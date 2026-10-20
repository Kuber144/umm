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
- The data folder (see below): `umm.db`, `files/` (screenshots `.jpg` with a `.thumb.jpg` next to each, recordings `.m4a`, `clipboard/` with the images of the clipboard history), `model/` (search model, 120 MB, downloaded on first save), `profile.txt`, `profiles.txt` (created profile names), `settings.json` (only what the person changed), `clipboard.json` (clipboard history), `agents/` (connected MCP servers). The database runs in WAL mode, so `umm.db-wal` and `umm.db-shm` sit next to it. The folder is mode 700 and the backend runs with umask 077, so other users on the Mac can't read it.
- `start.sh` builds what's missing and opens `build/umm.app`. `stop.sh` quits it. `build.sh` skips the app build when nothing in `app/` is newer than the binary, and signs ad hoc, so permissions may be asked again after a rebuild. If a certificate named "umm local signing" exists in the keychain (`scripts/setup-signing.sh`), it signs with that instead and permissions survive rebuilds.

## Data folder

The data folder defaults to `~/Library/Application Support/umm`. The backend, the MCP server and the CLI find it the same way: `UMM_DATA` if set (tests and dev), else the absolute path in the pointer file `~/Library/Application Support/umm/location`, else the default. When the folder in the pointer is missing (an unplugged drive, a deleted folder), they use the default folder and the backend logs it, so the app keeps working. The pointer stays, and the next start after the folder is back uses it again. The Swift app does not read it. The backend reads it on every start, so a restart follows a move.

`umm.sock`, `umm.log` and `location` always stay in `~/Library/Application Support/umm`, wherever the data is. A Unix socket path must be under 104 bytes, and this one is about 60 for a normal user name. Every client finds it without reading the pointer.

On the first start with no pointer and no database in the default folder, `db.py` moves an old `<repo>/data` there, all but `umm.sock` and `umm.log`, and logs it.

`POST /api/storage/move` copies the folder to a new place, checks the copied database has every item, writes the pointer, deletes the old folder and exits with status 0. The app then restarts the backend at the new place. It first waits for writes already in flight (a screenshot being read, say). During the move other writes get 503, and MCP writes wait on the database lock. Once the copy is checked, the move sets `PRAGMA user_version = 1` in the old database. Every write in `db.py` reads it before it commits, so an MCP write that waited on the lock fails with "umm moved its data folder, try again" and does not land in the deleted database. An MCP server that is already running sees the pointer change on its next message and reopens at the new folder, so the retry lands there.

The app has no Dock icon (accessory mode) except while the main window is open. The menu bar item has "Open umm" and "Quit umm".

## Profiles

Profiles shape the whole UI. Every item belongs to one. Two always exist, even when empty, and can't be deleted or renamed:

- `user`: what the person saves. It is the active profile by default, so hotkey saves land here.
- `agent`: what AI agents save. MCP `remember` defaults to it, and MCP `search_memory` searches all profiles unless told otherwise.

People can add more (for example `work`, `side-project`), rename them (not onto a name that exists), delete them (deletes their items and files) and move items between profiles. The active profile is always visible in the hotbar and the main window.

## Backend API

All JSON. Paths are the same over the socket and in the Vite dev proxy.

