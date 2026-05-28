---
name: cursor-hooks
metadata:
  node_type: memory
  url: https://cursor.com/docs/agent/hooks
  fetched: 2026-05-28
  summary: "Cursor exposes a 16+ event programmatic hook system with both BLOCKING hooks (preToolUse, beforeShellExecution, beforeMCPExecution, beforeReadFile, beforeSubmitPrompt, subagentStart, beforeTabFileRead) and observational/context-injecting hooks (sessionStart, postToolUse, stop, etc.). NOT a WEAK harness — STRONG-capable on most events."
  originSessionId: 020a9125-8340-41d2-84ee-49d0f493e71a
---

# Cursor hooks — 2026-05-28 snapshot

> Committed into the repo for RFC-008 F43/F59 auditability. Source of truth for the Cursor capability-matrix correction (WEAK → STRONG-capable) in `docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` §Capability-degradable enforcement.

## Critical correction for RFC-008

The §Capability-degradable enforcement table in RFC-008 (≤ v11) labels Cursor as `WEAK` across all events. **This is factually wrong against current Cursor docs.** Cursor is STRONG-capable on most events. See revised capability mapping below.

## Blocking hooks (can deny/block actions — STRONG tier candidates)

| Hook | Maps to RFC-008 event | Input | Output | Block mechanism |
|---|---|---|---|---|
| `preToolUse` | `pre_tool_use` | `tool_name`, `tool_input`, `tool_use_id`, `cwd` | `permission` ("allow"\|"deny"), `user_message`, `agent_message`, `updated_input` | `permission: "deny"` |
| `beforeShellExecution` | `pre_tool_use` (Bash subset) | `command`, `cwd`, `sandbox` | `permission` ("allow"\|"deny"\|"ask"), messages | `permission: "deny"` |
| `beforeMCPExecution` | `pre_tool_use` (MCP subset) | `tool_name`, `tool_input`, server details | `permission` ("allow"\|"deny"\|"ask") | `permission: "deny"` |
| `beforeReadFile` | `pre_tool_use` (Read subset) | `file_path`, `content`, `attachments` | `permission` ("allow"\|"deny"), `user_message` | `permission: "deny"` |
| `beforeSubmitPrompt` | (no direct RFC-008 mapping; pre-classifier surface) | `prompt`, `attachments` | `continue` (bool), `user_message` | `continue: false` |
| `subagentStart` | (no direct mapping; subagent-spawn) | `subagent_id`, `subagent_type`, `task`, `parent_conversation_id` | `permission` ("allow"\|"deny") | `permission: "deny"` |
| `beforeTabFileRead` | (Tab-completion surface; not the RFC-008 agent path) | `file_path`, `content` | `permission` ("allow"\|"deny") | `permission: "deny"` |

## Context-injecting hooks (advisory/observational — MEDIUM/WEAK)

| Hook | Maps to RFC-008 event | Tier | Notes |
|---|---|---|---|
| `sessionStart` | `session_start` | **STRONG** (R-action: `inject_context`) | Output `additional_context` injects mechanically + verifiable; deterministic per session |
| `sessionEnd` | `session_end` | **STRONG** (R-action: `write_artifact`) | Fires deterministically with `session_id`, `reason`, `duration_ms`, `final_status` |
| `postToolUse` | `tool_result` | **MEDIUM** (R-action: `observe` + partial `modify`) | Can update MCP tool output via `updated_mcp_tool_output` + inject `additional_context`; not full modify like OpenCode |
| `postToolUseFailure` | `tool_result` (failure subset) | MEDIUM | Observational on errors |
| `afterShellExecution` | `tool_result` (Bash subset) | MEDIUM | Audit-focused |
| `afterMCPExecution` | `tool_result` (MCP subset) | MEDIUM | Observational |
| `afterFileEdit` | `tool_result` (Edit subset) | MEDIUM | Post-processing |
| `subagentStop` | (subagent surface, no direct map) | MEDIUM | Can trigger auto-continuation via `followup_message` |
| `preCompact` | (no map; compaction event) | MEDIUM | Observational with `context_usage_percent` |
| `stop` | `stop` | **WEAK→MEDIUM** | Output `followup_message` triggers auto-submission (re-enters loop) — can "refuse stop" by forcing followup, but NOT a clean block; semantically MEDIUM |
| `afterAgentResponse` | (no map) | WEAK | Observational |
| `afterAgentThought` | (no map) | WEAK | Observational |
| `workspaceOpen` | (no map; lifecycle) | MEDIUM | Output `pluginPaths` |

## Corrected capability matrix for Cursor (replaces the WEAK row in §Capability-degradable enforcement)

| Event | Tier | Cursor hook | Action semantics (per events.json) |
|---|---|---|---|
| `pre_tool_use` | **STRONG** | `preToolUse` + `beforeShellExecution` + `beforeMCPExecution` + `beforeReadFile` | `block` (permission: deny) |
| `tool_result` | **MEDIUM** | `postToolUse` + `afterShellExecution` + `afterFileEdit` | `observe` (partial `modify` only via `updated_mcp_tool_output`) |
| `stop` | **MEDIUM** | `stop` | `warn` only (followup-message triggers re-entry, not true refuse-stop) |
| `session_start` | **STRONG** | `sessionStart` | `inject_context` (mechanical via `additional_context`) |
| `session_end` | **STRONG** | `sessionEnd` | `write_artifact` (fires deterministically) |

## Implementation notes

- Exit code semantics: `0` = succeeded, `2` = block, others = fail-open (default). Override with `failClosed: true` per hook definition.
- Cursor also supports **prompt-based hooks** — LLM-evaluation natural-language policy enforcement via `"type": "prompt"`. Out of scope for episodic-memory's static-config plugins but worth knowing exists.
- Hook config format: JSON file at workspace level (path/syntax not surfaced in this doc excerpt; need follow-up fetch on hook configuration before P1).

## OQ-3 implication (RFC-008)

Cursor MUST get a full `plugins/cursor/` directory with adapter implementing the blocking hooks, NOT a rules-injection-only stub. The 2026-05-28 docs put Cursor architecturally next to Claude Code / OpenCode, not next to Windsurf.

## What's NOT yet researched (open follow-ups before P5–P7 Cursor plugin lands)

- Exact hook configuration file format (path, syntax for declaring multiple hooks of same event type, precedence rules)
- How Cursor handles concurrent hook invocations
- Whether `pluginPaths` from `workspaceOpen` can be used to install episodic-memory's hooks dynamically (vs. static install)
- Specifics of the `failClosed: true` semantics under exit-code chaos
