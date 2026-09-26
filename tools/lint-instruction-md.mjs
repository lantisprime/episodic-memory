#!/usr/bin/env node
/**
 * lint-instruction-md.mjs — structural lint for agent instruction files (#203).
 *
 * Instruction files are read by agents, and a malformed one silently swallows
 * load-bearing content: an unclosed ``` fence turns every rule after it into a
 * code block (observed 2026-05-09 in ~/.claude/CLAUDE.md, lesson
 * 20260509-044459-unclosed-code-fences-in-instruction-file-d45d).
 *
 * Checks (zero-dep; no markdownlint — project rule: zero external deps):
 *   unclosed-fence     a fence that never closes              (every tracked *.md / *.mdc)
 *   fence-no-language  an opening fence with no info string   (instruction files, MD040)
 *   duplicate-heading  same text + level under the same parent (instruction files, MD024 siblings_only)
 *
 * Instruction files = CLAUDE.md, AGENTS.md, instructions/*.md|mdc, .claude/agents/*.md,
 * skills/*\/SKILL.md. This tool only READS them; it never rewrites a file.
 *
 * Usage: node tools/lint-instruction-md.mjs [--root <dir>] [file ...]
 *   With explicit files, every check runs on exactly those files.
 * Output: JSON on stdout. Exit 0 clean, 1 findings, 2 usage error.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scanMarkdown } from './lib/md.mjs'
import { isMain } from '../scripts/lib/run-direct.mjs'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const INSTRUCTION_RE = /^(CLAUDE\.md|AGENTS\.md|instructions\/[^/]+\.(md|mdc)|\.claude\/agents\/[^/]+\.md|skills\/[^/]+\/SKILL\.md)$/

/** Tracked markdown files, repo-relative. Falls back to a directory walk outside git. */
export function listMarkdown(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdc'], { cwd: root, encoding: 'utf8' })
    return out.split('\0').filter(Boolean).sort()
  } catch {
    const acc = []
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(r)
        else if (/\.(md|mdc)$/.test(e.name)) acc.push(r)
      }
    }
    walk('')
    return acc.sort()
  }
}

export function isInstructionFile(rel) {
  return INSTRUCTION_RE.test(rel.split(path.sep).join('/'))
}

/** Lint one document. `full` enables the instruction-file checks. */
export function lintText(src, { full = true } = {}) {
  const { fences, headings } = scanMarkdown(src)
  const findings = []
  for (const f of fences) {
    if (f.endLine === null) findings.push({ check: 'unclosed-fence', line: f.line, message: `fence ${f.marker} opened here never closes; everything after it renders as code` })
    else if (full && f.info === '') findings.push({ check: 'fence-no-language', line: f.line, message: 'opening fence has no language (use ```text for plain output)' })
  }
  if (full) {
    const stack = [] // stack[level] = heading text
    const seen = new Map()
    for (const h of headings) {
      stack.length = h.level
      const parent = stack.slice(1, h.level).map((t) => (t || '').toLowerCase()).join(' > ')
      const key = `${parent}\u0000${h.level}\u0000${h.text.toLowerCase()}`
      if (seen.has(key)) findings.push({ check: 'duplicate-heading', line: h.line, message: `duplicate heading "${h.text}" (first at line ${seen.get(key)}) under the same parent` })
      else seen.set(key, h.line)
      stack[h.level] = h.text
    }
  }
  return findings
}

export function lintRepo(root, files = null) {
  const explicit = Array.isArray(files) && files.length > 0
  const targets = explicit ? files : listMarkdown(root)
  const results = []
  let checked = 0
  for (const rel of targets) {
    const abs = path.resolve(root, rel)
    let src
    try {
      src = fs.readFileSync(abs, 'utf8')
    } catch (e) {
      results.push({ file: rel, check: 'unreadable', line: 0, message: e.code || String(e) })
      continue
    }
    checked++
    const full = explicit || isInstructionFile(rel)
    for (const f of lintText(src, { full })) results.push({ file: rel, ...f })
  }
  return { status: results.length ? 'fail' : 'ok', files_checked: checked, findings: results }
}

function main(argv) {
  let root = DEFAULT_ROOT
  const files = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(JSON.stringify({ status: 'help', usage: 'node tools/lint-instruction-md.mjs [--root <dir>] [file ...]', checks: ['unclosed-fence', 'fence-no-language', 'duplicate-heading'] }))
      return 0
    }
    if (a === '--root') {
      if (!argv[i + 1]) return usage('--root needs a directory')
      root = path.resolve(argv[++i])
    } else if (a.startsWith('--')) return usage(`unknown flag ${a}`)
    else files.push(a)
  }
  const report = lintRepo(root, files)
  console.log(JSON.stringify(report, null, 2))
  return report.status === 'ok' ? 0 : 1
}

function usage(message) {
  console.log(JSON.stringify({ status: 'error', message }))
  return 2
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