```
Item = {id, profile, kind, content, file, app, meta, created_at, note}
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
      meta.path is the absolute path of the file POST /api/import read. umm keeps a copy of an image, and screenshot_days
      deletes only that copy, so the detail can still show where the original is
      meta.pinned is 1 on a pinned item, see PATCH /api/items. The key is absent otherwise
      meta.transcribing is true on a voice item while Whisper runs. Its content is empty until then
      meta.reading is the same for a screenshot while OCR runs. A backend start finishes any left over
note: string or null. What the user wrote about the item, apart from content (OCR text, transcript). Whisper only sets content, so it never touches the note.
      Indexed for search and embedded together with content. Max 100,000 characters

GET    /api/items?q=&profile=&kind=&app=&since=&until=&sort=&limit=50&offset=0&source=&agent=&project=&session=&mode=hybrid -> [Item]
         profile defaults to active, "*" = all. kind may be comma separated.
         app filters by app name (the part before ":"). since/until are YYYY-MM-DD or YYYY-MM-DD HH:MM (local time), inclusive.
         source, agent and session match those meta keys. project matches meta.cwd, that folder or any folder under it.
         sort: new | old | relevance. Default is relevance when q is set, else new. limit is capped at 200.
         Without q, new (or default) lists pinned items first, newest first inside each group. old and any q ignore pins.
         mode: hybrid | keyword. With q, hybrid fuses keyword matches with meaning matches (docs/semantic-search.md).
         Without the model it is keywords only.
GET    /api/apps?profile=                                -> [{app, count}]   app names for the filter, most used first
GET    /api/origins?profile=                             -> [{source, agent, cwd, count}]   items per meta source, agent and folder,
                                                                    most first, for the source, agent and project filters
GET    /api/icon?app=                                    -> png      the icon of the installed app with that name (the part before ":"),
                                                                    64px, cached in <data>/files/icons/app-<name>.png. 404 when no app has the name
POST   /api/items      {content, app?, profile?, meta?, note?}  -> {id}     kind auto detected, multi-line ok. Max 100,000 characters, else 422.
                                                                    Only an absolute path or one starting with ~/ is kind path.
                                                                    The same text, kind and profile saved in the last 10 seconds returns that id
                                                                    and saves nothing, so a double Enter saves once
PATCH  /api/items/{id} {content?, profile?, note?, pinned?} -> {}    edit text, note, pin and/or move to another profile. Same 100,000 limit.
                                                                    note "" clears it, a missing note leaves it
                                                                    pinned true sets meta.pinned = 1, false removes the key. Only meta changes, so the
                                                                    content and the search vector stay
                                                                    A new text on a link drops its fetched title and icon and looks it up again
DELETE /api/items/{id}                                   -> {}       also deletes the file
POST   /api/capture    {app?, meta?, note?, display?, area?, profile?} -> {id, file}  screenshot, saved at once with empty content and meta.reading.
                                                                    The thumbnail and OCR follow in a thread, GET /api/thumb/{file} makes the thumbnail on
                                                                    request meanwhile. Replies in ~0.1s. 403 when the front app is in excluded_apps
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
                                                                    that exists (~/ is expanded). meta defaults to {source: "app"}, since the main window drops files.
                                                                    meta.path is set to the file's absolute path
POST   /api/clipboard  {app?, meta?}                          -> {ids}    saves what the clipboard holds: image as a screenshot with OCR,
                                                                    copied files as one path item each, else text. 400 when empty, or when the
                                                                    clipboard is marked secret (see /api/context)
GET    /api/clipboard/history                            -> [{text, image or files, at, app}] copies, newest first, at is local ISO time, app is the front app at copy time. A copied image file also has image, a preview up to 1600 px.
                                                                    image is "clipboard/<name>.jpg" (quality 0.8), shown at /api/files/clipboard/<name>.jpg.
                                                                    Kept in clipboard.json in the data folder, so it survives a restart. Up to clipboard_history entries.
                                                                    An older copy of the same text is dropped, images are never compared. An entry that falls off
                                                                    loses its image file. Secret marked copies are never kept
DELETE /api/clipboard/history                            -> {}       clears the list and deletes the image files
POST   /api/clipboard/restore {at}                       -> {}       puts that entry back on the clipboard, text as text, image as PNG. 404 when no entry has that at
POST   /api/clipboard/save {at, note?, profile?}         -> {id}     saves that entry as a memory with meta {source: "hotbar"} and the front app.
                                                                    Text is a text item, an image is copied to a new file and saved as a screenshot with OCR. 404 when no entry has that at
GET    /api/context?url=                                 -> {app, profile, clipboard_kind, clipboard, recording, url, history}
                                                                    clipboard_kind: text | image | files | null. clipboard is the text, or the
                                                                    copied paths one per line, empty for an image. Max 2000 chars. Clipboard content marked
                                                                    org.nspasteboard.ConcealedType or TransientType (password managers) is treated as empty.
                                                                    url is the query parameter echoed back, else null. Swift sends it, see "Page URL"
                                                                    history is the number of entries in GET /api/clipboard/history
GET    /api/profiles                                     -> {active, all: [{name, count}]}   always includes user and agent
POST   /api/profiles   {name}                            -> {}       sets active, creates if new. Names are 1 to 60 characters, no `*`, `/` or newline
POST   /api/profiles/rename {from, to}                   -> {}       not for user or agent. 409 when `to` exists
DELETE /api/profiles/{name}                              -> {}       deletes its items and files, not for user or agent
GET    /api/settings                                     -> Settings
PATCH  /api/settings   {any Settings keys}               -> Settings  422 on a bad value, unknown keys are ignored
GET    /api/storage                                      -> {path, bytes, kinds}   the data folder, its size and item count per kind
POST   /api/storage/move {path}                          -> {path}   moves the data folder, then the backend exits and the app restarts it.
                                                                    path must be absolute, writable, not inside the current folder,
                                                                    and empty (a .DS_Store is fine) or missing. 400 {detail} otherwise, 409 while recording or moving.
                                                                    Every other write gets 503 during the move
GET    /api/record                                       -> {on, seconds, transcribing}
POST   /api/record/start {app?, meta?, note?}                   -> same as GET /api/record. The voice item's app is empty when umm itself is in front.
                                                                    meta and note are saved on the voice item, meta next to meta.transcribing
POST   /api/record/stop                                  -> same. The voice item exists when this returns, with its m4a, empty content and
                                                                    meta.transcribing. Whisper fills content in the background and clears the flag.
                                                                    The main window polls GET /api/record and reloads its list when transcribing changes.
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
Settings = {languages, model, enrich_links, excluded_apps, clipboard_history, screenshot_days}
languages:      language codes Whisper may detect, default ["en", "hi"]. [] allows any language
model:          "small" | "medium", default "medium"
enrich_links:   default true, fetch title and description of saved links (not links with a secret looking query parameter)
excluded_apps:  default [], app names (the part of Item.app before ":", case insensitive)
                that POST /api/capture refuses
clipboard_history: default 50, 0 to 500. How many copies, text, image or files, the backend keeps for GET /api/clipboard/history. 0 turns it off
                and clears the list and the image files. A thread checks the pasteboard four times a second. Saved to clipboard.json after each change, written through a .tmp file
screenshot_days: default 0 (keep forever). A background thread runs at backend start and every 24 hours. It deletes the image
                and thumbnail of every screenshot older than this many days and sets its file to null. The item, OCR text and meta stay.
                It removes umm's copy only. An imported image's original file is left alone, and meta.path still names it
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
{type: "hide"}                     fade the hotbar out (140ms), focus returns to the previous app. Actions hide it at once instead
{type: "paste", detail?}           close the hotbar, "saved" sound, card "Pasted" and, with Accessibility, press Cmd+V in the app that
                                   gets focus back (CGEvent). Without it the card says "Copied to clipboard" (the entry is on the clipboard already)
{type: "saved", label?, detail?, kind?}  close the hotbar, play the "saved" sound, show the card: label (default "Saved"), detail
                                   (default "in <profile>") and an icon for kind note | clip | image | files (UI already did the fetch)
{type: "error", label?}            play the error sound, show label (default "That did not work") on a red card
{type: "capture", note?, record?} close the hotbar, wait 120ms, POST /api/capture with the app from context, the
                                   display under the mouse and note when not empty. Plays the shutter sound as the request
                                   is sent, then shows the card "Screenshot saved" with the thumbnail from GET /api/thumb/{file}.
                                   fallback: fetch POST /api/capture. On 403 or 412 it plays the error sound and the card
                                   says "Excluded app" or "Allow Screen Recording"
                                   With record: true, after the save it POSTs /api/record/start (app, meta {source, shot, url?}) and calls recording(true) without its own card, the screenshot card says "Screenshot saved, recording". A failed start plays the error sound and shows "Could not start recording".
{type: "area", note?}              same, with area: true. No sound at the start, the shutter plays when it saved.
                                   Nothing happens when the selection is cancelled
{type: "openMain", query?}         close the hotbar, show the main window, then call window.ummOpen?.({query})
                                   fallback: location.hash = ""
{type: "recording", on}            on: "rec-start" sound, a red ring along the screen edge, the card "Recording", red status item
                                   with the elapsed time (m:ss) and a "Stop recording" menu item (POST /api/record/stop).
                                   off: both go away, "rec-stop" sound, card "Recording saved". A repeat of the current state is ignored
{type: "resize", height}           hotbar panel height in CSS px, width is fixed at 680. The panel animates to it (220ms). The page
                                   itself is a fixed 760 px tall and pinned to the top, so WebKit never relays out while the panel moves
{type: "appearance", mode}         system | light | dark, sets NSApp.appearance. The hotbar page sends the saved setting on load
{type: "openExternal", url}        open in the default browser
{type: "settings"}                 ask for the login item state, Swift replies with window.ummSettings
{type: "loginItem", on}            register or unregister umm as a login item (SMAppService.mainApp), then replies like "settings"
{type: "accessibility"}            ask macOS for Accessibility (AXIsProcessTrustedWithOptions with the prompt), open its pane in
                                   System Settings, then reply like "settings". The grant happens later, so ask "settings" again on focus
{type: "chooseFolder"}             folder picker (can create folders). Swift replies with window.ummFolder, nothing on cancel
{type: "quit"}                     kill switch, quits the app and the backend
```

