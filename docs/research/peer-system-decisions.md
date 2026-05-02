# Peer-system synthesis decisions

**Date:** 2026-05-01
**Sources:** 5 cached notes (`memory/knowledge_base/`) + 3 WebSearch passes covering 16+ candidates.
**Method:** Problem-fit gate (one question per candidate: "is there an observed bp violation, recurring user friction, or known gap in this repo that this would close?"). No scoring matrix. A-Mem scored last; prestige flag armed (none triggered).
**Token budget:** <30k. Actual: well under.

## Observed problems (input to gate)

From 11 violations + 12 active patterns + this conversation:

1. Workflow discipline under momentum — addressed by Phase 3b checkpoint-gate (shipped #25).
2. Staleness detection — one observed instance: MEMORY.md said "Phase 3b designed" when shipped.
3. No retrieval-quality measure — em-recall has no benchmark.
4. MCP surface gap (open) — see [pending-analysis.md](../rfcs/pending-analysis.md#mcp-surface-vs-file-based-install--convergent-peer-signal-vs-design-differentiator).

## Rejected (no observed problem in this repo)

One-liner each. All survived no further review.

- **secret scrubbing** — never raised in violations or memory. *Caveat:* becomes mandatory if auto-capture / raw transcript / tool-output storage is added (Codex 2026-05-01 review). *Today's action* (Codex follow-up): redact `BODY="$(...)"`-style em-store calls when the body contains literal tool output, unreviewed logs, env dumps, HTTP headers, or stack traces with tokens. Distilled/intentional text is fine.
- **BM25 / vector search** — text matching adequate at current volume.
- **async / background persistence** — index rebuild is fast.
- **vault / consolidation promotion** — bp-003 pattern-promotion already covers project→global lift.
- **structured summary schema** — freeform summary works. *Flip signals* (Codex follow-up): scripts start grep/parsing summaries for status or next-steps; session wrap-up misses because state is buried in prose; retrieval benchmark needs labels not present in metadata. *Cheap instrumentation now:* lint counting episodes with missing useful frontmatter fields or overly long/ambiguous summaries — record cases where an agent had to read full body because summary/frontmatter was insufficient.
- **pitfall / pattern categories** (memento) — `violation` category + bp-009 already structure this.
- **archive / status (vs discard)** — supersedes covers archival.
- **explicit project-binding config** — `--project` flag already exists.
- **workspace config sync** — out of repo scope.
- **watermark handoffs** — out of repo scope.
- **topic-level summarize op** — not requested.
- **graph backends** (Cognee, MemMachine, Graphiti, Zep) — different paradigm; no graph-shaped problem observed.
- **mem0 / generic agent memory** — different domain.
- **tool-specific** (Hindsight, RooCode, REM/Aider) — narrower than this repo's cross-tool target.
- **related_ids / topic links** — lightweight value, no observed need. **Weakest rejection** (Codex follow-up: closest to flipping). *Flip trigger:* one concrete miss where semantically related episodes share no lexical / project / tag overlap. *Order:* retrieval benchmark first; topic links only as a candidate intervention if the benchmark surfaces link-shaped misses, otherwise it's unmeasured schema decoration.
- **A-Mem 5-op tool surface** — current 5 em-* scripts already map to these ops.

## Survivors

### 1. Retrieval-quality benchmark — adopt-now (tracking, deferred implementation)

**Source:** Letta Code (Dec 2025) reports 74.0% on LoCoMo by storing conversation histories in files; the benchmark approach is the takeaway, not Letta itself.
**Observed problem:** em-recall has no measure of retrieval quality. Could be excellent, could be poor — unknown.
**Updated rationale (Codex 2026-05-01 review):** Don't wait passively until Phase 4 — Phase 4 changes retrieval/consolidation, and without a smoke baseline beforehand, regressions land silently. Land a tiny fixed corpus + precision@k smoke baseline *before* Phase 4 touches the recall surface; expand the benchmark after Phase 4 stabilizes.
**Acceptance shape (sketch):**
- Smoke baseline (before Phase 4): ~10-20 synthetic episodes + queries with ground-truth relevance, precision@k for em-recall, "do not regress" CI step.
- Full benchmark (after Phase 4): expanded corpus, recall@k, regression CI gate.
**GH issue:** [#55](https://github.com/lantisprime/episodic-memory/issues/55) — implementation deferred but baseline must land before Phase 4.

### 2. Staleness detection — adopt-later

**Source:** Codex's expanded inventory.
**Observed problem:** MEMORY.md said "Phase 3b designed (23 acceptance tests)" when Phase 3b had merged via PR #25. Caught in this conversation by user, not by the system.
**Why later, not now:** N=1 remains weak. Codex (2026-05-01) noted session_handoff/MEMORY drift is *likely* recurring but stops short of generalizing from one instance.
**Acceptance shape (sketch):** lightweight check that compares MEMORY.md / session_handoff.md status claims against `git log --grep='Phase'` or RFC checklist state; flag mismatches at session start.
**File a GH issue?** Not yet — log one more concrete stale-status incident before issue.

### 3. MCP surface — adopt-now (instrument-first tracking issue), see pending-analysis

**Source:** MemPalace, agentmemory, Supermemory, doobidoo, memento-mcp, memorix all converge on MCP.
**Status:** Real residual gap, not vibes (Codex 2026-05-01 sharpened the framing). Phase 3b's SessionStart only closes start-of-session recall for *Claude-hooked* installs — it does NOT close (i) mid-conversation recall, (ii) Codex/Cursor/Windsurf first-class tool discovery, (iii) cross-tool handoff friction. See [pending-analysis.md](../rfcs/pending-analysis.md#mcp-surface-vs-file-based-install--convergent-peer-signal-vs-design-differentiator) for the full discussion.
**Direction:** Keep full MCP rewrite deferred (high cost, weak observed need at that scale). File instrument-first issue NOW: telemetry on em-recall invocations to detect "would-have-helped" misses, plus thin-MCP-wrapper exploration around existing em-* scripts. Codex's identity take: a thin wrapper preserves the enforcement-loop differentiation; a full rewrite would blur it.
**GH issue:** [#56](https://github.com/lantisprime/episodic-memory/issues/56) — instrument + spike thin wrapper.

## GH issues filed

**Two**, both tracking with deferred implementation (Codex 2026-05-01 outside-objection: "zero GH issues makes adopt-later easy to forget — file lightweight tracking even if implementation deferred"):

1. [#55](https://github.com/lantisprime/episodic-memory/issues/55) — Retrieval-quality smoke baseline before Phase 4 (corpus, precision@k harness, "do not regress" CI step).
2. [#56](https://github.com/lantisprime/episodic-memory/issues/56) — MCP surface instrument-first + thin-wrapper exploration (em-recall invocation telemetry; spike thin stdio MCP wrapper around em-recall/em-store/em-violation; decide after data).

Plus separately filed during this work: [#57](https://github.com/lantisprime/episodic-memory/issues/57) — em-* scripts silently target wrong `.episodic-memory/` from worktree cwd (caught as bp-010 violation mid-synthesis).

## Cheap instrumentations (Codex follow-up, 2026-05-01)

These are pre-emptive observations, not new survivors. Cost is low; they sharpen the rejection list's flip triggers if/when more evidence appears. Not filed as separate GH issues — fold into Phase 4 work or related issues opportunistically.

- **Summary/frontmatter lint** — count episodes with missing useful frontmatter fields or overly long/ambiguous summaries. Record cases where an agent had to read full body because summary/frontmatter was insufficient. Trigger to convert to schema work: counts climb consistently, or retrieval benchmark needs labels.
- **Secret-shape warning in em-store** — lightweight check before storing bodies that match env-var / JWT-API-key / Authorization-header / huge-raw-dump shapes. Stderr warning; not blocking. Trigger to convert to full scrubber: auto-capture / raw transcript / tool-result storage ships.
- **Topic-link miss capture** — when the retrieval benchmark records misses, flag any case where the missed episode has no lexical / project / tag overlap with the query. One such case = flip related_ids / topic links from rejected to defer.

## Bias check

- A-Mem scored last (cached note read after others) — A-Mem did not survive the gate. No prestige flag triggered.
- No candidate's verdict appears prestige-driven. Letta's appeal was the LoCoMo benchmark approach (concrete), not the brand.
- Path-dependency check: none of the rejected items would be materially harder to adopt in 6 months than today; rejection is not premature lock-in.
