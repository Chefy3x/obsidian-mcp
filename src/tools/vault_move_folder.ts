import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { atomicWriteFile } from "../atomic_write.js";
import { BacklinkIndex } from "../backlinks/index.js";
import {
  rewriteLinksInSource,
  recomputeOwnLinksAfterMove,
} from "../backlinks/rewrite.js";
import { TRASH_DIR } from "../trash.js";

export const vaultMoveFolderInputShape = {
  oldPath: z
    .string()
    .min(1)
    .describe("Current folder path relative to the vault root."),
  newPath: z
    .string()
    .min(1)
    .describe("Target folder path relative to the vault root."),
  createParents: z
    .boolean()
    .optional()
    .describe(
      "If true, create missing parent folders at the target. Default: false.",
    ),
  rewriteLinks: z
    .boolean()
    .optional()
    .describe(
      "If true (default), rewrite all backlinks in the vault and all outgoing markdown " +
        "links inside moved files. Set to false to skip backlink work (faster, but breaks links).",
    ),
};

const VAULT_MOVE_FOLDER_DESCRIPTION =
  "Move or rename a folder. Cascades to every file inside. Updates external sources " +
  "that link to moved files (case 1) AND every moved file's own outgoing markdown " +
  "links so they keep resolving to the same targets (case 2). The folder rename is a " +
  "single atomic fs.rename after all link rewrites are durable.";