The card is a 360 by 64 point panel near the top of the screen under the mouse, on the same glass as the hotbar, with the UI's colours (`ui/src/index.css`, light or dark): a tile on the left with the screenshot thumbnail or an SF Symbol on the accent blue (red for errors), a title and a detail line. It never takes focus, slides down as it appears and fades after 2.2 seconds. The hotbar fades in and slides up 4 points while the page scales from 98.5%. All native motion uses the UI's ease out curve. Reduce Motion turns the motion off.

Glass: `glass()` puts an `NSVisualEffectView` behind a clear page or view. The hotbar and card use the popover material with a 16 point rounded clip and a hairline edge, the main window the sidebar material. The page marks itself `html.glass` and leaves the sidebar and the hotbar tinted but not solid. The `appearance` setting (System, Light, Dark) picks the windows' appearance and the page follows it.

Sounds are `app/sounds/*.wav` (shutter, saved, rec-start, rec-stop, error). `scripts/make-sounds.py` generates them and `build.sh` copies them into the app. `play(name)` falls back to the system sound of that name when a file is missing. Recording start also draws a red ring along the screen edge that fades over a second, unless Reduce Motion is on.

Swift to UI:

```
window.ummShow?.(context, mode)  called every time the hotbar opens. mode is "clip" when Ctrl+Shift+V opened it, so the page goes straight to the clipboard history. context is GET /api/context?url=, fetched by Swift
                            BEFORE umm takes focus so `app` is the user's app. If the request fails, Swift tries once more before it passes `{}`. UI resets, focuses the input.
                            In browser dev the UI calls this itself on load with a fetched context.
window.ummOpen?.({query})   main window shown, optional search query
window.ummDrop?.({paths})   files dropped on the main window, absolute paths. Swift takes the drop so WebKit does not open the file.
                            The UI posts each path to /api/import. Dropped text is not intercepted and reaches the page as a normal drop
window.ummSettings?.({loginItem, version, accessibility})
                            reply to "settings" and "loginItem". loginItem is on | approval | off | missing.
                            approval means macOS wants the person to allow it in System Settings, Login Items.
                            version is CFBundleShortVersionString. accessibility is AXIsProcessTrusted().
                            Browser dev never calls it and the UI hides the startup row. The UI asks again when the window regains focus.
window.ummFolder?.(path)    reply to "chooseFolder", the absolute path of the picked folder
```

