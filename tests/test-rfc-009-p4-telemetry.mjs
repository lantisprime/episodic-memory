#!/usr/bin/env node
/**
 * test-rfc-009-p4-telemetry.mjs — RFC-009 P4-S1 (R6 telemetry writer, REQ-16/17).
 *
 * Proves the event-plane activation telemetry writer (scripts/lib/activation-log.mjs)
 * is append-only, size-bounded (drop-at-bound, never truncate), and fire-and-forget
 * (a failed write is a stderr note, never a throw). Every assertion inspects real
 * captured runtime state (parsed line, statSync size, module return, thrown flag) —
 * never a constant. The hook path is proven by a mock-project E2E (real install.mjs
 * + the real deployed hook), never mental-trace.
 *
 * Negative controls (§A.9, portable `--break-<x>` argv flags, NOT env vars — the hook
 * + tests must run under Windows `cmd`):
 *   --break-bound     → module ignores the 1 MiB bound → telemetry::dropAtBoundStderr FAILS
 *   --break-writefail → the writer rethrows instead of catching → telemetry::writeFailureNonFatal FAILS
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  appendActivationLine,
  ACTIVATION_LOG_NAME,
  ACTIVATION_LOG_MAX_BYTES,
} from '../scripts/lib/activation-log.mjs'
import { matchActivation } from '../scripts/lib/activation-match.mjs'
import { mkMock, runInstall, runScript, runHook } from './lib/activation-scoping-harness.mjs'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))

// Portable negative-control break override (§A.9-style, matching
// scripts/lib/activation-log.mjs's own --break-<x> convention): a plain argv
// flag, not an env var (must run under Windows `cmd` too). Production runs
// never pass this — it exists ONLY to prove telemetry::entriesFromMatcher has
// teeth by simulating "mergeIndexes never stamped source_scope" (the fixture
// entries arrive with no source_scope at all, exactly as they would if the
// upstream stamping step were reverted).
const BREAK_SCOPE = process.argv.includes('--break-scope')

let pass = 0, fail = 0
const failures = []
function t(name, fn) {
  try { fn(); pass++ }
  catch (e) { fail++; failures.push(`${name} - ${e && e.message}`) }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
}
function ok(cond, label) { if (!cond) throw new Error(label) }

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })
function mkTmp(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p4s1-${label}-`)))
  _tmpDirs.push(base)
  return base
}
// Capture process.stderr.write across a synchronous call.
function withStderrCapture(fn) {
  const orig = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = (chunk) => { captured += String(chunk); return true }
  try { const ret = fn(); return { ret, captured } }
  finally { process.stderr.write = orig }
}

function main() {
  // 1. telemetry::oneLinePerInjection — one append → exactly one schema-valid line
  //    carrying the injected sentinel id; parsed v===1.
  t('telemetry::oneLinePerInjection', () => {
    const dir = mkTmp('oneline')
    const sentinel = `id-${Date.now()}-oneline`
    const ret = appendActivationLine(dir, {
      ts: '2026-07-12T05:44:37Z', project: 'p4s1', event: 'inject', surface: 'per_prompt',
      entries: [{ id: sentinel, effective_priority: 8, rendered: 'imperative', source_scope: 'local', access_count_at_inject: 0 }],
    })
    eq(ret && ret.dropped, false, 'append not dropped')
    const lines = fs.readFileSync(path.join(dir, ACTIVATION_LOG_NAME), 'utf8').split('\n').filter(Boolean)
    eq(lines.length, 1, 'exactly one line')
    const parsed = JSON.parse(lines[0])
    eq(parsed.v, 1, 'v===1')
    eq(parsed.entries[0].id, sentinel, 'entries[0].id === sentinel')
  })

  // 2. telemetry::dropAtBoundStderr — a log pre-filled to MAX-10 bytes rejects the next
  //    line (which exceeds the 10-byte remainder): {dropped:true}, stderr note, size UNCHANGED.
  t('telemetry::dropAtBoundStderr', () => {
    const dir = mkTmp('bound')
    const logPath = path.join(dir, ACTIVATION_LOG_NAME)
    const marker = 'PRESERVE-SENTINEL-b2c3\n'
    const target = ACTIVATION_LOG_MAX_BYTES - 10
    fs.writeFileSync(logPath, 'x'.repeat(target - Buffer.byteLength(marker)) + marker)
    const sizeBefore = fs.statSync(logPath).size
    const { ret, captured } = withStderrCapture(() => appendActivationLine(dir, {
      ts: '2026-07-12T05:44:38Z', project: 'p4s1', event: 'inject', surface: 'per_prompt',
      entries: [{ id: 'id-bound-overflow', effective_priority: 8, rendered: 'plain', source_scope: 'local', access_count_at_inject: 0 }],
    }))
    const sizeAfter = fs.statSync(logPath).size
    eq(ret && ret.dropped, true, 'returns {dropped:true}')
    eq(sizeBefore, sizeAfter, 'file size unchanged')
    ok(/size bound reached; dropping line/.test(captured), 'emits stderr note')
  })

  // 3. telemetry::neverTruncates — the pre-existing last line survives a dropped append
  //    (dropping must not rewrite/truncate the file).
  t('telemetry::neverTruncates', () => {
    const dir = mkTmp('notrunc')
    const logPath = path.join(dir, ACTIVATION_LOG_NAME)
    const marker = 'PRESERVE-SENTINEL-notrunc\n'
    const target = ACTIVATION_LOG_MAX_BYTES - 10
    fs.writeFileSync(logPath, 'x'.repeat(target - Buffer.byteLength(marker)) + marker)
    withStderrCapture(() => appendActivationLine(dir, {
      ts: '2026-07-12T05:44:39Z', project: 'p4s1', event: 'inject', surface: 'per_prompt',
      entries: [{ id: 'id-notrunc-overflow', effective_priority: 8, rendered: 'plain', source_scope: 'local', access_count_at_inject: 0 }],
    }))
    ok(fs.readFileSync(logPath, 'utf8').endsWith(marker), 'pre-existing last line preserved')
  })

  // 4. telemetry::writeFailureNonFatal — an unwritable target (non-existent parent dir)
  //    returns {error:true} and does NOT throw (fire-and-forget, hook stays non-fatal).
  t('telemetry::writeFailureNonFatal', () => {
    const dir = mkTmp('fail')
    const badDir = path.join(dir, 'does', 'not', 'exist')
    let threw = false, ret = null
    try {
      ret = withStderrCapture(() => appendActivationLine(badDir, {
        ts: '2026-07-12T05:44:40Z', project: 'p4s1', event: 'inject', surface: 'per_prompt',
        entries: [{ id: 'id-writefail', effective_priority: 8, rendered: 'plain', source_scope: 'local', access_count_at_inject: 0 }],
      })).ret
    } catch { threw = true }
    ok(!threw, 'did not throw')
    eq(ret && ret.error, true, 'returns {error:true}')
  })

  // 5. telemetry::entriesFromMatcher — matchActivation on a fixture index
  //    holding one 'local' and one 'global' selected entry: entries[] has one
  //    element per rendered line, every element carries all 5 schema keys, and
  //    both source_scope polarities appear (RFC-009 P4-S1 1.2c producer, plan
  //    §12 activationLogLine schema). --break-scope strips source_scope from
  //    the fixture entries (simulating a reverted mergeIndexes stamp) so this
  //    test FAILS, proving the polarity assertion has teeth (1.4b).
  t('telemetry::entriesFromMatcher', () => {
    const index = {
      entries: [
        {
          episode_id: '20260101-000000-entries-local-aaa1', trigger_kind: 'phrase', value: 'alphaword',
          effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'],
          summary: 'local fixture', ...(BREAK_SCOPE ? {} : { source_scope: 'local' }),
        },
        {
          episode_id: '20260101-000000-entries-global-bbb2', trigger_kind: 'phrase', value: 'betaword',
          effective_priority: 5, applies_to_projects: ['acme'], applies_to_tools: ['claude-code'],
          summary: 'global fixture', ...(BREAK_SCOPE ? {} : { source_scope: 'global' }),
        },
      ],
    }
    const event = { kind: 'prompt', prompt: 'alphaword and betaword both fire here' }
    const identity = { slug: 'acme', tool_id: 'claude-code' }
    const r = matchActivation(index, event, identity, new Set(), { max_matches: 3, max_tokens: 500 })
    eq(r.entries.length, r.lines.length, 'entries.length === lines.length')
    eq(r.entries.length, 2, 'both fixture entries selected')
    const keys = ['id', 'effective_priority', 'rendered', 'source_scope', 'access_count_at_inject']
    for (const e of r.entries) {
      for (const k of keys) ok(Object.hasOwn(e, k), `entries[] element carries key ${k}`)
    }
    const scopes = new Set(r.entries.map((e) => e.source_scope))
    ok(scopes.has('local'), `both source_scope polarities appear — 'local' present (got ${JSON.stringify([...scopes])})`)
    ok(scopes.has('global'), `both source_scope polarities appear — 'global' present (got ${JSON.stringify([...scopes])})`)
  })

  // 6. telemetry::hookE2E — mock-project (isolated HOME, real install.mjs),
  //    drive the REAL deployed activation-prompt.sh hook with one injection,
  //    tail the written activation-log.jsonl: exactly one schema-valid line
  //    whose entries[0].source_scope is 'local' or 'global'.
  t('telemetry::hookE2E', () => {
    const M = mkMock('p4s1-telemetry')
    const install = runInstall({
      home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-activation'],
    })
    if (install.status !== 0) throw new Error(`install.mjs --install-activation failed: ${install.stderr}`)

    const manifest = JSON.parse(fs.readFileSync(path.join(M.project, '.claude', 'hooks', 'manifest.json'), 'utf8'))
    const slug = manifest.project_identity.slug

    const store = runScript(M.home, 'em-store.mjs', [
      '--project', slug, '--category', 'lesson', '--tags', 'test',
      '--summary', 'telemetry hookE2E lesson', '--body', 'body',
      '--trigger', 'telemetryhooke2ephrase',
      '--applies-to-project', slug, '--applies-to-tool', 'claude-code',
      '--priority', '5', '--scope', 'local',
    ], { cwd: M.project })
    if (!store.json || store.json.status !== 'ok') throw new Error(`em-store failed: ${store.stdout}\n${store.stderr}`)

    const hookPath = path.join(M.project, '.claude', 'hooks', 'activation-prompt.sh')
    ok(fs.existsSync(hookPath), 'deployed activation-prompt.sh present')

    const r = runHook(hookPath, { prompt: 'telemetryhooke2ephrase now' }, { home: M.home, project: M.project })
    eq(r.status, 0, 'hook exits 0')

    const logPath = path.join(M.project, '.episodic-memory', ACTIVATION_LOG_NAME)
    ok(fs.existsSync(logPath), `activation-log.jsonl written at ${logPath}`)
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    eq(lines.length, 1, 'exactly one line written for one injection')
    const parsed = JSON.parse(lines[0])
    eq(parsed.v, 1, 'v===1')
    ok(Array.isArray(parsed.entries) && parsed.entries.length >= 1, 'entries[] present and non-empty')
    ok(parsed.entries[0].source_scope === 'local' || parsed.entries[0].source_scope === 'global',
      `entries[0].source_scope is 'local' or 'global'; got ${JSON.stringify(parsed.entries[0])}`)
  })

  // 7. telemetry::hookE2ESessionStart — mirrors telemetry::hookE2E but drives
  //    the REAL activation-sessionstart.sh hook with a SessionStart payload.
  //    The lesson is stored with priority 5 (em-store rejects priorities 8/9
  //    directly — they are an EARNED band reserved for the chain-resolved
  //    effective_priority in buildSessionStart), so it lands in the
  //    session_start static-blend entries (tier-2), NOT in critical_entries.
  //    The fixture index.jsonl is rewritten to carry a NONZERO access_count
  //    for the stored episode, em-trigger-index is re-run to refresh the
  //    cache (the freshness check otherwise rejects the on-disk state), and
  //    the hook is invoked. Asserts: (a) surface === 'session_start'; (b)
  //    entries[] non-empty AND every entry has source_scope 'local' or
  //    'global' (never null); (c) access_count_at_inject for the injected
  //    episode equals the EXACT value the fixture index was rewritten with
  //    — proving the build-time access_count stamp (RFC-009 P4-S1 R6 / plan
  //    step 1.2cb) flows through end-to-end WITHOUT a hook-side index.jsonl
  //    read (the prior F4 join is REMOVED in R2-FIX-1).
  t('telemetry::hookE2ESessionStart', () => {
    const M = mkMock('p4s1-telemetry-ss')
    const install = runInstall({
      home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-activation'],
    })
    if (install.status !== 0) throw new Error(`install.mjs --install-activation failed: ${install.stderr}`)

    const manifest = JSON.parse(fs.readFileSync(path.join(M.project, '.claude', 'hooks', 'manifest.json'), 'utf8'))
    const slug = manifest.project_identity.slug

    const store = runScript(M.home, 'em-store.mjs', [
      '--project', slug, '--category', 'lesson', '--tags', 'test',
      '--summary', 'telemetry hookE2ESessionStart lesson', '--body', 'body',
      '--applies-to-project', slug, '--applies-to-tool', 'claude-code',
      '--priority', '5', '--scope', 'local',
    ], { cwd: M.project })
    if (!store.json || store.json.status !== 'ok') throw new Error(`em-store failed: ${store.stdout}\n${store.stderr}`)
    const epId = store.json.id || store.json.episode_id
    ok(typeof epId === 'string' && epId.length > 0, `em-store returned an episode id (got ${JSON.stringify(epId)})`)

    // Rewrite the fixture index.jsonl to carry a NONZERO access_count for the
    // just-stored episode. em-store writes access_count:0 by default; we need
    // a known positive value to assert the F4 join passes it through exactly.
    const FIXTURE_ACCESS_COUNT = 17
    const idxPath = path.join(M.project, '.episodic-memory', 'index.jsonl')
    const idxRaw = fs.readFileSync(idxPath, 'utf8')
    const idxRows = idxRaw.split('\n').filter(Boolean).map((l) => {
      const o = JSON.parse(l)
      if (o.id === epId) o.access_count = FIXTURE_ACCESS_COUNT
      return o
    })
    fs.writeFileSync(idxPath, idxRows.map((o) => JSON.stringify(o)).join('\n') + '\n')

    // Refresh the cached trigger-index so the runner's freshness check (stat
    // legs against the rewritten index.jsonl) passes; without this the stale
    // carve-out would shadow the just-edited access_count.
    const trig = runScript(M.home, 'em-trigger-index.mjs', ['--scope', 'local', '--project', M.project], { cwd: M.project })
    if (trig.status !== 0) throw new Error(`em-trigger-index rebuild failed: ${trig.stdout}\n${trig.stderr}`)

    const hookPath = path.join(M.project, '.claude', 'hooks', 'activation-sessionstart.sh')
    ok(fs.existsSync(hookPath), 'deployed activation-sessionstart.sh present')

    const r = runHook(hookPath, {}, { home: M.home, project: M.project })
    eq(r.status, 0, 'hook exits 0')

    const logPath = path.join(M.project, '.episodic-memory', ACTIVATION_LOG_NAME)
    ok(fs.existsSync(logPath), `activation-log.jsonl written at ${logPath}`)
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    eq(lines.length, 1, 'exactly one line written for one SessionStart injection')
    const parsed = JSON.parse(lines[0])
    eq(parsed.v, 1, 'v===1')
    eq(parsed.surface, 'session_start', `surface === 'session_start' (got ${JSON.stringify(parsed.surface)})`)
    ok(Array.isArray(parsed.entries) && parsed.entries.length >= 1, 'entries[] present and non-empty')
    // (b) every entry's source_scope is 'local' or 'global' (never null)
    for (const [i, e] of parsed.entries.entries()) {
      ok(e.source_scope === 'local' || e.source_scope === 'global',
        `entries[${i}].source_scope is 'local' or 'global' (got ${JSON.stringify(e)})`)
    }
    // (c) access_count_at_inject for the fixture episode === fixture value
    const fixtureEntry = parsed.entries.find((e) => e.id === epId)
    ok(!!fixtureEntry, `entries[] contains the fixture episode id ${epId}`)
    eq(fixtureEntry.access_count_at_inject, FIXTURE_ACCESS_COUNT,
      `access_count_at_inject flows from fixture index (expected ${FIXTURE_ACCESS_COUNT})`)
    eq(fixtureEntry.source_scope, 'local', `fixture entry source_scope === 'local'`)
  })
}

main()
console.log(`test-rfc-009-p4-telemetry: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map(f => `FAIL ${f}`).join('\n')); process.exit(1) }
