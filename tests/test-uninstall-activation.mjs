#!/usr/bin/env node
// test-uninstall-activation.mjs — RFC-009 P2 S6 mock-project E2E for
// `install.mjs --install-activation` / `--uninstall-activation` (Group 4).
//
// Every test drives the REAL install.mjs (install then uninstall) against an
// isolated HOME + git mock project — no stubs, no hand-staged trees, no mental
// tracing (feedback_mock_project_test_not_mental_trace). Assertions inspect real
// files on disk (settings JSON read back, fs.existsSync, before/after snapshots,
// real git fixtures for the authority-root axes).
//
// PRIMARY proof = uninstall_restores_core_state (REQ-23): in ONE project,
// core-install → snapshot → --install-activation → --uninstall-activation →
// re-snapshot; the after-state deep-equals the core baseline (tree + settings).
// That single invariant catches over-removal, under-removal, and residual empty
// event keys without trusting any hand-derived list.
//
// Advisory-only, claude-code-only, per-project. The strict P12 assertion is that
// NOTHING lands in ~/.claude (no_global_touch); ~/.episodic-memory MAY change
// (installs_json activation_installed flag — §7.1 metadata rows).
//
// Zero deps beyond the harness + node stdlib.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkMock, runInstall, REPO_ROOT } from './lib/activation-scoping-harness.mjs'
import {
  ACTIVATION_HOOK_SPECS, activationHookFileBasenames, activationSupportFiles,
} from '../scripts/lib/install-manifest.mjs'
import { resolveRepoRoot } from '../scripts/lib/local-dir.mjs'
import { MAX_SUPPORTED, gateSchemaVersion } from '../scripts/validate-plugin-registry.mjs'

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ✓ ${n}`) }
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}: ${d}`) }
function test(name, fn) {
  try { fn() } catch (e) { bad(name, e && e.message ? e.message : String(e)) }
}

const HOOKS = (p) => path.join(p, '.claude', 'hooks')
const SETTINGS = (p) => path.join(p, '.claude', 'settings.json')
const MANIFEST = (p) => path.join(HOOKS(p), 'manifest.json')

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readParsed = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null)

// The activation-owned artifact set, derived from the install manifest (never a
// hand-list, so a spec change can't drift the test): 3 registered .sh + runner.
const ACT_SH = activationHookFileBasenames()          // 3 .sh basenames
const ACT_SUPPORT = activationSupportFiles()           // ['activation-hook-run.mjs']
const OWNED_FILES = [...ACT_SH, ...ACT_SUPPORT]         // 4 files verified/deployed

// Recursive relpath→sha256 map (symlinks captured as `symlink:<target>`).
// EXCLUDE named top-level files (settings.json compared separately as parsed).
function snapshotTree(root, excludeTopLevel = []) {
  const out = {}
  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (!rel && excludeTopLevel.includes(e.name)) continue
      const abs = path.join(dir, e.name)
      if (e.isSymbolicLink()) out[r] = `symlink:${fs.readlinkSync(abs)}`
      else if (e.isDirectory()) walk(abs, r)
      else out[r] = sha(abs)
    }
  }
  walk(root, '')
  return out
}

// Flatten every hook command string across all events.
function allCommands(settings) {
  const out = []
  if (!settings || !settings.hooks) return out
  for (const ev of Object.keys(settings.hooks)) {
    for (const m of (settings.hooks[ev] || [])) {
      for (const h of (m.hooks || [])) if (typeof h.command === 'string') out.push(h.command)
    }
  }
  return out
}
// Command strings under one event only.
function commandsForEvent(settings, event) {
  const out = []
  for (const m of ((settings && settings.hooks && settings.hooks[event]) || [])) {
    for (const h of (m.hooks || [])) if (typeof h.command === 'string') out.push(h.command)
  }
  return out
}
// True if ANY command references one of the 3 activation .sh basenames.
const hasActivationCommand = (settings) =>
  allCommands(settings).some((c) => ACT_SH.some((f) => c.includes(f)))

function installCore(M, project = M.project) {
  const r = runInstall({ home: M.home, project, callerCwd: M.callerCwd, flags: [] })
  if (r.status !== 0) throw new Error(`core install failed: ${r.stderr}`)
  return r
}
function installActivation(M, project = M.project) {
  const r = runInstall({ home: M.home, project, callerCwd: M.callerCwd, flags: ['--install-activation'] })
  if (r.status !== 0) throw new Error(`activation install failed: ${r.stderr}`)
  return r
}
function uninstallActivation(M, project = M.project) {
  return runInstall({ home: M.home, project, callerCwd: M.callerCwd, flags: ['--uninstall-activation'] })
}

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
function mkGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'juan.delacruz@acme.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
}

