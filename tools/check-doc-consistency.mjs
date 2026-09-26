#!/usr/bin/env node
/**
 * check-doc-consistency.mjs — parallel-file drift detector (#131) and
 * top-level docs vs shipped-state gate (#210).
 *
 * Reads the Rule-14 registry docs/_consistency.json. Each group names a kind:
 *
 *   delegate          run an existing validator; it must exit 0. Used where one
 *                     already owns a pair (em-rfc-validate: RFC frontmatter <->
 *                     docs/rfcs/_index.json <-> docs/rfcs/README.md).
 *   rfc-table         a markdown section's `| [RFC-NNN](link) | title | status |`
 *                     table must hold exactly the index's ids, with the index title,
 *                     a link to `<link_prefix><file>`, and a status whose first word
 *                     is the index status.
 *   script-inventory  every <scripts_dir>/*.mjs basename appears in the section, or
 *                     is named in `internal` with a reason; every internal name exists.
 *   hook-gates        the section names (as `**X-gate**` bullets) exactly the *-gate.sh
 *                     hooks in the manifest's HOOK_SPECS, and its "**N installed gates:**"
 *                     count matches.
 *   same-line         each file has exactly one line matching `pattern`; all are identical.
 *
 * Advisory only: it reports drift, it never rewrites a doc.
 *
 * Usage: node tools/check-doc-consistency.mjs [--root <dir>] [--config <path>]
 * Output: JSON on stdout. Exit 0 consistent, 1 drift, 2 usage/config error.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanMarkdown } from './lib/md.mjs'
import { isMain } from '../scripts/lib/run-direct.mjs'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** Lines of the level-2 section whose heading text is exactly `title` (fenced lines kept). */
export function sectionLines(src, title) {
  const { lines, headings } = scanMarkdown(src)
  const i = headings.findIndex((h) => h.level === 2 && h.text === title)
  if (i < 0) return null
  const next = headings.slice(i + 1).find((h) => h.level <= 2)
  return lines.slice(headings[i].line, next ? next.line - 1 : lines.length)
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')

function needSection(root, g) {
  const lines = sectionLines(read(root, g.file), g.section)
  if (!lines) throw new Error(`${g.file}: no "## ${g.section}" section`)
  return lines
}

const CHECKS = {
  delegate(root, g) {
    const [script, ...args] = g.command
    const r = spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8' })
    if (r.status === 0) return []
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(0, 5).join(' / ')
    return [`${script} exited ${r.status}: ${out}`]
  },

  'rfc-table'(root, g) {
    const index = JSON.parse(read(root, g.index)).rfcs
    const rows = new Map()
    const drift = []
    for (const l of needSection(root, g)) {
      const m = l.match(/^\|\s*\[(RFC-\d+)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/)
      if (!m) continue
      if (rows.has(m[1])) drift.push(`${g.file}: ${m[1]} appears twice`)
      rows.set(m[1], { link: m[2], title: m[3], status: m[4] })
    }
    for (const r of index) {
      const row = rows.get(r.id)
      if (!row) {
        drift.push(`${g.file}: ${r.id} (${r.status}) is in ${g.index} but missing from the table`)
        continue
      }
      if (row.title !== r.title) drift.push(`${g.file}: ${r.id} title "${row.title}" != index "${r.title}"`)
      const status = row.status.split(/[\s(]/)[0].toLowerCase()
      if (status !== r.status) drift.push(`${g.file}: ${r.id} status "${row.status}" != index "${r.status}"`)
      if (row.link !== `${g.link_prefix}${r.file}`) drift.push(`${g.file}: ${r.id} links "${row.link}", expected "${g.link_prefix}${r.file}"`)
    }
    const ids = new Set(index.map((r) => r.id))
    for (const id of rows.keys()) if (!ids.has(id)) drift.push(`${g.file}: ${id} is in the table but not in ${g.index}`)
    return drift
  },

  'script-inventory'(root, g) {
    const text = needSection(root, g).join('\n')
    const internal = g.internal || {}
    const onDisk = fs.readdirSync(path.join(root, g.scripts_dir), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.mjs')).map((e) => e.name).sort()
    const drift = []
    const has = (name) => new RegExp(`(^|[^\\w.-])${name.replace(/[.]/g, '\\.')}(?![\\w-])`).test(text)
    for (const name of onDisk) {
      if (!has(name) && !(name in internal)) drift.push(`${g.scripts_dir}/${name} is neither documented in ${g.file} "## ${g.section}" nor listed as internal in the registry`)
    }
    for (const name of Object.keys(internal)) {
      if (!onDisk.includes(name)) drift.push(`internal entry ${name} does not exist in ${g.scripts_dir}/ (delete it from the registry)`)
      if (!String(internal[name]).trim()) drift.push(`internal entry ${name} has no reason`)
    }
    return drift
  },

  async 'hook-gates'(root, g) {
    const mod = await import(pathToFileURL(path.join(root, g.manifest)).href)
    const gates = [...new Set(mod.HOOK_SPECS.map((s) => s.file).filter((f) => /-gate\.sh$/.test(f)))].map((f) => f.replace(/\.sh$/, '')).sort()
    const lines = needSection(root, g)
    const named = [...new Set(lines.map((l) => l.match(/^\s*[-*]\s+\*\*([A-Za-z-]+-gate)\*\*/i)).filter(Boolean).map((m) => m[1].toLowerCase()))].sort()
    const drift = []
    for (const x of gates) if (!named.includes(x)) drift.push(`${g.file}: installed gate ${x} (${g.manifest} HOOK_SPECS) is not listed`)
    for (const x of named) if (!gates.includes(x)) drift.push(`${g.file}: lists ${x}, which ${g.manifest} HOOK_SPECS does not install`)
    const count = lines.join('\n').match(/\*\*(\w+) installed gates:\*\*/i)
    if (!count) drift.push(`${g.file}: no "**<N> installed gates:**" statement in the section`)
    else {
      const w = count[1].toLowerCase()
      const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS.indexOf(w)
      if (n !== gates.length) drift.push(`${g.file}: says "${count[1]} installed gates" but ${gates.length} are installed (${gates.join(', ')})`)
    }
    return drift
  },

  'same-line'(root, g) {
    const re = new RegExp(g.pattern)
    const found = []
    const drift = []
    for (const f of g.files) {
      const hits = read(root, f).split('\n').map((l, i) => ({ l: l.trim(), n: i + 1 })).filter((x) => re.test(x.l))
      if (hits.length !== 1) drift.push(`${f}: expected exactly 1 line matching /${g.pattern}/, found ${hits.length}`)
      else found.push({ f, ...hits[0] })
    }
    for (const x of found.slice(1)) {
      if (x.l !== found[0].l) drift.push(`${x.f}:${x.n} "${x.l}" differs from ${found[0].f}:${found[0].n} "${found[0].l}"`)
    }
    return drift
  },
}

export async function checkConsistency(root, config) {
  const groups = []
  for (const g of config.groups) {
    const fn = CHECKS[g.kind]
    let drift
    if (!fn) drift = [`unknown kind "${g.kind}"`]
    else {
      try {
        drift = await fn(root, g)
      } catch (e) {
        drift = [`check failed: ${e.message}`]
      }
    }
    groups.push({ id: g.id, kind: g.kind, status: drift.length ? 'drift' : 'ok', drift })
  }
  return { status: groups.some((g) => g.status !== 'ok') ? 'fail' : 'ok', groups }
}

async function main(argv) {
  let root = DEFAULT_ROOT
  let config = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      console.log(JSON.stringify({ status: 'help', usage: 'node tools/check-doc-consistency.mjs [--root <dir>] [--config <path>]', kinds: Object.keys(CHECKS) }))
      return 0
    }
    if (a === '--root' && argv[i + 1]) root = path.resolve(argv[++i])
    else if (a === '--config' && argv[i + 1]) config = path.resolve(argv[++i])
    else {
      console.log(JSON.stringify({ status: 'error', message: `unknown argument ${a}` }))
      return 2
    }
  }
  config = config || path.join(root, 'docs', '_consistency.json')
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(config, 'utf8'))
    if (!Array.isArray(parsed.groups)) throw new Error('"groups" must be an array')
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', config, message: e.message }))
    return 2
  }
  const report = await checkConsistency(root, parsed)
  console.log(JSON.stringify(report, null, 2))
  return report.status === 'ok' ? 0 : 1
}

if (isMain(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code })
