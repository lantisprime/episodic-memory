/**
 * activation-scoping-harness.mjs — mock-project E2E fixture lib for the
 * RFC-008 P4d enforcement-activation-scoping suite.
 *
 * Built S1; reused by S2–S8. Every helper runs the REAL install.mjs / REAL
 * deployed scripts / REAL hooks against an isolated HOME + mock git project —
 * NO mental tracing (feedback_mock_project_test_not_mental_trace).
 *
 * Empirically grounded against current code (2026-06-19):
 *   - `--project` is a NAMESPACE LABEL, not a path; local scope resolves to
 *     the process cwd's repo root. So local-scope round-trips MUST set
 *     cwd = mock project (not pass --project <path>).
 *   - macOS canonicalizes /tmp → /private/tmp; mkMock realpaths the base so
 *     path comparisons against script-reported paths hold.
 *   - A core install (no --install-hooks) writes NO global settings.json and
 *     wires ONLY BP-1 H1/H2 SessionStart (activation-gated) project-scoped —
 *     ZERO enforcement gates anywhere.
 *
 * Zero deps. Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  enforcementEntryScripts, relocatedOnlyLibs, isSubstrateScript,
} from '../../scripts/lib/install-manifest.mjs'

export const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname), '..', '..'
)

// The enforce-contract CONFIG files that relocate per-project (RFC-008 P4d / P12 —
// co-located with the engine under <project>/.claude/hooks/patterns/). NOTE:
// patterns/_index.json is SUBSTRATE (the behavioral-pattern registry) and stays
// global by design — it is deliberately NOT in this list.
export const CONTRACT_CONFIG_FILES = [
  'bp-001.json', 'events.json', 'enforce-config.schema.json', 'taxonomy.json',
]

// Enforcement RUNTIME found in GLOBAL scope under `home`: the engine + classifier
// + markers + bp1 entry scripts (manifest enforcementEntryScripts), the
// relocated-only libs, the contract config, and the contract plugins index — none
// may live in ~/.episodic-memory/. Manifest-derived so a newly added enforcement
// script is covered automatically (no hand-list to drift). Returns sorted
// rel-paths; [] == P12-clean. Complements enforcementFilesInGlobalScope (hooks)
// and hookCodeFilesInGlobalScope (~/.claude/hooks/).
export function enforcementRuntimeInGlobalScope(home) {
  const out = []
  const gScripts = path.join(home, '.episodic-memory', 'scripts')
  for (const f of enforcementEntryScripts(REPO_ROOT)) {
    if (fs.existsSync(path.join(gScripts, f))) out.push(`.episodic-memory/scripts/${f}`)
  }
  const gLib = path.join(gScripts, 'lib')
  for (const f of relocatedOnlyLibs(REPO_ROOT)) {
    if (fs.existsSync(path.join(gLib, f))) out.push(`.episodic-memory/scripts/lib/${f}`)
  }
  const gPatterns = path.join(home, '.episodic-memory', 'patterns')
  for (const f of CONTRACT_CONFIG_FILES) {
    if (fs.existsSync(path.join(gPatterns, f))) out.push(`.episodic-memory/patterns/${f}`)
  }
  if (fs.existsSync(path.join(home, '.episodic-memory', 'plugins', '_index.json'))) {
    out.push('.episodic-memory/plugins/_index.json')
  }
  return out.sort()
}

// COMPREHENSIVE global-substrate check (P12 / user directive 2026-06-19): the
// global ~/.episodic-memory/scripts dir must hold SUBSTRATE ONLY (em-* + the
// second-opinion harness). List any *.mjs there that is NOT substrate — this
// catches BOTH enforcement-runtime leaks AND repo-dev/CI-validator leaks
// (validate-*, scaffold-bp, …), the class that slipped past the enforcement-set-
// only enforcementRuntimeInGlobalScope check. Returns sorted rel-paths; [] ==
// substrate-clean. The second-opinion/ harness SUBTREE (recursively copied) is
// legitimate substrate and is excluded by only scanning the top-level .mjs files.
export function nonSubstrateScriptsInGlobalScope(home) {
  const gScripts = path.join(home, '.episodic-memory', 'scripts')
  let entries
  try { entries = fs.readdirSync(gScripts) } catch { return [] }
  return entries
    .filter((f) => f.endsWith('.mjs') && !isSubstrateScript(f))
    .map((f) => `.episodic-memory/scripts/${f}`)
    .sort()
}

// Command-string fragments that identify an RFC-008 ENFORCEMENT hook.
//
// Rule (one unambiguous definition, S1 review F1): a marker names EVERY hook
// that `--install-hooks` / `--install-second-opinion` registers — i.e. the
// install-manifest `HOOK_SPECS` bundle (all of which are enforcement; no
// substrate hook lives in HOOK_SPECS) + the SessionEnd script + the
// second-opinion gate (registered by --install-second-opinion, outside
// HOOK_SPECS). The BP-1 SessionStart hooks (bp1-approval-check /
// bp1-sweep-on-session) are wired by a SEPARATE install path, are SUBSTRATE
// hygiene (activation-gated, RFC-004), and are deliberately absent here — their
// project-scoped presence is expected and correct.
//
// test-activation-scoping-e2e.mjs (A4) asserts this set covers every HOOK_SPECS
// file + SESSION_END_SCRIPT, so it cannot silently drift behind install (Rule 14).
export const ENFORCEMENT_HOOK_MARKERS = [
  'plan-gate',
  'checkpoint-gate',
  'preflight-gate',
  'stop-gate',
  'em-recall-sessionstart',
  'preflight-prompt-helper',
  'session-handoff-prompt',
  'em-session-end-prompt',
  'second-opinion-gate',
]

// Enforcement hook FILE basenames that must live ONLY under <project>/.claude/
// (P12) — never in global ~/.claude/hooks/ or, for the SessionEnd hook script,
// ~/.episodic-memory/scripts/. 7 gate/recall/.sh hooks + the SessionEnd hook
// script. Distinct from ENFORCEMENT_HOOK_MARKERS (command-string fragments for
// settings-registration detection): this is about FILES on disk.
export const ENFORCEMENT_HOOK_FILES = [
  'checkpoint-gate.sh',
  'plan-gate.sh',
  'preflight-gate.sh',
  'stop-gate.sh',
  'preflight-prompt-helper.sh',
  'em-recall-sessionstart.sh',
  'session-handoff-prompt.sh',
  'em-session-end-prompt.mjs',
]

// Return enforcement artifacts found in GLOBAL scope under `home` — any
// enforcement hook FILE in ~/.claude/hooks/ plus the SessionEnd hook script if
// present at ~/.episodic-memory/scripts/. Empty array == P12-clean (no hook
// file in global). This is the on-disk half of the PRINCIPLES.md §12 "Test
// this" clause; hasEnforcementHook(globalSettings) is the registration half.
export function enforcementFilesInGlobalScope(home) {
  const found = []
  const globalHooks = path.join(home, '.claude', 'hooks')
  for (const f of ENFORCEMENT_HOOK_FILES) {
    if (f.endsWith('.mjs')) continue // SessionEnd hook script handled below
    if (fs.existsSync(path.join(globalHooks, f))) found.push(`.claude/hooks/${f}`)
  }
  const sessionEndGlobal = path.join(home, '.episodic-memory', 'scripts', 'em-session-end-prompt.mjs')
  if (fs.existsSync(sessionEndGlobal)) found.push('.episodic-memory/scripts/em-session-end-prompt.mjs')
  return found
}

// Recursively list EVERY hook CODE file (.sh / .mjs) under global
// ~/.claude/hooks/. P12: none may exist there — ALL hook code is per-project.
// This is the COMPREHENSIVE check (any hook file, not just a hand-maintained
// enforcement list), closing the blind spot where second-opinion-gate.mjs
// slipped past the enforcement-set-only assertion. Returns sorted rel paths.
export function hookCodeFilesInGlobalScope(home) {
  const root = path.join(home, '.claude', 'hooks')
  const out = []
  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(abs, r)
      else if (e.name.endsWith('.sh') || e.name.endsWith('.mjs')) out.push(`.claude/hooks/${r}`)
    }
  }
  walk(root, '')
  return out.sort()
}

// Env vars that, if inherited from the test runner's real environment, would
// defeat HOME isolation: CLAUDE_CONFIG_DIR repoints the settings dir, and the
// SO_* paths are read by second-opinion-gate.mjs (it would resolve the REAL
// snapshot/runbook instead of the mock). One source so the three runners can't
// drift (S1 review F2). Mutates `env` in place and returns it.
function scrubEnv(env) {
  delete env.CLAUDE_CONFIG_DIR
  delete env.SO_INSTALL_SNAPSHOT_PATH
  delete env.SO_RUNBOOK_PATH
  delete env.SO_QUICKREF_PATH
  // Hermeticity: with a key present, the checkpoint-gate's E2 hold-consult
  // (classifier-hold-consult.mjs → llm-classify.mjs, config default
  // enabled:true) makes a REAL billed API call from inside the test suite and
  // a confident verdict flips an expected HOLD to ALLOW (flaky cells, stray
  // verdict markers). test-checkpoint-gate.sh scrubs this at run_hook; the
  // shared harness must match.
  delete env.ANTHROPIC_API_KEY
  return env
}

const _tmpDirs = []
process.on('exit', () => {
  for (const d of _tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})
// 'exit' doesn't fire on a forced signal (local SIGINT, CI timeout SIGTERM);
// re-exit through process.exit so the cleanup above runs (S1 PR-review F3).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

/**
 * Create an isolated fixture: a fresh HOME, a mock git project, and a separate
 * caller cwd (so caller-cwd != --project leakage is detectable). Returns
 * absolute, realpath-canonicalized paths.
 */
