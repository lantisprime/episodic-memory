#!/usr/bin/env node
/**
 * test-em-restore.mjs — sibling test runner for em-restore.mjs.
 *
 * Shells out to `node scripts/em-restore.mjs --self-test` and asserts that
 * every selfTest case passes. The exhaustive case list (53+ assertions) lives
 * inside the script's selfTest; this runner is the harness CI invokes.
 *
 * Usage: node tests/test-em-restore.mjs
 */

import path from 'path'
import { execFileSync } from 'child_process'
import assert from 'assert'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'em-restore.mjs')

let result
try {
  result = execFileSync('node', [SCRIPT, '--self-test'], { encoding: 'utf8' })
} catch (e) {
  // Non-zero exit = some test failed; surface stdout so CI shows which.
  console.error(e.stdout || '')
  console.error(e.stderr || '')
  process.exit(1)
}

const parsed = JSON.parse(result)
assert.strictEqual(parsed.status, 'ok', `selfTest failed: ${JSON.stringify(parsed, null, 2)}`)
assert.strictEqual(parsed.fail, 0, `${parsed.fail} selfTest case(s) failed`)
assert.ok(parsed.total >= 60, `expected at least 60 selfTest cases; got ${parsed.total}`)

const failed = (parsed.results || []).filter(r => r.pass === false)
if (failed.length > 0) {
  console.error('Failed cases:')
  for (const f of failed) console.error(`  - ${f.name}: ${f.why}`)
  process.exit(1)
}

const skipped = parsed.skipped || 0
const skipNote = skipped > 0 ? ` (${skipped} skipped)` : ''
console.log(`✓ em-restore selfTest: ${parsed.pass}/${parsed.total} cases passed${skipNote}`)
