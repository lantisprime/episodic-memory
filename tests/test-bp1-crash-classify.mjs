#!/usr/bin/env node
/**
 * test-bp1-crash-classify.mjs — Pure crash-classifier tests
 * (scripts/bp1-crash-classify.mjs, RFC-004 slice 2e C3).
 *
 * Coverage targets the 23-row decision table (17 distinct from-states
 * with sub-branches). Each test feeds a synthetic episode list to the
 * pure `classifyRunCrash(...)` function and verifies classification +
 * resume_action.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const mod = await import(
  new URL('../scripts/bp1-crash-classify.mjs', import.meta.url).href
)
const { classifyRunCrash, PATH_B_AGE_THRESHOLD_MS } = mod

const { writeBp1Episode } = await import(
  new URL('../scripts/lib/bp1-episode-writer.mjs', import.meta.url).href
)
const { generateRunKey } = await import(
  new URL('../scripts/lib/bp1-keys.mjs', import.meta.url).href
)

const CLI = new URL('../scripts/bp1-crash-classify.mjs', import.meta.url).pathname

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

const NOW = Date.parse('2026-05-17T19:00:00.000Z')

function st(state, extra = {}) {
  return { type: 'state-transition', state, id: `ep-${state}-${Math.random().toString(36).slice(2, 8)}`, ...extra }
}
function ev(tags, extra = {}) {
  return { type: 'evidence', tags, id: `ev-${Math.random().toString(36).slice(2, 8)}`, ...extra }
}

// ============================================================================
// Row 22 — terminal states are no-op
// ============================================================================
for (const term of ['complete', 'aborted', 'abandoned', 'archived', 'approved', 'auto_approved', 'terminal_halt']) {
  tap(`CC-terminal-${term} → no-op`, () => {
    const r = classifyRunCrash({
      runState: { state: term }, episodes: [], markerPresent: false, markerExpired: false, now: NOW,
    })
    assert.equal(r.classification, 'terminal-no-op')
    assert.equal(r.resume_action, null)
  })
}

// ============================================================================
// Pre-classification states
// ============================================================================
tap('CC-active → crash-pre-classification needs-human', () => {
  const r = classifyRunCrash({
    runState: { state: 'active' }, episodes: [], markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-pre-classification')
  assert.equal(r.resume_action.command, 'needs-human')
})

tap('CC-classifier-dispatch-pending → crash-pre-classification', () => {
  const r = classifyRunCrash({
    runState: { state: 'classifier-dispatch-pending' }, episodes: [], markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-pre-classification')
})

// ============================================================================
// Row 1 — rfc-detected → crash-mid-classify
// ============================================================================
tap('CC-row1 rfc-detected without classified → crash-mid-classify', () => {
  const r = classifyRunCrash({
    runState: { state: 'rfc-detected' },
    episodes: [st('rfc-detected')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-classify')
  assert.equal(r.resume_action.command, 'record-classification')
})

// ============================================================================
// Row 2 — classified (trivial) without awaiting_approval → crash-mid-Phase-A
// ============================================================================
tap('CC-row2 classified trivial without awaiting_approval → crash-mid-Phase-A', () => {
  const r = classifyRunCrash({
    runState: { state: 'classified', decided_class: 'trivial' },
    episodes: [st('classified')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-Phase-A')
  assert.equal(r.resume_action.command, 'record-awaiting-approval')
})

// ============================================================================
// Row 3 — classified (risky) without needs-human → crash-mid-risky-route
// ============================================================================
tap('CC-row3 classified risky without needs-human → crash-mid-risky-route', () => {
  const r = classifyRunCrash({
    runState: { state: 'classified', decided_class: 'schema' },
    episodes: [st('classified')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-risky-route')
  assert.equal(r.resume_action.command, 'record-classification')
})

// ============================================================================
// Row 4 — awaiting_approval, marker absent → crash-mid-Phase-B
// ============================================================================
tap('CC-row4 awaiting_approval + marker absent → crash-mid-Phase-B', () => {
  const r = classifyRunCrash({
    runState: { state: 'awaiting_approval' },
    episodes: [st('awaiting_approval')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-Phase-B')
  assert.equal(r.resume_action.command, 'record-awaiting-approval')
})

// ============================================================================
// Row 5 — awaiting_approval, marker present + expired → a2-timeout
// ============================================================================
tap('CC-row5 awaiting_approval + marker present + expired → a2-timeout (confirm-approval)', () => {
  const r = classifyRunCrash({
    runState: { state: 'awaiting_approval' },
    episodes: [st('awaiting_approval')],
    markerPresent: true, markerExpired: true, now: NOW,
  })
  assert.equal(r.classification, 'a2-timeout')
  assert.equal(r.resume_action.command, 'confirm-approval')
  assert.equal(r.resume_action.args.outcome, 'auto_approved')
})

// ============================================================================
// Row 5b — awaiting_approval, marker present + not expired → in-flight
// ============================================================================
tap('CC-row5b awaiting_approval + marker present + not expired → in-flight no-op', () => {
  const r = classifyRunCrash({
    runState: { state: 'awaiting_approval' },
    episodes: [st('awaiting_approval')],
    markerPresent: true, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'in-flight')
  assert.equal(r.resume_action, null)
})

// ============================================================================
// Row 7 — planning, no plan episode → crash-mid-plan
// ============================================================================
tap('CC-row7 planning without plan episode → crash-mid-plan', () => {
  const r = classifyRunCrash({
    runState: { state: 'planning' },
    episodes: [st('planning')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-plan')
})

// ============================================================================
// Row 8 — planning + plan episode + no adversarial_reviewed → crash-mid-adversarial-dispatch
// ============================================================================
tap('CC-row8 planning + plan episode + no adversarial_reviewed → crash-mid-adversarial-dispatch', () => {
  const r = classifyRunCrash({
    runState: { state: 'planning' },
    episodes: [
      st('planning'),
      { type: 'plan', id: 'plan-1', tags: ['plan-v1'], summary: 'plan emitted' },
    ],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-adversarial-dispatch')
})

// ============================================================================
// Row 9 — adversarial_reviewed without em-review-request → crash-mid-em-review-request
// ============================================================================
tap('CC-row9 adversarial_reviewed without em-review-request → crash-mid-em-review-request', () => {
  const r = classifyRunCrash({
    runState: { state: 'adversarial_reviewed' },
    episodes: [st('adversarial_reviewed')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-em-review-request')
})

// ============================================================================
// Row 10 — codex_review + request-sent evidence → path-a-defer
// ============================================================================
tap('CC-row10 codex_review + request-sent evidence → path-a-defer', () => {
  const entry = st('codex_review', { id: 'cr-1', created_at: '2026-05-17T18:00:00Z' })
  const r = classifyRunCrash({
    runState: { state: 'codex_review' },
    episodes: [entry, ev(['bp1-codex-request-sent'], { parent_episode: 'cr-1' })],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'path-a-defer')
  assert.equal(r.resume_action.command, 'defer')
})

// ============================================================================
// Row 11 — codex_review naked + entry >= 5min → path-b-defer
// ============================================================================
tap('CC-row11 codex_review naked + age >= 5min → path-b-defer', () => {
  const old = new Date(NOW - PATH_B_AGE_THRESHOLD_MS - 1_000).toISOString()
  const entry = st('codex_review', { id: 'cr-1', created_at: old })
  const r = classifyRunCrash({
    runState: { state: 'codex_review' },
    episodes: [entry],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'path-b-defer')
})

// ============================================================================
// Row 12 — codex_review naked + entry < 5min → in-flight
// ============================================================================
tap('CC-row12 codex_review naked + age < 5min → in-flight', () => {
  const young = new Date(NOW - 60_000).toISOString()   // 1min old
  const entry = st('codex_review', { id: 'cr-1', created_at: young })
  const r = classifyRunCrash({
    runState: { state: 'codex_review' },
    episodes: [entry],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'in-flight')
  assert.equal(r.resume_action, null)
})

// ============================================================================
// Row 13 — codex_complete without sentinel → crash-mid-sentinel
// ============================================================================
tap('CC-row13 codex_complete without sentinel → crash-mid-sentinel', () => {
  const r = classifyRunCrash({
    runState: { state: 'codex_complete' },
    episodes: [st('codex_complete')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-sentinel')
})

// ============================================================================
// Row 14 — implementing without commit → crash-classify-ambiguous-impl
// ============================================================================
tap('CC-row14 implementing without commit/worktree → ambiguous needs-human', () => {
  const r = classifyRunCrash({
    runState: { state: 'implementing' },
    episodes: [st('implementing')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-classify-ambiguous-impl')
  assert.equal(r.resume_action.command, 'needs-human')
})

// ============================================================================
// Row 15 — implementing + commit + no reviewing → crash-mid-reviewer-dispatch
// ============================================================================
tap('CC-row15 implementing + commit + no reviewing → crash-mid-reviewer-dispatch', () => {
  const r = classifyRunCrash({
    runState: { state: 'implementing' },
    episodes: [
      st('implementing'),
      ev(['bp1-commit'], { summary: 'commit-evidence abc123' }),
    ],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-reviewer-dispatch')
})

// ============================================================================
// Row 16 — reviewing → crash-mid-reviewer-poll
// ============================================================================
tap('CC-row16 reviewing → crash-mid-reviewer-poll', () => {
  const r = classifyRunCrash({
    runState: { state: 'reviewing' },
    episodes: [st('reviewing')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-reviewer-poll')
})

// ============================================================================
// Row 17 — fix_loop → ambiguous needs_human
// ============================================================================
tap('CC-row17 fix_loop → ambiguous needs-human', () => {
  const r = classifyRunCrash({
    runState: { state: 'fix_loop' },
    episodes: [st('fix_loop')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-classify-ambiguous-fix-loop')
  assert.equal(r.resume_action.command, 'needs-human')
})

// ============================================================================
// Row 18 — auditing without audit_pass → crash-mid-auditing
// ============================================================================
tap('CC-row18 auditing without audit_pass → crash-mid-auditing', () => {
  const r = classifyRunCrash({
    runState: { state: 'auditing' },
    episodes: [st('auditing')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-auditing')
})

// ============================================================================
// Row 19 — audit_pass without pr_opened → crash-mid-pr-create
// ============================================================================
tap('CC-row19 audit_pass without pr_opened → crash-mid-pr-create', () => {
  const r = classifyRunCrash({
    runState: { state: 'audit_pass' },
    episodes: [st('audit_pass')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-pr-create')
})

// ============================================================================
// Row 20 — pr_opened without em-review-request → crash-mid-pr-review-request
// ============================================================================
tap('CC-row20 pr_opened without em-review-request → crash-mid-pr-review-request', () => {
  const r = classifyRunCrash({
    runState: { state: 'pr_opened' },
    episodes: [st('pr_opened')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-mid-pr-review-request')
})

// ============================================================================
// Row 21 — codex_pr_review → DEFER to deadline-tick
// ============================================================================
tap('CC-row21 codex_pr_review → pr-review-path-a-defer', () => {
  const r = classifyRunCrash({
    runState: { state: 'codex_pr_review' },
    episodes: [st('codex_pr_review')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'pr-review-path-a-defer')
})

// ============================================================================
// needs-human → awaiting-human-override (no automatic action)
// ============================================================================
tap('CC-needs-human → awaiting-human-override no action', () => {
  const r = classifyRunCrash({
    runState: { state: 'needs-human' },
    episodes: [st('needs-human')],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'awaiting-human-override')
  assert.equal(r.resume_action, null)
})

// ============================================================================
// Row 23 — unparseable state → crash-classify-unparseable
// ============================================================================
tap('CC-row23 unknown state → crash-classify-unparseable', () => {
  const r = classifyRunCrash({
    runState: { state: 'mysterious-state' },
    episodes: [],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-classify-unparseable')
  assert.equal(r.resume_action.command, 'needs-human')
})

tap('CC-null-runState → crash-classify-unparseable', () => {
  const r = classifyRunCrash({
    runState: null, episodes: [], markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-classify-unparseable')
})

// ============================================================================
// Ambiguous edge: codex_review with malformed created_at
// ============================================================================
tap('CC-ambiguous codex_review with non-parseable created_at → unparseable', () => {
  const entry = { type: 'state-transition', state: 'codex_review', id: 'cr-1', created_at: 'not-a-date' }
  const r = classifyRunCrash({
    runState: { state: 'codex_review' },
    episodes: [entry],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'crash-classify-unparseable')
})

// ============================================================================
// Ambiguous edge: codex_review state but no codex_review entry → inconsistent
// ============================================================================
// =============================================================================
// CC-canonical-root (C7 round-2 P1.2): CLI MUST bind to canonical project
// root (git toplevel + realpath), matching check-deadlines / init-run /
// confirm-approval. --project pointing at a non-git subdir of a parent git
// repo must read from the parent's run-state index, not from the subdir.
// =============================================================================
tap('CC-canonical-root P1.2: --project <subdir-of-git> reads from git toplevel run-state', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-cc-canon-')))
  // Init a git repo at tmp/proj.
  const proj = path.join(tmp, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const gitInit = spawnSync('git', ['init', '-q'], { cwd: proj, encoding: 'utf8' })
  assert.equal(gitInit.status, 0, `git init: ${gitInit.stderr}`)

  // Plant run-state index at PROJECT-ROOT (not at subdir).
  const runId = 'bp1-run-cc-canon-rfc-x-aabbcc'
  const indexDir = path.join(proj, '.episodic-memory', 'runs')
  fs.mkdirSync(indexDir, { recursive: true })
  fs.writeFileSync(path.join(indexDir, '_index.json'),
    JSON.stringify({
      schema_version: 2,
      runs: {
        [runId]: {
          run_id: runId, state: 'complete',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    }, null, 2))

  // Create a non-git subdir.
  const subdir = path.join(proj, 'feature-x')
  fs.mkdirSync(subdir, { recursive: true })

  // Call CLI with --project <subdir>; the resolver must canonicalize UP to
  // git toplevel and find the run.
  const r = spawnSync('node', [CLI, '--project', subdir, '--run-id', runId], {
    encoding: 'utf8', cwd: tmp,  // caller cwd intentionally outside both
  })
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.run_id, runId)
  assert.equal(out.state, 'complete')
})

tap('CC-ambiguous codex_review state with no entry episodes → inconsistent', () => {
  const r = classifyRunCrash({
    runState: { state: 'codex_review' },
    episodes: [],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(r.classification, 'inconsistent-codex-review')
})

// =============================================================================
// Issue #670 — CLI-level loadRunEpisodes/readApprovalMarkerStatus coverage.
// mkCrashProject/writeRunIndex/writeSignedEpisode build a real on-disk
// fixture (no git required — canonicalProjectRoot falls back to
// path.resolve when there's no git repo, per bp1-crash-classify.mjs main()).
// =============================================================================
function mkCrashProject() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-cc-proj-')))
  fs.mkdirSync(path.join(dir, '.episodic-memory', 'episodes'), { recursive: true })
  return dir
}

function writeRunIndex(proj, runId, state) {
  const indexDir = path.join(proj, '.episodic-memory', 'runs')
  fs.mkdirSync(indexDir, { recursive: true })
  fs.writeFileSync(path.join(indexDir, '_index.json'), JSON.stringify({
    schema_version: 2,
    runs: {
      [runId]: {
        run_id: runId, state,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
  }, null, 2))
}

// #670 review round MAJOR-1: loadRunEpisodes now gates on HMAC verification
// (see scripts/bp1-crash-classify.mjs loadRunEpisodes), so fixtures must
// write REAL signed episodes via the real writer — generateRunKey plants
// run.key on disk where loadRunKey (inside loadRunEpisodes) will find it,
// and writeBp1Episode signs with that SAME key. Returns { key32B, episodeId }.
function setupRunKey(proj, runId) {
  const { key32B } = generateRunKey(proj, runId)
  return key32B
}

function writeSignedEpisode(proj, runId, key32B, { state, filenameSuffix, tags = [] }) {
  const written = writeBp1Episode({
    projectRoot: proj, runId, runKey32B: key32B,
    type: 'state-transition', state,
    summary: `${state} for ${runId}`,
    parentEpisode: null, expectedPostEpisodeId: null,
    tags, body: `# ${state}\n`, filenameSuffix,
  })
  return written.episodeId
}

// Raw (UNSIGNED) episode write — parseBp1Frontmatter-compatible bare-token
// frontmatter with no hmac_signature field. Used ONLY for the forged-
// unsigned regression leg (MAJOR-1): loadRunEpisodes must SKIP this, not
// trust it (mirrors writeEpisode() in test-bp1-manifest-collect.mjs).
function writeRawEpisode(proj, epId, fields) {
  const dir = path.join(proj, '.episodic-memory', 'episodes')
  const lines = ['---']
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`)
  lines.push('---', '', 'body\n')
  fs.writeFileSync(path.join(dir, `${epId}.md`), lines.join('\n'))
}

function spawnCC(proj, runId, extraEnv) {
  return spawnSync('node', [CLI, '--project', proj, '--run-id', runId], {
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
    env: { ...process.env, ...extraEnv },
  })
}

// =============================================================================
// §2c positive control (round-2 E3R bound): the CLI classification for a
// valid run-tagged fixture MUST EQUAL the pure classifyRunCrash output for
// the equivalent episode records — the same shape the CC-row1 test (top of
// this file) injects directly. This is what makes the FIFO leg below
// non-vacuous: loadRunEpisodes must ACTUALLY return records, not just avoid
// hanging.
// =============================================================================
tap('CC-670-positive-control: rfc-detected run with ONE real on-disk SIGNED episode → CLI classification EQUALS pure classifyRunCrash output', () => {
  const proj = mkCrashProject()
  const runId = 'bp1-run-cc-670-pos-rfc-x-aabbcc'
  writeRunIndex(proj, runId, 'rfc-detected')
  const key32B = setupRunKey(proj, runId)
  const epId = writeSignedEpisode(proj, runId, key32B, { state: 'rfc-detected', filenameSuffix: 'rfc-detected' })

  const r = spawnCC(proj, runId)
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)

  // Independently compute the pure-function expectation for the SAME
  // records loadRunEpisodes should have produced (mirrors st('rfc-detected')
  // at the top of this file).
  const pure = classifyRunCrash({
    runState: { state: 'rfc-detected' },
    episodes: [{ id: epId, run_id: runId, type: 'state-transition', state: 'rfc-detected' }],
    markerPresent: false, markerExpired: false, now: Date.parse(out.marker?.deadline_at || NOW) || NOW,
  })
  assert.equal(out.classification, pure.classification, `CLI=${out.classification} pure=${pure.classification}`)
  assert.deepEqual(out.resume_action, pure.resume_action, `CLI=${JSON.stringify(out.resume_action)} pure=${JSON.stringify(pure.resume_action)}`)
  // Matches the CC-row1 pure-function expectation directly (lines ~78-93).
  assert.equal(out.classification, 'crash-mid-classify')
  assert.equal(out.resume_action.command, 'record-classification')
})

// Discriminating positive control (plan §7 build-round amendment): the Row1
// fixture above (CC-670-positive-control) is satisfied identically whether
// or not loadRunEpisodes returns correctly-SHAPED flat records — its
// classification doesn't depend on inspecting any episode field, only on
// state-transition PRESENCE of 'classified' (absent either way there). This
// case flips on an episode field (e.state) the fixed code must read
// correctly through fm.frontmatter — reachable only if loadRunEpisodes
// pushes fm.frontmatter (flat), not the {frontmatter,body} wrapper the
// half-activated fix used to push (whose fields all read back as
// undefined). Originally a builder STOP-and-flag finding (CLI reported
// crash-mid-Phase-A instead of inconsistent-classified-trivial); plan-owner
// authorized completing the wrapper-vs-content fix, so this now asserts the
// CORRECT post-fix behavior as a committed regression leg.
tap('CC-670-positive-control-discriminating: classified/trivial WITH an on-disk SIGNED awaiting_approval episode → CLI reads e.state correctly through fm.frontmatter', () => {
  const proj = mkCrashProject()
  const runId = 'bp1-run-cc-670-disc-rfc-x-aabbcc'
  writeRunIndex(proj, runId, 'classified')
  // Patch decided_class onto the run-state row (writeRunIndex doesn't set it).
  const idxPath = path.join(proj, '.episodic-memory', 'runs', '_index.json')
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  idx.runs[runId].decided_class = 'trivial'
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2))
  const key32B = setupRunKey(proj, runId)
  const epId = writeSignedEpisode(proj, runId, key32B, { state: 'awaiting_approval', filenameSuffix: 'awaiting-approval' })

  const r = spawnCC(proj, runId)
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)

  const pure = classifyRunCrash({
    runState: { state: 'classified', decided_class: 'trivial' },
    episodes: [{ id: epId, run_id: runId, type: 'state-transition', state: 'awaiting_approval' }],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  // Pure expectation for THIS shape: hasAwait=true -> inconsistent-classified-trivial
  // (NOT crash-mid-Phase-A, which is what the wrapper-shaped bug wrongly
  // reported since e.state read as undefined on every record).
  assert.equal(pure.classification, 'inconsistent-classified-trivial', `sanity: pure fixture itself must hit the discriminating branch, got ${pure.classification}`)
  assert.equal(out.classification, pure.classification, `CLI=${out.classification} pure=${pure.classification} (CLI diverging here would mean loadRunEpisodes is NOT returning flat frontmatter records)`)
  assert.deepEqual(out.resume_action, pure.resume_action)
})

// =============================================================================
// FIFO regression leg (issue #670 §2, loadRunEpisodes): a FIFO-shaped
// episode file alongside a real one must be skipped, not hang the verb.
// Uses the CLI (already a subprocess) with an explicit timeout so a
// regression against unfixed code (raw fs.readFileSync on a FIFO) fails as a
// timeout-kill instead of freezing this suite.
// =============================================================================
tap('CC-670-fifo-episode: FIFO episode file in run dir → skipped, classification unaffected, no hang', () => {
  const proj = mkCrashProject()
  const runId = 'bp1-run-cc-670-fifo-rfc-x-aabbcc'
  writeRunIndex(proj, runId, 'rfc-detected')
  const key32B = setupRunKey(proj, runId)
  writeSignedEpisode(proj, runId, key32B, { state: 'rfc-detected', filenameSuffix: 'rfc-detected' })
  const fifoPath = path.join(proj, '.episodic-memory', 'episodes', `${runId}-poison.md`)
  const mk = spawnSync('mkfifo', [fifoPath])
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`)

  const r = spawnCC(proj, runId)
  fs.unlinkSync(fifoPath)
  assert.equal(r.signal, null, `no signal (timeout/kill) — got ${r.signal} (fail-not-freeze regression signature); stderr=${(r.stderr || '').slice(0, 300)}`)
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.classification, 'crash-mid-classify', JSON.stringify(out))
})

// =============================================================================
// §2b FIFO regression leg: readApprovalMarkerStatus. A FIFO-shaped marker
// file must terminate with the function's EXISTING absent/invalid outcome
// (marker.present === false — no new status vocabulary), not hang.
// =============================================================================
tap('CC-670-fifo-marker: FIFO approval-marker file → present:false, verb terminates, no hang', () => {
  const proj = mkCrashProject()
  const runId = 'bp1-run-cc-670-marker-rfc-x-aabbcc'
  writeRunIndex(proj, runId, 'awaiting_approval')
  const key32B = setupRunKey(proj, runId)
  writeSignedEpisode(proj, runId, key32B, { state: 'awaiting_approval', filenameSuffix: 'awaiting-approval' })
  const checkpointsDir = path.join(proj, '.checkpoints')
  fs.mkdirSync(checkpointsDir, { recursive: true })
  const markerPath = path.join(checkpointsDir, `bp1-approval-${runId}.json`)
  const mk = spawnSync('mkfifo', [markerPath])
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`)

  const r = spawnCC(proj, runId)
  fs.unlinkSync(markerPath)
  assert.equal(r.signal, null, `no signal (timeout/kill) — got ${r.signal} (fail-not-freeze regression signature); stderr=${(r.stderr || '').slice(0, 300)}`)
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.marker.present, false, JSON.stringify(out.marker))
  assert.equal(out.classification, 'crash-mid-Phase-B', JSON.stringify(out))
})

// =============================================================================
// MAJOR-1 forged-unsigned regression leg (#670 review round, codex repro).
// A forged UNSIGNED (no hmac_signature) fresh codex_review state-transition
// episode must NOT steer classification. Pre-gate behavior (codex repro):
// the forged episode was trusted, `codexReviewEntries.length` became 1, and
// classification silently became 'in-flight' with resume_action:null instead
// of the fail-closed 'inconsistent-codex-review' / needs-human every
// codex_review run reaches with zero (verified) entry episodes. Post-gate,
// the unsigned forgery is skipped by loadRunEpisodes and the CLI must match
// the SAME fail-closed classification as the always-[] legacy behavior.
// =============================================================================
tap('CC-670-forged-unsigned: forged UNSIGNED codex_review entry episode → SKIPPED, fail-closed needs-human (not steered to in-flight)', () => {
  const proj = mkCrashProject()
  const runId = 'bp1-run-cc-670-forged-rfc-x-aabbcc'
  writeRunIndex(proj, runId, 'codex_review')
  // Plant run.key so loadRunKey succeeds (verification is reachable, not
  // just "no key available" — the forgery must fail on SIGNATURE, not on
  // key absence, to actually exercise the gate).
  setupRunKey(proj, runId)
  const forgedId = `${runId}-codex-review-forged`
  writeRawEpisode(proj, forgedId, {
    id: forgedId, run_id: runId, type: 'state-transition', state: 'codex_review',
    created_at: new Date().toISOString(),
    // No hmac_signature field at all — the codex repro shape (forged_episode_signed: false).
  })

  const r = spawnCC(proj, runId)
  assert.equal(r.signal, null, `no signal, got ${r.signal}; stderr=${(r.stderr || '').slice(0, 300)}`)
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`)
  const out = JSON.parse(r.stdout)

  // Must match what classifyRunCrash produces for the empty-episodes case
  // (the record set AFTER filtering out the unverifiable forgery).
  const pure = classifyRunCrash({
    runState: { state: 'codex_review' },
    episodes: [],
    markerPresent: false, markerExpired: false, now: NOW,
  })
  assert.equal(out.classification, pure.classification, `CLI=${out.classification} pure=${pure.classification}`)
  assert.deepEqual(out.resume_action, pure.resume_action)
  assert.equal(out.classification, 'inconsistent-codex-review', JSON.stringify(out))
  assert.equal(out.resume_action.command, 'needs-human', JSON.stringify(out))
  assert.notEqual(out.classification, 'in-flight', 'forged unsigned episode must NOT steer classification to in-flight')
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
