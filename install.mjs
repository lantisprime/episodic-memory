#!/usr/bin/env node
/**
 * install.mjs — Install episodic-memory scripts globally and per-tool instructions.
 *
 * Usage:
 *   node install.mjs --tool <claude-code|cursor|codex|windsurf|all> [--project <path>]
 *
 * Steps:
 *   1. Copies scripts to ~/.episodic-memory/scripts/
 *   2. Creates ~/.episodic-memory/episodes/ if not exists
 *   3. Copies the appropriate instruction file to the target project (or cwd)
 *   4. Creates .episodic-memory/ in the target project for local episodes
 *
 * For Claude Code, also sets up the plugin structure.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { eventsVersion } from './scripts/lib/version-hash.mjs'
import { findEnforcementTokens } from './scripts/lib/em-recall-purity.mjs'
import {
  HOOK_SPECS, SESSION_END_SCRIPT, ENFORCEMENT_HOOK_SCRIPTS, ENFORCE_CONFIG_SEED,
  enforcementHookFileBasenames, enforcementRegistrations, enforcementHookLibBasenames,
  isEnforcementEntryScript, isSubstrateScript, enforcementEntryScripts, enforcementBundleLibs,
  globalScriptLibs, relocatedOnlyLibs, bp1EntryScripts, bp1ClosureLibs,
} from './scripts/lib/install-manifest.mjs'
import {
  perProjectArtifactPairs, globalArtifactPairs, buildArtifactEntries,
  mergeArtifactEntries, buildManifest, resolveSourceVersion, writeJsonAtomic,
  readJsonSafe, projectManifestPath, globalManifestPath, registryPath,
  readRegistry, upsertRegistryEntries, updateConsumers, deployDistCache,
  normalizeProjectPath, PROJECT_MANIFEST_BASENAME,
} from './scripts/lib/install-version.mjs'

const GLOBAL_DIR = path.join(os.homedir(), '.episodic-memory')
const SCRIPTS_DIR = path.join(GLOBAL_DIR, 'scripts')
const REPO_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_SCRIPTS = path.join(REPO_DIR, 'scripts')
const REPO_INSTRUCTIONS = path.join(REPO_DIR, 'instructions')

const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const tool = flag('--tool')
const projectDir = flag('--project') || process.cwd()
const installHooks = argv.includes('--install-hooks')
const installHooksForce = argv.includes('--install-hooks-force')
// RFC-008 P4d / Principle 12: enforcement hooks (files + libs + scripts +
// registrations) install ONLY per-project via --install-enforcement, into
// <project>/.claude/. INTERNAL/undocumented until S3 resolves the cross-deps
// ($REPO_ROOT scripts/bundles + the SessionEnd .mjs libs) — S2 acceptance is
// registration-green, NOT functional-safe (the registered gates hard-deny on
// missing deps in a non-this-repo project until S3).
const installEnforcement = argv.includes('--install-enforcement')
// RFC-008 P4d S5: --uninstall-enforcement removes a project's enforcement-ONLY
// set (gates + engine + classifier + markers + the 7 hooks/lib/*.sh + contract
// config + plugins index + the 9 registrations) while PRESERVING the core bp1
// set, the operator-owned enforce-config.json, and the global substrate.
// --purge-config additionally deletes the operator switch (explicit opt-in).
const uninstallEnforcement = argv.includes('--uninstall-enforcement')
const purgeConfig = argv.includes('--purge-config')
const installSecondOpinion = argv.includes('--install-second-opinion')
// Scheduled maintenance routines (em-routines.mjs): sync routines.json to the
// platform scheduler (launchd/systemd/cron) right after the substrate deploys.
const installRoutines = argv.includes('--install-routines')
const bootstrapLastPrompt = argv.includes('--bootstrap-last-prompt')
const REPO_HOOKS = path.join(REPO_DIR, 'plugins', 'claude-code', 'hooks')
const REPO_SECOND_OPINION = path.join(REPO_SCRIPTS, 'second-opinion')
// RFC-008 P5 S6: OpenCode enforcement plugin source (adapter + bridge + runbooks).
const REPO_PLUGIN_OPENCODE = path.join(REPO_DIR, 'plugins', 'opencode')
// RFC-008 P6 S4: Codex enforcement plugin source (adapter + manifest + runbooks).
const REPO_PLUGIN_CODEX = path.join(REPO_DIR, 'plugins', 'codex')
// RFC-008 P7 S5: Pi enforcement extension source (adapter + manifest + runbooks).
const REPO_PLUGIN_PI = path.join(REPO_DIR, 'plugins', 'pi-agent')

// I-NEW-C: --install-second-opinion is atomic w.r.t. its own validation.
// installFailed is tracked across all sub-steps so the final "Done!" banner
// can be suppressed and process.exitCode set on any failure.
let installFailed = false

// P2 (code review): warn if --install-hooks-force passed without --install-hooks.
// Without the base flag, the entire hook-install block is skipped; a force flag
// alone silently no-ops and a user might think their settings were updated.
if (installHooksForce && !installHooks) {
  console.log('Warning: --install-hooks-force has no effect without --install-hooks; ignoring.')
}

// ---------------------------------------------------------------------------
// --bootstrap-last-prompt: standalone operation, doesn't require --tool.
// Writes a 60-second bootstrap sentinel at
// <projectDir>/.checkpoints/.last-user-prompt.<sid>.json so the pre-flight
// gate's I8 cross-check has ground truth for the FIRST prompt of a fresh
// install — before any UserPromptSubmit hook has fired. After the first
// real prompt, the hook writes a non-bootstrap file and this sentinel is
// replaced. Plan-v2 C6 (#238).
// ---------------------------------------------------------------------------
if (bootstrapLastPrompt) {
  const sidFromFlag = flag('--session-id')
  const sid = sidFromFlag || process.env.CLAUDE_SESSION_ID
  if (!sid) {
    console.error('--bootstrap-last-prompt: no session_id provided. Pass --session-id <sid> or set CLAUDE_SESSION_ID in env.')
    process.exit(1)
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sid)) {
    console.error(`--bootstrap-last-prompt: session_id "${sid}" does not match [A-Za-z0-9_-]{1,128}.`)
    process.exit(1)
  }
  const projectAbs = path.resolve(projectDir)
  if (!fs.existsSync(projectAbs)) {
    console.error(`--bootstrap-last-prompt: --project ${projectAbs} does not exist.`)
    process.exit(1)
  }
  const checkpointsDir = path.join(projectAbs, '.checkpoints')
  fs.mkdirSync(checkpointsDir, { recursive: true })
  const sentinel = {
    bootstrap: true,
    session_id: sid,
    wrote_at_ms: Date.now(),
    note: 'install.mjs --bootstrap-last-prompt; valid for 60s; UserPromptSubmit hook will replace on first real prompt'
  }
  const target = path.join(checkpointsDir, `.last-user-prompt.${sid}.json`)
  const temp = path.join(checkpointsDir, `.last-user-prompt.${sid}.json.${process.pid}.tmp`)
  fs.writeFileSync(temp, JSON.stringify(sentinel, null, 2))
  fs.renameSync(temp, target)
  console.log(`Wrote bootstrap sentinel: ${target} (valid 60s)`)
  // If --bootstrap-last-prompt is the ONLY action requested (no --tool),
  // exit successfully here. Otherwise fall through to the normal install.
  if (!tool) process.exit(0)
}

// ---------------------------------------------------------------------------
// --update-consumers [--dry-run]: standalone operation, doesn't require --tool.
// Layer 1 update sweep: iterate the consumer registry (~/.episodic-memory/
// installs.json); for each registered project, refresh manifest-listed
// artifacts whose on-disk sha256 still matches the manifest checksum
// (unmodified) to the current repo version; skip user-MODIFIED artifacts with
// a warning (Principle 10 — never silently overwritten); prune vanished
// project paths. Projects not in the registry are NEVER touched (Principle 3),
// and enforcement artifacts are never refreshed into a project whose registry
// entry says enforcement_installed:false. Prints one JSON report:
// { projects_scanned, refreshed, skipped_modified, pruned, ... }.
// --dry-run computes the identical report and writes nothing.
// ---------------------------------------------------------------------------
if (argv.includes('--update-consumers')) {
  const report = updateConsumers({
    repoDir: REPO_DIR,
    globalDir: GLOBAL_DIR,
    dryRun: argv.includes('--dry-run'),
  })
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

// --wizard: interactive guided setup (prereq checks → tool/project selection →
// optional hooks/backup → verify with em-doctor; also drives migrate-from-backup
// and health-check flows). Delegates to scripts/install-wizard.mjs, which
// re-invokes this installer non-interactively with the composed flags.
if (argv.includes('--wizard')) {
  const { spawnSync } = await import('child_process')
  const r = spawnSync(process.execPath, [path.join(REPO_DIR, 'scripts', 'install-wizard.mjs')], { stdio: 'inherit' })
  process.exit(r.status === null ? 1 : r.status)
}

if (!tool) {
  console.log(`Usage: node install.mjs --wizard   (interactive guided setup — recommended)
       node install.mjs --tool <claude-code|cursor|codex|opencode|pi-agent|windsurf|all> [--project <path>] [--install-routines] [--install-hooks] [--install-enforcement] [--uninstall-enforcement [--purge-config]] [--install-hooks-force] [--install-second-opinion] [--bootstrap-last-prompt]
       node install.mjs --update-consumers [--dry-run]   (refresh registered consuming projects)

Tools:
  claude-code  Install SKILL.md + plugin structure
  cursor       Install .cursor/rules/episodic-memory.mdc
  codex        Install skill to .agents/skills/episodic-memory/
  opencode     Install skill to .opencode/skills/episodic-memory/ (explicit-only; excluded from all)
  pi-agent     Install skill to .agents/skills/episodic-memory/ (shared with Codex)
  windsurf     Install .windsurfrules (or append to existing)
  all          Install for all supported tools except opencode (avoids duplicate OpenCode-visible skills)

Hook flags (claude-code / RFC-008 P4d — enforcement is PER-PROJECT, never global):
  --install-hooks         Install the NON-enforcement hooks into
                          <project>/.claude/ and register them in
                          <project>/.claude/settings.json: em-recall
                          (SessionStart), session-handoff (SessionStart), and
                          em-session-end-prompt (SessionEnd). Post-P4d this
                          flag alone NO LONGER deploys the enforcement gates
                          (checkpoint/plan/preflight/stop) — use
                          --install-enforcement for those. Skips divergent
                          local hook files AND withholds their settings
                          registration (re-run with --install-hooks-force to
                          accept). Atomic settings.json write (temp+rename).
  --install-enforcement   Install the PER-PROJECT enforcement layer under
                          <project>/.claude/ (NEVER ~/.claude): the gate hooks
                          (checkpoint-gate, plan-gate, preflight-gate,
                          stop-gate) + their hooks/lib closure + the
                          enforce-contract runtime config set
                          (taxonomy.json, events.json, schema), register them
                          in <project>/.claude/settings.json, and SEED a
                          discoverable on/off switch at
                          <project>/.episodic-memory/enforce-config.json
                          ({active:true}, create-if-absent — never overwritten,
                          even with --install-hooks-force). This is the only
                          flag that arms enforcement, and it arms it for THIS
                          project only.
  --install-hooks-force   Overwrite divergent hook files with repo versions
                          and proceed with registration.
  --uninstall-enforcement Reverse --install-enforcement for THIS project:
                          prune the enforcement registrations and delete the
                          enforcement-only files (gates + engine + classifier +
                          markers + the hooks/lib/*.sh closure) and the
                          enforcement-only hooks/patterns + hooks/plugins dirs,
                          while PRESERVING the core bp1 set, the operator-owned
                          enforce-config.json, and the global substrate. Never
                          touches ~/.claude or ~/.episodic-memory. Like every
                          claude-code install it also ensures the core bp1 set is
                          present (bp1 is core, always-on). Does NOT reverse
                          --install-second-opinion (separate capability).
  --purge-config          With --uninstall-enforcement, ALSO delete the operator
                          switch <project>/.episodic-memory/enforce-config.json
                          (explicit destructive opt-in; default leaves it).

Second-opinion harness:
  --install-second-opinion Write install snapshot at
                          ~/.claude/hooks/second-opinion-providers.json
                          with source_hash + per-fragment SHAs + flattened
                          providers (each provider's available() probed; CLI
                          not on PATH → skipped). Required for harness I-27a
                          gate (registry-stale-at-gate) + composer I-27b
                          (preamble-tamper-at-composer).

Update distribution (Layer 1):
  --update-consumers      Standalone (no --tool): sweep the consumer registry
                          (~/.episodic-memory/installs.json) and refresh every
                          registered project's UNMODIFIED installed artifacts
                          (on-disk sha256 == manifest checksum) to this repo's
                          current version. User-modified artifacts are skipped
                          with a warning, vanished projects pruned from the
                          registry. Prints one JSON report. Pair with
                          --dry-run to see exactly what a real run would do
                          without writing anything.
  --dry-run               With --update-consumers: report only, change nothing.

Pre-flight prompt-binding bootstrap:
  --bootstrap-last-prompt  Write a bootstrap sentinel at
                          <project>/.checkpoints/.last-user-prompt.<sid>.json
                          so the pre-flight gate's I8 cross-check has
                          ground truth for the FIRST prompt of a fresh
                          install (before the UserPromptSubmit hook has
                          fired). The sentinel is valid for 60 seconds.
                          Reads CLAUDE_SESSION_ID from env (or refuses
                          with a clear error). Idempotent.`)
  process.exit(1)
}

const VALID_TOOLS = ['claude-code', 'cursor', 'codex', 'opencode', 'pi-agent', 'windsurf', 'all']
if (!VALID_TOOLS.includes(tool)) {
  console.log(`Invalid tool "${tool}". Must be one of: ${VALID_TOOLS.join(', ')}. Note: opencode is explicit-only and is not included in all.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// GATE 1: --install-second-opinion pre-flight registry validation (I-NEW-C).
//
// Runs BEFORE any file copies so a malformed source registry produces a
// hard-stop with the active runtime byte-identical to its pre-install state.
// Closes the stale-snapshot class: failed install cannot leave new top-level
// harness files or subtree copies in place while the snapshot stays old.
// ---------------------------------------------------------------------------
if (installSecondOpinion) {
  try {
    const repoRegPath = path.join(REPO_SECOND_OPINION, 'providers', 'index.json')
    const repoReg = JSON.parse(fs.readFileSync(repoRegPath, 'utf8'))
    const { validateProviderRegistry } = await import(
      new URL('./scripts/second-opinion/lib/registry-validator.mjs', import.meta.url).href
    )
    validateProviderRegistry(repoReg)
  } catch (e) {
    console.error(`Pre-flight registry validation failed: ${e.message}`)
    if (e.code) console.error(`  code: ${e.code}`)
    if (e.field) console.error(`  field: ${e.field}`)
    if (e.provider) console.error(`  provider: ${e.provider}`)
    if (e.observed !== undefined) console.error(`  observed: ${JSON.stringify(e.observed)}`)
    console.error(`Aborting install. No files touched.`)
    process.exit(1)
  }
}

// I-NEW-C completeness (PR-level review P1): the unconditional script + lib +
// second-opinion subtree copies below mutate the active second-opinion runtime
// surface. A throw there (e.g., a directory blocking a destination file)
// would leave the pre-existing snapshot pointing at superseded source.
// Hoisted helper invoked from the runtime-copy catch when installSecondOpinion
// is true.
async function quarantinePreExistingSnapshotForFailedInstall() {
  try {
    const { snapshotPath } = await import(
      new URL('./scripts/second-opinion/lib/install-snapshot.mjs', import.meta.url).href
    )
    const target = snapshotPath()
    if (fs.existsSync(target)) {
      const quarantineName = `${target}.stale.${Date.now()}`
      fs.renameSync(target, quarantineName)
      console.error(`Quarantined pre-existing snapshot to: ${quarantineName}`)
    }
  } catch (qe) {
    console.error(`Quarantine attempt failed: ${qe.message}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Install scripts globally
//
// Second-opinion runtime surface: scripts/*.mjs (incl. scripts/second-opinion.mjs
// harness entrypoint) + scripts/lib/ (shared deps) + scripts/second-opinion/
// subtree. A copy failure here while installSecondOpinion is true must
// quarantine the pre-existing snapshot so the hook fail-closes on next call.
// ---------------------------------------------------------------------------
fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
fs.mkdirSync(path.join(GLOBAL_DIR, 'episodes'), { recursive: true })

let scriptFiles
try {
  // P12 (RFC-008 P4d): global = SUBSTRATE ONLY — the em-* tools + the second-opinion
  // capability harness (isSubstrateScript ALLOWLIST). Two other classes ship
  // elsewhere/nowhere: enforcement SCRIPTS (engine, classifier, markers, bp1,
  // SessionEnd hook) install per-project under --install-enforcement; repo-dev/CI
  // tools (validate-*, scaffold-bp, test-plugin, check-automode-defaults) ship
  // NOWHERE — CI runs them repo-relative. An allowlist (not the prior denylist)
  // ensures a newly added non-substrate script cannot silently leak into global.
  scriptFiles = fs.readdirSync(REPO_SCRIPTS).filter(
    f => f.endsWith('.mjs') && isSubstrateScript(f)
  )
  for (const file of scriptFiles) {
    const src = path.join(REPO_SCRIPTS, file)
    const dst = path.join(SCRIPTS_DIR, file)
    fs.copyFileSync(src, dst)
    fs.chmodSync(dst, 0o755)
  }
  // scripts/lib/ — shared helpers (e.g. local-dir.mjs for #85). Imported by em-*
  // scripts. P12: ENFORCEMENT-ONLY libs (relocatedOnlyLibs — the closure of the
  // enforcement entries minus anything a retained-global script imports) move
  // per-project with their scripts and are EXCLUDED here. Libs shared by both a
  // global and an enforcement script (local-dir, json-instance-validate, …) stay
  // global AND get a co-located copy in the per-project bundle.
  const REPO_SCRIPTS_LIB = path.join(REPO_SCRIPTS, 'lib')
  if (fs.existsSync(REPO_SCRIPTS_LIB)) {
    const libDst = path.join(SCRIPTS_DIR, 'lib')
    const relocatedLibs = new Set(relocatedOnlyLibs(REPO_DIR))
    fs.mkdirSync(libDst, { recursive: true })
    for (const file of fs.readdirSync(REPO_SCRIPTS_LIB).filter(f => f.endsWith('.mjs') && !relocatedLibs.has(f))) {
      fs.copyFileSync(path.join(REPO_SCRIPTS_LIB, file), path.join(libDst, file))
    }
  }

  // scripts/second-opinion/ — pluggable second-opinion review harness subtree.
  // Recursively copy preambles/, providers/, storage/, lib/. Done unconditionally
  // alongside scripts/*.mjs so the harness module imports resolve at runtime; the
  // install snapshot at ~/.claude/hooks/second-opinion-providers.json is only
  // written when --install-second-opinion is passed (separate concern).
  if (fs.existsSync(REPO_SECOND_OPINION)) {
    const soDst = path.join(SCRIPTS_DIR, 'second-opinion')
    copyDirRecursive(REPO_SECOND_OPINION, soDst)
  }
} catch (copyErr) {
  if (installSecondOpinion) {
    console.error(`Runtime copy failed during second-opinion install: ${copyErr.message}`)
    console.error(`Active runtime may be partially modified; quarantining snapshot.`)
    await quarantinePreExistingSnapshotForFailedInstall()
    process.exit(1)
  }
  // No second-opinion install requested → legacy behavior (rethrow).
  throw copyErr
}

function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath)
    }
  }
}

console.log(`Installed ${scriptFiles.length} scripts to ${SCRIPTS_DIR}`)

// ---------------------------------------------------------------------------
// Unified CLI shim: ~/.episodic-memory/bin/em → scripts/em.mjs, so a single
// PATH entry gives `em store|search|recall|doctor|...` everywhere. Clobbered
// on every install like the substrate scripts (drift-proof by overwrite).
// ---------------------------------------------------------------------------
const BIN_DIR = path.join(GLOBAL_DIR, 'bin')
fs.mkdirSync(BIN_DIR, { recursive: true })
const emShim = path.join(BIN_DIR, 'em')
fs.writeFileSync(emShim, `#!/bin/sh\nexec node "${path.join(SCRIPTS_DIR, 'em.mjs')}" "$@"\n`, 'utf8')
fs.chmodSync(emShim, 0o755)
console.log(`Installed unified CLI shim at ${emShim}`)
if (!(process.env.PATH || '').split(path.delimiter).includes(BIN_DIR)) {
  console.log(`  → add it to your PATH:  export PATH="$HOME/.episodic-memory/bin:$PATH"`)
}

// ---------------------------------------------------------------------------
// --install-routines: schedule the maintenance routines on the platform
// scheduler, using the JUST-DEPLOYED em-routines.mjs so entries point at the
// installed substrate (not the clone). Failure is non-fatal: the substrate
// install stands on its own; routines can be synced later.
// ---------------------------------------------------------------------------
if (installRoutines) {
  const routinesScript = path.join(SCRIPTS_DIR, 'em-routines.mjs')
  const r = (() => {
    try { return execFileSync(process.execPath, [routinesScript, 'sync'], { encoding: 'utf8' }) } catch (e) { return e.stdout || e.message }
  })()
  let parsed = null
  try { parsed = JSON.parse(String(r).trim().split('\n').pop()) } catch {}
  if (parsed && parsed.status === 'ok') {
    console.log(`Scheduled maintenance routines (${parsed.scheduler}): ${parsed.applied.map(a => a.routine).join(', ')}`)
    console.log(`  → manage with: em routines list|enable|disable|run  (logs: ${parsed.log_dir})`)
  } else {
    console.log(`WARNING: routine scheduling failed (${parsed ? parsed.message : String(r).slice(0, 200)}); run later: node ${routinesScript} sync`)
  }
}

// ---------------------------------------------------------------------------
// F45 (RFC-008 P3d): em-recall purity sentinel. em-recall.mjs is the memory
// SUBSTRATE and must carry ZERO enforcement code (RFC-008:83,85) — the stop gate
// (--gate stop), the SessionStart side-effects (--session-start: baseline write +
// marker sweeps), and the bp-001 advisory all relocated to enforce-contract.mjs.
// Assert the JUST-DEPLOYED em-recall is pure. A dirty installed copy means the
// install SOURCE is a stale pre-v11 (pre-purification) checkout; deploying it
// would re-couple enforcement into the substrate (double-running the stop gate,
// re-arming markers from recall). Fail loudly rather than ship that.
// Single source of the token class: scripts/lib/em-recall-purity.mjs (Rule 14;
// CI grep-guard tests/test-em-recall-purity.mjs scans the repo source, this
// scans the deployed copy).
// ---------------------------------------------------------------------------
const installedEmRecall = path.join(SCRIPTS_DIR, 'em-recall.mjs')
if (fs.existsSync(installedEmRecall)) {
  const leaked = findEnforcementTokens(fs.readFileSync(installedEmRecall, 'utf8'))
  if (leaked.length > 0) {
    console.error(
      `FATAL: installed em-recall.mjs contains enforcement tokens [${leaked.join(', ')}] ` +
      `(RFC-008 P3d F45). The install source is a stale pre-v11 (pre-purification) em-recall — ` +
      `the stop gate / SessionStart side-effects now live in enforce-contract.mjs. ` +
      `Re-install from an episodic-memory checkout at v11+.`
    )
    process.exit(1)
  }
}

// 1a. Seed default LLM-classifier config if absent. Idempotent — existing
// project/global configs win via the loader's env > project > global > defaults
// precedence chain. We only write the global default when the file does not
// already exist, so a user-customized config is never overwritten.
const classifierCfgPath = path.join(GLOBAL_DIR, 'classifier-config.json')
if (!fs.existsSync(classifierCfgPath)) {
  const defaultCfg = {
    model: 'claude-haiku-4-5-20251001',
    enabled: true,
    fail_mode: 'heuristic',
    timeout_ms: 5000,
    max_tokens: 200,
    temperature: 0,
    confidence_threshold: 0.7,
    api_base: 'https://api.anthropic.com',
    api_version: '2023-06-01'
  }
  const tmp = `${classifierCfgPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(defaultCfg, null, 2) + '\n')
  fs.renameSync(tmp, classifierCfgPath)
  console.log(`Seeded default LLM classifier config at ${classifierCfgPath}`)
}

// 1b. Copy patterns/_index.json for global pattern validation
const globalPatternsDir = path.join(GLOBAL_DIR, 'patterns')
const repoPatternsIndex = path.join(REPO_DIR, 'patterns', '_index.json')
if (fs.existsSync(repoPatternsIndex)) {
  fs.mkdirSync(globalPatternsDir, { recursive: true })
  fs.copyFileSync(repoPatternsIndex, path.join(globalPatternsDir, '_index.json'))
  console.log(`Installed patterns/_index.json to ${globalPatternsDir}`)
}

// 1b'. Copy categories.json — the episode-category vocabulary substrate (RFC-009 R10b).
// It is DATA the deployed em-* scripts read via `../../categories.json` from scripts/lib/, so it
// must land at the global root (NOT under ~/.claude/, which is enforcement-artifact territory).
const repoCategories = path.join(REPO_DIR, 'categories.json')
if (fs.existsSync(repoCategories)) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.copyFileSync(repoCategories, path.join(GLOBAL_DIR, 'categories.json'))
  console.log(`Installed categories.json to ${GLOBAL_DIR}`)
}

// 1b''. Copy activation-classes.json — the activity-class vocabulary for lesson
// activation triggers (RFC-009 R1/P1b). Same substrate rule as categories.json:
// DATA read via `../../activation-classes.json` from scripts/lib/, deployed at
// the global root and NEVER under ~/.claude/ (P12).
const repoActivationClasses = path.join(REPO_DIR, 'activation-classes.json')
if (fs.existsSync(repoActivationClasses)) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.copyFileSync(repoActivationClasses, path.join(GLOBAL_DIR, 'activation-classes.json'))
  console.log(`Installed activation-classes.json to ${GLOBAL_DIR}`)
}

// 1c. Copy the agent-facing per-script reference to the global root so any tool
// can read it before first script use (deployed on every install, all tools).
const repoScriptsGuide = path.join(REPO_DIR, 'docs', 'EM_SCRIPTS_GUIDE.md')
if (fs.existsSync(repoScriptsGuide)) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.copyFileSync(repoScriptsGuide, path.join(GLOBAL_DIR, 'EM_SCRIPTS_GUIDE.md'))
  console.log(`Installed EM_SCRIPTS_GUIDE.md to ${GLOBAL_DIR}`)
}

// NOTE (RFC-008 P4d / Principle 12): patterns/taxonomy.json is a RUNTIME
// dependency of the relocated command-classifier — it is an ENFORCEMENT contract
// artifact, NOT a global-validation artifact like _index.json. Post-S2 it is
// co-deployed with the classifier PER-PROJECT under <project>/.claude/hooks/patterns/
// inside the `if (installEnforcement)` block (§5b-ec), never global. Only
// _index.json (the substrate pattern registry) stays global, unconditionally (§1b
// above). Deploying taxonomy globally would re-leak an enforcement artifact into
// the substrate (the exact P12 violation S2 closes).

// ---------------------------------------------------------------------------
// 2. Create local .episodic-memory in target project
// ---------------------------------------------------------------------------
const localDir = path.join(projectDir, '.episodic-memory')
fs.mkdirSync(path.join(localDir, 'episodes'), { recursive: true })

// Add to .gitignore if it exists. Guards are line-anchored (not substring)
// so a stale comment mention does not silently suppress a real append.
function gitignoreHasPattern(content, pattern) {
  return content.split('\n').some(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return false
    return t === pattern
  })
}
const gitignorePath = path.join(projectDir, '.gitignore')
// RFC-004 §671 mandates these patterns be present even on fresh repos that
// don't yet have a .gitignore. Codex code-review A1 (PR-1c-A): the prior
// `if (fs.existsSync(gitignorePath))` gate left fresh installs vulnerable
// to committing `<project>/.episodic-memory/runs/<run_id>/run.key` (a
// per-run HMAC secret). Now we ensure the file exists, then idempotently
// append the two BP-1 patterns.
if (!fs.existsSync(gitignorePath)) {
  fs.writeFileSync(gitignorePath, '')
  console.log(`Created empty .gitignore at ${gitignorePath} (RFC-004 §671)`)
}
const content = fs.readFileSync(gitignorePath, 'utf8')
if (!gitignoreHasPattern(content, '.episodic-memory/') &&
    !gitignoreHasPattern(content, '.episodic-memory')) {
  fs.appendFileSync(gitignorePath, '\n# Episodic memory data\n.episodic-memory/\n')
  console.log('Added .episodic-memory/ to .gitignore')
}
// RFC-004 §671 — per-run HMAC key file is project-local but must never be
// committed. Pattern is stable across the BP-1 lifecycle.
const runKeyPattern = '**/.episodic-memory/runs/*/run.key'
const refreshed = fs.readFileSync(gitignorePath, 'utf8')
if (!gitignoreHasPattern(refreshed, runKeyPattern)) {
  fs.appendFileSync(gitignorePath, `\n# BP-1 per-run HMAC key (RFC-004)\n${runKeyPattern}\n`)
  console.log(`Added ${runKeyPattern} to .gitignore`)
}
// Layer 1: the per-project install-version manifest is machine-local state
// (per-checkout install record), like .episodic-memory/ itself.
{
  const refreshed2 = fs.readFileSync(gitignorePath, 'utf8')
  if (!gitignoreHasPattern(refreshed2, PROJECT_MANIFEST_BASENAME)) {
    fs.appendFileSync(gitignorePath, `\n# Episodic memory install-version manifest\n${PROJECT_MANIFEST_BASENAME}\n`)
    console.log(`Added ${PROJECT_MANIFEST_BASENAME} to .gitignore`)
  }
}

// ---------------------------------------------------------------------------
// 2b. BP-1 long-lived verify-key + activation map skeleton (RFC-004 §660-668).
// Generated once on first install; persists across runs and projects.
// ---------------------------------------------------------------------------
const verifyKeyPath = path.join(GLOBAL_DIR, '.verify-key')
if (!fs.existsSync(verifyKeyPath)) {
  const key = crypto.randomBytes(32)
  fs.writeFileSync(verifyKeyPath, key, { mode: 0o600 })
  // Defensive chmod: writeFileSync mode is umask-sensitive on some platforms.
  fs.chmodSync(verifyKeyPath, 0o600)
  console.log(`Created BP-1 verify-key at ${verifyKeyPath} (mode 0600)`)
} else {
  // Enforce mode invariant on every install — drift surfaces here, not at first
  // call to bp1-flag-check. Failure mode 29 (bp1-hmac-keyfile-fail).
  const mode = fs.statSync(verifyKeyPath).mode & 0o777
  if (mode !== 0o600) {
    fs.chmodSync(verifyKeyPath, 0o600)
    console.log(`Re-chmod'd ${verifyKeyPath} from 0${mode.toString(8)} to 0600`)
  }
}

const bp1ConfigPath = path.join(GLOBAL_DIR, 'config.json')
if (!fs.existsSync(bp1ConfigPath)) {
  const skeleton = { bp1: { schema_version: 1, activations: {} } }
  fs.writeFileSync(bp1ConfigPath, JSON.stringify(skeleton, null, 2) + '\n')
  console.log(`Created BP-1 config skeleton at ${bp1ConfigPath}`)
}

// ---------------------------------------------------------------------------
// 2c. BP-1 H2 SessionStart hook + settings.json wiring (RFC-004 §559 H-cfg).
//
// PR-1b-B / M0 part 2. Project-local: writes <projectDir>/.claude/settings.json
// (NEVER ~/.claude/settings.json — that's the legacy --install-hooks block in
// section 5 below). Invariant I10: this code path does NOT mutate HOME settings.
// If the user combines --install-hooks with this install, HOME settings may
// change only because of the legacy block; this block stays project-local.
//
// Only fires for tool=claude-code or tool=all (other tools don't use the
// Claude Code SessionStart hook system).
//
// H2 wiring contract decisions (RFC-004 §559 H-cfg):
//  - Target file: <projectRoot>/.claude/settings.json (project-local; NEVER HOME).
//  - Ordering: H2 appended to SessionStart end. M2 inserts H1 just-before this
//    H2 entry (relative-positioning, NOT SessionStart[0]) — preserves any
//    unrelated pre-existing SessionStart entries.
//  - Idempotence: re-run preserves H2 entry count = 1; mergeSessionStartH2Hook
//    in scripts/lib/bp1-install-helpers.mjs deep-clones input (invariant I2).
//  - cwd-binding: projectDir resolved from --project flag (line 37); fallback
//    is process.cwd(). Test fixtures cover caller-cwd ≠ --project (F1, F2, F3).
//  - Manifest hash: adding H2 changes settings_lines sha256; warn user once on
//    add only (B8 — suppress on no-op re-run).
//  - HOME isolation: ~/.claude/settings.json is NEVER touched here (I10).
// ---------------------------------------------------------------------------
if (tool === 'claude-code' || tool === 'all') {
  const { mergeSessionStartH2Hook } = await import(
    new URL('./scripts/lib/bp1-install-helpers.mjs', import.meta.url).href
  )

  const repoH2HookSrc = path.join(REPO_DIR, '.claude', 'hooks', 'bp1-sweep-on-session.sh')
  const projHooksDir = path.join(projectDir, '.claude', 'hooks')
  const projH2HookDst = path.join(projHooksDir, 'bp1-sweep-on-session.sh')
  const projSettingsPath = path.join(projectDir, '.claude', 'settings.json')

  if (!fs.existsSync(repoH2HookSrc)) {
    console.log(`Warning: BP-1 H2 hook source not found at ${repoH2HookSrc}; skipping wiring.`)
  } else {
    fs.mkdirSync(projHooksDir, { recursive: true })

    // RFC-008 P4d / Principle 12: the BP-1 behavior-pattern SCRIPTS (bp1-*.mjs +
    // their lib closure) install CO-LOCATED with the bp1 SessionStart hooks here,
    // per-project — NEVER in the global substrate (they are excluded from the
    // global scripts-scan by isEnforcementEntryScript). The hooks resolve them at
    // $HOOK_DIR, so core install ships a self-contained BP-1 (no global reach).
    {
      const projHooksLibDir = path.join(projHooksDir, 'lib')
      fs.mkdirSync(projHooksLibDir, { recursive: true })
      for (const f of bp1EntryScripts(REPO_DIR)) {
        const dst = path.join(projHooksDir, f)
        fs.copyFileSync(path.join(REPO_SCRIPTS, f), dst)
        fs.chmodSync(dst, 0o755)
      }
      for (const f of bp1ClosureLibs(REPO_DIR)) {
        const src = path.join(REPO_SCRIPTS, 'lib', f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(projHooksLibDir, f))
      }
    }

    let h2HookCopied = false
    let h2DivergentSkipped = false
    if (!fs.existsSync(projH2HookDst)) {
      fs.copyFileSync(repoH2HookSrc, projH2HookDst)
      fs.chmodSync(projH2HookDst, 0o755)
      console.log(`Installed BP-1 H2 SessionStart hook at ${projH2HookDst}`)
      h2HookCopied = true
    } else {
      const a = fs.readFileSync(repoH2HookSrc)
      const b = fs.readFileSync(projH2HookDst)
      if (!a.equals(b)) {
        // Codex code-review round-2 Finding 1 fix: gate force-overwrite on
        // BOTH --install-hooks AND --install-hooks-force, matching the
        // legacy contract (`install.mjs:42-47` warns that force-alone has no
        // effect; T11 in tests/test-install-hooks.sh enforces). This keeps
        // a single coherent meaning of --install-hooks-force across legacy
        // HOME hooks and the new project-local H2 path.
        if (installHooks && installHooksForce) {
          // Operator opted in via --install-hooks --install-hooks-force.
          // Overwrite + register.
          fs.copyFileSync(repoH2HookSrc, projH2HookDst)
          fs.chmodSync(projH2HookDst, 0o755)
          console.log(`Overwrote divergent ${projH2HookDst} (--install-hooks-force).`)
          h2HookCopied = true
        } else {
          // Codex code-review round-1 B2 fix: mirror legacy installHookFile
          // skipped-divergent semantics — withhold settings registration AS
          // WELL AS file overwrite. Otherwise install would wire a stale or
          // user-edited H2 path into settings.json. Re-run with
          // --install-hooks --install-hooks-force to overwrite + register.
          console.log(`Note: ${projH2HookDst} differs from repo source; not overwriting AND withholding settings registration. Re-run with --install-hooks --install-hooks-force to accept.`)
          h2DivergentSkipped = true
        }
      }
    }

    let existingSettings = {}
    let parseFailed = false
    if (fs.existsSync(projSettingsPath)) {
      try {
        existingSettings = JSON.parse(fs.readFileSync(projSettingsPath, 'utf8'))
      } catch (e) {
        // Class 4 (Empty / malformed) fixture from planner — refuse to silently
        // overwrite the user's malformed JSON; surface and skip.
        console.log(`Error: ${projSettingsPath} is not valid JSON (${e.message}); skipping H2 settings wiring.`)
        parseFailed = true
      }
    }

    if (!parseFailed && !h2DivergentSkipped) {
      // Codex code-review B1 fix: migrate any flat-shape entries (top-level
      // {command, ...}) to canonical nested ({hooks: [{type, command, ...}]})
      // BEFORE the idempotence check. Otherwise a pre-existing flat-shape H2
      // canonical entry would be detected as "already present" and skip the
      // merge — leaving a non-executable hook entry in settings.json. Mirrors
      // the legacy hook-install path which calls migrateMalformedEntries
      // before its idempotence check (install.mjs:542).
      let migratedCount = 0
      if (existingSettings && typeof existingSettings === 'object' &&
          existingSettings.hooks && typeof existingSettings.hooks === 'object') {
        migratedCount = migrateMalformedEntries(existingSettings.hooks)
        if (migratedCount > 0) {
          console.log(`Migrated ${migratedCount} flat-shape SessionStart entr${migratedCount === 1 ? 'y' : 'ies'} to canonical shape in ${projSettingsPath}`)
        }
      }

      const result = mergeSessionStartH2Hook(existingSettings, projH2HookDst, { timeout: 30 })
      const needsWrite = result.changed || migratedCount > 0
      if (needsWrite) {
        writeJSONAtomic(projSettingsPath, result.settings)
        if (result.changed) {
          console.log(`Wired BP-1 H2 SessionStart hook into ${projSettingsPath}`)
          console.log('Note: artifact_version_hash changed; activated projects must re-run M5 to regenerate.')
        }
      } else if (h2HookCopied) {
        // Hook file was newly copied but settings already had the canonical
        // entry — unusual mid-state, surface for visibility.
        console.log(`BP-1 H2 entry already present in ${projSettingsPath}.`)
      }

      // Codex code-review R6 follow-up: surface stale-canonical entries
      // explicitly so operators see them rather than only via cat settings.json.
      // detectStaleCanonicalEntries scans for entries that reference the H2
      // basename but at a different path than the canonical install location.
      // We do NOT auto-delete (preserves operator visibility); just warn.
      if (result.settings && result.settings.hooks &&
          typeof result.settings.hooks === 'object') {
        const stale = detectStaleCanonicalEntries(result.settings.hooks, {
          'bp1-sweep-on-session.sh': projH2HookDst,
        })
        for (const s of stale) {
          console.log(`Note: stale BP-1 H2 entry in ${s.event} → ${s.command} (canonical: ${projH2HookDst}). Operator can remove the stale entry; not auto-deleted.`)
        }
      }
      // Otherwise: silent no-op (B8 — regen warning suppressed on re-run).
    }

    // §559 H1 wiring — slice 2d-R / PR-2d-R.
    //
    // Splice-before-H2 semantics (mergeSessionStartH1Hook): if H2 is present
    // in SessionStart, insert H1 at that index (H2 shifts down). If absent,
    // append. Preserves §559 H-cfg relative ordering (approval-check FIRST,
    // sweep SECOND) WITHOUT reordering unrelated pre-existing entries.
    //
    // Mirrors the H2 install gating above: hook source must exist; file
    // copy + chmod 0o755; divergent target with neither --install-hooks nor
    // --install-hooks-force → skip settings registration with operator note.
    const { mergeSessionStartH1Hook } = await import(
      new URL('./scripts/lib/bp1-install-helpers.mjs', import.meta.url).href
    )
    const repoH1HookSrc = path.join(REPO_DIR, '.claude', 'hooks', 'bp1-approval-check.sh')
    const projH1HookDst = path.join(projHooksDir, 'bp1-approval-check.sh')

    if (!fs.existsSync(repoH1HookSrc)) {
      console.log(`Warning: BP-1 H1 hook source not found at ${repoH1HookSrc}; skipping wiring.`)
    } else {
      let h1HookCopied = false
      let h1DivergentSkipped = false
      if (!fs.existsSync(projH1HookDst)) {
        fs.copyFileSync(repoH1HookSrc, projH1HookDst)
        fs.chmodSync(projH1HookDst, 0o755)
        console.log(`Installed BP-1 H1 SessionStart hook at ${projH1HookDst}`)
        h1HookCopied = true
      } else {
        const a = fs.readFileSync(repoH1HookSrc)
        const b = fs.readFileSync(projH1HookDst)
        if (!a.equals(b)) {
          if (installHooks && installHooksForce) {
            fs.copyFileSync(repoH1HookSrc, projH1HookDst)
            fs.chmodSync(projH1HookDst, 0o755)
            console.log(`Overwrote divergent ${projH1HookDst} (--install-hooks-force).`)
            h1HookCopied = true
          } else {
            console.log(`Note: ${projH1HookDst} differs from repo source; not overwriting AND withholding H1 settings registration. Re-run with --install-hooks --install-hooks-force to accept.`)
            h1DivergentSkipped = true
          }
        }
      }

      // Re-read settings: the H2 merge above may have written a new file.
      let h1Settings = {}
      let h1ParseFailed = false
      if (fs.existsSync(projSettingsPath)) {
        try {
          h1Settings = JSON.parse(fs.readFileSync(projSettingsPath, 'utf8'))
        } catch (e) {
          console.log(`Error: ${projSettingsPath} is not valid JSON (${e.message}); skipping H1 settings wiring.`)
          h1ParseFailed = true
        }
      }

      if (!h1ParseFailed && !h1DivergentSkipped) {
        const h1Result = mergeSessionStartH1Hook(
          h1Settings, projH1HookDst, projH2HookDst, { timeout: 30 },
        )
        if (h1Result.changed) {
          writeJSONAtomic(projSettingsPath, h1Result.settings)
          console.log(`Wired BP-1 H1 SessionStart hook into ${projSettingsPath} (${h1Result.reason})`)
        } else if (h1HookCopied) {
          console.log(`BP-1 H1 entry already present in ${projSettingsPath}.`)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2d. Worktree session permission grant (issue #213).
//
// In a linked-worktree session, Claude Code's working-directory permission
// scope is the worktree path. But Rule 18 hooks read/write markers at the
// CANONICAL repo's `.checkpoints/` (lesson `20260509-044449-...-7836` —
// markers MUST stay canonical so stop-gate / checkpoint-gate / em-recall
// can find them). The mismatch surfaces as recurring "Path is outside
// allowed working directories" prompts on every Rule 18 marker access.
//
// Fix: when projectDir is a linked worktree of a canonical repo, append
// the canonical repo's `.checkpoints/` directory to
// `<canonical>/.claude/settings.local.json` `permissions.additionalDirectories`
// (Claude Code's documented working-directory extension; see
// https://code.claude.com/docs/en/permissions). Issue #215: must target the
// CANONICAL settings.local.json, not the worktree's — Claude Code loads
// project settings from the main repo, same canonicalization as our hooks.
//
// Design notes (folded from Codex round-1 plan-review reply
// `20260509-073135-...-4fb5`):
//   - Target = settings.local.json (machine-specific; absolute paths
//     belong here, not shared settings.json — Codex finding A).
//   - Worktree detection = realpath(show-toplevel) !== realpath(canonical)
//     using existing resolveRepoRoot primitive (Codex finding D).
//   - Scope = `.checkpoints/` only; do NOT auto-grant `.episodic-memory/`
//     or other hook-managed paths without a separate Claude-tool caller
//     (Codex finding C).
//   - Existing/future worktrees: rerun installer per worktree (Codex
//     finding E; no auto-detect of new worktrees).
//   - I-1' (no-prompt at runtime) is NOT locally verifiable — manual
//     acceptance artifact only (Codex finding B).
// ---------------------------------------------------------------------------
if (tool === 'claude-code' || tool === 'all') {
  const { execSync } = await import('child_process')
  const { resolveRepoRoot } = await import(
    new URL('./scripts/lib/local-dir.mjs', import.meta.url).href
  )

  // Realpath if the path exists, else path.resolve fallback. Used both for
  // de-dup keying and for canonicalizing the grant we write.
  const normalizePathForGrant = (p) => {
    try { return fs.realpathSync(p) } catch { return path.resolve(p) }
  }

  // Detect linked worktree by comparing the git context's working tree
  // (--show-toplevel) against the canonical repo root (main checkout).
  // Returns { worktreeRoot, canonicalRoot } when distinct; null when
  // projectDir is the main repo, not a git repo, or git is unavailable.
  const detectLinkedWorktree = (cwd) => {
    let top
    try {
      top = execSync('git rev-parse --show-toplevel', {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim()
    } catch {
      return null
    }
    if (!top) return null
    const canonical = resolveRepoRoot(cwd)
    if (!canonical) return null
    const topReal = normalizePathForGrant(top)
    const canonicalReal = normalizePathForGrant(canonical)
    if (topReal === canonicalReal) return null
    return { worktreeRoot: topReal, canonicalRoot: canonicalReal }
  }

  const wt = detectLinkedWorktree(projectDir)
  if (wt) {
    const checkpointsDir = path.join(wt.canonicalRoot, '.checkpoints')
    const grantPath = normalizePathForGrant(checkpointsDir)
    // Issue #215 fix: write the grant to the CANONICAL repo's settings.local.json,
    // not the worktree's. Claude Code loads project settings from the canonical
    // repo root (the main checkout) — same canonicalization as our hooks. The
    // original PR #214 wrote to <worktree>/.claude/settings.local.json which
    // Claude Code never reads in a worktree session, so I-1' failed at runtime.
    // Verified post-merge: the mechanism works (claude --add-dir <path>), but
    // the settings file must live at <canonical>/.claude/settings.local.json.
    const settingsLocalPath = path.join(wt.canonicalRoot, '.claude', 'settings.local.json')

    let localSettings = {}
    let parseFailed = false
    if (fs.existsSync(settingsLocalPath)) {
      try {
        localSettings = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf8'))
      } catch (e) {
        // Refuse to silently overwrite malformed user JSON. Surface and skip.
        console.log(`Error: ${settingsLocalPath} is not valid JSON (${e.message}); skipping additionalDirectories grant.`)
        parseFailed = true
      }
    }

    if (!parseFailed) {
      if (!localSettings.permissions || typeof localSettings.permissions !== 'object') {
        localSettings.permissions = {}
      }
      if (!Array.isArray(localSettings.permissions.additionalDirectories)) {
        localSettings.permissions.additionalDirectories = []
      }
      // De-dup by realpath (handles symlink/literal aliasing). Preserve
      // original entries verbatim — only skip if any existing entry
      // realpath-matches the new grant.
      const existingReal = new Set(
        localSettings.permissions.additionalDirectories.map(normalizePathForGrant)
      )
      if (!existingReal.has(grantPath)) {
        localSettings.permissions.additionalDirectories.push(grantPath)
        writeJSONAtomic(settingsLocalPath, localSettings)
        console.log(`Granted worktree permission for canonical .checkpoints/ in ${settingsLocalPath} (issues #213, #215).`)
      }
      // Already granted — silent no-op for re-run idempotence.
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Install tool-specific instructions
// ---------------------------------------------------------------------------
const projectAbs = path.resolve(projectDir)
const skillSource = path.join(REPO_INSTRUCTIONS, 'SKILL.md')

function installOwnedFile({ src, dst, label }) {
  const source = fs.readFileSync(src, 'utf8')
  if (fs.existsSync(dst)) {
    const existing = fs.readFileSync(dst, 'utf8')
    if (existing === source) {
      console.log(`${label} already current at ${dst}`)
      return { status: 'current' }
    }
    console.log(`Skipped ${label} at ${dst}: existing file differs from repo source; leaving it untouched.`)
    return { status: 'skipped-divergent' }
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, source)
  console.log(`Installed ${label} to ${dst}`)
  return { status: 'installed' }
}

function gitWorktreeRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

function ancestorChain(start, stop) {
  const chain = []
  let cur = path.resolve(start)
  const stopResolved = stop ? path.resolve(stop) : null
  while (true) {
    chain.push(cur)
    if (stopResolved && cur === stopResolved) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return chain
}

function opencodeVisibleSkillPaths(projectRoot) {
  const root = gitWorktreeRoot(projectRoot)
  const dirs = ancestorChain(projectRoot, root)
  const projectLocations = dirs.flatMap((dir) => [
    path.join(dir, '.opencode', 'skills', 'episodic-memory', 'SKILL.md'),
    path.join(dir, '.claude', 'skills', 'episodic-memory', 'SKILL.md'),
    path.join(dir, '.agents', 'skills', 'episodic-memory', 'SKILL.md'),
  ])
  const home = os.homedir()
  return [
    ...projectLocations,
    path.join(home, '.config', 'opencode', 'skills', 'episodic-memory', 'SKILL.md'),
    path.join(home, '.claude', 'skills', 'episodic-memory', 'SKILL.md'),
    path.join(home, '.agents', 'skills', 'episodic-memory', 'SKILL.md'),
  ]
}

function installOpenCodeSkill(projectRoot) {
  const dst = path.join(projectRoot, '.opencode', 'skills', 'episodic-memory', 'SKILL.md')
  const intended = path.resolve(dst)
  const duplicates = opencodeVisibleSkillPaths(projectRoot)
    .map((p) => path.resolve(p))
    .filter((p, idx, arr) => arr.indexOf(p) === idx)
    .filter((p) => p !== intended && fs.existsSync(p))

  if (duplicates.length > 0) {
    console.log(`Skipped OpenCode skill install: existing OpenCode-visible episodic-memory skill found at ${duplicates.join(', ')}. Run a future conflict-resolution flow before installing the native .opencode skill.`)
    return { status: 'skipped-duplicate' }
  }

  return installOwnedFile({
    src: skillSource,
    dst,
    label: 'OpenCode skill'
  })
}

const tools = tool === 'all' ? ['claude-code', 'cursor', 'codex', 'pi-agent', 'windsurf'] : [tool]

for (const t of tools) {
  switch (t) {
    case 'claude-code': {
      // Copy SKILL.md into .claude/skills/ or skills/ structure
      const skillDir = path.join(projectDir, '.claude', 'skills', 'episodic-memory')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_INSTRUCTIONS, 'SKILL.md'),
        path.join(skillDir, 'SKILL.md')
      )
      console.log(`Installed Claude Code skill to ${skillDir}/SKILL.md`)

      // Also install the classify-correction skill so users can record
      // per-project LLM-classifier corrections via the Claude skill surface.
      // F11-fix: use installOwnedFile so a user-customized SKILL.md is not
      // silently overwritten on re-install.
      const correctionSrc = path.join(REPO_DIR, 'skills', 'classify-correction', 'SKILL.md')
      if (fs.existsSync(correctionSrc)) {
        installOwnedFile({
          src: correctionSrc,
          dst: path.join(projectDir, '.claude', 'skills', 'classify-correction', 'SKILL.md'),
          label: 'Claude Code classify-correction skill'
        })
      }
      break
    }
    case 'cursor': {
      const rulesDir = path.join(projectDir, '.cursor', 'rules')
      fs.mkdirSync(rulesDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_INSTRUCTIONS, 'cursor.mdc'),
        path.join(rulesDir, 'episodic-memory.mdc')
      )
      console.log(`Installed Cursor rules to ${rulesDir}/episodic-memory.mdc`)
      break
    }
    case 'codex': {
      // Install as a Codex skill in .agents/skills/. Codex discovers skills
      // by SKILL.md inside the skill directory; arbitrary markdown filenames
      // in that directory are inert.
      installOwnedFile({
        src: skillSource,
        dst: path.join(projectDir, '.agents', 'skills', 'episodic-memory', 'SKILL.md'),
        label: 'Codex skill'
      })
      break
    }
    case 'opencode': {
      installOpenCodeSkill(projectAbs)
      break
    }
    case 'pi-agent': {
      installOwnedFile({
        src: skillSource,
        dst: path.join(projectDir, '.agents', 'skills', 'episodic-memory', 'SKILL.md'),
        label: 'Pi Agent skill'
      })
      break
    }
    case 'windsurf': {
      const wsFile = path.join(projectDir, '.windsurfrules')
      const instructions = fs.readFileSync(path.join(REPO_INSTRUCTIONS, 'windsurf.md'), 'utf8')
      if (fs.existsSync(wsFile)) {
        const existing = fs.readFileSync(wsFile, 'utf8')
        if (!existing.includes('episodic-memory')) {
          fs.appendFileSync(wsFile, '\n' + instructions)
          console.log('Appended episodic-memory section to existing .windsurfrules')
        } else {
          console.log('.windsurfrules already contains episodic-memory instructions')
        }
      } else {
        fs.writeFileSync(wsFile, instructions)
        console.log(`Created ${wsFile}`)
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Seed behavioral patterns
// ---------------------------------------------------------------------------
const seedScript = path.join(SCRIPTS_DIR, 'em-seed-patterns.mjs')
const repoPatternsDir = path.join(REPO_DIR, 'patterns')
if (fs.existsSync(seedScript) && fs.existsSync(repoPatternsDir)) {
  try {
    const { execSync } = await import('child_process')
    const result = execSync(`node "${seedScript}" --dir "${repoPatternsDir}"`, { encoding: 'utf8' })
    const parsed = JSON.parse(result.trim())
    if (parsed.seeded > 0) {
      console.log(`Seeded ${parsed.seeded} behavioral patterns (${parsed.skipped} already existed)`)
    } else {
      console.log(`All ${parsed.total} behavioral patterns already seeded`)
    }
  } catch {
    console.log('Note: behavioral pattern seeding skipped (non-fatal)')
  }
}

// ---------------------------------------------------------------------------
// 5. Optional: install Claude Code hooks (PR-B per #59)
//
// Phase 3b runtime: copies hooks/*.sh into ~/.claude/hooks/ (preserving local
// edits unless --install-hooks-force) and registers PreToolUse + SessionStart
// + SessionEnd entries in ~/.claude/settings.json using the canonical nested
// shape `{ matcher?, hooks: [{ type: "command", command, timeout }] }`.
//
// Migration: pre-existing flat-shape entries `{ command, description }` (bug
// shipped in earlier installer versions; never executed by Claude Code) are
// rewritten in place. Legacy substring detection is used ONLY for migration.
//
// Idempotence for new registrations is keyed on the EXACT canonical command
// string we install (full path), not basename — prevents false-positive skip
// when an unrelated script of the same name exists at a different path.
//
// Divergent local hook files (sha mismatch with repo) are skipped without a
// new settings registration unless --install-hooks-force is passed. Existing
// registrations pointing at the same canonical path are preserved.
//
// Settings.json is written atomically (temp + rename) so partial failure
// cannot corrupt user settings.
// ---------------------------------------------------------------------------

// POSIX shell-quote a path for safe inclusion in a hook command string.
// Conditional quoting: if the path contains only POSIX-safe characters
// (alphanumerics, underscore, dash, dot, slash, colon, equals, comma) we
// return it unchanged — matches what `printf '%q'` does for safe strings
// and avoids needless churn on existing installs whose paths don't need
// quoting. Otherwise wrap in single quotes and escape internal quotes.
//
// Codex post-PR review of #78 reproduced a path-with-spaces failure: an
// install at HOME=/private/tmp/em\ home\ with\ spaces produced commands
// that the shell split at the first space, and the registered hook never
// executed. shellQuote() makes the registered command shell-safe.
function shellQuote(s) {
  if (/^[A-Za-z0-9_\-./:=,]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}

// Per-writer unique temp suffix. The fixed `.tmp` form is not safe under
// concurrent installer runs against the same target file: writer A's
// rename can race writer B's write, producing ENOENT on rename. Codex
// PR-level review of #214 reproduced this with 5 concurrent installers
// against the same worktree settings.local.json. process.pid + random
// is unique enough across local installer processes.
function uniqueTmpPath(filePath) {
  return `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
}

// Best-effort sweep of the legacy fixed-temp orphan `<filePath>.tmp`. With
// unique-temp names (uniqueTmpPath), no live writer uses this exact path, so
// removing it is safe and matches the prior contract that crashed-prior-run
// orphans don't accumulate (test-install-hooks.sh T9a).
function sweepLegacyOrphanTmp(filePath) {
  try { fs.unlinkSync(filePath + '.tmp') } catch {}
}

function writeJSONAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = uniqueTmpPath(filePath)
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, filePath)
    sweepLegacyOrphanTmp(filePath)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

function writeJSONAtomicIfChanged(filePath, obj) {
  const next = JSON.stringify(obj, null, 2)
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === next) {
    return false
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = uniqueTmpPath(filePath)
  try {
    fs.writeFileSync(tmp, next, 'utf8')
    fs.renameSync(tmp, filePath)
    sweepLegacyOrphanTmp(filePath)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
  return true
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function hookVersion(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const m = text.match(/^# episodic-memory-hook-version:\s*(.+)$/m)
  return m ? m[1].trim() : null
}

function buildHookFreshnessManifest(hookSpecs, libFiles, userHooksDir, userHooksLibDir) {
  const filesByRelativePath = new Map()
  const add = (relativePath, installedPath) => {
    const sourcePath = path.join(REPO_DIR, relativePath)
    if (!fs.existsSync(sourcePath)) return
    const installedExists = fs.existsSync(installedPath)
    filesByRelativePath.set(relativePath, {
      relative_path: relativePath,
      installed_path: installedPath,
      source_sha256: sha256File(sourcePath),
      installed_sha256: installedExists ? sha256File(installedPath) : null,
      source_version: hookVersion(sourcePath)
    })
  }

  for (const spec of hookSpecs) {
    add(path.join('plugins', 'claude-code', 'hooks', spec.file), path.join(userHooksDir, spec.file))
  }
  for (const file of libFiles) {
    add(path.join('plugins', 'claude-code', 'hooks', 'lib', file), path.join(userHooksLibDir, file))
  }

  return {
    schema_version: 1,
    source_repo: REPO_DIR,
    hooks_dir: userHooksDir,
    files: [...filesByRelativePath.values()].sort((a, b) =>
      a.relative_path.localeCompare(b.relative_path))
  }
}

function entryReferencesSubstring(entry, substring) {
  if (entry.command && entry.command.includes(substring)) return true
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(h => h && h.command && h.command.includes(substring))
  }
  return false
}

// Normalize a command string by stripping POSIX shell single-quoting so that
// idempotence checks survive the v1→v2 PR-B upgrade on installs with spaced
// paths: a v1-installed unquoted entry and a v2-installed quoted entry refer
// to the same canonical command. Strips quotes around the whole string or
// around a trailing single-quoted argument (the `node '<path>'` shape).
function normalizeCommand(s) {
  if (typeof s !== 'string') return s
  if (s.length > 1 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/'\\''/g, "'")
  }
  const m = s.match(/^(.*\s)'((?:[^']|'\\'')+)'$/)
  if (m) return m[1] + m[2].replace(/'\\''/g, "'")
  return s
}

function entryHasExactCommand(entry, command) {
  const target = normalizeCommand(command)
  if (entry.command && normalizeCommand(entry.command) === target) return true
  if (Array.isArray(entry.hooks)) {
    return entry.hooks.some(h => h && normalizeCommand(h.command) === target)
  }
  return false
}

function addHookEntry(hooks, event, command, opts = {}) {
  const { matcher, timeout = 10 } = opts
  if (!hooks[event]) hooks[event] = []
  // Exact-command idempotence (Codex review feedback): basename substring would
  // false-positive on a different file at a different path with the same name.
  if (hooks[event].some(e => entryHasExactCommand(e, command))) return 'present'
  const entry = { hooks: [{ type: 'command', command, timeout }] }
  if (matcher) entry.matcher = matcher
  hooks[event].push(entry)
  return 'added'
}

function migrateMalformedEntries(hooks) {
  let migrated = 0
  for (const event of Object.keys(hooks)) {
    const arr = hooks[event]
    if (!Array.isArray(arr)) continue
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i]
      if (!entry || typeof entry !== 'object') continue
      // Flat shape: top-level `command` and no `hooks` array.
      if (entry.command && !Array.isArray(entry.hooks)) {
        arr[i] = {
          hooks: [{
            type: 'command',
            command: entry.command,
            timeout: typeof entry.timeout === 'number' ? entry.timeout : 10
          }]
        }
        migrated++
      }
    }
  }
  return migrated
}

// P2 (code review): after migrating malformed entries we preserve the
// pre-existing command verbatim. If that command points at a canonical hook
// basename (em-session-end-prompt.mjs / checkpoint-gate.sh / em-recall-
// sessionstart.sh) but at a different path than where this installer puts the
// canonical version, the user ends up with both registered: the canonical one
// (newly registered) and the migrated stale one (will fail silently at runtime
// because the path likely doesn't exist on this machine). Surface this so the
// user can clean up; we deliberately don't auto-rewrite their pointer.
function detectStaleCanonicalEntries(hooks, canonicalByBasename) {
  const stale = []
  for (const event of Object.keys(hooks)) {
    const arr = hooks[event]
    if (!Array.isArray(arr)) continue
    for (const entry of arr) {
      if (!Array.isArray(entry.hooks)) continue
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue
        for (const [basename, canonicalPath] of Object.entries(canonicalByBasename)) {
          if (h.command.includes(basename) && !h.command.includes(canonicalPath)) {
            stale.push({ event, basename, command: h.command })
          }
        }
      }
    }
  }
  return stale
}

// Resolve the filesystem target a hook command points at: strip a leading
// `bash`/`node`/`sh` runner and any surrounding shell quotes, take the first
// path token (the script; flags follow), and resolve it to an absolute path.
// Project-relative entries (e.g. `.claude/hooks/X.sh`) resolve against the
// project dir — that is how Claude Code runs project-relative hook commands.
// Returns null if no path token is recoverable.
function hookCommandTargetPath(cmd, projectDir) {
  if (typeof cmd !== 'string') return null
  const stripped = cmd.trim().replace(/^(?:bash|node|sh)\s+/, '')
  let tok = stripped.split(/\s+/)[0] || ''
  if (tok.length > 1 &&
      ((tok.startsWith("'") && tok.endsWith("'")) ||
       (tok.startsWith('"') && tok.endsWith('"')))) {
    tok = tok.slice(1, -1)
  }
  if (!tok) return null
  return path.resolve(projectDir, tok)
}

// Remove every hook ENTRY in <event> whose hook list contains a command exactly
// equal to <command>. Returns the count removed. Used to prune superseded
// path-spelling duplicates (relative vs absolute) of an already-canonical hook.
function removeHookEntryByCommand(hooks, event, command) {
  const arr = hooks[event]
  if (!Array.isArray(arr)) return 0
  const before = arr.length
  hooks[event] = arr.filter(e =>
    !(e && Array.isArray(e.hooks) && e.hooks.some(h => h && h.command === command)))
  return before - hooks[event].length
}

function installHookFile(repoFile, destFile, force) {
  if (!fs.existsSync(repoFile)) return 'missing-source'
  if (!fs.existsSync(destFile)) {
    fs.mkdirSync(path.dirname(destFile), { recursive: true })
    fs.copyFileSync(repoFile, destFile)
    fs.chmodSync(destFile, 0o755)
    return 'copied'
  }
  const a = fs.readFileSync(repoFile)
  const b = fs.readFileSync(destFile)
  if (a.equals(b)) return 'unchanged'
  if (force) {
    fs.copyFileSync(repoFile, destFile)
    fs.chmodSync(destFile, 0o755)
    return 'forced'
  }
  return 'skipped-divergent'
}

// ───────────────────────────────────────────────────────────────────────────
// RFC-008 P4d S5 — --uninstall-enforcement. Reverse the per-project enforcement
// delta: prune the 9 enforcement registrations + delete the enforcement-ONLY
// files/dirs, while PRESERVING the core bp1 set, the operator-owned
// enforce-config.json (unless --purge-config), and the global substrate. The
// primary correctness proof is the REQ-12 core-state delta E2E
// (core+enforce+uninstall ≡ core); this code only has to be list-correct enough
// to satisfy it. Never touches global scope.
// ───────────────────────────────────────────────────────────────────────────

// Fail-closed containment predicate (F-D/N2): a computed delete target must live
// UNDER `root`. Realpath both sides where they exist so a symlinked projectDir or
// hook file can't redirect the delete outside the tree (axes 4/5); fall back to
// the lexical path when the target is already gone (ENOENT — idempotent, axis 6).
// path.relative (not a bare startsWith) rejects sibling-prefix escapes like
// .claude/hooks-backup/ that share a string prefix with the root.
function assertContained(target, root) {
  let t = target
  let r = root
  try { t = fs.realpathSync(target) } catch {}
  try { r = fs.realpathSync(root) } catch {}
  const rel = path.relative(r, t)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('CONTAINMENT_VIOLATION: ' + target)
  }
}

// Remove a command from settings.hooks[event] at COMMAND granularity: filter the
// command out of each entry's hooks[] array, dropping an entry ONLY when WE emptied
// it (it held commands, now holds none). Unlike removeHookEntryByCommand (whole-
// entry removal, used at INSTALL time to prune single-command superseded duplicates),
// this preserves an operator command that a settings merge/formatter bundled into the
// SAME entry.hooks[] array as a gate (review F1 — reproduced operator-command data
// loss with whole-entry removal). Returns the count of command occurrences removed.
function removeHookCommandFromEvent(hooks, event, command) {
  const arr = hooks[event]
  if (!Array.isArray(arr)) return 0
  let removed = 0
  const kept = []
  for (const entry of arr) {
    if (!entry || !Array.isArray(entry.hooks)) { kept.push(entry); continue }
    const before = entry.hooks.length
    entry.hooks = entry.hooks.filter((h) => !(h && h.command === command))
    const dropped = before - entry.hooks.length
    removed += dropped
    if (dropped > 0 && entry.hooks.length === 0) continue // drop only what we emptied
    kept.push(entry)
  }
  hooks[event] = kept
  return removed
}

// Reverse the enforcement install for ONE project. Returns an UninstallReport
// { removedRegistrations, removedFiles, preserved, warnings }. Never throws on a
// missing file/registration (idempotent); throws ONLY on a containment violation.
// Atomic on malformed settings (F-C): parse FIRST; on a SyntaxError change NOTHING
// (no file deletion, no settings write) so a half-uninstall can never leave hooks
// pointing at deleted files.
function runUninstallEnforcement(projectDir, { purgeConfig = false } = {}) {
  const report = { removedRegistrations: [], removedFiles: [], preserved: [], warnings: [] }
  const userHooksDir = path.join(projectDir, '.claude', 'hooks')
  const userHooksLibDir = path.join(userHooksDir, 'lib')
  const hooksRoot = userHooksDir
  const settingsPath = path.join(projectDir, '.claude', 'settings.json')
  const localDir = path.join(projectDir, '.episodic-memory')
  const realpathOrLexical = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

  // (a) PARSE FIRST — atomic on malformed settings (F-C). On SyntaxError, abort
  //     the WHOLE op: delete nothing, write nothing.
  let settings = {}
  let settingsPresent = false
  if (fs.existsSync(settingsPath)) {
    settingsPresent = true
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch (e) {
      report.warnings.push(`settings.json is not valid JSON (${e.message}); aborted — nothing changed`)
      return report
    }
  }
  if (!settings.hooks) settings.hooks = {}

  // (b) PRUNE the 9 enforcement registrations. Remove the exact canonical command
  //     (gates: bare path; SessionEnd: `node <abs>` — F8); then remove any remaining
  //     same-event entry whose target realpath-resolves to the canonical file (legacy
  //     relative spelling). A same-basename entry resolving ELSEWHERE is the operator's
  //     own hook → warn + leave (REQ-5). Drop any event key left empty (BL-B).
  let settingsChanged = false
  for (const reg of enforcementRegistrations()) {
    const canonicalFile = path.join(userHooksDir, reg.file)
    const canonicalCmd = reg.file === SESSION_END_SCRIPT
      ? `node ${shellQuote(canonicalFile)}`
      : shellQuote(canonicalFile)
    if (removeHookCommandFromEvent(settings.hooks, reg.event, canonicalCmd) > 0) {
      settingsChanged = true
      report.removedRegistrations.push(`${reg.event} → ${reg.file}`)
    }
    const arr = settings.hooks[reg.event]
    if (Array.isArray(arr)) {
      const canonicalResolved = realpathOrLexical(canonicalFile)
      for (const entry of [...arr]) {
        const cmds = (entry && Array.isArray(entry.hooks)) ? entry.hooks : []
        for (const h of cmds) {
          if (!h || typeof h.command !== 'string') continue
          const tgt = hookCommandTargetPath(h.command, projectDir)
          if (!tgt || path.basename(tgt) !== reg.file) continue
          if (realpathOrLexical(tgt) === canonicalResolved) {
            if (removeHookCommandFromEvent(settings.hooks, reg.event, h.command) > 0) {
              settingsChanged = true
              report.removedRegistrations.push(`${reg.event} → ${reg.file} (legacy spelling)`)
            }
          } else {
            report.warnings.push(`left non-canonical ${reg.event} hook ${h.command} (resolves outside the canonical path)`)
          }
        }
      }
    }
  }
  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event]
    if (Array.isArray(list) && list.length === 0) { delete settings.hooks[event]; settingsChanged = true }
  }
  if (settingsPresent && settingsChanged) writeJSONAtomic(settingsPath, settings)

  // (c) FILE removal = (enforcement hook files ∪ enforcement entry scripts) under
  //     hooks/, and (enforcement bundle libs ∪ enforcement hooks/lib .sh) under
  //     hooks/lib/, each MINUS the core bp1 set so bp1 survives (EC7). A lib shared
  //     by bp1 + enforcement stays (it is in the bp1 closure → subtracted from the
  //     removal set). bp1-sweep-on-session.sh is core (deployed by the bp1 block).
  const coreEntry = new Set(bp1EntryScripts(REPO_DIR))
  const coreLibs = new Set(bp1ClosureLibs(REPO_DIR))
  const rootRemove = [...new Set([...enforcementHookFileBasenames(), ...enforcementEntryScripts(REPO_DIR)])]
    .filter((f) => !coreEntry.has(f) && f !== 'bp1-sweep-on-session.sh')
  const libRemove = [...new Set([...enforcementBundleLibs(REPO_DIR), ...enforcementHookLibBasenames(REPO_DIR)])]
    .filter((f) => !coreLibs.has(f))
  const removeFile = (dir, f) => {
    const target = path.join(dir, f)
    if (!fs.existsSync(target)) return
    assertContained(target, hooksRoot)
    fs.rmSync(target, { force: true })
    report.removedFiles.push(target)
  }
  for (const f of rootRemove) removeFile(userHooksDir, f)
  for (const f of libRemove) removeFile(userHooksLibDir, f)

  // (d) Enforcement-only DIRS removed wholesale — core never creates them, so this
  //     covers the contract set + plugins index without a second basename list (F-G/BL-B).
  for (const d of ['patterns', 'plugins']) {
    const target = path.join(userHooksDir, d)
    if (!fs.existsSync(target)) continue
    assertContained(target, hooksRoot)
    fs.rmSync(target, { recursive: true, force: true })
    report.removedFiles.push(target)
  }

  // (e) Operator switch — default LEAVE (operator-owned R5 kill switch); delete only
  //     under the explicit --purge-config. Second containment root: .episodic-memory.
  const switchPath = path.join(localDir, 'enforce-config.json')
  if (purgeConfig) {
    if (fs.existsSync(switchPath)) {
      assertContained(switchPath, localDir)
      fs.rmSync(switchPath, { force: true })
      report.removedFiles.push(switchPath)
    }
  } else if (fs.existsSync(switchPath)) {
    report.preserved.push(switchPath)
  }

  return report
}

// ---------------------------------------------------------------------------
// RFC-008 P5 S6 — OpenCode enforcement deploy (REQ-11). The OpenCode model is
// NOT the claude-code hook+settings.json model: the TS adapter is registered in
// the project `opencode.json` `plugin` array (version-independent path; KB
// opencode-plugin-api.md), and it spawns the co-located node bridge per tool
// call. The bridge resolves its repo-script deps (`enforce-contract.mjs` +
// `scripts/lib/`) via `../../scripts/...` relative to its capabilities/ dir, so
// the full transitive closure co-deploys under `.opencode/plugins/scripts/`
// (decision A — co-deploy the closure). Everything is per-project under
// <project>/.opencode/ — NEVER global (P12).
//
// Deployed layout (resolution-critical — verified by the deployed-bridge E2E):
//   <proj>/.opencode/plugins/episodic-memory/capabilities/{enforcement.ts,enforce-bridge.mjs}
//   <proj>/.opencode/plugins/episodic-memory/{manifest.json,runbooks/*}
//   <proj>/.opencode/plugins/scripts/enforce-contract.mjs   (bridge ../../scripts/..)
//   <proj>/.opencode/plugins/scripts/lib/*.mjs              (closure incl. repo-source.mjs)
//   <proj>/.opencode/plugins/scripts/patterns/{bp-001,events,enforce-config.schema}.json
//   <proj>/.opencode/plugins/scripts/plugins/_index.json    (project-local registry)
//   <proj>/.opencode/plugins/patterns/repo-source-carveouts.json (repo-source.mjs cand-2)
//   <proj>/opencode.json  plugin[] += "./.opencode/plugins/episodic-memory/capabilities/enforcement.ts"
//
// PROJECT-LOCAL contract source (round-2 BLOCKER-1 fix). The contract set is
// deployed BESIDE the deployed enforce-contract.mjs (under scripts/), so
// resolveContractRoot() accepts candidate-0 (the `patterns/bp-001.json` sentinel)
// and returns the deployed scripts/ dir — it NEVER falls through to the legacy
// GLOBAL candidate-1 (~/.episodic-memory), so a project's enforcement decision is
// owned entirely by the project (P12), deterministic across machines. Deploying
// enforce-config.schema.json is what makes loadEnforceConfig able to VALIDATE the
// operator's .episodic-memory/enforce-config.json, so the R5 kill switch
// (active:false -> allow) actually works; without the schema it silently
// fail-closed to active:true. bp-001.json is the resolve sentinel only — the
// bridge passes contractTier/configTier=null (OD-4: no bp-001 lifecycle for
// opencode). Net: GATED write -> block, carve-out -> allow, read -> allow,
// active:false -> allow, no global ambient state consulted.
function opencodeEnforcementPaths(projectDir) {
  const deployRoot = path.join(projectDir, '.opencode', 'plugins')
  const pluginDir = path.join(deployRoot, 'episodic-memory')
  const scriptsDir = path.join(deployRoot, 'scripts')
  return {
    opencodeDir: path.join(projectDir, '.opencode'),
    deployRoot,
    pluginDir,
    capabilitiesDir: path.join(pluginDir, 'capabilities'),
    runbooksDir: path.join(pluginDir, 'runbooks'),
    scriptsDir,
    scriptsLibDir: path.join(scriptsDir, 'lib'),
    // repo-source.mjs candidate-2 carve-out JSON: <deployRoot>/patterns (computed
    // from repo-source.mjs's own ../../patterns).
    carveoutPatternsDir: path.join(deployRoot, 'patterns'),
    // Contract source BESIDE the deployed engine: resolveContractRoot candidate-0
    // (bp-001.json sentinel) + the bridge's events.json / enforce-config.schema.json.
    contractPatternsDir: path.join(scriptsDir, 'patterns'),
    // Bridge registry: path.join(contractRoot='scriptsDir', 'plugins', '_index.json').
    contractIndexPath: path.join(scriptsDir, 'plugins', '_index.json'),
    // Adapter spec registered in opencode.json — always forward-slash (config is
    // OS-portable JSON, not a host path).
    adapterSpec: './.opencode/plugins/episodic-memory/capabilities/enforcement.ts',
    configPath: path.join(projectDir, 'opencode.json'),
  }
}

function installOpenCodeEnforcement(projectDir) {
  const report = { deployedFiles: [], registration: null, warnings: [] }
  const P = opencodeEnforcementPaths(projectDir)

  // 0. PARSE the existing opencode.json FIRST — abort the WHOLE deploy on malformed
  //    config (MAJOR-1 fix: symmetric with uninstall's parse-or-abort; never leave
  //    unregistered files on disk that the agent then silently fails to enforce with).
  let config
  if (fs.existsSync(P.configPath)) {
    try { config = JSON.parse(fs.readFileSync(P.configPath, 'utf8')) }
    catch (e) {
      report.warnings.push(`opencode.json is not valid JSON (${e.message}); aborted — nothing deployed`)
      return report
    }
  } else {
    config = { $schema: 'https://opencode.ai/config.json' }
  }

  // 1. adapter + bridge (co-located) + manifest + runbooks.
  fs.mkdirSync(P.capabilitiesDir, { recursive: true })
  for (const f of ['enforcement.ts', 'enforce-bridge.mjs']) {
    const dst = path.join(P.capabilitiesDir, f)
    fs.copyFileSync(path.join(REPO_PLUGIN_OPENCODE, 'capabilities', f), dst)
    report.deployedFiles.push(dst)
  }
  const manDst = path.join(P.pluginDir, 'manifest.json')
  fs.copyFileSync(path.join(REPO_PLUGIN_OPENCODE, 'manifest.json'), manDst)
  report.deployedFiles.push(manDst)
  const rbSrc = path.join(REPO_PLUGIN_OPENCODE, 'runbooks')
  if (fs.existsSync(rbSrc)) { copyDirRecursive(rbSrc, P.runbooksDir); report.deployedFiles.push(P.runbooksDir) }

  // 2. bridge transitive closure: enforce-contract.mjs + ALL of scripts/lib/*.mjs.
  fs.mkdirSync(P.scriptsLibDir, { recursive: true })
  const ecDst = path.join(P.scriptsDir, 'enforce-contract.mjs')
  fs.copyFileSync(path.join(REPO_SCRIPTS, 'enforce-contract.mjs'), ecDst)
  report.deployedFiles.push(ecDst)
  const repoLib = path.join(REPO_SCRIPTS, 'lib')
  for (const f of fs.readdirSync(repoLib).filter((f) => f.endsWith('.mjs')).sort()) {
    const dst = path.join(P.scriptsLibDir, f)
    fs.copyFileSync(path.join(repoLib, f), dst)
    report.deployedFiles.push(dst)
  }

  // 3. carve-out JSON (repo-source.mjs candidate-2; inline fallback exists, deploy for fidelity).
  const coSrc = path.join(REPO_DIR, 'patterns', 'repo-source-carveouts.json')
  if (fs.existsSync(coSrc)) {
    fs.mkdirSync(P.carveoutPatternsDir, { recursive: true })
    const coDst = path.join(P.carveoutPatternsDir, 'repo-source-carveouts.json')
    fs.copyFileSync(coSrc, coDst)
    report.deployedFiles.push(coDst)
  }

  // 4. PROJECT-LOCAL contract set (BLOCKER-1 fix). bp-001.json is the
  //    resolveContractRoot candidate-0 sentinel; events.json + enforce-config.schema.json
  //    are read by the bridge's L2; _index.json is the project-local registry
  //    (harnessCap). Deployed BESIDE the engine so resolution is project-local, never
  //    the global candidate-1. enforce-config.schema.json presence is what lets the
  //    R5 kill switch (active:false) be honored.
  fs.mkdirSync(P.contractPatternsDir, { recursive: true })
  for (const f of ['bp-001.json', 'events.json', 'enforce-config.schema.json']) {
    const src = path.join(REPO_DIR, 'patterns', f)
    if (fs.existsSync(src)) {
      const dst = path.join(P.contractPatternsDir, f)
      fs.copyFileSync(src, dst)
      report.deployedFiles.push(dst)
    }
  }
  const idxSrc = path.join(REPO_DIR, 'plugins', '_index.json')
  if (fs.existsSync(idxSrc)) {
    fs.mkdirSync(path.dirname(P.contractIndexPath), { recursive: true })
    fs.copyFileSync(idxSrc, P.contractIndexPath)
    report.deployedFiles.push(P.contractIndexPath)
  }

  // 5. register the adapter in opencode.json `plugin` array (config parsed in step 0).
  if (!Array.isArray(config.plugin)) config.plugin = []
  if (!config.plugin.includes(P.adapterSpec)) {
    config.plugin.push(P.adapterSpec)
    writeJSONAtomic(P.configPath, config)
    report.registration = P.adapterSpec
  } else {
    report.registration = `${P.adapterSpec} (already present)`
  }
  return report
}

function uninstallOpenCodeEnforcement(projectDir) {
  const report = { removedFiles: [], removedRegistration: null, warnings: [] }
  const P = opencodeEnforcementPaths(projectDir)

  // (a) config FIRST — parse-or-abort (atomic on malformed; F-C parity with claude-code).
  if (fs.existsSync(P.configPath)) {
    let config
    try { config = JSON.parse(fs.readFileSync(P.configPath, 'utf8')) }
    catch (e) { report.warnings.push(`opencode.json not valid JSON (${e.message}); aborted — nothing changed`); return report }
    if (Array.isArray(config.plugin)) {
      const before = config.plugin.length
      config.plugin = config.plugin.filter((p) => p !== P.adapterSpec)
      if (config.plugin.length !== before) {
        if (config.plugin.length === 0) delete config.plugin
        writeJSONAtomic(P.configPath, config)
        report.removedRegistration = P.adapterSpec
      }
    }
  }

  // (b) remove ONLY what we deployed, each contained under <project>/.opencode (BL-B).
  //     scriptsDir is recursive, so it covers scripts/{lib,patterns,plugins,*.mjs}.
  for (const target of [P.pluginDir, P.scriptsDir, P.carveoutPatternsDir]) {
    if (!fs.existsSync(target)) continue
    assertContained(target, P.opencodeDir)
    fs.rmSync(target, { recursive: true, force: true })
    report.removedFiles.push(target)
  }

  // (c) prune now-empty deploy dirs (leave dirs that still hold other plugins).
  for (const d of [P.deployRoot, P.opencodeDir]) {
    try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); report.removedFiles.push(d) } } catch {}
  }
  return report
}

// RFC-008 P6 S4: per-project Codex enforcement install/uninstall. Mirrors the OpenCode
// layer (installOpenCodeEnforcement above) but deploys under <project>/.codex and registers
// a PreToolUse command hook in .codex/hooks.json (NEVER ~/.codex — Principle 12; NEVER
// config.toml — the interactive hooks.json path is what fires, RFC-008 P6 S1).
function codexEnforcementPaths(projectDir) {
  // R-F3 (review F4): normalize the project root ONCE so a relative or symlinked --project
  // still yields an ABSOLUTE root. adapterAbs below is embedded verbatim in the hooks.json
  // `command` string (`node <adapterAbs>`); codex runs it from its own cwd, so a relative
  // adapterAbs would break the hook. realpath when the dir exists (install operates on an
  // existing project); path.resolve as the fallback. Scoped to codex (NOT install.mjs L46).
  let root
  try { root = fs.realpathSync(projectDir) } catch { root = path.resolve(projectDir) }
  const codexDir = path.join(root, '.codex')
  const pluginDir = path.join(codexDir, 'episodic-memory')
  const scriptsDir = path.join(codexDir, 'scripts')
  return {
    codexDir,
    pluginDir,
    capabilitiesDir: path.join(pluginDir, 'capabilities'),
    runbooksDir: path.join(pluginDir, 'runbooks'),
    scriptsDir,
    scriptsLibDir: path.join(scriptsDir, 'lib'),
    // repo-source.mjs candidate-2 carve-out JSON = <.codex>/patterns (its own ../../patterns).
    carveoutPatternsDir: path.join(codexDir, 'patterns'),
    // resolveContractRoot candidate-0 (bp-001.json) + events.json + enforce-config.schema.json,
    // BESIDE the deployed engine at <.codex>/scripts/patterns.
    contractPatternsDir: path.join(scriptsDir, 'patterns'),
    contractIndexPath: path.join(scriptsDir, 'plugins', '_index.json'),
    // ABSOLUTE host path embedded in the hooks.json command STRING (`node <path>`).
    adapterAbs: path.join(pluginDir, 'capabilities', 'codex-adapter.mjs'),
    hooksJsonPath: path.join(codexDir, 'hooks.json'),
  }
}

function codexHookCommand(adapterAbs) {
  // Shell-quote the path: codex runs the hooks.json `command` via a SHELL (empirically
  // confirmed on 0.142.3 — a `>` redirect inside a hook command evaluates), so an unquoted
  // path containing a space would split the argv and the hook would silently fail OPEN
  // (enforcement not applied). POSIX single-quote escaping neutralizes spaces + $, backticks,
  // globs, ';' etc. in the resolved project path. Uninstall recomputes via this same fn, so
  // its `h.command === cmd` match still holds.
  const quoted = "'" + String(adapterAbs).replaceAll("'", "'\\''") + "'"
  return `node ${quoted}`
}

function installCodexEnforcement(projectDir) {
  const report = { deployedFiles: [], registration: null, warnings: [] }
  const P = codexEnforcementPaths(projectDir)

  // 0. PARSE .codex/hooks.json FIRST — abort the WHOLE deploy on malformed JSON
  //    (MAJOR-1 parity: never leave unregistered files the agent then can't enforce with).
  let config
  if (fs.existsSync(P.hooksJsonPath)) {
    try { config = JSON.parse(fs.readFileSync(P.hooksJsonPath, 'utf8')) }
    catch (e) {
      report.warnings.push(`.codex/hooks.json is not valid JSON (${e.message}); aborted — nothing deployed`)
      return report
    }
  } else {
    config = {}
  }

  // 1. adapter + manifest + runbooks.
  fs.mkdirSync(P.capabilitiesDir, { recursive: true })
  const adDst = path.join(P.capabilitiesDir, 'codex-adapter.mjs')
  fs.copyFileSync(path.join(REPO_PLUGIN_CODEX, 'capabilities', 'codex-adapter.mjs'), adDst)
  report.deployedFiles.push(adDst)
  const manDst = path.join(P.pluginDir, 'manifest.json')
  fs.copyFileSync(path.join(REPO_PLUGIN_CODEX, 'manifest.json'), manDst)
  report.deployedFiles.push(manDst)
  const rbSrc = path.join(REPO_PLUGIN_CODEX, 'runbooks')
  if (fs.existsSync(rbSrc)) { copyDirRecursive(rbSrc, P.runbooksDir); report.deployedFiles.push(P.runbooksDir) }

  // 2. thin-waist closure: enforce-contract.mjs + ALL scripts/lib/*.mjs.
  fs.mkdirSync(P.scriptsLibDir, { recursive: true })
  const ecDst = path.join(P.scriptsDir, 'enforce-contract.mjs')
  fs.copyFileSync(path.join(REPO_SCRIPTS, 'enforce-contract.mjs'), ecDst)
  report.deployedFiles.push(ecDst)
  const repoLib = path.join(REPO_SCRIPTS, 'lib')
  for (const f of fs.readdirSync(repoLib).filter((f) => f.endsWith('.mjs')).sort()) {
    const dst = path.join(P.scriptsLibDir, f)
    fs.copyFileSync(path.join(repoLib, f), dst)
    report.deployedFiles.push(dst)
  }

  // 3. carve-out JSON (repo-source.mjs candidate-2).
  const coSrc = path.join(REPO_DIR, 'patterns', 'repo-source-carveouts.json')
  if (fs.existsSync(coSrc)) {
    fs.mkdirSync(P.carveoutPatternsDir, { recursive: true })
    const coDst = path.join(P.carveoutPatternsDir, 'repo-source-carveouts.json')
    fs.copyFileSync(coSrc, coDst)
    report.deployedFiles.push(coDst)
  }

  // 4. project-local contract set beside the engine (resolveContractRoot candidate-0).
  fs.mkdirSync(P.contractPatternsDir, { recursive: true })
  for (const f of ['bp-001.json', 'events.json', 'enforce-config.schema.json']) {
    const src = path.join(REPO_DIR, 'patterns', f)
    if (fs.existsSync(src)) {
      const dst = path.join(P.contractPatternsDir, f)
      fs.copyFileSync(src, dst)
      report.deployedFiles.push(dst)
    }
  }
  const idxSrc = path.join(REPO_DIR, 'plugins', '_index.json')
  if (fs.existsSync(idxSrc)) {
    fs.mkdirSync(path.dirname(P.contractIndexPath), { recursive: true })
    fs.copyFileSync(idxSrc, P.contractIndexPath)
    report.deployedFiles.push(P.contractIndexPath)
  }

  // 5. register a PreToolUse command hook in .codex/hooks.json — MERGE, idempotent,
  //    NEVER clobber a user hook (codex shape: hooks.PreToolUse[].hooks[].command string).
  const cmd = codexHookCommand(P.adapterAbs)
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {}
  if (!Array.isArray(config.hooks.PreToolUse)) config.hooks.PreToolUse = []
  const already = config.hooks.PreToolUse.some(
    (b) => Array.isArray(b.hooks) && b.hooks.some((h) => h && h.command === cmd))
  if (!already) {
    config.hooks.PreToolUse.push({
      matcher: '.*',
      hooks: [{ type: 'command', command: cmd, statusMessage: 'episodic-memory enforcement', timeout: 30 }],
    })
    writeJSONAtomic(P.hooksJsonPath, config)
    report.deployedFiles.push(P.hooksJsonPath)
    report.registration = cmd
  } else {
    report.registration = `${cmd} (already present)`
  }

  // 6. trust is inactive until the operator runs /hooks (R3) — print the instruction.
  console.log(`[codex enforcement] deployed under ${P.codexDir}. Run "/hooks" inside codex (cwd ${projectDir}) and TRUST the PreToolUse hook to activate enforcement.`)
  return report
}

function uninstallCodexEnforcement(projectDir) {
  const report = { removedFiles: [], removedRegistration: null, warnings: [] }
  const P = codexEnforcementPaths(projectDir)
  const cmd = codexHookCommand(P.adapterAbs)

  // (a) hooks.json FIRST — parse-or-abort; remove ONLY our command, keep user hooks.
  if (fs.existsSync(P.hooksJsonPath)) {
    let config
    try { config = JSON.parse(fs.readFileSync(P.hooksJsonPath, 'utf8')) }
    catch (e) { report.warnings.push(`.codex/hooks.json not valid JSON (${e.message}); aborted — nothing changed`); return report }
    if (config.hooks && Array.isArray(config.hooks.PreToolUse)) {
      let changed = false
      config.hooks.PreToolUse = config.hooks.PreToolUse
        .map((b) => {
          if (!Array.isArray(b.hooks)) return b
          const kept = b.hooks.filter((h) => !(h && h.command === cmd))
          if (kept.length !== b.hooks.length) changed = true
          return { ...b, hooks: kept }
        })
        .filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0)
      if (changed) {
        if (config.hooks.PreToolUse.length === 0) delete config.hooks.PreToolUse
        if (Object.keys(config.hooks).length === 0) delete config.hooks
        writeJSONAtomic(P.hooksJsonPath, config)
        report.removedRegistration = cmd
      }
    }
  }

  // (b) remove ONLY what we deployed (review F1 r2). pluginDir (.codex/episodic-memory) is a
  //     namespace WE create and fully own -> recursive rm is safe. But .codex/scripts and
  //     .codex/patterns sit directly under codex's own config dir and may hold user files;
  //     the adapter's ../../scripts waist forces those bare paths (unlike opencode's namespaced
  //     .opencode/plugins/). So remove only the EXACT files we copied — even inside the generic
  //     lib/patterns/plugins subdirs — then prune each dir bottom-up ONLY if empty.
  if (fs.existsSync(P.pluginDir)) {
    assertContained(P.pluginDir, P.codexDir)
    fs.rmSync(P.pluginDir, { recursive: true, force: true })
    report.removedFiles.push(P.pluginDir)
  }
  const removeFile = (p) => { if (fs.existsSync(p)) { assertContained(p, P.codexDir); fs.rmSync(p, { force: true }); report.removedFiles.push(p) } }
  const pruneIfEmpty = (d) => { try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); report.removedFiles.push(d) } } catch {} }

  removeFile(path.join(P.scriptsDir, 'enforce-contract.mjs'))
  let libFiles = []
  try { libFiles = fs.readdirSync(path.join(REPO_SCRIPTS, 'lib')).filter((f) => f.endsWith('.mjs')) }
  catch { libFiles = fs.existsSync(P.scriptsLibDir) ? fs.readdirSync(P.scriptsLibDir).filter((f) => f.endsWith('.mjs')) : [] }
  for (const f of libFiles) removeFile(path.join(P.scriptsLibDir, f))
  for (const f of ['bp-001.json', 'events.json', 'enforce-config.schema.json']) removeFile(path.join(P.contractPatternsDir, f))
  removeFile(P.contractIndexPath) // .codex/scripts/plugins/_index.json
  removeFile(path.join(P.carveoutPatternsDir, 'repo-source-carveouts.json'))
  // prune bottom-up: leaf dirs first, then parents, each only when now empty.
  for (const d of [P.scriptsLibDir, P.contractPatternsDir, path.dirname(P.contractIndexPath), P.scriptsDir, P.carveoutPatternsDir]) pruneIfEmpty(d)

  // (c) prune an empty .codex (leave it if a user hooks.json or other files remain).
  try { if (fs.existsSync(P.codexDir) && fs.readdirSync(P.codexDir).length === 0) { fs.rmdirSync(P.codexDir); report.removedFiles.push(P.codexDir) } } catch {}
  return report
}

// ---------------------------------------------------------------------------
// RFC-008 P7 S5 — Pi enforcement extension install/uninstall (per-project .pi/).
// Mirrors installCodexEnforcement but deploys under
// <project>/.pi/extensions/episodic-memory/ and registers NOTHING: Pi
// auto-discovers a nested .pi/extensions/<name>/index.js package in a TRUSTED
// project (S5-prep probe, KB pi-agent-extensions.md), so there is no hooks.json
// analogue (codex steps 0 + 5 + codexHookCommand are dropped). NEVER ~/.pi
// (Principle 12). Activation = Pi project trust (`--approve` / interactive).
// ---------------------------------------------------------------------------
function piAgentEnforcementPaths(projectDir) {
  // Normalize the project root once (realpath when it exists; resolve fallback).
  let root
  try { root = fs.realpathSync(projectDir) } catch { root = path.resolve(projectDir) }
  const piDir = path.join(root, '.pi')
  const extensionsDir = path.join(piDir, 'extensions')
  const pluginDir = path.join(extensionsDir, 'episodic-memory')
  const scriptsDir = path.join(pluginDir, 'scripts')
  return {
    piDir,
    extensionsDir,
    pluginDir,
    runbooksDir: path.join(pluginDir, 'runbooks'),
    scriptsDir,
    scriptsLibDir: path.join(scriptsDir, 'lib'),
    // repo-source.mjs self-relative candidate (../../patterns from scripts/lib) = pluginDir/patterns.
    carveoutPatternsDir: path.join(pluginDir, 'patterns'),
    // resolveContractRoot candidate-0 (bp-001.json) beside the deployed engine at pluginDir/scripts/patterns.
    contractPatternsDir: path.join(scriptsDir, 'patterns'),
    contractIndexPath: path.join(scriptsDir, 'plugins', '_index.json'),
    // the extension entry Pi loads; also enforcement.js resolveScriptPath's __dirname.
    adapterAbs: path.join(pluginDir, 'index.js'),
  }
}

function installPiAgentEnforcement(projectDir) {
  const report = { deployedFiles: [], registration: null, warnings: [] }
  const P = piAgentEnforcementPaths(projectDir)

  // 1. adapter (enforcement.js -> index.js) + manifest + runbooks.
  fs.mkdirSync(P.pluginDir, { recursive: true })
  const adDst = path.join(P.pluginDir, 'index.js')
  fs.copyFileSync(path.join(REPO_PLUGIN_PI, 'capabilities', 'enforcement.js'), adDst)
  report.deployedFiles.push(adDst)
  const manDst = path.join(P.pluginDir, 'manifest.json')
  fs.copyFileSync(path.join(REPO_PLUGIN_PI, 'manifest.json'), manDst)
  report.deployedFiles.push(manDst)
  const rbSrc = path.join(REPO_PLUGIN_PI, 'runbooks')
  if (fs.existsSync(rbSrc)) { copyDirRecursive(rbSrc, P.runbooksDir); report.deployedFiles.push(P.runbooksDir) }

  // 2. thin-waist closure: enforce-contract.mjs + ALL scripts/lib/*.mjs.
  fs.mkdirSync(P.scriptsLibDir, { recursive: true })
  const ecDst = path.join(P.scriptsDir, 'enforce-contract.mjs')
  fs.copyFileSync(path.join(REPO_SCRIPTS, 'enforce-contract.mjs'), ecDst)
  report.deployedFiles.push(ecDst)
  const repoLib = path.join(REPO_SCRIPTS, 'lib')
  for (const f of fs.readdirSync(repoLib).filter((f) => f.endsWith('.mjs')).sort()) {
    const dst = path.join(P.scriptsLibDir, f)
    fs.copyFileSync(path.join(repoLib, f), dst)
    report.deployedFiles.push(dst)
  }

  // 3. carve-out JSON (repo-source.mjs self-relative candidate).
  const coSrc = path.join(REPO_DIR, 'patterns', 'repo-source-carveouts.json')
  if (fs.existsSync(coSrc)) {
    fs.mkdirSync(P.carveoutPatternsDir, { recursive: true })
    const coDst = path.join(P.carveoutPatternsDir, 'repo-source-carveouts.json')
    fs.copyFileSync(coSrc, coDst)
    report.deployedFiles.push(coDst)
  }

  // 4. project-local contract set beside the engine (resolveContractRoot candidate-0).
  fs.mkdirSync(P.contractPatternsDir, { recursive: true })
  for (const f of ['bp-001.json', 'events.json', 'enforce-config.schema.json']) {
    const src = path.join(REPO_DIR, 'patterns', f)
    if (fs.existsSync(src)) {
      const dst = path.join(P.contractPatternsDir, f)
      fs.copyFileSync(src, dst)
      report.deployedFiles.push(dst)
    }
  }
  const idxSrc = path.join(REPO_DIR, 'plugins', '_index.json')
  if (fs.existsSync(idxSrc)) {
    fs.mkdirSync(path.dirname(P.contractIndexPath), { recursive: true })
    fs.copyFileSync(idxSrc, P.contractIndexPath)
    report.deployedFiles.push(P.contractIndexPath)
  }

  // 5. NO hooks.json registration — Pi auto-discovers the nested extension in a
  //    trusted project. File presence + trust is the load registration; the live
  //    tool_call block is proven by the S6 E2E, not by install.
  report.registration = 'pi auto-discovery (.pi/extensions/episodic-memory/index.js); no hooks.json'
  console.log(`[pi-agent enforcement] deployed under ${P.pluginDir}. Run "pi" inside ${projectDir} and grant project trust (or "pi --approve") to activate enforcement.`)
  return report
}

function uninstallPiAgentEnforcement(projectDir) {
  const report = { removedFiles: [], removedRegistration: null, warnings: [] }
  const P = piAgentEnforcementPaths(projectDir)

  // .pi/extensions/episodic-memory is a namespace WE fully own -> recursive rm is
  // safe (unlike codex's bare .codex/scripts). No hooks.json to surgically edit.
  if (fs.existsSync(P.pluginDir)) {
    assertContained(P.pluginDir, P.piDir)
    fs.rmSync(P.pluginDir, { recursive: true, force: true })
    report.removedFiles.push(P.pluginDir)
    report.removedRegistration = 'pi auto-discovery (extension file removed)'
  }
  // prune empty .pi/extensions and .pi (leave them if the user has other files).
  const pruneIfEmpty = (d) => { try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); report.removedFiles.push(d) } } catch {} }
  pruneIfEmpty(P.extensionsDir)
  pruneIfEmpty(P.piDir)
  return report
}

if (installHooks && !installEnforcement) {
  // P12 (RFC-008 P4d) transitional honesty (review F2): post-S2 ALL enforcement
  // (gates, libs, taxonomy/contract config, registrations) installs PER-PROJECT
  // via --install-enforcement. --install-hooks alone no longer deploys any
  // enforcement artifact — every inner block below is gated `if (installEnforcement)`.
  // Surface that rather than silently no-op'ing the previously load-bearing flag.
  console.log('Note: enforcement now installs per-project via --install-enforcement (RFC-008 P4d). --install-hooks alone no longer deploys enforcement gates.')
}

if (uninstallEnforcement) {
  // RFC-008 P4d S5 / P5 S6: mutually exclusive with install in one run — reverse
  // the per-project enforcement set and report what was removed/preserved. The
  // OpenCode layer (S6) lives under .opencode/ + opencode.json, not .claude/.
  const rep = tool === 'opencode'
    ? uninstallOpenCodeEnforcement(projectDir)
    : tool === 'codex'
      ? uninstallCodexEnforcement(projectDir)
      : tool === 'pi-agent'
        ? uninstallPiAgentEnforcement(projectDir)
        : runUninstallEnforcement(projectDir, { purgeConfig })
  console.log(JSON.stringify(rep, null, 2))
}

if (installEnforcement && tool === 'opencode') {
  // RFC-008 P5 S6: the OpenCode enforcement layer deploys under .opencode/ +
  // opencode.json (NOT the claude-code .claude/hooks model) — handled wholly by
  // installOpenCodeEnforcement, so it pre-empts the claude-code block below.
  const rep = installOpenCodeEnforcement(projectDir)
  console.log(JSON.stringify(rep, null, 2))
} else if (installEnforcement && tool === 'codex') {
  // RFC-008 P6 S4: the Codex enforcement layer deploys under .codex/ + .codex/hooks.json
  // (NOT the claude-code .claude/hooks model) — handled wholly by installCodexEnforcement,
  // so it pre-empts the claude-code block below. Does NOT touch the `case 'codex'` skill.
  const rep = installCodexEnforcement(projectDir)
  console.log(JSON.stringify(rep, null, 2))
} else if (installEnforcement && tool === 'pi-agent') {
  // RFC-008 P7 S5: the Pi enforcement layer deploys under
  // <project>/.pi/extensions/episodic-memory/ (in-process extension, auto-loaded
  // in a trusted project) — NOT the claude-code .claude/hooks model — handled
  // wholly by installPiAgentEnforcement, so it pre-empts the claude-code block below.
  const rep = installPiAgentEnforcement(projectDir)
  console.log(JSON.stringify(rep, null, 2))
} else if (installHooks || installEnforcement) {
  // P12 (RFC-008 P4d): enforcement artifacts (hook files, libs, taxonomy/contract
  // config, registrations) install PER-PROJECT under <project>/.claude/ — NEVER
  // global — and ONLY under --install-enforcement (every substantive inner block
  // is gated `if (installEnforcement)`). The lone global substrate artifact,
  // patterns/_index.json, is deployed unconditionally far above (§1b).
  const settingsPath = path.join(projectDir, '.claude', 'settings.json')
  const userHooksDir = path.join(projectDir, '.claude', 'hooks')
  const userHooksLibDir = path.join(userHooksDir, 'lib')
  const REPO_HOOKS_LIB = path.join(REPO_HOOKS, 'lib')
  const touched = { hooks: [], settings: [], hookLib: [] }
  try {
   // Shared enforcement lib-install state, hoisted so every installEnforcement
   // sub-block (5_lib, 5c registration gating, classifier-sync warning) sees it.
   const libResults = {}
   let hookLibFiles = []
   let anyLibSkippedDivergent = false
   if (installEnforcement) {
    // 5_lib. Deploy hooks/lib/ alongside hooks/. Session 1 (#86 PR-B / #89 /
    // #101) introduces hooks/lib/command-classifier.sh and hooks/lib/repo-root.sh
    // sourced by plan-gate.sh and checkpoint-gate.sh via $BASH_SOURCE/cd -P.
    // Per Codex review ...8c92: install must keep the lib in sync with the
    // hooks; same per-file hash + --install-hooks-force semantics. Per
    // ...3503 Q3: source-of-truth is current repo files at install time.
    // libResults[file] tracks per-lib install outcome. Codex PR #113 review
    // finding 3 [P2]: dependent hooks must NOT be registered if any required
    // lib was skipped-divergent — registered hook would source stale/missing
    // lib at runtime and fail loud (or worse, silently behave wrong if user's
    // divergent lib is incomplete).
    if (fs.existsSync(REPO_HOOKS_LIB)) {
      fs.mkdirSync(userHooksLibDir, { recursive: true })
      hookLibFiles = fs.readdirSync(REPO_HOOKS_LIB).filter(f => f.endsWith('.sh')).sort()
      for (const file of hookLibFiles) {
        const src = path.join(REPO_HOOKS_LIB, file)
        const dst = path.join(userHooksLibDir, file)
        const result = installHookFile(src, dst, installHooksForce)
        libResults[file] = result
        switch (result) {
          case 'copied':
            console.log(`Installed hook lib: ${dst}`)
            touched.hookLib.push(dst)
            break
          case 'unchanged':
            console.log(`Hook lib already current: ${dst}`)
            break
          case 'forced':
            console.log(`Force-overwrote hook lib: ${dst}`)
            touched.hookLib.push(dst)
            break
          case 'skipped-divergent':
            console.log(`Skipped hook lib (divergent local edit): ${dst} — re-run with --install-hooks-force to overwrite`)
            anyLibSkippedDivergent = true
            break
          case 'missing-source':
            console.log(`Note: ${src} not found in repo, skipped`)
            break
        }
      }
    }

    // 5a-pre. PR-B orphan sweep for renamed files (llm-classifier →
    // agent-classifier). User directive "delete stale/orphan": the glob copies
    // above add the new names but never remove old installed copies. Delete the
    // old names ONLY when the new replacements are current in THIS run — never
    // delete an orphan that a still-divergent command-classifier.sh might still
    // source (codex R1 P2: install.mjs may skip-divergent a locally-edited lib).
    // Explicit basename list (never glob-delete); auditable / CI-checkable.
    const RENAMED_REMOVED = [
      { oldPath: path.join(userHooksLibDir, 'llm-classifier.sh'),
        reason: 'renamed → agent-classifier.sh (PR-B)' },
      { oldPath: path.join(SCRIPTS_DIR, 'llm-classifier-dispatch.mjs'),
        reason: 'renamed → agent-classifier-dispatch.mjs (PR-B)' }
    ]
    const agentClassifierCurrent =
      ['copied', 'unchanged', 'forced'].includes(libResults['agent-classifier.sh'])
    const commandClassifierSafe =
      libResults['command-classifier.sh'] !== 'skipped-divergent'
    if (agentClassifierCurrent && commandClassifierSafe) {
      for (const { oldPath, reason } of RENAMED_REMOVED) {
        if (fs.existsSync(oldPath)) {
          fs.rmSync(oldPath, { force: true })
          console.log(`Removed stale renamed file: ${oldPath} (${reason})`)
          touched.hookLib.push(`removed:${oldPath}`)
        }
      }
    } else {
      console.log(
        'Skipped orphan sweep of old llm-classifier.sh — new agent-classifier.sh ' +
        'not fully installed (divergent local edit on command-classifier.sh?); ' +
        're-run with --install-hooks-force'
      )
    }
   } // end if (installEnforcement) — enforcement hook libs (per-project)

   // RFC-008 P4d / Principle 12: the enforce-contract RUNTIME config (taxonomy.json,
   // the bp-001/events/schema contract set, plugins/_index.json) is ENFORCEMENT, not
   // substrate — it now deploys PER-PROJECT, co-located with the engine, in the
   // `if (installEnforcement)` 5b-ec block above. It is no longer co-deployed to the
   // global $HOME/.episodic-memory under --install-hooks (that was the config half of
   // the P12 leak). No global contract co-deploy remains.

   if (installEnforcement) {
    // RFC-008 P3c (R4/F4, codex R1-P1b): if the command classifier was KEPT as a
    // divergent local edit while taxonomy.json was (re)deployed just above, the
    // installed classifier and the global taxonomy may disagree. Two cases,
    // distinguished by whether the kept file carries the runtime-sourcing helper:
    //   pre-P3c  (no _ensure_taxonomy_synced): runs stale hardcoded labels and is
    //            NOT taxonomy-synced — the gate is silently unprotected by
    //            runtime-sourcing (no fail-closed at all).
    //   post-P3c (has the helper): will FAIL CLOSED loudly on any drift until
    //            re-forced.
    if (libResults['command-classifier.sh'] === 'skipped-divergent') {
      let keptClassifier = ''
      try {
        keptClassifier = fs.readFileSync(
          path.join(userHooksLibDir, 'command-classifier.sh'), 'utf8')
      } catch { /* unreadable → treat as pre-P3c (no helper) below */ }
      if (keptClassifier.includes('_ensure_taxonomy_synced')) {
        console.log(
          'WARNING: command-classifier.sh kept (divergent local edit) while ' +
          'taxonomy.json was redeployed — the kept classifier will FAIL CLOSED ' +
          'on any taxonomy drift. Re-run with --install-hooks-force to sync.'
        )
      } else {
        console.log(
          'WARNING: command-classifier.sh kept (divergent local edit) is pre-P3c ' +
          '— it does NOT runtime-source taxonomy.json and is NOT taxonomy-synced ' +
          '(runs stale hardcoded labels). Re-run with --install-hooks-force to ' +
          'install runtime label-sourcing.'
        )
      }
    }

    // 5a. Hook specs from scripts/lib/install-manifest.mjs (single source of
    // truth, statically imported at top). Ensure the PROJECT hooks dir exists
    // (P12: enforcement hook files live under <project>/.claude/hooks/).
    const hookSpecs = HOOK_SPECS
    fs.mkdirSync(userHooksDir, { recursive: true })

    // 5b. Copy hook files; track which got installed for registration eligibility.
    const fileResults = {} // spec.file → result
    for (const spec of hookSpecs) {
      const repoFile = path.join(REPO_HOOKS, spec.file)
      const destFile = path.join(userHooksDir, spec.file)
      const result = installHookFile(repoFile, destFile, installHooksForce)
      fileResults[spec.file] = result
      switch (result) {
        case 'copied':
          console.log(`Installed hook: ${destFile}`)
          touched.hooks.push(destFile)
          break
        case 'unchanged':
          console.log(`Hook already current: ${destFile}`)
          break
        case 'forced':
          console.log(`Force-overwrote hook: ${destFile}`)
          touched.hooks.push(destFile)
          break
        case 'skipped-divergent':
          console.log(`Skipped (divergent local edit): ${destFile} — re-run with --install-hooks-force to overwrite`)
          break
        case 'missing-source':
          console.log(`Note: ${repoFile} not found in repo, skipped`)
          break
      }
    }

    // 5b-se. The SessionEnd hook SCRIPT (em-session-end-prompt.mjs) is an
    // enforcement hook script (P12) — copy it from scripts/ into the PROJECT
    // hooks dir too, so its registration points at <project>/.claude/hooks/.
    const seRepo = path.join(REPO_SCRIPTS, SESSION_END_SCRIPT)
    const seDest = path.join(userHooksDir, SESSION_END_SCRIPT)
    const seFileResult = installHookFile(seRepo, seDest, installHooksForce)
    fileResults[SESSION_END_SCRIPT] = seFileResult
    if (seFileResult === 'copied' || seFileResult === 'forced') {
      console.log(`Installed SessionEnd hook script: ${seDest}`)
      touched.hooks.push(seDest)
    } else if (seFileResult === 'unchanged') {
      console.log(`SessionEnd hook script already current: ${seDest}`)
    }

    // 5b-ec. RFC-008 P4d / Principle 12 — relocate the enforcement RUNTIME (engine +
    // classifier + markers + bp1 + their lib closure + the contract config) INTO the
    // project so global holds zero enforcement. The per-project gates resolve all of
    // it co-located ($HOOK_DIR), never reaching into $HOME/.episodic-memory.
    //
    //   entry scripts → <project>/.claude/hooks/         (siblings of the gates)
    //   lib closure   → <project>/.claude/hooks/lib/      (relative ./lib/ imports resolve)
    //   contract cfg  → <project>/.claude/hooks/patterns/ + .../plugins/  (engine candidate-0)
    fs.mkdirSync(userHooksLibDir, { recursive: true })
    const entryScripts = enforcementEntryScripts(REPO_DIR)
    for (const f of entryScripts) {
      const dst = path.join(userHooksDir, f)
      fs.copyFileSync(path.join(REPO_SCRIPTS, f), dst)
      fs.chmodSync(dst, 0o755)
      touched.hooks.push(dst)
    }
    for (const f of enforcementBundleLibs(REPO_DIR)) {
      const src = path.join(REPO_SCRIPTS, 'lib', f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(userHooksLibDir, f))
    }
    console.log(`Installed enforcement runtime (${entryScripts.length} scripts + lib closure) to ${userHooksDir}`)

    // Contract config co-located with the engine (enforce-contract candidate-0 =
    // <selfDir>/patterns). F-NEW-4 atomic order: events.json + schema FIRST, the
    // sha-referencer bp-001.json LAST, so the candidate gate (keys on bp-001.json)
    // flips to present only once the whole coupled set is on disk.
    const projPatternsDir = path.join(userHooksDir, 'patterns')
    const projPluginsDir = path.join(userHooksDir, 'plugins')
    fs.mkdirSync(projPatternsDir, { recursive: true })
    let deployedContractSet = false
    const repoTaxonomy = path.join(REPO_DIR, 'patterns', 'taxonomy.json')
    if (fs.existsSync(repoTaxonomy)) {
      fs.copyFileSync(repoTaxonomy, path.join(projPatternsDir, 'taxonomy.json'))
    }
    const repoBp001 = path.join(REPO_DIR, 'patterns', 'bp-001.json')
    if (fs.existsSync(repoBp001)) {
      for (const f of ['events.json', 'enforce-config.schema.json']) {
        const src = path.join(REPO_DIR, 'patterns', f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(projPatternsDir, f))
      }
      fs.copyFileSync(repoBp001, path.join(projPatternsDir, 'bp-001.json')) // LAST — sha-referencer
      deployedContractSet = true
    }
    const repoPluginsIndex = path.join(REPO_DIR, 'plugins', '_index.json')
    if (fs.existsSync(repoPluginsIndex)) {
      fs.mkdirSync(projPluginsDir, { recursive: true })
      fs.copyFileSync(repoPluginsIndex, path.join(projPluginsDir, '_index.json'))
    }
    if (deployedContractSet) {
      console.log(`Installed enforce-contract config set to ${projPatternsDir}`)
      try {
        const depBp = JSON.parse(fs.readFileSync(path.join(projPatternsDir, 'bp-001.json'), 'utf8'))
        const depEvents = JSON.parse(fs.readFileSync(path.join(projPatternsDir, 'events.json'), 'utf8'))
        const liveEv = eventsVersion(depEvents)
        if (depBp.events_version !== liveEv) {
          console.log(
            `WARNING: deployed bp-001.events_version (${depBp.events_version}) != sha of deployed ` +
            `events.json (${liveEv}) — contract set is divergent/torn; enforce-contract will fail ` +
            'CLOSED (stay STRONG). Re-run with --install-hooks-force to resync.'
          )
        }
      } catch (e) {
        console.log(`WARNING: could not verify enforce-contract set coupling: ${e.message}`)
      }
    }

    // 5b-ec-cfg. RFC-008 P4d S4 (P12 invariant 2 — per-project on/off switch):
    // SEED a default enforce-config.json so the operator has a discoverable switch
    // to edit. It lives at the MARKER root (<project>/.episodic-memory/), exactly
    // where loadEnforceConfig reads it (NOT the contract root — §6 two-root split).
    //
    // CREATE-IF-ABSENT, never overwrite — even under --install-hooks-force: the file
    // is operator-owned mutable state (R5 kill switch), and a reinstall must never
    // flip a deliberate {"active":false} back on (P12: each project OWNS its switch).
    // Exclusive-create (flag:'wx') is race-free (no existsSync-then-write TOCTOU):
    // EEXIST ⇒ preserved; any OTHER errno (EACCES/ENOSPC/EROFS) ⇒ non-fatal error log
    // (the install proceeds). A write failure costs only the seeded switch, never
    // safety — at runtime an absent file fails closed to identity {active:true} →
    // enforce-ON (loadEnforceConfig). A torn/partial write is likewise safe (runtime
    // JSON.parse fail → identity{active:true} → enforce-ON), so the non-atomic single
    // write needs no temp+rename. Seeded as gitignored local state by design
    // (.episodic-memory/ ignore at §2 above) — a per-checkout switch, not committed
    // team policy. Seeded instances pin an explicit active:true and do NOT auto-track
    // the absent-file identity default; a future change to the safe default would need
    // a migration of EXISTING seeded files (out of S6 scope). The seed↔identity
    // coupling for NEW seeds is single-sourced as ENFORCE_CONFIG_SEED and guarded by
    // tests/test-enforce-config-seed-identity.mjs (RFC-008 P4d S6, REQ-7): the seeded
    // literal normalizes to the SAME `active` disposition as loadEnforceConfig's
    // absent-file identity, so the two can never silently diverge.
    const enforceConfigPath = path.join(localDir, 'enforce-config.json')
    // localDir already exists (created unconditionally at §2, alongside episodes/).
    try {
      fs.writeFileSync(enforceConfigPath, ENFORCE_CONFIG_SEED, { flag: 'wx' })
      console.log(`Provisioned per-project enforcement switch: ${enforceConfigPath} (active:true)`)
      touched.hooks.push(enforceConfigPath)
    } catch (e) {
      if (e.code === 'EEXIST') {
        console.log(`Enforcement switch already present (operator-owned, preserved): ${enforceConfigPath}`)
      } else {
        console.log(`WARNING: could not provision ${enforceConfigPath}: ${e.message} ` +
          '(enforcement still defaults ON at runtime; re-run install to retry)')
      }
    }

    // 5c. Read settings, run migration, register hooks.
    let settings = {}
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    }
    if (!settings.hooks) settings.hooks = {}

    const migrated = migrateMalformedEntries(settings.hooks)
    if (migrated > 0) {
      console.log(`Migrated ${migrated} malformed hook entr${migrated === 1 ? 'y' : 'ies'} to nested shape`)
      touched.settings.push(`migrated ${migrated} legacy entr${migrated === 1 ? 'y' : 'ies'}`)
    }

    // Register copied/unchanged/forced hooks. Skip-divergent withholds NEW
    // registration (per Codex review): we don't want install.mjs to point
    // Claude at unreviewed custom content. If a registration already exists
    // for the canonical path, addHookEntry returns 'present' and leaves it.
    //
    // Codex PR #113 finding 3 [P2]: hooks that source hooks/lib/ files are
    // dependent on lib install success. If any required lib was skipped-
    // divergent, withhold NEW registration of dependent hooks. Existing
    // registration is preserved (don't yank a working setup).
    //
    // Issue #116 [P2] / Plan-agent v2 review: derive libDependentHooks at
    // runtime by grepping each hook's REPO source for `source.*hooks/lib/`
    // (not the deployed copy — Plan-agent confirmed direction to avoid
    // bootstrap circularity). A future hook (e.g. push-gate.sh in PR-E)
    // that sources hooks/lib/ is automatically included; a stateless hook
    // is automatically excluded.
    const eligibleForReg = new Set(['copied', 'unchanged', 'forced'])
    const libDependentHooks = new Set()
    // Build the set of expected lib basenames (so a hook need not literally
    // contain "hooks/lib/" — variable-built paths via $LIB_DIR/ also match).
    let libBasenames = []
    if (fs.existsSync(REPO_HOOKS_LIB)) {
      libBasenames = fs.readdirSync(REPO_HOOKS_LIB).filter(f => f.endsWith('.sh'))
    }
    for (const spec of hookSpecs) {
      const repoFile = path.join(REPO_HOOKS, spec.file)
      if (!fs.existsSync(repoFile)) continue
      const src = fs.readFileSync(repoFile, 'utf8')
      // Match if the hook (a) literally references hooks/lib/, or (b) uses
      // a `source` / `.` statement naming any known lib basename. The latter
      // catches variable-built paths like `source "$LIB_DIR/foo.sh"`.
      // Codex audit: previous regex only matched (a), missing both real
      // dependent hooks because they use $LIB_DIR variable form. Silent
      // protection bypass.
      const literalLibPath = /(^|\s)(source|\.)\s+[^\n]*hooks\/lib\//.test(src)
      const sourcesKnownLib = libBasenames.some(b => {
        // Match `source ... <basename>` or `. ... <basename>` on the same line.
        const re = new RegExp(`(^|\\n|\\s)(source|\\.)\\s+[^\\n]*${b.replace(/\./g, '\\.')}`)
        return re.test(src)
      })
      if (literalLibPath || sourcesKnownLib) {
        libDependentHooks.add(spec.file)
      }
    }

    for (const spec of hookSpecs) {
      const canonicalCmd = shellQuote(path.join(userHooksDir, spec.file))
      const fileEligible = eligibleForReg.has(fileResults[spec.file])
      const libBlocksReg = libDependentHooks.has(spec.file) && anyLibSkippedDivergent
      if (!fileEligible || libBlocksReg) {
        const alreadyRegistered = (settings.hooks[spec.event] || []).some(e =>
          entryHasExactCommand(e, canonicalCmd))
        if (alreadyRegistered) {
          console.log(`${spec.event} ${spec.file}: existing registration preserved`)
        } else if (libBlocksReg) {
          console.log(`${spec.event} ${spec.file}: registration withheld (required hooks/lib was skipped-divergent — re-run with --install-hooks-force)`)
        } else {
          console.log(`${spec.event} ${spec.file}: registration withheld (file install skipped)`)
        }
        continue
      }
      const result = addHookEntry(settings.hooks, spec.event, canonicalCmd, {
        matcher: spec.matcher, timeout: spec.timeout
      })
      console.log(`${spec.event} ${spec.file}: ${result}`)
      if (result === 'added') touched.settings.push(`${spec.event} → ${spec.file}`)
    }

    // SessionEnd em-session-end-prompt.mjs — registered at its PER-PROJECT
    // location (P12): <project>/.claude/hooks/em-session-end-prompt.mjs.
    const seCmd = `node ${shellQuote(path.join(userHooksDir, SESSION_END_SCRIPT))}`
    const seResult = addHookEntry(settings.hooks, 'SessionEnd', seCmd, { timeout: 10 })
    console.log(`SessionEnd em-session-end-prompt.mjs: ${seResult}`)
    if (seResult === 'added') touched.settings.push('SessionEnd → em-session-end-prompt.mjs')

    // P2 (code review): warn about stale canonical-named entries left behind
    // by migration so the user can prune them. Run AFTER all registrations.
    const canonicalByBasename = {
      'em-session-end-prompt.mjs': path.join(userHooksDir, 'em-session-end-prompt.mjs'),
      'checkpoint-gate.sh': path.join(userHooksDir, 'checkpoint-gate.sh'),
      'plan-gate.sh': path.join(userHooksDir, 'plan-gate.sh'),
      'em-recall-sessionstart.sh': path.join(userHooksDir, 'em-recall-sessionstart.sh'),
      'stop-gate.sh': path.join(userHooksDir, 'stop-gate.sh'),
      // #238 plan-v2 audit F5: include preflight-gate.sh (PR #240 omission)
      // AND the new preflight-prompt-helper.sh so stale registrations are
      // flagged for the operator to prune.
      'preflight-gate.sh': path.join(userHooksDir, 'preflight-gate.sh'),
      'preflight-prompt-helper.sh': path.join(userHooksDir, 'preflight-prompt-helper.sh')
    }
    // RFC-008 P4d double-registration fix. A prior installer version registered
    // hooks by PROJECT-RELATIVE path (`.claude/hooks/X`); this version registers
    // the canonical ABSOLUTE path. addHookEntry's idempotence keys on the EXACT
    // command string, so the two spellings don't unify — the absolute entry is
    // ADDED beside the stale relative one and every hook fires twice. Resolve
    // each stale entry's path: if it points at the SAME canonical file, it is a
    // superseded spelling → auto-remove it (the canonical absolute entry stays).
    // If it only shares the BASENAME but resolves elsewhere, it may be the
    // operator's own hook → warn only, never auto-remove (original safety intent).
    const staleEntries = detectStaleCanonicalEntries(settings.hooks, canonicalByBasename)
    for (const { event, basename, command } of staleEntries) {
      const canonicalResolved = path.resolve(canonicalByBasename[basename])
      if (hookCommandTargetPath(command, projectDir) === canonicalResolved) {
        const removed = removeHookEntryByCommand(settings.hooks, event, command)
        if (removed > 0) {
          console.log(`Removed superseded duplicate ${event} registration: ${command} (canonical absolute entry kept)`)
          touched.settings.push(`removed duplicate ${event} → ${basename}`)
        }
      } else {
        console.log(`Warning: stale ${event} entry for ${basename} at ${command} — resolves to a non-canonical path; left in place. Remove manually if unintended.`)
      }
    }

    writeJSONAtomic(settingsPath, settings)
    if (touched.settings.length > 0) touched.hooks.push(settingsPath)

    // 5d. Consent legibility (Codex non-blocking guidance): list everything
    // touched so the user can audit the install.
    if (touched.hooks.length > 0 || touched.settings.length > 0) {
      console.log('--- Hook install summary ---')
      if (touched.hooks.length > 0) {
        console.log('Files written:')
        for (const f of touched.hooks) console.log(`  ${f}`)
      }
      if (touched.settings.length > 0) {
        console.log('Settings.json mutations:')
        for (const m of touched.settings) console.log(`  ${m}`)
      }
    } else {
      console.log('--- Hook install summary: nothing to do (already current) ---')
    }
   } // end if (installEnforcement) — enforcement hook files + registration (per-project)
  } catch (e) {
    console.log(`Note: could not install hooks: ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// 6. --install-second-opinion: write install snapshot at
//    ~/.claude/hooks/second-opinion-providers.json + copy
//    hooks/second-opinion-gate.mjs to ~/.claude/hooks/.
//
// v3.1/v3.2/v3.3 contract: harness reads source_hash to detect drift
// (I-27a registry-stale-at-gate); composer reads per-fragment SHAs for
// in-flight tamper detection (I-27b preamble-tamper-at-composer); hook
// reads providers + cli_match patterns to gate Bash/Agent calls (I-8/I-9/I-10).
//
// Note: hook registration in ~/.claude/settings.json PreToolUse is performed
// by --install-hooks (existing flow). --install-second-opinion ONLY writes
// the snapshot + copies the gate script. To register the hook, run
// --install-hooks alongside --install-second-opinion.
// ---------------------------------------------------------------------------
if (installSecondOpinion) {
  // P12 (RFC-008 P4d): second-opinion-gate.mjs is a PreToolUse hook — its code
  // (gate + libs + runbooks) installs PER-PROJECT under <project>/.claude/hooks/,
  // never global. (The providers.json snapshot is a generated data artifact read
  // via the shared snapshotPath() resolver; fully relocating the runtime snapshot
  // path is S3 dep-class scope. The P12 guardrail tracks hook CODE files (.sh/.mjs),
  // which this moves out of global.)
  const userHooksDir = path.join(projectDir, '.claude', 'hooks')
  const userHooksLibDir = path.join(userHooksDir, 'lib')
  const userRunbooksDir = path.join(userHooksDir, 'runbooks')

  // ─── Codex r1 P1-3: pre-flight source existence + quickref derivation. ───
  // Validate ALL sources upfront so a missing/bad source doesn't leave a
  // partial install. Quickref derivation is the most failure-prone step
  // (section sentinel must be present + size-bounded); run it first so
  // we fail fast before any copy is attempted.
  const repoGateSrc         = path.join(REPO_HOOKS, 'second-opinion-gate.mjs')
  const repoValidatorSrc    = path.join(REPO_SECOND_OPINION, 'lib', 'registry-validator.mjs')
  const repoLocalDirSrc     = path.join(REPO_DIR, 'scripts', 'lib', 'local-dir.mjs')
  const repoTimeoutFloorSrc = path.join(REPO_HOOKS, 'lib', 'so-timeout-floor.mjs')
  // RFC-008 Follow (R10): the second-opinion runbooks now live at
  // plugins/second-opinion/runbooks/ (in-repo name harness.md per RFC L1135).
  // The deploy dest below stays second-opinion-harness.md, so the gate runtime
  // path (second-opinion-gate.mjs) is unchanged. REPO_DIR-relative (NOT
  // REPO_HOOKS, which resolves under plugins/claude-code/).
  const repoRunbookSrc      = path.join(REPO_DIR, 'plugins', 'second-opinion', 'runbooks', 'harness.md')

  const userGateDst         = path.join(userHooksDir, 'second-opinion-gate.mjs')
  const userValidatorDst    = path.join(userHooksLibDir, 'registry-validator.mjs')
  const userLocalDirDst     = path.join(userHooksLibDir, 'local-dir.mjs')
  const userTimeoutFloorDst = path.join(userHooksLibDir, 'so-timeout-floor.mjs')
  const userRunbookDst      = path.join(userRunbooksDir, 'second-opinion-harness.md')
  const userQuickrefDst     = path.join(userRunbooksDir, 'second-opinion-harness.quickref.md')

  // deriveQuickref: extract the "Self-trigger checklist" section from the
  // full runbook. Fail-closed if the section is missing or out of range.
  // Codex r4: section rename/removal in canonical runbook → install throws.
  function deriveQuickref(fullRunbookPath) {
    if (!fs.existsSync(fullRunbookPath)) {
      throw new Error(`runbook source not found at ${fullRunbookPath}`)
    }
    const body = fs.readFileSync(fullRunbookPath, 'utf8')
    // Locate header line (emoji-tolerant), then scan forward for the next
    // `## ` heading. Avoids multiline-mode `$` ambiguity.
    const headerRe = /^## [^\n]*Self-trigger checklist[^\n]*\n/m
    const headerMatch = body.match(headerRe)
    if (!headerMatch) {
      throw new Error(
        `quickref-derivation-failed: section "Self-trigger checklist" not found in ${fullRunbookPath}. ` +
        `Either restore the section in the runbook or update the install script's headerRe.`
      )
    }
    const startIdx = headerMatch.index
    const afterHeader = startIdx + headerMatch[0].length
    const nextHeader = body.indexOf('\n## ', afterHeader)
    const endIdx = nextHeader === -1 ? body.length : nextHeader
    const section = body.substring(startIdx, endIdx).trim()
    if (section.length < 64) {
      throw new Error(`quickref-derivation-failed: section too short (${section.length} chars)`)
    }
    if (section.length > 2048) {
      throw new Error(
        `quickref-derivation-failed: section too long (${section.length} chars > 2048 cap); ` +
        `distill before installing or update the cap in install.mjs:deriveQuickref.`
      )
    }
    return section + '\n'
  }

  // Pre-flight all source existence checks.
  const preflightMissing = []
  for (const src of [repoGateSrc, repoValidatorSrc, repoLocalDirSrc, repoTimeoutFloorSrc, repoRunbookSrc]) {
    if (!fs.existsSync(src)) preflightMissing.push(src)
  }
  if (preflightMissing.length > 0) {
    console.error('second-opinion install pre-flight failed; missing sources:')
    for (const m of preflightMissing) console.error(`  ${m}`)
    installFailed = true
  }

  let derivedQuickref = null
  if (!installFailed) {
    try {
      derivedQuickref = deriveQuickref(repoRunbookSrc)
      console.log(`Derived quickref: ${derivedQuickref.length} chars`)
    } catch (e) {
      console.error(`Quickref derivation failed: ${e.message}`)
      installFailed = true
    }
  }

  // Codex post-impl review F1 (HOLD P1): make runtime install atomic via
  // rollback. Each successful copy is recorded; on failure, all copies are
  // reverted by quarantining (rename to .stale.<ts>) so the install never
  // leaves a half-updated runtime that disagrees with the snapshot below.
  const runtimeInstalled = []  // array of {dest, prevQuarantine?} entries

  function safeCopy(label, src, dst, mode = null) {
    if (installFailed) return
    let prevQuarantine = null
    let entryPushed = false
    try {
      const dir = path.dirname(dst)
      fs.mkdirSync(dir, { recursive: true })
      // If dst already exists, move it aside so rollback can restore.
      if (fs.existsSync(dst)) {
        prevQuarantine = `${dst}.preinstall.${Date.now()}`
        fs.renameSync(dst, prevQuarantine)
        // PR-level review P1: record rollback metadata IMMEDIATELY after
        // quarantine so a later copy/chmod failure restores prevQuarantine.
        // Without this push, a first-copy failure leaves the rollback array
        // empty and rollbackRuntime() is a no-op while the original file
        // sits quarantined unrecoverably.
        runtimeInstalled.push({ dest: dst, prevQuarantine })
        entryPushed = true
      }
      fs.copyFileSync(src, dst)
      if (mode !== null) fs.chmodSync(dst, mode)
      if (!entryPushed) {
        runtimeInstalled.push({ dest: dst, prevQuarantine })
      }
      console.log(`Installed ${label}: ${dst}`)
    } catch (e) {
      console.error(`Failed to install ${label}: ${e.message}`)
      // If we quarantined but didn't push (shouldn't happen now), still
      // attempt direct restore here so the caller's rollbackRuntime can
      // proceed. The post-fix push above means this catch is mostly safety net.
      if (prevQuarantine && !entryPushed) {
        try {
          if (!fs.existsSync(dst)) fs.renameSync(prevQuarantine, dst)
        } catch {}
      }
      installFailed = true
    }
  }

  function safeWrite(label, dst, content) {
    if (installFailed) return
    let prevQuarantine = null
    let entryPushed = false
    try {
      const dir = path.dirname(dst)
      fs.mkdirSync(dir, { recursive: true })
      if (fs.existsSync(dst)) {
        prevQuarantine = `${dst}.preinstall.${Date.now()}`
        fs.renameSync(dst, prevQuarantine)
        runtimeInstalled.push({ dest: dst, prevQuarantine })
        entryPushed = true
      }
      fs.writeFileSync(dst, content)
      if (!entryPushed) {
        runtimeInstalled.push({ dest: dst, prevQuarantine })
      }
      console.log(`Installed ${label}: ${dst}`)
    } catch (e) {
      console.error(`Failed to install ${label}: ${e.message}`)
      if (prevQuarantine && !entryPushed) {
        try {
          if (!fs.existsSync(dst)) fs.renameSync(prevQuarantine, dst)
        } catch {}
      }
      installFailed = true
    }
  }

  function rollbackRuntime() {
    if (runtimeInstalled.length === 0) return
    console.error('Rolling back runtime install due to failure...')
    // Reverse order — last-installed quarantined first.
    for (let i = runtimeInstalled.length - 1; i >= 0; i--) {
      const { dest, prevQuarantine } = runtimeInstalled[i]
      try {
        if (fs.existsSync(dest)) {
          const failQuarantine = `${dest}.rollback.${Date.now()}`
          fs.renameSync(dest, failQuarantine)
          console.error(`  Quarantined: ${dest} -> ${failQuarantine}`)
        }
        if (prevQuarantine && fs.existsSync(prevQuarantine)) {
          fs.renameSync(prevQuarantine, dest)
          console.error(`  Restored:    ${prevQuarantine} -> ${dest}`)
        }
      } catch (re) {
        console.error(`  Rollback failed for ${dest}: ${re.message}`)
      }
    }
  }

  safeCopy('second-opinion gate hook', repoGateSrc, userGateDst, 0o755)
  safeCopy('second-opinion validator lib', repoValidatorSrc, userValidatorDst)
  safeCopy('second-opinion local-dir lib', repoLocalDirSrc, userLocalDirDst)
  safeCopy('second-opinion timeout-floor lib', repoTimeoutFloorSrc, userTimeoutFloorDst)
  safeCopy('runbook', repoRunbookSrc, userRunbookDst)
  if (!installFailed && derivedQuickref) {
    safeWrite(`quickref (${derivedQuickref.length} chars)`, userQuickrefDst, derivedQuickref)
  }

  if (installFailed) {
    rollbackRuntime()
  } else {
    // Clean up pre-install quarantines (success path — old files no longer needed).
    for (const { prevQuarantine } of runtimeInstalled) {
      if (prevQuarantine && fs.existsSync(prevQuarantine)) {
        try { fs.unlinkSync(prevQuarantine) } catch {}
      }
    }
  }

  // Unified quarantine: if ANY snapshot-refresh step fails after the global
  // source-copy completed (validator-lib copy, Gate 2 validation, or
  // writeSnapshot), the pre-existing snapshot must be quarantined so the
  // hook fail-closes (snapshot-not-installed) rather than reading a
  // stale-valid snapshot against newly-updated source. Uses snapshotPath()
  // — the same resolution writeSnapshot() uses — so env override
  // (SO_INSTALL_SNAPSHOT_PATH) routes both to the same target. F1+F2 from
  // post-implementation code review.
  let snapshotPathFn = null
  function quarantineExistingSnapshot() {
    if (!snapshotPathFn) return
    try {
      const target = snapshotPathFn()
      if (fs.existsSync(target)) {
        const quarantineName = `${target}.stale.${Date.now()}`
        fs.renameSync(target, quarantineName)
        console.error(`Quarantined pre-existing snapshot to: ${quarantineName}`)
      }
    } catch (qe) {
      console.error(`Quarantine attempt failed: ${qe.message}`)
    }
  }

  // Codex post-impl review F1: skip snapshot refresh entirely if runtime
  // install failed. Quarantine pre-existing snapshot so the gate
  // fail-closes on a partial runtime rather than reading a stale-valid
  // snapshot against the rolled-back runtime files.
  try {
    if (installFailed) {
      const { snapshotPath } = await import(
        new URL('./scripts/second-opinion/lib/install-snapshot.mjs', import.meta.url).href
      )
      snapshotPathFn = snapshotPath
      quarantineExistingSnapshot()
      throw new Error('runtime install failed — snapshot refresh skipped, runtime rolled back, pre-existing snapshot quarantined')
    }

    const { computeSourceHash } = await import(
      new URL('./scripts/second-opinion/lib/source-hash.mjs', import.meta.url).href
    )
    const { writeSnapshot, snapshotPath } = await import(
      new URL('./scripts/second-opinion/lib/install-snapshot.mjs', import.meta.url).href
    )
    const { validateProviderRegistry } = await import(
      new URL('./scripts/second-opinion/lib/registry-validator.mjs', import.meta.url).href
    )
    snapshotPathFn = snapshotPath  // expose to outer-catch quarantine helper

    // Hash against the GLOBAL installed copy (what runtime will see), NOT the
    // source repo. This ensures harness gate compares apples-to-apples.
    const globalSecondOpinion = path.join(SCRIPTS_DIR, 'second-opinion')
    if (!fs.existsSync(globalSecondOpinion)) {
      console.log(`Warning: ${globalSecondOpinion} not found; cannot write install snapshot.`)
      installFailed = true
    } else {
      const hashed = computeSourceHash(globalSecondOpinion)

      // Load providers/index.json + run each provider's available() to filter.
      const providersRegPath = path.join(globalSecondOpinion, 'providers', 'index.json')
      const providersReg = JSON.parse(fs.readFileSync(providersRegPath, 'utf8'))
      const installedProviders = []
      for (const provider of providersReg.providers) {
        const moduleFile = path.join(globalSecondOpinion, 'providers', `${provider.id}.mjs`)
        if (!fs.existsSync(moduleFile)) {
          console.log(`Skip provider ${provider.id}: module file not found at ${moduleFile}`)
          continue
        }
        try {
          const mod = await import(new URL(`file://${moduleFile}`).href)
          if (typeof mod.available !== 'function') {
            console.log(`Skip provider ${provider.id}: module missing available() export`)
            continue
          }
          const probe = mod.available()
          if (!probe.ok) {
            console.log(`Skip provider ${provider.id}: available() returned ${probe.reason}`)
            continue
          }
          installedProviders.push(provider)
          console.log(`Registered provider: ${provider.id}`)
        } catch (e) {
          console.log(`Skip provider ${provider.id}: import failed: ${e.message}`)
        }
      }

      // GATE 2: validate filtered installedProviders before writing snapshot.
      // Gate 1 already passed (source registry shape was valid), so a Gate 2
      // failure means the available() filter reduced providers to a malformed
      // set (typically empty when no provider CLI is on PATH — N1 fires).
      try {
        validateProviderRegistry({ schema_version: 1, providers: installedProviders })
      } catch (gateErr) {
        console.error(`Snapshot validation failed: ${gateErr.message}`)
        if (gateErr.field) console.error(`  field: ${gateErr.field}`)
        if (gateErr.provider) console.error(`  provider: ${gateErr.provider}`)
        throw gateErr  // unified outer-catch quarantines + sets installFailed
      }

      const snapshot = {
        schema_version: 1,
        source_hash: hashed.source_hash,
        source_repo: REPO_DIR,
        install_timestamp: new Date().toISOString(),
        providers: installedProviders,
        fragments: hashed.fragments,
        file_hashes: hashed.file_hashes,
      }
      const written = writeSnapshot(snapshot)
      console.log(`Wrote second-opinion install snapshot: ${written}`)
      console.log(`  source_hash: ${hashed.source_hash}`)
      console.log(`  providers:   ${installedProviders.map((p) => p.id).join(', ') || '(none)'}`)
      console.log(`  fragments:   ${hashed.fragments.length}`)
    }
  } catch (e) {
    if (!installFailed) {
      console.error(`Failed to install second-opinion snapshot: ${e.message}`)
      installFailed = true
    }
    // Unified quarantine: any snapshot-refresh failure path (Gate 2 throw,
    // writeSnapshot throw, dynamic-import failure mid-flight) ends here.
    quarantineExistingSnapshot()
  }

  if (installFailed) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// 7. Layer 1 update distribution: version manifests + consumer registry +
//    dist cache. Runs LAST so the manifests record what this run actually
//    left on disk (the artifact membership rule is byte-equality with the
//    repo source, so skipped-divergent user files are never recorded as ours).
//    Best-effort: a manifest failure must never fail an otherwise-good install.
// ---------------------------------------------------------------------------
try {
  // 7a. Global manifest (~/.episodic-memory/install-manifest.json).
  // REQ (--uninstall-enforcement, test-uninstall-enforcement t_no_global_touch):
  // an uninstall run never touches ~/.claude or ~/.episodic-memory — so ALL
  // global-side Layer 1 writes (global manifest, registry, dist cache) are
  // skipped for it; only the per-project manifest (7b) is refreshed (its
  // enforcement entries drop out via the merge because the files are gone).
  // The registry's enforcement_installed flag heals from disk truth on the
  // next regular install run (see 7c).
  const globalArtifacts = buildArtifactEntries(globalArtifactPairs(REPO_DIR, GLOBAL_DIR))
  const sourceVersion = resolveSourceVersion(REPO_DIR, globalArtifacts)
  if (!uninstallEnforcement) {
    writeJsonAtomic(globalManifestPath(GLOBAL_DIR), buildManifest({
      scope: 'global',
      tool,
      sourceVersion,
      sourceRepo: REPO_DIR,
      artifacts: globalArtifacts,
    }))
  }

  // 7b. Per-project manifest (<project>/.episodic-memory-install.json).
  // Fresh equality-gated enumeration merged with the previous manifest so a
  // skipped-divergent (user-modified) artifact keeps its original entry and
  // stays visible to the update sweep as "modified".
  const prevProjectManifest = readJsonSafe(projectManifestPath(projectAbs))
  const projectArtifacts = mergeArtifactEntries(
    prevProjectManifest,
    buildArtifactEntries(perProjectArtifactPairs(REPO_DIR, projectAbs)),
    projectAbs,
  )
  writeJsonAtomic(projectManifestPath(projectAbs), buildManifest({
    scope: 'project',
    tool,
    sourceVersion,
    sourceRepo: REPO_DIR,
    artifacts: projectArtifacts,
  }))

  // 7c. Consumer registry (~/.episodic-memory/installs.json): one entry per
  // (project_path, tool), deduped, degrade-not-throw on a malformed existing
  // registry. enforcement_installed flips true when THIS run installs
  // enforcement for the matching tool; otherwise the previous value is
  // preserved, cross-checked against disk truth (an uninstall run cannot
  // update the registry — global scope is off-limits to it — so the flag
  // heals here on the next regular install: engine gone ⇒ false).
  if (!uninstallEnforcement) {
    const projectKey = normalizeProjectPath(projectAbs)
    const { entries: existingEntries } = readRegistry(registryPath(GLOBAL_DIR))
    const nowIso = new Date().toISOString()
    const registryUpdates = tools.map((t) => {
      const prev = existingEntries.find((e) => {
        try { return normalizeProjectPath(e.project_path) === projectKey && e.tool === t } catch { return false }
      })
      // Enforcement rides the claude-code block for tool=claude-code/all; the
      // opencode/codex/pi-agent layers install under their exact tool name.
      const enforcementTool = (tool === 'opencode' || tool === 'codex' || tool === 'pi-agent')
        ? tool : 'claude-code'
      let enforcementInstalled = prev ? prev.enforcement_installed === true : false
      if (t === 'claude-code' && enforcementInstalled &&
          !fs.existsSync(path.join(projectAbs, '.claude', 'hooks', 'enforce-contract.mjs'))) {
        enforcementInstalled = false // healed: a prior --uninstall-enforcement removed the engine
      }
      if (t === enforcementTool && installEnforcement) enforcementInstalled = true
      return {
        project_path: projectKey,
        tool: t,
        version: sourceVersion,
        enforcement_installed: enforcementInstalled,
        last_install_ts: nowIso,
      }
    })
    upsertRegistryEntries(registryPath(GLOBAL_DIR), registryUpdates)
  }

  // 7d. Dist cache: mirror the current per-project payload SOURCES to
  // ~/.episodic-memory/dist/<version>/ (copy source only, zero registrations —
  // Principle 12 untouched) so the opt-in SessionStart auto-update can refresh
  // consumers without this repo checkout present. Prunes superseded versions.
  if (!uninstallEnforcement) {
    const dist = deployDistCache(REPO_DIR, GLOBAL_DIR, sourceVersion)
    console.log(`Recorded install version ${sourceVersion.slice(0, 12)} (manifests + registry); dist cache: ${dist.files} payload file(s) at ${dist.target}`)
  }
} catch (e) {
  console.log(`WARNING: could not record install version manifests: ${e.message} (install itself is complete; --update-consumers and the drift notice need a successful manifest write)`)
}

if (!installFailed) console.log('\nDone! Episodic memory is ready.')
console.log(`Global data:  ${GLOBAL_DIR}/`)
console.log(`Local data:   ${localDir}/`)
console.log(`Scripts:      ${SCRIPTS_DIR}/`)
