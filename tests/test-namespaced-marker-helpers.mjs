#!/usr/bin/env node
// Unit tests for the generic namespaced-marker helpers added in rank-2 (PR
// for checkpoint-quartet). Sibling-of-PR-#271 lib-parity validation.
//
// Coverage:
//   - namespacedMarkerBasenameMatches  (G1-G14)
//   - namespacedMarkerBasenameForSession  (C1-C3)
//   - anyNamespacedMarkerExists  (E1-E6) — uses /tmp fixture dirs
//   - CHECKPOINT_QUARTET / CHECKPOINT_QUARTET_RE / isCheckpointQuartetBasename  (Q1-Q9)

import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  namespacedMarkerBasenameMatches,
  namespacedMarkerBasenameForSession,
  anyNamespacedMarkerExists,
  CHECKPOINT_QUARTET,
  CHECKPOINT_QUARTET_RE,
  isCheckpointQuartetBasename,
  NAMESPACED_MARKER_SUFFIX_MAXLEN,
} from '../scripts/lib/marker-paths.mjs'

let pass = 0
let fail = 0
const failures = []

function assert(label, cond) {
  if (cond) { pass++; return }
  fail++
  failures.push(label)
}

// ---------------------------------------------------------------------------
// G1-G14: namespacedMarkerBasenameMatches
// ---------------------------------------------------------------------------
assert('G1 legacy literal matches',
  namespacedMarkerBasenameMatches('.checkpoint-required', '.checkpoint-required'))

assert('G2 simple sid matches',
  namespacedMarkerBasenameMatches('.checkpoint-required', '.checkpoint-required.abc123'))

assert('G3 uuid-shape sid matches',
  namespacedMarkerBasenameMatches('.checkpoint-required',
    '.checkpoint-required.eff2d836-5d8e-4750-908a-f2ae14852d57'))

assert('G4 sid with underscores matches',
  namespacedMarkerBasenameMatches('.checkpoint-required', '.checkpoint-required.sid_v2'))

assert('G5 wrong legacy rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required', '.post-checkpoint-required'))

assert('G6 wrong legacy with sid rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required', '.post-checkpoint-required.abc'))

assert('G7 suffix without dot rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required', '.checkpoint-required-extra'))

assert('G8 empty suffix rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required', '.checkpoint-required.'))

assert('G9 slash in suffix rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required', '.checkpoint-required.foo/bar'))

assert('G10 dot in suffix rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required', '.checkpoint-required..extra'))

assert('G11 oversize suffix rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required',
    '.checkpoint-required.' + 'a'.repeat(NAMESPACED_MARKER_SUFFIX_MAXLEN + 1)))

assert('G12 exact-maxlen suffix accepts',
  namespacedMarkerBasenameMatches('.checkpoint-required',
    '.checkpoint-required.' + 'a'.repeat(NAMESPACED_MARKER_SUFFIX_MAXLEN)))

assert('G13 null candidate rejects',
  !namespacedMarkerBasenameMatches('.checkpoint-required', null))

assert('G14 non-string legacy rejects',
  !namespacedMarkerBasenameMatches(null, '.checkpoint-required.abc'))

// ---------------------------------------------------------------------------
// C1-C3: namespacedMarkerBasenameForSession
// ---------------------------------------------------------------------------
assert('C1 compose simple',
  namespacedMarkerBasenameForSession('.checkpoint-required', 'abc') === '.checkpoint-required.abc')

assert('C2 compose uuid',
  namespacedMarkerBasenameForSession('.post-checkpoint-done', 'eff2d836-5d8e-4750-908a-f2ae14852d57')
    === '.post-checkpoint-done.eff2d836-5d8e-4750-908a-f2ae14852d57')

assert('C3 compose roundtrips through matcher',
  namespacedMarkerBasenameMatches(
    '.pre-checkpoint-done',
    namespacedMarkerBasenameForSession('.pre-checkpoint-done', 'sid-1')))

