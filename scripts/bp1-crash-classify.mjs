#!/usr/bin/env node
/**
 * bp1-crash-classify.mjs — Pure crash-recovery classifier for BP-1 runs
 * (RFC-004 M2 slice 2e — Path A and crash-recovery state walker).
 *
 * Given a run's run-state record + chronologically ordered episode list
 * + marker-on-disk evidence, this script classifies what (if anything)
 * the run was doing when it crashed and emits a JSON resume-action plan
 * the caller can dispatch.
 *
 *   - Pure: `classifyRunCrash(...)` does NOT mutate run-state, episodes,
 *     or the filesystem. The CLI entry point performs the disk reads to
 *     gather inputs but only prints JSON; it never writes.
 *   - Resume target enumeration covers the 17-distinct-from-state plan
 *     table (slice 2e plan v2 lines 178-204). Each row maps to a
 *     `{ classification, resume_action }` shape.
 *
 * Usage (CLI):
 *   node scripts/bp1-crash-classify.mjs --project <root> --run-id <id>
 *
 * Stdout: single-line JSON `{ run_id, state, classification, resume_action, evidence }`.
 *
 * Exit codes:
 *   0 — classification produced (printed to stdout)
 *   2 — argv error
 *   5 — run not found in run-state index
 *
 * Caller integration:
 *   - `bp1-orchestrator.mjs check-deadlines` invokes this on stale-lock
 *     paths (Path A scaffolding lives in C4).
 *   - Future M5 sessionStart resume hook will invoke this per-run on
 *     boot to pick up where a previous session left off.
 */

import fs from 'node:fs'
import path from 'node:path'

import { getRunState } from './lib/bp1-run-state.mjs'
import { parseBp1Frontmatter } from './lib/bp1-frontmatter.mjs'

// Plan v2 §1 — five-min naked-entry threshold for codex_review entries.
export const PATH_B_AGE_THRESHOLD_MS = 5 * 60 * 1000

const TERMINAL_STATES = new Set([
  'complete',
  'aborted',
  'abandoned',
  'archived',
  'approved',
  'auto_approved',
  'terminal_halt',
])

// ---------------------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------------------

/**
 * Classify a run's crash-recovery state given its run-state record + episode
 * stream + marker evidence. PURE: no I/O, no mutation.
 *
 * @param {object} args
 * @param {{ state: string, decided_class?: string|null, ...rest }} args.runState
 * @param {Array<object>} args.episodes — Frontmatter-only objects, chronologically
 *   ordered. Each MUST have at minimum `{ id, type, run_id }`; state-transition
 *   episodes also have `state`; evidence episodes link via `parent_episode`.
 * @param {boolean} args.markerPresent — Approval-marker file presence (only consulted for state=awaiting_approval).
 * @param {boolean} args.markerExpired — Approval-marker deadline expiry (only consulted for state=awaiting_approval).
 * @param {number|string} args.now — Epoch-ms or ISO-8601 string.
 * @returns {{
 *   classification: string,
 *   resume_action: { command: string, reason: string, args?: object } | null,
 *   evidence: object,
 * }}
 */
