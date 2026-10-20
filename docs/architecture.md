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
  api.py routes, db.py all SQL, record.py mic + Whisper, embed.py search model (child process), settings.py defaults for data/settings.json
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
- `data/` runtime only: `umm.db`, `files/` (screenshots `.jpg` with a `.thumb.jpg` next to each, recordings `.m4a`), `model/` (search model, 120 MB, downloaded on first save), `profile.txt`, `profiles.txt` (created profile names), `settings.json` (only what the person changed), `umm.log`, `umm.sock`. The database runs in WAL mode, so `umm.db-wal` and `umm.db-shm` sit next to it. `data/` is mode 700 and the backend runs with umask 077, so other users on the Mac can't read it.
- `start.sh` builds what's missing and opens `build/umm.app`. `stop.sh` quits it. `build.sh` skips the app build when nothing in `app/` is newer than the binary, and signs ad hoc, so permissions may be asked again after a rebuild. If a certificate named "umm local signing" exists in the keychain (`scripts/setup-signing.sh`), it signs with that instead and permissions survive rebuilds.

The app has no Dock icon (accessory mode) except while the main window is open. The menu bar item has "Open umm" and "Quit umm".

## Profiles

Profiles shape the whole UI. Every item belongs to one. Two always exist, even when empty, and can't be deleted or renamed:

- `user`: what the person saves. It is the active profile by default, so hotkey saves land here.
- `agent`: what AI agents save. MCP `remember` defaults to it, and MCP `search_memory` searches all profiles unless told otherwise.

People can add more (for example `work`, `side-project`), rename them (not onto a name that exists), delete them (deletes their items and files) and move items between profiles. The active profile is always visible in the hotbar and the main window.

## Backend API

All JSON. Paths are the same over the socket and in the Vite dev proxy.

```
Item = {id, profile, kind, content, file, app, meta, created_at}
kind: screenshot | text | path | link | voice
file: name under /api/files/ (screenshot jpg or voice m4a), else null. Screenshots also have /api/thumb/{file}, 640px wide
app:  "App: window title" of the app the user was in. For MCP saves: "<agent name>: <project folder name>"
meta: JSON object or null. Every save sets meta.source: hotbar | app (main window) | cli | mcp.
      The CLI also sets cwd. MCP saves set {source: "mcp", agent, agent_version, cwd, session}: the client name and version
      from the MCP handshake, the folder the agent runs in, and an id per MCP server process (one per agent session)
      Enriched links set {link: {site, title, author, text}, icon}, see "Link enrichment". A link that was refused or could not
      be read gets {tried: 1} instead.

GET    /api/items?q=&profile=&kind=&app=&since=&until=&sort=&limit=50&offset=0&mode=hybrid -> [Item]
         profile defaults to active, "*" = all. kind may be comma separated.
         app filters by app name (the part before ":"). since/until are YYYY-MM-DD or YYYY-MM-DD HH:MM (local time), inclusive.
         sort: new | old | relevance. Default is relevance when q is set, else new. limit is capped at 200.
         mode: hybrid | keyword. With q, hybrid fuses keyword matches with meaning matches (docs/semantic-search.md).
         Without the model it is keywords only.
GET    /api/apps?profile=                                -> [{app, count}]   app names for the filter, most used first
POST   /api/items      {content, app?, profile?, meta?}         -> {id}     kind auto detected, multi-line ok. Max 100,000 characters, else 422.
                                                                    Only an absolute path or one starting with ~/ is kind path
PATCH  /api/items/{id} {content?, profile?}              -> {}       edit text and/or move to another profile. Same 100,000 limit.
                                                                    A new text on a link drops its fetched title and icon and looks it up again
DELETE /api/items/{id}                                   -> {}       also deletes the file
POST   /api/capture    {app?, meta?, display?, area?, profile?} -> {id}  screenshot + OCR + thumbnail, takes ~1s. 403 when the front app is in excluded_apps
                                                                    (the server reads the front app itself, whatever `app` says). 412 when screencapture fails,
                                                                    which usually means Screen Recording is not allowed for umm
                                                                    display: 1-based number for screencapture -D, default main display
                                                                    area: true runs the interactive selection. Esc returns {id: null} and saves nothing
POST   /api/clipboard  {app?, meta?}                          -> {ids}    saves what the clipboard holds: image as a screenshot with OCR,
                                                                    copied files as one path item each, else text. 400 when empty, or when the
                                                                    clipboard is marked secret (see /api/context)
GET    /api/context                                      -> {app, profile, clipboard_kind, clipboard, recording}
                                                                    clipboard_kind: text | image | files | null. clipboard is the text, or the
                                                                    copied paths one per line, empty for an image. Max 2000 chars. Clipboard content marked
                                                                    org.nspasteboard.ConcealedType or TransientType (password managers) is treated as empty
GET    /api/profiles                                     -> {active, all: [{name, count}]}   always includes user and agent
POST   /api/profiles   {name}                            -> {}       sets active, creates if new. Names are 1 to 60 characters, no `*`, `/` or newline
POST   /api/profiles/rename {from, to}                   -> {}       not for user or agent. 409 when `to` exists
DELETE /api/profiles/{name}                              -> {}       deletes its items and files, not for user or agent
GET    /api/settings                                     -> Settings
PATCH  /api/settings   {any Settings keys}               -> Settings  422 on a bad value, unknown keys are ignored
GET    /api/storage                                      -> {path, bytes, kinds}   size of data/ and item count per kind
GET    /api/record                                       -> {on, seconds, transcribing}
POST   /api/record/start {app?, meta?}                          -> same as GET /api/record. The voice item's app is empty when umm itself is in front
POST   /api/record/stop                                  -> same, transcription runs in background and the voice item appears when done
POST   /api/copy       {text}                            -> {}       puts text on the clipboard
POST   /api/reveal     {text}                            -> {}       reveals a path in Finder
GET    /api/agents                                       -> [{agent, agent_version, cwd, session, pid, started, last_seen, connected, memories}]
         connected MCP servers. Each writes data/agents/<session>.json and deletes it on clean exit. connected = pid is alive,
         memories = items with that session. Sorted by last_seen, files of dead pids are removed after 30 days.
GET    /api/files/{name}                                 -> file
GET    /api/thumb/{name}                                 -> jpg      thumbnail of a screenshot, made on first request for old ones
```

