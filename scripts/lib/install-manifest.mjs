/**
 * install-manifest.mjs — Single source of truth for what install.mjs deploys.
 *
 * Used by both install.mjs (to know what to copy) and tools/migration-cutover.mjs
 * (to verify installed copies are byte-identical to repo sources). Closes Codex
 * round-2 implementation attention point: "install.mjs should expose actual
 * scriptSpecs manifest reused by tools/migration-cutover.mjs — avoid second
 * hardcoded copy list."
 *
 * Manifest entry shape:
 *   {
 *     relativePath: 'plugins/claude-code/hooks/checkpoint-gate.sh',  // path under repo root
 *     repoPath: '<repoDir>/plugins/claude-code/hooks/checkpoint-gate.sh',
 *     installedPath: '<homeDir>/.claude/hooks/checkpoint-gate.sh',
 *     kind: 'hook' | 'hook-lib' | 'script' | 'script-lib' | 'pattern' | 'config',
 *     // hook-only:
 *     event?: 'PreToolUse' | 'SessionStart' | 'SessionEnd' | 'Stop' | 'SubagentStop',
 *     matcher?: string,
 *     timeout?: number
 *   }
 *
 * Hook specs (event + matcher + timeout) live here so install.mjs's
 * registration logic and the cutover smoke test agree on what hooks should
 * be wired and where their files land.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

export const HOOK_SPECS = [
  {
    file: 'checkpoint-gate.sh',
    event: 'PreToolUse',
    matcher: 'Edit|Write|MultiEdit|Bash|NotebookEdit',
    timeout: 5
  },
  // plan-gate.sh: no matcher — must run on every PreToolUse so the
  // tool-name allowlist (read-only tools) is the sole filter for what
  // bypasses the marker. Issue #86 (PR-A): canonicalized into the repo
  // and registered by the installer.
  {
    file: 'plan-gate.sh',
    event: 'PreToolUse',
    timeout: 5
  },
  {
    file: 'em-recall-sessionstart.sh',
    event: 'SessionStart',
    timeout: 10
  },
  // stop-gate.sh: registered on both Stop AND SubagentStop. SubagentStop
  // is the conversion of Stop for subagent contexts per
  // claude-code-hooks-reference.md:409. Issue #128.
  {
    file: 'stop-gate.sh',
    event: 'Stop',
    timeout: 5
  },
  {
    file: 'stop-gate.sh',
    event: 'SubagentStop',
    timeout: 5
  },
  // preflight-gate.sh: Layer D narrow PR1 (codex consensus chain
  // ...ed24 → ...dbf6, 2026-05-12). PreToolUse on Bash/Agent/Write/Edit/
  // MultiEdit/NotebookEdit. Read-only tools exempt at gate level.
  {
    file: 'preflight-gate.sh',
    event: 'PreToolUse',
    matcher: 'Bash|Agent|Task|Write|Edit|MultiEdit|NotebookEdit',
    timeout: 10
  },
  // preflight-prompt-helper.sh: UserPromptSubmit hook for true prompt-
  // binding (#238 PR1 FU-C2). Writes .checkpoints/.last-user-prompt.<sid>.json
  // with the canonical sha of the real user prompt; preflight-gate.sh
  // cross-checks marker.prompt_sha256 against the file. UserPromptSubmit
  // accepts no matcher per claude-code-hooks-reference.md:85 (always fires).
  // Timeout 5s — hook is small and atomic; if it can't complete in 5s
  // something is wrong and fail-safe (exit 0) is the right outcome.
  {
    file: 'preflight-prompt-helper.sh',
    event: 'UserPromptSubmit',
    timeout: 5
  },
  // session-handoff-prompt.sh: SessionStart two-phase handoff/discipline
  // directive (rank-10 slice). Was installed + registered manually but never
  // tracked here, so the installed copy drifted ahead of the repo source
  // unreported (checkpoint-hygiene F3, diagnosis 20260611-234742). Timeout 5
  // matches the pre-existing manual registration in settings.json.
  {
    file: 'session-handoff-prompt.sh',
    event: 'SessionStart',
    timeout: 5
  }
]

// SessionEnd hook is em-session-end-prompt.mjs. Per RFC-008 P4d + Principle 12
// it is an ENFORCEMENT hook script (it runs ONLY as the SessionEnd hook), so it
// installs PER-PROJECT under <project>/.claude/hooks/ and is EXCLUDED from the
// global scripts-scan — it is NOT a global substrate script.
export const SESSION_END_SCRIPT = 'em-session-end-prompt.mjs'

// Enforcement hook SCRIPTS (.mjs that exist only to be run by a hook) — these
// must NEVER deploy to the global scripts dir (Principle 12); they install
// per-project. install.mjs's global scripts-scan filters these out.
export const ENFORCEMENT_HOOK_SCRIPTS = [SESSION_END_SCRIPT]

// DERIVED (Rule 14) from HOOK_SPECS + SESSION_END_SCRIPT — single source of
// truth so the harness drift guard (A4) and install can't diverge.
//
// enforcementHookFileBasenames(): the 8 enforcement hook FILES that install
// per-project — the unique HOOK_SPECS .sh gates (stop-gate.sh once) plus the
// SessionEnd hook script. Drives project-side copy AND global prune.
export function enforcementHookFileBasenames() {
  return [...new Set(HOOK_SPECS.map((s) => s.file)), ...ENFORCEMENT_HOOK_SCRIPTS]
}

// enforcementRegistrations(): the 9 enforcement registrations (8 HOOK_SPECS
// event-entries — stop-gate twice — plus the SessionEnd entry). Drives
// project-side registration, global de-registration, and the A4 drift guard.
export function enforcementRegistrations() {
  return [
    ...HOOK_SPECS.map((s) => ({ file: s.file, event: s.event, matcher: s.matcher, timeout: s.timeout })),
    { file: SESSION_END_SCRIPT, event: 'SessionEnd', timeout: 10 },
  ]
}

// ───────────────────────────────────────────────────────────────────────────
// RFC-008 P4d / Principle 12 — enforcement SCRIPTS + their lib closure relocate
// per-project; global holds ONLY substrate + dev/CI tooling.
//
// An "enforcement ENTRY script" is a .mjs under scripts/ that exists ONLY to be
// run by a hook: the enforcement ENGINE (enforce-contract), the classifier suite,
// the marker writers, and the bp1 orchestration. By the P12 FUNCTION test these
// are enforcement artifacts however packaged → they install under
// <project>/.claude/hooks/ and NEVER deploy to the global substrate scripts dir.
//
// The set is DERIVED (explicit list + the bp1-* family by prefix) so a newly
// added enforcement script is classified automatically and can't silently leak to
// global. The transitive relative-import closure (computeLibClosure) decides which
// scripts/lib/*.mjs travel with them — no hand-maintained lib list to drift.
// ───────────────────────────────────────────────────────────────────────────
const ENFORCEMENT_ENTRY_EXPLICIT = new Set([
  'enforce-contract.mjs',
  'agent-classifier-dispatch.mjs', 'classifier-config-loader.mjs', 'classifier-marker.mjs',
  'classifier-override-lookup.mjs', 'classifier-override-persist.mjs', 'classify-correction.mjs',
  'llm-classify.mjs',
  'checkpoint-marker.mjs', 'plan-marker.mjs', 'preflight-marker-write.mjs',
])

export function isEnforcementEntryScript(basename) {
  return ENFORCEMENT_ENTRY_EXPLICIT.has(basename) || /^bp1-.+\.mjs$/.test(basename)
}

function listRepoScripts(repoDir) {
  const d = path.join(repoDir, 'scripts')
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.mjs')) : []
}

// Transitive relative-import closure (restricted to scripts/lib/*.mjs) of a set of
// entry scripts. Static parse of `... from '<spec>'` + dynamic `import('<spec>')`,
// relative specifiers only. Returns a Set of lib basenames.
function computeLibClosure(repoDir, entryBasenames) {
  const scriptsDir = path.join(repoDir, 'scripts')
  const libDir = path.join(scriptsDir, 'lib')
  const libs = new Set()
  const seen = new Set()
  const walk = (abs) => {
    if (seen.has(abs)) return
    seen.add(abs)
    let src
    try { src = fs.readFileSync(abs, 'utf8') } catch { return }
    // Fresh matcher per call — a single /g regex shares lastIndex across the
    // recursive walk and would skip imports of nested modules.
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      if (!spec.startsWith('.')) continue
      let resolved = path.resolve(path.dirname(abs), spec)
      if (!resolved.endsWith('.mjs') && !fs.existsSync(resolved)) resolved += '.mjs'
      if (path.dirname(resolved) === libDir) libs.add(path.basename(resolved))
      walk(resolved)
    }
  }
  for (const e of entryBasenames) {
    const abs = path.join(scriptsDir, e)
    if (fs.existsSync(abs)) walk(abs)
  }
  return libs
}

// Enforcement entry scripts present in the repo (engine + classifier + markers + bp1).
export function enforcementEntryScripts(repoDir) {
  return listRepoScripts(repoDir).filter(isEnforcementEntryScript)
}

// Scripts that STAY global: substrate (em-*) + dev/CI tooling (validate-*, second-
// opinion, scaffold-bp, …). Excludes enforcement entries AND the per-project
// SessionEnd hook script.
export function globalEntryScripts(repoDir) {
  return listRepoScripts(repoDir).filter(
    (f) => !isEnforcementEntryScript(f) && !ENFORCEMENT_HOOK_SCRIPTS.includes(f)
  )
}

// Lib closure that STAYS global — every scripts/lib/*.mjs imported (transitively)
// by a retained-global script. These are NOT removed from global even if an
// enforcement script also imports them (e.g. local-dir.mjs, json-instance-validate).
export function globalScriptLibs(repoDir) {
  return computeLibClosure(repoDir, globalEntryScripts(repoDir))
}

// Lib closure that travels INTO the per-project enforcement bundle — every
// scripts/lib/*.mjs the enforcement entries (incl. the SessionEnd hook script)
// import. Includes shared substrate libs (local-dir.mjs, …) so the relocated
// scripts resolve all imports co-located, never reaching into global.
export function enforcementBundleLibs(repoDir) {
  return computeLibClosure(repoDir, [...enforcementEntryScripts(repoDir), SESSION_END_SCRIPT])
}

// Libs that move OUT of global (enforcement-only): in the enforcement bundle and
// NOT in any retained-global script's closure. Drives the global lib filter + the
// D4 prune sweep + the P12 global-clean guardrail.
export function relocatedOnlyLibs(repoDir) {
  const keep = globalScriptLibs(repoDir)
  return [...enforcementBundleLibs(repoDir)].filter((l) => !keep.has(l)).sort()
}

// BP-1 (RFC-004 auto-pilot) is a BEHAVIOR PATTERN, deployed PER-PROJECT alongside
// its SessionStart hooks on CORE install (not gated on --install-enforcement). Its
// scripts (bp1-*.mjs) + their lib closure co-locate with the bp1 hooks under
// <project>/.claude/hooks/. They are still enforcement-by-function for the GLOBAL
// exclusion (isEnforcementEntryScript matches bp1-* so they never land in global) —
// these helpers only drive the per-project co-deploy with the bp1 hooks.
export function bp1EntryScripts(repoDir) {
  return listRepoScripts(repoDir).filter((f) => /^bp1-.+\.mjs$/.test(f))
}
export function bp1ClosureLibs(repoDir) {
  return [...computeLibClosure(repoDir, bp1EntryScripts(repoDir))]
}

const HOME_HOOKS = (homeDir) => path.join(homeDir, '.claude', 'hooks')
const HOME_HOOKS_LIB = (homeDir) => path.join(homeDir, '.claude', 'hooks', 'lib')
const HOME_SCRIPTS = (homeDir) => path.join(homeDir, '.episodic-memory', 'scripts')
const HOME_SCRIPTS_LIB = (homeDir) => path.join(homeDir, '.episodic-memory', 'scripts', 'lib')

/**
 * Build the full install manifest for a given repo + home dir. Filesystem
 * I/O scoped to the source repo only (the installed-side paths are
 * predicted, not stat'd here — callers do that).
 *
 * Returns an array of manifest entries in deterministic order (sorted by
 * relativePath) for stable diffs and reproducible cutover output.
 */
