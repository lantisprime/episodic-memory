---
url: https://manaflow-ai-cmux.mintlify.app/automation/cli-reference
also: https://cmux.com/ , https://github.com/manaflow-ai/cmux
fetched: 2026-06-28
summary: cmux CLI for programmatic terminal control over a Unix socket. Native macOS app (NOT a tmux-style wrapper). send / send-key / read-screen drive an interactive session like tmux send-keys / capture-pane. Empirically smoke-tested: send a command + send-key enter + read-screen round-trips the executed output. Candidate replacement for the tmux codex-drive.sh review driver.
---

# cmux CLI — programmatic terminal control

cmux is a **native, first-class macOS terminal app** (per user, 2026-06-28). Some web sources
describe it as "Ghostty-based" — that refers to terminal rendering (libghostty / Ghostty config
integration at `~/.config/ghostty/config`), not to it being a tmux-style multiplexer-in-a-terminal.
Every action is exposed through the `cmux` CLI talking to the app over a Unix socket.

## Refs / targeting
- Handles: UUIDs, short refs (`window:1`, `workspace:2`, `pane:3`, `surface:4`), or indexes.
- `--workspace <ref>` / `--surface <ref>` target a context; output defaults to refs.
- Env auto-set inside cmux terminals: `CMUX_WORKSPACE_ID` (default `--workspace` for all commands),
  `CMUX_SURFACE_ID` (default `--surface`), `CMUX_TAB_ID`.
- Socket: `CMUX_SOCKET_PATH` override; default discovered (installed v: `~/.local/state/cmux/cmux.sock`;
  docs say `/tmp/cmux.sock`) with auto-discovery of tagged/debug sockets. Auth: `--password` /
  `CMUX_SOCKET_PASSWORD`.

## Driving primitives (the tmux-equivalents)
- **Create:** `cmux new-workspace [--name <title>] [--cwd <path>] [--command <cmd>] [--focus false]`.
  `--command` runs a command and **auto-appends a newline**. Returns `OK workspace:<n>`.
- **Send text:** `cmux send --workspace <ref> "<text>"`. Auto-unescapes `\n` and `\t`. Does NOT append
  a newline by itself — follow with an explicit Enter. Returns `OK surface:<n> workspace:<n>`.
- **Send key:** `cmux send-key --workspace <ref> <key>` — key names are lowercase: `enter`, `escape`,
  `ctrl+c`. (NOT `Enter`.)
- **Read screen:** `cmux read-screen --workspace <ref> [--surface <ref>] [--lines <n>] [--scrollback]`.
  `--lines <n>` implies `--scrollback`. tmux-compat alias: `capture-pane`. (Also `pipe-pane`,
  `wait-for`, `set-buffer`/`paste-buffer`, `respawn-pane` exist as tmux-compat.)
- **List / close:** `cmux workspace list` (legacy alias `list-workspaces`); `cmux close-workspace
  --workspace <ref>` → `OK workspace:<n>` (idempotent).
- **Probe:** `cmux ping`, `cmux identify`, `cmux capabilities`, `cmux version`.
- `--json` is available on commands for structured output.
- No documented "command finished" signal — poll `read-screen` and match on expected output
  (same model as the tmux driver's poll/wait loop).

## Native agent integrations
`cmux codex-teams [codex-args...]`, `cmux claude-teams [...]`, `cmux omo [opencode-args...]`,
`cmux hooks <agent> <install|uninstall|event>`. So codex can be launched as a first-class cmux
surface rather than via a tmux-wrapped TUI.

## Empirical smoke test (2026-06-28, this repo session)
Driver `scratchpad/cmux-test.sh`: `new-workspace --focus false` → `send "echo \"result=$((6*7))\""`
→ `send-key enter` → `read-screen --lines 40` → `close-workspace`. The capture contained the typed
command line AND a separate `result=42` output line — **non-vacuous proof the shell evaluated it**
(input shows `$((6*7))`, output shows `42`). Acks were `OK workspace:18` / `OK surface:19 workspace:18`.

## Why this matters here
Candidate replacement for the tmux `~/.claude/codex-drive.sh` review driver: a clean Unix-socket CLI
with structured `OK ...` acks, no tmux server, native macOS app, and built-in `codex-teams`. The
driving loop maps 1:1: tmux `new-session`+`send-keys`+`capture-pane` → cmux
`new-workspace`+`send`/`send-key`+`read-screen`.
