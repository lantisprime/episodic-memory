#!/usr/bin/env node
// test-uninstall-enforcement.mjs — RFC-008 P4d S5 mock-project E2E for
// `install.mjs --uninstall-enforcement [--purge-config]`.
//
// Every test drives the REAL install.mjs (install then uninstall) against an
// isolated HOME + git mock project — no stubs, no hand-staged trees, no mental
// tracing (feedback_mock_project_test_not_mental_trace). Assertions inspect real
// files on disk (settings JSON read back, fs.existsSync, before/after snapshots).
//
// PRIMARY proof = t_uninstall_restores_core_state (REQ-12): in ONE project,
// core-install → snapshot → --install-enforcement → --uninstall-enforcement →
// re-snapshot; the after-state deep-equals the core baseline. That single
// invariant catches over-removal (bp1), under-removal (the .sh libs), and
// residual empty event keys / patterns+plugins dirs without trusting any
// hand-derived list.
//
// Zero deps beyond the harness + node stdlib.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert'
import { mkMock, runInstall, REPO_ROOT } from './lib/activation-scoping-harness.mjs'
import {
  bp1EntryScripts, bp1ClosureLibs, enforcementHookLibBasenames,
  enforcementEntryScripts,
} from '../scripts/lib/install-manifest.mjs'

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ✓ ${n}`) }
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}: ${d}`) }
// Run a named test, converting a thrown assertion into a single failure.
function test(name, fn) {
  try { fn(); } catch (e) { bad(name, e && e.message ? e.message : String(e)); }
}

const HOOKS = (p) => path.join(p, '.claude', 'hooks')
const LIB = (p) => path.join(HOOKS(p), 'lib')
const SETTINGS = (p) => path.join(p, '.claude', 'settings.json')
const SWITCH = (p) => path.join(p, '.episodic-memory', 'enforce-config.json')

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// Recursive relpath→sha256 map of a directory. EXCLUDE the named top-level files
// (settings.json is compared separately as a parsed object — R3-F1). Returns {}
// if root is absent.
function snapshotTree(root, excludeTopLevel = []) {
  const out = {}
  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && excludeTopLevel.includes(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs, r)
      else if (e.isSymbolicLink()) out[r] = `symlink:${fs.readlinkSync(abs)}`
      else out[r] = sha(abs)
    }
  }
  walk(root, '')
  return out
}

const readParsed = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null)

function installCore(M) {
  const r = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: [] })
  if (r.status !== 0) throw new Error(`core install failed: ${r.stderr}`)
  return r
}
function installEnforce(M) {
  const r = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-enforcement'] })
  if (r.status !== 0) throw new Error(`enforce install failed: ${r.stderr}`)
  return r
}
function uninstall(M, extra = []) {
  return runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--uninstall-enforcement', ...extra] })
}

// ── PRIMARY: core-state delta (REQ-12) ──────────────────────────────────────
test('t_uninstall_restores_core_state', () => {
  const M = mkMock('restore')
  installCore(M)
  const baseTree = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
  const baseSettings = readParsed(SETTINGS(M.project))
  installEnforce(M)
  const u = uninstall(M)
  if (u.status !== 0) throw new Error(`uninstall failed: ${u.stderr}`)
  const afterTree = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
  const afterSettings = readParsed(SETTINGS(M.project))
  assert.deepStrictEqual(afterTree, baseTree, 'PRIMARY: .claude tree (excl settings.json) must equal core baseline')
  assert.deepStrictEqual(afterSettings, baseSettings, 'PRIMARY: parsed settings.json must equal core baseline')
  ok('t_uninstall_restores_core_state — core+enforce+uninstall ≡ core (tree + settings)')
})

