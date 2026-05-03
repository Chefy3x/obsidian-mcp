import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { atomicWriteFile } from "../atomic_write.js";
import { moveToTrash } from "../trash.js";
import { BacklinkIndex } from "../backlinks/index.js";
import { rewriteLinksInSource } from "../backlinks/rewrite.js";

const writeOpShape = z.object({
  type: z.literal("write"),
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(["overwrite", "append", "prepend"]).optional(),
  failIfExists: z.boolean().optional(),
  createParents: z.boolean().optional(),
});
const patchOpShape = z.object({
  type: z.literal("patch"),
  path: z.string().min(1),
  old_str: z.string().min(1),
  new_str: z.string(),
});
const deleteOpShape = z.object({
  type: z.literal("delete"),
  path: z.string().min(1),
  permanent: z.boolean().optional(),
});
const moveOpShape = z.object({
  type: z.literal("move"),
  sourcePath: z.string().min(1),
  destPath: z.string().min(1),
});
const createFolderOpShape = z.object({
  type: z.literal("create_folder"),
  path: z.string().min(1),
  createParents: z.boolean().optional(),
});

export const vaultBatchInputShape = {
  operations: z
    .array(
      z.union([
        writeOpShape,
        patchOpShape,
        deleteOpShape,
        moveOpShape,
        createFolderOpShape,
      ]),
    )
    .min(1)
    .max(200)
    .describe(
      "Array of operations. Each is one of: write, patch, delete, move, create_folder. Cap: 200 ops/batch.",
    ),
  stopOnError: z
    .boolean()
    .optional()
    .describe("If true, stop at the first failed operation. Default: false (continue)."),
};

const VAULT_BATCH_DESCRIPTION =
  "Run a sequence of vault operations (write, patch, delete, move, create_folder) " +
  "in one call. Each operation is atomic on its own; the batch is sequential. Move " +
  "operations share a single backlink index load+refresh+save (much cheaper than " +
  "calling vault_move N times). For atomic-rollback semantics across the whole batch, " +
  "take a vault_snapshot before calling.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

type Op = z.infer<
  typeof writeOpShape | typeof patchOpShape | typeof deleteOpShape | typeof moveOpShape | typeof createFolderOpShape
>;

interface OpOk {
  type: string;
  ok: true;
  [k: string]: unknown;
}
interface OpErr {
  type: string;
  ok: false;
  code: string;
  message: string;
  attempted: Record<string, unknown>;
}
type OpResult = OpOk | OpErr;

export function registerVaultBatch(server: McpServer, config: Config): void {
  server.tool(
    "vault_batch",
    VAULT_BATCH_DESCRIPTION,
    vaultBatchInputShape,
    withToolRuntime("vault_batch", async (args) => {
      const ops = args.operations as Op[];
      const stopOnError = args.stopOnError ?? false;
      const vaultRoot = path.resolve(config.vaultPath);

      let index: BacklinkIndex | null = null;
      const hasMove = ops.some((o) => o.type === "move");
      if (hasMove) {
        index = await BacklinkIndex.load(config.vaultPath);
        await index.refresh();
      }

      const results: OpResult[] = [];
      let aborted = false;

      for (const op of ops) {
        if (aborted) {
          results.push({
            type: op.type,
            ok: false,
            code: "ABORTED",
            message: "Skipped due to earlier failure with stopOnError=true.",
            attempted: { op },
          });
          continue;
        }
        let r: OpResult;
        try {
          if (op.type === "write") r = await execWrite(op, vaultRoot);
          else if (op.type === "patch") r = await execPatch(op, vaultRoot);
          else if (op.type === "delete") r = await execDelete(op, vaultRoot);
          else if (op.type === "create_folder") r = await execCreateFolder(op, vaultRoot);
          else r = await execMove(op, vaultRoot, index!);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          r = {
            type: op.type,
            ok: false,
            code: "UNHANDLED",
            message,
            attempted: { op },
          };
        }
        results.push(r);
        if (!r.ok && stopOnError) aborted = true;
      }

      if (index) await index.save();

      const successCount = results.filter((r) => r.ok).length;
      const errorCount = results.length - successCount;

      return toolSuccessResult({
        operationCount: ops.length,
        successCount,
        errorCount,
        aborted,
        results,
      });
    }),
  );
}

function pathError(opType: string, attempted: Record<string, unknown>, err: VaultPathError): OpErr {
  return {
    type: opType,
    ok: false,
    code: err.code,
    message: err.message,
    attempted,
  };
}

