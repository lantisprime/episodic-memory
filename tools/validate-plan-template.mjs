#!/usr/bin/env node
/**
 * validate-plan-template.mjs — mechanical plan-conformance validator (#453).
 *
 * A manually-run AUTHORING tool: run it on a plan BEFORE dispatching any review.
 * It is NOT a hook and NOT a CI gate on plans (operator-locked 2026-06-28: no
 * plan-template linter in CI). Only its own self-test runs in CI.
 *
 * Everything template-derived is read from docs/PLAN_TEMPLATE.md at run time
 * (section set + order, the §A.1 grep), so the template stays the single source.
 *
 * Checks (each failure is named; exit 1 if any):
 *  1. sections        — `## §N` / `## A.N` headers vs the template's mandatory set for
 *                       the plan's declared §0.1 altitude (low = §1-§20 + A.0-A.9 incl.
 *                       A.6b; high / human = §1-§20), order-checked. A mandatory section
 *                       whose body is empty, or is a short pointer back to the template
 *                       ("see PLAN_TEMPLATE §A.2"), fails: a pointer is not the section.
 *  2. forbidden-phrase — the template's §A.1 grep, scoped by its own acceptance rule:
 *                       a match fails only inside the §A.5 block or an §A.7 step row.
 *  3. a7-cells        — every EDIT row references an ANCHOR + REPLACE pair (named fenced
 *                       artifacts `X-ANCHOR`/`X-REPLACE`, a `Listing Ln` holding both, or
 *                       inline ANCHOR `..` → REPLACE `..`); every CREATE row references a
 *                       fenced artifact introduced as its "entire contents"; no action cell
 *                       (outside code spans) says "assert that", "verify that", "check
 *                       that", "ensure", "implementing … exactly" or "the N assertions".
 *  4. verify          — (A.6b) every EDIT/CREATE/APPEND Verify cell names an expected value
 *                       (`→`), has no tolerant pattern (`|| true`, `test $? -ne`,
 *                       `&& echo ok`), and does not grep for a string that the step's own
 *                       REPLACE/CREATE code block carries only in comment or echo lines
 *                       (prose blocks — markdown/text — are exempt: their lines are the deliverable).
 *
 * Usage: node tools/validate-plan-template.mjs <plan.md> [--template <path>]
 * Output: JSON on stdout. Exit 0 conformant, 1 failures, 2 usage error.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanMarkdown } from './lib/md.mjs'
import { sections, templateSectionKeys, forbiddenPattern } from './lib/plan-template.mjs'
import { isMain } from '../scripts/lib/run-direct.mjs'

const DEFAULT_TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'PLAN_TEMPLATE.md')

const POINTER_RE = /PLAN_TEMPLATE|\b(?:see|per|as in|copied from|verbatim from|unchanged from|same as)\b[^.\n]*\btemplate\b/i
const INTENT_RE = /\b(assert that|verify that|check that|ensure[sd]?)\b/i
const PROSE_SUMMARY_RES = [/\bimplement(?:s|ing|ed)?\b[^|]*?\bexactly\b/i, /\bthe \d+ assertions\b/i]
const TOLERANT_RE = /\|\|\s*true\b|\btest \$\? -ne\b|&&\s*echo ok\b/
const LISTING_REF_RE = /\bListing\s+(L\d+[a-z]?)\b/g // same grammar as scripts/validate-plan-listing-discipline.mjs
const LISTING_HEAD_RE = /\bListing\s+(L\d+[a-z]?)\b/
const COMMENT_START_RE = /^\s*(?:\/\/|#|\/\*|\*|<!--|--\s)/
const COMMENT_PREFIX_RE = /\/\/|(?:^|\s)#|\/\*|<!--|\becho\b|console\.log\(/

/** True when `needle` sits in the comment / echo part of `line`, not in its code. */
function inCommentOrEcho(line, needle) {
  if (COMMENT_START_RE.test(line)) return true
  return COMMENT_PREFIX_RE.test(line.slice(0, line.indexOf(needle)))
}

