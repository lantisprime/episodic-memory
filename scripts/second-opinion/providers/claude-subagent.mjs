/**
 * claude-subagent.mjs — Claude Code subagent provider for the second-opinion harness.
 *
 * Provider contract (per v3 §Provider availability):
 *   available()  → { ok, reason? }
 *   dispatch()   → { ok, exitCode, stdout, stderr, timedOut }
 *
 * Mechanism: invokes `claude` CLI with the composed prompt as the
 * subagent's task. The `negative-scenario-reviewer` subagent has its own
 * agent loader for toolkit disciplines, so the claude-subagent fragment
 * (claude-subagent-loader-ref) is short and references the loader.
 *
 * Note: this is a thin wrapper over `claude` CLI. The actual subagent
 * orchestration (which subagent to dispatch, what tools it has) is the
 * Claude CLI's responsibility — we just pass the prompt and capture stdout.
 *
 * Per v3 §Bypass: this provider is invoked from the harness Node process
 * via spawnSync — Claude Code's PreToolUse hook does NOT see this child
 * call (the hook sees the OUTER `node second-opinion.mjs` invocation).
 */

import { spawnSync } from 'node:child_process'

const HELP_SIGNATURE = /\bclaude\b/i

export const id = 'claude-subagent'
export const binary = 'claude'

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
  if (!prompt) throw new Error('claude-subagent.dispatch: prompt is required')
  if (!projectRoot) throw new Error('claude-subagent.dispatch: projectRoot is required')

  // Claude CLI invocation pattern: pipe prompt via stdin, request the
  // negative-scenario-reviewer subagent. Surface differs by Claude CLI
  // version; safest portable pattern is `claude -p <prompt>` for
  // single-shot non-interactive runs. For subagent dispatch specifically,
  // use the `--agent` or task-tool surface; v1 keeps it simple as `-p`.
  const result = spawnSync(binary, ['-p', prompt], {
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
  }
}
