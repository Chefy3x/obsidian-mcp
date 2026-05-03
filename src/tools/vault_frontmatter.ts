import { promises as fs } from "node:fs";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { atomicWriteFile } from "../atomic_write.js";

export const vaultFrontmatterInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root."),
  operation: z
    .enum(["get", "set", "delete", "replace"])
    .describe(
      "get: read frontmatter only. " +
        "set: upsert specific keys (other keys preserved). " +
        "delete: remove specific keys. " +
        "replace: replace the entire frontmatter object.",
    ),
  keys: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "For 'set': map of key->value to upsert. For 'replace': the full new frontmatter object.",
    ),
  removeKeys: z
    .array(z.string())
    .optional()
    .describe("For 'delete': list of frontmatter keys to remove."),
  dryRun: z
    .boolean()
    .optional()
    .describe(
      "If true, validate and report the change without writing. Default: false.",
    ),
};

const VAULT_FRONTMATTER_DESCRIPTION =
  "Read or modify a note's YAML frontmatter without touching the body. Operations: " +
  "get, set (shallow upsert), delete (remove keys), replace (whole-object replace). " +
  "Atomic write per change. Returns before/after frontmatter snapshots.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function registerVaultFrontmatter(
  server: McpServer,
  config: Config,
): void {
  server.tool(
    "vault_frontmatter",
    VAULT_FRONTMATTER_DESCRIPTION,
    vaultFrontmatterInputShape,
    withToolRuntime("vault_frontmatter", async (args) => {
      const relPath = args.path;
      const op = args.operation;
      const dryRun = args.dryRun ?? false;

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_frontmatter",
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

      let stat;
      try {
        stat = await fs.stat(absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_frontmatter",
            code: "NOT_FOUND",
            message: `No file at vault path: ${relPath}`,
            attempted: { path: relPath, operation: op },
            suggestions: ["Check the path with vault_list."],
          });
        }
        throw err;
      }
      if (!stat.isFile()) {
        return toolErrorResult({
          tool: "vault_frontmatter",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath, operation: op },
          suggestions: ["vault_frontmatter operates on a single note."],
        });
      }
      if (stat.size > MAX_FILE_BYTES) {
        return toolErrorResult({
          tool: "vault_frontmatter",
          code: "FILE_TOO_LARGE",
          message: `File exceeds max size of ${MAX_FILE_BYTES} bytes (got ${stat.size}).`,
          attempted: { path: relPath, size: stat.size },
          suggestions: ["vault_frontmatter currently caps at 10MB."],
        });
      }

      const raw = await fs.readFile(absPath, "utf8");

      let before: Record<string, unknown>;
      let body: string;
      try {
        const parsed = matter(raw);
        before = parsed.data as Record<string, unknown>;
        body = parsed.content;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolErrorResult({
          tool: "vault_frontmatter",
          code: "FRONTMATTER_PARSE_ERROR",
          message: `Failed to parse frontmatter: ${message}`,
          attempted: { path: relPath, operation: op },
          suggestions: [
            "Frontmatter must be valid YAML between '---' fences at the top of the file.",
          ],
        });
      }

      if (op === "get") {
        return toolSuccessResult({
          path: relPath,
          operation: "get",
          frontmatter: before,
        });
      }

      let after: Record<string, unknown>;

      if (op === "set") {
        if (!args.keys || Object.keys(args.keys).length === 0) {
          return toolErrorResult({
            tool: "vault_frontmatter",
            code: "NO_KEYS",
            message: "set requires a non-empty 'keys' object.",
            attempted: { path: relPath, operation: op },
            suggestions: ["Provide keys: { key1: value1, key2: value2 }."],
          });
        }
        after = { ...before, ...args.keys };
      } else if (op === "delete") {
        if (!args.removeKeys || args.removeKeys.length === 0) {
          return toolErrorResult({
            tool: "vault_frontmatter",
            code: "NO_KEYS",
            message: "delete requires a non-empty 'removeKeys' array.",
            attempted: { path: relPath, operation: op },
            suggestions: ["Provide removeKeys: ['key1', 'key2']."],
          });
        }
        after = { ...before };
        for (const key of args.removeKeys) {
          delete after[key];
        }
      } else {
        if (!args.keys) {
          return toolErrorResult({
            tool: "vault_frontmatter",
            code: "NO_KEYS",
            message: "replace requires a 'keys' object (use {} to clear all frontmatter).",
            attempted: { path: relPath, operation: op },
            suggestions: ["Provide keys: { ... } with the full new frontmatter."],
          });
        }
        after = { ...args.keys };
      }

      const beforeJson = JSON.stringify(before);
      const afterJson = JSON.stringify(after);
      const noChange = beforeJson === afterJson;

      if (noChange) {
        return toolSuccessResult({
          path: relPath,
          operation: op,
          before,
          after,
          changed: false,
          dryRun,
        });
      }

      const newContent =
        Object.keys(after).length === 0 ? body : matter.stringify(body, after);

      if (dryRun) {
        return toolSuccessResult({
          path: relPath,
          operation: op,
          before,
          after,
          changed: true,
          dryRun: true,
          sizeBefore: stat.size,
          sizeAfter: Buffer.byteLength(newContent, "utf8"),
        });
      }

      await atomicWriteFile(absPath, newContent);
      const newStat = await fs.stat(absPath);

      return toolSuccessResult({
        path: relPath,
        operation: op,
        before,
        after,
        changed: true,
        dryRun: false,
        size: newStat.size,
        modified: newStat.mtime.toISOString(),
      });
    }),
  );
}
