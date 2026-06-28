---
url: https://developers.openai.com/codex/hooks
fetched: 2026-06-28
summary: Codex CLI hooks use the Claude-Code-style event schema (PreToolUse/Stop/SessionStart etc.), block via exit 2 or hookSpecificOutput.permissionDecision (NOT the RFC's `{block:true}`), are command hooks in any language (NOT necessarily Python), configured in ~/.codex/ or repo-local .codex/ via hooks.json or config.toml. Source for RFC-008 P6. Corrects three RFC-008 Codex assumptions.
---

# Codex CLI hooks (for RFC-008 P6 — Codex enforcement plugin)

Verified 2026-06-28 from the official OpenAI docs (developers.openai.com/codex/hooks,
/config-reference) plus GitHub issue #17532. Installed locally: `codex-cli 0.141.0`.

## Event surface (matches Claude Code's schema, NOT a bespoke Codex one)

Turn-scoped: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`UserPromptSubmit`, `SubagentStop`, `Stop`.
Session/subagent-scoped: `SessionStart` (thread or subagent-start), `SubagentStart`.

## PreToolUse coverage + blocking (corrects RFC-008)

- **Fires for:** Bash, file edits via `apply_patch`, and MCP tool calls. Matcher may be
  `"apply_patch"`, `"Edit"`, or `"Write"`; hook input still reports `tool_name: "apply_patch"`.
  Does NOT yet intercept `WebSearch` or all shell calls ("only simple ones").
  => apply_patch coverage means repo-source Edit/Write **is** gateable on Codex (better than
  the "Bash-only" some third-party posts claim).
- **Block mechanism (RFC said `dict {block:true}` — WRONG):**
  1. exit code `2` with the blocking reason on stderr; OR
  2. JSON on stdout:
     `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`
     (`permissionDecision` ∈ allow|deny|ask; PreToolUse also supports `updatedInput`).
  Legacy `{"decision":"block","reason":"..."}` is still accepted (this is the closest thing to
  the RFC's claim). The canonical mechanism is exit-2 / permissionDecision — i.e. essentially
  Claude Code's hook model.

## Hook config (any executable — RFC said "Python hooks", NOT required)

Locations (all four valid): `~/.codex/hooks.json`, `~/.codex/config.toml`,
`<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`.

hooks.json shape:
```json
{ "hooks": { "PreToolUse": [ { "matcher": "^Bash$",
  "hooks": [ { "type": "command", "command": "node /path/adapter.mjs",
    "statusMessage": "Checking", "timeout": 30 } ] } ] } }
```
config.toml inline equivalent: `[[hooks.PreToolUse]]` + `[[hooks.PreToolUse.hooks]]` tables.
Field notes: `timeout` seconds (default 600); `statusMessage` optional; `commandWindows` /
`command_windows` for Windows override; only `type:"command"` runs (`prompt`/`agent` skipped).
Command can be ANY executable (docs use python3 as an example only) — use node `.mjs` to reuse
the ESM thin waist directly, no separate bridge needed.

## stdin / stdout contract

stdin JSON common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
`permission_mode`, `turn_id` (turn-scoped). PreToolUse adds `tool_name`, `tool_input`,
`tool_use_id`. stdout JSON: common `continue`/`stopReason`/`systemMessage`/`suppressOutput`;
PreToolUse adds `hookSpecificOutput`. Exit 0 + no output = success.

## Trust model (install UX implication)

Project-local hooks load only when `.codex/` is trusted. A non-managed command hook requires
review+trust of its exact hash via `/hooks`; new/changed hooks are skipped until trusted.
`--dangerously-bypass-hook-trust` skips for one invocation. So a Codex enforcement install
cannot silently activate — the user must trust the hook (document in the runbook).

## CRITICAL risk — issue #17532 (per-project enforcement)

[#17532](https://github.com/openai/codex/issues/17532) (OPEN as snapshotted, reported on
`0.120.0`): hooks in repo-local `.codex/config.toml` do NOT fire interactive `SessionStart`/
`Stop` (the scripts work when run manually => config-loading bug, not script bug). RFC-008
enforcement is PER-PROJECT (Principle 12), so this directly threatens Codex stop/session_start
STRONG tiers. Mitigations to test empirically on the installed `0.141.0` (newer than 0.120.0):
(a) prefer repo-local `.codex/hooks.json` over `config.toml` (the bug is config.toml-specific);
(b) confirm via a mock-project E2E that project-local Stop/SessionStart actually fire on 0.141.0
before declaring those tiers. Never assume from the RFC.

## EMPIRICAL probe (2026-06-28, codex-cli v0.142.3 / gpt-5.5) — pre_tool_use BLOCKS, no bypass

Drove real `codex exec --cd <mock> --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox`
against a project-local `.codex/hooks.json` PreToolUse hook that denies (stdout
`permissionDecision:"deny"` + exit 2). Results:

- **apply_patch write → BLOCKED.** Codex: `ERROR codex_core::tools::router: error=Command blocked by
  PreToolUse hook`. File not created. Codex surfaced the deny reason to the model.
- **Told to bypass via any shell route → ALL blocked** (6 attempts): `ls -la src`, `apply_patch`,
  `mkdir -p src && printf ... > src/shell.py` (compound redirect), `python3 -c "...write_text..."`,
  `/bin/sh -c '...printf... > ...'` (nested shell), and even `true`. The node_repl MCP route failed
  on an unrelated sandbox-metadata error (no successful write). **No bypass reproduced.**
- => codex `pre_tool_use` **MECHANISM is STRONG** (reliable hard block on apply_patch + every shell
  form the hook is told to deny — no bypass of the mechanism reproduced). **But the probe used a
  blanket-deny hook, so it proves the mechanism CAN block, not that a repo-source extractor can DETECT
  every write.** The P6 adapter denies only writes whose target it can lex; **unlexable** forms
  (`eval`, `$VAR`-expanded paths, command-substitution, `python -c`, `/bin/sh -c '... > src/x'` with
  the redirect inside the quoted arg) are NOT extracted → ALLOW. So the **delivered capability tier is
  MEDIUM** (mechanism STRONG, Bash extractor has a known unlexable residual): declare **MEDIUM** with a
  `bypass_known` MEDIUM ceiling, NOT STRONG/clean-audit (RFC-008 P6, Rule 10). The RFC's original
  "multi-edit bypass" rationale is **refuted** (that specific bypass does not exist on v0.142.3); the
  honest MEDIUM basis is the unlexable-shell extractor residual. Residual also untested: MCP-tool
  writes (node_repl failed before executing).
  **[Superseded interpretation: an earlier read of this probe concluded "correct to STRONG" — that
  conflated the mechanism with the delivered capability; corrected to MEDIUM (RFC-008 P6).]**

**Real PreToolUse stdin (apply_patch), captured:**
```json
{"session_id":"019f...","turn_id":"019f...","transcript_path":"...","cwd":"<abs>",
 "hook_event_name":"PreToolUse","model":"gpt-5.5","permission_mode":"bypassPermissions",
 "tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Add File: src/probe.py\n+print('hello')\n*** End Patch\n"},
 "tool_use_id":"call_..."}
```
Note: `turn_id` is a STRING and there is NO `turn_index` (the adapter must synthesize integer
turn_index for the canonical payload). apply_patch patch text is in `tool_input.command` (a single
string) — `extractTargetPaths` parses the `*** Add/Update/Delete File:` / `*** Move to:` directives
from it.

**Consequence at STRONG:** the thin-waist label branch gates any `shared_write` bash command with no
extractable path (`toolTargetsRepoSource(root,"Bash","",label)` → GATED, `repo-source.mjs:161`) — so
`git commit`/`mkdir`/`npm test` would be BLOCKED, bricking normal use. The codex adapter must gate
bash **only on an extracted repo-source write target**; no-target → allow (unlexable-shell writes are
the documented residual).

## Net corrections to RFC-008 Codex assumptions

1. Block is exit-2 / `permissionDecision:"deny"`, not `{block:true}` (RFC line ~336).
2. Hooks are command hooks in any language; "Python hooks" (P5-P7 doc line 48) is not required —
   use node `.mjs` for thin-waist reuse.
3. Codex's model is claude-code-like (external command hooks, exit-2, same event names),
   NOT opencode-like (in-process agent + node bridge). The P6 adapter is a node command hook,
   not a TS-adapter+bridge pair.
4. **pre_tool_use MECHANISM is STRONG; delivered capability is MEDIUM** (empirical, v0.142.3 — see
   probe above). The mechanism hard-blocks anything the hook denies, but the adapter's repo-source
   extractor cannot lex unlexable forms (`eval`/`$VAR`/command-subst/`python -c`/`sh -c`), so those
   ALLOW (the MEDIUM-ceiling residual). **Declare MEDIUM** (mechanism STRONG); the adapter BLOCKS
   (deny) for covered writes by passing a runtime STRONG mechanism cap to `gateDisposition`, while the
   manifest/registry/`bypass_known` declare MEDIUM (`events.json` maps `pre_tool_use@MEDIUM`→warn, so
   feeding the manifest cap would NOT block — RFC-008 P6 §8.2 tier/cap split). bash gating must be
   extract-only (per-path `isRepoSource`, never the Bash-label branch) to avoid bricking `git commit`
   etc. **[Superseded: an earlier note here concluded the tier should be STRONG — corrected to MEDIUM
   (mechanism vs capability), RFC-008 P6.]**
