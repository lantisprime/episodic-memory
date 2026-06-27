/**
 * enforcement.ts — OpenCode enforcement plugin (RFC-008 P5 S5, REQ-8/9/10/13/14).
 *
 * TypeScript adapter registered as an OpenCode plugin. Spawns the node bridge
 * (enforce-bridge.mjs) for each tool.execute.before event and applies the
 * §12 action semantics:
 *   block  → throw (refuses the tool call)
 *   allow  → return (proceeds)
 *   bridge exit≠0 / bad JSON / timeout → throw fail-closed
 *
 * Non-blocking events (tool_result, session_start, stop) are MEDIUM observe:
 * the bridge is invoked for audit/logging but never throws.
 *
 * Hook surface is pinned to the INSTALLED @opencode-ai/plugin `interface Hooks`
 * (dist/index.d.ts:173-316), NOT web docs. The host indexes hooks by FLAT
 * DOTTED keys ("tool.execute.before") and calls them with TWO args
 * (input, output); a nested object or single-arg signature is silently never
 * invoked (fails OPEN). Ground truth:
 *   "tool.execute.before"(input:{tool,sessionID,callID}, output:{args})
 *   "tool.execute.after"(input:{tool,sessionID,callID,args}, output:{title,output,metadata})
 *   "experimental.chat.system.transform"(input:{sessionID?,model}, output:{system})
 *   event(input:{event})  — Event union; session end = type "session.idle"
 * PluginInput carries `directory` (cwd source) but NO sessionId — sessionID
 * comes from each hook's `input`.
 *
 * Type-only import of @opencode-ai/plugin — no runtime dependency.
 *
 * OD-4 note: the bp-001 checkpoint/plan-approval MARKER lifecycle is NOT
 * replicated here. P5 enforces the repo-source-write × disposition AND only.
 * The full bp-001 lifecycle port is deferred to a follow-up slice.
 */

// @ts-ignore — type-only; not compiled in this repo (zero-dep policy for test harness)
import type { Plugin } from "@opencode-ai/plugin";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, "enforce-bridge.mjs");

// Per-session turn_index counters. Incremented synchronously BEFORE any await
// (EC3: no shared mutable state that a concurrent call could race on).
const _turnIndex = new Map<string, number>();

function nextTurnIndex(sessionId: string): number {
  const n = (_turnIndex.get(sessionId) ?? -1) + 1;
  _turnIndex.set(sessionId, n);
  return n;
}

/** Spawn the bridge, return parsed stdout decision. Throws on any error. */
function callBridge(envelope: Record<string, unknown>): { action: string; reason: string; label: string | null; effective_tier: string | null } {
  const input = JSON.stringify(envelope);
  const r = spawnSync(process.execPath, [BRIDGE], {
    input,
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.error) throw new Error(`opencode-enforce: bridge spawn error: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`opencode-enforce: fail-closed: bridge exited ${r.status}: ${(r.stderr || "").slice(0, 200)}`);
  let parsed: { action: string; reason: string; label: string | null; effective_tier: string | null };
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    throw new Error(`opencode-enforce: fail-closed: bridge stdout not valid JSON: ${(r.stdout || "").slice(0, 200)}`);
  }
  return parsed;
}

export const EpisodicEnforcement: Plugin = async (ctx) => {
  // cwd source: PluginInput.directory. Resolved per-call (worktree can change).
  const directoryOf = (): string => realpathSync(ctx.directory);

  return {
    /**
     * tool.execute.before — pre_tool_use (STRONG block).
     * Real signature: (input:{tool,sessionID,callID}, output:{args}).
     * tool_args live in `output.args`; sessionID in `input.sessionID`.
     * Block by throwing; allow by returning.
     */
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: unknown },
    ): Promise<void> => {
      const sessionId = input.sessionID || "unknown";
      // EC3: synchronous increment before any await.
      const turnIndex = nextTurnIndex(sessionId);
      const cwd = directoryOf();

      const envelope = {
        harness: "opencode",
        event: "pre_tool_use",
        normalized: {
          tool: input.tool,
          tool_args: output.args ?? {},
          cwd,
          session_id: sessionId,
          turn_index: turnIndex,
          timestamp_iso8601: new Date().toISOString(),
        },
      };

      const decision = callBridge(envelope);
      if (decision.action === "block") {
        throw new Error(decision.reason || "opencode-enforce: write blocked by enforcement gate");
      }
      // allow → return (no-op)
    },

    /**
     * tool.execute.after — tool_result (MEDIUM observe).
     * Real signature: (input:{tool,sessionID,callID,args}, output:{title,output,metadata}).
     * args live in `input.args`; the tool result text in `output.output`.
     * Invokes bridge for audit; never throws; never mutates output.
     */
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown },
    ): Promise<void> => {
      const sessionId = input.sessionID || "unknown";
      const turnIndex = nextTurnIndex(sessionId);
      const cwd = directoryOf();

      const envelope = {
        harness: "opencode",
        event: "tool_result",
        normalized: {
          tool: input.tool,
          tool_args: input.args ?? {},
          result: output.output,
          cwd,
          session_id: sessionId,
          turn_index: turnIndex,
          timestamp_iso8601: new Date().toISOString(),
        },
      };

      try {
        callBridge(envelope);
      } catch {
        // MEDIUM: observe only — log but do NOT rethrow.
        // A bridge failure on tool_result must not interrupt the agent.
      }
      // output left UNCHANGED (MEDIUM — no mutation)
    },

    /**
     * experimental.chat.system.transform — session_start (MEDIUM observe).
     * Real signature: (input:{sessionID?,model}, output:{system:string[]}).
     * Records session context; does not inject anything.
     */
    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model: unknown },
      _output: { system: string[] },
    ): Promise<void> => {
      const sessionId = input.sessionID || "unknown";
      const cwd = directoryOf();

      const envelope = {
        harness: "opencode",
        event: "session_start",
        normalized: {
          cwd,
          session_id: sessionId,
          harness: "opencode",
          timestamp_iso8601: new Date().toISOString(),
        },
      };

      try {
        callBridge(envelope);
      } catch {
        // MEDIUM: observe only.
      }
      // output.system left unmodified
    },

    /**
     * event — stop (MEDIUM observe).
     * Real signature: (input:{event}). The Event union carries `.type`;
     * session end is "session.idle" with `.properties.sessionID`.
     * No refuse-stop hook exists in OpenCode (stop is MEDIUM by construction).
     */
    event: async (input: { event: { type: string; properties?: { sessionID?: string } } }): Promise<void> => {
      if (!input.event || input.event.type !== "session.idle") return;
      const sessionId = input.event.properties?.sessionID || "unknown";
      const cwd = directoryOf();
      const turnIndex = _turnIndex.get(sessionId) ?? 0;

      const envelope = {
        harness: "opencode",
        event: "stop",
        normalized: {
          cwd,
          session_id: sessionId,
          turn_index: turnIndex,
          is_subagent: false,
          timestamp_iso8601: new Date().toISOString(),
        },
      };

      try {
        callBridge(envelope);
      } catch {
        // MEDIUM: observe only.
      }
    },
  };
};
