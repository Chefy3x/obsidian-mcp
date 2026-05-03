# obsidian-mcp

Agent-grade MCP server for Obsidian vaults.

> **Status:** Phase 1, in progress. Tool surfaces are registered but not yet implemented.

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

This package is intended to publish as `obsidian-mcp` on npm. If that name is unavailable at publish time, the fallback is `obsidian-agent-mcp`. The name is locked at first publish.

## License

MIT.
