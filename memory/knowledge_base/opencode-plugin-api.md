---
url: https://opencode.ai/docs/plugins/ + https://opencode.ai/docs/config/ + probed @opencode-ai/plugin@1.14.50 dist/index.d.ts
fetched: 2026-06-23
summary: OpenCode plugin hook API (ground truth from installed types, not web docs). Source for RFC-008 P5 OpenCode plugin OD-1/OD-2. Web docs were WRONG on tool.execute.after (it IS mutable) — installed types are authoritative.
---

# OpenCode plugin/hook API (RFC-008 P5)

**Authoritative source:** the installed `@opencode-ai/plugin@1.14.50`
`dist/index.d.ts` (`~/.opencode/node_modules/@opencode-ai/plugin/`). Web docs
conflict with it and were wrong in one material place (see tool.execute.after).
Probe the installed version, do not trust the web docs.

## Plugin shape & loading
- A plugin is an ESM TS/JS module: `Plugin = (input: PluginInput, options?) => Promise<Hooks>`.
- `PluginInput` context: `{ client, project, directory, worktree, $, serverUrl, experimental_workspace }`.
  - `directory` (string) = current working directory. `worktree` (string) = git worktree path.
  - **cwd is NOT in any event payload — it comes from this context.**
- Loaded from `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global) — **plural** per docs/config.
  Also registerable via the config `plugin` array in `opencode.json[c]`: `"plugin": ["pkg-name", "./path"]` (robust, version-independent — prefer this for install).
- Runs under OpenCode's runtime (Bun). External npm deps allowed via `.opencode/package.json`, but a type-only import of `@opencode-ai/plugin` is erased at runtime → zero runtime dep is achievable.

## Hooks (from `interface Hooks`, dist/index.d.ts:173-316)
| Hook | input | output (mutable) | Enforcement use |
|---|---|---|---|
| `tool.execute.before` | `{tool:string, sessionID:string, callID:string}` | `{args:any}` | **pre_tool_use STRONG.** Block by `throw`. Mutate `output.args`. |
| `tool.execute.after` | `{tool, sessionID, callID, args}` | `{title:string, output:string, metadata:any}` | **tool_result STRONG (modify).** `output.output` IS mutable → result mutation before model sees it. (Web docs wrongly said observe-only.) |
| `experimental.chat.system.transform` | `{sessionID?, model}` | `{system:string[]}` | **session_start MEDIUM.** `output.system.push(ctx)` — experimental, best-effort inject. |
| `event` | `{event: Event}` | — (void) | **observe only.** Sees `session.idle`/`session.created`/etc. Only path for "stop". |
| `permission.ask` | `Permission` | `{status:"ask"|"deny"|"allow"}` | could deny permissions (not used by P5). |
| `chat.params` / `chat.headers` / `chat.message` | per-message | various | not used by P5. |

## Capability honesty (P5 declared tiers — all verified against types)
- `pre_tool_use: STRONG` — `tool.execute.before` + throw. ✓
- `tool_result: STRONG` — `tool.execute.after` mutable `output.output`. ✓ (must E2E-confirm OpenCode re-reads mutated output).
- `session_start: MEDIUM` — only experimental transform, best-effort. ✓
- `stop: MEDIUM` — **no refuse-stop hook exists.** Only `event`→`session.idle` observe → warn/log. Cannot block a stop. STRONG is impossible. ✓ (maps events.json stop MEDIUM=warn).

## Translation gaps (OpenCode event → canonical payload)
The canonical event schemas (`schemas/events/event-*.schema.json`) require fields OpenCode does not put in the event:
- **`cwd`** — not in event; adapter injects from `PluginInput.directory`.
- **`turn_index`** — not provided anywhere; adapter synthesizes a per-`sessionID` monotonic counter (Map), incremented on each `tool.execute.before`. The canonical contract uses turn_index only for ordering/monotonicity, so an adapter-maintained counter satisfies it.
- So the OpenCode adapter has a **normalize step** (merge context + synthesize turn_index) BEFORE the declarative `field_bindings`. The harness-event fixtures represent the post-normalize object the field_bindings consume; the normalize step is covered by the adapter unit test, not the gauntlet.

## Blocking semantics
- Block = `throw new Error(msg)` inside the hook (verified: `.env` example throws to refuse a read).
- Modify result = mutate `output.output` in `tool.execute.after`.