export function classifyRunCrash({ runState, episodes, markerPresent, markerExpired, now }) {
  if (!runState || typeof runState !== 'object') {
    return {
      classification: 'crash-classify-unparseable',
      resume_action: { command: 'needs-human', reason: 'crash-classify-unparseable' },
      evidence: { reason: 'run-state missing or non-object' },
    }
  }

  const state = runState.state
  const epList = Array.isArray(episodes) ? episodes : []
  const stateTransitions = epList.filter(e => e && e.type === 'state-transition')
  const evidenceEps = epList.filter(e => e && e.type === 'evidence')

  if (TERMINAL_STATES.has(state)) {
    // Row 22 — terminal states are no-op.
    return {
      classification: 'terminal-no-op',
      resume_action: null,
      evidence: { state, terminal: true },
    }
  }

  switch (state) {
    case 'active':
    case 'classifier-dispatch-pending': {
      // Pre-classification — minimal data to recover automatically.
      return {
        classification: 'crash-pre-classification',
        resume_action: { command: 'needs-human', reason: 'crash-classify-pre-classification' },
        evidence: { state },
      }
    }

    case 'rfc-detected': {
      // Row 1 — no state-transition:classified follows.
      const hasClassified = stateTransitions.some(e => e.state === 'classified')
      if (!hasClassified) {
        return {
          classification: 'crash-mid-classify',
          resume_action: { command: 'record-classification', reason: 'no classified state-transition' },
          evidence: { state, hasClassified: false },
        }
      }
      return {
        classification: 'inconsistent-rfc-detected',
        resume_action: { command: 'needs-human', reason: 'classified state-transition exists but run.state still rfc-detected' },
        evidence: { state, hasClassified: true },
      }
    }

    case 'classified': {
      const klass = runState.decided_class
      if (klass === 'trivial') {
        // Row 2 — no awaiting_approval follows.
        const hasAwait = stateTransitions.some(e => e.state === 'awaiting_approval')
        if (!hasAwait) {
          return {
            classification: 'crash-mid-Phase-A',
            resume_action: { command: 'record-awaiting-approval', reason: 'no awaiting_approval transition after trivial classification' },
            evidence: { state, decided_class: klass },
          }
        }
        return {
          classification: 'inconsistent-classified-trivial',
          resume_action: { command: 'needs-human', reason: 'awaiting_approval exists but run.state still classified' },
          evidence: { state, decided_class: klass, hasAwait: true },
        }
      }
      // Risky class — Row 3.
      const hasNeedsHuman = stateTransitions.some(e => e.state === 'needs-human')
      if (!hasNeedsHuman) {
        return {
          classification: 'crash-mid-risky-route',
          resume_action: { command: 'record-classification', reason: 'risky class but no needs-human transition; re-dispatch route', args: { rerouteRisky: true } },
          evidence: { state, decided_class: klass },
        }
      }
      return {
        classification: 'inconsistent-classified-risky',
        resume_action: { command: 'needs-human', reason: 'needs-human transition exists but run.state still classified' },
        evidence: { state, decided_class: klass },
      }
    }

    case 'awaiting_approval': {
      if (!markerPresent) {
        // Row 4 — marker absent → Phase B crash before marker write.
        return {
          classification: 'crash-mid-Phase-B',
          resume_action: { command: 'record-awaiting-approval', reason: 'rewrite byte-identical marker (RFC §582)' },
          evidence: { state, markerPresent: false },
        }
      }
      if (markerExpired) {
        // Row 5 — marker present + expired = normal A2 timeout.
        return {
          classification: 'a2-timeout',
          resume_action: { command: 'confirm-approval', reason: 'deadline_at expired', args: { outcome: 'auto_approved' } },
          evidence: { state, markerPresent: true, markerExpired: true },
        }
      }
      // Marker present + not expired = in-flight, nothing to do.
      return {
        classification: 'in-flight',
        resume_action: null,
        evidence: { state, markerPresent: true, markerExpired: false },
      }
    }

    case 'planning': {
      // Row 7 — no plan episode yet (heuristic: tag includes 'plan' or summary mentions plan).
      // We avoid pinning the exact shape because slice 2e doesn't ship the
      // planner agent; the heuristic is "any non-transition episode with a
      // tag suggesting a plan was emitted" + "state-transition:adversarial_reviewed".
      const hasAdvReviewed = stateTransitions.some(e => e.state === 'adversarial_reviewed')
      const hasPlanEpisode = epList.some(e =>
        e && e.type !== 'state-transition' &&
        ((Array.isArray(e.tags) && e.tags.some(t => /(^|-)plan(-|$)/.test(String(t)))) ||
         /plan/i.test(String(e.summary || '')))
      )
      if (!hasPlanEpisode) {
        return {
          classification: 'crash-mid-plan',
          resume_action: { command: 'planning', reason: 'no plan episode emitted yet' },
          evidence: { state, hasPlanEpisode: false, hasAdvReviewed },
        }
      }
      if (!hasAdvReviewed) {
        return {
          classification: 'crash-mid-adversarial-dispatch',
          resume_action: { command: 'planning', reason: 'plan emitted but adversarial review not transitioned', args: { step: 'adversarial-dispatch' } },
          evidence: { state, hasPlanEpisode: true, hasAdvReviewed: false },
        }
      }
      return {
        classification: 'inconsistent-planning',
        resume_action: { command: 'needs-human', reason: 'adversarial_reviewed exists but run.state still planning' },
        evidence: { state, hasPlanEpisode: true, hasAdvReviewed: true },
      }
    }

    case 'adversarial_reviewed': {
      // Row 9 — no em-review-request evidence → resume request-issue step.
      const hasReviewRequest = evidenceEps.some(e =>
        (Array.isArray(e.tags) && e.tags.some(t => /em-review-request/.test(String(t)))) ||
        /em-review-request/.test(String(e.summary || ''))
      )
      if (!hasReviewRequest) {
        return {
          classification: 'crash-mid-em-review-request',
          resume_action: { command: 'adversarial_reviewed', reason: 'no em-review-request evidence', args: { step: 'request-issue' } },
          evidence: { state, hasReviewRequest: false },
        }
      }
      return {
        classification: 'inconsistent-adversarial-reviewed',
        resume_action: { command: 'needs-human', reason: 'em-review-request evidence exists but no codex_review transition' },
        evidence: { state, hasReviewRequest: true },
      }
    }

    case 'codex_review': {
      // Rows 10, 11, 12 — Path A vs Path B vs in-flight.
      const codexReviewEntries = stateTransitions.filter(e => e.state === 'codex_review')
      if (codexReviewEntries.length === 0) {
        return {
          classification: 'inconsistent-codex-review',
          resume_action: { command: 'needs-human', reason: 'state=codex_review but no codex_review entry episode found' },
          evidence: { state, codexReviewEntries: 0 },
        }
      }
      const latestEntry = codexReviewEntries[codexReviewEntries.length - 1]
      const hasRequestSent = evidenceEps.some(e =>
        e.parent_episode === latestEntry.id &&
        ((Array.isArray(e.tags) && e.tags.some(t => /bp1-codex-request-sent/.test(String(t)))) ||
         /bp1-codex-request-sent/.test(String(e.summary || '')))
      )
      if (hasRequestSent) {
        // Row 10 — Path A territory; deadline-tick owns it.
        return {
          classification: 'path-a-defer',
          resume_action: { command: 'defer', reason: 'request_sent=true; deadline-tick owns Path A timeout' },
          evidence: { state, hasRequestSent: true, latestEntryId: latestEntry.id },
        }
      }
      // Row 11/12 — naked entry; depends on age.
      const entryCreatedMs = Date.parse(latestEntry.created_at || '')
      if (Number.isNaN(entryCreatedMs)) {
        return {
          classification: 'crash-classify-unparseable',
          resume_action: { command: 'needs-human', reason: 'codex_review entry missing parsable created_at' },
          evidence: { state, latestEntryId: latestEntry.id, created_at: latestEntry.created_at },
        }
      }
      const nowMs = typeof now === 'string' ? Date.parse(now) : Number(now)
      const ageMs = nowMs - entryCreatedMs
      if (ageMs >= PATH_B_AGE_THRESHOLD_MS) {
        return {
          classification: 'path-b-defer',
          resume_action: { command: 'defer', reason: 'naked entry stale; naked-entry sweep owns recovery (slice 2f)' },
          evidence: { state, hasRequestSent: false, ageMs, latestEntryId: latestEntry.id },
        }
      }
      return {
        classification: 'in-flight',
        resume_action: null,
        evidence: { state, hasRequestSent: false, ageMs, latestEntryId: latestEntry.id },
      }
    }

    case 'codex_complete': {
      // Row 13 — no sentinel decision episode.
      const hasSentinel = epList.some(e =>
        (Array.isArray(e.tags) && e.tags.some(t => /sentinel/.test(String(t)))) ||
        /sentinel/.test(String(e.summary || ''))
      )
      if (!hasSentinel) {
        return {
          classification: 'crash-mid-sentinel',
          resume_action: { command: 'codex_complete', reason: 'no sentinel decision episode emitted', args: { step: 'sentinel-dispatch' } },
          evidence: { state, hasSentinel: false },
        }
      }
      return {
        classification: 'inconsistent-codex-complete',
        resume_action: { command: 'needs-human', reason: 'sentinel exists but no implementing transition' },
        evidence: { state, hasSentinel: true },
      }
    }

    case 'implementing': {
      // Rows 14 + 15 — commit/worktree evidence + reviewing transition.
      const hasCommit = epList.some(e =>
        (Array.isArray(e.tags) && e.tags.some(t => /(commit|worktree)/.test(String(t)))) ||
        /commit-evidence|worktree-evidence/.test(String(e.summary || ''))
      )
      const hasReviewingTransition = stateTransitions.some(e => e.state === 'reviewing')
      if (!hasCommit) {
        return {
          classification: 'crash-classify-ambiguous-impl',
          resume_action: { command: 'needs-human', reason: 'crash-classify-ambiguous-impl' },
          evidence: { state, hasCommit: false, hasReviewingTransition },
        }
      }
      if (!hasReviewingTransition) {
        return {
          classification: 'crash-mid-reviewer-dispatch',
          resume_action: { command: 'implementing', reason: 'commit present but reviewer not dispatched', args: { step: 'reviewer-dispatch' } },
          evidence: { state, hasCommit: true, hasReviewingTransition: false },
        }
      }
      return {
        classification: 'inconsistent-implementing',
        resume_action: { command: 'needs-human', reason: 'reviewing transition exists but state still implementing' },
        evidence: { state, hasCommit: true, hasReviewingTransition: true },
      }
    }

    case 'reviewing': {
      // Row 16 — resume reviewer-poll.
      return {
        classification: 'crash-mid-reviewer-poll',
        resume_action: { command: 'reviewing', reason: 're-poll reviewers; no all-clean signal' },
        evidence: { state },
      }
    }

    case 'fix_loop': {
      // Row 17 — ambiguous; route to needs_human.
      return {
        classification: 'crash-classify-ambiguous-fix-loop',
        resume_action: { command: 'needs-human', reason: 'crash-classify-ambiguous-fix-loop' },
        evidence: { state },
      }
    }

    case 'auditing': {
      // Row 18 — no audit_pass yet.
      const hasAuditPass = stateTransitions.some(e => e.state === 'audit_pass')
      if (!hasAuditPass) {
        return {
          classification: 'crash-mid-auditing',
          resume_action: { command: 'auditing', reason: 'no audit_pass transition; re-run audit' },
          evidence: { state, hasAuditPass: false },
        }
      }
      return {
        classification: 'inconsistent-auditing',
        resume_action: { command: 'needs-human', reason: 'audit_pass exists but run.state still auditing' },
        evidence: { state, hasAuditPass: true },
      }
    }

    case 'audit_pass': {
      // Row 19 — no pr_opened transition yet.
      const hasPrOpened = stateTransitions.some(e => e.state === 'pr_opened')
      if (!hasPrOpened) {
        return {
          classification: 'crash-mid-pr-create',
          resume_action: { command: 'audit_pass', reason: 'no pr_opened transition', args: { step: 'gh-pr-create' } },
          evidence: { state, hasPrOpened: false },
        }
      }
      return {
        classification: 'inconsistent-audit-pass',
        resume_action: { command: 'needs-human', reason: 'pr_opened exists but state still audit_pass' },
        evidence: { state, hasPrOpened: true },
      }
    }

    case 'pr_opened': {
      // Row 20 — no em-review-request evidence for the PR-tier review.
      const hasReviewRequest = evidenceEps.some(e =>
        (Array.isArray(e.tags) && e.tags.some(t => /em-review-request/.test(String(t)))) ||
        /em-review-request/.test(String(e.summary || ''))
      )
      if (!hasReviewRequest) {
        return {
          classification: 'crash-mid-pr-review-request',
          resume_action: { command: 'pr_opened', reason: 'no em-review-request evidence', args: { step: 'request-issue' } },
          evidence: { state, hasReviewRequest: false },
        }
      }
      return {
        classification: 'inconsistent-pr-opened',
        resume_action: { command: 'needs-human', reason: 'em-review-request exists but no codex_pr_review transition' },
        evidence: { state, hasReviewRequest: true },
      }
    }

    case 'codex_pr_review': {
      // Row 21 — DEFER to deadline-tick (same Path A semantics).
      return {
        classification: 'pr-review-path-a-defer',
        resume_action: { command: 'defer', reason: 'PR-tier codex review owned by deadline-tick' },
        evidence: { state },
      }
    }

    case 'needs-human': {
      // Awaiting human override; no automated action.
      return {
        classification: 'awaiting-human-override',
        resume_action: null,
        evidence: { state },
      }
    }

    default: {
      // Row 23 — unparseable / unknown state.
      return {
        classification: 'crash-classify-unparseable',
        resume_action: { command: 'needs-human', reason: 'crash-classify-unparseable', args: { observed_state: state } },
        evidence: { state },
      }
    }
  }
}

