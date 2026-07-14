# `docs/rfcs/` — RFC Directory

RFCs document proposed changes to the episodic-memory system. Every non-trivial change should go through an RFC before implementation.

---

## Active RFCs

| RFC | Title | Status | Champion |
|---|---|---|---|
| RFC-001 | Intelligent Memory: Tag Index, Relevance Scoring, Proactive Recall, and Semantic Consolidation | accepted | Charlton Ho |
| RFC-002 | Learning Loop: Violation Tracking, Pattern Refinement, and Actionable Recall | accepted | Charlton Ho |
| RFC-003 | Pluggable Tool Adapters: Per-Platform Enforcement and Cross-Tool Messaging | accepted | Charlton Ho |
| RFC-004 | BP-1 Auto-Pilot: Automated Rule-18 Implementation Workflow | accepted | Charlton Ho |
| RFC-005 | em-move — atomic episode relocation between scopes | accepted | Charlton Ho |
| RFC-006 | Codex Review Adapter: Typed-Request Consumer with Failure Classification and Local Fallback | withdrawn | Charlton Ho |
| RFC-007 | Graph Projection — first-class traversal over latent episode/rule edges | draft | Charlton Ho |
| RFC-008 | Decoupling the Enforcement Layer from the Memory Substrate | accepted | Charlton Ho |
| RFC-009 | Lesson Activation: Trigger-Bearing Lessons, Derived Trigger Index, and Bounded Advisory Recall | accepted | Charlton Ho |
| RFC-010 | Version-pinned central enforcement engine with per-project shims | draft | Charlton Ho |
| RFC-011 | Playbook Activation Preferences: Per-Project Session-Start and On-Demand Playbook Loading | accepted | Charlton Ho |
| RFC-012 | Promotion Arc: Evidence-Fed Knowledge Promotion, Advisory Cadence, and Stagnation Signals | draft | Charlton Ho |

---

## Directory structure

```
docs/rfcs/
  README.md       <- this file
  TEMPLATE.md     <- copy this when creating a new RFC
  RFC-NNN-<slug>.md
  RFC-008/        <- per-phase architecture + implementation plans for a large RFC
                     (one file per build phase; linked from the RFC's TOC)
  archived/       <- closed RFCs (implemented, withdrawn, superseded)
```

> **Companion phase directories.** When an `accepted` RFC's build-phase detail grows large
> enough to crowd the RFC body (architecture diagrams, per-phase file manifests, hazards),
> extract it into a sibling `RFC-NNN/` directory — one file per phase — and link each from
> the RFC's table of contents. The RFC body keeps the summary table, crosswalk, traceability
> matrix, and the live implementation ledger. First instance: `RFC-008/`.

---

## RFC status vocabulary

| Status | Meaning | Where the file lives |
|---|---|---|
| `draft` | Proposed; under active discussion | `rfcs/` root |
| `accepted` | Design approved; ready for implementation | `rfcs/` root |
| `deferred` | Valid idea; not the right time | `rfcs/` root |
| `implemented` | Fully shipped | `rfcs/archived/` |
| `withdrawn` | Abandoned | `rfcs/archived/` |
| `superseded` | Replaced by a newer RFC | `rfcs/archived/` |

---

## RFC lifecycle

1. **Draft** — Copy `TEMPLATE.md` to `RFC-NNN-<slug>.md`. Fill in the problem, proposal, and alternatives. Register in this README.
2. **Second opinion** — Required before acceptance. Record findings in the RFC's `## Second opinion` section.
3. **Accepted** — Design approved. Populate `## Implementation plan` with concrete PR/phase breakdown.
4. **Implemented** — All phases shipped. Move to `archived/`.

---

## Naming convention

```
RFC-NNN-<slug>.md
```

Example: `RFC-001-memory-improvements.md`

The RFC-NNN ID is assigned when the formal RFC file is created.

---

## Archive rules

- `archived/` is stable, not immutable. Errata are permitted; substantive changes require a new RFC.
- Deferred RFCs stay in `rfcs/` root (they may become active again).
