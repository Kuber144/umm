# Command line

`umm` is a small CLI for the running app. It talks to the backend over `data/umm.sock`, so the app has to be up. It uses only the Python standard library and starts in about 25 ms.

## Install

```
uv tool install --editable "$(pwd)/cli"      # from the repo root, `./start.sh` prints it too
```

This puts `umm` in `~/.local/bin`. The install is editable, so changes to `cli/umm.py` apply at once. To try it without installing, run `uv run --project cli umm ...` from the repo.

The CLI finds the repo from its own file location. Set `UMM_ROOT` to override that.

## Completions

zsh completion is generated from the argument parser, so it always matches the commands. Profile names are completed live. Pick one setup.

```
# in ~/.zshrc, after compinit
eval "$(umm completion zsh)"

# or write it once into a folder on your fpath
mkdir -p ~/.zfunc && umm completion zsh > ~/.zfunc/_umm
# and in ~/.zshrc, before compinit
fpath=(~/.zfunc $fpath)
```

## Basics

Ids are the numbers shown in the first column. `#42` works wherever `42` does. Commands that read items use the active profile unless you pass `-p NAME` or `-A` for every profile. Colors only show in a terminal and turn off when `NO_COLOR` is set. Errors are one line on stderr. Exit codes are 0 for success, 1 for a failure or a search with no hits, 2 for bad arguments.

Everything the CLI saves carries `meta = {source: "cli", cwd}`, so you can tell later where it came from. The same text saved twice within 10 seconds, or the same image within 10 minutes, returns the first id.

## Saving

| Command | What it does |
| --- | --- |
| `umm add "text"` | Save text. Paths and links are detected. `./file` becomes an absolute path. |
| `pbpaste \| umm add` | Save stdin. |
| `umm add` | In a terminal, opens `$VISUAL` or `$EDITOR` for a multi-line note. |
| `umm add -c`, `umm clip` | Save the clipboard. |
| `umm shot` | Screenshot with OCR. `-d 3` waits 3 seconds first. |
| `umm import file...` | Save files. An image (png, jpeg, heic, gif, tiff, webp) becomes a screenshot with OCR, anything else a path. |
| `umm rec start`, `stop`, `status` | Voice recording. `umm rec` shows the status. The voice item appears once transcription finishes. |

Pass `-p NAME` to `add`, `clip` or `import` to save into a specific profile. The profile has to exist.

`umm shot --area` is reserved for area select. The backend does not support it yet, so the flag exits with an error.

## Finding

```
umm find invoice                          # search the active profile, best match first
umm find "api key" -A -k text,link        # every profile, only text and links
umm s meeting -a Slack --since 2w         # short alias, app filter, last two weeks
umm find invoice --copy                   # also copy the top hit
umm ls                                    # recent items, same filters, no query
umm ls -k screenshot -n 5 --sort old
umm find x --json | jq '.[].content'      # for scripts
```

`search` has the aliases `find` and `s`. `ls` has `recent` and `l`.

| Flag | Meaning |
| --- | --- |
| `-p`, `--profile NAME` | Profile to look in. Default is the active one. |
| `-A`, `--all` | Every profile. Adds a profile column. |
| `-k`, `--kind` | `screenshot`, `text`, `path`, `link`, `voice`. Comma separated. |
| `-a`, `--app` | App name, for example `Safari`. |
| `--since`, `--until` | `YYYY-MM-DD`, `today`, `yesterday`, `3d`, `2w`. Whole days, inclusive. |
| `-s`, `--sort` | `new`, `old`, `relevance`. |
| `-n`, `--limit` | Default 20, the backend caps it at 200. |
| `--json` | Raw items as JSON. |

Each hit shows the id, kind, age, the profile with `-A`, the app and a one line snippet. Search snippets center on the first match and highlight it. Agent memories and CLI saves carry a short tag like `claude-code · umm` or `cli · umm`.

## Working with one item

| Command | What it does |
| --- | --- |
| `umm show 42` | Print the item in full with its app, file path and meta. `--json` adds `path`. |
| `umm copy 42` | Copy the text, path or link to the clipboard. Alias `cp`. |
| `umm open 42` | Open the screenshot or recording, open the link in the browser, or reveal the path in Finder. Alias `o`. A screenshot past `screenshot_days` has no image left to open. |
| `umm open` | With no id, open the main window. |
| `umm edit 42` | Edit the text in `$VISUAL` or `$EDITOR`. Alias `e`. |
| `umm mv 42 work` | Move to another profile. Takes several ids. |
| `umm rm 42` | Delete, with a confirmation. `-y` skips it. Takes several ids. Alias `delete`. |

The API has no get by id call, so `show`, `copy`, `open`, `edit`, `mv` and `rm` page through items newest first until they find the id. Old ids in a large library take a few requests.

## Profiles

```
umm profile                  # list with counts, the active one is marked
umm profile use work
umm profile new side-project # creates it and makes it active
umm profile rename work job
umm profile rm side-project  # asks first, deletes its items and files
```

`user` and `agent` cannot be renamed or deleted.

## The app

| Command | What it does |
| --- | --- |
| `umm start` | Run `start.sh` and wait until the backend answers. |
| `umm stop` | Quit the app and the backend. |
| `umm status` | App process, backend socket, active profile, item counts, recording state and size of `data/` on disk. Exit code 1 if the app or backend is down. |

When the app is down, every other command prints `umm: the app is not running, start it with: umm start` and exits with 1.

## Environment

| Variable | Use |
| --- | --- |
| `UMM_ROOT` | Repo location. Default is the parent of `cli/`. |
| `VISUAL`, `EDITOR` | Editor for `add` and `edit`. Falls back to `vi`. |
| `NO_COLOR` | Turns colors off. |
