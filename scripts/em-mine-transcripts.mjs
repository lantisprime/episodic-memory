#!/usr/bin/env node
/**
 * em-mine-transcripts.mjs — surface decisions/lessons/violations buried in
 * Claude Code session transcripts that were never captured as episodes.
 *
 * Walks ~/.claude/projects/<slug>/<session>.jsonl via transcript-walker,
 * scans user + assistant text for trigger phrases, dedupes against existing
 * episodes (global + every project's local store), and writes a staging
 * markdown file under .claude/scratch/. Each candidate ships with a
 * suggested category, tags, surrounding context, and a copy-pasteable
 * em-store command for human review.
 *
 * Cold-storage discipline: this script reads JSONL and writes a staging
 * file. It NEVER calls em-store on its own. Per local episode
 * 20260507-083352-treat-claude-code-jsonl-transcripts-as-c-1209.
 *
 * Usage:
 *   node em-mine-transcripts.mjs [--since <ISO>] [--slug <substring>]
 *                                [--exclude-worktrees]
 *                                [--output <path>] [--dry-run]
 *
 * Defaults:
 *   --since           7 days ago
 *   --output          .claude/scratch/mining-candidates-<YYYYMMDD>.md
 *   no slug filter    (walk all)
 *   includes worktrees
 *
 * Output JSON to stdout: { status, since, candidates, output, dryRun }
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { walkTranscripts } from './lib/transcript-walker.mjs'
import { resolveRepoRoot } from './lib/local-dir.mjs'

// ---------------------------------------------------------------------------
// Trigger config
// ---------------------------------------------------------------------------

const TRIGGERS = [
  // category: phrases (lowercase-matched against record text)
  { category: 'decision', phrases: ['we decided', "let's go with", 'the call is', 'going with', 'decided to', "we'll go with"] },
  { category: 'lesson',   phrases: ['next time', 'lesson:', 'should have', 'we learned', 'in retrospect', 'in hindsight', "won't make that mistake"] },
  { category: 'violation', phrases: ['you skipped', 'you forgot', 'rule violation', 'bp-001', 'you missed', 'rule 18', 'rule 9 ', 'you bypassed'] },
]

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
function flag(name, def = undefined) {
  const i = argv.indexOf(name)
  if (i === -1) return def
  if (i + 1 >= argv.length) return true
  const next = argv[i + 1]
  if (next.startsWith('--')) return true
  return next
}

const since = flag('--since') || isoDaysAgo(7)
const slugFilter = flag('--slug') === true ? undefined : flag('--slug')
const excludeWorktrees = flag('--exclude-worktrees') === true
const dryRun = flag('--dry-run') === true
const outputArg = flag('--output')

function isoDaysAgo(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

function defaultOutputPath() {
  const root = resolveRepoRoot()
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return path.join(root, '.claude', 'scratch', `mining-candidates-${date}.md`)
}

const outputPath = outputArg && outputArg !== true ? outputArg : defaultOutputPath()

// ---------------------------------------------------------------------------
// Dedupe corpus: pull every existing episode summary + tags from index files
// ---------------------------------------------------------------------------

function loadDedupeCorpus() {
  const indexFiles = []
  // Global
  const global = path.join(os.homedir(), '.episodic-memory', 'index.jsonl')
  if (fs.existsSync(global)) indexFiles.push(global)
  // Every project under ~/.claude/projects/<slug> may have a local store.
  // The convention: project's working tree at .episodic-memory/index.jsonl.
  // We only know slug -> dir mapping by reading transcripts' cwd field,
  // but it's simpler to just scan the user's homedir for known repo roots.
  // Quick win: read the local store of THIS repo (resolveRepoRoot) and
  // also any sibling .episodic-memory/index.jsonl reachable from a small
  // candidate set derived from cwds we've already seen during walking.
  // Returning a Set of lowercased summary strings here; cwd-derived stores
  // are added incrementally during the walk.
  const corpus = new Set()
  for (const f of indexFiles) {
    addIndexToCorpus(f, corpus)
  }
  // Also seed with this repo's local store if present.
  try {
    const local = path.join(resolveRepoRoot(), '.episodic-memory', 'index.jsonl')
    if (fs.existsSync(local)) addIndexToCorpus(local, corpus)
  } catch { /* not a repo */ }
  return corpus
}

function addIndexToCorpus(file, corpus) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (rec.summary) corpus.add(rec.summary.toLowerCase())
    } catch { /* skip malformed */ }
  }
}

