import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { BacklinkIndex } from "../backlinks/index.js";
import { moveToTrash, TRASH_DIR } from "../trash.js";

export const vaultDeleteFolderInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Folder path relative to the vault root."),
  mode: z
    .enum(["empty_only", "recursive_to_trash", "recursive_permanent"])
    .optional()
    .describe(
      "empty_only (default): fails if folder is non-empty. " +
        "recursive_to_trash: moves the whole folder into .trash/ preserving structure. " +
        "recursive_permanent: hard-deletes the folder and all contents (unrecoverable).",
    ),
  iUnderstandThisIsPermanent: z
    .boolean()
    .optional()
    .describe(
      "Required to be true when mode is recursive_permanent. Acts as a guard against " +
        "accidental hard deletes by an LLM.",
    ),
  reportOrphans: z
    .boolean()
    .optional()
    .describe(
      "If true (default), include the list of external sources that linked into the deleted " +
        "folder. Set to false to skip the index lookup for speed.",
    ),
};

const VAULT_DELETE_FOLDER_DESCRIPTION =
  "Delete a folder. Modes: empty_only (default), recursive_to_trash, recursive_permanent. " +
  "Reports the files affected and the external sources that linked into the deleted " +
  "folder (so you can audit broken links).";

export function registerVaultDeleteFolder(
  server: McpServer,
  config: Config,
): void {
  server.tool(
    "vault_delete_folder",
    VAULT_DELETE_FOLDER_DESCRIPTION,
    vaultDeleteFolderInputShape,
    withToolRuntime("vault_delete_folder", async (args) => {
      const relPath = args.path;
      const mode = args.mode ?? "empty_only";
      const iUnderstandThisIsPermanent = args.iUnderstandThisIsPermanent ?? false;
      const reportOrphans = args.reportOrphans ?? true;
      const vaultRoot = path.resolve(config.vaultPath);

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_delete_folder",
            code: err.code,
            message: err.message,
            attempted: { path: relPath, mode },
            suggestions: [
              "Use a path relative to the vault root with no leading slash and no '..' segments.",
            ],
          });
        }
        throw err;
      }

      if (absPath === vaultRoot) {
        return toolErrorResult({
          tool: "vault_delete_folder",
          code: "CANNOT_DELETE_VAULT_ROOT",
          message: "Refusing to delete the vault root.",
          attempted: { path: relPath, mode },
          suggestions: ["Pick a folder inside the vault."],
        });
      }

      const relPosix = toPosix(relPath);
      if (
        relPosix === TRASH_DIR ||
        relPosix.startsWith(`${TRASH_DIR}/`) ||
        relPosix === ".obsidian-mcp-cache" ||
        relPosix.startsWith(".obsidian-mcp-cache/") ||
        relPosix === ".obsidian" ||
        relPosix.startsWith(".obsidian/")
      ) {
        return toolErrorResult({
          tool: "vault_delete_folder",
          code: "PROTECTED_PATH",
          message: `Refusing to delete protected path: ${relPath}`,
          attempted: { path: relPath, mode },
          suggestions: [
            ".trash/, .obsidian/, and .obsidian-mcp-cache/ are managed and not deletable via this tool.",
          ],
        });
      }

      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_delete_folder",
            code: "NOT_FOUND",
            message: `No folder at vault path: ${relPath}`,
            attempted: { path: relPath, mode },
            suggestions: ["Check the path with vault_list."],
          });
        }
        throw err;
      }
      if (!stat.isDirectory()) {
        return toolErrorResult({
          tool: "vault_delete_folder",
          code: "NOT_A_FOLDER",
          message: `Path is not a folder: ${relPath}`,
          attempted: { path: relPath, mode },
          suggestions: ["Use vault_delete for files."],
        });
      }

      if (mode === "recursive_permanent" && !iUnderstandThisIsPermanent) {
        return toolErrorResult({
          tool: "vault_delete_folder",
          code: "CONFIRMATION_REQUIRED",
          message:
            "recursive_permanent requires iUnderstandThisIsPermanent=true to proceed.",
          attempted: { path: relPath, mode },
          suggestions: [
            "Pass iUnderstandThisIsPermanent: true to confirm.",
            "Or use mode: 'recursive_to_trash' for a recoverable delete.",
          ],
        });
      }

      if (mode === "empty_only") {
        try {
          await fs.rmdir(absPath);
          return toolSuccessResult({
            path: relPath,
            mode,
            deleted: true,
            files: [],
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
            return toolErrorResult({
              tool: "vault_delete_folder",
              code: "DIR_NOT_EMPTY",
              message: `Folder is not empty: ${relPath}`,
              attempted: { path: relPath, mode },
              suggestions: [
                "Use mode: 'recursive_to_trash' to soft-delete the folder and its contents.",
                "Or use mode: 'recursive_permanent' (with iUnderstandThisIsPermanent: true) for unrecoverable hard delete.",
              ],
            });
          }
          throw err;
        }
      }

      const files = await collectAllFiles(absPath, relPath);

      let orphanedSources: string[] = [];
      if (reportOrphans) {
        const index = await BacklinkIndex.load(config.vaultPath);
        await index.refresh();
        const movedSet = new Set(files);
        const orphans = new Set<string>();
        for (const f of files) {
          for (const src of index.findSources(f)) {
            if (!movedSet.has(src) && !isInsideFolder(src, relPath)) {
              orphans.add(src);
            }
          }
        }
        orphanedSources = [...orphans].sort();
      }

      let trashPath: string | null = null;

      if (mode === "recursive_to_trash") {
        const result = await moveToTrash(vaultRoot, absPath, relPath);
        trashPath = result.trashRel;
      } else {
        await fs.rm(absPath, { recursive: true, force: true });
      }

      const index = await BacklinkIndex.load(config.vaultPath);
      for (const f of files) index.forget(f);
      await index.refresh();
      await index.save();

      return toolSuccessResult({
        path: relPath,
        mode,
        files,
        trashPath,
        orphanedSources,
      });
    }),
  );
}

async function collectAllFiles(absRoot: string, relRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walk(absRoot, "");
  return out;

  async function walk(absDir: string, subRel: string): Promise<void> {
    const dirents = await fs.readdir(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const childSub = subRel === "" ? dirent.name : path.posix.join(toPosix(subRel), dirent.name);
      const childAbs = path.join(absDir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(childAbs, childSub);
        continue;
      }
      if (!dirent.isFile()) continue;
      out.push(path.posix.join(toPosix(relRoot), childSub));
    }
  }
}

function isInsideFolder(filePath: string, folderPath: string): boolean {
  const file = toPosix(filePath);
  const folder = toPosix(folderPath);
  return file === folder || file.startsWith(`${folder}/`);
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