export function mkMock(label = 'mock') {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `p4d-${label}-`))
  )
  _tmpDirs.push(base)
  const home = path.join(base, 'home')
  const project = path.join(base, 'project')
  const callerCwd = path.join(base, 'caller')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(project, '.git'), { recursive: true }) // mark git root
  fs.mkdirSync(callerCwd, { recursive: true })
  return { base, home, project, callerCwd }
}

/**
 * Run the real install.mjs with HOME overridden to the mock home. `flags`
 * defaults to [] (core install — no enforcement hooks). Caller cwd defaults to
 * the mock's caller dir (kept distinct from --project).
 */
export function runInstall({ home, project, callerCwd, flags = [], tool = 'claude-code', extraEnv = {} }) {
  const env = scrubEnv({ ...process.env, HOME: home, ...extraEnv })
  return spawnSync('node', [
    path.join(REPO_ROOT, 'install.mjs'),
    '--tool', tool,
    '--project', project,
    ...flags,
  ], {
    cwd: callerCwd || project,
    env,
    encoding: 'utf8',
    timeout: 120000,
  })
}

/** Absolute path of a deployed substrate script under the mock home. */
export function deployedScript(home, name) {
  return path.join(home, '.episodic-memory', 'scripts', name)
}

/**
 * Run a deployed em-* script (by filename) under isolated HOME. For
 * local-scope ops, pass cwd = mock project. Returns { status, stdout, stderr,
 * json } — json is the parsed last JSON line, or null if unparseable.
 */
