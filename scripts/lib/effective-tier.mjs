// effective-tier.mjs — the single tier-resolution algebra (RFC-008 P3b-2, R3).
//
// Extracted VERBATIM from validate-plugin-registry.mjs (TIER_RANK, effectiveTier,
// eventActionId) so the runbook's documented Resolution Matrix (Table B) and the
// runtime stop-gate decision read the SAME min()-over-tiers algebra — Rule 14:
// one algebra, two consumers, MUST NOT drift. The validator re-imports these for
// byte-rendering Table B (no behavior change there, proven by its self-tests);
// enforce-contract.mjs imports the base-STRONG fold + the gate maps for the live
// stop decision.
//
// TWO folds, deliberately distinct (F-CLOSE-1 / F-NEW-2):
//
//   effectiveTier(tiers)          null on all-absent. VALIDATOR-ONLY — the matrix
//                                 byte-diff renders an em-dash on null (eventActionId
//                                 returns "—"), and that em-dash is embedded in the
//                                 runbook + byte-diffed by M7c. Mutating it to
//                                 never-null would break that diff (fails LOUD in
//                                 CI, never fail-open) — so the never-null consumer
//                                 gets a SEPARATE fold below, and this one is pinned.
//
//   effectiveTierStrong(sources)  base 'STRONG', clamp-DOWN only, returns a CONCRETE
//                                 tier NEVER null. ENFORCE-CONTRACT-ONLY. A
//                                 null/absent/unresolvable/unknown source is never
//                                 folded as a lowering value and never read as
//                                 silent-allow, so "resolution failed ⇒ weaker gate"
//                                 is unreachable by construction (B1 — the anti-
//                                 fail-open invariant).

// STRONG(3) > MEDIUM(2) > WEAK(1) > TBD(0). TBD is a manifest-declaration sentinel
// (validate-plugin-registry TIERS); it never reaches a live contract (schema.json
// closes contract tiers to {STRONG,MEDIUM,WEAK}).
export const TIER_RANK = { TBD: 0, WEAK: 1, MEDIUM: 2, STRONG: 3 };

// gate → lifecycle event the gate fires at. The three classification gates fire at
// pre_tool_use; the root-level marker-state stop gate fires at stop (F-NEW-1,
// grounded in patterns/schema.json:17-36 — `gates.*` are the pre_tool_use
// classification gates, `stop.tier` is the marker-state gate). The event selects
// both the harness-capability tier and the events.json action semantics.
export const GATE_EVENT_MAP = {
  plan_approval: "pre_tool_use",
  pre_checkpoint: "pre_tool_use",
  post_checkpoint: "pre_tool_use",
  stop: "stop",
};

// gate → contract key PATH inside a bp-XXX.json contract (patterns/schema.json).
// The three classification gates live under `gates.*`; the stop refuse is the
// ROOT-LEVEL `stop.tier` marker-state gate — NOT `gates.post_checkpoint` (the
// v2-plan bug F-NEW-1 corrected). An operator relaxing the stop refuse clamps
// `{"bp-001":{"stop":"WEAK"}}`, never `post_checkpoint`.
export const GATE_CONTRACT_KEY = {
  plan_approval: "gates.plan_approval",
  pre_checkpoint: "gates.pre_checkpoint",
  post_checkpoint: "gates.post_checkpoint",
  stop: "stop.tier",
};

// Which gates P3b-2 LIVE-wires into a runtime decision. ONLY the stop gate this
// slice (decideStop, the marker-state gate). The three pre_tool_use classification
// gates are DEFERRED — they need the bash plan-gate.sh/checkpoint-gate.sh ↔ node
// bridge, a later slice (§9). Exported so the Rule-14 mirror validator can assert
// a `stop→` clamp degrades the live decision while a `post_checkpoint→` clamp does
// not (it is inert until wired).
export const LIVE_GATES = ["stop"];

/**
 * VALIDATOR-ONLY fold: min over the PRESENT tier sources, null on all-absent.
 * Pinned unchanged — the runbook matrix byte-diff depends on the null→em-dash
 * rendering. Do not give this never-null semantics; use effectiveTierStrong.
 */
export function effectiveTier(tiers) {
  let min = null, minRank = Infinity;
  for (const t of tiers) {
    if (t == null) continue;
    const r = TIER_RANK[t] ?? Infinity;
    if (r < minRank) { minRank = r; min = t; }
  }
  return min;
}

/**
 * clamp-DOWN only (B1). A null source leaves base unchanged; a source strictly
 * WEAKER than base lowers it; a source stronger-or-equal — OR an unknown tier
 * string (rank Infinity) — leaves base unchanged. Unknown ⇒ never lowers ⇒
 * fail-closed: a malformed tier can never weaken a gate.
 */
export function clampTier(base, source) {
  if (source == null) return base;
  const br = TIER_RANK[base] ?? -Infinity;
  const sr = TIER_RANK[source] ?? Infinity;
  return sr < br ? source : base;
}

/**
 * ENFORCE-CONTRACT fold: base 'STRONG', clamp each source DOWN, return a CONCRETE
 * tier NEVER null. All sources null/absent ⇒ 'STRONG' (today's behavior), so a
 * resolution failure can never produce a weaker gate (the anti-fail-open
 * invariant, F-NEW-2). The caller passes [harnessCap, contractTier, configTier];
 * any leg it could not resolve it passes as null.
 */
export function effectiveTierStrong(sources) {
  let t = "STRONG";
  for (const s of sources) t = clampTier(t, s);
  return t;
}

/**
 * The events.json action id for (eventId, tier). Returns "—" (em-dash) when the
 * tier is null or the event/action is absent — the validator renders that em-dash
 * in the runbook matrix. enforce-contract passes a concrete tier, so it always
 * gets a real action id (or "—" only on a genuinely missing event, which it
 * treats as a non-actionable resolution miss).
 */
export function eventActionId(events, eventId, tier) {
  const ev = (events.events || []).find((e) => e.id === eventId);
  const a = ev && ev.actions && tier != null ? ev.actions[tier] : null;
  return a && a.id ? a.id : "—";
}
