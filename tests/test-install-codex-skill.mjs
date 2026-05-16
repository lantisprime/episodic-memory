#!/usr/bin/env node
/**
 * test-install-codex-skill.mjs — Codex skill install regression.
 *
 * Codex discovers project skills from `.agents/skills/<name>/SKILL.md`.
 * Installing to an arbitrary markdown filename silently creates an inert file.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const INSTALL = path.join(REPO_ROOT, 'install.mjs')

test('install --tool codex writes discoverable .agents skill SKILL.md', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-codex-install-')))
  const home = path.join(tmp, 'home')
  const project = path.join(tmp, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(project, { recursive: true })

  try {
    const r = spawnSync('node', [INSTALL, '--tool', 'codex', '--project', project], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 15000
    })
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)

    const skillPath = path.join(project, '.agents', 'skills', 'episodic-memory', 'SKILL.md')
    const legacyPath = path.join(project, '.agents', 'skills', 'episodic-memory', 'episodic-memory.md')
    assert.equal(fs.existsSync(skillPath), true, 'Codex skill SKILL.md should exist')
    assert.equal(fs.existsSync(legacyPath), false, 'legacy inert episodic-memory.md should not be written')

    const body = fs.readFileSync(skillPath, 'utf8')
    assert.match(body, /^---\nname: episodic-memory\n/m, 'Codex skill must retain YAML frontmatter')
    assert.match(r.stdout, /Installed Codex skill to .*SKILL\.md/, 'installer output should name SKILL.md')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
