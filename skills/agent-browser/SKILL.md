---
name: agent-browser
description: Automates browser interactions with profile persistence, session management, video recording, and streaming. Use when the user needs to navigate websites, interact with web pages, fill forms, take screenshots, test web applications, extract information from web pages, record browser sessions, or maintain persistent browser state across runs.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation

Run `npx agent-browser --help` for complete usage. The `--help` output is the authoritative reference — do not rely on prior knowledge of flags or subcommands.

## Key capabilities (0.23+)

- **Profile persistence**: `--profile <path>` for persistent browser profiles (cookies, IndexedDB)
- **Session management**: `--session-name` auto-save/restore state; `--auto-connect` to reuse running Chrome
- **State save/load**: `--state <path>` to export/import browser state as JSON
- **Video recording**: `record start/stop` to capture browser sessions
- **Trace recording**: `trace start/stop` for debugging
- **WebSocket streaming**: real-time browser event stream via `AGENT_BROWSER_STREAM_PORT`

## Common operations

- Navigate: `agent-browser open <url>`
- Screenshot: `agent-browser screenshot [path]`
- Accessibility snapshot: `agent-browser snapshot -i`
- Click by ref: `agent-browser click @e2`
- Fill form field: `agent-browser fill @e3 "value"`
- Get text: `agent-browser get text @e1`

Always check `--help` for exact flags before use.

## Verification

**What to check:** The CLI launches a real browser, navigates to a URL, and returns the actual page content in the accessibility snapshot.

**How to run:**
```bash
agent-browser open https://example.com
agent-browser snapshot -i
```

The snapshot output must contain the text "Example Domain" — this is the actual page title rendered by the live browser. A weak check (e.g., confirming the process exits 0) cannot prove a page loaded; the snapshot text is the only proof that DOM content was fetched and parsed.

**What failure mode it catches:** A broken CDP connection, a missing Chromium binary, or a crashed browser process will cause `snapshot` to return an error or an empty tree. The actual page text cannot appear in the snapshot unless the browser successfully navigated and rendered the page. A stub or mock cannot produce this output.

**Why it cannot be gamed:** The text "Example Domain" is served by a live HTTP server (`example.com`). It appears in the accessibility tree only after the browser makes a real network request, parses the HTML, and builds the DOM. No in-process mock can satisfy this check without the actual browser stack being functional.
