#!/usr/bin/env node
// test-enforcement-scope.mjs — RFC-008 P4d "enforcement scope correction" (ESC) suite.
//
// Proves the gates gate ONLY repo-source writes (locked R1/R2/R3): episodes,
// reads, plan files, and off-repo writes are never blocked; repo-source writes
// while a marker is pending still block.
//
// Every test drives the REAL DEPLOYED gate (<project>/.claude/hooks/<gate>.sh)
// via runHook against an isolated HOME + git mock project installed by the REAL
// install.mjs — no stubs, no mental tracing
// (feedback_mock_project_test_not_mental_trace, feedback_verify_strong_claim).
//
// Slice ladder: ESC-S1 landed t_checkpoint_parity (checkpoint-gate adopts the
// shared lib). ESC-S2 adds the plan-gate tests below + F1 (missing-lib fail-closed,
// both gates) + F2 (multi-redirect mixed). ESC-S3 adds t_no_global_touch + CI wire.
//
// Requires bash + jq on PATH (CI ubuntu-latest has both). Zero deps beyond the harness.

import fs from 'node:fs'
import path from 'node:path'
import { mkMock, runInstall, runHook, deployedScript, hookCodeFilesInGlobalScope } from './lib/activation-scoping-harness.mjs'

let pass = 0, fail = 0
const ok = (n) => { pass++; console.log(`  ✓ ${n}`) }
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}: ${d}`) }

const SID = '11111111-2222-3333-4444-555555555555'
const isBlock = (o) => /"decision"\s*:\s*"block"/.test(o.stdout || '')

// Install one mock project with enforcement gates deployed per-project.
function freshProject(label) {
  const M = mkMock(label)
  const r = runInstall({
    home: M.home, project: M.project, callerCwd: M.callerCwd,
    flags: ['--install-enforcement'],
  })
  if (r.status !== 0) {
    console.error(`install failed (${label}):`, r.stderr)
    process.exit(1)
  }
  M.planGate = path.join(M.project, '.claude', 'hooks', 'plan-gate.sh')
  M.ckptGate = path.join(M.project, '.claude', 'hooks', 'checkpoint-gate.sh')
  return M
}

const fire = (M, gate, tool, input) => runHook(
  gate,
  { tool_name: tool, tool_input: input, cwd: M.project, session_id: SID },
  { home: M.home, project: M.project },
)

const join = (M, rel) => path.join(M.project, rel)

// "arm plan" — write the legacy (suffix-less) plan-approval marker. plan-gate
// honors it in .checkpoints/ (primary) and .claude/ (legacy read path).
function armPlan(M) {
  fs.mkdirSync(path.join(M.project, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(M.project, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(M.project, '.checkpoints', '.plan-approval-pending'), '')
}

// "arm ckpt" — the checkpoint pre-gate engages on the next repo-source write.
function armCkpt(M) {
  fs.mkdirSync(path.join(M.project, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(M.project, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(M.project, '.checkpoints', '.checkpoint-required'), '')
  fs.writeFileSync(path.join(M.project, '.claude', '.checkpoint-required'), '')
}

const cfgPath = (M) => path.join(M.project, '.episodic-memory', 'enforce-config.json')

// ── t_checkpoint_parity (ESC-S1) ────────────────────────────────────────────
// checkpoint-gate adopts the shared predicate. Parity: a repo-source write still
// engages; the NEW docs/plans carve-out allows; the .episodic-memory substrate
// (gitignored) still allows. Asserted at the observable runHook verdict (§14 note).
function t_checkpoint_parity() {
  const M = freshProject('esc-ckpt-parity')
  armCkpt(M)
  const src = fire(M, M.ckptGate, 'Write', { file_path: join(M, 'scripts/foo.mjs') })
  const planf = fire(M, M.ckptGate, 'Write', { file_path: join(M, 'docs/plans/x.md') })
  const sub = fire(M, M.ckptGate, 'Write', { file_path: join(M, '.episodic-memory/x.json') })
  if (isBlock(src)) ok('t_checkpoint_parity: repo-source (scripts/foo.mjs) → engages (block)')
  else bad('t_checkpoint_parity: scripts/foo.mjs', `expected block, got "${(src.stdout || '').trim()}" stderr=${(src.stderr || '').slice(-300)}`)
  if (!isBlock(planf)) ok('t_checkpoint_parity: docs/plans/x.md → allowed (new carve-out)')
  else bad('t_checkpoint_parity: docs/plans/x.md', `expected allow, got "${(planf.stdout || '').trim()}"`)
  if (!isBlock(sub)) ok('t_checkpoint_parity: .episodic-memory/x.json → allowed (substrate)')
  else bad('t_checkpoint_parity: .episodic-memory/x.json', `expected allow, got "${(sub.stdout || '').trim()}"`)
}

// ── t_em_allowed_all_states (R1, REQ-1) ─────────────────────────────────────
// em-store (nonsrc_write) is NEVER blocked by either gate, in any marker state.
function t_em_allowed_all_states() {
  const M = freshProject('esc-em')
  const cmd = `node ${deployedScript(M.home, 'em-store.mjs')} --project test --category decision --summary x --body y`
  const states = [
    ['no-marker', () => {}],
    ['arm-plan', () => armPlan(M)],
    ['arm-plan+ckpt', () => { armPlan(M); armCkpt(M) }],
  ]
  let allOk = true
  for (const [name, arm] of states) {
    arm()
    for (const gate of [['plan', M.planGate], ['ckpt', M.ckptGate]]) {
      const o = fire(M, gate[1], 'Bash', { command: cmd })
      if (isBlock(o)) { allOk = false; bad(`t_em_allowed_all_states[${name}/${gate[0]}]`, `blocked: "${(o.stdout || '').trim()}"`) }
    }
  }
  if (allOk) ok('t_em_allowed_all_states: em-store allowed by both gates across 3 marker states (6 calls)')
}

// ── t_planfile_allowed (R1, REQ-2) ──────────────────────────────────────────
function t_planfile_allowed() {
  const M = freshProject('esc-planfile')
  armPlan(M)
  const o = fire(M, M.planGate, 'Write', { file_path: join(M, 'docs/plans/new.md') })
  if (!isBlock(o)) ok('t_planfile_allowed: Write docs/plans/new.md under pending plan → allowed')
  else bad('t_planfile_allowed', `expected allow, got "${(o.stdout || '').trim()}"`)
}

// ── t_nonsrc_carveouts_allowed (R1) ─────────────────────────────────────────
function t_nonsrc_carveouts_allowed() {
  const M = freshProject('esc-carveouts')
  armPlan(M)
  const rels = ['.episodic-memory/x.json', '.checkpoints/y', '.review-store/z.md', '.git/COMMIT_EDITMSG']
  let allOk = true
  for (const rel of rels) {
    const o = fire(M, M.planGate, 'Write', { file_path: join(M, rel) })
    if (isBlock(o)) { allOk = false; bad(`t_nonsrc_carveouts_allowed[${rel}]`, `blocked: "${(o.stdout || '').trim()}"`) }
  }
  if (allOk) ok('t_nonsrc_carveouts_allowed: .episodic-memory/.checkpoints/.review-store/.git writes allowed')
}

// ── t_empty_path_blocks_clean (REQ-12) ──────────────────────────────────────
// The invariant is that a block leaks no MARKER state (nothing that alters a
// later gate decision). gate-log.jsonl is E5 append-only telemetry — written
// on every terminal decision by design, read by nothing on the decision path —
// so it is excluded from the state comparison.
function t_empty_path_blocks_clean() {
  const M = freshProject('esc-empty')
  armPlan(M)
  const ckDir = path.join(M.project, '.checkpoints')
  const markerState = () => fs.readdirSync(ckDir).filter(f => f !== 'gate-log.jsonl').sort()
  const before = markerState()
  const o = fire(M, M.planGate, 'Write', {})
  const after = markerState()
  const unchanged = JSON.stringify(before) === JSON.stringify(after)
  if (isBlock(o) && unchanged) ok('t_empty_path_blocks_clean: empty path → block, no marker leaked')
  else bad('t_empty_path_blocks_clean', `block=${isBlock(o)} unchanged=${unchanged} before=${before} after=${after}`)
}

// ── t_read_always_allowed (R2, REQ-6) ───────────────────────────────────────
function t_read_always_allowed() {
  const M = freshProject('esc-read')
  armPlan(M)
  const r1 = fire(M, M.planGate, 'Read', { file_path: join(M, 'scripts/x.mjs') })
  const r2 = fire(M, M.planGate, 'Bash', { command: 'ls -la' })
  if (!isBlock(r1) && !isBlock(r2)) ok('t_read_always_allowed: Read + read-only Bash allowed under pending plan')
  else bad('t_read_always_allowed', `read=${isBlock(r1)} ls=${isBlock(r2)}`)
}

// ── t_reposrc_write_blocked (R2, REQ-7) ─────────────────────────────────────
function t_reposrc_write_blocked() {
  const M = freshProject('esc-reposrc')
  armPlan(M)
  const o = fire(M, M.planGate, 'Write', { file_path: join(M, 'scripts/foo.mjs') })
  if (isBlock(o)) ok('t_reposrc_write_blocked: Write scripts/foo.mjs under pending plan → block')
  else bad('t_reposrc_write_blocked', `expected block, got "${(o.stdout || '').trim()}"`)
}

// ── t_consult_fail_closed (REQ-9, EC6) ──────────────────────────────────────
// Garbage enforce-config → resolver errors → fail-CLOSED (ENFORCE, not silenced).
function t_consult_fail_closed() {
  const M = freshProject('esc-failclosed')
  armPlan(M)
  fs.writeFileSync(cfgPath(M), '{bad json')
  const o = fire(M, M.planGate, 'Write', { file_path: join(M, 'scripts/foo.mjs') })
  if (isBlock(o)) ok('t_consult_fail_closed: garbage enforce-config → repo-source write still blocked')
  else bad('t_consult_fail_closed', `expected block, got "${(o.stdout || '').trim()}"`)
}

// ── t_offrepo_write_allowed (R3, EC2) ───────────────────────────────────────
function t_offrepo_write_allowed() {
  const M = freshProject('esc-offrepo')
  armPlan(M)
  const a = fire(M, M.planGate, 'Write', { file_path: '/tmp/esc-offrepo.txt' })
  // axis-4: a /var-symlinked path that canonicalizes to /private/var on macOS.
  const b = fire(M, M.planGate, 'Write', { file_path: '/var/tmp/esc-offrepo-var.txt' })
  if (!isBlock(a) && !isBlock(b)) ok('t_offrepo_write_allowed: /tmp + /var/tmp off-repo writes allowed')
  else bad('t_offrepo_write_allowed', `tmp=${isBlock(a)} var=${isBlock(b)}`)
}

// ── t_offrepo_redirect_allowed (R3, REQ-5, EC3) ─────────────────────────────
function t_offrepo_redirect_allowed() {
  const M = freshProject('esc-offrepo-redir')
  armPlan(M)
  const o = fire(M, M.planGate, 'Bash', { command: 'echo x > /tmp/esc-redir.txt' })
  if (!isBlock(o)) ok('t_offrepo_redirect_allowed: echo x > /tmp/... → allowed (TARGET localized off-repo)')
  else bad('t_offrepo_redirect_allowed', `expected allow, got "${(o.stdout || '').trim()}"`)
}

// ── t_perproject_isolation (R5, EC5) ────────────────────────────────────────
// Project A active:false silences; project B active:true blocks. No cross-silence.
function t_perproject_isolation() {
  const A = freshProject('esc-iso-a')
  const B = freshProject('esc-iso-b')
  fs.writeFileSync(cfgPath(A), '{"active":false}\n')
  fs.writeFileSync(cfgPath(B), '{"active":true}\n')
  armPlan(A); armPlan(B)
  const oa = fire(A, A.planGate, 'Write', { file_path: join(A, 'scripts/foo.mjs') })
  const ob = fire(B, B.planGate, 'Write', { file_path: join(B, 'scripts/foo.mjs') })
  if (!isBlock(oa) && isBlock(ob)) ok('t_perproject_isolation: A(active:false)→allow, B(active:true)→block — no cross-silence')
  else bad('t_perproject_isolation', `A=${isBlock(oa)} B=${isBlock(ob)}`)
}

// ── t_missing_lib_fails_closed (F1) ─────────────────────────────────────────
// Removing the deployed repo-source.sh fails CLOSED on BOTH gates.
function t_missing_lib_fails_closed() {
  const M = freshProject('esc-missinglib')
  armPlan(M); armCkpt(M)
  fs.rmSync(path.join(M.project, '.claude', 'hooks', 'lib', 'repo-source.sh'))
  const p = fire(M, M.planGate, 'Write', { file_path: join(M, 'scripts/foo.mjs') })
  const c = fire(M, M.ckptGate, 'Write', { file_path: join(M, 'scripts/foo.mjs') })
  if (isBlock(p) && isBlock(c)) ok('t_missing_lib_fails_closed: missing repo-source.sh → both gates fail CLOSED')
  else bad('t_missing_lib_fails_closed', `plan=${isBlock(p)} ckpt=${isBlock(c)}`)
}

// ── t_multi_redirect_mixed (F2) ─────────────────────────────────────────────
// Two non-marker redirects (one repo-source, one off-repo) → ambiguous target
// cleared → conservative gate (block), not last-target-wins.
function t_multi_redirect_mixed() {
  const M = freshProject('esc-multiredir')
  armPlan(M)
  const o = fire(M, M.planGate, 'Bash', { command: 'echo x > scripts/foo.mjs 2> /tmp/log' })
  if (isBlock(o)) ok('t_multi_redirect_mixed: echo > scripts/foo.mjs 2> /tmp/log → block (no last-target-wins)')
  else bad('t_multi_redirect_mixed', `expected block, got "${(o.stdout || '').trim()}"`)
}

// ── t_offrepo_relative_escape (R3, F1) ──────────────────────────────────────
// A relative `..`-escape writes OUTSIDE the repo → must be ALLOWED, matching the
// absolute-collapsed form (no `..`-overblock). And traversal BACK into the repo
// must still BLOCK (no fail-OPEN introduced by the `..` carve).
function t_offrepo_relative_escape() {
  const M = freshProject('esc-rel-escape')
  armPlan(M)
  const w = fire(M, M.planGate, 'Write', { file_path: '../escape.txt' })
  const r = fire(M, M.planGate, 'Bash', { command: 'echo hi > ../escape2.txt' })
  const back = fire(M, M.planGate, 'Bash', { command: 'echo x > docs/../scripts/evil.mjs' })
  if (!isBlock(w) && !isBlock(r) && isBlock(back)) {
    ok('t_offrepo_relative_escape: ../escape Write+redirect → allow (R3); docs/../scripts/evil.mjs → block (no fail-open)')
  } else {
    bad('t_offrepo_relative_escape', `write=${isBlock(w)} redirect=${isBlock(r)} back-into-repo=${isBlock(back)}`)
  }
}

// ── t_no_global_touch (REQ-11, P12) ─────────────────────────────────────────
// ESC deploys enforcement gates per-project only; the global ~/.claude/hooks/
// tree stays empty of enforcement code. Asserts the substrate-stays-hook-free
// invariant for the exact --install-enforcement path this suite drives (the
// same install freshProject() uses), not a stub.
function t_no_global_touch() {
  const M = freshProject('esc-no-global')
  const globalHookCode = hookCodeFilesInGlobalScope(M.home)
  if (globalHookCode.length === 0) {
    ok('t_no_global_touch: ~/.claude/hooks/ has zero enforcement code after --install-enforcement (REQ-11)')
  } else {
    bad('t_no_global_touch', `expected [] (P12 global-clean), got ${JSON.stringify(globalHookCode)}`)
  }
}

t_checkpoint_parity()
t_offrepo_relative_escape()
t_no_global_touch()
t_em_allowed_all_states()
t_planfile_allowed()
t_nonsrc_carveouts_allowed()
t_empty_path_blocks_clean()
t_read_always_allowed()
t_reposrc_write_blocked()
t_consult_fail_closed()
t_offrepo_write_allowed()
t_offrepo_redirect_allowed()
t_perproject_isolation()
t_missing_lib_fails_closed()
t_multi_redirect_mixed()

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
