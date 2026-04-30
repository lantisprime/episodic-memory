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

## What Gets Stored and What Doesn't

### Stored automatically

| Type | Examples |
|------|----------|
| **Decisions** | "Chose TypeScript over JavaScript", "REST vs GraphQL", "Which library to use" |
| **Discoveries** | Bug root causes, undocumented behaviors, performance insights |
| **Milestones** | Feature shipped, migration completed, major refactor done |
| **Context** | Environment quirks, client constraints, deployment details |

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

### "I want to start fresh"

```bash
rm -rf ~/.episodic-memory/episodes/*
rm -rf my-project/.episodic-memory/episodes/*
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```
