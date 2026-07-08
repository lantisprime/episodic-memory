# Principles

Governing principles for the episodic-memory project. Future RFCs reference this document; new features that violate a principle should either revise the principle (with rationale) or be rejected.

These principles are deliberately opinionated. They exist to keep the substrate small, portable, and honest as the project grows new capabilities (cross-tool messaging, enforcement adapters, lifecycle gates).

---

## 1. Memory is the substrate

**Intent:** one data layer; everything that is state reduces to episodes.

Episodic memory — store and recall episodes — is the only data layer. No feature may introduce a second store (queue, socket, sidecar database). If a feature's DATA cannot be expressed as episodes, that is the trigger for a new RFC, not a workaround. (Adjacent layers such as enforcement, distribution, and presentation live in this repo without being episode operations; they consume the substrate and never extend the data layer. See CAPABILITIES.md "Adjacent layers".)

**Why:** Avoiding a second store (queues, sockets, sidecar databases) keeps installation a single directory and reasoning a single mental model. Cross-tool communication, state machines, and lifecycle events all reduce to episodes with categories.

**How to apply:** When you reach for a queue, daemon, IPC channel, or "let's just spin up a small server," stop. Express it as episodes first. If the episode model genuinely cannot carry the use case, that is the moment for a new RFC, not a workaround.

**Capability families.** The sanctioned ways to *use* the substrate — memory-store strategy, recall strategy, learning strategy — and the rule for adding new ones are enumerated in [CAPABILITIES.md](CAPABILITIES.md). Capabilities *use* memory; they do **not** enforce workflows — that is the job of behavior patterns (`bp-XXX`), a separate decoupled layer (RFC-008). A capability that cannot be expressed as an operation over episodes does not belong to the substrate.

---

## 2. Behavior definitions are data; execution belongs behind stable adapter contracts

**Intent:** definitions evolve as data; the code that interprets them stays behind stable, testable contracts.

Pattern definitions, request schemas, and registry entries are JSON. The code that interprets them — adapters, validators, dispatchers — is `.mjs` behind stable contracts that don't change as definitions evolve.

**Why:** Adding a new pattern (`bp-XXX.json`) or request type (`requests/notify.json`) shouldn't require touching code. Conversely, code that interprets definitions deserves a real implementation; pretending logic is "just configuration" hides bugs.

**How to apply:** New behavior definition? JSON file in the appropriate registry. New interpretation logic? `.mjs` module behind a contract that other code calls without caring about underlying schema details.

---

## 3. Detect capabilities automatically; activate adapters explicitly

**Intent:** detection may be automatic; changing system state requires visible consent.

Installation may detect which tool is present and recommend an adapter, but enabling hooks, writing to settings files, or starting background listeners requires user-visible consent and can be undone cleanly.

**Why:** Silently writing to `~/.claude/settings.json` or installing a session-start hook has surprised users and is hard to back out of. Detection is fine; activation must be intentional.

**How to apply:** Installers and adapters declare their side effects explicitly (see Principle 10). Activation prompts the user with the side-effect list before applying. Uninstall is a first-class action with the same fidelity.

---

## 4. Cognitive load > lightweight when they conflict

**Intent:** spend code to save the user from workflow misses.

When a smarter default costs additional code but reliably saves the user from a workflow miss, take the additional code. "Lightweight" is a tiebreaker, not the primary goal.

**Why:** This project exists because users couldn't reliably hold workflow steps in their head — bp-001's persistence proves it. A 50-line helper that makes the right thing automatic is worth more than a 5-line stub that requires the user to remember.

**How to apply:** When you find yourself debating "should this be more automatic?" and the user has been bitten by the manual version — automate it. Reserve "lightweight" for genuine simplicity wins (zero deps, single-file scripts), not for shifting cognitive load to the user.

---

## 5. Cross-platform with honest capability labels

**Intent:** identical artifacts everywhere; never overstate a tool's enforcement strength.

Patterns, request schemas, and lifecycle episodes are portable across all supported tools. Per-tool enforcement strength varies — and we say so explicitly.

**Why:** A Cursor user installing this gets the same memory and the same patterns as a Claude Code user. But Cursor lacks `PreToolUse` hooks, so its enforcement tier is lower than Claude Code's. Pretending parity exists where it doesn't sets users up for failure.

**How to apply:** Capability matrices in RFCs and READMEs declare per-tool tier (`STRONG | MEDIUM | WEAK | TBD`) for each capability. A WEAK tier is honest, not a defect. Never describe a capability as "supported" when only a manual workaround exists — say "MEDIUM (manual)".

---

## 6. Tokens are the budget; bounded background work

**Intent:** token cost is a budget; background spend must be visible, bounded, and consented.

