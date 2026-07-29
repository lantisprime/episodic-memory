#!/usr/bin/env node
// test-rfc-015-p1-s3a-resurfacing.mjs — RFC-015 P1-S3a (R7a re-surfacing + the
// R7b read-boundary amendment package). 29 legs across four groups (plan §14):
//   Group 1 (9): tail read + bound (REQ-1, REQ-1b, REQ-1c, REQ-2)
//   Group 2 (8): the unread join (REQ-4, REQ-8b, REQ-9)
//   Group 3 (9): bounds + ordering (REQ-5, REQ-6, REQ-7, REQ-8, REQ-11, REQ-12)
//   Group 4 (3): fail-open + advisory ceiling + regression pins (REQ-10/16/17)
//
// No leg invokes any em-* script (plan §A.2 rule 9): trigger-index and
// activation-log fixtures are hand-written JSON, exactly as the P1-S2 suite
// writes its index.jsonl rows directly. Group 1/2-unit legs import
// loadInjectState / matchActivation from scripts/lib/* directly — NEVER from
// the hook (importing the hook runs main() and process.exit(0), which would
// kill the test process before any assertion runs, plan R1-F2).
//
// Hook-driving legs spawn the REAL, committed activation-hook-run.mjs bytes
// copied into an isolated fake-repo tree (mirrors tests/test-activation-hook-
// e2e.mjs's rationale: the hook resolves scripts/lib/* relative to itself, so
// driving it without writing a scratch manifest.json into the TRACKED
// plugins/claude-code-activation/ directory requires a scratch copy that
// mirrors the real repo's relative depth), with both HOME and USERPROFILE
// pointed into the fixture (cross-platform, P1-S1 convention).
//
// Run: node tests/test-rfc-015-p1-s3a-resurfacing.mjs   (exit 0 = pass)

import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadInjectState, RESURFACE_TAIL_MAX_BYTES } from '../scripts/lib/activation-log.mjs'
import { matchActivation } from '../scripts/lib/activation-match.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const HOOK = path.join(REPO, 'plugins/claude-code-activation/hooks/activation-hook-run.mjs')
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null

