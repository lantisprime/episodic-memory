#!/usr/bin/env node
/**
 * test-bp1-sweep-on-session.mjs — Hermetic tests for the H2 SessionStart hook.
 *
 * RFC-004 §178 (silent-refusal) + §559 (H-cfg wiring contract). Per plan v3
 * negative-scenario matrix + codex code-review round 1 finding A1, fixtures
 * exercise the REAL installed shape: bp1 scripts live at
 * $HOME/.episodic-memory/scripts/ (NOT under <projectRoot>/scripts/), so each
 * fixture installs scripts into a fake HOME and never symlinks repo `scripts/`
 * into project roots — that symlink would mask the cross-project install bug
 * codex caught.
 *
 *   F4 — happy path: caller cwd != stdin.cwd, project active → sweep-tick
 *        episode lands under TARGET, ZERO under caller (I8).
 *   F5 — silent: project inactive → exit 0, stdout empty, stderr empty,
 *        no episodes anywhere (I7, RFC §178).
 *   F6a — cd-fail nonexistent cwd → exit 0 silently.
 *   F6b — empty stdin {} → falls back to pwd (caller cwd), proceeds per
 *         caller's activation state.
 *   F6c — null cwd → same as F6b.
 *   F6d — permission-denied cwd → exit 0 silently (codex FU-3).
 *   B6 — cross-project bypass: project A's dry-run lock+env in scope, hook
 *        fires for project B which is inactive → fail closed (RFC §577-585
 *        v3.12). No sweep at B.
 *   no-install — codex A1 regression: HOME has NO bp1 scripts → H2 silently
 *        no-ops (the soft-fail branch).
 *
 * Zero deps; Node stdlib only. Mirrors test-bp1-deadline-sweep.mjs patterns.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HOOK = path.join(REPO, '.claude', 'hooks', 'bp1-sweep-on-session.sh')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp1-h2-${label}-`))
}

/**
 * Make a project root. NO symlink to repo `scripts/` — exercises the real
 * post-install shape per codex finding A1.
 */
function makeProjectRoot() {
  const dir = makeTempDir('proj')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}

/**
 * Install bp1 scripts globally under <homeDir>/.episodic-memory/scripts/,
 * mirroring install.mjs section 1 (lines 82-99). H2 resolves scripts from
 * $HOME/.episodic-memory/scripts/ post-codex-A1-fix.
 */
function installBp1ScriptsToHome(homeDir) {
  const dst = path.join(homeDir, '.episodic-memory', 'scripts')
  fs.mkdirSync(dst, { recursive: true })
  const repoScripts = path.join(REPO, 'scripts')
  for (const file of fs.readdirSync(repoScripts).filter(f => f.endsWith('.mjs'))) {
    fs.copyFileSync(path.join(repoScripts, file), path.join(dst, file))
    fs.chmodSync(path.join(dst, file), 0o755)
  }
  // scripts/lib/ subtree for transitive imports (e.g. bp1-sweep.mjs).
  const repoLib = path.join(repoScripts, 'lib')
  if (fs.existsSync(repoLib)) {
    const dstLib = path.join(dst, 'lib')
    fs.mkdirSync(dstLib, { recursive: true })
    for (const file of fs.readdirSync(repoLib).filter(f => f.endsWith('.mjs'))) {
      fs.copyFileSync(path.join(repoLib, file), path.join(dstLib, file))
    }
  }
  // categories.json is substrate the deployed em-store resolves via ../../categories.json
  // (RFC-009 P1a; install.mjs deploys it globally). The sweep shells out to em-store, which now
  // fails CLOSED without the vocab — mirror the real deploy so the sweep-tick write succeeds.
  const repoCategories = path.join(REPO, 'categories.json')
  if (fs.existsSync(repoCategories)) {
    fs.copyFileSync(repoCategories, path.join(homeDir, '.episodic-memory', 'categories.json'))
  }
}

function projectSha(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot, 'utf8').digest('hex')
}