export function buildInstallManifest(repoDir, homeDir = os.homedir()) {
  const entries = []

  // Hooks — driven by HOOK_SPECS (subset of hooks/*.sh that we wire).
  // Deduped on file basename so stop-gate.sh (registered twice for
  // Stop + SubagentStop) appears once in the file manifest.
  //
  // Codex round-1 F3 (path: scripts/lib/install-manifest.mjs:95-98):
  // entries are emitted UNCONDITIONALLY for HOOK_SPECS so a wrong/empty
  // --repo can't return an empty manifest that vacuously passes the
  // cutover check. compareFiles in migration-cutover.mjs reports
  // SOURCE_GONE when repoPath is missing, which the gate counts as
  // failure.
  const hookFiles = new Set()
  for (const spec of HOOK_SPECS) {
    if (hookFiles.has(spec.file)) continue
    hookFiles.add(spec.file)
    const rel = `plugins/claude-code/hooks/${spec.file}`
    entries.push({
      relativePath: rel,
      repoPath: path.join(repoDir, rel),
      installedPath: path.join(HOME_HOOKS(homeDir), spec.file),
      kind: 'hook',
      // RFC-008 P4d / Principle 12: enforcement hooks install per-project, not
      // global. migration-cutover excludes scope:'project' (the installedPath
      // above is the legacy global location, no longer written).
      scope: 'project'
    })
  }

  // Hook lib — every .sh under hooks/lib/.
  const repoHooksLib = path.join(repoDir, 'plugins', 'claude-code', 'hooks', 'lib')
  if (fs.existsSync(repoHooksLib)) {
    for (const f of fs.readdirSync(repoHooksLib).filter(n => n.endsWith('.sh'))) {
      const rel = `plugins/claude-code/hooks/lib/${f}`
      entries.push({
        relativePath: rel,
        repoPath: path.join(repoDir, rel),
        installedPath: path.join(HOME_HOOKS_LIB(homeDir), f),
        kind: 'hook-lib',
        // P12: hook libs install per-project alongside their hooks.
        scope: 'project'
      })
    }
  }

  // Scripts — every .mjs under scripts/ EXCEPT enforcement hook scripts
  // (em-session-end-prompt.mjs), which install per-project (Principle 12) and
  // must not appear as global substrate. The enforcement ENTRY scripts (engine +
  // classifier + markers + bp1) are emitted scope:'project' — they relocated to
  // <project>/.claude/hooks/, so migration-cutover (which verifies the GLOBAL
  // installed copies) excludes them; the installedPath below is the legacy global
  // location, no longer written.
  const repoScripts = path.join(repoDir, 'scripts')
  if (fs.existsSync(repoScripts)) {
    for (const f of fs.readdirSync(repoScripts).filter(n => n.endsWith('.mjs') && !ENFORCEMENT_HOOK_SCRIPTS.includes(n))) {
      const rel = `scripts/${f}`
      entries.push({
        relativePath: rel,
        repoPath: path.join(repoDir, rel),
        installedPath: path.join(HOME_SCRIPTS(homeDir), f),
        kind: 'script',
        ...(isEnforcementEntryScript(f) ? { scope: 'project' } : {}),
      })
    }
  }

  // Script lib — every .mjs under scripts/lib/. Enforcement-only libs
  // (relocatedOnlyLibs) travel per-project with their scripts → scope:'project'.
  // Libs shared with a retained-global script stay global (no scope).
  const repoScriptsLib = path.join(repoDir, 'scripts', 'lib')
  if (fs.existsSync(repoScriptsLib)) {
    const relocated = new Set(relocatedOnlyLibs(repoDir))
    for (const f of fs.readdirSync(repoScriptsLib).filter(n => n.endsWith('.mjs'))) {
      const rel = `scripts/lib/${f}`
      entries.push({
        relativePath: rel,
        repoPath: path.join(repoDir, rel),
        installedPath: path.join(HOME_SCRIPTS_LIB(homeDir), f),
        kind: 'script-lib',
        ...(relocated.has(f) ? { scope: 'project' } : {}),
      })
    }
  }

  // Patterns index — copied into the global patterns dir.
  const repoPatternsIndex = path.join(repoDir, 'patterns', '_index.json')
  if (fs.existsSync(repoPatternsIndex)) {
    entries.push({
      relativePath: 'patterns/_index.json',
      repoPath: repoPatternsIndex,
      installedPath: path.join(homeDir, '.episodic-memory', 'patterns', '_index.json'),
      kind: 'pattern'
    })
  }

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/**
 * Compute the SessionEnd hook command string. install.mjs uses this at
 * registration time; cutover may use it to verify the registered command
 * still references the canonical install path.
 */
export function sessionEndHookCommand(homeDir = os.homedir()) {
  return `node ${path.join(HOME_SCRIPTS(homeDir), SESSION_END_SCRIPT)}`
}
