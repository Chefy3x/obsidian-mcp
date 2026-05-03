import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { atomicWriteFile } from "../atomic_write.js";
import { moveToTrash, TRASH_DIR } from "../trash.js";

const SNAPSHOTS_DIR = ".snapshots";
const SKIP_DIRS = new Set([
  TRASH_DIR,
  SNAPSHOTS_DIR,
  ".obsidian",
  ".obsidian-mcp-cache",
]);
const MANIFEST_VERSION = 1;

export const vaultSnapshotInputShape = {
  operation: z
    .enum(["create", "list", "restore", "delete"])
    .describe(
      "create: take a new snapshot. list: enumerate existing snapshots. " +
        "restore: roll the vault back to a snapshot. delete: remove a snapshot.",
    ),
  label: z
    .string()
    .optional()
    .describe("For create: a human-readable tag for this snapshot."),
  snapshotId: z
    .string()
    .optional()
    .describe("For restore/delete: the snapshot ID to operate on."),
  mode: z
    .enum(["replace", "merge"])
    .optional()
    .describe(
      "For restore: 'replace' (default) returns vault to exactly the snapshot state; " +
        "any files added since are moved to .trash/. 'merge' copies snapshot files over " +
        "current state but leaves added files in place.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe("For restore: report what would change without writing. Default: false."),
};

const VAULT_SNAPSHOT_DESCRIPTION =
  "Manage manual save points. Snapshots live at .snapshots/<id>/ with a " +
  "manifest.json + data/ mirror of the vault (excluding .trash/, .snapshots/, " +
  ".obsidian/, .obsidian-mcp-cache/). Useful as a pre-flight before risky agent runs.";

interface SnapshotManifest {
  version: number;
  id: string;
  label: string | null;
  createdAt: string;
  fileCount: number;
  totalBytes: number;
}

export function registerVaultSnapshot(
  server: McpServer,
  config: Config,
): void {
  server.tool(
    "vault_snapshot",
    VAULT_SNAPSHOT_DESCRIPTION,
    vaultSnapshotInputShape,
    withToolRuntime("vault_snapshot", async (args) => {
      const op = args.operation;
      const vaultRoot = path.resolve(config.vaultPath);
      const snapshotsRoot = path.join(vaultRoot, SNAPSHOTS_DIR);

      if (op === "create") {
        return createSnapshot(vaultRoot, snapshotsRoot, args.label ?? null);
      }
      if (op === "list") {
        return listSnapshots(snapshotsRoot);
      }
      if (op === "restore") {
        if (!args.snapshotId) {
          return toolErrorResult({
            tool: "vault_snapshot",
            code: "MISSING_SNAPSHOT_ID",
            message: "restore requires snapshotId.",
            attempted: { operation: op },
            suggestions: ["List snapshots first with operation: 'list'."],
          });
        }
        return restoreSnapshot(
          vaultRoot,
          snapshotsRoot,
          args.snapshotId,
          args.mode ?? "replace",
          args.dryRun ?? false,
        );
      }
      if (!args.snapshotId) {
        return toolErrorResult({
          tool: "vault_snapshot",
          code: "MISSING_SNAPSHOT_ID",
          message: "delete requires snapshotId.",
          attempted: { operation: op },
          suggestions: ["List snapshots first with operation: 'list'."],
        });
      }
      return deleteSnapshot(snapshotsRoot, args.snapshotId);
    }),
  );
}

async function createSnapshot(
  vaultRoot: string,
  snapshotsRoot: string,
  label: string | null,
) {
  const id =
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomBytes(3).toString("hex");
  const snapshotDir = path.join(snapshotsRoot, id);
  const dataDir = path.join(snapshotDir, "data");
  await fs.mkdir(dataDir, { recursive: true });

  let fileCount = 0;
  let totalBytes = 0;

  await copyTree(vaultRoot, dataDir, "");

  async function copyTree(srcRoot: string, dstRoot: string, sub: string): Promise<void> {
    const absSrc = path.join(srcRoot, sub);
    const dirents = await fs.readdir(absSrc, { withFileTypes: true });
    for (const dirent of dirents) {
      if (sub === "" && SKIP_DIRS.has(dirent.name)) continue;
      const childSub =
        sub === "" ? dirent.name : path.posix.join(toPosix(sub), dirent.name);
      const absSrcChild = path.join(srcRoot, childSub);
      const absDstChild = path.join(dstRoot, childSub);
      if (dirent.isDirectory()) {
        await fs.mkdir(absDstChild, { recursive: true });
        await copyTree(srcRoot, dstRoot, childSub);
        continue;
      }
      if (!dirent.isFile()) continue;
      await fs.mkdir(path.dirname(absDstChild), { recursive: true });
      await fs.copyFile(absSrcChild, absDstChild);
      const stat = await fs.stat(absDstChild);
      fileCount++;
      totalBytes += stat.size;
    }
  }

  const manifest: SnapshotManifest = {
    version: MANIFEST_VERSION,
    id,
    label,
    createdAt: new Date().toISOString(),
    fileCount,
    totalBytes,
  };
  await atomicWriteFile(
    path.join(snapshotDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  return toolSuccessResult({ ...manifest, operation: "create" });
}

async function listSnapshots(snapshotsRoot: string) {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(snapshotsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return toolSuccessResult({ operation: "list", snapshots: [] });
    }
    throw err;
  }

  const snapshots: SnapshotManifest[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = path.join(snapshotsRoot, dirent.name, "manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const m = JSON.parse(raw) as SnapshotManifest;
      if (m.version === MANIFEST_VERSION) snapshots.push(m);
    } catch {
      /* skip malformed snapshots */
    }
  }
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return toolSuccessResult({ operation: "list", snapshots });
}

async function restoreSnapshot(
  vaultRoot: string,
  snapshotsRoot: string,
  snapshotId: string,
  mode: "replace" | "merge",
  dryRun: boolean,
) {
  const snapshotDir = path.join(snapshotsRoot, snapshotId);
  const dataDir = path.join(snapshotDir, "data");
  let manifestStat;
  try {
    manifestStat = await fs.stat(path.join(snapshotDir, "manifest.json"));
  } catch {
    return toolErrorResult({
      tool: "vault_snapshot",
      code: "SNAPSHOT_NOT_FOUND",
      message: `No snapshot with id: ${snapshotId}`,
      attempted: { operation: "restore", snapshotId },
      suggestions: ["List snapshots with operation: 'list'."],
    });
  }
  void manifestStat;

  const snapshotFiles = new Map<string, string>();
  await collectFiles(dataDir, "", snapshotFiles);

  const currentFiles = new Map<string, string>();
  await collectVaultFiles(vaultRoot, "", currentFiles);

  const filesToWrite: string[] = [];
  const filesUnchanged: string[] = [];
  const filesToDelete: string[] = [];

  for (const [rel, absSrc] of snapshotFiles) {
    const absDst = path.join(vaultRoot, rel);
    if (currentFiles.has(rel)) {
      const sameContent = await filesEqual(absSrc, absDst);
      if (sameContent) {
        filesUnchanged.push(rel);
        continue;
      }
    }
    filesToWrite.push(rel);
  }

  if (mode === "replace") {
    for (const rel of currentFiles.keys()) {
      if (!snapshotFiles.has(rel)) filesToDelete.push(rel);
    }
  }

  if (dryRun) {
    return toolSuccessResult({
      operation: "restore",
      snapshotId,
      mode,
      dryRun: true,
      filesToWrite,
      filesUnchanged,
      filesToDelete,
    });
  }

  for (const rel of filesToWrite) {
    const absSrc = snapshotFiles.get(rel)!;
    const absDst = path.join(vaultRoot, rel);
    await fs.mkdir(path.dirname(absDst), { recursive: true });
    const content = await fs.readFile(absSrc);
    await atomicWriteBytes(absDst, content);
  }

  const movedToTrash: string[] = [];
  for (const rel of filesToDelete) {
    const abs = path.join(vaultRoot, rel);
    try {
      const result = await moveToTrash(vaultRoot, abs, rel);
      movedToTrash.push(result.trashRel);
    } catch {
      /* race; skip */
    }
  }

  return toolSuccessResult({
    operation: "restore",
    snapshotId,
    mode,
    dryRun: false,
    filesWritten: filesToWrite.length,
    filesUnchanged: filesUnchanged.length,
    filesMovedToTrash: movedToTrash,
  });
}

async function deleteSnapshot(snapshotsRoot: string, snapshotId: string) {
  const snapshotDir = path.join(snapshotsRoot, snapshotId);
  try {
    await fs.stat(path.join(snapshotDir, "manifest.json"));
  } catch {
    return toolErrorResult({
      tool: "vault_snapshot",
      code: "SNAPSHOT_NOT_FOUND",
      message: `No snapshot with id: ${snapshotId}`,
      attempted: { operation: "delete", snapshotId },
      suggestions: ["List snapshots with operation: 'list'."],
    });
  }
  await fs.rm(snapshotDir, { recursive: true, force: true });
  return toolSuccessResult({
    operation: "delete",
    snapshotId,
    deleted: true,
  });
}

async function collectFiles(
  rootAbs: string,
  sub: string,
  out: Map<string, string>,
): Promise<void> {
  const absDir = path.join(rootAbs, sub);
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const childSub =
      sub === "" ? dirent.name : path.posix.join(toPosix(sub), dirent.name);
    const childAbs = path.join(rootAbs, childSub);
    if (dirent.isDirectory()) {
      await collectFiles(rootAbs, childSub, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    out.set(childSub, childAbs);
  }
}

async function collectVaultFiles(
  vaultRoot: string,
  sub: string,
  out: Map<string, string>,
): Promise<void> {
  const absDir = path.join(vaultRoot, sub);
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (sub === "" && SKIP_DIRS.has(dirent.name)) continue;
    const childSub =
      sub === "" ? dirent.name : path.posix.join(toPosix(sub), dirent.name);
    const childAbs = path.join(vaultRoot, childSub);
    if (dirent.isDirectory()) {
      await collectVaultFiles(vaultRoot, childSub, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    out.set(childSub, childAbs);
  }
}

async function filesEqual(a: string, b: string): Promise<boolean> {
  const [statA, statB] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (statA.size !== statB.size) return false;
  const [bufA, bufB] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return bufA.equals(bufB);
}

async function atomicWriteBytes(absPath: string, content: Buffer): Promise<void> {
  const tempPath = path.join(
    path.dirname(absPath),
    `.${path.basename(absPath)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, absPath);
  } catch (err) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
