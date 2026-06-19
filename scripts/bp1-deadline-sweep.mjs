#!/usr/bin/env node
/**
 * bp1-deadline-sweep.mjs --once — Unified Path A + Path B fallback executor.
 *
 * RFC-004 §556-577 (M0 part 2). Replays the logic that T1 (deadline-tick,
 * Path A) and T1b (naked-entry-sweep, Path B) would have run, when the
 * `mcp__scheduled-tasks` capability is unavailable. Auto-wired as a
 * SessionStart hook (H2) in PR-1b-B.
 *
 * Plan-review consensus (Codex rounds 1-3, episodes ...-d36c, ...-2c25,
 * ...-f8f2): this script OWNS all side effects. The pure helper
 * `scripts/lib/bp1-sweep.mjs` is consulted for candidate detection only.
 * Code-review round 1 Finding 2 + round 2: PR-1b-A keeps idempotency to
 * within-invocation locks. The persistent request-claim contract (RFC
 * §911-929 with claim_id, ttl_seconds, writer_run_id, HMAC) is M1's
 * responsibility — PR-1b-A's executor only DETECTS candidates and emits
 * `bp1-sweep-action-pending-m1` evidence; M1 introduces the persistent
 * claim file + signed action evidence + em-review-request issuance.
 *
 * Behavior:
 *   1. Call bp1-flag-check.mjs (which owns activation + dry-run bypass).
 *      On refusal: emit bp1-disabled-sweep evidence (project-level
 *      operational, non-authorizing — RFC §177) and exit 0.
 *   2. Load active-run state from <project>/.episodic-memory/bp1-runs/
 *      (or --input <fixture> for tests). Missing dir → zero runs.
 *   3. Run the pure scan to derive candidates + counts.
 *   4. For each candidate (Path A then Path B):
 *      - Take per-entry advisory lock with stale-reclaim (>60s) per
 *        RFC §909-923. Lock is per-invocation only — released at end.
 *      - Re-read entry under lock; if state changed (already-issued or
 *        cancelled), emit bp1-naked-sweep-superseded and continue
 *        (RFC §973-981).
 *      - Emit bp1-sweep-action-pending-m1 evidence describing the action
 *        the M1 orchestrator should execute. M1 takes the persistent
 *        claim and issues the request.
 *      - Release lock.
 *   5. Emit one bp1-sweep-tick operational episode (RFC §572) AFTER the
 *      action loop so action_count is real. Project-level, non-authorizing,
 *      no HMAC. Tagged bp1-evidence-snapshot, bp1-sweep-tick-operational.
 *   6. Exit 0 with final JSON carrying counts + actions + evidence_emission
 *      + load_issue.
 *
 * Output: one JSON line to stdout summarizing the invocation. Use --json
 * for machine-readable output (default is human-readable line + final JSON).
 *
 * Usage:
 *   node bp1-deadline-sweep.mjs --once
 *   node bp1-deadline-sweep.mjs --once --project <root>
 *   node bp1-deadline-sweep.mjs --once --input <fixture.json> --no-emit
 */
'use strict'

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { canonicalProjectRoot } from './lib/bp1-manifest.mjs'
import { scanForCandidates } from './lib/bp1-sweep.mjs'
import { loadActiveRunsFromDir } from './lib/bp1-sweep-loader.mjs'

// In-process lock TTL. Two concurrent --once invocations are the realistic
// concurrency: each takes ≪1s to evaluate a candidate. A stale lock older
// than this threshold is reclaimed (process crashed mid-evaluation).
// Codex code-review round 1 Finding 2: locks must be crash/restart safe.
const LOCK_TTL_MS = 60_000  // 60s, RFC §909-923 state-lock TTL contract

// Emission accounting — Codex code-review round 1 Finding 3 + round 2 Finding 1.
// Declared at module scope so the disabled-sweep path can call emitEpisode
// without hitting a temporal-dead-zone crash on production (non-`--no-emit`)
// invocations. emissionStats is mutated by emitEpisode and surfaced verbatim
// in the final JSON for both ok and disabled paths.
const emissionStats = { attempted: 0, succeeded: 0, failed: 0, missing_em_store: false, failures: [] }

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}
function bool(name) { return argv.includes(name) }

if (!bool('--once')) {
  console.error('bp1-deadline-sweep: --once is required (this is a one-shot tool)')
  process.exit(2)
}

