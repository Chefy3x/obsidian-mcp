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
import { rewriteLinksInSource, recomputeOwnLinksAfterMove } from "../backlinks/rewrite.js";
import { TRASH_DIR } from "../trash.js";

export const vaultMoveInputShape = {
  oldPath: z
    .string()
    .min(1)
    .describe("Current path of the file relative to the vault root."),
  newPath: z
    .string()
    .min(1)
    .describe("Target path relative to the vault root."),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "If true, overwrite an existing file at newPath. Default: false (errors if newPath exists).",
    ),
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
      "If true (default), rewrite all backlinks in the vault to point at newPath. " +
        "Set to false to skip backlink rewriting (faster, but breaks links).",
    ),
};

const VAULT_MOVE_DESCRIPTION =
  "Move or rename a file. Updates every wikilink and markdown link in the vault that " +
  "pointed at the old path. Atomic per-file: every link rewrite is an atomic temp+rename; " +
  "the actual file move is the last step.";

export function registerVaultMove(server: McpServer, config: Config): void {
  server.tool(
    "vault_move",
    VAULT_MOVE_DESCRIPTION,
    vaultMoveInputShape,
    withToolRuntime("vault_move", async (args) => {
      const oldRel = args.oldPath;
      const newRel = args.newPath;
      const overwrite = args.overwrite ?? false;
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
            tool: "vault_move",
            code: err.code,
            message: err.message,
            attempted: { oldPath: oldRel, newPath: newRel },
            suggestions: [
              "Use paths relative to the vault root with no leading slash and no '..' segments.",
            ],
          });
        }
        throw err;
      }

      if (oldAbs === newAbs) {
        return toolErrorResult({
          tool: "vault_move",
          code: "SAME_PATH",
          message: "oldPath and newPath resolve to the same location.",
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: ["Pick a different newPath."],
        });
      }

      const oldPosix = toPosix(oldRel);
      if (oldPosix === TRASH_DIR || oldPosix.startsWith(`${TRASH_DIR}/`)) {
        return toolErrorResult({
          tool: "vault_move",
          code: "SOURCE_IN_TRASH",
          message: `oldPath is inside ${TRASH_DIR}/: ${oldRel}`,
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: [
            "Restore the file out of .trash/ manually before moving it.",
          ],
        });
      }

      let oldStat;
      try {
        oldStat = await fs.stat(oldAbs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_move",
            code: "NOT_FOUND",
            message: `No file at oldPath: ${oldRel}`,
            attempted: { oldPath: oldRel, newPath: newRel },
            suggestions: ["Check the path with vault_list."],
          });
        }
        throw err;
      }
      if (!oldStat.isFile()) {
        return toolErrorResult({
          tool: "vault_move",
          code: "NOT_A_FILE",
          message: `oldPath is not a regular file: ${oldRel}`,
          attempted: { oldPath: oldRel, newPath: newRel },
          suggestions: ["Use vault_move_folder for folders."],
        });
      }

      let newStat: import("node:fs").Stats | undefined;
      try {
        newStat = await fs.stat(newAbs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (newStat) {
        if (!newStat.isFile()) {
          return toolErrorResult({
            tool: "vault_move",
            code: "TARGET_NOT_A_FILE",
            message: `newPath exists but is not a regular file: ${newRel}`,
            attempted: { oldPath: oldRel, newPath: newRel },
            suggestions: ["Pick a newPath that is either missing or a regular file."],
          });
        }
        if (!overwrite) {
          return toolErrorResult({
            tool: "vault_move",
            code: "TARGET_EXISTS",
            message: `newPath already exists: ${newRel}`,
            attempted: { oldPath: oldRel, newPath: newRel, overwrite: false },
            suggestions: [
              "Set overwrite to true to replace the existing file.",
              "Or pick a different newPath.",
            ],
          });
        }
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
              tool: "vault_move",
              code: "PARENT_NOT_FOUND",
              message: `Parent folder of newPath does not exist: ${path.relative(vaultRoot, newParent)}`,
              attempted: { oldPath: oldRel, newPath: newRel },
              suggestions: [
                "Set createParents to true.",
                "Or create the parent folder first with vault_create_folder.",
              ],
            });
          }
          await fs.mkdir(newParent, { recursive: true });
        } else if (!parentStat.isDirectory()) {
          return toolErrorResult({
            tool: "vault_move",
            code: "PARENT_NOT_FOLDER",
            message: `Parent path is not a folder: ${path.relative(vaultRoot, newParent)}`,
            attempted: { oldPath: oldRel, newPath: newRel },
            suggestions: ["Pick a different newPath."],
          });
        }
      }

      let linksRewritten = 0;
      let sourcesUpdated = 0;
      let ownLinksRewritten = 0;
      const sourcesUpdatedList: string[] = [];

      if (doRewriteLinks) {
        const index = await BacklinkIndex.load(config.vaultPath);
        await index.refresh();

        const sources = index.findSources(oldRel);
        for (const sourcePath of sources) {
          const sourceAbs = path.join(vaultRoot, sourcePath);
          let content: string;
          try {
            content = await fs.readFile(sourceAbs, "utf8");
          } catch {
            continue;
          }
          const result = rewriteLinksInSource(sourcePath, content, {
            oldPath: oldRel,
            newPath: newRel,
          });
          if (result.rewrites === 0) continue;
          await atomicWriteFile(sourceAbs, result.content);
          linksRewritten += result.rewrites;
          sourcesUpdated++;
          sourcesUpdatedList.push(sourcePath);
        }

        if (oldRel.toLowerCase().endsWith(".md")) {
          const ownContent = await fs.readFile(oldAbs, "utf8");
          const ownResult = recomputeOwnLinksAfterMove(ownContent, oldRel, newRel);
          if (ownResult.rewrites > 0) {
            await atomicWriteFile(oldAbs, ownResult.content);
            ownLinksRewritten = ownResult.rewrites;
          }
        }
      }

      await fs.rename(oldAbs, newAbs);

      if (doRewriteLinks) {
        const index = await BacklinkIndex.load(config.vaultPath);
        index.forget(oldRel);
        await index.refresh();
        await index.save();
      }

      return toolSuccessResult({
        oldPath: oldRel,
        newPath: newRel,
        linksRewritten,
        sourcesUpdated,
        sourcesUpdatedList,
        ownLinksRewritten,
        rewriteLinks: doRewriteLinks,
      });
    }),
  );
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
