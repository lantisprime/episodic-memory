# Violation ↔ RFC ↔ Fix correlation — session 2026-05-02

**Status:** snapshot
**Date:** 2026-05-02
**Scope:** all bp-001 violations logged in this session, the PRs they drove, and the open residuals.

## Summary

Eleven bp-001 violations across the day. Six logged in detail (see table). The session shipped both PR #84 (bp-001 checkpoint-gate activation) and PR #87 (plan-gate canonicalization for #86) — both fixes exist *because* documentation alone fails. PR #87 itself was shipped while violating Rule 8.

Documentation-tier enforcement of bp-001 fails 100% under momentum, even with same-session violation episodes loaded. Hooks close shapes only when armed and only for the armed transition; once a one-shot gate clears, the rest of the session runs unguarded.

## Session-level violation log

| Episode ID | Shape | Driving fix |
|---|---|---|
| `...387e` | Mid-flight Commit 1 scope expansion without re-approval | None — filed as #99 |
| `...ec9e` | Pushed PR #78 without post-impl block; skipped step 9 | PR #78; #80 H1 push-gate validator |
| `...f7f5` | Session-lessons episode (codified the "cite an artifact" self-check) | Documentation tier (proven weak) |
| `...7000` | Skipped step 6 subagent code review on commit 3df072c | None — filed as #100 |
| `...6a15` | Chained commit+push on 1e03dc3 without post-impl block | #80 H1 push-gate validator |
| `...a1e0` | Followed substantive bp-001 steps but skipped Rule 8 plan-gate marker | PR #87 (canonicalize) + #86 PR-B (strict Bash allowlist) |

## PR ↔ violation shape closure map

| PR | Mechanism shipped | Violation shape addressed | Closes shape? |
|---|---|---|---|
| #78 (installer deploy) | `--install-hooks`, atomic settings.json, format migration, shellQuote, bp-001 enforcement table | Deploy gap (hooks not on disk) | Yes for deploy gap; **no** for runtime violations |
| #82 (CLAUDE.md doctrine) | `docs/rfcs/` paths, no-mental-tracing convention | Documentation drift | Documentation tier — empirically weak |
| #84 (bp-001 activation) | `shouldArmBp001Checkpoint` + `armCheckpointMarker`; SessionStart arming without `--task-type` | Inert-gate gap (arming never fired in real sessions) | Yes for **first** task transition; one-shot per session; **no** for subsequent transitions |
| #87 (plan-gate canonicalize) | NotebookRead/ToolSearch allowlist, canonical form | Tool-name allowlist gap | Yes for missing-tool-name path; **no** for `...a1e0` shape (marker write was a *procedural step*, not arming) |

## Residuals → open issues

| Residual shape | Issue | Status |
|---|---|---|
| Marker-write-as-procedural-step (the `...a1e0` pathology) in plan-gate | #86 PR-B | Open — strict Bash command allowlist not yet shipped |
| Same pathology in checkpoint-gate, plus read-only Bash false-positive | #89 | Open — filed this session after 3+ empirical hits (`ls`, `grep`, marker write) |
| Plan-gate BashOutput / KillBash allowlist evaluation | #88 | Open — follow-up from PR #87 |
| Push without post-impl block (`...ec9e`, `...6a15` shape) | #80 Phase 3b-H1 | Open — validator-backed gate to replace non-empty-marker semantics with workflow-lifecycle episodes |
| Mid-flight scope expansion (`...387e`) | #99 | Open — filed during this analysis |
| Skipped step 6 subagent review (`...7000`) | #100 | Open — filed during this analysis |

## Correlation pattern

1. **Documentation-tier enforcement fails 100%.** Every violation occurred *with the relevant memory file loaded* (MEMORY.md, feedback_no_chained_commit_push.md, bp-001 right-size). The chained-commit-push shape recurred twice in the same session despite a memory file explicitly named for it.
2. **Hooks close shapes only when armed and only for the armed transition.** Phase 3b ships a one-shot gate per session — first write or first push. After clearance, the rest of the session is unguarded. PR #84 fixed activation (the gate fires); it did not fix recurrence.
3. **Fixes generate fresh violations.** PR #87 (plan-gate canonicalization for #86) was shipped while violating Rule 8 (`...a1e0`): the marker-arming step was treated as a procedural item, not as the gate it actually is.
4. **Two unfiled residuals (`...387e`, `...7000`)** had no enforcement mechanism, no open issue, and no acknowledgment beyond the violation episode at the time of analysis. Filed as #99 and #100.

## Coverage gap (shapes vs hooks)

```
Plan → approval → arm marker   →  plan-gate.sh         [shipping; #88, #86 PR-B open]
Pre-checkpoint write            →  checkpoint-gate.sh  [shipping; #89 open]
Post-checkpoint push            →  checkpoint-gate.sh  [shipping; #80 H1 open]
Mid-flight scope re-gate        →  NO HOOK             [#99 — this analysis]
Step 6 subagent review          →  NO HOOK             [#100 — this analysis]
Step 9 issue log                →  partial             [#80 H1 may cover]
```

## Recommendation

Prioritize #86 PR-B above #80 H1. PR-B closes the most empirically frequent shape (`...a1e0` recurred on the very PRs that were fixing the gate it bypasses). #80 H1 is the larger architectural change and depends on validator infrastructure; it is the right long-term direction but more expensive.

#99 and #100 should fold into #80 H1's design rather than ship as standalone gates — they are manifestations of the same "non-empty marker is too coarse" pathology that H1 already targets.

## RFC mapping

- **RFC-002 Phase 3b** (Checkpoint Enforcement Gate): mechanism merged; covers narrow case only. Population-level bp-001 violation rate unchanged across 5 sessions.
- **RFC-002 Phase 3b-H1** (#80): the validator-backed successor that subsumes #99 and #100.
- **RFC-003** (Pluggable Tool Adapters): generalizes Phase 3b's Claude-only primitive across tools. Phase 1 implementation not started; out of scope for this analysis.

## Receipts

- Violation episodes are in `.episodic-memory/episodes/` (main local store; 4 episodes were migrated from worktrees during this analysis — main count 159 → 163).
- Issues #99 and #100 created during this analysis: <https://github.com/lantisprime/episodic-memory/issues/99>, <https://github.com/lantisprime/episodic-memory/issues/100>.
- MEMORY.md still cites this analysis at a now-correct path (`docs/analysis/2026-05-02-violation-correlation-analysis.md`); previously the citation pointed at a non-existent file.
