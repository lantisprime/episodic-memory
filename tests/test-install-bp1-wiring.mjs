#!/usr/bin/env node
/**
 * test-install-bp1-wiring.mjs — Hermetic tests for install.mjs section 2c
 * (BP-1 H2 SessionStart hook + project-local settings.json wiring).
 *
 * RFC-004 §559 H-cfg. Per plan v3:
 *   F1 — caller cwd ≠ --project: settings.json under TARGET only; HOME bp1
 *        lines unchanged (I1, I10).
 *        FU-1: exact install command spelled out, NO --install-hooks.
 *   F2 — no --project: falls back to caller cwd; settings.json there.
 *   F3 — worktree: caller in main repo, --project <worktree-path>; settings
 *        under worktree only.
 *   R1 — fresh install creates settings.json with one canonical H2 entry.
 *   R2 — re-run preserves H2 count = 1; regen warning suppressed (B8).
 *   R3 — pre-seeded H1 at index 0 → order [H1, H2] (forward-compat for M2).
 *   R4 — flat-shape pre-seed → migrated by helper.
 *   R5 — canonical pre-seed → byte-stable.
 *   R6 — H2 at non-canonical path → existing detectStaleCanonicalEntries
 *        warning emitted (informational).
 *   manifest-hash — H2 wiring changes settings_lines sha256 (I9).
 *   regen-warning — fires on add only; suppressed on no-op (B8 specific).
 *   helper-purity — mergeSessionStartH2Hook does not mutate input (I2).
 *
 * Note (FU-2): if --install-hooks is combined with --tool claude-code, HOME
 * settings may change due to the legacy hook-install block (section 5).
 * H2's project-local wiring stays project-local regardless. This test
 * exercises plain --tool claude-code (no --install-hooks) so HOME
 * isolation is testable cleanly.
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const INSTALL = path.join(REPO, 'install.mjs')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp1-install-${label}-`))
}

function makeProjectRoot() {
  const dir = makeTempDir('proj')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return fs.realpathSync(dir)
}

/**
 * Run install.mjs in a fully sandboxed environment.
 *
 * Per FU-1: command is exactly `node install.mjs --tool claude-code --project <target>`.
 * NO --install-hooks (legacy HOME-write block). Per I10, HOME settings.json
 * stays untouched.
 *
 * `homeDir` overrides HOME so global state writes (~/.episodic-memory/scripts/,
 * ~/.claude/) don't pollute the user's real environment.
 */
function runInstall({ projectDir, callerCwd, homeDir, env }) {
  return spawnSync('node', [INSTALL, '--tool', 'claude-code', '--project', projectDir], {
    cwd: callerCwd || projectDir,
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDir, ...(env || {}) },
  })
}