## Page URL

When umm has the Accessibility permission, Swift reads the front app over the generic AX API as the hotbar opens, before it fetches the context. It takes the focused window's `AXDocument` (a file URL in editors, the page URL in Chrome). If that is empty, it walks up from the focused element to an `AXWebArea` and takes its `AXURL`. No per-app code. It sends the result as `GET /api/context?url=`, so `context.url` holds it. Swift adds it to the hotbar screenshot as `meta = {source: "hotbar", url}`, and the UI adds `meta.url` to notes and clipboard saves from the hotbar. Each AX call waits at most 0.5 seconds. A URL of 4000 characters or more, such as a `data:` URL, is left out, since the backend refuses a request line over 64 KB. When nothing is found, Swift sets `AXManualAccessibility` on the app once per process (Electron builds its tree then) and reads twice more, 50 ms apart. Firefox builds its web tree after the first query, so that retry or the next open finds the URL. `AXEnhancedUserInterface` is not set: it can turn off window animations in some apps, and Firefox did not need it. Without the permission, `url` is null and nothing else changes.

## OCR languages

Apple Vision (VNRecognizeTextRequest, revision 3) on macOS 26 lists 30 OCR languages and no Indic one, so Devanagari in a screenshot is not read and `languages` stays a Whisper setting.