Settings live in `data/settings.json`. The defaults are the `Settings` model in `backend/settings.py`, the only place they are written. `settings.get()` reads the file on every call, so `record.py` and `api.py` pick up a change without a restart.

```
Settings = {languages, model, enrich_links, excluded_apps}
languages:      language codes Whisper may detect, default ["en", "hi"]. [] allows any language
model:          "small" | "medium", default "medium"
enrich_links:   default true, fetch title and description of saved links (not links with a secret looking query parameter)
excluded_apps:  default [], app names (the part of Item.app before ":", case insensitive)
                that POST /api/capture refuses
```

## Link enrichment

When a link is saved, `db.add` starts a background thread (`db.enrich`, fetch code in `backend/link.py`). Saving stays instant. Tweet URLs on x.com and twitter.com use the oEmbed endpoint of X. YouTube URLs use the YouTube oEmbed endpoint. Any other URL is fetched once, HTML only, with an 8 second limit, the first 256 KB, and redirects followed. The page is read for `og:site_name`, `og:title` or `<title>`, and `og:description` or the description meta tag.

The result is stored twice. Search only indexes `content`, and the UI needs the fields apart.

- `meta.link = {site, title, author, text}`. Empty keys are left out. Tweets have site `X`, author `Name (@handle)` and the tweet text. YouTube has the video title and the channel as author.
- The same values are appended to `content`, one per line, after the original text. The URL stays on the first line, `kind` stays `link`, and copy still gives the URL. The UI cuts the appended lines when it shows a note typed after the URL.
- `meta.icon` is a file name like `icons/youtube.com.ico`, served from `/api/files/`. It comes from the page's `<link rel="icon">`, then apple-touch-icon, then `/favicon.ico`, at most 100 KB. It is saved once per host in `data/files/icons/` and never refetched. Deleting an item keeps the icon, because other links share it.

A URL is not fetched when its query string has a parameter whose name contains `token`, `key`, `sig`, `code`, `auth`, `secret`, `pass`, `otp`, `session` or `reset`. Such links are often one time links (login, password reset, signed downloads), and opening them would use them up. A refused or failed fetch leaves the save alone and sets `meta.tried = 1`. On backend start, a background thread enriches every link with neither `meta.link` nor `meta.tried`, newest first, one per second, so a link that never resolves is tried once. Editing a link's text drops `meta.link`, `meta.icon` and `meta.tried` and looks the new URL up again.

Only URLs the user saved are fetched, and nothing else is sent. Turn `enrich_links` off in Settings to stop it all, icons included.

