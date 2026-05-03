import { promises as fs, createReadStream } from "node:fs";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

export const vaultReadMultipleInputShape = {
  paths: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Array of paths relative to the vault root. Cap: 100 paths per call.",
    ),
};

const VAULT_READ_MULTIPLE_DESCRIPTION =
  "Read up to 100 notes in a single call. Returns one entry per requested path with " +
  "either the parsed result (frontmatter + content + size + mtime) or a structured " +
  "per-file error. Reads are independent; one failure does not abort the batch.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const STREAMING_THRESHOLD_BYTES = 50 * 1024;
const MAX_PATHS = 100;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

interface ReadOk {
  path: string;
  size: number;
  modified: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

interface ReadErr {
  path: string;
  error: { code: string; message: string };
}

async function readFileViaStream(absPath: string): Promise<string> {
  const stream = createReadStream(absPath, { encoding: "utf8" });
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as string);
  }
  return chunks.join("");
}

export function registerVaultReadMultiple(
  server: McpServer,
  config: Config,
): void {
  server.tool(
    "vault_read_multiple",
    VAULT_READ_MULTIPLE_DESCRIPTION,
    vaultReadMultipleInputShape,
    withToolRuntime("vault_read_multiple", async ({ paths }) => {
      if (paths.length > MAX_PATHS) {
        return toolErrorResult({
          tool: "vault_read_multiple",
          code: "TOO_MANY_PATHS",
          message: `Got ${paths.length} paths; cap is ${MAX_PATHS}.`,
          attempted: { count: paths.length },
          suggestions: ["Split into smaller batches."],
        });
      }

      const results: Array<ReadOk | ReadErr> = [];
      let totalBytes = 0;
      let successCount = 0;
      let errorCount = 0;

      for (const relPath of paths) {
        const result = await readOne(config.vaultPath, relPath);
        if ("error" in result) {
          errorCount++;
        } else {
          successCount++;
          totalBytes += result.size;
          if (totalBytes > MAX_TOTAL_BYTES) {
            results.push({
              path: relPath,
              error: {
                code: "BATCH_TOO_LARGE",
                message: `Cumulative bytes exceeded ${MAX_TOTAL_BYTES}; remaining files not read.`,
              },
            });
            errorCount++;
            for (let i = paths.indexOf(relPath) + 1; i < paths.length; i++) {
              results.push({
                path: paths[i],
                error: {
                  code: "BATCH_ABORTED",
                  message: "Aborted after batch size limit reached.",
                },
              });
              errorCount++;
            }
            return toolSuccessResult({
              results: [...results, result],
              successCount,
              errorCount,
              totalBytes,
              aborted: true,
            });
          }
        }
        results.push(result);
      }

      return toolSuccessResult({
        results,
        successCount,
        errorCount,
        totalBytes,
        aborted: false,
      });
    }),
  );
}

async function readOne(vaultPath: string, relPath: string): Promise<ReadOk | ReadErr> {
  let absPath: string;
  try {
    absPath = resolveVaultPath(vaultPath, relPath);
  } catch (err) {
    if (err instanceof VaultPathError) {
      return { path: relPath, error: { code: err.code, message: err.message } };
    }
    throw err;
  }

  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path: relPath,
        error: { code: "NOT_FOUND", message: `No file at: ${relPath}` },
      };
    }
    throw err;
  }
  if (!stat.isFile()) {
    return {
      path: relPath,
      error: { code: "NOT_A_FILE", message: `Not a regular file: ${relPath}` },
    };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      path: relPath,
      error: {
        code: "FILE_TOO_LARGE",
        message: `File exceeds ${MAX_FILE_BYTES} bytes (got ${stat.size}).`,
      },
    };
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
    return {
      path: relPath,
      error: {
        code: "FRONTMATTER_PARSE_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  return {
    path: relPath,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    frontmatter,
    content,
  };
}
