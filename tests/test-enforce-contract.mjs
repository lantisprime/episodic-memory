#!/usr/bin/env node
// test-enforce-contract.mjs — RFC-008 P3b-1.
//
// enforce-contract.mjs `--gate stop` is a PURE RELOCATION of em-recall.mjs's
// `--gate stop` handler into the enforcement layer (R1 strong form). These tests
// pin two things:
//   (A) decideStop() — the relocated marker logic as a PURE function
//       (block / allow / carve-out / plan-pending / symlink-fail-closed / null-sid).
//   (B) PARITY — `enforce-contract --gate stop` is byte-identical to
//       `em-recall --gate stop` on stdout AND exit-code AND stderr (modulo the
//       script-name prefix) AND no-marker-side-effect. This is the R1 relocation
//       invariant; em-recall's --gate handler is deleted in P3d, so this suite is
//       the regression fixture that guards the migration until then.
//
// Negative-scenario-planner findings folded:
//   G-B: decideStop is pure (the 3 em-recall exits → returns); CLI is sole I/O.
//   G-A: stderr is in the parity tuple (the invalid-sid warning the hook's
//        2>/dev/null would otherwise hide).
//   G-C: this suite stages its OWN module imports (no piggyback on em-recall).
//   G-D: no-side-effect = before/after dir-entry set-equality.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

import { decideStop } from '../scripts/enforce-contract.mjs'
import {
  PRIMARY_MARKER_DIR,
  LEGACY_MARKER_DIR,
  BASELINE_NAME,
  PLAN_MARKER_LEGACY_BASENAME,
  primaryMarkerPath,
  legacyMarkerPath,
  writeMarkerPath,
  namespacedMarkerBasenameForSession,
} from '../scripts/lib/marker-paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const ENFORCE = path.join(REPO, 'scripts', 'enforce-contract.mjs')
const EM_RECALL = path.join(REPO, 'scripts', 'em-recall.mjs')

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function eq(name, actual, expected) {
  if (actual === expected) ok(name)
  else bad(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function truthy(name, v, detail) { if (v) ok(name); else bad(name, detail || 'expected truthy') }

// Non-git repo with both marker roots — for the pure decideStop() tests where we
// pass repoRoot explicitly (no resolveRepoRoot involved).
function mkRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-contract-'))
  fs.mkdirSync(path.join(repo, PRIMARY_MARKER_DIR), { recursive: true })
  fs.mkdirSync(path.join(repo, LEGACY_MARKER_DIR), { recursive: true })
  return repo
}
// Git repo with marker roots — for PARITY subprocess tests (both scripts call
// resolveRepoRoot() from cwd, which needs a git work tree to converge).
function mkGitRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-parity-'))
  execSync('git init -q -b main', { cwd: repo })
  execSync('git config user.email test@example.com', { cwd: repo })
  execSync('git config user.name test', { cwd: repo })
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n')
  execSync('git add . && git commit -q -m init', { cwd: repo, shell: '/bin/bash' })
  fs.mkdirSync(path.join(repo, PRIMARY_MARKER_DIR), { recursive: true })
  fs.mkdirSync(path.join(repo, LEGACY_MARKER_DIR), { recursive: true })
  return repo
}
function writeMarker(p, mtimeSec, content = '') {
  fs.writeFileSync(p, content)
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec)
}
// Snapshot the set of marker-dir entries (for the no-side-effect assertion).
function snapshotMarkers(repo) {
  const out = {}
  for (const dir of [PRIMARY_MARKER_DIR, LEGACY_MARKER_DIR]) {
    try { out[dir] = fs.readdirSync(path.join(repo, dir)).sort().join(',') }
    catch { out[dir] = '<none>' }
  }
  return JSON.stringify(out)
}

console.log('=== A: decideStop() pure-function unit cases ===')

// A1 — no markers → allow (null)
{
  const repo = mkRepo()
  eq('A1: no markers → null (allow)', decideStop({ repoRoot: repo, sid: null }), null)
}

// A2 — .checkpoint-required armed (no baseline) + no post-done → BLOCK
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 200)
  const d = decideStop({ repoRoot: repo, sid: null })
  truthy('A2: armed + no post-done + no baseline → block', d && d.decision === 'block', `got ${JSON.stringify(d)}`)
  if (d) eq('A2: block reason names the legacy-literal write path',
    d.reason.includes(writeMarkerPath(repo, '.post-checkpoint-done')), true)
}

