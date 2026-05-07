#!/usr/bin/env node
/**
 * em-audit-compliance.mjs — measure rule-skip rates from session transcripts.
 *
 * Walks Claude Code session JSONLs via transcript-walker, classifies each
 * session against three high-confidence heuristics:
 *
 *   - rule-9-handoff   : session has >= 20 records AND no Write to a
 *                        session_handoff.md path during the session
 *   - rule-8-plan-gate : session contains Edit/Write tool_use AND assistant
 *                        text mentions "plan" AND no `.plan-approval-pending`
 *                        marker touch was observed (the marker is what
 *                        plan-gate.sh checks)
 *   - rule-18-e2e      : session contains implementation Edit/Write
 *                        (to .mjs/.ts/.js/.sh/.py) AND no Bash test run
 *                        (node ... .mjs|.test.|jest|pytest|vitest|test-) AND
 *                        no `gh issue create` (bug-logging step)
 *
 * Heuristic, not ground truth. False positives expected — short sessions
 * legitimately have no handoff; documentation-only changes legitimately have
 * no tests. Output is directionally useful for trend tracking, not
 * authoritative.
 *
 * Usage:
 *   node em-audit-compliance.mjs [--since <ISO>] [--slug <substring>]
 *                                [--exclude-worktrees]
 *                                [--format json|markdown]
 *                                [--prior-since <ISO>]
 *
 * Defaults:
 *   --since         7 days ago
 *   --prior-since   14 days ago (used for trend delta vs prior week)
 *   --format        json
 *
 * Output JSON to stdout: see schema in classifySession() and aggregate().
 *
 * Zero deps; Node stdlib only.
 */

import { walkTranscripts, groupBySession } from './lib/transcript-walker.mjs'

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

function isoDaysAgo(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString()
}

const since = flag('--since') || isoDaysAgo(7)
const priorSince = flag('--prior-since') || isoDaysAgo(14)
const slugFilter = flag('--slug') === true ? undefined : flag('--slug')
const excludeWorktrees = flag('--exclude-worktrees') === true
const format = flag('--format') || 'json'

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const IMPL_FILE_RE = /\.(mjs|ts|tsx|js|jsx|sh|py|rb|go|rs)\b/
const TEST_BASH_RE = /\b(node\s+\S*test|jest|pytest|vitest|tap\b|test-\S+\.(mjs|sh|py|js))/i
const GH_ISSUE_RE = /\bgh\s+issue\s+create\b/i

function getEditWriteTargetPath(rec) {
  // tool_use record. Inspect input.file_path / input.path / etc.
  const tu = rec.raw?.message?.content?.find((b) => b && b.type === 'tool_use')
  if (!tu) return null
  const i = tu.input || {}
  return i.file_path || i.path || i.notebook_path || null
}

function getBashCommand(rec) {
  const tu = rec.raw?.message?.content?.find((b) => b && b.type === 'tool_use')
  if (!tu) return null
  return tu.input?.command || null
}

