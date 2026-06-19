#!/usr/bin/env node
/**
 * test-p12-global-clean.mjs — RFC-008 P4d, the governing Principle 12 guardrail.
 *
 * PRINCIPLES.md §12 "Test this": after ANY global/core install variant, global
 * scope must contain ZERO enforcement hook FILES and ZERO enforcement
 * registrations. Enforcement artifacts (hook files, hook scripts, libs) live
 * ONLY under <project>/.claude/. A script that runs only as a hook (e.g.
 * em-session-end-prompt.mjs) is an enforcement artifact, not substrate.
 *
 * This test is parametrized over every install variant a user can run WITHOUT
 * the per-project --install-enforcement opt-in. None of them may leave an
 * enforcement file in ~/.claude/hooks/ or ~/.episodic-memory/scripts/, nor an
 * enforcement registration in ~/.claude/settings.json.
 *
 * Pre-S2 this FAILS (--install-hooks writes hook files + registrations to
 * global) — that failure is the proof the guardrail bites. S2 makes it pass by
 * moving all enforcement per-project.
 *
 * Zero deps. Node assert + the activation-scoping fixture lib.
 */

import assert from 'node:assert'
import {
  mkMock, runInstall, readSettings,
  hasEnforcementHook, enforcementHookCommands, enforcementFilesInGlobalScope,
  hookCodeFilesInGlobalScope, enforcementRuntimeInGlobalScope,
  nonSubstrateScriptsInGlobalScope,
} from './lib/activation-scoping-harness.mjs'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn(); passed++; console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++; failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

console.log('# test-p12-global-clean (RFC-008 P4d — PRINCIPLES.md §12 guardrail)')

// Every install variant a user can run WITHOUT the per-project enforcement
// opt-in. None may place an enforcement artifact in global scope.
// Core + the opt-in variants. --install-enforcement is INCLUDED here even though
// it is the per-project enforcement opt-in: P12's whole point is that enforcement
// goes to the PROJECT, so even WITH --install-enforcement, GLOBAL scope must stay
// enforcement-clean. That is the strongest form of the guarantee.
const VARIANTS = [
  { label: 'core (no flags)', flags: [] },
  { label: '--install-hooks', flags: ['--install-hooks', '--install-hooks-force'] },
  { label: '--install-second-opinion', flags: ['--install-second-opinion'] },
  { label: '--install-hooks + --install-second-opinion', flags: ['--install-hooks', '--install-hooks-force', '--install-second-opinion'] },
  { label: '--install-enforcement', flags: ['--install-enforcement'] },
  { label: '--install-enforcement + --install-second-opinion', flags: ['--install-enforcement', '--install-second-opinion'] },
]

for (const v of VARIANTS) {
  test(`P12: after '${v.label}', global scope has ZERO enforcement files + registrations`, () => {
    const M = mkMock('p12')
    const r = runInstall({ home: M.home, project: M.project, callerCwd: M.callerCwd, flags: v.flags })
    assert.strictEqual(r.status, 0, `install '${v.label}' must exit 0; stderr=${r.stderr}`)

    // (a) No KNOWN enforcement hook FILE in global scope.
    const globalFiles = enforcementFilesInGlobalScope(M.home)
    assert.deepStrictEqual(globalFiles, [],
      `P12 VIOLATION — enforcement files in global scope after '${v.label}': ${globalFiles.join(', ')}`)

    // (b) COMPREHENSIVE: NO hook code file (.sh/.mjs) of ANY kind under global
    // ~/.claude/hooks/ — not just the hand-maintained enforcement set. This is
    // the check that catches review tooling (second-opinion-gate.mjs) too.
    const globalHookCode = hookCodeFilesInGlobalScope(M.home)
    assert.deepStrictEqual(globalHookCode, [],
      `P12 VIOLATION — hook code files in global ~/.claude/hooks/ after '${v.label}': ${globalHookCode.join(', ')}`)

    // (c) No enforcement REGISTRATION in global settings.json.
    const g = readSettings('global', M)
    assert.strictEqual(hasEnforcementHook(g), false,
      `P12 VIOLATION — enforcement registrations in global settings after '${v.label}': ${enforcementHookCommands(g).join(', ')}`)

    // (d) COMPREHENSIVE RUNTIME: no enforcement ENGINE / classifier / markers /
    // bp1 entry scripts, no relocated-only libs, no contract config, no contract
    // plugins index in global ~/.episodic-memory/. This is the script+config half
    // of the leak the 2026-06-19 audit found (the per-project gates used to shim
    // back into a global enforce-contract.mjs). Manifest-derived, so it cannot
    // drift behind a newly added enforcement script.
    const globalRuntime = enforcementRuntimeInGlobalScope(M.home)
    assert.deepStrictEqual(globalRuntime, [],
      `P12 VIOLATION — enforcement runtime in global ~/.episodic-memory/ after '${v.label}': ${globalRuntime.join(', ')}`)

    // (e) SUBSTRATE-ONLY: global ~/.episodic-memory/scripts holds NOTHING but
    // substrate (em-* + second-opinion). Catches the repo-dev/CI-validator leak
    // class (validate-*, scaffold-bp, test-plugin, check-automode-defaults) that
    // (d) — scoped to the enforcement set only — does not. By the P12 FUNCTION
    // test those validators exist only to police the repo/enforcement layer; they
    // are not substrate and must ship nowhere.
    const nonSubstrate = nonSubstrateScriptsInGlobalScope(M.home)
    assert.deepStrictEqual(nonSubstrate, [],
      `P12 VIOLATION — non-substrate scripts in global ~/.episodic-memory/scripts after '${v.label}': ${nonSubstrate.join(', ')}`)
  })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
