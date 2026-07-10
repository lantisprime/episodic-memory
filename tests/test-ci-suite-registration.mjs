#!/usr/bin/env node
/**
 * test-ci-suite-registration.mjs - #504 class closure.
 *
 * The class lesson behind #504 (and PLAN-session-auto-capture convention 8):
 * CI runs explicitly listed test files, so an unlisted suite silently never
 * runs. Instance fixes (wiring suites one by one) leave the class open — this
 * lint closes it: every top-level tests/test-*.{mjs,sh} must be
 *
 *   (a) referenced by a .github/workflows/*.yml run step (comment lines are
 *       stripped first, so a commented-out step does not count as wired), OR
 *   (b) a member of the P12 invariant meta-runner (glob test-p12-*.mjs plus
 *       its EXPLICIT set — membership-in-code, Rule 14), OR
 *   (c) listed in the KNOWN_UNWIRED baseline below.
 *
 * The baseline is SHRINK-ONLY (a ratchet): it enumerates the suites that were
 * already unwired when this lint landed (2026-07-11, #504 audit). A baseline
 * entry that becomes wired must be deleted from the baseline (t_baseline_not_wired),
 * and an entry whose file is deleted must be deleted too (t_baseline_exists).
 * Adding a NEW suite to the baseline is a conscious reviewed edit of this
 * file, never the path of least resistance: a brand-new unwired suite fails
 * t_all_suites_registered by default.
 *
 * Zero deps. Node stdlib only.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const SELF_BASENAME = path.basename(SELF)
const testsDir = path.dirname(SELF)
const repoRoot = path.dirname(testsDir)
const workflowsDir = path.join(repoRoot, '.github', 'workflows')

// Suites known to be unwired when this lint landed (#504 audit, 2026-07-11).
// SHRINK-ONLY: entries may be removed (when wired or deleted), never added
// without review. Many are structurally CI-unsuitable (live seats, external
// codex/opencode binaries, network); wiring decisions stay per-suite.
const KNOWN_UNWIRED = [
  'test-bp1-approval-check-hook.mjs',
  'test-bp1-atomic.mjs',
  'test-bp1-check-deadlines.mjs',
  'test-bp1-crash-classify.mjs',
  'test-bp1-deadlines-lib.mjs',
  'test-bp1-emit-marker-invalid-evidence.mjs',
  'test-bp1-finalize-run.mjs',
  'test-bp1-flag-flip.mjs',
  'test-bp1-frontmatter.mjs',
  'test-bp1-hmac-manifest.mjs',
  'test-bp1-manifest-collect.mjs',
  'test-bp1-marker-validate.mjs',
  'test-bp1-marker.mjs',
  'test-bp1-orchestrator-286-race-and-crash.mjs',
  'test-bp1-orchestrator-287-rollback.mjs',
  'test-bp1-orchestrator-288-resume.mjs',
  'test-bp1-orchestrator-confirm-approval.mjs',
  'test-bp1-orchestrator-parseargs.mjs',
  'test-bp1-orchestrator-record-awaiting-approval.mjs',
  'test-bp1-orchestrator-sweep-naked-entries.mjs',
  'test-bp1-request-claim.mjs',
  'test-bp1-rfc-scan.mjs',
  'test-bp1-run-state-trylock.mjs',
  'test-bp1-state-lock.mjs',
  'test-bp1-sweep-loader.mjs',
  'test-canonicalize-path-tolerant.mjs',
  'test-checkpoint-marker.mjs',
  'test-classify-correction.mjs',
  'test-claude-subagent-env-propagation.mjs',
  'test-em-audit-compliance.mjs',
  'test-em-body-file.mjs',
  'test-em-help-flags.mjs',
  'test-em-local-dir-worktree.mjs',
  'test-em-mine-transcripts.mjs',
  'test-em-restore.mjs',
  'test-em-revise-scope-inherit.mjs',
  'test-em-sort-missing-datetime.mjs',
  'test-em-store-tag-flags.mjs',
  'test-em-watch-codex.mjs',
  'test-install-codex-skill.mjs',
  'test-install-opencode-pi-agent.mjs',
  'test-install-scripts-guide.mjs',
  'test-install-worktree-grant.mjs',
  'test-marker-paths.mjs',
  'test-marker-paths.sh',
  'test-marker-write-helper.mjs',
  'test-migration-sweep.mjs',
  'test-namespaced-marker-helpers.mjs',
  'test-namespaced-marker-helpers.sh',
  'test-opencode-enforcement-live-e2e.mjs',
  'test-p3-fixes.mjs',
  'test-phase2.mjs',
  'test-phase3.mjs',
  'test-preflight-gate-sid-parser.sh',
  'test-preflight-non-worsening.sh',
  'test-preflight-prompt-canon.mjs',
  'test-rfc002-phase1.mjs',
  'test-rfc002-phase2.mjs',
  'test-rfc002-phase3.mjs',
  'test-runbook-marker-checkpoint-gate.sh',
  'test-runbook-marker-classifier.sh',
  'test-script-identity-key.mjs',
  'test-second-opinion-audit-drift.mjs',
  'test-second-opinion-consensus-e2e.mjs',
  'test-second-opinion-consensus.mjs',
  'test-second-opinion-dispatch.mjs',
  'test-second-opinion-gate-runbook.mjs',
  'test-second-opinion-gate.mjs',
  'test-second-opinion-i22-algorithm-parity.mjs',
  'test-second-opinion-install-snapshot.mjs',
  'test-second-opinion-preamble.mjs',
  'test-second-opinion-providers.mjs',
  'test-second-opinion-storage.mjs',
  'test-seed-patterns.mjs',
  'test-session-end-quartet-cleanup.mjs',
  'test-session-handoff-cwd-matrix.sh',
  'test-so-gate-timeout-floor-integration.mjs',
  'test-so-gate-timeout-floor.mjs',
  'test-tier0-overrides.mjs',
  'test-transcript-walker.mjs',
  'test-validate-discipline-load-bundles.mjs',
  'test-workflow-validate.mjs',
  'test-worktree-marker-write.sh',
]

// --- derivation (kept as small pure helpers so the negative control can run
// --- the same predicate against synthetic input) --------------------------

function listSuites(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^test-.*\.(mjs|sh)$/.test(f))
    .sort()
}

// All workflow YAML with full-line comments stripped: a commented-out step
// must not count as wired.
function readWorkflowsText(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) =>
      fs
        .readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n'),
    )
    .join('\n')
}

// P12 meta-runner membership, re-derived the way the runner derives it
// (glob test-p12-*.mjs minus meta-runners) plus a textual match against its
// source for the EXPLICIT set (the names appear literally there).
const P12_RUNNER = 'test-p12-invariant-suite.mjs'
const p12Source = fs.readFileSync(path.join(testsDir, P12_RUNNER), 'utf8')

function isWired(basename, wfText) {
  if (wfText.includes(basename)) return true
  if (/^test-p12-.*\.mjs$/.test(basename) && !basename.includes('invariant-suite')) return true
  if (p12Source.includes(`'${basename}'`)) return true
  return false
}

function computeUnregistered(suites, wfText, baseline) {
  const base = new Set(baseline)
  return suites.filter((f) => !isWired(f, wfText) && !base.has(f))
}

const SUITES = listSuites(testsDir)
const WF_TEXT = readWorkflowsText(workflowsDir)

// --- test harness ----------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  + ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  x ${name}: ${e.message}`)
  }
}

console.log('# test-ci-suite-registration (#504 - every suite wired or baselined)')
console.log(`# suites: ${SUITES.length}, baseline: ${KNOWN_UNWIRED.length}`)

test('t_all_suites_registered: every tests/test-*.{mjs,sh} is wired in a workflow, run by the P12 meta-runner, or baselined', () => {
  const unregistered = computeUnregistered(SUITES, WF_TEXT, KNOWN_UNWIRED)
  assert.deepStrictEqual(
    unregistered,
    [],
    `unregistered suites (wire them into a workflow, or — with review — baseline them):\n  ${unregistered.join('\n  ')}`,
  )
})

test('t_baseline_not_wired: no baseline entry is wired (shrink-only ratchet — delete wired entries from KNOWN_UNWIRED)', () => {
  const wiredButBaselined = KNOWN_UNWIRED.filter((f) => isWired(f, WF_TEXT))
  assert.deepStrictEqual(
    wiredButBaselined,
    [],
    `now wired — remove from KNOWN_UNWIRED: ${wiredButBaselined.join(', ')}`,
  )
})

test('t_baseline_exists: every baseline entry exists on disk (delete stale entries)', () => {
  const missing = KNOWN_UNWIRED.filter((f) => !fs.existsSync(path.join(testsDir, f)))
  assert.deepStrictEqual(missing, [], `baseline entries with no file — remove: ${missing.join(', ')}`)
})

test('t_baseline_sorted_unique: baseline is sorted and duplicate-free (reviewable shrink diffs)', () => {
  assert.deepStrictEqual(KNOWN_UNWIRED, [...new Set(KNOWN_UNWIRED)].sort())
})

test('t_detection_sanity: a known-wired suite reads wired; this lint itself is wired; positive workflow signal exists', () => {
  // Guards the comment-stripper / reader against silently matching nothing.
  assert.ok(isWired('test-plan-marker.mjs', WF_TEXT), 'test-plan-marker.mjs must read as wired')
  // The P12 glob path must still short-circuit meta-runner members.
  assert.ok(isWired('test-p12-global-clean.mjs', WF_TEXT), 'P12 glob member must read as wired')
  // Rename drift: if this file is renamed without updating the workflow step,
  // fail here on the next local run.
  assert.ok(WF_TEXT.includes(SELF_BASENAME), `${SELF_BASENAME} must itself be wired in a workflow`)
})

test('t_negative_control: a synthetic unwired suite is reported unregistered (red path proves the predicate bites)', () => {
  const synthetic = 'test-synthetic-never-wired-504.mjs'
  assert.ok(!isWired(synthetic, WF_TEXT), 'synthetic name must not read as wired')
  const out = computeUnregistered([...SUITES, synthetic], WF_TEXT, KNOWN_UNWIRED)
  assert.deepStrictEqual(out, [synthetic])
})

console.log(`\n# ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
console.log('test-ci-suite-registration: PASS')
