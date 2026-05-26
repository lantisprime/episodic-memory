#!/usr/bin/env node
/**
 * test-tier0-overrides.mjs — PR #336 regression tests.
 *
 * Consolidates the smoke tests developed during the per-artifact codex
 * review series (files 4/8 + 5/8 + 6/8 + 7/8). Covers:
 *   - Lookup helper carve-out enforcement (inverted allowlist, hardcoded-
 *     mutator refusal, flag-prefixed-interpreter bypass class)
 *   - Persist helper policy (confidence threshold, user-correction
 *     protection, dedup, symlink-leaf scan refusal, broad-catch downgrade)
 *   - End-to-end flow (marker hit → auto-persist → Tier 0 hits next time)
 *
 * Each test cites the codex review round + finding that motivated it.
 */

import assert from 'assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync, execSync } from 'child_process'

const ROOT = path.resolve(new URL(import.meta.url).pathname, '..', '..')
const LOOKUP = path.join(ROOT, 'scripts', 'classifier-override-lookup.mjs')
const PERSIST = path.join(ROOT, 'scripts', 'classifier-override-persist.mjs')
const CORRECTION = path.join(ROOT, 'scripts', 'classify-correction.mjs')
const MARKER = path.join(ROOT, 'scripts', 'classifier-marker.mjs')
const SHELL_LIB = path.join(ROOT, 'hooks', 'lib', 'command-classifier.sh')