Every agent invocation costs tokens; polling burns tokens on emptiness. Prefer event-driven over polling, small JSON over verbose, lazy loading over eager. When event sources don't exist, prefer lifecycle-gated checks (session start, user-turn boundary). A long-lived or background process (server, watcher, timer) is admissible only when it is user-started, visible while running, bounded in lifetime, and near-zero cost when idle, and it declares its trigger and cost up front. Silent or unbounded background spend is the violation, not the mechanism: an explicitly launched local console qualifies; a silent polling daemon never does.

**Why:** A polling daemon that checks an empty inbox every 30 seconds spends real money for no value. Adapters that are silent when nothing is happening are the goal.

**How to apply:** New listener? Use `fs.watch` first; fall back to one inbox check on session start; a recurring timer requires explicit opt-in plus a declared trigger and cost. New script output? Default to small JSON; full episode bodies only on explicit request. New background task? Show your work — declare what triggers it and what it costs.

---

## 7. State changes are episodes

**Intent:** one immutable audit trail; no parallel mutable state.

Lifecycle transitions (a request opening, being reviewed, closing) are recorded as new episodes referencing the original by ID. There is no separate state store and no in-place mutation.

**Why:** This extends the existing immutability convention ("Episode IDs are immutable; decisions are corrected via revision chains, not edits") to all lifecycle. A single audit trail covers everything; no parallel "state" that can drift from the episode log.

**How to apply:** New lifecycle phase? Define an episode category for the transition (e.g., `request.lifecycle`). Reference the original episode ID via a `references:` or `reply_to:` field. Never edit the original.

---

## 8. Messages carry their context and their recipient

**Intent:** a request is self-sufficient; context drift and routing are detectable from the message alone.

A cross-tool request must be self-sufficient on two axes: **context** (what the receiver should inspect — `worktree`, `branch`, `head` for review-class) and **routing** (who the request is for — a specific tool, a tier, or a broadcast audience). Replies must echo what was actually inspected so drift between requester and reviewer is detectable.

**Why:** Two failure modes, both silent:

- *Context drift.* The reviewer reads stale or wrong files, gives confused feedback, nobody notices. Issue #64 is a concrete instance during the review of RFC-003 itself.
- *Routing ambiguity.* Without an explicit recipient, every adapter has to scan every episode and guess relevance. Adapters either over-fetch (wasted tokens, against P6) or miss messages addressed to them.

**How to apply:** Any typed request declares its required context fields *and* its routing fields in the registry. `em-store --type <type>` validates both before writing. Replies echo `inspected.worktree`, `inspected.head`, and which store they read from; the requester compares and flags mismatches. Adapters filter their inbox by `recipient` (or membership in `audience`) — no scanning all episodes.

---

## 9. Core never imports adapters; adapters import core

**Intent:** the substrate works with zero adapters installed.

The dependency direction is one-way. Memory, recall, and request dispatch run without any adapter installed. Adapters import core APIs (`em-recall`, `em-store`, request dispatch) to wire tool-specific behavior; nothing in core knows that adapters exist.

**Why:** This guarantees the substrate stays usable even if every adapter is removed, broken, or replaced. It also forces clean contracts: anything an adapter needs from core has to be an exported, stable API.

**How to apply:** Code review check — does anything in `scripts/` reference `adapters/` by path or name? If yes, refactor. Adapter-specific decision logic should be pulled back to core; adapters are translators, not deciders.

---

## 10. Consent and reversibility

**Intent:** every side effect is visible, consented, and undoable.

Every adapter declares its side effects (files written, settings modified, hooks installed) in a manifest. Install presents the list and asks for consent. Uninstall removes only owned artifacts. If a user has modified an owned artifact, uninstall fails loud with a diff — it does not silently overwrite.

**Why:** Silent installs have burned users on this project before. "I'll back it out later" is easy until you have to figure out what got installed.

**How to apply:** Adapter manifests include `side_effects: [{type, path, ownership_id, checksum, backout_action}]`. Uninstall checks checksums; if divergent, prints the diff and exits non-zero. The core installer drives the install/uninstall flow, not the adapter — so the consent prompt is consistent across adapters.

---

## 11. Portable core contract

**Intent:** one JSON-and-CLI contract; tools translate and present, never decide.

Core decisions — what is a request, what is a verdict, what closes a request — are JSON episodes and CLI output. Adapters translate tool-specific plumbing (hook formats, slash commands, rules-injection) into that contract.

**Why:** A new tool only has to learn the JSON shapes and CLI commands; it doesn't have to reimplement decision logic. The core stays the source of truth; adapters stay shallow.

**How to apply:** When you find yourself adding decision logic inside an adapter (e.g., "for Codex, a 'comment' verdict means X"), pull it back to core. Adapters route, translate, and present — they don't decide.

---

## 12. Enforcement is per-project; the substrate is global

**Intent:** enforcement activates, scopes, and switches off strictly per project; the substrate never depends on it.