/** §0.1 altitude declared in the plan (a row or line mentioning "altitude"), default low. */
export function declaredAltitude(src) {
  for (const l of src.split('\n')) {
    if (!/altitude/i.test(l)) continue
    const m = l.match(/`(low|high|human)`/i) || l.match(/\|\s*\**(low|high|human)\b/i)
    if (m) return { altitude: m[1].toLowerCase(), source: 'declared' }
  }
  return { altitude: 'low', source: 'default (§0.1: Default = low)' }
}

export function requiredKeys(templateKeys, altitude) {
  return altitude === 'low' ? templateKeys : templateKeys.filter((k) => k.startsWith('§'))
}

function splitRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
  return cells.map((c) => c.replace(/\\\|/g, '|').trim())
}

const stripCode = (s) => s.replace(/`[^`]*`/g, '``')
const normKind = (s) => s.replace(/[*`]/g, '').trim().toUpperCase()

/** Named fenced artifacts (`NAME`: + fence) and `Listing Ln` sections with their fences. */
export function collectArtifacts(scan) {
  const { lines, fences, headings } = scan
  const byStart = new Map(fences.map((f) => [f.line, f]))
  const content = (f) => lines.slice(f.line, (f.endLine || lines.length) - 1).join('\n')
  const named = new Map()
  for (let i = 0; i < lines.length; i++) {
    if (scan.fenced.has(i + 1)) continue
    const m = lines[i].match(/^\s*(?:\*\*)?`([A-Za-z0-9][\w.-]*)`(?:\*\*)?(.*)$/)
    if (!m || !/:\s*$/.test(m[2]) && !/^\s*(?:—|-|\()/.test(m[2])) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    const f = byStart.get(j + 1)
    if (f) named.set(m[1], { line: i + 1, intro: lines[i], info: f.info, content: content(f) })
  }
  const listings = new Map()
  headings.forEach((h, idx) => {
    const m = h.text.match(LISTING_HEAD_RE)
    if (!m) return
    const next = headings.slice(idx + 1).find((x) => x.level <= h.level)
    const end = next ? next.line - 1 : lines.length
    const blocks = fences
      .filter((f) => f.line > h.line && f.line <= end)
      .map((f) => {
        let k = f.line - 2
        while (k > h.line - 1 && lines[k].trim() === '') k--
        return { intro: lines[k] || '', info: f.info, content: content(f) }
      })
    listings.set(m[1], { line: h.line, text: lines.slice(h.line - 1, end).join('\n'), blocks })
  })
  return { named, listings }
}

/** Step rows of every table inside §A.7, with column roles from the header row. */
export function a7Rows(scan, a7) {
  const rows = []
  let cols = null
  for (let n = a7.bodyStart; n <= a7.bodyEnd; n++) {
    const line = scan.lines[n - 1]
    if (scan.fenced.has(n) || !/^\s*\|/.test(line)) {
      cols = /^\s*\|/.test(line) ? cols : null
      continue
    }
    const cells = splitRow(line)
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
    const kindIdx = cells.findIndex((c) => /^kind$/i.test(c))
    if (kindIdx >= 0) {
      cols = {
        kind: kindIdx,
        action: cells.findIndex((c) => /^exact action/i.test(c)),
        verify: cells.findIndex((c) => /^verify/i.test(c)),
      }
      continue
    }
    if (!cols) continue
    rows.push({ line: n, step: cells[0], kind: normKind(cells[cols.kind] || ''), action: cells[cols.action] || '', verify: cells[cols.verify] || '' })
  }
  return rows
}

function checkSections(src, templateKeys, altitude, scan, list, fail) {
  const required = requiredKeys(templateKeys, altitude)
  const found = new Map()
  for (const s of list) if (!found.has(s.key)) found.set(s.key, s)
  for (const k of required) if (!found.has(k)) fail('sections', 0, `missing mandatory section ${k} (altitude ${altitude})`)
  const order = [...found.keys()].filter((k) => templateKeys.includes(k))
  for (let i = 1; i < order.length; i++) {
    if (templateKeys.indexOf(order[i]) < templateKeys.indexOf(order[i - 1])) {
      fail('sections', found.get(order[i]).line, `section ${order[i]} appears after ${order[i - 1]}; template order puts it before`)
    }
  }
  for (const k of required) {
    const s = found.get(k)
    if (!s) continue
    const body = scan.lines.slice(s.bodyStart - 1, s.bodyEnd).filter((l) => l.trim() !== '' && l.trim() !== '---')
    const hasStructure = body.some((l, i) => /^\s*\|/.test(l) || scan.fenced.has(s.bodyStart + i) || /^#{3,}\s/.test(l))
    if (body.length === 0) fail('sections', s.line, `section ${k} is empty`)
    else if (!hasStructure && body.length <= 3 && POINTER_RE.test(body.join(' '))) {
      fail('sections', s.line, `section ${k} is a pointer to the template, not its content: "${body.join(' ').slice(0, 120)}"`)
    }
  }
}

function checkForbidden(templateSrc, scan, list, rows, fail) {
  const re = new RegExp(forbiddenPattern(templateSrc), 'i')
  const a5 = list.find((s) => s.key === 'A.5')
  const lines = new Set(rows.map((r) => r.line))
  if (a5) for (let n = a5.bodyStart; n <= a5.bodyEnd; n++) lines.add(n)
  for (const n of [...lines].sort((a, b) => a - b)) {
    const text = scan.lines[n - 1]
    const inA5 = a5 && n >= a5.bodyStart && n <= a5.bodyEnd
    // §A.1 caveat: a phrase can wrap across two lines. The joined pair counts only
    // when neither line matches alone, so a phrase is reported once, on its first line.
    const next = inA5 && n < a5.bodyEnd ? scan.lines[n] : ''
    const m = text.match(re) || (next && !re.test(next) ? `${text} ${next}`.match(re) : null)
    if (m) fail('forbidden-phrase', n, `§A.1 forbidden phrase "${m[0]}" inside ${inA5 ? 'the §A.5 block' : 'an §A.7 step row'}`)
  }
}

function stepArtifacts(row, arts) {
  const refs = [...row.action.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((n) => arts.named.has(n))
  const listings = [...row.action.matchAll(LISTING_REF_RE)].map((m) => m[1]).filter((id) => arts.listings.has(id))
  return { refs, listings }
}

function checkCells(rows, arts, fail) {
  for (const r of rows) {
    const bare = stripCode(r.action)
    const intent = bare.match(INTENT_RE)
    if (intent) fail('a7-cells', r.line, `step ${r.step}: action cell describes intent ("${intent[1]}") instead of the exact change`)
    for (const re of PROSE_SUMMARY_RES) {
      const m = bare.match(re)
      if (m) fail('a7-cells', r.line, `step ${r.step}: action cell is a prose summary ("${m[0].slice(0, 60)}")`)
    }
    const { refs, listings } = stepArtifacts(r, arts)
    if (r.kind === 'EDIT') {
      const named = refs.some((n) => /ANCHOR/i.test(n)) && refs.some((n) => /REPLACE/i.test(n))
      const listed = listings.some((id) => {
        const b = arts.listings.get(id).blocks
        return b.some((x) => /ANCHOR/i.test(x.intro)) && b.some((x) => /REPLACE/i.test(x.intro))
      })
      const inline = /ANCHOR\W*`[^`]+`[\s\S]*REPLACE\W*`[^`]+`/i.test(r.action)
      if (!named && !listed && !inline) fail('a7-cells', r.line, `step ${r.step}: EDIT row references no fenced ANCHOR/REPLACE artifact pair`)
    } else if (r.kind === 'CREATE') {
      const entire = (t) => /entire contents/i.test(t)
      const ok =
        refs.some((n) => entire(r.action) || entire(arts.named.get(n).intro)) ||
        listings.some((id) => arts.listings.get(id).blocks.length && (entire(r.action) || entire(arts.listings.get(id).text)))
      if (!ok) fail('a7-cells', r.line, `step ${r.step}: CREATE row references no fenced block introduced as the file's entire contents`)
    }
  }
}

// Only CODE blocks: in a prose block (markdown/text) a `#` line is a heading or
// doc content the step delivers, so grepping it is a legitimate Verify.
const PROSE_INFO_RE = /^(?:$|markdown\b|md\b|text\b|txt\b|plain)/i

function replaceBlocks(row, arts) {
  const { refs, listings } = stepArtifacts(row, arts)
  const picked = refs.filter((n) => row.kind === 'CREATE' || /REPLACE/i.test(n)).map((n) => arts.named.get(n))
  for (const id of listings) for (const b of arts.listings.get(id).blocks) if (row.kind === 'CREATE' || /REPLACE/i.test(b.intro)) picked.push(b)
  return picked.filter((b) => !PROSE_INFO_RE.test(b.info)).map((b) => b.content)
}

function checkVerify(rows, arts, fail) {
  for (const r of rows) {
    if (!['EDIT', 'CREATE', 'APPEND'].includes(r.kind)) continue
    if (!r.verify.includes('→')) fail('verify', r.line, `step ${r.step}: Verify names no expected value (no "→ <expected>")`)
    const tol = r.verify.match(TOLERANT_RE)
    if (tol) fail('verify', r.line, `step ${r.step}: Verify uses a tolerant pattern ("${tol[0]}") a no-op passes`)
    const blocks = replaceBlocks(r, arts)
    for (const m of r.verify.matchAll(/grep\s+(?:-[A-Za-z]+\s+)*(["'])(.+?)\1/g)) {
      const needle = m[2].replace(/\\(.)/g, '$1')
      const hits = blocks.flatMap((b) => b.split('\n')).filter((l) => l.includes(needle))
      if (hits.length && hits.every((l) => inCommentOrEcho(l, needle))) {
        fail('verify', r.line, `step ${r.step}: Verify greps "${needle.slice(0, 60)}", which the step's own block carries only in comment/echo lines (self-fulfilling)`)
      }
    }
  }
}

export function validatePlan(planSrc, templateSrc) {
  const failures = []
  const fail = (check, line, message) => failures.push({ check, line, message })
  const templateKeys = templateSectionKeys(templateSrc)
  const { altitude, source } = declaredAltitude(planSrc)
  const { scan, sections: list } = sections(planSrc)
  checkSections(planSrc, templateKeys, altitude, scan, list, fail)
  const a7 = list.find((s) => s.key === 'A.7')
  const rows = a7 ? a7Rows(scan, a7) : []
  const arts = collectArtifacts(scan)
  checkForbidden(templateSrc, scan, list, rows, fail)
  checkCells(rows, arts, fail)
  checkVerify(rows, arts, fail)
  failures.sort((a, b) => a.line - b.line)
  return {
    status: failures.length ? 'fail' : 'ok',
    altitude,
    altitude_source: source,
    counts: { sections: list.length, a7_rows: rows.length, named_artifacts: arts.named.size, listings: arts.listings.size },
    failures,
  }
}

function main(argv) {
  let template = DEFAULT_TEMPLATE
  let plan = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(JSON.stringify({ status: 'help', usage: 'node tools/validate-plan-template.mjs <plan.md> [--template <path>]', checks: ['sections', 'forbidden-phrase', 'a7-cells', 'verify'] }))
      return 0
    }
    if (a === '--template' && argv[i + 1]) template = path.resolve(argv[++i])
    else if (!a.startsWith('--') && plan === null) plan = a
    else return usage(`unexpected argument ${a}`)
  }
  if (!plan) return usage('a plan path is required')
  let planSrc, templateSrc
  try {
    planSrc = fs.readFileSync(plan, 'utf8')
    templateSrc = fs.readFileSync(template, 'utf8')
  } catch (e) {
    return usage(e.message)
  }
  const report = validatePlan(planSrc, templateSrc)
  console.log(JSON.stringify({ plan, ...report }, null, 2))
  return report.status === 'ok' ? 0 : 1
}

function usage(message) {
  console.log(JSON.stringify({ status: 'error', message }))
  return 2
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