export function runScript(home, name, args = [], { cwd, extraEnv = {} } = {}) {
  const env = scrubEnv({ ...process.env, HOME: home, ...extraEnv })
  const r = spawnSync('node', [deployedScript(home, name), ...args], {
    cwd: cwd || home,
    env,
    encoding: 'utf8',
    timeout: 60000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parseLastJson(r.stdout) }
}

/**
 * Run a hook script (absolute path) with a JSON event on stdin. `event` may be
 * an object (JSON.stringify'd) or a raw string. Returns { status, stdout,
 * stderr }.
 */
export function runHook(hookPath, event, { home, project, extraEnv = {} } = {}) {
  const env = scrubEnv({ ...process.env, ...extraEnv })
  if (home) env.HOME = home
  if (project) env.CLAUDE_PROJECT_DIR = project
  const input = typeof event === 'string' ? event : JSON.stringify(event)
  const r = spawnSync('bash', [hookPath], {
    cwd: project || home || process.cwd(),
    env,
    input,
    encoding: 'utf8',
    timeout: 60000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * Read settings.json for a scope. scope='global' → <home>/.claude/settings.json;
 * scope='project' → <project>/.claude/settings.json. Returns the parsed object,
 * or null if the file is absent.
 */
export function readSettings(scope, { home, project }) {
  const p = scope === 'global'
    ? path.join(home, '.claude', 'settings.json')
    : path.join(project, '.claude', 'settings.json')
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/**
 * Flatten every hook command string across all events in a settings object.
 * Returns string[] (empty if settings is null or has no hooks).
 */
export function flattenHookCommands(settings) {
  const out = []
  if (!settings || !settings.hooks) return out
  for (const event of Object.keys(settings.hooks)) {
    const matchers = settings.hooks[event]
    if (!Array.isArray(matchers)) continue
    for (const m of matchers) {
      const hooks = m && Array.isArray(m.hooks) ? m.hooks : []
      for (const h of hooks) {
        if (h && typeof h.command === 'string') out.push(h.command)
      }
    }
  }
  return out
}

/** True if any enforcement-gate marker appears in the settings' hook commands. */
export function hasEnforcementHook(settings) {
  const cmds = flattenHookCommands(settings)
  return cmds.some((c) => ENFORCEMENT_HOOK_MARKERS.some((m) => c.includes(m)))
}

/** List enforcement-gate command strings found in a settings object. */
export function enforcementHookCommands(settings) {
  return flattenHookCommands(settings).filter(
    (c) => ENFORCEMENT_HOOK_MARKERS.some((m) => c.includes(m))
  )
}

function parseLastJson(stdout) {
  if (!stdout) return null
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try { return JSON.parse(line) } catch { /* keep scanning up */ }
  }
  return null
}
