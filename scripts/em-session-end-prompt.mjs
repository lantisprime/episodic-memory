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

// Phase 3b SessionEnd sweep: remove all four checkpoint markers so they
// don't persist into the next session and create false-positive gates.
// Cleans orphaned states too (e.g. .post-checkpoint-required without
// .checkpoint-required, per RFC-002 line 207). Failure is silent — markers
// may not exist or .claude/ may be missing in some workflows.
//
// resolveRepoRoot ensures we clean the SAME .claude/ that armCheckpointMarker
// (em-recall) and the hooks (hooks/lib/repo-root.sh) target — a worktree-cwd
// would otherwise sweep an empty worktree-local .claude/ while leaving the
// real markers stranded at the main repo root. Closes #106.
const claudeDir = path.join(resolveRepoRoot(), '.claude')
for (const marker of [
  '.checkpoint-required',
  '.pre-checkpoint-done',
  '.post-checkpoint-required',
  '.post-checkpoint-done'
]) {
  try { fs.unlinkSync(path.join(claudeDir, marker)) } catch {}
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
  store_command: `node ${path.join(scriptsDir, 'em-violation.mjs')} --pattern <id> --summary "..." --body "..."`
}, null, 2))