async function execWrite(op: z.infer<typeof writeOpShape>, vaultRoot: string): Promise<OpResult> {
  const mode = op.mode ?? "overwrite";
  const failIfExists = op.failIfExists ?? false;
  const createParents = op.createParents ?? false;
  let absPath: string;
  try {
    absPath = resolveVaultPath(vaultRoot, op.path);
  } catch (err) {
    if (err instanceof VaultPathError) return pathError("write", { path: op.path }, err);
    throw err;
  }

  let stat: import("node:fs").Stats | undefined;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const exists = stat !== undefined;
  if (exists) {
    if (!stat!.isFile()) {
      return { type: "write", ok: false, code: "TARGET_NOT_A_FILE", message: `Not a file: ${op.path}`, attempted: { op } };
    }
    if (failIfExists) {
      return { type: "write", ok: false, code: "FILE_EXISTS", message: `Already exists: ${op.path}`, attempted: { op } };
    }
    if ((mode === "append" || mode === "prepend") && stat!.size > MAX_FILE_BYTES) {
      return { type: "write", ok: false, code: "FILE_TOO_LARGE", message: `Too large to ${mode}: ${stat!.size} bytes`, attempted: { op } };
    }
  }

  const parent = path.dirname(absPath);
  if (parent !== vaultRoot) {
    let pStat: import("node:fs").Stats | undefined;
    try {
      pStat = await fs.stat(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!pStat) {
      if (!createParents) {
        return { type: "write", ok: false, code: "PARENT_NOT_FOUND", message: `Parent missing: ${path.relative(vaultRoot, parent)}`, attempted: { op } };
      }
      await fs.mkdir(parent, { recursive: true });
    } else if (!pStat.isDirectory()) {
      return { type: "write", ok: false, code: "PARENT_NOT_FOLDER", message: `Parent is a file: ${path.relative(vaultRoot, parent)}`, attempted: { op } };
    }
  }

  let finalContent: string;
  if (!exists || mode === "overwrite") finalContent = op.content;
  else {
    const existing = await fs.readFile(absPath, "utf8");
    finalContent = mode === "append" ? existing + op.content : op.content + existing;
  }

  await atomicWriteFile(absPath, finalContent);
  const ns = await fs.stat(absPath);
  return {
    type: "write",
    ok: true,
    path: op.path,
    size: ns.size,
    modified: ns.mtime.toISOString(),
    created: !exists,
    mode,
  };
}

async function execPatch(op: z.infer<typeof patchOpShape>, vaultRoot: string): Promise<OpResult> {
  if (op.old_str === op.new_str) {
    return { type: "patch", ok: false, code: "OLD_STR_EQUALS_NEW_STR", message: "no-op", attempted: { op } };
  }
  let absPath: string;
  try {
    absPath = resolveVaultPath(vaultRoot, op.path);
  } catch (err) {
    if (err instanceof VaultPathError) return pathError("patch", { path: op.path }, err);
    throw err;
  }
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { type: "patch", ok: false, code: "NOT_FOUND", message: `No file: ${op.path}`, attempted: { op } };
    }
    throw err;
  }
  if (!stat.isFile()) return { type: "patch", ok: false, code: "NOT_A_FILE", message: `Not a file: ${op.path}`, attempted: { op } };
  if (stat.size > MAX_FILE_BYTES) {
    return { type: "patch", ok: false, code: "FILE_TOO_LARGE", message: `Too large: ${stat.size}`, attempted: { op } };
  }

  const raw = await fs.readFile(absPath, "utf8");
  let count = 0;
  let pos = 0;
  while ((pos = raw.indexOf(op.old_str, pos)) !== -1) {
    count++;
    pos += op.old_str.length;
  }
  if (count === 0) return { type: "patch", ok: false, code: "OLD_STR_NOT_FOUND", message: "old_str not in file", attempted: { op } };
  if (count > 1) return { type: "patch", ok: false, code: "OLD_STR_NOT_UNIQUE", message: `old_str appears ${count} times`, attempted: { op, occurrences: count } };

  const idx = raw.indexOf(op.old_str);
  const newContent = raw.slice(0, idx) + op.new_str + raw.slice(idx + op.old_str.length);
  const line = raw.slice(0, idx).split("\n").length;
  await atomicWriteFile(absPath, newContent);
  const ns = await fs.stat(absPath);
  return { type: "patch", ok: true, path: op.path, line, size: ns.size, modified: ns.mtime.toISOString() };
}