## Native bridge

The UI talks to the backend with plain `fetch('/api/...')`. In the app, the page is `umm://app/`, so that resolves to `umm://app/api/...` and the scheme handler forwards it. In dev, Vite proxies `/api` to the socket.

UI to Swift: `window.webkit.messageHandlers.umm.postMessage(msg)`. When that object is missing (browser dev), the UI falls back as noted.

```
{type: "hide"}                     close the hotbar, focus returns to the previous app
{type: "saved"}                    close the hotbar and play the "saved" sound (UI already did the fetch)
{type: "error"}                    play the error sound
{type: "capture"}                  close the hotbar, wait 250ms, POST /api/capture with the app from context and the
                                   display under the mouse, play sound. fallback: fetch POST /api/capture.
                                   On 412 the status item shows "Allow Screen Recording" for 3 seconds
{type: "area"}                     same, with area: true. No sound when the selection is cancelled
{type: "openMain", query?}         close the hotbar, show the main window, then call window.ummOpen?.({query})
                                   fallback: location.hash = ""
{type: "recording", on}            update the status bar item (red while recording)
{type: "resize", height}           hotbar panel height in CSS px, width is fixed at 680
{type: "openExternal", url}        open in the default browser
{type: "settings"}                 ask for the login item state, Swift replies with window.ummSettings
{type: "loginItem", on}            register or unregister umm as a login item (SMAppService.mainApp), then replies like "settings"
{type: "quit"}                     kill switch, quits the app and the backend
```

Swift to UI:

```
window.ummShow?.(context)   called every time the hotbar opens. context is GET /api/context, fetched by Swift
                            BEFORE umm takes focus so `app` is the user's app. If the request fails, Swift tries once more before it passes `{}`. UI resets, focuses the input.
                            In browser dev the UI calls this itself on load with a fetched context.
window.ummOpen?.({query})   main window shown, optional search query
window.ummSettings?.({loginItem, version})
                            reply to "settings" and "loginItem". loginItem is on | approval | off | missing.
                            approval means macOS wants the person to allow it in System Settings, Login Items.
                            version is CFBundleShortVersionString. Browser dev never calls it and the UI hides the startup row.
```

## Hotbar

Opens on `Ctrl+Shift+Space`. Keyboard first. `Enter` on open takes a screenshot (top row), so `Ctrl+Shift+Space` then `Enter` is the fast path, also with Ctrl and Shift still held. Rows:

1. Screenshot
2. Screenshot an area
3. Save clipboard (text preview, "Save clipboard image" or "Save N copied files", hidden when the clipboard is empty)
4. Note: opens a multi-line editor in the hotbar. `Enter` is a new line, `Cmd+Enter` saves, `Esc` goes back
5. Start recording / Stop recording (shows elapsed time while on)
6. Search memories: typing filters the rows and shows matching memories below them. Links show their title and site icon. `Enter` on a memory copies it (path, link or text) and closes
7. Switch profile
8. Open umm (main window)
9. Quit umm

## Settings view

The gear at the bottom of the sidebar, or `Cmd+,`, swaps the main window's list for the settings. Clicking a profile goes back. Sections: saving (which profile hotkey saves go to, same as the active profile), voice, privacy, storage, agents (the MCP command with this install's path, the CLI install command), startup, about. Every change saves at once.

The login item uses `SMAppService.mainApp`, which accepts the ad hoc signed bundle.
When an excluded app is in front, the hotbar screenshot plays the error sound and the menu bar item shows "Excluded app" for 3 seconds.

The hotbar panel is nonactivating. Swift activates umm for it only when the main window is closed. With the main window open, activating would raise that window over the user's app, and the screenshot would capture umm. The panel takes keys without activation.

At launch Swift calls `CGPreflightScreenCaptureAccess` and, if Screen Recording is missing, `CGRequestScreenCaptureAccess`.

## Recordings and crashes

A recording is a `.flac` in `data/files` until its transcription is saved. On backend start, `record.recover` transcribes every `.flac` that has no item, one at a time, into the active profile with an empty app. The Whisper child process exits when the backend dies, so a killed backend does not leave it running.

## Rules for every agent

- Write as little code as possible. Match the surrounding style.
- Only edit your own folder unless told otherwise. Don't commit; the lead commits.
- Nothing app specific. It must work the same for anyone, in any app.
- Watch memory and disk.
- Run any prose you write (docs, comments, commit text) through the `unslop` skill. No emojis.
