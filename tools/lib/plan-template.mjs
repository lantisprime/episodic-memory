// plan-template.mjs — zero-dep readers for docs/PLAN_TEMPLATE.md structure,
// shared by tools/validate-plan-template.mjs (#453) and
// tools/check-plan-template-sync.mjs (#438). The template is the single source:
// section keys, their order, and the §A.1 forbidden-phrase grep are read from
// it, never restated here.

import { scanMarkdown } from './md.mjs'

/** `§12 Contracts` → `§12`; `A.6b Falsifiable Verify` → `A.6b`; anything else → null. */
export function sectionKey(headingText) {
  const m = String(headingText).match(/^(§\d+|A\.\d+b?)(?=[\s:—-]|$)/)
  return m ? m[1] : null
}

/**
 * Level-2 sections keyed by §N / A.N, in document order.
 * Each: { key, line, text, bodyStart, bodyEnd } — body lines are 1-based, inclusive,
 * and run to the line before the next heading of level <= 2.
 */
export function sections(src) {
  const scan = scanMarkdown(src)
  const top = scan.headings.filter((h) => h.level <= 2)
  const out = []
  top.forEach((h, i) => {
    const key = h.level === 2 ? sectionKey(h.text) : null
    if (!key) return
    const next = top[i + 1]
    out.push({ key, line: h.line, text: h.text, bodyStart: h.line + 1, bodyEnd: next ? next.line - 1 : scan.lines.length })
  })
  return { scan, sections: out }
}

export function sectionBody(src, key) {
  const { scan, sections: list } = sections(src)
  const s = list.find((x) => x.key === key)
  if (!s) return null
  return { ...s, lines: scan.lines.slice(s.bodyStart - 1, s.bodyEnd), scan }
}

/** The mandatory plan sections, in template order: §1..§N then A.*; §0 (how-to-use) excluded. */
export function templateSectionKeys(templateSrc) {
  return sections(templateSrc).sections.map((s) => s.key).filter((k) => k !== '§0')
}

/** The pattern inside the §A.1 `grep -niE "<pattern>"` command. */
export function forbiddenPattern(templateSrc) {
  const a1 = sectionBody(templateSrc, 'A.1')
  if (!a1) throw new Error('PLAN_TEMPLATE: no ## A.1 section')
  for (const l of a1.lines) {
    const m = l.match(/grep\s+-[a-zA-Z]*E[a-zA-Z]*\s+"([^"]+)"/)
    if (m) return m[1]
  }
  throw new Error('PLAN_TEMPLATE: §A.1 has no grep -E "<pattern>" line')
}

/** `\betc\.` → `etc.`; lowercased; the canonical spelling of one alternative. */
export function normalizePhrase(p) {
  return String(p).replace(/\\b/g, '').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function patternPhrases(pattern) {
  return pattern.split('|').map(normalizePhrase).filter(Boolean)
}

/** The backticked phrases of §A.1's prose sentence (the text before its first fence). */
export function a1ProsePhrases(templateSrc) {
  const a1 = sectionBody(templateSrc, 'A.1')
  const prose = []
  for (const l of a1.lines) {
    if (/^\s*(`{3,}|~{3,})/.test(l)) break
    prose.push(l)
  }
  return [...prose.join(' ').matchAll(/`([^`]+)`/g)].map((m) => normalizePhrase(m[1]))
}

/** Double-quoted phrases in §0.2 — empty once §0.2 defers to §A.1 (#438). */
export function tripwirePhrases(templateSrc) {
  const s = sectionBody(templateSrc, '§0')
  if (!s) return []
  const start = s.lines.findIndex((l) => /^###\s+0\.2\b/.test(l))
  if (start < 0) return []
  const rest = s.lines.slice(start + 1)
  const end = rest.findIndex((l) => /^###\s/.test(l))
  const body = (end < 0 ? rest : rest.slice(0, end)).join(' ')
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => normalizePhrase(m[1]))
}
