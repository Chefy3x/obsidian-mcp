# obsidian-mcp

Agent-grade MCP server for Obsidian vaults.

> **Status:** v0.3.0 — fully implemented, dogfooding before npm publish.

## What

A purpose-built [Model Context Protocol](https://modelcontextprotocol.io) server for Obsidian, designed for autonomous agent workflows. Atomic writes, backlink-aware moves, soft delete with trash, folder-aware operations, streaming reads, and structured errors that let agents recover.

## Configuration

Create `~/.config/obsidian-mcp/config.json`:

```json
{
  "vaultPath": "/absolute/path/to/your/vault"
}
```

Or set `OBSIDIAN_MCP_VAULT=/absolute/path/to/your/vault` in the environment to override the config file (useful for development).

## Package name

Will publish as **`obsidian-agent-mcp`** on npm — the plain `obsidian-mcp` name is already taken by an unrelated package. The GitHub repo keeps the `obsidian-mcp` name.

## License

MIT.
