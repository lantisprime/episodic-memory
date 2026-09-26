#!/usr/bin/env node
/**
 * test-check-doc-consistency.mjs — self-test for tools/check-doc-consistency.mjs
 * and the docs/_consistency.json registry (#131, #210).
 *
 *   t_repo_consistent   every registered group passes on the repo.
 *   t_registry_shape    the registry holds the groups the issues require (RFC status,
 *                       workplan pointer, hook registration, top-level README parity).
 *   t_rfc_table_drift   missing id, wrong status, wrong title, wrong link, stray id: each named.
 *   t_script_inventory  an undocumented script and a stale internal entry fail; a documented
 *                       or internal one passes; a name that is only a prefix does not count.
 *   t_hook_gates        a gate missing from the manual, a gate not installed, and a wrong
 *                       count all fail against a seeded HOOK_SPECS manifest.
 *   t_same_line         two differing copies of the recipe fail; a missing copy fails.
 *   t_delegate          a delegated validator's non-zero exit is drift.
 *   t_bad_config        an unreadable registry is exit 2, not a pass.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'check-doc-consistency.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })
  return { code: r.status, json: JSON.parse(r.stdout) }
}
/** A seeded repo with `files` and a registry holding `groups`. */
function seeded(files, groups) {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'))
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', '_consistency.json'), JSON.stringify({ groups }))
  return run(['--root', root])
}
const drift = (r, id) => r.json.groups.find((g) => g.id === id).drift

test('t_repo_consistent', () => {
  const r = run([])
  assert.equal(r.code, 0, JSON.stringify(r.json, null, 1))
  assert.ok(r.json.groups.every((g) => g.status === 'ok'))
})

test('t_registry_shape', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', '_consistency.json'), 'utf8'))
  const kinds = Object.fromEntries(reg.groups.map((g) => [g.id, g.kind]))
  assert.deepEqual(kinds, {
    'rfc-status-registry': 'delegate',
    'readme-rfc-table': 'rfc-table',
    'readme-script-inventory': 'script-inventory',
    'user-manual-gates': 'hook-gates',
    'workplan-discovery-recipe': 'same-line',
  })
  assert.ok(reg.groups.every((g) => typeof g.why === 'string' && g.why.length > 20))
})

const INDEX = JSON.stringify({ rfcs: [
  { id: 'RFC-001', title: 'One', status: 'accepted', file: 'RFC-001-one.md' },
  { id: 'RFC-002', title: 'Two', status: 'draft', file: 'RFC-002-two.md' },
  { id: 'RFC-003', title: 'Three', status: 'accepted', file: 'RFC-003-three.md' },
] })

test('t_rfc_table_drift', () => {
  const readme = [
    '# R', '', '## RFCs', '', '| RFC | Title | Status |', '|---|---|---|',
    '| [RFC-001](docs/rfcs/RFC-001-one.md) | One | Accepted (phase 1 shipped) |',
    '| [RFC-002](docs/rfcs/RFC-002-two.md) | Two! | Accepted |',
    '| [RFC-009](docs/rfcs/RFC-009-x.md) | Nine | Draft |',
    '| [RFC-003](docs/rfcs/RFC-003.md) | Three | Accepted |', '', '## Next', '',
    '| [RFC-004](docs/rfcs/RFC-004.md) | outside the section | Draft |',
  ].join('\n')
  const r = seeded({ 'docs/rfcs/_index.json': INDEX, 'README.md': readme }, [{ id: 't', kind: 'rfc-table', index: 'docs/rfcs/_index.json', file: 'README.md', section: 'RFCs', link_prefix: 'docs/rfcs/' }])
  assert.equal(r.code, 1)
  assert.deepEqual(drift(r, 't'), [
    'README.md: RFC-002 title "Two!" != index "Two"',
    'README.md: RFC-002 status "Accepted" != index "draft"',
    'README.md: RFC-003 links "docs/rfcs/RFC-003.md", expected "docs/rfcs/RFC-003-three.md"',
    'README.md: RFC-009 is in the table but not in docs/rfcs/_index.json',
  ])
  const missing = seeded({ 'docs/rfcs/_index.json': INDEX, 'README.md': '## RFCs\n\n| [RFC-001](docs/rfcs/RFC-001-one.md) | One | Accepted |\n' }, [{ id: 't', kind: 'rfc-table', index: 'docs/rfcs/_index.json', file: 'README.md', section: 'RFCs', link_prefix: 'docs/rfcs/' }])
  assert.deepEqual(drift(missing, 't'), [
    'README.md: RFC-002 (draft) is in docs/rfcs/_index.json but missing from the table',
    'README.md: RFC-003 (accepted) is in docs/rfcs/_index.json but missing from the table',
  ])
})

