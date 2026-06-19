#!/usr/bin/env node
/**
 * test-activation-scoping-e2e.mjs — RFC-008 P4d Slice S1.
 *
 * Mock-project E2E proving the SUBSTRATE is already hook-independent on
 * current code (RQ3): a core install ships the em-* substrate + activation-
 * gated BP-1 hygiene with ZERO enforcement gates, and every em-* round-trip
 * works with no enforcement hook present.
 *
 * This file is GREEN ON TODAY'S CODE — it is the foundation every later slice
 * (S2 project-scoped --install-enforcement, S3 dep-class fix, S4 switch, …)
 * asserts against. It does NOT yet exercise --install-enforcement (S2's flag).
 *
 * Contracts:
 *   A0  core install → exit 0, "Done!"
 *   A1g global settings.json carries ZERO enforcement gates (file absent)
 *   A1p project settings.json carries ZERO enforcement gates; SessionStart
 *       holds ONLY the two BP-1 hygiene hooks (activation-gated)
 *   A2  substrate scripts deployed under <home>/.episodic-memory/scripts
 *   A3  BP-1 SessionStart hook runs + exits 0 silently when not activated
 *       (substrate present but inert) — exercises runHook
 *   C1  em-store (local) → ok, file under <project>/.episodic-memory
 *   C2  em-search (local, by tag) → finds it
 *   C3  em-revise (local) → supersedes the original
 *   C4  em-rebuild-index (local) → ok
 *   C5  em-list → revised present with supersedes set
 *   C6  em-recall → revised surfaces, original suppressed, no preflight warnings
 *   C7  em-store/search (global) → ok, file under <home>/.episodic-memory
 *
 * Zero deps. Node assert + the activation-scoping fixture lib.
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'
import {
  mkMock, runInstall, runScript, runHook, readSettings,
  hasEnforcementHook, enforcementHookCommands, flattenHookCommands, deployedScript,
} from './lib/activation-scoping-harness.mjs'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

console.log('# test-activation-scoping-e2e (RFC-008 P4d S1)')

// ---------------------------------------------------------------------------
// Single shared core install — exercised by both the A and C contract groups.
// ---------------------------------------------------------------------------
const M = mkMock('s1')
const install = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd })

console.log('\n## A — install hook-scoping baseline (core install, no --install-hooks)')

test('A0: core install exits 0 with Done!', () => {
  assert.strictEqual(install.status, 0,
    `expected exit 0; got ${install.status}; stderr=${install.stderr}`)
  assert.ok(install.stdout.includes('Done!'),
    `expected "Done!"; stdout tail: ${install.stdout.slice(-200)}`)
})

test('A1g: global settings.json carries ZERO enforcement gates', () => {
  const g = readSettings('global', M)
  // Core install must not even create a global settings.json.
  assert.strictEqual(g, null,
    `core install must not write global settings.json; found: ${JSON.stringify(g)}`)
  assert.strictEqual(hasEnforcementHook(g), false)
})

test('A1p: project settings.json has ZERO enforcement gates; only BP-1 SessionStart', () => {
  const p = readSettings('project', M)
  assert.ok(p, 'project settings.json must exist after core install')
  assert.strictEqual(hasEnforcementHook(p), false,
    `enforcement gates leaked into project scope: ${enforcementHookCommands(p).join(', ')}`)
  // Only SessionStart is wired, and only the two BP-1 hygiene hooks.
  assert.deepStrictEqual(Object.keys(p.hooks), ['SessionStart'],
    `core install must wire only SessionStart; got events: ${Object.keys(p.hooks)}`)
  const cmds = flattenHookCommands(p)
  assert.strictEqual(cmds.length, 2, `expected exactly 2 BP-1 hooks; got: ${cmds.join(', ')}`)
  assert.ok(cmds.some((c) => c.includes('bp1-approval-check.sh')), 'BP-1 H1 must be wired')
  assert.ok(cmds.some((c) => c.includes('bp1-sweep-on-session.sh')), 'BP-1 H2 must be wired')
  // No PreToolUse / Stop / SessionEnd enforcement surfaces.
  assert.ok(!('PreToolUse' in p.hooks), 'no PreToolUse gates in a core install')
  assert.ok(!('Stop' in p.hooks), 'no Stop gate in a core install')
  assert.ok(!('SessionEnd' in p.hooks), 'no SessionEnd prompt in a core install')
})

test('A2: substrate scripts deployed under <home>/.episodic-memory/scripts', () => {
  for (const s of ['em-store.mjs', 'em-search.mjs', 'em-recall.mjs', 'em-list.mjs',
    'em-revise.mjs', 'em-rebuild-index.mjs']) {
    assert.ok(fs.existsSync(deployedScript(M.home, s)), `missing deployed substrate script: ${s}`)
  }
})

test('A3: BP-1 SessionStart hook runs + exits 0 silently when not activated', () => {
  const hook = path.join(M.project, '.claude', 'hooks', 'bp1-approval-check.sh')
  assert.ok(fs.existsSync(hook), 'BP-1 H1 hook must be deployed project-scoped')
  const r = runHook(hook,
    { hook_event_name: 'SessionStart', session_id: 's1', cwd: M.project },
    { home: M.home, project: M.project })
  assert.strictEqual(r.status, 0, `BP-1 hook must exit 0 when not activated; stderr=${r.stderr}`)
})

console.log('\n## C — substrate round-trips with ZERO enforcement hooks (RQ3)')

let originalId = null
let revisedId = null

test('C1: em-store (local) → ok, file under <project>/.episodic-memory', () => {
  const r = runScript(M.home, 'em-store.mjs', [
    '--project', 'mock', '--category', 'decision', '--tag', 's1rt',
    '--summary', 's1 round-trip', '--body', 'substrate works hook-free',
    '--scope', 'local',
  ], { cwd: M.project })
  assert.ok(r.json && r.json.status === 'ok', `em-store failed: ${r.stdout} ${r.stderr}`)
  originalId = r.json.id
  assert.ok(r.json.file.startsWith(path.join(M.project, '.episodic-memory')),
    `local episode must land under the mock project; got ${r.json.file}`)
})

test('C2: em-search (local, by tag) → finds the stored episode', () => {
  const r = runScript(M.home, 'em-search.mjs', [
    '--project', 'mock', '--tag', 's1rt', '--scope', 'local', '--no-track',
  ], { cwd: M.project })
  assert.ok(r.json && r.json.status === 'ok', `em-search failed: ${r.stdout} ${r.stderr}`)
  assert.ok(r.json.count >= 1, `expected >=1 hit; got ${r.json.count}`)
  assert.ok(r.json.episodes.some((e) => e.id === originalId), 'stored episode must be found')
})

test('C3: em-revise (local) → supersedes the original', () => {
  const r = runScript(M.home, 'em-revise.mjs', [
    '--original', originalId, '--summary', 's1 revised', '--body', 'revision body',
    '--scope', 'local',
  ], { cwd: M.project })
  assert.ok(r.json && r.json.status === 'ok', `em-revise failed: ${r.stdout} ${r.stderr}`)
  assert.strictEqual(r.json.supersedes, originalId, 'revision must point at the original')
  revisedId = r.json.id
})

test('C4: em-rebuild-index (local) → ok', () => {
  const r = runScript(M.home, 'em-rebuild-index.mjs', ['--scope', 'local'], { cwd: M.project })
  assert.ok(r.json && r.json.status === 'ok', `em-rebuild-index failed: ${r.stdout} ${r.stderr}`)
})

test('C5: em-list → revised present with supersedes set', () => {
  const r = runScript(M.home, 'em-list.mjs', [], { cwd: M.project })
  assert.ok(r.json && r.json.status === 'ok', `em-list failed: ${r.stdout} ${r.stderr}`)
  const rev = r.json.episodes.find((e) => e.id === revisedId)
  assert.ok(rev, 'revised episode must be listed')
  assert.strictEqual(rev.supersedes, originalId, 'listed revision must carry supersedes')
})

test('C6: em-recall → revised surfaces, original suppressed, no preflight warnings', () => {
  const r = runScript(M.home, 'em-recall.mjs', [], { cwd: M.project })
  assert.ok(r.json && r.json.status === 'ok', `em-recall failed: ${r.stdout} ${r.stderr}`)
  const ids = r.json.episodes.map((e) => e.id)
  assert.ok(ids.includes(revisedId), 'revised episode must surface in recall')
  assert.ok(!ids.includes(originalId), 'superseded original must NOT surface')
  // Recall must produce no enforcement side-effects (purified substrate).
  assert.deepStrictEqual(r.json.preflight_warnings, [],
    `substrate recall must emit no preflight warnings; got ${JSON.stringify(r.json.preflight_warnings)}`)
})

test('C7: em-store/search (global) → ok, file under <home>/.episodic-memory', () => {
  const s = runScript(M.home, 'em-store.mjs', [
    '--project', 'mock', '--category', 'lesson', '--tag', 's1global',
    '--summary', 'global rt', '--body', 'global substrate', '--scope', 'global',
  ], { cwd: M.project })
  assert.ok(s.json && s.json.status === 'ok', `global em-store failed: ${s.stdout} ${s.stderr}`)
  assert.ok(s.json.file.startsWith(path.join(M.home, '.episodic-memory')),
    `global episode must land under <home>/.episodic-memory; got ${s.json.file}`)
  const q = runScript(M.home, 'em-search.mjs', [
    '--project', 'mock', '--tag', 's1global', '--scope', 'global', '--no-track',
  ], { cwd: M.project })
  assert.ok(q.json && q.json.status === 'ok' && q.json.count >= 1,
    `global em-search must find it; got ${q.stdout}`)
})

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