function writeVerifyKey(homeDir) {
  const verifyDir = path.join(homeDir, '.episodic-memory')
  fs.mkdirSync(verifyDir, { recursive: true })
  const verifyPath = path.join(verifyDir, '.verify-key')
  const key = crypto.randomBytes(32)
  fs.writeFileSync(verifyPath, key)
  fs.chmodSync(verifyPath, 0o600)
  const fp = crypto.createHmac('sha256', key)
    .update('verify-key-fingerprint-v1', 'utf8')
    .digest('hex').slice(0, 16)
  return { fingerprint: fp }
}

function writeConfig(homeDir, projectRoot, entry) {
  const configPath = path.join(homeDir, '.episodic-memory', 'config.json')
  const config = entry
    ? { bp1: { schema_version: 1, activations: { [projectRoot]: entry } } }
    : { bp1: { schema_version: 1, activations: {} } }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function buildHashAgainstHome(projectRoot, homeDir) {
  // RFC-008 P4d / Principle 12: bp1 scripts install CO-LOCATED per-project under
  // <project>/.claude/hooks/. The unit fixtures stage them at the legacy global
  // scripts dir; the real-install test (case 9) co-locates them. Resolve whichever
  // exists so both shapes use the same artifact-manifest builder.
  const coLocated = path.join(projectRoot, '.claude', 'hooks', 'bp1-build-artifact-manifest.mjs')
  const global = path.join(homeDir, '.episodic-memory', 'scripts', 'bp1-build-artifact-manifest.mjs')
  const script = fs.existsSync(coLocated) ? coLocated : global
  const out = execFileSync('node', [
    script, '--project', projectRoot, '--json',
  ], { encoding: 'utf8', env: { ...process.env, HOME: homeDir } })
  return JSON.parse(out).sha256
}

function activationEntry(projectRoot, homeDir, fingerprint) {
  return {
    enabled: true,
    artifact_version_hash: 'sha256:' + buildHashAgainstHome(projectRoot, homeDir),
    enabled_at: new Date().toISOString(),
    enabled_via: 'test-fixture',
    verify_key_id: fingerprint,
  }
}

/**
 * Drive the H2 bash hook with stdin JSON + caller cwd + HOME override.
 * Returns { exitCode, stdout, stderr }.
 */
function runHook({ stdinJSON, callerCwd, homeDir, env }) {
  const r = spawnSync('bash', [HOOK], {
    cwd: callerCwd,
    encoding: 'utf8',
    input: typeof stdinJSON === 'string' ? stdinJSON : JSON.stringify(stdinJSON),
    env: { ...process.env, HOME: homeDir, ...(env || {}) },
  })
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr }
}

function episodesDirOf(projectRoot) {
  return path.join(projectRoot, '.episodic-memory', 'episodes')
}

function listEpisodes(projectRoot) {
  const dir = episodesDirOf(projectRoot)
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}

// =============================================================================
// F4 — happy path: caller cwd != stdin.cwd, project active
// =============================================================================
tap('F4 happy: caller cwd != stdin.cwd, project active → sweep-tick under TARGET, none under caller (I8)', () => {
  const target = makeProjectRoot()
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  installBp1ScriptsToHome(home)
  const { fingerprint } = writeVerifyKey(home)
  writeConfig(home, target, activationEntry(target, home, fingerprint))

  const r = runHook({
    stdinJSON: { cwd: target },
    callerCwd: caller,
    homeDir: home,
  })

  assert.equal(r.exitCode, 0, 'H2 must exit 0')

  // Sweep evidence lands under target, NOT caller.
  const callerEps = listEpisodes(caller)
  const targetEps = listEpisodes(target)
  assert.equal(callerEps.length, 0,
    `evidence must NOT land in caller cwd; found ${callerEps.length}`)
  assert.ok(targetEps.length >= 1,
    `target project must have a sweep episode; got ${targetEps.length}`)
  assert.ok(targetEps.some(e => /bp1-sweep-tick|bp1-sweep-noop/.test(e)),
    `expected bp1-sweep-tick or bp1-sweep-noop in target episodes; got ${targetEps.join(', ')}`)
})

