/**
 * codex.mjs — Codex CLI provider for the second-opinion harness.
 *
 * Provider contract (per v3 §Provider availability):
 *   available()  → { ok, reason? } — checks CLI binary on PATH + --help signature
 *   dispatch()   → { ok, exitCode, stdout, stderr, timedOut, error } — runs codex exec
 *                 with explicit cwd: projectRoot, shell: false
 *
 * Auto-background mitigation: passes stdin: 'ignore' so codex sees stdin EOF
 * immediately and doesn't hang waiting for input (see session 2026-05-10
 * lesson — codex hangs when stdin is a pipe without EOF).
 *
 * Per v3 §Bypass: this provider is invoked from the harness Node process via
 * spawnSync — Claude Code's PreToolUse hook does NOT see this child call
 * (the hook sees the OUTER `node second-opinion.mjs` invocation).
 */

import { spawnSync } from 'node:child_process'

const HELP_SIGNATURE = /\bUsage:\s+codex\s+exec\b/

export const id = 'codex'
export const binary = 'codex'

export function available() {
  // 1. Binary on PATH.
  const which = spawnSync('which', [binary], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
  if (which.status !== 0) return { ok: false, reason: 'cli-not-found' }

  // 2. --help parses + matches expected signature.
  const help = spawnSync(binary, ['exec', '--help'], {
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  })
  if (help.status !== 0) {
    return { ok: false, reason: 'cli-help-failed', exitCode: help.status }
  }
  if (!HELP_SIGNATURE.test(help.stdout.toString())) {
    return {
      ok: false,
      reason: 'cli-help-signature-mismatch',
      expected: String(HELP_SIGNATURE),
    }
  }
  return { ok: true }
}

/**
 * dispatch — Run `codex exec` synchronously and capture exit + stdout.
 *
 * Args: {
 *   prompt: string,        // composed preamble + body (full prompt text)
 *   projectRoot: string,   // explicit cwd for spawnSync (NEVER inherit)
 *   timeout?: number,      // milliseconds (default 600000 = 10 min)
 * }
 *
 * Returns: {
 *   ok: boolean,
 *   exitCode: number | null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   error: string | null,   // spawn-failure message (ENOENT / bad cwd), else null
 * }
 *
 * Note: writing the reply episode is the harness's responsibility. This
 * function returns the raw codex stdout/stderr; harness parses + persists.
 */
export function dispatch({ prompt, projectRoot, timeout = 600000 }) {
  if (!prompt) throw new Error('codex.dispatch: prompt is required')
  if (!projectRoot) throw new Error('codex.dispatch: projectRoot is required')

  const result = spawnSync(binary, ['exec', '--skip-git-repo-check', prompt], {
    cwd: projectRoot,           // CRITICAL: explicit cwd (I-6)
    shell: false,               // CRITICAL: no shell interpretation (I-6)
    stdio: ['ignore', 'pipe', 'pipe'],   // stdin: ignore → codex sees EOF immediately
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
