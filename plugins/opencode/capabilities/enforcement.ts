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

export const EpisodicEnforcement: Plugin = async (ctx) => ({
  /**
   * tool.execute.before — pre_tool_use (STRONG block).
   * Invokes the bridge; throws on "block" or bridge failure.
   */
  tool: {
    execute: {
      before: async (params: { tool: string; args: Record<string, unknown> }) => {
        const sessionId = ctx.sessionId as string ?? "unknown";
        // EC3: synchronous increment before any await.
        const turnIndex = nextTurnIndex(sessionId);
        const cwd = realpathSync(ctx.directory as string);

        const envelope = {
          harness: "opencode",
          event: "pre_tool_use",
          normalized: {
            tool: params.tool,
            tool_args: params.args,
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
       * Invokes bridge for logging; never throws; never mutates result.
       */
      after: async (params: { tool: string; args: Record<string, unknown>; result: unknown }) => {
        const sessionId = ctx.sessionId as string ?? "unknown";
        const turnIndex = nextTurnIndex(sessionId);
        const cwd = realpathSync(ctx.directory as string);

        const envelope = {
          harness: "opencode",
          event: "tool_result",
          normalized: {
            tool: params.tool,
            tool_args: params.args,
            result: params.result,
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
        // return result UNCHANGED (MEDIUM — no mutation)
      },
    },
  },

  /**
   * experimental.chat.system.transform — session_start (MEDIUM observe).
   * Records session context; does not inject anything.
   */
  experimental: {
    chat: {
      system: {
        transform: async (messages: unknown[]) => {
          const sessionId = ctx.sessionId as string ?? "unknown";
          const cwd = realpathSync(ctx.directory as string);

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
          return messages; // unmodified
        },
      },
    },
  },

  /**
   * event — stop (MEDIUM observe).
   * Records session end; does not refuse.
   */
  event: async (type: string, data: unknown) => {
    if (type !== "session:stop") return;
    const sessionId = ctx.sessionId as string ?? "unknown";
    const cwd = realpathSync(ctx.directory as string);
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
});
