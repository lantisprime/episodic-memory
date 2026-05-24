#!/usr/bin/env node
/**
 * test-so-gate-timeout-floor.mjs — unit tests for so-timeout-floor.mjs.
 *
 * Tests the pure helpers (tokenizeCommand, splitTopLevelSegments,
 * checkTimeoutFloor) over the negative-scenario matrix A1-A38 from
 * plan v5. Integration with the installed hook lives in
 * test-so-gate-timeout-floor-integration.mjs.
 */

import {
  TIMEOUT_FLOOR_MS,
  tokenizeCommand,
  splitTopLevelSegments,
  checkTimeoutFloor,
} from '../hooks/lib/so-timeout-floor.mjs'

let passes = 0
let failures = 0

function assertEq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passes++
  } else {
    failures++
    console.error(`FAIL ${label}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

function assertBlock(label, toolInput, expectedCode) {
  const r = checkTimeoutFloor(toolInput)
  if (!r.block) {
    failures++
    console.error(`FAIL ${label}\n  expected block (code=${expectedCode})\n  got: ${JSON.stringify(r)}`)
    return
  }
  if (r.extra?.code !== expectedCode) {
    failures++
    console.error(`FAIL ${label}\n  expected code=${expectedCode}\n  got code=${r.extra?.code}`)
    return
  }
  passes++
}

function assertAllow(label, toolInput) {
  const r = checkTimeoutFloor(toolInput)
  if (r.block) {
    failures++
    console.error(`FAIL ${label}\n  expected allow\n  got block: ${JSON.stringify(r)}`)
    return
  }
  passes++
}

// ───────── tokenizeCommand ─────────

assertEq('tokenize: empty',
  tokenizeCommand(''),
  [])

assertEq('tokenize: bare flags',
  tokenizeCommand('node scripts/second-opinion.mjs request --provider codex --dispatch'),
  ['node', 'scripts/second-opinion.mjs', 'request', '--provider', 'codex', '--dispatch'])

assertEq('tokenize: single-quoted body preserved',
  tokenizeCommand("node x --body 'hello world' --dispatch"),
  ['node', 'x', '--body', 'hello world', '--dispatch'])

assertEq('tokenize: double-quoted body preserved',
  tokenizeCommand('node x --body "hello world" --dispatch'),
  ['node', 'x', '--body', 'hello world', '--dispatch'])

assertEq('tokenize: backslash escape outside quotes',
  tokenizeCommand('node x --body hello\\ world --dispatch'),
  ['node', 'x', '--body', 'hello world', '--dispatch'])

assertEq('tokenize: double-quote with backslash escape',
  tokenizeCommand('node x --body "hello \\"quoted\\" world"'),
  ['node', 'x', '--body', 'hello "quoted" world'])

assertEq('tokenize: tabs and newlines as separators',
  tokenizeCommand('node\tx\n--dispatch'),
  ['node', 'x', '--dispatch'])

assertEq('tokenize: multiple consecutive whitespace',
  tokenizeCommand('node    x   --dispatch'),
  ['node', 'x', '--dispatch'])

// ───────── splitTopLevelSegments ─────────

assertEq('split: no separator',
  splitTopLevelSegments('node x --dispatch'),
  ['node x --dispatch'])

assertEq('split: semicolon',
  splitTopLevelSegments('a ; b'),
  ['a ', ' b'])

assertEq('split: &&',
  splitTopLevelSegments('a && b'),
  ['a ', ' b'])

assertEq('split: ||',
  splitTopLevelSegments('a || b'),
  ['a ', ' b'])

assertEq('split: pipe',
  splitTopLevelSegments('a | b'),
  ['a ', ' b'])

assertEq('split: background &',
  splitTopLevelSegments('a & b'),
  ['a ', ' b'])

assertEq('split: separator inside double-quotes is opaque',
  splitTopLevelSegments('a "x;y&&z" b'),
  ['a "x;y&&z" b'])

assertEq('split: separator inside single-quotes is opaque',
  splitTopLevelSegments("a 'x;y&&z' b"),
  ["a 'x;y&&z' b"])

assertEq('split: backslash-escaped semicolon',
  splitTopLevelSegments('a \\; b'),
  ['a \\; b'])

// ───────── checkTimeoutFloor ─────────

const harnessCmd = 'node scripts/second-opinion.mjs request --provider codex --dispatch --body x'
const harnessConsensus = 'node scripts/second-opinion.mjs request --provider codex --consensus --max-rounds 3 --body x'

// A1: happy path — sufficient timeout
assertAllow('A1: timeout >= floor allows',
  { command: harnessCmd, timeout: 600000 })

// A2: above floor
assertAllow('A2: timeout > floor allows',
  { command: harnessCmd, timeout: 900000 })

// A3: default Bash timeout blocks
assertBlock('A3: default 120000 timeout blocks',
  { command: harnessCmd, timeout: 120000 },
  'so-timeout-below-floor')

// A4: missing timeout field treated as 120000
assertBlock('A4: missing timeout treated as default',
  { command: harnessCmd },
  'so-timeout-below-floor')

// A5: timeout = 1
assertBlock('A5: very small timeout blocks',
  { command: harnessCmd, timeout: 1 },
  'so-timeout-below-floor')

// A6: timeout exactly at floor
assertAllow('A6: timeout exactly == floor allows',
  { command: harnessCmd, timeout: TIMEOUT_FLOOR_MS })

// A7: non-harness command — pure passthrough
assertAllow('A7: non-harness Bash unaffected',
  { command: 'ls -la', timeout: 100 })

// A8: harness but no --dispatch / --consensus
assertAllow('A8: harness without --dispatch allowed',
  { command: 'node scripts/second-opinion.mjs request --provider codex --body x', timeout: 100 })

// A9: stub carve-out
assertAllow('A9: stub provider exempt',
  { command: 'node scripts/second-opinion.mjs request --provider stub --dispatch --body x', timeout: 100 })

// A10: stub + consensus carve-out
assertAllow('A10: stub provider exempt under consensus',
  { command: 'node scripts/second-opinion.mjs request --provider stub --consensus --body x', timeout: 100 })

// A11: gemini provider blocked below floor
assertBlock('A11: gemini provider blocked below floor',
  { command: 'node scripts/second-opinion.mjs request --provider gemini --dispatch --body x', timeout: 120000 },
  'so-timeout-below-floor')

// A12: claude-subagent provider blocked below floor
assertBlock('A12: claude-subagent provider blocked below floor',
  { command: 'node scripts/second-opinion.mjs request --provider claude-subagent --dispatch --body x', timeout: 120000 },
  'so-timeout-below-floor')

// A13: consensus mode (implicit --dispatch)
assertBlock('A13: --consensus below floor blocks',
  { command: harnessConsensus, timeout: 120000 },
  'so-timeout-below-floor')

// A14: consensus mode at floor
assertAllow('A14: --consensus at floor allows',
  { command: harnessConsensus, timeout: TIMEOUT_FLOOR_MS })

// A15: first --provider wins (stub-then-codex bypass attempt within one argv)
assertAllow('A15: first --provider stub wins across duplicate (one argv)',
  { command: 'node scripts/second-opinion.mjs request --provider stub --provider codex --dispatch --body x', timeout: 100 })
// Mirrors harness's argv.indexOf semantics — this is intentional and documented.

// A16: codex first, stub second — codex wins
assertBlock('A16: first --provider codex wins across duplicate (one argv)',
  { command: 'node scripts/second-opinion.mjs request --provider codex --provider stub --dispatch --body x', timeout: 100 },
  'so-timeout-below-floor')

// A17: compound bypass — stub segment then codex segment with ;
assertBlock('A17: compound ; — codex segment caught',
  { command: 'node scripts/second-opinion.mjs request --provider stub --body x ; node scripts/second-opinion.mjs request --provider codex --dispatch --body y', timeout: 100 },
  'so-timeout-below-floor')

// A18: compound &&
assertBlock('A18: compound && — codex segment caught',
  { command: 'node scripts/second-opinion.mjs request --provider stub --body x && node scripts/second-opinion.mjs request --provider codex --dispatch --body y', timeout: 100 },
  'so-timeout-below-floor')

// A19: compound ||
assertBlock('A19: compound || — codex segment caught',
  { command: 'node scripts/second-opinion.mjs request --provider stub --body x || node scripts/second-opinion.mjs request --provider codex --dispatch --body y', timeout: 100 },
  'so-timeout-below-floor')

// A20: pipe
assertBlock('A20: pipe — codex segment caught',
  { command: 'echo y | node scripts/second-opinion.mjs request --provider codex --dispatch --body x', timeout: 100 },
  'so-timeout-below-floor')

// A21: background &
assertBlock('A21: background & — codex segment caught',
  { command: 'sleep 1 & node scripts/second-opinion.mjs request --provider codex --dispatch --body x', timeout: 100 },
  'so-timeout-below-floor')

// A22: command empty
assertAllow('A22: empty command allowed',
  { command: '', timeout: 100 })

// A23: command undefined / non-string
assertAllow('A23: non-string command allowed',
  { command: null, timeout: 100 })

// A24: timeout non-numeric → defaults
assertBlock('A24: non-numeric timeout treated as default (120000)',
  { command: harnessCmd, timeout: 'fast' },
  'so-timeout-below-floor')

// A25: extra block fields surfaced
{
  const r = checkTimeoutFloor({ command: harnessCmd, timeout: 100 })
  assertEq('A25: extra has code', r.extra?.code, 'so-timeout-below-floor')
  assertEq('A25: extra has floorMs', r.extra?.floorMs, TIMEOUT_FLOOR_MS)
  assertEq('A25: extra has gotMs', r.extra?.gotMs, 100)
  assertEq('A25: extra has provider', r.extra?.provider, 'codex')
}

// A26: --provider with malformed value (next token is itself a flag) — not 'stub' → block
{
  const r = checkTimeoutFloor({ command: 'node scripts/second-opinion.mjs request --provider --dispatch', timeout: 100 })
  // tokens after --provider is '--dispatch' which is treated as the provider value (not 'stub') → block
  if (!r.block) {
    failures++
    console.error(`FAIL A26 expected block, got ${JSON.stringify(r)}`)
  } else {
    passes++
  }
}

// A27: --provider at end (no value)
{
  const r = checkTimeoutFloor({ command: 'node scripts/second-opinion.mjs request --dispatch --provider', timeout: 100 })
  // provIdx + 1 >= tokens.length → firstProvider = null → not stub → block
  if (!r.block) {
    failures++
    console.error(`FAIL A27 expected block, got ${JSON.stringify(r)}`)
  } else {
    passes++
  }
}

// A28: --dispatch present but no --provider at all → firstProvider null → block (default codex assumption)
{
  const r = checkTimeoutFloor({ command: 'node scripts/second-opinion.mjs request --dispatch --body x', timeout: 100 })
  if (!r.block) {
    failures++
    console.error(`FAIL A28 expected block (no provider = not stub), got ${JSON.stringify(r)}`)
  } else {
    passes++
  }
}

// A29: env-prefix before node
assertBlock('A29: env-prefix VAR=x node ... blocks',
  { command: 'FOO=bar node scripts/second-opinion.mjs request --provider codex --dispatch --body x', timeout: 100 },
  'so-timeout-below-floor')

// A30: absolute path to second-opinion.mjs
assertBlock('A30: absolute-path harness invocation blocks',
  { command: '/Users/x/scripts/second-opinion.mjs request --provider codex --dispatch --body y', timeout: 100 },
  'so-timeout-below-floor')

// A31: single-quoted --body containing a separator
assertBlock('A31: single-quoted body with ; inside is opaque',
  { command: "node scripts/second-opinion.mjs request --provider codex --dispatch --body 'review; this'", timeout: 100 },
  'so-timeout-below-floor')

// A32: double-quoted --body containing a separator
assertBlock('A32: double-quoted body with && inside is opaque',
  { command: 'node scripts/second-opinion.mjs request --provider codex --dispatch --body "review && this"', timeout: 100 },
  'so-timeout-below-floor')

// A33: harness as one segment, stub provider, second segment unrelated
assertAllow('A33: harness stub then unrelated command allowed',
  { command: 'node scripts/second-opinion.mjs request --provider stub --dispatch --body x ; ls', timeout: 100 })

// A34: harness as second segment after unrelated first
assertBlock('A34: unrelated first then harness codex dispatch second blocks',
  { command: 'ls ; node scripts/second-opinion.mjs request --provider codex --dispatch --body x', timeout: 100 },
  'so-timeout-below-floor')

// A35: multiple --dispatch tokens — still blocks
assertBlock('A35: duplicate --dispatch blocks',
  { command: 'node scripts/second-opinion.mjs request --provider codex --dispatch --dispatch --body x', timeout: 100 },
  'so-timeout-below-floor')

// A36: --max-rounds in consensus (extra args)
assertBlock('A36: consensus with --max-rounds blocks below floor',
  { command: 'node scripts/second-opinion.mjs request --provider codex --consensus --max-rounds 5 --body x', timeout: 100 },
  'so-timeout-below-floor')

// A37: stub provider with consensus (still allowed)
assertAllow('A37: stub --consensus allowed',
  { command: 'node scripts/second-opinion.mjs request --provider stub --consensus --max-rounds 3 --body x', timeout: 100 })

// A38: DEFER — quoted command substitution hides --dispatch token (documented limitation)
{
  // The whole "$(...)" is one quoted token; --dispatch is not a top-level token.
  // The substring-level isHarnessRequest() in the gate would still detect it,
  // but timeout-floor's token-level matcher cannot enforce the floor.
  // This test ASSERTS the limitation: we ALLOW (i.e., floor does not fire).
  const r = checkTimeoutFloor({
    command: 'echo "$(node scripts/second-opinion.mjs request --provider codex --dispatch --body x)"',
    timeout: 100,
  })
  if (r.block) {
    failures++
    console.error(`FAIL A38 (documented limitation): expected allow, got block`)
  } else {
    passes++
  }
}

console.log(`\n${passes} pass, ${failures} fail`)
if (failures > 0) process.exit(1)
