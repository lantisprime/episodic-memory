# workflow.lifecycle Episode Schema

**Status:** draft (RFC-002 Phase 3b-H1 PR-C)
**Source of truth:** [RFC-002:259-327](../rfcs/RFC-002-learning-loop.md)
**Validator:** [`scripts/em-workflow-validate.mjs`](../../scripts/em-workflow-validate.mjs)

## Purpose

Replace non-empty marker semantics (`[ -s "$MARKER" ]`) in checkpoint-gate.sh
with append-only workflow lifecycle episodes. Each Rule 18 transition is
recorded as a `workflow.lifecycle` episode whose payload references prior
artifacts (plans, approvals, reviews, tests, issues). The validator parses the
chain and answers: "may this gate clear?"

## Storage

- Episode category: `workflow.lifecycle`
- Stored via `em-store.mjs --category workflow.lifecycle ...`
- Episode body MUST contain exactly one ` ```json ` fenced code block; that
  block is the lifecycle payload. Anything else in the body is informational.

## Events (RFC-002:262)

Ordered chain. Each event is one episode.

| Event | When |
|---|---|
| `classified` | Task classification done (light vs full, scope sketched) |
| `plan-approved` | User approved the implementation plan |
| `pre-checkpoint` | Pre-implementation checkpoint armed (was: `.pre-checkpoint-done` marker) |
| `review-done` | Second-opinion or code-review complete with reply reference |
| `post-checkpoint` | Post-implementation checkpoint with full evidence (was: `.post-checkpoint-done` marker) |
| `scope-change` | Approved scope expansion (Phase 3b-H2) |
| `push-allowed` | Push/PR-create cleared by validator |

## Required fields (all events)

```json
{
  "event": "<one of the events above>",
  "pattern_id": "bp-001-implementation-workflow",
  "task": "<stable task identifier — used to chain episodes>",
  "context": {
    "worktree": "<absolute path>",
    "branch": "<git branch>",
    "head": "<git sha at time of episode>"
  }
}
```

`task` is the chaining key. Pick a concise stable string (e.g. `"PR-C: workflow validator"`) and reuse it across every event for the same Rule 18 cycle.

## Per-event additions

### `plan-approved`

```json
{
  "plan_ref": "<file path or doc URL of the plan>",
  "classification": "light|full"
}
```

`plan-approved` is itself the approval record. `pre-checkpoint` references this episode's id via `approval_ref`. `episode:self` is rejected as a placeholder — references must point to real distinct artifacts.

### `pre-checkpoint`

```json
{
  "plan_ref": "<file path or doc URL>",
  "approval_ref": "episode:<plan-approved episode id>",
  "second_opinion": {
    "status": "skipped|pending|done",
    "recipient": "codex|subagent|...",
    "reply_ref": "episode:<id>"
  }
}
```

`second_opinion.reply_ref` is **required** when `status === "done"`. If skipped, omit the object or set status accordingly.

`approval_ref` MUST resolve to a `plan-approved` episode for the same `task`. The validator rejects orphaned references.

### `review-done`

```json
{
  "reply_ref": "episode:<review episode id>",
  "evidence_ref": "<file path or other concrete reference>"
}
```

At least one of `reply_ref` or `evidence_ref` is required (external witness).

### `post-checkpoint`

```json
{
  "evidence": {
    "tests": [
      { "command": "node tests/test-x.mjs", "status": "passed", "log_ref": "episode:<id>" }
    ],
    "code_review": {
      "status": "done",
      "reply_ref": "episode:<subagent review id>"
    },
    "e2e": {
      "status": "passed",
      "log_ref": "episode:<id>"
    },
    "bug_logging": {
      "status": "done",
      "issues": ["<issue url or number>", "..."]
    }
  }
}
```

- `evidence.tests` MUST be a non-empty array.
- `code_review.reply_ref` required when `status === "done"`.
- `e2e.log_ref` required when `status === "passed"`.
- `bug_logging.issues` MUST be an array when `status === "done"` (empty array means "checked, no bugs").
- `bug_logging.issues[]` element shape: each non-empty entry MUST be either a
  GitHub issue URL `https://github.com/<owner>/<repo>/issues/<n>` or the
  short form `gh:<owner>/<repo>#<n>`. Free-form strings are rejected. Live
  existence of the issue is **not** checked by this validator (deferred).