async function execDelete(op: z.infer<typeof deleteOpShape>, vaultRoot: string): Promise<OpResult> {
  const permanent = op.permanent ?? false;
  let absPath: string;
  try {
    absPath = resolveVaultPath(vaultRoot, op.path);
  } catch (err) {
    if (err instanceof VaultPathError) return pathError("delete", { path: op.path }, err);
    throw err;
  }
  const relPosix = op.path.split(path.sep).join(path.posix.sep);
  if (relPosix === ".trash" || relPosix.startsWith(".trash/")) {
    return { type: "delete", ok: false, code: "ALREADY_IN_TRASH", message: `Already in .trash/: ${op.path}`, attempted: { op } };
  }
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { type: "delete", ok: false, code: "NOT_FOUND", message: `No file: ${op.path}`, attempted: { op } };
    }
    throw err;
  }
  if (!stat.isFile()) {
    return { type: "delete", ok: false, code: "NOT_A_FILE", message: `Not a file: ${op.path}`, attempted: { op } };
  }
  if (permanent) {
    await fs.unlink(absPath);
    return { type: "delete", ok: true, path: op.path, permanent: true };
  }
  const { trashRel } = await moveToTrash(vaultRoot, absPath, op.path);
  return { type: "delete", ok: true, path: op.path, permanent: false, trashPath: trashRel };
}

async function execCreateFolder(op: z.infer<typeof createFolderOpShape>, vaultRoot: string): Promise<OpResult> {
  const createParents = op.createParents ?? false;
  let absPath: string;
  try {
    absPath = resolveVaultPath(vaultRoot, op.path);
  } catch (err) {
    if (err instanceof VaultPathError) return pathError("create_folder", { path: op.path }, err);
    throw err;
  }
  let stat: import("node:fs").Stats | undefined;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (stat) {
    if (!stat.isDirectory()) {
      return { type: "create_folder", ok: false, code: "PATH_IS_FILE", message: `Exists as file: ${op.path}`, attempted: { op } };
    }
    return { type: "create_folder", ok: true, path: op.path, created: false };
  }
  await fs.mkdir(absPath, { recursive: createParents });
  return { type: "create_folder", ok: true, path: op.path, created: true };
}

async function execMove(
  op: z.infer<typeof moveOpShape>,
  vaultRoot: string,
  index: BacklinkIndex,
): Promise<OpResult> {
  let srcAbs: string;
  let dstAbs: string;
  try {
    srcAbs = resolveVaultPath(vaultRoot, op.sourcePath);
    dstAbs = resolveVaultPath(vaultRoot, op.destPath);
  } catch (err) {
    if (err instanceof VaultPathError) {
      return {
        type: "move",
        ok: false,
        code: err.code,
        message: err.message,
        attempted: { op },
      };
    }
    throw err;
  }

  let srcStat;
  try {
    srcStat = await fs.stat(srcAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { type: "move", ok: false, code: "SOURCE_NOT_FOUND", message: `No source: ${op.sourcePath}`, attempted: { op } };
    }
    throw err;
  }
  if (!srcStat.isFile()) {
    return { type: "move", ok: false, code: "SOURCE_NOT_A_FILE", message: `Not a file: ${op.sourcePath}`, attempted: { op } };
  }

  let dstExists = false;
  try {
    await fs.stat(dstAbs);
    dstExists = true;
  } catch {
    /* ok */
  }
  if (dstExists) {
    return { type: "move", ok: false, code: "DEST_EXISTS", message: `Dest exists: ${op.destPath}`, attempted: { op } };
  }

  const sources = index.findSources(op.sourcePath);
  let linksRewritten = 0;
  const filesRewritten: string[] = [];
  for (const sourcePath of sources) {
    const sourceAbs = path.join(vaultRoot, sourcePath);
    let sourceContent: string;
    try {
      sourceContent = await fs.readFile(sourceAbs, "utf8");
    } catch {
      continue;
    }
    const result = rewriteLinksInSource(sourcePath, sourceContent, {
      oldPath: op.sourcePath,
      newPath: op.destPath,
    });
    if (result.rewrites > 0) {
      await atomicWriteFile(sourceAbs, result.content);
      linksRewritten += result.rewrites;
      filesRewritten.push(sourcePath);
    }
  }

  await fs.mkdir(path.dirname(dstAbs), { recursive: true });
  await fs.rename(srcAbs, dstAbs);

  index.forget(op.sourcePath);

  return {
    type: "move",
    ok: true,
    sourcePath: op.sourcePath,
    destPath: op.destPath,
    linksRewritten,
    filesRewritten,
  };
}
