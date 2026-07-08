#!/usr/bin/env node
/**
 * em-capture.mjs — session auto-capture: draft candidate episodes from a
 * session transcript; confirm them into the store later (wave-6 #2,
 * docs/plans/PLAN-session-auto-capture.md).
 *
 * Memory only works if things get stored, and storing depends on agent
 * discipline. This script drafts candidates automatically at session end;
 * the next session (or the user) confirms them. Drafts are NEVER silently
 * promoted to episodes — confirm-before-store is the design invariant.
 *
 * Usage:
 *   node em-capture.mjs extract [--transcript <path>] [--session-id <id>]
 *                               [--project <name>] [--mode heuristic|cmd]
 *                               [--cmd "<command>"] [--max <n>] [--dry-run]
 *   node em-capture.mjs list
 *   node em-capture.mjs review --draft <id> (--accept <n,...> | --accept-all |
 *                               --reject <n,...> | --discard) [--scope local|global]
 *
 * Drafts live at ~/.episodic-memory/drafts/<draft-id>.json. They are NOT
 * episodes: no index.jsonl rows, invisible to search/recall ranking (em-recall
 * surfaces only a pending_drafts count). `review --accept` writes through
 * em-store.mjs as a subprocess — never hand-written episode files — so
 * category validation, tags and token indexing all apply.
 *
 * extract modes:
 *   heuristic (default, zero-LLM) — signal scan over the transcript:
 *     explicit markers ("remember this", "lesson:", ...), decision language
 *     in assistant text, error→fix command pairs, merged-PR milestones.
 *     Fenced code blocks and inline backticks are stripped before matching
 *     (fabricated-signal guard, same rule as em-graph body citations).
 *   cmd (opt-in LLM) — pipe {session_id, project, chunks} JSON to a user
 *     command (same protocol family as em-embed --cmd / claude-rerank.sh);
 *     expect {candidates:[...]} back. Ship template:
 *     examples/capturers/claude-capture.sh. Persisted default via
 *     ~/.episodic-memory/capture-config.json {enabled, mode, cmd, max}.
 *
 * Zero deps; Node stdlib only. One JSON object to stdout.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listTranscripts, walkTranscripts } from './lib/transcript-walker.mjs'
import { validateCategory } from './lib/categories.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const DRAFTS_DIR = path.join(GLOBAL_DIR, 'drafts')
const CONFIG_PATH = path.join(GLOBAL_DIR, 'capture-config.json')

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  console.log(JSON.stringify({ status: 'help', script: 'em-capture.mjs', usage: 'node em-capture.mjs (extract [--transcript <path>] [--session-id <id>] [--project <name>] [--mode heuristic|cmd] [--cmd <command>] [--max <n>] [--dry-run] | list | review --draft <id> (--accept <n,...> | --accept-all | --reject <n,...> | --discard) [--scope local|global]) — draft candidate episodes from session transcripts; confirm-before-store (wave-6 #2)' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}
function fail(message, code = 1) {
  console.log(JSON.stringify({ status: 'error', message }))
  process.exit(code)
}

const mode = argv[0]
if (!['extract', 'list', 'review'].includes(mode)) {
  fail(`Unknown command "${mode}". Expected: extract | list | review (see --help).`, 2)
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

// ---------------------------------------------------------------------------
// Shared: fabricated-signal guard. Signals must never fire on text inside
// fenced code blocks or inline backticks (an example "lesson:" in a code
// sample is not a lesson). Same stripping rule as em-graph bodyCitations.
// ---------------------------------------------------------------------------
function stripCode(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

function excerpt(text, idx, len = 200) {
  const lineStart = text.lastIndexOf('\n', idx) + 1
  const tail = text.slice(idx)
  const sentEnd = tail.search(/[.!?\n]/)
  const end = sentEnd === -1 ? Math.min(text.length, idx + len) : idx + sentEnd + 1
  return text.slice(lineStart, end).trim().slice(0, len)
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

// Marker → category constants (single-string values only; a hardcoded
// category ARRAY would violate the categories-lib CI guard).
const CAT_LESSON = 'lesson'
const CAT_DECISION = 'decision'
const CAT_DISCOVERY = 'discovery'
const CAT_MILESTONE = 'milestone'

const USER_MARKERS = [
  { re: /\b(remember this|save this|note that)\b/i, category: CAT_DISCOVERY },
  { re: /\blesson:/i, category: CAT_LESSON },
  { re: /\bdecision:/i, category: CAT_DECISION },
]
const ASSISTANT_DECISION_RE = /\b(decided to|chose \S+ over|going with)\b/i
const MILESTONE_RE = /\bPR #\d+[^\n]*\bmerged\b/i

function heuristicCandidates(records, maxCandidates) {
  const out = []
  const seen = new Set()
  const push = (c) => {
    const key = `${c.category}:${c.summary.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  // Error→fix tracking: same Bash command failing then later succeeding.
  const cmdOutcomes = new Map() // command -> { failed: boolean }
  let lastCommand = null

  for (const rec of records) {
    if (rec.role === 'user' && rec.text) {
      const clean = stripCode(rec.text)
      for (const m of USER_MARKERS) {
        const hit = m.re.exec(clean)
        if (hit) {
          const ev = excerpt(clean, hit.index)
          push({
            category: m.category,
            summary: ev.slice(0, 120),
            body: ev,
            tags: ['auto-captured'],
            confidence: 0.9,
            evidence_excerpt: ev,
            signal: 'user-marker',
          })
        }
      }
    }
    if (rec.role === 'assistant' && rec.text) {
      const clean = stripCode(rec.text)
      const dHit = ASSISTANT_DECISION_RE.exec(clean)
      if (dHit) {
        const ev = excerpt(clean, dHit.index)
        push({
          category: CAT_DECISION,
          summary: ev.slice(0, 120),
          body: ev,
          tags: ['auto-captured'],
          confidence: 0.6,
          evidence_excerpt: ev,
          signal: 'assistant-decision',
        })
      }
      const mHit = MILESTONE_RE.exec(clean)
      if (mHit) {
        const ev = excerpt(clean, mHit.index)
        push({
          category: CAT_MILESTONE,
          summary: ev.slice(0, 120),
          body: ev,
          tags: ['auto-captured'],
          confidence: 0.7,
          evidence_excerpt: ev,
          signal: 'milestone',
        })
      }
    }
    // Error→fix pairs: a Bash command whose tool_result errored, later rerun
    // (same command string) with a clean result. Transcript order is
    // tool_use → its tool_result, so a single lastCommand cursor pairs them.
    if (rec.role === 'tool_use' && rec.toolName === 'Bash') {
      const blocks = rec.raw?.message?.content
      const tu = Array.isArray(blocks) ? blocks.find((b) => b && b.type === 'tool_use') : null
      const command = tu?.input?.command
      lastCommand = typeof command === 'string' && command.trim() ? command.trim() : null
    }
    if (rec.role === 'tool_result' && lastCommand) {
      const blocks = rec.raw?.message?.content
      const tr = Array.isArray(blocks) ? blocks.find((b) => b && b.type === 'tool_result') : null
      if (tr) {
        const prior = cmdOutcomes.get(lastCommand)
        if (tr.is_error === true) {
          cmdOutcomes.set(lastCommand, { failed: true })
        } else if (prior && prior.failed) {
          cmdOutcomes.set(lastCommand, { failed: false })
          const ev = `Command failed then passed on rerun: ${lastCommand.slice(0, 160)}`
          push({
            category: CAT_DISCOVERY,
            summary: ev.slice(0, 120),
            body: ev,
            tags: ['auto-captured', 'error-fix'],
            confidence: 0.5,
            evidence_excerpt: ev,
            signal: 'error-fix',
          })
        }
        lastCommand = null
      }
    }
  }
  return out
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxCandidates)
}

function cmdCandidates(records, command, sessionId, project, maxCandidates) {
  const chunks = records
    .filter((r) => (r.role === 'user' || r.role === 'assistant') && r.text)
    .map((r) => ({ role: r.role, text: r.text.slice(0, 4000) }))
  const payload = JSON.stringify({ session_id: sessionId, project, max: maxCandidates, chunks })
  const r = spawnSync(command, { shell: true, input: payload, encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0) {
    fail(`capture cmd exited ${r.status}: ${(r.stderr || '').slice(0, 300)}`)
  }
  let parsed
  try { parsed = JSON.parse(r.stdout.trim()) } catch {
    fail(`capture cmd did not return JSON: ${(r.stdout || '').slice(0, 200)}`)
  }
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : null
  if (!rawCandidates) fail('capture cmd JSON lacks a candidates[] array')
  const out = []
  for (const c of rawCandidates.slice(0, maxCandidates)) {
    if (!c || typeof c !== 'object') fail('capture cmd returned a non-object candidate')
    const v = validateCategory(String(c.category || ''))
    if (!v.ok) fail(`capture cmd candidate category "${c.category}" invalid: ${v.reason}`)
    if (typeof c.summary !== 'string' || !c.summary.trim()) fail('capture cmd candidate missing summary')
    out.push({
      category: v.name,
      summary: c.summary.slice(0, 200),
      body: typeof c.body === 'string' && c.body.trim() ? c.body : c.summary,
      tags: ['auto-captured', ...(Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === 'string') : [])],
      confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
      evidence_excerpt: typeof c.evidence_excerpt === 'string' ? c.evidence_excerpt.slice(0, 300) : c.summary.slice(0, 300),
      signal: 'cmd',
    })
  }
  return out
}

async function collectRecords({ transcriptPath, sessionId }) {
  const records = []
  if (transcriptPath) {
    // Single-file walk: reuse the walker's normalization by narrowing the
    // listTranscripts result via a synthetic walk over just this file.
    if (!fs.existsSync(transcriptPath)) fail(`Transcript not found: ${transcriptPath}`)
    const sid = path.basename(transcriptPath).replace(/\.jsonl$/, '')
    for await (const rec of walkTranscripts({})) {
      if (rec.file === path.resolve(transcriptPath) || rec.file === transcriptPath) records.push(rec)
    }
    if (!records.length) {
      // The file may live outside ~/.claude/projects — parse it directly with
      // the same record shapes via a local fallback walk.
      const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        let rec
        try { rec = JSON.parse(line) } catch { continue }
        const role = rec.type === 'user' ? 'user' : rec.type === 'assistant' ? 'assistant' : 'skip'
        if (role === 'skip') continue
        const msg = rec.message
        let text = ''
        if (typeof msg?.content === 'string') text = msg.content
        else if (Array.isArray(msg?.content)) {
          text = msg.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
        }
        records.push({ sessionId: sid, slug: null, file: transcriptPath, ts: rec.timestamp || null, role, toolName: null, text, raw: rec })
      }
    }
    return records
  }
  if (sessionId) {
    const all = listTranscripts({})
    const match = all.find((t) => t.sessionId === sessionId)
    if (!match) fail(`No transcript found for session ${sessionId} under ~/.claude/projects`)
    for await (const rec of walkTranscripts({ slugFilter: match.slug })) {
      if (rec.sessionId === sessionId) records.push(rec)
    }
    return records
  }
  fail('extract requires --transcript <path> or --session-id <id>', 2)
}

function newDraftId(project) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const slug = String(project || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'session'
  return `${stamp}-draft-${slug}-${crypto.randomBytes(2).toString('hex')}`
}

async function runExtract() {
  const cfg = loadConfig()
  const transcriptPath = flag('--transcript')
  const sessionId = flag('--session-id')
  const project = flag('--project') || path.basename(process.cwd())
  const extractMode = flag('--mode') || cfg.mode || 'heuristic'
  const command = flag('--cmd') || cfg.cmd
  const maxRaw = flag('--max') || String(cfg.max || 5)
  const dryRun = argv.includes('--dry-run')
  if (!['heuristic', 'cmd'].includes(extractMode)) fail(`Invalid --mode "${extractMode}". Expected heuristic|cmd.`, 2)
  if (!/^\d+$/.test(maxRaw) || parseInt(maxRaw, 10) < 1) fail(`Invalid --max "${maxRaw}": expected an integer >= 1.`, 2)
  const maxCandidates = parseInt(maxRaw, 10)
  if (extractMode === 'cmd' && !command) fail('--mode cmd requires --cmd <command> (or capture-config.json cmd).', 2)

  const records = await collectRecords({ transcriptPath, sessionId })
  const sid = sessionId || (records[0] ? records[0].sessionId : null)
  const cwd = [...records].reverse().find((r) => r.raw?.cwd)?.raw?.cwd || null

  const candidates = extractMode === 'cmd'
    ? cmdCandidates(records, command, sid, project, maxCandidates)
    : heuristicCandidates(records, maxCandidates)

  const draft = {
    id: newDraftId(project),
    session_id: sid,
    project,
    ts: new Date().toISOString(),
    source: transcriptPath || (records[0] ? records[0].file : null),
    cwd,
    mode: extractMode,
    candidates: candidates.map((c, i) => ({ n: i + 1, status: 'pending', ...c })),
  }

  if (dryRun) {
    console.log(JSON.stringify({ status: 'ok', dry_run: true, draft }))
    return
  }
  if (!candidates.length) {
    console.log(JSON.stringify({ status: 'ok', draft: null, candidates: 0, message: 'No candidates found; nothing drafted.' }))
    return
  }
  fs.mkdirSync(DRAFTS_DIR, { recursive: true })
  const file = path.join(DRAFTS_DIR, `${draft.id}.json`)
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(draft, null, 2))
  fs.renameSync(tmp, file)
  console.log(JSON.stringify({ status: 'ok', draft: draft.id, candidates: candidates.length, file, review: `node ${path.join(SCRIPT_DIR, 'em-capture.mjs')} review --draft ${draft.id} --accept-all` }))
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
function runList() {
  let files = []
  try { files = fs.readdirSync(DRAFTS_DIR).filter((f) => f.endsWith('.json')) } catch { /* no drafts dir yet */ }
  const drafts = []
  for (const f of files.sort()) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'))
      drafts.push({
        id: d.id,
        project: d.project,
        session_id: d.session_id,
        ts: d.ts,
        pending: d.candidates.filter((c) => c.status === 'pending').length,
        accepted: d.candidates.filter((c) => c.status === 'accepted').length,
        rejected: d.candidates.filter((c) => c.status === 'rejected').length,
        summaries: d.candidates.map((c) => `[${c.n}:${c.status}] ${c.category}: ${c.summary.slice(0, 80)}`),
      })
    } catch { /* skip malformed draft */ }
  }
  console.log(JSON.stringify({ status: 'ok', count: drafts.length, drafts }))
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------
function runReview() {
  const draftId = flag('--draft')
  if (!draftId) fail('review requires --draft <id>', 2)

  // Usage validation BEFORE existence: a malformed invocation is exit 2
  // regardless of whether the draft happens to exist.
  const acceptAll = argv.includes('--accept-all')
  const discard = argv.includes('--discard')
  const acceptRaw = flag('--accept')
  const rejectRaw = flag('--reject')
  const actions = [acceptAll, discard, acceptRaw !== undefined, rejectRaw !== undefined].filter(Boolean)
  if (actions.length !== 1) fail('review requires exactly one of --accept <n,...> | --accept-all | --reject <n,...> | --discard', 2)

  const file = path.join(DRAFTS_DIR, `${draftId}.json`)
  if (!fs.existsSync(file)) fail(`Draft not found: ${draftId}`)
  const draft = JSON.parse(fs.readFileSync(file, 'utf8'))

  if (discard) {
    fs.unlinkSync(file)
    console.log(JSON.stringify({ status: 'ok', draft: draftId, discarded: true }))
    return
  }

  const parseNs = (raw) => {
    const ns = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (!ns.length || ns.some((n) => !/^\d+$/.test(n))) fail(`Invalid candidate list "${raw}": expected comma-separated numbers.`, 2)
    return ns.map((n) => parseInt(n, 10))
  }

  if (rejectRaw !== undefined) {
    const ns = parseNs(rejectRaw)
    for (const n of ns) {
      const c = draft.candidates.find((x) => x.n === n)
      if (!c) fail(`Draft ${draftId} has no candidate ${n}`)
      if (c.status === 'pending') c.status = 'rejected'
    }
    finishReview(draft, file, { rejected: ns })
    return
  }

  const scope = flag('--scope') || 'global'
  if (!['local', 'global'].includes(scope)) fail(`Invalid --scope "${scope}". Must be local or global.`, 2)
  const ns = acceptAll
    ? draft.candidates.filter((c) => c.status === 'pending').map((c) => c.n)
    : parseNs(acceptRaw)

  const emStore = path.join(SCRIPT_DIR, 'em-store.mjs')
  const storeCwd = scope === 'local'
    ? (draft.cwd && fs.existsSync(draft.cwd) ? draft.cwd : null)
    : process.cwd()
  if (scope === 'local' && !storeCwd) {
    fail(`--scope local requires the draft's source cwd (${draft.cwd || 'unknown'}) to exist; run from that project or accept to global.`)
  }

  const accepted = []
  for (const n of ns) {
    const c = draft.candidates.find((x) => x.n === n)
    if (!c) fail(`Draft ${draftId} has no candidate ${n}`)
    if (c.status !== 'pending') continue
    const tags = [...new Set(['auto-captured', ...(c.tags || [])])]
    const args = [emStore,
      '--project', draft.project,
      '--category', c.category,
      '--summary', c.summary,
      '--body', `${c.body}\n\nAuto-captured from session ${draft.session_id || '(unknown)'} (draft ${draft.id}, signal: ${c.signal || 'n/a'}).`,
      '--tags', tags.join(','),
      '--scope', scope,
    ]
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: storeCwd, timeout: 60000 })
    let json = null
    try { json = JSON.parse(r.stdout.trim()) } catch { /* handled below */ }
    if (r.status !== 0 || !json || json.status !== 'ok') {
      fail(`em-store failed for candidate ${n} (exit ${r.status}): ${(r.stdout || r.stderr || '').slice(0, 300)}`)
    }
    c.status = 'accepted'
    c.episode_id = json.id
    accepted.push({ n, episode_id: json.id })
  }
  finishReview(draft, file, { accepted })
}

function finishReview(draft, file, resultFields) {
  const pending = draft.candidates.filter((c) => c.status === 'pending').length
  if (pending === 0) {
    fs.unlinkSync(file)
  } else {
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(draft, null, 2))
    fs.renameSync(tmp, file)
  }
  console.log(JSON.stringify({ status: 'ok', draft: draft.id, ...resultFields, pending_remaining: pending, draft_file: pending === 0 ? null : file }))
}

// ---------------------------------------------------------------------------
if (mode === 'extract') await runExtract()
else if (mode === 'list') runList()
else runReview()
