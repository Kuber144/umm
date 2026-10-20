<p align="center"><img src="assets/icon.svg" width="128" alt="umm icon"></p>

# umm

Press a hotkey in any Mac app to save what you might need later, then search it yourself or let your AI agents search it.

- Saves screenshots (with OCR text), the clipboard, typed notes, file paths, links and voice recordings. Each item records the app and window title you were in.
- `Ctrl+Shift+Space` opens a small hotbar over any app. The fast path is the hotkey, then `Enter` for a screenshot.
- A main window to search, filter, edit and organize everything into profiles.
- Voice recordings are transcribed on your Mac with Whisper, in English, Hindi or the languages you pick.
- An MCP server lets Claude Code, Codex, Cursor and other agents search and add memories. A CLI does the same from the terminal.
- Everything lives in one SQLite file in `data/`. Nothing is uploaded.

## Requirements

- macOS 13 or newer, Apple Silicon or Intel.
- Xcode Command Line Tools: `xcode-select --install`.
- [uv](https://docs.astral.sh/uv/) for the Python backend.
- Node.js with npm, to build the UI once.

umm builds from source, so there is no installer. The first voice transcription downloads the Whisper model, about 1.5 GB for `medium` (the default) and less for `small`.

## Quick start

```
git clone https://github.com/Kuber144/umm.git
cd umm
./start.sh
```

The first run installs the dependencies and builds `build/umm.app`, which takes a few minutes. umm lives in the menu bar and has no Dock icon until the main window opens. When macOS asks, allow Screen Recording and Microphone for umm. Then press `Ctrl+Shift+Space`.

`./stop.sh` quits umm and its backend. `./start.sh` also prints the commands to connect agents and install the CLI, with the right paths for your checkout.

## Permissions

- Screen Recording lets umm take screenshots and read the front window's title. Without it a screenshot fails, and the menu bar shows "Allow Screen Recording" for a moment.
- Microphone lets umm record your voice when you start a recording.

umm never uses either one on its own. A screenshot happens when you ask for it, and the mic is on only during a recording.

macOS ties a permission to the app's code signature. By default `build.sh` signs ad hoc, so every rebuild looks like a new app and macOS asks again. To avoid that, create a local signing certificate once:

```
scripts/setup-signing.sh
```

It makes a self-signed certificate named "umm local signing" in your login keychain. The next build uses it and the permissions stick. Grant them once more after that first signed build. To undo it, run `scripts/remove-signing.sh`.

## Using it

The hotbar opens with `Ctrl+Shift+Space`.

- Type to filter the rows and to see matching memories below them. `Enter` on a memory copies it.
- Up and Down pick a row, `Enter` runs it.
- Rows: screenshot, screenshot an area, save clipboard (text, an image or copied files), write a note, start or stop recording, search, switch profile, open umm, quit.
- In the note editor `Enter` is a new line, `Cmd+Enter` saves, `Esc` goes back.
- `Esc` closes the hotbar. A pop sound means it saved, a low thud means it failed.

The main window opens from the hotbar or the menu bar icon, which turns red while recording.

- Profiles are on the left, plus "All". `Cmd+1` to `Cmd+9` switch.
- `Cmd+K` searches. Filter by kind, app and date range, and sort by relevance, new or old.
- Write a note or record your voice at the top. `Cmd+Enter` saves.
- Move with Up, Down, `j` and `k`. `Enter` copies or opens, `Delete` removes.
- Each item can be copied, edited, moved to another profile, deleted, or revealed in Finder when it is a path.
- `Cmd+,` opens Settings: the profile for hotkey saves, voice languages and model, apps the hotbar screenshot refuses to capture, link lookup, storage, and open at login.

Every item belongs to one profile, and new saves go to the active one.

- `user` is yours and is active by default.
- `agent` is where agents save over MCP.
- Custom profiles are ones you create. You can rename them, delete them with their items, and move items between them. `user` and `agent` can't be renamed or deleted.

## Agents

Agents reach umm over MCP. Run the command `./start.sh` prints, or from the repo root:

```
claude mcp add umm -s user -- uv run --project "$(pwd)/backend" "$(pwd)/backend/mcp_server.py"
```

Other MCP clients take the same command in their config. Use absolute paths:

```json
{
  "mcpServers": {
    "umm": {
      "command": "uv",
      "args": ["run", "--project", "<path-to-umm>/backend", "<path-to-umm>/backend/mcp_server.py"]
    }
  }
}
```

The Agents section in Settings shows these commands with your real paths and copy buttons.

Agents can search, read, add, and take a screenshot, which needs the app running. They can edit and delete only items in the `agent` profile. They can't record audio, change the active profile, or touch your items unless you tell them to. All agents share one memory, and each memory records which agent, project folder and session saved it. The tools are in [docs/mcp.md](docs/mcp.md).

## CLI

```
uv tool install --editable "$(pwd)/cli"     # run from the repo root, puts umm in ~/.local/bin
```

The CLI talks to the running app.

```
umm add "text"            # save text, paths and links are detected
pbpaste | umm add         # save stdin
umm shot                  # screenshot with OCR
umm find invoice          # search, also: umm s invoice
umm ls -k link -n 5       # recent items
umm show 42               # print one item
umm profile use work      # switch profile
umm start / stop / status # control the app
```

See [docs/cli.md](docs/cli.md) for every command, zsh completion and flags.

## Privacy

- Everything is local. Items, screenshots and recordings stay in `data/` on your Mac. OCR uses Apple Vision and transcription runs locally.
- umm has no account, no telemetry and no TCP port. The backend listens on a Unix socket.
- Two things use the network. When you save a link, umm fetches that page's title, description and icon, and for tweets and YouTube links it asks their public oEmbed endpoints. Links with a token, key, signature or similar parameter in the query are never fetched. Turn it off with "Look up links" in Settings. The first transcription downloads the Whisper model from Hugging Face.
- Agents you connect can read your memories. That is their job, so connect only agents you trust.

## Data and uninstall

All data is in `data/` inside the repo: `umm.db`, `files/` for screenshots and recordings, `settings.json` and `umm.log`. Copy that folder to back it up.

To remove umm:

1. Turn off "Open at login" in Settings, or remove umm in System Settings, General, Login Items.
2. Run `./stop.sh`.
3. Delete the repo folder. That removes the app, the backend and your data. Keep `data/` first if you want it.
4. Remove the CLI with `uv tool uninstall umm-cli`.
5. Remove the MCP entry with `claude mcp remove umm -s user`, or delete it from your other client's config.
6. Remove the signing certificate with `scripts/remove-signing.sh`, if you created one.
7. Optionally remove umm under Screen Recording and Microphone in System Settings, Privacy and Security, and delete the Whisper model from `~/.cache/huggingface/hub`.

## Troubleshooting

- Screenshots fail. Screen Recording is not granted to umm. Enable it in System Settings, Privacy and Security, Screen Recording, then run `./stop.sh` and `./start.sh`. After a rebuild you may need to toggle it off and on.
- Anything else broken. Read `data/umm.log`.
- A keychain prompt appears during the build. That is `codesign` using the signing certificate. Click Always Allow.
- Permissions keep resetting after rebuilds. Run `scripts/setup-signing.sh`.
- umm seems to run twice, or permissions apply to the wrong app. Two copies of umm.app exist, for example from two checkouts. Quit both, keep one folder, and start that one.
- The first transcription is slow. It is downloading the Whisper model.

## Development

```
app/       Swift app, build.sh, Info.plist, icons
backend/   FastAPI on a Unix socket, MCP server, db.py (all SQL), record.py
cli/       the umm command, standard library only
ui/        React + Vite, the hotbar and the main window
assets/    icon sources
docs/      architecture, CLI, MCP, plan
scripts/   signing certificate setup and removal
data/      runtime files, not source
build/     umm.app
```

- UI changes need `cd ui && npm run build`. The backend serves `ui/dist` from disk, so the app needs no rebuild.
- `cd ui && npm run dev` starts Vite on 5173 and proxies `/api` to the socket. Open `http://localhost:5173/#hotbar` for the hotbar view.
- Swift changes rebuild on the next `./start.sh`.
- `UMM_SHOW=main build/umm.app/Contents/MacOS/umm` opens the main window at launch. `UMM_SHOW=hotbar` opens the hotbar.
- `UMM_SWIFT_FLAGS="-D TEST" app/build.sh` adds test hooks. `SIGUSR1` toggles the hotbar and `UMM_JS` runs JavaScript in the hotbar page.

More in [docs/architecture.md](docs/architecture.md), [docs/plan.md](docs/plan.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
