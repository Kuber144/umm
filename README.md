# umm (u might miss)

Press `Ctrl+Shift+Space`, then `Enter`, and umm saves your screen with its text. The same menu saves your clipboard or a typed note. Later you ask Claude Code "where did I put the tax docs" and it searches what you saved.

It all runs on your Mac. OCR uses Apple Vision, and storage is one SQLite file in `data/`. It works the same in every app. Each saved item records the app and window title you were in, like the browser tab title or the Finder folder name.

## Start and stop

```
./start.sh   # builds what's missing, runs the backend and hotkey menu in the background
./stop.sh    # kill switch, stops everything
```

The menu also has a "Stop umm" row that runs `stop.sh`.

The first time you capture, macOS asks for Screen Recording permission. Grant it to the terminal app you ran `start.sh` from, then run `./stop.sh && ./start.sh`.

## Hotkey menu

`Ctrl+Shift+Space` opens it from any app. While umm runs it always gets this combo first.

- `Enter` takes a screenshot, which is the top row. You can keep Ctrl+Shift held.
- Arrow keys pick another row, such as the clipboard. To save a folder path, copy it first (in Finder, `Cmd+Option+C`), then pick the clipboard row.
- To save a note, type it and press `Enter`.
- `Esc` closes the menu.

A pop sound means it saved. A low thud means the backend isn't running.

## Web UI

http://localhost:8000. Search, browse, delete, and switch or create profiles. Hotkey saves go to whichever profile is active.

## Claude Code and other agents

```
claude mcp add umm -s user -- uv --directory /Users/kuberjain/Developer/personal/umm/backend run mcp_server.py
```

Tools: `search_memory`, `remember`, `list_profiles`. An agent can keep its own profile by passing `profile="claude-code"` to `remember`. Search results for screenshots include the image path, so the agent can open the image when the OCR text isn't enough.

## Layout

```
backend/   FastAPI app, MCP server, db.py (all SQL)
menu/      hotkey menu, one Swift file
ui/        React + Vite
docs/      plan.md
data/      umm.db, shots/, profile.txt, umm.log (created on first run)
```
