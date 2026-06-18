// em-recall-purity.mjs — RFC-008 P3d (F45/F60) single source of truth for the
// "enforcement-only token" equivalence class that must NEVER appear in the
// memory substrate (em-recall.mjs). em-recall is pure recall; the stop gate
// (--gate stop), the SessionStart side-effects (--session-start: baseline write
// + marker sweeps), and the bp-001 advisory all relocated to enforce-contract.mjs
// + scripts/lib/ (RFC-008:83,85).
//
// Rule 14 (machine-readable single source, two consumers — MUST NOT drift):
//   - tests/test-em-recall-purity.mjs  (F60 CI grep-guard on the repo source)
//   - install.mjs                      (F45 install-time sentinel on the deployed copy)
//   - tests/test-install-em-recall-purified.mjs (F45 regression)
// Zero dependencies (Node stdlib only) so install.mjs can import it.

// The forbidden class. EXCLUDES recall-legit tokens (bp-001, pattern, violated,
// resolveRepoRoot) which legitimately survive in em-recall's recall body.
export const EM_RECALL_ENFORCEMENT_TOKENS = [
  '--gate',
  'VALID_GATES',
  '--session-start',
  '--session-id',
  '.session-baseline',
  'BASELINE_NAME',
  '.checkpoint-required',
  '.post-checkpoint',
  '.plan-approval',
  'marker-state',
  'marker-paths',
  'stopGateCarveOut',
  '__BP1_ADVISORY__',
  '.checkpoints',
  'shouldArmBp001Checkpoint',
]

// Return the subset of forbidden tokens present in `source` (em-recall.mjs body).
// Empty array = pure. Non-empty = enforcement code leaked back into the substrate.
export function findEnforcementTokens(source) {
  return EM_RECALL_ENFORCEMENT_TOKENS.filter(tok => source.includes(tok))
}
