#!/usr/bin/env node
/**
 * check-doc-snippets.mjs — docs-PR validation (#130).
 *
 * Docs-only PRs run no code, so a doc can ship a command that silently does the
 * wrong thing: PR #122 put `em-search --tags workplan` in CLAUDE.md, the script
 * ignored the unknown flag, and the discovery instruction returned the wrong
 * episode. Two checks:
 *
 *  1. flags   Every `node scripts/<x>.mjs ...` command in a code block or inline
 *             code span (also the installed `~/.episodic-memory/scripts/<x>.mjs`
 *             spelling) must name a script that exists, and every `--flag` it
 *             passes must appear in that script's own `--help` output. `--help`
 *             is run once per script with HOME and cwd pointed at a throwaway
 *             temp dir. A flag missing from `--help` but parsed by the script
 *             (a '--flag' string literal in its source) is a script-side help
 *             gap: reported under `help_gaps`, not failed. A flag in neither is
 *             the #122 class and fails. A script whose `--help` exits non-zero
 *             or lists no flags is reported under `unverifiable`, not failed.
 *  2. anchors Every relative markdown link carrying a `#fragment` must point at a
 *             file that exists and, for a markdown target, at a heading anchor
 *             (GitHub slug rules, tools/lib/md.mjs) or explicit <a id|name>.
 *
 * Scope: tracked *.md / *.mdc, minus docs/plans/** (historical, and plans cite
 * flags they are about to add) and docs/rfcs/archived/**. docs/rfcs/** is
 * anchor-checked only: an RFC specifies proposed and unbuilt surfaces (draft
 * scripts, review-table hypotheticals), so its commands are not flag-checked.
 *
 * Usage: node tools/check-doc-snippets.mjs [--root <dir>] [file ...]
 * Output: JSON on stdout. Exit 0 clean, 1 findings, 2 usage error.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scanMarkdown, anchorsOf } from './lib/md.mjs'
import { listMarkdown } from './lint-instruction-md.mjs'
import { isMain } from '../scripts/lib/run-direct.mjs'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXCLUDE_RE = /^(docs\/plans\/|docs\/rfcs\/archived\/)/
const ANCHORS_ONLY_RE = /^docs\/rfcs\//
const CMD_RE = /\bnode\s+(?:\.\/)?(?:(?:~|\$HOME|\$\{HOME\})\/\.episodic-memory\/)?scripts\/([\w.-]+\.mjs)\b([^`]*)/g
const FLAG_RE = /^--([A-Za-z][\w-]*)(?:=.*)?$/

/** The argument words of one command: up to the first shell separator or comment. */
function commandArgs(rest) {
  const seg = rest.split(/\s(?:\|\|?|;|&&|#|>|2>|<)\s|\s(?:\||;|&&)$|;/)[0]
  return seg.split(/\s+/).filter(Boolean)
}

/** Commands in fenced code (with `\` continuations joined) and inline code spans. */
export function extractCommands(src) {
  const { lines, fenced } = scanMarkdown(src)
  const out = []
  const scanText = (text, line) => {
    for (const m of text.matchAll(CMD_RE)) {
      const flags = commandArgs(m[2]).map((w) => w.match(FLAG_RE)).filter(Boolean).map((f) => `--${f[1]}`)
      out.push({ line, script: m[1], flags })
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i + 1)) {
      let text = lines[i]
      const start = i + 1
      while (/\\\s*$/.test(text) && i + 1 < lines.length && fenced.has(i + 2)) text = text.replace(/\\\s*$/, ' ') + lines[++i]
      scanText(text, start)
    } else {
      for (const span of lines[i].matchAll(/(`+)(?!`)(.+?)(?<!`)\1(?!`)/g)) scanText(span[2], i + 1)
    }
  }
  return out
}

/** Relative links with a #fragment, outside code. */
export function extractAnchorLinks(src) {
  const { lines, fenced } = scanMarkdown(src)
  const out = []
  lines.forEach((l, i) => {
    if (fenced.has(i + 1)) return
    const prose = l.replace(/(`+)(?!`).+?(?<!`)\1(?!`)/g, '')
    for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]*#[^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue
      const hash = m[1].indexOf('#')
      out.push({ line: i + 1, target: m[1].slice(0, hash), fragment: m[1].slice(hash + 1) })
    }
  })
  return out
}

