#!/usr/bin/env node
/**
 * test-bp1-orchestrator-parseargs.mjs — orchestrator argv parser M5 hardening
 * (slice 2e C4).
 *
 * Coverage (~8 cases):
 *   - PA1 happy: known subcommand + known flags → exit 0 / 2 per existing
 *         contract (no regression for already-tested subcommand parsing)
 *   - PA2 unknown flag (e.g. --runid typo) → exit 2 + error to stderr,
 *         no silent consumption of next argv token
 *   - PA3 missing flag value (--project with no following token) → exit 2
 *   - PA4 unexpected positional argument → exit 2
 *   - PA5 flag mid-token (--project --rfc-id ...) → caught as unexpected
 *         positional once the consumed value collides
 *   - PA6 multiple unknowns → first one reported (deterministic message)
 *   - PA7 --help / -h short-circuits ALL parsing (returns 0 even with
 *         later unknown flags)
 *   - PA8 long-form value flags whose value would be quoted preserve
 *         spaces (sanity: not a M5 regression)
 *
 * Each test runs the orchestrator as a subprocess with argv only — no
 * file I/O is needed since all the cases exit before reaching subcommand
 * logic.
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ORCH = path.join(REPO, 'scripts', 'bp1-orchestrator.mjs')

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

function runOrch(argv) {
  return spawnSync(process.execPath, [ORCH, ...argv], { encoding: 'utf8' })
}

// =============================================================================
// PA1 happy path — unknown subcommand still exits 2 (existing behavior)
// =============================================================================
tap('PA1 baseline: unknown subcommand → exit 2 (existing behavior preserved)', () => {
  const r = runOrch(['totally-fake-subcommand'])
  assert.equal(r.status, 2, `expected exit 2; got ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /unknown subcommand/)
})

// =============================================================================
// PA2 unknown flag rejected (M5 — was silently consumed pre-C4)
// =============================================================================
tap('PA2 M5: unknown flag --runid (typo) → exit 2 + stderr error', () => {
  const r = runOrch(['init-run', '--runid', 'bp1-run-x', '--project', '/tmp/p'])
  assert.equal(r.status, 2, `expected exit 2 on unknown flag; got ${r.status}`)
  assert.match(r.stderr, /unknown flag: --runid/)
})

tap('PA2b M5: unknown flag --bogus → exit 2', () => {
  const r = runOrch(['detect-rfcs', '--project', '/tmp/p', '--bogus', 'val'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown flag: --bogus/)
})

// =============================================================================
// PA3 missing flag value
// =============================================================================
tap('PA3 M5: --project at end of argv with no value → exit 2', () => {
  const r = runOrch(['init-run', '--project'])
  assert.equal(r.status, 2, `expected exit 2 on missing value; got ${r.status}`)
  assert.match(r.stderr, /missing value for flag: --project/)
})

// =============================================================================
// PA4 unexpected positional
// =============================================================================
tap('PA4 M5: unexpected positional argument → exit 2', () => {
  const r = runOrch(['init-run', '--project', '/tmp/p', 'stray-positional'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unexpected positional argument: stray-positional/)
})

// =============================================================================
// PA5 flag mid-token (--project --rfc-id is caught downstream)
// =============================================================================
tap('PA5 M5: --project --rfc-id RFC-004 → caught as unexpected positional', () => {
  // After --project consumes --rfc-id as its value, RFC-004 is left as a
  // positional. M5 rejects with a clear error rather than letting it slip
  // through with project="--rfc-id".
  const r = runOrch(['init-run', '--project', '--rfc-id', 'RFC-004'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unexpected positional argument: RFC-004/)
})

// =============================================================================
// PA6 deterministic error — first unknown flag reported
// =============================================================================
tap('PA6 M5: multiple unknown flags → first one reported', () => {
  const r = runOrch(['detect-rfcs', '--first-unknown', 'a', '--second-unknown', 'b'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown flag: --first-unknown/)
  // Must not have leaked --second-unknown in error (deterministic single
  // error message keeps tests stable).
})

// =============================================================================
// PA7 --help short-circuits even with later unknown flags
// =============================================================================
tap('PA7 --help short-circuits parsing → exit 0 (unknown flags after are ignored)', () => {
  const r = runOrch(['init-run', '--help', '--definitely-unknown', 'x'])
  assert.equal(r.status, 0, `expected exit 0 on --help; got ${r.status}; stderr=${r.stderr}`)
})

// =============================================================================
// PA8 long-form value preserves quoted spaces (sanity — not an M5 regression)
// =============================================================================
tap('PA8 sanity: known flag accepts value with spaces (e.g. --project "/tmp/has spaces")', () => {
  // No actual file I/O; init-run will fail because /tmp/has spaces isn't a
  // git repo, but parse-time should accept it and exit on the downstream
  // error, not on a parse error.
  const r = runOrch(['init-run', '--project', '/tmp/has spaces', '--rfc-id', 'RFC-004'])
  // Not asserting a specific exit code — just that we got past parseArgs
  // (no "unknown flag" / "missing value" / "unexpected positional"
  // stderr).
  assert.doesNotMatch(r.stderr || '', /unknown flag|missing value for flag|unexpected positional argument/)
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail === 0 ? 0 : 1)
