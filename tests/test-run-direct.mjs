#!/usr/bin/env node
/**
 * test-run-direct.mjs — regression guard for the ESM direct-run guard class
 * (#380; earlier URL-encoding member fixed in 649e3fd / P2a step-6 F4).
 *
 * A raw `import.meta.url === pathToFileURL(process.argv[1]).href` (or the
 * `file://${argv[1]}` template) compare fail-opens: under a symlinked argv[1]
 * Node realpaths the main module, so the compare is false, main() never runs,
 * and the CLI exits 0 with EMPTY output — a vacuous green. The template form
 * also fails on a path containing a space.
 *
 * Three layers:
 *   1. isMain() unit behavior on a fixture script (real / symlink / space /
 *      --preserve-symlinks-main / imported-not-main).
 *   2. Every direct-run guard site, invoked via symlink and via a path with a
 *      space, produces the SAME non-empty output + exit code as the real path.
 *   3. Class lint: no .mjs under scripts/ plugins/ tools/ carries a raw
 *      one-sided argv[1] vs import.meta.url compare.
 *
 * Zero deps. Node stdlib only.
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let passed = 0, failed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; failures.push({ name, error: e.stack || e.message }); console.log(`  ✗ ${name}: ${e.message}`) }
}

console.log('# test-run-direct (#380 — direct-run guard under symlink / space)')

// Scratch dir outside git; realpath'd so the fixture's own spelling is canonical.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-direct-')))
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

function run(args, cwd = tmp) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 30000 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

// --- 1. isMain unit behavior ------------------------------------------------
const helperUrl = pathToFileURL(path.join(REPO, 'scripts', 'lib', 'run-direct.mjs')).href
const realDir = path.join(tmp, 'real')
const spaceDir = path.join(tmp, 'dir with space')
const linkDir = path.join(tmp, 'links')
for (const d of [realDir, spaceDir, linkDir]) fs.mkdirSync(d, { recursive: true })
const probeSrc = `import { isMain } from ${JSON.stringify(helperUrl)}\n` +
  `process.stdout.write(JSON.stringify({ main: isMain(import.meta.url) }))\n`
const probe = path.join(realDir, 'probe.mjs')
fs.writeFileSync(probe, probeSrc)
fs.writeFileSync(path.join(spaceDir, 'probe.mjs'), probeSrc)
fs.symlinkSync(probe, path.join(linkDir, 'probe.mjs'))
fs.writeFileSync(path.join(realDir, 'importer.mjs'), `import ${JSON.stringify(pathToFileURL(probe).href)}\n`)

test('isMain: true when run by real path', () => {
  assert.strictEqual(run([probe]).stdout, '{"main":true}')
})
test('isMain: true when run through a symlink (#380)', () => {
  assert.strictEqual(run([path.join(linkDir, 'probe.mjs')]).stdout, '{"main":true}')
})
test('isMain: true when run through a relative symlink path from cwd', () => {
  assert.strictEqual(run(['probe.mjs'], linkDir).stdout, '{"main":true}')
})
test('isMain: true on a path containing a space (649e3fd class)', () => {
  assert.strictEqual(run([path.join(spaceDir, 'probe.mjs')]).stdout, '{"main":true}')
})
test('isMain: true under --preserve-symlinks-main through a symlink', () => {
  assert.strictEqual(run(['--preserve-symlinks-main', path.join(linkDir, 'probe.mjs')]).stdout, '{"main":true}')
})
test('isMain: false when the module is imported, not run', () => {
  assert.strictEqual(run([path.join(realDir, 'importer.mjs')]).stdout, '{"main":false}')
})

// --- 2. every guard site: symlink / space spelling == real spelling ---------
const SITES = [
  'scripts/validate-schemas.mjs',
  'scripts/validate-plugin-registry.mjs',
  'scripts/test-plugin.mjs',
  'scripts/scaffold-bp.mjs',
  'scripts/validate-bp-contract.mjs',
  'scripts/classifier-config-loader.mjs',
  'scripts/check-plugin-version-bump.mjs',
  'scripts/em-trigger-index.mjs',
  'scripts/bp1-crash-classify.mjs',
  'tools/validate-discipline-load-bundles.mjs',
]
// Space-path copy of the two trees the sites live in (tools/ imports ../scripts/lib).
const spaceRepo = path.join(tmp, 'repo with space')
for (const d of ['scripts', 'tools']) fs.cpSync(path.join(REPO, d), path.join(spaceRepo, d), { recursive: true })

for (const rel of SITES) {
  const real = run([path.join(REPO, rel), '--help'])
  // Same basename as the real file (usage text echoes it); own dir per site.
  const link = path.join(linkDir, path.dirname(rel), path.basename(rel))
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(path.join(REPO, rel), link)
  test(`${rel}: real-path run produces output (baseline)`, () => {
    assert.ok((real.stdout + real.stderr).length > 0, 'real-path run printed nothing')
  })
  test(`${rel}: symlinked argv[1] runs main() (not a vacuous exit 0)`, () => {
    const r = run([link, '--help'])
    assert.ok((r.stdout + r.stderr).length > 0, `empty output, exit=${r.status}`)
    assert.deepStrictEqual(r, real)
  })
  test(`${rel}: argv[1] containing a space runs main()`, () => {
    const r = run([path.join(spaceRepo, rel), '--help'])
    assert.ok((r.stdout + r.stderr).length > 0, `empty output, exit=${r.status}`)
    assert.strictEqual(r.status, real.status)
  })
}

// --- 3. class lint: no raw one-sided guard compare left behind -------------
function* mjsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* mjsFiles(p)
    else if (e.name.endsWith('.mjs')) yield p
  }
}
test('class lint: no raw argv[1] vs import.meta.url guard in scripts/ plugins/ tools/', () => {
  const offenders = []
  for (const top of ['scripts', 'plugins', 'tools']) {
    for (const f of mjsFiles(path.join(REPO, top))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return
        if (!line.includes('process.argv[1]') || !line.includes('import.meta.url')) return
        // Realpath-both idiom is sound; a `.pathname` side is not (percent-encoded).
        const realpathBoth = (line.match(/realpathSync\(/g) || []).length >= 2
        if (realpathBoth && !line.includes('.pathname')) return
        offenders.push(`${path.relative(REPO, f)}:${i + 1}: ${line.trim()}`)
      })
    }
  }
  assert.deepStrictEqual(offenders, [], `use isMain(import.meta.url) from scripts/lib/run-direct.mjs:\n${offenders.join('\n')}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { for (const f of failures) console.error(`\n${f.name}\n${f.error}`); process.exit(1) }