const projectArg = flag('--project')
const inputArg = flag('--input')
const wantJson = bool('--json')
const emit = !bool('--no-emit')

const SCRIPT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname))
const FLAG_CHECK = path.join(SCRIPT_DIR, 'bp1-flag-check.mjs')
// em-store is SUBSTRATE (stays global): co-located in dev/repo, else the global
// substrate root (RFC-008 P4d / Principle 12 — enforcement may call the substrate).
const EM_STORE = fs.existsSync(path.join(SCRIPT_DIR, 'em-store.mjs'))
  ? path.join(SCRIPT_DIR, 'em-store.mjs')
  : path.join(os.homedir(), '.episodic-memory', 'scripts', 'em-store.mjs')

// ---------------------------------------------------------------------------
// Resolve project root
// ---------------------------------------------------------------------------
let projectRoot
try {
  projectRoot = projectArg
    ? fs.realpathSync(path.resolve(projectArg))
    : canonicalProjectRoot()
} catch (e) {
  emitFinalAndExit({
    status: 'error',
    code: 'project_root_unresolvable',
    message: e.message,
  }, 2)
}
if (!projectRoot) {
  emitFinalAndExit({
    status: 'error',
    code: 'project_root_unresolvable',
    message: 'canonicalProjectRoot() returned null',
  }, 2)
}

// ---------------------------------------------------------------------------
// Activation gate: delegate to bp1-flag-check.mjs (owns the dry-run bypass
// per RFC §563-571 v3.12).
// ---------------------------------------------------------------------------
const flagCheckArgs = ['--project', projectRoot, '--no-emit']
let flagCheckResult
try {
  const out = execFileSync('node', [FLAG_CHECK, ...flagCheckArgs], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  })
  flagCheckResult = JSON.parse(out)
} catch (e) {
  // Exit code 2 from flag-check is the structured-fail path. Parse stdout.
  if (e.stdout) {
    try {
      flagCheckResult = JSON.parse(e.stdout)
    } catch {
      // Truly unparseable — propagate as fail-closed.
      emitDisabledSweep('flag_check_unparseable', { stdout: e.stdout, stderr: e.stderr })
      emitFinalAndExit({
        status: 'disabled', reason: 'flag_check_unparseable',
        project_root: projectRoot,
        evidence_emission: emissionStats,
      }, 0)
    }
  } else {
    emitDisabledSweep('flag_check_subprocess_error', { message: e.message })
    emitFinalAndExit({
      status: 'disabled', reason: 'flag_check_subprocess_error',
      project_root: projectRoot,
      evidence_emission: emissionStats,
    }, 0)
  }
}

if (!flagCheckResult || flagCheckResult.status !== 'ok') {
  // RFC §177: --once invocation emits bp1-disabled-sweep evidence + exit 0.
  // (H2 hook in PR-1b-B will exit 0 silently per RFC §178 — different mode.)
  const code = (flagCheckResult && flagCheckResult.code) || 'unknown_refusal'
  emitDisabledSweep(code, flagCheckResult || {})
  emitFinalAndExit({
    status: 'disabled',
    reason: code,
    project_root: projectRoot,
    evidence_emission: emissionStats,
  }, 0)
}

const mode = flagCheckResult.bypass === 'dry-run' ? 'dry_run' : 'native'
const flagPassExtra = {
  artifact_version_hash: flagCheckResult.artifact_version_hash,
  verify_key_id: flagCheckResult.verify_key_id,
}
if (flagCheckResult.run_id) flagPassExtra.dry_run_id = flagCheckResult.run_id

// ---------------------------------------------------------------------------
// Load active runs
// ---------------------------------------------------------------------------
let activeRuns = []
let loadIssue = null
try {
  if (inputArg) {
    activeRuns = JSON.parse(fs.readFileSync(path.resolve(inputArg), 'utf8'))
    if (!Array.isArray(activeRuns)) {
      throw new TypeError(`--input file must contain a JSON array; got ${typeof activeRuns}`)
    }
  } else {
    const runsDir = path.join(projectRoot, '.episodic-memory', 'bp1-runs')
    const { activeRuns: loaded, loadIssue: li } = loadActiveRunsFromDir(runsDir)
    activeRuns = loaded
    if (li) loadIssue = li
  }
} catch (e) {
  loadIssue = { code: 'active_runs_load_error', message: e.message }
  activeRuns = []
}