// ---------------------------------------------------------------------------
// I/O wrapper (kept separate from the pure classifier)
// ---------------------------------------------------------------------------

/**
 * Read all BP-1 episode files for a given run from the project's episodic
 * memory store, parse their frontmatter, and return chronologically-sorted
 * frontmatter records. Episodes whose frontmatter cannot be parsed are
 * dropped silently (per RFC §753-771 fail-closed parser; replay tolerates
 * skipped records).
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @returns {Array<object>}
 */
export function loadRunEpisodes(projectRoot, runId) {
  const dir = path.join(projectRoot, '.episodic-memory', 'episodes')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw e
  }
  const records = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    let text
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch (_e) {
      continue
    }
    let fm
    try {
      fm = parseBp1Frontmatter(text)
    } catch (_e) {
      continue  // skip unparseable
    }
    if (!fm || typeof fm !== 'object') continue
    if (fm.run_id !== runId) continue
    fm.__filename = name
    records.push(fm)
  }
  // Sort by filename — BP-1 episode ids are timestamp-prefixed, so
  // lexicographic sort is chronological.
  records.sort((a, b) => String(a.__filename).localeCompare(String(b.__filename)))
  return records
}

/**
 * Check approval-marker existence + expiry for a run. Caller is responsible
 * for marker-path resolution and validation; this helper consults the
 * standard `<projectRoot>/.checkpoints/bp1-approval-<run_id>.json` location
 * and parses the embedded `deadline_at` field for expiry.
 *
 * @param {string} projectRoot
 * @param {string} runId
 * @param {number} [nowMs=Date.now()]
 * @returns {{ present: boolean, expired: boolean, deadline_at: string|null }}
 */