// ── install_writes_project_only: 3 registrations + 4 files + injected manifest ─
test('install_writes_project_only', () => {
  const M = mkMock('act-install')
  installActivation(M)
  const s = readParsed(SETTINGS(M.project))
  // Every spec's event carries a command referencing its .sh (matcher-less bare).
  for (const spec of ACTIVATION_HOOK_SPECS) {
    const cmds = commandsForEvent(s, spec.event)
    assert.ok(cmds.some((c) => c.includes(spec.file)),
      `event ${spec.event} must register ${spec.file}`)
  }
  // 4 owned files deployed under <project>/.claude/hooks/.
  for (const f of OWNED_FILES) {
    assert.ok(fs.existsSync(path.join(HOOKS(M.project), f)), `owned file ${f} must be deployed`)
  }
  // Co-located manifest carries the INJECTED project_identity (slug + root).
  const m = readParsed(MANIFEST(M.project))
  assert.ok(m, 'manifest.json must be written beside the hooks')
  assert.deepStrictEqual(m.project_identity, { slug: path.basename(M.project), root: M.project },
    'manifest project_identity must bind slug=basename + root=authorityRoot')
  ok('install_writes_project_only — 3 registrations + 4 files + manifest with injected project_identity')
})

// ── PRIMARY: core-state delta (REQ-23) ───────────────────────────────────────
test('uninstall_restores_core_state', () => {
  const M = mkMock('act-restore')
  installCore(M)
  const baseTree = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
  const baseSettings = readParsed(SETTINGS(M.project))
  installActivation(M)
  const u = uninstallActivation(M)
  if (u.status !== 0) throw new Error(`uninstall failed: ${u.stderr}`)
  const afterTree = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
  const afterSettings = readParsed(SETTINGS(M.project))
  assert.deepStrictEqual(afterTree, baseTree, 'PRIMARY: .claude tree (excl settings.json) must equal core baseline')
  assert.deepStrictEqual(afterSettings, baseSettings, 'PRIMARY: parsed settings.json must equal core baseline')
  ok('uninstall_restores_core_state — core+activation+uninstall ≡ core (tree + settings)')
})

// ── registrations removed from settings ──────────────────────────────────────
test('registrations_removed', () => {
  const M = mkMock('act-regs')
  installActivation(M)
  assert.ok(hasActivationCommand(readParsed(SETTINGS(M.project))), 'precondition: activation registered')
  uninstallActivation(M)
  const s = readParsed(SETTINGS(M.project)) || { hooks: {} }
  assert.ok(!hasActivationCommand(s), 'no activation registration may survive uninstall')
  ok('registrations_removed — all 3 activation registrations pruned from settings')
})

// ── files removed via real readdir (3 .sh + runner + manifest) ───────────────
test('files_removed', () => {
  const M = mkMock('act-files')
  installActivation(M)
  uninstallActivation(M)
  for (const f of OWNED_FILES) {
    assert.ok(!fs.existsSync(path.join(HOOKS(M.project), f)), `owned file ${f} must be removed`)
  }
  assert.ok(!fs.existsSync(MANIFEST(M.project)), 'co-located manifest.json must be removed')
  ok('files_removed — 3 .sh + runner + manifest gone (real existsSync)')
})

// ── no_global_touch: ~/.claude byte-identical across the activation cycle ─────
test('no_global_touch', () => {
  const M = mkMock('act-global')
  installCore(M) // baseline global state (core writes nothing to ~/.claude)
  const gBefore = snapshotTree(path.join(M.home, '.claude'))
  installActivation(M)
  uninstallActivation(M)
  const gAfter = snapshotTree(path.join(M.home, '.claude'))
  assert.deepStrictEqual(gAfter, gBefore, '~/.claude must be byte-identical across install+uninstall of activation')
  ok('no_global_touch — ~/.claude unchanged by --install-activation + --uninstall-activation (strict P12)')
})

// ── installs_json_activation_flag: registry flag flips true (§7.1 metadata) ───
test('installs_json_activation_flag', () => {
  const M = mkMock('act-flag')
  installActivation(M)
  const reg = readParsed(path.join(M.home, '.episodic-memory', 'installs.json'))
  assert.ok(reg && Array.isArray(reg.entries), 'installs.json must exist with an entries array')
  const cc = reg.entries.filter((e) => e.tool === 'claude-code')
  assert.ok(cc.length >= 1, 'a claude-code entry must exist')
  assert.ok(cc.some((e) => e.activation_installed === true),
    'the claude-code entry must carry activation_installed:true')
  ok('installs_json_activation_flag — ~/.episodic-memory/installs.json records activation_installed:true')
})