let pass = 0, fail = 0
async function t(name, fn) {
  if (ONLY && name !== ONLY) return
  try { await fn(); pass++; console.log(`ok   ${name}`) }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.stack || e.message}`) }
}

function mkFixture(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `em-s3a-h-${tag}-`))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), `em-s3a-p-${tag}-`))
  fs.mkdirSync(path.join(proj, '.episodic-memory'), { recursive: true })
  return { home, proj, store: path.join(proj, '.episodic-memory') }
}

// ---------------------------------------------------------------------------
// Fake-repo scaffold (module-level, built ONCE), mirroring
// tests/test-activation-hook-e2e.mjs: copy scripts/ + schemas/ +
// activation-classes.json + the real committed hook bytes into an isolated
// temp tree so the hook's relative-to-itself asset resolution finds
// everything, without ever writing into the tracked plugins/ directory.
// ---------------------------------------------------------------------------
const FAKE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-s3a-repo-')))
fs.cpSync(path.join(REPO, 'scripts'), path.join(FAKE_ROOT, 'scripts'), { recursive: true })
fs.cpSync(path.join(REPO, 'schemas'), path.join(FAKE_ROOT, 'schemas'), { recursive: true })
fs.copyFileSync(path.join(REPO, 'activation-classes.json'), path.join(FAKE_ROOT, 'activation-classes.json'))
const FAKE_HOOKS_DIR = path.join(FAKE_ROOT, 'plugins/claude-code-activation/hooks')
fs.mkdirSync(FAKE_HOOKS_DIR, { recursive: true })
const FAKE_HOOK_PATH = path.join(FAKE_HOOKS_DIR, 'activation-hook-run.mjs')
fs.copyFileSync(HOOK, FAKE_HOOK_PATH)
const FAKE_MANIFEST_PATH = path.join(FAKE_ROOT, 'plugins/claude-code-activation/manifest.json')

function writeManifest({ slug, root }) {
  fs.writeFileSync(FAKE_MANIFEST_PATH, JSON.stringify({
    type: 'activation', schema_version: '1.0.0', id: 'claude-code', harness: 'claude-code', version: '1.0.0',
    blocking: false,
    capabilities: { user_prompt_submit: 'STRONG', pre_tool_use: 'STRONG', session_start: 'STRONG' },
    registrations: [],
    io_schema: 'schemas/runtime/activation-io.schema.json',
    runbook: { full: 'x', quickref: 'y' },
    project_identity: { slug, root },
  }))
}

function runHook(eventName, { home, stdin, extraEnv = {} }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv }
  delete env.CLAUDE_CONFIG_DIR
  const r = spawnSync(process.execPath, [FAKE_HOOK_PATH, eventName], {
    cwd: home,
    env,
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    timeout: 15000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function parseHookOut(stdout) {
  const line = stdout.trim()
  if (!line) return null
  return JSON.parse(line)
}
function noDecisionField(s) {
  return !/"decision"|"block"|"permissionDecision"/.test(s)
}

// ---------------------------------------------------------------------------
// Store fixture writer: hand-written trigger-index.json, stat-matched against
// a hand-written index.jsonl so the FRESH path is always taken and no
// em-trigger-index.mjs subprocess is ever spawned (plan §A.2 rule 9).
// ---------------------------------------------------------------------------
function writeStore(store, { entries = [], sessionStart } = {}) {
  fs.mkdirSync(store, { recursive: true })
  const jsonlPath = path.join(store, 'index.jsonl')
  fs.writeFileSync(jsonlPath, '')
  const st = fs.statSync(jsonlPath)
  const doc = {
    schema_version: 4,
    source: { index_mtime_ms: st.mtimeMs, index_size: st.size, playbooks_mtime_ms: 0, playbooks_size: 0 },
    entries,
    activity_phrases: {},
  }
  if (sessionStart) doc.session_start = sessionStart
  fs.writeFileSync(path.join(store, 'trigger-index.json'), JSON.stringify(doc))
}

function defaultSessionStart(playbooks = []) {
  return { critical_entries: [], entries: [], preflight: {}, playbooks }
}

function playbookRow({ id, accessCount = 0, summary = 'a playbook summary', readCommand } = {}) {
  const row = { episode_id: id, summary, access_count: accessCount, effective_priority: 0, source_scope: 'local', entry_class: 'playbook' }
  if (readCommand !== undefined) row.read_command = readCommand
  return row
}

function writeLog(store, rows) {
  fs.writeFileSync(path.join(store, 'activation-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}
function appendLog(store, row) {
  fs.appendFileSync(path.join(store, 'activation-log.jsonl'), JSON.stringify(row) + '\n')
}
function logRow({ ts, surface = 'session_start', entries, v = 1 }) {
  return { v, ts, project: 'acme', event: 'inject', surface, entries }
}

// ===========================================================================
// Group 1: tail read + bound (REQ-1, REQ-1b, REQ-1c, REQ-2) — 9 legs
// ===========================================================================

await t('t1_tail_parse', async () => {
  const { store } = mkFixture('t1')
  writeLog(store, [
    logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'AAA', access_count_at_inject: 1 }] }),
    logRow({ ts: '2026-01-02T00:00:00Z', entries: [{ id: 'BBB', access_count_at_inject: 2 }] }),
    logRow({ ts: '2026-01-03T00:00:00Z', entries: [{ id: 'AAA', access_count_at_inject: 5 }] }),
  ])
  const map = loadInjectState(store)
  assert.deepStrictEqual(Object.keys(map).sort(), ['AAA', 'BBB'])
  assert.strictEqual(map.AAA.access_count_at_inject, 5)
})

await t('t1b_tail_bound', async () => {
  const { store } = mkFixture('t1b')
  const logPath = path.join(store, 'activation-log.jsonl')
  const headLine = JSON.stringify(logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'HEAD_SENTINEL', access_count_at_inject: 1 }] })) + '\n'
  const padLine = JSON.stringify({ v: 1, ts: '2026-01-02T00:00:00Z', project: 'acme', event: 'inject', surface: 'session_start', entries: [{ id: 'PAD', access_count_at_inject: 0 }], pad: 'X'.repeat(70000) }) + '\n'
  const tailLine = JSON.stringify(logRow({ ts: '2026-01-03T00:00:00Z', entries: [{ id: 'TAIL_SENTINEL', access_count_at_inject: 1 }] })) + '\n'
  fs.writeFileSync(logPath, headLine + padLine + tailLine)
  const map = loadInjectState(store)
  assert.strictEqual('TAIL_SENTINEL' in map, true)
  assert.strictEqual('HEAD_SENTINEL' in map, false)
})

await t('t1b2_tail_exact_boundary', async () => {
  const { store } = mkFixture('t1b2')
  const logPath = path.join(store, 'activation-log.jsonl')
  const edgeLine = JSON.stringify(logRow({ ts: '2026-01-03T00:00:00Z', entries: [{ id: 'EDGE_SENTINEL', access_count_at_inject: 1 }] })) + '\n'
  // padLine occupies EXACTLY RESURFACE_TAIL_MAX_BYTES bytes and ends on '\n',
  // so the tail window starts exactly at the byte after it (EC4b).
  const padLine = 'X'.repeat(RESURFACE_TAIL_MAX_BYTES - 1) + '\n'
  fs.writeFileSync(logPath, padLine + edgeLine)
  const map = loadInjectState(store)
  assert.strictEqual('EDGE_SENTINEL' in map, true)
})

await t('t1b3_tail_single_huge_line', async () => {
  const { store } = mkFixture('t1b3')
  const logPath = path.join(store, 'activation-log.jsonl')
  fs.writeFileSync(logPath, 'X'.repeat(70000)) // one oversized line, no '\n' anywhere
  const map = loadInjectState(store)
  // Object.keys (not deepStrictEqual against {}) — loadInjectState's map is now
  // Object.create(null) (round-3 H1 NIT), which is content-empty but not
  // prototype-identical to a plain {} literal; the contract under test is
  // "nothing usable, no crash", not the map's prototype.
  assert.strictEqual(Object.keys(map).length, 0)
})

await t('t1c_surface_filter', async () => {
  const { store } = mkFixture('t1c')
  writeLog(store, [logRow({ ts: '2026-01-01T00:00:00Z', surface: 'tool', entries: [{ id: 'TOOLONLY', access_count_at_inject: 1 }] })])
  const map = loadInjectState(store)
  assert.strictEqual('TOOLONLY' in map, false)
})

await t('t1d_version_skip', async () => {
  const { store } = mkFixture('t1d')
  writeLog(store, [{ v: 2, ts: '2026-01-01T00:00:00Z', project: 'acme', event: 'inject', surface: 'session_start', entries: [{ id: 'V2ONLY', access_count_at_inject: 1 }] }])
  const map = loadInjectState(store)
  assert.strictEqual('V2ONLY' in map, false)
})

await t('t1e_entry_malformed_skipped', async () => {
  const { store } = mkFixture('t1e')
  writeLog(store, [logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'NULLACI', access_count_at_inject: null }] })])
  const map = loadInjectState(store)
  assert.strictEqual('NULLACI' in map, false)
})

await t('t2_no_read_off_prompt', async () => {
  const { home, proj, store } = mkFixture('t2')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, {
    entries: [{ trigger_kind: 'tool', value: 'tool:Bash:t2cmd*', episode_id: 'lesson-t2', summary: 'a tool lesson', effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] }],
    sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 73 })]),
  })
  // This log row would SUPPRESS PB1's re-surfacing if it were read on the
  // prompt path (aci === current access_count). Driving SessionStart/
  // PreToolUse with it present-vs-absent and observing byte-identical output
  // is what actually falsifies "the log is never read off-prompt" (R1-F13) —
  // a vacuous fixture (e.g. an empty log) could not distinguish "not read"
  // from "read but had no effect".
  writeLog(store, [logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'PB1', access_count_at_inject: 73 }] })])

  const sessionWithLog = runHook('SessionStart', { home, stdin: {} })
  const toolWithLog = runHook('PreToolUse', { home, stdin: { tool_name: 'Bash', tool_input: { command: 't2cmd now' } } })
  fs.rmSync(path.join(store, 'activation-log.jsonl'), { force: true })
  const sessionNoLog = runHook('SessionStart', { home, stdin: {} })
  const toolNoLog = runHook('PreToolUse', { home, stdin: { tool_name: 'Bash', tool_input: { command: 't2cmd now' } } })

  assert.strictEqual(sessionWithLog.stdout, sessionNoLog.stdout, 'SessionStart output must not depend on activation-log.jsonl presence')
  assert.strictEqual(toolWithLog.stdout, toolNoLog.stdout, 'PreToolUse output must not depend on activation-log.jsonl presence')
})

await t('t3_arity_backcompat', async () => {
  const idx = {
    // deliberately no resurface_playbooks field at all
    entries: [{ trigger_kind: 'phrase', value: 'arityphrase', episode_id: 'lesson-arity', summary: 'arity lesson', effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] }],
  }
  const event = { kind: 'prompt', prompt: 'arityphrase now' }
  const identity = { slug: 'acme', root: '/nonexistent', tool_id: 'claude-code' }
  const suppress = new Set()
  const bounds = { max_matches: 3, max_tokens: 500 }
  const withoutSixth = matchActivation(idx, event, identity, suppress, bounds)
  const withSixthUndefined = matchActivation(idx, event, identity, suppress, bounds, undefined)
  assert.deepStrictEqual(withoutSixth, withSixthUndefined, '5-arg call reproduces the 6-arg-with-undefined call byte-for-byte')
  assert.deepStrictEqual(Object.keys(withoutSixth).sort(), ['entries', 'lines', 'overflowNote'], 'pre-slice 3-field shape is preserved (no totalTokens leak)')
})

// ===========================================================================
// Group 2: the unread join (REQ-4, REQ-8b, REQ-9) — 8 legs
// ===========================================================================

await t('t4_unread_join', async () => {
  const { home, proj, store } = mkFixture('t4')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 73 })]) })
  writeLog(store, [logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'PB1', access_count_at_inject: 73 }] })])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.strictEqual(r.status, 0)
  assert.ok(r.stdout.includes('READ PB1 before proceeding'), `stdout: ${r.stdout}`)
})

await t('t4b_no_row_is_unread', async () => {
  const { home, proj, store } = mkFixture('t4b')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 0 })]) })
  writeLog(store, [])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.ok(r.stdout.includes('PB1'), `stdout: ${r.stdout}`)
})

await t('t4c_log_text_never_rendered', async () => {
  const { home, proj, store } = mkFixture('t4c')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 0 })]) })
  writeLog(store, [{ v: 1, ts: '2026-01-01T00:00:00Z', project: 'INJECT_SENTINEL_9f2a', event: 'inject', surface: 'session_start', entries: [{ id: 'PB1', access_count_at_inject: 0 }] }])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.ok(!r.stdout.includes('INJECT_SENTINEL_9f2a'), `stdout leaked log content: ${r.stdout}`)
})

await t('t4d_missing_access_count', async () => {
  const { home, proj, store } = mkFixture('t4d')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([{ episode_id: 'PB1', summary: 'x', access_count: 'x', effective_priority: 0, source_scope: 'local', entry_class: 'playbook' }]) })
  writeLog(store, [])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.strictEqual(r.status, 0)
  assert.ok(r.stdout.includes('PB1'), `stdout: ${r.stdout}`)
})

await t('t4e_backward_count', async () => {
  const { home, proj, store } = mkFixture('t4e')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 70 })]) })
  writeLog(store, [logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'PB1', access_count_at_inject: 73 }] })])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.ok(r.stdout.includes('PB1'), `stdout: ${r.stdout}`)
})

await t('t8b_aci_source', async () => {
  const idx = { entries: [], resurface_playbooks: [playbookRow({ id: 'PB1', accessCount: 73 })] }
  const event = { kind: 'prompt', prompt: 'anything' }
  const identity = { slug: 'acme', root: '/nonexistent', tool_id: 'claude-code' }
  const suppress = new Set()
  const bounds = { max_matches: 3, max_tokens: 500 }
  const injectState = { PB1: { access_count_at_inject: 74, ts: '2026-01-01T00:00:00Z' } }
  const result = matchActivation(idx, event, identity, suppress, bounds, injectState)
  const entry = result.entries.find((e) => e.id === 'PB1')
  assert.ok(entry, `no entry for PB1: ${JSON.stringify(result)}`)
  assert.strictEqual(entry.access_count_at_inject, 73)
  assert.notStrictEqual(entry.access_count_at_inject, 74)
})

await t('t9_read_suppresses', async () => {
  const { home, proj, store } = mkFixture('t9')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 74 })]) })
  writeLog(store, [logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'PB1', access_count_at_inject: 73 }] })])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.ok(!r.stdout.includes('PB1'), `stdout should not contain PB1: ${r.stdout}`)
})

await t('t9b_three_events_no_read', async () => {
  const { home, proj, store } = mkFixture('t9b')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 73 })]) })
  writeLog(store, [logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'PB1', access_count_at_inject: 73 }] })])
  // Each event's own render appends its own inject row (REQ-8) to the SAME
  // log the hook reads next time — no manual append needed; this is exactly
  // the C1 loop invariant under live production behavior.
  for (let i = 0; i < 3; i++) {
    const r = runHook('UserPromptSubmit', { home, stdin: { prompt: `event number ${i}` } })
    assert.ok(r.stdout.includes('PB1'), `event ${i} stdout: ${r.stdout}`)
  }
})

// ===========================================================================
// Group 3: bounds + ordering (REQ-5, REQ-6, REQ-7, REQ-8, REQ-11, REQ-12) — 9 legs
// ===========================================================================

await t('t5_one_line_max', async () => {
  const { home, proj, store } = mkFixture('t5')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, {
    sessionStart: defaultSessionStart([
      playbookRow({ id: 'PB1', accessCount: 0 }),
      playbookRow({ id: 'PB2', accessCount: 0 }),
      playbookRow({ id: 'PB3', accessCount: 0 }),
    ]),
  })
  writeLog(store, [])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  const out = parseHookOut(r.stdout)
  assert.ok(out, `no output: ${r.stdout}`)
  const lines = out.hookSpecificOutput.additionalContext.split('\n')
  const playbookLines = lines.filter((l) => /^playbook \(playbooks\.json\)/.test(l))
  assert.strictEqual(playbookLines.length, 1, `expected exactly 1 playbook line, got: ${JSON.stringify(lines)}`)
})

await t('t6_round_robin', async () => {
  const { home, proj, store } = mkFixture('t6')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, {
    sessionStart: defaultSessionStart([
      playbookRow({ id: 'PB1', accessCount: 0 }),
      playbookRow({ id: 'PB2', accessCount: 0 }),
    ]),
  })
  writeLog(store, [
    logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'PB1', access_count_at_inject: 0 }] }),
    logRow({ ts: '2026-01-02T00:00:00Z', entries: [{ id: 'PB2', access_count_at_inject: 0 }] }),
  ])
  const r1 = runHook('UserPromptSubmit', { home, stdin: { prompt: 'first' } })
  assert.ok(r1.stdout.includes('PB1') && !r1.stdout.includes('PB2'), `run1 should render PB1 only: ${r1.stdout}`)
  const r2 = runHook('UserPromptSubmit', { home, stdin: { prompt: 'second' } })
  assert.ok(r2.stdout.includes('PB2') && !r2.stdout.includes('PB1'), `run2 should render PB2 only: ${r2.stdout}`)
})

await t('t7_token_budget_only', async () => {
  const idx = {
    entries: [
      { trigger_kind: 'phrase', value: 'budgetphrase', episode_id: 'lesson-1', summary: 'l1', effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] },
      { trigger_kind: 'phrase', value: 'budgetphrase', episode_id: 'lesson-2', summary: 'l2', effective_priority: 4, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] },
      { trigger_kind: 'phrase', value: 'budgetphrase', episode_id: 'lesson-3', summary: 'l3', effective_priority: 3, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] },
    ],
    resurface_playbooks: [playbookRow({ id: 'PB1', accessCount: 0 })],
  }
  const event = { kind: 'prompt', prompt: 'budgetphrase now' }
  const identity = { slug: 'acme', root: '/nonexistent', tool_id: 'claude-code' }
  const suppress = new Set()
  const bounds = { max_matches: 3, max_tokens: 5000 }
  const result = matchActivation(idx, event, identity, suppress, bounds, {})
  assert.strictEqual(result.lines.length, 4, `expected 4 lines (3 lessons + 1 playbook), got: ${JSON.stringify(result.lines)}`)
  assert.ok(result.lines[3].startsWith('playbook (playbooks.json)'), `4th line should be the playbook line: ${result.lines[3]}`)
})

await t('t7b_symlinked_log_still_fail_open', async () => {
  const { home, proj, store } = mkFixture('t7b')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, {
    entries: [{ trigger_kind: 'phrase', value: 'symphrase', episode_id: 'lesson-sym', summary: 'sym lesson', effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] }],
  })
  const dirTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'em-s3a-symtarget-'))
  fs.symlinkSync(dirTarget, path.join(store, 'activation-log.jsonl'), 'dir')
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'symphrase now' } })
  assert.strictEqual(r.status, 0)
  assert.ok(noDecisionField(r.stdout), `stdout carries a decision field: ${r.stdout}`)
  assert.ok(r.stdout.includes('lesson-sym'), `normal injection should still work: ${r.stdout}`)
})

await t('t8_entry_lockstep', async () => {
  const idx = { entries: [], resurface_playbooks: [playbookRow({ id: 'PB1', accessCount: 0 })] }
  const event = { kind: 'prompt', prompt: 'anything' }
  const identity = { slug: 'acme', root: '/nonexistent', tool_id: 'claude-code' }
  const suppress = new Set()
  const bounds = { max_matches: 3, max_tokens: 500 }
  const result = matchActivation(idx, event, identity, suppress, bounds, {})
  assert.strictEqual(result.entries.length, result.lines.length, `entries/lines out of lockstep: ${JSON.stringify(result)}`)
  assert.strictEqual(result.lines.length, 1)
})

await t('t11_suppress_wins', async () => {
  const { home, proj, store } = mkFixture('t11')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 0 })]) })
  writeLog(store, [])
  fs.writeFileSync(path.join(store, 'lesson-suppress.json'), JSON.stringify({
    schema_version: 1, suppress: [{ episode_id: 'PB1', reason: 'test', added: '2026-07-29' }],
  }))
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.ok(!r.stdout.includes('PB1'), `PB1 should be suppressed: ${r.stdout}`)
})

await t('t12_no_double_render', async () => {
  const { home, proj, store } = mkFixture('t12')
  writeManifest({ slug: 'acme', root: proj })
  // read_command deliberately does NOT contain the episode id, so the
  // "exactly once" substring assertion below is meaningful: renderPlaybookLine
  // always ALSO embeds ${id} in the READ prefix, so an id-bearing read_command
  // would make even a correctly-deduped single render contain the id twice.
  const rc = 'node em-search.mjs --read episode'
  writeStore(store, {
    entries: [{ trigger_kind: 'phrase', value: 'doublephrase', episode_id: 'PB1', summary: 'pb summary', effective_priority: 0, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'], entry_class: 'playbook', read_command: rc }],
    sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 0, summary: 'pb summary', readCommand: rc })]),
  })
  writeLog(store, [])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'doublephrase now' } })
  const count = (r.stdout.match(/PB1/g) || []).length
  assert.strictEqual(count, 1, `PB1 should appear exactly once in stdout, got ${count}: ${r.stdout}`)
})

await t('t12b_zero_lessons_still_resurfaces', async () => {
  const { home, proj, store } = mkFixture('t12b')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { entries: [], sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 0 })]) })
  writeLog(store, [])
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.ok(r.stdout.includes('PB1'), `stdout: ${r.stdout}`)
})

await t('t12c_scrollout_treated_unread', async () => {
  const { home, proj, store } = mkFixture('t12c')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, { sessionStart: defaultSessionStart([playbookRow({ id: 'PB1', accessCount: 74 })]) })
  const logPath = path.join(store, 'activation-log.jsonl')
  const pb1Row = JSON.stringify(logRow({ ts: '2026-01-01T00:00:00Z', entries: [{ id: 'PB1', access_count_at_inject: 73 }] })) + '\n'
  const padRow = JSON.stringify({ v: 1, ts: '2026-01-02T00:00:00Z', project: 'acme', event: 'inject', surface: 'session_start', entries: [{ id: 'PAD', access_count_at_inject: 0 }], pad: 'X'.repeat(70000) }) + '\n'
  fs.writeFileSync(logPath, pb1Row + padRow)
  const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'anything' } })
  assert.ok(r.stdout.includes('PB1'), `PB1 should re-surface once its inject row scrolls out of the tail window: ${r.stdout}`)
})

// ===========================================================================
// Group 4: fail-open + advisory ceiling + regression pins (REQ-10/16/17) — 3 legs
// ===========================================================================

await t('t10_fail_open', async () => {
  const cases = ['absent', 'empty', 'truncated', 'garbage', 'directory']
  for (const kind of cases) {
    const { home, proj, store } = mkFixture(`t10-${kind}`)
    writeManifest({ slug: 'acme', root: proj })
    writeStore(store, {
      entries: [{ trigger_kind: 'phrase', value: 'failopenphrase', episode_id: 'lesson-fo', summary: 'fail-open lesson', effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] }],
    })
    const logPath = path.join(store, 'activation-log.jsonl')
    if (kind === 'empty') {
      fs.writeFileSync(logPath, '')
    } else if (kind === 'truncated') {
      fs.writeFileSync(logPath, '{"v":1,"ts":"2026-01-01T00:00:00Z","project":"acme","event":"inject","surface":"session_start","entries":[{"id":"PB1","access_count_at_inject"')
    } else if (kind === 'garbage') {
      fs.writeFileSync(logPath, 'not json at all\nmore garbage\n')
    } else if (kind === 'directory') {
      fs.mkdirSync(logPath)
    } // 'absent': no file at all
    const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'failopenphrase now' } })
    assert.strictEqual(r.status, 0, `[${kind}] exit code`)
    assert.ok(noDecisionField(r.stdout), `[${kind}] decision field leaked: ${r.stdout}`)
    assert.ok(r.stdout.includes('lesson-fo'), `[${kind}] normal injection broken: ${r.stdout}`)
  }
})

await t('t16_env_independence_prompt', async () => {
  const { home, proj, store } = mkFixture('t16')
  writeManifest({ slug: 'acme', root: proj })
  writeStore(store, {
    // No session_start.playbooks declared at all -> pickResurfacePlaybook
    // returns null at state A regardless of injectState (plan EC7): output
    // cannot vary with the log's content or growth.
    entries: [{ trigger_kind: 'phrase', value: 'envphrase', episode_id: 'lesson-env', summary: 'env lesson', effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] }],
  })
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'distractor' }))
  const bogusClassesPath = path.join(proj, 'bogus-activation-classes.json')
  fs.writeFileSync(bogusClassesPath, JSON.stringify({ version: '9.9.9', classes: [] }))

  const variants = [
    { extraEnv: {} },
    { extraEnv: { EM_ACTIVATION_CLASSES_PATH: bogusClassesPath } },
    { extraEnv: { EM_ACTIVATION_CLASSES_PATH: path.join(proj, 'does-not-exist.json') } },
    { extraEnv: {} },
  ]
  const outputs = []
  for (const [i, v] of variants.entries()) {
    // The log GROWS across variants (a fresh inject row each pass) — must not
    // move the output since no playbook is declared (EC7).
    appendLog(store, logRow({ ts: `2026-01-0${i + 1}T00:00:00Z`, entries: [{ id: `NOISE${i}`, access_count_at_inject: i }] }))
    const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'envphrase now' }, extraEnv: v.extraEnv })
    outputs.push(r.stdout)
  }
  assert.ok(outputs.every((o) => o === outputs[0]), `outputs diverged across variants: ${JSON.stringify(outputs)}`)
})

await t('t17_advisory_ceiling', async () => {
  const cases = ['absent', 'empty', 'truncated', 'garbage', 'directory', 'symlink']
  for (const kind of cases) {
    const { home, proj, store } = mkFixture(`t17-${kind}`)
    writeManifest({ slug: 'acme', root: proj })
    writeStore(store, {
      entries: [{ trigger_kind: 'phrase', value: 'ceilingphrase', episode_id: 'lesson-ceil', summary: 'ceiling lesson', effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'] }],
    })
    const logPath = path.join(store, 'activation-log.jsonl')
    if (kind === 'empty') {
      fs.writeFileSync(logPath, '')
    } else if (kind === 'truncated') {
      fs.writeFileSync(logPath, '{"v":1,"ts":"2026-01-01T00:00:00Z"')
    } else if (kind === 'garbage') {
      fs.writeFileSync(logPath, 'not json\n')
    } else if (kind === 'directory') {
      fs.mkdirSync(logPath)
    } else if (kind === 'symlink') {
      const dirTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'em-s3a-symtarget17-'))
      fs.symlinkSync(dirTarget, logPath, 'dir')
    } // 'absent': no file at all
    const r = runHook('UserPromptSubmit', { home, stdin: { prompt: 'ceilingphrase now' } })
    assert.strictEqual(r.status, 0, `[${kind}] exit code`)
    assert.ok(noDecisionField(r.stdout), `[${kind}] decision field leaked in stdout: ${r.stdout}`)
    assert.ok(noDecisionField(r.stderr), `[${kind}] decision field leaked in stderr: ${r.stderr}`)
  }
})

// ===========================================================================
console.log(`\n${pass}/${pass + fail} pass`)
process.exit(fail ? 1 : 0)
