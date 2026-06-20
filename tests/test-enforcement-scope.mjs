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
// Slice ladder: ESC-S1 lands the checkpoint-gate parity test below. ESC-S2 adds
// the plan-gate tests (t_em_allowed_all_states, t_planfile_allowed,
// t_nonsrc_carveouts_allowed, t_reposrc_write_blocked, t_read_always_allowed,
// t_empty_path_blocks_clean, t_consult_fail_closed, t_offrepo_write_allowed,
// t_offrepo_redirect_allowed, t_perproject_isolation, t_missing_lib_fails_closed,
// t_multi_redirect_mixed). ESC-S3 adds t_no_global_touch + full E2E.
//
// Requires bash + jq on PATH (CI ubuntu-latest has both). Zero deps beyond the harness.

import fs from 'node:fs'
import path from 'node:path'
import { mkMock, runInstall, runHook } from './lib/activation-scoping-harness.mjs'

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

// "arm ckpt" — the checkpoint pre-gate would engage on the next repo-source write.
function armCkpt(M) {
  fs.mkdirSync(path.join(M.project, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(M.project, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(M.project, '.checkpoints', '.checkpoint-required'), '')
  fs.writeFileSync(path.join(M.project, '.claude', '.checkpoint-required'), '')
}

const join = (M, rel) => path.join(M.project, rel)

// ── t_checkpoint_parity (ESC-S1) ────────────────────────────────────────────
// checkpoint-gate adopts the shared predicate. Parity: a repo-source write still
// engages; the NEW docs/plans carve-out allows; the .episodic-memory substrate
// (gitignored) still allows pre/post (F5). Asserted at the observable runHook
// verdict, never an internal predicate return (§14 note).
function t_checkpoint_parity() {
  const M = freshProject('esc-ckpt-parity')
  armCkpt(M)

  const src = fire(M, M.ckptGate, 'Write', { file_path: join(M, 'scripts/foo.mjs') })
  const planf = fire(M, M.ckptGate, 'Write', { file_path: join(M, 'docs/plans/x.md') })
  const sub = fire(M, M.ckptGate, 'Write', { file_path: join(M, '.episodic-memory/x.json') })

  if (isBlock(src)) ok('t_checkpoint_parity: repo-source (scripts/foo.mjs) → engages (block)')
  else bad('t_checkpoint_parity: scripts/foo.mjs', `expected block, got stdout="${(src.stdout || '').trim()}" stderr=${(src.stderr || '').slice(-300)}`)

  if (!isBlock(planf)) ok('t_checkpoint_parity: docs/plans/x.md → allowed (new carve-out)')
  else bad('t_checkpoint_parity: docs/plans/x.md', `expected allow, got stdout="${(planf.stdout || '').trim()}"`)

  if (!isBlock(sub)) ok('t_checkpoint_parity: .episodic-memory/x.json → allowed (substrate, gitignored)')
  else bad('t_checkpoint_parity: .episodic-memory/x.json', `expected allow, got stdout="${(sub.stdout || '').trim()}"`)
}

t_checkpoint_parity()

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
