# umm

Personal memory tool for macOS. `umm.app` saves screenshots with OCR text, clipboard, notes, paths, links and voice recordings. Agents search it over MCP. See `docs/plan.md` for scope and `docs/architecture.md` for the API and the native bridge.

## Layout

- `app/` Swift. `main.swift` is the hotkey, hotbar panel, main window and menu bar item. `Backend.swift` runs the Python backend and talks to it over `~/Library/Application Support/umm/umm.sock`. `Web.swift` is the `umm://` scheme handler. `build.sh` builds `build/umm.app`.
- `backend/` Python (uv). `db.py` holds all SQLite access. `api.py` is the FastAPI app. `record.py` records the mic and runs Whisper. `link.py` fetches titles and icons for saved links. `settings.py` holds the defaults for `settings.json`. `mcp_server.py` serves agents.
- `ui/` React + Vite. One page, two views. The main window is `/` and the hotbar is `/#hotbar`. Calls `/api/*`, and the backend serves `ui/dist`.
- `assets/` icon sources.
- Data lives outside the repo, in `~/Library/Application Support/umm` or the folder named in its `location` file. `UMM_DATA` overrides both, for tests. The socket and log always stay in `~/Library/Application Support/umm`. See `docs/architecture.md`.
- `docs/` plan and architecture.

No TCP ports. The backend listens on a Unix socket and the app owns its lifetime.

## Rules

- Write as little code as possible. A change that adds a dependency or a new file needs a reason.
- All SQL lives in `backend/db.py`. The API and MCP server call it and never touch SQLite directly.
- One table, `items`, an FTS5 virtual table. `rowid` is the id. Add a column before adding a table.
- Nothing app specific. No per-app scripts or app name lists. It has to work the same for anyone in any app.
- Watch memory and disk. Screenshots are JPG and recordings are 16 kHz mono AAC `.m4a`. Whisper runs in a child process that exits when done. So does the search model (`embed.py`), after 3 idle minutes. Wrap PyObjC calls in API threads with `objc.autorelease_pool()`. Deleting an item deletes its file.
- No emojis anywhere.

## Run and test

```
./start.sh                       # builds what is missing, opens build/umm.app
./stop.sh                        # quits the app and the backend
cd ui && npm run build           # after UI changes, no app rebuild needed
cd ui && npm run dev             # Vite on 5173, proxies /api to the socket
cd ui && npm run lint
```

- `UMM_SHOW=main` or `UMM_SHOW=hotbar`, set on `build/umm.app/Contents/MacOS/umm`, opens a window at launch.
- `UMM_SWIFT_FLAGS="-D TEST" app/build.sh` adds test hooks. `SIGUSR1` toggles the hotbar and `UMM_JS` runs JavaScript in the hotbar page.
- Check the backend with `curl --unix-socket ~/Library/Application\ Support/umm/umm.sock http://umm/api/profiles`.
- Logs are in `~/Library/Application Support/umm/umm.log`.
- Test the backend with a temporary `HOME` (keep it short, the socket path must be under 104 bytes) or `UMM_DATA`, so nothing lands in your real data.
- Rebuilds are signed ad hoc, so macOS may ask for Screen Recording and Microphone again. `scripts/setup-signing.sh` creates a local certificate that keeps them.
