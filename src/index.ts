#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAllTools } from "./tools/index.js";

async function main(): Promise<void> {
  const config = await loadConfig();

  const server = new McpServer({
    name: "obsidian-mcp",
    version: "0.0.1",
  });

  registerAllTools(server, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`obsidian-mcp failed to start: ${message}\n`);
  process.exit(1);
});
