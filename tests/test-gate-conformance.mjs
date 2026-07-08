#!/usr/bin/env node
// test-gate-conformance.mjs — E6 conformance matrix for checkpoint-gate.sh.
//
// Table-driven suite that executes the REAL checkpoint-gate.sh (bash spawn,
// PreToolUse JSON on stdin) against an isolated fixture: real install.mjs
// --install-enforcement into a fresh HOME + mock git project, then drives the
// DEPLOYED <project>/.claude/hooks/checkpoint-gate.sh — asserted below to be
// byte-identical to the repo source, so the matrix verifies the checked-in
// hook, not a hand-staged copy (feedback_mock_project_test_not_mental_trace).
//
// Gate contract note (matrix "expected" column mapping): PreToolUse hooks
// ALWAYS exit 0 — the decision is carried in stdout JSON, not the exit code.
//   ALLOW   → exit 0 + empty stdout
//   HOLD    → exit 0 + {"decision":"block"} whose reason routes to the agent
//             classifier (_block_needs_classification) — telemetry `hold`
//   BLOCK   → exit 0 + {"decision":"block"} (checkpoint/push blocks)
//   SILENCE → exit 0 + empty stdout via an enforce-config consult — same
//             observable as ALLOW; distinguished by the E5 telemetry line
// Every cell also asserts the E5 telemetry: exactly ONE line appended to
// .checkpoints/gate-log.jsonl with the expected `decision` value, and the
// whole log is re-checked against the accumulated expectation at the end.
//
// Requires bash + jq on PATH (CI ubuntu-latest has both; same requirement as
// tests/test-checkpoint-gate.sh). Zero deps beyond the harness.

import fs from 'node:fs'
import path from 'node:path'
import { mkMock, runInstall, runHook, REPO_ROOT } from './lib/activation-scoping-harness.mjs'
import { ENFORCE_CONFIG_SEED } from '../scripts/lib/install-manifest.mjs'

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ✓ ${n}`) }
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}: ${d}`) }

const SID = 'e6-conformance-sid-01'

// ---------------------------------------------------------------------------
// Fixture: real install into isolated HOME + mock git project.
// ---------------------------------------------------------------------------
const M = mkMock('gate-conformance')
const inst = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: ['--install-enforcement'] })
if (inst.status !== 0) { console.error('install failed:', inst.stderr); process.exit(1) }

const GATE = path.join(M.project, '.claude', 'hooks', 'checkpoint-gate.sh')
const CKPT = path.join(M.project, '.checkpoints')
const LOG = path.join(CKPT, 'gate-log.jsonl')
const CFG = path.join(M.project, '.episodic-memory', 'enforce-config.json')

// The deployed gate must be the repo source, byte for byte — otherwise the
// matrix would certify a different artifact than the PR diff.
{
  const repoGate = path.join(REPO_ROOT, 'plugins', 'claude-code', 'hooks', 'checkpoint-gate.sh')
  if (fs.readFileSync(GATE).equals(fs.readFileSync(repoGate))) ok('deployed checkpoint-gate.sh is byte-identical to repo source')
  else { bad('deployed gate identity', `${GATE} differs from ${repoGate}`); process.exit(1) }
}

// ---------------------------------------------------------------------------
// State helpers.
// ---------------------------------------------------------------------------
// Reset marker state between cells; gate-log.jsonl accumulates across the whole
// matrix (the final telemetry sweep depends on it). .checkpoints/ must EXIST
// for telemetry — the E5 append deliberately never creates it (caller-leak
// class), and any project with real gate activity has it.
function resetState(config /* 'seed' | 'off' | 'missing' | 'malformed' */) {
  fs.mkdirSync(CKPT, { recursive: true })
  for (const f of fs.readdirSync(CKPT)) {
    if (f === 'gate-log.jsonl') continue
    fs.rmSync(path.join(CKPT, f), { recursive: true, force: true })
  }
  fs.rmSync(path.join(M.project, '.claude', '.checkpoint-required'), { force: true }) // legacy root, belt+braces
  if (config === 'seed') fs.writeFileSync(CFG, ENFORCE_CONFIG_SEED)
  else if (config === 'off') fs.writeFileSync(CFG, '{"active":false}\n')
  else if (config === 'missing') fs.rmSync(CFG, { force: true })
  else if (config === 'malformed') fs.writeFileSync(CFG, '{"active": tru\n')
  else throw new Error(`unknown config mode ${config}`)
}

const seedApproval = () => fs.writeFileSync(path.join(CKPT, `.plan-approved.${SID}`), '')

const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : [])

function fire(toolName, toolInput) {
  const before = logLines().length
  const res = runHook(GATE, { tool_name: toolName, tool_input: toolInput, cwd: M.project, session_id: SID },
    { home: M.home, project: M.project })
  const appended = logLines().slice(before)
  return { ...res, appended }
}

