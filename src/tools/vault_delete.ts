import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { moveToTrash, TRASH_DIR } from "../trash.js";
import { withToolRuntime } from "../runtime.js";

export const vaultDeleteInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root, e.g. 'Inbox/today.md'."),
  permanent: z
    .boolean()
    .optional()
    .describe(
      "If true, permanently delete (no trash). Default: false (soft delete to .trash/).",
    ),
};

const VAULT_DELETE_DESCRIPTION =
  "Delete a note. By default, soft-deletes to the vault's .trash/ folder, preserving " +
  "the original folder structure. Set permanent=true for an unrecoverable hard delete. " +
  "Use vault_delete_folder for folders.";

export function registerVaultDelete(server: McpServer, config: Config): void {
  server.tool(
    "vault_delete",
    VAULT_DELETE_DESCRIPTION,
    vaultDeleteInputShape,
    withToolRuntime("vault_delete", async (args) => {
      const relPath = args.path;
      const permanent = args.permanent ?? false;
      const vaultRoot = path.resolve(config.vaultPath);

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_delete",
            code: err.code,
            message: err.message,
            attempted: { path: relPath, permanent },
            suggestions: [
              "Use a path relative to the vault root with no leading slash and no '..' segments.",
            ],
          });
        }
        throw err;
      }

      const relPosix = relPath.split(path.sep).join(path.posix.sep);
      if (relPosix === TRASH_DIR || relPosix.startsWith(`${TRASH_DIR}/`)) {
        return toolErrorResult({
          tool: "vault_delete",
          code: "ALREADY_IN_TRASH",
          message: `Path is already inside ${TRASH_DIR}/: ${relPath}`,
          attempted: { path: relPath, permanent },
          suggestions: [
            "Use permanent=true to hard-delete files inside .trash/.",
            "A dedicated empty-trash tool will land in a later phase.",
          ],
        });
      }

      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_delete",
            code: "NOT_FOUND",
            message: `No file at vault path: ${relPath}`,
            attempted: { path: relPath, permanent },
            suggestions: [
              "Check the path is correct.",
              "Use vault_list to discover what exists in the parent folder.",
            ],
          });
        }
        throw err;
      }

      if (!stat.isFile()) {
        return toolErrorResult({
          tool: "vault_delete",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath, permanent },
          suggestions: ["Use vault_delete_folder for folders."],
        });
      }

      if (permanent) {
        await fs.unlink(absPath);
        return toolSuccessResult({
          path: relPath,
          permanent: true,
        });
      }

      const { trashRel } = await moveToTrash(vaultRoot, absPath, relPath);

      return toolSuccessResult({
        path: relPath,
        permanent: false,
        trashPath: trashRel,
      });
    }),
  );
}