// ── manifest_agreement: deployed manifest ≡ source on {file,event,timeout} ────
test('manifest_agreement', () => {
  const M = mkMock('act-agree')
  installActivation(M)
  const deployed = readParsed(MANIFEST(M.project))
  const source = readParsed(path.join(REPO_ROOT, 'plugins', 'claude-code-activation', 'manifest.json'))
  const norm = (regs) => (regs || []).map((r) => ({ file: r.file, event: r.event, timeout: r.timeout }))
    .sort((a, b) => a.file.localeCompare(b.file))
  assert.deepStrictEqual(norm(deployed.registrations), norm(source.registrations),
    'deployed manifest registrations must match source on {file,event,timeout}')
  // Also agree with ACTIVATION_HOOK_SPECS (the install-side source of truth).
  const specNorm = ACTIVATION_HOOK_SPECS.map((s) => ({ file: s.file, event: s.event, timeout: s.timeout }))
    .sort((a, b) => a.file.localeCompare(b.file))
  assert.deepStrictEqual(norm(deployed.registrations), specNorm,
    'deployed manifest registrations must match ACTIVATION_HOOK_SPECS')
  ok('manifest_agreement — deployed manifest ≡ source ≡ ACTIVATION_HOOK_SPECS on {file,event,timeout}')
})

// ── manifest_checksum_matches_file: each declared checksum == deployed bytes ──
test('manifest_checksum_matches_file', () => {
  const M = mkMock('act-checksum')
  installActivation(M)
  const m = readParsed(MANIFEST(M.project))
  const declared = [
    ...(Array.isArray(m.registrations) ? m.registrations : []),
    ...(Array.isArray(m.support_files) ? m.support_files : []),
  ].filter((r) => r && typeof r.file === 'string' && typeof r.checksum === 'string')
  assert.ok(declared.length === OWNED_FILES.length,
    `manifest must declare a checksum for all ${OWNED_FILES.length} owned files (got ${declared.length})`)
  for (const r of declared) {
    const want = r.checksum.replace(/^sha256:/, '')
    const got = sha(path.join(HOOKS(M.project), r.file))
    assert.strictEqual(got, want, `checksum for ${r.file} must equal sha256 of the deployed bytes`)
  }
  ok('manifest_checksum_matches_file — every declared checksum == sha256 of the deployed hook file')
})

// ── t_preserves_modified_owned (REQ-28 / P10): user-modified file survives ────
test('t_preserves_modified_owned', () => {
  const M = mkMock('act-modified')
  installActivation(M)
  const modified = path.join(HOOKS(M.project), 'activation-prompt.sh')
  fs.appendFileSync(modified, '\n# operator tamper — must be preserved\n')
  const u = uninstallActivation(M)
  assert.strictEqual(u.status, 0, `uninstall exits 0 even with a modified owned file (got ${u.status}: ${u.stderr})`)
  assert.ok(fs.existsSync(modified), 'user-modified activation-prompt.sh must be PRESERVED (P10)')
  assert.ok(fs.readFileSync(modified, 'utf8').includes('operator tamper'), 'preserved file content intact')
  // Unmodified siblings removed; the manifest (unambiguously ours) removed too.
  for (const f of OWNED_FILES.filter((x) => x !== 'activation-prompt.sh')) {
    assert.ok(!fs.existsSync(path.join(HOOKS(M.project), f)), `unmodified sibling ${f} must be removed`)
  }
  assert.ok(!fs.existsSync(MANIFEST(M.project)), 'manifest.json removed even when a sibling is preserved')
  ok('t_preserves_modified_owned — checksum-divergent owned file preserved; unmodified siblings + manifest removed')
})

// ── idempotent: nothing-installed run + double run = exit 0, no change ────────
test('idempotent', () => {
  const M = mkMock('act-idem')
  installCore(M) // core only — no activation installed
  const u0 = uninstallActivation(M)
  assert.strictEqual(u0.status, 0, `uninstall with nothing installed exits 0 (got ${u0.status}: ${u0.stderr})`)
  installActivation(M)
  uninstallActivation(M)
  const tree1 = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
  const settings1 = readParsed(SETTINGS(M.project))
  const u2 = uninstallActivation(M)
  assert.strictEqual(u2.status, 0, `second uninstall exits 0 (got ${u2.status})`)
  assert.deepStrictEqual(snapshotTree(path.join(M.project, '.claude'), ['settings.json']), tree1, 'second uninstall changes no files')
  assert.deepStrictEqual(readParsed(SETTINGS(M.project)), settings1, 'second uninstall changes no settings')
  ok('idempotent — nothing-installed run + double run both exit 0, no change')
})