export function registerVaultMoveFolder(server: McpServer, config: Config): void {
  server.tool(
    "vault_move_folder",
    VAULT_MOVE_FOLDER_DESCRIPTION,
    vaultMoveFolderInputShape,
    withToolRuntime("vault_move_folder", async (args) => {
      const oldRel = args.oldPath;
      const newRel = args.newPath;
      const createParents = args.createParents ?? false;
      const doRewriteLinks = args.rewriteLinks ?? true;
      const vaultRoot = path.resolve(config.vaultPath);

      let oldAbs: string;
      let newAbs: string;
      try {
        oldAbs = resolveVaultPath(config.vaultPath, oldRel);
        newAbs = resolveVaultPath(config.vaultPath, newRel);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_move_folder",
            code: err.code,
            message: err.message,
            attempted: { oldPath: oldRel, newPath: newRel },
            suggestions: [
              "Use folder paths relative to the vault root with no leading slash and no '..' segments.",
            ],
          });
        }
        throw err;
      }

      if (oldAbs === vaultRoot) {
        return toolErrorResult({
          tool: "vault_move_folder",
          code: "CANNOT_MOVE_VAULT_ROOT",
          message: "oldPath resolves to the vault root, which cannot be moved.",
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: ["Pick a folder inside the vault."],
        });
      }
      if (oldAbs === newAbs) {
        return toolErrorResult({
          tool: "vault_move_folder",
          code: "SAME_PATH",
          message: "oldPath and newPath resolve to the same folder.",
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: ["Pick a different newPath."],
        });
      }

      const oldPosix = toPosix(oldRel);
      if (oldPosix === TRASH_DIR || oldPosix.startsWith(`${TRASH_DIR}/`)) {
        return toolErrorResult({
          tool: "vault_move_folder",
          code: "SOURCE_IN_TRASH",
          message: `oldPath is inside ${TRASH_DIR}/: ${oldRel}`,
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: ["Restore the folder out of .trash/ before moving."],
        });
      }

      const oldAbsWithSep = oldAbs.endsWith(path.sep) ? oldAbs : oldAbs + path.sep;
      if (newAbs === oldAbs || newAbs.startsWith(oldAbsWithSep)) {
        return toolErrorResult({
          tool: "vault_move_folder",
          code: "TARGET_INSIDE_SOURCE",
          message: "newPath is inside oldPath; would create a recursive move.",
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: ["Pick a target outside the source folder."],
        });
      }

      let oldStat;
      try {
        oldStat = await fs.stat(oldAbs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_move_folder",
            code: "NOT_FOUND",
            message: `No folder at oldPath: ${oldRel}`,
            attempted: { oldPath: oldRel, newPath: newRel },
            suggestions: ["Check the path with vault_list."],
          });
        }
        throw err;
      }
      if (!oldStat.isDirectory()) {
        return toolErrorResult({
          tool: "vault_move_folder",
          code: "NOT_A_FOLDER",
          message: `oldPath is not a folder: ${oldRel}`,
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: ["Use vault_move for files."],
        });
      }

      let newStat: import("node:fs").Stats | undefined;
      try {
        newStat = await fs.stat(newAbs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (newStat) {
        return toolErrorResult({
          tool: "vault_move_folder",
          code: "TARGET_EXISTS",
          message: `newPath already exists: ${newRel}`,
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: [
            "Pick a fresh newPath. Merging into an existing folder is not supported.",
          ],
        });
      }

      const newParent = path.dirname(newAbs);
      if (newParent !== vaultRoot) {
        let parentStat: import("node:fs").Stats | undefined;
        try {
          parentStat = await fs.stat(newParent);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (!parentStat) {
          if (!createParents) {
            return toolErrorResult({
              tool: "vault_move_folder",
              code: "PARENT_NOT_FOUND",
              message: `Parent folder of newPath does not exist: ${path.relative(vaultRoot, newParent)}`,
              attempted: { oldPath: oldRel, newPath: newRel },
              suggestions: [
                "Set createParents to true.",
                "Or create the parent first with vault_create_folder.",
              ],
            });
          }
          await fs.mkdir(newParent, { recursive: true });
        } else if (!parentStat.isDirectory()) {
          return toolErrorResult({
            tool: "vault_move_folder",
            code: "PARENT_NOT_FOLDER",
            message: `Parent path is not a folder: ${path.relative(vaultRoot, newParent)}`,
            attempted: { oldPath: oldRel, newPath: newRel },
            suggestions: ["Pick a different newPath."],
          });
        }
      }

      const moves = await collectFileMoves(oldAbs, oldRel, newRel);

      let externalLinksRewritten = 0;
      let externalSourcesUpdated = 0;
      let ownLinksRewritten = 0;
      let ownFilesRewritten = 0;
      const externalSourcesList: string[] = [];

      if (doRewriteLinks) {
        const index = await BacklinkIndex.load(config.vaultPath);
        await index.refresh();

        const movedSet = new Set(moves.map((m) => m.oldRel));
        const dirtySources = new Map<string, string>();

        for (const move of moves) {
          const sources = index.findSources(move.oldRel);
          for (const sourcePath of sources) {
            if (movedSet.has(sourcePath)) continue;
            const sourceAbs = path.join(vaultRoot, sourcePath);
            let content = dirtySources.get(sourcePath);
            if (content === undefined) {
              try {
                content = await fs.readFile(sourceAbs, "utf8");
              } catch {
                continue;
              }
            }
            const result = rewriteLinksInSource(sourcePath, content, {
              oldPath: move.oldRel,
              newPath: move.newRel,
            });
            if (result.rewrites === 0) continue;
            dirtySources.set(sourcePath, result.content);
            externalLinksRewritten += result.rewrites;
          }
        }

        for (const [sourcePath, content] of dirtySources) {
          await atomicWriteFile(path.join(vaultRoot, sourcePath), content);
          externalSourcesUpdated++;
          externalSourcesList.push(sourcePath);
        }

        for (const move of moves) {
          if (!move.oldRel.toLowerCase().endsWith(".md")) continue;
          const fileAbs = path.join(vaultRoot, move.oldRel);
          let content: string;
          try {
            content = await fs.readFile(fileAbs, "utf8");
          } catch {
            continue;
          }
          const result = recomputeOwnLinksAfterMove(content, move.oldRel, move.newRel, {
            skipTargetsInsideFolder: oldRel,
          });
          if (result.rewrites === 0) continue;
          await atomicWriteFile(fileAbs, result.content);
          ownLinksRewritten += result.rewrites;
          ownFilesRewritten++;
        }
      }

      await fs.rename(oldAbs, newAbs);

      if (doRewriteLinks) {
        const index = await BacklinkIndex.load(config.vaultPath);
        for (const move of moves) index.forget(move.oldRel);
        await index.refresh();
        await index.save();
      }

      return toolSuccessResult({
        oldPath: oldRel,
        newPath: newRel,
        filesMoved: moves.length,
        externalLinksRewritten,
        externalSourcesUpdated,
        externalSourcesList,
        ownLinksRewritten,
        ownFilesRewritten,
        rewriteLinks: doRewriteLinks,
      });
    }),
  );
}

interface FileMove {
  oldRel: string;
  newRel: string;
}

async function collectFileMoves(
  oldRootAbs: string,
  oldRootRel: string,
  newRootRel: string,
): Promise<FileMove[]> {
  const moves: FileMove[] = [];
  await walk(oldRootAbs, "");
  return moves;

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
      const oldRel = path.posix.join(toPosix(oldRootRel), childSub);
      const newRel = path.posix.join(toPosix(newRootRel), childSub);
      moves.push({ oldRel, newRel });
    }
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
