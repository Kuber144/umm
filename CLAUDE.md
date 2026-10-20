# umm

Personal memory tool for macOS. A hotkey saves a screenshot with OCR text. Notes, folder paths and links get saved too. Agents search it over MCP. See `docs/plan.md` for scope and next steps.

## Layout

- `backend/` Python (uv). `db.py` holds all SQLite access, `api.py` is the FastAPI app for the UI and hotkeys, `mcp_server.py` serves agents.
- `ui/` React + Vite. Calls `/api/*`. In dev, Vite proxies to port 8000. After `npm run build`, FastAPI serves `ui/dist`.
- `menu/` hotkey menu (Ctrl+Shift+Space), one Swift file built by `start.sh`. It only draws the menu and calls the API.
- `data/` runtime files (`umm.db`, `shots/`, `profile.txt`, `umm.log`). Not source. Don't commit it.
- `docs/` plan and notes.

## Rules

- Write as little code as possible. A change that adds a dependency or a new file needs a reason.
- All SQL lives in `backend/db.py`. The API and MCP server call it and never touch SQLite directly.
- One table, `items`, an FTS5 virtual table. `rowid` is the id. Add a column before adding a table.
- Nothing app specific. No per-app scripts or app name lists. It has to work the same for anyone in any app.
- Watch memory and disk. Screenshots are JPG. Wrap PyObjC calls in API threads with `objc.autorelease_pool()`. Deleting an item deletes its file.
- No emojis anywhere.
- Run any doc, README or commit message through the `unslop` skill.

## Run

```
./start.sh   # backend + menu in the background
./stop.sh    # kill switch
cd ui && npm run dev   # UI dev server on 5173
```