// A3 — armed + post-checkpoint-done NON-EMPTY → allow (null)
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 200)
  writeMarker(primaryMarkerPath(repo, '.post-checkpoint-done'), 200, 'done block\n')
  eq('A3: armed + non-empty post-done → null (allow)', decideStop({ repoRoot: repo, sid: null }), null)
}

// A4 — carve-out applies (baseline newer than all signals) → allow (null)
{
  const repo = mkRepo()
  // baseline newest (300); checkpoint-required older (100) → carve-out applies.
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 300)
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 100)
  eq('A4: carve-out (baseline > signals) → null (allow)', decideStop({ repoRoot: repo, sid: null }), null)
}

// A5 — plan-pending ACTIVE (mtime > baseline) → deferral allow even when armed
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 100)
  writeMarker(primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME), 300) // active plan-pending
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 300)      // also armed mid-session
  eq('A5: active plan-pending > baseline → null (deferral allow)', decideStop({ repoRoot: repo, sid: null }), null)
}

// A6 — symlinked baseline → carve-out fails CLOSED → block (when armed + empty)
{
  const repo = mkRepo()
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 200)
  // baseline as a symlink → stopGateCarveOutApplies returns false (fail-closed).
  fs.symlinkSync('/nonexistent', primaryMarkerPath(repo, BASELINE_NAME))
  const d = decideStop({ repoRoot: repo, sid: null })
  truthy('A6: symlinked baseline + armed → block (fail-closed)', d && d.decision === 'block', `got ${JSON.stringify(d)}`)
}

// A7 — null sid → legacy-literal resolution (armed legacy literal) → block
{
  const repo = mkRepo()
  writeMarker(legacyMarkerPath(repo, '.checkpoint-required'), 200)
  const d = decideStop({ repoRoot: repo, sid: null })
  truthy('A7: null sid + legacy-literal armed → block', d && d.decision === 'block', `got ${JSON.stringify(d)}`)
}

// A8 — own-session suffixed marker → resolved; block reason uses suffixed path
{
  const repo = mkRepo()
  const sid = 'sess-a8'
  writeMarker(primaryMarkerPath(repo, namespacedMarkerBasenameForSession('.checkpoint-required', sid)), 200)
  const d = decideStop({ repoRoot: repo, sid })
  truthy('A8: own-session suffixed armed → block', d && d.decision === 'block', `got ${JSON.stringify(d)}`)
  if (d) eq('A8: block reason names the suffixed write path',
    d.reason.includes(writeMarkerPath(repo, namespacedMarkerBasenameForSession('.post-checkpoint-done', sid))), true)
}

console.log('')
console.log('=== B: parity vs em-recall --gate stop (stdout + exit + stderr + no-side-effect) ===')

// Run a script's `--gate stop` in a given cwd; returns {stdout, stderr, status}.
function runGate(script, cwd, extraArgs = []) {
  const r = spawnSync('node', [script, '--gate', 'stop', ...extraArgs], { cwd, encoding: 'utf8' })
  return { stdout: r.stdout, stderr: r.stderr, status: r.status }
}
// Normalize the only allowed stderr delta: the script-name prefix.
function normPrefix(s) {
  return s.replace(/^(em-recall|enforce-contract): /gm, '<script>: ')
}

// Each scenario seeds a git repo, runs BOTH scripts in the SAME repo cwd, asserts
// full parity. Scenarios cover allow / block / carve-out / plan-pending.
const PARITY_SCENARIOS = [
  { name: 'no-marker (allow)', seed: () => {}, args: [] },
  {
    name: 'armed-no-postdone (block)',
    seed: (repo) => writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 200),
    args: [],
  },
  {
    name: 'armed-nonempty-postdone (allow)',
    seed: (repo) => {
      writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 200)
      writeMarker(primaryMarkerPath(repo, '.post-checkpoint-done'), 200, 'done\n')
    },
    args: [],
  },
  {
    name: 'carve-out (allow)',
    seed: (repo) => {
      writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 300)
      writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 100)
    },
    args: [],
  },
  {
    name: 'active-plan-pending (deferral allow)',
    seed: (repo) => {
      writeMarker(primaryMarkerPath(repo, BASELINE_NAME), 100)
      writeMarker(primaryMarkerPath(repo, PLAN_MARKER_LEGACY_BASENAME), 300)
      writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 300)
    },
    args: [],
  },
  {
    name: 'sid-suffixed armed (block)',
    seed: (repo) => writeMarker(primaryMarkerPath(repo, namespacedMarkerBasenameForSession('.checkpoint-required', 'p-sid')), 200),
    args: ['--session-id', 'p-sid'],
  },
  {
    name: 'invalid sid → stderr warning (allow)',
    seed: () => {},
    args: ['--session-id', 'bad sid!!'],
  },
]