// ---------------------------------------------------------------------------
// Pure scan
// ---------------------------------------------------------------------------
const now = Date.now()
const scan = scanForCandidates({ activeRuns, now })

// (emissionStats declared at module scope above to satisfy disabled-path emit.)

// ---------------------------------------------------------------------------
// Action loop. Codex code-review round 1 Finding 2: PR-1b-A keeps locks as
// within-invocation idempotency primitives only — no persistent claim file
// (M1 owns request-claim persistence with full TTL/HMAC contract per RFC
// §911-929). Stale locks (older than LOCK_TTL_MS) are reclaimed: a process
// crashed mid-evaluation must not block subsequent sweeps.
//
// The action loop runs in candidate order: Path A first (longer-deadline
// timeouts are higher priority), then Path B.
// ---------------------------------------------------------------------------
const actionResults = []
for (const cand of [...scan.path_a_candidates, ...scan.path_b_candidates]) {
  const lockResult = takeEntryLock(projectRoot, cand, now)
  if (!lockResult.ok) {
    actionResults.push({ ...cand, action: 'skipped_locked', reason: lockResult.reason })
    if (emit) emitSuperseded(cand, 'locked_by_other_writer')
    continue
  }
  try {
    const reread = rereadEntry(projectRoot, cand)
    if (reread.state === 'changed') {
      actionResults.push({ ...cand, action: 'skipped_superseded', reason: reread.reason })
      if (emit) emitSuperseded(cand, reread.reason)
      continue
    }
    if (emit) emitSweepActionPendingM1(cand)
    actionResults.push({ ...cand, action: 'pending_m1' })
  } finally {
    releaseEntryLock(lockResult)
  }
}

// ---------------------------------------------------------------------------
// Emit operational tick (RFC §572) — project-level, non-authorizing.
// Emitted AFTER the action loop so action_count is real (Codex Finding 1).
// Schema follows D4 strict shape per consensus episode `...807f`.
// ---------------------------------------------------------------------------
const action_count = actionResults.filter(a => a.action === 'pending_m1').length
const refusal_or_bypass = flagCheckResult.bypass === 'dry-run' ? 'dry_run_bypass' : 'activated'

const tickPayload = {
  timestamp: now,
  project_root_sha256: projectRootSha(projectRoot),
  mode: 'fallback',  // RFC §556-577: this script IS the fallback executor
  candidate_count_path_a: scan.counts.path_a_candidate_count,
  candidate_count_path_b: scan.counts.path_b_candidate_count,
  action_count,
  refusal_or_bypass,
  // Carry-forward extras (test/operator visibility — outside D4 strict but
  // useful and harmless for non-authorizing evidence):
  invocation: '--once',
  runs_inspected_count: scan.counts.runs_inspected_count,
  entries_inspected_count: scan.counts.entries_inspected_count,
  stale_or_corrupt_count: scan.counts.stale_or_corrupt_count,
  artifact_version_hash: flagCheckResult.artifact_version_hash,
  verify_key_id: flagCheckResult.verify_key_id,
}
if (flagCheckResult.run_id) tickPayload.dry_run_id = flagCheckResult.run_id
if (loadIssue) tickPayload.load_issue = loadIssue

if (emit) emitTick(tickPayload)

emitFinalAndExit({
  status: 'ok',
  project_root: projectRoot,
  project_root_sha256: projectRootSha(projectRoot),
  mode: 'fallback',
  activation_mode: mode,
  ...flagPassExtra,
  counts: scan.counts,
  actions: actionResults,
  action_count,
  refusal_or_bypass,
  load_issue: loadIssue,             // null when load was clean — explicit field
  evidence_emission: emissionStats,  // operator-visible; --no-emit yields zeros
}, 0)

// ===========================================================================
// Helpers
// ===========================================================================

// loadActiveRunsFromDisk extracted to scripts/lib/bp1-sweep-loader.mjs in
// slice 2f so the M0 fallback and the M2 sweep-naked-entries subcommand
// share one authoritative loader (codex plan-tier r1 P1, episode ...-4956).

function entryLockPath(projectRoot, cand) {
  // Per-entry advisory lock under <project>/.episodic-memory/bp1-locks/
  return path.join(projectRoot, '.episodic-memory', 'bp1-locks',
    `${cand.run_id}__${cand.entry_id}.lock`)
}

