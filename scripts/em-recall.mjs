#!/usr/bin/env node
/**
 * em-recall.mjs — Proactive session-start recall via multi-pass retrieval.
 *
 * Usage:
 *   node em-recall.mjs [--project <name>] [--scope local|global|all]
 *                      [--limit <n>] [--days <n>] [--no-track]
 *                      [--warn-time-ms <n>] [--warn-count <n>]
 *
 * Three passes:
 *   1. Project match — episodes whose `project` field matches inferred project name
 *   2. Tag match — episodes whose tags overlap with inferred context tokens
 *   3. Recent cross-project — high-relevance episodes from last N days
 *
 * Outputs JSON: { status, context, count, episodes, preflight_warnings, prune_suggestion }
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync } from 'child_process'
import { resolveLocalDir, resolveRepoRoot } from './lib/local-dir.mjs'
import {
  BASELINE_NAME,
  PRIMARY_MARKER_DIR,
  LEGACY_MARKER_DIR,
  PLAN_MARKER_LEGACY_BASENAME,
  primaryMarkerPath,
  legacyMarkerPath,
  resolveMarkerRead,
  writeMarkerPath,
  ensurePrimaryDir,
  bothMarkerPaths,
  namespacedMarkerBasenameForSession,
  preflightMarkerSuffixedBasenameMatches,
  lastUserPromptBasenameMatches,
} from './lib/marker-paths.mjs'
import {
  _maxMtimeAcrossRootsStrict,
  _maxMtimeAcrossRootsForPlanMarkerStrict,
  resolveOwnSessionMarkerRead,
  stopGateCarveOutApplies,
} from './lib/marker-state.mjs'
import { validateSessionId } from './lib/session-id.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()
const REPO_ROOT = resolveRepoRoot()

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const projectOverride = flag('--project')
const scope = flag('--scope') || 'all'
const limit = parseInt(flag('--limit') || '5', 10)
const days = parseInt(flag('--days') || '7', 10)
const noTrack = argv.includes('--no-track')
const warnTimeMs = parseInt(flag('--warn-time-ms') || '500', 10)
const warnCount = parseInt(flag('--warn-count') || '5000', 10)
const taskTypeFlag = flag('--task-type')
const gateFlag = flag('--gate')
const sessionStartFlag = argv.includes('--session-start')

// --session-id <sid> — bound from SessionStart stdin `.session_id` via the
// hook wrapper (em-recall-sessionstart.sh) AND from stop-gate.sh wrapper
// (rank-2 C5). Used to scope stop-gate carve-out and the per-session
// quartet arming. Validation: missing/invalid emits stderr warning and
// falls back to legacy-literal-only mode (hook reliability outweighs
// strict contract per codex R2 Q3).
const sessionIdFlag = flag('--session-id')
let mySid = null
if (sessionIdFlag !== undefined) {
  if (sessionIdFlag !== '' && validateSessionId(sessionIdFlag)) {
    mySid = sessionIdFlag
  } else if (sessionIdFlag !== '') {
    process.stderr.write(`em-recall: warn — --session-id "${sessionIdFlag}" failed validateSessionId; legacy-literal-only mode\n`)
  }
}

const VALID_SCOPES = ['local', 'global', 'all']
if (!VALID_SCOPES.includes(scope)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}` }))
  process.exit(1)
}

const VALID_TASK_TYPES = ['implementation', 'push', 'rule', 'general']
if (taskTypeFlag !== undefined && !VALID_TASK_TYPES.includes(taskTypeFlag)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --task-type "${taskTypeFlag}". Must be one of: ${VALID_TASK_TYPES.join(', ')}` }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Gate dispatch (RFC-003 Phase 3b primitive; future Phase 2 will subsume the
// shell wrapper into adapters/claude-code/capabilities/enforcement.mjs while
// keeping this dispatch in core per P9. See RFC-003 §Considerations — #128
// stop-gate alignment for the event-name-keying commitment.)
//
// `--gate <event>` returns a hook-decision JSON to stdout for adapter
// consumption. Empty stdout = allow (Claude proceeds normally on Stop).
// `{decision: "block", reason: "..."}` = block.
//
// Currently implemented: stop. The dispatch contract may extend to other
// Claude Code events (presubmit/prewrite/prepush) as Phase 1 ratifies.
// ---------------------------------------------------------------------------
const VALID_GATES = ['stop']
if (gateFlag !== undefined && !VALID_GATES.includes(gateFlag)) {
  console.log(JSON.stringify({ status: 'error', message: `Invalid --gate "${gateFlag}". Must be one of: ${VALID_GATES.join(', ')}` }))
  process.exit(1)
}

// #146 P2-5: --session-start is a SessionStart-hook side-effect mode; it
// must not be combined with --gate (which is a different hook event-key).
// Combining them would cause --gate's early exit to silently skip the
// baseline write, which is the worst failure mode (carve-out inactive
// without a clear signal).
if (sessionStartFlag && gateFlag !== undefined) {
  console.log(JSON.stringify({ status: 'error', message: '--session-start cannot be combined with --gate' }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Marker-state reads moved to scripts/lib/marker-state.mjs (RFC-008 P3a, R1).
// The carve-out predicate, relaxed mtime helpers, and own-session resolver now
// live in the enforcement-owned marker-state module; em-recall imports only the
// four helpers its surviving `--gate stop` dispatch handler still calls
// (_maxMtimeAcrossRootsStrict, _maxMtimeAcrossRootsForPlanMarkerStrict,
// resolveOwnSessionMarkerRead, stopGateCarveOutApplies). TASK_SIGNAL_MARKERS
// and CHECKPOINT_QUARTET moved with the carve-out and are no longer imported
// here. The dispatch handler itself moves to enforce-contract.mjs in P3b and
// is deleted here in P3d.
// ---------------------------------------------------------------------------

if (gateFlag === 'stop') {
  // REPO_ROOT was resolved at module load (line ~26) via resolveRepoRoot()
  // from scripts/lib/local-dir.mjs. This converges with the hook readers in
  // hooks/checkpoint-gate.sh + hooks/plan-gate.sh that use repo-root.sh.
  // Closes #106's worktree-orphan class for this gate.
  //
  // #178 F1: defer stop-gate when plan is ACTIVELY pending at EITHER root.
  // The plan-gate blocks Write/Bash while .plan-approval-pending exists at
  // either root, creating an unrecoverable triangle when stop-gate ALSO
  // blocks. The exemption narrows to ACTIVE plan-pending only (mtime >
  // baseline) — orphan plan-pending falls through to the existing carve-out.
  //
  // Strict-lstat semantics via _maxMtimeAcrossRootsStrict (codex round-3 F11
  // + round-6 F17): ENOENT skips (marker absent at this root, fine); any
  // other lstat error (EACCES, ENOTDIR, EIO, ELOOP) → hadOtherError → fail
  // closed. Symlink at EITHER root → fail closed (same-class with carve-out
  // symmetric defense).
  //
  // Dual-root semantics (codex round-2 F8): plan-pending and baseline are
  // BOTH evaluated across primary and legacy. resolveMarkerRead's primary-
  // first ordering would have recreated the deadlock when primary is stale
  // and legacy is active during burn-in.
  //
  // Code-review B1: this exemption INTENTIONALLY supersedes the
  // stopGateCarveOutApplies() check below for the active-plan-pending case.
  // If plan-pending is mid-session active, the agent is in plan-review
  // (no writes happening), and the checkpoint-gate + plan-gate + stop-gate
  // triangle would otherwise be unrecoverable. Plan-gate provides the
  // writer-side defense via its independent .plan-approval-pending check;
  // stop-gate stepping aside is the deadlock-break. The exemption fires
  // EVEN when other TASK_SIGNAL_MARKERS (.checkpoint-required,
  // .post-checkpoint-required) are also active — see test 5.13.
  // #268 fix E19: plan-pending deferral fires for ANY plan-marker variant
  // (legacy literal OR any suffixed) — own session or other.
  const planPending = _maxMtimeAcrossRootsForPlanMarkerStrict(REPO_ROOT)
  const baseStrict = _maxMtimeAcrossRootsStrict(REPO_ROOT, BASELINE_NAME)
  if (
    planPending.anyExisted && !planPending.hadSymlink && !planPending.hadOtherError &&
    baseStrict.anyExisted && !baseStrict.hadSymlink && !baseStrict.hadOtherError &&
    planPending.mtime > baseStrict.mtime
  ) {
    process.exit(0)
  }

  // Rank-2: session-aware reads. Resolution order for each quartet member:
  //   1. <root>/.checkpoints/<name>.<mySid>
  //   2. <root>/.claude/<name>.<mySid>
  //   3. <root>/.checkpoints/<name>      (legacy literal, burn-in)
  //   4. <root>/.claude/<name>           (legacy literal, burn-in)
  //
  // When mySid is null (invalid/missing sid), only steps 3-4 are checked
  // (graceful degrade per codex R2 Q3: hook reliability outweighs strict
  // contract). Other sessions' suffixed markers are intentionally NOT
  // probed — own-session carve-out semantic.
  const preReqPath = resolveOwnSessionMarkerRead(REPO_ROOT, '.checkpoint-required', mySid)
  const postDonePath = resolveOwnSessionMarkerRead(REPO_ROOT, '.post-checkpoint-done', mySid)
  let postDoneSize = 0
  if (postDonePath) {
    try { postDoneSize = fs.statSync(postDonePath).size } catch {}
  }
  if (preReqPath && postDoneSize === 0) {
    if (!stopGateCarveOutApplies(REPO_ROOT, mySid)) {
      // Block-message path: emit suffixed write path when sid is valid;
      // legacy literal otherwise. Agent's block-write goes to the suffixed
      // path via checkpoint-marker.mjs helper or direct Write.
      const writeBasename = mySid
        ? namespacedMarkerBasenameForSession('.post-checkpoint-done', mySid)
        : '.post-checkpoint-done'
      const writePath = writeMarkerPath(REPO_ROOT, writeBasename)
      const reason = `Post-implementation checkpoint required. Write the Rule 18 post-implementation checkpoint block to ${writePath} (must be non-empty), then end your turn again. Hook: stop-gate.sh.`
      console.log(JSON.stringify({ decision: 'block', reason }))
    }
    // else: carve-out applies — emit nothing (allow stop).
  }
  // Otherwise: emit nothing. Empty stdout on Stop = allow Claude to stop.
  process.exit(0)
}

const recallStart = Date.now()

// ---------------------------------------------------------------------------
// Stopword list for tag matching
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'fix', 'feat', 'feature', 'bug', 'test', 'app', 'src', 'lib', 'dev',
  'main', 'master', 'release', 'hotfix', 'docs', 'chore', 'refactor',
  'style', 'ci', 'cd', 'build', 'user', 'data', 'add', 'update', 'new',
  'phase', 'merge', 'pr', 'push', 'implement', 'wip', 'draft', 'rule',
  'enforce', 'pattern'
])

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:normalizeTags — update both on change
// ---------------------------------------------------------------------------
function normalizeTags(raw) {
  if (!raw) return []
  const arr = (Array.isArray(raw) ? raw : raw.split(','))
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(arr)].sort()
}

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:loadTagsIndex — update both on change
// ---------------------------------------------------------------------------
function loadTagsIndex(dataDir) {
  const tagsFile = path.join(dataDir, 'tags.json')
  try {
    return JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:computeScore — update both on change
// ---------------------------------------------------------------------------
function computeScore(entry, textMatchScore) {
  const accessCount = entry.access_count || 0
  // Use new Date(entry.date) for decay — sub-day precision unnecessary
  const created = new Date(entry.date)
  const daysSince = Math.max(0, (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24))
  const timeFactor = Math.max(0.1, 1 - (daysSince / 365))
  const accessFactor = 1 + Math.log1p(accessCount) * 0.1
  return textMatchScore * timeFactor * accessFactor
}

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:writeBackAccessTracking — update both on change
// ---------------------------------------------------------------------------
function writeBackAccessTracking(results) {
  // Group results by source data directory
  const byDir = new Map()
  for (const e of results) {
    if (!e._dataDir) continue
    if (!byDir.has(e._dataDir)) byDir.set(e._dataDir, new Set())
    byDir.get(e._dataDir).add(e.id)
  }

  const now = new Date().toISOString().slice(0, 19) + 'Z'

  for (const [dataDir, ids] of byDir) {
    const indexFile = path.join(dataDir, 'index.jsonl')
    try {
      // Re-read just before writing to narrow race window with concurrent em-store appends.
      // This is best-effort — last-writer-wins for concurrent searches is acceptable.
      const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean)
      const updated = lines.map(line => {
        try {
          const entry = JSON.parse(line)
          if (ids.has(entry.id)) {
            entry.access_count = (entry.access_count || 0) + 1
            entry.last_accessed = now
          }
          return JSON.stringify(entry)
        } catch { return line }
      })
      const tmpFile = indexFile + '.tmp'
      fs.writeFileSync(tmpFile, updated.join('\n') + '\n', 'utf8')
      fs.renameSync(tmpFile, indexFile)
    } catch {
      // Access tracking is best-effort — skip silently on failure
    }
  }
}

// ---------------------------------------------------------------------------
// Task-type → relevant pattern_ids (RFC-002 Phase 3)
// Pre-flight surfaces violations of these patterns when task type is known.
// Empty list means no violation pre-flight runs (e.g. task-type=general).
// ---------------------------------------------------------------------------
const TASK_TYPE_PATTERNS = {
  implementation: ['bp-001-implementation-workflow', 'bp-006-push-after-verify'],
  push: ['bp-006-push-after-verify'],
  rule: ['bp-010-habits-override-knowledge'],
  general: []
}

// ---------------------------------------------------------------------------
// Branch token → task type keyword inference. First match wins. No match
// means task type stays unknown and no pre-flight runs.
// ---------------------------------------------------------------------------
const BRANCH_TYPE_KEYWORDS = {
  implementation: ['implement', 'build', 'feature', 'phase', 'feat'],
  push: ['push', 'merge', 'pr', 'release'],
  rule: ['rule', 'enforce', 'pattern']
}

function inferTaskType(branchTokens) {
  if (!branchTokens || branchTokens.length === 0) return null
  for (const type of ['implementation', 'push', 'rule']) {
    const keywords = BRANCH_TYPE_KEYWORDS[type]
    if (branchTokens.some(t => keywords.includes(t))) return type
  }
  return null
}

// ---------------------------------------------------------------------------
// Load patterns/_index.json (project-local first, then global install).
// Mirrors em-violation.mjs:loadPatternsIndex.
// ---------------------------------------------------------------------------
function loadPatternsIndex() {
  const candidates = [
    path.join(process.cwd(), 'patterns', '_index.json'),
    path.join(os.homedir(), '.episodic-memory', 'patterns', '_index.json')
  ]
  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (data.patterns && Array.isArray(data.patterns)) return data.patterns
    } catch {}
  }
  return []
}

// ---------------------------------------------------------------------------
// Violation pre-flight: scan activeEntries for violations of patterns
// relevant to the task type within the last 30 days. Returns warning objects.
// ---------------------------------------------------------------------------
function runViolationPreflight(activeEntries, taskType, patterns) {
  if (!taskType) return []
  const relevantIds = TASK_TYPE_PATTERNS[taskType] || []
  if (relevantIds.length === 0) return []

  const validIds = new Set(patterns.map(p => p.pattern_id))
  const filterIds = relevantIds.filter(id => validIds.has(id))
  if (filterIds.length === 0) return []

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const warnings = []
  for (const patternId of filterIds) {
    const violationTag = `violated:${patternId}`
    const matching = activeEntries.filter(e =>
      e.category === 'violation' &&
      Array.isArray(e.tags) &&
      e.tags.includes(violationTag) &&
      typeof e.date === 'string' &&
      e.date >= cutoffStr
    )
    if (matching.length === 0) continue
    matching.sort((a, b) => b.date.localeCompare(a.date))
    const last = matching[0].date
    warnings.push({
      type: 'violation',
      pattern_id: patternId,
      violations_last_30d: matching.length,
      last_violation: last,
      message: `${patternId} violated ${matching.length} time${matching.length === 1 ? '' : 's'} in last 30 days (last: ${last}). Remember to follow this pattern before proceeding.`
    })
  }
  return warnings
}

// ---------------------------------------------------------------------------
// Phase 3b activation predicate: returns true iff there exists at least one
// active (non-superseded) episode within the 30-day cutoff that is a
// bp-001-implementation-workflow violation. Decoupled from task_type so the
// SessionStart hook can arm the checkpoint marker even when branch/task-type
// inference returns null. Pure function — testable in isolation and stable
// for #80's later validator-backed gate to swap.
// ---------------------------------------------------------------------------
function shouldArmBp001Checkpoint(activeEntries, now, currentProject) {
  // Fail-closed: without a resolved project name we cannot scope the match.
  // The 30-day window arming engine bleeds across projects without this guard.
  if (!currentProject) return false
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const tag = 'violated:bp-001-implementation-workflow'
  return activeEntries.some(e =>
    e &&
    e.status !== 'superseded' &&
    e.category === 'violation' &&
    e.project === currentProject &&
    Array.isArray(e.tags) &&
    e.tags.includes(tag) &&
    typeof e.date === 'string' &&
    e.date >= cutoffStr
  )
}

// Resolve the project name for ARMING purposes (binds to REPO_ROOT, not cwd).
// Precedence: --project override (unless ignored) → <projectRoot>/package.json
// `name` → `git remote get-url origin` basename (subprocess cwd = projectRoot)
// → path.basename(projectRoot).
//
// ignoreOverride:true for the bp-001 arming call site — the marker writes to
// REPO_ROOT/.checkpoints/ so the project identity used to filter violations
// must also bind to REPO_ROOT. Letting --project override the arming-time name
// re-creates the cross-project bleed via a different surface (codex R2 P1).
//
// fast:true skips the `git remote get-url` subprocess. The arming call site
// passes fast:true because (a) SessionStart fires every session and the test
// contract (test-em-recall-session-start-early-exit.mjs T7) forbids this git
// invocation during --session-start, and (b) violations record project names
// matching package.json `name` (the em-store convention), so the git-remote
// fallback rarely contributes a different match than basename(projectRoot).
function resolveProjectName(projectRoot, { ignoreOverride = false, fast = false } = {}) {
  if (!ignoreOverride && projectOverride) return projectOverride

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    if (pkg.name && pkg.name.trim()) return pkg.name.trim()
  } catch {}

  if (!fast) {
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim()
      const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/) || remoteUrl.match(/:([^/]+?)(?:\.git)?$/)
      if (match) return match[1]
    } catch {}
  }

  return path.basename(projectRoot)
}

// ---------------------------------------------------------------------------
// NOTE (planning-passive redesign, 2026-05-25): the former
// armCheckpointMarkerForSession() was removed. em-recall no longer arms the
// pre-checkpoint gate at SessionStart — a recent bp-001 violation now only
// emits the __BP1_ADVISORY__ stderr signal (see the call site below). The
// pre-checkpoint requirement is lazily armed by checkpoint-gate.sh at the first
// repo-source write (the implementation boundary). shouldArmBp001Checkpoint()
// is retained as the advisory predicate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SYNC: em-search.mjs:loadIndex — update both on change
// ---------------------------------------------------------------------------
function loadIndex(dataDir, source) {
  const indexFile = path.join(dataDir, 'index.jsonl')
  if (!fs.existsSync(indexFile)) return []
  return fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    try {
      const entry = JSON.parse(line)
      entry._source = source
      entry._dataDir = dataDir
      return entry
    } catch { return null }
  }).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Context inference
// ---------------------------------------------------------------------------
function inferContext() {
  const ctx = { project: null, branch_tokens: [], keywords: [], effective_tokens: [] }

  // Always read REPO_ROOT/package.json for keywords (independent of project resolution).
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    if (Array.isArray(pkg.keywords)) ctx.keywords = pkg.keywords.map(k => k.toLowerCase().trim()).filter(Boolean)
  } catch {}

  // Project name resolution — root-bound, honors --project override here (recall
  // output filtering is the intended override contract). Arming path uses
  // ignoreOverride:true at the dedicated call site.
  ctx.project = resolveProjectName(REPO_ROOT)

  // 2. Branch tokens
  try {
    const branch = execSync('git branch --show-current', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    if (branch) {
      ctx.branch_tokens = branch.split(/[/\-_]/).filter(Boolean).map(t => t.toLowerCase())
    }
  } catch {}

  // 3. Effective tokens: branch tokens + keywords, stopword-filtered
  const allTokens = [...ctx.branch_tokens, ...ctx.keywords]
  ctx.effective_tokens = [...new Set(
    allTokens.filter(t => t.length >= 4 && !STOPWORDS.has(t))
  )]

  return ctx
}

// ---------------------------------------------------------------------------
// Load all entries once
// ---------------------------------------------------------------------------
let allEntries = []

if (scope === 'local' || scope === 'all') {
  allEntries.push(...loadIndex(LOCAL_DIR, 'local'))
}
if (scope === 'global' || scope === 'all') {
  allEntries.push(...loadIndex(GLOBAL_DIR, 'global'))
}

const totalEpisodeCount = allEntries.length

// Dedupe by id (local takes priority)
const seenIds = new Set()
allEntries = allEntries.filter(e => {
  if (seenIds.has(e.id)) return false
  seenIds.add(e.id)
  return true
})

// Filter out superseded
const activeEntries = allEntries.filter(e => e.status !== 'superseded')

// ---------------------------------------------------------------------------
// SessionStart legacy-plan-marker sweep (PR #314). Runs BEFORE bp-001 arm
// to keep the plan-approval lifecycle deterministic on fresh SessionStart.
//
// Scope reduction (2026-05-18 orphan-deadlock fix): only the unconditional
// legacy-suffix-less `.plan-approval-pending` basename is swept here.
// Checkpoint markers (`.checkpoint-required`, `.post-checkpoint-required`)
// are no longer baseline-mtime-swept — the M5 retime-and-rearm contract
// (force-monotonic baseline below) unblocks Stop while preserving the
// writer-gate for any concurrent live session.
//
// Symlinks ignored (lstat-based; threat-model: honest-agent only).
// ---------------------------------------------------------------------------
if (sessionStartFlag) {
  try {
    ensurePrimaryDir(REPO_ROOT)

    // ---------------------------------------------------------------------
    // Unconditional legacy-suffix-less plan-marker sweep (PR #314 contract).
    // Runs unconditionally so first-ever SessionStart on a fresh clone still
    // reaps any pre-existing legacy orphan. Suffixed forms
    // `.plan-approval-pending.<sid>` are NEVER swept here — SessionEnd hook
    // (em-session-end-prompt.mjs, registry E21) owns own-session cleanup;
    // cross-session crashed-orphan cleanup is the operator-cleanup FU.
    // legacy-read-only: ok (this site only sweeps the legacy basename;
    // never writes it).
    //
    // Checkpoint markers (`.checkpoint-required`, `.post-checkpoint-required`)
    // are NOT swept here. Codex R2/R3 P1: the prior baseline-mtime-keyed
    // sweep created a transient rm→rearm window where a concurrent writer
    // could pass `checkpoint-gate.sh:541` between sweep and
    // `armCheckpointMarker`. The M5 retime-and-rearm contract (force-
    // monotonic baseline below) instead unblocks Stop via baseline mtime
    // refresh while preserving the writer-gate for any concurrent live
    // session.
    // ---------------------------------------------------------------------
    for (const dir of [path.join(REPO_ROOT, PRIMARY_MARKER_DIR), path.join(REPO_ROOT, LEGACY_MARKER_DIR)]) {
      const p = path.join(dir, PLAN_MARKER_LEGACY_BASENAME)
      try {
        const st = fs.lstatSync(p)
        if (!st.isSymbolicLink()) fs.rmSync(p, { force: true })
      } catch (e) {
        if (e.code !== 'ENOENT') {
          process.stderr.write(`em-recall: legacy-plan-marker-sweep skipped ${p}: ${e.code || e.message}\n`)
        }
      }
    }

    // ---------------------------------------------------------------------
    // Preflight-family orphan sweep (checkpoint-hygiene F4, closes the #283
    // SessionStart half). `.preflight-done.<sid>` and
    // `.last-user-prompt.<sid>.json` are written by preflight-prompt-helper.sh
    // every session; SessionEnd reaps the own-session pair, this sweep reaps
    // crashed-session orphans.
    //
    // Containment + safety:
    //   - readdir of the PRIMARY marker dir only (families never had legacy
    //     .claude/ forms); basenames carry no path separators.
    //   - suffixED-only matchers — the legacy suffix-less `.preflight-done`
    //     is burn-in/F7 scope and is preserved.
    //   - 7-day mtime guard: a live concurrent session's markers are days,
    //     not weeks, old. Worst case (week-idle still-open session) the
    //     preflight gate re-prompts once — fail-closed in the safe direction.
    //   - lstat per entry; symlinks never followed or unlinked (mirrors the
    //     classifier-marker vacuum contract).
    // ---------------------------------------------------------------------
    const PREFLIGHT_ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
    const sweepCutoff = Date.now() - PREFLIGHT_ORPHAN_MAX_AGE_MS
    const primaryDir = path.join(REPO_ROOT, PRIMARY_MARKER_DIR)
    let sweepEntries = []
    try { sweepEntries = fs.readdirSync(primaryDir) } catch { sweepEntries = [] }
    for (const name of sweepEntries) {
      if (!preflightMarkerSuffixedBasenameMatches(name) && !lastUserPromptBasenameMatches(name)) continue
      const p = path.join(primaryDir, name)
      try {
        const st = fs.lstatSync(p)
        if (st.isSymbolicLink()) continue
        if (!st.isFile()) continue
        if (st.mtimeMs < sweepCutoff) fs.unlinkSync(p)
      } catch (e) {
        if (e.code !== 'ENOENT') {
          process.stderr.write(`em-recall: preflight-orphan-sweep skipped ${p}: ${e.code || e.message}\n`)
        }
      }
    }

  } catch {
    // Best-effort: a failure here leaves the legacy-plan-marker sweep
    // inactive; SessionEnd hook still owns own-session cleanup.
  }
}

// ---------------------------------------------------------------------------
// Phase 3b activation (RFC-002 Phase 3 / T7): historically armed the checkpoint
// marker whenever a recent bp-001-implementation-workflow violation existed,
// regardless of task_type. bp-001 is workflow discipline that applies to any
// session that ends up writing files.
// ---------------------------------------------------------------------------
// Bind advisory-time project name to REPO_ROOT (NOT process.cwd() and NOT the
// --project override) so the project identity used to scope violations matches
// the repo authority root. Closes the cross-project bleed where violations in
// one project armed checkpoint gates in every other project at SessionStart.
// Planning-passive redesign (2026-05-25): a recent bp-001 violation NO LONGER
// arms the pre-checkpoint gate at session start. That blocked planning,
// discovery, exploration, and code reviews before any implementation began —
// the core checkpoint friction. The pre-checkpoint requirement is now lazily
// armed by checkpoint-gate.sh at the IMPLEMENTATION boundary (first repo-source
// write). Here we only emit an ADVISORY (warning, never a marker/block) on a
// dedicated stderr sentinel; em-recall-sessionstart.sh surfaces it via
// SessionStart additionalContext (closes the #61 swallow for this signal).
const armingProject = resolveProjectName(REPO_ROOT, { ignoreOverride: true, fast: true })
if (shouldArmBp001Checkpoint(activeEntries, new Date(), armingProject)) {
  process.stderr.write(
    '__BP1_ADVISORY__ A recent bp-001-implementation-workflow violation exists in this project. ' +
    'The pre-implementation checkpoint is NOT armed during planning — it is required only when you ' +
    'first edit repo source. Advisory only; not blocking.\n'
  )
}

// ---------------------------------------------------------------------------
// SessionStart baseline write — M5 retime-and-rearm (#146 A2 + 2026-05-18
// orphan-deadlock fix). Runs AFTER the arming block above.
//
// Force-monotonic semantics (codex R3/R4): baseline.mtime is set to
//   max(Date.now(), ceil(max(CR.mtime, PostR.mtime)) + 1)
// so the carve-out invariant `marker.mtime <= baseline.mtime` holds for
// every checkpoint marker OBSERVED during the SessionStart probe loop,
// regardless of whether it was armed by this session or left by a prior
// crashed session. Residual liveness edge (codex code-review R1 FU): a
// marker armed AFTER the probe but BEFORE `fs.utimesSync` is not retimed
// — but it fails CLOSED (stop-gate conservatively blocks when
// marker.mtime > baseline.mtime), so it is a residual orphan-deadlock
// edge, not a safety hole. The next SessionStart resolves it.
//
// Why force-monotonic instead of `Date.now()/1000`:
//   - APFS / ext4 preserve sub-ms file mtime (ns-precision).
//   - `Date.now()` is ms-truncated; `fs.writeFileSync` writes with kernel
//     ns precision. A marker armed at sub-ms past `Date.now()`'s tick can
//     land with mtime > baseline.mtime → carve-out inverts → orphan stop-
//     gate deadlock. This is the empirical bug observed 2026-05-18.
//   - `+1` (ms unit) guarantees ordering on APFS/ext4/NTFS (sub-second).
//
// Concurrent-session-safety (codex R2/R3): no rm of CR/PostR — Session A's
// live marker is preserved across Session B SessionStart; writer-gate
// remains active for both. Stop is unblocked because B's baseline now
// dominates A's marker mtime.
//
// .checkpoints/ migration: baseline written at PRIMARY only. Carve-out
// reader takes the MAX of primary + legacy baseline mtimes (defensive).
// ---------------------------------------------------------------------------
if (sessionStartFlag) {
  try {
    ensurePrimaryDir(REPO_ROOT)

    // Probe checkpoint task-signal marker mtimes across BOTH roots
    // (dual-root burn-in). Plan-marker excluded — PR #314 contract handles
    // plan-approval lifecycle.
    //
    // Rank-2: glob-expand suffixed forms `.X.<*>` CROSS-SESSION. The
    // baseline must dominate all sessions' suffixed markers so any
    // session's stop-gate carve-out + push-gate cleanup remains valid.
    // This is the cross-session safety mechanism for the quartet
    // (own-session reads handle the rest at stop-gate time).
    let maxCheckpointMarkerMs = 0
    const taskSignalQuartet = ['.checkpoint-required', '.post-checkpoint-required']
    for (const name of taskSignalQuartet) {
      // Legacy literal at both roots.
      for (const p of bothMarkerPaths(REPO_ROOT, name)) {
        try {
          const st = fs.lstatSync(p)
          if (st.isSymbolicLink()) continue
          if (st.mtimeMs > maxCheckpointMarkerMs) {
            maxCheckpointMarkerMs = st.mtimeMs
          }
        } catch (e) {
          if (e.code !== 'ENOENT') {
            process.stderr.write(`em-recall: baseline-monotonic-probe skipped ${p}: ${e.code || e.message}\n`)
          }
        }
      }
      // Cross-session glob-expand `<name>.<*>` at both roots.
      const prefix = `${name}.`
      for (const dir of [path.join(REPO_ROOT, PRIMARY_MARKER_DIR), path.join(REPO_ROOT, LEGACY_MARKER_DIR)]) {
        let entries
        try { entries = fs.readdirSync(dir) } catch (e) {
          if (e.code !== 'ENOENT') {
            process.stderr.write(`em-recall: baseline-monotonic-probe readdir skipped ${dir}: ${e.code || e.message}\n`)
          }
          continue
        }
        for (const ent of entries) {
          if (!ent.startsWith(prefix)) continue
          const p = path.join(dir, ent)
          try {
            const st = fs.lstatSync(p)
            if (st.isSymbolicLink()) continue
            if (st.mtimeMs > maxCheckpointMarkerMs) {
              maxCheckpointMarkerMs = st.mtimeMs
            }
          } catch (e) {
            if (e.code !== 'ENOENT') {
              process.stderr.write(`em-recall: baseline-monotonic-probe skipped ${p}: ${e.code || e.message}\n`)
            }
          }
        }
      }
    }

    const baseline = writeMarkerPath(REPO_ROOT, BASELINE_NAME)
    fs.writeFileSync(baseline, '')
    const baselineTargetMs = Math.max(Date.now(), Math.ceil(maxCheckpointMarkerMs) + 1)
    const baselineTargetSec = baselineTargetMs / 1000
    fs.utimesSync(baseline, baselineTargetSec, baselineTargetSec)
  } catch {
    // Best-effort: baseline write failure leaves carve-out inactive for
    // this session (gate falls back to original behavior — original
    // bp-001 enforcement still works without the carve-out).
  }

  // SessionStart fast path: hook redirects stdout to /dev/null, so the
  // recall-output formatting below is dead work. All side effects above
  // (orphan cleanup, bp-001 arm, baseline write) are synchronous and
  // already complete. Skipping inferContext() here also avoids two git
  // execs (~35 ms) that only feed the discarded output.
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Context (recall-output path only; inferContext() runs git subprocesses
// that are unnecessary in --session-start mode).
// ---------------------------------------------------------------------------
const context = inferContext()
const preflight_warnings = []

// ---------------------------------------------------------------------------
// Task type: explicit flag wins; otherwise infer from branch tokens.
// `null` means task type is unclear → no task-type-scoped pre-flight runs
// (T3). Marker arming above is independent.
// ---------------------------------------------------------------------------
const taskType = taskTypeFlag || inferTaskType(context.branch_tokens)

// ---------------------------------------------------------------------------
// Violation pre-flight (RFC-002 Phase 3 / T1-T5) — task-type-scoped
// warnings for ranking and user-facing messaging.
// ---------------------------------------------------------------------------
if (taskType) {
  const patterns = loadPatternsIndex()
  const violationWarnings = runViolationPreflight(activeEntries, taskType, patterns)
  preflight_warnings.push(...violationWarnings)
}

// ---------------------------------------------------------------------------
// Pass 1: Project match
// ---------------------------------------------------------------------------
const pass1 = new Map()
if (context.project) {
  for (const e of activeEntries) {
    if (e.project === context.project) {
      const score = computeScore(e, 1.0)
      pass1.set(e.id, { entry: e, score })
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2: Tag match (using inverted index)
// ---------------------------------------------------------------------------
const pass2 = new Map()
if (context.effective_tokens.length > 0) {
  const normalizedTokens = normalizeTags(context.effective_tokens.join(','))

  // Load tags indexes
  const dirs = []
  if (scope === 'local' || scope === 'all') dirs.push(LOCAL_DIR)
  if (scope === 'global' || scope === 'all') dirs.push(GLOBAL_DIR)

  const matchingIds = new Set()
  let tagsIndexMissing = false

  for (const dir of dirs) {
    const idx = loadTagsIndex(dir)
    if (!idx) {
      tagsIndexMissing = true
      continue
    }
    for (const token of normalizedTokens) {
      if (idx[token]) {
        for (const id of idx[token]) matchingIds.add(id)
      }
    }
  }

  if (tagsIndexMissing) {
    // Fallback: linear scan
    preflight_warnings.push({ type: 'system', message: 'tags.json missing or corrupt in one or more stores. Run em-rebuild-index.mjs to regenerate.' })
    for (const e of activeEntries) {
      if (e.tags) {
        const eTags = e.tags.map(t => t.toLowerCase().trim())
        if (normalizedTokens.some(t => eTags.includes(t))) {
          matchingIds.add(e.id)
        }
      }
    }
  }

  for (const e of activeEntries) {
    if (matchingIds.has(e.id)) {
      const score = computeScore(e, 0.7)
      pass2.set(e.id, { entry: e, score })
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 3: Recent cross-project (last N days)
// ---------------------------------------------------------------------------
const pass3 = new Map()
if (days > 0) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  for (const e of activeEntries) {
    if (e.date >= cutoffStr) {
      const score = computeScore(e, 0.5)
      pass3.set(e.id, { entry: e, score })
    }
  }
}

// ---------------------------------------------------------------------------
// Merge: deduplicate by episode ID, keep highest score
// ---------------------------------------------------------------------------
const merged = new Map()
for (const pass of [pass1, pass2, pass3]) {
  for (const [id, { entry, score }] of pass) {
    if (!merged.has(id) || merged.get(id).score < score) {
      merged.set(id, { entry, score })
    }
  }
}

// Sort by score descending, apply limit
let results = [...merged.values()]
  .sort((a, b) => b.score - a.score)
  .slice(0, limit)

// ---------------------------------------------------------------------------
// Access tracking write-back
// ---------------------------------------------------------------------------
if (!noTrack && results.length > 0) {
  writeBackAccessTracking(results.map(r => r.entry))
}

// ---------------------------------------------------------------------------
// Prune suggestion (query-independent score, matching em-prune.mjs)
// ---------------------------------------------------------------------------
let prune_suggestion = null
const PRUNE_THRESHOLD = 0.15
let prunableCount = 0
for (const e of allEntries) {
  const pruneScore = computeScore(e, 1.0)
  if (pruneScore < PRUNE_THRESHOLD) prunableCount++
}
if (prunableCount > 0) {
  prune_suggestion = `${prunableCount} episodes below threshold. Run em-prune.mjs --dry-run to review.`
}

// ---------------------------------------------------------------------------
// Build output
// ---------------------------------------------------------------------------
const episodes = results.map(({ entry, score }) => {
  const { _dataDir, _source, ...rest } = entry
  return { ...rest, source: _source, score: Math.round(score * 1000) / 1000 }
})

const result = {
  status: 'ok',
  context: {
    project: context.project,
    branch_tokens: context.branch_tokens,
    effective_tokens: context.effective_tokens,
    task_type: taskType
  },
  count: episodes.length,
  episodes,
  preflight_warnings,
  prune_suggestion
}

// Performance health check
const elapsed = Date.now() - recallStart
if (elapsed > warnTimeMs) {
  preflight_warnings.push({ type: 'system', message: `Recall took ${elapsed}ms across ${totalEpisodeCount} episodes. Consider running em-prune.mjs to archive stale episodes.` })
}
if (totalEpisodeCount > warnCount) {
  preflight_warnings.push({ type: 'system', message: `${totalEpisodeCount} episodes in index. Performance may degrade. Run em-prune.mjs --dry-run to check for prunable episodes.` })
}

console.log(JSON.stringify(result))
