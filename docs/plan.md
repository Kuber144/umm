# Plan

## Entry points

1. Hotbar. `Ctrl+Shift+Space` from any app saves a screenshot, the clipboard, a note or a voice recording. Done.
2. Main window. Browse, search, filter, edit and manage profiles. Done.
3. MCP. Agents search and save, and each agent can use its own profile. Done.
4. CLI. An `umm` command, for example `umm add "..."`, `umm search tax`, `umm start`, `umm stop`. Next.

## Done

- `umm.app` in Swift. Hotkey, hotbar panel, main window, menu bar item, both windows in WKWebViews.
- Python backend on a Unix socket, restarted with backoff if it dies. Quitting the app stops it.
- SQLite FTS5 search, Apple Vision OCR, app and window title for every item.
- Profiles. Built-in `user` and `agent`, custom ones with rename, delete and move.
- Voice. Recording and local Whisper (`faster-whisper`, model `small`), transcript saved as a voice item.
- Main window filters for kind, app and date, sort, screenshot grid, undo on delete.
- MCP server with `search_memory`, `remember`, `list_profiles`.
- Start and stop scripts, app icon, menu bar icon.

## Next

1. CLI.
2. Links. Pull tweet text (X oEmbed) and YouTube titles so they show up in search.
3. Ask box in the main window that calls Claude with your API key.
4. Embeddings for fuzzy search.
5. Start at login.
6. Stable code signing, so Screen Recording and Microphone permissions survive rebuilds.

## Decisions

- No Raycast or other launcher. umm runs on its own.
- The hotbar and main window are one React app in WKWebViews. The app is native Swift only for the hotkey, windows and backend process.
- No TCP ports. The UI reaches the backend through the `umm://` scheme and a Unix socket.
- Context is generic. Every item stores the front app and window title, read the same way for every app.
- Screenshots are JPG. They are about 9x smaller than PNG and OCR reads the same text.
- Whisper runs in a child process so its memory goes back to the OS when it finishes.
