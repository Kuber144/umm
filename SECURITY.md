# Security

## Reporting

Please report vulnerabilities privately. Use GitHub security advisories: open the Security tab of [Kuber144/umm](https://github.com/Kuber144/umm) and choose "Report a vulnerability". Please do not open a public issue for security problems. You will get a reply within a few days.

## What umm handles

umm stores whatever you save: screenshots, OCR text, clipboard contents, notes, file paths, links and voice recordings. All of it is in `data/` on your Mac and is not encrypted. Anyone with access to that folder, or to the MCP server you connect to an agent, can read it.

- The backend listens on a Unix socket in `data/`, not a TCP port.
- Agents connected over MCP can read all your memories and can add new ones. They can edit or delete only items in the `agent` profile unless the user lets them.
- Network use is limited to link lookups for links you save, and a one-time Whisper model download.
- umm needs the Screen Recording and Microphone permissions.

Good reports include a way to reproduce the problem and what an attacker would gain.