function readSettings(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

function h2Command(projectDir) {
  return `bash ${path.join(projectDir, '.claude', 'hooks', 'bp1-sweep-on-session.sh')}`
}

function h1CommandStub(projectDir) {
  // Synthetic H1 entry for forward-compat tests. Not a real path; we just need
  // a distinct command string to verify ordering.
  return `bash ${path.join(projectDir, '.claude', 'hooks', 'bp1-approval-check.sh')}`
}

function settingsFor(projectDir) {
  return path.join(projectDir, '.claude', 'settings.json')
}

function homeSettingsBp1Hash(homeDir) {
  // Snapshot of HOME ~/.claude/settings.json content. Used to assert I10.
  // Returns null if file doesn't exist (fresh HOME).
  const p = path.join(homeDir, '.claude', 'settings.json')
  if (!fs.existsSync(p)) return null
  const buf = fs.readFileSync(p)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function manifestHashFor(projectDir) {
  // Compute artifact-version-hash via the manifest builder. Used for I9.
  const out = execFileSync('node', [
    path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    '--project', projectDir, '--json',
  ], { encoding: 'utf8' })
  return JSON.parse(out).sha256
}

// =============================================================================
// F1 — caller cwd ≠ --project: settings under target only; HOME unchanged (I1, I10)
// =============================================================================
tap('F1: caller cwd != --project → settings under TARGET; caller has no .claude; HOME bp1 lines unchanged (I1, I10)', () => {
  const target = makeProjectRoot()
  const caller = makeProjectRoot()
  const home = makeTempDir('home')

  const homeHashBefore = homeSettingsBp1Hash(home)

  const r = runInstall({ projectDir: target, callerCwd: caller, homeDir: home })
  assert.equal(r.status, 0, `install failed: ${r.stderr}`)

  // I1: settings.json under TARGET, NOT caller.
  assert.ok(fs.existsSync(settingsFor(target)),
    `target settings.json must exist at ${settingsFor(target)}`)
  assert.ok(!fs.existsSync(settingsFor(caller)),
    `caller settings.json must NOT exist at ${settingsFor(caller)}`)
  // Hook script under target.
  const hookPath = path.join(target, '.claude', 'hooks', 'bp1-sweep-on-session.sh')
  assert.ok(fs.existsSync(hookPath), `H2 hook must be installed at ${hookPath}`)

  // I10: HOME settings.json content snapshot unchanged. The plain --tool
  // claude-code (no --install-hooks) path is the contract — HOME-touching is
  // only reachable via --install-hooks (FU-2 note).
  const homeHashAfter = homeSettingsBp1Hash(home)
  assert.equal(homeHashAfter, homeHashBefore,
    'HOME settings.json must be unchanged by --tool claude-code (no --install-hooks)')

  // settings.json shape includes one canonical H2 entry.
  const s = readSettings(settingsFor(target))
  assert.equal(s.hooks.SessionStart.length, 1, 'exactly one SessionStart entry')
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, h2Command(target),
    'SessionStart entry command must reference the canonical H2 path')
})

// =============================================================================
// F2 — no --project: falls back to caller cwd
// =============================================================================
tap('F2: no --project flag → settings under caller cwd (process.cwd() fallback)', () => {
  const caller = makeProjectRoot()
  const home = makeTempDir('home')
  // Run install.mjs without --project; spawnSync's cwd = caller is the source
  // for process.cwd() inside install.mjs.
  const r = spawnSync('node', [INSTALL, '--tool', 'claude-code'], {
    cwd: caller, encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  assert.equal(r.status, 0, `install failed: ${r.stderr}`)
  assert.ok(fs.existsSync(settingsFor(caller)),
    `caller settings.json must exist when --project omitted`)
})

// =============================================================================
// F3 — worktree-style: caller is "main repo", target is a separate dir
// =============================================================================
tap('F3: caller cwd is one project, --project points at another → settings under TARGET only', () => {
  const target = makeProjectRoot()
  const caller = makeProjectRoot()
  const home = makeTempDir('home')

  const r = runInstall({ projectDir: target, callerCwd: caller, homeDir: home })
  assert.equal(r.status, 0)
  assert.ok(fs.existsSync(settingsFor(target)))
  assert.ok(!fs.existsSync(settingsFor(caller)),
    'caller (linked-worktree main repo) must remain unchanged')
})

// =============================================================================
// R1 — fresh install creates settings with one canonical H2 entry
// =============================================================================
tap('R1: fresh install → settings.json created with one canonical H2 entry', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')
  const r = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r.status, 0)
  const s = readSettings(settingsFor(target))
  assert.equal(s.hooks.SessionStart.length, 1)
  assert.equal(s.hooks.SessionStart[0].hooks[0].type, 'command')
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, h2Command(target))
  assert.equal(typeof s.hooks.SessionStart[0].hooks[0].timeout, 'number')
})

// =============================================================================
// R2 — re-run preserves H2 count = 1; regen-warning suppressed on no-op (B8)
// =============================================================================
tap('R2: re-run idempotent → H2 count stays 1; regen warning fires on FIRST install only (B8)', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')

  const r1 = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r1.status, 0)
  assert.match(r1.stdout, /artifact_version_hash changed/,
    'regen warning must fire on FIRST install')

  const settingsAfterR1 = fs.readFileSync(settingsFor(target), 'utf8')

  const r2 = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r2.status, 0)
  // B8: no regen warning on no-op re-run.
  assert.doesNotMatch(r2.stdout, /artifact_version_hash changed/,
    'regen warning must NOT fire on no-op re-run (B8)')
  // Idempotence: settings byte-stable.
  const settingsAfterR2 = fs.readFileSync(settingsFor(target), 'utf8')
  assert.equal(settingsAfterR2, settingsAfterR1,
    'settings.json must be byte-identical across re-run (idempotence)')

  const s = readSettings(settingsFor(target))
  assert.equal(s.hooks.SessionStart.length, 1, 'H2 entry count must remain 1')
})