export function readApprovalMarkerStatus(projectRoot, runId, nowMs = Date.now()) {
  const markerPath = path.join(projectRoot, '.checkpoints', `bp1-approval-${runId}.json`)
  let raw
  try {
    raw = fs.readFileSync(markerPath, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return { present: false, expired: false, deadline_at: null }
    return { present: false, expired: false, deadline_at: null }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_e) {
    // Malformed JSON treated as present-but-invalid; let the validator path
    // surface that. For crash-classify purposes, treat as "present, expired"
    // so the caller routes through normal A2 flow.
    return { present: true, expired: true, deadline_at: null }
  }
  const deadlineAt = typeof parsed.deadline_at === 'string' ? parsed.deadline_at : null
  if (!deadlineAt) return { present: true, expired: true, deadline_at: null }
  const deadlineMs = Date.parse(deadlineAt)
  if (Number.isNaN(deadlineMs)) return { present: true, expired: true, deadline_at: deadlineAt }
  return { present: true, expired: nowMs >= deadlineMs, deadline_at: deadlineAt }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') out.project = argv[++i]
    else if (a === '--run-id') out.runId = argv[++i]
    else if (a === '--now') out.now = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else {
      return { error: `unknown-flag: ${a}` }
    }
  }
  return out
}

function helpText() {
  return [
    'bp1-crash-classify.mjs — classify a BP-1 run\'s crash-recovery state',
    '',
    'Usage:',
    '  node scripts/bp1-crash-classify.mjs --project <root> --run-id <id> [--now <iso>]',
    '',
    'Output: single-line JSON to stdout with { run_id, state, classification,',
    '        resume_action, evidence }.',
    '',
    'Exit codes:',
    '  0  classification produced',
    '  2  argv error',
    '  5  run not found',
    ''
  ].join('\n')
}