// ── registrations removed, incl. SessionEnd `node <abs>` (EC8) ──────────────
test('t_registrations_removed', () => {
  const M = mkMock('regs')
  installCore(M)
  installEnforce(M)
  uninstall(M)
  const s = readParsed(SETTINGS(M.project)) || { hooks: {} }
  const cmds = []
  for (const ev of Object.keys(s.hooks || {})) {
    for (const m of (s.hooks[ev] || [])) {
      for (const h of (m.hooks || [])) if (typeof h.command === 'string') cmds.push(h.command)
    }
  }
  const ENFORCE_BASENAMES = [
    'checkpoint-gate.sh', 'plan-gate.sh', 'preflight-gate.sh', 'stop-gate.sh',
    'em-recall-sessionstart.sh', 'session-handoff-prompt.sh', 'preflight-prompt-helper.sh',
    'em-session-end-prompt.mjs',
  ]
  const leaked = cmds.filter((c) => ENFORCE_BASENAMES.some((b) => c.includes(b)))
  assert.deepStrictEqual(leaked, [], `no enforcement registration may survive; leaked: ${leaked.join(', ')}`)
  // bp1 SessionStart entries must remain (core).
  assert.ok(cmds.some((c) => c.includes('bp1-sweep-on-session.sh')), 'bp1 SessionStart registration must survive')
  ok('t_registrations_removed — 0 enforcement entries incl. SessionEnd node entry; bp1 survives')
})

// ── files removed via real readdir; patterns/ + plugins/ dirs gone (F7/BL-B) ─
test('t_files_removed', () => {
  const M = mkMock('files')
  installCore(M)
  installEnforce(M)
  uninstall(M)
  const hookFiles = fs.existsSync(HOOKS(M.project)) ? fs.readdirSync(HOOKS(M.project)) : []
  const libFiles = fs.existsSync(LIB(M.project)) ? fs.readdirSync(LIB(M.project)) : []
  for (const f of ['checkpoint-gate.sh', 'plan-gate.sh', 'preflight-gate.sh', 'stop-gate.sh',
    'em-recall-sessionstart.sh', 'session-handoff-prompt.sh', 'preflight-prompt-helper.sh',
    'em-session-end-prompt.mjs', 'enforce-contract.mjs', 'classifier-marker.mjs']) {
    assert.ok(!hookFiles.includes(f), `enforcement file ${f} must be removed from hooks/`)
  }
  for (const f of enforcementHookLibBasenames(REPO_ROOT)) {
    assert.ok(!libFiles.includes(f), `enforcement .sh lib ${f} must be removed from hooks/lib/`)
  }
  assert.ok(!fs.existsSync(path.join(HOOKS(M.project), 'patterns')), 'hooks/patterns/ must be gone')
  assert.ok(!fs.existsSync(path.join(HOOKS(M.project), 'plugins')), 'hooks/plugins/ must be gone')
  ok('t_files_removed — gates/engine/.sh-libs gone (real readdir); patterns + plugins dirs removed')
})

// ── bp1 core set preserved (EC7) ────────────────────────────────────────────
test('t_bp1_preserved', () => {
  const M = mkMock('bp1')
  installCore(M)
  installEnforce(M)
  uninstall(M)
  for (const f of bp1EntryScripts(REPO_ROOT)) {
    assert.ok(fs.existsSync(path.join(HOOKS(M.project), f)), `bp1 entry script ${f} must survive`)
  }
  for (const f of bp1ClosureLibs(REPO_ROOT)) {
    assert.ok(fs.existsSync(path.join(LIB(M.project), f)), `bp1 closure lib ${f} must survive`)
  }
  assert.ok(fs.existsSync(path.join(HOOKS(M.project), 'bp1-sweep-on-session.sh')), 'bp1 H2 hook must survive')
  assert.ok(fs.existsSync(path.join(HOOKS(M.project), 'bp1-approval-check.sh')), 'bp1 H1 hook must survive (F4)')
  ok('t_bp1_preserved — bp1 entry scripts + closure libs + H1 + H2 hooks all survive')
})

// ── operator switch preserved by default ────────────────────────────────────
test('t_switch_preserved', () => {
  const M = mkMock('switch')
  installCore(M)
  installEnforce(M)
  const before = sha(SWITCH(M.project))
  uninstall(M)
  assert.ok(fs.existsSync(SWITCH(M.project)), 'enforce-config.json must remain after default uninstall')
  assert.strictEqual(sha(SWITCH(M.project)), before, 'enforce-config.json bytes must be unchanged')
  ok('t_switch_preserved — enforce-config.json present + byte-unchanged after default uninstall')
})

