#!/usr/bin/env node
/**
 * em-review-request.mjs — Build and store a workflow.lifecycle review-request event.
 *
 * RFC-002 Phase 3b-H1 PR-D (#118). Wrapper that validates all required refs
 * (plan, approval, pre-checkpoint, post-checkpoint, tests, code review,
 * bug log, command inventory) before writing the review-request lifecycle
 * episode. Validation reuses the same exact-id resolver semantics as
 * em-workflow-validate.mjs (duplicated inline; pinned BYTE-EQUAL by the
 * drift test in tests/test-workflow-validate.mjs — D4 lifts to lib/ post-#119).
 *
 * Usage:
 *   node em-review-request.mjs
 *     --task <stable task id>
 *     --plan-ref <episode:id|file:path|url>
 *     --approval-ref <episode:id>          # → workflow.lifecycle plan-approved
 *     --pre-checkpoint-ref <episode:id>    # → workflow.lifecycle pre-checkpoint
 *     --post-checkpoint-ref <episode:id>   # → workflow.lifecycle post-checkpoint
 *     --tests-ref <episode:id|file:path>
 *     --code-review-ref <episode:id>
 *     [--bug-log-ref <issue-url>]+         # repeatable; XOR with --no-new-bugs
 *     [--no-new-bugs]                      # mutex with --bug-log-ref
 *     [--command-inventory-ref <ref>]      # required when classifier/gate touched
 *     [--triggered-by <episode:id>]
 *     [--head <sha>]                       # default: git rev-parse HEAD
 *     [--branch <name>]                    # default: git rev-parse --abbrev-ref HEAD
 *     [--worktree <abs path>]              # default: git rev-parse --show-toplevel
 *     [--project <name>]                   # default: project directory basename
 *     [--tags <t1,t2>]                     # additional tags beyond defaults
 *     [--scope inherit|local|global]       # default: inherit (from --post-checkpoint-ref)
 *     [--verifications-file <path>]        # JSON file with verifications[] array
 *     [--pattern-id <id>]                  # default: bp-001-implementation-workflow
 *     [--dry-run]                          # print payload, no write
 *
 * Exit codes:
 *   0 — review-request episode written (or dry-run printed)
 *   1 — validation failure (missing/inactive/wrong-category/cross-task ref)
 *   2 — usage error (missing required flag, malformed input, detached HEAD)
 *
 * Output: JSON to stdout. On success: { status: 'ok', id, file, scope, valid }.
 *         On failure:                  { status: 'error', message, errors[] }.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { nullProtoIndex, episodeTokens, updateTokensIndex } from './lib/relevance.mjs'
import { acquireStoreWriteLocksSync, releaseStoreWriteLocks, atomicReplaceFileSync } from './lib/store-write-lock.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const LOCAL_DIR = resolveLocalDir()

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-review-request.mjs', usage: 'node em-review-request.mjs --task <id> --plan-ref <ref> --approval-ref <ep> --pre-checkpoint-ref <ep> --post-checkpoint-ref <ep> --tests-ref <ref> --code-review-ref <ep> [--bug-log-ref <url>]... [--no-new-bugs] [--command-inventory-ref <ref>] [--triggered-by <ep>] [--head <sha>] [--branch <name>] [--worktree <path>] [--project <name>] [--tags <t1,t2>] [--scope inherit|local|global] [--verifications-file <path>] [--pattern-id <id>] [--dry-run]' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}
function flagAll(name) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) {
      const val = argv[i + 1]
      if (val.startsWith('--')) continue
      out.push(val)
      i++
    }
  }
  return out
}
function hasFlag(name) { return argv.includes(name) }

function fail(code, message, errors = []) {
  console.log(JSON.stringify({ status: 'error', message, errors }))
  process.exit(code)
}

const task = flag('--task')
const planRef = flag('--plan-ref')
const approvalRef = flag('--approval-ref')
const preCheckpointRef = flag('--pre-checkpoint-ref')
const postCheckpointRef = flag('--post-checkpoint-ref')
const testsRef = flag('--tests-ref')
const codeReviewRef = flag('--code-review-ref')
const bugLogRefs = flagAll('--bug-log-ref')
const noNewBugs = hasFlag('--no-new-bugs')
const commandInventoryRef = flag('--command-inventory-ref')
const triggeredBy = flag('--triggered-by')
const projectFlag = flag('--project')
const tagsRaw = flag('--tags')
const tagRepeats = flagAll('--tag')
const scope = flag('--scope') || 'inherit'
const dryRun = hasFlag('--dry-run')
const patternId = flag('--pattern-id') || 'bp-001-implementation-workflow'
const verificationsFile = flag('--verifications-file')

function gitOutput(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch { return null }
}

// Required flags check FIRST — fail fast on usage errors before any git work.
const required = {
  '--task': task,
  '--plan-ref': planRef,
  '--approval-ref': approvalRef,
  '--pre-checkpoint-ref': preCheckpointRef,
  '--post-checkpoint-ref': postCheckpointRef,
  '--tests-ref': testsRef,
  '--code-review-ref': codeReviewRef,
}
const missingFlags = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
if (missingFlags.length > 0) {
  fail(2, `Missing required flags: ${missingFlags.join(', ')}`)
}

// Now resolve git context. --head, --branch, --worktree can come from flags
// or git. Detached HEAD detection (folded gap #5; review M3 strengthening):
// `git symbolic-ref --short -q HEAD` succeeds iff HEAD points to a real ref
// (branch). Detached HEAD → exits non-zero. This avoids false-positive on the
// legitimate branch name "HEAD" (yes, git allows `git checkout -b HEAD`) and
// on brand-new repos where rev-parse --abbrev-ref returns "HEAD".
const headFlag = flag('--head') || gitOutput(['rev-parse', 'HEAD'])
const worktreeFlag = flag('--worktree') || gitOutput(['rev-parse', '--show-toplevel']) || process.cwd()
let branchFlag = flag('--branch')
if (!branchFlag) {
  branchFlag = gitOutput(['symbolic-ref', '--short', '-q', 'HEAD'])
}

if (!branchFlag) {
  fail(2, 'Detached HEAD or no symbolic ref detected (rebase / cherry-pick / detached checkout / fresh repo / not a git repo). Pass --branch <name> explicitly when running em-review-request in this state.')
}
if (!headFlag) {
  fail(2, 'Could not determine --head. Pass --head <sha> explicitly or run inside a git repository.')
}

// bug_log XOR no_new_bugs
if (!noNewBugs && bugLogRefs.length === 0) {
  fail(2, 'Must pass --bug-log-ref <issue-url> (one or more) OR --no-new-bugs.')
}
if (noNewBugs && bugLogRefs.length > 0) {
  fail(2, '--bug-log-ref and --no-new-bugs are mutually exclusive.')
}

// bug_log_ref shape (folded gap #9). Mirrors em-workflow-validate.mjs:421.
const ISSUE_REF_RE = /^(https:\/\/github\.com\/[^\/\s]+\/[^\/\s]+\/issues\/\d+|gh:[^\/\s]+\/[^\/\s#]+#\d+)$/
const malformedBugLogs = bugLogRefs.filter(r => !ISSUE_REF_RE.test(r))
if (malformedBugLogs.length > 0) {
  fail(2, `Malformed --bug-log-ref values (expected GitHub issue URL or gh:owner/repo#N): ${malformedBugLogs.join(', ')}`)
}

const VALID_SCOPES_REVIEW = ['inherit', 'local', 'global']
if (!VALID_SCOPES_REVIEW.includes(scope)) {
  fail(2, `Invalid --scope "${scope}". Must be one of: ${VALID_SCOPES_REVIEW.join(', ')}`)
}

// ---------------------------------------------------------------------------
// Duplicated resolver — pinned BYTE-EQUAL by drift test against
// em-workflow-validate.mjs. D4 (#150) lifts to scripts/lib/. Keep symbol set
// + behavior identical; do NOT add wrapper-specific extensions here.
// ---------------------------------------------------------------------------
const PLACEHOLDER_VALUES = new Set(['', 'tbd', 'todo', 'placeholder', '...', 'xxx', 'n/a', 'na'])
const REF_PREFIXES = ['episode:', 'issue:', 'file:', 'command:', 'log:', 'sha:']
const SELF_REFS = new Set(['episode:self', 'self'])

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

function refTarget(ref) {
  if (typeof ref !== 'string') return null
  const m = ref.match(/^episode:(.+)$/)
  return m ? m[1].trim() : null
}

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

// Load BOTH scopes regardless of --scope (folded gap #4 — wrapper-validator
// scope parity contract; mirrors em-workflow-validate.mjs:489-495).
const localEntries = loadIndex(LOCAL_DIR, 'local')
const globalEntries = loadIndex(GLOBAL_DIR, 'global')
const indexById = new Map()
for (const e of globalEntries) indexById.set(e.id, e)
for (const e of localEntries) indexById.set(e.id, e) // local wins

// Build the citing episode shape upfront so resolveEpisodeRef can compare
// timestamps and reject self-witness against the about-to-be-written id.
const now = new Date()
const dateStr = now.toISOString().slice(0, 10)
const timeStr = now.toISOString().slice(11, 16)
const ts = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/(\d{8})(\d{6})/, '$1-$2')
const summarySlug = `review-request-${task}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const randSuffix = crypto.randomBytes(2).toString('hex')
const id = `${ts}-${summarySlug}-${randSuffix}`
const currentEpisode = { id, date: dateStr, time: timeStr }

function resolveEpisodeRef(ref, opts = {}) {
  const tid = refTarget(ref)
  if (!tid) return { error: `not an episode reference (expected episode:<id>): "${ref}"` }
  if (tid === currentEpisode.id) {
    return { error: `episode:${tid} self-witness: ref points to its own episode id` }
  }
  const entry = indexById.get(tid)
  if (!entry) return { error: `episode:${tid} not found (checked local + global)` }
  if (entry.status === 'superseded') return { error: `episode:${tid} is superseded` }
  if (entry.status && entry.status !== 'active') {
    return { error: `episode:${tid} is not active (status=${entry.status})` }
  }
  const refTime = `${entry.date} ${entry.time}`
  const curTime = `${currentEpisode.date} ${currentEpisode.time}`
  if (refTime > curTime) {
    return { error: `episode:${tid} timestamp ${refTime} is after citing episode ${curTime} (chain must be temporally ordered)` }
  }
  if (opts.expectedCategory && entry.category !== opts.expectedCategory) {
    return { error: `episode:${tid} category "${entry.category}" != expected "${opts.expectedCategory}"` }
  }
  return { entry }
}

// ---------------------------------------------------------------------------
// Validate refs (pre-write, exit 1 on failure)
// ---------------------------------------------------------------------------
const errors = []
function checkRef(label, value, opts = {}) {
  if (!value) return null
  if (isPlaceholder(value)) {
    errors.push(`${label}: placeholder value "${value}" rejected`)
    return null
  }
  if (typeof value === 'string' && value.startsWith('episode:')) {
    const r = resolveEpisodeRef(value, opts)
    if (r.error) {
      errors.push(`${label}: ${r.error}`)
      return null
    }
    return r.entry
  }
  // Non-episode refs (file:, log:, URLs) pass through; validator checks shape.
  return null
}

// Chain-ref check (Codex PR #156 review F1 splice-resistance):
// approval_ref + pre_checkpoint_ref + post_checkpoint_ref MUST each be
// episode-shaped, resolve to workflow.lifecycle, AND have body event ===
// expected event AND body task === current task. Reject any of:
// - non-episode shape (file:, url, etc.)
// - placeholder
// - wrong category
// - wrong event type
// - cross-task
function checkChainRef(label, value, expectedEvent) {
  if (!value) return null
  if (isPlaceholder(value)) {
    errors.push(`${label}: placeholder value "${value}" rejected`)
    return null
  }
  if (typeof value !== 'string' || !value.startsWith('episode:')) {
    errors.push(`${label}: "${value}" must be an episode reference (episode:<id>); chain refs cannot be file/URL/other shapes`)
    return null
  }
  const r = resolveEpisodeRef(value, { expectedCategory: 'workflow.lifecycle' })
  if (r.error) {
    errors.push(`${label}: ${r.error}`)
    return null
  }
  // Body inspection — verify event type AND task match. Chain refs are
  // same-task by definition (Codex PR #156 round-2 P2): missing/null task
  // in the referenced body is a REJECTION, not provenance-only. Same for
  // missing file on disk: indexed-but-orphaned cannot be verified, so
  // reject. (Distinct from triggered_by, where missing task IS legitimate
  // provenance-only — that path uses checkRef + a separate body-parse.)
  const filePath = path.join(r.entry._dataDir, 'episodes', `${r.entry.id}.md`)
  if (!fs.existsSync(filePath)) {
    errors.push(`${label}: episode:${r.entry.id} indexed but file missing at ${filePath}; cannot verify event/task for chain link`)
    return null
  }
  const text = fs.readFileSync(filePath, 'utf8')
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/)
  if (!m) {
    errors.push(`${label}: episode:${r.entry.id} body has no \`\`\`json fenced block; cannot verify event/task for chain link`)
    return null
  }
  let p
  try {
    p = JSON.parse(m[1])
  } catch (e) {
    errors.push(`${label}: episode:${r.entry.id} body JSON parse failed (${e.message})`)
    return null
  }
  if (p.event !== expectedEvent) {
    errors.push(`${label}: episode:${r.entry.id} has event "${p.event}" but expected "${expectedEvent}" for this chain link`)
  }
  // Strict equality: chain refs MUST share task. null/undefined/mismatch all rejected.
  if (p.task !== task) {
    const got = p.task === undefined ? '<undefined>' : (p.task === null ? '<null>' : `"${p.task}"`)
    errors.push(`${label}: episode:${r.entry.id} has task ${got} but expected "${task}" (chain links must share task exactly; cross-task splice and missing-task rejected)`)
  }
  return r.entry
}

const approvalEntry = checkChainRef('--approval-ref', approvalRef, 'plan-approved')
const preCheckpointEntry = checkChainRef('--pre-checkpoint-ref', preCheckpointRef, 'pre-checkpoint')
const postCheckpointEntry = checkChainRef('--post-checkpoint-ref', postCheckpointRef, 'post-checkpoint')
checkRef('--plan-ref', planRef)
checkRef('--tests-ref', testsRef)
checkRef('--code-review-ref', codeReviewRef)
checkRef('--command-inventory-ref', commandInventoryRef)

// triggered_by: optional, MUST be episode-shaped (review n1 tightening).
// Freeform provenance strings rejected — em-store the source as an episode
// first, then pass episode:<id>.
let triggeredByEntry = null
if (triggeredBy) {
  if (typeof triggeredBy !== 'string' || !triggeredBy.startsWith('episode:')) {
    errors.push(`--triggered-by "${triggeredBy}" must be an episode reference (episode:<id>); freeform provenance strings rejected`)
  } else {
    triggeredByEntry = checkRef('--triggered-by', triggeredBy)
  }
  if (triggeredByEntry) {
    // Read body to extract task field. Non-lifecycle episodes have no task in
    // body → null/undefined → provenance-only (no task assertion).
    const filePath = path.join(triggeredByEntry._dataDir, 'episodes', `${triggeredByEntry.id}.md`)
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8')
      const m = text.match(/```json\s*\n([\s\S]*?)\n```/)
      if (m) {
        try {
          const p = JSON.parse(m[1])
          if (p.task != null && p.task !== task) {
            errors.push(`--triggered-by: episode:${triggeredByEntry.id} has task "${p.task}" which differs from current task "${task}" (cross-task pollution rejected)`)
          }
          // task null/undefined: provenance-only.
        } catch {
          // Body has json fenced block but parse failed; treat as provenance-only.
        }
      }
    }
  }
}

// Verifications file (optional). Validator does the schema check; wrapper
// just confirms it parses as an array.
let verifications = null
if (verificationsFile) {
  if (!fs.existsSync(verificationsFile)) {
    fail(2, `--verifications-file path does not exist: ${verificationsFile}`)
  }
  try {
    const raw = fs.readFileSync(verificationsFile, 'utf8')
    verifications = JSON.parse(raw)
    if (!Array.isArray(verifications)) {
      fail(2, `--verifications-file must contain a JSON array, got ${typeof verifications}`)
    }
  } catch (e) {
    fail(2, `Failed to parse --verifications-file: ${e.message}`)
  }
}

if (errors.length > 0) {
  console.log(JSON.stringify({ status: 'error', message: 'Ref validation failed', errors }))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Resolve scope (inherit ↦ post-checkpoint-ref's source)
// ---------------------------------------------------------------------------
let resolvedScope
if (scope === 'inherit') {
  resolvedScope = postCheckpointEntry ? postCheckpointEntry._source : 'local'
} else {
  resolvedScope = scope
}
const dataDir = resolvedScope === 'global' ? GLOBAL_DIR : LOCAL_DIR
const episodesDir = path.join(dataDir, 'episodes')
const indexFile = path.join(dataDir, 'index.jsonl')

// ---------------------------------------------------------------------------
// Build payload (top-level triggered_by per Plan-agent Q4 verdict; not under evidence)
// ---------------------------------------------------------------------------
const payload = {
  event: 'review-request',
  pattern_id: patternId,
  task,
  context: { worktree: worktreeFlag, branch: branchFlag, head: headFlag },
  plan_ref: planRef,
  approval_ref: approvalRef,
  pre_checkpoint_ref: preCheckpointRef,
  post_checkpoint_ref: postCheckpointRef,
  evidence: {
    tests_ref: testsRef,
    code_review_ref: codeReviewRef,
    bug_logging: noNewBugs
      ? { status: 'no-new-bugs' }
      : { status: 'done', issues: bugLogRefs },
  },
}
if (commandInventoryRef) payload.evidence.command_inventory_ref = commandInventoryRef
if (verifications) payload.evidence.verifications = verifications
if (triggeredBy) payload.triggered_by = triggeredBy

if (dryRun) {
  console.log(JSON.stringify({ status: 'ok', dry_run: true, payload, scope: resolvedScope }))
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Write episode (mirrors em-store.mjs primitives)
// ---------------------------------------------------------------------------
const project = projectFlag || path.basename(process.cwd())
const inputTags = [...(tagsRaw ? tagsRaw.split(',') : []), ...tagRepeats].map(t => t.trim().toLowerCase()).filter(Boolean)
const baseTags = ['workflow.lifecycle', 'review-request', `task:${task.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`]
const tags = [...new Set([...baseTags, ...inputTags])].sort()

const summary = `review-request: ${task} @ ${headFlag.slice(0, 7)}`
const fmLines = [
  '---',
  `id: ${id}`,
  `date: ${dateStr}`,
  `time: "${timeStr}"`,
  `project: ${project}`,
  `category: workflow.lifecycle`,
  `status: active`,
  `tags: [${tags.join(', ')}]`,
  `summary: ${summary}`,
  '---',
]
const frontmatter = fmLines.join('\n')
const bodyJson = JSON.stringify(payload, null, 2)
const episodeContent = `${frontmatter}\n\n# ${summary}\n\nReview-request lifecycle event for task **${task}** at HEAD ${headFlag}.\n\n\`\`\`json\n${bodyJson}\n\`\`\`\n`

const filePath = path.join(episodesDir, `${id}.md`)

function updateTagsIndex(dir, episodeId, tagList) {
  const tagsFile = path.join(dir, 'tags.json')
  // Null-proto: a tag named "constructor" must not resolve to Object.prototype (issue #469)
  let idx = Object.create(null)
  try { idx = nullProtoIndex(JSON.parse(fs.readFileSync(tagsFile, 'utf8'))) } catch {}
  for (const t of tagList) {
    if (!idx[t]) idx[t] = []
    if (!idx[t].includes(episodeId)) idx[t].push(episodeId)
  }
  atomicReplaceFileSync(tagsFile, JSON.stringify(idx, null, 2))
}

function updateCategoryIndex(dir, episodeId, category) {
  const categoryFile = path.join(dir, 'category-index.json')
  let idx = Object.create(null)
  try { idx = nullProtoIndex(JSON.parse(fs.readFileSync(categoryFile, 'utf8'))) } catch {}
  if (!idx[category]) idx[category] = []
  if (!idx[category].includes(episodeId)) idx[category].push(episodeId)
  atomicReplaceFileSync(categoryFile, JSON.stringify(idx, null, 2))
}

const lockResult = acquireStoreWriteLocksSync(dataDir)
if (!lockResult.ok) {
  console.log(JSON.stringify({ status: 'error', message: `em-review-request: ${lockResult.code}`, errors: [], code: lockResult.code, heldBy: lockResult.heldBy }))
  process.exit(1)
}

try {
  // The generated ID participated in pre-write self-reference validation.
  // Re-read both collision surfaces under lock rather than silently
  // overwriting an episode or duplicating its index row.
  let idInIndex = false
  if (fs.existsSync(indexFile)) {
    for (const line of fs.readFileSync(indexFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        if (JSON.parse(line).id === id) { idInIndex = true; break }
      } catch {}
    }
  }
  if (idInIndex || fs.existsSync(filePath)) {
    console.log(JSON.stringify({ status: 'error', message: `Generated episode id collision: ${id}`, errors: [], code: 'episode-id-collision' }))
    process.exitCode = 1
  } else {
    fs.mkdirSync(episodesDir, { recursive: true })
    atomicReplaceFileSync(filePath, episodeContent)

    // Index entry: clean serialization. _source / _dataDir are load-time
    // decorations added by loadIndex (review n3 — explicit so future readers
    // don't "fix" the apparent omission).
    const indexEntry = JSON.stringify({
      id, date: dateStr, time: timeStr, project,
      category: 'workflow.lifecycle', status: 'active', supersedes: null, tags, summary,
    })
    fs.appendFileSync(indexFile, indexEntry + '\n', 'utf8')
    updateTagsIndex(dataDir, id, tags)
    updateCategoryIndex(dataDir, id, 'workflow.lifecycle')
    updateTokensIndex(dataDir, id, episodeTokens({ summary, tags, body: episodeContent }))
  }
} finally {
  releaseStoreWriteLocks(lockResult.handles)
}

if (process.exitCode) process.exit(process.exitCode)

console.log(JSON.stringify({ status: 'ok', id, file: filePath, scope: resolvedScope, valid: true }))
process.exit(0)