async function main() {
  const argv = parseArgv(process.argv.slice(2))
  if (argv.help) { process.stdout.write(helpText()); process.exit(0) }
  if (argv.error) {
    process.stderr.write(`argv error: ${argv.error}\n`)
    process.exit(2)
  }
  if (!argv.project || !argv.runId) {
    process.stderr.write('argv error: --project and --run-id are required\n')
    process.exit(2)
  }
  const projectRoot = path.resolve(argv.project)
  const runId = argv.runId
  const nowMs = argv.now ? Date.parse(argv.now) : Date.now()
  if (Number.isNaN(nowMs)) {
    process.stderr.write(`argv error: --now is not a parseable ISO-8601: ${JSON.stringify(argv.now)}\n`)
    process.exit(2)
  }

  const runState = getRunState(projectRoot, runId)
  if (!runState) {
    process.stderr.write(`run not found in run-state index: ${runId}\n`)
    process.exit(5)
  }
  const episodes = loadRunEpisodes(projectRoot, runId)
  const marker = readApprovalMarkerStatus(projectRoot, runId, nowMs)

  const result = classifyRunCrash({
    runState,
    episodes,
    markerPresent: marker.present,
    markerExpired: marker.expired,
    now: nowMs,
  })

  process.stdout.write(JSON.stringify({
    run_id: runId,
    state: runState.state,
    decided_class: runState.decided_class ?? null,
    classification: result.classification,
    resume_action: result.resume_action,
    evidence: result.evidence,
    marker: { present: marker.present, expired: marker.expired, deadline_at: marker.deadline_at },
  }) + '\n')
}

const invokedAsScript = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname) }
  catch { return false }
})()
if (invokedAsScript) {
  main().catch(e => {
    process.stderr.write(`internal error: ${e.stack || e.message}\n`)
    process.exit(3)
  })
}