function mkrepo(name) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t0-${name}-`)))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  execSync('git init -q', { cwd: repo })
  return repo
}

function correction(repo, command, label, opts = {}) {
  return spawnSync(process.execPath, [
    CORRECTION,
    '--project-root', repo,
    '--caller-cwd', opts.callerCwd || repo,
    '--command', command,
    '--label', label,
    '--reason', opts.reason || 'test'
  ], { cwd: opts.cwd || repo, env: process.env, encoding: 'utf8' })
}

function lookup(repo, command, opts = {}) {
  return spawnSync(process.execPath, [
    LOOKUP,
    '--project-root', repo,
    '--caller-cwd', opts.callerCwd || repo,
    '--command', command
  ], { cwd: opts.cwd || repo, env: process.env, encoding: 'utf8' })
}

function persist(repo, command, label, confidence, sourceTag = 'llm-marker-autopersist', opts = {}) {
  return spawnSync(process.execPath, [
    PERSIST,
    '--project-root', repo,
    '--caller-cwd', opts.callerCwd || repo,
    '--command', command,
    '--label', label,
    '--confidence', String(confidence),
    '--source-tag', sourceTag
  ], { cwd: opts.cwd || repo, env: process.env, encoding: 'utf8' })
}

function readOverrides(repo) {
  const f = path.join(repo, '.episodic-memory', 'classifier-overrides.jsonl')
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

let pass = 0, fail = 0
const failures = []
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++ }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failures.push({ name, error: e.message }); fail++ }
}

console.log('\n=== Lookup helper carve-out tests ===')

test('T-LU-OVERRIDABLE-INTERPRETER: node scripts/foo.mjs override hits', () => {
  const r = mkrepo('overridable')
  correction(r, 'node scripts/foo.mjs --x', 'read_only')
  const out = lookup(r, 'node scripts/foo.mjs --x')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(out.status, 0)
  assert.strictEqual(j.status, 'hit')
  assert.strictEqual(j.label, 'read_only')
})

test('T-LU-OVERRIDE-EM-WFV: em-workflow-validate IS overridable (allowlisted)', () => {
  const r = mkrepo('em-wfv')
  correction(r, 'node scripts/em-workflow-validate.mjs', 'shared_write')
  const out = lookup(r, 'node scripts/em-workflow-validate.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.status, 'hit')
})

test('T-LU-CARVE-EM-STORE: em-store.mjs override REFUSED (codex R2 carve-out)', () => {
  const r = mkrepo('em-store')
  correction(r, 'node scripts/em-store.mjs --x', 'read_only')
  const out = lookup(r, 'node scripts/em-store.mjs --x')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(out.status, 1)
  assert.strictEqual(j.status, 'not-overridable')
  assert.strictEqual(j.reason, 'hardcoded-mutator')
})

test('T-LU-CARVE-EM-PRUNE: em-prune.mjs override REFUSED', () => {
  const r = mkrepo('em-prune')
  correction(r, 'node scripts/em-prune.mjs', 'read_only')
  const out = lookup(r, 'node scripts/em-prune.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'hardcoded-mutator')
})

test('T-LU-CARVE-EM-VIOLATION: em-violation.mjs override REFUSED', () => {
  const r = mkrepo('em-viol')
  correction(r, 'node scripts/em-violation.mjs', 'read_only')
  const out = lookup(r, 'node scripts/em-violation.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'hardcoded-mutator')
})

test('T-LU-CARVE-CLASSIFIER-MARKER: classifier-marker.mjs override REFUSED (own env-prefix discipline)', () => {
  const r = mkrepo('cm')
  correction(r, 'node scripts/classifier-marker.mjs --read --x', 'read_only')
  const out = lookup(r, 'node scripts/classifier-marker.mjs --read --x')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'helper-with-own-discipline')
})

test('T-LU-CARVE-NON-INTERPRETER: ls override REFUSED (no mislabel surface)', () => {
  const r = mkrepo('ls')
  fs.mkdirSync(path.join(r, '.episodic-memory'))
  fs.writeFileSync(path.join(r, '.episodic-memory', 'classifier-overrides.jsonl'),
    JSON.stringify({ schema: 1, cache_key: 'X', label: 'shared_write' }) + '\n')
  const out = lookup(r, 'ls -la')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'not-interpreter')
})

test('T-LU-BYPASS-REQUIRE: node --require ./x scripts/em-store.mjs REFUSED (codex file 4 R1 REJECT)', () => {
  const r = mkrepo('bypass-req')
  correction(r, 'node --require ./noop.js scripts/em-store.mjs --x', 'read_only')
  const out = lookup(r, 'node --require ./noop.js scripts/em-store.mjs --x')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'interpreter-flag-present')
})

test('T-LU-BYPASS-INSPECT: node --inspect scripts/em-prune.mjs REFUSED', () => {
  const r = mkrepo('bypass-inspect')
  correction(r, 'node --inspect scripts/em-prune.mjs', 'read_only')
  const out = lookup(r, 'node --inspect scripts/em-prune.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'interpreter-flag-present')
})

test('T-LU-NODE-E: node -e <expr> REFUSED (interpreter-flag-present)', () => {
  const r = mkrepo('node-e')
  correction(r, 'node -e console.log(1)', 'read_only')
  const out = lookup(r, 'node -e console.log(1)')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'interpreter-flag-present')
})

test('T-LU-MISS: no override staged → miss', () => {
  const r = mkrepo('miss')
  fs.mkdirSync(path.join(r, '.episodic-memory'))
  const out = lookup(r, 'node scripts/unstaged.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.status, 'miss')
})

test('T-LU-NO-EM-DIR: no .em dir → miss (not error)', () => {
  const r = mkrepo('no-em')
  const out = lookup(r, 'node scripts/foo.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.status, 'miss')
})

test('T-LU-ENV-PREFIX: FOO=bar node ... REFUSED', () => {
  const r = mkrepo('env-prefix')
  fs.mkdirSync(path.join(r, '.episodic-memory'))
  const out = lookup(r, 'FOO=bar node scripts/foo.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.reason, 'env-prefix-rejected')
})

test('T-LU-CROSS-REPO: --project-root != cwd-repo-root → exit 2', () => {
  const r1 = mkrepo('cross-a')
  const r2 = mkrepo('cross-b')
  const out = spawnSync(process.execPath, [
    LOOKUP,
    '--project-root', r2,
    '--caller-cwd', r2,
    '--command', 'node scripts/foo.mjs'
  ], { cwd: r1, env: process.env, encoding: 'utf8' })
  assert.strictEqual(out.status, 2)
  assert.ok(out.stderr.includes('cross-repo'))
})

console.log('\n=== Persist helper policy tests ===')

test('T-PP-HAPPY: confidence ≥ threshold + overridable → entry written silently', () => {
  const r = mkrepo('pp-happy')
  const out = persist(r, 'node scripts/foo.mjs', 'read_only', 0.9)
  assert.strictEqual(out.status, 0)
  assert.strictEqual(out.stdout, '')
  const entries = readOverrides(r)
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].label, 'read_only')
  assert.strictEqual(entries[0].created_by, 'llm-marker-autopersist')
})

test('T-PP-LOW-CONFIDENCE: confidence < threshold → silent skip', () => {
  const r = mkrepo('pp-low')
  const out = persist(r, 'node scripts/foo.mjs', 'read_only', 0.5)
  assert.strictEqual(out.status, 0)
  assert.strictEqual(readOverrides(r).length, 0)
})

test('T-PP-NOT-OVERRIDABLE-EM-STORE: hardcoded-mutator silent skip', () => {
  const r = mkrepo('pp-em-store')
  const out = persist(r, 'node scripts/em-store.mjs', 'read_only', 0.9)
  assert.strictEqual(out.status, 0)
  assert.strictEqual(readOverrides(r).length, 0)
})

test('T-PP-USER-CORRECTION-WINS: prior user correction → persist skip (NEVER shadow)', () => {
  const r = mkrepo('pp-uw')
  const cr = correction(r, 'node scripts/foo.mjs', 'shared_write')
  assert.strictEqual(cr.status, 0)
  const out = persist(r, 'node scripts/foo.mjs', 'read_only', 0.9)
  assert.strictEqual(out.status, 0)
  const entries = readOverrides(r)
  assert.strictEqual(entries.length, 1)
  assert.strictEqual(entries[0].created_by, 'user-correction')
})

test('T-PP-DEDUP: persist same command twice → only first entry remains', () => {
  const r = mkrepo('pp-dedup')
  persist(r, 'node scripts/foo.mjs', 'read_only', 0.9)
  persist(r, 'node scripts/foo.mjs', 'read_only', 0.9)
  assert.strictEqual(readOverrides(r).length, 1)
})

test('T-PP-SYMLINK-LEAF-CODEX-R1: foreign symlinked leaf MUST NOT suppress persist', () => {
  const r = mkrepo('pp-symlink')
  const sd = path.join(r, '.episodic-memory')
  fs.mkdirSync(sd)
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-symlink-outside-'))
  const foreign = path.join(outsideDir, 'poison.jsonl')
  fs.writeFileSync(foreign, JSON.stringify({
    schema: 1, cache_key: 'POISONED', label: 'unsafe_complex',
    created_by: 'user-correction', tuple: {}
  }) + '\n')
  fs.symlinkSync(foreign, path.join(sd, 'classifier-overrides.jsonl'))
  const out = persist(r, 'node scripts/foo.mjs', 'read_only', 0.9)
  // Security boundary: foreign content must be untouched
  const foreignContent = fs.readFileSync(foreign, 'utf8')
  assert.ok(!foreignContent.includes('read_only'), 'no data leak to foreign')
  assert.strictEqual(out.status, 2)  // O_NOFOLLOW refusal via appendLine
})

test('T-PP-BROAD-CATCH-CODEX-R2: symlinked .em in git repo → must NOT silent-skip', () => {
  const r = mkrepo('pp-broad-catch')
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-broad-catch-outside-'))
  fs.symlinkSync(outsideDir, path.join(r, '.episodic-memory'))
  const out = persist(r, 'node scripts/foo.mjs', 'read_only', 0.9)
  // Pre-fix: silent skip via broad-catch downgrade. Post-fix: hard failure.
  assert.notStrictEqual(out.status, 0)
  assert.ok(out.stderr.includes('symlink') || out.stderr.includes('refusing'),
    `expected symlink rejection; got: ${out.stderr}`)
})

test('T-PP-ENV-PREFIX: FOO=bar shape → silent skip', () => {
  const r = mkrepo('pp-env')
  const out = persist(r, 'FOO=bar node scripts/foo.mjs', 'read_only', 0.9)
  assert.strictEqual(out.status, 0)
  assert.strictEqual(readOverrides(r).length, 0)
})

test('T-PP-CROSS-REPO: --project-root mismatch → exit 2', () => {
  const r1 = mkrepo('pp-cross-a')
  const r2 = mkrepo('pp-cross-b')
  const out = spawnSync(process.execPath, [
    PERSIST,
    '--project-root', r2,
    '--caller-cwd', r2,
    '--command', 'node scripts/foo.mjs',
    '--label', 'read_only',
    '--confidence', '0.9',
    '--source-tag', 'llm-marker-autopersist'
  ], { cwd: r1, env: process.env, encoding: 'utf8' })
  assert.strictEqual(out.status, 2)
  assert.ok(out.stderr.includes('cross-repo'))
})

test('T-PP-NON-GIT-NO-STORE: non-git repo without pre-existing .em → silent skip', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't0-pp-nongit-')))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  // No git init
  const out = persist(repo, 'node scripts/foo.mjs', 'read_only', 0.9)
  assert.strictEqual(out.status, 0)
  assert.ok(!fs.existsSync(path.join(repo, '.episodic-memory')))
})

test('T-PP-INVALID-LABEL: bad label → exit 2', () => {
  const r = mkrepo('pp-bad-label')
  const out = persist(r, 'node scripts/foo.mjs', 'INVALID', 0.9)
  assert.strictEqual(out.status, 2)
})

test('T-PP-INVALID-SOURCE-TAG: bad source-tag → exit 2', () => {
  const r = mkrepo('pp-bad-tag')
  const out = spawnSync(process.execPath, [
    PERSIST,
    '--project-root', r, '--caller-cwd', r,
    '--command', 'node scripts/foo.mjs',
    '--label', 'read_only', '--confidence', '0.9',
    '--source-tag', 'forged-tag'
  ], { cwd: r, env: process.env, encoding: 'utf8' })
  assert.strictEqual(out.status, 2)
})

test('T-F1-RACE-LOOKUP-PRECEDENCE: user-correction wins over autopersist regardless of JSONL order', () => {
  // F-1 race fix v2 (codex PR-level R1 P1): instead of a racy post-append
  // rewrite, lookupProjectOverride enforces precedence at READ time:
  // ANY user-correction entry for a key beats ANY autopersist entry for
  // the same key, regardless of file order. This closes the race
  // deterministically without any rewrite hazard.
  //
  // Setup: autopersist entry written FIRST, user-correction SECOND (so
  // last-write-wins would pick the user-correction). That alone doesn't
  // test the precedence rule — we need the autopersist to be LATER, which
  // is exactly the race we're closing. Do both orders to prove order-
  // independence.

  // Order A: autopersist first, user-correction second.
  {
    const r = mkrepo('precedence-A')
    persist(r, 'node scripts/precA.mjs', 'shared_write', 0.95)
    correction(r, 'node scripts/precA.mjs', 'read_only', { reason: 'A-second' })
    const out = lookup(r, 'node scripts/precA.mjs')
    const j = JSON.parse(out.stdout.trim().split('\n').pop())
    assert.strictEqual(out.status, 0)
    assert.strictEqual(j.label, 'read_only', 'user-correction must win when written SECOND')
  }

  // Order B (the actual race-class): user-correction first, autopersist second.
  // The pre-fix lookup (last-write-wins) would serve the autopersist, masking
  // the user-correction. The post-fix precedence rule serves the user-correction.
  {
    const r = mkrepo('precedence-B')
    correction(r, 'node scripts/precB.mjs', 'read_only', { reason: 'B-first' })
    // Simulate the race: append an autopersist entry directly via the persist
    // helper. The pre-scan at step-7 normally catches user-correction-exists
    // and skips, so we bypass by manually appending an autopersist line to
    // simulate "autopersist landed during the user-correction's pre-scan
    // window" — codex's R1 race shape.
    const sd = path.join(r, '.episodic-memory')
    const tupleStr = JSON.stringify({
      project_root_canonical: fs.realpathSync(r),
      caller_cwd_or_rel: '.',
      normalized_command: 'node scripts/precB.mjs',
      executable_resolved: null,
      script_digest: null
    }, Object.keys({
      project_root_canonical: '', caller_cwd_or_rel: '', normalized_command: '',
      executable_resolved: '', script_digest: ''
    }).sort())
    // Read the existing user-correction's cache_key to keep the simulated
    // autopersist entry on the same key.
    const existing = readOverrides(r)
    assert.strictEqual(existing.length, 1)
    const key = existing[0].cache_key
    const autopersistEntry = {
      schema: 1, cache_key: key, tuple: existing[0].tuple,
      label: 'shared_write', confidence: 0.95, reason: 'simulated-race',
      created_at: new Date(Date.now() + 1000).toISOString(),
      created_by: 'llm-marker-autopersist'
    }
    fs.appendFileSync(path.join(sd, 'classifier-overrides.jsonl'),
      JSON.stringify(autopersistEntry) + '\n')

    const out = lookup(r, 'node scripts/precB.mjs')
    const j = JSON.parse(out.stdout.trim().split('\n').pop())
    assert.strictEqual(out.status, 0)
    assert.strictEqual(j.label, 'read_only',
      `user-correction must win even when autopersist is LAST in file order; got: ${JSON.stringify(j)}`)
  }
})

test('T-F1-PRESERVES-UNRELATED-ROWS: persist append leaves unrelated rows intact', () => {
  // Baseline append-only invariant: persist for a new command must not
  // touch rows for OTHER commands. Codex PR-level R2 P3 noted: this alone
  // would also pass against the old retract code (retract only rewrote
  // on same-key races). Paired with T-F1-NO-RETRACT-ON-SAME-KEY-RACE below
  // to lock the actual "no whole-file rewrite" invariant.
  const r = mkrepo('preserve-unrelated')
  for (let i = 0; i < 3; i++) {
    correction(r, `node scripts/diff-${i}.mjs`, 'read_only',
      { reason: `pre-existing-${i}` })
  }
  const before = readOverrides(r)
  assert.strictEqual(before.length, 3)
  persist(r, 'node scripts/new.mjs', 'shared_write', 0.95)
  const after = readOverrides(r)
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(after[i].cache_key, before[i].cache_key,
      `pre-existing entry ${i} was modified or reordered`)
  }
  assert.strictEqual(after.length, 4)
  assert.strictEqual(after[3].created_by, 'llm-marker-autopersist')
})

test('T-F1-NO-RETRACT-ON-SAME-KEY-RACE: same-key user-correction does NOT trigger any rewrite', () => {
  // Locks the actual codex PR-level R1 P1 invariant: even when a same-key
  // user-correction exists AFTER an autopersist landed (the race that the
  // OLD retract code targeted), persist MUST NOT rewrite the JSONL.
  //
  // Setup mirrors the race shape: (1) autopersist lands first; (2) a
  // user-correction is appended later for the SAME key (this is the
  // condition that triggered the old retract); (3) a SECOND persist call
  // fires (e.g., from a re-classify of the same command in another Bash
  // invocation). With the OLD retract code, step 3 would rewrite the file,
  // potentially clobbering any concurrent append. With the NEW code,
  // persist just calls appendLine (or skips via user-correction protection).
  //
  // We verify: between step 2 and step 3, plant a "concurrent" row for an
  // UNRELATED key. After step 3, the concurrent row MUST still exist.
  const r = mkrepo('no-retract-same-key')
  // (1) autopersist
  persist(r, 'node scripts/race-key.mjs', 'shared_write', 0.95)
  // (2) same-key user-correction (would trigger old retract on next persist)
  correction(r, 'node scripts/race-key.mjs', 'read_only', { reason: 'same-key-user' })
  // (2.5) plant a "concurrent" row for an unrelated key (simulates another
  //       process appending during the would-be retract's tmp+rename window)
  correction(r, 'node scripts/unrelated.mjs', 'shared_write', { reason: 'concurrent-append' })
  const before = readOverrides(r)
  assert.strictEqual(before.length, 3,
    `expected [autopersist, user-correction, concurrent]; got ${JSON.stringify(before)}`)
  // (3) re-fire persist for the same race-key command. Pre-fix: this would
  //     have triggered retract → rewrite [autopersist, user-correction,
  //     concurrent] minus autopersist = [user-correction, concurrent].
  //     Post-fix: persist sees user-correction at step 7 → silentSkip; no
  //     rewrite happens. JSONL is unchanged.
  persist(r, 'node scripts/race-key.mjs', 'shared_write', 0.95)
  const after = readOverrides(r)
  assert.strictEqual(after.length, 3,
    `JSONL changed unexpectedly; before=${JSON.stringify(before)}; after=${JSON.stringify(after)}`)
  // Concurrent row must still exist
  assert.ok(after.some(e => e.reason === 'concurrent-append'),
    'concurrent-append row was clobbered (regression: retract logic returned?)')
})

test('T-F1-MULTIPLE-USER-CORRECTIONS-LATEST-WINS: re-correction updates the served label', () => {
  // Documented behavior: multiple user-corrections for the same key are
  // allowed; last user-correction wins (loop overwrites the userCorrection
  // local). User can re-correct to update a stale entry.
  const r = mkrepo('multi-user-corr')
  correction(r, 'node scripts/foo.mjs', 'read_only', { reason: 'first' })
  correction(r, 'node scripts/foo.mjs', 'shared_write', { reason: 'second-overrides' })
  const out = lookup(r, 'node scripts/foo.mjs')
  const j = JSON.parse(out.stdout.trim().split('\n').pop())
  assert.strictEqual(j.label, 'shared_write')
  assert.strictEqual(j.reason, 'second-overrides')
})

test('T-F3-CLASSIFY-CORRECTION-ENV-PREFIX-REFUSED: write side refuses env-prefix shape', () => {
  // F-3 (negative-scenario-reviewer ACCEPT-with-FU): symmetric env-prefix
  // refusal on the WRITE side. The lookup + persist helpers already refuse
  // env-prefix; classify-correction.mjs now does too.
  const r = mkrepo('f3-env-prefix-write')
  const out = correction(r, 'FOO=bar node scripts/foo.mjs', 'read_only')
  assert.strictEqual(out.status, 2)
  assert.ok(out.stderr.includes('env-prefix'),
    `expected env-prefix refusal; got: ${out.stderr}`)
  // Verify no entry was written
  assert.strictEqual(readOverrides(r).length, 0)
})

console.log('\n=== End-to-end shell flow tests ===')

function runShell(script) {
  return execSync(`bash -c "${script.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    env: process.env
  })
}