## Hotbar

Opens on `Ctrl+Shift+Space`. Keyboard first. `Enter` on open takes a screenshot (top row), so `Ctrl+Shift+Space` then `Enter` is the fast path, also with Ctrl and Shift still held. Rows:

1. Screenshot
2. Screenshot an area
3. Screenshot with a note: opens the note editor, then `Cmd+Enter` takes the screenshot with the note
   Screenshot and record (hidden while recording): takes a screenshot and starts a recording tied to it (`{type:'capture', record:true}`, Swift does both). The recording item gets `meta.shot`, the screenshot's id
4. Save clipboard (text preview, "Save clipboard image", or "Save copied file" with the file names, hidden when the clipboard is empty). Copied files save like a drop on the main window: an image file becomes a screenshot item with OCR, anything else a path. The text preview is blurred until the row is selected. `Tab` on a text clipboard opens it in the editor, `Cmd+Enter` saves the edited text
5. Pick from clipboard history (only when the clipboard history setting has more than one entry): lists recent copies (text, or a 28 px thumbnail for images) with the app each came from, typing filters them. `Enter` puts one back on the clipboard (`POST /api/clipboard/restore`), `Cmd+Enter` saves it as a memory (`/api/clipboard/save`), `Tab` edits a text entry first, `Esc` goes back. The text is blurred until the row is selected
6. Note: opens a multi-line editor in the hotbar. `Enter` is a new line, `Cmd+Enter` saves, `Esc` goes back
7. Start recording / Stop recording (shows elapsed time while on)
8. Record with a note: opens the note editor, then `Cmd+Enter` starts the recording with the note. Hidden while recording
9. Search memories: opens a search mode. Typing in the menu only filters these rows, so the last row becomes `Search memories for "..."` and `Enter` carries the text over. The search mode lists recent memories while the box is empty. Links show their title and site icon. `Cmd+Enter` opens the search in the main window, `Esc` goes back. `Enter` on a memory copies it (path, link or text) and closes. Pinned memories show a small pin

In clipboard history and memory search, a type picker sits right of the search box (All, then Text, Images, Links, Files for copies, or the memory kinds). `Cmd+P` steps through it. A copied image file counts as an image. `Enter` on a copied file puts the file back, as if copied in Finder. `Space` toggles a preview pane on the right, the same view the main window shows (note, image, text in image, audio player, link card, path). It stays open while the highlight moves and across opens, and works before any arrow key when the search box is empty. A move event with the pointer still in place, such as after a scroll, does not move the highlight
10. Switch profile
11. Open umm (main window)
12. Quit umm. While recording, the first `Enter` asks again

