#!/usr/bin/env node
/**
 * check-plan-template-sync.mjs — keep docs/PLAN_TEMPLATE.md's forbidden-phrase
 * lists in sync (#438, Rule 14: drift-prone dual state gets a validator).
 *
 * The §A.1 grep pattern is the single source of the forbidden-phrase list.
 * This CI check fails when any other copy in the template disagrees with it:
 *   - the §A.1 prose sentence ("The plan is not executor-ready if any step
 *     contains: `decide`, ...") must list exactly the grep's phrases;
 *   - §0.2 defers to §A.1 and carries no list; if a double-quoted list is ever
 *     re-added there, it must equal the grep's phrases too.
 *
 * This lints the TEMPLATE, not plans (plans are never CI-gated; see #453).
 *
 * Usage: node tools/check-plan-template-sync.mjs [--template <path>]
 * Output: JSON on stdout. Exit 0 in sync, 1 drift, 2 usage/parse error.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { forbiddenPattern, patternPhrases, a1ProsePhrases, tripwirePhrases } from './lib/plan-template.mjs'
import { isMain } from '../scripts/lib/run-direct.mjs'

const DEFAULT_TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'PLAN_TEMPLATE.md')

function diff(source, copy) {
  const s = new Set(source)
  const c = new Set(copy)
  return { missing: source.filter((p) => !c.has(p)), extra: copy.filter((p) => !s.has(p)) }
}

export function checkSync(templateSrc) {
  const grep = patternPhrases(forbiddenPattern(templateSrc))
  const copies = [
    { copy: '§A.1 prose list', phrases: a1ProsePhrases(templateSrc), required: true },
    { copy: '§0.2 tripwire list', phrases: tripwirePhrases(templateSrc), required: false },
  ]
  const drift = []
  for (const c of copies) {
    if (!c.required && c.phrases.length === 0) continue
    const d = diff(grep, c.phrases)
    if (d.missing.length || d.extra.length) drift.push({ copy: c.copy, missing_vs_grep: d.missing, extra_vs_grep: d.extra })
  }
  return { status: drift.length ? 'fail' : 'ok', source: '§A.1 grep pattern', phrases: grep, drift }
}

function main(argv) {
  let template = DEFAULT_TEMPLATE
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--template' && argv[i + 1]) template = path.resolve(argv[++i])
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(JSON.stringify({ status: 'help', usage: 'node tools/check-plan-template-sync.mjs [--template <path>]' }))
      return 0
    } else {
      console.log(JSON.stringify({ status: 'error', message: `unknown argument ${argv[i]}` }))
      return 2
    }
  }
  let report
  try {
    report = checkSync(fs.readFileSync(template, 'utf8'))
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', template, message: e.message }))
    return 2
  }
  console.log(JSON.stringify({ template: path.relative(process.cwd(), template) || template, ...report }, null, 2))
  return report.status === 'ok' ? 0 : 1
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