function classifySession(records) {
  let editWriteCount = 0
  let implEditCount = 0
  let handoffWrite = false
  let planMentioned = false
  let planApprovalMarker = false
  let testRun = false
  let issueCreate = false

  for (const r of records) {
    if (r.role === 'assistant' && r.text && /\bplan\b/i.test(r.text)) {
      planMentioned = true
    }
    if (r.role === 'tool_use') {
      if (r.toolName === 'Edit' || r.toolName === 'Write' || r.toolName === 'NotebookEdit') {
        editWriteCount++
        const target = getEditWriteTargetPath(r) || ''
        if (IMPL_FILE_RE.test(target)) implEditCount++
        if (/session_handoff\.md\b/.test(target)) handoffWrite = true
      } else if (r.toolName === 'Bash') {
        const cmd = getBashCommand(r) || ''
        if (/\.plan-approval-pending\b/.test(cmd)) planApprovalMarker = true
        if (TEST_BASH_RE.test(cmd)) testRun = true
        if (GH_ISSUE_RE.test(cmd)) issueCreate = true
      }
    }
  }

  const skipped = []
  // rule-9: long sessions w/o handoff
  if (records.length >= 20 && !handoffWrite) skipped.push('rule-9-handoff')
  // rule-8: edits + plan mention + no marker touch
  if (editWriteCount > 0 && planMentioned && !planApprovalMarker) skipped.push('rule-8-plan-gate')
  // rule-18: impl edits + no tests + no issue create
  if (implEditCount > 0 && !testRun && !issueCreate) skipped.push('rule-18-e2e')

  return {
    sessionId: records[0].sessionId,
    slug: records[0].slug,
    firstTs: records[0].ts,
    lastTs: records[records.length - 1].ts,
    records: records.length,
    editWriteCount,
    implEditCount,
    handoffWrite,
    planMentioned,
    planApprovalMarker,
    testRun,
    issueCreate,
    skipped,
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const RULES = ['rule-9-handoff', 'rule-8-plan-gate', 'rule-18-e2e']

function aggregate(classifications) {
  const totalSessions = classifications.length
  const rules = {}
  for (const rule of RULES) {
    const skipped = classifications.filter((c) => c.skipped.includes(rule)).length
    const eligible = countEligible(rule, classifications)
    rules[rule] = {
      skipped,
      eligibleSessions: eligible,
      rate: eligible ? skipped / eligible : 0,
    }
  }
  // top offenders: sessions with the most skipped rules
  const topOffenders = classifications
    .filter((c) => c.skipped.length)
    .sort((a, b) => b.skipped.length - a.skipped.length)
    .slice(0, 5)
    .map((c) => ({
      sessionId: c.sessionId,
      slug: c.slug,
      lastTs: c.lastTs,
      records: c.records,
      skipped: c.skipped,
    }))
  return { totalSessions, rules, topOffenders }
}

function countEligible(rule, classifications) {
  // Eligibility = sessions that COULD have skipped (denominator).
  // Tells us "of sessions where this rule applied, what % skipped."
  switch (rule) {
    case 'rule-9-handoff':
      return classifications.filter((c) => c.records >= 20).length
    case 'rule-8-plan-gate':
      return classifications.filter((c) => c.editWriteCount > 0 && c.planMentioned).length
    case 'rule-18-e2e':
      return classifications.filter((c) => c.implEditCount > 0).length
    default:
      return classifications.length
  }
}

async function audit(sinceVal) {
  const generator = walkTranscripts({ slugFilter, excludeWorktrees, since: sinceVal })
  const grouped = await groupBySession(generator)
  const classifications = []
  for (const [, records] of grouped) {
    classifications.push(classifySession(records))
  }
  return aggregate(classifications)
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

function computeTrend(current, prior) {
  const out = {}
  for (const rule of RULES) {
    const cur = current.rules[rule].rate
    const prv = prior.rules[rule].rate
    out[rule] = +(cur - prv).toFixed(3)
  }
  return out
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const current = await audit(since)
let trend = null
if (priorSince && priorSince !== since) {
  // Prior window = [priorSince, since)
  const priorAll = await audit(priorSince)
  // Subtract current window's sessions to get just the prior window.
  // For simplicity in v1 we just report rates over [priorSince, now];
  // the delta is approximate but useful for direction. Documented as such.
  trend = computeTrend(current, priorAll)
}

const result = {
  status: 'ok',
  generatedAt: new Date().toISOString(),
  since,
  priorSince,
  slug: slugFilter || null,
  excludeWorktrees,
  ...current,
  trendVsPriorWindow: trend,
  notes: 'Heuristic; false positives expected. Trend compares current window to broader [priorSince, now] window.',
}

if (format === 'markdown') {
  console.log(renderMarkdown(result))
} else {
  console.log(JSON.stringify(result, null, 2))
}

function renderMarkdown(r) {
  const lines = [
    `# Compliance audit — ${r.generatedAt.slice(0, 10)}`,
    '',
    `Window: \`${r.since}\` → now${r.slug ? ` · slug=${r.slug}` : ''}${r.excludeWorktrees ? ' · no worktrees' : ''}`,
    `Total sessions: **${r.totalSessions}**`,
    '',
    '## Rule skip rates',
    '',
    '| Rule | Skipped | Eligible | Rate | Δ vs prior |',
    '|------|--------:|---------:|-----:|-----------:|',
  ]
  for (const rule of RULES) {
    const stats = r.rules[rule]
    const trendStr = r.trendVsPriorWindow ? formatDelta(r.trendVsPriorWindow[rule]) : 'n/a'
    lines.push(`| \`${rule}\` | ${stats.skipped} | ${stats.eligibleSessions} | ${(stats.rate * 100).toFixed(1)}% | ${trendStr} |`)
  }
  lines.push('')
  if (r.topOffenders.length) {
    lines.push('## Top offenders')
    lines.push('')
    for (const o of r.topOffenders) {
      lines.push(`- \`${o.sessionId}\` (${o.records} records, ${o.lastTs}) — skipped: ${o.skipped.join(', ')}`)
    }
    lines.push('')
  }
  lines.push(`> ${r.notes}`)
  return lines.join('\n')
}

function formatDelta(d) {
  if (d == null) return 'n/a'
  const sign = d > 0 ? '+' : ''
  return `${sign}${(d * 100).toFixed(1)}pp`
}