// ── --purge-config deletes the switch; absent-switch variant is a no-op ──────
test('t_purge_removes_switch', () => {
  const M = mkMock('purge')
  installCore(M)
  installEnforce(M)
  assert.ok(fs.existsSync(SWITCH(M.project)), 'precondition: switch seeded by enforce install')
  const u = uninstall(M, ['--purge-config'])
  assert.strictEqual(u.status, 0, `purge uninstall exit 0 (got ${u.status}: ${u.stderr})`)
  assert.ok(!fs.existsSync(SWITCH(M.project)), 'enforce-config.json must be deleted under --purge-config')
  // absent variant: a second purge run is a clean no-op.
  const u2 = uninstall(M, ['--purge-config'])
  assert.strictEqual(u2.status, 0, 'purge with switch already absent exits 0')
  ok('t_purge_removes_switch — switch deleted under --purge-config; absent variant is a no-op')
})

// ── never touches global scope (~/.claude + ~/.episodic-memory) ─────────────
test('t_no_global_touch', () => {
  const M = mkMock('global')
  installCore(M)
  installEnforce(M)
  const gClaudeBefore = snapshotTree(path.join(M.home, '.claude'))
  const gEmBefore = snapshotTree(path.join(M.home, '.episodic-memory'))
  uninstall(M)
  const gClaudeAfter = snapshotTree(path.join(M.home, '.claude'))
  const gEmAfter = snapshotTree(path.join(M.home, '.episodic-memory'))
  assert.deepStrictEqual(gClaudeAfter, gClaudeBefore, '~/.claude must be byte-identical before/after uninstall')
  assert.deepStrictEqual(gEmAfter, gEmBefore, '~/.episodic-memory must be byte-identical before/after uninstall')
  ok('t_no_global_touch — global ~/.claude + ~/.episodic-memory unchanged by uninstall')
})

// ── operator's own same-basename hook (resolves elsewhere) is preserved ─────
test('t_foreign_hook_preserved', () => {
  const M = mkMock('foreign')
  installCore(M)
  installEnforce(M)
  // Seed a FOREIGN stop-gate.sh outside the canonical hooks dir, with sentinel
  // content, and register it under the Stop event by its non-canonical path.
  const foreignDir = path.join(M.project, 'operator-hooks')
  fs.mkdirSync(foreignDir, { recursive: true })
  const foreignFile = path.join(foreignDir, 'stop-gate.sh')
  const SENTINEL = '#!/usr/bin/env bash\n# OPERATOR OWNED — DO NOT DELETE\necho operator\n'
  fs.writeFileSync(foreignFile, SENTINEL)
  const s = readParsed(SETTINGS(M.project))
  s.hooks.Stop = s.hooks.Stop || []
  s.hooks.Stop.push({ hooks: [{ type: 'command', command: foreignFile }] })
  fs.writeFileSync(SETTINGS(M.project), JSON.stringify(s, null, 2))
  uninstall(M)
  assert.ok(fs.existsSync(foreignFile), 'foreign stop-gate.sh file must survive')
  assert.strictEqual(fs.readFileSync(foreignFile, 'utf8'), SENTINEL, 'foreign file content (sentinel) must be intact')
  const after = readParsed(SETTINGS(M.project))
  const stopCmds = (after.hooks.Stop || []).flatMap((m) => (m.hooks || []).map((h) => h.command))
  assert.ok(stopCmds.includes(foreignFile), 'foreign Stop registration must survive')
  ok('t_foreign_hook_preserved — non-canonical same-basename hook + registration survive (sentinel intact)')
})

// ── idempotent: nothing-installed run + double run = exit 0, no change ───────
test('t_idempotent', () => {
  const M = mkMock('idem')
  installCore(M) // core only — no enforcement installed
  const u0 = uninstall(M)
  assert.strictEqual(u0.status, 0, `uninstall with nothing installed exits 0 (got ${u0.status}: ${u0.stderr})`)
  assert.ok(fs.existsSync(path.join(HOOKS(M.project), 'bp1-sweep-on-session.sh')), 'bp1 intact after no-op uninstall')
  // Now install + uninstall, then uninstall AGAIN — second run changes nothing.
  installEnforce(M)
  uninstall(M)
  const treeAfter1 = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
  const settingsAfter1 = readParsed(SETTINGS(M.project))
  const u2 = uninstall(M)
  assert.strictEqual(u2.status, 0, `second uninstall exits 0 (got ${u2.status})`)
  assert.deepStrictEqual(snapshotTree(path.join(M.project, '.claude'), ['settings.json']), treeAfter1, 'second uninstall changes no files')
  assert.deepStrictEqual(readParsed(SETTINGS(M.project)), settingsAfter1, 'second uninstall changes no settings')
  ok('t_idempotent — nothing-installed run + double run both exit 0, no change')
})

