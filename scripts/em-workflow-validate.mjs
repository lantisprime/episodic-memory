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

function fail(msg, code = 2) {
  console.log(JSON.stringify({ status: 'error', message: msg }))
  process.exit(code)
}

if (!task) fail('Missing --task')
if (!gate) fail(`Missing --gate. Must be one of: ${VALID_GATES.join(', ')}`)
if (!VALID_GATES.includes(gate)) fail(`Invalid --gate "${gate}". Must be one of: ${VALID_GATES.join(', ')}`)
if (!VALID_SCOPES.includes(scope)) fail(`Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES.join(', ')}`)

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

function validatePayload(payload, entry, errors, warnings) {
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
  // Branch / head mismatch is an error when a flag is explicitly passed
  // (a hook caller asserts a specific value). Stale-head warnings without
  // an explicit flag would be too strict for ad-hoc validator runs.
  if (branch && ctx.branch && ctx.branch !== branch) {
    errors.push(`${fp}: context.branch "${ctx.branch}" != requested "${branch}"`)
  }
  if (head && ctx.head && ctx.head !== head) {
    errors.push(`${fp}: context.head "${ctx.head}" != requested "${head}" (stale episode?)`)
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
      if (payload.second_opinion) {
        const so = payload.second_opinion
        if (!so.status || isPlaceholder(so.status)) errors.push(`${fp}: pre-checkpoint.second_opinion.status missing`)
        if (so.status === 'done' && isPlaceholder(so.reply_ref)) errors.push(`${fp}: pre-checkpoint.second_opinion.reply_ref required when status=done`)
      }
      break
    case 'review-done':
      if (isPlaceholder(payload.reply_ref) && isPlaceholder(payload.evidence_ref)) {
        errors.push(`${fp}: review-done requires reply_ref or evidence_ref (external witness)`)
      }
      break
    case 'post-checkpoint':
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
      break
    case 'push-allowed':
      if (isPlaceholder(payload.post_checkpoint_ref)) {
        errors.push(`${fp}: push-allowed requires post_checkpoint_ref pointing to the post-checkpoint episode`)
      }
      break
  }
}

// ---------------------------------------------------------------------------
// Approval-ref / post-checkpoint-ref continuity: pre-checkpoint must reference
// a plan-approved episode for the same task; push-allowed must reference a
// post-checkpoint episode for the same task. This is the chain integrity
// check that prevents replay of unrelated episodes.
// ---------------------------------------------------------------------------
function refTarget(ref) {
  if (typeof ref !== 'string') return null
  const m = ref.match(/^episode:(.+)$/)
  return m ? m[1].trim() : null
}

function validateChain(events, errors) {
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
      errors.push(`episode:${pre.entry.id}: approval_ref episode:${targetId} not found among plan-approved episodes for task`)
    }
  }
  // push-allowed.post_checkpoint_ref must point to a post-checkpoint episode
  for (const pa of (byEvent['push-allowed'] || [])) {
    const targetId = refTarget(pa.payload.post_checkpoint_ref)
    if (!targetId) {
      errors.push(`episode:${pa.entry.id}: post_checkpoint_ref not an episode reference`)
      continue
    }
    const matching = (byEvent['post-checkpoint'] || []).find(e => e.entry.id === targetId)
    if (!matching) {
      errors.push(`episode:${pa.entry.id}: post_checkpoint_ref episode:${targetId} not found among post-checkpoint episodes for task`)
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let allEntries = []
if (scope === 'local' || scope === 'all') allEntries.push(...loadIndex(LOCAL_DIR, 'local'))
if (scope === 'global' || scope === 'all') allEntries.push(...loadIndex(GLOBAL_DIR, 'global'))

// Dedupe (local takes priority, same as em-recall)
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
  validatePayload(payload, entry, errors, warnings)
  events.push({ entry, payload })
}

validateChain(events, errors)

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
