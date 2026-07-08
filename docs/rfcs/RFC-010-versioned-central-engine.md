---
rfc_id: RFC-010
slug: versioned-central-engine
title: Version-pinned central enforcement engine with per-project shims
status: draft
champion: Charlton Ho
created: 2026-07-08
last_modified: 2026-07-08
supersedes: ~
superseded_by: ~
---

# RFC-010 — Version-pinned central enforcement engine with per-project shims

## AI context

> (1) This RFC replaces full per-project copies of enforcement hook code with thin
> per-project shims that execute a centrally stored, version-pinned engine at
> `~/.episodic-memory/enforcement/v<N>/`, so updating consumers becomes flipping a
> per-project pin instead of re-copying files into every project. (2) It solves the
> consumers-left-behind problem: copy-based distribution means every repo update strands
> each consuming project on its install-time snapshot, and the Layer-1 mitigations
> (install manifests, consumer registry, `--update-consumers` sweep) still re-copy code
> per project. (3) The key trade-off: central code storage requires amending
> Principle 12's letter (hook FILES live in the project) while preserving its intent
> (registration, consent, and scoping stay strictly per-project); a project only ever
> runs the engine version its own pin names, so a global update never changes a
> project's behavior without a per-project pin flip.

---

## Problem

Enforcement hook code (checkpoint-gate.sh, plan-gate.sh, stop-gate.sh, preflight-gate.sh,
lib/) is copied in full into every consuming project's `.claude/hooks/` at install time
(Principle 12, P4d). Observable consequences:

- Every repo update strands every consuming project on its install-time snapshot until
  someone manually re-runs the installer in that project. The 2026-07-08 consult-gap fix
  is a live example: fixed at source, deployed to exactly one project.
- Bug fixes to gate code must be re-deployed N times for N consumers; missed re-deploys
  leave inconsistent enforcement behavior across projects on the same machine.
- Per-project full copies also mean per-project drift: a project's hooks can be locally
  patched and silently diverge, with no version identity to detect it (partially
  mitigated by the Layer-1 install manifests).

The Layer-1 tooling (install manifest + consumer registry + `--update-consumers` sweep +
session-start drift notice) makes staleness visible and fixable in one command, but the
structural cause remains: code distribution is N copies of the same files.

---

## Proposal

Store engine code once per version, centrally; keep everything project-facing thin and
explicit:

1. **Central versioned store.** `install.mjs` deploys enforcement engine code to
   `~/.episodic-memory/enforcement/v<version>/` (immutable once written; a new version is
   a new directory). Composes with the E1 engine inversion (bash-shim / Node-engine): a
   single-engine layout makes version pinning tractable.
2. **Per-project shims.** A consuming project's `.claude/hooks/` contains only small
   shims (a few lines each) that resolve the project's pinned version and `exec` the
   central engine file. Hook REGISTRATIONS stay in `<project>/.claude/settings.json`
   exactly as today; a project that never opted in still runs zero enforcement.
3. **Per-project pin.** `<project>/.episodic-memory/enforce-config.json` gains a
   `engine_version` field. The shim resolves the pin; a missing pinned version directory
   fails closed with a clear message naming the fix. Updating a consumer = flipping its
   pin (one JSON edit, done by `install.mjs --update-consumers` with consent semantics
   from Layer 1). Rollback = flipping it back (Principle 10 reversibility).
4. **Principle 12 amendment.** P12's intent is preserved and sharpened: registration,
   activation, consent, and the enable/disable switch are per-project, always; code
   STORAGE may be central and versioned because centrally stored code executes only when
   a project-local registration invokes it under a project-local pin. The amendment text
   ships in this RFC and edits PRINCIPLES.md in the same PR that flips this RFC to
   `accepted`.

### Scope

- **In scope:** central versioned storage for enforcement engine code; shim + pin
  mechanism; pin-flip semantics in `--update-consumers`; PRINCIPLES.md P12 amendment;
  migration path from full-copy installs (a shim install replaces a copy install;
  burn-in period where both layouts are honored).
- **Out of scope:** the E1 bash-to-Node engine inversion itself (tracked separately;
  this RFC works with either engine form but is designed for the post-E1 layout);
  substrate script distribution (already a single global copy); non-enforcement
  per-project artifacts (instruction files stay copy-based under Layer-1 manifests).

---

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Pull-based auto-update: global dist CACHE (payload only, no registrations) + per-project `auto_update` consent flag + session-start checksum-guarded refresh | NOT rejected — shipping as the near-term layer (2026-07-08, no P12 change needed since the cache registers nothing and code still lives/executes per-project). It reduces this RFC's urgency; this RFC remains the end-state only if single-copy storage + instant pin-flip updates prove worth an amendment on top of it |
| Keep full per-project copies + Layer-1 sweep only | Fixes visibility, not the structure: still N copies, still N re-deploys per fix, still silent local divergence between sweeps |
| Global unversioned engine (single latest copy, P4a-era fallback) | A global update instantly changes behavior in every project with no per-project consent or rollback; this is why P4d removed the global engine fallback |
| Symlink project hooks to a global latest | Same blast-radius problem as unversioned global, plus symlink semantics differ across platforms/tools and complicate the path-authority story |
| Claude Code plugin marketplace distribution for hooks | Plugin updates cover skill/instruction artifacts, but enforcement is per-project by design and marketplace update timing is not consent-gated per project |

---

## Implementation plan

> Populate this section when the RFC moves to `accepted`. Expected shape: PR-1 central
> store + shim + pin (burn-in, both layouts honored); PR-2 `--update-consumers` pin-flip
> integration + migration sweep; PR-3 full-copy layout sunset after parity evidence.

---

## Implementation

> Populate during build stage — mark each item immediately after it ships. Do not batch
> at the end.

| PR/Commit | Files changed | Tests | Notes |
|---|---|---|---|
| _pending_ | _pending_ | _pending_ | _pending_ |

---

## Related RFCs

- RFC-008 (decouple enforcement from substrate) — parent of Principle 12; this RFC
  amends P12's storage clause without touching the decoupling thesis.
- Layer-1 installer work (install manifests, consumer registry, `--update-consumers`,
  drift notice) — the discovery and consent machinery this RFC's pin flips ride on.
- E1 engine inversion (bash-shim / Node-engine, issue pending) — composes; a single
  Node engine is the natural unit of central versioning.

---

## Second opinion

> Required before `status: accepted` can be set.

**Reviewer:** <!-- pending -->
**Date:** <!-- pending -->
**Findings:** <!-- pending -->
**AI-slop check:** <!-- pending -->
**Decision:** <!-- pending -->

---

## Open questions

| # | Question | Owner | Status |
|---|---|---|---|
| OQ-1 | Version identity: semver, monotonic integer, or source git SHA? (Layer-1 manifests use git SHA; pins probably want something orderable) | — | open |
| OQ-2 | How many engine versions does the central store retain, and what prunes them (a version no project pins)? | — | open |
| OQ-3 | Burn-in mechanics: how long are full-copy layouts honored, and what evidence gates the sunset (parity with the E6 conformance matrix)? | — | open |
| OQ-4 | Cross-tool reach: do Cursor/Windsurf enforcement adapters (RFC-008 P8) adopt shims from day one or after Claude Code burn-in? | — | open |

---

## Deferral note

> Populate only if status changes to `deferred`.

---

## Withdrawal note

> Populate only if status changes to `withdrawn`.

---

## Supersession note

> Populate only if status changes to `superseded`.
