#!/usr/bin/env node
/**
 * test-plugin-version-bump.mjs - #644: the plugin version-bump CI gate.
 *
 * Unit-tests the pure decideBump() core, then drives the REAL
 * scripts/check-plugin-version-bump.mjs against an isolated fixture git repo
 * OUTSIDE the checkout (red-then-green): content change without a bump must
 * exit 1, with a bump exit 0, docs-only change exits 0 with no bump.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { decideBump, parseSemver, semverGreater } from '../scripts/check-plugin-version-bump.mjs'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const GATE = path.join(REPO_ROOT, 'scripts/check-plugin-version-bump.mjs')

let pass = 0, fail = 0
const failures = []
const assert = (c, n, d) => { if (c) pass++; else { fail++; failures.push(`${n}${d ? ' - ' + d : ''}`) } }

// --- decideBump unit axes ---------------------------------------------------

{
  const r = decideBump({ changedPaths: ['docs/rfcs/rfc-999.md', 'tests/test-x.mjs'], baseVersion: '0.1.0', headVersion: '0.1.0' })
  assert(r.ok === true && r.bump_required === false, 'docs+tests only: no bump required', r.reason)
}
{
  const r = decideBump({ changedPaths: ['scripts/em-store.mjs'], baseVersion: '0.1.0', headVersion: '0.1.0' })
  assert(r.ok === false && r.bump_required === true, 'content change + same version: fail', r.reason)
}
{
  const r = decideBump({ changedPaths: ['scripts/em-store.mjs'], baseVersion: '0.1.0', headVersion: '0.2.0' })
  assert(r.ok === true, 'content change + greater version: pass', r.reason)
}
{
  const r = decideBump({ changedPaths: ['skills/episodic-memory/SKILL.md'], baseVersion: '0.2.0', headVersion: '0.1.9' })
  assert(r.ok === false, 'content change + downgrade: fail', r.reason)
}
{
  const r = decideBump({ changedPaths: ['.claude-plugin/plugin.json'], baseVersion: '0.1.0', headVersion: '0.2.0-rc1' })
  assert(r.ok === false, 'prerelease/non-X.Y.Z head version: fail closed', r.reason)
}
{
  const r = decideBump({ changedPaths: ['install.mjs'], baseVersion: null, headVersion: '0.1.0' })
  assert(r.ok === true, 'manifest absent at merge-base: pass', r.reason)
}
{
  // Prefix must bind on path boundaries: install.mjs is an exact file entry,
  // not a prefix — install.mjs.bak must not trip the gate.
  const r = decideBump({ changedPaths: ['install.mjs.bak'], baseVersion: '0.1.0', headVersion: '0.1.0' })
  assert(r.ok === true && r.bump_required === false, 'exact-file entry does not prefix-match siblings', r.reason)
}
{
  assert(parseSemver('1.2.3') !== null && parseSemver('v1.2.3') === null && parseSemver('1.2') === null, 'parseSemver shape')
  assert(semverGreater([0, 2, 0], [0, 1, 9]) && !semverGreater([0, 1, 0], [0, 1, 0]), 'semverGreater ordering')
}

// --- E2E against the real script in an isolated fixture repo ----------------

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pvb-gate-')))
  _tmpDirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '0.1.0' }))
  fs.writeFileSync(path.join(dir, 'scripts/a.mjs'), '// v1\n')
  fs.writeFileSync(path.join(dir, 'docs/readme.md'), 'v1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  // The gate diffs against a base ref; point origin/main at the base commit
  // without needing a network remote.
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return dir
}

function runGate(cwd) {
  const r = spawnSync(process.execPath, [GATE], { cwd, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { status: r.status, json, stderr: r.stderr }
}

{
  // RED: content change, no bump -> exit 1
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// v2\n')
  git(repo, 'commit', '-aqm', 'change script')
  const r = runGate(repo)
  assert(r.status === 1 && r.json?.ok === false, 'E2E red: content change without bump exits 1', JSON.stringify(r.json))

  // GREEN: bump the version on top -> exit 0
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '0.2.0' }))
  git(repo, 'commit', '-aqm', 'bump version')
  const g = runGate(repo)
  assert(g.status === 0 && g.json?.ok === true && g.json?.bump_required === true, 'E2E green: bump satisfies gate', JSON.stringify(g.json))
}
{
  // Docs-only change -> exit 0, no bump required
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, 'docs/readme.md'), 'v2\n')
  git(repo, 'commit', '-aqm', 'docs only')
  const r = runGate(repo)
  assert(r.status === 0 && r.json?.bump_required === false, 'E2E docs-only: no bump required', JSON.stringify(r.json))
}
{
  // No commits past merge-base (push-to-main shape): exit 0
  const repo = mkRepo()
  const r = runGate(repo)
  assert(r.status === 0 && r.json?.ok === true, 'E2E no delta vs base ref: pass', JSON.stringify(r.json))
}
{
  // Missing base ref -> fail closed
  const repo = mkRepo()
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
  const r = runGate(repo)
  assert(r.status === 1 && r.json?.ok === false, 'E2E missing base ref: fail closed', JSON.stringify(r.json))
}

console.log(`test-plugin-version-bump: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map(f => `FAIL ${f}`).join('\n')); process.exit(1) }
