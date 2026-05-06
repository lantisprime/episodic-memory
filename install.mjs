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
const REPO_HOOKS = path.join(REPO_DIR, 'hooks')

// P2 (code review): warn if --install-hooks-force passed without --install-hooks.
// Without the base flag, the entire hook-install block is skipped; a force flag
// alone silently no-ops and a user might think their settings were updated.
if (installHooksForce && !installHooks) {
  console.log('Warning: --install-hooks-force has no effect without --install-hooks; ignoring.')
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
                          and proceed with registration.`)
  process.exit(1)
}

const VALID_TOOLS = ['claude-code', 'cursor', 'codex', 'windsurf', 'all']
if (!VALID_TOOLS.includes(tool)) {
  console.log(`Invalid tool "${tool}". Must be one of: ${VALID_TOOLS.join(', ')}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. Install scripts globally
// ---------------------------------------------------------------------------
fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
fs.mkdirSync(path.join(GLOBAL_DIR, 'episodes'), { recursive: true })

const scriptFiles = fs.readdirSync(REPO_SCRIPTS).filter(f => f.endsWith('.mjs'))
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
if (fs.existsSync(gitignorePath)) {
  const content = fs.readFileSync(gitignorePath, 'utf8')
  if (!gitignoreHasPattern(content, '.episodic-memory/') &&
      !gitignoreHasPattern(content, '.episodic-memory')) {
    fs.appendFileSync(gitignorePath, '\n# Episodic memory data\n.episodic-memory/\n')
    console.log('Added .episodic-memory/ to .gitignore')
  }
  // RFC-004 §656 — per-run HMAC key file is project-local but must never be
  // committed. Pattern is stable across the BP-1 lifecycle.
  const runKeyPattern = '**/.episodic-memory/runs/*/run.key'
  const refreshed = fs.readFileSync(gitignorePath, 'utf8')
  if (!gitignoreHasPattern(refreshed, runKeyPattern)) {
    fs.appendFileSync(gitignorePath, `\n# BP-1 per-run HMAC key (RFC-004)\n${runKeyPattern}\n`)
    console.log(`Added ${runKeyPattern} to .gitignore`)
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
      // Install as a Codex skill in .agents/skills/
      const skillDir = path.join(projectDir, '.agents', 'skills', 'episodic-memory')
      fs.mkdirSync(skillDir, { recursive: true })
      fs.copyFileSync(
        path.join(REPO_INSTRUCTIONS, 'codex-skill.md'),
        path.join(skillDir, 'episodic-memory.md')
      )
      console.log(`Installed Codex skill to ${skillDir}/episodic-memory.md`)
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

function writeJSONAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
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
    let anyLibSkippedDivergent = false
    if (fs.existsSync(REPO_HOOKS_LIB)) {
      fs.mkdirSync(userHooksLibDir, { recursive: true })
      const libFiles = fs.readdirSync(REPO_HOOKS_LIB).filter(f => f.endsWith('.sh'))
      for (const file of libFiles) {
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

    // 5a. Hook specs (file → event + matcher + timeout + canonical command).
    const hookSpecs = [
      {
        file: 'checkpoint-gate.sh',
        event: 'PreToolUse',
        matcher: 'Edit|Write|MultiEdit|Bash|NotebookEdit',
        timeout: 5
      },
      // plan-gate.sh: no matcher — must run on every PreToolUse so the
      // tool-name allowlist (read-only tools) is the sole filter for what
      // bypasses the marker. Issue #86 (PR-A): canonicalized into the repo
      // and registered by the installer; Bash command-level allowlisting
      // is deferred to PR-B.
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
      // claude-code-hooks-reference.md:409 — without explicit SubagentStop
      // registration, subagent shape-4 (docs-only-summarize-as-done from
      // inside a Skill / Plan / Explore agent) is uncovered. Issue #128.
      // Phase 3b primitive; future RFC-003 Phase 2 subsumes into
      // adapters/claude-code/capabilities/enforcement.mjs.
      {
        file: 'stop-gate.sh',
        event: 'Stop',
        timeout: 5
      },
      {
        file: 'stop-gate.sh',
        event: 'SubagentStop',
        timeout: 5
      }
    ]

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
      'stop-gate.sh': path.join(userHooksDir, 'stop-gate.sh')
    }
    const staleEntries = detectStaleCanonicalEntries(settings.hooks, canonicalByBasename)
    for (const { event, basename, command } of staleEntries) {
      console.log(`Warning: stale ${event} entry for ${basename} at ${command} — canonical also registered; remove the stale entry manually if it never resolves.`)
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
  } catch (e) {
    console.log(`Note: could not install hooks: ${e.message}`)
  }
}

console.log('\nDone! Episodic memory is ready.')
console.log(`Global data:  ${GLOBAL_DIR}/`)
console.log(`Local data:   ${localDir}/`)
console.log(`Scripts:      ${SCRIPTS_DIR}/`)