// ---------------------------------------------------------------------------
// Cell runner: asserts exit code, decisive stdout substring, and the single
// appended telemetry line's decision.
// ---------------------------------------------------------------------------
const expectedDecisions = [] // accumulated for the final whole-log sweep

function cell(name, { setup, tool, input, expect, substring, telemetry, post }) {
  setup()
  const res = fire(tool, input)
  const out = (res.stdout || '').trim()
  const isBlock = /"decision"\s*:\s*"block"/.test(out)
  let failure = null
  if (res.status !== 0) failure = `exit=${res.status} (gate must always exit 0) stderr=${(res.stderr || '').slice(-200)}`
  else if (expect === 'ALLOW' || expect === 'SILENCE') {
    if (out !== '') failure = `expected empty stdout, got: ${out.slice(0, 200)}`
  } else { // HOLD | BLOCK
    if (!isBlock) failure = `expected {"decision":"block"}, got: ${out.slice(0, 200) || '(empty)'}`
    else if (substring && !out.includes(substring)) failure = `block emitted but missing decisive substring "${substring}": ${out.slice(0, 300)}`
  }
  if (!failure) {
    if (res.appended.length !== 1) failure = `expected exactly 1 telemetry line, got ${res.appended.length}: ${JSON.stringify(res.appended)}`
    else {
      let row = null
      try { row = JSON.parse(res.appended[0]) } catch { failure = `telemetry line is not JSON: ${res.appended[0]}` }
      if (row) {
        if (row.decision !== telemetry) failure = `telemetry decision=${row.decision}, expected ${telemetry}: ${res.appended[0]}`
        else if (row.gate !== 'checkpoint' || row.sid !== SID || !Number.isInteger(row.ts)) {
          failure = `telemetry shape wrong: ${res.appended[0]}`
        } else if (tool === 'Bash' && !/^[0-9a-f]{64}$/.test(row.cmd_sha256)) {
          failure = `Bash cell must log a 64-hex cmd_sha256: ${res.appended[0]}`
        }
      }
    }
  }
  if (failure) bad(name, failure)
  else {
    expectedDecisions.push(telemetry)
    ok(name)
    if (post) post()
  }
}

const NOVEL = { command: 'node /fixture/foo.mjs' } // classifier: shared_write / interpreter_other (unevaluated novel)

console.log('=== E6 conformance matrix — checkpoint-gate.sh ===')

// 1. Novel Bash shared_write, active:true, no plan → HOLD for classification.
cell('1. novel Bash (interpreter_other) + active:true + no plan → HOLD (needs-classification)', {
  setup: () => resetState('seed'),
  tool: 'Bash', input: NOVEL,
  expect: 'HOLD', substring: 'classif', telemetry: 'hold',
  post: () => {
    // The hold must NOT arm a checkpoint (agent-classifier-first #351).
    if (fs.existsSync(path.join(CKPT, `.checkpoint-required.${SID}`))) bad('1a. hold must not arm .checkpoint-required', 'marker exists')
    else ok('1a. hold did not arm .checkpoint-required')
  },
})

// 2. Same command, active:false → ALLOW. Regression cell for the R5
// consult-gap fix at HEAD (b520212): with NO plan and nothing armed, the
// classifier hold must consult enforce-config and be silenced.
cell('2. novel Bash + active:false → ALLOW (R5 consult-gap regression: hold silenced)', {
  setup: () => resetState('off'),
  tool: 'Bash', input: NOVEL,
  expect: 'SILENCE', telemetry: 'silence',
})

// 3. Same command, enforce-config.json missing → HOLD (loadEnforceConfig
// identity {active:true} — fail-closed default).
cell('3. novel Bash + enforce-config missing → HOLD (fail-closed)', {
  setup: () => resetState('missing'),
  tool: 'Bash', input: NOVEL,
  expect: 'HOLD', substring: 'classif', telemetry: 'hold',
})

// 4. Same command, enforce-config malformed JSON → HOLD (fail-closed).
cell('4. novel Bash + enforce-config malformed → HOLD (fail-closed)', {
  setup: () => resetState('malformed'),
  tool: 'Bash', input: NOVEL,
  expect: 'HOLD', substring: 'classif', telemetry: 'hold',
})

// 5. Bash read_only → ALLOW regardless of active (exits before any consult).
cell('5a. Bash read_only (git status) + active:true → ALLOW', {
  setup: () => resetState('seed'),
  tool: 'Bash', input: { command: 'git status' },
  expect: 'ALLOW', telemetry: 'allow',
})
cell('5b. Bash read_only (git status) + active:false → ALLOW (active irrelevant)', {
  setup: () => resetState('off'),
  tool: 'Bash', input: { command: 'git status' },
  expect: 'ALLOW', telemetry: 'allow',
})

