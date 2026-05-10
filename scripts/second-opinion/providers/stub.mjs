/**
 * stub.mjs — Stub provider for testing the second-opinion harness end-to-end.
 *
 * In-process synchronous "provider" that returns a deterministic reply
 * referencing the prompt content (so I-7 mock-block-until-reply tests can
 * verify the harness wrote the reply before exiting).
 *
 * Used ONLY in tests; never installed for production use.
 */

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
export function dispatch({ prompt, projectRoot }) {
  if (!prompt) throw new Error('stub.dispatch: prompt is required')
  if (!projectRoot) throw new Error('stub.dispatch: projectRoot is required')

  // Pull request_id from prompt if present (matches em-store id format).
  const idMatch = prompt.match(/(\d{8}-\d{6}-[a-z0-9-]+-[0-9a-f]{4})/)
  const requestId = idMatch ? idMatch[1] : 'unknown-request'

  const replyBody = `# Stub provider reply (test fixture)

Request: ${requestId}
Prompt length: ${prompt.length} chars
Verdict: ACCEPT (synthetic)

This is a stub-provider reply emitted in-process for testing the harness
end-to-end without requiring a real provider CLI binary.

\`\`\`json:second-opinion-summary
{
  "final_verdict": "ACCEPT",
  "findings": [],
  "spec_cycle_signal": null
}
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
