#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const INSTALL = path.join(REPO, 'install.mjs')
const tmpRoots = []
process.on('exit', () => {
  if (process.env.EM_KEEP_TMP === '1') return
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true })
})

function fixture(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `em-codex-act-${label}-`)))
  tmpRoots.push(base)
  const home = path.join(base, 'home')
  const project = path.join(base, 'project')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  const init = spawnSync('git', ['init', '--quiet', project], { encoding: 'utf8' })
  assert.equal(init.status, 0, `fixture git init failed: ${init.stderr}`)
  fs.mkdirSync(path.join(project, '.episodic-memory', 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(project, '.episodic-memory', 'episodes', 'keep.md'), 'must survive\n')
  return { base, home, project }
}

function install(F, ...flags) {
  return installAt(F, F.project, ...flags)
}

function installAt(F, project, ...flags) {
  return spawnSync(process.execPath, [INSTALL, '--tool', 'codex', '--project', project, ...flags], {
    cwd: project,
    env: { ...process.env, HOME: F.home },
    encoding: 'utf8',
    timeout: 120000,
  })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function commands(settings, event) {
  return ((settings.hooks && settings.hooks[event]) || []).flatMap((group) =>
    (group.hooks || []).map((hook) => hook.command).filter(Boolean))
}

function treeHash(dir) {
  const hash = crypto.createHash('sha256')
  const walk = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = path.join(current, entry.name)
      hash.update(nextRel)
      if (entry.isDirectory()) walk(abs, nextRel)
      else hash.update(fs.readFileSync(abs))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

function fileHashes(dir) {
  const out = {}
  const walk = (current, rel = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) walk(abs, nextRel)
      else out[nextRel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
    }
  }
  walk(dir)
  return out
}

function testInstallAndUninstall() {
  const F = fixture('cycle')
  const episodes = path.join(F.project, '.episodic-memory', 'episodes')
  const beforeHashes = fileHashes(episodes)

  const result = install(F, '--install-activation')
  assert.equal(result.status, 0, `install failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

  const codexDir = path.join(F.project, '.codex')
  const pluginDir = path.join(codexDir, 'episodic-memory-activation')
  const hooks = readJson(path.join(codexDir, 'hooks.json'))
  const manifest = readJson(path.join(pluginDir, 'manifest.json'))
  assert.equal(manifest.harness, 'codex')
  assert.equal(manifest.blocking, false)
  assert.deepEqual(manifest.project_identity, { slug: 'project', root: F.project })
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'SessionStart']) {
    assert.equal(commands(hooks, event).filter((command) => command.includes('episodic-memory-activation')).length, 1,
      `${event} must have exactly one Codex activation registration`)
  }
  for (const file of ['activation-prompt.sh', 'activation-tool.sh', 'activation-sessionstart.sh', 'activation-hook-run.mjs', 'activation-match.mjs', 'json-instance-validate.mjs']) {
    assert.equal(fs.existsSync(path.join(pluginDir, 'hooks', file)), true, `${file} must be installed`)
  }
  assert.match(result.stdout, /Run "\/hooks" inside Codex.*trust/i)
  const afterHashes = fileHashes(episodes)
  const newFiles = Object.keys(afterHashes).filter((name) => !(name in beforeHashes))
  for (const [name, hash] of Object.entries(beforeHashes)) {
    assert.equal(afterHashes[name], hash, `install must preserve ${name} byte-for-byte`)
  }
  assert.equal(newFiles.length, 1, `install may add exactly one store-identity episode, got ${newFiles.length}: ${newFiles.join(', ')}`)
  const newContent = fs.readFileSync(path.join(episodes, newFiles[0]), 'utf8')
  assert.match(newContent, /^record_type: store-identity$/m, 'new episode must carry record_type: store-identity')
  assert.match(newContent, /^category: context$/m, 'new episode must carry category: context')
  assert.match(newContent, /^store_id: ([0-9a-f]{16}|global)$/m, 'new episode must carry a valid store_id')
  const afterEpisodes = treeHash(episodes)

  const registry = readJson(path.join(F.home, '.episodic-memory', 'installs.json'))
  const row = registry.entries.find((entry) => entry.tool === 'codex' && entry.project_path === F.project)
  assert.equal(row && row.activation_installed, true, 'Codex registry row must record activation_installed:true')

  const uninstall = install(F, '--uninstall-activation')
  assert.equal(uninstall.status, 0, `uninstall failed\nstdout:\n${uninstall.stdout}\nstderr:\n${uninstall.stderr}`)
  const hooksAfter = readJson(path.join(codexDir, 'hooks.json'))
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'SessionStart']) {
    assert.equal(commands(hooksAfter, event).some((command) => command.includes('episodic-memory-activation')), false,
      `${event} activation registration must be removed`)
  }
  assert.equal(fs.existsSync(pluginDir), false, 'Codex activation plugin directory must be removed')
  assert.equal(treeHash(episodes), afterEpisodes, 'uninstall must preserve local episodes byte-for-byte')
}

function testSessionStartOutput() {
  const F = fixture('session')
  const result = install(F, '--install-activation')
  assert.equal(result.status, 0, result.stderr)
  const hook = path.join(F.project, '.codex', 'episodic-memory-activation', 'hooks', 'activation-sessionstart.sh')
  const localIndex = path.join(F.project, '.episodic-memory', 'index.jsonl')
  const indexStat = fs.existsSync(localIndex) ? fs.statSync(localIndex) : { mtimeMs: 0, size: 0 }
  const trigger = {
    schema_version: 4,
    source: { index_mtime_ms: indexStat.mtimeMs, index_size: indexStat.size, playbooks_mtime_ms: 0, playbooks_size: 0 },
    entries: [
      {
        trigger_kind: 'phrase', value: 'codex activation', episode_id: 'lesson-prompt', summary: 'Codex prompt context',
        effective_priority: 5, applies_to_projects: ['project'], applies_to_tools: ['codex'],
      },
      {
        trigger_kind: 'tool', value: 'tool:apply_patch:*', episode_id: 'lesson-tool', summary: 'Codex tool context',
        effective_priority: 5, applies_to_projects: ['project'], applies_to_tools: ['codex'],
      },
    ],
    activity_phrases: {},
    session_start: {
      critical_entries: [],
      entries: [{
        episode_id: 'lesson-1',
        summary: 'Codex session context',
        static_score: 10,
        applies_to_projects: ['project'],
        applies_to_tools: ['codex'],
      }],
      preflight: {},
    },
  }
  fs.writeFileSync(path.join(F.project, '.episodic-memory', 'trigger-index.json'), JSON.stringify(trigger))
  const hookRun = spawnSync('bash', [hook], {
    cwd: F.project,
    env: { ...process.env, HOME: F.home },
    input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: F.project, session_id: 'test' }),
    encoding: 'utf8',
  })
  assert.equal(hookRun.status, 0, hookRun.stderr)
  assert.notEqual(hookRun.stdout.trim(), '', `SessionStart hook emitted no context\nstderr:\n${hookRun.stderr}`)
  const output = JSON.parse(hookRun.stdout)
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart')
  assert.match(output.hookSpecificOutput.additionalContext, /Codex session context/)
  assert.equal('decision' in output, false)
  assert.equal('permissionDecision' in output.hookSpecificOutput, false)

  const runEvent = (file, payload) => spawnSync('bash', [path.join(F.project, '.codex', 'episodic-memory-activation', 'hooks', file)], {
    cwd: F.project,
    env: { ...process.env, HOME: F.home },
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
  const promptRun = runEvent('activation-prompt.sh', { hook_event_name: 'UserPromptSubmit', prompt: 'please use codex activation' })
  assert.equal(promptRun.status, 0, promptRun.stderr)
  assert.match(JSON.parse(promptRun.stdout).hookSpecificOutput.additionalContext, /Codex prompt context/)
  const toolRun = runEvent('activation-tool.sh', {
    hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' },
  })
  assert.equal(toolRun.status, 0, toolRun.stderr)
  const toolOutput = JSON.parse(toolRun.stdout)
  assert.match(toolOutput.hookSpecificOutput.additionalContext, /Codex tool context/)
  assert.equal('permissionDecision' in toolOutput.hookSpecificOutput, false)
}

function testFailurePaths() {
  const malformed = fixture('malformed')
  fs.mkdirSync(path.join(malformed.project, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(malformed.project, '.codex', 'hooks.json'), '{bad')
  const malformedEpisodes = path.join(malformed.project, '.episodic-memory', 'episodes')
  const beforeHashes = fileHashes(malformedEpisodes)
  const rejected = install(malformed, '--install-activation')
  assert.equal(rejected.status, 0)
  assert.match(rejected.stdout, /aborted — nothing changed/)
  assert.equal(fs.existsSync(path.join(malformed.project, '.codex', 'episodic-memory-activation')), false)
  const afterHashes = fileHashes(malformedEpisodes)
  const newFiles = Object.keys(afterHashes).filter((name) => !(name in beforeHashes))
  for (const [name, hash] of Object.entries(beforeHashes)) {
    assert.equal(afterHashes[name], hash, `install must preserve ${name} byte-for-byte`)
  }
  assert.equal(newFiles.length, 1, `install may add exactly one store-identity episode, got ${newFiles.length}: ${newFiles.join(', ')}`)
  const newContent = fs.readFileSync(path.join(malformedEpisodes, newFiles[0]), 'utf8')
  assert.match(newContent, /^record_type: store-identity$/m, 'new episode must carry record_type: store-identity')
  assert.match(newContent, /^category: context$/m, 'new episode must carry category: context')
  assert.match(newContent, /^store_id: ([0-9a-f]{16}|global)$/m, 'new episode must carry a valid store_id')

  const idempotent = fixture('idempotent')
  fs.mkdirSync(path.join(idempotent.project, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(idempotent.project, '.codex', 'hooks.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep-me', timeout: 1 }] }] },
  }))
  assert.equal(install(idempotent, '--install-activation').status, 0)
  assert.equal(install(idempotent, '--install-activation').status, 0)
  const hooks = readJson(path.join(idempotent.project, '.codex', 'hooks.json'))
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'SessionStart']) {
    assert.equal(commands(hooks, event).filter((command) => command.includes('episodic-memory-activation')).length, 1)
  }

  const modified = path.join(idempotent.project, '.codex', 'episodic-memory-activation', 'hooks', 'activation-hook-run.mjs')
  fs.appendFileSync(modified, '\n// operator modification\n')
  const removed = install(idempotent, '--uninstall-activation')
  assert.equal(removed.status, 0)
  assert.equal(fs.existsSync(modified), true, 'modified Codex activation file must survive uninstall')
  assert.equal(fs.existsSync(path.join(idempotent.project, '.codex', 'episodic-memory-activation', 'manifest.json')), true,
    'ownership manifest must remain beside a preserved modified file')
  assert.match(fs.readFileSync(modified, 'utf8'), /operator modification/)
  assert.equal(commands(readJson(path.join(idempotent.project, '.codex', 'hooks.json')), 'SessionStart').includes('echo keep-me'), true,
    'unrelated Codex hooks must survive activation install and uninstall')

  const nestedFixture = fixture('nested')
  const nested = path.join(nestedFixture.project, 'packages', 'app')
  fs.mkdirSync(nested, { recursive: true })
  const nestedInstall = installAt(nestedFixture, nested, '--install-activation')
  assert.equal(nestedInstall.status, 0, nestedInstall.stderr)
  const nestedManifest = readJson(path.join(nested, '.codex', 'episodic-memory-activation', 'manifest.json'))
  assert.deepEqual(nestedManifest.project_identity, { slug: 'project', root: nestedFixture.project },
    'nested registration must read the canonical repository episode store')
  assert.equal(fs.existsSync(path.join(nestedFixture.project, '.codex', 'episodic-memory-activation')), false,
    'registration must remain at the literal nested target')
}

testInstallAndUninstall()
testSessionStartOutput()
testFailurePaths()
console.log('test-codex-activation-install: 3 passed')
