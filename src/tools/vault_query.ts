import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

const FIELD_NAMES = ["path", "frontmatter", "modified", "size", "title", "tags"] as const;
const SORT_FIELDS = ["modified", "path", "title", "size"] as const;

export const vaultQueryInputShape = {
  scope: z
    .string()
    .optional()
    .describe(
      "Folder path relative to the vault root to scope the query. Default: whole vault.",
    ),
  where: z
    .object({
      frontmatter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Frontmatter exact-match filter (all keys must match)."),
      tagsAll: z.array(z.string()).optional(),
      tagsAny: z.array(z.string()).optional(),
      tagsNone: z.array(z.string()).optional(),
      modifiedAfter: z
        .string()
        .optional()
        .describe("ISO 8601 datetime; matches files with mtime > this value."),
      modifiedBefore: z
        .string()
        .optional()
        .describe("ISO 8601 datetime; matches files with mtime < this value."),
      pathMatches: z
        .string()
        .optional()
        .describe("Optional regex applied to vault-relative path (POSIX separators)."),
    })
    .optional()
    .describe("Filters; all clauses are AND'd together. Omit for 'match everything'."),
  select: z
    .array(z.enum(FIELD_NAMES))
    .optional()
    .describe(
      "Fields to include per result. Default: ['path', 'modified', 'title']. " +
        "Use 'frontmatter' to include the full frontmatter object.",
    ),
  sortBy: z
    .enum(SORT_FIELDS)
    .optional()
    .describe("Sort key. Default: 'modified'."),
  sortOrder: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Default: 'desc'."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum results. Default: 100, max: 1000."),
};

const VAULT_QUERY_DESCRIPTION =
  "Run a structured query over the vault: filter by frontmatter exact match, tag " +
  "boolean (all/any/none), mtime range, and optional path regex. Select which fields " +
  "to return per result, sort, and limit. Tag normalization handles 'tags: [a, b]' and " +
  "'tags: a, b' identically.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_SCAN_FILES = 20_000;

type Field = (typeof FIELD_NAMES)[number];
type SortKey = (typeof SORT_FIELDS)[number];

