#!/usr/bin/env node
/**
 * em-session-end-prompt.mjs — SessionEnd hook script for violation flagging.
 *
 * Outputs a JSON prompt template that the AI reads and uses to ask the user
 * whether any behavioral patterns were violated during the session.
 *
 * Usage:
 *   node em-session-end-prompt.mjs
 *
 * Designed for Claude Code SessionEnd hook. Not interactive — outputs JSON
 * for the AI to consume and act on.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { resolveRepoRoot } from './lib/local-dir.mjs'
import {
  ALL_MIGRATED_MARKERS,
  PLAN_MARKER_LEGACY_BASENAME,
  bothMarkerPaths,
  planMarkerBasenameForSession,
  primaryMarkerPath,
  legacyMarkerPath,
} from './lib/marker-paths.mjs'
import { validateSessionId } from './lib/session-id.mjs'

// ---------------------------------------------------------------------------
// Load known patterns from _index.json
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

// Phase 3b SessionEnd sweep: remove all six migrated markers (5 .X markers
// + .session-baseline) so they don't persist into the next session and
// create false-positive gates. Cleans orphaned states too (e.g.
// .post-checkpoint-required without .checkpoint-required, per RFC-002:207).
// Failure is silent — markers may not exist in some workflows.
//
// Dual-root sweep (.checkpoints/ migration, Codex round-1 F2): iterate the
// shared ALL_MIGRATED_MARKERS list and rm at BOTH .checkpoints/ AND .claude/
// during burn-in. .session-baseline is included so carve-out state doesn't
// leak across sessions.
//
// resolveRepoRoot ensures we clean the SAME root that armCheckpointMarker
// (em-recall) and the hooks (hooks/lib/repo-root.sh) target — a worktree-cwd
// would otherwise sweep an empty worktree-local marker dir while leaving
// the real markers stranded at the main repo root. Closes #106.
//
// #268 fix F12 (codex r1 F1): plan-approval-pending cleanup is OWN-SESSION-ONLY.
// SessionEnd hooks receive stdin JSON {session_id, ...}. We:
//   1. Read stdin if available, extract session_id, validate.
//   2. SKIP `.plan-approval-pending` (legacy literal) from the cleanup loop —
//      legacy is read-only-during-burn-in per plan v6 F3 (cleared only by
//      SessionStart orphan sweep with mtime check).
//   3. If sid valid: also rm `.plan-approval-pending.<own-sid>` at both roots.
//   4. If sid invalid/missing: skip plan-marker cleanup entirely.
// Other ALL_MIGRATED_MARKERS members are unchanged (per-session by nature).
//
// This prevents the bug class where session B's SessionEnd would delete
// session A's active `.plan-approval-pending.A` marker.

// Read SessionEnd stdin (best-effort; non-blocking-safe via readFileSync(0)).
// Codex code-tier r1 BLOCKER-B2 fix: extract BOTH session_id AND cwd from
// stdin. The hook target's cwd is the project the SessionEnd applies to;
// using process.cwd() would bind cleanup to the caller, which is wrong
// for linked-worktree / nested-cwd invocations.
let sessionEndSid = null
let sessionEndCwd = null
try {
  const stdinData = fs.readFileSync(0, 'utf8')
  if (stdinData) {
    const stdinJson = JSON.parse(stdinData)
    if (stdinJson && typeof stdinJson.session_id === 'string') {
      sessionEndSid = stdinJson.session_id
    }
    if (stdinJson && typeof stdinJson.cwd === 'string') {
      sessionEndCwd = stdinJson.cwd
    }
  }
} catch { /* best-effort; stdin missing/non-JSON → null sid + cwd */ }

// Pass stdin.cwd to resolveRepoRoot so cleanup binds to the hook target
// project, not the caller cwd. Use `|| undefined` so null/empty falls
// through to resolveRepoRoot's default-arg (process.cwd()) for manual
// interactive runs without stdin.
const repoRoot = resolveRepoRoot(sessionEndCwd || undefined)
for (const marker of ALL_MIGRATED_MARKERS) {
  if (marker === PLAN_MARKER_LEGACY_BASENAME) {
    // F12: never delete legacy plan-marker on SessionEnd.
    if (validateSessionId(sessionEndSid)) {
      // Own-session suffixed marker only.
      const ownBasename = planMarkerBasenameForSession(sessionEndSid)
      for (const p of [
        primaryMarkerPath(repoRoot, ownBasename),
        legacyMarkerPath(repoRoot, ownBasename),
      ]) {
        try { fs.unlinkSync(p) } catch {}
      }
    }
    // sid invalid → skip plan-marker cleanup entirely; orphan-sweep handles it.
    continue
  }
  for (const p of bothMarkerPaths(repoRoot, marker)) {
    try { fs.unlinkSync(p) } catch {}
  }
}

const patterns = loadPatternsIndex()

const knownPatterns = patterns.map(p => ({
  pattern_id: p.pattern_id,
  name: p.name
}))

const scriptsDir = path.join(os.homedir(), '.episodic-memory', 'scripts')

console.log(JSON.stringify({
  prompt: 'Were any behavioral patterns violated this session?',
  known_patterns: knownPatterns,
  store_command: `node ${path.join(scriptsDir, 'em-violation.mjs')} --pattern <id> --summary "..." --body "..."`,
  store_command_long_body: `node ${path.join(scriptsDir, 'em-violation.mjs')} --pattern <id> --summary "..." --body-file <path>  # for multi-paragraph bodies (avoids unsafe-substitution permission gate)`
}, null, 2))
