# Contributing

Issues and pull requests are welcome. For anything big, open an issue first so we can agree on the approach.

## Run it

```
git clone https://github.com/Kuber144/umm.git
cd umm
./start.sh   # builds build/umm.app and opens it
./stop.sh    # quits it
```

You need macOS 13+, Xcode Command Line Tools, uv and Node. The README has the details. `scripts/setup-signing.sh` keeps macOS permissions across rebuilds, which saves a lot of clicking while you develop.

- UI changes: `cd ui && npm run build`. The app picks them up without a rebuild. `npm run dev` runs Vite on 5173 and proxies `/api` to the socket.
- Swift changes: `./start.sh` rebuilds when anything in `app/` changed.
- Backend and CLI changes: `./stop.sh`, then `./start.sh`.
- Logs are in `~/Library/Application Support/umm/umm.log`.

## Rules

- Write as little code as possible. Less code means fewer bugs. A new dependency or a new file needs a reason in the PR.
- All SQL lives in `backend/db.py`. The API and MCP server call it and never touch SQLite directly.
- Add a column before adding a table.
- Nothing app specific. No per-app scripts or lists of app names. umm has to work the same in any app.
- Keep memory and disk low. Screenshots are JPG, recordings are 16 kHz mono AAC, Whisper runs in a child process that exits when done, and deleting an item deletes its file.
- No emojis in code, docs or commits.
- Keep docs short and plain. Update them when behavior changes.

## Test

There is no test suite yet. Before you open a PR:

- `cd ui && npm run lint && npm run build`
- `swiftc -typecheck app/*.swift`
- `cd backend && uv sync && uv run python -c "import api, mcp_server, record, db"`
- Try your change in the real app. For the backend, `curl --unix-socket ~/Library/Application\ Support/umm/umm.sock http://umm/api/profiles`.

CI runs the same build checks on every push.

## Commits and PRs

- One change per commit. A short imperative subject, for example `Fix blank screenshot after wake`. Add a line or two on why when it is not obvious.
- Keep PRs small and say how you tested them.
