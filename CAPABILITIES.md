# Capabilities

The capability charter for the episodic-memory project. This is the **guiding post**: it names
the capability families of the **memory substrate** — the ways the system *uses* episodes — the
single substrate they all operate on, and the rule for adding new ones as the project grows.
RFCs and the plugin manager (RFC-008) derive their substrate plugin **types** from this
document.

**Scope boundary (read first).** Capabilities are about **using the memory substrate** —
storing, recalling, and learning from episodes. They do **not** enforce workflows. Enforcing
agent workflow discipline is the job of **behavior patterns** (`bp-XXX`) and the enforcement
layer, which is *decoupled* from the substrate (the thesis of RFC-008) and is **not** a
capability listed here. See
[Enforcement is not a substrate capability](#enforcement-is-not-a-substrate-capability).

Companion to [PRINCIPLES.md](PRINCIPLES.md): the principles say *how* we build; this says
*what the substrate does with episodes*.

---

## The substrate: episodes

Everything reduces to **episodes** — store and recall episodes, then act on them
([Principle 1](PRINCIPLES.md#1-memory-is-the-substrate)). A **capability** is a way of *using*
episodes. The substrate stays small and pure; capabilities are pluggable operations layered
over it, and they **MUST stay enforcement-free** (Principle 1; RFC-008 R1 — no gate / marker /
workflow logic in the substrate).

---

## The capability families

All three are ways of **using episodes**. None of them enforce workflows.

| Capability | What it does | Operates on | Substrate script | Plugin type | Default |
|---|---|---|---|---|---|
| **Memory-store strategy** | Persists episodes and builds derived indexes from them (e.g. knowledge graph) | episodes (write) + derived indexes | `em-store` | `store-strategy` | append-only log + lexical index |
| **Recall strategy** | Retrieves + ranks episodes for use | episodes (read) | `em-recall` | `recall-strategy` | lexical tag-based (zero-dep) |
| **Learning strategy** | Derives new knowledge from episodes + derived indexes, writes it back as global episodes | indexes (read) → episodes (write) | `em-store` (write-back) | `learning` | none (opt-in) |

### 1. Memory-store strategy
How episodes are persisted, and what **derived** structures are built alongside them. Default:
append-only episode log + lexical index. A store strategy may, in future, maintain a derived
**knowledge-graph index** or another derived index that makes recall richer. Derived indexes
are a substrate concern — built from episodes, consumed by recall and learning.

### 2. Recall strategy
How episodes are found and ranked for use. Default: lexical, tag-based, zero-dependency.
Alternatives — semantic (embeddings), graph traversal, hybrid (RRF) — are opt-in
`recall-strategy` plugins. Algorithms live in their own RFCs (RFC-001 Intelligent Memory,
RFC-007 Graph Projection); this charter owns only the capability contract.

### 3. Learning strategy
How the system turns accumulated episodes (and the derived indexes a store strategy builds)
into **new** knowledge, written back as new global episodes for future recall. Reads indexes,
persists derived knowledge via `em-store`. Opt-in, substrate-side, enforcement-free.

---

## The unifying invariant

Every capability is **a way to use memory episodes** — storing them, recalling them, or
learning from them. This is the test for "does X belong here":

- X is an operation over episodes that **does not** enforce workflow → it is a substrate
  capability (this document).
- X **enforces** workflow discipline → it belongs to **behavior patterns**, not here (below).
- X **cannot** be expressed as episodes at all → it is the trigger for a new RFC
  ([Principle 1](PRINCIPLES.md#1-memory-is-the-substrate)).

---

## Enforcement is not a substrate capability

Enforcing agent workflow discipline — plan-approval gates, checkpoints, push gates — is the job
of **behavior patterns** (`patterns/bp-XXX.json`) executed by the **enforcement layer**, **not**
a way of using the memory substrate. RFC-008 exists precisely to keep these apart:

- The substrate (`em-store` / `em-recall` / `em-search`) is pure store-and-recall and contains
  **zero** gate / marker / workflow logic (RFC-008 R1).
- Behavior-pattern enforcement is a **separate layer** that reads contracts and decides
  block / allow — it depends on the substrate, never the reverse (RFC-008 R2 / R6).

The plugin manager *does* host an `enforcement` plugin type, but it lives in the enforcement
layer alongside the three substrate-capability types — it is **not** a capability of the memory
itself. Keep the boundary sharp: **a capability uses memory; behavior patterns enforce
workflow.**

---

## Adding a new capability (the forward rule)

The project **will** grow new ways to use episodes. A new **substrate capability** is sanctioned
only when it satisfies all of the following:

1. **Episode-expressible, not workflow-enforcing** — it is an operation over episodes
   (store / recall / derive). If it enforces workflow, it is a behavior-pattern concern, not a
   capability. If it cannot be expressed as episodes at all, it is a new-RFC conversation
   (Principle 1).
2. **A registered plugin type** — it becomes a `type` in the plugin registry (RFC-008 R8 typed
   registry), added as an additive **MINOR** schema-version bump (R8 versioned-contract clause),
   never an ad-hoc edit to a merged contract.
3. **Complete contract** — it ships its own (a) registry sub-schema (the slot),
   (b) descriptor / manifest schema, (c) runtime IO schema, and (d) a conformance test gauntlet.
   "Supported" means **schema-validated and test-covered**, not merely present.
4. **Enforcement-free** — it stays inside the substrate layer and contains no gate / marker /
   workflow logic (RFC-008 R1). This is the non-negotiable boundary.
5. **Honest + consensual** — declares its capability tier (Principle 5) and explicit activation /
   side-effects (Principles 3, 10); algorithm-heavy capabilities cross-reference their own RFC
   (this charter owns the *contract*; the RFC owns the *algorithm*).

---

## Relation to other docs

- [PRINCIPLES.md](PRINCIPLES.md) — build constraints (*how*); Principle 1 is this charter's root.
- [RFC-008](docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md) — **decouples enforcement
  from the substrate** (R1) and provides the typed plugin manager that hosts both the three
  substrate-capability types and the separate `enforcement` type (R8).
- RFC-001 (Intelligent Memory), RFC-007 (Graph Projection) — algorithms for specific recall /
  store / learning strategies.
