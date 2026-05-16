#!/usr/bin/env node
/**
 * test-validate-rfc-contract-mirror.mjs — Slice 2c CI gate tests.
 *
 * Coverage:
 *   - happy path: contract.json matches code → exit 0
 *   - drift: canonical-fields field added in code but not contract
 *   - drift: canonical-fields field removed from code still in contract
 *   - drift: subtype missing from code
 *   - drift: v2 state in contract not in VALID_V2_STATES
 *   - drift: v2 state in code not in contract
 *   - drift: missing subcommand keyword in orchestrator
 *   - drift: missing required flag in orchestrator
 *   - drift: C3 state↔subtype consistency (v2 state without matching subtype)
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-rfc-contract-mirror.mjs')
const REAL_CONTRACT = path.join(REPO_ROOT, 'docs', 'rfcs', 'RFC-004-bp1-auto-pilot.contract.json')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function mkRepoFixture() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-contract-validator-')))
  // Layout mirrors real repo: scripts/, scripts/lib/, docs/rfcs/.
  fs.mkdirSync(path.join(tmp, 'scripts', 'lib'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'docs', 'rfcs'), { recursive: true })
  // Symlink the real validator into the fixture so the script path resolves
  // its DEFAULT_REPO relative to the fixture. We pass --repo explicitly anyway.
  // Copy a stub canonicalize + run-state with hard-coded values to avoid
  // pulling the whole module tree.
  fs.writeFileSync(path.join(tmp, 'scripts', 'lib', 'bp1-canonicalize.mjs'),
    'export const TYPE_SPECIFIC_CANONICAL_FIELDS = Object.freeze({\n' +
    '  "state-transition:rfc-detected": Object.freeze(["state", "rfc_id", "frontmatter_sha256"]),\n' +
    '  "state-transition:classifier-dispatch-pending": Object.freeze(["state", "input_sha256"]),\n' +
    '  "state-transition:classified": Object.freeze(["state", "decided_class", "classifier_confidence"]),\n' +
    '  "state-transition:planning": Object.freeze(["state", "source_class"]),\n' +
    '  "state-transition:needs-human": Object.freeze(["state", "reason", "decided_class"]),\n' +
    '  "failure:classifier-schema-violation": Object.freeze(["failure_kind", "field_name", "observed_value", "violation_reason"]),\n' +
    '})\n')
  fs.writeFileSync(path.join(tmp, 'scripts', 'lib', 'bp1-run-state.mjs'),
    'export const VALID_V2_STATES = Object.freeze([\n' +
    '  "active", "rfc-detected", "classifier-dispatch-pending", "classified",\n' +
    '  "planning", "needs-human", "complete", "aborted", "abandoned", "archived",\n' +
    '])\n')
  // Stub orchestrator with all 3 subcommand keywords + required flags.
  fs.writeFileSync(path.join(tmp, 'scripts', 'bp1-orchestrator.mjs'),
    "// stub for validator test\n" +
    "const SUBCOMMANDS = ['init-run', 'finalize-run', 'detect-rfcs', 'record-classifier-dispatch-pre', 'record-classification']\n" +
    "const FLAGS = ['--project', '--rfc-id', '--run-id', '--input-sha256', '--pre-episode-id', '--result-file']\n")
  return tmp
}

function writeContract(repoRoot, contract) {
  fs.writeFileSync(path.join(repoRoot, 'docs', 'rfcs', 'RFC-004-bp1-auto-pilot.contract.json'),
    JSON.stringify(contract, null, 2) + '\n')
}

function happyContract() {
  return {
    version: 'v3.14',
    episode_canonical_fields: {
      'state-transition:rfc-detected': ['state', 'rfc_id', 'frontmatter_sha256'],
      'state-transition:classifier-dispatch-pending': ['state', 'input_sha256'],
      'state-transition:classified': ['state', 'decided_class', 'classifier_confidence'],
      'state-transition:planning': ['state', 'source_class'],
      'state-transition:needs-human': ['state', 'reason', 'decided_class'],
      'failure:classifier-schema-violation': ['failure_kind', 'field_name', 'observed_value', 'violation_reason'],
    },
    run_state_schemas: {
      v1: { states: ['active', 'complete', 'aborted', 'abandoned', 'archived'], fields: [] },
      v2: {
        states: ['active', 'rfc-detected', 'classifier-dispatch-pending', 'classified', 'planning', 'needs-human', 'complete', 'aborted', 'abandoned', 'archived'],
        fields: [],
      },
    },
    subcommand_contracts: {
      'detect-rfcs': { required_args: ['--project'], exit_codes: {} },
      'record-classifier-dispatch-pre': { required_args: ['--project', '--run-id', '--input-sha256'], exit_codes: {} },
      'record-classification': { required_args: ['--project', '--run-id', '--pre-episode-id', '--result-file'], exit_codes: {} },
    },
  }
}

function run(repoRoot) {
  const r = spawnSync('node', [VALIDATOR, '--repo', repoRoot], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

// =============================================================================
// CV1: happy path
// =============================================================================
tap('CV1 happy path — fixture matches contract → exit 0', () => {
  const repo = mkRepoFixture()
  writeContract(repo, happyContract())
  const r = run(repo)
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`)
})

// =============================================================================
// CV2: drift — code declares a slice-2c subtype not in contract
// =============================================================================
tap('CV2 drift: code declares slice-2c subtype not in contract', () => {
  const repo = mkRepoFixture()
  const c = happyContract()
  delete c.episode_canonical_fields['state-transition:planning']
  // c also has a "planning" state but no matching subtype → triggers BOTH
  // (a) reverse canonical-fields drift AND (b) C3 state-subtype consistency.
  writeContract(repo, c)
  const r = run(repo)
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.errors.some(e => e.includes('state-transition:planning')))
})

// =============================================================================
// CV3: drift — contract declares subtype not in code
// =============================================================================
tap('CV3 drift: contract declares subtype absent from code', () => {
  const repo = mkRepoFixture()
  const c = happyContract()
  c.episode_canonical_fields['state-transition:phantom'] = ['state']
  writeContract(repo, c)
  const r = run(repo)
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.errors.some(e => e.includes('state-transition:phantom')))
})

// =============================================================================
// CV4: drift — field mismatch within a subtype
// =============================================================================
tap('CV4 drift: subtype field added in contract but absent in code', () => {
  const repo = mkRepoFixture()
  const c = happyContract()
  c.episode_canonical_fields['state-transition:rfc-detected'].push('extra_field')
  writeContract(repo, c)
  const r = run(repo)
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.errors.some(e => e.includes('extra_field')))
})

// =============================================================================
// CV5: drift — v2 state in contract not in code
// =============================================================================
tap('CV5 drift: v2 state in contract not in VALID_V2_STATES', () => {
  const repo = mkRepoFixture()
  const c = happyContract()
  c.run_state_schemas.v2.states.push('not-a-real-state')
  // Also add matching subtype so we don't trip the C3 check first.
  c.episode_canonical_fields['state-transition:not-a-real-state'] = ['state']
  writeContract(repo, c)
  const r = run(repo)
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.errors.some(e => e.includes('not-a-real-state')))
})

// =============================================================================
// CV6: drift — missing subcommand keyword in orchestrator
// =============================================================================
tap('CV6 drift: orchestrator missing subcommand keyword', () => {
  const repo = mkRepoFixture()
  // Strip "detect-rfcs" keyword from orchestrator.
  const orch = fs.readFileSync(path.join(repo, 'scripts', 'bp1-orchestrator.mjs'), 'utf8')
  fs.writeFileSync(path.join(repo, 'scripts', 'bp1-orchestrator.mjs'), orch.replace("'detect-rfcs', ", ''))
  writeContract(repo, happyContract())
  const r = run(repo)
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.errors.some(e => e.includes('detect-rfcs')))
})

// =============================================================================
// CV7: drift — missing required flag in orchestrator
// =============================================================================
tap('CV7 drift: orchestrator missing required flag', () => {
  const repo = mkRepoFixture()
  const orch = fs.readFileSync(path.join(repo, 'scripts', 'bp1-orchestrator.mjs'), 'utf8')
  fs.writeFileSync(path.join(repo, 'scripts', 'bp1-orchestrator.mjs'), orch.replace("'--pre-episode-id', ", ''))
  writeContract(repo, happyContract())
  const r = run(repo)
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.errors.some(e => e.includes('--pre-episode-id')))
})

// =============================================================================
// CV8: drift — C3 state-subtype consistency
// =============================================================================
tap('CV8 C3 drift: v2 state without matching state-transition:<state> subtype', () => {
  const repo = mkRepoFixture()
  const c = happyContract()
  // Add a v2 state that has no matching canonical-fields subtype.
  c.run_state_schemas.v2.states.push('mystery-state')
  // Update code stub to declare the new state too (so v2-states check passes).
  const rs = fs.readFileSync(path.join(repo, 'scripts', 'lib', 'bp1-run-state.mjs'), 'utf8')
  fs.writeFileSync(path.join(repo, 'scripts', 'lib', 'bp1-run-state.mjs'),
    rs.replace('"archived",', '"archived", "mystery-state",'))
  writeContract(repo, c)
  const r = run(repo)
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.ok(out.errors.some(e => e.includes('state-subtype-consistency') && e.includes('mystery-state')))
})

// =============================================================================
// CV9: real-repo sanity — validator runs against the real contract.json
// (skipped if real orchestrator doesn't yet have new subcommands — task #7)
// =============================================================================
tap('CV9 real-repo: validator runs against the real contract.json', () => {
  // We only assert that the real contract.json exists + parses; pass/fail
  // depends on task #7 being complete. This test exercises argv handling.
  assert.ok(fs.existsSync(REAL_CONTRACT))
  const r = spawnSync('node', [VALIDATOR], { encoding: 'utf8' })
  // Either pass (after task #7) or specific drift exit; never crash (exit 2).
  assert.notEqual(r.status, 2, `validator crashed: ${r.stderr}`)
})

console.log(`\n# ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
