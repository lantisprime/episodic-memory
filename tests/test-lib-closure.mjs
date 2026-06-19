#!/usr/bin/env node
/**
 * test-lib-closure.mjs — regression guard for computeLibClosure's import-form
 * coverage (RFC-008 P4d S2, review finding F3).
 *
 * computeLibClosure is the SOLE guarantee that the per-project enforcement bundle
 * (enforcementBundleLibs) is import-complete. A relative import FORM the walker
 * misses → a transitive lib silently dropped from the bundle → the relocated
 * engine fails at runtime in a non-this-repo project, uncatchable by this repo's
 * dev-relative CI. F3: the walker missed bare side-effect `import './x.mjs'`.
 *
 * This builds a throwaway scripts/ fixture exercising every static import form +
 * recursion + the non-captured cases, and asserts the resolved lib closure.
 *
 * Zero deps. Node stdlib only.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computeLibClosure } from '../scripts/lib/install-manifest.mjs'

let passed = 0, failed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; failures.push({ name, error: e.stack || e.message }); console.log(`  ✗ ${name}: ${e.message}`) }
}

console.log('# test-lib-closure (RFC-008 P4d S2 — F3 import-form coverage)')

// Build a fixture repo: <tmp>/scripts/{entry.mjs, lib/*.mjs}.
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'libclosure-')))
process.on('exit', () => { try { fs.rmSync(repo, { recursive: true, force: true }) } catch {} })
const scriptsDir = path.join(repo, 'scripts')
const libDir = path.join(scriptsDir, 'lib')
fs.mkdirSync(libDir, { recursive: true })

// entry.mjs exercises ALL FOUR import forms + a non-relative + a computed import.
fs.writeFileSync(path.join(scriptsDir, 'entry.mjs'), [
  `import './lib/bare.mjs'`,                  // bare side-effect (F3: was missed)
  `import def from './lib/default.mjs'`,      // default import
  `export { x } from './lib/reexport.mjs'`,  // re-export
  `const d = await import('./lib/dynamic.mjs')`, // dynamic literal
  `import fs from 'node:fs'`,                 // non-relative → NOT captured
  `const m = './lib/computed.mjs'; await import(m)`, // computed → NOT captured (documented limit)
].join('\n'))

// bare.mjs recurses into nested.mjs via a bare import → must be captured transitively.
fs.writeFileSync(path.join(libDir, 'bare.mjs'), `import './nested.mjs'\n`)
for (const f of ['default.mjs', 'reexport.mjs', 'dynamic.mjs', 'nested.mjs', 'computed.mjs']) {
  fs.writeFileSync(path.join(libDir, f), `export const ok = true\n`)
}

const closure = computeLibClosure(repo, ['entry.mjs'])

test('F3: bare side-effect `import \'./x\'` is captured', () => {
  assert.ok(closure.has('bare.mjs'), `bare.mjs missing from closure: ${[...closure].sort().join(', ')}`)
})
test('bare import recurses transitively (nested.mjs captured)', () => {
  assert.ok(closure.has('nested.mjs'), `nested.mjs missing: ${[...closure].sort().join(', ')}`)
})
test('default + re-export + dynamic-literal forms all captured', () => {
  for (const f of ['default.mjs', 'reexport.mjs', 'dynamic.mjs']) {
    assert.ok(closure.has(f), `${f} missing: ${[...closure].sort().join(', ')}`)
  }
})
test('non-relative import is NOT captured (node:fs)', () => {
  assert.ok(!closure.has('fs'), 'node:fs leaked into closure')
})
test('computed dynamic import is NOT captured (documented static-analysis limit)', () => {
  assert.ok(!closure.has('computed.mjs'),
    'computed import unexpectedly resolved — if static analysis was extended, update the F3 limitation note')
})
test('closure is exactly the 5 statically-resolvable relative libs', () => {
  assert.deepStrictEqual([...closure].sort(),
    ['bare.mjs', 'default.mjs', 'dynamic.mjs', 'nested.mjs', 'reexport.mjs'])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { for (const f of failures) console.error(`\n${f.name}\n${f.error}`); process.exit(1) }
