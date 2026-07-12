/**
 * stub.mjs — Stub provider for testing the second-opinion harness end-to-end.
 *
 * In-process synchronous "provider" that returns a deterministic reply
 * referencing the prompt content (so I-7 mock-block-until-reply tests can
 * verify the harness wrote the reply before exiting).
 *
 * Used ONLY in tests; never installed for production use.
 */

import { spawnSync } from 'node:child_process'

export const id = 'stub'
export const binary = 'stub-provider'

export function available() {
  return { ok: true }
}

/**
 * dispatch — Synchronous in-process "provider" that echoes prompt info.
 *
 * Returns a fake reply body containing:
 *   - request_id (extracted from prompt)
 *   - prompt length
 *   - synthetic verdict (default ACCEPT)
 *   - canonical fenced JSON block per v3 §Consensus-loop v3 contract
 */
/**
 * dispatch — Configurable for tests via env vars:
 *   SO_STUB_VERDICT — one of ACCEPT, HOLD, REJECT, ACCEPT-with-FU (default ACCEPT)
 *   SO_STUB_DEFER_COUNT — number of HOLD rounds before flipping to ACCEPT.
 *     Used in conjunction with SO_STUB_VERDICT=HOLD to test consensus loops.
 *     Counter is incremented across calls within the same harness process via
 *     a module-scope variable.
 *   SO_STUB_FINDING_SEVERITY — for HOLD/ACCEPT-with-FU, the severity to attach
 *     to the synthetic finding (P1/P2/P3, default P2).
 *   SO_STUB_FINDING_STATUS — synthetic finding status (ACCEPT-OK, NEEDS-MORE-WORK,
 *     NEW-CONCERN, DEFERRED-AS-FU). Default NEEDS-MORE-WORK.
 *   SO_STUB_SPEC_CYCLE — '1' to emit spec_cycle_signal: 'trigger-met'.
 */

let _callCount = 0

export function dispatch({ prompt, projectRoot, timeout }) {
  if (!prompt) throw new Error('stub.dispatch: prompt is required')
  if (!projectRoot) throw new Error('stub.dispatch: projectRoot is required')

  _callCount++

  // SO_STUB_SLEEP_MS (A.5): simulate a slow provider via a REAL child so the
  // spawnSync timeout/kill semantics match codex.mjs:74-86 exactly.
  const sleepMs = parseInt(process.env.SO_STUB_SLEEP_MS || '0', 10)
  const sleepOnCall = parseInt(process.env.SO_STUB_SLEEP_ON_CALL || '0', 10)
  if (Number.isInteger(sleepMs) && sleepMs > 0 && (sleepOnCall === 0 || _callCount === sleepOnCall)) {
    const sleeper = "if (process.env.SO_STUB_PID_FILE) require('node:fs').writeFileSync(process.env.SO_STUB_PID_FILE, String(process.pid)); process.stdout.write('stub-sleeper-partial'); setTimeout(() => {}, parseInt(process.env.SO_STUB_SLEEP_MS, 10))"
    const child = spawnSync(process.execPath, ['-e', sleeper], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      ...(timeout === undefined ? {} : { timeout }),
    })
    if (child.signal === 'SIGTERM' && child.error?.code === 'ETIMEDOUT') {
      return { ok: false, exitCode: null, stdout: child.stdout || '', stderr: child.stderr || '', timedOut: true }
    }
  }

  const idMatch = prompt.match(/(\d{8}-\d{6}-[a-z0-9-]+-[0-9a-f]{4})/)
  const requestId = idMatch ? idMatch[1] : 'unknown-request'

  // Resolve effective verdict: SO_STUB_DEFER_COUNT lets the stub emit HOLD
  // for N calls then flip to ACCEPT. Used to test consensus loop convergence.
  let verdict = process.env.SO_STUB_VERDICT || 'ACCEPT'
  const deferCount = parseInt(process.env.SO_STUB_DEFER_COUNT || '0', 10)
  if (deferCount > 0 && verdict === 'HOLD' && _callCount > deferCount) {
    verdict = 'ACCEPT'
  }

  const severity = process.env.SO_STUB_FINDING_SEVERITY || 'P2'
  const status = process.env.SO_STUB_FINDING_STATUS || 'NEEDS-MORE-WORK'
  const specCycle = process.env.SO_STUB_SPEC_CYCLE === '1'

  let findings = []
  if (verdict === 'HOLD' || verdict === 'REJECT') {
    findings = [{ id: 'F1', class: 'safety', severity, status }]
  } else if (verdict === 'ACCEPT-with-FU') {
    findings = [{ id: 'F1', class: 'doc', severity: 'P3', status: 'DEFERRED-AS-FU' }]
  }

  const summary = {
    final_verdict: verdict,
    findings,
    spec_cycle_signal: specCycle ? 'trigger-met' : null,
  }

  const replyBody = `# Stub provider reply (test fixture)

Request: ${requestId}
Prompt length: ${prompt.length} chars
Call count: ${_callCount}
Verdict: ${verdict} (synthetic)

\`\`\`json:second-opinion-summary
${JSON.stringify(summary, null, 2)}
\`\`\`
`

  return {
    ok: true,
    exitCode: 0,
    stdout: replyBody,
    stderr: '',
    timedOut: false,
  }
}

// For tests — reset call counter between runs.
export function __resetCallCount() {
  _callCount = 0
}
