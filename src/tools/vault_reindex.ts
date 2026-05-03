import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";
import { BacklinkIndex } from "../backlinks/index.js";

export const vaultReindexInputShape = {
  fromScratch: z
    .boolean()
    .optional()
    .describe(
      "If true, ignore the existing cache and re-parse every file. Default: false " +
        "(uses mtime+size to skip unchanged files).",
    ),
};

const VAULT_REINDEX_DESCRIPTION =
  "Refresh the backlink index. Walks every .md file in the vault, re-parses changed " +
  "files, and writes the cache to .obsidian-mcp-cache/backlinks.json. Backlink-aware " +
  "tools (vault_move, vault_move_folder, vault_delete_folder) call this internally; " +
  "you only need to call it explicitly to force a rebuild.";

export function registerVaultReindex(server: McpServer, config: Config): void {
  server.tool(
    "vault_reindex",
    VAULT_REINDEX_DESCRIPTION,
    vaultReindexInputShape,
    withToolRuntime("vault_reindex", async (args) => {
      const fromScratch = args.fromScratch ?? false;

      const index = await BacklinkIndex.load(config.vaultPath);
      if (fromScratch) index.clear();

      const startMs = Date.now();
      const stats = await index.refresh();
      const refreshMs = Date.now() - startMs;

      await index.save();

      return toolSuccessResult({
        ...stats,
        totalFilesIndexed: index.size(),
        refreshDurationMs: refreshMs,
        fromScratch,
      });
    }),
  );
}
