#!/usr/bin/env node
// test-em-recall-purity.mjs — RFC-008 P3d (F60) CI grep-guard.
//
// em-recall.mjs is the memory SUBSTRATE and must carry ZERO enforcement code
// (RFC-008:83,85). P3d STRICT-DELETED the stop gate (--gate stop), the
// SessionStart side-effects (--session-start: baseline write + marker sweeps),
// and the bp-001 advisory out of em-recall and into enforce-contract.mjs +
// scripts/lib/. This guard fails the build if any enforcement-only token
// reappears in em-recall.mjs — the equivalence class, not a single spelling
// (feedback_handoff_complete_bug_class).
//
// Three controls (a guard with only the forbidden check passes vacuously if the
// file is empty/missing OR if a forbidden token is a typo that never matches):
//   1. FORBIDDEN absent  — no enforcement token appears in em-recall.mjs.
//   2. POSITIVE control  — em-recall.mjs still contains its recall-side code
//                          (proves we're scanning the real, non-empty script).
//   3. ANTI-VACUOUS      — every FORBIDDEN token IS present somewhere in the
//                          enforcement layer (proves the token strings are real;
//                          a typo'd forbidden token would fail this and be caught).

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { EM_RECALL_ENFORCEMENT_TOKENS } from '../scripts/lib/em-recall-purity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const SCRIPTS = path.join(REPO, 'scripts')
const EM_RECALL = path.join(SCRIPTS, 'em-recall.mjs')

// Enforcement-only token equivalence class (RFC-008 P3d §F60), imported from the
// Rule-14 single source shared with install.mjs's F45 sentinel.
const FORBIDDEN = EM_RECALL_ENFORCEMENT_TOKENS

// Recall-side identifiers that MUST survive in em-recall.mjs (positive control —
// these are intrinsic to the recall substrate and would only vanish if the file
// were truncated/replaced, which would make the forbidden check vacuous).
const REQUIRED_RECALL = [
  'preflight_warnings',
  'inferContext',
  'loadIndex',
  '--scope',
  '--project',
  '--limit',
]

// Enforcement files that legitimately OWN the forbidden tokens — used for the
// anti-vacuous control (each forbidden token must appear in this corpus).
const ENFORCEMENT_FILES = [
  path.join(SCRIPTS, 'enforce-contract.mjs'),
  path.join(SCRIPTS, 'lib', 'marker-paths.mjs'),
  path.join(SCRIPTS, 'lib', 'marker-state.mjs'),
  path.join(SCRIPTS, 'lib', 'bp001-advisory.mjs'),
]

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }

console.log('=== F60: em-recall.mjs enforcement-token purity guard ===')

const src = fs.readFileSync(EM_RECALL, 'utf8')

// --- Control 2: positive (real, non-empty recall script) ---
for (const tok of REQUIRED_RECALL) {
  if (src.includes(tok)) ok(`positive control: em-recall.mjs contains recall token "${tok}"`)
  else bad(`positive control "${tok}"`, 'recall-side token MISSING — is em-recall.mjs truncated/replaced? forbidden check would be vacuous')
}

// --- Control 3: anti-vacuous (forbidden tokens are real strings) ---
const enforcementCorpus = ENFORCEMENT_FILES.map(f => {
  try { return fs.readFileSync(f, 'utf8') } catch { return '' }
}).join('\n')
for (const tok of FORBIDDEN) {
  if (enforcementCorpus.includes(tok)) ok(`anti-vacuous: forbidden token "${tok}" is real (found in enforcement layer)`)
  else bad(`anti-vacuous "${tok}"`, 'forbidden token not found anywhere in the enforcement layer — likely a typo that would pass the purity check vacuously')
}

// --- Control 1: forbidden tokens absent from em-recall.mjs ---
for (const tok of FORBIDDEN) {
  // Match per-line to give an actionable location on failure.
  const lines = src.split('\n')
  const hits = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => l.includes(tok))
  if (hits.length === 0) ok(`purity: em-recall.mjs free of enforcement token "${tok}"`)
  else bad(`purity "${tok}"`, `found at ${hits.map(h => `L${h.n}`).join(', ')} — enforcement code leaked back into the memory substrate (RFC-008:83,85)`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log('\nFailures:'); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
