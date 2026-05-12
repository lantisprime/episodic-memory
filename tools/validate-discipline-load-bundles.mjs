#!/usr/bin/env node
/**
 * validate-discipline-load-bundles.mjs — Rule 14 validator for the rank-10
 * discipline-load slice.
 *
 * Verifies machine-readable trigger map ↔ on-disk file inventory:
 *
 *   1. Every always-tier file (constant below) exists on disk at the
 *      configured memory_root.
 *   2. Every component listed in any bundles/*.md (via the bundle-manifest
 *      JSON block) exists on disk.
 *   3. Every feedback_*.md / reference_*.md file at memory_root is registered
 *      somewhere: always-tier ∪ {bundle components} ∪ explicit exclusion-
 *      allowlist (each excluded file carries a one-line rationale).
 *   4. Installed runtime hook sha matches committed source hook (T9 / F10).
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — at least one violation
 *   2 — CLI usage error
 *
 * Designed to run in CI; output is structured JSON + human-readable summary.
 *
 * Codex consensus chain (5 rounds, 2026-05-12): episodes …ef14 → …0355.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import process from 'process'

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { memoryRoot: null, repoRoot: null, json: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--memory-root') out.memoryRoot = argv[++i]
    else if (a === '--repo-root') out.repoRoot = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function usage() {
  process.stderr.write(`Usage: node ${path.basename(process.argv[1])} --memory-root <path> --repo-root <path> [--json]

Required:
  --memory-root <path>   Memory directory containing feedback_*.md / reference_*.md
  --repo-root <path>     Repo root (contains bundles/, hooks/)

Optional:
  --json                 Emit machine-readable JSON to stdout

Exit codes:
  0  all checks pass
  1  at least one violation
  2  CLI usage error
`)
}

// ---------------------------------------------------------------------------
// Constants — the single source of truth for what loads always
// ---------------------------------------------------------------------------

export const ALWAYS_TIER = [
  'MEMORY.md',
  'feedback_verify_by_artifact.md',
  'feedback_self_trigger_artifact_mode.md',
  'feedback_per_prompt_rule_preflight.md',
  'feedback_send_grep_artifact.md',
  'feedback_three_state_review_verdict.md',
  'feedback_bp1_step9_filing_trigger.md',
  'feedback_canonical_agent_dispatch_trigger.md'
]

// Files present on disk but intentionally NOT loaded at session start.
// Each entry: { basename, rationale }. Rationale is a one-line spec citation
// or design note explaining why this file is neither always-tier nor in any
// bundle.
//
// FU-2 (workplan-tracked): bundle registration is incomplete for the lazy
// tier. Once trigger-phrase bundles are filled out for plan-time-matrix,
// adversarial-code-review, rule-bearing-file-edit, scratch-files, wrap-up-
// discipline, many entries will MOVE from this allowlist into those bundles.
export const EXCLUSION_ALLOWLIST = {
  'feedback_canonical_prompt_as_episode.md': 'Lazy: codex review payload shape; loaded with codex-review-handoff bundle (FU-2 to register).',
  'feedback_check_episodes_before_analysis.md': 'Lazy: synthesis-task trigger; FU-2 to register in adversarial-code-review.',
  'feedback_codex_cli_augments_async.md': 'Lazy: dual-transport ζ for high-stakes RFCs; FU-2 to register in codex-review-handoff.',
  'feedback_consult_kb_claude_docs.md': 'Lazy: Claude internals state-claims; FU-2 to register.',
  'feedback_global_allowlist_scope.md': 'Lazy: per-project allowlist hygiene; FU-2 to register in scratch-files/wrap-up.',
  'feedback_inline_fu_heuristic.md': 'Lazy: bp-001 step-9 disposition heuristic; FU-2 to register in wrap-up-discipline.',
  'feedback_load_discipline_at_session_start.md': 'Lazy: meta-rule about session-start load itself; redundant once always-tier ships (this slice).',
  'feedback_local_episodes_main_store.md': 'Lazy: em-store hygiene; FU-2 to register in scratch-files.',
  'feedback_memory_tier_persistence.md': 'Lazy: tier-1/2/3 audit at wrap-up; FU-2 to register in wrap-up-discipline.',
  'feedback_quoted_string_regex_traps.md': 'Lazy: shell-regex trap; FU-2 to register in rule-bearing-file-edit.',
  'feedback_reach_consensus_with_codex.md': 'Lazy: iterate without between-round confirmation; FU-2 to register in codex-review-handoff.',
  'feedback_read_episodes_directly.md': 'Lazy: em-read vs em-search; FU-2 to register.',
  'feedback_reduce_friction.md': 'Lazy: workflow ergonomics; FU-2 to register.',
  'feedback_spec_vs_runtime.md': 'Lazy: divergence audit; FU-2 to register in rule-bearing-file-edit.',
  'feedback_validate_pr_applied_locally.md': 'Lazy: post-merge validation; FU-2 to register in wrap-up-discipline.',
  'feedback_verify_file_branch.md': 'Lazy: branch-state check; FU-2 to register.',
  'feedback_workplan_display_format.md': 'Lazy: formatting rule; FU-2 to register.',
  'feedback_workplan_session_start.md': 'Lazy: session-start workplan pointer; FU-2 to register.',
  'feedback_workplan_table_format.md': 'Lazy: workplan table format; FU-2 to register.',
  'feedback_anchor_prior_lessons.md': 'Lazy: review-output trigger; FU-2 to register in adversarial-code-review.',
  'feedback_avoid_compound_bash.md': 'Lazy: shell hygiene; FU-2 to register in wrap-up-discipline.',
  'feedback_avoid_dev_null_redirect.md': 'Lazy: shell hygiene; FU-2 to register in wrap-up-discipline.',
  'feedback_bp001_rightsize.md': 'Lazy: bp-001 scope; FU-2 to register in wrap-up-discipline.',
  'feedback_cite_spec_dont_guess.md': 'Lazy: "why didn\'t X catch this" trigger; FU-2 to register.',
  'feedback_cluster_findings_by_class.md': 'Lazy: review-output trigger; FU-2 to register in adversarial-code-review.',
  'feedback_contract_density_warning.md': 'Lazy: spec-density trigger; FU-2 to register in plan-time-matrix.',
  'feedback_defer_requires_per_member_repro.md': 'Lazy: defer-time discipline; FU-2 to register in plan-time-matrix.',
  'feedback_diagnose_via_transcripts.md': 'Lazy: tool-failure trigger; FU-2 to register in codex-review-handoff.',
  'feedback_em_store_scope.md': 'Lazy: em-store scope hygiene; FU-2 to register.',
  'feedback_fixture_transitive_imports.md': 'Lazy: test-fixture trigger; FU-2 to register in rule-bearing-file-edit.',
  'feedback_handoff_merge_pending.md': 'Lazy: Rule 9 handoff; FU-2 to register in wrap-up-discipline.',
  'feedback_implementer_second_order_review.md': 'Lazy: HOLD-response trigger; FU-2 to register in adversarial-code-review.',
  'feedback_independence_of_judgments.md': 'Lazy: review-pressure trigger; FU-2 to register in adversarial-code-review.',
  'feedback_invariant_first_review.md': 'Lazy: review-output trigger; FU-2 to register in adversarial-code-review.',
  'feedback_no_chained_commit_push.md': 'Lazy: wrap-up trigger; FU-2 to register in wrap-up-discipline.',
  'feedback_no_self_authored_independent_voice.md': 'Lazy: PR review trigger; FU-2 to register.',
  'feedback_plan_time_attack_analysis.md': 'Lazy: plan-time trigger; FU-2 to register in plan-time-matrix.',
  'feedback_pre_action_briefing.md': 'Lazy: architectural-work trigger; FU-2 to register.',
  'feedback_pre_review_smoke_e2e.md': 'Lazy: pre-review trigger; FU-2 to register in rule-bearing-file-edit.',
  'feedback_process_chaining_fractal.md': 'Lazy: plan-execution discipline; FU-2 to register in wrap-up-discipline.',
  'feedback_project_root_binding_audit.md': 'Lazy: discipline #20 trigger; FU-2 to register in rule-bearing-file-edit.',
  'feedback_repro_attack_pre_merge.md': 'Lazy: security/validator trigger; FU-2 to register in plan-time-matrix.',
  'feedback_same_class_completeness.md': 'Lazy: class-fix trigger; FU-2 to register in plan-time-matrix.',
  'feedback_scratch_in_tree.md': 'Lazy: scratch-file trigger; FU-2 to register in scratch-files.',
  'feedback_second_opinion_harness_runbook.md': 'Bundle: registered in bundles/codex-review-channel-current.md.',
  'feedback_semantic_role_audit.md': 'Lazy: class-fix trigger; FU-2 to register in plan-time-matrix.',
  'feedback_spec_cycle_stop_condition.md': 'Lazy: round-3+ review trigger; FU-2 to register in adversarial-code-review.',
  'feedback_subprocess_not_e2e.md': 'Lazy: BP-1 step 8 trigger; FU-2 to register in rule-bearing-file-edit.',
  'feedback_test_resource_existence_check.md': 'Lazy: test-discipline trigger; FU-2 to register in rule-bearing-file-edit.',
  'feedback_validation_timing_checklist.md': 'Lazy: config-driven-feature trigger; FU-2 to register in rule-bearing-file-edit.',
  'feedback_violation_writeback.md': 'Lazy: violation-catching trigger; FU-2 to register in wrap-up-discipline.',
  'feedback_codex_cli_episode_messaging.md': 'Bundle: registered in bundles/codex-review-channel-current.md.',
  'feedback_codex_review_episodes_both_halves.md': 'Lazy: codex review trigger; FU-2 to register in codex-review-handoff bundle.',
  'feedback_codex_review_request_preamble.md': 'Bundle: registered in bundles/codex-review-channel-current.md.',
  'feedback_dont_fabricate_codex_reply.md': 'Lazy: codex review trigger; FU-2 to register in codex-review-handoff.',
  'feedback_subagent_cli_episode_messaging.md': 'Bundle: registered in bundles/codex-review-channel-current.md.',
  'reference_codex_review_flow.md': 'Bundle: registered in bundles/codex-review-channel-current.md.',
  'reference_second_opinion_harness.md': 'Bundle: registered in bundles/codex-review-channel-current.md.'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shaFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function parseBundleManifest(bundleFilePath) {
  // Bundles embed a fenced ```json:bundle-manifest block. Extract and parse.
  const text = fs.readFileSync(bundleFilePath, 'utf8')
  const re = /```json:bundle-manifest\s*\n([\s\S]*?)\n```/m
  const m = text.match(re)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

function listBundles(repoRoot) {
  const bundlesDir = path.join(repoRoot, 'bundles')
  if (!fs.existsSync(bundlesDir)) return []
  return fs.readdirSync(bundlesDir)
    .filter(n => n.endsWith('.md'))
    .map(n => path.join(bundlesDir, n))
}

function listMemoryFiles(memoryRoot) {
  if (!fs.existsSync(memoryRoot)) return []
  return fs.readdirSync(memoryRoot)
    .filter(n => (n.startsWith('feedback_') || n.startsWith('reference_')) && n.endsWith('.md'))
    .sort()
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

export function validate({ memoryRoot, repoRoot }) {
  const result = {
    status: 'ok',
    memory_root: memoryRoot,
    repo_root: repoRoot,
    checks: {},
    missing_files: [],
    unregistered_files: [],
    malformed_entries: [],
    sync_drift: [],
    warnings: []
  }

  // ----- Check 1: always-tier files exist
  const alwaysTierResults = []
  for (const f of ALWAYS_TIER) {
    const p = path.join(memoryRoot, f)
    const exists = fs.existsSync(p)
    alwaysTierResults.push({ basename: f, exists, path: p })
    if (!exists) result.missing_files.push({ kind: 'always-tier', basename: f, expected_path: p })
  }
  result.checks.always_tier = alwaysTierResults

  // ----- Check 2: bundle components exist + manifest parses
  const bundleFiles = listBundles(repoRoot)
  const bundleComponentSet = new Set()
  const bundleResults = []
  for (const bf of bundleFiles) {
    const manifest = parseBundleManifest(bf)
    if (!manifest) {
      result.malformed_entries.push({ kind: 'bundle-manifest-unparseable', path: bf })
      bundleResults.push({ bundle: path.basename(bf), parsed: false })
      continue
    }
    const components = []
    for (const c of manifest.components || []) {
      const p = path.join(memoryRoot, c.basename)
      const exists = fs.existsSync(p)
      components.push({ basename: c.basename, exists, role: c.role })
      bundleComponentSet.add(c.basename)
      if (!exists) result.missing_files.push({ kind: 'bundle-component', basename: c.basename, bundle: path.basename(bf), expected_path: p })
    }
    bundleResults.push({ bundle: path.basename(bf), parsed: true, components })
  }
  result.checks.bundles = bundleResults

  // ----- Check 3: every memory file is registered somewhere
  const memFiles = listMemoryFiles(memoryRoot)
  const alwaysTierSet = new Set(ALWAYS_TIER)
  const exclusionSet = new Set(Object.keys(EXCLUSION_ALLOWLIST))
  const inventoryResults = []
  for (const f of memFiles) {
    let category, rationale = null
    if (alwaysTierSet.has(f)) category = 'always-tier'
    else if (bundleComponentSet.has(f)) category = 'bundle'
    else if (exclusionSet.has(f)) { category = 'exclusion-allowlist'; rationale = EXCLUSION_ALLOWLIST[f] }
    else {
      category = 'unregistered'
      result.unregistered_files.push({ basename: f, path: path.join(memoryRoot, f) })
    }
    inventoryResults.push({ basename: f, category, rationale })
  }
  result.checks.inventory = inventoryResults

  // ----- Check 4: installed-runtime ↔ committed-source sha sync (T9 / F10)
  const sourceHook = path.join(repoRoot, 'hooks', 'session-handoff-prompt.sh')
  const installedHook = path.join(os.homedir(), '.claude', 'hooks', 'session-handoff-prompt.sh')
  const syncResult = { source: sourceHook, installed: installedHook }
  if (!fs.existsSync(sourceHook)) {
    syncResult.status = 'source-missing'
    result.sync_drift.push(syncResult)
  } else if (!fs.existsSync(installedHook)) {
    syncResult.status = 'installed-missing'
    result.warnings.push('session-handoff-prompt.sh not installed at ~/.claude/hooks/ — run install or copy')
  } else {
    const ss = shaFile(sourceHook)
    const is_ = shaFile(installedHook)
    syncResult.source_sha = ss
    syncResult.installed_sha = is_
    syncResult.status = ss === is_ ? 'in-sync' : 'drift'
    if (ss !== is_) result.sync_drift.push(syncResult)
  }
  result.checks.source_install_sync = syncResult

  // ----- Final status
  if (
    result.missing_files.length > 0 ||
    result.unregistered_files.length > 0 ||
    result.malformed_entries.length > 0 ||
    result.sync_drift.length > 0
  ) {
    result.status = 'fail'
  }

  return result
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv)
  if (args.help) { usage(); process.exit(0) }
  if (!args.memoryRoot || !args.repoRoot) {
    usage()
    process.exit(2)
  }

  const r = validate({ memoryRoot: args.memoryRoot, repoRoot: args.repoRoot })

  if (args.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  } else {
    process.stdout.write(`Status: ${r.status}\n`)
    process.stdout.write(`  memory_root: ${r.memory_root}\n`)
    process.stdout.write(`  repo_root:   ${r.repo_root}\n`)
    process.stdout.write(`  always-tier files: ${r.checks.always_tier.length} (${r.checks.always_tier.filter(c => c.exists).length} present)\n`)
    process.stdout.write(`  bundles parsed:    ${r.checks.bundles.filter(b => b.parsed).length}/${r.checks.bundles.length}\n`)
    process.stdout.write(`  inventory total:   ${r.checks.inventory.length}\n`)
    process.stdout.write(`    always-tier:     ${r.checks.inventory.filter(i => i.category === 'always-tier').length}\n`)
    process.stdout.write(`    bundle:          ${r.checks.inventory.filter(i => i.category === 'bundle').length}\n`)
    process.stdout.write(`    exclusion:       ${r.checks.inventory.filter(i => i.category === 'exclusion-allowlist').length}\n`)
    process.stdout.write(`    unregistered:    ${r.checks.inventory.filter(i => i.category === 'unregistered').length}\n`)
    process.stdout.write(`  source/install sync: ${r.checks.source_install_sync.status}\n`)
    if (r.missing_files.length > 0) {
      process.stdout.write(`\nMissing files (${r.missing_files.length}):\n`)
      for (const m of r.missing_files) process.stdout.write(`  - [${m.kind}] ${m.basename}\n`)
    }
    if (r.unregistered_files.length > 0) {
      process.stdout.write(`\nUnregistered files (${r.unregistered_files.length}):\n`)
      for (const u of r.unregistered_files) process.stdout.write(`  - ${u.basename}\n`)
    }
    if (r.malformed_entries.length > 0) {
      process.stdout.write(`\nMalformed entries:\n`)
      for (const e of r.malformed_entries) process.stdout.write(`  - [${e.kind}] ${e.path || e.basename}\n`)
    }
    if (r.sync_drift.length > 0) {
      process.stdout.write(`\nSource/install sync drift:\n`)
      for (const d of r.sync_drift) process.stdout.write(`  - [${d.status}] ${d.installed}\n`)
    }
    if (r.warnings.length > 0) {
      process.stdout.write(`\nWarnings:\n`)
      for (const w of r.warnings) process.stdout.write(`  - ${w}\n`)
    }
  }

  process.exit(r.status === 'ok' ? 0 : 1)
}

// Run as CLI when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
