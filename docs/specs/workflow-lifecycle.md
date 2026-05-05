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
| `review-request` | Bot/Codex review request with full lifecycle ref bundle (#118 PR-D) |
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
  "pre_checkpoint_ref": "episode:<pre-checkpoint episode id>",
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

`pre_checkpoint_ref` is **required** (schema_version 1). It binds the
post-checkpoint back to the pre-checkpoint that authorized the work; without
it an attacker could splice a same-task post-checkpoint from an unrelated
attempt onto the chain.

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

### `review-request`

The wrapper for filing a Codex/bot review request. Built and stored by [`scripts/em-review-request.mjs`](../../scripts/em-review-request.mjs) (#118 PR-D).

```json
{
  "plan_ref": "<file path or episode:<id> of the plan>",
  "approval_ref": "episode:<plan-approved episode id>",
  "pre_checkpoint_ref": "episode:<pre-checkpoint episode id>",
  "post_checkpoint_ref": "episode:<post-checkpoint episode id>",
  "evidence": {
    "tests_ref": "<episode:<id> or file:<path>>",
    "code_review_ref": "episode:<subagent review id>",
    "command_inventory_ref": "<optional; required when classifier/gate code touched>",
    "bug_logging": {
      "status": "done",
      "issues": ["https://github.com/owner/repo/issues/123"]
    },
    "verifications": [
      { "kind": "evidence", "claim": "X", "path": "scripts/foo.mjs:42", "excerpt": "..." }
    ]
  },
  "triggered_by": "episode:<id of the feedback episode that triggered this review-request>"
}
```

`bug_logging.status` accepts:
- `"done"` with `issues[]` array — empty array means "checked, no bugs"; non-empty entries MUST match the GitHub issue ref shape (URL or `gh:owner/repo#N`).
- `"no-new-bugs"` (no `issues[]` required) — the `em-review-request` wrapper's `--no-new-bugs` flag emits this; an explicit alternate to `status="done"` with empty `issues[]`. Both forms are accepted by the validator.

This mirrors `post-checkpoint.evidence.bug_logging` (#118 review M2 alignment): post-checkpoint already accepted empty `issues[]` with `status="done"`, so review-request follows suit.

All four chain refs (`approval_ref`, `pre_checkpoint_ref`, `post_checkpoint_ref`,
plus `evidence.tests_ref` and `evidence.code_review_ref` when episode-shaped) are
resolved via the same exact-id semantics described in [Episode reference
resolution](#episode-reference-resolution-rfc-002327). The chain refs additionally
require `category === "workflow.lifecycle"`.

`post_checkpoint_ref` provides splice-resistance: it binds review-request back
to the post-checkpoint that authorized the review. Same rule as
`push-allowed.post_checkpoint_ref`; if `--head` is passed, the referenced
post-checkpoint's `context.head` MUST equal `--head` exactly (defeats stale-
evidence forgery).

#### `triggered_by` (top-level, optional)

Causal-upstream pointer: identifies the episode that *triggered* this review
request (e.g. a Codex feedback lesson, a post-merge lesson, a violation).
Lives **top-level on the payload, not under `evidence`** — provenance is not
verification (RFC-003 OQ-7).

`triggered_by` MUST be an episode reference (`episode:<id>`) when set.
Freeform strings are rejected — em-store the source as an episode first
(any category), then pass `episode:<id>` (#118 review n1 tightening).

When `triggered_by` is set:

- Resolved via the standard semantics (id exists, active, not self, temporally
  ordered).
- **Task-binding:** if the resolved episode has a `task` field in its body's
  JSON payload, that task MUST equal the citing review-request's task. This
  rejects cross-task pollution.
- `task: null` and `task: undefined` (no task field) are both treated as
  **provenance-only** — no task assertion.

A future follow-up issue ([#147](https://github.com/lantisprime/episodic-memory/issues/147))
will add temporal-ordering rules (require `plan_ref.timestamp >
triggered_by.timestamp` for Codex/post-merge feedback). The field is
forward-compatible.

#### `evidence.verifications[]` (optional, schema v1)

Per-claim verification array. Each item:

```json
{
  "kind": "evidence",
  "claim": "string — what the review asserts",
  "path": "<file:line or command>",
  "excerpt": "<file excerpt — required when kind=evidence and path is a file>",
  "output": "<command stdout — required when kind=evidence and path is a command>"
}
```

`kind` defaults to `"evidence"`. When `kind === "evidence"`, **at least one of
`excerpt` or `output`** must be non-empty (non-placeholder). `kind ===
"narrative"` is the explicit opt-in to unfalsifiable form — it accepts any
shape (including empty), but is grep-able as an anti-pattern. Permissive
acceptance of empty narrative is intentional: choosing `kind: "narrative"`
itself is the loud signal; what's inside doesn't matter.

The `kind` whitelist is `["evidence", "narrative"]` enforced under **schema
v1** (validator error string includes `(schema v1)`). Future extensions
(e.g. `"weak-evidence"`, `"claim"`) will surface as a discoverable schema bump,
not a silent reject. Migrating to a new whitelist requires a coordinated
schema-version flip.

`null` and missing `verifications` are both treated as "not provided"; an
empty array `[]` is "checked, no claims" (distinct).

## Per-gate head & branch rules

The validator enforces context (`worktree`, `branch`, `head`) consistency
across the chain. Rules differ for terminal vs non-terminal links:

- **Worktree** equality enforced on every chain link (compared via realpath).
- **Branch** equality enforced on every chain link AND against `--branch`
  (when passed). Branch-switch mid-chain is rejected — it's the primary
  forgery vector.
- **Head**:
  - Terminal link (the gated event itself): `ctx.head === --head` exact.
    Rationale: the terminal episode asserts the chain is current.
  - Non-terminal links: `ctx.head` may be older than `--head`, but when git
    is available it must be an ancestor of `--head` (`git merge-base
    --is-ancestor`). When git is available but the recorded `ctx.head` is
    not a known commit (status 128), the link is rejected — referencing a
    fictional commit is a chain failure. When git is unavailable (no repo),
    the ancestor check is skipped silently so the validator remains usable
    outside a repo.

Special case for `push-allowed` AND `review-request` gates: the referenced
`post-checkpoint` episode's `context.head` MUST also equal `--head` exactly.
Ancestor-only would be too weak — it would allow new commits between the
post-checkpoint evidence and the gate clearing, defeating the purpose. Re-run
the post-checkpoint at current HEAD if commits have landed. To make this
check meaningful, **`--head` is required when `--gate push-allowed` or
`--gate review-request`** — the validator exits with a usage error if it is
omitted.

### Multi-`review-request` per task (pre-#102 chain-walk fallback)

When multiple `review-request` episodes exist for the same task (e.g. user
re-runs `em-review-request` after fixing a missed ref), the validator picks
the **latest by timestamp** as the terminal review-request. Older
review-request episodes are surfaced as warnings (not errors); any errors
keyed to non-terminal review-request ids are downgraded to warnings.

This is a pragmatic pre-#102 (chain-walk) fallback. The canonical multi-
attempt path is `em-revise --original <id>` to make the supersedes chain
explicit. After [#102](https://github.com/lantisprime/episodic-memory/issues/102)
lands, chain-walk anchors at the terminal explicitly; this rule will tighten.

### Wrapper-validator scope-parity contract

The `em-review-request` wrapper duplicates `resolveEpisodeRef` + the
placeholder/self-witness/timestamp/category checks inline (see
[scripts/em-review-request.mjs](../../scripts/em-review-request.mjs)
"Duplicated resolver" section). Behavior is pinned BYTE-EQUAL via a drift
test in `tests/test-workflow-validate.mjs`.

**Contract for the lifted resolver** (when [#150](https://github.com/lantisprime/episodic-memory/issues/150) lifts to
`scripts/lib/resolve-episode-ref.mjs`):

- Index loaded from BOTH local AND global scopes regardless of caller's `--scope` flag.
- Local entries take priority on id collisions (local wins).
- Same `PLACEHOLDER_VALUES`, `REF_PREFIXES`, `SELF_REFS` sets.
- Same temporal ordering check (refTime <= curTime).
- Same `expectedCategory` opt-in.

#119 (checkpoint-gate v2) inherits this contract and must not regress it.

## Schema versioning

Payloads do not carry an explicit `schema_version` field today. The shape
defined by this document is informally **schema v1**; validator-backed gates
(PR-D Plan Gate v2, PR-E checkpoint-gate) accept only this shape. Pre-PR-C
lifecycle episodes (if any) without `pre_checkpoint_ref` on `post-checkpoint`
will not satisfy the gates; since PR-C is not yet hook-wired, no migration is
required — chains are authored fresh under the new shape. Older non-lifecycle
episodes are unaffected.

A future PR may add a literal `schema_version` field (and start rejecting
payloads with unknown versions) once we have a second shape to switch on.

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
`evidence.e2e.log_ref`, `push-allowed.post_checkpoint_ref`,
`review-request.{approval_ref, pre_checkpoint_ref, post_checkpoint_ref,
plan_ref}`, `review-request.evidence.{tests_ref, code_review_ref,
command_inventory_ref}`, `review-request.triggered_by` (top-level).

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
| `review-request` | `plan-approved`, `pre-checkpoint`, `post-checkpoint`, `review-request` |
| `push-allowed` | `plan-approved`, `pre-checkpoint`, `post-checkpoint`, `push-allowed` |

`classified`, `review-done`, and `scope-change` are not required for any gate by default. Future PRs (Plan Gate v2 / Phase 3b-H2) may tighten this.

`review-request` is **NOT** a predecessor of `push-allowed`. Hook-side
enforcement of the review-request gate before push lives in
[#119](https://github.com/lantisprime/episodic-memory/issues/119) (PR-E
checkpoint-gate v2), which will add it as a predecessor in its own PR with
the necessary test updates.

### Known non-coverage (shape-4 caveat)

Wrap-up summarize-as-done transitions ("ready for next task" / "all layers
green") happen with no tool call — they are invisible to PreToolUse hooks.
The push-gate cannot see them. A "task-complete" tool primitive would close
this hole but belongs to a separate harness-discipline issue. #118 closes
the artifact-shaped half of bp-001 violations (shapes 1, 3, 5, 6); shape-4
remains harness-discipline territory.

## Out of scope (this PR)

- Hook integration (`checkpoint-gate.sh` still uses marker semantics — see PR-E).
- Adapter cache layer (`.claude/em-gates/*` referencing episode IDs — see PR-D/PR-E).
- Step-instrumentation skills/wrappers that emit lifecycle episodes as Rule 18 side effects.
- Plan-content hashing for stronger task-identity binding (proposed hardening, not in RFC).
