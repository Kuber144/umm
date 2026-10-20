<p align="center"><img src="assets/icon.svg" width="128" alt="umm icon"></p>

# umm

umm is a Mac app that keeps what you might miss later. Press `Ctrl+Shift+Space` from any app to save a screenshot with its OCR text, the clipboard, a typed note or a voice recording. Search it in the main window, or let Claude Code search it over MCP. Everything stays on your Mac in one SQLite file in `data/`. Each item records the app and window title you were in.

## Install and run

```
./start.sh   # builds build/umm.app if needed and opens it
./stop.sh    # quits umm and its backend
```

`start.sh` needs `uv`, `npm` and the Xcode command line tools. umm lives in the menu bar and has no Dock icon until the main window opens.

On first use macOS asks for two permissions for umm.app:

- Screen Recording, for screenshots.
- Microphone, for recordings.

The app is signed ad hoc, so macOS treats every rebuild as a new app and may ask again. Allow it again if so. If a screenshot comes out blank, quit with `./stop.sh` and start again.

## Hotbar

`Ctrl+Shift+Space` opens it over any app. `Enter` right away takes a screenshot, so the fast path is the hotkey, then `Enter`.

- Type to filter the rows and see matching memories below them. `Enter` on a memory copies it.
- Up and Down pick a row. `Enter` runs it.
- Rows: screenshot, save clipboard, write a note, start or stop recording, search, switch profile, open umm, quit.
- In the note editor `Enter` is a new line, `Cmd+Enter` saves, `Esc` goes back.
- `Esc` closes the hotbar. A pop sound means it saved, a low thud means it failed.

## Main window

Open it from the hotbar or the menu bar icon. The icon turns red while recording.

- Profiles on the left, plus "All". `Cmd+1` to `Cmd+9` switch.
- Search with `Cmd+K`. Filter by kind, app and date range. Sort by relevance, new or old.
- Write a note or record your voice at the top. `Cmd+Enter` saves.
- Move with Up, Down, `j` and `k`. `Enter` copies or opens, `Delete` removes.
- Each item can be copied, edited, moved to another profile, deleted, or revealed in Finder when it is a path.

## Profiles

Every item belongs to one profile, and new saves go to the active one.

- `user` is yours and is active by default.
- `agent` is what Claude and other agents save over MCP.
- Custom profiles are ones you create. You can rename them, delete them with their items, and move items between them. `user` and `agent` can't be renamed or deleted.

## Claude Code

```
claude mcp add umm -s user -- uv run --project /Users/kuberjain/Developer/personal/umm/backend /Users/kuberjain/Developer/personal/umm/backend/mcp_server.py
```

Any MCP client (Claude Code, Codex, Cursor) can use it, and they all share one memory. `remember` saves to the `agent` profile and records which agent saved it, the project folder it ran in and the session. Agents can search by agent and project, update a memory instead of saving a copy, and only delete from `agent`. See `docs/mcp.md` for the tools.

## Voice

Recording is 16 kHz mono and kept as 32 kbps AAC `.m4a`, which the app can play. Stopping starts transcription with local faster-whisper in a child process that exits afterwards, so its memory (about 2 GB at peak for `medium`) goes back to the OS. The model (`small` or `medium`, default `medium`) and the languages (default English and Hindi) are in Settings. Detection only picks from your languages, because free detection misreads short clips. Non-English speech is saved as the original transcript plus an English translation, so English searches find it. The model loads from the HuggingFace cache and downloads once if missing.

## Settings

Open them with the gear at the bottom of the sidebar or `Cmd+,`. Changes save at once and need no restart.

- Which profile hotkey saves go to.
- Voice: languages and the Whisper model.
- Privacy: apps where the hotbar screenshot refuses to capture, such as a password manager, and whether links are looked up.
- Storage: size of `data/`, how many items of each kind, and a button that opens the folder.
- Agents: the MCP command and the command line install, with copy buttons.
- Startup: open umm at login.

They are stored in `data/settings.json`. The defaults are in `backend/settings.py`.

## Layout

```
app/       Swift app, build.sh, Info.plist, icons
backend/   FastAPI on a Unix socket, MCP server, db.py (all SQL), record.py
ui/        React + Vite, the hotbar and the main window
assets/    icon.svg and the menu bar icon source
docs/      architecture.md, plan.md
data/      umm.db, files/, profile.txt, profiles.txt, settings.json, umm.log, umm.sock
build/     umm.app
```

## Dev notes

- The app has no TCP port. The backend listens on `data/umm.sock`, and the app serves the UI through the `umm://` scheme.
- UI changes need `cd ui && npm run build`. The backend serves `ui/dist` straight from disk, so no app rebuild is needed.
- `cd ui && npm run dev` starts Vite on 5173 and proxies `/api` to the socket. Set `UMM_SOCK` to use another socket. Open `http://localhost:5173/#hotbar` for the hotbar view.
- Swift changes rebuild on the next `./start.sh`. It skips the build when nothing in `app/` changed.
- Run the binary to set env vars. `UMM_SHOW=main build/umm.app/Contents/MacOS/umm` opens the main window at launch, and `UMM_SHOW=hotbar` opens the hotbar after 2 seconds.
- Build with `UMM_SWIFT_FLAGS="-D TEST" app/build.sh` to add test hooks. `SIGUSR1` toggles the hotbar and `UMM_JS` runs JavaScript in the hotbar page.
- Logs are in `data/umm.log`.