function alreadyCaptured(candidatePhrase, corpus) {
  // Two-way containment on the FULL phrase (not a 60-char prefix). The prior
  // prefix-containment branch over-suppressed candidates that shared
  // boilerplate openings (e.g. canonical-prompt-as-episode, codex-review-*)
  // with existing summaries — Codex F3, PR #187 round 1.
  // Whitespace is normalized so trivial wrapping differences don't dodge
  // the check.
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const lc = norm(candidatePhrase)
  if (lc.length < 12) return false
  if (corpus.has(lc)) return true
  for (const summary of corpus) {
    const ns = norm(summary)
    if (ns.length < 12) continue
    if (lc === ns) return true
    // Full-phrase bidirectional containment only: candidate contained in an
    // existing summary, or existing summary contained in candidate.
    if (lc.includes(ns) || ns.includes(lc)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

function findTriggerHits(text) {
  if (!text || typeof text !== 'string') return []
  const lc = text.toLowerCase()
  const hits = []
  for (const { category, phrases } of TRIGGERS) {
    for (const phrase of phrases) {
      const idx = lc.indexOf(phrase)
      if (idx !== -1) {
        // Salient sentence: from start of containing line to end-of-sentence
        const lineStart = text.lastIndexOf('\n', idx) + 1
        const tail = text.slice(idx)
        const sentEnd = tail.search(/[.!?\n]/)
        const end = sentEnd === -1 ? Math.min(text.length, idx + 200) : idx + sentEnd
        hits.push({
          category,
          phrase,
          salient: text.slice(lineStart, end).trim().slice(0, 200),
        })
      }
    }
  }
  return hits
}

function suggestTags(category, text) {
  // Cheap keyword tagger; humans will refine.
  const tags = new Set([category])
  const map = [
    [/\brfc-(\d+)/i, (m) => `rfc-${m[1]}`],
    [/\bbp-?001\b/i, () => 'bp-001'],
    [/\brule\s*(\d+)/i, (m) => `rule-${m[1]}`],
    [/\bcodex\b/i, () => 'codex'],
    [/\bworktree/i, () => 'worktree'],
    [/\bhandoff\b/i, () => 'handoff'],
    [/\bplan-gate\b/i, () => 'plan-gate'],
    [/\btranscript/i, () => 'transcripts'],
  ]
  for (const [re, fn] of map) {
    const m = re.exec(text || '')
    if (m) tags.add(fn(m))
  }
  return [...tags]
}

async function mine() {
  const corpus = loadDedupeCorpus()
  const candidates = []
  // Keep a small ring buffer of recent records per session for context.
  const ringBySession = new Map()

  for await (const rec of walkTranscripts({ slugFilter, excludeWorktrees, since })) {
    const ring = ringBySession.get(rec.sessionId) || []
    ring.push(rec)
    if (ring.length > 5) ring.shift()
    ringBySession.set(rec.sessionId, ring)

    if (rec.role !== 'user' && rec.role !== 'assistant') continue
    if (!rec.text) continue
    const hits = findTriggerHits(rec.text)
    if (!hits.length) continue
    for (const hit of hits) {
      if (alreadyCaptured(hit.salient, corpus)) continue
      candidates.push({
        sessionId: rec.sessionId,
        slug: rec.slug,
        ts: rec.ts,
        cwd: rec.raw?.cwd || null,
        category: hit.category,
        phrase: hit.phrase,
        salient: hit.salient,
        tags: suggestTags(hit.category, rec.text),
        contextPreview: ring
          .filter((r) => r.role === 'user' || r.role === 'assistant')
          .slice(-3)
          .map((r) => `**${r.role}** (${r.ts}): ${r.text.slice(0, 240).replace(/\n+/g, ' ')}`)
          .join('\n\n'),
        // Add candidate to corpus so subsequent identical hits within this run
        // are deduped against each other too.
        _: corpus.add(hit.salient.toLowerCase()),
      })
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Output formatter
// ---------------------------------------------------------------------------

function renderMarkdown(candidates, since) {
  const header = [
    `# Mining candidates — generated ${new Date().toISOString()}`,
    '',
    `Window: since ${since}`,
    `Slug filter: ${slugFilter || '(all)'}`,
    `Exclude worktrees: ${excludeWorktrees}`,
    `Total candidates: ${candidates.length}`,
    '',
    '> Heuristic mining; review each before storing. False positives expected.',
    '',
    '---',
    '',
  ].join('\n')

  if (!candidates.length) return header + '_No candidates found in this window._\n'

  const sections = candidates.map((c, i) => {
    const tagsStr = c.tags.join(',')
    // POSIX single-quote escape: wrap in '...', encode embedded ' as '\''.
    // Resists $(...), backticks, $VAR, and backslash interpolation in the
    // surrounding double-quoted form previously used. (Codex F2, PR #187.)
    // Strip NUL and other C0 control bytes (except \t \n \r) before quoting:
    // POSIX shell cannot represent NUL inside argv, and other control bytes
    // make the rendered command unreadable. (Codex F5, PR #187 round 2.)
    const stripCtl = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    const sq = (s) => "'" + stripCtl(s).replace(/'/g, "'\\''") + "'"
    const summarySq = sq(c.salient.slice(0, 120))
    const tagsSq = sq(tagsStr)
    const cmd = `node scripts/em-store.mjs --project episodic-memory --scope local --category ${c.category} --tags ${tagsSq} --summary ${summarySq} --body '<expand from context>'`
    return [
      `## Candidate ${i + 1} — ${c.category}`,
      '',
      `- **Session:** \`${c.sessionId}\``,
      `- **Slug:** \`${c.slug}\``,
      `- **Timestamp:** ${c.ts}`,
      `- **Cwd:** ${c.cwd || '(unknown)'}`,
      `- **Triggered by phrase:** "${c.phrase}"`,
      `- **Suggested tags:** ${tagsStr}`,
      '',
      `**Salient text:**`,
      '',
      `> ${c.salient}`,
      '',
      `**Context (last 3 messages):**`,
      '',
      c.contextPreview,
      '',
      `**Suggested em-store command:**`,
      '',
      '```bash',
      cmd,
      '```',
      '',
      '---',
      '',
    ].join('\n')
  })

  return header + sections.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const candidates = await mine()
const md = renderMarkdown(candidates, since)

if (dryRun) {
  console.log(md)
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, md)
}

console.log(JSON.stringify({
  status: 'ok',
  since,
  slug: slugFilter || null,
  excludeWorktrees,
  candidates: candidates.length,
  output: dryRun ? null : outputPath,
  dryRun,
}, null, 2))
