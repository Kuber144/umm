# MCP server

`backend/mcp_server.py` lets AI agents search and add to umm. It runs over stdio and reads `data/umm.db` directly, so the app does not need to be running.

## Setup

Claude Code:

```
claude mcp add umm -s user -- uv --directory /Users/kuberjain/Developer/personal/umm/backend run mcp_server.py
```

Other clients (Codex, Cursor, and so on) take the same command in their MCP config:

```json
{
  "mcpServers": {
    "umm": {
      "command": "uv",
      "args": ["--directory", "/Users/kuberjain/Developer/personal/umm/backend", "run", "mcp_server.py"]
    }
  }
}
```

## Tools

| Tool | Parameters | Returns |
| --- | --- | --- |
| `search_memory` | `query`, `kind[]`, `app`, `since`, `until`, `sort`, `limit` (1-50, default 10), `offset`, `profile` (default `*`) | Items. Content over 500 characters is cut and marked `truncated`. |
| `get_memory` | `id` | One item with full content. |
| `remember` | `content`, `profile` (default `agent`) | New id. |
| `forget` | `id`, `allow_any` (default false) | Confirmation. |
| `list_profiles` | none | Names and item counts. |
| `list_apps` | `profile` (default `*`) | App names and counts, for the `app` filter. |

An item is `{id, profile, kind, content, file, app, created_at}`. For screenshots and voice, `file` is an absolute path the agent can open.

Search is AND-matched with prefix matching, so short keywords work best. `since` and `until` are `YYYY-MM-DD`, inclusive. `sort` is `relevance`, `new` or `old`.

## Profiles

- `user` holds what the person saved. `agent` holds what agents saved. Other profiles are made in the app.
- Search covers all profiles by default. Pass `profile` to narrow it.
- `remember` saves to `agent` unless told otherwise. It rejects empty content and `*`.
- `forget` only deletes items in `agent`. Deleting from any other profile needs `allow_any=true`, which agents should set only when the user asks.
