import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { BacklinkIndex } from "../backlinks/index.js";
import { parseLinks } from "../backlinks/parse.js";

export const vaultLinksInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root."),
};

const VAULT_LINKS_DESCRIPTION =
  "Get backlinks (sources that link in), forward links (links going out), and " +
  "broken forward links (forward links that don't resolve to any vault file) for " +
  "a single note. Backlinks come from the on-disk backlink index (refreshed each call).";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

interface ForwardLink {
  target: string;
  kind: "wikilink" | "markdown";
  resolvedPath: string | null;
  fragment: string;
  alias: string | null;
}

export function registerVaultLinks(server: McpServer, config: Config): void {
  server.tool(
    "vault_links",
    VAULT_LINKS_DESCRIPTION,
    vaultLinksInputShape,
    withToolRuntime("vault_links", async ({ path: relPath }) => {
      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_links",
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
            tool: "vault_links",
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
          tool: "vault_links",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath },
          suggestions: ["vault_links operates on a single note."],
        });
      }
      if (stat.size > MAX_FILE_BYTES) {
        return toolErrorResult({
          tool: "vault_links",
          code: "FILE_TOO_LARGE",
          message: `File exceeds max size of ${MAX_FILE_BYTES} bytes (got ${stat.size}).`,
          attempted: { path: relPath, size: stat.size },
          suggestions: ["vault_links currently caps at 10MB."],
        });
      }

      const index = await BacklinkIndex.load(config.vaultPath);
      await index.refresh();
      await index.save();

      const backlinks = index.findSources(relPath);

      const isMd = relPath.toLowerCase().endsWith(".md");
      const forwardLinks: ForwardLink[] = [];
      const brokenForwardLinks: Array<{ target: string; kind: "wikilink" | "markdown" }> = [];

      if (isMd) {
        const allFiles = index.allMdFiles();
        const basenameMap = new Map<string, string[]>();
        for (const f of allFiles) {
          const baseLower = stripExt(path.posix.basename(f)).toLowerCase();
          const list = basenameMap.get(baseLower);
          if (list) list.push(f);
          else basenameMap.set(baseLower, [f]);
        }

        const content = await fs.readFile(absPath, "utf8");
        const links = parseLinks(content);
        const sourceDirPosix = path.posix.dirname(toPosix(relPath));
        const baseDir = sourceDirPosix === "." ? "" : sourceDirPosix;

        for (const link of links) {
          if (link.kind === "wikilink") {
            const baseLower = stripExt(link.target).toLowerCase();
            const candidates = basenameMap.get(baseLower) ?? [];
            const resolvedPath = candidates[0] ?? null;
            forwardLinks.push({
              target: link.target,
              kind: "wikilink",
              resolvedPath,
              fragment: link.fragment,
              alias: link.alias,
            });
            if (!resolvedPath) {
              brokenForwardLinks.push({ target: link.target, kind: "wikilink" });
            }
          } else {
            const resolvedPosix = path.posix.normalize(
              path.posix.join(baseDir, link.target),
            );
            const resolvedAbs = path.join(config.vaultPath, resolvedPosix);
            let exists = false;
            try {
              await fs.access(resolvedAbs);
              exists = true;
            } catch {
              exists = false;
            }
            forwardLinks.push({
              target: link.target,
              kind: "markdown",
              resolvedPath: exists ? resolvedPosix : null,
              fragment: link.fragment,
              alias: link.alias,
            });
            if (!exists) {
              brokenForwardLinks.push({ target: link.target, kind: "markdown" });
            }
          }
        }
      }

      return toolSuccessResult({
        path: relPath,
        backlinks,
        forwardLinks,
        brokenForwardLinks,
      });
    }),
  );
}

function stripExt(name: string): string {
  const ext = path.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function toPosix(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}
