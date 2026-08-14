#!/usr/bin/env node
/**
 * test-em-backup-body-read.mjs — issue #669 net-new suite.
 *
 * em-backup.mjs read episode/doc bodies (auditSources :549/:651 pre-fix
 * line numbers) with raw fs.readFileSync, and classified file bytes
 * (classifyFileBytes :352) with a raw blocking fs.openSync(path, 'r') — a
 * FIFO with no writer blocks BOTH forever.
 *
 * Per plan §3/§0: walk() only pushes isFile() dirents, so an AT-REST FIFO
 * never reaches either function through the normal directory-walk path —
 * an end-to-end CLI probe with a planted at-rest FIFO is VACUOUS (it
 * passes on unfixed HEAD too, since walk() already filters it out before
 * classifyFileBytes/the read ever run). The real exposure is a
 * classify-then-read RACE WINDOW (source flips from regular to non-regular
 * between classify time and read time) — DEFER-A residual, not fixed here,
 * but the READ ITSELF must never hang on it.
 *
 * This suite therefore uses DIRECT-UNIT calls (plan §3's explicit
 * alternative to an end-to-end probe) against the real exported functions:
 *   - classifyFileBytes(fifoPath) directly — proves the fd-based
 *     non-blocking classify never hangs on a FIFO and returns 'binary'
 *     (round-2 MINOR-R2-2 pin);
 *   - a manufactured classify-then-read race (classify a REGULAR file,
 *     then replace it with a FIFO before the read auditSources would do
 *     next) — proves the read layer never hangs even mid-race;
 *   - auditSources() end-to-end against a genuinely-unreadable-but-PRESENT
 *     regular file (chmod 0o000) — a real, deterministic (non-racy) defect
 *     that DOES reach the read, and asserts the new unreadable_skipped
 *     count in the existing report shape.
 */

import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const { classifyFileBytes, auditSources, SOURCES } = await import(path.join(REPO, 'scripts', 'em-backup.mjs'))
const { readBodyOrSkip } = await import(path.join(REPO, 'scripts', 'lib', 'index-state.mjs'))

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

function mktemp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

const EM_BACKUP_PATH = path.join(REPO, 'scripts', 'em-backup.mjs')

// #669 review-round codex MINOR-2 (test-strength gap): calling
// classifyFileBytes(fifoPath) IN-PROCESS means a regression back to a
// blocking openSync would hang this ENTIRE test file forever (no outer
// timeout catches an in-process hang). Spawn a CHILD process with an
// external timeout instead — a regression then fails this ONE test
// (timeout-killed child, non-null signal) rather than hanging the suite.
function classifyFileBytesSpawned(fifoPath, timeoutMs = 5000) {
  const helperCode = `import { classifyFileBytes } from ${JSON.stringify(EM_BACKUP_PATH)}\n` +
    `console.log(JSON.stringify({ result: classifyFileBytes(process.env.EMBACKUP_TEST_PATH) }))\n`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', helperCode], {
    encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, EMBACKUP_TEST_PATH: fifoPath },
  })
  return r
}

