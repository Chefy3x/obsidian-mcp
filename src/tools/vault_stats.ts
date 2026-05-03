import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

const SKIP_DIRS = new Set([".trash", ".snapshots", ".obsidian", ".obsidian-mcp-cache"]);

export const vaultStatsInputShape = {
  scope: z
    .string()
    .optional()
    .describe(
      "Folder path relative to the vault root to scope the stats. Default: whole vault.",
    ),
};

const VAULT_STATS_DESCRIPTION =
  "Vault-wide summary: counts of notes (.md) and attachments (other files), folder " +
  "count, total bytes, oldest and newest modified times. Skips .obsidian/, .trash/, " +
  ".snapshots/, .obsidian-mcp-cache/.";

export function registerVaultStats(server: McpServer, config: Config): void {
  server.tool(
    "vault_stats",
    VAULT_STATS_DESCRIPTION,
    vaultStatsInputShape,
    withToolRuntime("vault_stats", async ({ scope }) => {
      const scopeRel = scope ?? ".";
      let scopeAbs: string;
      try {
        scopeAbs = resolveVaultPath(config.vaultPath, scopeRel);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_stats",
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
            tool: "vault_stats",
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
          tool: "vault_stats",
          code: "SCOPE_NOT_A_FOLDER",
          message: `Scope is not a folder: ${scopeRel}`,
          attempted: { scope: scopeRel },
          suggestions: ["Pass a folder path."],
        });
      }

      let noteCount = 0;
      let attachmentCount = 0;
      let folderCount = 0;
      let totalBytes = 0;
      let noteBytes = 0;
      let attachmentBytes = 0;
      let oldestModifiedMs: number | null = null;
      let newestModifiedMs: number | null = null;
      let oldestPath: string | null = null;
      let newestPath: string | null = null;
      const largestNotes: Array<{ path: string; size: number }> = [];
      const LARGEST_KEEP = 5;

      await walk(scopeAbs, "", true);

      async function walk(absDir: string, sub: string, atScopeRoot: boolean): Promise<void> {
        let dirents: import("node:fs").Dirent[];
        try {
          dirents = await fs.readdir(absDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const dirent of dirents) {
          if (atScopeRoot && SKIP_DIRS.has(dirent.name)) continue;
          if (dirent.name.startsWith(".")) continue;
          const childSub =
            sub === "" ? dirent.name : path.posix.join(toPosix(sub), dirent.name);
          const childAbs = path.join(absDir, dirent.name);
          if (dirent.isDirectory()) {
            folderCount++;
            await walk(childAbs, childSub, false);
            continue;
          }
          if (!dirent.isFile()) continue;

          let s;
          try {
            s = await fs.stat(childAbs);
          } catch {
            continue;
          }

          const isNote = dirent.name.toLowerCase().endsWith(".md");
          if (isNote) {
            noteCount++;
            noteBytes += s.size;
            if (largestNotes.length < LARGEST_KEEP) {
              largestNotes.push({ path: childSub, size: s.size });
              largestNotes.sort((a, b) => b.size - a.size);
            } else if (s.size > largestNotes[largestNotes.length - 1].size) {
              largestNotes.push({ path: childSub, size: s.size });
              largestNotes.sort((a, b) => b.size - a.size);
              largestNotes.pop();
            }
          } else {
            attachmentCount++;
            attachmentBytes += s.size;
          }
          totalBytes += s.size;

          if (oldestModifiedMs === null || s.mtimeMs < oldestModifiedMs) {
            oldestModifiedMs = s.mtimeMs;
            oldestPath = childSub;
          }
          if (newestModifiedMs === null || s.mtimeMs > newestModifiedMs) {
            newestModifiedMs = s.mtimeMs;
            newestPath = childSub;
          }
        }
      }

      return toolSuccessResult({
        scope: scopeRel,
        noteCount,
        attachmentCount,
        folderCount,
        totalBytes,
        noteBytes,
        attachmentBytes,
        oldestModified:
          oldestModifiedMs !== null
            ? { path: oldestPath, modified: new Date(oldestModifiedMs).toISOString() }
            : null,
        newestModified:
          newestModifiedMs !== null
            ? { path: newestPath, modified: new Date(newestModifiedMs).toISOString() }
            : null,
        largestNotes,
      });
    }),
  );
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