// ── containment: symlinked escape AND sibling-prefix → THROW, escape blocked ─
test('t_delete_containment', () => {
  // Case A: a to-be-removed file is a symlink pointing OUTSIDE the project tree.
  {
    const M = mkMock('contain-out')
    installCore(M)
    installEnforce(M)
    const outsideDir = path.join(M.base, 'outside')
    fs.mkdirSync(outsideDir, { recursive: true })
    const outsideFile = path.join(outsideDir, 'checkpoint-gate.sh')
    fs.writeFileSync(outsideFile, 'OUTSIDE — MUST SURVIVE\n')
    const canonical = path.join(HOOKS(M.project), 'checkpoint-gate.sh')
    fs.rmSync(canonical, { force: true })
    fs.symlinkSync(outsideFile, canonical)
    const u = uninstall(M)
    assert.notStrictEqual(u.status, 0, 'uninstall must fail closed (non-zero) on a symlink escaping the tree')
    assert.ok(fs.existsSync(outsideFile), 'outside sentinel must NOT be deleted')
    assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), 'OUTSIDE — MUST SURVIVE\n', 'outside sentinel content intact')
  }
  // Case B: sibling-prefix escape (.claude/hooks-backup/) — a bare startsWith
  // would WRONGLY admit this; path.relative rejects it.
  {
    const M = mkMock('contain-sib')
    installCore(M)
    installEnforce(M)
    const siblingDir = path.join(M.project, '.claude', 'hooks-backup')
    fs.mkdirSync(siblingDir, { recursive: true })
    const siblingFile = path.join(siblingDir, 'checkpoint-gate.sh')
    fs.writeFileSync(siblingFile, 'SIBLING — MUST SURVIVE\n')
    const canonical = path.join(HOOKS(M.project), 'checkpoint-gate.sh')
    fs.rmSync(canonical, { force: true })
    fs.symlinkSync(siblingFile, canonical)
    const u = uninstall(M)
    assert.notStrictEqual(u.status, 0, 'uninstall must fail closed on a sibling-prefix escape (hooks-backup/)')
    assert.ok(fs.existsSync(siblingFile), 'sibling-prefix sentinel must NOT be deleted')
  }
  ok('t_delete_containment — symlink-out AND sibling-prefix both fail closed; escape targets survive')
})

// ── malformed settings.json → WHOLE op aborts atomically (F-C/EC12) ──────────
test('t_malformed_settings_safe', () => {
  const M = mkMock('malformed')
  installCore(M)
  installEnforce(M)
  const gate = path.join(HOOKS(M.project), 'checkpoint-gate.sh')
  assert.ok(fs.existsSync(gate), 'precondition: gate present after enforce install')
  const MALFORMED = '{ this is not valid json '
  fs.writeFileSync(SETTINGS(M.project), MALFORMED)
  const u = uninstall(M)
  // settings bytes unchanged AND enforcement files still present (atomic).
  assert.strictEqual(fs.readFileSync(SETTINGS(M.project), 'utf8'), MALFORMED, 'malformed settings.json must be left byte-unchanged')
  assert.ok(fs.existsSync(gate), 'enforcement files must NOT be deleted when settings is malformed (atomic)')
  ok('t_malformed_settings_safe — malformed settings: nothing deleted, settings byte-unchanged')
})

// ── caller cwd ≠ project ≠ repo: deletions land in the mock project (EC9) ────
test('t_uninstall_cwd_independent', () => {
  const M = mkMock('cwd')
  installCore(M)
  installEnforce(M)
  // runInstall already runs from M.callerCwd (≠ M.project ≠ REPO_ROOT).
  assert.notStrictEqual(M.callerCwd, M.project)
  assert.notStrictEqual(M.callerCwd, REPO_ROOT)
  uninstall(M)
  assert.ok(!fs.existsSync(path.join(HOOKS(M.project), 'checkpoint-gate.sh')), 'deletion landed under the mock project')
  assert.ok(!fs.existsSync(path.join(M.callerCwd, '.claude')), 'no .claude created under the caller cwd')
  ok('t_uninstall_cwd_independent — caller cwd ≠ project ≠ repo; deletions land in the mock project')
})

