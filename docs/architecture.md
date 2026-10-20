# Architecture

umm is one macOS app, `umm.app`. It owns the `Ctrl+Shift+Space` hotkey, shows the hotbar and the main window, and runs the Python backend as a child process. Quitting the app kills the backend. That is the kill switch. If the backend dies on its own, the app restarts it after 1s, 2s, 4s and so on up to 30s. Exit status 0 means the backend asked for it (after a data folder move), so it restarts after 0.5s. On start it kills any orphaned backend still holding the socket.

No TCP ports. The backend listens on a Unix socket at `~/Library/Application Support/umm/umm.sock`, so it can't clash with dev servers.

```
umm.app (Swift, app/)
  hotkey, hotbar panel, main window, status bar item
  both windows are WKWebView loading umm://app/...
  umm:// scheme handler  ->  HTTP over umm.sock  ->  backend
  starts backend/.venv/bin/python -m uvicorn api:app --uds umm.sock
backend/ (Python, FastAPI)
  api.py routes, db.py all SQL, record.py mic + Whisper, embed.py search model (child process), settings.py defaults for settings.json
  serves ui/dist at / and <data>/files at /api/files
mcp_server.py (stdio, started by Claude Code, reads umm.db directly)
ui/ (React + Vite)
  one app, two views: main window at /, hotbar at /#hotbar
```

## Folders and owners

- `app/` Swift sources, `app/build.sh`, `app/Info.plist`, `app/AppIcon.icns`. Build output goes to `build/umm.app`.
- `backend/` Python.
- `ui/` React.
- `assets/` icon source (`icon.svg`).
- The data folder (see below): `umm.db`, `files/` (screenshots `.jpg` with a `.thumb.jpg` next to each, recordings `.m4a`), `model/` (search model, 120 MB, downloaded on first save), `profile.txt`, `profiles.txt` (created profile names), `settings.json` (only what the person changed), `agents/` (connected MCP servers). The database runs in WAL mode, so `umm.db-wal` and `umm.db-shm` sit next to it. The folder is mode 700 and the backend runs with umask 077, so other users on the Mac can't read it.
- `start.sh` builds what's missing and opens `build/umm.app`. `stop.sh` quits it. `build.sh` skips the app build when nothing in `app/` is newer than the binary, and signs ad hoc, so permissions may be asked again after a rebuild. If a certificate named "umm local signing" exists in the keychain (`scripts/setup-signing.sh`), it signs with that instead and permissions survive rebuilds.

## Data folder

The data folder defaults to `~/Library/Application Support/umm`. The backend, the MCP server and the CLI find it the same way: `UMM_DATA` if set (tests and dev), else the absolute path in the pointer file `~/Library/Application Support/umm/location`, else the default. When the folder in the pointer is missing (an unplugged drive, a deleted folder), they use the default folder and the backend logs it, so the app keeps working. The pointer stays, and the next start after the folder is back uses it again. The Swift app does not read it. The backend reads it on every start, so a restart follows a move.

`umm.sock`, `umm.log` and `location` always stay in `~/Library/Application Support/umm`, wherever the data is. A Unix socket path must be under 104 bytes, and this one is about 60 for a normal user name. Every client finds it without reading the pointer.

On the first start with no pointer and no database in the default folder, `db.py` moves an old `<repo>/data` there, all but `umm.sock` and `umm.log`, and logs it.

`POST /api/storage/move` copies the folder to a new place, checks the copied database has every item, writes the pointer, deletes the old folder and exits with status 0. The app then restarts the backend at the new place. It first waits for writes already in flight (a screenshot being read, say). During the move other writes get 503, and MCP writes wait on the database lock. An MCP server that is already running sees the pointer change on its next message and reopens at the new folder.

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
file: name under /api/files/ (screenshot jpg or voice m4a), else null. Screenshots also have /api/thumb/{file}, 640px wide.
      A screenshot past screenshot_days has file null and keeps its OCR text and meta
app:  "App: window title" of the app the user was in. For MCP saves: "<agent name>: <project folder name>"
meta: JSON object or null. Every save sets meta.source: hotbar | app (main window) | cli | mcp.
      The CLI also sets cwd. MCP saves set {source: "mcp", agent, agent_version, cwd, session}: the client name and version
      from the MCP handshake, the folder the agent runs in, and an id per MCP server process (one per agent session)
      Enriched links set {link: {site, title, author, text}, icon}, see "Link enrichment". A link that was refused or could not
      be read gets {tried: 1} instead.
      meta.url is the page or document the user was on, when Swift could read it over Accessibility (see /api/context)