function projectRootSha(projectRoot) {
  return crypto.createHash('sha256').update(projectRoot, 'utf8').digest('hex')
}

function takeEntryLock(projectRoot, cand, now) {
  // Codex code-review round 1 Finding 2: stale-lock reclaim. A lock older
  // than LOCK_TTL_MS is treated as orphaned (the holding process crashed)
  // and overwritten. Lock body carries `{pid, claimed_at}`; we read the
  // existing one before deciding to reclaim.
  const lockPath = entryLockPath(projectRoot, cand)
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  } catch (e) {
    return { ok: false, reason: `mkdir_failed:${e.message}` }
  }

  const tryCreate = () => {
    try {
      const fd = fs.openSync(lockPath, 'wx')  // O_CREAT | O_EXCL
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, claimed_at: now }))
      return { ok: true, fd, lockPath }
    } catch (e) {
      if (e.code === 'EEXIST') return { ok: false, reason: 'EEXIST' }
      return { ok: false, reason: e.code || e.message }
    }
  }

  let r = tryCreate()
  if (r.ok) return r
  if (r.reason !== 'EEXIST') return r

  // Existing lock — check age.
  let existing
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch {
    // Corrupt lock body. Treat as stale and reclaim.
    existing = null
  }
  const claimedAt = existing && typeof existing.claimed_at === 'number' ? existing.claimed_at : 0
  const ageMs = now - claimedAt
  if (ageMs >= LOCK_TTL_MS) {
    // Reclaim. Remove + retry.
    try { fs.unlinkSync(lockPath) } catch { /* race: another writer reclaimed first */ }
    r = tryCreate()
    if (r.ok) {
      r.reclaimed_stale = { previous: existing, age_ms: ageMs }
    }
    return r
  }
  return { ok: false, reason: 'EEXIST', held_by: existing, age_ms: ageMs }
}

function releaseEntryLock(lockResult) {
  if (!lockResult || !lockResult.ok) return
  try { fs.closeSync(lockResult.fd) } catch { /* descriptor already gone */ }
  try { fs.unlinkSync(lockResult.lockPath) } catch { /* lock file may have been reclaimed by another process */ }
}

function rereadEntry(projectRoot, cand) {
  // Re-read the run's state.json under lock and find the entry. If the
  // entry now has request_sent=true (Path B candidate) or
  // response_received=true (Path A candidate), the sweep is superseded.
  if (inputArg) {
    // Test mode: --input fixture is ground truth; no on-disk state to re-read.
    return { state: 'unchanged', reason: 'fixture_mode' }
  }
  const statePath = path.join(projectRoot, '.episodic-memory', 'bp1-runs',
    cand.run_id, 'state.json')
  if (!fs.existsSync(statePath)) return { state: 'changed', reason: 'state_file_missing' }
  let state
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch (e) {
    return { state: 'changed', reason: `state_parse_error:${e.message}` }
  }
  const entries = Array.isArray(state && state.codex_review_entries) ? state.codex_review_entries : []
  const entry = entries.find(e => e && e.entry_id === cand.entry_id)
  if (!entry) return { state: 'changed', reason: 'entry_disappeared' }
  if (entry.cancelled === true) return { state: 'changed', reason: 'cancelled' }
  if (cand.path === 'path_a' && entry.response_received === true) {
    return { state: 'changed', reason: 'response_received' }
  }
  if (cand.path === 'path_b' && entry.request_sent === true) {
    return { state: 'changed', reason: 'request_already_sent' }
  }
  return { state: 'unchanged' }
}

function emitTick(payload) {
  emitEpisode({
    category: 'workflow.lifecycle',
    tags: 'bp1,bp1-sweep-tick,bp1-sweep-tick-operational,bp1-evidence-snapshot',
    summary: `bp1-sweep-tick: ${payload.candidate_count_path_a}A + ${payload.candidate_count_path_b}B candidates, ${payload.action_count} actions (mode=${payload.mode})`,
    body: '# bp1-sweep-tick (operational, non-authorizing)\n\n' +
      'Project-level operational evidence per RFC §572. NOT authorizing — must NOT be consulted by replay/decision logic. Per-run signed evidence (M1) lands separately via `bp1-sweep-action`.\n\n' +
      '```json\n' + JSON.stringify(payload, null, 2) + '\n```\n',
  })
}

