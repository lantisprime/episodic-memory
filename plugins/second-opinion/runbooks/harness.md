# Second-opinion harness — operator runbook

The harness exists. Use it. But the harness is invoked via the Bash tool, and the Bash tool has its own gotchas. This file is the single-page operator checklist so I stop burning sessions rediscovering the same lessons.

This file lives at `plugins/second-opinion/runbooks/harness.md` and is shipped via `install.mjs --install-second-opinion` to `~/.claude/hooks/runbooks/second-opinion-harness.md` (deploy name unchanged) — the source the `second-opinion-gate.mjs` PreToolUse hook injects into context on the first harness invocation per session. Mirror of `feedback_second_opinion_harness_runbook.md` in episodic memory.

## ⚠️ Self-trigger checklist — the THREE moments I keep getting wrong

Read this before every harness invocation AND every HOLD reply. These are the recurring violations that cost user time:

| Moment | The habit that fires | The rule | Self-check before emit |
|---|---|---|---|
| **Dispatching the harness** | Reaching for `run_in_background: true` because the harness takes minutes | **Foreground Bash, `timeout: 600000`. NEVER `run_in_background`.** No exceptions for "long-running." | Am I about to set `run_in_background: true`? STOP. Foreground + timeout 600000. |
| **Codex returns HOLD** | Pausing to ask user "want me to fix and re-review, or pause?" — feels deferential, IS the failure mode | **Iterate to round 2 immediately.** User authorized the review = user authorized convergence. | Am I about to write "your call" / "want me to run round 2?" → STOP. Build the rebuttal table, dispatch round 2. The ONE exception: REJECT-class architectural redesign. HOLD with concrete findings = iterate. |
| **Disposing a HOLD finding I disagree with** | Filing it as DEFER-issue unilaterally citing scope/discipline #19 without sending the pushback back to codex | **Round-trip the disagreement.** Discipline #19 applies to contract-cross-reference oscillation ONLY, NOT to concrete code findings. If codex recommended a specific code change, you owe codex the Verdict/Evidence/Required-action rebuttal — not a unilateral DEFER. | Is this finding a concrete code recommendation? Then DEFER without round-trip is a violation. Send it back via round-2 body. |

**Self-test:** Before sending a HOLD reply to the user, re-read the table. If any column 2 description matches what I'm about to do, STOP and apply column 4 instead.

## The canonical invocation (memorize the shape)

```bash
node scripts/second-opinion.mjs request \
  --provider codex \
  --project /Users/charltondho/Developer/projects/episodic-memory \
  --storage episodic \
  --body-file scratch/<review-body>.md \
  --summary "<short summary>" \
  --dispatch
```

Bash tool call MUST include `timeout: 600000` (10 minutes).

**Defaults I get wrong:**

- `--project .` works but absolute path is what every past successful session used. Use the absolute path.
- `--storage` defaults to `episodic`, which is what you want for cross-tool message-bus dogfooding. Don't pass `--storage files` unless you have a specific reason.
- Bash tool default timeout is 120000ms (2 min). Codex review of a 5K+ char prompt routinely takes 3–8 min. **The 2-min default SIGTERMs codex silently.**

## Failure mode → diagnosis cheat sheet

| Symptom | Likely cause | Verify |
|---|---|---|
| `em-store failed (exit 1):` with empty stderr | Bash timeout SIGTERM'd codex → empty stdout → em-store rejected `--body ""` | Check past-session transcript for working invocation; compare timeouts |
| Harness exits but no reply episode | Reply episode write failed AFTER dispatch (rare; usually still the timeout class) | Re-check Bash `timeout` and codex CLI auth |
| `provider-dispatch-failed` | Codex CLI binary not on PATH / auth issue | `which codex` then `codex exec --help` |
| `registry-stale-at-gate` | Source registry diverged from installed snapshot | `node install.mjs --tool claude-code --install-second-opinion` |
| `runbook-injection-required` | First harness call this session — runbook gate; runbook is now in context | Retry the command; marker auto-binds to current sha |
| `runbook-load-failed` | Runbook missing/empty/missing-sentinel at install path | Re-run `node install.mjs --tool claude-code --install-second-opinion` |

## HOLD is not the end of the review

When codex returns `Verdict: HOLD`, that is NOT the close-out. Per `feedback_three_state_review_verdict.md`: HOLD's closeout phrasing is mandatory — "revise + re-request review on findings 1-N plus any new integration surface introduced by the fixes." That re-review is round 2 of the same logical review cycle, not a fresh review.

**Rule of thumb:**

- ACCEPT → done.
- ACCEPT-with-FU → done; file the FUs as issues.
- HOLD → fix the findings, run round 2 with the fix referenced, expect ACCEPT.
- REJECT → architectural redesign needed; pause and consult user.

If round 2 returns HOLD again with NEW findings, that's when the cap engages.

## Round 2 (post-HOLD) request body — template

```markdown
# PR #X — Round 2 (post-HOLD fix)

## Round 1 verdict
Episode `<r1-reply-id>` — HOLD with N finding(s).

## Round 1 findings + my disposition
**Finding:** <quote>
**Verdict:** ACCEPT / ACCEPT-WITH-MODIFICATION / REJECT / DEFER / NEEDS-EVIDENCE
**Evidence:** <artifact>
**Required action:** <concrete>
**Confidence:** HIGH / MED / LOW

## Fix landed
Commit `<sha>` on branch `<name>`, pushed to origin.

## Second-order review per discipline #17
[Table: what the fix introduced, scope/persistence/rollback/negative-test for each new surface.]

## Convergence request
Please re-review and emit closeout verdict.
```

## Trigger phrases I keep missing

When the prompt mentions any of:

- "second opinion"
- "codex review"
- "cross-tool review"
- "review the plan / diff / PR"
- Rule 6 light path on a feature plan
- Rule 18 step 2 (mandatory plan review) or step 6 (mandatory code review)
- The user says "request a codex review" or "ask codex" or "run a second opinion"

→ Use this harness. Bash `timeout: 600000`. After HOLD, run round 2 to converge.

## Anti-patterns this memory exists to prevent

- ❌ Invoking the harness via Bash without `timeout: 600000`.
- ❌ Debugging em-store / provider source / preamble composer before checking past-session transcripts.
- ❌ "Let me dispatch codex directly via the provider module" when the harness fails. The harness IS the canonical path. Diagnose it; don't bypass it.
- ❌ Treating HOLD as the close-out because of the "cap at 1 round" pin.
- ❌ Asking the user "want me to run round 2?" — iterate without between-round confirmation; the user authorized the review.

## Composes with

- `reference_second_opinion_harness.md` — design reference (what the harness IS).
- `reference_codex_review_flow.md` — manual 5-step fallback.
- `feedback_three_state_review_verdict.md` — HOLD/ACCEPT/REJECT discipline #16.
- `feedback_reach_consensus_with_codex.md` — iterate without pausing.
- `feedback_implementer_second_order_review.md` — discipline #17 (run on the fix surface in round 2).
- `feedback_verify_by_artifact.md` — when in doubt, the artifact is past-session transcripts at `~/.claude/projects/<project-path>/*.jsonl`.
- `feedback_codex_review_episodes_both_halves.md` — both request and reply MUST be em-store episodes; harness's `--storage episodic` handles this.