GET    /api/items?q=&profile=&kind=&app=&since=&until=&sort=&limit=50&offset=0&source=&agent=&project=&session=&mode=hybrid -> [Item]
         profile defaults to active, "*" = all. kind may be comma separated.
         app filters by app name (the part before ":"). since/until are YYYY-MM-DD or YYYY-MM-DD HH:MM (local time), inclusive.
         source, agent and session match those meta keys. project matches meta.cwd, that folder or any folder under it.
         sort: new | old | relevance. Default is relevance when q is set, else new. limit is capped at 200.
         mode: hybrid | keyword. With q, hybrid fuses keyword matches with meaning matches (docs/semantic-search.md).
         Without the model it is keywords only.
GET    /api/apps?profile=                                -> [{app, count}]   app names for the filter, most used first
GET    /api/origins?profile=                             -> [{source, agent, cwd, count}]   items per meta source, agent and folder,
                                                                    most first, for the source, agent and project filters
GET    /api/icon?app=                                    -> png      the icon of the installed app with that name (the part before ":"),
                                                                    64px, cached in <data>/files/icons/app-<name>.png. 404 when no app has the name
POST   /api/items      {content, app?, profile?, meta?}         -> {id}     kind auto detected, multi-line ok. Max 100,000 characters, else 422.
                                                                    Only an absolute path or one starting with ~/ is kind path.
                                                                    The same text, kind and profile saved in the last 10 seconds returns that id
                                                                    and saves nothing, so a double Enter saves once
PATCH  /api/items/{id} {content?, profile?}              -> {}       edit text and/or move to another profile. Same 100,000 limit.
                                                                    A new text on a link drops its fetched title and icon and looks it up again
DELETE /api/items/{id}                                   -> {}       also deletes the file
POST   /api/capture    {app?, meta?, display?, area?, profile?} -> {id}  screenshot + OCR + thumbnail, takes ~1s. 403 when the front app is in excluded_apps
                                                                    (the server reads the front app itself, whatever `app` says). 412 when screencapture fails,
                                                                    which usually means Screen Recording is not allowed for umm
                                                                    display: 1-based number for screencapture -D, default main display
                                                                    area: true runs the interactive selection. Esc returns {id: null} and saves nothing
                                                                    meta defaults to {source: "hotbar"}, since only the hotbar captures without one.
                                                                    An image byte for byte equal to a screenshot saved in the same profile in the
                                                                    last 10 minutes returns that id and saves nothing. Same for /api/clipboard and /api/import
POST   /api/import     {path, app?, meta?, profile?}            -> {id}     an image file (png, jpeg, heic, gif, tiff, webp, read by content with sips -g format,
                                                                    not by extension) is converted to jpg and saved as a screenshot with OCR and a thumbnail.
                                                                    Anything else becomes a path item: folders, and images that are unreadable or broken. 400 when path is not an absolute path
                                                                    that exists (~/ is expanded). meta defaults to {source: "app"}, since the main window drops files
POST   /api/clipboard  {app?, meta?}                          -> {ids}    saves what the clipboard holds: image as a screenshot with OCR,
                                                                    copied files as one path item each, else text. 400 when empty, or when the
                                                                    clipboard is marked secret (see /api/context)
GET    /api/context?url=                                 -> {app, profile, clipboard_kind, clipboard, recording, url}
                                                                    clipboard_kind: text | image | files | null. clipboard is the text, or the
                                                                    copied paths one per line, empty for an image. Max 2000 chars. Clipboard content marked
                                                                    org.nspasteboard.ConcealedType or TransientType (password managers) is treated as empty.
                                                                    url is the query parameter echoed back, else null. Swift sends it, see "Page URL"
GET    /api/profiles                                     -> {active, all: [{name, count}]}   always includes user and agent
POST   /api/profiles   {name}                            -> {}       sets active, creates if new. Names are 1 to 60 characters, no `*`, `/` or newline
POST   /api/profiles/rename {from, to}                   -> {}       not for user or agent. 409 when `to` exists
DELETE /api/profiles/{name}                              -> {}       deletes its items and files, not for user or agent
GET    /api/settings                                     -> Settings
PATCH  /api/settings   {any Settings keys}               -> Settings  422 on a bad value, unknown keys are ignored
GET    /api/storage                                      -> {path, bytes, kinds}   the data folder, its size and item count per kind
POST   /api/storage/move {path}                          -> {path}   moves the data folder, then the backend exits and the app restarts it.
                                                                    path must be absolute, writable, not inside the current folder,
                                                                    and empty or missing. 400 {detail} otherwise, 409 while recording.
                                                                    Every other write gets 503 during the move
