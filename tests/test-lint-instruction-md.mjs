#!/usr/bin/env node
/**
 * test-lint-instruction-md.mjs — self-test for tools/lint-instruction-md.mjs (#203).
 *
 *   t_repo_clean          the repo's tracked markdown passes (instruction files: all three
 *                         checks; every other tracked *.md: unclosed-fence).
 *   t_issue_203_repro     the 2026-05-09 shape — an unclosed ```text fence swallowing a
 *                         "## Rules" section — fails with unclosed-fence at the opening line.
 *   t_no_language         a bare ``` opening fence fails; the closing fence is not flagged.
 *   t_duplicate_sibling   a duplicate heading under the same parent fails; the same text
 *                         under different parents does not (MD024 siblings_only).
 *   t_nested_fences       a longer fence containing ``` lines is one block, not three.
 *   t_scope               in a repo walk, fence-no-language applies to instruction files only.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(REPO, 'tools', 'lint-instruction-md.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lim-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })
  return { code: r.status, json: JSON.parse(r.stdout) }
}
function lintOne(name, text) {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, text)
  return run([p])
}
const checks = (r) => r.json.findings.map((f) => `${f.check}@${f.line}`)

test('t_repo_clean', () => {
  const r = run([])
  assert.equal(r.code, 0, JSON.stringify(r.json.findings))
  assert.ok(r.json.files_checked > 100)
})

test('t_issue_203_repro', () => {
  const r = lintOne('CLAUDE.md', '# Prefs\n\n## Verdict template\n\n```text\nVERDICT: ...\n\n## Rules\n\n1. Rule one\n')
  assert.equal(r.code, 1)
  assert.deepEqual(checks(r), ['unclosed-fence@5'])
})

test('t_no_language', () => {
  const r = lintOne('a.md', '# A\n\n```\nplain\n```\n\n```bash\nls\n```\n')
  assert.deepEqual(checks(r), ['fence-no-language@3'])
})

test('t_duplicate_sibling', () => {
  const r = lintOne('b.md', '# Top\n\n## Rules\n\n### Example\n\n## Other\n\n### Example\n\n## Rules\n')
  assert.deepEqual(checks(r), ['duplicate-heading@11'])
  assert.match(r.json.findings[0].message, /first at line 3/)
})

test('t_nested_fences', () => {
  const r = lintOne('c.md', '# C\n\n````markdown\n```bash\nls\n```\n````\n')
  assert.equal(r.code, 0, JSON.stringify(r.json.findings))
})

test('t_scope', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'repo-'))
  fs.mkdirSync(path.join(root, 'instructions'))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'instructions', 'x.md'), '# X\n\n```\nbare\n```\n')
  fs.writeFileSync(path.join(root, 'docs', 'y.md'), '# Y\n\n```\nbare\n```\n\n```bash\nopen\n')
  const r = run(['--root', root])
  assert.equal(r.code, 1)
  assert.deepEqual(r.json.findings.map((f) => `${f.file}:${f.check}@${f.line}`), ['docs/y.md:unclosed-fence@7', 'instructions/x.md:fence-no-language@3'])
})
