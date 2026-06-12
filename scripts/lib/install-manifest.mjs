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

// SessionEnd hook is em-session-end-prompt.mjs invoked from the global
// scripts dir (canonical at $HOME/.episodic-memory/scripts/). The hook
// command string is built by install.mjs at registration time.
export const SESSION_END_SCRIPT = 'em-session-end-prompt.mjs'

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
      kind: 'hook'
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
        kind: 'hook-lib'
      })
    }
  }

  // Scripts — every .mjs under scripts/.
  const repoScripts = path.join(repoDir, 'scripts')
  if (fs.existsSync(repoScripts)) {
    for (const f of fs.readdirSync(repoScripts).filter(n => n.endsWith('.mjs'))) {
      const rel = `scripts/${f}`
      entries.push({
        relativePath: rel,
        repoPath: path.join(repoDir, rel),
        installedPath: path.join(HOME_SCRIPTS(homeDir), f),
        kind: 'script'
      })
    }
  }

  // Script lib — every .mjs under scripts/lib/.
  const repoScriptsLib = path.join(repoDir, 'scripts', 'lib')
  if (fs.existsSync(repoScriptsLib)) {
    for (const f of fs.readdirSync(repoScriptsLib).filter(n => n.endsWith('.mjs'))) {
      const rel = `scripts/lib/${f}`
      entries.push({
        relativePath: rel,
        repoPath: path.join(repoDir, rel),
        installedPath: path.join(HOME_SCRIPTS_LIB(homeDir), f),
        kind: 'script-lib'
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
