#!/usr/bin/env node
/**
 * second-opinion-gate.mjs — Claude Code PreToolUse hook for second-opinion harness.
 *
 * Block-class matrix per v3 §Hook block-class matrix:
 *
 * Bash branch (tool_name == "Bash"):
 *   For each provider in install snapshot, if tool_input.command matches
 *   provider.cli_match regex AND any of:
 *     1. tool_input.run_in_background === true
 *     2. tool_input.command.length > provider.prompt_max_chars
 *     3. cwd is a linked worktree AND command lacks --allow-worktree
 *     4. command matches em-store.*--scope local AND cwd is worktree
 *        (PR #218 anti-pattern)
 *   → block.
 *
 * Agent branch (tool_name == "Agent"):
 *   For each provider, if tool_input.subagent_type matches any pattern in
 *   provider.agent_block_patterns AND NOT in provider.agent_allow_patterns
 *   → block.
 *
 * Fail-closed cases (block on snapshot problems — any direct provider call
 * could be the bypass):
 *   - Snapshot file missing  → block.
 *   - Snapshot JSON parse fails → block.
 *   - Snapshot missing source_hash → block.
 *
 * Hook contract (Claude Code spec):
 *   - stdin = JSON: {tool_name, tool_input, cwd, ...}
 *   - exit 0 + stdout JSON {decision: "block", reason: "..."} → block
 *   - exit 0 + no stdout → allow
 *
 * Out-of-scope bypass classes (documented in commit; users can add gates):
 *   - Shell aliases / functions resolving to provider CLI
 *   - eval indirection
 *   - Wrapper scripts (npm scripts, project-local shell scripts)
 *   - Background provider runs spawned outside Claude Code
 *   - Provider invocations via SSH / remote tools
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SNAPSHOT_PATH = process.env.SO_INSTALL_SNAPSHOT_PATH ||
  path.join(os.homedir(), '.claude', 'hooks', 'second-opinion-providers.json')

function emitBlock(reason, extra = {}) {
  console.log(JSON.stringify({ decision: 'block', reason, ...extra }))
  process.exit(0)
}

function emitAllow() {
  // Claude Code interprets empty stdout + exit 0 as "allow".
  process.exit(0)
}

function readStdinSync() {
  // Claude Code provides stdin as a finite JSON blob, not a stream.
  let data = ''
  try {
    data = fs.readFileSync(0, 'utf8')
  } catch (e) {
    // No stdin — Claude Code always provides one; treat as fail-open
    // (test/CLI invocation without stdin should not block real tools).
    return null
  }
  if (!data.trim()) return null
  try {
    return JSON.parse(data)
  } catch (e) {
    // Malformed input — Claude Code internal contract violation.
    // Fail-open per the spec for unknown inputs (don't block on parse error
    // of stdin we can't trust the schema of).
    return null
  }
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    return { error: 'snapshot-not-installed' }
  }
  let raw, parsed
  try {
    raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8')
  } catch (e) {
    return { error: 'snapshot-read-failed', detail: e.message }
  }
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { error: 'snapshot-parse-failed', detail: e.message }
  }
  if (!parsed.source_hash) {
    return { error: 'snapshot-missing-source-hash' }
  }
  return { snapshot: parsed }
}

function isWorktreeCwd(cwd) {
  // Linked worktree: <cwd>/.git is a FILE (containing gitdir: ...), not a dir.
  // Main repo: <cwd>/.git is a directory.
  // Non-git: <cwd>/.git doesn't exist.
  const gitPath = path.join(cwd, '.git')
  if (!fs.existsSync(gitPath)) return false
  try {
    return !fs.statSync(gitPath).isDirectory()
  } catch {
    return false
  }
}

function compileCliMatch(pattern) {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

function checkBashBranch(toolInput, cwd, snapshot) {
  const command = toolInput.command || ''
  const runInBackground = toolInput.run_in_background === true

  for (const provider of snapshot.providers || []) {
    const cliRe = compileCliMatch(provider.cli_match || '')
    if (!cliRe || !cliRe.test(command)) continue

    // Block class 1: run_in_background
    if (runInBackground) {
      return {
        block: true,
        reason: `Direct provider call (${provider.id}) with run_in_background:true is blocked. ` +
          `Use the second-opinion harness (scripts/second-opinion.mjs request --provider ${provider.id} --dispatch) instead.`,
      }
    }

    // Block class 2: command length > prompt_max_chars
    if (provider.prompt_max_chars > 0 && command.length > provider.prompt_max_chars) {
      return {
        block: true,
        reason: `Direct provider call (${provider.id}) with prompt length ${command.length} exceeds prompt_max_chars ${provider.prompt_max_chars}. ` +
          `Use the harness which composes prompts with overflow detection.`,
      }
    }

    // Block class 3: cwd is worktree + no --allow-worktree
    if (isWorktreeCwd(cwd) && !command.includes('--allow-worktree')) {
      return {
        block: true,
        reason: `Direct provider call (${provider.id}) from linked worktree cwd. ` +
          `Run from canonical repo, OR pass --allow-worktree explicitly.`,
      }
    }
  }

  // Block class 4: em-store --scope local from worktree (PR #218 class).
  // Independent of provider match; applies to any em-store call.
  if (/\bem-store\b/.test(command) && /--scope\s+local/.test(command) && isWorktreeCwd(cwd)) {
    return {
      block: true,
      reason: `em-store --scope local from linked worktree cwd lands in worktree's ` +
        `.episodic-memory/, invisible to canonical-repo readers (PR #218 anti-pattern). ` +
        `Run from canonical repo path.`,
    }
  }

  return { block: false }
}

function checkAgentBranch(toolInput, snapshot) {
  const subagent = toolInput.subagent_type || ''
  if (!subagent) return { block: false }

  for (const provider of snapshot.providers || []) {
    const blockPatterns = provider.agent_block_patterns || []
    const allowPatterns = provider.agent_allow_patterns || []

    if (allowPatterns.includes(subagent)) continue
    if (blockPatterns.includes(subagent)) {
      return {
        block: true,
        reason: `Agent(${subagent}) is blocked: provider ${provider.id} review-shaped subagents must go through the second-opinion harness, not the Agent tool. ` +
          `Use scripts/second-opinion.mjs request --provider ${provider.id} --dispatch instead.`,
      }
    }
  }

  return { block: false }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const input = readStdinSync()
if (!input) {
  // No / unparseable stdin. Allow (Claude Code spec: hooks should not block
  // on malformed inputs; the actual tool dispatcher handles its own validation).
  emitAllow()
}

const snap = loadSnapshot()
if (snap.error) {
  emitBlock(
    `second-opinion-gate: ${snap.error}. Run: node install.mjs --install-second-opinion to install the registry. ` +
    `(Direct provider calls cannot be safely gated without the install snapshot.)`,
    { code: snap.error }
  )
}

const snapshot = snap.snapshot
const toolName = input.tool_name || ''
const toolInput = input.tool_input || {}
const cwd = input.cwd || process.cwd()

if (toolName === 'Bash') {
  const decision = checkBashBranch(toolInput, cwd, snapshot)
  if (decision.block) emitBlock(decision.reason)
  emitAllow()
}

if (toolName === 'Agent' || toolName === 'Task') {
  // Claude Code's Agent tool may report as 'Task' depending on version.
  const decision = checkAgentBranch(toolInput, snapshot)
  if (decision.block) emitBlock(decision.reason)
  emitAllow()
}

// Other tools: allow.
emitAllow()
