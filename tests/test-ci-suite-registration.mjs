#!/usr/bin/env node
/**
 * test-ci-suite-registration.mjs - #504 class closure.
 *
 * The class lesson behind #504 (and PLAN-session-auto-capture convention 8):
 * CI runs explicitly listed test files, so an unlisted suite silently never
 * runs. Instance fixes (wiring suites one by one) leave the class open — this
 * lint closes it: every test-*.{mjs,sh} at any depth under tests/ must be
 *
 *   (a) STEP-WIRED in .github/workflows/*.{yml,yaml}: a `run:` line whose
 *       value is exactly `node|bash|sh tests/<suite>`, located (by an
 *       indent-stack walk that skips block scalars) at the YAML path
 *       jobs.<job>.steps, in a workflow whose TOP-LEVEL `on:` declares a
 *       pull_request or push trigger. This is a structural contract, not
 *       shell parsing (codex rounds 1-4 killed every looser predicate:
 *       substrings, comments, step names, four heredoc spellings, and
 *       hierarchy-unbound exact lines under `env:`). Heredocs can only exist
 *       inside block scalars, so skipping block-scalar content closes the
 *       entire heredoc class; hierarchy binding closes the forged-placement
 *       class; the trigger check closes the disabled-workflow class. STRICT
 *       by design: an invocation with arguments, inside a block scalar, or
 *       with a trailing comment does NOT count — a legitimate future wiring
 *       in one of those forms fails CI loudly and this contract gets
 *       extended consciously (false negatives are loud; only silent false
 *       positives are dangerous); OR
 *   (b) a member of the P12 invariant meta-runner — re-derived the way the
 *       runner derives it: glob(test-p12-*.mjs) minus meta-runners, plus the
 *       runner's actual `const EXPLICIT = [...]` array (block comments
 *       stripped before locating the declaration, exactly one declaration
 *       required, line comments stripped inside it); OR
 *   (c) listed in the KNOWN_UNWIRED baseline below.
 *
 * The baseline is SHRINK-ONLY (a ratchet): it enumerates the suites that were
 * already unwired when this lint landed (2026-07-11, #504 audit). A baseline
 * entry that becomes wired must be deleted (t_baseline_not_wired), and an
 * entry whose file is deleted must be deleted too (t_baseline_exists). A
 * brand-new unwired suite fails t_all_suites_registered by default; adding it
 * to the baseline is a conscious reviewed edit of this file.
 *
 * Known out-of-contract files (tracked, not lint members): tests/e2e/
 * console.e2e.mjs (opt-in, Playwright) and tests/integration/
 * codex-tmux-e2e.mjs (live codex + tmux) do not follow the test-* naming
 * contract and are documented exemptions.
 *
 * Accepted residual (documented, review-guarded): a workflow author who
 * deliberately forges a byte-exact `run: node tests/<f>` line as heredoc-free
 * block-scalar-free DATA cannot exist — outside a block scalar such a line IS
 * a step key — so the residual reduces to adversarial YAML that GitHub would
 * reject or execute. The lint targets accidental drift, not a hostile author
 * with commit rights.
 *
 * Zero deps. Node stdlib only.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const SELF_BASENAME = path.basename(SELF)
const testsDir = path.dirname(SELF)
const repoRoot = path.dirname(testsDir)
const workflowsDir = path.join(repoRoot, '.github', 'workflows')

// Suites known to be unwired when this lint landed (#504 audit, 2026-07-11).
// Paths are relative to tests/. SHRINK-ONLY: entries may be removed (when
// wired or deleted), never added without review. Many are structurally
// CI-unsuitable (live seats, external codex/opencode binaries, network);
// wiring decisions stay per-suite.
const KNOWN_UNWIRED = [
  'test-bp1-approval-check-hook.mjs',
  'test-bp1-atomic.mjs',
  'test-bp1-check-deadlines.mjs',
  'test-bp1-crash-classify.mjs',
  'test-bp1-deadlines-lib.mjs',
  'test-bp1-emit-marker-invalid-evidence.mjs',
  'test-bp1-finalize-run.mjs',
  'test-bp1-flag-flip.mjs',
  'test-bp1-frontmatter.mjs',
  'test-bp1-hmac-manifest.mjs',
  'test-bp1-manifest-collect.mjs',
  'test-bp1-marker-validate.mjs',
  'test-bp1-marker.mjs',
  'test-bp1-orchestrator-286-race-and-crash.mjs',
  'test-bp1-orchestrator-287-rollback.mjs',
  'test-bp1-orchestrator-288-resume.mjs',
  'test-bp1-orchestrator-confirm-approval.mjs',
  'test-bp1-orchestrator-parseargs.mjs',
  'test-bp1-orchestrator-record-awaiting-approval.mjs',
  'test-bp1-orchestrator-sweep-naked-entries.mjs',
  'test-bp1-request-claim.mjs',
  'test-bp1-rfc-scan.mjs',
  'test-bp1-run-state-trylock.mjs',
  'test-bp1-state-lock.mjs',
  'test-bp1-sweep-loader.mjs',
  'test-canonicalize-path-tolerant.mjs',
  'test-checkpoint-marker.mjs',
  'test-classify-correction.mjs',
  'test-claude-subagent-env-propagation.mjs',
  'test-em-audit-compliance.mjs',
  'test-em-body-file.mjs',
  'test-em-help-flags.mjs',
  'test-em-local-dir-worktree.mjs',
  'test-em-mine-transcripts.mjs',
  'test-em-restore.mjs',
  'test-em-revise-scope-inherit.mjs',
  'test-em-sort-missing-datetime.mjs',
  'test-em-store-tag-flags.mjs',
  'test-em-watch-codex.mjs',
  'test-install-codex-skill.mjs',
  'test-install-opencode-pi-agent.mjs',
  'test-install-scripts-guide.mjs',
  'test-install-worktree-grant.mjs',
  'test-marker-paths.mjs',
  'test-marker-paths.sh',
  'test-marker-write-helper.mjs',
  'test-migration-sweep.mjs',
  'test-namespaced-marker-helpers.mjs',
  'test-namespaced-marker-helpers.sh',
  'test-opencode-enforcement-live-e2e.mjs',
  'test-p3-fixes.mjs',
  'test-phase2.mjs',
  'test-phase3.mjs',
  'test-preflight-gate-sid-parser.sh',
  'test-preflight-non-worsening.sh',
  'test-preflight-prompt-canon.mjs',
  'test-rfc002-phase1.mjs',
  'test-rfc002-phase2.mjs',
  'test-rfc002-phase3.mjs',
  'test-runbook-marker-checkpoint-gate.sh',
  'test-runbook-marker-classifier.sh',
  'test-script-identity-key.mjs',
  'test-second-opinion-audit-drift.mjs',
  'test-second-opinion-consensus-e2e.mjs',
  'test-second-opinion-consensus.mjs',
  'test-second-opinion-dispatch.mjs',
  'test-second-opinion-gate-runbook.mjs',
  'test-second-opinion-gate.mjs',
  'test-second-opinion-i22-algorithm-parity.mjs',
  'test-second-opinion-install-snapshot.mjs',
  'test-second-opinion-preamble.mjs',
  'test-second-opinion-providers.mjs',
  'test-second-opinion-storage.mjs',
  'test-seed-patterns.mjs',
  'test-session-end-quartet-cleanup.mjs',
  'test-session-handoff-cwd-matrix.sh',
  'test-so-gate-timeout-floor-integration.mjs',
  'test-so-gate-timeout-floor.mjs',
  'test-tier0-overrides.mjs',
  'test-transcript-walker.mjs',
  'test-validate-discipline-load-bundles.mjs',
  'test-worktree-marker-write.sh',
]

// --- derivation (small pure helpers so mutation fixtures can drive the SAME
// --- code paths CI drives) --------------------------------------------------

// Recursive discovery: every test-*.{mjs,sh} at ANY depth under tests/,
// returned as paths relative to tests/ (top level: 'test-x.mjs'; nested:
// 'e2e/test-x.mjs').
function listSuites(dir, prefix = '') {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isDirectory()) out.push(...listSuites(path.join(dir, ent.name), `${prefix}${ent.name}/`))
    else if (/^test-.*\.(mjs|sh)$/.test(ent.name)) out.push(`${prefix}${ent.name}`)
  }
  return out
}

// A `key: |` / `key: >` line (with optional chomp/indent modifiers) opens a
// YAML block scalar; its content is every following line indented deeper than
// the key. Heredocs, echoed text, and any other data can only live inside
// such content, so the scanner skips it entirely.
const BLOCK_SCALAR_KEY = /^(\s*)(?:-\s+)?[\w-]+:\s*[|>][+-]?\d*\s*(?:#.*)?$/

// The one value shape that counts as a wiring step (exact to end of line):
//   run: node|bash|sh tests/<relpath>
const STEP_INVOCATION = /^run:\s*(?:node|bash|sh)\s+tests\/(\S+)$/

// One structural pass over a workflow's YAML (codex round-4 P1: matches must
// bind to hierarchy, not just line shape). An indent stack of mapping keys is
// maintained (sequence-item `- ` prefixes fold into effective indent), block
// scalars are skipped wholesale, and:
//   - a STEP_INVOCATION line counts ONLY under the exact path
//     jobs(col 0) -> <job> -> steps, so a byte-identical line under `env:` or
//     anywhere else confers nothing;
//   - trigger keys count ONLY as direct children of top-level `on:` (or its
//     flow/scalar value), so `env: { pull_request: x }` activates nothing.
function parseWorkflow(yamlText) {
  const lines = yamlText.split('\n')
  const stack = [] // { indent, key }
  const triggers = new Set()
  const stepSuites = []
  // #515 qualifier taxonomy (F4): on:-level filters (paths/branches/types)
  // qualify the whole workflow; job-level and step-level `if:` qualify their
  // scope. `always()` broadens, never narrows, so it does not qualify. Record
  // now, classify after the loop (order-independent).
  const partialSuites = []
  const records = [] // { suite, jobKey, stepId }
  const qualifiedJobs = new Set()
  const qualifiedSteps = new Set()
  const ON_QUALIFIER_KEYS = new Set(['paths', 'paths-ignore', 'branches', 'branches-ignore', 'types'])
  const ALWAYS_RE = /^(?:\$\{\{\s*)?always\(\)\s*(?:\}\})?$/
  const filteredTriggers = new Set() // pull_request/push triggers carrying a paths/branches/types filter
  let workflowQualified = false
  let stepCounter = 0
  let currentStepId = -1
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const scalar = raw.match(BLOCK_SCALAR_KEY)
    if (scalar) {
      const keyIndent = scalar[1].length
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (next.trim() !== '' && next.match(/^(\s*)/)[1].length <= keyIndent) break
        i++
      }
      continue
    }
    const indent = raw.match(/^( *)/)[1].length
    let content = raw.slice(indent)
    let seqOffset = 0
    while (content.startsWith('- ')) {
      content = content.slice(2)
      seqOffset += 2
    }
    const effIndent = indent + seqOffset
    while (stack.length && stack[stack.length - 1].indent >= effIndent) stack.pop()
    if (seqOffset > 0 && stack.length && stack[stack.length - 1].key === 'steps') {
      currentStepId = ++stepCounter
    }

    const step = content.match(STEP_INVOCATION)
    if (step) {
      const n = stack.length
      if (
        n >= 3 &&
        stack[n - 1].key === 'steps' &&
        stack[n - 3].key === 'jobs' &&
        stack[n - 3].indent === 0
      ) {
        records.push({ suite: step[1], jobKey: stack[n - 2].key, stepId: currentStepId })
      }
      continue
    }

    const key = content.match(/^([\w_-]+):\s*(.*?)\s*(?:#.*)?$/)
    if (!key) continue
    const depth = stack.length
    if (ON_QUALIFIER_KEYS.has(key[1]) && depth === 2 && stack[0].key === 'on' && stack[0].indent === 0) {
      filteredTriggers.add(stack[1].key) // this trigger is filtered; workflow-partial decided post-loop
    }
    if (key[1] === 'if' && !ALWAYS_RE.test(key[2])) {
      if (depth === 2 && stack[0].key === 'jobs' && stack[0].indent === 0) {
        qualifiedJobs.add(stack[1].key)
      } else if (depth >= 3 && stack[depth - 1].key === 'steps' && stack[depth - 3].key === 'jobs') {
        qualifiedSteps.add(currentStepId)
      }
    }
    if (key[1] === 'on' && effIndent === 0 && key[2] !== '') {
      // Flow (`on: [push, pull_request]`) or scalar (`on: push`) trigger value.
      for (const t of key[2].replace(/[[\]]/g, '').split(',')) triggers.add(t.trim())
    } else if (stack.length === 1 && stack[0].key === 'on' && stack[0].indent === 0) {
      triggers.add(key[1])
    }
    stack.push({ indent: effIndent, key: key[1] })
  }
  // F4: classify AFTER the full scan (YAML mapping order is not semantic).
  const hasUnfilteredPush = triggers.has('push') && !filteredTriggers.has('push')
  workflowQualified = triggers.has('pull_request') && filteredTriggers.has('pull_request') && !hasUnfilteredPush
  for (const rec of records) {
    if (workflowQualified || qualifiedJobs.has(rec.jobKey) || qualifiedSteps.has(rec.stepId)) {
      partialSuites.push(rec.suite)
    } else {
      stepSuites.push(rec.suite)
    }
  }
  return { triggers, stepSuites, partialSuites }
}

// A workflow only executes on PRs/pushes if its top-level `on:` declares
// those triggers; a workflow_dispatch- or schedule-only file wires nothing (a
// suite invoked only there never gates a merge).
function isTriggerActive(triggers) {
  return triggers.has('pull_request') || triggers.has('push')
}

// The set of suites step-wired across all trigger-active workflows.
function collectWiredSet(dir) {
  const wired = new Set()
  const partial = new Set()
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    const { triggers, stepSuites, partialSuites } = parseWorkflow(fs.readFileSync(path.join(dir, f), 'utf8'))
    if (!isTriggerActive(triggers)) continue
    for (const suite of stepSuites) wired.add(suite)
    for (const suite of partialSuites) partial.add(suite)
  }
  // A suite fully wired anywhere is not partial: full wiring wins.
  for (const suite of wired) partial.delete(suite)
  return { wired, partial }
}

// P12 meta-runner membership, re-derived the way the runner derives it
// (test-p12-invariant-suite.mjs deriveMembers()): glob(test-p12-*.mjs) minus
// meta-runners, plus its actual `const EXPLICIT = [...]` array.
const P12_RUNNER = 'test-p12-invariant-suite.mjs'

function parseP12Explicit(runnerSource) {
  // Strip /* */ block comments BEFORE locating the declaration: a
  // block-commented fake `const EXPLICIT = [...]` preceding the real one must
  // not shadow it (codex round-2 F2). Then require the declaration to be
  // unique — two surviving declarations means this parser's assumptions broke,
  // so fail closed instead of guessing.
  const noBlockComments = runnerSource.replace(/\/\*[\s\S]*?\*\//g, '')
  const decls = [...noBlockComments.matchAll(/const EXPLICIT = \[([\s\S]*?)\n\]/g)]
  assert.strictEqual(
    decls.length,
    1,
    `expected exactly one "const EXPLICIT = [" declaration in ${P12_RUNNER}, found ${decls.length} — update this lint's parser`,
  )
  const noComments = decls[0][1].replace(/\/\/.*$/gm, '')
  return [...noComments.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function p12Members(runnerSource, suiteBasenames) {
  const globbed = suiteBasenames.filter((f) => /^test-p12-.*\.mjs$/.test(f) && !f.includes('invariant-suite'))
  return new Set([...globbed, ...parseP12Explicit(runnerSource)])
}

function computeUnregistered(suites, wiredSet, p12Set, baseline, partialSet = new Set()) {
  const base = new Set(baseline)
  return suites.filter((f) => !wiredSet.has(f) && !partialSet.has(f) && !p12Set.has(f) && !base.has(f))
}

const SUITES = listSuites(testsDir)
const { wired: WIRED, partial: PARTIAL } = collectWiredSet(workflowsDir)
const P12_SOURCE = fs.readFileSync(path.join(testsDir, P12_RUNNER), 'utf8')
const P12_SET = p12Members(P12_SOURCE, SUITES)

// --- test harness ------------------------------------------------------------

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  + ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  x ${name}: ${e.message}`)
  }
}

console.log('# test-ci-suite-registration (#504 - every suite step-wired, P12-run, or baselined)')
console.log(`# suites: ${SUITES.length}, baseline: ${KNOWN_UNWIRED.length}, step-wired: ${WIRED.size}`)
console.log(`# partial (qualified wiring, #515): ${PARTIAL.size}${PARTIAL.size ? ' - ' + [...PARTIAL].sort().join(', ') : ''}`)

test('t_all_suites_registered: every tests/ test-*.{mjs,sh} (any depth) is step-wired, a P12 member, or baselined', () => {
  const unregistered = computeUnregistered(SUITES, WIRED, P12_SET, KNOWN_UNWIRED, PARTIAL)
  assert.deepStrictEqual(
    unregistered,
    [],
    `unregistered suites (wire them as a bare "run: node|bash tests/<f>" step, or — with review — baseline them):\n  ${unregistered.join('\n  ')}`,
  )
})

test('t_baseline_not_wired: no baseline entry is step-wired or a P12 member (shrink-only ratchet — delete wired entries)', () => {
  const wiredButBaselined = KNOWN_UNWIRED.filter((f) => WIRED.has(f) || P12_SET.has(f))
  assert.deepStrictEqual(
    wiredButBaselined,
    [],
    `now wired — remove from KNOWN_UNWIRED: ${wiredButBaselined.join(', ')}`,
  )
})

test('t_baseline_exists: every baseline entry exists on disk (delete stale entries)', () => {
  const missing = KNOWN_UNWIRED.filter((f) => !fs.existsSync(path.join(testsDir, f)))
  assert.deepStrictEqual(missing, [], `baseline entries with no file — remove: ${missing.join(', ')}`)
})

test('t_baseline_sorted_unique: baseline is sorted and duplicate-free (reviewable shrink diffs)', () => {
  assert.deepStrictEqual(KNOWN_UNWIRED, [...new Set(KNOWN_UNWIRED)].sort())
})

test('t_detection_sanity: known-wired suites detected via each acceptance branch; this lint itself is wired', () => {
  assert.ok(WIRED.has('test-plan-marker.mjs'), 'node-invoked suite must read as wired')
  assert.ok(WIRED.has('test-plan-gate.sh'), 'bash-invoked suite must read as wired')
  assert.ok(P12_SET.has('test-p12-global-clean.mjs'), 'P12 glob member must read as wired')
  assert.ok(P12_SET.has('test-uninstall-enforcement.mjs'), 'P12 EXPLICIT member must read as wired')
  assert.ok(WIRED.has(SELF_BASENAME), `${SELF_BASENAME} must itself be step-wired`)
})

// Codex rounds 1-4 workflow axes, driven through the SAME parser CI uses.
// Every non-step reference class must read as NOT wired.
test('t_mutation_workflow_axes: only jobs.*.steps run lines outside block scalars in on:-triggered workflows count', () => {
  const target = 'test-mut-probe.mjs'
  const SKELETON = 'on:\n  pull_request:\njobs:\n  validate:\n    runs-on: ubuntu-latest\n    steps:\n'
  const wires = (steps, prefix = SKELETON) => {
    const { triggers, stepSuites } = parseWorkflow(prefix + steps)
    return isTriggerActive(triggers) && stepSuites.includes(target)
  }
  // Positive controls.
  assert.ok(wires('      - name: x\n        run: node tests/test-mut-probe.mjs\n'), 'plain step line')
  assert.ok(wires('      - run: bash tests/test-mut-probe.mjs\n'), 'inline "- run:" step form (bash)')
  // Round-1 axes.
  assert.ok(!wires('      - name: run node tests/test-mut-probe.mjs\n        run: echo hi\n'), 'step-name-only reference')
  assert.ok(!wires("      - if: contains(x, 'tests/test-mut-probe.mjs')\n        run: echo hi\n"), 'if-condition-only reference')
  assert.ok(!wires('      # run: node tests/test-mut-probe.mjs\n      - run: echo hi\n'), 'YAML comment-only reference')
  assert.ok(!wires('      - run: node tests/test-mut-probe.mjs # note\n'), 'trailing comment breaks exactness (strict false negative)')
  assert.ok(!wires('      - run: node tests/test-mut-probe.mjs.backup\n'), 'filename embedded in longer token')
  assert.ok(!wires('      - run: node tests/prefix-test-mut-probe.mjs\n'), 'filename as suffix of longer token')
  assert.ok(!wires('      - run: echo node tests/test-mut-probe.mjs\n'), 'echoed reference is not a step line')
  // Rounds 2-3 heredoc class: heredocs only exist inside block scalars, and
  // ALL block-scalar content is skipped — quoted, unquoted, backslash-quoted,
  // and stacked delimiters die identically.
  assert.ok(!wires("      - run: |\n          cat <<'INERT'\n          node tests/test-mut-probe.mjs\n          INERT\n"), 'quoted-delimiter heredoc body')
  assert.ok(!wires('      - run: |\n          cat <<\\INERT\n          node tests/test-mut-probe.mjs\n          INERT\n'), 'backslash-quoted heredoc body (round-3)')
  assert.ok(!wires('      - run: |\n          cat <<FIRST <<SECOND\n          inert\n          FIRST\n          node tests/test-mut-probe.mjs\n          SECOND\n'), 'stacked heredocs (round-3)')
  assert.ok(!wires('      - run: |\n          cat <<X\n          run: node tests/test-mut-probe.mjs\n          X\n'), 'forged step line inside block scalar')
  assert.ok(!wires('      - run: |\n          node tests/test-mut-probe.mjs\n'), 'block-scalar invocation does not count (strict false negative, loud in CI)')
  // Round-4 hierarchy axes: a byte-exact run line bound to the wrong YAML
  // path confers nothing.
  assert.ok(!wires('', 'on:\n  pull_request:\nenv:\n  run: node tests/test-mut-probe.mjs\njobs:\n  validate:\n    steps:\n'), 'top-level env.run placement (round-4)')
  assert.ok(!wires('', 'on:\n  pull_request:\njobs:\n  validate:\n    env:\n      run: node tests/test-mut-probe.mjs\n    steps:\n'), 'job-level env.run placement (round-4)')
  // Trigger axes (round-1 subagent + round-4): only top-level on: children
  // (or its flow/scalar value) activate a workflow.
  const dispatchOnly = 'on:\n  workflow_dispatch:\njobs:\n  v:\n    steps:\n      - run: node tests/test-mut-probe.mjs\n'
  assert.ok(!wires('', dispatchOnly), 'dispatch-only workflow wires nothing')
  const envTrigger = 'on:\n  workflow_dispatch:\nenv:\n  pull_request: inert-non-trigger-key\njobs:\n  v:\n    steps:\n      - run: node tests/test-mut-probe.mjs\n'
  assert.ok(!wires('', envTrigger), 'pull_request under env: is not a trigger (round-4)')
  assert.ok(!isTriggerActive(parseWorkflow('# pull_request: in a comment\non:\n  schedule:\n    - cron: "0 0 * * *"\n').triggers), 'schedule-only workflow with a comment mention is not trigger-active')
  assert.ok(isTriggerActive(parseWorkflow('on: [push]\n').triggers), 'flow-style trigger list is recognized')
  assert.ok(isTriggerActive(parseWorkflow('on: push\n').triggers), 'scalar trigger value is recognized')
  assert.ok(wires('      - run: node tests/test-mut-probe.mjs\n', 'on:\n  push:\n    branches: [main]\njobs:\n  v:\n    steps:\n'), 'push-with-branches trigger activates (nested keys do not leak)')
})

// Codex round-2/3 P12 axes: membership binds to the ACTUAL EXPLICIT array.
test('t_mutation_p12_axes: EXPLICIT-array literals confer membership; comments, stray literals, and shadow declarations do not', () => {
  const src = [
    '// intro comment mentioning \'test-ghost-a.mjs\'',
    'const EXPLICIT = [',
    "  // rationale comment naming 'test-ghost-b.mjs'",
    "  'test-real-member.mjs',",
    ']',
    "assert.deepStrictEqual([...EXPLICIT].sort(), ['test-ghost-c.mjs'])",
  ].join('\n')
  const set = p12Members(src, ['test-p12-extra.mjs', 'test-p12-invariant-suite.mjs'])
  assert.ok(set.has('test-real-member.mjs'), 'actual EXPLICIT entry is a member')
  assert.ok(set.has('test-p12-extra.mjs'), 'glob member joins')
  assert.ok(!set.has('test-p12-invariant-suite.mjs'), 'meta-runner excluded from glob')
  assert.ok(!set.has('test-ghost-a.mjs'), 'literal outside the array does not confer membership')
  assert.ok(!set.has('test-ghost-b.mjs'), 'comment inside the array does not confer membership')
  assert.ok(!set.has('test-ghost-c.mjs'), 'literal after the array (assertion pin) does not confer membership')
  const shadowed = [
    '/* const EXPLICIT = [',
    "  'test-ghost-d.mjs',",
    ']',
    '*/',
    'const EXPLICIT = [',
    "  'test-real-member.mjs',",
    ']',
  ].join('\n')
  const shadowSet = p12Members(shadowed, [])
  assert.ok(shadowSet.has('test-real-member.mjs'), 'real declaration read past a block-commented fake')
  assert.ok(!shadowSet.has('test-ghost-d.mjs'), 'block-commented fake declaration confers nothing')
  const ambiguous = "const EXPLICIT = [\n  'a.mjs',\n]\nconst EXPLICIT = [\n  'b.mjs',\n]"
  assert.throws(() => p12Members(ambiguous, []), /exactly one/, 'two surviving declarations fail closed')
})

// Nested placement cannot escape the gate.
test('t_mutation_nested_discovery: a suite under tests/e2e/ is discovered and reported unregistered', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-suite-reg-'))
  try {
    fs.mkdirSync(path.join(tmp, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'test-top.mjs'), '')
    fs.writeFileSync(path.join(tmp, 'e2e', 'test-nested.mjs'), '')
    fs.writeFileSync(path.join(tmp, 'e2e', 'helper.mjs'), '')
    const found = listSuites(tmp)
    assert.deepStrictEqual(found, ['e2e/test-nested.mjs', 'test-top.mjs'])
    const out = computeUnregistered(found, new Set(['test-top.mjs']), new Set(), [])
    assert.deepStrictEqual(out, ['e2e/test-nested.mjs'])
    // A nested suite wired with its relative path registers.
    const wiredNested = parseWorkflow(
      'on:\n  pull_request:\njobs:\n  v:\n    steps:\n      - run: node tests/e2e/test-nested.mjs\n',
    ).stepSuites
    assert.deepStrictEqual(wiredNested, ['e2e/test-nested.mjs'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('t_negative_control: a synthetic unwired suite is reported unregistered against the REAL repo state', () => {
  const synthetic = 'test-synthetic-never-wired-504.mjs'
  const out = computeUnregistered([...SUITES, synthetic], WIRED, P12_SET, KNOWN_UNWIRED, PARTIAL)
  assert.deepStrictEqual(out, [synthetic])
})

test('t_partial_paths_filter (#515): paths:-filtered workflow classifies its suites partial', () => {
  const y = ['on:', '  pull_request:', "    paths:", "      - 'docs/**'", 'jobs:', '  j:', '    steps:', '      - run: node tests/test-x.mjs'].join('\n')
  const { stepSuites, partialSuites } = parseWorkflow(y)
  assert.deepStrictEqual(stepSuites, [])
  assert.deepStrictEqual(partialSuites, ['test-x.mjs'])
})

test('t_partial_step_if (#515): step-level if: qualifies its suite - if before AND after run:', () => {
  const y = ['on: [push]', 'jobs:', '  j:', '    steps:', "      - if: github.event_name == 'push'", '        run: node tests/test-a.mjs', '      - run: node tests/test-b.mjs', '        if: failure()', '      - run: node tests/test-c.mjs'].join('\n')
  const { stepSuites, partialSuites } = parseWorkflow(y)
  assert.deepStrictEqual([...stepSuites].sort(), ['test-c.mjs'])
  assert.deepStrictEqual([...partialSuites].sort(), ['test-a.mjs', 'test-b.mjs'])
})

test('t_partial_job_if (#515): job-level if: marks every suite in that job partial; sibling job unaffected', () => {
  const y = ['on: [push]', 'jobs:', '  gated:', "    if: github.repository == 'x/y'", '    steps:', '      - run: node tests/test-d.mjs', '  open:', '    steps:', '      - run: node tests/test-e.mjs'].join('\n')
  const { stepSuites, partialSuites } = parseWorkflow(y)
  assert.deepStrictEqual([...stepSuites].sort(), ['test-e.mjs'])
  assert.deepStrictEqual([...partialSuites].sort(), ['test-d.mjs'])
})

test('t_always_qualifier (#515): if: always() stays fully wired (broadens, never narrows)', () => {
  const y = ['on: [push]', 'jobs:', '  j:', '    steps:', '      - if: ${{ always() }}', '        run: node tests/test-f.mjs', '      - if: always()', '        run: node tests/test-g.mjs'].join('\n')
  const { stepSuites, partialSuites } = parseWorkflow(y)
  assert.deepStrictEqual([...stepSuites].sort(), ['test-f.mjs', 'test-g.mjs'])
  assert.deepStrictEqual(partialSuites, [])
})

test('t_r5b_wired (#515/REQ-10): the four P3 suites are step-wired unqualified in the live workflows', () => {
  for (const f of ['test-pattern-health-check-gate.mjs', 'test-so-lesson-injection.mjs', 'test-so-timeout.mjs', 'test-trigger-index-pattern-health.mjs']) {
    assert.ok(WIRED.has(f), `${f} fully wired`)
    assert.ok(!PARTIAL.has(f), `${f} not partial`)
  }
})

test('t_order_job_if_after_steps (#515, F4): job-level if: AFTER steps still marks the job partial', () => {
  const y = ['on: [push]', 'jobs:', '  j:', '    steps:', '      - run: node tests/test-job.mjs', "    if: github.repository == 'x/y'"].join('\n')
  const { stepSuites, partialSuites } = parseWorkflow(y)
  assert.deepStrictEqual(stepSuites, [])
  assert.deepStrictEqual(partialSuites, ['test-job.mjs'])
})

test('t_order_on_after_jobs (#515, F4): on-qualifier AFTER jobs still marks the workflow partial', () => {
  const y = ['jobs:', '  j:', '    steps:', '      - run: node tests/test-workflow.mjs', 'on:', '  pull_request:', "    paths:", "      - 'docs/**'"].join('\n')
  const { stepSuites, partialSuites } = parseWorkflow(y)
  assert.deepStrictEqual(stepSuites, [])
  assert.deepStrictEqual(partialSuites, ['test-workflow.mjs'])
})

console.log(`\n# ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
console.log('test-ci-suite-registration: PASS')