// 6. Edit targeting repo source, plan-approval token present, active:true →
// BLOCK (pre-checkpoint materializes at the implementation boundary).
cell('6. repo-source Edit + .plan-approved token + active:true → BLOCK (pre-checkpoint)', {
  setup: () => { resetState('seed'); seedApproval() },
  tool: 'Edit', input: { file_path: path.join(M.project, 'src-app.txt') },
  expect: 'BLOCK', substring: 'Checkpoint required', telemetry: 'block',
  post: () => {
    // Contract detail: the block lazily ARMS the checkpoint and consumes the
    // one-shot approval token (planapproval redesign, transactional consume).
    if (!fs.existsSync(path.join(CKPT, `.checkpoint-required.${SID}`))) bad('6a. block armed .checkpoint-required.<sid>', 'marker missing')
    else ok('6a. block armed .checkpoint-required.<sid>')
    if (fs.existsSync(path.join(CKPT, `.plan-approved.${SID}`))) bad('6b. approval token consumed on arm', 'token still present')
    else ok('6b. approval token consumed on arm')
  },
})

// 7. Same Edit, active:false → ALLOW (F11 pre_checkpoint consult silences).
cell('7. repo-source Edit + .plan-approved token + active:false → ALLOW (silenced)', {
  setup: () => { resetState('off'); seedApproval() },
  tool: 'Edit', input: { file_path: path.join(M.project, 'src-app.txt') },
  expect: 'SILENCE', telemetry: 'silence',
})

// 8. Edit targeting a NON-repo path → ALLOW regardless (smart-arming:
// off-repo writes never gate; terminal fall-through allow).
cell('8. Edit targeting non-repo path → ALLOW regardless', {
  setup: () => resetState('seed'),
  tool: 'Edit', input: { file_path: path.join(M.base, 'outside-the-repo.txt') },
  expect: 'ALLOW', telemetry: 'allow',
})

// 9. git push, no verified post-checkpoint, active:true → BLOCK (push
// self-arms POST_REQ — independent hard gate, B1/D7 backstop).
cell('9. git push + no post-checkpoint + active:true → BLOCK (push-gate)', {
  setup: () => resetState('seed'),
  tool: 'Bash', input: { command: 'git push origin main' },
  expect: 'BLOCK', substring: 'Post-implementation checkpoint required', telemetry: 'block',
  post: () => {
    if (!fs.existsSync(path.join(CKPT, `.post-checkpoint-required.${SID}`))) bad('9a. push self-armed .post-checkpoint-required.<sid>', 'marker missing')
    else ok('9a. push self-armed .post-checkpoint-required.<sid>')
  },
})

// 10. git push, active:false, .checkpoint-required armed → the F10 silenced
// path still exits 0 AND runs the cleanup sweep (no stranded markers → no
// stop-gate deadlock).
cell('10. git push + active:false + armed checkpoint → ALLOW (F10: silence still sweeps)', {
  setup: () => {
    resetState('off')
    fs.writeFileSync(path.join(CKPT, `.checkpoint-required.${SID}`), '')
  },
  tool: 'Bash', input: { command: 'git push origin main' },
  expect: 'SILENCE', telemetry: 'silence',
  post: () => {
    const leftovers = fs.readdirSync(CKPT).filter((f) => f.startsWith('.checkpoint-required'))
    if (leftovers.length) bad('10a. no leftover .checkpoint-required after silenced push', `stranded: ${leftovers.join(', ')}`)
    else ok('10a. no leftover .checkpoint-required after silenced push (F10 sweep ran)')
  },
})

// ---------------------------------------------------------------------------
// Telemetry sweep (also the E5 acceptance): the fixture log holds exactly one
// line per matrix decision, in order, with the expected decision values and a
// parseable controlled-token shape.
// ---------------------------------------------------------------------------
{
  const lines = logLines()
  if (lines.length === expectedDecisions.length) ok(`telemetry: ${lines.length} log lines — one per matrix decision`)
  else bad('telemetry line count', `log has ${lines.length}, matrix produced ${expectedDecisions.length}`)
  const decisions = []
  let parseFail = null
  for (const line of lines) {
    try {
      const row = JSON.parse(line)
      decisions.push(row.decision)
      for (const field of ['ts', 'gate', 'tool', 'label', 'reason', 'decision', 'sid', 'cmd_sha256']) {
        if (!(field in row)) throw new Error(`missing field ${field}`)
      }
    } catch (e) { parseFail = `${e.message}: ${line}` }
  }
  if (parseFail) bad('telemetry: every line parses with the full field set', parseFail)
  else ok('telemetry: every line parses with the full field set')
  if (decisions.join(',') === expectedDecisions.join(',')) ok(`telemetry: decision sequence matches matrix (${decisions.join(',')})`)
  else bad('telemetry decision sequence', `log=[${decisions.join(',')}] expected=[${expectedDecisions.join(',')}]`)
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} pass`)
process.exit(fail === 0 ? 0 : 1)
