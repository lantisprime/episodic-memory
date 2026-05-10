# Episodic Memory — User Manual

A persistent memory system for AI coding assistants. It remembers your decisions, discoveries, and context across sessions so you don't have to repeat yourself.

**You don't run any scripts.** Your AI assistant handles everything automatically. This manual shows what that looks like in practice.

## Table of Contents

- [Getting Started](#getting-started)
- [Scenario 1: Starting a New Session](#scenario-1-starting-a-new-session)
- [Scenario 2: Making a Decision](#scenario-2-making-a-decision)
- [Scenario 3: Discovering Something Important](#scenario-3-discovering-something-important)
- [Scenario 4: Correcting a Bad Decision](#scenario-4-correcting-a-bad-decision)
- [Scenario 5: Asking About Past Decisions](#scenario-5-asking-about-past-decisions)
- [Scenario 6: Reaching a Milestone](#scenario-6-reaching-a-milestone)
- [Scenario 7: Recording Project Context](#scenario-7-recording-project-context)
- [Scenario 8: Switching Between Tools](#scenario-8-switching-between-tools)
- [Scenario 9: Explicitly Asking to Remember](#scenario-9-explicitly-asking-to-remember)
- [Scenario 10: Preventing Repeated Mistakes](#scenario-10-preventing-repeated-mistakes)
- [Scenario 11: Tracking Rule Violations](#scenario-11-tracking-rule-violations)
- [Scenario 12: The Checkpoint Gate Stopped the AI](#scenario-12-the-checkpoint-gate-stopped-the-ai)
- [What Gets Stored and What Doesn't](#what-gets-stored-and-what-doesnt)
- [Browsing Your Memories](#browsing-your-memories)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### Install once per project

```bash
# For Cursor
node ~/episodic-memory/install.mjs --tool cursor --project /path/to/my-project

# For Claude Code
node ~/episodic-memory/install.mjs --tool claude-code --project /path/to/my-project

# For Claude Code with checkpoint enforcement hooks (opt-in, recommended)
node ~/episodic-memory/install.mjs --tool claude-code --install-hooks --project /path/to/my-project

# For Codex
node ~/episodic-memory/install.mjs --tool codex --project /path/to/my-project

# For Windsurf
node ~/episodic-memory/install.mjs --tool windsurf --project /path/to/my-project

# For all tools at once
node ~/episodic-memory/install.mjs --tool all --project /path/to/my-project
```

That's the only manual step. After this, your AI assistant reads the instruction file automatically and manages everything.

### What the installer does

1. Copies scripts to `~/.episodic-memory/scripts/` (shared across all projects)
2. Creates `.episodic-memory/` in your project for local memories
3. Adds the right instruction file for your tool
4. Updates `.gitignore` to exclude memory data
5. With `--install-hooks` (Claude Code only): registers PreToolUse (checkpoint-gate, plan-gate, stop-gate), SessionStart (recall + BP-1 fallback sweep), and SessionEnd hooks. Re-running the installer warns when any installed hook has drifted from the source-of-truth copy.

---

## Scenario 1: Starting a New Session

**What happens:** You open your project and start talking to the AI. It automatically checks for relevant memories from past sessions.

```
You:  Let's continue working on the payment module.

AI:   I found 3 relevant memories from past sessions:

      1. "Chose Stripe over PayPal for payment processing" (Mar 12)
         — Stripe's API is more developer-friendly and supports
         idempotency keys natively

      2. "Payment webhook must be idempotent" (Mar 15)
         — Duplicate webhooks caused double charges in testing.
         Added deduplication using event IDs.

      3. "Stripe test mode uses separate API keys" (Mar 12)
         — Keys are in .env.test, not .env

      I'll keep these in mind as we work. What would you like to do?
```

**What you did:** Nothing special. The AI recalled context on its own.

---

## Scenario 2: Making a Decision

**What happens:** During a conversation, you and the AI discuss a trade-off and settle on an approach. The AI recognizes this as a significant decision and stores it.

```
You:  Should we use REST or GraphQL for the new API?

AI:   For your use case — mostly CRUD with a few complex queries —
      REST is simpler to implement and cache. GraphQL adds complexity
      you don't need yet.

You:  Agreed, let's go with REST. We can always add a GraphQL layer
      later if needed.

AI:   Sounds good. I'll set up Express with a RESTful resource
      structure.

      Stored decision: "Chose REST over GraphQL for the new API"
      — simpler for CRUD-heavy use case, GraphQL deferred.
```

**What you did:** Just had a normal conversation. The AI stored the decision because it involved a meaningful trade-off.

---

## Scenario 3: Discovering Something Important

**What happens:** While debugging or exploring code, you uncover something non-obvious that future sessions should know about.

```
You:  Why is this test failing intermittently?

AI:   Found it. The `user.save()` method triggers a post-save hook
      that sends an email via an external service. In tests, the
      service times out randomly, causing flaky failures.

You:  Wow, that's not documented anywhere.

AI:   I'll mock the email service in tests to fix the flakiness.

      Stored discovery: "user.save() triggers email post-save hook"
      — causes flaky tests when external service is slow. Mock the
      email service in test environment.
```

**What you did:** Just debugged normally. The AI recognized a non-obvious behavior worth remembering.

---

## Scenario 4: Correcting a Bad Decision

**What happens:** A past decision turns out to be wrong. Instead of deleting the old memory, the AI creates a revision — preserving the history of why things changed.

```
You:  The REST approach isn't working. The mobile app needs to fetch
      deeply nested data and we're making 8 API calls per screen.

AI:   That's a classic case where GraphQL shines — the mobile app
      can fetch exactly what it needs in one query.

      I found our original decision from March: "Chose REST over
      GraphQL for the new API." Let me revise it.

      Revised: "Switched to GraphQL for the API" — REST required
      too many round trips for the mobile app's nested data needs.
      The original REST decision is now superseded.

You:  What if someone asks why we're using GraphQL?

AI:   The revision chain shows the full history:

      1. [superseded] "Chose REST over GraphQL" (Mar 12)
         — seemed simpler for CRUD at the time
      2. [active] "Switched to GraphQL" (Apr 5)
         — REST caused 8 round trips per mobile screen
```

**What you did:** Told the AI the old approach wasn't working. It found the original decision, revised it, and preserved the reasoning chain.

---

## Scenario 5: Asking About Past Decisions

**What happens:** You want to recall what was decided previously, either for a specific topic or broadly.

### Asking about a specific topic

```
You:  What did we decide about authentication?

AI:   3 active decisions related to auth:

      1. "Using passport.js with local strategy" (Feb 20)
         — Chose over custom auth middleware for maintainability

      2. "Session cookies over JWT for auth tokens" (Feb 25)
         — JWT header size caused 431 errors with large payloads

      3. "Rate limit login to 5 attempts per minute" (Mar 1)
         — Prevents brute force without blocking legitimate users
```

### Asking broadly

```
You:  What do you know about this project?

AI:   Here are the 5 most recent memories for this project:

      1. "Switched to GraphQL for the API" (Apr 5) — decision
      2. "user.save() triggers email post-save hook" (Mar 28) — discovery
      3. "Stripe test mode uses separate API keys" (Mar 12) — context
      4. "Payment webhook must be idempotent" (Mar 15) — discovery
      5. "Chose Stripe over PayPal" (Mar 12) — decision
```

---

## Scenario 6: Reaching a Milestone

**What happens:** A significant piece of work is completed. The AI records it so future sessions have context about what's already done.

```
You:  The payment module is done. All tests pass, webhooks are
      idempotent, and it's deployed to staging.

AI:   Great work!

      Stored milestone: "Payment module complete and deployed to
      staging" — Stripe integration with idempotent webhooks,
      15 endpoints, full test coverage.
```

**Why this matters:** Next time someone works on a related feature (like refunds or invoicing), the AI knows the payment module exists and what state it's in.

---

## Scenario 7: Recording Project Context

**What happens:** You share environment-specific knowledge, constraints, or quirks that aren't written down anywhere but affect how work should be done.

```
You:  By the way, the staging database resets every Sunday night.
      Don't rely on test data persisting over the weekend.

AI:   Good to know.

      Stored context: "Staging database resets every Sunday night"
      — don't rely on persistent test data over weekends.
```

```
You:  The client insists on supporting IE11 for the admin panel.

AI:   Understood — I'll avoid modern CSS and use polyfills where
      needed.

      Stored context: "Admin panel must support IE11" — client
      requirement, affects CSS and JS choices.
```

---

## Scenario 8: Switching Between Tools

**What happens:** You use Cursor on Monday and Claude Code on Tuesday. Both tools share the same memory store.

**Monday (Cursor):**

```
You:  Let's use Tailwind CSS for styling.

AI:   Stored decision: "Chose Tailwind CSS for styling"
```

**Tuesday (Claude Code):**

```
You:  Let's work on the dashboard UI.

AI:   I see from a previous session that you chose Tailwind CSS
      for styling. I'll use Tailwind utility classes for the
      dashboard components.
```

**How it works:** Both tools read from and write to `~/.episodic-memory/`. The instruction files are different per tool, but the data is shared.

**Cross-tool messaging via the second-opinion harness.** When you ask one tool to review another's plan or diff, `scripts/second-opinion.mjs` writes the request as a local episode, dispatches it to the chosen provider (Codex, Claude subagent, Gemini), and writes the reply back as another episode. Both halves live in `.episodic-memory/` so any tool can read them later. Under the hood, `em-watch-codex.mjs` provides the per-scope cursors that keep replies from being read twice.

---

## Scenario 8b: Running a Second-Opinion Review on a Plan or Diff

**What happens:** You're about to implement a non-trivial change and want a second model to sanity-check the plan before you commit time. Or you've finished a PR and want a class-completeness review before merging. Instead of manually writing the request, invoking the other tool, and stitching the reply back into your store, you invoke one harness and it does the round-trip for you.

```
You:  Get a second opinion on this plan from Codex before I start.

AI:   Running scripts/second-opinion.mjs --provider codex --dispatch
      with the plan body...

      Codex replied (episode 20260510-...-1076): ACCEPT-with-FU.
      Two findings — F1 (P1, accepted), F2 (P2, deferred as
      follow-up). Want me to fold F1 into the plan?
```

**Single-shot review of a plan file:**

```bash
node scripts/second-opinion.mjs request \
  --provider codex --project . --storage episodic \
  --body-file plan.md --summary "plan review" --dispatch
```

**Consensus loop until both sides agree (or you hit the round cap):**

```bash
node scripts/second-opinion.mjs request \
  --provider codex --project . --storage episodic \
  --body-file plan.md --summary "plan review" \
  --consensus --max-rounds 5 --rebuttal-cb scripts/my-rebuttal.mjs
```

The `--rebuttal-cb` is a script that takes the reviewer's verdict and decides what to send back next round — accept the findings, push back with new evidence, or stop. Each round is one request episode + one reply episode, so the whole conversation is auditable later via `em-search --tag codex-review --scope local`.

**Providers available:** `codex` (OpenAI Codex CLI), `claude-subagent` (a separate Claude Code session), `gemini` (Google's CLI), and `stub` for testing harness behavior without spending tokens.

**When to use it:** Rule 18 step 2 (any non-trivial implementation needs a second-opinion review on the plan before approval), PR-level reviews before merge, or any time you want a sanity check from a different model family on a load-bearing decision.

---

## Scenario 9: Explicitly Asking to Remember

**What happens:** You want to make sure something specific is remembered, even if the AI might not consider it significant enough to store automatically.

```
You:  Remember: never use console.log in production code.
      Use the winston logger instead.

AI:   Stored context: "Use winston logger, not console.log in
      production" — project convention for structured logging.
```

```
You:  Save this: the deploy pipeline takes 12 minutes. If you
      change only docs, skip CI with [skip ci] in the commit.

AI:   Stored context: "Deploy pipeline takes 12 minutes" — use
      [skip ci] for docs-only changes to save time.
```

**Trigger phrases that work:** "remember this", "save this", "don't forget", "store this for later", "keep this in mind for next time"

---

## Scenario 10: Preventing Repeated Mistakes

**What happens:** The AI uses stored discoveries to prevent you from hitting the same issue twice.

**Session 1 (two weeks ago):**

```
You:  Why is the build failing?

AI:   The test runner runs in parallel by default, and two tests
      are writing to the same temp file. Adding --runInBand fixes it.

      Stored discovery: "Parallel tests conflict on shared temp file"
      — use --runInBand or unique temp paths per test.
```

**Session 2 (today):**

```
You:  I'm adding a new test that writes to /tmp/output.json.

AI:   Heads up — I recall from a past session that parallel tests
      conflict when writing to shared temp files. Two weeks ago this
      caused build failures.

      I'd recommend using a unique temp path per test:
      /tmp/output-${testId}.json

      Want me to set it up that way?
```

**What happened:** The AI prevented you from repeating a mistake by proactively recalling a relevant discovery.

---

## Scenario 11: Tracking Rule Violations

**What happens:** The AI skips a step in its workflow. You catch it and the system records the violation structurally — linking it to the specific rule that was broken.

```
You:  Did you follow the implementation workflow?

AI:   No — I skipped the E2E testing step before pushing. That's a
      violation of bp-001 (implementation workflow).

      Stored violation: "Skipped E2E testing before push"
      — Pattern: bp-001-implementation-workflow
      — What happened: jumped from code review fixes to commit
      — Correct sequence: code review → fix → E2E → bug logging → push
```

**In a future session:**

```
You:  Let's implement the new feature.

AI:   ⚠️ Pre-flight warning: bp-001 (implementation workflow) was
      violated 3 times in the last 30 days. Last violation: yesterday.

      I'll make sure to follow all 9 steps this time, including
      E2E testing and bug logging before pushing.
```

**What happened:** Violations are stored with the pattern ID, the wrong sequence, and the correct sequence. The system aggregates them and surfaces warnings when you start similar work. Over time, this drives enforcement improvements — if a rule is violated repeatedly, it gets a mechanical gate (hook) instead of relying on documentation.

---

## Scenario 12: The Checkpoint Gate Stopped the AI

**What happens:** You installed Claude Code with `--install-hooks`. The AI tries to edit a file or run a command and is blocked with a message about a "checkpoint required."

```
AI:   I tried to edit auth.ts but the checkpoint gate blocked me:

      "Checkpoint required. Write the Rule 18 pre-implementation
      checkpoint block to .checkpoints/.pre-checkpoint-done before write
      tools are unblocked."

      I'll print my implementation plan, get your approval, then
      write the checkpoint marker before continuing.
```

**Why this exists:** The checkpoint enforcement gates (RFC-002 Phase 3b + RFC-004 BP-1 Auto-Pilot) are PreToolUse hooks that prevent the AI from skipping the plan → review → approval → testing steps of the implementation workflow (bp-001). It's the mechanical version of the rules described in Scenario 11 — instead of relying on the AI to remember, the hooks physically block edits until each checkpoint is recorded.

**Three gates:**
- **Pre-checkpoint** — blocks `Edit`/`Write`/`Bash` until the AI has printed its plan and you've approved it.
- **Stop-gate (post-checkpoint)** — blocks turn-end until E2E testing has run and any bugs found are logged ([#144](https://github.com/lantisprime/episodic-memory/pull/144)).
- **Push-gate** — blocks `git push` until all wrap-up steps are complete.

**To clear a gate:** Approve the AI's plan in chat. The AI writes the checkpoint marker on your behalf — you don't run any commands manually. (Marker location is an internal implementation detail; PR #207 relocated it from `<repo>/.claude/.X` to `<repo>/.checkpoints/.X` to escape Claude Code's built-in sensitive-file prompt — readers honor both during burn-in.)

**Behind the scenes — BP-1 Auto-Pilot (RFC-004).** These three gates are part of a run-lifecycle system that signs each implementation run with HMAC, tracks state across crashes, and replays unfinished work via a finalize-recovery state machine. You don't interact with it directly — the gates above are its user-facing edges.

**To opt out entirely:** Don't pass `--install-hooks` during install, or remove the hook entries from `~/.claude/settings.json`.

---

## What Gets Stored and What Doesn't

### Stored automatically

| Type | Examples |
|------|----------|
| **Decisions** | "Chose TypeScript over JavaScript", "REST vs GraphQL", "Which library to use" |
| **Discoveries** | Bug root causes, undocumented behaviors, performance insights |
| **Milestones** | Feature shipped, migration completed, major refactor done |
| **Context** | Environment quirks, client constraints, deployment details |
| **Research** | Web research distilled for future reference (avoids re-fetching) |
| **Violations** | When the AI broke a workflow rule — tracked structurally for pattern improvement |

### Never stored

| Type | Why |
|------|-----|
| Routine edits | Opening, reading, or editing files isn't memorable |
| Test runs | Running tests is normal workflow, not a memory |
| Credentials | Passwords, API keys, tokens are never stored |
| User preferences | These belong in your tool's settings, not episodic memory |

### Storage limits

- **0-3 episodes per session** — only genuinely significant events
- **5 episodes recalled at session start** — enough context without overwhelming

---

## Browsing Your Memories

While the AI manages everything, you can browse memories directly — they're just markdown files.

### File locations

```
~/.episodic-memory/               # Global (shared across projects)
├── episodes/                     # Markdown files
│   ├── 20260312-chose-stripe-a3f1.md
│   ├── 20260315-webhook-idempotent-b2c4.md
│   └── ...
└── index.jsonl                   # Search index

my-project/.episodic-memory/      # Project-local
├── episodes/
└── index.jsonl
```

### What an episode file looks like

```markdown
---
id: 20260312-143022-chose-stripe-over-paypal-a3f1
date: 2026-03-12
time: "14:30"
project: my-project
category: decision
status: active
tags: [payments, api, vendor]
summary: Chose Stripe over PayPal for payment processing
---

# Chose Stripe over PayPal for payment processing

Stripe's API is more developer-friendly. Key reasons:
- Idempotency keys prevent duplicate charges
- Webhook signing for security
- Better docs and SDK support

PayPal was considered but rejected due to complex OAuth flow.
```

### A superseded episode

```markdown
---
id: 20260312-110530-chose-rest-over-graphql-f4a2
date: 2026-03-12
time: "11:05"
project: my-project
category: decision
status: superseded
tags: [api, architecture]
summary: Chose REST over GraphQL for the new API
---

# Chose REST over GraphQL for the new API

REST is simpler for our CRUD-heavy use case...
```

### Its revision

```markdown
---
id: 20260405-091245-switched-to-graphql-c8d3
date: 2026-04-05
time: "09:12"
project: my-project
category: decision
status: active
supersedes: 20260312-110530-chose-rest-over-graphql-f4a2
tags: [api, architecture, revised]
summary: Switched to GraphQL for the API
---

# Switched to GraphQL for the API

Revises: `20260312-110530-chose-rest-over-graphql-f4a2`

REST required 8 round trips per mobile screen...
```

---

## Troubleshooting

### "The AI isn't recalling anything"

- Check that the instruction file was installed: look for `.cursor/rules/episodic-memory.mdc`, `.claude/skills/episodic-memory/SKILL.md`, `AGENTS.md`, or `.windsurfrules` in your project
- Check that scripts exist at `~/.episodic-memory/scripts/`
- Re-run the installer: `node ~/episodic-memory/install.mjs --tool <your-tool> --project .`

### "The AI is storing too many things"

The instruction file limits storage to 0-3 significant events per session. If your AI is over-storing, it may be interpreting "significant" broadly. You can tell it:

```
You:  That wasn't important enough to store. Only store major
      decisions and non-obvious discoveries.
```

### "I want to delete a memory"

Delete the file and rebuild the index:

```bash
rm ~/.episodic-memory/episodes/<episode-id>.md
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```

### "The index seems out of sync"

Rebuild it — this regenerates the index from the actual episode files:

```bash
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```

### "How do I track violations?"

The AI can track rule violations automatically when you point them out. Just say "that was a violation of [rule name]" and the AI stores it with structured details. You can search for all violations:

```bash
node ~/.episodic-memory/scripts/em-search.mjs --category violation
node ~/.episodic-memory/scripts/em-search.mjs --tag "violated:bp-001-implementation-workflow"
```

### "Which patterns are being violated repeatedly?"

`em-pattern-health.mjs` aggregates violation episodes by pattern within a rolling window (default 30 days) and reports which behavioral patterns are healthy, which need attention (violated despite enforcement), and which need enforcement (violated and have no hook stopping them):

```bash
# Full report
node ~/.episodic-memory/scripts/em-pattern-health.mjs

# One-line summary
node ~/.episodic-memory/scripts/em-pattern-health.mjs --summary

# Use as a CI / SessionStart gate — exit 1 if anything needs attention
node ~/.episodic-memory/scripts/em-pattern-health.mjs --check
```

A pattern flagged `needs-enforcement` is being violated repeatedly *and* the script found no mechanical hook (in `~/.claude/hooks/`, `<project>/.claude/hooks/`, `<project>/.git/hooks/`, or `<project>/.github/workflows/`) referencing the pattern. That's a signal to write or install a hook. `needs-attention` means a hook exists but violations are still happening — escalate to a human.

If detection misses a hook (e.g., enforcement lives in an unusual file), pass `--has-enforcement <pattern_id>` to override; repeat the flag for multiple patterns.

### "I want to archive old memories"

`em-prune.mjs` archives episodes that score below a relevance threshold. Use `--dry-run` first to preview, and `--check` as a CI gate that exits 1 when prunable episodes exist:

```bash
node ~/.episodic-memory/scripts/em-prune.mjs --dry-run
node ~/.episodic-memory/scripts/em-prune.mjs --scope global --threshold 0.15
node ~/.episodic-memory/scripts/em-prune.mjs --check
```

### "I want to start fresh"

```bash
rm -rf ~/.episodic-memory/episodes/*
rm -rf my-project/.episodic-memory/episodes/*
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```

### "I want to back up my memories or move them to a new machine"

`em-backup.mjs` mirrors your memory directories to a private GitHub repo with PII / secret redaction applied to the staging copy (source files are never modified):

```bash
# Preview what would be redacted, no writes
node ~/.episodic-memory/scripts/em-backup.mjs --audit

# One-time setup: create the private repo + initial commit + push
node ~/.episodic-memory/scripts/em-backup.mjs --init

# Daily run: rsync sources, redact, commit, push
node ~/.episodic-memory/scripts/em-backup.mjs --sync
```

Config lives at `~/.config/em-backup/config.json`; see `examples/em-backup.config.example.json`. Refuses `--init` / `--sync` without a config to prevent shipping raw personal memory.

`em-restore.mjs` selectively restores from a cloned backup repo — filterable by tag, date, or category, with conflict modes for handling existing files:

```bash
# Dry-run (default): show what would happen, no disk writes
node ~/.episodic-memory/scripts/em-restore.mjs \
  --from /path/to/cloned-backup-repo \
  --source-map home-em=$HOME/.episodic-memory \
  --tag workplan --from-date 2026-04-01

# Apply with full doc tree (MEMORY.md, knowledge_base/, etc.)
node ~/.episodic-memory/scripts/em-restore.mjs \
  --from /path/to/backup --source-map home-em=$HOME/.episodic-memory \
  --include-docs --apply
```

**Restore is one-way:** it can't undo redaction. Frame it as "spin up a fresh machine from backup," not "recover the originals." Files redacted via `extra_redact_strings` retain their `[REDACTED]` tokens; binary / oversized / symlinked files are absent and only summarized in the report.
