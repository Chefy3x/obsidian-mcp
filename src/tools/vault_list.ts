import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

export const vaultListInputShape = {
  path: z
    .string()
    .optional()
    .describe(
      "Folder path relative to the vault root. Omit or pass '.' to list the vault root.",
    ),
  includeHidden: z
    .boolean()
    .optional()
    .describe(
      "Include dotfiles and dot-folders (e.g. .obsidian, .trash). Default false.",
    ),
  includeFrontmatterTitle: z
    .boolean()
    .optional()
    .describe(
      "For .md files, parse frontmatter and include the title field. Default true. " +
        "Set false on very large folders for faster listing.",
    ),
};

const VAULT_LIST_DESCRIPTION =
  "List the contents of a folder in the vault. Returns one entry per file or subfolder " +
  "with name, path, type, size, modified time, and (for .md files) frontmatter title. " +
  "Folders are listed before files, alphabetical within each group.";

const FRONTMATTER_TITLE_MAX_BYTES = 500 * 1024;

interface VaultListEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  modified?: string;
  frontmatterTitle?: string | null;
}

export function registerVaultList(server: McpServer, config: Config): void {
  server.tool(
    "vault_list",
    VAULT_LIST_DESCRIPTION,
    vaultListInputShape,
    withToolRuntime("vault_list", async (args) => {
      const relPath = args.path ?? ".";
      const includeHidden = args.includeHidden ?? false;
      const includeFrontmatterTitle = args.includeFrontmatterTitle ?? true;

      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_list",
            code: err.code,
            message: err.message,
            attempted: { path: relPath },
            suggestions: [
              "Use a path relative to the vault root with no leading slash and no '..' segments.",
              "Pass '.' or omit the path to list the vault root.",
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
            tool: "vault_list",
            code: "NOT_FOUND",
            message: `No folder at vault path: ${relPath}`,
            attempted: { path: relPath },
            suggestions: [
              "Check the path is correct.",
              "List the parent folder first to discover what exists.",
            ],
          });
        }
        throw err;
      }

      if (!stat.isDirectory()) {
        return toolErrorResult({
          tool: "vault_list",
          code: "NOT_A_FOLDER",
          message: `Path is not a folder: ${relPath}`,
          attempted: { path: relPath },
          suggestions: ["vault_list only lists folders. Use vault_read for files."],
        });
      }

      const dirents = await fs.readdir(absPath, { withFileTypes: true });

      const maybeEntries = await Promise.all(
        dirents.map((dirent) =>
          buildEntry(dirent, {
            absParent: absPath,
            relParent: relPath,
            includeHidden,
            includeFrontmatterTitle,
          }),
        ),
      );

      const entries = maybeEntries.filter(
        (e): e is VaultListEntry => e !== null,
      );

      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return toolSuccessResult({
        path: relPath,
        entries,
      });
    }),
  );
}

async function buildEntry(
  dirent: import("node:fs").Dirent,
  ctx: {
    absParent: string;
    relParent: string;
    includeHidden: boolean;
    includeFrontmatterTitle: boolean;
  },
): Promise<VaultListEntry | null> {
  if (!ctx.includeHidden && dirent.name.startsWith(".")) return null;

  const entryRelPath =
    ctx.relParent === "." || ctx.relParent === ""
      ? dirent.name
      : path.posix.join(toPosix(ctx.relParent), dirent.name);
  const entryAbsPath = path.join(ctx.absParent, dirent.name);

  if (dirent.isDirectory()) {
    return { name: dirent.name, path: entryRelPath, type: "folder" };
  }

  if (!dirent.isFile()) return null;

  let entryStat;
  try {
    entryStat = await fs.stat(entryAbsPath);
  } catch {
    return null;
  }

  const entry: VaultListEntry = {
    name: dirent.name,
    path: entryRelPath,
    type: "file",
    size: entryStat.size,
    modified: entryStat.mtime.toISOString(),
  };

  if (
    ctx.includeFrontmatterTitle &&
    dirent.name.toLowerCase().endsWith(".md") &&
    entryStat.size <= FRONTMATTER_TITLE_MAX_BYTES
  ) {
    entry.frontmatterTitle = await readFrontmatterTitle(entryAbsPath);
  }

  return entry;
}

async function readFrontmatterTitle(absPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(absPath, "utf8");
    const parsed = matter(raw);
    const title = (parsed.data as Record<string, unknown>).title;
    return typeof title === "string" ? title : null;
  } catch {
    return null;
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
