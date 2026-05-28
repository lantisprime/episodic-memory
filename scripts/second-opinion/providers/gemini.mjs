/**
 * gemini.mjs — Gemini CLI provider for the second-opinion harness.
 *
 * Provider contract (per v3 §Provider availability):
 *   available()  → { ok, reason? }
 *   dispatch()   → { ok, exitCode, stdout, stderr, timedOut, error }
 *
 * Mechanism: invokes `gemini` CLI with composed prompt. Gemini has no
 * agent loader, so the gemini-ladder-v1 fragment ships the full review
 * ladder inline.
 *
 * Per v3 §Bypass: same as codex/claude-subagent — invoked from harness
 * Node via spawnSync; not seen by Claude Code PreToolUse hook.
 */

import { spawnSync } from 'node:child_process'

const HELP_SIGNATURE = /\bgemini\b/i

export const id = 'gemini'
export const binary = 'gemini'

export function available() {
  const which = spawnSync('which', [binary], {
    shell: false, stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (which.status !== 0) return { ok: false, reason: 'cli-not-found' }

  const help = spawnSync(binary, ['--help'], {
    shell: false, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  })
  if (help.status !== 0) {
    return { ok: false, reason: 'cli-help-failed', exitCode: help.status }
  }
  if (!HELP_SIGNATURE.test(help.stdout.toString())) {
    return {
      ok: false, reason: 'cli-help-signature-mismatch',
      expected: String(HELP_SIGNATURE),
    }
  }
  return { ok: true }
}

export function dispatch({ prompt, projectRoot, timeout = 600000 }) {
  if (!prompt) throw new Error('gemini.dispatch: prompt is required')
  if (!projectRoot) throw new Error('gemini.dispatch: projectRoot is required')

  // Gemini CLI invocation pattern: pass prompt as positional argument.
  // Surface may differ by version (some use --prompt or -p). Default
  // pattern uses positional + flags; revise per gemini --help on first
  // real probe.
  const result = spawnSync(binary, [prompt], {
    cwd: projectRoot,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
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