function emitDisabledSweep(reason, extra) {
  if (!emit) return
  emitEpisode({
    category: 'workflow.lifecycle',
    tags: 'bp1,bp1-disabled-sweep,bp1-evidence-snapshot',
    summary: `bp1-disabled-sweep: ${reason}`,
    body: '# bp1-disabled-sweep\n\nFallback sweep refused by activation gate (RFC §177).\n\n' +
      '```json\n' + JSON.stringify({ reason, project_root: projectRoot, ...extra }, null, 2) + '\n```\n',
  })
}

function emitSuperseded(cand, reason) {
  emitEpisode({
    category: 'workflow.lifecycle',
    tags: 'bp1,bp1-naked-sweep-superseded,bp1-evidence-snapshot',
    summary: `bp1-naked-sweep-superseded: ${cand.run_id}/${cand.entry_id} (${reason})`,
    body: '# bp1-naked-sweep-superseded\n\nCandidate skipped (RFC §973-981).\n\n' +
      '```json\n' + JSON.stringify({ ...cand, reason }, null, 2) + '\n```\n',
  })
}

function emitSweepActionPendingM1(cand) {
  // PR-1b-A scope marker: candidate was detected within an in-process lock.
  // M1 will introduce the persistent request claim (RFC §911-929) plus the
  // actual em-review-request issuance + per-run HMAC-signed bp1-sweep-action.
  emitEpisode({
    category: 'workflow.lifecycle',
    tags: 'bp1,bp1-sweep-action-pending-m1,bp1-evidence-snapshot',
    summary: `bp1-sweep-action-pending-m1: ${cand.path} ${cand.run_id}/${cand.entry_id}`,
    body: '# bp1-sweep-action-pending-m1\n\n' +
      'Sweep candidate detected. Action execution deferred to M1 orchestrator (persistent request claim + per-run HMAC signing + em-review-request issuance).\n\n' +
      '```json\n' + JSON.stringify(cand, null, 2) + '\n```\n',
  })
}

function emitEpisode({ category, tags, summary, body }) {
  // Codex code-review round 1 Finding 3: emission failures must be visible
  // in the final stdout. Returns {ok, reason}; updates emissionStats so the
  // final JSON carries accurate emission status.
  if (!emit) return { ok: true, reason: 'no_emit_flag' }
  emissionStats.attempted++
  if (!fs.existsSync(EM_STORE)) {
    emissionStats.missing_em_store = true
    emissionStats.failed++
    emissionStats.failures.push({ tags, reason: 'missing_em_store' })
    return { ok: false, reason: 'missing_em_store' }
  }
  try {
    // cwd: projectRoot — Codex follow-up bug (PR-186 post-ACCEPT): em-store
    // resolves --scope local from cwd, NOT from --project. Without setting
    // cwd here, evidence lands in the CALLER's .episodic-memory store, not
    // the target project's. Same bug class as the worktree/local-store miss
    // logged in episode 20260501-125543-...-9bb0.
    execFileSync('node', [
      EM_STORE,
      '--project', path.basename(projectRoot),
      '--category', category,
      '--tags', tags,
      '--scope', 'local',
      '--summary', summary,
      '--body', body,
    ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, cwd: projectRoot })
    emissionStats.succeeded++
    return { ok: true }
  } catch (e) {
    emissionStats.failed++
    emissionStats.failures.push({ tags, reason: e.code || e.message })
    return { ok: false, reason: e.code || e.message }
  }
}

function emitFinalAndExit(payload, code) {
  if (wantJson) {
    console.log(JSON.stringify(payload))
  } else {
    if (payload.status === 'ok') {
      console.log(`bp1-deadline-sweep: OK (${payload.counts.path_a_candidate_count}A + ${payload.counts.path_b_candidate_count}B candidates, ${payload.actions.length} actions)`)
    } else if (payload.status === 'disabled') {
      console.log(`bp1-deadline-sweep: DISABLED (${payload.reason})`)
    } else {
      console.log(`bp1-deadline-sweep: ERROR (${payload.code || 'unknown'}: ${payload.message || ''})`)
    }
    console.log(JSON.stringify(payload))
  }
  process.exit(code)
}
