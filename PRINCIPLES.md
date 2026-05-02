# Principles

Governing principles for the episodic-memory project. Future RFCs reference this document; new features that violate a principle should either revise the principle (with rationale) or be rejected.

These principles are deliberately opinionated. They exist to keep the substrate small, portable, and honest as the project grows new capabilities (cross-tool messaging, enforcement adapters, lifecycle gates).

---

## 1. Memory is the substrate

Episodic memory — store and recall episodes — is the only data layer. If a feature can't be expressed as "store and recall episodes, then react to them," it doesn't belong in this repo.

**Why:** Avoiding a second store (queues, sockets, sidecar databases) keeps installation a single directory and reasoning a single mental model. Cross-tool communication, state machines, and lifecycle events all reduce to episodes with categories.

**How to apply:** When you reach for a queue, daemon, IPC channel, or "let's just spin up a small server," stop. Express it as episodes first. If the episode model genuinely cannot carry the use case, that is the moment for a new RFC, not a workaround.

---

## 2. Behavior definitions are data; execution belongs behind stable adapter contracts

Pattern definitions, request schemas, and registry entries are JSON. The code that interprets them — adapters, validators, dispatchers — is `.mjs` behind stable contracts that don't change as definitions evolve.

**Why:** Adding a new pattern (`bp-XXX.json`) or request type (`requests/notify.json`) shouldn't require touching code. Conversely, code that interprets definitions deserves a real implementation; pretending logic is "just configuration" hides bugs.

**How to apply:** New behavior definition? JSON file in the appropriate registry. New interpretation logic? `.mjs` module behind a contract that other code calls without caring about underlying schema details.

---

## 3. Detect capabilities automatically; activate adapters explicitly

Installation may detect which tool is present and recommend an adapter, but enabling hooks, writing to settings files, or starting background listeners requires user-visible consent and can be undone cleanly.

**Why:** Silently writing to `~/.claude/settings.json` or installing a session-start hook has surprised users and is hard to back out of. Detection is fine; activation must be intentional.

**How to apply:** Installers and adapters declare their side effects explicitly (see Principle 10). Activation prompts the user with the side-effect list before applying. Uninstall is a first-class action with the same fidelity.

---

## 4. Cognitive load > lightweight when they conflict

When a smarter default costs additional code but reliably saves the user from a workflow miss, take the additional code. "Lightweight" is a tiebreaker, not the primary goal.

**Why:** This project exists because users couldn't reliably hold workflow steps in their head — bp-001's persistence proves it. A 50-line helper that makes the right thing automatic is worth more than a 5-line stub that requires the user to remember.

**How to apply:** When you find yourself debating "should this be more automatic?" and the user has been bitten by the manual version — automate it. Reserve "lightweight" for genuine simplicity wins (zero deps, single-file scripts), not for shifting cognitive load to the user.

---

## 5. Cross-platform with honest capability labels

Patterns, request schemas, and lifecycle episodes are portable across all supported tools. Per-tool enforcement strength varies — and we say so explicitly.

**Why:** A Cursor user installing this gets the same memory and the same patterns as a Claude Code user. But Cursor lacks `PreToolUse` hooks, so its enforcement tier is lower than Claude Code's. Pretending parity exists where it doesn't sets users up for failure.

**How to apply:** Capability matrices in RFCs and READMEs declare per-tool tier (`STRONG | MEDIUM | WEAK | TBD`) for each capability. A WEAK tier is honest, not a defect. Never describe a capability as "supported" when only a manual workaround exists — say "MEDIUM (manual)".

---

## 6. Tokens are the budget; bounded background work

Every agent invocation costs tokens; polling burns tokens on emptiness. Prefer event-driven over polling, small JSON over verbose, lazy loading over eager. When event sources don't exist, fall back to lifecycle-gated checks (session start, user-turn boundary) — never timers. No silent daemons.

**Why:** A polling daemon that checks an empty inbox every 30 seconds spends real money for no value. Adapters that are silent when nothing is happening are the goal.

**How to apply:** New listener? Use `fs.watch` first; fall back to one inbox check on session start; never schedule a recurring timer. New script output? Default to small JSON; full episode bodies only on explicit request. New background task? Show your work — declare what triggers it and what it costs.

