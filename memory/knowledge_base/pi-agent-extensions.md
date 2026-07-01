---
url: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
fetched: 2026-07-01
summary: Pi coding-agent ExtensionAPI. tool_call is the blocking pre-tool event (return {block:true,reason}); session_start/session_shutdown/turn_end exist but are observe-only (return void, NOT cancellable). Extensions are TypeScript loaded via jiti (zero-compile); project-local dir is .pi/extensions/*.ts (requires project trust) — this is the per-project home for P7 enforcement, NOT global ~/.pi/agent/extensions. Runtime EMPIRICAL (P7 S0, 2026-07-01): host = Node.js v26.0.0 (NOT Bun), in-process import() of a .mjs works, ctx has NO projectRoot. Source for RFC-008 P7.
---

## EMPIRICAL (P7 S0) — live probe result (2026-07-01)

Ran `pi -e /tmp/em-pi-probe/probe-run.mjs --provider deepseek --model deepseek-v4-flash
--no-session --no-tools -p "reply ok"`; the `session_start` handler logged:

- **Host runtime = Node.js `v26.0.0`.** `process.execPath` =
  `/opt/homebrew/Cellar/node/26.0.0/bin/node`; `process.versions.node = 26.0.0`;
  `globalThis.Bun` undefined (`hasBun: false`). => The P5 Bun/`process.execPath` trap does
  NOT apply to Pi. If the adapter ever spawned, `process.execPath` here IS node — but it does
  not need to spawn (next point).
- **In-process `import()` of a `.mjs` WORKS** (`importOk: true`, the module's export read
  back correctly). => the P7 adapter dynamic-`import()`s the co-deployed `.mjs` thin-waist
  IN-PROCESS. No child process, no node-resolution. This settles the A2/A4 bridge decision.
- **`ctx` exposes NO `projectRoot`.** ctx keys = `ui, mode, hasUI, cwd, sessionManager,
  modelRegistry, model, isIdle, isProjectTrusted, signal, abort, hasPendingMessages,
  shutdown, getContextUsage, compact, getSystemPrompt`. => the adapter MUST resolve `repoRoot`
  itself (git-toplevel of `realpath(ctx.cwd)`); it CANNOT use `ctx.projectRoot` (BLOCKER 3 is
  mandatory, not "if present"). `ctx.cwd` is present and is the project cwd.
- Deployed adapter file extension: default `.js` (packages.md guarantees the loader
  discovers `.ts`+`.js`; `.mjs` is loaded by `-e` but project-local glob discovery is not
  separately confirmed for `.mjs`, so use `.js`).
- **Nested-package auto-discovery WORKS (P7 S5-prep probe, 2026-07-01).** Ran `pi --approve
  --no-session --no-tools --provider deepseek --model deepseek-v4-flash -p "reply ok"` in a
  trusted project holding BOTH `.pi/extensions/toplevel-probe.js` (top-level file) AND
  `.pi/extensions/nested-probe/index.js` (nested `<name>/index.js` package); each factory
  wrote a sentinel on load. Result: `exit 0`, BOTH sentinels present => Pi auto-discovers a
  nested `.pi/extensions/<name>/index.js` package, not only top-level `*.js` files. => the P7
  S5 deploy tree `<proj>/.pi/extensions/episodic-memory/index.js` loads with NO
  `settings.json`/`package.json` `extensions` registration and NO top-level re-export shim.
  `--approve` (or interactive project trust) is the activation gate. The docs' `*.ts` glob
  wording understates this; nested index-package discovery is real.

# Pi coding-agent ExtensionAPI (RFC-008 P7 source)

Canonical repo: `earendil-works/pi`, package `@earendil-works/pi-coding-agent`
(imports `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai`). Extension doc:
`packages/coding-agent/docs/extensions.md`. Corroborated on-disk by the working
`pi-extensions/permission-policy/index.ts` extension (a real Pi tool-call gate).

## Event model (`pi.on(eventName, handler)`)

Factory: `export default function (pi: ExtensionAPI) { ... }` (may be async).

**Blocking pre-tool event — the one P7 needs:**
- `tool_call`: `async (event, ctx) => { block?: boolean, reason?: string }`.
  Return `{ block: true, reason }` to DENY the tool before it runs. `event.input`
  is mutable (can patch args). This is the STRONG-capable mechanism → RFC's
  `pre_tool_use: STRONG` is mechanically justified (block fires synchronously
  pre-execution). `event.toolName` + `event.input` are the fields (per the live
  permission-policy extension).

**Observe-only lifecycle events (return void — CANNOT cancel a real quit):**
- `session_start`: `event.reason: "startup"|"reload"|"new"|"resume"|"fork"`. NOTE (codex
  P7 review 2026-07-01): RFC-008 `session_start: STRONG` means dynamic CONTEXT INJECTION
  with transcript-visible effect — a plain observe-only `session_start` handler does NOT
  deliver that. To deliver STRONG session_start, P7 must use Pi's `before_agent_start`
  (`{ message?, systemPrompt? }` — inject messages / modify system prompt), not
  `session_start` alone.
- `session_shutdown`: `event.reason: "quit"|"reload"|"new"|"resume"|"fork"` → void.
- `turn_end`: `event.toolResults` → void.
  So "stop" enforcement is observe-only = **MEDIUM ceiling** (matches RFC `stop: MEDIUM`);
  you cannot hard-block session end via session_shutdown/turn_end. (Cancellable variants
  exist only for switch/fork/compact: `session_before_switch|fork|compact` return
  `{cancel?: boolean}` — none is a true session-quit gate.)
- `tool_result`: `{ content?, details?, isError? }` — can modify a result (mutable).

## Built-in tools + input field names

Tools: `read`, `write`, `edit`, `bash` (+ `grep`, `find`, `ls`). Input fields
(from the live permission-policy extension, authoritative):
- `write` / `edit` → `input.path`
- `read` → `input.path`
- `bash` → `input.command`

NOTE: differs from codex (`filePath`/`file_path`, `command`/`cmd`) and Claude
(`file_path`). **No `apply_patch` tool** (that is codex-only) — Pi writes go through
`write`/`edit`/`bash`. The codex bash-write lexing residual applies identically to Pi's
`bash` command, so if P7 gates bash writes with the same extractor, the same MEDIUM
lexing ceiling exists (honesty note for the tier claim).

## Extension development model (P7 is a Pi EXTENSION, not a codex command hook)

Unlike codex (external node command hook, stdin→exit code), a Pi enforcement plugin is a
first-class Pi **extension**: an in-process JS/TS module.

- **Entry:** `export default function (pi) { pi.on("tool_call", async (event, ctx) => {...}) }`
  (may be async). **JS is first-class** — `packages.md`: "`extensions/` loads `.ts` and
  `.js` files." So P7's adapter is a plain zero-dep ESM extension. Deployed file extension:
  default `.js` (loader-guaranteed by packages.md; `.mjs` not explicitly listed → the S0
  probe confirms which the project-local loader accepts).
- **In-process** in Pi's extension host → the adapter can dynamic-`import()` the `.mjs`
  thin-waist directly (no child process). This SIDESTEPS the spawn/`process.execPath`/Bun
  trap that cost P5 a round — pending the A2 probe confirming jiti-host `import()` of a
  plain `.mjs` works. Only fall back to spawn if that import fails, and then resolve `node`
  explicitly.
- **ExtensionAPI surface:** `pi.on(event,h)`, `registerTool`, `registerCommand`,
  `registerShortcut`, `registerFlag`, `sendMessage`, `appendEntry`, `exec`, `pi.events`
  (inter-extension).
- **ctx fields (handler):** `ctx.cwd` (use for relative `input.path` resolution — A4),
  `ctx.hasUI`, `ctx.mode` ("tui"|"rpc"|"json"|"print"), `ctx.ui.*`, `ctx.model`,
  `ctx.signal`, `ctx.isProjectTrusted()`, `ctx.shutdown()`, `ctx.sessionManager`.
- **STRONG session_start = `before_agent_start`** handler returning `{ message?,
  systemPrompt? }` (inject context / modify system prompt, transcript-visible). Plain
  `session_start` is observe-only.
- **Dev/test:** `pi -e ./ext.js` (quick load), `/reload` (hot reload), auto-discovery from
  `.pi/extensions/`. NO documented unit test harness — testing is interactive TUI OR via
  non-interactive modes (`ctx.mode === "rpc"|"json"|"print"`). => P7 live E2E must drive Pi
  in a non-interactive mode (or the universal `test-plugin.mjs` gauntlet against fixtures +
  a scripted `pi -e` smoke).
- **Packaging:** bare file in `.pi/extensions/` (convention, no manifest needed), OR
  `package.json` `"pi": { "extensions": ["./..."] }`, OR `settings.json`
  `{ "extensions": [...], "packages": ["npm:...","git:..."] }`.

## Install / location (per-project is supported)

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `.pi/extensions/*.ts` | **Project-local** (requires project trust) |
| `-e ./path.ts` flag | CLI override (quick tests) |
| `settings.json` `{ "extensions": [...], "packages": [...] }` | extra paths / npm/git packages |

**P7 deploys to `<project>/.pi/extensions/` — the project-local dir — never the global
`~/.pi/agent/extensions/`.** This satisfies the LOCKED requirement (enforcement per-project,
NEVER global; Principle 12 substrate global hook-free). Project-local load requires Pi
"project trust" (`project_trust` event: `{ trusted: "yes"|"no"|"undecided" }`).

## Runtime — NOT doc-confirmed (probe before building the adapter)

Extensions are TypeScript modules loaded via **jiti** (zero compilation); Node built-ins,
npm deps, and bare `@earendil-works/*` imports are supported. Install is `npm install -g
--ignore-scripts @earendil-works/pi-coding-agent`. codex P7 review (2026-07-01) read the
Pi package metadata: it declares `bin: dist/cli.js` + `engines.node >= 22.19.0` (Node
path), BUT there is ALSO a Bun-compiled binary build path — so the host runtime for
extensions is genuinely ambiguous and NOT safe to infer. This is the exact axis that cost
P5 a review round (opencode ran under Bun; `process.execPath` was the Bun binary, not node
→ adapter fail-closed on every call; lesson `20260628-060804-…5050`). So P7 MUST
empirically probe Pi's runtime before choosing the adapter->thin-waist bridge (probe:
`process.execPath`, `process.versions`, `globalThis.Bun`, and a dynamic `import()` of
`scripts/enforce-contract.mjs` from inside a real project-local extension):
- If in-process dynamic `import()` of the `.mjs` waist under jiti works cleanly → prefer it
  (mirrors opencode enforce.ts + enforce-bridge.mjs).
- If spawning a child is needed → resolve `node` explicitly (never `process.execPath`).

## Impact on RFC-008 P7 assumptions (codex-validated 2026-07-01, /tmp/pi-p7-verdict.md)

1. CONFIRMED: `pre_tool_use` MECHANISM STRONG via `tool_call` return `{block:true}` (blocks
   synchronously pre-execution; `event.input` mutable).
2. PARTIAL: `session_start` exists but is observe-only — RFC `session_start: STRONG` (context
   injection) requires `before_agent_start`, not `session_start` alone. `session_shutdown`/
   `turn_end` void/non-cancellable → `stop: MEDIUM` honest.
3. CONFIRMED: per-project home `.pi/extensions/` — aligns with locked per-project rule.
   Caveat: project-local extensions do NOT run before project trust; cannot enforce the
   trust decision itself.
4. CONFIRMED but implementation-sensitive: the thin waist (`repo-source.mjs`) gates
   repo-source only (outside-repo / carveouts / gitignored → allow). The adapter MUST resolve
   relative `input.path` against Pi's `ctx.cwd` BEFORE calling `isRepoSource` — `repo-source.mjs`
   falls back to `process.cwd()` for relative paths, which is WRONG inside a host extension
   (same class as codex r7 F1 `process.cwd` target-resolution bypass).
5. PROBE: Pi runtime (Node/Bun) ambiguous (engines.node>=22.19 AND Bun binary path) → drives
   in-process-import vs spawn-resolved-node bridge choice. Never `process.execPath`.
6. TIER (key finding): mechanism STRONG ≠ delivered `pre_tool_use` STRONG. Delivered tier is a
   DESIGN CHOICE driven by the Bash policy:
   - Codex-style path extractor (gate repo-source writes only, allow unlexable/no-target bash)
     → same MEDIUM lexing residual as codex → delivered MEDIUM.
   - Overblock (gate ALL non-read-only/unknown bash when no safe outside-repo target proven)
     → can honestly be STRONG, BUT blocks some outside-repo bash writes.
   The LOCKED rule R3 (`feedback_enforcement_gate_only_repo_src`: outside-repo writes
   PERMITTED, gate ONLY repo-source) FORBIDS the overblock path → P7 delivered
   `pre_tool_use` = MEDIUM, matching codex. RFC-008's declared Pi `pre_tool_use: STRONG`
   therefore needs a MEDIUM honesty-downgrade (with a Pi `bypass_known` ceiling entry),
   exactly as codex got. codex verdict: "single most likely thing you got wrong = treating
   'Pi has a STRONG blocking hook' as 'Pi delivers STRONG pre_tool_use'."