GET    /api/record                                       -> {on, seconds, transcribing}
POST   /api/record/start {app?, meta?}                          -> same as GET /api/record. The voice item's app is empty when umm itself is in front
POST   /api/record/stop                                  -> same, transcription runs in background and the voice item appears when done
POST   /api/copy       {text}                            -> {}       puts text on the clipboard
POST   /api/reveal     {text}                            -> {}       reveals a path in Finder
POST   /api/copy-image {id}                              -> {}       puts a screenshot's image on the clipboard as PNG (macOS adds TIFF for apps that ask).
                                                                    404 for an unknown id, an item that is not a screenshot, or one without its image file
POST   /api/open       {id, reveal?}                     -> {}       opens the item's file in its default app (Preview for screenshots), or with
                                                                    reveal: true shows it in Finder. A path item's file is its path. 404 when there is no file
GET    /api/agents                                       -> [{agent, agent_version, cwd, session, pid, started, last_seen, connected, memories}]
         connected MCP servers. Each writes <data>/agents/<session>.json and deletes it on clean exit. connected = pid is alive,
         memories = items with that session. Sorted by last_seen, files of dead pids are removed after 30 days.
GET    /api/setup                                        -> {mcp, cli}   the commands that connect Claude Code and install the CLI,
                                                                    with this checkout's path
GET    /api/files/{name}                                 -> file
GET    /api/thumb/{name}                                 -> jpg      thumbnail of a screenshot, made on first request for old ones
```

Settings live in `settings.json` in the data folder. The defaults are the `Settings` model in `backend/settings.py`, the only place they are written. `settings.get()` reads the file on every call, so `record.py` and `api.py` pick up a change without a restart.

```
Settings = {languages, model, enrich_links, excluded_apps, screenshot_days}
languages:      language codes Whisper may detect, default ["en", "hi"]. [] allows any language
model:          "small" | "medium", default "medium"
enrich_links:   default true, fetch title and description of saved links (not links with a secret looking query parameter)
excluded_apps:  default [], app names (the part of Item.app before ":", case insensitive)
                that POST /api/capture refuses
screenshot_days: default 0 (keep forever). A background thread runs at backend start and every 24 hours. It deletes the image
                and thumbnail of every screenshot older than this many days and sets its file to null. The item, OCR text and meta stay
```

## Link enrichment

When a link is saved, `db.add` starts a background thread (`db.enrich`, fetch code in `backend/link.py`). Saving stays instant. Tweet URLs on x.com and twitter.com use the oEmbed endpoint of X. YouTube URLs use the YouTube oEmbed endpoint. Any other URL is fetched once, HTML only, with an 8 second limit, the first 256 KB, and redirects followed. The page is read for `og:site_name`, `og:title` or `<title>`, and `og:description` or the description meta tag.

The result is stored twice. Search only indexes `content`, and the UI needs the fields apart.

- `meta.link = {site, title, author, text}`. Empty keys are left out. Tweets have site `X`, author `Name (@handle)` and the tweet text. YouTube has the video title and the channel as author.
- The same values are appended to `content`, one per line, after the original text. The URL stays on the first line, `kind` stays `link`, and copy still gives the URL. The UI cuts the appended lines when it shows a note typed after the URL.
- `meta.icon` is a file name like `icons/youtube.com.ico`, served from `/api/files/`. It comes from the page's `<link rel="icon">`, then apple-touch-icon, then `/favicon.ico`, at most 100 KB. It is saved once per host in `files/icons/` in the data folder and never refetched. Deleting an item keeps the icon, because other links share it.

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
{type: "accessibility"}            ask macOS for Accessibility (AXIsProcessTrustedWithOptions with the prompt), open its pane in
                                   System Settings, then reply like "settings". The grant happens later, so ask "settings" again on focus
{type: "chooseFolder"}             folder picker (can create folders). Swift replies with window.ummFolder, nothing on cancel
{type: "quit"}                     kill switch, quits the app and the backend
```

Swift to UI:

