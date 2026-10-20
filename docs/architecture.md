# Architecture

umm is one macOS app, `umm.app`. It owns the `Ctrl+Shift+Space` hotkey, shows the hotbar and the main window, and runs the Python backend as a child process. Quitting the app kills the backend. That is the kill switch. If the backend dies on its own, the app restarts it after 1s, 2s, 4s and so on up to 30s. On start it kills any orphaned backend still holding the socket.

No TCP ports. The backend listens on a Unix socket at `data/umm.sock`, so it can't clash with dev servers.

```
umm.app (Swift, app/)
  hotkey, hotbar panel, main window, status bar item
  both windows are WKWebView loading umm://app/...
  umm:// scheme handler  ->  HTTP over data/umm.sock  ->  backend
  starts backend/.venv/bin/python -m uvicorn api:app --uds data/umm.sock
backend/ (Python, FastAPI)
  api.py routes, db.py all SQL, record.py mic + Whisper, embed.py search model (child process)
  serves ui/dist at / and data/files at /api/files
mcp_server.py (stdio, started by Claude Code, reads umm.db directly)
ui/ (React + Vite)
  one app, two views: main window at /, hotbar at /#hotbar
```

## Folders and owners

- `app/` Swift sources, `app/build.sh`, `app/Info.plist`, `app/AppIcon.icns`. Build output goes to `build/umm.app`.
- `backend/` Python.
- `ui/` React.
- `assets/` icon source (`icon.svg`).
- `data/` runtime only: `umm.db`, `files/` (screenshots `.jpg`, recordings `.m4a`), `model/` (search model, 120 MB, downloaded on first save), `profile.txt`, `profiles.txt` (created profile names), `umm.log`, `umm.sock`.
- `start.sh` builds what's missing and opens `build/umm.app`. `stop.sh` quits it. `build.sh` skips the app build when nothing in `app/` is newer than the binary, and signs ad hoc, so permissions may be asked again after a rebuild.

The app has no Dock icon (accessory mode) except while the main window is open. The menu bar item has "Open umm" and "Quit umm".

## Profiles

Profiles shape the whole UI. Every item belongs to one. Two always exist, even when empty, and can't be deleted or renamed:

- `user`: what the person saves. It is the active profile by default, so hotkey saves land here.
- `agent`: what AI agents save. MCP `remember` defaults to it, and MCP `search_memory` searches all profiles unless told otherwise.

People can add more (for example `work`, `side-project`), rename them, delete them (deletes their items and files) and move items between profiles. The active profile is always visible in the hotbar and the main window.

## Backend API

All JSON. Paths are the same over the socket and in the Vite dev proxy.

```
Item = {id, profile, kind, content, file, app, meta, created_at}
kind: screenshot | text | path | link | voice
file: name under /api/files/ (screenshot jpg or voice m4a), else null
app:  "App: window title" of the app the user was in. For MCP saves: "<agent name>: <project folder name>"
meta: JSON object or null. MCP saves set {agent, agent_version, cwd, session}: the client name and version
      from the MCP handshake, the folder the agent runs in, and an id per MCP server process (one per agent session)

GET    /api/items?q=&profile=&kind=&app=&since=&until=&sort=&limit=50&offset=0&mode=hybrid -> [Item]
         profile defaults to active, "*" = all. kind may be comma separated.
         app filters by app name (the part before ":"). since/until are YYYY-MM-DD, inclusive.
         sort: new | old | relevance. Default is relevance when q is set, else new. limit is capped at 200.
         mode: hybrid | keyword. With q, hybrid fuses keyword matches with meaning matches (docs/semantic-search.md).
         Without the model it is keywords only.
GET    /api/apps?profile=                                -> [{app, count}]   app names for the filter, most used first
POST   /api/items      {content, app?, profile?}         -> {id}     kind auto detected, multi-line ok
PATCH  /api/items/{id} {content?, profile?}              -> {}       edit text and/or move to another profile
DELETE /api/items/{id}                                   -> {}       also deletes the file
POST   /api/capture    {app?}                            -> {id}     screenshot + OCR, takes ~1s
GET    /api/context                                      -> {app, profile, clipboard, recording}
GET    /api/profiles                                     -> {active, all: [{name, count}]}   always includes user and agent
POST   /api/profiles   {name}                            -> {}       sets active, creates if new
POST   /api/profiles/rename {from, to}                   -> {}       not for user or agent
DELETE /api/profiles/{name}                              -> {}       deletes its items and files, not for user or agent
GET    /api/record                                       -> {on, seconds, transcribing}
POST   /api/record/start {app?}                          -> same as GET /api/record
POST   /api/record/stop                                  -> same, transcription runs in background and the voice item appears when done
POST   /api/copy       {text}                            -> {}       puts text on the clipboard
POST   /api/reveal     {text}                            -> {}       reveals a path in Finder
GET    /api/files/{name}                                 -> file
```

## Native bridge

The UI talks to the backend with plain `fetch('/api/...')`. In the app, the page is `umm://app/`, so that resolves to `umm://app/api/...` and the scheme handler forwards it. In dev, Vite proxies `/api` to the socket.

UI to Swift: `window.webkit.messageHandlers.umm.postMessage(msg)`. When that object is missing (browser dev), the UI falls back as noted.

```
{type: "hide"}                     close the hotbar, focus returns to the previous app
{type: "saved"}                    close the hotbar and play the "saved" sound (UI already did the fetch)
{type: "error"}                    play the error sound
{type: "capture"}                  close the hotbar, wait 250ms, POST /api/capture with the app from context, play sound
                                   fallback: fetch POST /api/capture
{type: "openMain", query?}         close the hotbar, show the main window, then call window.ummOpen?.({query})
                                   fallback: location.hash = ""
{type: "recording", on}            update the status bar item (red while recording)
{type: "resize", height}           hotbar panel height in CSS px, width is fixed at 680
{type: "openExternal", url}        open in the default browser
{type: "quit"}                     kill switch, quits the app and the backend
```

Swift to UI:

```
window.ummShow?.(context)   called every time the hotbar opens. context is GET /api/context, fetched by Swift
                            BEFORE umm takes focus so `app` is the user's app. UI resets, focuses the input.
                            In browser dev the UI calls this itself on load with a fetched context.
window.ummOpen?.({query})   main window shown, optional search query
```

## Hotbar

Opens on `Ctrl+Shift+Space`. Keyboard first. `Enter` on open takes a screenshot (top row), so `Ctrl+Shift+Space` then `Enter` is the fast path, also with Ctrl and Shift still held. Rows:

1. Screenshot
2. Save clipboard (shows a preview, hidden when the clipboard is empty)
3. Note: opens a multi-line editor in the hotbar. `Enter` is a new line, `Cmd+Enter` saves, `Esc` goes back
4. Start recording / Stop recording (shows elapsed time while on)
5. Search memories: typing filters the rows and shows matching memories below them. `Enter` on a memory copies it (path, link or text) and closes
6. Switch profile
7. Open umm (main window)
8. Quit umm

## Rules for every agent

- Write as little code as possible. Match the surrounding style.
- Only edit your own folder unless told otherwise. Don't commit; the lead commits.
- Nothing app specific. It must work the same for anyone, in any app.
- Watch memory and disk.
- Run any prose you write (docs, comments, commit text) through the `unslop` skill. No emojis.
