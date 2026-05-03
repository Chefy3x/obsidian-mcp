import { promises as fs } from "node:fs";
import matter from "gray-matter";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

export const vaultDiffInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root."),
  operation: z
    .enum(["write", "patch"])
    .describe(
      "write: simulate vault_write. patch: simulate vault_patch with old_str/new_str.",
    ),
  content: z
    .string()
    .optional()
    .describe("For write: the new content (interpreted by mode)."),
  mode: z
    .enum(["overwrite", "append", "prepend"])
    .optional()
    .describe("For write: write mode. Default: overwrite."),
  old_str: z
    .string()
    .optional()
    .describe("For patch: the substring to find. Must be unique in the file."),
  new_str: z
    .string()
    .optional()
    .describe("For patch: the replacement."),
};

const VAULT_DIFF_DESCRIPTION =
  "Preview the result of a vault_write or vault_patch call without modifying the file. " +
  "Returns a unified diff, frontmatter before/after, and size deltas.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function registerVaultDiff(server: McpServer, config: Config): void {
  server.tool(
    "vault_diff",
    VAULT_DIFF_DESCRIPTION,
    vaultDiffInputShape,
    withToolRuntime("vault_diff", async (args) => {
      const relPath = args.path;
      const op = args.operation;

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_diff",
            code: err.code,
            message: err.message,
            attempted: { path: relPath, operation: op },
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
      const exists = stat !== undefined;

      if (exists && !stat!.isFile()) {
        return toolErrorResult({
          tool: "vault_diff",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath, operation: op },
          suggestions: ["vault_diff operates on a single note."],
        });
      }
      if (exists && stat!.size > MAX_FILE_BYTES) {
        return toolErrorResult({
          tool: "vault_diff",
          code: "FILE_TOO_LARGE",
          message: `File exceeds max size of ${MAX_FILE_BYTES} bytes (got ${stat!.size}).`,
          attempted: { path: relPath, size: stat!.size },
          suggestions: ["vault_diff currently caps at 10MB."],
        });
      }

      const oldContent = exists ? await fs.readFile(absPath, "utf8") : "";

      let newContent: string;
      let occurrences: number | undefined;

      if (op === "write") {
        if (args.content === undefined) {
          return toolErrorResult({
            tool: "vault_diff",
            code: "MISSING_CONTENT",
            message: "operation 'write' requires 'content'.",
            attempted: { path: relPath, operation: op },
            suggestions: ["Pass content: '...'."],
          });
        }
        const mode = args.mode ?? "overwrite";
        if (!exists || mode === "overwrite") {
          newContent = args.content;
        } else if (mode === "append") {
          newContent = oldContent + args.content;
        } else {
          newContent = args.content + oldContent;
        }
      } else {
        if (args.old_str === undefined || args.new_str === undefined) {
          return toolErrorResult({
            tool: "vault_diff",
            code: "MISSING_PATCH_ARGS",
            message: "operation 'patch' requires 'old_str' and 'new_str'.",
            attempted: { path: relPath, operation: op },
            suggestions: ["Pass old_str and new_str."],
          });
        }
        if (!exists) {
          return toolErrorResult({
            tool: "vault_diff",
            code: "NOT_FOUND",
            message: `Cannot patch missing file: ${relPath}`,
            attempted: { path: relPath, operation: op },
            suggestions: [
              "Use operation: 'write' to simulate creating a new file.",
            ],
          });
        }
        if (args.old_str.length === 0) {
          return toolErrorResult({
            tool: "vault_diff",
            code: "EMPTY_OLD_STR",
            message: "old_str must be non-empty.",
            attempted: { path: relPath, operation: op },
            suggestions: ["Provide a non-empty old_str."],
          });
        }
        occurrences = countOccurrences(oldContent, args.old_str);
        if (occurrences === 0) {
          return toolErrorResult({
            tool: "vault_diff",
            code: "OLD_STR_NOT_FOUND",
            message: "old_str does not appear in the file.",
            attempted: { path: relPath, operation: op, occurrences },
            suggestions: ["Read the file with vault_read and copy exact text."],
          });
        }
        if (occurrences > 1) {
          return toolErrorResult({
            tool: "vault_diff",
            code: "OLD_STR_NOT_UNIQUE",
            message: `old_str appears ${occurrences} times.`,
            attempted: { path: relPath, operation: op, occurrences },
            suggestions: ["Add more surrounding context to old_str."],
          });
        }
        const idx = oldContent.indexOf(args.old_str);
        newContent =
          oldContent.slice(0, idx) + args.new_str + oldContent.slice(idx + args.old_str.length);
      }

      const changed = newContent !== oldContent;

      let frontmatterBefore: Record<string, unknown> = {};
      let frontmatterAfter: Record<string, unknown> = {};
      try {
        if (oldContent.length > 0) {
          frontmatterBefore = matter(oldContent).data as Record<string, unknown>;
        }
        if (newContent.length > 0) {
          frontmatterAfter = matter(newContent).data as Record<string, unknown>;
        }
      } catch {
        /* leave as empty if either parse fails */
      }

      const diff = createTwoFilesPatch(
        relPath,
        relPath,
        oldContent,
        newContent,
        "before",
        "after",
      );

      return toolSuccessResult({
        path: relPath,
        operation: op,
        changed,
        diff,
        frontmatterBefore,
        frontmatterAfter,
        sizeBefore: Buffer.byteLength(oldContent, "utf8"),
        sizeAfter: Buffer.byteLength(newContent, "utf8"),
        existed: exists,
        ...(occurrences !== undefined ? { occurrences } : {}),
      });
    }),
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
