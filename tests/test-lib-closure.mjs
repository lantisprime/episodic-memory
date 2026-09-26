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

// #540: quoted specifiers inside COMMENTS must not enter the closure (phantom
// libs), while `//` / `/*` inside strings and regex literals must not hide a
// real import that follows on the same line.
fs.writeFileSync(path.join(scriptsDir, 'commented.mjs'), [
  `// e.g. import './lib/phantom-line.mjs'`,
  `/* doc: import x from './lib/phantom-block.mjs'`,
  `   and import('./lib/phantom-dyn.mjs') */`,
  `/** JSDoc: \`import './lib/phantom-jsdoc.mjs'\` */`,
  `const url = 'https://example.com/a'; import './lib/after-url.mjs'`,
  `const re = /\\/\\/|\\/\\*/; import './lib/after-regex.mjs'`,
  `const t = \`// not a comment\`; import './lib/after-template.mjs'`,
  `const q = a / b; import './lib/after-division.mjs' // trailing './lib/phantom-trailing.mjs'`,
].join('\n'))
for (const f of ['after-url.mjs', 'after-regex.mjs', 'after-template.mjs', 'after-division.mjs',
  'phantom-line.mjs', 'phantom-block.mjs', 'phantom-dyn.mjs', 'phantom-jsdoc.mjs', 'phantom-trailing.mjs']) {
  fs.writeFileSync(path.join(libDir, f), `export const ok = true\n`)
}
const commented = computeLibClosure(repo, ['commented.mjs'])

test('#540: imports inside // and /* */ comments are NOT captured', () => {
  const phantoms = [...commented].filter((f) => f.startsWith('phantom-'))
  assert.deepStrictEqual(phantoms, [], `comment literals leaked into closure: ${phantoms.join(', ')}`)
})
test('#540: `//` or `/*` inside strings, templates and regexes do not hide real imports', () => {
  assert.deepStrictEqual([...commented].sort(),
    ['after-division.mjs', 'after-regex.mjs', 'after-template.mjs', 'after-url.mjs'])
})
test('#540: real repo global closure has no phantom (non-existent) libs', () => {
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const missing = [...computeLibClosure(REPO, fs.readdirSync(path.join(REPO, 'scripts')).filter((f) => f.endsWith('.mjs')))]
    .filter((f) => !fs.existsSync(path.join(REPO, 'scripts', 'lib', f)))
  assert.deepStrictEqual(missing, [], `closure names libs absent on disk: ${missing.join(', ')}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { for (const f of failures) console.error(`\n${f.name}\n${f.error}`); process.exit(1) }
