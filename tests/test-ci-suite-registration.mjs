#!/usr/bin/env node
/**
 * test-ci-suite-registration.mjs - #504 class closure.
 *
 * The class lesson behind #504 (and PLAN-session-auto-capture convention 8):
 * CI runs explicitly listed test files, so an unlisted suite silently never
 * runs. Instance fixes (wiring suites one by one) leave the class open — this
 * lint closes it: every test-*.{mjs,sh} at any depth under tests/ must be
 *
 *   (a) INVOKED by a .github/workflows/*.{yml,yaml} `run:` command — the
 *       reference must be an interpreter invocation (`node|bash|sh tests/<f>`)
 *       at command position inside an extracted run value. Step names, `if:`
 *       conditions, YAML comments, shell comment lines, quoted strings, and
 *       longer tokens that merely contain the filename do NOT count; OR
 *   (b) a member of the P12 invariant meta-runner — re-derived the way the
 *       runner derives it: glob(test-p12-*.mjs) minus meta-runners, plus the
 *       runner's actual `const EXPLICIT = [...]` array (parsed from that
 *       block only, comments stripped — a name quoted elsewhere in the runner
 *       source does not count); OR
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
 * console.e2e.mjs and tests/integration/codex-tmux-e2e.mjs do not follow the
 * test-* naming contract (browser/tmux-bound; structurally CI-unsuitable).
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
// 'e2e/test-x.mjs'). Codex F3: a suite landing in tests/e2e etc. must not
// escape the gate.
function listSuites(dir, prefix = '') {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isDirectory()) out.push(...listSuites(path.join(dir, ent.name), `${prefix}${ent.name}/`))
    else if (/^test-.*\.(mjs|sh)$/.test(ent.name)) out.push(`${prefix}${ent.name}`)
  }
  return out
}

// Extract the VALUE TEXT of every `run:` key in a workflow YAML, without a
// YAML dependency. Single-line values get their trailing YAML comment
// stripped; block scalars (| or >, with chomping/indent modifiers) collect
// the following deeper-indented lines verbatim. Everything outside run:
// values (step names, if: conditions, YAML comments) is dropped, so a suite
// name there can never count as wired (codex F1).
function extractRunCommands(yamlText) {
  const lines = yamlText.split('\n')
  const commands = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/)
    if (!m) continue
    const keyIndent = m[1].length
    const value = m[2]
    if (/^[|>]/.test(value)) {
      const block = []
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]
        if (line.trim() === '') { block.push(''); continue }
        const indent = line.match(/^(\s*)/)[1].length
        if (indent <= keyIndent) break
        block.push(line)
        i = j
      }
      // De-indent the way YAML hands the scalar to the shell: strip the
      // common block indentation so heredoc delimiters compare the text the
      // shell actually sees.
      const baseIndent = Math.min(
        ...block.filter((l) => l.trim() !== '').map((l) => l.match(/^( *)/)[1].length),
      )
      commands.push(block.map((l) => (l.trim() === '' ? l : l.slice(baseIndent))).join('\n'))
    } else {
      commands.push(value.replace(/\s#.*$/, ''))
    }
  }
  return commands
}

// Drop shell heredoc BODIES from a command's lines: text between
// `<<[-]['"]WORD['"]` and the closing WORD line is data fed to a program, not
// executable commands (codex round-2 F1: `cat <<'INERT' ... INERT` carrying an
// invocation-shaped line must not count as wired).
function stripHeredocBodies(lines) {
  const out = []
  let delimiter = null
  let dashed = false
  for (const line of lines) {
    if (delimiter !== null) {
      const closing = dashed ? line.replace(/^\t+/, '') : line
      if (closing === delimiter) delimiter = null
      continue
    }
    out.push(line)
    const m = line.replace(/(^|\s)#.*$/, '$1').match(/<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/)
    if (m) {
      dashed = m[1] === '-'
      delimiter = m[2] ?? m[3] ?? m[4]
    }
  }
  return out
}

// A suite counts as workflow-wired ONLY if some run-command line invokes it:
// `node|bash|sh [./]tests/<relpath>` at command position (line start or after
// ;, &&, ||, |, ( or $( ). Heredoc bodies are dropped and shell comment
// segments stripped first, so `cat <<'X' ... X`, `# node tests/x.mjs`, and
// `echo done # node tests/x.mjs` never count; a quoted occurrence
// (`echo 'node tests/x.mjs'`) fails the command-position anchor (codex F1 axes).
function invokedByRunCommands(relPath, runCommands) {
  const esc = relPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|[;&|(]|\\$\\()\\s*(?:node|bash|sh)\\s+(?:\\./)?tests/${esc}(?=$|[\\s;&|)'"])`)
  for (const cmd of runCommands) {
    for (const rawLine of stripHeredocBodies(cmd.split('\n'))) {
      const line = rawLine.replace(/(^|\s)#.*$/, '$1')
      if (re.test(line)) return true
    }
  }
  return false
}

function readWorkflowRunCommands(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .flatMap((f) => extractRunCommands(fs.readFileSync(path.join(dir, f), 'utf8')))
}

// P12 meta-runner membership, re-derived the way the runner derives it
// (test-p12-invariant-suite.mjs deriveMembers()): glob(test-p12-*.mjs) minus
// meta-runners, plus its actual `const EXPLICIT = [...]` array. The EXPLICIT
// set is parsed from THAT BLOCK ONLY, with // comments stripped first — a
// filename quoted in a comment, assertion message, or anywhere else in the
// runner source does not confer membership (codex F2).
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

function computeUnregistered(suites, runCommands, p12Set, baseline) {
  const base = new Set(baseline)
  return suites.filter(
    (f) => !invokedByRunCommands(f, runCommands) && !p12Set.has(f) && !base.has(f),
  )
}

const SUITES = listSuites(testsDir)
const RUN_COMMANDS = readWorkflowRunCommands(workflowsDir)
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

console.log('# test-ci-suite-registration (#504 - every suite invoked by CI or baselined)')
console.log(`# suites: ${SUITES.length}, baseline: ${KNOWN_UNWIRED.length}, run commands: ${RUN_COMMANDS.length}`)

test('t_all_suites_registered: every tests/ test-*.{mjs,sh} (any depth) is invoked by a workflow run command, a P12 member, or baselined', () => {
  const unregistered = computeUnregistered(SUITES, RUN_COMMANDS, P12_SET, KNOWN_UNWIRED)
  assert.deepStrictEqual(
    unregistered,
    [],
    `unregistered suites (wire them into a workflow, or — with review — baseline them):\n  ${unregistered.join('\n  ')}`,
  )
})

test('t_baseline_not_wired: no baseline entry is invoked or a P12 member (shrink-only ratchet — delete wired entries)', () => {
  const wiredButBaselined = KNOWN_UNWIRED.filter(
    (f) => invokedByRunCommands(f, RUN_COMMANDS) || P12_SET.has(f),
  )
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
  assert.ok(invokedByRunCommands('test-plan-marker.mjs', RUN_COMMANDS), 'node-invoked suite must read as wired')
  assert.ok(invokedByRunCommands('test-plan-gate.sh', RUN_COMMANDS), 'bash-invoked suite must read as wired')
  assert.ok(P12_SET.has('test-p12-global-clean.mjs'), 'P12 glob member must read as wired')
  assert.ok(P12_SET.has('test-uninstall-enforcement.mjs'), 'P12 EXPLICIT member must read as wired')
  assert.ok(invokedByRunCommands(SELF_BASENAME, RUN_COMMANDS), `${SELF_BASENAME} must itself be invoked by a workflow`)
})

// Codex F1 mutation axes: every non-invocation reference class must read as
// NOT wired, driven through the same extractRunCommands + invokedByRunCommands
// paths the real check uses.
test('t_mutation_workflow_axes: step-name / if: / YAML comment / shell comment / quoted / longer-token references never count', () => {
  const target = 'test-mut-probe.mjs'
  const wired = (yaml) => invokedByRunCommands(target, extractRunCommands(yaml))
  // Positive controls: plain and block-scalar invocations DO count.
  assert.ok(wired('      - name: x\n        run: node tests/test-mut-probe.mjs\n'), 'plain run invocation')
  assert.ok(wired('      - run: |\n          echo start\n          node tests/test-mut-probe.mjs\n'), 'block-scalar invocation')
  assert.ok(wired('      - run: node tests/a.mjs && node tests/test-mut-probe.mjs\n'), 'command position after &&')
  // Attack axes: each must NOT count.
  assert.ok(!wired('      - name: run node tests/test-mut-probe.mjs\n        run: echo hi\n'), 'step-name-only reference')
  assert.ok(!wired("      - if: contains(github.event.head_commit.message, 'tests/test-mut-probe.mjs')\n        run: echo hi\n"), 'if-condition-only reference')
  assert.ok(!wired('      # node tests/test-mut-probe.mjs\n      - run: echo hi\n'), 'YAML comment-only reference')
  assert.ok(!wired('      - run: node tests/other.mjs # node tests/test-mut-probe.mjs\n'), 'inline trailing YAML comment')
  assert.ok(!wired('      - run: |\n          # node tests/test-mut-probe.mjs\n          echo hi\n'), 'shell comment line in block scalar')
  assert.ok(!wired('      - run: |\n          echo done # node tests/test-mut-probe.mjs\n'), 'trailing shell comment in block scalar')
  assert.ok(!wired("      - run: |\n          echo 'node tests/test-mut-probe.mjs'\n"), 'quoted inert text in block scalar')
  assert.ok(!wired('      - run: node tests/test-mut-probe.mjs.backup\n'), 'filename embedded in longer token')
  assert.ok(!wired('      - run: node tests/prefix-test-mut-probe.mjs\n'), 'filename as suffix of longer token')
  assert.ok(!wired('      - run: echo node tests/test-mut-probe.mjs\n'), 'echoed (non-command-position) reference')
  // Codex round-2 F1: heredoc bodies are data, not commands.
  assert.ok(!wired("      - run: |\n          cat <<'INERT'\n          node tests/test-mut-probe.mjs\n          INERT\n"), 'quoted-delimiter heredoc body')
  assert.ok(!wired('      - run: |\n          cat <<INERT\n          node tests/test-mut-probe.mjs\n          INERT\n'), 'unquoted-delimiter heredoc body')
  assert.ok(!wired('      - run: |\n          cat <<-INERT\n\t\t\tnode tests/test-mut-probe.mjs\n\tINERT\n'), 'dash-heredoc body with tab-indented close')
  assert.ok(wired("      - run: |\n          cat <<'INERT'\n          inert text\n          INERT\n          node tests/test-mut-probe.mjs\n"), 'real invocation AFTER a closed heredoc still counts')
})

// Codex F2 mutation axes: P12 membership binds to the ACTUAL EXPLICIT array.
test('t_mutation_p12_axes: EXPLICIT-array literals confer membership; comments and stray literals elsewhere do not', () => {
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
  // Codex round-2 F2: a block-commented fake declaration must not shadow the
  // real one, and an ambiguous parse must fail closed rather than guess.
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

// Codex F3 mutation axis: nested suites are discovered and gated.
test('t_mutation_nested_discovery: a suite under tests/e2e/ is discovered and reported unregistered', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-suite-reg-'))
  try {
    fs.mkdirSync(path.join(tmp, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'test-top.mjs'), '')
    fs.writeFileSync(path.join(tmp, 'e2e', 'test-nested.mjs'), '')
    fs.writeFileSync(path.join(tmp, 'e2e', 'helper.mjs'), '')
    const found = listSuites(tmp)
    assert.deepStrictEqual(found, ['e2e/test-nested.mjs', 'test-top.mjs'])
    const out = computeUnregistered(found, [' node tests/test-top.mjs'.trim()], new Set(), [])
    assert.deepStrictEqual(out, ['e2e/test-nested.mjs'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('t_negative_control: a synthetic unwired suite is reported unregistered against the REAL repo state', () => {
  const synthetic = 'test-synthetic-never-wired-504.mjs'
  const out = computeUnregistered([...SUITES, synthetic], RUN_COMMANDS, P12_SET, KNOWN_UNWIRED)
  assert.deepStrictEqual(out, [synthetic])
})

console.log(`\n# ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
console.log('test-ci-suite-registration: PASS')
