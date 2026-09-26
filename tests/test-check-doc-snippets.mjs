#!/usr/bin/env node
/**
 * test-check-doc-snippets.mjs — self-test for tools/check-doc-snippets.mjs (#130).
 *
 *   t_repo_clean        the repo's docs pass (real scripts, real --help).
 *   t_issue_122_repro   PR #122's `em-search --tags workplan` fails as unknown-flag.
 *   t_help_gap          a flag the script parses but omits from --help is a help gap, not a failure.
 *   t_continuation      a flag on a `\`-continued line of a fenced command is still checked.
 *   t_anchors           broken #fragment and missing link target fail; a real heading passes.
 *   t_scope             in a seeded repo: docs/ flags checked, docs/rfcs anchors-only,
 *                       docs/plans skipped, a missing script fails, a --help that exits
 *                       non-zero is reported unverifiable.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'check-doc-snippets.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })
  return { code: r.status, json: JSON.parse(r.stdout) }
}
function doc(name, text) {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, text)
  return p
}
const found = (r) => r.json.findings.map((f) => `${f.check}@${f.line}: ${f.message}`)

test('t_repo_clean', () => {
  const r = run([])
  assert.equal(r.code, 0, JSON.stringify(r.json.findings))
  assert.ok(r.json.commands_checked > 100, `commands_checked=${r.json.commands_checked}`)
  assert.ok(r.json.anchor_links_checked > 50, `anchor_links_checked=${r.json.anchor_links_checked}`)
})

test('t_issue_122_repro', () => {
  const p = doc('claude122.md', '# Start\n\n```bash\nnode scripts/em-search.mjs --tags workplan --category decision --limit 1\n```\n')
  const r = run([p])
  assert.equal(r.code, 1)
  assert.deepEqual(found(r), ['unknown-flag@4: --tags is not in `node scripts/em-search.mjs --help`'])
})

test('t_help_gap', () => {
  const p = doc('gap.md', 'Run `node scripts/second-opinion.mjs request --provider codex --body-file plan.md`.\n')
  const r = run([p])
  assert.equal(r.code, 0, JSON.stringify(r.json.findings))
  assert.deepEqual(r.json.help_gaps.map((g) => g.flag), ['scripts/second-opinion.mjs --body-file'])
})

test('t_continuation', () => {
  const p = doc('cont.md', '# C\n\n```bash\nnode ~/.episodic-memory/scripts/em-store.mjs --project p \\\n  --category decision --no-such-flag x\n```\n')
  const r = run([p])
  assert.deepEqual(found(r), ['unknown-flag@4: --no-such-flag is not in `node scripts/em-store.mjs --help`'])
})

test('t_anchors', () => {
  const readme = path.relative(tmp, path.join(REPO, 'README.md')).split(path.sep).join('/')
  const p = doc('links.md', `# L\n\n[ok](${readme}#supported-tools) [bad](${readme}#no-such-heading) [gone](nope.md#x) [self](#l) [ext](https://x.test/#y)\n`)
  const r = run([p])
  assert.deepEqual(found(r).map((s) => s.split(':')[0]), ['missing-anchor@3', 'missing-link-target@3'])
  assert.equal(r.json.anchor_links_checked, 4)
})

test('t_scope', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'))
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  w('scripts/fake.mjs', "console.log(JSON.stringify({ status: 'help', usage: 'node fake.mjs [--alpha]' }))\n")
  w('scripts/nohelp.mjs', 'process.exit(2)\n')
  w('docs/guide.md', '# G\n\n`node scripts/fake.mjs --beta` `node scripts/nohelp.mjs --x` `node scripts/ghost.mjs`\n')
  w('docs/rfcs/RFC-900-x.md', '# R\n\n`node scripts/fake.mjs --beta` [a](../guide.md#nope)\n')
  w('docs/plans/p.md', '# P\n\n`node scripts/fake.mjs --beta` [a](#nope)\n')
  const r = run(['--root', root])
  assert.equal(r.code, 1)
  assert.deepEqual(r.json.findings.map((f) => `${f.file}:${f.check}`).sort(), [
    'docs/guide.md:missing-script',
    'docs/guide.md:unknown-flag',
    'docs/rfcs/RFC-900-x.md:missing-anchor',
  ])
  assert.deepEqual(r.json.unverifiable, [{ script: 'scripts/nohelp.mjs', reason: '--help exited 2' }])
})
