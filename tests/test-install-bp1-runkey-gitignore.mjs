#!/usr/bin/env node
/**
 * test-install-bp1-runkey-gitignore.mjs — install.mjs gitignore delta tests
 * (planner B4: cwd-binding + idempotence on `**\/.episodic-memory/runs/*\/run.key`).
 *
 * The line itself is ALREADY shipped from PR-1a (install.mjs:135-142). This
 * test pins #20 cwd-binding for it: caller_cwd != --project must land the
 * line at target's .gitignore, NEVER at caller cwd or HOME.
 *
 * Coverage:
 *   install-F1: caller cwd ≠ --project + sandbox HOME → line at target only.
 *   install-F2: re-run on already-wired project → idempotent (no duplicate).
 *   install-F3: pre-existing .gitignore with the line → no duplicate appended.
 *   install-HOME-iso: HOME .gitignore unchanged (checksum before/after).
 *   install-cwd-iso: caller cwd .gitignore unchanged (checksum before/after).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const INSTALL = path.join(REPO, 'install.mjs')

const RUN_KEY_PATTERN = '**/.episodic-memory/runs/*/run.key'

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function makeSandboxProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-gi-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return fs.realpathSync(dir)
}

function makeSandboxCaller() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-gi-caller-'))
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}

function makeSandboxHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-gi-home-'))
  return fs.realpathSync(dir)
}

function runInstall({ project, callerCwd, homeDir, tool = 'claude-code' }) {
  return spawnSync(
    'node',
    [INSTALL, '--tool', tool, '--project', project],
    {
      cwd: callerCwd,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    },
  )
}

function gitignoreLineCount(filePath, pattern) {
  if (!fs.existsSync(filePath)) return 0
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n')
  // Match the pattern as an exact line (trim trailing whitespace).
  return lines.filter(l => l.trimEnd() === pattern).length
}

function checksum(filePath) {
  if (!fs.existsSync(filePath)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

// =============================================================================
// install-F1 — caller_cwd != --project: line at target only
// =============================================================================
tap('install-F1 caller_cwd != --project: gitignore line lands at target only', () => {
  const project = makeSandboxProject()
  const caller = makeSandboxCaller()
  const home = makeSandboxHome()
  // Pre-write the target's .gitignore (install.mjs gates the block on
  // fs.existsSync(.gitignore) — fresh repos without one are a no-op).
  fs.writeFileSync(path.join(project, '.gitignore'), '# baseline\n')
  // Pre-write .gitignore on caller and HOME to detect tampering.
  fs.writeFileSync(path.join(caller, '.gitignore'), '# caller\n')
  fs.writeFileSync(path.join(home, '.gitignore'), '# home\n')
  const callerSum = checksum(path.join(caller, '.gitignore'))
  const homeSum = checksum(path.join(home, '.gitignore'))

  const r = runInstall({ project, callerCwd: caller, homeDir: home })
  assert.equal(r.status, 0, `install failed: ${r.stderr}`)

  // Target gitignore has the run-key pattern.
  assert.equal(gitignoreLineCount(path.join(project, '.gitignore'), RUN_KEY_PATTERN), 1,
    'target .gitignore must contain run.key pattern exactly once')

  // Caller and HOME .gitignore unchanged.
  assert.equal(checksum(path.join(caller, '.gitignore')), callerSum,
    'caller .gitignore must be unchanged')
  assert.equal(checksum(path.join(home, '.gitignore')), homeSum,
    'HOME .gitignore must be unchanged')
})

// =============================================================================
// install-F2 — re-run idempotence (no duplicate)
// =============================================================================
tap('install-F2 re-run on already-wired project → no duplicate of run.key pattern', () => {
  const project = makeSandboxProject()
  const home = makeSandboxHome()
  // Pre-write target .gitignore (block is gated on file existence).
  fs.writeFileSync(path.join(project, '.gitignore'), '# baseline\n')

  // First install.
  const r1 = runInstall({ project, callerCwd: project, homeDir: home })
  assert.equal(r1.status, 0)
  assert.equal(gitignoreLineCount(path.join(project, '.gitignore'), RUN_KEY_PATTERN), 1)

  // Second install.
  const r2 = runInstall({ project, callerCwd: project, homeDir: home })
  assert.equal(r2.status, 0)
  assert.equal(gitignoreLineCount(path.join(project, '.gitignore'), RUN_KEY_PATTERN), 1,
    're-run must NOT duplicate the run.key pattern')
})

// =============================================================================
// install-F3 — pre-existing .gitignore with the line → no duplicate
// =============================================================================
tap('install-F3 pre-existing .gitignore with the line → install does not duplicate', () => {
  const project = makeSandboxProject()
  const home = makeSandboxHome()
  // Pre-write the line.
  fs.writeFileSync(
    path.join(project, '.gitignore'),
    `# pre-existing\n${RUN_KEY_PATTERN}\nnode_modules/\n`,
  )

  const r = runInstall({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 0)
  assert.equal(gitignoreLineCount(path.join(project, '.gitignore'), RUN_KEY_PATTERN), 1,
    'pre-existing line must NOT be duplicated by install')
})

// =============================================================================
// install-fresh — no pre-existing .gitignore on a fresh git repo (install
// creates .episodic-memory/ entry first; bp1 hook is conditional on existing
// gitignore, so this test pins the documented "if .gitignore exists" branch).
// =============================================================================
// =============================================================================
// install-fresh — no pre-existing .gitignore: install creates one with both
// .episodic-memory/ entry AND the run.key pattern (codex round-1 A1 fix).
// =============================================================================
tap('install-fresh (codex A1) — no pre-existing .gitignore: install creates one with run.key pattern', () => {
  const project = makeSandboxProject()
  const home = makeSandboxHome()
  // Confirm no .gitignore exists pre-install.
  assert.ok(!fs.existsSync(path.join(project, '.gitignore')))

  const r = runInstall({ project, callerCwd: project, homeDir: home })
  assert.equal(r.status, 0, `install failed: ${r.stderr}`)
  // Install MUST create .gitignore on fresh repos (RFC-004 §671 mandate).
  assert.ok(fs.existsSync(path.join(project, '.gitignore')),
    'install must create .gitignore on fresh repos so run.key never escapes')
  assert.equal(gitignoreLineCount(path.join(project, '.gitignore'), RUN_KEY_PATTERN), 1,
    'fresh-install .gitignore must contain run.key pattern exactly once')
  // .episodic-memory/ should also be there.
  const text = fs.readFileSync(path.join(project, '.gitignore'), 'utf8')
  assert.match(text, /\.episodic-memory\//,
    'fresh-install .gitignore must contain .episodic-memory/ entry')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