// =============================================================================
// F5 — silent: inactive project → exit 0, no stdout, no stderr, no episodes
// =============================================================================
tap('F5 silent: inactive project → exit 0, stdout empty, stderr empty, no episodes anywhere (I7, §178)', () => {
  const target = makeProjectRoot()
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  installBp1ScriptsToHome(home)
  writeVerifyKey(home)
  writeConfig(home, target, null)  // empty activations → inactive

  const r = runHook({
    stdinJSON: { cwd: target },
    callerCwd: caller,
    homeDir: home,
  })

  assert.equal(r.exitCode, 0, 'must exit 0 silently per §178')
  assert.equal(r.stdout, '',
    `silent-refusal must NOT emit stdout; got: ${JSON.stringify(r.stdout)}`)
  assert.equal(r.stderr, '',
    `silent-refusal must NOT emit stderr; got: ${JSON.stringify(r.stderr)}`)
  assert.equal(listEpisodes(target).length, 0,
    'silent-refusal must NOT emit any episode under target')
  assert.equal(listEpisodes(caller).length, 0,
    'silent-refusal must NOT emit any episode under caller')
})

// =============================================================================
// F6a — cd-fail: nonexistent cwd
// =============================================================================
tap('F6a cd-fail nonexistent: stdin .cwd points at /nonexistent/path → exit 0 silently', () => {
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  installBp1ScriptsToHome(home)
  writeVerifyKey(home)

  const fakeCwd = path.join(os.tmpdir(), `bp1-h2-nonexistent-${crypto.randomBytes(4).toString('hex')}`)

  const r = runHook({
    stdinJSON: { cwd: fakeCwd },
    callerCwd: caller,
    homeDir: home,
  })

  assert.equal(r.exitCode, 0, 'cd-fail on nonexistent must exit 0 silently')
  assert.equal(r.stdout, '', 'cd-fail must not emit stdout')
  assert.equal(r.stderr, '', 'cd-fail must not emit stderr')
})

// =============================================================================
// F6b — empty stdin {} → falls back to caller cwd's pwd
// =============================================================================
tap('F6b empty stdin {}: falls back to pwd (caller cwd), proceeds per caller activation state', () => {
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  installBp1ScriptsToHome(home)
  writeVerifyKey(home)
  writeConfig(home, caller, null)  // caller is inactive

  const r = runHook({
    stdinJSON: {},
    callerCwd: caller,
    homeDir: home,
  })

  assert.equal(r.exitCode, 0, 'must exit 0')
  assert.equal(r.stdout, '', 'inactive caller must produce no stdout')
  assert.equal(listEpisodes(caller).length, 0, 'no episodes on silent refusal')
})

// =============================================================================
// F6c — null cwd → falls back to pwd
// =============================================================================
tap('F6c null cwd: stdin {"cwd": null} → falls back to pwd (same shape as F6b)', () => {
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  installBp1ScriptsToHome(home)
  writeVerifyKey(home)
  writeConfig(home, caller, null)

  const r = runHook({
    stdinJSON: { cwd: null },
    callerCwd: caller,
    homeDir: home,
  })

  assert.equal(r.exitCode, 0, 'must exit 0')
  assert.equal(r.stdout, '', 'inactive caller must produce no stdout')
  assert.equal(listEpisodes(caller).length, 0, 'no episodes on silent refusal')
})

// =============================================================================
// F6d — permission-denied cwd (codex FU-3)
// =============================================================================
tap('F6d cd-fail permission-denied: stdin .cwd points at unreadable dir → exit 0 silently', () => {
  if (process.platform === 'win32') {
    console.log('# skipping F6d on win32 — chmod semantics differ')
    return
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('# skipping F6d when running as root — chmod 000 ineffective')
    return
  }

  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  installBp1ScriptsToHome(home)
  writeVerifyKey(home)

  const lockedDir = makeTempDir('locked')
  fs.chmodSync(lockedDir, 0o000)
  try {
    const r = runHook({
      stdinJSON: { cwd: lockedDir },
      callerCwd: caller,
      homeDir: home,
    })
    assert.equal(r.exitCode, 0, 'cd into permission-denied dir must exit 0 silently')
    assert.equal(r.stdout, '', 'cd-fail must not emit stdout')
    assert.equal(r.stderr, '', 'cd-fail must not emit stderr')
  } finally {
    fs.chmodSync(lockedDir, 0o700)
    fs.rmSync(lockedDir, { recursive: true, force: true })
  }
})

