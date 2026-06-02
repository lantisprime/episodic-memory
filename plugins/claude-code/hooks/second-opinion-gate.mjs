#!/usr/bin/env node
/**
 * second-opinion-gate.mjs — Claude Code PreToolUse hook for second-opinion harness.
 *
 * Two responsibilities, ordered:
 *
 *   1. RUNBOOK GATE (codex r2 P1 — runbook injection):
 *      For Bash tool calls matching `node ... second-opinion.mjs ... request`,
 *      block on the FIRST invocation per session with the runbook quickref
 *      inlined in the reason field. Marker `.checkpoints/.so-runbook-shown.<sha8>`
 *      at canonical repo root tracks "runbook has been shown this session";
 *      sha8 binds to runbook content so in-session edits force re-inject.
 *      Runs BEFORE validator/snapshot load so a missing/bad snapshot cannot
 *      preempt the runbook block.
 *
 *   2. DIRECT-PROVIDER BLOCK (existing v1 behavior):
 *      Block direct provider CLI calls (codex/etc.) that bypass the harness.
 *      Reads installed provider snapshot at ~/.claude/hooks/second-opinion-providers.json
 *      and applies cli_match / agent_block_patterns from the snapshot.
 *
 * Block-class matrix per v3 §Hook block-class matrix (existing flow):
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
 * Fail-closed cases (block on snapshot/runbook problems):
 *   - Runbook gate: runbook file missing/empty/too-short/no-sentinel → block.
 *   - Snapshot file missing/parse-failed/missing-source-hash → block.
 *
 * Hook contract (Claude Code spec):
 *   - stdin = JSON: {tool_name, tool_input, cwd, ...}
 *   - exit 0 + stdout JSON {decision: "block", reason: "..."} → block
 *   - exit 0 + no stdout → allow
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// resolveRepoRoot is dynamically imported inside checkRunbookGate so a
// missing local-dir.mjs (orphan/partial install) cannot preempt the gate
// at module load. Fallback resolver below handles the case where the
// installed lib is missing.

const SNAPSHOT_PATH = process.env.SO_INSTALL_SNAPSHOT_PATH ||
  path.join(os.homedir(), '.claude', 'hooks', 'second-opinion-providers.json')

const RUNBOOK_PATH = process.env.SO_RUNBOOK_PATH ||
  path.join(os.homedir(), '.claude', 'hooks', 'runbooks', 'second-opinion-harness.md')

const QUICKREF_PATH = process.env.SO_QUICKREF_PATH ||
  path.join(os.homedir(), '.claude', 'hooks', 'runbooks', 'second-opinion-harness.quickref.md')

// Sentinel substring required to be present in the full runbook. The
// canonical runbook's load-bearing section is "## ⚠️ Self-trigger checklist";
// the substring drops the emoji to avoid regex/encoding fragility.
const RUNBOOK_SENTINEL = 'Self-trigger checklist'
const MIN_RUNBOOK_BYTES = 256
const MIN_QUICKREF_BYTES = 64

// ---------------------------------------------------------------------------
// Pure helpers — no side effects at module load.
// ---------------------------------------------------------------------------

function emitBlock(reason, extra = {}) {
  console.log(JSON.stringify({ decision: 'block', reason, ...extra }))
  process.exit(0)
}

function emitAllow() {
  // Claude Code interprets empty stdout + exit 0 as "allow".
  process.exit(0)
}

function readStdinSync() {
  let data = ''
  try {
    data = fs.readFileSync(0, 'utf8')
  } catch (e) {
    return null
  }
  if (!data.trim()) return null
  try {
    return JSON.parse(data)
  } catch (e) {
    return null
  }
}

/**
 * Occurrence-scoped harness detection. Strips shell quote/escape chars (mirrors
 * `_strip_shell_quotes` in checkpoint-gate.sh:163), then matches the literal
 * `second-opinion.mjs ... request` substring. Accepts splice patterns
 * (&& / ; / env-prefix), quoted script names, and absolute paths. Known
 * false-positive: `echo "node second-opinion.mjs request"` — acceptable
 * trade-off per plan v4 (asymmetric cost: false-positive = one extra prompt
 * round; false-negative = runbook never loaded).
 */