// =============================================================================
// R3 — pre-seeded H1 → order [H1, H2] (forward-compat for M2 §559 ordering)
// =============================================================================
tap('R3: pre-seeded H1 entry → H2 appended; order = [H1, H2] (M2 forward-compat per §559)', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')

  // Pre-seed settings.json with an H1-style entry at index 0 (synthetic; H1
  // doesn't ship until M2, but install.mjs must not reorder existing entries).
  const dotClaude = path.join(target, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  const preseedSettings = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: h1CommandStub(target), timeout: 10 }] },
      ],
    },
  }
  fs.writeFileSync(settingsFor(target), JSON.stringify(preseedSettings, null, 2))

  const r = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r.status, 0)

  const s = readSettings(settingsFor(target))
  assert.equal(s.hooks.SessionStart.length, 2, 'H1 + H2 = 2 entries')
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, h1CommandStub(target),
    'H1 must remain at index 0 (preserves pre-existing entry)')
  assert.equal(s.hooks.SessionStart[1].hooks[0].command, h2Command(target),
    'H2 must be appended at index 1')
})

// =============================================================================
// R4 — flat-shape pre-seed → migrated to canonical (codex code-review B1)
// =============================================================================
tap('R4: pre-seeded H2 in flat shape {command, timeout} → migrated to nested canonical (B1)', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')

  // Pre-seed settings.json with the H2 entry in FLAT shape (legacy /
  // misconfigured user state). install.mjs section 2c must migrate this to
  // nested canonical shape before the idempotence check, otherwise the
  // mergeSessionStartH2Hook would detect the canonical command as "already
  // present" and leave a non-executable flat entry in place.
  const dotClaude = path.join(target, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  const flatSettings = {
    hooks: {
      SessionStart: [
        {
          // Flat shape: top-level command + timeout, NO inner hooks array.
          command: h2Command(target),
          timeout: 10,
        },
      ],
    },
  }
  fs.writeFileSync(settingsFor(target), JSON.stringify(flatSettings, null, 2))

  const r = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r.status, 0, `install failed: ${r.stderr}`)

  // install.mjs must announce the migration (visibility).
  assert.match(r.stdout, /Migrated \d+ flat-shape SessionStart entr/,
    'install must surface flat-shape migration')

  // Post-state: exactly one H2 entry, in nested canonical shape.
  const s = readSettings(settingsFor(target))
  assert.equal(s.hooks.SessionStart.length, 1, 'one entry post-migration (no duplicate)')
  const entry = s.hooks.SessionStart[0]
  assert.ok(Array.isArray(entry.hooks),
    `migrated entry must have nested .hooks array; got ${JSON.stringify(entry)}`)
  assert.equal(entry.hooks.length, 1, 'nested .hooks array has one inner hook')
  assert.equal(entry.hooks[0].type, 'command')
  assert.equal(entry.hooks[0].command, h2Command(target))
  // Flat top-level .command must NOT survive in nested shape.
  assert.equal(entry.command, undefined,
    `flat top-level .command must be removed post-migration; got ${entry.command}`)
})

// =============================================================================
// R5 — canonical pre-seed → byte-stable
// =============================================================================
tap('R5: canonical H2 pre-seed → byte-stable across install', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')

  const r1 = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r1.status, 0)

  const before = fs.readFileSync(settingsFor(target), 'utf8')
  const r2 = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r2.status, 0)
  const after = fs.readFileSync(settingsFor(target), 'utf8')
  assert.equal(after, before, 'settings.json byte-stable on re-run with canonical entry')
})

