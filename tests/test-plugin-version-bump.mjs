#!/usr/bin/env node
/**
 * test-plugin-version-bump.mjs - #644: the plugin version-bump CI gate.
 *
 * Unit-tests the pure decideBump() core, locks CONTENT_PREFIXES against the
 * install-version.mjs artifact enumerator (the installed-surface oracle —
 * codex R1 F3), then drives the REAL scripts/check-plugin-version-bump.mjs
 * against isolated fixture git repos OUTSIDE the checkout, covering the
 * codex R1 fail-open axes: push-tip self-compare, ambient-cwd authority,
 * corrupt-base-as-introduction, quoted pathnames, lax semver.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { decideBump, isContentPath, parseArgs, parseSemver, semverGreater } from '../scripts/check-plugin-version-bump.mjs'
import { perProjectArtifactPairs } from '../scripts/lib/install-version.mjs'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const GATE = path.join(REPO_ROOT, 'scripts/check-plugin-version-bump.mjs')

let pass = 0, fail = 0
const failures = []
const assert = (c, n, d) => { if (c) pass++; else { fail++; failures.push(`${n}${d ? ' - ' + d : ''}`) } }

const present = (v) => ({ state: 'present', version: v })

// --- decideBump unit axes ---------------------------------------------------

{
  const r = decideBump({ changedPaths: ['docs/rfcs/rfc-999.md', 'tests/test-x.mjs'], base: present('0.1.0'), headVersion: '0.1.0' })
  assert(r.ok === true && r.bump_required === false, 'docs+tests only: no bump required', r.reason)
}
{
  const r = decideBump({ changedPaths: ['scripts/em-store.mjs'], base: present('0.1.0'), headVersion: '0.1.0' })
  assert(r.ok === false && r.bump_required === true, 'content change + same version: fail', r.reason)
}
{
  const r = decideBump({ changedPaths: ['scripts/em-store.mjs'], base: present('0.1.0'), headVersion: '0.2.0' })
  assert(r.ok === true, 'content change + greater version: pass', r.reason)
}
{
  const r = decideBump({ changedPaths: ['skills/episodic-memory/SKILL.md'], base: present('0.2.0'), headVersion: '0.1.9' })
  assert(r.ok === false, 'content change + downgrade: fail', r.reason)
}
{
  const r = decideBump({ changedPaths: ['.claude-plugin/plugin.json'], base: present('0.1.0'), headVersion: '0.2.0-rc1' })
  assert(r.ok === false, 'prerelease/non-X.Y.Z head version: fail closed', r.reason)
}
{
  const r = decideBump({ changedPaths: ['install.mjs'], base: { state: 'absent' }, headVersion: '0.1.0' })
  assert(r.ok === true, 'manifest proven absent at merge-base: pass', r.reason)
}
{
  // codex R1 F4: an existing-but-corrupt base manifest is NOT an introduction.
  const r = decideBump({ changedPaths: ['scripts/a.mjs'], base: present(undefined), headVersion: '0.2.0' })
  assert(r.ok === false, 'base manifest missing version field: fail closed', r.reason)
}
{
  const r = decideBump({ changedPaths: ['scripts/a.mjs'], base: present('<unreadable: bad json>'), headVersion: '0.2.0' })
  assert(r.ok === false, 'base manifest unparsable: fail closed', r.reason)
}
{
  // Prefix must bind on path boundaries: install.mjs is an exact file entry,
  // not a prefix — install.mjs.bak must not trip the gate.
  const r = decideBump({ changedPaths: ['install.mjs.bak'], base: present('0.1.0'), headVersion: '0.1.0' })
  assert(r.ok === true && r.bump_required === false, 'exact-file entry does not prefix-match siblings', r.reason)
}
{
  // codex R2 F10: strict fail-closed argv contract.
  assert(parseArgs([]).opts !== undefined, 'parseArgs: empty argv ok')
  assert(parseArgs(['--base-reff', 'main']).error !== undefined, 'parseArgs: unknown flag rejected')
  assert(parseArgs(['main']).error !== undefined, 'parseArgs: positional rejected')
  assert(parseArgs(['--base-ref']).error !== undefined, 'parseArgs: missing value rejected')
  assert(parseArgs(['--base-ref', 'a', '--base-ref', 'b']).error !== undefined, 'parseArgs: duplicate flag rejected')
  assert(parseArgs(['--base-ref', 'a', '--base-sha', 'b']).error !== undefined, 'parseArgs: base-ref + base-sha mutually exclusive')
  assert(parseArgs(['--project', '.', '--base-sha', 'abc']).opts !== undefined, 'parseArgs: valid combination ok')
}
{
  // codex R1 F3 + R2 F9: the runtime data surface is content.
  for (const p of ['patterns/taxonomy.json', 'categories.json', 'activation-classes.json', 'docs/EM_SCRIPTS_GUIDE.md', '.claude/hooks/bp1-approval-check.sh', 'schemas/runtime/structured-alert.schema.json']) {
    const r = decideBump({ changedPaths: [p], base: present('0.1.0'), headVersion: '0.1.0' })
    assert(r.ok === false, `runtime surface path requires bump: ${p}`, r.reason)
  }
}
{
  // codex R1 F6: strict semver — leading zeros rejected, big components exact.
  assert(parseSemver('00.2.0') === null && parseSemver('0.01.0') === null && parseSemver('0.0') === null && parseSemver('v1.2.3') === null, 'parseSemver rejects leading zeros and malformed shapes')
  assert(parseSemver('0.0.0') !== null && parseSemver('10.0.3') !== null, 'parseSemver accepts canonical zero and multi-digit')
  const big = decideBump({ changedPaths: ['scripts/a.mjs'], base: present('0.0.9007199254740992'), headVersion: '0.0.9007199254740993' })
  assert(big.ok === true, 'BigInt compare: above MAX_SAFE_INTEGER still strictly ordered', big.reason)
  const zeros = decideBump({ changedPaths: ['scripts/a.mjs'], base: present('0.1.0'), headVersion: '00.2.0' })
  assert(zeros.ok === false, 'leading-zero head version: fail closed', zeros.reason)
  assert(semverGreater([0n, 2n, 0n], [0n, 1n, 9n]) && !semverGreater([0n, 1n, 0n], [0n, 1n, 0n]), 'semverGreater ordering')
}

// --- conformance: CONTENT_PREFIXES covers the installed-artifact oracle -----

{
  // Every per-project artifact SOURCE the installer enumerates must be gate
  // content — the enumerator grows automatically, so this locks against the
  // hand-list drifting stale (codex R1 F3). Plus the named global-substrate
  // data files install.mjs copies directly.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvb-conf-'))
  let sources = []
  try {
    sources = perProjectArtifactPairs(REPO_ROOT, tmp).map((p) => p.sourceRel)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  assert(sources.length > 0, 'artifact enumerator returned sources')
  const uncovered = sources.filter((s) => !isContentPath(s))
  assert(uncovered.length === 0, 'every enumerated install source is gate content', uncovered.join(', '))
  for (const g of ['categories.json', 'activation-classes.json', 'docs/EM_SCRIPTS_GUIDE.md']) {
    assert(isContentPath(g), `global substrate data file is gate content: ${g}`)
  }
}

// --- E2E against the real script in isolated fixture repos ------------------

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
  // The gate diffs against a baseline; point origin/main at the base commit
  // without needing a network remote.
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return dir
}

function runGate(cwd, ...extra) {
  const r = spawnSync(process.execPath, [GATE, ...extra], { cwd, encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr }
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
  // codex R1 F1: push-event shape. The remote-tracking ref has advanced to the
  // pushed tip (self-compare would see an empty diff); the workflow instead
  // passes the immutable pre-push sha, which must still catch the missing bump.
  const repo = mkRepo()
  const beforeSha = git(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// v2\n')
  git(repo, 'commit', '-aqm', 'pushed content change, no bump')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD') // ref now useless as baseline
  const r = runGate(repo, '--base-sha', beforeSha)
  assert(r.status === 1 && r.json?.ok === false, 'E2E push baseline: explicit before-sha catches missing bump', JSON.stringify(r.json))
  const zero = runGate(repo, '--base-sha', '0'.repeat(40))
  assert(zero.status === 0 && zero.json?.ok === true, 'E2E push baseline: all-zeros before sha (branch creation) passes', JSON.stringify(zero.json))
}
{
  // codex R2 F7: non-fast-forward push. Ancestor A (1.0.0) -> pre-push tip B
  // (5.0.0); force-pushed HEAD H based on A carries 2.0.0. --base-sha B must
  // treat B as the exact baseline and fail the 5.0.0 -> 2.0.0 downgrade;
  // merge-base reduction would compare against A and false-accept.
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }))
  git(repo, 'commit', '-aqm', 'A: 1.0.0')
  const shaA = git(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '5.0.0' }))
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// B\n')
  git(repo, 'commit', '-aqm', 'B: 5.0.0')
  const shaB = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', shaA)
  git(repo, 'checkout', '-qb', 'rewrite')
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '2.0.0' }))
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// H\n')
  git(repo, 'commit', '-aqm', 'H: 2.0.0 (force-push shape)')
  const r = runGate(repo, '--base-sha', shaB)
  assert(r.status === 1 && r.json?.ok === false && r.json?.baseline === shaB,
    'E2E non-fast-forward push: exact base-sha catches the downgrade merge-base would hide', JSON.stringify(r.json))
}
{
  // codex R2 F8: rename out of the surface must still gate (the source
  // endpoint is removed installed content). And into the surface likewise.
  const repo = mkRepo()
  git(repo, 'mv', 'scripts/a.mjs', 'docs/a.mjs')
  git(repo, 'commit', '-qm', 'rename runtime -> excluded')
  const out = runGate(repo)
  assert(out.status === 1 && out.json?.content_paths?.includes('scripts/a.mjs'),
    'E2E rename runtime->excluded: source endpoint still gates', JSON.stringify(out.json))

  const repo2 = mkRepo()
  git(repo2, 'mv', 'docs/readme.md', 'scripts/readme.md')
  git(repo2, 'commit', '-qm', 'rename excluded -> runtime')
  const into = runGate(repo2)
  assert(into.status === 1 && into.json?.content_paths?.includes('scripts/readme.md'),
    'E2E rename excluded->runtime: destination endpoint gates', JSON.stringify(into.json))
}
{
  // codex R2 F10 E2E: unknown flag fails closed with one JSON error.
  const repo = mkRepo()
  const r = runGate(repo, '--base-reff', 'main')
  assert(r.status === 1 && r.json?.status === 'error', 'E2E unknown flag: JSON error, fail closed', JSON.stringify(r.json ?? r.stdout))
}
{
  // codex R1 F2: --project binds authority; ambient cwd must not.
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// v2\n')
  git(repo, 'commit', '-aqm', 'change script')
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pvb-elsewhere-')))
  _tmpDirs.push(elsewhere)
  const r = runGate(elsewhere, '--project', repo)
  assert(r.status === 1 && r.json?.ok === false && r.json?.project_root === repo,
    'E2E --project: audits the declared root from a foreign cwd and reports it', JSON.stringify(r.json))
}
{
  // codex R1 F4: base manifest present but corrupt is NOT "introduced".
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), '{not json')
  git(repo, 'commit', '-aqm', 'corrupt manifest')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '0.2.0' }))
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// v2\n')
  git(repo, 'commit', '-aqm', 'repair + content change')
  const r = runGate(repo)
  assert(r.status === 1 && r.json?.ok === false, 'E2E corrupt base manifest: fail closed, not introduction', JSON.stringify(r.json))
}
{
  // codex R1 F4: base manifest missing its version field.
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture' }))
  git(repo, 'commit', '-aqm', 'versionless manifest')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '0.2.0' }))
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// v2\n')
  git(repo, 'commit', '-aqm', 'add version + content change')
  const r = runGate(repo)
  assert(r.status === 1 && r.json?.ok === false, 'E2E versionless base manifest: fail closed', JSON.stringify(r.json))
}
{
  // True introduction: manifest path absent at base -> pass.
  const repo = mkRepo()
  git(repo, 'rm', '-q', '.claude-plugin/plugin.json')
  git(repo, 'commit', '-qm', 'no manifest yet')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  fs.mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true }) // git rm pruned the empty dir
  fs.writeFileSync(path.join(repo, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '0.1.0' }))
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// v2\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'introduce manifest + content change')
  const r = runGate(repo)
  assert(r.status === 0 && r.json?.ok === true && r.json?.base_manifest?.state === 'absent',
    'E2E proven-absent base manifest: introduction passes', JSON.stringify(r.json))
}
{
  // codex R1 F5: non-ASCII path under default core.quotePath must still match.
  const repo = mkRepo()
  git(repo, 'config', 'core.quotePath', 'true')
  fs.writeFileSync(path.join(repo, 'scripts/é.mjs'), '// unicode\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'unicode script')
  const r = runGate(repo)
  assert(r.status === 1 && r.json?.ok === false && r.json?.content_paths?.some((p) => p.includes('é')),
    'E2E quoted pathname: NUL-delimited diff sees the raw unicode path', JSON.stringify(r.json))
}
{
  // No commits past baseline (nothing to gate): exit 0
  const repo = mkRepo()
  const r = runGate(repo)
  assert(r.status === 0 && r.json?.ok === true, 'E2E no delta vs baseline: pass', JSON.stringify(r.json))
}
{
  // Missing baseline ref -> fail closed, and the one-JSON contract holds on
  // every error path (codex free-hunt 2).
  const repo = mkRepo()
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/main')
  const r = runGate(repo)
  assert(r.status === 1 && r.json?.ok === false, 'E2E missing baseline ref: fail closed with JSON report', JSON.stringify(r.json ?? r.stdout))
}
{
  // Head manifest unreadable -> JSON error, not a raw stack.
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, 'scripts/a.mjs'), '// v2\n')
  git(repo, 'rm', '-q', '--cached', '.claude-plugin/plugin.json')
  git(repo, 'commit', '-aqm', 'drop manifest from HEAD')
  const r = runGate(repo)
  assert(r.status === 1 && r.json?.status === 'error', 'E2E unreadable HEAD manifest: one-JSON error contract', JSON.stringify(r.json ?? r.stdout))
}

console.log(`test-plugin-version-bump: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map(f => `FAIL ${f}`).join('\n')); process.exit(1) }