// ---------------------------------------------------------------------------
// E1-E6: anyNamespacedMarkerExists  (fs fixtures)
// ---------------------------------------------------------------------------
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rank2-marker-test-'))
fs.mkdirSync(path.join(fixtureRoot, '.checkpoints'), { recursive: true })
fs.mkdirSync(path.join(fixtureRoot, '.claude'), { recursive: true })

assert('E1 missing returns false',
  anyNamespacedMarkerExists(fixtureRoot, '.checkpoint-required') === false)

fs.writeFileSync(path.join(fixtureRoot, '.checkpoints', '.checkpoint-required'), '')
assert('E2 legacy literal at primary detected',
  anyNamespacedMarkerExists(fixtureRoot, '.checkpoint-required') === true)

fs.rmSync(path.join(fixtureRoot, '.checkpoints', '.checkpoint-required'))
fs.writeFileSync(path.join(fixtureRoot, '.claude', '.checkpoint-required'), '')
assert('E3 legacy literal at legacy root detected',
  anyNamespacedMarkerExists(fixtureRoot, '.checkpoint-required') === true)

fs.rmSync(path.join(fixtureRoot, '.claude', '.checkpoint-required'))
fs.writeFileSync(path.join(fixtureRoot, '.checkpoints', '.checkpoint-required.sid123'), '')
assert('E4 suffixed at primary detected',
  anyNamespacedMarkerExists(fixtureRoot, '.checkpoint-required') === true)

// E5 — non-strict basename in same dir does not cause false-positives.
// Write a file whose basename starts with the prefix but fails the strict
// matcher (oversize suffix). The legit .sid123 marker is still detected.
fs.writeFileSync(
  path.join(fixtureRoot, '.checkpoints',
    '.checkpoint-required.' + 'x'.repeat(NAMESPACED_MARKER_SUFFIX_MAXLEN + 5)),
  '')
assert('E5 non-strict-suffix sibling does not affect legitimate detection',
  anyNamespacedMarkerExists(fixtureRoot, '.checkpoint-required') === true)

fs.rmSync(path.join(fixtureRoot, '.checkpoints', '.checkpoint-required.sid123'))
fs.writeFileSync(path.join(fixtureRoot, '.checkpoints', '.checkpoint-required-extra'), '')
assert('E6 hyphen-suffix non-strict basename does NOT match',
  anyNamespacedMarkerExists(fixtureRoot, '.checkpoint-required') === false)

fs.rmSync(fixtureRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// Q1-Q9: CHECKPOINT_QUARTET + isCheckpointQuartetBasename
// ---------------------------------------------------------------------------
assert('Q1 quartet has 4 members', CHECKPOINT_QUARTET.length === 4)

assert('Q2 quartet is frozen',
  Object.isFrozen(CHECKPOINT_QUARTET))

assert('Q3 RE matches all 4 legacy',
  CHECKPOINT_QUARTET.every(m => CHECKPOINT_QUARTET_RE.test(m)))

assert('Q4 RE matches all 4 suffixed',
  CHECKPOINT_QUARTET.every(m => CHECKPOINT_QUARTET_RE.test(`${m}.abc-123`)))

assert('Q5 RE rejects plan-marker',
  !CHECKPOINT_QUARTET_RE.test('.plan-approval-pending'))

assert('Q6 RE rejects preflight-marker',
  !CHECKPOINT_QUARTET_RE.test('.preflight-done'))

assert('Q7 RE rejects baseline',
  !CHECKPOINT_QUARTET_RE.test('.session-baseline'))

assert('Q8 isCheckpointQuartetBasename accepts all forms',
  isCheckpointQuartetBasename('.pre-checkpoint-done.eff2d836') &&
  isCheckpointQuartetBasename('.post-checkpoint-required') &&
  isCheckpointQuartetBasename('.checkpoint-required'))

assert('Q9 isCheckpointQuartetBasename rejects neighbors',
  !isCheckpointQuartetBasename('.checkpoint-required-extra') &&
  !isCheckpointQuartetBasename('.checkpoint-required.') &&
  !isCheckpointQuartetBasename(null))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(JSON.stringify({
  pass,
  fail,
  total: pass + fail,
  failures,
}, null, 2))

process.exit(fail === 0 ? 0 : 1)