While typing, `Enter` runs a row only when the query starts its label ("rec" starts a recording). Otherwise it copies the first matching memory, or searches. `Enter` while an input method is composing does nothing, and the arrow keys stop at the ends. A half-written note stays when the hotbar closes. Notes opened from a combo row or for clipboard editing start empty and do not replace that draft. Saves show a short HUD ("Note saved", "Clipboard saved", "Image saved").

## Main window

The sidebar lists profiles, then All profiles, Connections and Settings. A long profile list scrolls on its own and the last three stay in view. Clicking a profile only browses it. The active profile, where hotkey saves go, changes in Settings, the hotbar "Switch profile" row, or by creating a profile. A note written in the main window goes to the profile on screen.

The rest of the window is a toolbar (profile name, search, record, a New note icon), a list and a preview pane. Each row is two lines: an icon, a title and the time, then one quiet line (text snippet, site, folder, or agent and project). The icon is the app's icon (`/api/icon`), a link's site icon, or a monogram for agents and apps that are not installed, with a small badge for the kind. Rows with no source show the kind alone. Screenshot thumbnails only appear in the pane. `meta.url` shows as a link on the row and in the pane, and opens with `openExternal`. Above the list are kind filters and a Sort and filter menu (app, source, agent, project, dates). The agent profile adds chips to narrow by agent and project. Selected rows use `--sel` while the list has focus and `--sel-dim` when it does not.

The pane shows the selected item in full, laid out by kind. A screenshot shows its note (if any), the image, its window title and a "Text in image" section that is closed unless there is a search. A link shows a card with its site icon, a voice note its note (if any), the player, its text and the English translation ("Transcribing..." with a slow teal dot until Whisper is done, in the row, the pane and hotbar search), a path the file, and notes and agent memories their text. Below that is a list of facts: app or agent, page, project or folder, how it was saved, profile and date. The toolbar above the pane has icon buttons that depend on the kind. A screenshot gets Copy image, Copy text, Open in Preview and Show in Finder. A link gets Copy link and Open link, a path gets Copy path and Show in Finder, and the rest get Copy text. Text, link and path items get Edit, which changes the content. A screenshot or voice note gets Add note or Edit note, which saves `note` through `PATCH /api/items/{id}` (empty clears it) and never touches the OCR text or transcript. A note shows above the image or player, and as the row title with the old title moved to the second line. Pin to top (`Cmd+D`) sets `meta.pinned` through `PATCH /api/items/{id}`. A pinned item comes first in the default list and its row shows a small pin before the time. A recording made right after a screenshot shows a Screenshot fact ("Taken with screenshot N", from `meta.shot`). Move to profile and Delete are on the right. Keys: `Cmd+C` copies (the image for a screenshot), `Cmd+Shift+C` copies the text, `Cmd+O` opens, `Cmd+Shift+R` shows in Finder, `Cmd+E` edits, `Cmd+D` pins. Clicking the image opens a full window view: click switches between fit and 100%, scrolling pans, the arrow keys step through screenshots, Esc closes. New note (`Cmd+N`) opens an editor in the pane. `Cmd+Enter` saves to the profile on screen.

Keys in the list: Up and Down (or `j` and `k`) move, Shift extends the selection, `Cmd+A` selects all. Esc closes the open menu or popover first, then clears a multiple selection, then the selected row, then the search. Cmd-click adds or removes a row, Shift-click selects a range. Enter opens a link, zooms a screenshot, or copies anything else. Space zooms a screenshot. Delete asks first with `confirm()` (a native alert in the app), naming the kind or the count and saying the file goes too. It then removes the selection, and one Undo in the toast (or `Cmd+Z`) brings the whole batch back, selected. Keys pressed while an input method is composing (`isComposing`, or keyCode 229 for the Enter that confirms it in WebKit) reach no shortcut, in both windows. When the window regains focus the list reloads every row already loaded and keeps the selected item selected, even when new saves pushed it down. Rows highlight the query their results were found with, so typing does not re-render a long list. With several rows selected, the pane counts them by kind and offers Move to and Delete for all of them. `Cmd+K` or `/` searches, `Cmd+1` to `Cmd+9` switch profiles, `Cmd+,` opens Settings. `Cmd+K` and `Cmd+N` also work from Settings and Connections and go back to the list.