function isHarnessRequest(command) {
  if (!command) return false
  const stripped = command.replace(/["'\\]/g, '')
  return /\bsecond-opinion\.mjs\s+request\b/.test(stripped) ||
         /\bsecond-opinion\.mjs\b[^|;&]*\brequest\b/.test(stripped)
}

function computeSha8(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8)
}

function loadAndValidateRunbook() {
  if (!fs.existsSync(RUNBOOK_PATH)) {
    return { error: 'runbook-missing', detail: RUNBOOK_PATH }
  }
  if (!fs.existsSync(QUICKREF_PATH)) {
    return { error: 'quickref-missing', detail: QUICKREF_PATH }
  }
  let runbook, quickref
  try {
    runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8')
    quickref = fs.readFileSync(QUICKREF_PATH, 'utf8')
  } catch (e) {
    return { error: 'runbook-read-failed', detail: e.message }
  }
  if (runbook.trim().length < MIN_RUNBOOK_BYTES) {
    return { error: 'runbook-too-short' }
  }
  if (!runbook.includes(RUNBOOK_SENTINEL)) {
    return { error: 'runbook-missing-sentinel' }
  }
  if (quickref.trim().length < MIN_QUICKREF_BYTES) {
    return { error: 'quickref-too-short' }
  }
  return { ok: true, runbook, quickref, sha8: computeSha8(runbook) }
}

async function checkRunbookGate(input) {
  const cwd = input.cwd || process.cwd()
  let canonicalRoot = cwd
  const localDirUrl = new URL('./lib/local-dir.mjs', import.meta.url).href
  try {
    const mod = await import(localDirUrl)
    canonicalRoot = mod.resolveRepoRoot(cwd)
  } catch (e) {
    // PR-level review P1: distinguish missing DIRECT target from transitive
    // ERR_MODULE_NOT_FOUND (broken inner import). Only direct-target ENOENT
    // is the "orphan install" case that gets the CWD-fallback degradation.
    // Any other failure mode (transitive missing, syntax error, runtime
    // error) indicates installed-lib corruption → fail closed.
    const isDirectMissing = e.code === 'ERR_MODULE_NOT_FOUND' &&
      typeof e.url === 'string' &&
      e.url === localDirUrl
    if (isDirectMissing) {
      canonicalRoot = cwd
    } else {
      emitBlock(
        `second-opinion runbook gate: local-dir.mjs failed to load ` +
        `(${e.code || e.name}: ${e.message}). The installed lib at ` +
        `~/.claude/hooks/lib/local-dir.mjs appears corrupted (transitive ` +
        `missing dep or syntax/runtime error, NOT just a missing direct ` +
        `target). Run: node install.mjs --tool claude-code --install-second-opinion to reinstall.`,
        { code: 'runbook-canonicalize-failed', detail: e.message }
      )
    }
  }
  const loaded = loadAndValidateRunbook()
  if (loaded.error) {
    emitBlock(
      `second-opinion runbook gate: ${loaded.error}` +
      (loaded.detail ? ` (${loaded.detail})` : '') +
      `. Run: node install.mjs --tool claude-code --install-second-opinion to install/refresh the runbook.`,
      { code: 'runbook-load-failed', detail: loaded.error }
    )
  }
  const markerPath = path.join(
    canonicalRoot, '.checkpoints', `.so-runbook-shown.${loaded.sha8}`
  )
  if (fs.existsSync(markerPath)) emitAllow()

  // Marker absent → block with quickref inlined. Marker is NOT self-written
  // by the hook (codex r2 / r3 design): the model must Read the full runbook
  // and `touch <markerPath>` to acknowledge. The touch passes through
  // command-classifier's touch handler → marker_write → checkpoint-gate's
  // runbook exemption case (canonical-root check + plan-pending bypass).
  emitBlock(
    `${loaded.quickref}\n\n` +
    `=== Full runbook ===\n${RUNBOOK_PATH}\n` +
    `After reading the full runbook, run: touch ${markerPath} — then retry your original command. ` +
    `Marker resets at next SessionStart.`,
    {
      code: 'runbook-injection-required',
      runbook_sha: loaded.sha8,
      runbook_path: RUNBOOK_PATH,
      marker_path: markerPath,
    }
  )
}

// ---------------------------------------------------------------------------
// Provider snapshot helpers — only called for non-harness flow.
// ---------------------------------------------------------------------------

function loadSnapshot(validateProviderRegistry) {
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
  try {
    validateProviderRegistry({ schema_version: 1, providers: parsed.providers })
  } catch (e) {
    return {
      error: 'snapshot-invalid-providers',
      detail: e.message,
      field: e.field,
      provider: e.provider,
    }
  }
  return { snapshot: parsed }
}

function isWorktreeCwd(cwd) {
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

    if (runInBackground) {
      return {
        block: true,
        reason: `Direct provider call (${provider.id}) with run_in_background:true is blocked. ` +
          `Use the second-opinion harness (scripts/second-opinion.mjs request --provider ${provider.id} --dispatch) instead.`,
      }
    }

    if (provider.prompt_max_chars > 0 && command.length > provider.prompt_max_chars) {
      return {
        block: true,
        reason: `Direct provider call (${provider.id}) with prompt length ${command.length} exceeds prompt_max_chars ${provider.prompt_max_chars}. ` +
          `Use the harness which composes prompts with overflow detection.`,
      }
    }

    if (isWorktreeCwd(cwd) && !command.includes('--allow-worktree')) {
      return {
        block: true,
        reason: `Direct provider call (${provider.id}) from linked worktree cwd. ` +
          `Run from canonical repo, OR pass --allow-worktree explicitly.`,
      }
    }
  }

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
// Main — stdin FIRST, runbook gate FIRST, validator LAZY.
// ---------------------------------------------------------------------------

async function main() {
  const input = readStdinSync()
  if (!input) emitAllow()

  const toolName = input.tool_name || ''
  const toolInput = input.tool_input || {}
  const cwd = input.cwd || process.cwd()

  // ─── Timeout-floor + runbook gate fire BEFORE validator/snapshot work. ─
  // Codex r2 P1: validator import failure / snapshot errors MUST NOT
  // preempt the runbook block on harness invocations.
  // Timeout-floor fires FIRST so insufficient-timeout callers get one
  // clear retry instruction instead of being routed through runbook ack
  // and then SIGTERM'd anyway.
  if (toolName === 'Bash' && isHarnessRequest(toolInput.command || '')) {
    let checkTimeoutFloor
    try {
      const mod = await import(new URL('./lib/so-timeout-floor.mjs', import.meta.url).href)
      checkTimeoutFloor = mod.checkTimeoutFloor
    } catch (e) {
      // emitBlock exits process; defensive return keeps next-reader from
      // assuming checkTimeoutFloor is defined below if emitBlock ever
      // changes to non-fatal (negative-scenario-reviewer NIT-1).
      emitBlock(
        `second-opinion-gate: cannot load timeout-floor at ./lib/so-timeout-floor.mjs ` +
        `(detail: ${e.message}). Run: node install.mjs --tool claude-code --install-second-opinion ` +
        `to reinstall the colocated timeout-floor lib.`,
        { code: 'so-timeout-floor-load-failed', detail: e.message }
      )
      return
    }
    const decision = checkTimeoutFloor(toolInput)
    if (decision.block) emitBlock(decision.reason, decision.extra)
    await checkRunbookGate(input)
    return
  }

  // ─── Lazy validator load for non-harness flow. ────────────────────────
  let validateProviderRegistry
  try {
    const mod = await import(new URL('./lib/registry-validator.mjs', import.meta.url).href)
    validateProviderRegistry = mod.validateProviderRegistry
  } catch (e) {
    emitBlock(
      `second-opinion-gate: cannot load validator at ./lib/registry-validator.mjs ` +
      `(detail: ${e.message}). Run: node install.mjs --tool claude-code --install-second-opinion ` +
      `to reinstall the colocated validator lib.`,
      { code: 'snapshot-validator-load-failed', detail: e.message }
    )
  }

  const snap = loadSnapshot(validateProviderRegistry)
  if (snap.error) {
    const extra = { code: snap.error }
    if (snap.field) extra.field = snap.field
    if (snap.provider) extra.provider = snap.provider
    if (snap.detail) extra.detail = snap.detail
    const detailSuffix = snap.field
      ? ` (field: ${snap.field}${snap.provider ? `, provider: ${snap.provider}` : ''})`
      : ''
    emitBlock(
      `second-opinion-gate: ${snap.error}${detailSuffix}. ` +
      `Run: node install.mjs --tool claude-code --install-second-opinion to install/refresh the registry. ` +
      `(Direct provider calls cannot be safely gated without a valid install snapshot.)`,
      extra
    )
  }

  if (toolName === 'Bash') {
    const decision = checkBashBranch(toolInput, cwd, snap.snapshot)
    if (decision.block) emitBlock(decision.reason)
    emitAllow()
  }

  if (toolName === 'Agent' || toolName === 'Task') {
    const decision = checkAgentBranch(toolInput, snap.snapshot)
    if (decision.block) emitBlock(decision.reason)
    emitAllow()
  }

  emitAllow()
}

main()
