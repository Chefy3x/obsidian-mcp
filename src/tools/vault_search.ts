import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

export const vaultSearchInputShape = {
  query: z
    .string()
    .optional()
    .describe(
      "Text to search for in the body. If regex is true, treated as a JS regex source.",
    ),
  regex: z
    .boolean()
    .optional()
    .describe("Treat query as a JS regex source. Default: false (substring)."),
  caseSensitive: z
    .boolean()
    .optional()
    .describe("Case sensitive matching. Default: false."),
  scope: z
    .string()
    .optional()
    .describe(
      "Folder path relative to the vault root to scope the search. Default: whole vault.",
    ),
  tagsAll: z
    .array(z.string())
    .optional()
    .describe("Notes must have ALL these tags."),
  tagsAny: z
    .array(z.string())
    .optional()
    .describe("Notes must have at least one of these tags."),
  tagsNone: z
    .array(z.string())
    .optional()
    .describe("Notes must NOT have any of these tags."),
  frontmatter: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Frontmatter exact-match filter, e.g. {status: 'draft'}. All keys must match.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum results to return. Default: 50, max: 500."),
};

const VAULT_SEARCH_DESCRIPTION =
  "Search notes by content (text or regex), frontmatter exact-match, and tag boolean " +
  "filters (all/any/none), optionally scoped to a folder. Tag arrays are normalized: " +
  "'tags: a, b' is treated identically to 'tags: [a, b]'. Returns results ranked by " +
  "match count (then mtime desc) with a 200-char snippet around the first match.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_SCAN_FILES = 10_000;
const SNIPPET_BEFORE = 80;
const SNIPPET_AFTER = 120;

interface SearchResult {
  path: string;
  matches: number;
  modified: string;
  size: number;
  title: string | null;
  snippet: string | null;
  matchedFirstAt: number | null;
}

export function registerVaultSearch(server: McpServer, config: Config): void {
  server.tool(
    "vault_search",
    VAULT_SEARCH_DESCRIPTION,
    vaultSearchInputShape,
    withToolRuntime("vault_search", async (args) => {
      const query = args.query ?? "";
      const useRegex = args.regex ?? false;
      const caseSensitive = args.caseSensitive ?? false;
      const scope = args.scope ?? ".";
      const tagsAll = args.tagsAll ?? [];
      const tagsAny = args.tagsAny ?? [];
      const tagsNone = args.tagsNone ?? [];
      const frontmatterFilter = args.frontmatter ?? {};
      const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      const hasContentFilter = query.length > 0;
      const hasTagFilter =
        tagsAll.length > 0 || tagsAny.length > 0 || tagsNone.length > 0;
      const hasFmFilter = Object.keys(frontmatterFilter).length > 0;

      if (!hasContentFilter && !hasTagFilter && !hasFmFilter) {
        return toolErrorResult({
          tool: "vault_search",
          code: "NO_FILTERS",
          message:
            "vault_search requires at least one of: query, tagsAll, tagsAny, tagsNone, frontmatter.",
          attempted: { args },
          suggestions: [
            "Provide a non-empty query, tag filter, or frontmatter filter.",
            "To list all notes, use vault_list instead.",
          ],
        });
      }

      let scopeAbs: string;
      try {
        scopeAbs = resolveVaultPath(config.vaultPath, scope);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_search",
            code: err.code,
            message: err.message,
            attempted: { scope },
            suggestions: [
              "Use a folder path relative to the vault root, or omit scope to search the whole vault.",
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
            tool: "vault_search",
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
          tool: "vault_search",
          code: "SCOPE_NOT_A_FOLDER",
          message: `Scope is not a folder: ${scope}`,
          attempted: { scope },
          suggestions: ["Pass a folder path for scope."],
        });
      }

      let pattern: RegExp | null = null;
      if (hasContentFilter) {
        try {
          if (useRegex) {
            pattern = new RegExp(query, caseSensitive ? "g" : "gi");
          } else {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            pattern = new RegExp(escaped, caseSensitive ? "g" : "gi");
          }
        } catch (err) {
          return toolErrorResult({
            tool: "vault_search",
            code: "INVALID_REGEX",
            message: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
            attempted: { query, regex: useRegex },
            suggestions: ["Check the regex syntax."],
          });
        }
      }

      const files = await walk(scopeAbs, scope);
      if (files.length > MAX_SCAN_FILES) {
        return toolErrorResult({
          tool: "vault_search",
          code: "SCOPE_TOO_LARGE",
          message: `Scope contains ${files.length} files; cap is ${MAX_SCAN_FILES}.`,
          attempted: { scope, fileCount: files.length },
          suggestions: ["Narrow the scope to a subfolder."],
        });
      }

      const results: SearchResult[] = [];
      let filesScanned = 0;

      for (const filePath of files) {
        const absFilePath = path.join(config.vaultPath, filePath);
        let stat;
        try {
          stat = await fs.stat(absFilePath);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) continue;

        const raw = await fs.readFile(absFilePath, "utf8");
        filesScanned++;

        let parsed;
        try {
          parsed = matter(raw);
        } catch {
          continue;
        }
        const fmData = parsed.data as Record<string, unknown>;

        if (hasFmFilter) {
          let allMatch = true;
          for (const [k, v] of Object.entries(frontmatterFilter)) {
            if (!deepEqual(fmData[k], v)) {
              allMatch = false;
              break;
            }
          }
          if (!allMatch) continue;
        }

        if (hasTagFilter) {
          const fileTags = normalizeTags(fmData.tags);
          if (tagsAll.length > 0 && !tagsAll.every((t: string) => fileTags.includes(t))) {
            continue;
          }
          if (tagsAny.length > 0 && !tagsAny.some((t: string) => fileTags.includes(t))) {
            continue;
          }
          if (tagsNone.length > 0 && tagsNone.some((t: string) => fileTags.includes(t))) {
            continue;
          }
        }

        let matchCount = 0;
        let firstMatchAt: number | null = null;
        let snippet: string | null = null;
        if (pattern) {
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(parsed.content)) !== null) {
            if (firstMatchAt === null) firstMatchAt = m.index;
            matchCount++;
            if (m.index === pattern.lastIndex) pattern.lastIndex++;
          }
          if (matchCount === 0) continue;
          if (firstMatchAt !== null) {
            snippet = makeSnippet(parsed.content, firstMatchAt);
          }
        }

        const titleRaw = fmData.title;
        const title = typeof titleRaw === "string" ? titleRaw : null;

        results.push({
          path: filePath,
          matches: matchCount,
          modified: stat.mtime.toISOString(),
          size: stat.size,
          title,
          snippet,
          matchedFirstAt: firstMatchAt,
        });
      }

      results.sort((a, b) => {
        if (b.matches !== a.matches) return b.matches - a.matches;
        return b.modified.localeCompare(a.modified);
      });

      const truncated = results.slice(0, limit);

      return toolSuccessResult({
        results: truncated,
        totalMatching: results.length,
        filesScanned,
        truncated: results.length > limit,
      });
    }),
  );
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
      if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function makeSnippet(content: string, atIndex: number): string {
  const start = Math.max(0, atIndex - SNIPPET_BEFORE);
  const end = Math.min(content.length, atIndex + SNIPPET_AFTER);
  let snippet = content.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet.replace(/\s+/g, " ").trim();
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