Every icon button has a tooltip. A control sets `data-tip`, and `data-keys` for its shortcut, and one shared `Tips` element in `ui.tsx` shows it at once on hover. No element uses `title`. Every dropdown (sort and filters, profile options, Move to, the Settings pickers) is the shared `Menu` from `ui.tsx`, not a native select. It marks the current item with a check, and takes the arrow keys, Enter, Esc and typing to jump. It opens above the button, or further left, when there is no room below.

When every profile is empty, the window shows a welcome page in place of the list: how to save a first memory, the Screen Recording, Microphone and Accessibility permissions, and the MCP command to connect an agent. "Skip the setup" hides it for good by setting `umm.welcome` in `localStorage`.

The window has a transparent title bar with the content under it. WebKit has no drag region for the page, so `DropView` in `main.swift` moves the window when you drag the empty top of the sidebar (200 by 52 points).

Dropping text or a link on the window saves it as a note. Swift handles dropped files. It calls `window.ummDrop({paths})`, and the UI posts each path to `/api/import`. Pasting with `Cmd+V` outside a text field saves text as a note, and an image or copied files through `/api/clipboard`. A drop overlay shows while something is dragged over the window.

Connections lists `GET /api/agents`: connected agents with a live dot, then recent sessions, each with its project folder, last seen and memory count. Clicking one shows that session's memories across all profiles. It refreshes every 5 seconds and shows the MCP setup command.

## Settings view

The gear at the bottom of the sidebar, or `Cmd+,`, swaps the main window's list for the settings. Clicking a profile goes back. Groups: General (where hotkey saves go, clipboard history of Off, 50, 200 or 500 entries, a Clear button that empties the history, the login item, the hotbar key), Screenshots (how long images are kept, the Accessibility permission for page URLs, excluded apps), Voice, Links, Storage (size, location), Agents (the MCP command with this install's path, the CLI install command). Every change saves at once. Pickers use the shared `Menu`.

To move the data, Change... takes a folder, typed or picked with `chooseFolder`. The data goes to `<folder>/umm`, and the UI shows that path before it posts `/api/storage/move`. The backend then restarts in the new place, so the UI polls `GET /api/storage` every second until the path changes, and gives up after 60 seconds. A 400 or 409 shows its `detail` under the field. On an older backend the UI hides the image retention row, and the move says this version cannot do it.

The login item uses `SMAppService.mainApp`, which accepts the ad hoc signed bundle.
When an excluded app is in front, the hotbar screenshot plays the error sound and the menu bar item shows "Excluded app" for 3 seconds.

The hotbar panel is nonactivating. Swift activates umm for it only when the main window is closed. With the main window open, activating would raise that window over the user's app, and the screenshot would capture umm. The panel takes keys without activation.

At launch Swift calls `CGPreflightScreenCaptureAccess` and, if Screen Recording is missing, `CGRequestScreenCaptureAccess`.

## Recordings and crashes

A recording is a `.flac` in `files/` in the data folder while the mic is on. On stop, `record.save` converts it to `.m4a`, adds the voice item with empty content and `meta.transcribing`, and deletes the `.flac`, so the file name never changes after the item exists. Whisper then reads the `.m4a` and `db.update` sets the content, clears the flag and drops the vector so the item is embedded again. Empty content is never embedded. A failed run sets the content to "(transcription failed)" and keeps the audio. On backend start, `record.recover` adds an item for every `.flac` that has none, into the active profile with an empty app, and transcribes those and every item still marked `transcribing`, one at a time. The Whisper child process exits when the backend dies, so a killed backend does not leave it running.

## Rules for every agent

- Write as little code as possible. Match the surrounding style.
- Only edit your own folder unless told otherwise. Don't commit; the lead commits.
- Nothing app specific. It must work the same for anyone, in any app.
- Watch memory and disk.
- Run any prose you write (docs, comments, commit text) through the `unslop` skill. No emojis.
