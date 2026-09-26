// md.mjs — zero-dep markdown structure helpers shared by the docs checkers in
// tools/ (issues #130, #203, #453). Not a markdown renderer: it recovers only
// the structure the checkers need — fenced code blocks, ATX headings, GitHub
// heading anchors — with line numbers.
//
// Scope, stated so the checkers do not over-claim:
//   - Fences: ``` and ~~~ (length >= 3), optionally indented or inside `>`
//     blockquotes. A fence closes on the same character with a run at least
//     as long and nothing but whitespace after it (CommonMark). A backtick
//     fence's info string may not contain a backtick.
//   - Headings: ATX only (`#`..`######`). Setext headings are not recognised.
//   - A leading YAML frontmatter block (`---` ... `---` on line 1) is skipped.
//   - Anchors follow GitHub's slugger: lowercase, drop every character that is
//     not a letter, mark, number, connector punctuation, space or hyphen, turn
//     spaces into hyphens, and suffix repeats with -1, -2, ...

const FENCE_RE = /^(\s*(?:>\s?)*)(`{3,}|~{3,})(.*)$/
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/

/** Strip inline markdown from heading text the way GitHub's rendered text reads. */
export function headingText(raw) {
  return String(raw)
    .replace(/[ \t]+#+[ \t]*$/, '') // closing ATX sequence
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
    .replace(/<[^>]+>/g, '') // inline html
    .replace(/`([^`]*)`/g, '$1') // code spans keep their content
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .trim()
}

/** GitHub heading slug (without the duplicate suffix). */
export function slugBase(text) {
  return headingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

/**
 * Walk a markdown document.
 * @returns {{
 *   lines: string[],
 *   fences: {line:number, endLine:number|null, info:string, marker:string}[],
 *   headings: {line:number, level:number, text:string, slug:string}[],
 *   fenced: Set<number>,     // 1-based line numbers inside (or delimiting) a fence
 *   frontmatterEnd: number,  // last 1-based line of frontmatter, 0 when none
 * }}
 */
export function scanMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  const fences = []
  const headings = []
  const fenced = new Set()
  const slugCount = new Map()
  let open = null
  let start = 0
  let frontmatterEnd = 0
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      frontmatterEnd = end + 1
      start = end + 1
    }
  }
  for (let i = start; i < lines.length; i++) {
    const n = i + 1
    const line = lines[i]
    const m = line.match(FENCE_RE)
    if (open) {
      fenced.add(n)
      if (m && m[2][0] === open.marker[0] && m[2].length >= open.marker.length && m[3].trim() === '') {
        open.endLine = n
        open = null
      }
      continue
    }
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      open = { line: n, endLine: null, info: m[3].trim(), marker: m[2] }
      fences.push(open)
      fenced.add(n)
      continue
    }
    const h = line.match(ATX_RE)
    if (h) {
      const text = headingText(h[2] || '')
      const base = slugBase(h[2] || '')
      const seen = slugCount.get(base) || 0
      slugCount.set(base, seen + 1)
      headings.push({ line: n, level: h[1].length, text, slug: seen ? `${base}-${seen}` : base })
    }
  }
  return { lines, fences, headings, fenced, frontmatterEnd }
}

/** Every anchor a document exposes: heading slugs plus explicit <a name|id="...">. */
export function anchorsOf(src) {
  const { headings, lines, fenced } = scanMarkdown(src)
  const out = new Set(headings.map((h) => h.slug))
  lines.forEach((l, i) => {
    if (fenced.has(i + 1)) return
    for (const m of l.matchAll(/<a\s+(?:[^>]*?\s)?(?:name|id)\s*=\s*["']([^"']+)["']/gi)) out.add(m[1].toLowerCase())
  })
  return out
}