interface QueryRow {
  path: string;
  modified: string;
  modifiedMs: number;
  size: number;
  title: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

export function registerVaultQuery(server: McpServer, config: Config): void {
  server.tool(
    "vault_query",
    VAULT_QUERY_DESCRIPTION,
    vaultQueryInputShape,
    withToolRuntime("vault_query", async (args) => {
      const scope = args.scope ?? ".";
      const where = args.where ?? {};
      const select: Field[] = args.select ?? ["path", "modified", "title"];
      const sortBy: SortKey = args.sortBy ?? "modified";
      const sortOrder = args.sortOrder ?? "desc";
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      let scopeAbs: string;
      try {
        scopeAbs = resolveVaultPath(config.vaultPath, scope);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_query",
            code: err.code,
            message: err.message,
            attempted: { scope },
            suggestions: [
              "Use a folder path relative to the vault root, or omit scope.",
            ],
          });
        }
        throw err;
      }

      let scopeStat;
      try {
        scopeStat = await fs.stat(scopeAbs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return toolErrorResult({
            tool: "vault_query",
            code: "SCOPE_NOT_FOUND",
            message: `Scope folder does not exist: ${scope}`,
            attempted: { scope },
            suggestions: ["Check the scope path with vault_list."],
          });
        }
        throw err;
      }
      if (!scopeStat.isDirectory()) {
        return toolErrorResult({
          tool: "vault_query",
          code: "SCOPE_NOT_A_FOLDER",
          message: `Scope is not a folder: ${scope}`,
          attempted: { scope },
          suggestions: ["Pass a folder path for scope."],
        });
      }

      let modifiedAfterMs: number | null = null;
      let modifiedBeforeMs: number | null = null;
      if (where.modifiedAfter) {
        const t = Date.parse(where.modifiedAfter);
        if (Number.isNaN(t)) {
          return toolErrorResult({
            tool: "vault_query",
            code: "INVALID_DATE",
            message: `modifiedAfter is not a valid ISO 8601 datetime: ${where.modifiedAfter}`,
            attempted: { modifiedAfter: where.modifiedAfter },
            suggestions: ["Use ISO 8601, e.g. '2026-04-25T00:00:00Z'."],
          });
        }
        modifiedAfterMs = t;
      }
      if (where.modifiedBefore) {
        const t = Date.parse(where.modifiedBefore);
        if (Number.isNaN(t)) {
          return toolErrorResult({
            tool: "vault_query",
            code: "INVALID_DATE",
            message: `modifiedBefore is not a valid ISO 8601 datetime: ${where.modifiedBefore}`,
            attempted: { modifiedBefore: where.modifiedBefore },
            suggestions: ["Use ISO 8601, e.g. '2026-04-25T00:00:00Z'."],
          });
        }
        modifiedBeforeMs = t;
      }

      let pathRegex: RegExp | null = null;
      if (where.pathMatches) {
        try {
          pathRegex = new RegExp(where.pathMatches);
        } catch (err) {
          return toolErrorResult({
            tool: "vault_query",
            code: "INVALID_REGEX",
            message: `Invalid pathMatches regex: ${err instanceof Error ? err.message : String(err)}`,
            attempted: { pathMatches: where.pathMatches },
            suggestions: ["Check the regex syntax."],
          });
        }
      }

      const tagsAll = where.tagsAll ?? [];
      const tagsAny = where.tagsAny ?? [];
      const tagsNone = where.tagsNone ?? [];
      const fmFilter = where.frontmatter ?? {};
      const hasTagFilter =
        tagsAll.length > 0 || tagsAny.length > 0 || tagsNone.length > 0;
      const hasFmFilter = Object.keys(fmFilter).length > 0;
      const includeFrontmatter = select.includes("frontmatter");
      const needFmRead = hasFmFilter || hasTagFilter || includeFrontmatter || select.includes("title") || select.includes("tags");

      const files = await walk(scopeAbs, scope);
      if (files.length > MAX_SCAN_FILES) {
        return toolErrorResult({
          tool: "vault_query",
          code: "SCOPE_TOO_LARGE",
          message: `Scope contains ${files.length} files; cap is ${MAX_SCAN_FILES}.`,
          attempted: { scope, fileCount: files.length },
          suggestions: ["Narrow the scope to a subfolder."],
        });
      }

      const rows: QueryRow[] = [];
      let filesScanned = 0;

      for (const filePath of files) {
        if (pathRegex && !pathRegex.test(filePath)) continue;

        const absFilePath = path.join(config.vaultPath, filePath);
        let stat;
        try {
          stat = await fs.stat(absFilePath);
        } catch {
          continue;
        }
        if (modifiedAfterMs !== null && stat.mtimeMs <= modifiedAfterMs) continue;
        if (modifiedBeforeMs !== null && stat.mtimeMs >= modifiedBeforeMs) continue;
        if (stat.size > MAX_FILE_BYTES) continue;

        let fmData: Record<string, unknown> = {};
        if (needFmRead) {
          try {
            const raw = await fs.readFile(absFilePath, "utf8");
            const parsed = matter(raw);
            fmData = parsed.data as Record<string, unknown>;
          } catch {
            continue;
          }
        }
        filesScanned++;

        if (hasFmFilter) {
          let allMatch = true;
          for (const [k, v] of Object.entries(fmFilter)) {
            if (!deepEqual(fmData[k], v)) {
              allMatch = false;
              break;
            }
          }
          if (!allMatch) continue;
        }

        const fileTags = normalizeTags(fmData.tags);
        if (hasTagFilter) {
          if (tagsAll.length > 0 && !tagsAll.every((t: string) => fileTags.includes(t))) continue;
          if (tagsAny.length > 0 && !tagsAny.some((t: string) => fileTags.includes(t))) continue;
          if (tagsNone.length > 0 && tagsNone.some((t: string) => fileTags.includes(t))) continue;
        }

        const titleVal = fmData.title;
        rows.push({
          path: filePath,
          modified: stat.mtime.toISOString(),
          modifiedMs: stat.mtimeMs,
          size: stat.size,
          title: typeof titleVal === "string" ? titleVal : null,
          tags: fileTags,
          frontmatter: fmData,
        });
      }

      rows.sort((a, b) => compare(a, b, sortBy, sortOrder));

      const truncated = rows.length > limit;
      const selected = rows.slice(0, limit).map((r) => projectRow(r, select));

      return toolSuccessResult({
        results: selected,
        totalMatching: rows.length,
        filesScanned,
        truncated,
      });
    }),
  );
}

function projectRow(row: QueryRow, fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === "path") out.path = row.path;
    else if (f === "modified") out.modified = row.modified;
    else if (f === "size") out.size = row.size;
    else if (f === "title") out.title = row.title;
    else if (f === "tags") out.tags = row.tags;
    else if (f === "frontmatter") out.frontmatter = row.frontmatter;
  }
  return out;
}

function compare(a: QueryRow, b: QueryRow, key: SortKey, order: "asc" | "desc"): number {
  let cmp = 0;
  if (key === "modified") cmp = a.modifiedMs - b.modifiedMs;
  else if (key === "path") cmp = a.path.localeCompare(b.path);
  else if (key === "title")
    cmp = (a.title ?? "").localeCompare(b.title ?? "");
  else if (key === "size") cmp = a.size - b.size;
  return order === "desc" ? -cmp : cmp;
}

async function walk(scopeAbs: string, scopeRel: string): Promise<string[]> {
  const out: string[] = [];
  await recurse(scopeAbs, "");
  return out;

  async function recurse(absDir: string, subRel: string): Promise<void> {
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const childSub =
        subRel === "" ? dirent.name : path.posix.join(toPosix(subRel), dirent.name);
      const childAbs = path.join(absDir, dirent.name);
      if (dirent.isDirectory()) {
        await recurse(childAbs, childSub);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!dirent.name.toLowerCase().endsWith(".md")) continue;
      const fullRel =
        scopeRel === "." || scopeRel === ""
          ? childSub
          : path.posix.join(toPosix(scopeRel), childSub);
      out.push(fullRel);
    }
  }
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((t) => typeof t === "string") as string[];
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (
        !deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
