#!/usr/bin/env node
/**
 * test-install-opencode-pi-agent.mjs — OpenCode + Pi Agent install targets.
 *
 * OpenCode skill discovery is intentionally pinned to the current official
 * docs observed on 2026-05-16:
 * https://opencode.ai/docs/skills
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync, spawnSync } from 'node:child_process'
import test from 'node:test'

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const INSTALL = path.join(REPO_ROOT, 'install.mjs')
const SOURCE_SKILL = fs.readFileSync(path.join(REPO_ROOT, 'instructions', 'SKILL.md'), 'utf8')

function tmpFixture(prefix = 'em-opencode-pi-') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  const caller = path.join(root, 'caller')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(caller, { recursive: true })
  return { root, home, project, caller }
}

function runInstall({ home, cwd, project, tool }) {
  return spawnSync('node', [INSTALL, '--tool', tool, '--project', project], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 30000
  })
}

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init -q -b main')
  git(repo, 'config user.email test@example.com')
  git(repo, 'config user.name test')
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n')
  git(repo, 'add README.md')
  git(repo, 'commit -q -m init')
}

function writeSkill(file, body = SOURCE_SKILL) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

function assertOk(result) {
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
}

const opencodeSkill = (project) =>
  path.join(project, '.opencode', 'skills', 'episodic-memory', 'SKILL.md')
const agentsSkill = (project) =>
  path.join(project, '.agents', 'skills', 'episodic-memory', 'SKILL.md')
const claudeSkill = (project) =>
  path.join(project, '.claude', 'skills', 'episodic-memory', 'SKILL.md')

test('install --tool opencode writes only the native OpenCode skill path', () => {
  const f = tmpFixture()
  try {
    const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'opencode' })
    assertOk(r)
    assert.equal(fs.readFileSync(opencodeSkill(f.project), 'utf8'), SOURCE_SKILL)
    assert.equal(fs.existsSync(agentsSkill(f.project)), false, 'opencode install must not write .agents')
    assert.equal(fs.existsSync(claudeSkill(f.project)), false, 'opencode install must not write .claude')
    assert.equal(fs.existsSync(path.join(f.project, 'AGENTS.md')), false, 'opencode install must not write root AGENTS.md')
    assert.equal(fs.existsSync(path.join(f.project, 'opencode.json')), false, 'opencode install must not write opencode.json')
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('install --tool opencode skips when direct .agents or .claude duplicate exists', () => {
  for (const duplicatePath of [agentsSkill, claudeSkill]) {
    const f = tmpFixture()
    try {
      writeSkill(duplicatePath(f.project), 'user-owned duplicate\n')
      const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'opencode' })
      assertOk(r)
      assert.match(r.stdout, /Skipped OpenCode skill install: existing OpenCode-visible episodic-memory skill found/)
      assert.equal(fs.existsSync(opencodeSkill(f.project)), false)
      assert.equal(fs.readFileSync(duplicatePath(f.project), 'utf8'), 'user-owned duplicate\n')
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test('install --tool opencode scans git ancestors for .opencode/.agents/.claude duplicates', () => {
  for (const duplicatePath of [opencodeSkill, agentsSkill, claudeSkill]) {
    const f = tmpFixture()
    const repo = path.join(f.root, 'repo')
    const nested = path.join(repo, 'sub', 'dir')
    try {
      initRepo(repo)
      fs.mkdirSync(nested, { recursive: true })
      writeSkill(duplicatePath(repo), 'ancestor duplicate\n')
      const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: nested, tool: 'opencode' })
      assertOk(r)
      assert.match(r.stdout, /Skipped OpenCode skill install: existing OpenCode-visible episodic-memory skill found/)
      assert.equal(fs.existsSync(opencodeSkill(nested)), false)
      assert.equal(fs.readFileSync(duplicatePath(repo), 'utf8'), 'ancestor duplicate\n')
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test('install --tool opencode stops duplicate scan at git worktree root', () => {
  const f = tmpFixture()
  const parent = path.join(f.root, 'parent')
  const repo = path.join(parent, 'repo')
  const nested = path.join(repo, 'sub', 'dir')
  try {
    writeSkill(path.join(parent, '.agents', 'skills', 'episodic-memory', 'SKILL.md'), 'above repo\n')
    initRepo(repo)
    fs.mkdirSync(nested, { recursive: true })
    const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: nested, tool: 'opencode' })
    assertOk(r)
    assert.doesNotMatch(r.stdout, /existing OpenCode-visible/)
    assert.equal(fs.readFileSync(opencodeSkill(nested), 'utf8'), SOURCE_SKILL)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('install --tool opencode handles linked worktree roots, not canonical checkout roots', () => {
  const f = tmpFixture()
  const main = path.join(f.root, 'main')
  const linked = path.join(f.root, 'linked')
  const nested = path.join(linked, 'sub', 'dir')
  try {
    initRepo(main)
    git(main, `worktree add -q -b feature ${linked}`)
    fs.mkdirSync(nested, { recursive: true })

    writeSkill(agentsSkill(main), 'canonical duplicate only\n')
    let r = runInstall({ home: f.home, cwd: REPO_ROOT, project: nested, tool: 'opencode' })
    assertOk(r)
    assert.doesNotMatch(r.stdout, /existing OpenCode-visible/)
    assert.equal(fs.readFileSync(opencodeSkill(nested), 'utf8'), SOURCE_SKILL)

    fs.rmSync(opencodeSkill(nested), { force: true })
    writeSkill(agentsSkill(linked), 'linked duplicate\n')
    r = runInstall({ home: f.home, cwd: REPO_ROOT, project: nested, tool: 'opencode' })
    assertOk(r)
    assert.match(r.stdout, /Skipped OpenCode skill install: existing OpenCode-visible episodic-memory skill found/)
    assert.equal(fs.existsSync(opencodeSkill(nested)), false)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('install --tool opencode scans non-git ancestors to filesystem root', () => {
  const f = tmpFixture()
  const ancestor = path.join(f.root, 'plain')
  const nested = path.join(ancestor, 'sub', 'dir')
  try {
    fs.mkdirSync(nested, { recursive: true })
    writeSkill(agentsSkill(ancestor), 'plain ancestor duplicate\n')
    const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: nested, tool: 'opencode' })
    assertOk(r)
    assert.match(r.stdout, /Skipped OpenCode skill install: existing OpenCode-visible episodic-memory skill found/)
    assert.equal(fs.existsSync(opencodeSkill(nested)), false)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('install --tool opencode scans global OpenCode-visible skill locations', () => {
  const globalDuplicates = [
    path.join('.config', 'opencode', 'skills', 'episodic-memory', 'SKILL.md'),
    path.join('.claude', 'skills', 'episodic-memory', 'SKILL.md'),
    path.join('.agents', 'skills', 'episodic-memory', 'SKILL.md'),
  ]
  for (const rel of globalDuplicates) {
    const f = tmpFixture()
    try {
      writeSkill(path.join(f.home, rel), 'global duplicate\n')
      const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'opencode' })
      assertOk(r)
      assert.match(r.stdout, /Skipped OpenCode skill install: existing OpenCode-visible episodic-memory skill found/)
      assert.equal(fs.existsSync(opencodeSkill(f.project)), false)
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test('install --tool opencode rerun no-ops when only intended destination exists', () => {
  const f = tmpFixture()
  try {
    assertOk(runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'opencode' }))
    const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'opencode' })
    assertOk(r)
    assert.match(r.stdout, /OpenCode skill already current/)
    assert.doesNotMatch(r.stdout, /existing OpenCode-visible/)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('install --tool pi-agent shares the canonical .agents skill with Codex', () => {
  const f = tmpFixture()
  try {
    let r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'pi-agent' })
    assertOk(r)
    assert.equal(fs.readFileSync(agentsSkill(f.project), 'utf8'), SOURCE_SKILL)

    r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'codex' })
    assertOk(r)
    assert.match(r.stdout, /Codex skill already current/)
    assert.equal(fs.readFileSync(agentsSkill(f.project), 'utf8'), SOURCE_SKILL)

    fs.rmSync(agentsSkill(f.project), { force: true })
    r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'codex' })
    assertOk(r)
    r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'pi-agent' })
    assertOk(r)
    assert.match(r.stdout, /Pi Agent skill already current/)
    assert.equal(fs.readFileSync(agentsSkill(f.project), 'utf8'), SOURCE_SKILL)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('install --tool all includes pi-agent but excludes opencode', () => {
  const f = tmpFixture()
  try {
    const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'all' })
    assertOk(r)
    assert.equal(fs.existsSync(agentsSkill(f.project)), true, 'all should install shared .agents skill')
    assert.equal(fs.existsSync(opencodeSkill(f.project)), false, 'all must not install native OpenCode skill')
    assert.doesNotMatch(r.stdout, /Installed OpenCode skill/)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('skill installers skip divergent existing files', () => {
  for (const [tool, fileFor] of [['opencode', opencodeSkill], ['pi-agent', agentsSkill]]) {
    const f = tmpFixture()
    try {
      writeSkill(fileFor(f.project), 'user modified\n')
      const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool })
      assertOk(r)
      assert.match(r.stdout, /existing file differs from repo source/)
      assert.equal(fs.readFileSync(fileFor(f.project), 'utf8'), 'user modified\n')
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  }
})

test('install --project writes under target project, not caller cwd', () => {
  const f = tmpFixture()
  try {
    const r = runInstall({ home: f.home, cwd: f.caller, project: f.project, tool: 'pi-agent' })
    assertOk(r)
    assert.equal(fs.existsSync(agentsSkill(f.project)), true)
    assert.equal(fs.existsSync(agentsSkill(f.caller)), false)
    assert.equal(fs.existsSync(path.join(f.project, '.episodic-memory', 'episodes')), true)
    assert.equal(fs.existsSync(path.join(f.caller, '.episodic-memory')), false)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('invalid tool output includes opencode/pi-agent and all exclusion note', () => {
  const f = tmpFixture()
  try {
    const r = runInstall({ home: f.home, cwd: REPO_ROOT, project: f.project, tool: 'bogus' })
    assert.notEqual(r.status, 0)
    assert.match(r.stdout, /opencode/)
    assert.match(r.stdout, /pi-agent/)
    assert.match(r.stdout, /opencode is explicit-only and is not included in all/)
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})
