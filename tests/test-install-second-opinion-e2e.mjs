#!/usr/bin/env node
/**
 * test-install-second-opinion-e2e.mjs — End-to-end tests for I-NEW-C
 * (--install-second-opinion atomicity).
 *
 * Coverage:
 *   Case 1 — Happy install: empty HOME + unmutated registry → exit 0,
 *     Done! printed, full active surface populated, snapshot valid.
 *
 *   Case 2 — Gate 1 failure with empty HOME: mutated cli_match in temp repo
 *     copy → exit 1, no Done!, walkAllFiles(tempHome).length === 0
 *     (NO files anywhere under tempHome — not just second-opinion surface;
 *     R6-F1 full-tree check), target project untouched.
 *
 *   Case 3 — Gate 1 failure with populated HOME: pre-existing happy install
 *     in tempHome → mutate registry in temp repo copy → run install →
 *     full-tree hash byte-identical pre vs post (active runtime untouched).
 *
 *   Case 4 — Gate 2 failure with quarantine: pre-existing happy snapshot →
 *     overwrite all 4 provider modules in temp repo copy so every
 *     available() returns {ok: false} → install passes Gate 1 (source
 *     registry shape is valid) but Gate 2 fails (installedProviders is
 *     empty → N1) → quarantine pre-existing snapshot to .stale.<ts> so
 *     hook fail-closes (R6-F3 all-unavailable fixture).
 *
 * R7-F1: all 4 cases are bound to the caller-cwd != --project axis
 * (toolkit #20). Caller cwd is set to a separate tempBase dir; assertions
 * verify no artifacts land at caller cwd.
 *
 * Zero deps. Node assert + fs + child_process + crypto.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

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

const tmpDirs = []
process.on('exit', () => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

function mkTempBase(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `install-so-e2e-${label}-`))
  tmpDirs.push(dir)
  return dir
}

// Walk every regular file under root. Returns sorted absolute paths.
function walkAllFiles(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  function walk(d) {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile() || ent.isSymbolicLink()) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

// Stable hash over the entire file tree under root: each file's relative path
// + null byte + its content + null byte, in sorted order. Comparing this hash
// pre vs post-install detects ANY change anywhere in the tree.
function treeHash(root) {
  const h = crypto.createHash('sha256')
  for (const f of walkAllFiles(root)) {
    const rel = path.relative(root, f)
    h.update(rel).update('\0')
    try {
      // readFileSync would throw on broken symlinks; lstat first.
      const st = fs.lstatSync(f)
      if (st.isSymbolicLink()) {
        h.update('SYMLINK:').update(fs.readlinkSync(f))
      } else {
        h.update(fs.readFileSync(f))
      }
    } catch (e) {
      h.update(`ERR:${e.message}`)
    }
    h.update('\0')
  }
  return h.digest('hex')
}

// Copy a directory tree from src → dst, dereference: false to preserve symlinks
// (so mutating the COPY's registry doesn't mutate the live repo via symlink).
function copyRepo(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: false })
}

// Mutate the provider registry in a temp repo copy to introduce an invalid
// cli_match regex on the first provider entry. Triggers Gate 1.
function mutateRegistryInvalid(tempRepoCopy) {
  const regPath = path.join(tempRepoCopy, 'scripts/second-opinion/providers/index.json')
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
  reg.providers[0].cli_match = '['  // unclosed regex group → throws on new RegExp
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2))
}

// R6-F3: overwrite every provider module so every available() returns
// {ok: false}. installedProviders becomes empty → Gate 2 N1 fires.
function makeAllProvidersUnavailable(tempRepoCopy) {
  const providersDir = path.join(tempRepoCopy, 'scripts/second-opinion/providers')
  for (const name of ['stub', 'codex', 'claude-subagent', 'gemini']) {
    fs.writeFileSync(
      path.join(providersDir, `${name}.mjs`),
      `export const id = '${name}'\n` +
      `export const binary = '${name}'\n` +
      `export function available() { return { ok: false, reason: 'test-fixture-unavailable' } }\n` +
      `export function dispatch({ prompt, projectRoot }) {\n` +
      `  if (!prompt) throw new Error('prompt is required')\n` +
      `  if (!projectRoot) throw new Error('projectRoot is required')\n` +
      `  return { ok: false, exitCode: 1, stdout: '', stderr: 'test-fixture' }\n` +
      `}\n`
    )
  }
}

// Build a pre-existing valid snapshot under tempHome to simulate a prior
// successful install. Returns the snapshot path so callers can hash it.
function preInstallValidSnapshot(tempHome) {
  fs.mkdirSync(path.join(tempHome, '.claude', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(tempHome, '.episodic-memory', 'scripts', 'second-opinion'), { recursive: true })
  const snapPath = path.join(tempHome, '.claude', 'hooks', 'second-opinion-providers.json')
  const snap = {
    schema_version: 1,
    source_hash: 'pre-existing-valid-hash',
    source_repo: '/pre-existing',
    install_timestamp: new Date(0).toISOString(),
    providers: [
      { id: 'stub', binary: 'stub', cli_match: '^stub', prompt_max_chars: 100,
        agent_block_patterns: [], agent_allow_patterns: [] },
    ],
    fragments: [],
    file_hashes: {},
  }
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2))
  return snapPath
}

// Run install.mjs from tempRepoCopy with caller-cwd in tempBase (R7-F1:
// caller cwd != --project axis) and HOME overridden to tempHome. Returns
// spawn result.
function runInstall(tempRepoCopy, tempProject, tempHome, callerCwd, extraEnv = {}) {
  // Hermeticity: scrub SO_INSTALL_SNAPSHOT_PATH so the install resolves the
  // snapshot path via HOME (the production default). Otherwise an inherited
  // env override from the test shell breaks the temp-HOME isolation. F3
  // from post-implementation code review.
  const env = { ...process.env, HOME: tempHome, ...extraEnv }
  delete env.SO_INSTALL_SNAPSHOT_PATH
  return spawnSync('node', [
    path.join(tempRepoCopy, 'install.mjs'),
    '--tool', 'claude-code',
    '--project', tempProject,
    '--install-second-opinion',
  ], {
    cwd: callerCwd,
    env,
    encoding: 'utf8',
    timeout: 60000,
  })
}

console.log('# test-install-second-opinion-e2e')

// ---------------------------------------------------------------------------
// Case 1: happy install
// ---------------------------------------------------------------------------
console.log('\n## Case 1 — happy install (R7-F1 caller-cwd axis)')
test('happy install: exit 0, Done!, full surface populated, snapshot valid', () => {
  const tempBase = mkTempBase('case1')
  const tempRepoCopy = path.join(tempBase, 'repo')
  const tempProject = path.join(tempBase, 'project')
  const tempHome = path.join(tempBase, 'home')
  const callerCwd = path.join(tempBase, 'caller')
  copyRepo(REPO_ROOT, tempRepoCopy)
  fs.mkdirSync(tempProject, { recursive: true })
  fs.mkdirSync(callerCwd, { recursive: true })

  const r = runInstall(tempRepoCopy, tempProject, tempHome, callerCwd)

  assert.strictEqual(r.status, 0,
    `expected exit 0, got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`)
  assert.ok(r.stdout.includes('Done!'), `expected Done! in stdout; got: ${r.stdout}`)

  // Active surface populated.
  const harness = path.join(tempHome, '.episodic-memory/scripts/second-opinion.mjs')
  const hook = path.join(tempHome, '.claude/hooks/second-opinion-gate.mjs')
  const hookLib = path.join(tempHome, '.claude/hooks/lib/registry-validator.mjs')
  const snapshot = path.join(tempHome, '.claude/hooks/second-opinion-providers.json')
  assert.ok(fs.existsSync(harness), `harness must exist at ${harness}`)
  assert.ok(fs.existsSync(hook), `hook must exist at ${hook}`)
  assert.ok(fs.existsSync(hookLib), `hook lib must exist at ${hookLib}`)
  assert.ok(fs.existsSync(snapshot), `snapshot must exist at ${snapshot}`)

  // Snapshot has at least one provider (stub is always available()).
  const snap = JSON.parse(fs.readFileSync(snapshot, 'utf8'))
  assert.ok(Array.isArray(snap.providers) && snap.providers.length >= 1,
    `snapshot.providers must be non-empty, got ${JSON.stringify(snap.providers)}`)

  // R7-F1: caller cwd untouched (no .episodic-memory / .claude there).
  assert.ok(!fs.existsSync(path.join(callerCwd, '.episodic-memory')),
    'caller cwd must not have .episodic-memory')
  assert.ok(!fs.existsSync(path.join(callerCwd, '.claude')),
    'caller cwd must not have .claude')
})

// ---------------------------------------------------------------------------
// Case 2: Gate 1 failure with empty HOME (R6-F1 full-tree check)
// ---------------------------------------------------------------------------
console.log('\n## Case 2 — Gate 1 failure, empty HOME (R6-F1 full-tree)')
test('Gate 1 with empty HOME: exit 1, no Done!, tempHome remains EMPTY (all files)', () => {
  const tempBase = mkTempBase('case2')
  const tempRepoCopy = path.join(tempBase, 'repo')
  const tempProject = path.join(tempBase, 'project')
  const tempHome = path.join(tempBase, 'home')
  const callerCwd = path.join(tempBase, 'caller')
  copyRepo(REPO_ROOT, tempRepoCopy)
  fs.mkdirSync(tempProject, { recursive: true })
  fs.mkdirSync(callerCwd, { recursive: true })

  mutateRegistryInvalid(tempRepoCopy)

  const r = runInstall(tempRepoCopy, tempProject, tempHome, callerCwd)

  assert.notStrictEqual(r.status, 0,
    `expected nonzero exit on Gate 1 failure; got ${r.status}`)
  assert.ok(!r.stdout.includes('Done!'),
    `Done! must not appear on failure; got stdout: ${r.stdout}`)

  // R6-F1: full HOME tree assertion — NOTHING under tempHome (not just
  // second-opinion surface). Gate 1 hard-stops before any file write.
  const files = walkAllFiles(tempHome)
  assert.strictEqual(files.length, 0,
    `Gate 1 failure must leave tempHome empty, but found ${files.length} file(s): ${files.slice(0, 5).join(', ')}`)

  // R7-F1: caller cwd untouched.
  assert.strictEqual(walkAllFiles(callerCwd).length, 0,
    `caller cwd must remain empty on Gate 1 failure`)

  // Target project: install creates .episodic-memory unconditionally early
  // (line ~150) — but Gate 1 runs BEFORE that, so target should be untouched.
  const projectFiles = walkAllFiles(tempProject)
  assert.strictEqual(projectFiles.length, 0,
    `target project must be untouched on Gate 1 failure, found: ${projectFiles}`)
})

// ---------------------------------------------------------------------------
// Case 3: Gate 1 failure with populated HOME (R4-F1 stale-snapshot)
// ---------------------------------------------------------------------------
console.log('\n## Case 3 — Gate 1 failure, populated HOME (R4-F1 stale-snapshot)')
test('Gate 1 with populated HOME: full-tree hash byte-identical pre vs post', () => {
  const tempBase = mkTempBase('case3')
  const tempRepoCopy = path.join(tempBase, 'repo')
  const tempProject = path.join(tempBase, 'project')
  const tempHome = path.join(tempBase, 'home')
  const callerCwd = path.join(tempBase, 'caller')

  // Simulate prior successful install (full surface present).
  copyRepo(REPO_ROOT, tempRepoCopy)
  fs.mkdirSync(tempProject, { recursive: true })
  fs.mkdirSync(callerCwd, { recursive: true })
  const happyResult = runInstall(tempRepoCopy, tempProject, tempHome, callerCwd)
  assert.strictEqual(happyResult.status, 0, 'prior happy install setup must succeed')

  const preHash = treeHash(tempHome)

  // Now mutate the temp repo registry (does NOT affect what's already on
  // tempHome) and re-run install.
  mutateRegistryInvalid(tempRepoCopy)
  const r = runInstall(tempRepoCopy, tempProject, tempHome, callerCwd)

  assert.notStrictEqual(r.status, 0, 'Gate 1 must reject mutated registry')
  assert.ok(!r.stdout.includes('Done!'), 'no Done! on Gate 1 failure')

  const postHash = treeHash(tempHome)
  assert.strictEqual(postHash, preHash,
    'full HOME tree must be byte-identical after Gate 1 failure (atomic install)')
})

// ---------------------------------------------------------------------------
// Case 4: Gate 2 failure with quarantine (R6-F3 all-unavailable + R4-F1)
// ---------------------------------------------------------------------------
console.log('\n## Case 4 — Gate 2 failure with quarantine (R6-F3 all-unavailable)')
test('Gate 2 with populated HOME + all-unavailable: snapshot quarantined to .stale.<ts>', () => {
  const tempBase = mkTempBase('case4')
  const tempRepoCopy = path.join(tempBase, 'repo')
  const tempProject = path.join(tempBase, 'project')
  const tempHome = path.join(tempBase, 'home')
  const callerCwd = path.join(tempBase, 'caller')

  copyRepo(REPO_ROOT, tempRepoCopy)
  fs.mkdirSync(tempProject, { recursive: true })
  fs.mkdirSync(callerCwd, { recursive: true })

  // Pre-populate tempHome with valid snapshot (simulating prior install).
  const snapPath = preInstallValidSnapshot(tempHome)
  const preSnapshotContent = fs.readFileSync(snapPath, 'utf8')

  // Make all providers unavailable in the COPY only.
  makeAllProvidersUnavailable(tempRepoCopy)

  const r = runInstall(tempRepoCopy, tempProject, tempHome, callerCwd)

  assert.notStrictEqual(r.status, 0,
    `Gate 2 must fail (empty installedProviders → N1); got exit ${r.status}, stderr=${r.stderr}`)
  assert.ok(!r.stdout.includes('Done!'),
    `no Done! on Gate 2 failure; stdout: ${r.stdout}`)

  // Current snapshot file must be GONE (renamed).
  assert.ok(!fs.existsSync(snapPath),
    `current snapshot must be quarantined (renamed away); still exists at ${snapPath}`)

  // Quarantine file must exist matching snapPath + .stale.<digits>.
  const hooksDir = path.dirname(snapPath)
  const quarantineFiles = fs.readdirSync(hooksDir).filter(
    f => f.startsWith('second-opinion-providers.json.stale.')
  )
  assert.strictEqual(quarantineFiles.length, 1,
    `expected 1 quarantine file, found ${quarantineFiles.length}: ${quarantineFiles}`)

  // Quarantine file content byte-identical to original valid snapshot.
  const quarantineContent = fs.readFileSync(path.join(hooksDir, quarantineFiles[0]), 'utf8')
  assert.strictEqual(quarantineContent, preSnapshotContent,
    'quarantined snapshot must be byte-identical to original')
})

// ---------------------------------------------------------------------------
// Case 5: writeSnapshot failure path (F1 unified-quarantine regression).
// Block writeSnapshot's atomic rename by pre-creating a directory at the
// .tmp target. Validates that quarantine ALSO fires when writeSnapshot
// throws (not just when Gate 2 validation throws).
// ---------------------------------------------------------------------------
console.log('\n## Case 5 — writeSnapshot failure (F1 unified-quarantine regression)')
test('writeSnapshot blocked: quarantine still fires via unified outer-catch', () => {
  const tempBase = mkTempBase('case5')
  const tempRepoCopy = path.join(tempBase, 'repo')
  const tempProject = path.join(tempBase, 'project')
  const tempHome = path.join(tempBase, 'home')
  const callerCwd = path.join(tempBase, 'caller')

  copyRepo(REPO_ROOT, tempRepoCopy)
  fs.mkdirSync(tempProject, { recursive: true })
  fs.mkdirSync(callerCwd, { recursive: true })

  // Pre-populate tempHome with valid snapshot.
  const snapPath = preInstallValidSnapshot(tempHome)
  const preSnapshotContent = fs.readFileSync(snapPath, 'utf8')

  // Block writeSnapshot's atomic temp-then-rename by pre-creating a
  // DIRECTORY at the .tmp path. fs.writeFileSync into a directory throws.
  // writeSnapshot uses `${targetPath}.tmp` per install-snapshot.mjs.
  fs.mkdirSync(`${snapPath}.tmp`, { recursive: true })

  const r = runInstall(tempRepoCopy, tempProject, tempHome, callerCwd)

  assert.notStrictEqual(r.status, 0,
    `writeSnapshot block must exit nonzero; got ${r.status}, stderr=${r.stderr}`)
  assert.ok(!r.stdout.includes('Done!'),
    `no Done! on writeSnapshot failure; stdout=${r.stdout}`)

  // F1 invariant: current snapshot must be quarantined (renamed).
  assert.ok(!fs.existsSync(snapPath),
    `current snapshot must be quarantined; still exists at ${snapPath}`)

  // Quarantine file must exist.
  const hooksDir = path.dirname(snapPath)
  const quarantineFiles = fs.readdirSync(hooksDir).filter(
    f => f.startsWith('second-opinion-providers.json.stale.')
  )
  assert.strictEqual(quarantineFiles.length, 1,
    `expected 1 quarantine file, found ${quarantineFiles.length}: ${quarantineFiles}`)
  assert.strictEqual(
    fs.readFileSync(path.join(hooksDir, quarantineFiles[0]), 'utf8'),
    preSnapshotContent,
    'quarantined snapshot must be byte-identical to original')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
