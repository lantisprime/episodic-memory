#!/usr/bin/env node
/**
 * em-workflow-validate.mjs — Validate workflow.lifecycle episode chain for a task.
 *
 * RFC-002 Phase 3b-H1 PR-C. Replaces non-empty-marker semantics (`[ -s "$MARKER" ]`)
 * with append-only workflow lifecycle episodes referenced by the gate.
 *
 * Usage:
 *   node em-workflow-validate.mjs --task <task>
 *                                 --gate <pre-checkpoint|post-checkpoint|push-allowed>
 *                                 [--pattern-id <id>]      # default: bp-001-implementation-workflow
 *                                 [--worktree <abs path>]  # context match (error on mismatch)
 *                                 [--branch <branch>]      # context match (error on mismatch when passed)
 *                                 [--head <sha>]           # context match (error on mismatch when passed)
 *                                 [--scope local|global|all]  # default: all
 *                                 [--strict]               # treat warnings as errors
 *
 * Exits 0 on validation pass, 1 on validation fail, 2 on usage/IO error.
 * Always emits JSON to stdout: { status, valid, gate, task, missing[], errors[], warnings[], episodes[] }
 *
 * Episode body convention: workflow.lifecycle episodes MUST contain exactly one
 * ```json fenced code block whose content conforms to the schema in
 * docs/specs/workflow-lifecycle.md (mirrored from RFC-002:267-327).
 *
 * This script does NOT modify episodes, write markers, or call hooks. It is a
 * pure validator. Hooks shell out to it and act on the JSON result.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = path.join(process.cwd(), '.episodic-memory')

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const task = flag('--task')
const gate = flag('--gate')
const patternId = flag('--pattern-id') || 'bp-001-implementation-workflow'
const worktreeFlag = flag('--worktree')
const branch = flag('--branch')
const head = flag('--head')
const scope = flag('--scope') || 'all'
const strict = argv.includes('--strict')

const VALID_GATES = ['pre-checkpoint', 'post-checkpoint', 'push-allowed']
const VALID_SCOPES = ['local', 'global', 'all']

// Lifecycle event order per RFC-002:262.
// classified and scope-change are not required for any gate by default.
const EVENT_ORDER = ['classified', 'plan-approved', 'pre-checkpoint', 'review-done', 'post-checkpoint', 'scope-change', 'push-allowed']

// Required predecessor chain by gate. The gate passes iff all required events
// are present, in order, with valid payloads and consistent task identity.
const REQUIRED_FOR_GATE = {
  'pre-checkpoint': ['plan-approved', 'pre-checkpoint'],
  'post-checkpoint': ['plan-approved', 'pre-checkpoint', 'post-checkpoint'],
  'push-allowed': ['plan-approved', 'pre-checkpoint', 'post-checkpoint', 'push-allowed']
}

// Terminal event for each gate. Per-gate head rules (#98 finding 1):
// only the terminal link must have ctx.head == --head; non-terminal chain
// links may sit at older heads (their authoring time, not current HEAD).
// Branch must match across ALL chain links — branch-switch is the forgery
// vector. push-allowed adds an additional exact-equality check on the
// referenced post-checkpoint's head, since that's what asserts "code at
// this SHA passed evidence" (see validateChain for that special case).
const TERMINAL_FOR_GATE = {
  'pre-checkpoint': 'pre-checkpoint',
  'post-checkpoint': 'post-checkpoint',
  'push-allowed': 'push-allowed'
}

function fail(msg, code = 2) {
  console.log(JSON.stringify({ status: 'error', message: msg }))
  process.exit(code)
}

if (!task) fail('Missing --task')
if (!gate) fail(`Missing --gate. Must be one of: ${VALID_GATES.join(', ')}`)
if (!VALID_GATES.includes(gate)) fail(`Invalid --gate "${gate}". Must be one of: ${VALID_GATES.join(', ')}`)
if (!VALID_SCOPES.includes(scope)) fail(`Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}`)
// push-allowed gate requires --head: without it the post-checkpoint exact-
// equality head check is silently skipped, which would let stale evidence
// satisfy a push (#98 finding 1 / Codex BLOCKER 2).
if (gate === 'push-allowed' && !head) fail('--head is required for --gate push-allowed (post-checkpoint head must be asserted against current HEAD)')

// ---------------------------------------------------------------------------
// Index loading — mirrors em-search.mjs:loadIndex / em-recall.mjs:loadIndex.
// SYNC: keep aligned with those two if the index format changes.
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
// Payload extraction. Episodes are .md files; the lifecycle payload is the
// first ```json fenced code block in the body. Returns parsed JSON or throws.
// ---------------------------------------------------------------------------
function extractPayload(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/)
  if (!m) throw new Error(`No \`\`\`json fenced block found in ${filePath}`)
  return JSON.parse(m[1])
}

// ---------------------------------------------------------------------------
// Schema validation per RFC-002:267-327.
//
// Required fields per event:
//   all:               event, pattern_id, task, context.{worktree,branch,head}
//   plan-approved:     plan_ref, approval_ref
//   pre-checkpoint:    plan_ref, approval_ref, second_opinion?{status,recipient,reply_ref?}
//   review-done:       reply_ref or evidence reference (witness)
//   post-checkpoint:   evidence.{tests[],code_review,e2e,bug_logging}
//   push-allowed:      references post-checkpoint episode by id
//
// Placeholder rejection: any required reference field whose value is the
// literal "TBD", "TODO", "placeholder", "...", "" or whose ref-shaped values
// (episode:..., issue:..., file:..., command:..., log:...) lack a payload
// after the prefix is treated as placeholder and rejected. `episode:self` is
// also rejected as a placeholder — self-witnessing approval is not evidence
// (RFC-002:327: references must point to real artifacts).
// ---------------------------------------------------------------------------
const PLACEHOLDER_VALUES = new Set(['', 'tbd', 'todo', 'placeholder', '...', 'xxx', 'n/a', 'na'])
const REF_PREFIXES = ['episode:', 'issue:', 'file:', 'command:', 'log:', 'sha:']
const SELF_REFS = new Set(['episode:self', 'self'])

function realpathOrPath(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

// Probe git availability once. If we're inside a work tree, git is "available"
// — and a subsequent status-128 from is-ancestor must mean "unknown sha"
// (which we treat as failure, not skip). If git is unavailable / not a repo,
// ancestor checks are skipped silently — the validator must work outside a
// repo (e.g. running over a pure index dump in CI).
let GIT_AVAILABLE = null
function gitAvailable() {
  if (GIT_AVAILABLE !== null) return GIT_AVAILABLE
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      stdio: 'ignore', cwd: process.cwd()
    })
    GIT_AVAILABLE = true
  } catch {
    GIT_AVAILABLE = false
  }
  return GIT_AVAILABLE
}

// `git merge-base --is-ancestor <a> <b>` exits 0 if a is an ancestor of b,
// 1 if not, 128 if not a repo / unknown sha.
// Returns true / false / null (null = git unavailable, skip the check).
// When git IS available but a sha is unknown (status 128), returns false —
// referencing a fictional commit is a chain failure.
function isAncestor(ancestor, descendant) {
  if (!ancestor || !descendant) return null
  if (ancestor === descendant) return true
  if (!gitAvailable()) return null
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore', cwd: process.cwd()
    })
    return true
  } catch (e) {
    // status 1 = not an ancestor; status 128 = unknown sha (now that git is
    // available, this is a hard failure, not "skip silently").
    return false
  }
}

function isPlaceholder(v) {
  if (v == null) return true
  if (typeof v !== 'string') return false
  const lower = v.trim().toLowerCase()
  if (PLACEHOLDER_VALUES.has(lower)) return true
  if (SELF_REFS.has(lower)) return true
  for (const p of REF_PREFIXES) {
    if (lower === p || lower === p.slice(0, -1)) return true
    if (lower.startsWith(p) && lower.slice(p.length).trim() === '') return true
  }
  return false
}

// Resolve every `episode:<id>`-shaped value in a list of (label, value) pairs.
// Non-episode-shaped values (file paths, URLs, etc.) pass through unchanged.
// Errors are pushed into the shared array.
function checkEpisodeRefs(pairs, entry, indexById, errors, opts = {}) {
  for (const [label, value] of pairs) {
    if (typeof value !== 'string') continue
    if (!value.startsWith('episode:')) continue
    if (isPlaceholder(value)) continue // already errored upstream
    const r = resolveEpisodeRef(value, indexById, entry, opts)
    if (r.error) errors.push(`episode:${entry.id}: ${label} ${r.error}`)
  }
}

function validatePayload(payload, entry, errors, warnings, indexById) {
  const fp = `episode:${entry.id}`
  if (payload.event && !EVENT_ORDER.includes(payload.event)) {
    errors.push(`${fp}: unknown event "${payload.event}". Must be one of: ${EVENT_ORDER.join(', ')}`)
  }
  if (payload.pattern_id !== patternId) {
    errors.push(`${fp}: pattern_id "${payload.pattern_id}" != requested "${patternId}"`)
  }
  if (payload.task !== task) {
    errors.push(`${fp}: task "${payload.task}" != requested "${task}"`)
  }
  const ctx = payload.context || {}
  for (const f of ['worktree', 'branch', 'head']) {
    if (!ctx[f] || isPlaceholder(ctx[f])) errors.push(`${fp}: context.${f} missing or placeholder`)
  }
  // Worktree mismatch is an error per RFC-002:327. Either the explicit flag
  // or the validator's CWD is the source of truth — explicit flag wins.
  // Compare resolved real paths so symlink-affected matches (e.g. macOS
  // /var → /private/var) don't false-positive.
  const expectedWorktree = worktreeFlag || process.cwd()
  if (ctx.worktree) {
    const actualReal = realpathOrPath(ctx.worktree)
    const expectedReal = realpathOrPath(expectedWorktree)
    if (actualReal !== expectedReal) {
      errors.push(`${fp}: context.worktree "${ctx.worktree}" != expected "${expectedWorktree}"`)
    }
  }
  // Branch must match across ALL chain links (#98 finding 1 — branch-switch
  // is the forgery vector). Enforced whenever --branch is passed.
  if (branch && ctx.branch && ctx.branch !== branch) {
    errors.push(`${fp}: context.branch "${ctx.branch}" != requested "${branch}" (chain links must share branch)`)
  }
  // Head check is per-gate: terminal link MUST equal --head; non-terminal
  // links may sit at an older head, but if git is available that head must
  // be an ancestor of --head (same git history). Skip ancestor check if
  // git is unavailable (validator must work outside a repo too).
  if (head && ctx.head) {
    const terminalEvent = TERMINAL_FOR_GATE[gate]
    const isTerminal = payload.event === terminalEvent
    if (isTerminal) {
      if (ctx.head !== head) {
        errors.push(`${fp}: context.head "${ctx.head}" != requested "${head}" (terminal ${payload.event} must be at current HEAD; new commits since evidence?)`)
      }
    } else if (ctx.head !== head) {
      const anc = isAncestor(ctx.head, head)
      if (anc === false) {
        errors.push(`${fp}: context.head "${ctx.head}" is not an ancestor of current HEAD "${head}" (chain link must be in same git history — branch switch or unrelated chain?)`)
      }
      // anc === null: git unavailable; skip silently.
    }
  }

  switch (payload.event) {
    case 'plan-approved':
      // plan-approved IS the approval record — it doesn't need approval_ref
      // pointing elsewhere. pre-checkpoint references plan-approved by id.
      if (isPlaceholder(payload.plan_ref)) errors.push(`${fp}: plan-approved.plan_ref missing or placeholder`)
      break
    case 'pre-checkpoint':
      if (isPlaceholder(payload.plan_ref)) errors.push(`${fp}: pre-checkpoint.plan_ref missing or placeholder`)
      if (isPlaceholder(payload.approval_ref)) errors.push(`${fp}: pre-checkpoint.approval_ref missing or placeholder`)
      // approval_ref must resolve to a workflow.lifecycle plan-approved episode.
      // The category check is done here; the event check happens in validateChain
      // since events[] has already extracted payloads.
      checkEpisodeRefs(
        [['approval_ref', payload.approval_ref]],
        entry, indexById, errors,
        { expectedCategory: 'workflow.lifecycle' }
      )
      // plan_ref MAY be an episode ref (e.g. an inline RFC excerpt episode)
      // or a file path / URL. If episode-shaped, resolve it.
      checkEpisodeRefs([['plan_ref', payload.plan_ref]], entry, indexById, errors)
      if (payload.second_opinion) {
        const so = payload.second_opinion
        if (!so.status || isPlaceholder(so.status)) errors.push(`${fp}: pre-checkpoint.second_opinion.status missing`)
        if (so.status === 'done' && isPlaceholder(so.reply_ref)) errors.push(`${fp}: pre-checkpoint.second_opinion.reply_ref required when status=done`)
        if (so.reply_ref) checkEpisodeRefs([['second_opinion.reply_ref', so.reply_ref]], entry, indexById, errors)
      }
      break
    case 'review-done':
      if (isPlaceholder(payload.reply_ref) && isPlaceholder(payload.evidence_ref)) {
        errors.push(`${fp}: review-done requires reply_ref or evidence_ref (external witness)`)
      }
      checkEpisodeRefs(
        [['reply_ref', payload.reply_ref], ['evidence_ref', payload.evidence_ref]],
        entry, indexById, errors
      )
      break
    case 'post-checkpoint':
      // pre_checkpoint_ref is required — it's the splice-resistance link
      // back to the pre-checkpoint episode in the same chain (#98 finding 1).
      if (isPlaceholder(payload.pre_checkpoint_ref)) {
        errors.push(`${fp}: post-checkpoint.pre_checkpoint_ref missing or placeholder (required to bind chain back to pre-checkpoint)`)
      } else {
        checkEpisodeRefs(
          [['pre_checkpoint_ref', payload.pre_checkpoint_ref]],
          entry, indexById, errors,
          { expectedCategory: 'workflow.lifecycle' }
        )
      }
      const ev = payload.evidence
      if (!ev || typeof ev !== 'object') {
        errors.push(`${fp}: post-checkpoint.evidence missing`)
        break
      }
      if (!Array.isArray(ev.tests) || ev.tests.length === 0) {
        errors.push(`${fp}: post-checkpoint.evidence.tests must be a non-empty array`)
      } else {
        ev.tests.forEach((t, i) => {
          if (!t || isPlaceholder(t.command)) errors.push(`${fp}: evidence.tests[${i}].command missing/placeholder`)
          if (!t || isPlaceholder(t.status)) errors.push(`${fp}: evidence.tests[${i}].status missing/placeholder`)
          if (!t || isPlaceholder(t.log_ref)) errors.push(`${fp}: evidence.tests[${i}].log_ref missing/placeholder`)
        })
      }
      for (const k of ['code_review', 'e2e', 'bug_logging']) {
        const sub = ev[k]
        if (!sub || typeof sub !== 'object') errors.push(`${fp}: post-checkpoint.evidence.${k} missing`)
        else if (isPlaceholder(sub.status)) errors.push(`${fp}: evidence.${k}.status missing/placeholder`)
      }
      if (ev.code_review && ev.code_review.status === 'done' && isPlaceholder(ev.code_review.reply_ref)) {
        errors.push(`${fp}: evidence.code_review.reply_ref required when status=done`)
      }
      if (ev.e2e && ev.e2e.status === 'passed' && isPlaceholder(ev.e2e.log_ref)) {
        errors.push(`${fp}: evidence.e2e.log_ref required when status=passed`)
      }
      if (ev.bug_logging && ev.bug_logging.status === 'done' && !Array.isArray(ev.bug_logging.issues)) {
        errors.push(`${fp}: evidence.bug_logging.issues must be an array when status=done`)
      }
      // Resolve all episode-shaped evidence refs (#98 finding 2).
      if (Array.isArray(ev.tests)) {
        ev.tests.forEach((t, i) => {
          if (t) checkEpisodeRefs([[`evidence.tests[${i}].log_ref`, t.log_ref]], entry, indexById, errors)
        })
      }
      if (ev.code_review) checkEpisodeRefs([['evidence.code_review.reply_ref', ev.code_review.reply_ref]], entry, indexById, errors)
      if (ev.e2e) checkEpisodeRefs([['evidence.e2e.log_ref', ev.e2e.log_ref]], entry, indexById, errors)
      // bug_logging.issues[] shape: empty array OR strings of shape
      // https://github.com/<owner>/<repo>/issues/<n> | gh:<owner>/<repo>#<n>.
      // Free-form strings rejected (was previously unvalidated — #98 finding 2).
      if (ev.bug_logging && Array.isArray(ev.bug_logging.issues)) {
        ev.bug_logging.issues.forEach((iss, i) => {
          if (typeof iss !== 'string' || !ISSUE_REF_RE.test(iss)) {
            errors.push(`${fp}: evidence.bug_logging.issues[${i}] must be GitHub issue URL (https://github.com/owner/repo/issues/N) or gh:owner/repo#N, got "${iss}"`)
          }
        })
      }
      break
    case 'push-allowed':
      if (isPlaceholder(payload.post_checkpoint_ref)) {
        errors.push(`${fp}: push-allowed requires post_checkpoint_ref pointing to the post-checkpoint episode`)
      }
      checkEpisodeRefs(
        [['post_checkpoint_ref', payload.post_checkpoint_ref]],
        entry, indexById, errors,
        { expectedCategory: 'workflow.lifecycle' }
      )
      break
  }
}

// ---------------------------------------------------------------------------
// Episode reference resolution. RFC-002:327 requires references to point to
// real artifacts. Resolution checks (a) the id exists in the index, (b) the
// episode is active (not superseded), (c) the ref is not self-witness, and
// (d) the referenced episode's timestamp is <= the citing episode's. Optional
// `expectedCategory` enforces kind for chain-link refs (e.g. approval_ref
// must point to a workflow.lifecycle episode).
// ---------------------------------------------------------------------------
function refTarget(ref) {
  if (typeof ref !== 'string') return null
  const m = ref.match(/^episode:(.+)$/)
  return m ? m[1].trim() : null
}

function resolveEpisodeRef(ref, indexById, currentEpisode, opts = {}) {
  const id = refTarget(ref)
  if (!id) return { error: `not an episode reference (expected episode:<id>): "${ref}"` }
  if (id === currentEpisode.id) {
    return { error: `episode:${id} self-witness: ref points to its own episode id` }
  }
  const entry = indexById.get(id)
  if (!entry) return { error: `episode:${id} not found (checked local + global)` }
  if (entry.status === 'superseded') return { error: `episode:${id} is superseded` }
  if (entry.status && entry.status !== 'active') {
    return { error: `episode:${id} is not active (status=${entry.status})` }
  }
  const refTime = `${entry.date} ${entry.time}`
  const curTime = `${currentEpisode.date} ${currentEpisode.time}`
  if (refTime > curTime) {
    return { error: `episode:${id} timestamp ${refTime} is after citing episode ${curTime} (chain must be temporally ordered)` }
  }
  if (opts.expectedCategory && entry.category !== opts.expectedCategory) {
    return { error: `episode:${id} category "${entry.category}" != expected "${opts.expectedCategory}"` }
  }
  return { entry, source: entry._source }
}

// `bug_logging.issues[]` element shape per workflow-lifecycle.md:
// empty array (checked, no bugs), or strings of shape
//   https://github.com/<owner>/<repo>/issues/<n>
//   gh:<owner>/<repo>#<n>
// Free-form strings are rejected (was previously unvalidated — #98 finding 2).
const ISSUE_REF_RE = /^(https:\/\/github\.com\/[^\/\s]+\/[^\/\s]+\/issues\/\d+|gh:[^\/\s]+\/[^\/\s#]+#\d+)$/

function validateChain(events, errors, gateArg, headArg) {
  const byEvent = {}
  for (const e of events) {
    if (!byEvent[e.payload.event]) byEvent[e.payload.event] = []
    byEvent[e.payload.event].push(e)
  }
  // pre-checkpoint.approval_ref must point to a plan-approved episode for same task
  for (const pre of (byEvent['pre-checkpoint'] || [])) {
    const targetId = refTarget(pre.payload.approval_ref)
    if (!targetId) {
      errors.push(`episode:${pre.entry.id}: approval_ref "${pre.payload.approval_ref}" is not an episode reference (expected episode:<id>)`)
      continue
    }
    const matching = (byEvent['plan-approved'] || []).find(e => e.entry.id === targetId)
    if (!matching) {
      errors.push(`episode:${pre.entry.id}: approval_ref episode:${targetId} not a plan-approved episode for this task (chain link must be same-task plan-approved, not arbitrary episode)`)
    }
  }
  // post-checkpoint.pre_checkpoint_ref must point to a pre-checkpoint episode
  // for same task (#98 finding 1 splice-resistance).
  for (const post of (byEvent['post-checkpoint'] || [])) {
    if (!post.payload.pre_checkpoint_ref) continue // already errored upstream
    const targetId = refTarget(post.payload.pre_checkpoint_ref)
    if (!targetId) continue
    const matching = (byEvent['pre-checkpoint'] || []).find(e => e.entry.id === targetId)
    if (!matching) {
      errors.push(`episode:${post.entry.id}: pre_checkpoint_ref episode:${targetId} not a pre-checkpoint episode for this task (chain splicing rejected)`)
    }
  }
  // push-allowed.post_checkpoint_ref must point to a post-checkpoint episode.
  // Additionally for push-allowed gate: the referenced post-checkpoint's head
  // MUST equal --head (Codex correction on #98 finding 1: ancestor-only is too
  // weak — it would let commits land after the evidence SHA).
  for (const pa of (byEvent['push-allowed'] || [])) {
    const targetId = refTarget(pa.payload.post_checkpoint_ref)
    if (!targetId) {
      errors.push(`episode:${pa.entry.id}: post_checkpoint_ref not an episode reference`)
      continue
    }
    const matching = (byEvent['post-checkpoint'] || []).find(e => e.entry.id === targetId)
    if (!matching) {
      errors.push(`episode:${pa.entry.id}: post_checkpoint_ref episode:${targetId} not a post-checkpoint episode for this task (chain link must be same-task post-checkpoint, not arbitrary episode)`)
      continue
    }
    if (gateArg === 'push-allowed' && headArg) {
      const pcHead = matching.payload.context && matching.payload.context.head
      if (!pcHead) {
        errors.push(`episode:${pa.entry.id}: referenced post-checkpoint episode:${targetId} has no context.head — cannot verify against current HEAD`)
      } else if (pcHead !== headArg) {
        errors.push(`episode:${pa.entry.id}: referenced post-checkpoint episode:${targetId} has head "${pcHead}" != current --head "${headArg}". Code may have changed since evidence was recorded — re-run post-checkpoint at current HEAD.`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
// Caller --scope governs which scopes are searched for the lifecycle chain
// itself (the workflowEntries below). Episode reference resolution is a
// separate concern: a lifecycle chain may legitimately cite a global witness
// even when --scope=local (and vice versa). So we build indexById from BOTH
// local and global unconditionally, while workflowEntries respects --scope.
// Without this split, a local chain that cites a global log would fail with
// "not found (checked local + global)" — the exact behavior Codex reproduced
// in the PR #98 re-review (#98 finding 2 follow-up).
const localEntries = loadIndex(LOCAL_DIR, 'local')
const globalEntries = loadIndex(GLOBAL_DIR, 'global')

// Resolver index: every id from both scopes, local takes priority on collision.
const indexById = new Map()
for (const e of globalEntries) indexById.set(e.id, e)
for (const e of localEntries) indexById.set(e.id, e) // local wins

// Lifecycle chain entries respect --scope.
let allEntries = []
if (scope === 'local' || scope === 'all') allEntries.push(...localEntries)
if (scope === 'global' || scope === 'all') allEntries.push(...globalEntries)
const seen = new Set()
allEntries = allEntries.filter(e => {
  if (seen.has(e.id)) return false
  seen.add(e.id)
  return true
})

// Filter to active workflow.lifecycle episodes
const workflowEntries = allEntries.filter(e =>
  e.status !== 'superseded' && e.category === 'workflow.lifecycle'
)

const errors = []
const warnings = []
const events = [] // {entry, payload}

for (const entry of workflowEntries) {
  const filePath = path.join(entry._dataDir, 'episodes', `${entry.id}.md`)
  if (!fs.existsSync(filePath)) {
    warnings.push(`episode:${entry.id}: file ${filePath} not found (orphaned index entry)`)
    continue
  }
  let payload
  try {
    payload = extractPayload(filePath)
  } catch (e) {
    errors.push(`episode:${entry.id}: ${e.message}`)
    continue
  }
  // Pre-filter: must be the same task + pattern
  if (payload.task !== task || payload.pattern_id !== patternId) continue
  validatePayload(payload, entry, errors, warnings, indexById)
  events.push({ entry, payload })
}

validateChain(events, errors, gate, head)

const presentEvents = new Set(events.map(e => e.payload.event))
const required = REQUIRED_FOR_GATE[gate] || []
const missing = required.filter(e => !presentEvents.has(e))

const valid = errors.length === 0 && missing.length === 0 && (!strict || warnings.length === 0)

const output = {
  status: 'ok',
  valid,
  gate,
  task,
  pattern_id: patternId,
  required,
  missing,
  errors,
  warnings,
  episodes: events.map(e => ({
    id: e.entry.id,
    event: e.payload.event,
    date: e.entry.date,
    time: e.entry.time,
    branch: e.payload.context && e.payload.context.branch,
    head: e.payload.context && e.payload.context.head
  }))
}

console.log(JSON.stringify(output))
process.exit(valid ? 0 : 1)
