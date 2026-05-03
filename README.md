# obsidian-mcp

Agent-grade MCP server for Obsidian vaults.

> **Status:** Phase 1, in progress. Tool surfaces are registered but not yet implemented.

## What

A purpose-built [Model Context Protocol](https://modelcontextprotocol.io) server for Obsidian, designed for autonomous agent workflows. Atomic writes, backlink-aware moves, soft delete with trash, folder-aware operations, streaming reads, and structured errors that let agents recover.

## Roadmap

- **Phase 1 — Tier 1 (core):** `vault_read`, `vault_write`, `vault_patch`, `vault_move`, `vault_delete`, `vault_list`, `vault_create_folder`, `vault_delete_folder`, `vault_move_folder`.
- **Phase 2 — Tier 2 (search & structure):** `vault_search`, `vault_links`, `vault_frontmatter`.
- **Phase 3 — Tier 3 (advanced):** `vault_query`, `vault_diff`, `vault_snapshot`.
- **Phase 4:** Open-source release.

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