// ── delete_containment: symlink-out AND sibling-prefix escape both fail closed.
//    The manifest.json delete (step d) is UNCONDITIONAL (not checksum-gated) and
//    the .sh delete reaches assertContained only when bytes still match the
//    declared checksum — so a faithful containment probe copies the real hook
//    bytes to the escape target (checksum still matches) then symlinks the owned
//    file at it, forcing the delete path to realpath-escape → throw. ───────────
test('delete_containment', () => {
  // Case A: owned file symlinked OUTSIDE the project tree.
  {
    const M = mkMock('act-contain-out')
    installActivation(M)
    const canonical = path.join(HOOKS(M.project), 'activation-prompt.sh')
    const realBytes = fs.readFileSync(canonical) // == declared checksum bytes
    const outsideDir = path.join(M.base, 'outside')
    fs.mkdirSync(outsideDir, { recursive: true })
    const outsideFile = path.join(outsideDir, 'activation-prompt.sh')
    fs.writeFileSync(outsideFile, realBytes) // checksum still matches → reaches assertContained
    fs.rmSync(canonical, { force: true })
    fs.symlinkSync(outsideFile, canonical)
    const u = uninstallActivation(M)
    assert.notStrictEqual(u.status, 0, 'uninstall must fail closed (non-zero) on a symlink escaping the tree')
    assert.ok(fs.existsSync(outsideFile), 'outside target must NOT be deleted')
    assert.ok(fs.readFileSync(outsideFile).equals(realBytes), 'outside target content intact')
  }
  // Case B: sibling-prefix escape (.claude/hooks-backup/) — a bare startsWith
  // would wrongly admit this; path.relative rejects it.
  {
    const M = mkMock('act-contain-sib')
    installActivation(M)
    const canonical = path.join(HOOKS(M.project), 'activation-prompt.sh')
    const realBytes = fs.readFileSync(canonical)
    const siblingDir = path.join(M.project, '.claude', 'hooks-backup')
    fs.mkdirSync(siblingDir, { recursive: true })
    const siblingFile = path.join(siblingDir, 'activation-prompt.sh')
    fs.writeFileSync(siblingFile, realBytes)
    fs.rmSync(canonical, { force: true })
    fs.symlinkSync(siblingFile, canonical)
    const u = uninstallActivation(M)
    assert.notStrictEqual(u.status, 0, 'uninstall must fail closed on a sibling-prefix escape (hooks-backup/)')
    assert.ok(fs.existsSync(siblingFile), 'sibling-prefix target must NOT be deleted')
  }
  ok('delete_containment — symlink-out AND sibling-prefix both fail closed; escape targets survive')
})

// ── malformed_settings_safe: parse-first abort, nothing touched (EC4/atomic) ──
test('malformed_settings_safe', () => {
  const M = mkMock('act-malformed')
  installActivation(M)
  const runner = path.join(HOOKS(M.project), 'activation-hook-run.mjs')
  assert.ok(fs.existsSync(runner), 'precondition: runner present after install')
  const MALFORMED = '{ this is not valid json '
  fs.writeFileSync(SETTINGS(M.project), MALFORMED)
  const u = uninstallActivation(M)
  assert.strictEqual(fs.readFileSync(SETTINGS(M.project), 'utf8'), MALFORMED, 'malformed settings.json left byte-unchanged')
  assert.ok(fs.existsSync(runner), 'owned files must NOT be deleted when settings is malformed (atomic abort)')
  assert.ok(fs.existsSync(MANIFEST(M.project)), 'manifest must NOT be deleted when settings is malformed')
  ok('malformed_settings_safe — malformed settings: nothing deleted, settings byte-unchanged')
})

// ── install_malformed_settings_atomic (Finding A) ────────────────────────────
//    runInstallActivation must PARSE settings.json first and abort atomically on
//    malformed JSON — mirroring runUninstallActivation. Regression for the bare
//    JSON.parse that used to throw AFTER mkdir + 4 copies + the manifest write,
//    leaving a half-installed footprint (files on disk, ZERO registrations,
//    installs.json never flipped). Proof: seed malformed settings, run
//    --install-activation, assert clean exit + ZERO activation footprint +
//    installs.json activation flag never set true.
test('install_malformed_settings_atomic', () => {
  const M = mkMock('act-install-malformed')
  installCore(M) // valid settings + bp1 hooks + installs.json baseline
  const MALFORMED = '{ this is not valid json '
  fs.writeFileSync(SETTINGS(M.project), MALFORMED)
  // Snapshot the .claude tree (excl settings.json) + installs.json AFTER seeding
  // malformed, BEFORE --install-activation — the aborted install must add nothing.
  const beforeTree = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
  const installsPath = path.join(M.home, '.episodic-memory', 'installs.json')
  const beforeInstalls = readParsed(installsPath)
  const r = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-activation'] })
  // (a) exited cleanly — no uncaught SyntaxError / raw stack trace.
  assert.strictEqual(r.status, 0, `malformed-settings install must exit cleanly (got ${r.status}: ${r.stderr})`)
  assert.ok(!/\n\s*at .+install\.mjs/.test(r.stderr), `no raw stack trace may reach stderr:\n${r.stderr}`)
  // (b) settings.json left byte-identical (still malformed) — no registration written.
  assert.strictEqual(fs.readFileSync(SETTINGS(M.project), 'utf8'), MALFORMED,
    'malformed settings.json left byte-unchanged (no activation registration)')
  // ZERO activation owned files / manifest created.
  for (const f of OWNED_FILES) {
    assert.ok(!fs.existsSync(path.join(HOOKS(M.project), f)),
      `activation file ${f} must NOT be created on a malformed-settings abort`)
  }
  assert.ok(!fs.existsSync(MANIFEST(M.project)), 'activation manifest must NOT be created on a malformed-settings abort')
  // .claude tree (excl settings.json) byte-identical to the pre-install snapshot.
  assert.deepStrictEqual(snapshotTree(path.join(M.project, '.claude'), ['settings.json']), beforeTree,
    'ZERO footprint: .claude tree unchanged by the aborted install')
  // installs.json activation flag never flipped true (disk-truth: runner absent).
  const afterInstalls = readParsed(installsPath)
  const cc = ((afterInstalls && afterInstalls.entries) || []).filter((e) => e.tool === 'claude-code')
  assert.ok(cc.length >= 1, 'precondition: a claude-code installs.json entry exists')
  assert.ok(!cc.some((e) => e.activation_installed === true),
    'no claude-code entry may carry activation_installed:true after an aborted install')
  const ccBefore = ((beforeInstalls && beforeInstalls.entries) || []).filter((e) => e.tool === 'claude-code')
  assert.ok(!ccBefore.some((e) => e.activation_installed === true),
    'sanity: baseline core install never set activation_installed:true')
  ok('install_malformed_settings_atomic — malformed settings: clean exit, ZERO footprint, installs.json flag unchanged (Finding A)')
})

