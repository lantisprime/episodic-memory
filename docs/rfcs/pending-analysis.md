# Pending analysis

Raw input for future RFCs. Each entry is a problem + evidence + candidate directions, not a spec. Promote to a numbered RFC when ready.

---

## MCP surface vs file-based install — convergent peer signal vs design differentiator

**Status:** seed for potential RFC (numbered after RFC-003, which is now accepted)
**Date:** 2026-05-01
**Triggering question:** Peer-system research synthesis (knowledge_base/) found all major neighbors expose memory via MCP server. This repo exposes via instruction files. Is this a gap to close, or the differentiator?

### Evidence — peer-system convergence on MCP

| System | Surface | Cross-tool reach |
|---|---|---|
| MemPalace (Apr 2026, 43k★ in 1 week) | MCP server | Claude Code, Codex CLI, Cursor, Claude Desktop |
| agentmemory (Cognition) | Zero-config npm → MCP | Claude Code, Cursor, Gemini CLI, OpenCode |
| Supermemory | MCP server + plugins | Claude Code, OpenCode (purpose-built for coding agents) |
| doobidoo/mcp-memory-service | REST API + MCP + autonomous consolidation | Claude + LangGraph/CrewAI/AutoGen |
| memento-mcp (cached) | MCP server, SQLite + FTS5 | MCP-compatible clients |
| memorix (cached) | MCP server, SQLite + Orama | Broadest cross-tool target list |
| **This repo** | **Shell scripts + per-tool instruction files** | Claude Code, Cursor, Codex, Windsurf via SKILL.md / cursor.mdc / AGENTS.md / windsurf.md |

### Framing — gap is real, but only for the residual surface

**(a) Real gap.** Instruction files don't surface memory as a live tool the agent discovers automatically. Phase 3b's SessionStart hook closes *only one* sub-gap: start-of-session recall for Claude Code installs that opted into hooks. It does not close:
1. **Mid-conversation recall.** Once the session is running, the agent has to remember to invoke shell scripts. No first-class `recall(query)` available mid-flow.
2. **Codex / Cursor / Windsurf tool discovery.** SessionStart hook is Claude-Code-specific. Agents on other tools have no auto-recall surface — only instruction-file prompting, which depends on the agent reading and acting on it.
3. **Cross-tool handoff friction.** Memory passed between tools requires manual install + instruction files per tool; an MCP server registered once would be tool-discoverable.

(Codex 2026-05-01 sharpened this framing — the original draft presented two symmetric framings, which under-stated the gap.)

**(b) Intentional differentiation — partial.** "Tool-agnostic, zero deps, Node.js stdlib only" (CLAUDE.md project conventions) is real and worth preserving. The differentiator is **the enforcement loop** (bp violations, checkpoint gates, local flat-file auditability), not file-based-vs-MCP per se. A *thin* MCP wrapper around existing em-* scripts preserves zero-deps in the storage layer and preserves the enforcement loop; a *full* MCP rewrite (new server, new storage, new install path) would blur identity.

### Pattern

All five cached peer systems and all four newly-surfaced ones converge on MCP. The lone holdouts are file-based systems (AGENTS.md / CLAUDE.md / Hermes) — and even those have open feature requests to expose them via MCP (`hermes-agent#10835`).

### Open questions before RFC

1. **Observed friction.** Are there instances of "agent forgot to recall" or "agent couldn't recall mid-conversation" in this repo's violation log? Current scan: 11 violations, all bp-001/bp-012 workflow-discipline. No retrieval-surface friction observed.
2. **Phase 3b coverage.** SessionStart hook auto-invokes em-recall and writes `.checkpoint-required` on bp-001 hits. Does this already close gap-(a)? Mid-conversation recall (vs session-start recall) is the residual.
3. **Cost of MCP adoption.** Adding an MCP server breaks "zero deps." Does adoption come bundled with the @modelcontextprotocol/sdk dependency, or is a thin stdio wrapper feasible in stdlib only?
4. **Coexistence.** Can MCP and file-based scripts ship side-by-side without dual-sourcing the storage layer? (Likely yes if MCP is a thin tool wrapper around existing em-* scripts.)
5. **Identity / positioning.** If we add MCP, does this repo become "another mcp-memory-service" with weak differentiation? Or does the bp-001/bp-012 enforcement-loop angle remain unique regardless of surface?

### Candidate directions

1. **Reject.** Stay file-based. Add positioning to README: "zero-infra cross-tool memory — no server, no daemon." Differentiation by absence.
2. **Thin MCP wrapper.** Wrap existing em-* scripts as MCP tools (`recall`, `store`, `violation`) without changing storage. <500 LOC, optional `--install-mcp` flag like `--install-hooks`. Coexists with shell access.
3. **Full MCP rewrite.** New RFC. New server. New install path. High cost, weak observed need.
4. **Defer + instrument.** Add em-recall invocation telemetry to detect "would-have-helped" misses (e.g., violations stored within N turns of an em-recall that should have surfaced the relevant pattern). Decide after data.

### Recommendation

**Adopt levers 2 + 4 as a single tracking issue, now.** File a GH issue covering: (i) em-recall invocation telemetry to detect "would-have-helped" misses; (ii) spike a thin stdio MCP wrapper around existing em-recall / em-store / em-violation scripts (no new storage, no new dependency in storage layer; MCP SDK lives only in the optional wrapper). Defer the **decision** on full adoption pending instrumentation data, but don't defer the issue itself — Codex's outside objection is that adopt-later items without tracking get forgotten.

Reject lever 3 (full MCP rewrite) — high cost, weak observed need at that scale, blurs identity.

Reject lever 1 (stay file-based, position by absence) — peer convergence is too strong to dismiss; the residual gaps (mid-conversation recall, cross-tool tool discovery, cross-tool handoff) are real for any user not on Claude Code with hooks installed.

Promote to numbered RFC if telemetry shows ≥3 "would-have-helped" misses across two sessions OR if a user-experienced friction is reported on Codex/Cursor/Windsurf.
