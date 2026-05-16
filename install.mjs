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
import { fileURLToPath } from 'url'

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
const installSecondOpinion = argv.includes('--install-second-opinion')
const bootstrapLastPrompt = argv.includes('--bootstrap-last-prompt')
const REPO_HOOKS = path.join(REPO_DIR, 'hooks')
const REPO_SECOND_OPINION = path.join(REPO_SCRIPTS, 'second-opinion')

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

if (!tool) {
  console.log(`Usage: node install.mjs --tool <claude-code|cursor|codex|windsurf|all> [--project <path>] [--install-hooks] [--install-hooks-force]

Tools:
  claude-code  Install SKILL.md + plugin structure
  cursor       Install .cursor/rules/episodic-memory.mdc
  codex        Install skill to .agents/skills/episodic-memory/
  windsurf     Install .windsurfrules (or append to existing)
  all          Install for all supported tools

Hook flags (claude-code / Phase 3b):
  --install-hooks         Copy hooks/*.sh into ~/.claude/hooks/ and register
                          checkpoint-gate + plan-gate (PreToolUse),
                          em-recall-sessionstart (SessionStart), and
                          em-session-end-prompt (SessionEnd) in
                          ~/.claude/settings.json. Skips divergent local
                          hook files AND withholds new settings registration
                          for them (re-run with --install-hooks-force to
                          accept). Atomic settings.json write (temp+rename).
  --install-hooks-force   Overwrite divergent hook files with repo versions
                          and proceed with registration.

Second-opinion harness:
  --install-second-opinion Write install snapshot at
                          ~/.claude/hooks/second-opinion-providers.json
                          with source_hash + per-fragment SHAs + flattened
                          providers (each provider's available() probed; CLI
                          not on PATH → skipped). Required for harness I-27a
                          gate (registry-stale-at-gate) + composer I-27b
                          (preamble-tamper-at-composer).

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

const VALID_TOOLS = ['claude-code', 'cursor', 'codex', 'windsurf', 'all']
if (!VALID_TOOLS.includes(tool)) {
  console.log(`Invalid tool "${tool}". Must be one of: ${VALID_TOOLS.join(', ')}`)
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
  scriptFiles = fs.readdirSync(REPO_SCRIPTS).filter(f => f.endsWith('.mjs'))
  for (const file of scriptFiles) {
    const src = path.join(REPO_SCRIPTS, file)
    const dst = path.join(SCRIPTS_DIR, file)
    fs.copyFileSync(src, dst)
    fs.chmodSync(dst, 0o755)
  }
  // scripts/lib/ — shared helpers (e.g. local-dir.mjs for #85). Imported by em-* scripts.
  const REPO_SCRIPTS_LIB = path.join(REPO_SCRIPTS, 'lib')
  if (fs.existsSync(REPO_SCRIPTS_LIB)) {
    const libDst = path.join(SCRIPTS_DIR, 'lib')
    fs.mkdirSync(libDst, { recursive: true })
    for (const file of fs.readdirSync(REPO_SCRIPTS_LIB).filter(f => f.endsWith('.mjs'))) {
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

// 1b. Copy patterns/_index.json for global pattern validation
const globalPatternsDir = path.join(GLOBAL_DIR, 'patterns')
const repoPatternsIndex = path.join(REPO_DIR, 'patterns', '_index.json')
if (fs.existsSync(repoPatternsIndex)) {
  fs.mkdirSync(globalPatternsDir, { recursive: true })
  fs.copyFileSync(repoPatternsIndex, path.join(globalPatternsDir, '_index.json'))
  console.log(`Installed patterns/_index.json to ${globalPatternsDir}`)
}

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

    // §559 partial-coverage TODO:
    //
    // RFC §559 (H-cfg row) v3.12 calls for install.mjs to wire BOTH H1
    // (bp1-approval-check.sh) AND H2 (bp1-sweep-on-session.sh) into the
    // SessionStart array. PR-1b-B (M0 part 2) ships H2 only. H1 depends on
    // bp1-marker-validate.mjs which lands in M2 (per RFC §552 / artifact-
    // table H1 row).
    //
    // Insertion semantics for M2: M2's install.mjs MUST find the existing H2
    // entry's index in SessionStart and splice H1 just-before it (relative
    // positioning). NOT unconditional SessionStart[0] — that reading would
    // reorder unrelated pre-existing SessionStart entries (e.g. em-recall-
    // sessionstart). The §559 ordering invariant ("approval-check FIRST,
    // sweep SECOND") is read as relative ordering between the two BP-1
    // hooks, not absolute index in the global SessionStart array.
    //
    // TODO(M2): wire H1 bp1-approval-check.sh per RFC §559 (H-cfg).
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
const tools = tool === 'all' ? ['claude-code', 'cursor', 'codex', 'windsurf'] : [tool]

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
      const skillDir = path.join(projectDir, '.agents', 'skills', 'episodic-memory')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_INSTRUCTIONS, 'SKILL.md'),
        path.join(skillDir, 'SKILL.md')
      )
      console.log(`Installed Codex skill to ${skillDir}/SKILL.md`)
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
    add(path.join('hooks', spec.file), path.join(userHooksDir, spec.file))
  }
  for (const file of libFiles) {
    add(path.join('hooks', 'lib', file), path.join(userHooksLibDir, file))
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

if (installHooks) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const userHooksDir = path.join(os.homedir(), '.claude', 'hooks')
  const userHooksLibDir = path.join(userHooksDir, 'lib')
  const REPO_HOOKS_LIB = path.join(REPO_HOOKS, 'lib')
  const touched = { hooks: [], settings: [], hookLib: [] }
  try {
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
    const libResults = {}
    let hookLibFiles = []
    let anyLibSkippedDivergent = false
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

    // 5a. Hook specs imported from scripts/lib/install-manifest.mjs (single
    // source of truth shared with tools/migration-cutover.mjs). Closes
    // Codex round-2 implementation attention point: avoid a second
    // hardcoded copy list.
    const { HOOK_SPECS } = await import(
      new URL('./scripts/lib/install-manifest.mjs', import.meta.url).href
    )
    const hookSpecs = HOOK_SPECS

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

    // SessionEnd em-session-end-prompt.mjs (Phase 1; canonical at SCRIPTS_DIR).
    const seCmd = `node ${shellQuote(path.join(SCRIPTS_DIR, 'em-session-end-prompt.mjs'))}`
    const seResult = addHookEntry(settings.hooks, 'SessionEnd', seCmd, { timeout: 10 })
    console.log(`SessionEnd em-session-end-prompt.mjs: ${seResult}`)
    if (seResult === 'added') touched.settings.push('SessionEnd → em-session-end-prompt.mjs')

    // P2 (code review): warn about stale canonical-named entries left behind
    // by migration so the user can prune them. Run AFTER all registrations.
    const canonicalByBasename = {
      'em-session-end-prompt.mjs': path.join(SCRIPTS_DIR, 'em-session-end-prompt.mjs'),
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
    const staleEntries = detectStaleCanonicalEntries(settings.hooks, canonicalByBasename)
    for (const { event, basename, command } of staleEntries) {
      console.log(`Warning: stale ${event} entry for ${basename} at ${command} — canonical also registered; remove the stale entry manually if it never resolves.`)
    }

    writeJSONAtomic(settingsPath, settings)
    if (touched.settings.length > 0) touched.hooks.push(settingsPath)

    const manifestPath = path.join(GLOBAL_DIR, 'hook-install.json')
    const manifest = buildHookFreshnessManifest(hookSpecs, hookLibFiles, userHooksDir, userHooksLibDir)
    if (writeJSONAtomicIfChanged(manifestPath, manifest)) {
      console.log(`Wrote hook freshness manifest: ${manifestPath}`)
      touched.hooks.push(manifestPath)
    }

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
  const userHooksDir = path.join(os.homedir(), '.claude', 'hooks')
  const userHooksLibDir = path.join(userHooksDir, 'lib')
  const userRunbooksDir = path.join(userHooksDir, 'runbooks')

  // ─── Codex r1 P1-3: pre-flight source existence + quickref derivation. ───
  // Validate ALL sources upfront so a missing/bad source doesn't leave a
  // partial install. Quickref derivation is the most failure-prone step
  // (section sentinel must be present + size-bounded); run it first so
  // we fail fast before any copy is attempted.
  const repoGateSrc       = path.join(REPO_HOOKS, 'second-opinion-gate.mjs')
  const repoValidatorSrc  = path.join(REPO_SECOND_OPINION, 'lib', 'registry-validator.mjs')
  const repoLocalDirSrc   = path.join(REPO_DIR, 'scripts', 'lib', 'local-dir.mjs')
  const repoRunbookSrc    = path.join(REPO_HOOKS, 'runbooks', 'second-opinion-harness.md')

  const userGateDst       = path.join(userHooksDir, 'second-opinion-gate.mjs')
  const userValidatorDst  = path.join(userHooksLibDir, 'registry-validator.mjs')
  const userLocalDirDst   = path.join(userHooksLibDir, 'local-dir.mjs')
  const userRunbookDst    = path.join(userRunbooksDir, 'second-opinion-harness.md')
  const userQuickrefDst   = path.join(userRunbooksDir, 'second-opinion-harness.quickref.md')

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
  for (const src of [repoGateSrc, repoValidatorSrc, repoLocalDirSrc, repoRunbookSrc]) {
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

if (!installFailed) console.log('\nDone! Episodic memory is ready.')
console.log(`Global data:  ${GLOBAL_DIR}/`)
console.log(`Local data:   ${localDir}/`)
console.log(`Scripts:      ${SCRIPTS_DIR}/`)
