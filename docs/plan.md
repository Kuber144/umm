# Plan

## Entry points

1. Hotkey menu. `Ctrl+Shift+Space` from any app saves a screenshot, the clipboard or a typed note. Done.
2. MCP. Agents search and save, and each agent can use its own profile. Done.
3. CLI. An `umm` command, for example `umm add "..."`, `umm search tax`, `umm start`, `umm stop`. Next.

## Steps

1. Done. Backend, SQLite FTS5 search, OCR, profiles, web UI, MCP, hotkey menu, start and stop scripts.
2. CLI.
3. Voice. A menu row toggles recording, local Whisper (`faster-whisper`, models already in the HuggingFace cache) transcribes it, and the transcript gets saved.
4. Links. Pull tweet text (X oEmbed) and YouTube titles so they show up in search.
5. Ask box in the UI that calls Claude with your API key.
6. Maybe later. Embeddings for fuzzy search, start at login.

## Decisions

- No Raycast or other launcher. umm runs on its own.
- The menu is native Swift, not React, so it opens instantly and needs no Electron.
- Context is generic. Every item stores the front app and window title, read the same way for every app.
- Screenshots are JPG. They are about 9x smaller than PNG and OCR reads the same text.
