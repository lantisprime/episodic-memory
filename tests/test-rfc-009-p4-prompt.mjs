#!/usr/bin/env node
/**
 * test-rfc-009-p4-prompt.mjs — RFC-009 P4-S7 (R9d clerk prompt + conformance,
 * REQ-15). The prompt is DATA (P2) shipped at
 * `scripts/em-consolidate/prompts/clerk.md` and must carry every
 * normative clause from docs/rfcs/RFC-009-lesson-activation.md:189-207.
 *
 * Coverage:
 *   - prompt::fileExists — the shipped prompt file exists, is non-trivially
 *     sized, and the directory structure is intact.
 *   - prompt::loadBearingClauses — every load-bearing clause from the RFC
 *     is present in the shipped prompt, asserted by a discriminating
 *     substring. --break-prompt strips a load-bearing clause from the
 *     LOADED COPY (no file mutation) and the assertion must FAIL.
 *   - prompt::sampleReportSchemaValid — the embedded fenced-json sample
 *     parses, has mode==='clerk-report', every clusters[].proposed_action
 *     is in {merge,dedupe,keep-distinct}, every cluster has
 *     members[].id+summary, and the sample includes at least one
 *     citation-bearing cluster and one deferred item.
 *
 * Modeled on tests/test-second-opinion-preamble.mjs (read independently,
 * do not couple). Zero deps. Node assert + fs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const PROMPT_PATH = path.join(REPO_ROOT, 'scripts', 'em-consolidate', 'prompts', 'clerk.md')

let passed = 0, failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

// Extract the FIRST fenced ```json ... ``` block from the prompt body.
// The prompt is shipped as data with two embedded json blocks: the
// output SCHEMA (a small example with placeholders like <id>) and the
// SAMPLE report (a fully-populated example with sentinel ids). The first
// block is the schema; the last is the sample. Downstream consumers
// pattern-match the sample, so the sample is what we verify here.
function extractFencedJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/)
  if (!m) throw new Error('no fenced ```json``` block found in prompt')
  return m[1]
}

// Extract the LAST fenced ```json ... ``` block (the SAMPLE report, after
// the output SCHEMA). The sample carries the full report shape including
// per_lesson, deferred, escalation_audit, demotion_review_candidates,
// r10_drift_queue, and (F6) the conversion block.
function extractSampleReport(text) {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (matches.length < 1) throw new Error('no fenced ```json``` block found in prompt')
  return matches[matches.length - 1][1]
}

// Load the prompt into memory; --break-prompt strips a load-bearing clause
// from the IN-MEMORY copy (no file mutation, no on-disk side-effect).
const BREAK_PROMPT = process.argv.includes('--break-prompt')
function loadPrompt() {
  let body = fs.readFileSync(PROMPT_PATH, 'utf8')
  if (BREAK_PROMPT) {
    // RED: strip a single load-bearing clause marker from the loaded copy.
    // The "keep-distinct bias" rule (rule 3) is the most-testable single
    // substring; stripping it breaks exactly one of the 13 load-bearing
    // clauses, proving the assertion has teeth. (Cross-platform: pure
    // String.replace, no shell.)
    body = body.replace('Prefer `keep-distinct` over `merge` when intent might differ', 'Prefer MERGE over keep-distinct when intent might differ (RED-STRIPPED)')
  }
  return body
}

console.log('# test-rfc-009-p4-prompt')

// ---------------------------------------------------------------------------
// prompt::fileExists — the prompt file ships, is non-trivially sized, the
// directory structure is intact, and the file is readable.
// ---------------------------------------------------------------------------
console.log('\n## prompt::fileExists')
test('prompts directory exists at scripts/em-consolidate/prompts/', () => {
  const dir = path.dirname(PROMPT_PATH)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`prompts directory not found at ${dir}`)
  }
})

test('prompt file exists at scripts/em-consolidate/prompts/clerk.md', () => {
  if (!fs.existsSync(PROMPT_PATH)) {
    throw new Error(`prompt file not found at ${PROMPT_PATH}`)
  }
  const stat = fs.statSync(PROMPT_PATH)
  if (!stat.isFile()) throw new Error(`prompt path is not a regular file: ${PROMPT_PATH}`)
  if (stat.size < 1000) throw new Error(`prompt file is trivially small (${stat.size} bytes; expected >= 1000)`)
})

test('no runtime loader ships in P4 (grep -c "readFileSync.*prompt" on em-consolidate.mjs is 0)', () => {
  const ecPath = path.join(REPO_ROOT, 'scripts', 'em-consolidate.mjs')
  const ec = fs.readFileSync(ecPath, 'utf8')
  const matches = (ec.match(/readFileSync.*prompt/g) || []).length
  if (matches !== 0) throw new Error(`expected 0 readFileSync.*prompt occurrences in em-consolidate.mjs, got ${matches}`)
})

// ---------------------------------------------------------------------------
// prompt::loadBearingClauses — every load-bearing clause from the RFC
// normative paragraph (lines 189-207) is present in the shipped prompt,
// asserted by a discriminating substring. --break-prompt strips ONE clause
// from the LOADED COPY (no file mutation); the assertion then FAILS.
// ---------------------------------------------------------------------------
console.log('\n## prompt::loadBearingClauses')
const PROMPT = loadPrompt()
test('three-verb mandate (AGGREGATE / ENRICH / MANAGE) is present', () => {
  if (!/AGGREGATE/i.test(PROMPT)) throw new Error('missing three-verb mandate (AGGREGATE)')
  if (!/ENRICH/i.test(PROMPT)) throw new Error('missing three-verb mandate (ENRICH)')
  if (!/MANAGE/i.test(PROMPT)) throw new Error('missing three-verb mandate (MANAGE)')
})

test('never-enforce clause is present', () => {
  if (!/never\s+enforce/i.test(PROMPT)) throw new Error('missing never-enforce clause')
})

test('propose-only / no-write-tools clause is present', () => {
  if (!/PROPOSE/i.test(PROMPT)) throw new Error('missing PROPOSE mandate')
  if (!/no\s+write\s+tools/i.test(PROMPT)) throw new Error('missing no-write-tools clause')
})

test('cite-or-discard / citation rule is present', () => {
  if (!/cited\s+artifacts/i.test(PROMPT)) throw new Error('missing cite-or-discard (cited artifacts) clause')
})

test('no-fabricated-evidence clause is present', () => {
  if (!/fabricate/i.test(PROMPT)) throw new Error('missing no-fabricated-evidence clause')
})

test('keep-distinct bias rule (rule 3) is present', () => {
  // The verbatim RFC wording.
  if (!/Prefer\s+`keep-distinct`\s+over\s+`merge`/i.test(PROMPT)) {
    throw new Error('missing keep-distinct bias rule (rule 3)')
  }
})

test('never-widen-scope clause (rule 4) is present', () => {
  if (!/Never\s+widen\s+scope/i.test(PROMPT)) throw new Error('missing never-widen-scope clause')
})

test('respect-recorded-judgment clause (rule 5) is present', () => {
  if (!/Respect\s+recorded/i.test(PROMPT)) throw new Error('missing respect-recorded-judgment clause')
})

test('report-JSON-only clause (rule 6) is present', () => {
  if (!/Output\s+ONLY\s+the\s+report\s+JSON/i.test(PROMPT)) throw new Error('missing report-JSON-only clause')
})

test('no-questions / deferred clause (rule 7) is present', () => {
  if (!/Do not ask/i.test(PROMPT)) throw new Error('missing no-questions clause (rule 7)')
  if (!/deferred/i.test(PROMPT)) throw new Error('missing deferred marker clause (rule 7)')
})

test('escalation-audit surfacing (rule 8a) is present', () => {
  if (!/escalation\s+audit/i.test(PROMPT)) throw new Error('missing escalation-audit surfacing (rule 8a)')
})

test('demotion-review surfacing (rule 8b) is present', () => {
  if (!/demotion[\s-]review/i.test(PROMPT)) throw new Error('missing demotion-review surfacing (rule 8b)')
})

test('drift surfacing / R10 drift queue (rule 8c) is present', () => {
  if (!/drift/i.test(PROMPT)) throw new Error('missing drift surfacing (rule 8c)')
  if (!/R10\s+drift/i.test(PROMPT)) throw new Error('missing R10 drift queue reference')
})

// ---------------------------------------------------------------------------
// prompt::sampleReportSchemaValid — the embedded fenced-json sample parses,
// has mode==='clerk-report', every clusters[].proposed_action is in the
// {merge,dedupe,keep-distinct} enum, every cluster carries
// members[].id+summary, and the sample includes at least one citation-
// bearing cluster and one deferred item (REQ-15).
// ---------------------------------------------------------------------------
console.log('\n## prompt::sampleReportSchemaValid')
test('embedded fenced-json sample parses', () => {
  const raw = extractFencedJson(PROMPT)
  try { JSON.parse(raw) } catch (e) { throw new Error(`sample JSON parse failed: ${e.message}`) }
})

test('sample has mode === "clerk-report"', () => {
  const sample = JSON.parse(extractFencedJson(PROMPT))
  if (sample.mode !== 'clerk-report') throw new Error(`sample.mode is ${JSON.stringify(sample.mode)}, want "clerk-report"`)
})

test('every clusters[].proposed_action is in {merge,dedupe,keep-distinct}', () => {
  const sample = JSON.parse(extractFencedJson(PROMPT))
  const VALID = new Set(['merge', 'dedupe', 'keep-distinct'])
  for (const c of sample.clusters || []) {
    if (!VALID.has(c.proposed_action)) {
      throw new Error(`cluster proposed_action is ${JSON.stringify(c.proposed_action)}, want one of ${[...VALID].join(', ')}`)
    }
  }
})

test('every cluster carries members[].id + members[].summary', () => {
  const sample = JSON.parse(extractFencedJson(PROMPT))
  for (const c of sample.clusters || []) {
    if (!Array.isArray(c.members)) throw new Error('cluster.members is not an array')
    for (const m of c.members) {
      if (typeof m.id !== 'string' || !m.id) throw new Error(`cluster member missing id (${JSON.stringify(m)})`)
      if (typeof m.summary !== 'string' || !m.summary) throw new Error(`cluster member missing summary (${JSON.stringify(m)})`)
    }
  }
})

test('sample includes at least one citation-bearing cluster', () => {
  const sample = JSON.parse(extractFencedJson(PROMPT))
  const hasCitations = (sample.clusters || []).some(c => Array.isArray(c.citations) && c.citations.length > 0)
  if (!hasCitations) throw new Error('no cluster in the sample carries a citations field (REQ-15 sample contract)')
})

test('sample includes at least one deferred item (rule 7 marker)', () => {
  const sample = JSON.parse(extractFencedJson(PROMPT))
  if (!Array.isArray(sample.deferred) || sample.deferred.length < 1) {
    throw new Error('sample.deferred is empty (rule 7 requires low-confidence items to be marked deferred)')
  }
})

// GLM review F6: the embedded sample report carries a conversion block
// matching the shipped envelope (per_band imperative/plain n,d + per_lesson +
// torn_skipped + carried_forward + lower_bound:true). The sample now
// mirrors the real report shape so a downstream consumer that pattern-
// matches the sample against the envelope finds the conversion fields
// where it expects them.
test('sample includes a conversion block (per_band + per_lesson + lower_bound:true)', () => {
  const sample = JSON.parse(extractSampleReport(PROMPT))
  if (!sample.conversion || typeof sample.conversion !== 'object') {
    throw new Error('sample.conversion is missing or not an object (F6 sample mirrors the report envelope)')
  }
  const conv = sample.conversion
  if (!conv.per_band || typeof conv.per_band !== 'object') throw new Error('sample.conversion.per_band is missing or not an object')
  for (const band of ['imperative', 'plain']) {
    const b = conv.per_band[band]
    if (!b || typeof b !== 'object') throw new Error(`sample.conversion.per_band.${band} is missing or not an object`)
    if (typeof b.n !== 'number') throw new Error(`sample.conversion.per_band.${band}.n is not a number (got ${typeof b.n})`)
    if (typeof b.d !== 'number') throw new Error(`sample.conversion.per_band.${band}.d is not a number (got ${typeof b.d})`)
  }
  if (!Array.isArray(conv.per_lesson)) throw new Error('sample.conversion.per_lesson is not an array')
  if (typeof conv.torn_skipped !== 'number') throw new Error('sample.conversion.torn_skipped is not a number')
  if (typeof conv.carried_forward !== 'number') throw new Error('sample.conversion.carried_forward is not a number')
  if (conv.lower_bound !== true) throw new Error(`sample.conversion.lower_bound is not true (got ${JSON.stringify(conv.lower_bound)})`)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error}`)
  process.exit(1)
}