// ── F1: operator command bundled in the SAME hooks[] entry as a gate survives ─
test('t_operator_command_in_shared_entry_preserved', () => {
  const M = mkMock('shared-entry')
  installCore(M)
  installEnforce(M)
  const s = readParsed(SETTINGS(M.project))
  // Find the PreToolUse entry that registers checkpoint-gate.sh and bundle an
  // operator command INTO that same entry.hooks[] array (the non-canonical shape
  // a settings merge/formatter can produce — whole-entry removal would delete it).
  const canonicalGate = path.join(HOOKS(M.project), 'checkpoint-gate.sh')
  let bundled = false
  for (const entry of (s.hooks.PreToolUse || [])) {
    if (entry && Array.isArray(entry.hooks) && entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes('checkpoint-gate.sh'))) {
      entry.hooks.push({ type: 'command', command: '/operator/my-own-guard.sh' })
      bundled = true
      break
    }
  }
  assert.ok(bundled, 'precondition: found a checkpoint-gate PreToolUse entry to bundle into')
  fs.writeFileSync(SETTINGS(M.project), JSON.stringify(s, null, 2))
  uninstall(M)
  const after = readParsed(SETTINGS(M.project))
  const allCmds = []
  for (const ev of Object.keys(after.hooks || {})) {
    for (const m of (after.hooks[ev] || [])) for (const h of (m.hooks || [])) allCmds.push(h.command)
  }
  assert.ok(allCmds.includes('/operator/my-own-guard.sh'), 'operator command bundled with a gate must survive (F1)')
  assert.ok(!allCmds.some((c) => typeof c === 'string' && c === shellQuoteLike(canonicalGate)), 'the gate command itself must be removed')
  ok('t_operator_command_in_shared_entry_preserved — command-granularity prune keeps a bundled operator command (F1)')
})

// shellQuote mirror (install.mjs:1012) so the test compares against the exact
// command string install writes for a gate registration.
function shellQuoteLike(s) {
  return /^[A-Za-z0-9_\-./:=,]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`
}

// ── F2: no core/bp1 hook sources a hooks/lib/*.sh (so removing the .sh closure is
//        always safe). Machine guard (Rule 14) for the prose-only OD-1 invariant. ─
test('t_sh_libs_not_sourced_by_core', () => {
  // Scope to the CORE bp1 hooks only (bp1-*.sh). The enforcement GATE .sh files
  // (checkpoint/plan/preflight) also live here as deployed copies and DO source
  // the libs — correctly, they are enforcement. The OD-1 invariant is only that
  // no bp1/core hook sources an enforcement hooks/lib .sh.
  const coreHooksDir = path.join(REPO_ROOT, '.claude', 'hooks')
  const coreHookFiles = fs.existsSync(coreHooksDir)
    ? fs.readdirSync(coreHooksDir).filter((f) => /^bp1-.+\.sh$/.test(f))
    : []
  assert.ok(coreHookFiles.length > 0, 'precondition: found core bp1 .sh hooks in repo')
  const libBasenames = enforcementHookLibBasenames(REPO_ROOT)
  const offenders = []
  for (const hookFile of coreHookFiles) {
    const src = fs.readFileSync(path.join(coreHooksDir, hookFile), 'utf8')
    for (const lib of libBasenames) {
      const re = new RegExp(`(^|\\n|\\s)(source|\\.)\\s+[^\\n]*${lib.replace(/\./g, '\\.')}`)
      if (re.test(src)) offenders.push(`${hookFile} sources ${lib}`)
    }
  }
  assert.deepStrictEqual(offenders, [], `no core/bp1 hook may source a hooks/lib .sh; offenders: ${offenders.join(', ')}`)
  ok('t_sh_libs_not_sourced_by_core — core bp1 hooks source 0 enforcement .sh libs (F2 drift guard)')
})

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