test('T-E2E-MARKER-HIT-TRIGGERS-AUTOPERSIST: full pipeline (marker hit → persist → Tier 0 next)', () => {
  const r = mkrepo('e2e-pipe')
  const sid = 'test-session-e2e-pipeline'
  // Plant marker
  const wr = spawnSync(process.execPath, [
    MARKER, '--write',
    '--project-root', r, '--caller-cwd', r,
    '--command', 'node scripts/e2e-helper.mjs --arg',
    '--session-id', sid,
    '--label', 'read_only',
    '--confidence', '0.92',
    '--reason', 'e2e-test'
  ], { cwd: r, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' })
  assert.strictEqual(wr.status, 0, `marker write failed: ${wr.stderr}`)

  // First classify_command: marker hit + fire-and-forget auto-persist
  const sh1 = spawnSync('bash', ['-c',
    `source "${SHELL_LIB}" && cd "${r}" && classify_command "node scripts/e2e-helper.mjs --arg" "${r}"`
  ], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' })
  assert.ok(sh1.stdout.includes('read_only'), `first classify_command: ${sh1.stdout}`)
  assert.ok(sh1.stdout.includes('interpreter_marker_cache_hit'),
    `expected marker hit reason; got: ${sh1.stdout}`)

  // Wait briefly for fire-and-forget persist
  execSync('sleep 1')

  // Override file should exist with autopersist created_by
  const overrideFile = path.join(r, '.episodic-memory', 'classifier-overrides.jsonl')
  assert.ok(fs.existsSync(overrideFile), 'auto-persist override file not created')
  const rows = readOverrides(r)
  assert.ok(rows.some(e => e.created_by === 'llm-marker-autopersist'),
    `expected llm-marker-autopersist entry; got: ${JSON.stringify(rows)}`)

  // Second classify_command: Tier 0 serves it
  const sh2 = spawnSync('bash', ['-c',
    `source "${SHELL_LIB}" && cd "${r}" && classify_command "node scripts/e2e-helper.mjs --arg" "${r}"`
  ], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' })
  assert.ok(sh2.stdout.includes('tier0_project_override'),
    `expected Tier 0 hit on second call; got: ${sh2.stdout}`)
})

test('T-E2E-CALLER-CWD-DISTINCT-CODEX-FILE-6-R1: caller cwd != target_root, override hits', () => {
  const r = mkrepo('e2e-caller-cwd')
  const callerCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't0-e2e-caller-')))
  // Stage from $r with --caller-cwd pointing at unrelated dir
  correction(r, 'node /usr/bin/external-tool --x', 'read_only',
    { cwd: r, callerCwd })

  // Invoke classify_command from $callerCwd targeting $r
  const out = spawnSync('bash', ['-c',
    `source "${SHELL_LIB}" && cd "${callerCwd}" && classify_command "node /usr/bin/external-tool --x" "${r}"`
  ], { env: process.env, encoding: 'utf8' })
  assert.ok(out.stdout.includes('read_only'), `caller-cwd-distinct override missed: ${out.stdout}`)
  assert.ok(out.stdout.includes('tier0_project_override'), out.stdout)
})

test('T-E2E-STRUCTURAL-DENY-WINS: bash -c "node em-store" → unsafe_complex (Tier 0 cannot demote)', () => {
  const r = mkrepo('e2e-struct')
  // Even if user stages an override, structural deny at command-classifier.sh:1237
  // fires BEFORE Tier 0 at line 1448.
  correction(r, 'bash -c "node scripts/em-store.mjs"', 'read_only')
  const out = spawnSync('bash', ['-c',
    `source "${SHELL_LIB}" && cd "${r}" && classify_command 'bash -c "node scripts/em-store.mjs"' "${r}"`
  ], { env: process.env, encoding: 'utf8' })
  assert.ok(out.stdout.includes('unsafe_complex'),
    `structural deny must win; got: ${out.stdout}`)
})

test('T-E2E-EM-WORKFLOW-VALIDATE-RELABEL: read_only / interpreter_em_read', () => {
  const r = mkrepo('e2e-emwfv')
  const out = spawnSync('bash', ['-c',
    `source "${SHELL_LIB}" && cd "${r}" && classify_command "node scripts/em-workflow-validate.mjs" "${r}"`
  ], { env: process.env, encoding: 'utf8' })
  assert.ok(out.stdout.includes('read_only'), out.stdout)
  assert.ok(out.stdout.includes('interpreter_em_read'), out.stdout)
})

test('T-E2E-EM-STORE-MUTATOR-INTACT: node scripts/em-store.mjs → nonsrc_write (override carve-out)', () => {
  const r = mkrepo('e2e-em-store')
  correction(r, 'node scripts/em-store.mjs --x', 'read_only')  // should be REFUSED
  const out = spawnSync('bash', ['-c',
    `source "${SHELL_LIB}" && cd "${r}" && classify_command "node scripts/em-store.mjs --x" "${r}"`
  ], { env: process.env, encoding: 'utf8' })
  // PR-B2 (#351): em-store's hardcoded label moved shared_write → nonsrc_write
  // (it writes the episode store, not repo source). The CARVE-OUT invariant is
  // unchanged: the planted read_only override is still REFUSED — the classifier
  // returns em-store's hardcoded label, not the override's read_only.
  assert.ok(out.stdout.includes('nonsrc_write'), `mutator carve-out broken: ${out.stdout}`)
  assert.ok(out.stdout.includes('interpreter_em_write'), out.stdout)
})

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) {
  console.error('\nFailures:')
  for (const f of failures) console.error(`  ${f.name}: ${f.error}`)
  process.exit(1)
}
