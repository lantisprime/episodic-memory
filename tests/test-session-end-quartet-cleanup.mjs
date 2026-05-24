#!/usr/bin/env node
/**
 * Regression test for rank-2 C7: SessionEnd own-session quartet cleanup.
 *
 * Verifies:
 *   Q1 — Own-session suffixed quartet markers DELETED on SessionEnd.
 *   Q2 — Cross-session quartet markers PRESERVED on SessionEnd.
 *   Q3 — Legacy literal quartet markers DELETED (orphan cleanup, unchanged).
 *   Q4 — Invalid sid → only legacy literal cleanup; suffixed forms preserved.
 */

import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SESSION_END = path.join(REPO, 'scripts', 'em-session-end-prompt.mjs')

const QUARTET = [
  '.checkpoint-required',
  '.post-checkpoint-required',
  '.pre-checkpoint-done',
  '.post-checkpoint-done',
]

let pass = 0
let fail = 0
const failures = []

function assert(label, cond) {
  if (cond) { pass++; return }
  fail++
  failures.push(label)
}

function setupRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rank2-c7-test-'))
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, '.checkpoints'), { recursive: true })
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true })
  return root
}

function runSessionEnd(root, sid) {
  // Per codex C7 R1 P2: do NOT swallow execSync failures. SessionEnd is
  // expected to exit 0 with the JSON prompt template on stdout. Throwing
  // surfaces regressions that would otherwise be masked by partial-cleanup
  // shape.
  execSync(`node "${SESSION_END}"`, {
    input: JSON.stringify({ session_id: sid, cwd: root, hook_event_name: 'SessionEnd' }),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: root },
  })
}

// ---------------------------------------------------------------------------
// Q1 — Own-session suffixed quartet markers DELETED
// Q2 — Cross-session quartet markers PRESERVED
// ---------------------------------------------------------------------------
{
  const root = setupRoot()
  const sidB = 'session-b'
  const sidA = 'session-a'

  // Seed B's own suffixed quartet at both roots + A's suffixed at both roots.
  for (const dir of ['.checkpoints', '.claude']) {
    for (const m of QUARTET) {
      fs.writeFileSync(path.join(root, dir, `${m}.${sidB}`), '')
      fs.writeFileSync(path.join(root, dir, `${m}.${sidA}`), '')
    }
  }

  runSessionEnd(root, sidB)

  for (const dir of ['.checkpoints', '.claude']) {
    for (const m of QUARTET) {
      assert(`Q1 ${dir}/${m}.${sidB} removed (own-session)`,
        !fs.existsSync(path.join(root, dir, `${m}.${sidB}`)))
      assert(`Q2 ${dir}/${m}.${sidA} preserved (cross-session)`,
        fs.existsSync(path.join(root, dir, `${m}.${sidA}`)))
    }
  }

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Q3 — Legacy literal quartet markers DELETED (unchanged behavior)
// ---------------------------------------------------------------------------
{
  const root = setupRoot()
  const sid = 'session-c'

  for (const dir of ['.checkpoints', '.claude']) {
    for (const m of QUARTET) {
      fs.writeFileSync(path.join(root, dir, m), '')
    }
  }

  runSessionEnd(root, sid)

  for (const dir of ['.checkpoints', '.claude']) {
    for (const m of QUARTET) {
      assert(`Q3 ${dir}/${m} legacy literal removed (orphan cleanup)`,
        !fs.existsSync(path.join(root, dir, m)))
    }
  }

  fs.rmSync(root, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Q4 — Invalid sid → only legacy literal cleanup; suffixed preserved
// ---------------------------------------------------------------------------
{
  const root = setupRoot()
  const realSid = 'session-d'

  for (const dir of ['.checkpoints', '.claude']) {
    for (const m of QUARTET) {
      fs.writeFileSync(path.join(root, dir, m), '')
      fs.writeFileSync(path.join(root, dir, `${m}.${realSid}`), '')
    }
  }

  runSessionEnd(root, '../evil/invalid')

  for (const dir of ['.checkpoints', '.claude']) {
    for (const m of QUARTET) {
      assert(`Q4 ${dir}/${m} legacy literal removed (cleanup proceeds)`,
        !fs.existsSync(path.join(root, dir, m)))
      assert(`Q4 ${dir}/${m}.${realSid} preserved (invalid sid skips suffixed cleanup)`,
        fs.existsSync(path.join(root, dir, `${m}.${realSid}`)))
    }
  }

  fs.rmSync(root, { recursive: true, force: true })
}

console.log(JSON.stringify({
  pass,
  fail,
  total: pass + fail,
  failures,
}, null, 2))

process.exit(fail === 0 ? 0 : 1)
