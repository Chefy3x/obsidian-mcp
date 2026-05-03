import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

export const vaultCreateFolderInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Folder path relative to the vault root, e.g. 'Inbox/Daily'."),
  createParents: z
    .boolean()
    .optional()
    .describe("If true, create missing parent folders. Default: false."),
};

const VAULT_CREATE_FOLDER_DESCRIPTION =
  "Create a folder in the vault. Idempotent: succeeds with created=false if the folder " +
  "already exists. Set createParents to true to create intermediate folders.";

export function registerVaultCreateFolder(
  server: McpServer,
  config: Config,
): void {
  server.tool(
    "vault_create_folder",
    VAULT_CREATE_FOLDER_DESCRIPTION,
    vaultCreateFolderInputShape,
    withToolRuntime("vault_create_folder", async (args) => {
      const relPath = args.path;
      const createParents = args.createParents ?? false;
      const vaultRoot = path.resolve(config.vaultPath);

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_create_folder",
            code: err.code,
            message: err.message,
            attempted: { path: relPath },
            suggestions: [
              "Use a path relative to the vault root with no leading slash and no '..' segments.",
            ],
          });
        }
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
          return toolErrorResult({
            tool: "vault_create_folder",
            code: "PATH_IS_FILE",
            message: `Path exists but is not a folder: ${relPath}`,
            attempted: { path: relPath },
            suggestions: [
              "Pick a different path, or delete the existing file first with vault_delete.",
            ],
          });
        }
        return toolSuccessResult({ path: relPath, created: false });
      }

      const parent = path.dirname(absPath);
      if (parent !== vaultRoot) {
        let parentStat: import("node:fs").Stats | undefined;
        try {
          parentStat = await fs.stat(parent);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (!parentStat) {
          if (!createParents) {
            return toolErrorResult({
              tool: "vault_create_folder",
              code: "PARENT_NOT_FOUND",
              message: `Parent folder does not exist: ${path.relative(vaultRoot, parent) || "."}`,
              attempted: { path: relPath },
              suggestions: [
                "Set createParents to true to auto-create intermediate folders.",
                "Or create the parent folder first with vault_create_folder.",
              ],
            });
          }
        } else if (!parentStat.isDirectory()) {
          return toolErrorResult({
            tool: "vault_create_folder",
            code: "PARENT_NOT_FOLDER",
            message: `Parent path is not a folder: ${path.relative(vaultRoot, parent)}`,
            attempted: { path: relPath },
            suggestions: ["A file already exists at the parent path. Pick a different path."],
          });
        }
      }

      await fs.mkdir(absPath, { recursive: createParents });

      return toolSuccessResult({ path: relPath, created: true });
    }),
  );
}
