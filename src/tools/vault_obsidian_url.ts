import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { resolveVaultPath, VaultPathError } from "../vault.js";
import { toolErrorResult, toolSuccessResult } from "../errors.js";
import { withToolRuntime } from "../runtime.js";

export const vaultObsidianUrlInputShape = {
  path: z
    .string()
    .min(1)
    .describe("Path to the note relative to the vault root."),
  newPane: z
    .boolean()
    .optional()
    .describe("Hint to Obsidian to open in a new pane. Default: false."),
  vaultName: z
    .string()
    .optional()
    .describe(
      "Override the vault name. By default uses the basename of the configured vaultPath.",
    ),
};

const VAULT_OBSIDIAN_URL_DESCRIPTION =
  "Build an obsidian:// URL that opens a specific note in the user's Obsidian app. " +
  "Returns the URL as a string for the agent to surface to the user (or to a UI " +
  "layer that can launch URLs). The MCP itself cannot open Obsidian — this just " +
  "constructs the URL.";

export function registerVaultObsidianUrl(
  server: McpServer,
  config: Config,
): void {
  server.tool(
    "vault_obsidian_url",
    VAULT_OBSIDIAN_URL_DESCRIPTION,
    vaultObsidianUrlInputShape,
    withToolRuntime("vault_obsidian_url", async (args) => {
      const relPath = args.path;
      const newPane = args.newPane ?? false;
      const vaultName = args.vaultName ?? path.basename(path.resolve(config.vaultPath));

      try {
        resolveVaultPath(config.vaultPath, relPath);
      } catch (err) {
        if (err instanceof VaultPathError) {
          return toolErrorResult({
            tool: "vault_obsidian_url",
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

      const filePath = relPath.endsWith(".md") ? relPath.slice(0, -3) : relPath;

      const params = new URLSearchParams();
      params.set("vault", vaultName);
      params.set("file", filePath);
      if (newPane) params.set("newpane", "true");

      const url = `obsidian://open?${params.toString()}`;

      return toolSuccessResult({
        path: relPath,
        url,
        vaultName,
        newPane,
      });
    }),
  );
}
