# MCP server

`backend/mcp_server.py` lets AI agents search and add to umm. It runs over stdio and reads `data/umm.db` directly, so the app does not need to be running.

## Setup

Claude Code:

```
claude mcp add umm -s user -- uv run --project /Users/kuberjain/Developer/personal/umm/backend /Users/kuberjain/Developer/personal/umm/backend/mcp_server.py
```

Other clients (Codex, Cursor, and so on) take the same command in their MCP config:

```json
{
  "mcpServers": {
    "umm": {
      "command": "uv",
      "args": ["run", "--project", "/Users/kuberjain/Developer/personal/umm/backend", "/Users/kuberjain/Developer/personal/umm/backend/mcp_server.py"]
    }
  }
}
```

Use `--project`, not `--directory`. `--directory` changes the working folder to `backend/`, and umm records the folder the agent started in.

## Tools

| Tool | Parameters | Returns |
| --- | --- | --- |
| `search_memory` | `query`, `kind[]`, `app`, `since`, `until`, `sort`, `limit` (1-50, default 10), `offset`, `profile` (default `*`), `agent`, `project`, `here` | Items. Content over 500 characters is cut and marked `truncated`. |
| `get_memory` | `id` | One item with full content. |
| `remember` | `content`, `profile` (default `agent`) | New id. |
| `update_memory` | `id`, `content`, `allow_any` (default false) | Confirmation. Replaces the content. |
| `forget` | `id`, `allow_any` (default false) | Confirmation. |
| `list_profiles` | none | Names and item counts. |
| `list_apps` | `profile` (default `*`) | App names and counts, for the `app` filter. |

An item is `{id, profile, kind, content, file, app, meta, created_at}`. For screenshots and voice, `file` is an absolute path the agent can open.

Search is AND-matched with prefix matching, so short keywords work best. `since` and `until` are `YYYY-MM-DD`, inclusive. `sort` is `relevance`, `new` or `old`.

## Where a memory came from

`remember` stores `meta` = `{agent, agent_version, cwd, session}` and sets `app` to `<agent>: <folder name>`.

- `agent` and `agent_version` come from the client's MCP handshake.
- `cwd` is the folder the server started in, which is the agent's working folder.
- `session` is `CLAUDE_CODE_SESSION_ID` when the client sets it, else a random id per server process. Each agent session starts its own server.

Filter with `agent`, `project` (a folder and its subfolders) or `here` (the server's own folder). The user's saves have `meta: null`.

## Profiles

- `user` holds what the person saved. `agent` holds what agents saved. Other profiles are made in the app.
- Search covers all profiles by default. Pass `profile` to narrow it.
- `remember` saves to `agent` unless told otherwise. It rejects empty content and `*`.
- `update_memory` and `forget` only touch items in `agent`. Other profiles need `allow_any=true`, which agents should set only when the user asks.
- Search before `remember`. Use `update_memory` when a memory already covers the fact.
