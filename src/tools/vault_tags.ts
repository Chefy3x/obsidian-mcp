import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

const SKIP_DIRS = new Set([".trash", ".snapshots", ".obsidian", ".obsidian-mcp-cache"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const vaultTagsInputShape = {
  scope: z
    .string()
    .optional()
    .describe(
      "Folder path relative to the vault root to scope the enumeration. Default: whole vault.",
    ),
  withCounts: z
    .boolean()
    .optional()
    .describe(
      "Include per-tag usage counts. Default: true. Set false to return just the unique tag list.",
    ),
  prefix: z
    .string()
    .optional()
    .describe(
      "Only include tags starting with this prefix. Useful for hierarchical tags like 'project/'.",
    ),
};

const VAULT_TAGS_DESCRIPTION =
  "Enumerate all unique tags found in frontmatter across the vault, optionally with " +
  "per-tag usage counts. Tag normalization handles 'tags: [a, b]' and 'tags: a, b' " +
  "identically. Sorted by count desc (or alphabetical when counts disabled).";

export function registerVaultTags(server: McpServer, config: Config): void {
  server.tool(
    "vault_tags",
    VAULT_TAGS_DESCRIPTION,
    vaultTagsInputShape,
    withToolRuntime("vault_tags", async (args) => {
      const scopeRel = args.scope ?? ".";
      const withCounts = args.withCounts ?? true;
      const prefix = args.prefix ?? "";

      let scopeAbs: string;
      try {
        scopeAbs = resolveVaultPath(config.vaultPath, scopeRel);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_tags",
            code: err.code,
            message: err.message,
            attempted: { scope: scopeRel },
            suggestions: ["Use a folder path relative to the vault root."],
          });
        }
        throw err;
      }

      let stat;
      try {
        stat = await fs.stat(scopeAbs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_tags",
            code: "SCOPE_NOT_FOUND",
            message: `Scope folder does not exist: ${scopeRel}`,
            attempted: { scope: scopeRel },
            suggestions: ["Check the path with vault_list."],
          });
        }
        throw err;
      }
      if (!stat.isDirectory()) {
        return toolErrorResult({
          tool: "vault_tags",
          code: "SCOPE_NOT_A_FOLDER",
          message: `Scope is not a folder: ${scopeRel}`,
          attempted: { scope: scopeRel },
          suggestions: ["Pass a folder path."],
        });
      }

      const counts = new Map<string, number>();
      let filesScanned = 0;

      await walk(scopeAbs, true);

      async function walk(absDir: string, atScopeRoot: boolean): Promise<void> {
        let dirents: import("node:fs").Dirent[];
        try {
          dirents = await fs.readdir(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const dirent of dirents) {
          if (atScopeRoot && SKIP_DIRS.has(dirent.name)) continue;
          if (dirent.name.startsWith(".")) continue;
          const childAbs = path.join(absDir, dirent.name);
          if (dirent.isDirectory()) {
            await walk(childAbs, false);
            continue;
          }
          if (!dirent.isFile()) continue;
          if (!dirent.name.toLowerCase().endsWith(".md")) continue;

          let s;
          try {
            s = await fs.stat(childAbs);
          } catch {
            continue;
          }
          if (s.size > MAX_FILE_BYTES) continue;

          let raw;
          try {
            raw = await fs.readFile(childAbs, "utf8");
          } catch {
            continue;
          }
          filesScanned++;

          let fmTags: unknown;
          try {
            fmTags = (matter(raw).data as Record<string, unknown>).tags;
          } catch {
            continue;
          }
          for (const tag of normalizeTags(fmTags)) {
            if (prefix && !tag.startsWith(prefix)) continue;
            counts.set(tag, (counts.get(tag) ?? 0) + 1);
          }
        }
      }

      const all = Array.from(counts.entries());
      if (withCounts) {
        all.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        return toolSuccessResult({
          scope: scopeRel,
          totalUnique: all.length,
          filesScanned,
          tags: all.map(([name, count]) => ({ name, count })),
        });
      }
      const names = all.map(([n]) => n).sort((a, b) => a.localeCompare(b));
      return toolSuccessResult({
        scope: scopeRel,
        totalUnique: names.length,
        filesScanned,
        tags: names,
      });
    }),
  );
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((t): t is string => typeof t === "string");
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}