### `push-allowed`

```json
{
  "post_checkpoint_ref": "episode:<post-checkpoint episode id>"
}
```

Validator rejects `push-allowed` whose `post_checkpoint_ref` does not resolve to a `post-checkpoint` episode for the same task.

## Episode reference resolution (RFC-002:327)

Every value of shape `episode:<id>` in any of the fields below must resolve
against the local + global episode index (regardless of `--scope`). The
validator rejects:

- references to non-existent ids
- references to superseded or non-active episodes
- self-witness (a ref pointing to its own episode id)
- references whose timestamp is **after** the citing episode (chain links must
  be temporally ordered)
- chain-link refs (`approval_ref`, `post_checkpoint_ref`) whose target
  category is not `workflow.lifecycle`

Fields resolved: `pre-checkpoint.approval_ref`, `pre-checkpoint.plan_ref`
(when episode-shaped), `pre-checkpoint.second_opinion.reply_ref`,
`review-done.reply_ref`, `review-done.evidence_ref`,
`evidence.tests[].log_ref`, `evidence.code_review.reply_ref`,
`evidence.e2e.log_ref`, `push-allowed.post_checkpoint_ref`.

Non-episode-shaped values (file paths, URLs, GitHub issue refs) pass through
unchanged.

## Placeholder rejection (RFC-002:327)

Any required string field whose value is one of:

- empty string, `"TBD"`, `"TODO"`, `"placeholder"`, `"..."`, `"xxx"`, `"n/a"`, `"na"`
- a bare ref prefix with no payload (e.g. `"episode:"`)

is rejected with an error. References must carry an actual id/path/URL.

## Validator usage

```bash
node scripts/em-workflow-validate.mjs \
  --task "PR-C: workflow validator" \
  --gate pre-checkpoint \
  --branch claude/keen-euler-b48a7b \
  --head $(git rev-parse HEAD)
```

Exit codes:
- `0` — gate passes
- `1` — gate fails (missing events, schema errors, broken chain)
- `2` — usage error

Output (always JSON to stdout):

```json
{
  "status": "ok",
  "valid": true,
  "gate": "pre-checkpoint",
  "task": "PR-C: workflow validator",
  "pattern_id": "bp-001-implementation-workflow",
  "required": ["plan-approved", "pre-checkpoint"],
  "missing": [],
  "errors": [],
  "warnings": [],
  "episodes": [{ "id": "...", "event": "plan-approved", "date": "2026-05-02", "time": "17:30", "branch": "...", "head": "..." }]
}
```

## Gate requirements

| Gate | Required events |
|---|---|
| `pre-checkpoint` | `plan-approved`, `pre-checkpoint` |
| `post-checkpoint` | `plan-approved`, `pre-checkpoint`, `post-checkpoint` |
| `push-allowed` | `plan-approved`, `pre-checkpoint`, `post-checkpoint`, `push-allowed` |

`classified`, `review-done`, and `scope-change` are not required for any gate by default. Future PRs (Plan Gate v2 / Phase 3b-H2) may tighten this.

## Out of scope (this PR)

- Hook integration (`checkpoint-gate.sh` still uses marker semantics — see PR-E).
- Adapter cache layer (`.claude/em-gates/*` referencing episode IDs — see PR-D/PR-E).
- Step-instrumentation skills/wrappers that emit lifecycle episodes as Rule 18 side effects.
- Plan-content hashing for stronger task-identity binding (proposed hardening, not in RFC).
