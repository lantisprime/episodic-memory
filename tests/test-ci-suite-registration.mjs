#!/usr/bin/env node
/**
 * test-ci-suite-registration.mjs - #504 class closure.
 *
 * The class lesson behind #504 (and PLAN-session-auto-capture convention 8):
 * CI runs explicitly listed test files, so an unlisted suite silently never
 * runs. Instance fixes (wiring suites one by one) leave the class open — this
 * lint closes it: every test-*.{mjs,sh} at any depth under tests/ must be
 *
 *   (a) STEP-WIRED in .github/workflows/*.{yml,yaml}: some line, OUTSIDE any
 *       YAML block scalar, in a workflow whose `on:` declares a pull_request
 *       or push trigger, trims to exactly
 *           [- ]run: node|bash|sh tests/<suite>
 *       This is a structural line-grammar contract, not shell parsing (codex
 *       rounds 1-3 killed every textual predicate: substrings, comments,
 *       step names, and four heredoc spellings). Heredocs can only exist
 *       inside block scalars, so skipping block-scalar content closes the
 *       entire heredoc class; the trigger check closes the
 *       disabled-workflow class. STRICT by design: an invocation with
 *       arguments, inside a block scalar, or with a trailing comment does
 *       NOT count — a legitimate future wiring in one of those forms fails
 *       CI loudly and this contract gets extended consciously (false
 *       negatives are loud; only silent false positives are dangerous); OR
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
  'test-workflow-validate.mjs',
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
// such content, so step scanning skips it entirely.
const BLOCK_SCALAR_KEY = /^(\s*)(?:-\s+)?[\w-]+:\s*[|>][+-]?\d*\s*(?:#.*)?$/

// The one shape that counts as a wiring step (trimmed, exact):
//   [- ]run: node|bash|sh tests/<relpath>
const STEP_INVOCATION = /^(?:-\s+)?run:\s*(?:node|bash|sh)\s+tests\/(\S+)$/

// Collect the suite relpaths step-wired by one workflow's text: scan lines,
// skip block-scalar content, exact-match the remainder against
// STEP_INVOCATION.
function collectStepInvocations(yamlText) {
  const lines = yamlText.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const scalar = lines[i].match(BLOCK_SCALAR_KEY)
    if (scalar) {
      const keyIndent = scalar[1].length
      while (i + 1 < lines.length) {
        const next = lines[i + 1]
        if (next.trim() !== '' && next.match(/^(\s*)/)[1].length <= keyIndent) break
        i++
      }
      continue
    }
    const m = lines[i].trim().match(STEP_INVOCATION)
    if (m) out.push(m[1])
  }
  return out
}

// A workflow only executes on PRs/pushes if its `on:` declares those
// triggers; a workflow_dispatch- or schedule-only file wires nothing (a
// suite invoked only there never gates a merge).
function workflowHasActiveTrigger(yamlText) {
  const noComments = yamlText
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  return /^\s*(?:pull_request|push)\s*:/m.test(noComments) || /^on:\s*\[[^\]]*(?:pull_request|push)[^\]]*\]/m.test(noComments)
}

// The set of suites step-wired across all trigger-active workflows.
function collectWiredSet(dir) {
  const wired = new Set()
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    if (!workflowHasActiveTrigger(text)) continue
    for (const suite of collectStepInvocations(text)) wired.add(suite)
  }
  return wired
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

function computeUnregistered(suites, wiredSet, p12Set, baseline) {
  const base = new Set(baseline)
  return suites.filter((f) => !wiredSet.has(f) && !p12Set.has(f) && !base.has(f))
}

const SUITES = listSuites(testsDir)
const WIRED = collectWiredSet(workflowsDir)
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

test('t_all_suites_registered: every tests/ test-*.{mjs,sh} (any depth) is step-wired, a P12 member, or baselined', () => {
  const unregistered = computeUnregistered(SUITES, WIRED, P12_SET, KNOWN_UNWIRED)
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

// Codex rounds 1-3 workflow axes, driven through the SAME helpers CI uses.
// Every non-step reference class must read as NOT wired.
test('t_mutation_workflow_axes: only bare step lines outside block scalars in trigger-active workflows count', () => {
  const target = 'test-mut-probe.mjs'
  const ACTIVE = 'on:\n  pull_request:\n'
  const wires = (yaml) => {
    const text = ACTIVE + yaml
    return workflowHasActiveTrigger(text) && collectStepInvocations(text).includes(target)
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
  // Trigger axis (round-1 subagent finding): a workflow without pull_request/
  // push wires nothing.
  const inert = 'on:\n  workflow_dispatch:\n'
  assert.ok(!workflowHasActiveTrigger(inert + 'jobs: {}\n'), 'dispatch-only workflow is not trigger-active')
  assert.ok(!workflowHasActiveTrigger('# pull_request: in a comment\non:\n  schedule:\n    - cron: "0 0 * * *"\n'), 'schedule-only workflow with a comment mention is not trigger-active')
  assert.ok(workflowHasActiveTrigger('on: [push]\n'), 'flow-style trigger list is recognized')
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
    const wiredNested = collectStepInvocations('      - run: node tests/e2e/test-nested.mjs\n')
    assert.deepStrictEqual(wiredNested, ['e2e/test-nested.mjs'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('t_negative_control: a synthetic unwired suite is reported unregistered against the REAL repo state', () => {
  const synthetic = 'test-synthetic-never-wired-504.mjs'
  const out = computeUnregistered([...SUITES, synthetic], WIRED, P12_SET, KNOWN_UNWIRED)
  assert.deepStrictEqual(out, [synthetic])
})

console.log(`\n# ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
console.log('test-ci-suite-registration: PASS')