// ── uninstall_symlink_abort_atomic (Finding C) ───────────────────────────────
//    A containment-escaping owned-file symlink (with checksum-matching bytes, so
//    it reaches the delete branch) must abort BEFORE any settings mutation. The
//    containment gate was hoisted ahead of the settings write, so the aborted
//    uninstall leaves settings.json BYTE-IDENTICAL (previously the prune+write
//    ran first, leaving partial state). Extends delete_containment with the new
//    byte-identical assertion (c).
test('uninstall_symlink_abort_atomic', () => {
  const M = mkMock('act-contain-atomic')
  installActivation(M)
  const canonical = path.join(HOOKS(M.project), 'activation-prompt.sh')
  const realBytes = fs.readFileSync(canonical) // == declared checksum bytes
  const outsideDir = path.join(M.base, 'outside-atomic')
  fs.mkdirSync(outsideDir, { recursive: true })
  const outsideFile = path.join(outsideDir, 'activation-prompt.sh')
  fs.writeFileSync(outsideFile, realBytes) // checksum still matches → reaches assertContained
  fs.rmSync(canonical, { force: true })
  fs.symlinkSync(outsideFile, canonical)
  // Snapshot settings.json BYTES immediately before uninstall — Finding C proves
  // the abort left them untouched (the containment gate precedes the settings write).
  const settingsBytesBefore = fs.readFileSync(SETTINGS(M.project))
  const u = uninstallActivation(M)
  // (a) fails closed on the containment escape.
  assert.notStrictEqual(u.status, 0, 'uninstall must fail closed (non-zero) on a symlink escaping the tree')
  assert.ok(/CONTAINMENT_VIOLATION/.test(u.stderr), `stderr must name the containment violation:\n${u.stderr}`)
  // (b) external escape target survives untouched.
  assert.ok(fs.existsSync(outsideFile), 'escape target must NOT be deleted')
  assert.ok(fs.readFileSync(outsideFile).equals(realBytes), 'escape target content intact')
  // (c) NEW: settings.json is BYTE-IDENTICAL — the aborted op changed nothing.
  assert.ok(fs.readFileSync(SETTINGS(M.project)).equals(settingsBytesBefore),
    'settings.json must be BYTE-IDENTICAL after a containment-escape abort (Finding C atomicity)')
  ok('uninstall_symlink_abort_atomic — containment escape: fail-closed, escape target intact, settings BYTE-IDENTICAL (Finding C)')
})

// ── cwd_independent: caller cwd ≠ project ≠ repo; delta lands in the project ──
test('cwd_independent', () => {
  const M = mkMock('act-cwd')
  installActivation(M)
  assert.notStrictEqual(M.callerCwd, M.project)
  assert.notStrictEqual(M.callerCwd, REPO_ROOT)
  uninstallActivation(M)
  assert.ok(!fs.existsSync(path.join(HOOKS(M.project), 'activation-hook-run.mjs')), 'deletion landed under the mock project')
  assert.ok(!fs.existsSync(path.join(M.callerCwd, '.claude')), 'no .claude created under the caller cwd')
  ok('cwd_independent — caller cwd ≠ project ≠ repo; activation delta lands in the mock project')
})