export function makeHelpReader(root) {
  const cache = new Map()
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-snippets-'))
  const read = (script) => {
    if (cache.has(script)) return cache.get(script)
    const file = path.join(root, 'scripts', script)
    let entry
    if (!fs.existsSync(file)) entry = { exists: false }
    else {
      const home = fs.mkdtempSync(path.join(scratch, 'home-'))
      const cwd = fs.mkdtempSync(path.join(scratch, 'cwd-'))
      const r = spawnSync(process.execPath, [file, '--help'], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] })
      const text = `${r.stdout || ''}\n${r.stderr || ''}`
      const flags = new Set([...text.matchAll(/--([A-Za-z][\w-]*)/g)].map((m) => `--${m[1]}`))
      const parsed = new Set([...fs.readFileSync(file, 'utf8').matchAll(/['"`]--([A-Za-z][\w-]*)/g)].map((m) => `--${m[1]}`))
      entry = r.status === 0 && flags.size > 0 ? { exists: true, usable: true, flags, parsed } : { exists: true, usable: false, reason: r.status === 0 ? '--help lists no flags' : `--help exited ${r.status ?? r.signal}` }
    }
    cache.set(script, entry)
    return entry
  }
  read.cleanup = () => fs.rmSync(scratch, { recursive: true, force: true })
  return read
}

export function checkDocs(root, files = null) {
  const targets = files && files.length ? files : listMarkdown(root).filter((f) => !EXCLUDE_RE.test(f))
  const help = makeHelpReader(root)
  const findings = []
  const unverifiable = new Map()
  const helpGaps = new Map()
  let commands = 0
  let links = 0
  const anchorCache = new Map()
  try {
    for (const rel of targets) {
      const abs = path.resolve(root, rel)
      const src = fs.readFileSync(abs, 'utf8')
      for (const c of ANCHORS_ONLY_RE.test(rel) ? [] : extractCommands(src)) {
        commands++
        const h = help(c.script)
        if (!h.exists) {
          findings.push({ file: rel, line: c.line, check: 'missing-script', message: `scripts/${c.script} does not exist` })
          continue
        }
        if (!h.usable) {
          if (c.flags.length) unverifiable.set(c.script, h.reason)
          continue
        }
        for (const f of c.flags) {
          if (f === '--help' || h.flags.has(f)) continue
          if (h.parsed.has(f)) {
            const k = `scripts/${c.script} ${f}`
            if (!helpGaps.has(k)) helpGaps.set(k, [])
            helpGaps.get(k).push(`${rel}:${c.line}`)
            continue
          }
          findings.push({ file: rel, line: c.line, check: 'unknown-flag', message: `${f} is not in \`node scripts/${c.script} --help\`` })
        }
      }
      for (const l of extractAnchorLinks(src)) {
        links++
        const targetAbs = l.target ? path.resolve(path.dirname(abs), decodeURI(l.target)) : abs
        if (!fs.existsSync(targetAbs)) {
          findings.push({ file: rel, line: l.line, check: 'missing-link-target', message: `${l.target} does not exist` })
          continue
        }
        if (!/\.(md|mdc)$/i.test(targetAbs) || fs.statSync(targetAbs).isDirectory()) continue
        if (!anchorCache.has(targetAbs)) anchorCache.set(targetAbs, anchorsOf(fs.readFileSync(targetAbs, 'utf8')))
        let frag = l.fragment
        try { frag = decodeURIComponent(frag) } catch {}
        if (!anchorCache.get(targetAbs).has(frag.toLowerCase())) {
          findings.push({ file: rel, line: l.line, check: 'missing-anchor', message: `#${l.fragment} is not a heading anchor in ${path.relative(root, targetAbs) || rel}` })
        }
      }
    }
  } finally {
    help.cleanup()
  }
  return {
    status: findings.length ? 'fail' : 'ok',
    files_checked: targets.length,
    commands_checked: commands,
    anchor_links_checked: links,
    unverifiable: [...unverifiable].map(([script, reason]) => ({ script: `scripts/${script}`, reason })),
    help_gaps: [...helpGaps].map(([k, at]) => ({ flag: k, note: 'parsed by the script but missing from its --help', used_at: at })),
    findings,
  }
}

function main(argv) {
  let root = DEFAULT_ROOT
  const files = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(JSON.stringify({ status: 'help', usage: 'node tools/check-doc-snippets.mjs [--root <dir>] [file ...]', checks: ['missing-script', 'unknown-flag', 'missing-link-target', 'missing-anchor'] }))
      return 0
    }
    if (a === '--root' && argv[i + 1]) root = path.resolve(argv[++i])
    else if (a.startsWith('--')) {
      console.log(JSON.stringify({ status: 'error', message: `unknown flag ${a}` }))
      return 2
    } else files.push(a)
  }
  const report = checkDocs(root, files)
  console.log(JSON.stringify(report, null, 2))
  return report.status === 'ok' ? 0 : 1
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
