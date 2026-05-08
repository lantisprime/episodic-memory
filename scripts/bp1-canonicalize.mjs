#!/usr/bin/env node
/**
 * bp1-canonicalize.mjs — CLI wrapper around lib/bp1-canonicalize.mjs.
 *
 * Reads an episode markdown file (frontmatter + body), parses YAML
 * frontmatter, calls canonicalize(), prints { canonical_sha256, payload }
 * as JSON to stdout.
 *
 * Usage:
 *   node scripts/bp1-canonicalize.mjs --episode <path-to-episode.md>
 *   node scripts/bp1-canonicalize.mjs --episode <path> --pretty
 *
 * Exit codes:
 *   0 on success
 *   1 on missing file / unparseable frontmatter
 *   2 on bad CLI args
 *
 * Zero deps; minimal YAML parsing inline (matches em-store/em-search
 * frontmatter conventions: simple key: value pairs, no nested structures
 * for canonical-bearing fields). For richer YAML, callers should pre-parse
 * and use the lib directly.
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { canonicalize } from './lib/bp1-canonicalize.mjs'

function parseArgs(argv) {
  const out = { episode: null, pretty: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--episode') out.episode = argv[++i]
    else if (arg === '--pretty') out.pretty = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: bp1-canonicalize --episode <path> [--pretty]\n')
      process.exit(0)
    }
  }
  return out
}

function splitFrontmatter(text) {
  // Frontmatter must start at byte 0 with "---\n" and end at the next
  // "\n---\n" boundary. Body is everything after.
  if (!text.startsWith('---\n')) {
    throw new Error('episode does not start with "---\\n" frontmatter delimiter')
  }
  const end = text.indexOf('\n---\n', 4)
  if (end === -1) {
    throw new Error('frontmatter end delimiter "\\n---\\n" not found')
  }
  return {
    frontmatter: text.slice(4, end),
    body: text.slice(end + 5),
  }
}

function parseSimpleYaml(yamlText) {
  // Minimal YAML — handles "key: value", "key: 'quoted value'", "key: [a, b]",
  // and "key: null" / "key: true" / "key: 123". Sufficient for BP-1 episode
  // frontmatter, which avoids nested structures for canonical fields.
  const obj = {}
  for (const rawLine of yamlText.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const rawVal = line.slice(colonIdx + 1).trim()
    if (!key) continue
    obj[key] = parseScalar(rawVal)
  }
  return obj
}

function parseScalar(raw) {
  if (raw === '' || raw === '~' || raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw)
  // Strip simple [a, b] arrays.
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(s => parseScalar(s.trim()))
  }
  // Strip quotes (single or double).
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]) {
    return raw.slice(1, -1)
  }
  return raw
}

const args = parseArgs(process.argv.slice(2))
if (!args.episode) {
  process.stderr.write('error: --episode <path> is required\n')
  process.exit(2)
}

let text
try {
  text = fs.readFileSync(args.episode, 'utf8')
} catch (e) {
  process.stderr.write(`error: cannot read ${args.episode}: ${e.message}\n`)
  process.exit(1)
}

let split
try {
  split = splitFrontmatter(text)
} catch (e) {
  process.stderr.write(`error: ${e.message}\n`)
  process.exit(1)
}

const frontmatter = parseSimpleYaml(split.frontmatter)
const { canonicalBytes, payload } = canonicalize(frontmatter, split.body)
const canonicalSha = crypto.createHash('sha256').update(canonicalBytes).digest('hex')

const output = { canonical_sha256: canonicalSha, payload }
process.stdout.write(JSON.stringify(output, null, args.pretty ? 2 : 0) + '\n')