// =============================================================================
// R6 — H2 at non-canonical path: install adds canonical + emits stale warning
//      (codex code-review R6 follow-up: explicit warning, not just dup entry)
// =============================================================================
tap('R6: pre-seeded H2 at non-canonical path → install adds canonical + emits stale-entry warning', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')
  const dotClaude = path.join(target, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  const stalePath = '/old/path/bp1-sweep-on-session.sh'
  const staleSettings = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: `bash ${stalePath}`, timeout: 10 }] },
      ],
    },
  }
  fs.writeFileSync(settingsFor(target), JSON.stringify(staleSettings, null, 2))

  const r = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r.status, 0)

  const s = readSettings(settingsFor(target))
  // Helper's exact-command idempotence check (normalizeCommand-based) sees the
  // stale path as a different command, so canonical H2 is appended.
  assert.equal(s.hooks.SessionStart.length, 2,
    'stale + canonical → 2 entries (operator can clean up the stale one)')
  const commands = s.hooks.SessionStart.flatMap(e => e.hooks.map(h => h.command))
  assert.ok(commands.includes(`bash ${stalePath}`), 'stale entry preserved (no auto-delete)')
  assert.ok(commands.includes(h2Command(target)), 'canonical H2 added')
  // R6 explicit warning surfaced via detectStaleCanonicalEntries.
  assert.match(r.stdout, /stale BP-1 H2 entry/,
    'install must surface a stale-canonical warning when H2 entry references a non-canonical path')
})

// =============================================================================
// B2 — divergent H2 file at destination, no force → settings registration withheld
//      (codex code-review B2 fix: mirror legacy installHookFile semantics)
// =============================================================================
tap('B2: divergent H2 hook + no --install-hooks-force → file NOT overwritten AND settings NOT registered', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')
  const projHooksDir = path.join(target, '.claude', 'hooks')
  const projH2HookDst = path.join(projHooksDir, 'bp1-sweep-on-session.sh')
  fs.mkdirSync(projHooksDir, { recursive: true })

  // Pre-seed a "divergent" H2 file (different content from repo source).
  const divergentContent = '#!/usr/bin/env bash\n# Divergent / user-edited H2.\nexit 0\n'
  fs.writeFileSync(projH2HookDst, divergentContent)
  fs.chmodSync(projH2HookDst, 0o755)

  const r = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r.status, 0)
  // Warning surfaced.
  assert.match(r.stdout, /differs from repo source.*withholding settings registration/,
    'install must surface divergent-file + withholding-registration warning')
  // File NOT overwritten.
  assert.equal(fs.readFileSync(projH2HookDst, 'utf8'), divergentContent,
    'divergent H2 file must NOT be overwritten without --install-hooks-force')
  // settings.json NOT created (or, if pre-existed, no H2 entry registered).
  // Since target has no settings.json pre-test, the file should not exist post-install.
  assert.ok(!fs.existsSync(settingsFor(target)),
    'settings.json must NOT be created when H2 file is divergent and no force flag')
})

tap('B2: divergent H2 hook + --install-hooks + --install-hooks-force → file overwritten AND settings registered', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')
  const projHooksDir = path.join(target, '.claude', 'hooks')
  const projH2HookDst = path.join(projHooksDir, 'bp1-sweep-on-session.sh')
  fs.mkdirSync(projHooksDir, { recursive: true })

  fs.writeFileSync(projH2HookDst, '#!/usr/bin/env bash\n# Divergent / user-edited H2.\nexit 0\n')
  fs.chmodSync(projH2HookDst, 0o755)

  const r = spawnSync('node', [INSTALL,
    '--tool', 'claude-code',
    '--project', target,
    '--install-hooks',
    '--install-hooks-force',
  ], {
    cwd: target,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Overwrote divergent .*bp1-sweep-on-session\.sh/,
    'install must announce overwrite under --install-hooks --install-hooks-force')
  // File matches repo source now.
  const repoH2 = fs.readFileSync(path.join(REPO, '.claude', 'hooks', 'bp1-sweep-on-session.sh'))
  assert.ok(repoH2.equals(fs.readFileSync(projH2HookDst)),
    'overwrite must restore repo-source contents')
  // settings.json registered.
  assert.ok(fs.existsSync(settingsFor(target)),
    'settings.json must be registered after force overwrite')
  const s = readSettings(settingsFor(target))
  assert.equal(s.hooks.SessionStart.length, 1)
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, h2Command(target))
})

