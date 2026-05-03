import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { BacklinkIndex } from "../backlinks/index.js";
import { parseEmbeds, extractBlockById } from "../embeds.js";
import { extractHeadingSection } from "../headings.js";

export const vaultResolveEmbedsInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root."),
};

const VAULT_RESOLVE_EMBEDS_DESCRIPTION =
  "Resolve all '![[Note]]', '![[Note#Heading]]', and '![[Note^block]]' transclusions " +
  "in a note, returning both the original body and a fully-expanded version with " +
  "embed content substituted inline. Single-level resolution only (nested embeds in " +
  "the resolved output are left as raw markers). Image/attachment embeds (.png, .pdf, " +
  "etc.) are reported but not expanded.";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESOLVABLE_EXTENSIONS = new Set([".md", ""]);

interface EmbedResult {
  rawText: string;
  target: string;
  fragment: string;
  alias: string | null;
  resolvedFromPath: string | null;
  success: boolean;
  bytesIncluded: number;
  error: string | null;
}

export function registerVaultResolveEmbeds(
  server: McpServer,
  config: Config,
): void {
  server.tool(
    "vault_resolve_embeds",
    VAULT_RESOLVE_EMBEDS_DESCRIPTION,
    vaultResolveEmbedsInputShape,
    withToolRuntime("vault_resolve_embeds", async ({ path: relPath }) => {
      let absPath: string;
      try {
        absPath = resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_resolve_embeds",
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
            tool: "vault_resolve_embeds",
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
          tool: "vault_resolve_embeds",
          code: "NOT_A_FILE",
          message: `Path is not a regular file: ${relPath}`,
          attempted: { path: relPath },
          suggestions: ["vault_resolve_embeds operates on a single note."],
        });
      }
      if (stat.size > MAX_FILE_BYTES) {
        return toolErrorResult({
          tool: "vault_resolve_embeds",
          code: "FILE_TOO_LARGE",
          message: `File exceeds max size of ${MAX_FILE_BYTES} bytes (got ${stat.size}).`,
          attempted: { path: relPath, size: stat.size },
          suggestions: ["vault_resolve_embeds currently caps at 10MB."],
        });
      }

      const raw = await fs.readFile(absPath, "utf8");
      const parsed = matter(raw);
      const body = parsed.content;

      const embeds = parseEmbeds(body);
      if (embeds.length === 0) {
        return toolSuccessResult({
          path: relPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          frontmatter: parsed.data,
          content: body,
          resolvedContent: body,
          embedCount: 0,
          embeds: [],
        });
      }

      const index = await BacklinkIndex.load(config.vaultPath);
      await index.refresh();
      await index.save();
      const resolutionMap = index.wikilinkResolutionMap();

      const results: EmbedResult[] = [];
      let resolved = "";
      let cursor = 0;

      for (const embed of embeds) {
        resolved += body.slice(cursor, embed.start);
        cursor = embed.end;

        const result = await resolveOneEmbed(
          embed,
          config.vaultPath,
          resolutionMap,
        );
        results.push(result);

        if (result.success && result.resolvedFromPath) {
          const includedText = await readEmbedContent(
            embed,
            path.join(config.vaultPath, result.resolvedFromPath),
          );
          result.bytesIncluded = Buffer.byteLength(includedText, "utf8");
          resolved += includedText;
        } else {
          resolved += embed.rawText;
        }
      }
      resolved += body.slice(cursor);

      const successCount = results.filter((r) => r.success).length;

      return toolSuccessResult({
        path: relPath,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        frontmatter: parsed.data,
        content: body,
        resolvedContent: resolved,
        embedCount: embeds.length,
        successCount,
        embeds: results,
      });
    }),
  );
}

async function resolveOneEmbed(
  embed: ReturnType<typeof parseEmbeds>[number],
  vaultRoot: string,
  resolutionMap: Map<string, string[]>,
): Promise<EmbedResult> {
  const baseResult: EmbedResult = {
    rawText: embed.rawText,
    target: embed.target,
    fragment: embed.fragment,
    alias: embed.alias,
    resolvedFromPath: null,
    success: false,
    bytesIncluded: 0,
    error: null,
  };

  const ext = path.posix.extname(embed.target).toLowerCase();
  if (ext.length > 0 && !RESOLVABLE_EXTENSIONS.has(ext)) {
    const candidatePath = path.posix.normalize(embed.target);
    const abs = path.join(vaultRoot, candidatePath);
    try {
      const s = await fs.stat(abs);
      if (s.isFile()) {
        return {
          ...baseResult,
          resolvedFromPath: candidatePath,
          success: false,
          error: "ATTACHMENT_NOT_EXPANDED",
        };
      }
    } catch {
      /* fall through */
    }
    return { ...baseResult, error: "ATTACHMENT_NOT_FOUND" };
  }

  const baseLower = stripExt(embed.target).toLowerCase();
  const candidates = resolutionMap.get(baseLower);
  if (!candidates || candidates.length === 0) {
    return { ...baseResult, error: "TARGET_NOT_FOUND" };
  }
  const resolvedFromPath = candidates[0];
  return {
    ...baseResult,
    resolvedFromPath,
    success: true,
  };
}

async function readEmbedContent(
  embed: ReturnType<typeof parseEmbeds>[number],
  absResolvedPath: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(absResolvedPath, "utf8");
  } catch {
    return embed.rawText;
  }
  const parsed = matter(raw);
  const body = parsed.content;

  if (embed.fragment.startsWith("#")) {
    const headingText = embed.fragment.slice(1);
    const section = extractHeadingSection(body, headingText);
    return section ? section.text : embed.rawText;
  }
  if (embed.fragment.startsWith("^")) {
    const blockId = embed.fragment.slice(1);
    const block = extractBlockById(body, blockId);
    return block ?? embed.rawText;
  }
  return body.trim();
}

function stripExt(name: string): string {
  const ext = path.posix.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
