import { promises as fs, createReadStream } from "node:fs";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

export const vaultReadInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root, e.g. 'Inbox/today.md'."),
};

const VAULT_READ_DESCRIPTION =
  "Read a note from the vault. Returns content and frontmatter as separate fields. " +
  "Path is relative to the vault root.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const STREAMING_THRESHOLD_BYTES = 50 * 1024;

async function readFileViaStream(absPath: string): Promise<string> {
  const stream = createReadStream(absPath, { encoding: "utf8" });
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as string);
  }
  return chunks.join("");
}

export function registerVaultRead(server: McpServer, config: Config): void {
  server.tool(
    "vault_read",
    VAULT_READ_DESCRIPTION,
    vaultReadInputShape,
    withToolRuntime("vault_read", async ({ path: relPath }) => {
      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_read",
            code: err.code,
            message: err.message,
            attempted: { path: relPath },
            suggestions: [
              "Use a path relative to the vault root, with no leading slash and no '..' segments.",
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
            tool: "vault_read",
            code: "NOT_FOUND",
            message: `No file at vault path: ${relPath}`,
            attempted: { path: relPath },
            suggestions: [
              "Check the path is correct.",
              "Use vault_list to discover what exists in the parent folder.",
            ],
          });
        }
        throw err;
      }

      if (!stat.isFile()) {
        return toolErrorResult({
          tool: "vault_read",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath },
          suggestions: [
            "vault_read only reads regular files. Use vault_list for directories.",
          ],
        });
      }

      if (stat.size > MAX_FILE_BYTES) {
        return toolErrorResult({
          tool: "vault_read",
          code: "FILE_TOO_LARGE",
          message: `File exceeds max read size of ${MAX_FILE_BYTES} bytes (got ${stat.size}).`,
          attempted: { path: relPath, size: stat.size },
          suggestions: [
            "vault_read currently caps at 10MB. Range reads will land in a later phase.",
          ],
        });
      }

      const raw =
        stat.size >= STREAMING_THRESHOLD_BYTES
          ? await readFileViaStream(absPath)
          : await fs.readFile(absPath, "utf8");

      let frontmatter: Record<string, unknown>;
      let content: string;
      try {
        const parsed = matter(raw);
        frontmatter = parsed.data as Record<string, unknown>;
        content = parsed.content;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolErrorResult({
          tool: "vault_read",
          code: "FRONTMATTER_PARSE_ERROR",
          message: `Failed to parse frontmatter: ${message}`,
          attempted: { path: relPath },
          suggestions: [
            "Frontmatter must be valid YAML between '---' fences at the top of the file.",
            "Read the file outside the MCP to inspect the malformed YAML, or fix it manually in Obsidian.",
          ],
        });
      }

      return toolSuccessResult({
        path: relPath,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        frontmatter,
        content,
      });
    }),
  );
}
