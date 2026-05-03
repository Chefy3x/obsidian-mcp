import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { atomicWriteFile } from "../atomic_write.js";
import { withToolRuntime } from "../runtime.js";

export const vaultPatchInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root, e.g. 'Inbox/today.md'."),
  old_str: z
    .string()
    .min(1)
    .describe(
      "The exact substring to find and replace. Must occur exactly once in the file. " +
        "Include enough surrounding context to make it unique.",
    ),
  new_str: z
    .string()
    .describe(
      "The replacement string. May be empty to delete the matched text.",
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "If true, validate the patch (uniqueness, etc.) and report what would change " +
        "without writing. Default: false.",
    ),
};

const VAULT_PATCH_DESCRIPTION =
  "Replace a unique substring in a note with new content. Verifies that old_str " +
  "occurs exactly once before writing. Atomic: the file is either the old content " +
  "or the new content, never partial. Reduces blast radius compared to full overwrites.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function registerVaultPatch(server: McpServer, config: Config): void {
  server.tool(
    "vault_patch",
    VAULT_PATCH_DESCRIPTION,
    vaultPatchInputShape,
    withToolRuntime("vault_patch", async (args) => {
      const relPath = args.path;
      const oldStr = args.old_str;
      const newStr = args.new_str;
      const dryRun = args.dryRun ?? false;

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_patch",
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

      if (oldStr === newStr) {
        return toolErrorResult({
          tool: "vault_patch",
          code: "OLD_STR_EQUALS_NEW_STR",
          message: "old_str and new_str are identical; patch would be a no-op.",
          attempted: { path: relPath },
          suggestions: ["Provide a different new_str, or skip the call."],
        });
      }

      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_patch",
            code: "NOT_FOUND",
            message: `No file at vault path: ${relPath}`,
            attempted: { path: relPath },
            suggestions: [
              "Check the path is correct.",
              "Use vault_list to discover what exists in the parent folder.",
              "Use vault_write to create a new file instead of patching.",
            ],
          });
        }
        throw err;
      }

      if (!stat.isFile()) {
        return toolErrorResult({
          tool: "vault_patch",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath },
          suggestions: ["vault_patch only edits regular files."],
        });
      }

      if (stat.size > MAX_FILE_BYTES) {
        return toolErrorResult({
          tool: "vault_patch",
          code: "FILE_TOO_LARGE",
          message: `File exceeds max patch size of ${MAX_FILE_BYTES} bytes (got ${stat.size}).`,
          attempted: { path: relPath, size: stat.size },
          suggestions: [
            "vault_patch currently caps at 10MB. Range-based edits will land in a later phase.",
          ],
        });
      }

      const raw = await fs.readFile(absPath, "utf8");
      const occurrences = countOccurrences(raw, oldStr);

      if (occurrences === 0) {
        return toolErrorResult({
          tool: "vault_patch",
          code: "OLD_STR_NOT_FOUND",
          message: "old_str does not appear in the file.",
          attempted: { path: relPath, oldStrLength: oldStr.length },
          suggestions: [
            "Read the file with vault_read and copy the exact text you intend to replace, including whitespace.",
            "Watch for tabs vs. spaces and trailing newlines.",
          ],
        });
      }

      if (occurrences > 1) {
        return toolErrorResult({
          tool: "vault_patch",
          code: "OLD_STR_NOT_UNIQUE",
          message: `old_str appears ${occurrences} times in the file; it must be unique.`,
          attempted: { path: relPath, occurrences },
          suggestions: [
            "Add more surrounding context to old_str so it matches exactly once.",
            "Or call vault_patch multiple times with progressively narrower context.",
          ],
        });
      }

      const matchIndex = raw.indexOf(oldStr);
      const line = raw.slice(0, matchIndex).split("\n").length;
      const newContent = raw.slice(0, matchIndex) + newStr + raw.slice(matchIndex + oldStr.length);

      if (dryRun) {
        return toolSuccessResult({
          path: relPath,
          dryRun: true,
          line,
          oldStrBytes: Buffer.byteLength(oldStr, "utf8"),
          newStrBytes: Buffer.byteLength(newStr, "utf8"),
          sizeBefore: stat.size,
          sizeAfter: Buffer.byteLength(newContent, "utf8"),
        });
      }

      await atomicWriteFile(absPath, newContent);
      const newStat = await fs.stat(absPath);

      return toolSuccessResult({
        path: relPath,
        dryRun: false,
        line,
        size: newStat.size,
        modified: newStat.mtime.toISOString(),
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