Enforcement — hooks, gates, classifiers — is activated and controlled **per project, never globally**. Four invariants define this principle; any implementation satisfying all four is admissible:

- **I-1 No global registration.** Hook registrations live only in `<project>/.claude/settings.json` — NEVER in `~/.claude/settings.json` or any surface that fires outside the opting project.
- **I-2 Per-project consent and switch.** Activation is an explicit per-project opt-in (Principle 3). Each project owns its own switch (`<project>/.episodic-memory/enforce-config.json` `active`) and, where versioned engines exist, its own version pin; flipping either affects only that project.
- **I-3 Reversibility.** Per-project uninstall removes the project's enforcement set and restores the pre-enforcement state (Principle 10); no global operation leaves enforcement behind in any project.
- **I-4 Substrate independence.** The memory substrate — the episode store, the `em-*` memory tools (`em-store`/`em-search`/`em-recall`/`em-revise`/`em-list`/`em-rebuild-index`), `patterns/`, and the skill — stays global and **hook-free**: it never registers, copies, or depends on a hook to function (Principle 9).

Where enforcement CODE is stored is an implementation detail constrained by the invariants, not by path: full per-project copies (the current layout), a global payload cache used only as a copy source, or a central versioned engine store executed through project-local pinned shims (RFC-010) are all admissible if and only if every invariant holds. What may never exist is a registration outside the project, or an activation without that project's consent. A script that exists only to be run by a hook is an enforcement artifact, not substrate, however it is packaged.

**Why:** A hook in global `~/.claude/settings.json` fires in *every* project — Claude Code merges hooks across scopes and a project cannot subtract a global one — so global enforcement reaches into unrelated projects and breaks them (a gate looking for a project-local lib that isn't there denies real work). Enforcement that cannot be scoped or switched off per project defeats the entire point of RFC-008: decoupling enforcement from the substrate. Memory must stay usable everywhere without dragging enforcement along.

**How to apply:** Enforcement adapters register hooks only into `<project>/.claude/settings.json` (never `~/.claude/hooks/` or `~/.claude/settings.json`), and the artifacts a project executes live under, or are pinned by, that project (`<project>/.claude/hooks/` copies or shims). Global install deploys the substrate (the `em-*` memory tools, `patterns/`, the skill) plus, at most, an unregistered payload cache under `~/.episodic-memory/` used solely as a copy or pin source; it writes zero hook registrations and places nothing under `~/.claude/`. Each project carries its own enable/disable switch — `<project>/.episodic-memory/enforce-config.json` `active`, plus the presence of its hook registrations. Installers expose enforcement as an explicit per-project opt-in (Principle 3) with per-project uninstall (Principle 10); a project that did not opt in runs zero enforcement hooks. Core memory operations never depend on any hook being installed (Principle 9). **Test this:** a mock-project E2E must assert that after any global/core install, `~/.claude/hooks/` contains no enforcement file and `~/.claude/settings.json` contains no enforcement registration; that the enforcement set a project EXECUTES is registered only under `<project>/.claude/`; and any design/code/test that places a REGISTERED enforcement artifact in global scope, or activates enforcement without per-project consent, is a P12 violation (an unregistered payload cache under `~/.episodic-memory/` is not a registration). Per-project uninstall is implemented (P4d S5, #416): `install.mjs --uninstall-enforcement` removes the project's enforcement set while preserving the core set and the global substrate, and the round-trip invariant (core install, then enforce, then uninstall, restores the core-install state) is asserted by `tests/test-uninstall-enforcement.mjs`.

---

## How these principles relate

- **Substrate** (1, 2, 9, 11): episodes are the only data, definitions are JSON, adapters are shallow.
- **Install contract** (3, 10): detect to suggest, activate to commit, undo as a first-class action.
- **Enforcement contract** (3, 10, 12): enforcement activates per-project, switches off per-project, and never reaches global; the substrate stays global and hook-free.
- **Honesty contract** (4, 5, 6): don't pretend parity, don't burn tokens silently, don't shift load onto the user.
- **Integrity contract** (7, 8): lifecycle is auditable, messages carry their context.

---

## When a principle gets in the way

Principles can be revised; they cannot be quietly abandoned. There are two amendment tiers, chosen by whether the principle's **Intent** line changes:

- **Clarification (letter blocks, intent does not).** The stated Intent is preserved; only the mechanics or letter over-constrain. Amend via a PR editing the principle directly, with the rationale in the PR body and a second-opinion review on the diff. Example class: restating Principle 12 as invariants instead of file paths.
- **Revision (intent changes).** The Intent line itself changes, or a new trade-off is introduced. This requires a new RFC; rationale belongs in the RFC's `Alternatives considered` table.

Either way the change is explicit and reviewed; silent override remains the only forbidden move.