test('t_script_inventory', () => {
  const files = {
    'scripts/em-a.mjs': '', 'scripts/em-ab.mjs': '', 'scripts/helper.mjs': '', 'scripts/lib/deep.mjs': '',
    'README.md': '## Scripts Reference\n\n`node scripts/em-a.mjs`\n\n## Other\n\nem-ab.mjs is mentioned outside the section.\n',
  }
  const g = { id: 't', kind: 'script-inventory', scripts_dir: 'scripts', file: 'README.md', section: 'Scripts Reference', internal: { 'helper.mjs': 'hook plumbing', 'gone.mjs': 'was removed' } }
  const r = seeded(files, [g])
  assert.equal(r.code, 1)
  assert.deepEqual(drift(r, 't'), [
    'scripts/em-ab.mjs is neither documented in README.md "## Scripts Reference" nor listed as internal in the registry',
    'internal entry gone.mjs does not exist in scripts/ (delete it from the registry)',
  ])
})

test('t_hook_gates', () => {
  const manifest = "export const HOOK_SPECS = [{ file: 'a-gate.sh' }, { file: 'b-gate.sh' }, { file: 'b-gate.sh' }, { file: 'helper.sh' }]\n"
  const manual = (bullets, n) => `## Scenario 12\n\n**${n} installed gates:**\n${bullets.map((b) => `- **${b}** — does things.`).join('\n')}\n\n## After\n`
  const g = { id: 't', kind: 'hook-gates', manifest: 'm.mjs', file: 'M.md', section: 'Scenario 12' }
  const good = seeded({ 'm.mjs': manifest, 'M.md': manual(['A-gate', 'B-gate'], 'Two') }, [g])
  assert.equal(good.code, 0, JSON.stringify(good.json))
  const bad = seeded({ 'm.mjs': manifest, 'M.md': manual(['A-gate', 'C-gate'], 'Three') }, [g])
  assert.deepEqual(drift(bad, 't'), [
    'M.md: installed gate b-gate (m.mjs HOOK_SPECS) is not listed',
    'M.md: lists c-gate, which m.mjs HOOK_SPECS does not install',
    'M.md: says "Three installed gates" but 2 are installed (a-gate, b-gate)',
  ])
})

test('t_same_line', () => {
  const g = { id: 't', kind: 'same-line', pattern: 'em-search\\.mjs --tag workplan', files: ['A.md', 'B.md', 'C.md'] }
  const r = seeded({ 'A.md': 'node scripts/em-search.mjs --tag workplan --limit 1\n', 'B.md': 'node scripts/em-search.mjs --tag workplan --limit 2\n', 'C.md': 'nothing\n' }, [g])
  assert.equal(r.code, 1)
  assert.deepEqual(drift(r, 't'), [
    'C.md: expected exactly 1 line matching /em-search\\.mjs --tag workplan/, found 0',
    'B.md:1 "node scripts/em-search.mjs --tag workplan --limit 2" differs from A.md:1 "node scripts/em-search.mjs --tag workplan --limit 1"',
  ])
})

test('t_delegate', () => {
  const r = seeded({ 'v.mjs': "console.log('RFC-9 mismatch'); process.exit(1)\n" }, [{ id: 't', kind: 'delegate', command: ['v.mjs'] }])
  assert.equal(r.code, 1)
  assert.deepEqual(drift(r, 't'), ['v.mjs exited 1: RFC-9 mismatch'])
})

test('t_bad_config', () => {
  const r = run(['--config', path.join(tmp, 'nope.json')])
  assert.equal(r.code, 2)
  assert.equal(r.json.status, 'error')
})