// Codex code-review round-2 Finding 1: --install-hooks-force ALONE (without
// --install-hooks) must NOT overwrite divergent project-local H2 — matches
// legacy T11 contract that says force-alone has no effect on hooks.
tap('B2 force-alone (codex r2 Finding 1): --install-hooks-force without --install-hooks → divergent H2 NOT overwritten', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')
  const projHooksDir = path.join(target, '.claude', 'hooks')
  const projH2HookDst = path.join(projHooksDir, 'bp1-sweep-on-session.sh')
  fs.mkdirSync(projHooksDir, { recursive: true })

  const divergentContent = '#!/usr/bin/env bash\n# Divergent / user-edited H2.\nexit 0\n'
  fs.writeFileSync(projH2HookDst, divergentContent)
  fs.chmodSync(projH2HookDst, 0o755)

  const r = spawnSync('node', [INSTALL,
    '--tool', 'claude-code',
    '--project', target,
    '--install-hooks-force',  // FORCE alone, no --install-hooks
  ], {
    cwd: target,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
  assert.equal(r.status, 0)
  // Legacy T11a warning fires.
  assert.match(r.stdout, /--install-hooks-force has no effect without --install-hooks/,
    'install must surface the legacy force-alone warning')
  // Section 2c also surfaces its withholding-registration message.
  assert.match(r.stdout, /not overwriting AND withholding settings registration/,
    'install must surface section 2c divergent withholding message')
  // File NOT overwritten — force-alone is impotent.
  assert.equal(fs.readFileSync(projH2HookDst, 'utf8'), divergentContent,
    'divergent H2 must NOT be overwritten with --install-hooks-force ALONE')
  // settings.json NOT registered.
  assert.ok(!fs.existsSync(settingsFor(target)),
    'settings.json must NOT be created when force is provided alone')
})

// =============================================================================
// manifest-hash — H2 wiring changes settings_lines sha256 (I9)
// =============================================================================
tap('manifest-hash: H2 wiring changes artifact_version_hash settings_lines (I9)', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')

  // Baseline manifest BEFORE H2 wiring (no .claude/ in target yet).
  const hashBefore = manifestHashFor(target)

  const r = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  assert.equal(r.status, 0)

  const hashAfter = manifestHashFor(target)
  assert.notEqual(hashAfter, hashBefore,
    'artifact_version_hash must change after H2 wiring lands (I9)')
})

// =============================================================================
// helper-purity — I2: mergeSessionStartH2Hook does not mutate input
// =============================================================================
tap('helper-purity: mergeSessionStartH2Hook does NOT mutate input (I2)', async () => {
  const { mergeSessionStartH2Hook } = await import('../scripts/lib/bp1-install-helpers.mjs')
  const input = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bash /x', timeout: 10 }] }] } }
  const inputClone = JSON.parse(JSON.stringify(input))
  const result = mergeSessionStartH2Hook(input, '/y')
  assert.deepEqual(input, inputClone, 'input must not be mutated (I2)')
  assert.equal(result.changed, true)
  assert.equal(result.settings.hooks.SessionStart.length, 2)
})

// =============================================================================
// malformed-json — install.mjs refuses to silently overwrite bad JSON
// =============================================================================
tap('malformed-json: pre-existing invalid JSON → install surfaces error and skips H2 wiring (no overwrite)', () => {
  const target = makeProjectRoot()
  const home = makeTempDir('home')
  const dotClaude = path.join(target, '.claude')
  fs.mkdirSync(dotClaude, { recursive: true })
  fs.writeFileSync(settingsFor(target), '{ this is not valid JSON', 'utf8')

  const r = runInstall({ projectDir: target, callerCwd: target, homeDir: home })
  // install.mjs surfaces and continues; exit 0 still happens for the rest.
  assert.equal(r.status, 0)
  assert.match(r.stdout, /not valid JSON/, 'install must surface malformed JSON')
  // settings.json content unchanged (no silent overwrite).
  assert.equal(fs.readFileSync(settingsFor(target), 'utf8'), '{ this is not valid JSON',
    'install must NOT overwrite malformed settings.json silently')
})

// =============================================================================
// Summary
// =============================================================================
console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
