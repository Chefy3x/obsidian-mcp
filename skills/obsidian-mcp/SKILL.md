---
name: obsidian-mcp
description: Use this skill when working with the user's Obsidian vault — reading, writing, searching, or reorganizing notes; modifying frontmatter; managing folders; analyzing tags or backlinks. Triggers on phrases like "my vault", "Obsidian", "my notes", "the vault", "knowledge base", or any reference to a specific note path. Provides decision rules, workflow patterns, and anti-patterns for the obsidian-mcp tools so agents compose them correctly the first time.
---

# Obsidian MCP — Agent Workflow Guide

This MCP exposes 22 tools for autonomous agent operation on an Obsidian vault. Atomic writes, backlink-aware moves, soft delete, structured errors. Built so agents can run unattended without corrupting data.

Every tool is namespaced as `vault_*`. All paths are relative to the vault root, POSIX separators (`/`), no `..`, no leading slash.

---

## Tool index — what's available

**Reading & inspection**
- `vault_read` — one note (frontmatter + body, streamed if ≥50KB)
- `vault_read_multiple` — up to 100 notes in one call (per-file errors don't abort the batch)
- `vault_list` — folder contents with metadata
- `vault_outline` — heading structure (H1–H6) without re-reading body
- `vault_links` — backlinks + forward links + broken-link list
- `vault_resolve_embeds` — expand `![[Note]]` / `![[Note#Heading]]` / `![[Note^block]]` transclusions inline
- `vault_stats` — vault-wide summary (counts, sizes, oldest/newest, top-N largest)
- `vault_tags` — unique tags with usage counts (supports prefix filter for hierarchical tags)

**Writing & editing**
- `vault_write` — atomic full-file write; modes: overwrite/append/prepend
- `vault_patch` — surgical str_replace with uniqueness check (preferred over `vault_write` whenever possible)
- `vault_frontmatter` — typed YAML ops: get / set / delete / replace (body untouched)
- `vault_create_folder` — idempotent
- `vault_delete` — soft delete to `.trash/` (default) or hard delete with `permanent: true`
- `vault_move` — rename or relocate; **automatically rewrites every backlink** (wiki + markdown forms)
- `vault_move_folder` — cascading move with backlink rewrites
- `vault_delete_folder` — modes: empty_only / recursive_to_trash / recursive_permanent
- `vault_batch` — sequence of mixed operations (write + patch + delete + move + create_folder) in one call

**Search & query**
- `vault_search` — content (text or regex), frontmatter exact-match, tag boolean (all/any/none), folder scope, ranked snippets
- `vault_query` — structured query: filters + select + sort + limit; preferred when you don't need text matching

**Safety & introspection**
- `vault_diff` — preview a `vault_write` or `vault_patch` without committing
- `vault_snapshot` — create / list / restore / delete vault save points
- `vault_reindex` — rebuild the backlink index (admin; rarely needed)
- `vault_obsidian_url` — build an `obsidian://open?...` URL for surfacing to a UI layer (the MCP cannot open Obsidian itself)

---

## Decision rules — pick the right tool

| Goal | Tool | Notes |
|---|---|---|
| Read a single note | `vault_read` | |
| Read 5+ notes | `vault_read_multiple` | One call, not five |
| Find notes by **content** | `vault_search` | Returns ranked snippets |
| Find notes by **metadata only** | `vault_query` | Faster, more flexible filters |
| List a folder | `vault_list` | |
| Navigate headings | `vault_outline` | Don't re-read the body if you only need TOC |
| Get full content with embeds expanded | `vault_resolve_embeds` | Single-level resolution |
| **Modify part of a note** | `vault_patch` | **Default for any edit smaller than 50% of file** |
| Replace a whole note | `vault_write` (overwrite) | Only when the whole body is being regenerated |
| Add to end of a note | `vault_write` (append) | Daily notes, log entries |
| Add to start | `vault_write` (prepend) | |
| Change frontmatter only | `vault_frontmatter` | Preserves body byte-for-byte |
| Rename or move a note | `vault_move` | **Never use shell `mv`** — backlinks |
| Delete | `vault_delete` | Soft by default → `.trash/` |
| Bulk restructure | `vault_batch` | Optionally `vault_snapshot` first |
| Find what links to X | `vault_links` | |
| Discover all tags | `vault_tags` | Use `prefix` for hierarchical |
| Vault size/health | `vault_stats` | |
| Preview before commit | `vault_diff` or `dryRun: true` on the underlying tool | |
| Check before risky bulk op | `vault_snapshot create` | Restorable in one call |

---

## Workflow templates

### Append to a daily note
```
1. vault_create_folder { path: "Daily" }            # idempotent, safe to always call
2. vault_write { path: "Daily/<YYYY-MM-DD>.md", content: "...", mode: "append" }
```

### Find all draft notes from the last 7 days
```
vault_query {
  where: {
    frontmatter: { status: "draft" },
    modifiedAfter: "<ISO 8601 7 days ago>"
  },
  sortBy: "modified",
  sortOrder: "desc"
}
```

### Tag a set of notes in bulk
```
1. vault_query → list of paths
2. vault_batch { operations: [
     { type: "write", ... }   # or use vault_frontmatter via individual calls
   ]}
```
For frontmatter changes specifically, call `vault_frontmatter` per file (not yet supported by vault_batch).

### Surgical edit: change one phrase across a known file
```
vault_patch {
  path: "...",
  old_str: "<exact unique text including enough context>",
  new_str: "<replacement>"
}
```
If `OLD_STR_NOT_UNIQUE`, widen the context until unique. If `OLD_STR_NOT_FOUND`, `vault_read` first to copy exact text including whitespace.

### Restructure that touches many files
```
1. vault_snapshot { operation: "create", label: "before <description>" }
2. vault_batch { operations: [...] }                 # atomic per-item; record any errors
3. (verify with vault_query / vault_links / vault_diff)
4. If broken: vault_snapshot { operation: "restore", snapshotId: "<from step 1>" }
```

### Find broken links across the vault
```
1. vault_query { select: ["path"] }                  # all notes
2. For each batch of paths: vault_links → collect brokenForwardLinks
```
(A future tool may roll this up; for now it's two-step.)

### Render a note for an LLM with embeds expanded
```
vault_resolve_embeds { path: "..." }
```
Returns both `content` (raw) and `resolvedContent` (with `![[X]]` substituted). Use `resolvedContent` for analysis; preserve `content` if you'll write back.

### Open a note in the user's Obsidian app
```
vault_obsidian_url { path: "..." }                   # returns the obsidian:// URL
# Surface the URL to the user — you cannot launch it from the MCP
```

---

## Anti-patterns — don't do these

1. **Don't full-overwrite when patching is enough.** `vault_write` blows away the whole file; `vault_patch` only touches the matched span. A bad write loses the entire note. Always prefer `vault_patch` for changes smaller than ~50% of the body.

2. **Don't move files via shell or `vault_write` to a new path + `vault_delete`.** Use `vault_move`. It rewrites every backlink in the vault — wiki form, markdown form, alias form. Manual approaches silently break links.

3. **Don't N×call when batch exists.** A folder-restructure with 8 moves should be one `vault_batch`, not eight `vault_move` calls. Batching shares one backlink-index load+save.

4. **Don't `permanent: true` by default.** The default soft-delete to `.trash/` is recoverable. Permanent delete is for cleanup of `.trash/` contents or known-temporary files.

5. **Don't skip the snapshot before risky ops.** Anything that touches >5 files in modes you haven't tested should be preceded by `vault_snapshot create`. It's free insurance.

6. **Don't read large notes repeatedly.** If you only need TOC, use `vault_outline`. If you need to find content, use `vault_search` (returns snippets). `vault_read` returns the whole body.

7. **Don't ignore `dryRun`.** Both `vault_patch` and `vault_frontmatter` accept `dryRun: true`. Use it when the agent isn't 100% sure the change is right — verify the diff, then commit.

8. **Don't write to absolute paths or use `..`.** Returns `PATH_ESCAPE`. Vault is a sandbox. Always relative-from-root.

---

## Reliability properties (rely on these)

- **Atomic writes.** Every write goes temp-file → fsync → rename. The target file is either the old content or the new content, never partial. A crash mid-write leaves the original intact.
- **Soft delete.** `vault_delete` default puts files in `.trash/<original-path>`, preserving folder structure. Collisions get timestamped suffixes. Recoverable until you explicitly empty `.trash/`.
- **Backlink-aware moves.** `vault_move` and `vault_move_folder` rewrite every `[[Wiki]]`, `[[Wiki|alias]]`, `[[Wiki#heading]]`, `[md](path.md)` in every other note that points at the moved file. Aliases (`aliases:` frontmatter) are also indexed and respected.
- **Per-call timeout.** Default 30s. If a tool hangs, you get a structured `TIMEOUT` error envelope, not silence.
- **Stateless across calls.** No in-memory caches between calls. The backlink index lives on disk at `.obsidian-mcp-cache/` and is mtime-invalidated.
- **Structured errors.** Every error has `code`, `message`, `attempted`, `suggestions`. Recover programmatically; don't just retry blindly.

---

## Common error codes — what they mean and what to do

| Code | Meaning | Recovery |
|---|---|---|
| `PATH_ESCAPE` | Path leaves vault root | Use a path relative to root, no `..`, no leading `/` |
| `NOT_FOUND` | File doesn't exist | `vault_list` parent folder; check spelling |
| `NOT_A_FILE` | Path is a folder | Use `vault_list` for folders |
| `OLD_STR_NOT_FOUND` (patch) | Search text not present | `vault_read` to copy exact text |
| `OLD_STR_NOT_UNIQUE` (patch) | Multiple matches | Widen the context until unique |
| `FILE_EXISTS` | Target exists, `failIfExists: true` | Pick a new name or set `failIfExists: false` |
| `PARENT_NOT_FOUND` | Parent folder missing | Set `createParents: true` or call `vault_create_folder` first |
| `FILE_TOO_LARGE` | File over 10MB cap | Use range-based ops (future) or split the file |
| `TIMEOUT` | Operation exceeded 30s | Investigate filesystem health; rerun |
| `OLD_STR_EQUALS_NEW_STR` | Patch is a no-op | Don't call; or fix the patch logic upstream |

---

## A note on what this MCP cannot do

These are intrinsic limits of a stdio MCP server, not bugs:

- **Cannot open notes in Obsidian's UI.** Use `vault_obsidian_url` to build an `obsidian://` URL and surface it to a UI layer.
- **Cannot interact with Obsidian plugins, Canvas, Excalidraw, or Dataview as a runtime.** (Dataview-style *queries* are covered by `vault_query`.)
- **Cannot stream change notifications.** No filesystem watching; agents must poll if they need to react to external changes.
- **Cannot sync.** Use Obsidian Sync, iCloud, or git separately.

Open-source: https://github.com/[user]/obsidian-mcp (placeholder; update on publish)
