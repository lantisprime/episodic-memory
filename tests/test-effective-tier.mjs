#!/usr/bin/env node
// test-effective-tier.mjs — RFC-008 P3b-2 (R3). Pins the tier algebra extracted
// into scripts/lib/effective-tier.mjs: the TWO folds (validator null-on-absent vs
// enforce-contract base-STRONG never-null — F-CLOSE-1/F-NEW-2), clamp-DOWN-only
// semantics (B1), the gate→event / gate→contract-key maps (B5/F-NEW-1), and the
// events.json action lookup. The "a stop clamp degrades the live decideStop
// refuse / a post_checkpoint clamp does NOT" integration lives in
// test-enforce-config.mjs (it needs the config loader + decideStop).

import {
  TIER_RANK,
  GATE_EVENT_MAP,
  GATE_CONTRACT_KEY,
  LIVE_GATES,
  effectiveTier,
  clampTier,
  effectiveTierStrong,
  eventActionId,
} from '../scripts/lib/effective-tier.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(name) { pass++; console.log(`  ✓ ${name}`) }
function bad(name, detail) { fail++; failures.push(`${name}: ${detail}`); console.log(`  ✗ ${name}: ${detail}`) }
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) ok(name); else bad(name, `expected ${e}, got ${a}`)
}

console.log('=== TIER_RANK ordering ===')
eq('STRONG > MEDIUM > WEAK > TBD', TIER_RANK.STRONG > TIER_RANK.MEDIUM && TIER_RANK.MEDIUM > TIER_RANK.WEAK && TIER_RANK.WEAK > TIER_RANK.TBD, true)

console.log('')
console.log('=== effectiveTier (VALIDATOR fold — null on all-absent, pinned) ===')
eq('all-absent → null (em-dash render depends on this)', effectiveTier([null, null]), null)
eq('empty list → null', effectiveTier([]), null)
eq('min over present (STRONG, WEAK) → WEAK', effectiveTier(['STRONG', 'WEAK']), 'WEAK')
eq('present + null (STRONG, null) → STRONG', effectiveTier(['STRONG', null]), 'STRONG')
eq('STRONG ∩ STRONG → STRONG', effectiveTier(['STRONG', 'STRONG']), 'STRONG')

console.log('')
console.log('=== effectiveTierStrong (ENFORCE-CONTRACT fold — base STRONG, NEVER null) ===')
eq('F-NEW-2: all-absent → concrete "STRONG" (NOT null)', effectiveTierStrong([null, null, null]), 'STRONG')
eq('F-NEW-2: empty sources → "STRONG"', effectiveTierStrong([]), 'STRONG')
eq('no clamp (STRONG,STRONG,null) → STRONG', effectiveTierStrong(['STRONG', 'STRONG', null]), 'STRONG')
eq('clamp-down (STRONG,STRONG,WEAK) → WEAK', effectiveTierStrong(['STRONG', 'STRONG', 'WEAK']), 'WEAK')
eq('clamp-down to MEDIUM', effectiveTierStrong(['STRONG', null, 'MEDIUM']), 'MEDIUM')
eq('weakest wins across legs (WEAK,MEDIUM) → WEAK', effectiveTierStrong(['WEAK', 'MEDIUM']), 'WEAK')
eq('unknown tier string never lowers (fail-closed)', effectiveTierStrong(['STRONG', 'BOGUS']), 'STRONG')

console.log('')
console.log('=== clampTier (clamp-DOWN only) ===')
eq('null source → base unchanged', clampTier('STRONG', null), 'STRONG')
eq('weaker source lowers', clampTier('STRONG', 'WEAK'), 'WEAK')
eq('clamp-UP ignored: base WEAK, source STRONG → WEAK', clampTier('WEAK', 'STRONG'), 'WEAK')
eq('equal source → base', clampTier('MEDIUM', 'MEDIUM'), 'MEDIUM')
eq('unknown source → base (fail-closed)', clampTier('STRONG', 'NOPE'), 'STRONG')

console.log('')
console.log('=== GATE_EVENT_MAP / GATE_CONTRACT_KEY (B5 / F-NEW-1) ===')
// The headline F-NEW-1 correction: the stop refuse is the ROOT-LEVEL stop.tier
// gate firing at the `stop` event — NOT gates.post_checkpoint (a pre_tool_use
// classification gate). Get these wrong and a STRONG contract degrades the wrong
// gate.
eq('stop gate fires at the stop event', GATE_EVENT_MAP.stop, 'stop')
eq('stop gate contract key is stop.tier', GATE_CONTRACT_KEY.stop, 'stop.tier')
eq('post_checkpoint fires at pre_tool_use', GATE_EVENT_MAP.post_checkpoint, 'pre_tool_use')
eq('post_checkpoint contract key is gates.post_checkpoint', GATE_CONTRACT_KEY.post_checkpoint, 'gates.post_checkpoint')
eq('plan_approval fires at pre_tool_use', GATE_EVENT_MAP.plan_approval, 'pre_tool_use')
eq('pre_checkpoint fires at pre_tool_use', GATE_EVENT_MAP.pre_checkpoint, 'pre_tool_use')
eq('the two maps cover the same four gates', Object.keys(GATE_EVENT_MAP).sort(), Object.keys(GATE_CONTRACT_KEY).sort())
eq('all four contract gates are LIVE-wired (P4a)', LIVE_GATES.slice().sort(), ['plan_approval', 'post_checkpoint', 'pre_checkpoint', 'stop'])
eq('every LIVE gate has an event + contract-key mapping', LIVE_GATES.every((g) => GATE_EVENT_MAP[g] && GATE_CONTRACT_KEY[g]), true)

console.log('')
console.log('=== eventActionId (events.json action lookup) ===')
const EVENTS = {
  events: [
    { id: 'stop', actions: { STRONG: { id: 'refuse_stop' }, MEDIUM: { id: 'warn' }, WEAK: { id: 'unsupported' } } },
  ],
}
eq('stop STRONG → refuse_stop', eventActionId(EVENTS, 'stop', 'STRONG'), 'refuse_stop')
eq('stop MEDIUM → warn', eventActionId(EVENTS, 'stop', 'MEDIUM'), 'warn')
eq('stop WEAK → unsupported', eventActionId(EVENTS, 'stop', 'WEAK'), 'unsupported')
eq('null tier → em-dash', eventActionId(EVENTS, 'stop', null), '—')
eq('missing event → em-dash', eventActionId(EVENTS, 'pre_tool_use', 'STRONG'), '—')

console.log('')
if (fail === 0) {
  console.log(`PASS — ${pass} checks`)
  process.exit(0)
} else {
  console.log(`FAIL — ${fail} of ${pass + fail} checks failed:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