// ── authority_root_linked_worktree: --project=worktree binds to MAIN checkout ─
test('authority_root_linked_worktree', () => {
  const M = mkMock('act-wt')
  const mainRepo = path.join(M.base, 'wt-main')
  mkGitRepo(mainRepo)
  const wt = path.join(M.base, 'wt-linked')
  const w = git(mainRepo, ['worktree', 'add', '-q', wt])
  assert.strictEqual(w.status, 0, `git worktree add must succeed: ${w.stderr}`)
  installActivation(M, wt)
  const resolved = resolveRepoRoot(wt)
  assert.notStrictEqual(resolved, wt, 'authority root must resolve UP to the main checkout, not the worktree')
  const m = readParsed(MANIFEST(resolved))
  assert.ok(m, `manifest must land under the resolved main root ${resolved}/.claude/hooks/`)
  assert.strictEqual(m.project_identity.root, resolved, 'manifest project_identity.root == resolved main checkout')
  assert.ok(fs.existsSync(path.join(HOOKS(resolved), 'activation-hook-run.mjs')), 'hooks deployed under the resolved main root')
  ok('authority_root_linked_worktree — --project=worktree deploys under the MAIN checkout (resolveRepoRoot)')
})

// ── authority_root_nested_cwd: --project=subdir resolves UP to the git toplevel ─
test('authority_root_nested_cwd', () => {
  const M = mkMock('act-nested')
  const gitRoot = path.join(M.base, 'nested-main')
  mkGitRepo(gitRoot)
  const sub = path.join(gitRoot, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  installActivation(M, sub)
  const resolved = resolveRepoRoot(sub)
  assert.notStrictEqual(resolved, sub, 'authority root must resolve UP to the git toplevel, not the nested subdir')
  const m = readParsed(MANIFEST(resolved))
  assert.ok(m, `manifest must land under the git toplevel ${resolved}/.claude/hooks/`)
  assert.strictEqual(m.project_identity.root, resolved, 'manifest project_identity.root == git toplevel')
  assert.strictEqual(resolved, fs.realpathSync(gitRoot), 'resolved root == the repo toplevel')
  assert.ok(fs.existsSync(path.join(HOOKS(resolved), 'activation-hook-run.mjs')), 'hooks deployed under the git toplevel')
  ok('authority_root_nested_cwd — --project=subdir deploys under the git toplevel (resolveRepoRoot)')
})

// ── authority_root_non_git_cwd: --project=plain dir binds to the dir itself ───
test('authority_root_non_git_cwd', () => {
  const M = mkMock('act-nogit')
  const plain = path.join(M.base, 'plain-nogit')
  fs.mkdirSync(plain, { recursive: true })
  installActivation(M, plain)
  const resolved = resolveRepoRoot(plain)
  assert.strictEqual(resolved, fs.realpathSync(plain), 'non-git authority root is the dir itself')
  const m = readParsed(MANIFEST(plain))
  assert.ok(m, `manifest must land under ${plain}/.claude/hooks/`)
  assert.strictEqual(m.project_identity.root, resolved, 'manifest project_identity.root == the plain dir')
  assert.ok(fs.existsSync(path.join(HOOKS(plain), 'activation-hook-run.mjs')), 'hooks deployed under the plain dir')
  ok('authority_root_non_git_cwd — --project=non-git dir deploys under the dir itself (resolveRepoRoot)')
})

// ── pre_amendment_schema_rejects: the 1.1.0 MINOR bump is load-bearing ───────
test('pre_amendment_schema_rejects', () => {
  const idx = readParsed(path.join(REPO_ROOT, 'plugins', '_index.json'))
  assert.strictEqual(idx.schema_version, '1.1.0', 'registry declares schema_version 1.1.0 (activation entry)')
  assert.ok((idx.entries || idx.plugins || []).length >= 0, 'registry parsed')
  // A pre-amendment validator (MAX_SUPPORTED=1.0.0) must REJECT the bumped registry…
  assert.strictEqual(gateSchemaVersion(idx.schema_version, '1.0.0').ok, false,
    'schema_version 1.1.0 must be rejected under a 1.0.0 forward gate (bump is load-bearing)')
  // …and the current MAX_SUPPORTED (1.1.0) must ACCEPT it.
  assert.strictEqual(gateSchemaVersion(idx.schema_version, MAX_SUPPORTED).ok, true,
    'schema_version 1.1.0 must be accepted under the current MAX_SUPPORTED')
  ok('pre_amendment_schema_rejects — 1.1.0 rejected pre-amendment (1.0.0 gate), accepted at MAX_SUPPORTED')
})

// ── install_divergent_runner_withholds (Finding F1) ──────────────────────────
//    The 3 .sh wrappers are inert; ALL logic lives in the shared runner
//    activation-hook-run.mjs which they exec. A DIVERGENT runner (user bytes,
//    preserved by installHookFile without --install-hooks-force) is unreviewed
//    content — registering the .sh would point Claude AT it. So the runner is
//    load-bearing for the WHOLE adapter: a not-ours runner must WITHHOLD ALL 3
//    registrations AND leave activation_installed unset. Pre-fix, the 3 .sh
//    copied + REGISTERED against the divergent runner and the flag flipped true.
test('install_divergent_runner_withholds', () => {
  const M = mkMock('act-divergent-runner')
  installCore(M) // valid settings.json + installs.json baseline
  // Pre-place a DIVERGENT runner with USER bytes (differs from repo source), no force.
  const runner = path.join(HOOKS(M.project), 'activation-hook-run.mjs')
  fs.mkdirSync(HOOKS(M.project), { recursive: true })
  const USER_BYTES = '// USER-EDITED activation runner — must be preserved, never wired\n'
  fs.writeFileSync(runner, USER_BYTES)
  const r = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-activation'] })
  // (a) clean exit — withholding is not an error.
  assert.strictEqual(r.status, 0, `divergent-runner install must exit cleanly (got ${r.status}: ${r.stderr})`)
  // (b) NO activation registration wired (all 3 .sh withheld).
  const s = readParsed(SETTINGS(M.project))
  assert.ok(!hasActivationCommand(s),
    'no activation .sh may be registered while the runner is divergent/unreviewed')
  for (const spec of ACTIVATION_HOOK_SPECS) {
    assert.ok(!commandsForEvent(s, spec.event).some((c) => c.includes(spec.file)),
      `event ${spec.event} must NOT register ${spec.file} against a divergent runner`)
  }
  // (c) the divergent runner is PRESERVED byte-for-byte (never overwritten).
  assert.strictEqual(fs.readFileSync(runner, 'utf8'), USER_BYTES,
    'the divergent runner must be preserved (installHookFile skipped-divergent)')
  // (d) installs.json activation flag NEVER flipped true (nothing was wired).
  const reg = readParsed(path.join(M.home, '.episodic-memory', 'installs.json'))
  const cc = ((reg && reg.entries) || []).filter((e) => e.tool === 'claude-code')
  assert.ok(cc.length >= 1, 'a claude-code installs.json entry must exist')
  assert.ok(!cc.some((e) => e.activation_installed === true),
    'no claude-code entry may carry activation_installed:true when the runner is divergent')
  ok('install_divergent_runner_withholds — divergent runner: all 3 registrations withheld, runner preserved, flag never set (F1)')
})

// ── install_nonobject_settings_atomic (Finding F2) ───────────────────────────
//    Valid JSON of the WRONG SHAPE is as unusable as malformed. `settings.json =
//    []` parses, but `![].hooks` → true → `settings.hooks = {}` sets a NAMED prop
//    on the array that JSON.stringify SILENTLY DROPS → registrations lost yet the
//    files + manifest were already written and the flag flipped (half-install).
//    The parse-first guard must also validate SHAPE and abort atomically BEFORE
//    any mkdir/copy/manifest — zero footprint, settings byte-identical, flag
//    unset. Two sub-cases exercise BOTH guards with the SAME reachable shape:
//    (A) --install-activation and (B) --uninstall-activation, each with `[]`.
//
//    REACHABILITY NOTE: `[]` is the shape that reaches these guards byte-for-byte
//    — the core install's `JSON.parse(settings) || {}` passes a top-level array
//    THROUGH unchanged (whereas it HEALS `null` → `{}` and CRASHES on a bare
//    primitive, both BEFORE activation reads settings.json). So `[]` is the exact
//    valid-JSON-wrong-shape probe for the activation seam; the guards also defend
//    null/primitive shapes defensively if ever reached directly.
test('install_nonobject_settings_atomic', () => {
  // (A) INSTALL with settings.json = [] — abort atomically, zero footprint.
  {
    const M = mkMock('act-nonobject-install')
    installCore(M) // valid baseline (settings + installs.json)
    fs.writeFileSync(SETTINGS(M.project), '[]')
    const beforeTree = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
    const installsPath = path.join(M.home, '.episodic-memory', 'installs.json')
    const r = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-activation'] })
    assert.strictEqual(r.status, 0, `[] install must exit cleanly (got ${r.status}: ${r.stderr})`)
    assert.ok(!/\n\s*at .+install\.mjs/.test(r.stderr), `[] no raw stack trace may reach stderr:\n${r.stderr}`)
    assert.strictEqual(fs.readFileSync(SETTINGS(M.project), 'utf8'), '[]',
      '[] settings.json must be byte-identical after a shape-abort')
    for (const f of OWNED_FILES) {
      assert.ok(!fs.existsSync(path.join(HOOKS(M.project), f)), `[] activation file ${f} must NOT be created on a shape-abort`)
    }
    assert.ok(!fs.existsSync(MANIFEST(M.project)), '[] manifest must NOT be created on a shape-abort')
    assert.deepStrictEqual(snapshotTree(path.join(M.project, '.claude'), ['settings.json']), beforeTree,
      '[] ZERO footprint: .claude tree unchanged by the aborted install')
    const after = readParsed(installsPath)
    const cc = ((after && after.entries) || []).filter((e) => e.tool === 'claude-code')
    assert.ok(!cc.some((e) => e.activation_installed === true),
      '[] no claude-code entry may carry activation_installed:true after a shape-abort')
  }
  // (B) UNINSTALL with settings.json = [] — abort atomically, delete NOTHING.
  {
    const M = mkMock('act-nonobject-uninstall')
    installActivation(M) // real activation footprint (files + manifest + regs)
    fs.writeFileSync(SETTINGS(M.project), '[]')
    const beforeTree = snapshotTree(path.join(M.project, '.claude'), ['settings.json'])
    const u = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--uninstall-activation'] })
    assert.strictEqual(u.status, 0, `[] uninstall must exit cleanly (got ${u.status}: ${u.stderr})`)
    assert.ok(!/\n\s*at .+install\.mjs/.test(u.stderr), `[] no raw stack trace may reach stderr:\n${u.stderr}`)
    assert.strictEqual(fs.readFileSync(SETTINGS(M.project), 'utf8'), '[]',
      '[] settings.json must be byte-identical after an uninstall shape-abort')
    // Owned files + manifest must NOT be deleted (uninstall aborted before removal).
    for (const f of OWNED_FILES) {
      assert.ok(fs.existsSync(path.join(HOOKS(M.project), f)), `[] owned file ${f} must NOT be deleted on an uninstall shape-abort`)
    }
    assert.ok(fs.existsSync(MANIFEST(M.project)), '[] manifest must NOT be deleted on an uninstall shape-abort')
    assert.deepStrictEqual(snapshotTree(path.join(M.project, '.claude'), ['settings.json']), beforeTree,
      '[] ZERO deletion: .claude tree unchanged by the aborted uninstall')
  }
  ok('install_nonobject_settings_atomic — settings=[] on install AND uninstall: clean exit, ZERO footprint, byte-identical (F2)')
})

// ── uninstall_legacy_relative_nested_project (Finding F3) ─────────────────────
//    A legacy RELATIVE activation command (`.claude/hooks/activation-prompt.sh`)
//    in the authority-root settings.json must resolve against the AUTHORITY ROOT
//    whose settings.json is being edited — NOT projectDir. Under a nested
//    `--project <subdir>` uninstall, resolving against projectDir bound the
//    relative command under the subdir, judged it foreign, LEFT the registration
//    — yet still DELETED the canonical file → a dangling registration. The fix
//    makes registration-removal and file-deletion AGREE.
test('uninstall_legacy_relative_nested_project', () => {
  const M = mkMock('act-legacy-nested')
  const gitRoot = path.join(M.base, 'legacy-main')
  mkGitRepo(gitRoot)
  const resolved = resolveRepoRoot(gitRoot)
  const sub = path.join(gitRoot, 'a', 'b')
  fs.mkdirSync(sub, { recursive: true })
  // Install activation (authority root = gitRoot): absolute canonical commands +
  // files + manifest land under the resolved main root.
  installActivation(M, sub)
  const canonical = path.join(HOOKS(resolved), 'activation-prompt.sh')
  assert.ok(fs.existsSync(canonical), 'precondition: canonical hook file deployed')
  // Rewrite the UserPromptSubmit registration to the LEGACY RELATIVE spelling.
  const s = readParsed(SETTINGS(resolved))
  let rewrote = false
  for (const m of (s.hooks.UserPromptSubmit || [])) {
    for (const h of (m.hooks || [])) {
      if (typeof h.command === 'string' && h.command.includes('activation-prompt.sh')) {
        h.command = '.claude/hooks/activation-prompt.sh'
        rewrote = true
      }
    }
  }
  assert.ok(rewrote, 'precondition: rewrote the UserPromptSubmit registration to legacy relative spelling')
  fs.writeFileSync(SETTINGS(resolved), JSON.stringify(s, null, 2))
  // Uninstall via the NESTED subdir — authority root still resolves to gitRoot.
  const u = uninstallActivation(M, sub)
  assert.strictEqual(u.status, 0, `nested uninstall must exit 0 (got ${u.status}: ${u.stderr})`)
  // (a) the legacy relative registration is REMOVED (not left dangling)…
  const after = readParsed(SETTINGS(resolved)) || { hooks: {} }
  assert.ok(!commandsForEvent(after, 'UserPromptSubmit').some((c) => c.includes('activation-prompt.sh')),
    'the legacy relative registration must be REMOVED under a nested-project uninstall (F3)')
  assert.ok(!hasActivationCommand(after), 'no activation registration may survive the nested uninstall')
  // (b) …AND its canonical file is deleted — removal and deletion AGREE.
  assert.ok(!fs.existsSync(canonical), 'the canonical hook file must be deleted (agrees with registration removal)')
  ok('uninstall_legacy_relative_nested_project — legacy relative reg removed + file deleted agree under nested --project (F3)')
})

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
console.log(`test-uninstall-activation: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