```
window.ummShow?.(context)   called every time the hotbar opens. context is GET /api/context?url=, fetched by Swift
                            BEFORE umm takes focus so `app` is the user's app. If the request fails, Swift tries once more before it passes `{}`. UI resets, focuses the input.
                            In browser dev the UI calls this itself on load with a fetched context.
window.ummOpen?.({query})   main window shown, optional search query
window.ummDrop?.({paths})   files dropped on the main window, absolute paths. Swift takes the drop so WebKit does not open the file.
                            The UI posts each path to /api/import. Dropped text is not intercepted and reaches the page as a normal drop
window.ummSettings?.({loginItem, version, accessibility})
                            reply to "settings" and "loginItem". loginItem is on | approval | off | missing.
                            approval means macOS wants the person to allow it in System Settings, Login Items.
                            version is CFBundleShortVersionString. accessibility is AXIsProcessTrusted().
                            Browser dev never calls it and the UI hides the startup row.
window.ummFolder?.(path)    reply to "chooseFolder", the absolute path of the picked folder
```

## Page URL

When umm has the Accessibility permission, Swift reads the front app over the generic AX API as the hotbar opens, before it fetches the context. It takes the focused window's `AXDocument` (a file URL in editors, the page URL in Chrome). If that is empty, it walks up from the focused element to an `AXWebArea` and takes its `AXURL`. No per-app code. It sends the result as `GET /api/context?url=`, so `context.url` holds it. Swift adds it to the hotbar screenshot as `meta = {source: "hotbar", url}`, and the UI adds `meta.url` to notes and clipboard saves from the hotbar. Each AX call waits at most 0.5 seconds. Firefox shows no web area unless an assistive app is running, so it gets no URL. Without the permission, `url` is null and nothing else changes.

## OCR languages

Apple Vision (VNRecognizeTextRequest, revision 3) on macOS 26 lists 30 OCR languages and no Indic one, so Devanagari in a screenshot is not read and `languages` stays a Whisper setting.

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
9. Quit umm. While recording, the first `Enter` asks again

While typing, `Enter` runs a row only when the query starts its label ("scr" takes a screenshot). Otherwise it copies the first matching memory, or searches. `Enter` while an input method is composing does nothing, and the arrow keys stop at the ends. A half-written note stays when the hotbar closes.

## Main window

The sidebar lists profiles, then All profiles, Connections and Settings. Clicking a profile only browses it. The active profile, where hotkey saves go, changes in Settings, the hotbar "Switch profile" row, or by creating a profile. A note written in the main window goes to the profile on screen.

Each row shows the app's icon (`/api/icon`), a link's site icon, or a monogram for agents and apps that are not installed. A small glyph marks items saved from the CLI or the main window. Agent memories show the agent and project folder. The agent profile has chips to narrow by agent and project, and Filter has app, source, agent, project and dates.

Connections lists `GET /api/agents`: connected agents with a live dot, then recent sessions, each with its project folder, last seen and memory count. Clicking one shows that session's memories across all profiles. It refreshes every 5 seconds and shows the MCP setup command.

## Settings view

The gear at the bottom of the sidebar, or `Cmd+,`, swaps the main window's list for the settings. Clicking a profile goes back. Sections: saving (which profile hotkey saves go to, same as the active profile), voice, privacy, storage, agents (the MCP command with this install's path, the CLI install command), startup, about. Every change saves at once.

The login item uses `SMAppService.mainApp`, which accepts the ad hoc signed bundle.
When an excluded app is in front, the hotbar screenshot plays the error sound and the menu bar item shows "Excluded app" for 3 seconds.

The hotbar panel is nonactivating. Swift activates umm for it only when the main window is closed. With the main window open, activating would raise that window over the user's app, and the screenshot would capture umm. The panel takes keys without activation.

At launch Swift calls `CGPreflightScreenCaptureAccess` and, if Screen Recording is missing, `CGRequestScreenCaptureAccess`.

## Recordings and crashes

A recording is a `.flac` in `files/` in the data folder until its transcription is saved. On backend start, `record.recover` transcribes every `.flac` that has no item, one at a time, into the active profile with an empty app. The Whisper child process exits when the backend dies, so a killed backend does not leave it running.

## Rules for every agent

- Write as little code as possible. Match the surrounding style.
- Only edit your own folder unless told otherwise. Don't commit; the lead commits.
- Nothing app specific. It must work the same for anyone, in any app.
- Watch memory and disk.
- Run any prose you write (docs, comments, commit text) through the `unslop` skill. No emojis.
