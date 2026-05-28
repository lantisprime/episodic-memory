/**
 * opencode.mjs — OpenCode CLI provider for the second-opinion harness.
 *
 * Provider contract (per v3 §Provider availability — same as codex/gemini):
 *   available()  → { ok, reason? } — checks CLI binary on PATH + --help signature
 *   dispatch()   → { ok, exitCode, stdout, stderr, timedOut }
 *
 * Mechanism: invokes `opencode run -m <model> <prompt>` non-interactively.
 * OpenCode is an agentic CLI; `run` is its one-shot (non-TUI) entry point and
 * prints the model's formatted response to stdout, which the harness captures
 * and persists as the review reply.
 *
 * Model: defaults to deepseek/deepseek-v4-pro (the requested model), overridable
 * via OPENCODE_MODEL for operators who want a different provider/model pair.
 * Format is `provider/model` per `opencode run -m`.
 *
 * Per v3 §Bypass: invoked from harness Node via spawnSync — Claude Code's
 * PreToolUse hook does NOT see this child call (the hook sees the OUTER
 * `node second-opinion.mjs` invocation). The registry's cli_match is scoped to
 * `^opencode\s+run\b` so the gate blocks only direct `opencode run` Bash calls,
 * not the interactive TUI or other subcommands.
 */

import { spawnSync } from 'node:child_process'

const HELP_SIGNATURE = /\bopencode\s+run\b/
const DEFAULT_MODEL = 'deepseek/deepseek-v4-pro'

export const id = 'opencode'
export const binary = 'opencode'
// Resolved once at module-load time. The harness imports each provider module
// exactly once per process, so OPENCODE_MODEL is read at import — a mid-process
// env change would not be observed (acceptable: one import per dispatch run).
export const model = process.env.OPENCODE_MODEL || DEFAULT_MODEL

export function available() {
  // 1. Binary on PATH.
  const which = spawnSync('which', [binary], {
    shell: false, stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (which.status !== 0) return { ok: false, reason: 'cli-not-found' }

  // 2. --help parses + matches expected signature (the `run` subcommand).
  //    OpenCode prints --help to STDERR (not stdout — verified empirically:
  //    `opencode --help 2>/dev/null` is empty), so capture BOTH streams and
  //    test the signature against their concatenation.
  const help = spawnSync(binary, ['--help'], {
    shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  })
  if (help.status !== 0) {
    return { ok: false, reason: 'cli-help-failed', exitCode: help.status }
  }
  const helpText = `${help.stdout ? help.stdout.toString() : ''}${help.stderr ? help.stderr.toString() : ''}`
  if (!HELP_SIGNATURE.test(helpText)) {
    return {
      ok: false, reason: 'cli-help-signature-mismatch',
      expected: String(HELP_SIGNATURE),
    }
  }
  return { ok: true }
}

/**
 * dispatch — Run `opencode run -m <model> <prompt>` synchronously.
 *
 * Args: {
 *   prompt: string,        // composed preamble + body (full prompt text)
 *   projectRoot: string,   // explicit cwd for spawnSync (NEVER inherit)
 *   timeout?: number,      // milliseconds (default 600000 = 10 min)
 * }
 *
 * Returns: { ok, exitCode, stdout, stderr, timedOut, error }
 *   error is the spawn-failure message (ENOENT / bad cwd) or null on success.
 *
 * Note: writing the reply episode is the harness's responsibility. This
 * function returns the raw opencode stdout/stderr; harness parses + persists.
 */
export function dispatch({ prompt, projectRoot, timeout = 600000 }) {
  if (!prompt) throw new Error('opencode.dispatch: prompt is required')
  if (!projectRoot) throw new Error('opencode.dispatch: projectRoot is required')

  const result = spawnSync(binary, ['run', '-m', model, prompt], {
    cwd: projectRoot,           // CRITICAL: explicit cwd (I-6)
    shell: false,               // CRITICAL: no shell interpretation (I-6)
    stdio: ['ignore', 'pipe', 'pipe'],   // stdin: ignore → no hang waiting on input
    timeout,
  })

  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout ? result.stdout.toString() : '',
    stderr: result.stderr ? result.stderr.toString() : '',
    timedOut: result.signal === 'SIGTERM' && result.error?.code === 'ETIMEDOUT',
    // Surface spawn failures (ENOENT / bad cwd) instead of discarding them —
    // status is null on a spawn error, so ok=false but the cause was lost (FU-001).
    error: result.error ? result.error.message : null,
  }
}