---

## 7. State changes are episodes

Lifecycle transitions (a request opening, being reviewed, closing) are recorded as new episodes referencing the original by ID. There is no separate state store and no in-place mutation.

**Why:** This extends the existing immutability convention ("Episode IDs are immutable; decisions are corrected via revision chains, not edits") to all lifecycle. A single audit trail covers everything; no parallel "state" that can drift from the episode log.

**How to apply:** New lifecycle phase? Define an episode category for the transition (e.g., `request.lifecycle`). Reference the original episode ID via a `references:` or `reply_to:` field. Never edit the original.

---

## 8. Messages carry their context and their recipient

A cross-tool request must be self-sufficient on two axes: **context** (what the receiver should inspect — `worktree`, `branch`, `head` for review-class) and **routing** (who the request is for — a specific tool, a tier, or a broadcast audience). Replies must echo what was actually inspected so drift between requester and reviewer is detectable.

**Why:** Two failure modes, both silent:

- *Context drift.* The reviewer reads stale or wrong files, gives confused feedback, nobody notices. Issue #64 is a concrete instance during the review of RFC-003 itself.
- *Routing ambiguity.* Without an explicit recipient, every adapter has to scan every episode and guess relevance. Adapters either over-fetch (wasted tokens, against P6) or miss messages addressed to them.

**How to apply:** Any typed request declares its required context fields *and* its routing fields in the registry. `em-store --type <type>` validates both before writing. Replies echo `inspected.worktree`, `inspected.head`, and which store they read from; the requester compares and flags mismatches. Adapters filter their inbox by `recipient` (or membership in `audience`) — no scanning all episodes.

---

## 9. Core never imports adapters; adapters import core

The dependency direction is one-way. Memory, recall, and request dispatch run without any adapter installed. Adapters import core APIs (`em-recall`, `em-store`, request dispatch) to wire tool-specific behavior; nothing in core knows that adapters exist.

**Why:** This guarantees the substrate stays usable even if every adapter is removed, broken, or replaced. It also forces clean contracts: anything an adapter needs from core has to be an exported, stable API.

**How to apply:** Code review check — does anything in `scripts/` reference `adapters/` by path or name? If yes, refactor. Adapter-specific decision logic should be pulled back to core; adapters are translators, not deciders.

---

## 10. Consent and reversibility

Every adapter declares its side effects (files written, settings modified, hooks installed) in a manifest. Install presents the list and asks for consent. Uninstall removes only owned artifacts. If a user has modified an owned artifact, uninstall fails loud with a diff — it does not silently overwrite.

**Why:** Silent installs have burned users on this project before. "I'll back it out later" is easy until you have to figure out what got installed.

**How to apply:** Adapter manifests include `side_effects: [{type, path, ownership_id, checksum, backout_action}]`. Uninstall checks checksums; if divergent, prints the diff and exits non-zero. The core installer drives the install/uninstall flow, not the adapter — so the consent prompt is consistent across adapters.

---

## 11. Portable core contract

Core decisions — what is a request, what is a verdict, what closes a request — are JSON episodes and CLI output. Adapters translate tool-specific plumbing (hook formats, slash commands, rules-injection) into that contract.

**Why:** A new tool only has to learn the JSON shapes and CLI commands; it doesn't have to reimplement decision logic. The core stays the source of truth; adapters stay shallow.

**How to apply:** When you find yourself adding decision logic inside an adapter (e.g., "for Codex, a 'comment' verdict means X"), pull it back to core. Adapters route, translate, and present — they don't decide.

---

## How these principles relate

- **Substrate** (1, 2, 9, 11): episodes are the only data, definitions are JSON, adapters are shallow.
- **Install contract** (3, 10): detect to suggest, activate to commit, undo as a first-class action.
- **Honesty contract** (4, 5, 6): don't pretend parity, don't burn tokens silently, don't shift load onto the user.
- **Integrity contract** (7, 8): lifecycle is auditable, messages carry their context.

---

## When a principle gets in the way

If a principle blocks an obviously valuable feature, the principle gets revisited in a new RFC — not silently overridden. Rationale belongs in the RFC's `Alternatives considered` table. Principles can be revised; they cannot be quietly abandoned.