// =============================================================================
// B6 — cross-project bypass: project A's lock+env in scope, hook fires for B
// =============================================================================
tap('B6 cross-project bypass: A has lock+env, B is inactive, hook for B → fail closed, no sweep at B (§577-585)', () => {
  const projA = makeProjectRoot()
  const projB = makeProjectRoot()
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  installBp1ScriptsToHome(home)
  writeVerifyKey(home)
  writeConfig(home, projB, null)  // B is inactive

  // Project A has its own valid dry-run lock...
  fs.writeFileSync(
    path.join(projA, '.episodic-memory', '.bp1-dry-run.lock'),
    JSON.stringify({
      run_id: 'dry-A-1',
      ttl_until: Date.now() + 60_000,
      project_root_sha256: projectSha(projA),
    })
  )

  const r = runHook({
    stdinJSON: { cwd: projB },
    callerCwd: caller,
    homeDir: home,
    env: { BP1_DRY_RUN_MODE: projectSha(projA) },
  })

  assert.equal(r.exitCode, 0, 'cross-project must fail closed silently')
  assert.equal(r.stdout, '', 'cross-project bypass must NOT emit stdout')
  assert.equal(listEpisodes(projB).length, 0,
    'cross-project bypass must NOT emit sweep evidence under B')
})

// =============================================================================
// no-install — codex A1 regression: HOME has no bp1 scripts → soft no-op
// =============================================================================
tap('no-install (codex A1): HOME without bp1 scripts → H2 silently no-ops', () => {
  const target = makeProjectRoot()
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  // Deliberately NO installBp1ScriptsToHome — verifies the soft-fail branch.

  const r = runHook({
    stdinJSON: { cwd: target },
    callerCwd: caller,
    homeDir: home,
  })

  assert.equal(r.exitCode, 0, 'missing scripts must exit 0 silently')
  assert.equal(r.stdout, '', 'no stdout when scripts unavailable')
  assert.equal(r.stderr, '', 'no stderr when scripts unavailable')
  assert.equal(listEpisodes(target).length, 0, 'no episodes when scripts unavailable')
})

// =============================================================================
// installed-shape (codex A1): post-install.mjs invocation works end-to-end
// =============================================================================
tap('installed-shape (codex A1): real install.mjs → H2 invocation finds scripts at $HOME/.episodic-memory/scripts/', () => {
  const target = makeProjectRoot()
  const caller = makeProjectRoot()
  const home = makeTempDir('home')

  // Run install.mjs end-to-end. This both copies scripts to $HOME and wires H2.
  const installer = spawnSync('node', [
    path.join(REPO, 'install.mjs'),
    '--tool', 'claude-code',
    '--project', target,
  ], {
    cwd: caller,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  assert.equal(installer.status, 0, `install.mjs failed: ${installer.stderr}`)

  // Activation gate setup so the sweep is allowed to run.
  const { fingerprint } = writeVerifyKey(home)
  writeConfig(home, target, activationEntry(target, home, fingerprint))

  // Now invoke the INSTALLED H2 hook (lives under <target>/.claude/hooks/) with
  // stdin pointing at the activated target. NO symlink in <target>/scripts —
  // codex A1's regression check.
  const installedHook = path.join(target, '.claude', 'hooks', 'bp1-sweep-on-session.sh')
  assert.ok(fs.existsSync(installedHook), 'install.mjs must have copied H2 hook')

  const r = spawnSync('bash', [installedHook], {
    cwd: caller,
    encoding: 'utf8',
    input: JSON.stringify({ cwd: target }),
    env: { ...process.env, HOME: home },
  })
  assert.equal(r.status, 0, 'installed H2 must exit 0')

  // The sweep must have actually fired: at least one bp1-sweep episode under target.
  const targetEps = listEpisodes(target)
  assert.ok(targetEps.some(e => /bp1-sweep/.test(e)),
    `installed H2 must produce a sweep episode at target; got ${targetEps.join(', ')}`)
})

// =============================================================================
// Summary
// =============================================================================
console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
