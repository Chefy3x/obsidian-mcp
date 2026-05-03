import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { atomicWriteFile } from "../atomic_write.js";
import { withToolRuntime } from "../runtime.js";

export const vaultWriteInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root, e.g. 'Inbox/today.md'."),
  content: z
    .string()
    .describe(
      "The content to write. For overwrite mode this is the full new content; " +
        "for append/prepend it is added to the existing content.",
    ),
  mode: z
    .enum(["overwrite", "append", "prepend"])
    .optional()
    .describe("Write mode. Default: overwrite."),
  failIfExists: z
    .boolean()
    .optional()
    .describe("If true, error when the target already exists. Default: false."),
  createParents: z
    .boolean()
    .optional()
    .describe("If true, create missing parent folders. Default: false."),
};

const VAULT_WRITE_DESCRIPTION =
  "Atomically write content to a note. Uses temp-file + rename for crash safety: " +
  "the target file is either the old content or the new content, never partial. " +
  "Modes: overwrite (default), append, prepend.";

const MAX_EXISTING_FILE_BYTES = 10 * 1024 * 1024;

export function registerVaultWrite(server: McpServer, config: Config): void {
  server.tool(
    "vault_write",
    VAULT_WRITE_DESCRIPTION,
    vaultWriteInputShape,
    withToolRuntime("vault_write", async (args) => {
      const relPath = args.path;
      const content = args.content;
      const mode = args.mode ?? "overwrite";
      const failIfExists = args.failIfExists ?? false;
      const createParents = args.createParents ?? false;
      const vaultRoot = path.resolve(config.vaultPath);

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_write",
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

      let targetStat: import("node:fs").Stats | undefined;
      try {
        targetStat = await fs.stat(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const targetExists = targetStat !== undefined;

      if (targetExists) {
        if (!targetStat!.isFile()) {
          return toolErrorResult({
            tool: "vault_write",
            code: "TARGET_NOT_A_FILE",
            message: `Target path is not a regular file: ${relPath}`,
            attempted: { path: relPath, mode },
            suggestions: [
              "vault_write only writes regular files. Pick a path that includes a filename.",
            ],
          });
        }
        if (failIfExists) {
          return toolErrorResult({
            tool: "vault_write",
            code: "FILE_EXISTS",
            message: `Target file already exists: ${relPath}`,
            attempted: { path: relPath, mode, failIfExists: true },
            suggestions: [
              "Set failIfExists to false to overwrite, or pick a new path.",
            ],
          });
        }
        if (
          (mode === "append" || mode === "prepend") &&
          targetStat!.size > MAX_EXISTING_FILE_BYTES
        ) {
          return toolErrorResult({
            tool: "vault_write",
            code: "FILE_TOO_LARGE",
            message:
              `Existing file is too large to ${mode}: ${targetStat!.size} bytes ` +
              `(cap ${MAX_EXISTING_FILE_BYTES}).`,
            attempted: { path: relPath, mode, size: targetStat!.size },
            suggestions: [
              "For very large files, use overwrite mode with the full new content.",
            ],
          });
        }
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
              tool: "vault_write",
              code: "PARENT_NOT_FOUND",
              message: `Parent folder does not exist: ${path.relative(vaultRoot, parent) || "."}`,
              attempted: { path: relPath, mode },
              suggestions: [
                "Set createParents to true to auto-create missing folders.",
                "Or call vault_create_folder first.",
              ],
            });
          }
          await fs.mkdir(parent, { recursive: true });
        } else if (!parentStat.isDirectory()) {
          return toolErrorResult({
            tool: "vault_write",
            code: "PARENT_NOT_FOLDER",
            message: `Parent path is not a folder: ${path.relative(vaultRoot, parent)}`,
            attempted: { path: relPath, mode },
            suggestions: [
              "A file already exists at the parent path. Pick a different path.",
            ],
          });
        }
      }

      let finalContent: string;
      if (!targetExists || mode === "overwrite") {
        finalContent = content;
      } else {
        const existing = await fs.readFile(absPath, "utf8");
        finalContent = mode === "append" ? existing + content : content + existing;
      }

      await atomicWriteFile(absPath, finalContent);

      const newStat = await fs.stat(absPath);

      return toolSuccessResult({
        path: relPath,
        size: newStat.size,
        modified: newStat.mtime.toISOString(),
        created: !targetExists,
        mode,
      });
    }),
  );
}
