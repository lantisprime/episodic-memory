#!/usr/bin/env node
/**
 * test-workflow-non-event-classification.mjs — Issue 558 regression suite.
 *
 * RFC-002 Phase 3b-H1 PR-C + issue 558. Verifies that em-workflow-validate
 * classifies typed BP-1 operational records as non-workflow events BEFORE
 * lifecycle payload parsing. A real bp1-deadline-tick record with
 * `type: evidence` and a plain-text body must NOT invalidate an otherwise
 * valid unrelated task chain, while an untyped or unknown-typed
 * workflow.lifecycle record without the required JSON fence MUST still fail
 * closed.
 *
 * Runner: node tests/test-workflow-non-event-classification.mjs
 * Mutation control: node tests/test-workflow-non-event-classification.mjs --break-bp1-classification
 *
 * The mutation control replaces the producer tick's `type: evidence` with
 * `type: unknown` so the closed allowlist no longer classifies it as a
 * non-event. The tick is out-of-chain (the producer file is not part of the
 * plan-approved + pre-checkpoint chain), so the strict fence path raises the
 * existing fenced-block parse error against the plain-text body, the
 * out-of-chain migration downgrades that error into a warning, the
 * validator remains exit 0 with valid=true for the complete chain, and the
 * test suite exits non-zero because the no-warning oracle fails. This is
 * the load-bearing mutation: a guard that lets `unknown` through as a
 * non-event would silently let the mutated tick pass, the suite would
 * green, and the regression would re-open.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SELF_DIR, '..')
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts')
const ORCHESTRATOR = path.join(SCRIPTS_DIR, 'bp1-orchestrator.mjs')
const EM_STORE = path.join(SCRIPTS_DIR, 'em-store.mjs')
const EM_REBUILD = path.join(SCRIPTS_DIR, 'em-rebuild-index.mjs')
const VALIDATE = path.join(SCRIPTS_DIR, 'em-workflow-validate.mjs')

const BREAK_FLAG = '--break-bp1-classification'
const BREAK_MODE = process.argv.slice(2).includes(BREAK_FLAG)

let passed = 0
let failed = 0
const failures = []

function runNode(scriptPath, args, env, cwd) {
  return execFileSync('node', [scriptPath, ...args], {
    env,
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

// runProc — wrap execFileSync so non-zero exit surfaces {status, stdout, stderr}
// without throwing. Always returns {status, stdout, stderr}: status 0 with the
// captured stdout on success; non-zero status with captured stdout/stderr on
// failure. Never returns null and never throws.
function runProc(scriptPath, args, env, cwd) {
  try {
    const stdout = runNode(scriptPath, args, env, cwd)
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    return {
      status: e.status == null ? 1 : e.status,
      stdout: e.stdout ? e.stdout.toString() : '',
      stderr: e.stderr ? e.stderr.toString() : '',
    }
  }
}

function makeEnv() {
  const tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-558-home-')))
  const tmpCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-558-cwd-')))
  execFileSync('git', ['init', '-q'], { cwd: tmpCwd })
  // Pre-create the directories the scripts touch so first-use is graceful.
  fs.mkdirSync(path.join(tmpCwd, '.episodic-memory', 'episodes'), { recursive: true })
  fs.mkdirSync(path.join(tmpHome, '.episodic-memory'), { recursive: true })
  const env = { ...process.env, HOME: tmpHome }
  return { tmpHome, tmpCwd, env }
}

function runOrchestrator(args, env, cwd) {
  return runProc(ORCHESTRATOR, args, env, cwd)
}

function runEmStore(args, env, cwd) {
  return runProc(EM_STORE, args, env, cwd)
}

function runEmRebuild(args, env, cwd) {
  return runProc(EM_REBUILD, args, env, cwd)
}

// runValidate — em-workflow-validate fails closed: exits 0 on valid, 1 on
// invalid, 2 on usage. Wrap so we can parse JSON on every exit class.
function runValidate(args, env, cwd) {
  let stdout
  let status
  try {
    stdout = execFileSync('node', [VALIDATE, ...args], {
      env, cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    })
    status = 0
  } catch (e) {
    status = e.status == null ? 1 : e.status
    stdout = e.stdout ? e.stdout.toString() : ''
  }
  let parsed
  try { parsed = JSON.parse(stdout) } catch { parsed = null }
  return { status, stdout, json: parsed }
}

// readFrontmatterLines — locate the first --- / --- block and return its
// content lines for assertions. CRLF-tolerant (mirrors the validator's
// parsing contract per §12).
function readFrontmatterLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') return []
  const close = lines.indexOf('---', 1)
  if (close === -1) return []
  return lines.slice(1, close)
}

// Author a workflow.lifecycle chain via real em-store. The validator's
// pre-filter requires task + pattern_id match. Returns the chain ids.
function writeChain(args, env, cwd, task, head) {
  const planBody = '```json\n' + JSON.stringify({
    event: 'plan-approved',
    pattern_id: 'bp-001-implementation-workflow',
    task,
    plan_ref: 'docs/plan.md',
    classification: 'full',
    context: { worktree: cwd, branch: 'main', head },
  }, null, 2) + '\n```'
  const planOut = runEmStore([
    '--project', 'issue-558-fixture',
    '--category', 'workflow.lifecycle',
    '--summary', 'plan-approved',
    '--body', planBody,
    '--scope', 'local',
  ], env, cwd)
  assert.strictEqual(planOut.status, 0, `plan-approved via em-store failed: ${planOut.stderr}\n${planOut.stdout}`)
  const planId = JSON.parse(planOut.stdout).id

  const preBody = '```json\n' + JSON.stringify({
    event: 'pre-checkpoint',
    pattern_id: 'bp-001-implementation-workflow',
    task,
    plan_ref: 'docs/plan.md',
    approval_ref: `episode:${planId}`,
    context: { worktree: cwd, branch: 'main', head },
  }, null, 2) + '\n```'
  const preOut = runEmStore([
    '--project', 'issue-558-fixture',
    '--category', 'workflow.lifecycle',
    '--summary', 'pre-checkpoint',
    '--body', preBody,
    '--scope', 'local',
  ], env, cwd)
  assert.strictEqual(preOut.status, 0, `pre-checkpoint via em-store failed: ${preOut.stderr}\n${preOut.stdout}`)
  const preId = JSON.parse(preOut.stdout).id
  return { planId, preId }
}

function runTest(name, fn) {
  // Each test gets its own isolated env so failures in one don't cross
  // contaminate another. Mirrors the per-test reset pattern in
  // tests/test-workflow-validate.mjs.
  const { tmpHome, tmpCwd, env } = makeEnv()
  try {
    fn({ tmpHome, tmpCwd, env })
    passed++
    console.log(`  + ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  x ${name}`)
    console.log(`    ${e.message}`)
  } finally {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(tmpCwd, { recursive: true, force: true }) } catch {}
  }
}

// ---------------------------------------------------------------------------
// Group 1 — real producer
// ---------------------------------------------------------------------------

runTest('realDeadlineTickDoesNotPoisonValidChain', ({ tmpHome, tmpCwd, env }) => {
  const task = 'issue-558-real-tick'

  // Step A: invoke the real bp1-orchestrator check-deadlines producer.
  const orchOut = runOrchestrator(['check-deadlines', '--project', tmpCwd], env, tmpCwd)
  assert.strictEqual(orchOut.status, 0, `check-deadlines failed: ${orchOut.stderr}\n${orchOut.stdout}`)
  const orchJson = JSON.parse(orchOut.stdout)
  const tickId = orchJson.tick_id
  assert.ok(tickId, `tick_id missing from orchestrator output: ${orchOut.stdout}`)
  const tickFile = path.join(tmpCwd, '.episodic-memory', 'episodes', `${tickId}.md`)
  assert.ok(fs.existsSync(tickFile), `tick episode must land at ${tickFile}`)
  void tmpHome

  // Step B: verify the producer wrote `type: evidence` and NO json fence.
  const tickText = fs.readFileSync(tickFile, 'utf8')
  const fmLines = readFrontmatterLines(tickFile)
  assert.ok(
    fmLines.some(l => l === 'type: evidence'),
    `tick must carry exact "type: evidence" frontmatter; got: ${fmLines.join('\n')}`,
  )
  assert.ok(!/```json\s*\n/.test(tickText),
    'tick must NOT contain a json fenced block (it is an operational record, not a lifecycle event)')

  // Step C (mutation): replace type: evidence with type: unknown. The
  // closed allowlist no longer classifies it as a non-event, so the
  // strict fence path raises the existing fenced-block parse error against
  // the plain-text producer body. Because the tick is out-of-chain (the
  // chain is plan-approved + pre-checkpoint for a different task), the
  // out-of-chain migration downgrades that error into a warning: the
  // validator stays exit 0 with valid=true for the complete chain, and the
  // no-warning oracle below fails the test suite.
  if (BREAK_MODE) {
    const mutated = tickText.replace(/^type: evidence$/m, 'type: unknown')
    assert.notStrictEqual(mutated, tickText, 'mutation did not match the type: evidence line')
    fs.writeFileSync(tickFile, mutated)
  }

  // Step D: rebuild the local index because the producer wrote only the
  // episode file (no index entry, per the real check-deadlines writer).
  const rebuildOut = runEmRebuild(['--scope', 'local'], env, tmpCwd)
  assert.strictEqual(rebuildOut.status, 0, `em-rebuild-index failed: ${rebuildOut.stderr}\n${rebuildOut.stdout}`)

  // Step E: author a valid plan-approved + pre-checkpoint chain via real
  // em-store. The validator will only honor events for `task`.
  writeChain(null, env, tmpCwd, task, 'abc1234')

  // Step F: run the validator against the chain. After the fix, the tick is
  // classified as a non-event and skipped; the chain validates as valid.
  // Under BREAK_MODE, the tick is reclassified out of the non-event path
  // and the strict fence path raises a fenced-block parse error against
  // the plain-text producer body. Because the tick is out-of-chain, the
  // out-of-chain migration downgrades that error into a warning: the
  // validator exits 0 with valid=true, but the tick leaks into warnings[]
  // and the no-warning oracle (next block) fails the test suite.
  const r = runValidate([
    '--task', task,
    '--gate', 'pre-checkpoint',
    '--head', 'abc1234',
    '--scope', 'local',
  ], env, tmpCwd)

  // BREAK_MODE oracle. The mutation (type: evidence → type: unknown)
  // replaces a closed-allowlist member with a value that must NOT be
  // classified as a non-event. The validator falls into the strict fence
  // path and throws the existing fenced-block error against the plain-text
  // producer body; the out-of-chain migration then downgrades that error
  // into a warning, so the validator exits 0 with valid=true for the
  // complete chain (the chain-validity assertion above still passes). The
  // suite fails at the no-warning oracle further down
  // (assert.ok(!tickLeak, ...)), which catches the tick in warnings[].
  // That distinction is the load-bearing proof of the allowlist: any
  // future guard that lets `unknown` through as a non-event would silently
  // let the mutated tick pass, the suite would green, and the regression
  // would re-open.
  assert.strictEqual(r.status, 0, `expected validator exit 0; got ${r.status}; stdout=${r.stdout}; stderr=${r.stderr || ''}`)
  assert.ok(r.json, `validator JSON missing; stdout=${r.stdout}`)
  assert.strictEqual(r.json.valid, true, `chain must validate; errors=${JSON.stringify(r.json.errors)}; warnings=${JSON.stringify(r.json.warnings)}`)
  // The bug surface: pre-fix the validator's #102 out-of-chain migration
  // downgrades the tick's body-parse error into a warning, leaving a
  // (out-of-chain) episode:<tickId>: No json fenced block entry in
  // warnings[]. Post-fix the tick is read once for its frontmatter type
  // and classified as a non-event BEFORE the JSON fence parser — no
  // error, no warning, no migration leak. This assertion is the red
  // capture the plan promises.
  const tickLeak = (r.json.warnings || []).find(w => w.includes(tickId))
  assert.ok(!tickLeak,
    `tick ${tickId} must not leak as a warning under the new classification; warnings=${JSON.stringify(r.json.warnings)}`)
  // The tick must not appear in chain events[] (validator skips non-events).
  const tickEp = (r.json.episodes || []).find(e => e.id === tickId)
  assert.ok(!tickEp, `tick ${tickId} must not appear in chain events[] (non-event); episodes=${JSON.stringify(r.json.episodes)}`)
  assert.deepStrictEqual(r.json.missing, [], `chain must be complete; missing=${JSON.stringify(r.json.missing)}`)
})

// ---------------------------------------------------------------------------
// Group 2 — typed BP-1 sibling records
// ---------------------------------------------------------------------------

// writeTypedNonEventIndex — writes a workflow.lifecycle episode with a typed
// BP-1 frontmatter field (one of evidence/failure/state-transition) and a
// plain-text body, plus an index entry. Mirrors the REAL bp1-orchestrator
// producer's on-disk shape exactly so the validator's frontmatter inspection
// runs against the same layout it would see in production.
function writeTypedNonEvent({ cwd, type, summary }) {
  const id = `20260722-${type}-sibling-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`
  const fmLines = [
    '---',
    `id: "${id}"`,
    'type: ' + type,
    'parent_episode: null',
    `summary: ${JSON.stringify(`bp1-${type} ${id}`)}`,
    'tags: [bp1-deadline-tick]',
    'category: workflow.lifecycle',
    'date: 2026-07-22',
    'time: "12:00"',
    'project: "issue-558-fixture"',
    '---',
  ]
  const body = `bp1-${type} plain text body without a json fence.\nactivation=disabled\n`
  const text = fmLines.join('\n') + '\n' + body
  fs.writeFileSync(path.join(cwd, '.episodic-memory', 'episodes', `${id}.md`), text)
  fs.appendFileSync(
    path.join(cwd, '.episodic-memory', 'index.jsonl'),
    JSON.stringify({
      id, date: '2026-07-22', time: '12:00', project: 'issue-558-fixture',
      category: 'workflow.lifecycle', status: 'active', supersedes: null,
      tags: ['bp1-deadline-tick'], summary,
    }) + '\n'
  )
  return id
}

runTest('knownBp1TypesAreNonEvents', ({ tmpHome, tmpCwd, env }) => {
  const task = 'issue-558-typed-siblings'

  // Write three typed plain-text records — one per BP-1 producer type.
  // Each carries the same workflow.lifecycle category so they enter the
  // validator's workflowEntries pre-filter, and each has the typed
  // frontmatter that closes the non-event allowlist.
  const written = [
    writeTypedNonEvent({ cwd: tmpCwd, type: 'evidence', summary: 'evidence' }),
    writeTypedNonEvent({ cwd: tmpCwd, type: 'failure', summary: 'failure' }),
    writeTypedNonEvent({ cwd: tmpCwd, type: 'state-transition', summary: 'state-transition' }),
  ]
  void tmpHome

  // Author the chain via real em-store.
  writeChain(null, env, tmpCwd, task, 'abc1234')

  const r = runValidate([
    '--task', task,
    '--gate', 'pre-checkpoint',
    '--head', 'abc1234',
    '--scope', 'local',
  ], env, tmpCwd)

  assert.strictEqual(r.status, 0, `expected validator exit 0; got ${r.status}; stdout=${r.stdout}`)
  assert.ok(r.json, `validator JSON missing; stdout=${r.stdout}`)
  // The typed records must NOT contribute to missing[] (they are non-events).
  assert.deepStrictEqual(r.json.missing, [], `chain must be complete; missing=${JSON.stringify(r.json.missing)}`)
  // And they must NOT appear in chain events[] (validator skips non-events).
  for (const id of written) {
    assert.ok(
      !(r.json.episodes || []).some(e => e.id === id),
      `typed non-event ${id} must not appear in chain events[]; got: ${JSON.stringify(r.json.episodes)}`,
    )
  }
  // The chain itself must be valid.
  assert.strictEqual(r.json.valid, true,
    `typed records must not poison the chain; errors=${JSON.stringify(r.json.errors)}; warnings=${JSON.stringify(r.json.warnings)}`)
  // Pre-fix the typed records leak as (out-of-chain) migration warnings;
  // post-fix they are non-events and leave no warning trace.
  for (const id of written) {
    assert.ok(
      !(r.json.warnings || []).some(w => w.includes(id)),
      `typed non-event ${id} must not leak as a warning; warnings=${JSON.stringify(r.json.warnings)}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Group 3 — fail-closed controls
// ---------------------------------------------------------------------------

runTest('untypedUnfencedRecordRemainsFatal', ({ tmpHome, tmpCwd, env }) => {
  // Use real em-store to write a workflow.lifecycle record with a plain-text
  // body and no json fenced block. The validator MUST reject it.
  const body = 'plain text lifecycle record with no fenced json block.\nthis should fail closed.\n'
  const storeOut = runEmStore([
    '--project', 'issue-558-fixture',
    '--category', 'workflow.lifecycle',
    '--summary', 'untyped-unfenced',
    '--body', body,
    '--scope', 'local',
  ], env, tmpCwd)
  assert.strictEqual(storeOut.status, 0, `em-store failed: ${storeOut.stderr}\n${storeOut.stdout}`)
  const untypedId = JSON.parse(storeOut.stdout).id

  const untypedFile = path.join(tmpCwd, '.episodic-memory', 'episodes', `${untypedId}.md`)
  assert.ok(fs.existsSync(untypedFile), `episode file must exist at ${untypedFile}`)

  // Assert: genuine lifecycle episodes written by em-store carry no type
  // frontmatter. This is the "no-type invariant" the closed allowlist
  // relies on for genuine lifecycle events.
  const fmLines = readFrontmatterLines(untypedFile)
  assert.ok(
    !fmLines.some(l => /^type:/.test(l)),
    `em-store-written episode must NOT carry any "type:" frontmatter field; got: ${fmLines.join('\n')}`,
  )
  void tmpHome

  // Run the validator. The untyped record has no type — frontmatterScalar
  // returns null — so extractPayload falls into the strict JSON fence
  // path and throws the existing fenced-block error. Gate fails closed.
  const r = runValidate([
    '--task', 'issue-558-untyped',
    '--gate', 'pre-checkpoint',
    '--head', 'abc1234',
    '--scope', 'local',
  ], env, tmpCwd)

  assert.strictEqual(r.status, 1, `expected validator exit 1; got ${r.status}; stdout=${r.stdout}`)
  assert.ok(r.json, `validator JSON missing; stdout=${r.stdout}`)
  assert.ok(
    r.json.errors && r.json.errors.some(e => /fenced block/i.test(e) && e.includes(untypedId)),
    `expected fenced-block error naming ${untypedId}; got: ${JSON.stringify(r.json.errors)}`,
  )
})

runTest('unknownTypedUnfencedRecordRemainsFatal', ({ tmpHome, tmpCwd, env }) => {
  // Author via real em-store (no type), then mutate the on-disk file to add
  // type: unknown. The mutation mirrors --break-bp1-classification's effect
  // on the producer file but is local to this test (no dependency on test 1).
  const body = 'plain text lifecycle record with no fenced json block.\nunknown-typed control.\n'
  const storeOut = runEmStore([
    '--project', 'issue-558-fixture',
    '--category', 'workflow.lifecycle',
    '--summary', 'unknown-typed-control',
    '--body', body,
    '--scope', 'local',
  ], env, tmpCwd)
  assert.strictEqual(storeOut.status, 0, `em-store failed: ${storeOut.stderr}\n${storeOut.stdout}`)
  const unknownId = JSON.parse(storeOut.stdout).id

  const unknownFile = path.join(tmpCwd, '.episodic-memory', 'episodes', `${unknownId}.md`)
  const text = fs.readFileSync(unknownFile, 'utf8')
  assert.ok(text.startsWith('---\n'), 'file must lead with a yaml frontmatter block')
  // Insert a `type: unknown` line right after the opening `---`.
  const mutated = text.replace(/^---\n/, '---\ntype: unknown\n')
  assert.notStrictEqual(mutated, text, 'mutation did not insert the type: unknown line')
  fs.writeFileSync(unknownFile, mutated)

  // Rebuild so the index reflects the on-disk file (em-store wrote the
  // index entry without type, but the file now has it — the index does
  // not need re-reading because index fields don't include "type", but
  // rebuild is cheap and keeps the on-disk shape consistent for the
  // validator).
  const rebuildOut = runEmRebuild(['--scope', 'local'], env, tmpCwd)
  assert.strictEqual(rebuildOut.status, 0, `em-rebuild-index failed: ${rebuildOut.stderr}\n${rebuildOut.stdout}`)
  void tmpHome

  // Run validator. type: unknown is NOT in the closed allowlist and the
  // body has no fence → fail closed with the same error as untyped.
  const r = runValidate([
    '--task', 'issue-558-unknown-typed',
    '--gate', 'pre-checkpoint',
    '--head', 'abc1234',
    '--scope', 'local',
  ], env, tmpCwd)

  assert.strictEqual(r.status, 1, `expected validator exit 1; got ${r.status}; stdout=${r.stdout}`)
  assert.ok(r.json, `validator JSON missing; stdout=${r.stdout}`)
  assert.ok(
    r.json.errors && r.json.errors.some(e => /fenced block/i.test(e) && e.includes(unknownId)),
    `expected fenced-block error naming ${unknownId}; got: ${JSON.stringify(r.json.errors)}`,
  )
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n# ${passed} passed, ${failed} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  x ${f.name}\n    ${f.error}`)
}
process.exit(failed === 0 ? 0 : 1)