for (const sc of PARITY_SCENARIOS) {
  const repoA = mkGitRepo(); sc.seed(repoA)
  const repoB = mkGitRepo(); sc.seed(repoB)
  const before = snapshotMarkers(repoA)
  const a = runGate(EM_RECALL, repoA, sc.args)
  const b = runGate(ENFORCE, repoB, sc.args)
  const after = snapshotMarkers(repoA)

  // stdout parity. Block-reason paths differ only by the repo dir (repoA vs
  // repoB); normalize each repo's realpath out so the decision shape compares.
  const realA = fs.realpathSync(repoA)
  const realB = fs.realpathSync(repoB)
  const outA = a.stdout.split(realA).join('<REPO>')
  const outB = b.stdout.split(realB).join('<REPO>')
  eq(`B[${sc.name}]: stdout parity`, outB, outA)
  eq(`B[${sc.name}]: exit-code parity`, b.status, a.status)
  eq(`B[${sc.name}]: stderr parity (modulo prefix)`, normPrefix(b.stderr), normPrefix(a.stderr))
  eq(`B[${sc.name}]: no marker side-effect`, after, before)
}

console.log('')
console.log('=== C: CLI arg handling ===')

// C1 — missing/invalid --gate → error exit 1
{
  const r = spawnSync('node', [ENFORCE], { encoding: 'utf8' })
  eq('C1: no --gate → exit 1', r.status, 1)
  truthy('C1: no --gate → error JSON', /"status":\s*"error"/.test(r.stdout), `got ${r.stdout}`)
}
{
  const r = spawnSync('node', [ENFORCE, '--gate', 'bogus'], { encoding: 'utf8' })
  eq('C2: invalid --gate → exit 1', r.status, 1)
}

// C3 — invalid --session-id emits the warning to stderr (G-A), exits 0
{
  const repo = mkGitRepo()
  const r = spawnSync('node', [ENFORCE, '--gate', 'stop', '--session-id', 'bad sid!!'], { cwd: repo, encoding: 'utf8' })
  eq('C3: invalid sid → exit 0', r.status, 0)
  truthy('C3: invalid sid → stderr warning with enforce-contract prefix',
    /^enforce-contract: warn — --session-id "bad sid!!" failed/m.test(r.stderr), `got stderr: ${r.stderr}`)
}

// C4 — REGRESSION (P3b-1 fail-OPEN bug): the CLI invoked via a SYMLINKED path
// must still run its decision. The original `import.meta.url === pathToFileURL(
// argv[1])` isMain check failed when the install path had a symlink component
// (macOS /var→/private/var, /tmp→/private/tmp, a symlinked $HOME): import.meta.url
// is canonical while pathToFileURL(argv[1]) is not → isMain false → CLI no-op →
// stop gate degraded to ALLOW-ALWAYS. The realpath-both fix restores it. Caught
// by test-stop-gate.sh's /var/folders fixture during E2E; pinned here explicitly.
{
  const repo = mkGitRepo()
  writeMarker(primaryMarkerPath(repo, '.checkpoint-required'), 200) // armed, no post-done → must block
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-symlink-'))
  const linkedScripts = path.join(linkDir, 'scripts')
  fs.symlinkSync(path.join(REPO, 'scripts'), linkedScripts) // non-canonical path to the real script
  const r = spawnSync('node', [path.join(linkedScripts, 'enforce-contract.mjs'), '--gate', 'stop'], { cwd: repo, encoding: 'utf8' })
  truthy('C4: CLI via symlinked path → still blocks (isMain realpath-robust)',
    /"decision":\s*"block"/.test(r.stdout), `got stdout: [${r.stdout}] exit ${r.status}`)
}

console.log('')
if (fail === 0) {
  console.log(`PASS — ${pass} checks`)
  process.exit(0)
} else {
  console.log(`FAIL — ${fail} of ${pass + fail} checks failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