t('classifyFileBytes on a FIFO with no writer: returns binary, no hang (round-2 MINOR-R2-2)', () => {
  const tmp = mktemp('embackup-classify-')
  const fifoPath = path.join(tmp, 'probe.bin') // non-KNOWN_TEXT_EXTENSIONS so the fast-path doesn't short-circuit
  const mk = spawnSync('mkfifo', [fifoPath])
  assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`)

  const start = Date.now()
  const r = classifyFileBytesSpawned(fifoPath)
  const elapsed = Date.now() - start
  assert.equal(r.signal, null, `no signal (a regression to blocking open must fail THIS test, not hang the suite), got ${r.signal}`)
  assert.equal(r.status, 0, `child must exit cleanly, got ${r.status}: ${r.stderr}`)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.result, 'binary', `FIFO must classify as binary, got ${out.result}`)
  assert.ok(elapsed < 4000, `classifyFileBytes must return promptly (no hang), took ${elapsed}ms`)

  fs.unlinkSync(fifoPath)
  fs.rmSync(tmp, { recursive: true, force: true })
})

// #669 review-round A2 (MAJOR, convergent — silent no-op CLI): the
// entry-point guard used to be a plain `import.meta.url === file://argv[1]`
// string compare, which FAILS (and the CLI silently no-ops, exit 0, empty
// stdout) whenever the invocation path has a symlink component — exactly
// what happens spawning through a symlinked path here. Fixed with the
// realpath-both idiom (structured-alert-probe.mjs:65-72, FU #390 class).
t('CLI invoked through a symlinked path still runs as main (not a silent no-op)', () => {
  const tmp = mktemp('embackup-symlink-')
  const linkPath = path.join(tmp, 'em-backup-via-link.mjs')
  fs.symlinkSync(EM_BACKUP_PATH, linkPath)
  const r = spawnSync(process.execPath, [linkPath, '--help'], { encoding: 'utf8', timeout: 5000 })
  assert.equal(r.signal, null, `no signal (hang), got ${r.signal}`)
  assert.equal(r.status, 0, `exit 0, got ${r.status}: ${r.stderr}`)
  assert.ok(r.stdout.trim().length > 0, 'must NOT silently no-op with empty stdout')
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.status, 'help', `must actually run as main and print help, got ${r.stdout}`)
  fs.rmSync(tmp, { recursive: true, force: true })
})

t('classifyFileBytes on a FIFO named with a KNOWN_TEXT_EXTENSIONS suffix (.md): fast-path never touches the fd, so it cannot hang either', () => {
  // .md is in KNOWN_TEXT_EXTENSIONS: the fast-path returns 'text' WITHOUT
  // ever opening the fd (extension check only) — correctly hang-free by a
  // DIFFERENT mechanism than the fstat guard the other two tests exercise.
  // This documents that property rather than asserting a 'binary' verdict.
  const tmp = mktemp('embackup-classify-ext-')
  const fifoPath = path.join(tmp, 'probe.md')
  execFileSync('mkfifo', [fifoPath])
  const start = Date.now()
  const result = classifyFileBytes(fifoPath)
  const elapsed = Date.now() - start
  assert.equal(result, 'text', `known-text-extension fast-path returns 'text' unconditionally, got ${result}`)
  assert.ok(elapsed < 2000, `must not hang even though it never fstats the FIFO, took ${elapsed}ms`)
  fs.unlinkSync(fifoPath)
  fs.rmSync(tmp, { recursive: true, force: true })
})

t('classify-then-read race shape: classify sees a regular file, read sees a FIFO planted in between — never hangs', () => {
  // Manufactured race (plan §3 "(or race shapes)"): auditSources's/
  // syncToBackup's per-file loop does classifyFileBytes(f) THEN a guarded
  // read of f. Calling auditSources() itself here would be VACUOUS — its
  // OWN internal walk() re-reads the directory fresh and would already see
  // the swapped-in FIFO, filtering it out before classify/read even run
  // (plan §0: at-rest FIFOs never reach these reads). Replaying the exact
  // two-step sequence (classify, THEN read) directly proves the READ layer
  // survives a genuine TOCTOU swap between those two steps, independent of
  // walk()'s vacuous-exclusion property.
  const tmp = mktemp('embackup-race-')
  const racedPath = path.join(tmp, 'raced.txt')
  fs.writeFileSync(racedPath, 'regular content at classify time\n')

  const cls = classifyFileBytes(racedPath)
  assert.equal(cls, 'text', `regular file must classify as text before the race, got ${cls}`)

  // Race: swap the regular file for a FIFO before the read that would
  // normally follow immediately in auditSources'/syncToBackup's loop body.
  fs.unlinkSync(racedPath)
  execFileSync('mkfifo', [racedPath])

  const start = Date.now()
  const bodyRead = readBodyOrSkip(fs, racedPath)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 2000, `the post-classify read must not hang on the raced FIFO, took ${elapsed}ms`)
  assert.equal(bodyRead.ok, false, `raced-in FIFO must fail the read, got ${JSON.stringify(bodyRead)}`)
  assert.equal(bodyRead.code, 'ENOTREG', `expected ENOTREG, got ${bodyRead.code}`)

  fs.unlinkSync(racedPath)
  fs.rmSync(tmp, { recursive: true, force: true })
})

t('auditSources on a genuinely-unreadable-but-present regular file (EACCES): unreadable_skipped counted, run does not abort', () => {
  if (process.getuid && process.getuid() === 0) {
    console.log('      (skipped: running as root, chmod 0o000 does not block reads)')
    return
  }
  const tmp = mktemp('embackup-eacces-')
  const blockedPath = path.join(tmp, 'blocked.txt')
  fs.writeFileSync(blockedPath, 'unreadable content\n')
  fs.chmodSync(blockedPath, 0o000)
  const okPath = path.join(tmp, 'ok.txt')
  fs.writeFileSync(okPath, 'readable content\n')

  SOURCES.length = 0
  SOURCES.push({ src: tmp, dest: 'blocked', absDest: path.join(tmp, '__dest__'), label: 'blocked' })
  try {
    const report = auditSources({ sample: 0 })
    assert.equal(report.totals.files, 2, `both files counted as attempted (walk() sees both as regular): ${JSON.stringify(report.totals)}`)
    assert.equal(report.totals.text_files, 1, `only the readable file counts as text_files: ${JSON.stringify(report.totals)}`)
    assert.equal(report.totals.unreadable_skipped, 1, `the EACCES file must count in unreadable_skipped: ${JSON.stringify(report.totals)}`)
    const entry = report.sources.find(s => s.label === 'blocked')
    assert.equal(entry.unreadable_skipped, 1, `per-source entry.unreadable_skipped: ${JSON.stringify(entry)}`)
  } finally {
    fs.chmodSync(blockedPath, 0o644) // restore before rmSync
    fs.rmSync(tmp, { recursive: true, force: true })
    SOURCES.length = 0
  }
})

t('healthy control: auditSources on all-readable sources reports zero unreadable_skipped', () => {
  const tmp = mktemp('embackup-control-')
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'content a\n')
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'content b\n')
  SOURCES.length = 0
  SOURCES.push({ src: tmp, dest: 'ctrl', absDest: path.join(tmp, '__dest__'), label: 'ctrl' })
  const report = auditSources({ sample: 0 })
  assert.equal(report.totals.text_files, 2, JSON.stringify(report.totals))
  assert.equal(report.totals.unreadable_skipped, 0, JSON.stringify(report.totals))
  fs.rmSync(tmp, { recursive: true, force: true })
  SOURCES.length = 0
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
