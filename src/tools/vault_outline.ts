import { promises as fs } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { parseHeadings } from "../headings.js";

export const vaultOutlineInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root."),
  maxLevel: z
    .number()
    .int()
    .min(1)
    .max(6)
    .optional()
    .describe("Include headings up to this level (1=H1 only, 6=all). Default: 6."),
};

const VAULT_OUTLINE_DESCRIPTION =
  "Extract the heading structure (H1-H6) from a note. Returns one entry per heading " +
  "with level, text, and line number. ATX headings only; skips headings inside fenced " +
  "code blocks. Useful for navigating long notes without re-reading the body and for " +
  "constructing valid '#heading' links.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function registerVaultOutline(server: McpServer, config: Config): void {
  server.tool(
    "vault_outline",
    VAULT_OUTLINE_DESCRIPTION,
    vaultOutlineInputShape,
    withToolRuntime("vault_outline", async (args) => {
      const relPath = args.path;
      const maxLevel = args.maxLevel ?? 6;

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_outline",
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

      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_outline",
            code: "NOT_FOUND",
            message: `No file at vault path: ${relPath}`,
            attempted: { path: relPath },
            suggestions: ["Check the path with vault_list."],
          });
        }
        throw err;
      }
      if (!stat.isFile()) {
        return toolErrorResult({
          tool: "vault_outline",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath },
          suggestions: ["vault_outline operates on a single note."],
        });
      }
      if (stat.size > MAX_FILE_BYTES) {
        return toolErrorResult({
          tool: "vault_outline",
          code: "FILE_TOO_LARGE",
          message: `File exceeds max size of ${MAX_FILE_BYTES} bytes (got ${stat.size}).`,
          attempted: { path: relPath, size: stat.size },
          suggestions: ["vault_outline currently caps at 10MB."],
        });
      }

      const raw = await fs.readFile(absPath, "utf8");
      const headings = parseHeadings(raw)
        .filter((h) => h.level <= maxLevel)
        .map((h) => ({ level: h.level, text: h.text, line: h.line }));

      return toolSuccessResult({
        path: relPath,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        headings,
      });
    }),
  );
}
