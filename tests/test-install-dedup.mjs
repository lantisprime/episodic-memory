#!/usr/bin/env node
/**
 * test-install-dedup.mjs — regression for the double-registration fix
 * (RFC-008 P4d). A prior installer version registered hooks by PROJECT-RELATIVE
 * path; the current version registers the canonical ABSOLUTE path. Because
 * addHookEntry keys idempotence on the exact command STRING, re-installing left
 * BOTH spellings and every hook fired twice.
 *
 * This test drives the REAL install.mjs against an isolated HOME + mock project
 * (feedback_mock_project_test_not_mental_trace) and asserts:
 *   1. a superseded project-relative spelling of a canonical hook is AUTO-REMOVED
 *      on re-install (resolves to the same file), and
 *   2. a same-basename entry at a DIFFERENT path (an operator's own hook) is
 *      PRESERVED (warn-only) — the original safety intent is kept.
 *
 * Zero deps. Node stdlib only.
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'
import {
  mkMock, runInstall, readSettings, flattenHookCommands,
} from './lib/activation-scoping-harness.mjs'

let passed = 0, failed = 0
function check(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.log(`  ✗ ${name}`); failed++ }
}
const count = (cmds, sub) => cmds.filter((c) => c.includes(sub)).length

const INSTALL_FLAGS = ['--install-hooks', '--install-enforcement', '--install-hooks-force']
const { home, project, callerCwd } = mkMock('dedup')
const settingsPath = path.join(project, '.claude', 'settings.json')
const canonicalCG = path.join(project, '.claude', 'hooks', 'checkpoint-gate.sh')
const RELATIVE_CG = '.claude/hooks/checkpoint-gate.sh'
const CUSTOM_CG = '/tmp/operator-custom-hooks/checkpoint-gate.sh'

console.log('--- First enforcement install (canonical absolute registration) ---')
const r1 = runInstall({ home, project, callerCwd, flags: INSTALL_FLAGS })
assert(r1.status === 0, `first install failed (status ${r1.status}): ${r1.stderr}`)
const cg1 = count(flattenHookCommands(readSettings('project', { home, project })), 'checkpoint-gate.sh')
check(`baseline: exactly one checkpoint-gate after first install (got ${cg1})`, cg1 === 1)

console.log('--- Inject a superseded relative dup + a different-path custom entry ---')
const seeded = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
seeded.hooks.PreToolUse.unshift(
  { hooks: [{ type: 'command', command: RELATIVE_CG, timeout: 5 }], matcher: 'Edit|Write|MultiEdit|Bash|NotebookEdit' },
)
seeded.hooks.PreToolUse.unshift(
  { hooks: [{ type: 'command', command: CUSTOM_CG, timeout: 5 }], matcher: 'Edit' },
)
fs.writeFileSync(settingsPath, JSON.stringify(seeded, null, 2))
const before = count(flattenHookCommands(readSettings('project', { home, project })), 'checkpoint-gate.sh')
check(`seeded: 3 checkpoint-gate entries before re-install (got ${before})`, before === 3)

console.log('--- Re-install (prune superseded spelling, preserve custom) ---')
const r2 = runInstall({ home, project, callerCwd, flags: INSTALL_FLAGS })
assert(r2.status === 0, `re-install failed (status ${r2.status}): ${r2.stderr}`)
const cmds2 = flattenHookCommands(readSettings('project', { home, project }))

check('relative spelling AUTO-REMOVED', !cmds2.includes(RELATIVE_CG))
check('canonical absolute entry KEPT', cmds2.includes(canonicalCG))
check('exactly one canonical checkpoint-gate remains', cmds2.filter((c) => c === canonicalCG).length === 1)
check('different-path custom entry PRESERVED (warn-only)', cmds2.includes(CUSTOM_CG))
check('re-install reported the removal', /Removed superseded duplicate/.test(r2.stdout))
check('re-install warned (not removed) about the custom entry', /resolves to a non-canonical path/.test(r2.stdout))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
