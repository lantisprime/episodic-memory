#!/usr/bin/env node
/**
 * em-restore.mjs — Selective restore from a local em-backup repo.
 *
 * Usage:
 *   node em-restore.mjs --from <backup-dir>
 *     --source-map <label>=<dir> [...repeatable]
 *     [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD]
 *     [--tag <t>]... [--category <c>]... [--source <label>]...
 *     [--dry-run | --apply]
 *     [--conflict-mode skip|sidecar|force] [--force] [--allow-duplicate-id]
 *     [--include-docs] [--restore-claude-md] [--skip-memory-md]
 *     [--allow-symlink-overwrite]
 *     [--rebuild-index | --no-rebuild-index]
 *     [--self-test]
 *
 * Lossy-data note: em-backup applies content redaction and path-segment
 * redaction. Restore CANNOT undo those — it materializes the backup as-is
 * and surfaces the gaps. Frame as "spin up a fresh machine," not "recover
 * the original."
 *
 * Outputs JSON to stdout. Every emitted string passes through the single
 * output boundary `redactArtifactString` (mirrors em-backup PR-#137 lesson:
 * patching individual return paths is whack-a-mole; one boundary is the
 * defense-in-depth backstop).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { loadCategories, validateCategory, canonicalCategory } from './lib/categories.mjs'
import { nullProtoIndex } from './lib/relevance.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The category vocabulary is read from categories.json via lib/categories.mjs
// (RFC-009 R10b) — no local array to keep in sync with em-store any longer.
const VALID_CONFLICT_MODES = ['skip', 'sidecar', 'force']

// Reserved doc filename: when --include-docs encounters this, gate behind
// --restore-claude-md (project copy is git-tracked; user-global at ~/.claude/
// is treated as ordinary curated doc, conflict model applies).
const PROJECT_CLAUDE_MD_BASENAME = 'CLAUDE.md'

// ---------------------------------------------------------------------------
// Output boundary (P1-13: single redaction point for all stdout/log strings)
// ---------------------------------------------------------------------------
//
// em-restore reads ALREADY-REDACTED backup content; we don't carry the user's
// extra_redact_strings list (it lives in em-backup config, not here). The
// remaining leak surface is paths in error messages and the JSON report.
// Strip the user's $HOME prefix (matches em-backup redactArtifactString
// home_path subset). Future leak-source additions must route through this
// function, not bypass it.
function redactArtifactString(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  // Same regex shape as em-backup home_path.
  return value.replace(/(\/Users|\/home)\/[A-Za-z0-9._-]+(?=\/|"|'|\s|$|[,)])/g, (m) => m.replace(/\/[A-Za-z0-9._-]+$/, '/USER'))
}

function sanitizeOutputObject(o) {
  function walk(node) {
    if (typeof node === 'string') return redactArtifactString(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v)
      return out
    }
    return node
  }
  return walk(o)
}

function out(o) {
  // Use process.stdout.write directly. console.log is async-flushed via the
  // event loop; when paired with process.exit() the trailing chunk is
  // truncated at the OS pipe buffer (~8KB on macOS). selfTest output now
  // exceeds that. process.stdout.write is synchronous for small payloads on
  // file-streams; for safety we additionally drain via writeSync of a
  // newline if needed. See Node issue: process.exit() truncates stdout.
  const s = JSON.stringify(sanitizeOutputObject(o), null, 2) + '\n'
  // For pipe stdout (subprocess), writeSync directly on the fd guarantees
  // the buffer reaches the OS before exit. Falls back to process.stdout.write
  // for terminal-attached stdout where writeSync(1,...) might block.
  try {
    fs.writeSync(1, s)
  } catch {
    process.stdout.write(s)
  }
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function multiFlag(name) {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1])
  }
  return out
}

function bool(name) {
  return argv.includes(name)
}

// ---------------------------------------------------------------------------
// Frontmatter parser (subset shared with em-rebuild-index)
// ---------------------------------------------------------------------------
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const lines = match[1].split('\n')
  const data = {}
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const [, key, raw] = m
    const arrMatch = raw.match(/^\[(.*)\]$/)
    if (arrMatch) {
      data[key] = arrMatch[1].split(',').map(s => s.trim()).filter(Boolean)
    } else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      data[key] = raw.slice(1, -1)
    } else {
      data[key] = raw === 'null' ? null : raw
    }
  }
  return data
}

// ---------------------------------------------------------------------------
// Source-map parsing: --source-map LABEL=DIR (repeatable)
// ---------------------------------------------------------------------------
function parseSourceMap(values) {
  const map = new Map()
  for (const v of values) {
    const eq = v.indexOf('=')
    if (eq <= 0) {
      throw new Error(`Invalid --source-map "${v}": expected LABEL=DIR`)
    }
    const label = v.slice(0, eq).trim()
    const dir = v.slice(eq + 1).trim()
    if (!label || !dir) {
      throw new Error(`Invalid --source-map "${v}": empty label or dir`)
    }
    // F4 (code review): refuse duplicate label declarations rather than
    // silently last-write-wins. Users repeating --source-map for the same
    // label probably mean to update one of them, not pick a winner.
    if (map.has(label)) {
      throw new Error(`Duplicate --source-map for label "${label}": already mapped to ${map.get(label)}`)
    }
    map.set(label, expandHome(dir))
  }
  return map
}

// Reviewer m3: reject hostile fm.id shapes that would create path-traversal,
// NUL injection, or unrenderable filenames at the target. Em-store generates
// ids matching `^[a-z0-9-]+$` (timestamp + slug + 4-hex suffix). We accept
// a slightly wider grammar to tolerate hand-edited episodes from older
// versions, but draw the line at any path separator, any control char,
// any space, and any id longer than 200 chars. Full em-store grammar
// drift test deferred to a follow-up issue (mirrors the shared-lib
// cross-script consistency discipline at T1).
function isSafeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false
  // Reject any control character (C0 + DEL).
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i)
    if (code < 0x20 || code === 0x7F) return false
  }
  // Defensive: forbid leading dot (would create hidden file or .. traversal
  // when joined naively). Em-store ids never start with '.'.
  if (id.startsWith('.')) return false
  return true
}

function expandHome(p) {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

// ---------------------------------------------------------------------------
// Backup discovery: enumerate source labels + their trees
// ---------------------------------------------------------------------------
function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'))
}

function gitStatusClean(dir) {
  try {
    const r = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe']
    }).toString()
    return r.trim().length === 0
  } catch (e) {
    throw new Error(`git status failed in ${dir}: ${e.message}`)
  }
}

function discoverSourceLabels(backupDir) {
  const entries = fs.readdirSync(backupDir, { withFileTypes: true })
  const labels = []
  for (const e of entries) {
    if (e.name === '.git') continue
    if (e.isSymbolicLink()) continue // P1-7: refuse backup-side symlinks
    if (e.isDirectory()) labels.push(e.name)
  }
  return labels
}

// ---------------------------------------------------------------------------
// Source-side walker (refuses symlinks)
// ---------------------------------------------------------------------------
function walkBackupSource(root, out = [], rejectedSymlinks = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isSymbolicLink()) {
      rejectedSymlinks.push(full)
      continue
    }
    if (e.isDirectory()) walkBackupSource(full, out, rejectedSymlinks)
    else if (e.isFile()) out.push(full)
  }
  return out
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------
function passesFilter(fm, filters) {
  if (filters.fromDate && fm.date && fm.date < filters.fromDate) return false
  if (filters.toDate && fm.date && fm.date > filters.toDate) return false
  if (filters.tags.length > 0) {
    const fmTags = new Set((fm.tags || []).map(t => String(t).toLowerCase()))
    for (const t of filters.tags) if (!fmTags.has(t.toLowerCase())) return false
  }
  if (filters.categories.length > 0) {
    if (!filters.categories.includes(fm.category)) return false
  }
  return true
}

// Supersedes-chain expansion (P0-6): when a filter selects a tip, also include
// its predecessors so the chain is intact at the target. Walks `supersedes:`
// frontmatter backward across all discovered backup episodes.
//
// Returns { expanded, chainBreaks } where chainBreaks lists supersedes refs
// that point at episodes NOT present in byId (orphan references).
//
// Reviewer n2 cycle defense: `out.has()` ensures each ancestor is enqueued at
// most once. A→B→A two-cycle terminates: starting with selected={A}, we walk
// to B (added to out), then walk to A (already in out, skipped) → loop ends.
// Chain expansion is bounded by the size of byId regardless of cycles.
//
// Reviewer M3 cross-label gap (#158): byId only retains first-encountered
// (label, id) tuple. With --allow-duplicate-id, additional same-id entries
// from other labels live in additionalDuplicates and are NOT consulted here.
// Their chain ancestors (which may differ from byId's chain) are silently
// missed. Tracked at #158; not closed in this commit.
function expandSupersedesChain(selected, byId) {
  const out = new Map(selected) // id → entry
  const queue = [...selected.keys()]
  const chainBreaks = []
  while (queue.length > 0) {
    const id = queue.shift()
    const entry = byId.get(id)
    if (!entry || !entry.fm.supersedes) continue
    const ancestor = byId.get(entry.fm.supersedes)
    if (!ancestor) {
      // Reviewer n1: previously the comment claimed chain breaks were
      // surfaced; they weren't. Now we accumulate them and `run()` includes
      // them in the summary report.
      chainBreaks.push({ tip: id, missing_ancestor: entry.fm.supersedes })
      continue
    }
    if (!out.has(ancestor.fm.id)) {
      out.set(ancestor.fm.id, ancestor)
      queue.push(ancestor.fm.id)
    }
  }
  return { expanded: out, chainBreaks }
}

// ---------------------------------------------------------------------------
// Conflict classification (P1-8: 4 buckets, normalized-equal as 3rd)
// ---------------------------------------------------------------------------
function normalizeText(buf) {
  let s = buf.toString('utf8')
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1) // strip BOM
  s = s.replace(/\r\n/g, '\n') // CRLF → LF
  s = s.replace(/\n+$/, '') + '\n' // single trailing newline
  return s
}

function classifyConflict(srcPath, dstPath) {
  if (!fs.existsSync(dstPath)) return 'clean'
  // P1-7: lstat dst; if symlink, special-case so we never write through it.
  const lst = fs.lstatSync(dstPath)
  if (lst.isSymbolicLink()) return 'target-symlink'
  const a = fs.readFileSync(srcPath)
  const b = fs.readFileSync(dstPath)
  if (a.equals(b)) return 'identical'
  if (normalizeText(a) === normalizeText(b)) return 'normalized-equal'
  return 'overwrite'
}

// ---------------------------------------------------------------------------
// Path-traversal guard (every target path resolved-realpath under known root)
// ---------------------------------------------------------------------------
// Resolve a path to its semantic absolute form: walk up to the deepest
// existing ancestor, realpathSync that (which resolves any symlinks in the
// ancestry), then append the lexical suffix for the non-existent tail. If
// nothing in the chain exists, fall back to pure lexical resolution.
//
// This is the foundation for ensureUnder's traversal check. The same
// algorithm is applied to BOTH root and candidate, eliminating the
// asymmetry that previously caused macOS /var ↔ /private/var false
// rejections (root realpath'd vs candidate lexical).
function realpathLogical(p) {
  if (typeof p !== 'string' || p.length === 0) return p
  let cur = p
  let suffix = ''
  while (!fs.existsSync(cur)) {
    suffix = path.sep + path.basename(cur) + suffix
    const parent = path.dirname(cur)
    if (parent === cur) return path.resolve(p) // nothing in chain exists
    cur = parent
  }
  try {
    return fs.realpathSync(cur) + suffix
  } catch {
    return path.resolve(p)
  }
}

function ensureUnder(root, candidate) {
  // Verify candidate doesn't escape root after symlinks resolve in either.
  // Return the candidate path AS GIVEN — downstream code (mkdirSync, rename)
  // operates on the original path; realpath is for the safety check only.
  //
  // Codex round-2: ensureUnder must not REQUIRE root to exist on disk
  // (dry-run path planning).
  // Reviewer round-3 MINOR-2: applying realpath asymmetrically (root real,
  // candidate lexical) is fractal #9 level-2 violation. Both paths now go
  // through the same `realpathLogical` helper.
  const rootResolved = realpathLogical(root)
  const candResolved = realpathLogical(candidate)
  if (candResolved !== rootResolved && !candResolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Path traversal refused: ${redactArtifactString(candidate)} resolves outside ${redactArtifactString(root)}`)
  }
  return candidate
}

// ---------------------------------------------------------------------------
// Atomic write helpers
// ---------------------------------------------------------------------------
function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // F12 (code review): unique tmp suffix per process+timestamp so concurrent
  // em-restore runs targeting the same file can't overwrite each other's
  // tmp before rename (last-rename-wins would silently lose A's writes).
  const tmp = `${filePath}.em-restore.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, filePath)
}

function writeJSONAtomic(filePath, obj) {
  writeAtomic(filePath, JSON.stringify(obj, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Index merge (P0-5: union by id; restored entry wins on overwrite if --force)
// ---------------------------------------------------------------------------
function loadIndexJsonl(filePath) {
  const map = new Map()
  if (!fs.existsSync(filePath)) return map
  const content = fs.readFileSync(filePath, 'utf8').trim()
  if (!content) return map
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.id) map.set(entry.id, entry)
    } catch {}
  }
  return map
}

function mergeIndexes(targetDir, restoredEntries, conflictMode) {
  const indexFile = path.join(targetDir, 'index.jsonl')
  const tagsFile = path.join(targetDir, 'tags.json')

  const existing = loadIndexJsonl(indexFile)
  const merged = new Map(existing)
  for (const entry of restoredEntries) {
    const prev = merged.get(entry.id)
    if (!prev) {
      merged.set(entry.id, entry)
    } else if (conflictMode === 'force') {
      // F6 (code review): preserve access_count + last_accessed when
      // overwriting an existing entry. em-rebuild-index already maintains
      // this invariant; force-restore must not silently zero em-search
      // history that the user accumulated independently of backup.
      const carriedForward = {
        ...entry,
        access_count: prev.access_count != null ? prev.access_count : (entry.access_count || 0),
        last_accessed: prev.last_accessed != null ? prev.last_accessed : (entry.last_accessed || null)
      }
      merged.set(entry.id, carriedForward)
    }
    // skip / sidecar: leave existing entry; restored .md may not have been
    // written. Per-id consistency: if the .md was sidecared and we updated
    // index, em-search would point at stale entry. So index follows file.
  }

  const sortedIds = [...merged.keys()].sort()
  const lines = sortedIds.map(id => JSON.stringify(merged.get(id))).join('\n') + (sortedIds.length ? '\n' : '')
  writeAtomic(indexFile, lines)

  // Codex round-1 F3: tags.json is DERIVED from index.jsonl. Set-unioning into
  // the existing tags.json was per-string patching — when force-restore changes
  // an entry's tags, the OLD tags would still keep the id. Apply the
  // single-output-boundary lesson (`20260503-134615-...-8457`) to file
  // ownership: tags.json is rebuilt EXCLUSIVELY from the merged index map,
  // never read from disk. em-rebuild-index uses the same discipline.
  // Null-proto: a tag named "constructor" must not resolve to Object.prototype (issue #469)
  const tagsIndex = Object.create(null)
  for (const id of sortedIds) {
    const e = merged.get(id)
    for (const tag of (e.tags || [])) {
      if (!tagsIndex[tag]) tagsIndex[tag] = []
      tagsIndex[tag].push(id)
    }
  }
  writeJSONAtomic(tagsFile, tagsIndex)
}

// ---------------------------------------------------------------------------
// MEMORY.md reference integrity (P1-9)
// ---------------------------------------------------------------------------
function stripFencedCodeBlocks(md) {
  return md.replace(/```[\s\S]*?```/g, '')
}

function extractMarkdownLinks(md) {
  const stripped = stripFencedCodeBlocks(md)
  const refs = new Set()
  // Inline: [text](path[.md][#frag]) — F9 (code review) accepts hash-fragment
  // links like [a](feedback_x.md#trigger) which are common in MEMORY.md
  // referencing a section within a memory file.
  const inlineRe = /\[[^\]]+\]\(([^)\s#]+\.md)(?:#[^)\s]*)?\)/g
  let m
  while ((m = inlineRe.exec(stripped)) !== null) refs.add(m[1])
  // Reference-style: [id]: path.md (with optional fragment)
  const refRe = /^\s*\[[^\]]+\]:\s*(\S+?\.md)(?:#\S*)?\s*$/gm
  while ((m = refRe.exec(stripped)) !== null) refs.add(m[1])
  return [...refs]
}

function checkMemoryRefIntegrity(memoryMdContent, restoreSetBasenames, targetDir) {
  if (!memoryMdContent) return { present: false, refs: [], dangling: [] }
  const refs = extractMarkdownLinks(memoryMdContent)
  const dangling = []
  for (const ref of refs) {
    const basename = path.basename(ref)
    if (restoreSetBasenames.has(basename)) continue
    // Satisfied by existing target file?
    const targetPath = path.join(targetDir, ref)
    if (fs.existsSync(targetPath)) continue
    dangling.push(ref)
  }
  return { present: true, refs, dangling }
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------
function preflight({ backupDir, sourceMap }) {
  if (!fs.existsSync(backupDir)) {
    throw new Error(`Backup dir does not exist: ${redactArtifactString(backupDir)}`)
  }
  if (!isGitRepo(backupDir)) {
    throw new Error(`Backup dir is not a git repo: ${redactArtifactString(backupDir)} (run em-backup --init first)`)
  }
  if (!gitStatusClean(backupDir)) {
    throw new Error(`Backup dir has uncommitted changes; refusing. ${redactArtifactString(backupDir)}`)
  }
  // Validate each --source-map target
  for (const [label, dir] of sourceMap) {
    const expanded = expandHome(dir)
    // Round-2 R1 (P1): first-time restore needs the target to be CREATABLE
    // — but Codex round-2 caught a regression where preflight created the
    // dir UNCONDITIONALLY, even in dry-run mode (violating the README "no
    // disk writes" contract) and even before later validation like invalid
    // --category (creating dirs as a side effect of failed validation).
    //
    // Validate-before-side-effect (feedback_validation_timing_checklist.md
    // step 3): preflight is the validation layer; it must NOT mkdir.
    // Apply-phase preflightTargetDirs (only-on-apply, runs after ALL
    // validation has passed) is the create layer. ensureUnder gracefully
    // handles a non-existent root for dry-run path planning.
    if (!fs.existsSync(expanded)) {
      // Verify the parent exists so apply-phase mkdir has somewhere to land.
      const parent = path.dirname(expanded)
      if (!fs.existsSync(parent)) {
        throw new Error(`Source-map target ${redactArtifactString(label)} → ${redactArtifactString(expanded)}: parent dir does not exist (cannot be created at apply time)`)
      }
    } else {
      // If exists, ensure it's a directory and not a symlink
      const lst = fs.lstatSync(expanded)
      if (lst.isSymbolicLink()) {
        throw new Error(`Source-map target ${redactArtifactString(label)} is a symlink; refusing`)
      }
      if (!lst.isDirectory()) {
        throw new Error(`Source-map target ${redactArtifactString(label)} is not a directory`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Discover episodes across all source labels in backup
// ---------------------------------------------------------------------------
function discoverEpisodes(backupDir, sourceLabels, sourceMap, sourceFilter) {
  // Returns: Map<id, { fm, sourcePath, label }>
  const byId = new Map()
  const collisions = []
  const symlinkRejects = []

  // P0-1 dispatch: walk EVERY label that isn't filtered out, regardless of
  // sourceMap. Surface unmapped-but-matched labels so the run() caller can
  // refuse with a clear "missing --source-map" error. Skipping unmapped
  // labels here would silently empty byId and the missing-map check upstream
  // would never fire.
  //
  // Codex round-1 F2: byId previously OVERWROTE on cross-label same-id, so
  // --allow-duplicate-id would still drop one label's entry. Now byId keeps
  // first-encountered (used for chain-walk lookups), and every additional
  // label-bound dup is pushed to `additionalDuplicates`. With
  // --allow-duplicate-id, the apply phase iterates byId + dups whose id is
  // in the expanded set. Without the flag, the discovery-time `collisions`
  // array still triggers refusal in run().
  const unmappedLabelsWithEpisodes = []
  const additionalDuplicates = [] // entries that lost the byId race
  for (const label of sourceLabels) {
    if (sourceFilter.length > 0 && !sourceFilter.includes(label)) continue
    const labelRoot = path.join(backupDir, label)
    const episodesDir = path.join(labelRoot, 'episodes')
    if (!fs.existsSync(episodesDir)) continue
    const lst = fs.lstatSync(episodesDir)
    if (lst.isSymbolicLink()) { symlinkRejects.push(episodesDir); continue }
    const localRejects = []
    const files = walkBackupSource(episodesDir, [], localRejects)
    for (const r of localRejects) symlinkRejects.push(r)
    let hadEpisodeForLabel = false
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const content = fs.readFileSync(f, 'utf8')
      const fm = parseFrontmatter(content)
      if (!fm || !fm.id) continue
      hadEpisodeForLabel = true
      // Reviewer m3: fm.id is used as filename and index key. Path traversal
      // via `..` is caught downstream by ensureUnder, but other shapes (NUL
      // bytes, control chars, path separators, very long ids) would land on
      // disk unchecked. Reject hostile fm.id values at discovery.
      if (!isSafeId(fm.id)) {
        symlinkRejects.push(`unsafe-id:${f}`) // reuse the rejected list channel
        continue
      }
      if (!sourceMap.has(label)) continue // tracked below; don't load entry
      const entry = { fm, sourcePath: f, label, content }
      if (byId.has(fm.id)) {
        // Reviewer m2: collisions array now keys per id with all labels
        // accumulated, so 3+ labels containing the same id show ALL of them
        // in the report (previous shape pushed [first,this] each time,
        // dropping intermediate labels).
        const existing = collisions.find(c => c.id === fm.id)
        if (existing) {
          if (!existing.labels.includes(label)) existing.labels.push(label)
        } else {
          collisions.push({ id: fm.id, labels: [byId.get(fm.id).label, label] })
        }
        additionalDuplicates.push(entry)
      } else {
        byId.set(fm.id, entry)
      }
    }
    if (hadEpisodeForLabel && !sourceMap.has(label)) unmappedLabelsWithEpisodes.push(label)
  }

  return { byId, additionalDuplicates, collisions, symlinkRejects, unmappedLabelsWithEpisodes }
}

// ---------------------------------------------------------------------------
// Doc tree discovery (--include-docs path; not filterable)
// ---------------------------------------------------------------------------
function discoverDocFiles(backupDir, sourceLabels, sourceMap, sourceFilter) {
  // Everything under each mapped label-root EXCEPT episodes/ (handled above)
  // and the manifest file. Returns: [{ label, sourcePath, relPath }]
  const docs = []
  const symlinkRejects = []
  for (const label of sourceLabels) {
    if (sourceFilter.length > 0 && !sourceFilter.includes(label)) continue
    if (!sourceMap.has(label)) continue
    const labelRoot = path.join(backupDir, label)
    const localRejects = []
    const all = walkBackupSource(labelRoot, [], localRejects)
    for (const r of localRejects) symlinkRejects.push(r)
    for (const f of all) {
      const rel = path.relative(labelRoot, f)
      // Skip episodes/ subtree (covered by episode flow)
      if (rel === 'episodes' || rel.startsWith('episodes' + path.sep)) continue
      // Skip backup metadata
      if (rel === '.skipped-files.json') continue
      // F1 (code review): index.jsonl and tags.json have a SINGLE writer:
      // mergeIndexes. If --include-docs walked them as ordinary docs they'd
      // overwrite target's existing index BEFORE mergeIndexes reads it,
      // silently dropping every local-only entry. Single output boundary
      // discipline applied to file ownership.
      if (rel === 'index.jsonl' || rel === 'tags.json') continue
      docs.push({ label, sourcePath: f, relPath: rel })
    }
  }
  return { docs, symlinkRejects }
}

// ---------------------------------------------------------------------------
// Build write plan
// ---------------------------------------------------------------------------
function buildWritePlan({
  selected, extraEntries = [], sourceMap, sourceLabelByEpisode, conflictMode, allowSymlinkOverwrite, allowDuplicateId, includeDocs, docs, restoreClaudeMd, skipMemoryMd, sidecarRefuseExisting
}) {
  const episodeWrites = [] // { sourcePath, targetPath, conflict, label, id, action }
  const docWrites = []
  const refusedClaudeMd = []
  const sidecarConflicts = [] // { targetPath, .from-backup already exists }
  const symlinkSkips = []
  // Codex round-2 non-blocking note: cross-source same-id at same target
  // (allowed via --allow-duplicate-id, last-write-wins) was previously
  // reported under symlink_rejects.target — semantic mismatch since it's
  // not a symlink rejection. Dedicated field makes the report self-
  // documenting.
  const duplicateSkips = []
  // RFC-009 R10c row 2 (apply path): an episode whose canonical category is unknown-to-any-version
  // is skipped and surfaced here (inverting the old silent write-through). Deprecated members
  // restore verbatim (canonicalCategory maps them to an active successor, so cv.ok stays true).
  const categorySkips = []
  const targetByPath = new Map() // collision detection within plan

  // Codex round-1 F2: iterate the expanded selection AND any cross-label
  // duplicates that the user explicitly opted-in to via --allow-duplicate-id.
  // Each entry brings its own label, so per-target dispatch is correct
  // (different labels → different target dirs → both files written).
  const allEntries = []
  for (const e of selected.values()) allEntries.push(e)
  for (const e of extraEntries) allEntries.push(e)

  for (const entry of allEntries) {
    const label = entry.label
    const targetDir = sourceMap.get(label)
    const targetPath = ensureUnder(targetDir, path.join(targetDir, 'episodes', `${entry.fm.id}.md`))
    const conflict = classifyConflict(entry.sourcePath, targetPath)

    let action = decideAction(conflict, conflictMode)
    // Category validation precedes any write (EC6): an unknown category is skipped + surfaced,
    // never written through. canonicalCategory resolves a deprecated member to its active
    // successor first, so only genuinely-unknown categories fail here.
    const cv = validateCategory(canonicalCategory(entry.fm.category), { allowDeprecated: true })
    if (!cv.ok) {
      categorySkips.push({ targetPath, id: entry.fm.id, category: entry.fm.category, reason: 'unknown category not in vocabulary' })
      action = 'skip'
    }
    // Reviewer M1: previously set action='overwrite-symlink' but the apply
    // path only switched on skip/noop/sidecar/<default>, making the label
    // cosmetic. Now: when --allow-symlink-overwrite is set, the symlink
    // path takes the SAME action as a regular overwrite (renameSync replaces
    // the symlink atomically). The dispatch is no longer differentiated;
    // the conflict field still records 'target-symlink' for the report.
    if (conflict === 'target-symlink') {
      if (!allowSymlinkOverwrite) {
        symlinkSkips.push({ targetPath, reason: 'target is symlink; pass --allow-symlink-overwrite to override' })
        action = 'skip'
      } else {
        // Treat as overwrite per conflict-mode semantics; renameSync replaces
        // the symlink without following it.
        if (conflictMode === 'force') action = 'overwrite'
        else if (conflictMode === 'sidecar') action = 'sidecar'
        else action = 'skip' // default-skip is conservative even under allow-symlink-overwrite
      }
    }

    // Sidecar collision check
    if (action === 'sidecar') {
      const sidecarPath = targetPath + '.from-backup'
      if (fs.existsSync(sidecarPath) && sidecarRefuseExisting) {
        sidecarConflicts.push({ sidecarPath })
        action = 'skip'
      }
    }

    // Within-plan target collision. Three cases:
    // (a) Same id from two source-labels, both mapped to the SAME target
    //     dir, AND --allow-duplicate-id was passed → user explicitly opted
    //     into last-write-wins. First entry stays; later entries skip.
    // (b) Anything else → defensive assertion. byId is keyed by id and the
    //     target filename is `<id>.md`, so different ids cannot collide;
    //     same-id-different-target is allowed under --allow-duplicate-id;
    //     same-id-same-target without the flag was already refused at
    //     discovery. The remaining case is genuinely unreachable.
    if (targetByPath.has(targetPath) && action !== 'skip' && action !== 'noop') {
      const prev = targetByPath.get(targetPath)
      if (allowDuplicateId && prev.id === entry.fm.id) {
        // Case (a): record as skipped under the dedicated field.
        duplicateSkips.push({ targetPath, id: entry.fm.id, kept_label: prev.label, skipped_label: label, reason: 'cross-source same-id at same target; last-write-wins disabled, first entry kept' })
        action = 'skip'
      } else {
        throw new Error(`Internal: two entries (id=${prev.id} from ${prev.label}, id=${entry.fm.id} from ${label}) resolved to same target ${redactArtifactString(targetPath)}. This should be unreachable; please file a bug with backup contents.`)
      }
    }
    if (action !== 'skip' && action !== 'noop') {
      targetByPath.set(targetPath, { label, id: entry.fm.id })
    }

    // Codex round-1 F2: store the source-content directly on the plan write
    // so applyEpisodeWrites doesn't lose label distinction by re-keying via
    // byId.get(id). Cross-label same-id dups carry their own content here.
    episodeWrites.push({ sourcePath: entry.sourcePath, targetPath, conflict, label, id: entry.fm.id, action, content: entry.content, fm: entry.fm })
  }

  if (includeDocs) {
    for (const d of docs) {
      const targetDir = sourceMap.get(d.label)
      const targetPath = ensureUnder(targetDir, path.join(targetDir, d.relPath))
      const isProjectClaudeMd = path.basename(d.relPath) === PROJECT_CLAUDE_MD_BASENAME && !d.relPath.includes(path.sep)
      const conflict = classifyConflict(d.sourcePath, targetPath)
      let action = decideAction(conflict, conflictMode)

      if (isProjectClaudeMd && !restoreClaudeMd && conflict !== 'identical' && conflict !== 'normalized-equal') {
        refusedClaudeMd.push({ targetPath, reason: 'project CLAUDE.md is git-tracked; pass --restore-claude-md to override' })
        action = 'skip'
      }
      if (path.basename(d.relPath) === 'MEMORY.md' && skipMemoryMd) {
        action = 'skip'
      }
      if (conflict === 'target-symlink') {
        if (!allowSymlinkOverwrite) {
          symlinkSkips.push({ targetPath, reason: 'target is symlink; pass --allow-symlink-overwrite to override' })
          action = 'skip'
        } else {
          // Reviewer M1: same simplification as episode dispatch above.
          if (conflictMode === 'force') action = 'overwrite'
          else if (conflictMode === 'sidecar') action = 'sidecar'
          else action = 'skip'
        }
      }
      if (action === 'sidecar') {
        const sidecarPath = targetPath + '.from-backup'
        if (fs.existsSync(sidecarPath) && sidecarRefuseExisting) {
          sidecarConflicts.push({ sidecarPath })
          action = 'skip'
        }
      }
      docWrites.push({ sourcePath: d.sourcePath, targetPath, relPath: d.relPath, conflict, label: d.label, action })
    }
  }

  return { episodeWrites, docWrites, refusedClaudeMd, sidecarConflicts, symlinkSkips, duplicateSkips, categorySkips }
}

// Pre-creates every unique parent dir referenced by the plan's writes
// (episode targets, doc targets, and sidecar paths). Any failure here —
// notably "EEXIST: file exists at <segment>" when a path component is a
// regular file rather than a directory — surfaces BEFORE applyEpisodeWrites
// touches disk. Idempotent: rerunning a clean restore is a no-op.
function preflightTargetDirs(plan, sourceMap) {
  const dirs = new Set()
  for (const w of plan.episodeWrites) {
    if (w.action === 'skip' || w.action === 'noop') continue
    dirs.add(path.dirname(w.targetPath))
    if (w.action === 'sidecar') dirs.add(path.dirname(w.targetPath + '.from-backup'))
  }
  for (const w of plan.docWrites) {
    if (w.action === 'skip' || w.action === 'noop') continue
    dirs.add(path.dirname(w.targetPath))
    if (w.action === 'sidecar') dirs.add(path.dirname(w.targetPath + '.from-backup'))
  }
  // Reviewer m5: mergeIndexes writes to <targetDir>/index.jsonl and
  // <targetDir>/tags.json. Their parent (`targetDir`) is already created
  // during the higher-level preflight, but include them here defensively
  // so a future "snapshot index next to episode" change doesn't silently
  // bypass this layer. Class-completeness audit (toolkit v4 #9) extension.
  if (sourceMap) {
    for (const targetDir of sourceMap.values()) dirs.add(targetDir)
  }
  const failures = []
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { recursive: true })
    } catch (e) {
      failures.push({ dir: d, error: e.message })
    }
  }
  if (failures.length > 0) {
    const summary = failures.map(f => `  - ${redactArtifactString(f.dir)}: ${f.error}`).join('\n')
    throw new Error(`Target directory pre-creation failed for ${failures.length} path(s); refusing to write any files:\n${summary}`)
  }
}

// Reviewer M2: validate conflictMode so a misspelled value can't silently
// fall through to 'skip' (data loss class). CLI dispatcher already validates
// at line 1969, but in-process callers (selfTest, future programmatic uses)
// would skip the check. Class-completeness audit (toolkit v4 #9 level 1):
// `categories` is also validated in run() — same shape applies here.
function decideAction(conflict, conflictMode) {
  if (!VALID_CONFLICT_MODES.includes(conflictMode)) {
    throw new Error(`Invalid conflictMode "${conflictMode}". Must be one of: ${VALID_CONFLICT_MODES.join(', ')}`)
  }
  if (conflict === 'clean') return 'create'
  if (conflict === 'identical') return 'noop'
  if (conflict === 'normalized-equal') return 'noop' // P1-8: default-skip is conservative
  if (conflict === 'overwrite') {
    if (conflictMode === 'force') return 'overwrite'
    if (conflictMode === 'sidecar') return 'sidecar'
    return 'skip'
  }
  if (conflict === 'target-symlink') return 'skip' // override above
  return 'skip'
}

// ---------------------------------------------------------------------------
// Apply (write phase)
// ---------------------------------------------------------------------------
function applyEpisodeWrites(plan) {
  const written = []
  const skipped = []
  const sidecarsWritten = []
  for (const w of plan.episodeWrites) {
    if (w.action === 'skip' || w.action === 'noop') { skipped.push(w); continue }
    // Codex round-1 F2: w.content is captured at plan-build time from the
    // specific (label, id) entry. Re-keying via a global byId map would
    // collapse cross-label dups to the first-encountered content.
    if (w.action === 'sidecar') {
      const sidecar = w.targetPath + '.from-backup'
      writeAtomic(sidecar, w.content)
      sidecarsWritten.push({ targetPath: w.targetPath, sidecarPath: sidecar, label: w.label })
      continue
    }
    writeAtomic(w.targetPath, w.content)
    written.push(w)
  }
  return { written, skipped, sidecarsWritten }
}

// --include-docs atomic write via staging dir + per-file rename (P1-10)
function applyDocWrites(plan, sourceMap) {
  const written = []
  const skipped = []
  const sidecarsWritten = []

  // Group by target dir so we can stage each tree separately.
  const byTargetDir = new Map()
  for (const w of plan.docWrites) {
    if (w.action === 'skip' || w.action === 'noop') { skipped.push(w); continue }
    const targetDir = sourceMap.get(w.label)
    if (!byTargetDir.has(targetDir)) byTargetDir.set(targetDir, [])
    byTargetDir.get(targetDir).push(w)
  }

  for (const [targetDir, writes] of byTargetDir) {
    // Round-2 R2 (P2): mkdirSync({recursive:true}) on a pre-existing symlink
    // at the staging dir path silently accepts the symlink and subsequent
    // copyFileSync writes through it — confirmed via direct repro. The
    // previous name `.em-restore-staging-<pid>-<ts>` is predictable enough
    // that an attacker with write access to targetDir could plant the
    // symlink before mkdirSync runs. mkdtempSync atomically creates a fresh
    // dir with random suffix; symlink-redirect is impossible because the
    // final name is generated only on successful creation. Defense-in-depth
    // (attack still requires write access to targetDir).
    const stagingDir = fs.mkdtempSync(path.join(targetDir, '.em-restore-staging-'))
    try {
      // Stage all writes to staging dir using a deterministic relative key.
      const staged = []
      for (const w of writes) {
        const rel = path.relative(targetDir, w.targetPath)
        const stagePath = path.join(stagingDir, rel)
        fs.mkdirSync(path.dirname(stagePath), { recursive: true })
        fs.copyFileSync(w.sourcePath, stagePath)
        staged.push({ w, stagePath })
      }
      // Rename phase: per-file atomic moves into final position.
      // F3 (code review): per-file atomicity is NOT tree-atomic. If the Nth
      // rename throws, files 1..N-1 are already in target with no rollback.
      // We track applied-before-failure on the error so callers see partial
      // state explicitly rather than discovering it via filesystem walk.
      // True snapshot+rollback is heavyweight; document this contract.
      const appliedBeforeFailure = []
      try {
        for (const { w, stagePath } of staged) {
          if (w.action === 'sidecar') {
            const sidecar = w.targetPath + '.from-backup'
            fs.mkdirSync(path.dirname(sidecar), { recursive: true })
            fs.renameSync(stagePath, sidecar)
            sidecarsWritten.push({ targetPath: w.targetPath, sidecarPath: sidecar, label: w.label, relPath: w.relPath })
            appliedBeforeFailure.push({ kind: 'sidecar', path: sidecar })
          } else {
            fs.mkdirSync(path.dirname(w.targetPath), { recursive: true })
            fs.renameSync(stagePath, w.targetPath)
            written.push(w)
            appliedBeforeFailure.push({ kind: 'doc', path: w.targetPath })
          }
        }
      } catch (e) {
        e.applied_before_failure = appliedBeforeFailure
        e.staging_dir = stagingDir
        throw e
      }
    } finally {
      // Clean staging dir (whatever's left)
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch {}
    }
  }
  return { written, skipped, sidecarsWritten }
}

// ---------------------------------------------------------------------------
// MEMORY.md ref-integrity wrapper called during plan emission
// ---------------------------------------------------------------------------
function buildRefIntegrityReport(plan, sourceMap, docs) {
  // Find MEMORY.md in docs (per source label). Build per-target report.
  const reports = []
  const docsByLabel = new Map()
  for (const d of docs) {
    if (path.basename(d.relPath) !== 'MEMORY.md') continue
    if (!docsByLabel.has(d.label)) docsByLabel.set(d.label, [])
    docsByLabel.get(d.label).push(d)
  }
  for (const [label, mems] of docsByLabel) {
    const targetDir = sourceMap.get(label)
    for (const mem of mems) {
      const content = fs.readFileSync(mem.sourcePath, 'utf8')
      // Build set of basenames in the restore set for THIS label
      const restoreBasenames = new Set()
      for (const w of plan.docWrites) if (w.label === label && w.action !== 'skip') restoreBasenames.add(path.basename(w.relPath))
      for (const w of plan.episodeWrites) if (w.label === label && w.action !== 'skip') restoreBasenames.add(path.basename(w.targetPath))
      const r = checkMemoryRefIntegrity(content, restoreBasenames, path.dirname(path.join(targetDir, mem.relPath)))
      reports.push({ label, relPath: mem.relPath, ...r })
    }
  }
  return reports
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
function run(opts) {
  const {
    backupDir, sourceMap, fromDate, toDate, tags, categories, sources,
    apply, conflictMode, force, includeDocs, restoreClaudeMd, skipMemoryMd,
    allowSymlinkOverwrite, allowDuplicateId, rebuildIndex
  } = opts

  // Codex round-2 finding: ALL pure-input validation must run before any
  // function that touches disk. Even though preflight() no longer creates
  // dirs, defense-in-depth says: if preflight ever regrows a side effect
  // (e.g. running git commands against the backup), categories check must
  // already have passed. Same shape as proof-rigor v4 #1 (validation
  // timing): pure-input checks are the cheapest layer; do them first.
  for (const c of categories) {
    // Filter flag: strict INCLUDING deprecated names, so older-vocab backups filter
    // correctly (R10c row 2). Unknown → the existing invalid-category error.
    const fv = validateCategory(c, { allowDeprecated: true })
    if (!fv.ok) {
      throw new Error(`Invalid --category "${c}". Must be in the vocabulary.`)
    }
  }

  preflight({ backupDir, sourceMap })

  const sourceLabels = discoverSourceLabels(backupDir)

  // Verify every label in `sources` filter exists in backup
  for (const s of sources) {
    if (!sourceLabels.includes(s)) throw new Error(`--source "${s}" not found in backup. Available: ${sourceLabels.join(', ')}`)
  }

  // Discovery
  const { byId, additionalDuplicates, collisions: discoverCollisions, symlinkRejects: epSymlinkRejects, unmappedLabelsWithEpisodes } = discoverEpisodes(backupDir, sourceLabels, sourceMap, sources)

  // Refuse if any label has episodes in backup but no --source-map.
  // (For docs-only labels: still surface, but only when --include-docs would
  // pick them up; keep the error focused on episode dispatch for now.)
  if (unmappedLabelsWithEpisodes.length > 0) {
    throw new Error(`Labels in backup with episodes but no --source-map: ${unmappedLabelsWithEpisodes.join(', ')}. Pass --source-map LABEL=DIR for each, or --source LABEL to narrow.`)
  }

  // Filter
  const filters = { fromDate, toDate, tags, categories }
  const filteredIds = new Map()
  for (const [id, entry] of byId) {
    if (passesFilter(entry.fm, filters)) filteredIds.set(id, entry)
  }

  // Supersedes-chain expansion
  const { expanded, chainBreaks } = expandSupersedesChain(filteredIds, byId)
  const expansionAdded = expanded.size - filteredIds.size

  // Cross-source dup
  if (discoverCollisions.length > 0 && !allowDuplicateId) {
    throw new Error(`Same episode id appears in multiple source labels: ${JSON.stringify(discoverCollisions)}. Pass --allow-duplicate-id to proceed (last-discovered wins).`)
  }

  // Doc discovery (only walked if --include-docs; cheap to skip)
  let docs = []
  let docSymlinkRejects = []
  if (includeDocs) {
    const r = discoverDocFiles(backupDir, sourceLabels, sourceMap, sources)
    docs = r.docs
    docSymlinkRejects = r.symlinkRejects
  }

  // Map episode→label for plan
  const sourceLabelByEpisode = new Map()
  for (const [id, entry] of expanded) sourceLabelByEpisode.set(id, entry.label)

  // Codex round-1 F2: when --allow-duplicate-id, additional same-id entries
  // from other labels (preserved by discoverEpisodes) become extra plan
  // entries — but only those whose id is in the post-filter expanded set,
  // so dups for filtered-out episodes don't sneak in.
  const extraEntries = []
  if (allowDuplicateId) {
    for (const dup of additionalDuplicates) {
      if (expanded.has(dup.fm.id)) extraEntries.push(dup)
    }
  }

  // Build plan
  const plan = buildWritePlan({
    selected: expanded,
    extraEntries,
    sourceMap,
    sourceLabelByEpisode,
    conflictMode: force ? 'force' : conflictMode,
    allowSymlinkOverwrite,
    allowDuplicateId,
    includeDocs,
    docs,
    restoreClaudeMd,
    skipMemoryMd,
    sidecarRefuseExisting: true
  })

  // Codex round-1 F1: validation-timing checklist (`feedback_validation_
  // timing_checklist.md`) step 3 — "imagine the validator throws AFTER the
  // operation is partway done. What state is left on disk?" Pre-PR, an
  // applyDocWrites mkdir failure (e.g. target has 'dir' as a regular file
  // blocking 'dir/file.md') threw AFTER applyEpisodeWrites already wrote
  // episodes, leaving episodes on disk but indexes unwritten — exactly the
  // partial-state class the checklist closes. Solution: writability preflight
  // collects every unique parent dir across the plan and pre-creates them.
  // Any mkdir failure is raised BEFORE any episode write.
  if (apply) {
    preflightTargetDirs(plan, sourceMap)
  }

  // MEMORY.md ref-integrity
  const refReports = includeDocs ? buildRefIntegrityReport(plan, sourceMap, docs) : []

  // Skipped-files manifest summary
  const skipManifest = readSkipManifest(backupDir)

  const summary = {
    matched: { episodes: filteredIds.size, after_chain_expansion: expanded.size, docs: includeDocs ? docs.length : 0 },
    expansion_added: expansionAdded,
    by_category: countBy(expanded, e => e.fm.category),
    by_label: countBy(expanded, e => e.label),
    conflicts: countBy(plan.episodeWrites, w => w.conflict),
    actions: countBy(plan.episodeWrites, w => w.action),
    doc_actions: countBy(plan.docWrites, w => w.action),
    refused_claude_md: plan.refusedClaudeMd,
    sidecar_collisions: plan.sidecarConflicts,
    symlink_rejects: { source: [...epSymlinkRejects, ...docSymlinkRejects], target: plan.symlinkSkips },
    duplicate_skips: plan.duplicateSkips,
    category_skips: plan.categorySkips,
    ref_integrity: refReports,
    chain_breaks: chainBreaks, // reviewer n1: actually surface dangling supersedes refs
    skipped_in_backup: skipManifest
  }

  if (!apply) {
    return { status: 'ok', mode: 'dry-run', summary, plan: { episodeWrites: plan.episodeWrites.map(redactPlanItem), docWrites: plan.docWrites.map(redactPlanItem) } }
  }

  // Apply
  const epResult = applyEpisodeWrites(plan)
  const docResult = applyDocWrites(plan, sourceMap)

  // Index merge per target dir
  const indexResults = []
  if (rebuildIndex !== false) {
    const writtenByTarget = new Map()
    for (const w of epResult.written) {
      const targetDir = sourceMap.get(w.label)
      if (!writtenByTarget.has(targetDir)) writtenByTarget.set(targetDir, [])
      // Codex round-1 F2: w.fm is the per-(label,id) frontmatter, not byId's
      // first-encountered version. Each cross-label dup updates ITS target's
      // index correctly.
      writtenByTarget.get(targetDir).push(w.fm)
    }
    for (const [targetDir, fms] of writtenByTarget) {
      const restoredEntries = fms.map(fm => ({
        id: fm.id,
        date: fm.date,
        time: fm.time,
        project: fm.project,
        category: fm.category,
        status: fm.status || 'active',
        supersedes: fm.supersedes || null,
        tags: Array.isArray(fm.tags) ? fm.tags.map(t => String(t).toLowerCase()) : [],
        summary: fm.summary,
        access_count: 0,
        last_accessed: null
      }))
      mergeIndexes(targetDir, restoredEntries, force ? 'force' : conflictMode)
      // RFC-009 R10d: merge the restored ids into category-index.json under their canonical
      // category key (temp+rename), mirroring the store/revise incremental maintenance.
      const catFile = path.join(targetDir, 'category-index.json')
      // Null-proto: unknown categories index under their literal key (issue #469)
      let catIndex = Object.create(null)
      try { catIndex = nullProtoIndex(JSON.parse(fs.readFileSync(catFile, 'utf8'))) } catch {}
      for (const fm of fms) {
        const key = canonicalCategory(fm.category)
        if (!catIndex[key]) catIndex[key] = []
        if (!catIndex[key].includes(fm.id)) catIndex[key].push(fm.id)
      }
      const catTmp = catFile + '.tmp'
      fs.writeFileSync(catTmp, JSON.stringify(catIndex, null, 2), 'utf8')
      fs.renameSync(catTmp, catFile)
      indexResults.push({ targetDir, merged: restoredEntries.length })
    }
  }

  return {
    status: 'ok',
    mode: 'apply',
    summary,
    written: { episodes: epResult.written.length, docs: docResult.written.length, sidecars: epResult.sidecarsWritten.length + docResult.sidecarsWritten.length },
    skipped: { episodes: epResult.skipped.length, docs: docResult.skipped.length },
    indexes: indexResults
  }
}

function redactPlanItem(w) {
  return {
    label: w.label,
    id: w.id,
    relPath: w.relPath,
    conflict: w.conflict,
    action: w.action,
    targetPath: w.targetPath
  }
}

function countBy(iter, key) {
  // Null-proto: tally keys can be episode-derived strings (issue #469)
  const m = Object.create(null)
  for (const x of (iter instanceof Map ? iter.values() : iter)) {
    const k = key(x)
    m[k] = (m[k] || 0) + 1
  }
  return m
}

function readSkipManifest(backupDir) {
  // em-backup writes ONE manifest at backup root. We surface a summary;
  // P0-4 finding means we cannot use these paths to materialize placeholders
  // (paths are redacted). v1 only summarizes counts.
  const path1 = path.join(backupDir, '.skipped-files.json')
  if (!fs.existsSync(path1)) return { present: false }
  try {
    const m = JSON.parse(fs.readFileSync(path1, 'utf8'))
    return {
      present: true,
      generated_at: m.generated_at,
      counts: {
        symlinks: (m.skipped_symlinks || []).length,
        oversized: (m.skipped_oversized || []).length,
        binary: (m.skipped_binary || []).length
      }
    }
  } catch (e) {
    return { present: true, parse_error: e.message }
  }
}

// ---------------------------------------------------------------------------
// selfTest
// ---------------------------------------------------------------------------
function selfTest() {
  let pass = 0, fail = 0, skipped = 0
  const results = []

  function ok(name) {
    pass++
    results.push({ name, pass: true })
  }
  function bad(name, why) {
    fail++
    results.push({ name, pass: false, why: why || 'no reason' })
  }
  function skip(name, why) {
    // F11 (code review): skipped tests must NOT count as pass — that's
    // the proof-rigor "verify before deferring" anti-pattern. Distinct
    // status, distinct counter.
    skipped++
    results.push({ name, skipped: true, why })
  }
  function assert(name, cond, why) {
    if (cond) ok(name)
    else bad(name, why || 'assertion false')
  }

  // Helper: build a fake backup tree.
  function makeFakeBackup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-test-'))
    const backupDir = path.join(root, 'backup')
    fs.mkdirSync(backupDir, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: backupDir, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: backupDir })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: backupDir })
    return { root, backupDir }
  }

  function makeEpisode(id, fm, body = 'body content\n') {
    const fmLines = ['---']
    for (const [k, v] of Object.entries(fm)) {
      if (Array.isArray(v)) fmLines.push(`${k}: [${v.join(', ')}]`)
      else if (v === null) fmLines.push(`${k}: null`)
      else fmLines.push(`${k}: ${v}`)
    }
    fmLines.push('---')
    return fmLines.join('\n') + '\n\n# ' + (fm.summary || id) + '\n\n' + body
  }

  function commitBackup(backupDir) {
    execFileSync('git', ['add', '-A'], { cwd: backupDir })
    // --allow-empty so tests that create no files (e.g. invalid_category)
    // can still produce a clean working tree for preflight.
    execFileSync('git', ['commit', '-m', 'test', '--allow-empty'], { cwd: backupDir, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  // T1: both scripts read the vocabulary from the shared lib (RFC-009 R10b, REQ-17).
  // Replaces the old valid_categories_match_em_store grep-for-array drift test — with a single
  // lib source there is no duplicated array to drift; the guard is now "both import the lib".
  try {
    const scriptsDir = path.dirname(new URL(import.meta.url).pathname)
    const storePath = path.join(scriptsDir, 'em-store.mjs')
    const restorePath = path.join(scriptsDir, 'em-restore.mjs')
    if (fs.existsSync(storePath) && fs.existsSync(restorePath)) {
      const storeSrc = fs.readFileSync(storePath, 'utf8')
      const restoreSrc = fs.readFileSync(restorePath, 'utf8')
      const bothImport = storeSrc.includes("from './lib/categories.mjs'") && restoreSrc.includes("from './lib/categories.mjs'")
      const vocabOk = loadCategories().categories.length === 10
      assert('test_categories_from_shared_lib', bothImport && vocabOk, `bothImport=${bothImport} vocabLen=${loadCategories().categories.length}`)
    } else {
      skip('test_categories_from_shared_lib', 'em-store.mjs/em-restore.mjs not present alongside (installed copy); lib-import check skipped')
    }
  } catch (e) {
    bad('test_categories_from_shared_lib', e.message)
  }

  // T2: pre-flight refuses non-git backup
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-t2-'))
    let threw = false
    try {
      preflight({ backupDir: tmp, sourceMap: new Map() })
    } catch { threw = true }
    fs.rmSync(tmp, { recursive: true, force: true })
    assert('preflight_refuses_non_git', threw)
  } catch (e) { bad('preflight_refuses_non_git', e.message) }

  // T3: discovery enumerates labels, skips .git
  try {
    const { root, backupDir } = makeFakeBackup()
    fs.mkdirSync(path.join(backupDir, 'label-a', 'episodes'), { recursive: true })
    fs.mkdirSync(path.join(backupDir, 'label-b', 'episodes'), { recursive: true })
    const labels = discoverSourceLabels(backupDir)
    assert('discovery_enumerates_labels', labels.includes('label-a') && labels.includes('label-b') && !labels.includes('.git'))
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('discovery_enumerates_labels', e.message) }

  // T4: filter date / tag / category / intersection
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep1 = makeEpisode('id-1', { id: 'id-1', date: '2026-04-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: ['alpha'], summary: 'one' })
    const ep2 = makeEpisode('id-2', { id: 'id-2', date: '2026-05-01', time: '"10:00"', project: 't', category: 'lesson', status: 'active', tags: ['beta'], summary: 'two' })
    const ep3 = makeEpisode('id-3', { id: 'id-3', date: '2026-05-15', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: ['alpha', 'beta'], summary: 'three' })
    const epDir = path.join(backupDir, 'lab', 'episodes')
    fs.mkdirSync(epDir, { recursive: true })
    fs.writeFileSync(path.join(epDir, 'id-1.md'), ep1)
    fs.writeFileSync(path.join(epDir, 'id-2.md'), ep2)
    fs.writeFileSync(path.join(epDir, 'id-3.md'), ep3)
    commitBackup(backupDir)

    const { byId } = discoverEpisodes(backupDir, ['lab'], new Map([['lab', '/tmp/x']]), [])
    // Filter by from-date
    const f1 = new Map()
    for (const [id, e] of byId) if (passesFilter(e.fm, { fromDate: '2026-05-01', toDate: undefined, tags: [], categories: [] })) f1.set(id, e)
    assert('filter_from_date', f1.size === 2 && f1.has('id-2') && f1.has('id-3'))

    const f2 = new Map()
    for (const [id, e] of byId) if (passesFilter(e.fm, { fromDate: undefined, toDate: undefined, tags: ['alpha'], categories: [] })) f2.set(id, e)
    assert('filter_tag', f2.size === 2 && f2.has('id-1') && f2.has('id-3'))

    const f3 = new Map()
    for (const [id, e] of byId) if (passesFilter(e.fm, { fromDate: undefined, toDate: undefined, tags: [], categories: ['decision'] })) f3.set(id, e)
    assert('filter_category', f3.size === 2 && f3.has('id-1') && f3.has('id-3'))

    // Intersection
    const f4 = new Map()
    for (const [id, e] of byId) if (passesFilter(e.fm, { fromDate: '2026-05-01', toDate: undefined, tags: ['alpha'], categories: ['decision'] })) f4.set(id, e)
    assert('filter_intersection', f4.size === 1 && f4.has('id-3'))

    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('filter_axes', e.message) }

  // T5: supersedes-chain expansion (P0-6)
  try {
    const { root, backupDir } = makeFakeBackup()
    const orig = makeEpisode('id-orig', { id: 'id-orig', date: '2026-04-01', time: '"10:00"', project: 't', category: 'decision', status: 'superseded', supersedes: null, tags: [], summary: 'orig' })
    const tip = makeEpisode('id-tip', { id: 'id-tip', date: '2026-05-15', time: '"10:00"', project: 't', category: 'decision', status: 'active', supersedes: 'id-orig', tags: ['picked'], summary: 'tip' })
    const epDir = path.join(backupDir, 'lab', 'episodes')
    fs.mkdirSync(epDir, { recursive: true })
    fs.writeFileSync(path.join(epDir, 'id-orig.md'), orig)
    fs.writeFileSync(path.join(epDir, 'id-tip.md'), tip)
    commitBackup(backupDir)

    const { byId } = discoverEpisodes(backupDir, ['lab'], new Map([['lab', '/tmp/x']]), [])
    // Filter selects only the tip
    const selected = new Map()
    for (const [id, e] of byId) if (passesFilter(e.fm, { fromDate: undefined, toDate: undefined, tags: ['picked'], categories: [] })) selected.set(id, e)
    assert('chain_filter_selects_tip_only', selected.size === 1 && selected.has('id-tip'))
    // Reviewer n1: expandSupersedesChain now returns { expanded, chainBreaks }
    const { expanded } = expandSupersedesChain(selected, byId)
    assert('chain_expansion_includes_ancestor', expanded.size === 2 && expanded.has('id-tip') && expanded.has('id-orig'))

    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('chain_expansion', e.message) }

  // T6: conflict trichotomy + normalized-equal
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-t6-'))
    const src = path.join(tmp, 'src.md')
    const dstClean = path.join(tmp, 'a.md')
    const dstIdent = path.join(tmp, 'b.md')
    const dstNorm = path.join(tmp, 'c.md')
    const dstDiff = path.join(tmp, 'd.md')
    fs.writeFileSync(src, 'hello\n')
    // a not created → clean
    fs.writeFileSync(dstIdent, 'hello\n')
    fs.writeFileSync(dstNorm, '﻿hello\r\n\n') // BOM + CRLF + extra newline
    fs.writeFileSync(dstDiff, 'goodbye\n')
    assert('conflict_clean', classifyConflict(src, dstClean) === 'clean')
    assert('conflict_identical', classifyConflict(src, dstIdent) === 'identical')
    assert('conflict_normalized_equal', classifyConflict(src, dstNorm) === 'normalized-equal')
    assert('conflict_overwrite', classifyConflict(src, dstDiff) === 'overwrite')
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('conflict_classification', e.message) }

  // T7: target-symlink classification + skip without override
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-t7-'))
    const src = path.join(tmp, 'src.md')
    const realFile = path.join(tmp, 'real.md')
    const linkDst = path.join(tmp, 'link.md')
    fs.writeFileSync(src, 'A\n')
    fs.writeFileSync(realFile, 'B\n')
    fs.symlinkSync(realFile, linkDst)
    assert('target_symlink_detected', classifyConflict(src, linkDst) === 'target-symlink')
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('target_symlink_detect', e.message) }

  // T8: backup-side symlink rejection
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-t8-'))
    const real = path.join(tmp, 'real.md')
    const link = path.join(tmp, 'link.md')
    fs.writeFileSync(real, 'x')
    fs.symlinkSync(real, link)
    const out = []
    const rejects = []
    walkBackupSource(tmp, out, rejects)
    assert('backup_symlink_rejected', rejects.length === 1 && rejects[0] === link && out.length === 1)
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('backup_symlink_reject', e.message) }

  // T9: redactArtifactString strips $HOME
  try {
    const homeStripped = redactArtifactString('/Users/alice/Documents/foo')
    assert('output_boundary_strips_home', homeStripped === '/Users/USER/Documents/foo', `got "${homeStripped}"`)
    // Also verify it doesn't leave bare "USER" inside arbitrary tokens
    const noStrip = redactArtifactString('plain string with no path')
    assert('output_boundary_passes_through', noStrip === 'plain string with no path')
  } catch (e) { bad('output_boundary', e.message) }

  // T10: sanitizeOutputObject walks nested
  try {
    const obj = { ok: true, path: '/Users/alice/x', nested: { p: '/home/bob/y' }, arr: ['/Users/eve/z'] }
    const r = sanitizeOutputObject(obj)
    assert('output_walk_nested', r.path === '/Users/USER/x' && r.nested.p === '/home/USER/y' && r.arr[0] === '/Users/USER/z')
  } catch (e) { bad('output_walk_nested', e.message) }

  // T11: MEMORY.md ref-integrity dangling + satisfied-by-target
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-t11-'))
    const md = '# Memory\n\n- [a](feedback_a.md) — hook\n- [b](feedback_b.md) — hook\n\n```\n[c](feedback_c.md)\n```\n'
    // Restore set has a; target already has b; c is in fenced block so ignored
    const restoreBn = new Set(['feedback_a.md'])
    fs.writeFileSync(path.join(tmp, 'feedback_b.md'), '')
    const r = checkMemoryRefIntegrity(md, restoreBn, tmp)
    assert('refint_present', r.present === true)
    // Inline a satisfied by restore set; b satisfied by target; c filtered by fence
    assert('refint_dangling_zero', r.dangling.length === 0, `got ${JSON.stringify(r.dangling)}`)
    // Add a dangling one
    const md2 = md + '\n- [d](feedback_d.md) — hook\n'
    const r2 = checkMemoryRefIntegrity(md2, restoreBn, tmp)
    assert('refint_dangling_detected', r2.dangling.length === 1 && r2.dangling[0] === 'feedback_d.md')
    // Reference-style
    const md3 = '[a]: feedback_a.md\n[d]: feedback_d.md\n'
    const r3 = checkMemoryRefIntegrity(md3, restoreBn, tmp)
    assert('refint_reference_style_dangling', r3.dangling.includes('feedback_d.md'))
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('memory_md_ref_integrity', e.message) }

  // T12: index merge unions by id; tags set-union
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-t12-'))
    const indexFile = path.join(tmp, 'index.jsonl')
    const tagsFile = path.join(tmp, 'tags.json')
    fs.writeFileSync(indexFile, JSON.stringify({ id: 'id-old', tags: ['t1'], category: 'decision', date: '2026-01-01' }) + '\n')
    fs.writeFileSync(tagsFile, JSON.stringify({ t1: ['id-old'] }))
    const restored = [
      { id: 'id-new', tags: ['t1', 't2'], category: 'lesson', date: '2026-05-01' }
    ]
    mergeIndexes(tmp, restored, 'skip')
    const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n')
    assert('index_merge_union', lines.length === 2)
    const tags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
    assert('tags_merge_t1', tags.t1.includes('id-old') && tags.t1.includes('id-new'))
    assert('tags_merge_t2_new', tags.t2.includes('id-new'))
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('index_merge', e.message) }

  // T13: VALID_CONFLICT_MODES, decideAction
  try {
    assert('decide_clean', decideAction('clean', 'skip') === 'create')
    assert('decide_identical', decideAction('identical', 'skip') === 'noop')
    assert('decide_normalized_skip', decideAction('normalized-equal', 'skip') === 'noop')
    assert('decide_overwrite_skip', decideAction('overwrite', 'skip') === 'skip')
    assert('decide_overwrite_force', decideAction('overwrite', 'force') === 'overwrite')
    assert('decide_overwrite_sidecar', decideAction('overwrite', 'sidecar') === 'sidecar')
  } catch (e) { bad('decide_action', e.message) }

  // T14: end-to-end dry-run (no writes)
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-1', { id: 'id-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: ['x'], summary: 'one' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-1.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    const r = run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: false, conflictMode: 'skip', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    assert('e2e_dryrun_status', r.status === 'ok' && r.mode === 'dry-run')
    assert('e2e_dryrun_no_writes', !fs.existsSync(path.join(target, 'episodes', 'id-1.md')))
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('e2e_dryrun', e.message) }

  // T15: end-to-end apply (writes + index merge)
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-1', { id: 'id-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: ['x'], summary: 'one' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-1.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    const r = run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: true
    })
    const writtenPath = path.join(target, 'episodes', 'id-1.md')
    assert('e2e_apply_status', r.status === 'ok' && r.mode === 'apply')
    assert('e2e_apply_wrote_episode', fs.existsSync(writtenPath))
    assert('e2e_apply_index_exists', fs.existsSync(path.join(target, 'index.jsonl')))
    const idx = fs.readFileSync(path.join(target, 'index.jsonl'), 'utf8')
    assert('e2e_apply_index_has_id', idx.includes('id-1'))
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('e2e_apply', e.message) }

  // T16: --include-docs + staging + atomic per-file rename + CLAUDE.md gate
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab')
    fs.mkdirSync(path.join(labRoot, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(labRoot, 'MEMORY.md'), '# Memory\n')
    fs.writeFileSync(path.join(labRoot, 'feedback_x.md'), 'feedback content\n')
    fs.writeFileSync(path.join(labRoot, 'CLAUDE.md'), 'project instructions\n')
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })

    // First run: CLAUDE.md must be refused
    const r1 = run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: true,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    assert('docs_memory_md_written', fs.existsSync(path.join(target, 'MEMORY.md')))
    assert('docs_feedback_written', fs.existsSync(path.join(target, 'feedback_x.md')))
    assert('docs_claude_md_refused', !fs.existsSync(path.join(target, 'CLAUDE.md')) && r1.summary.refused_claude_md.length === 1)

    // Second run with --restore-claude-md: writes
    const r2 = run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: true,
      restoreClaudeMd: true, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    assert('docs_claude_md_written_with_flag', fs.existsSync(path.join(target, 'CLAUDE.md')))

    // No staging dir leftovers (reviewer n3: filter symlinks so a parallel
    // test that planted a trap symlink with this prefix can't false-fail this
    // assertion under reordering).
    const stagingPattern = fs.readdirSync(target).filter(n => {
      if (!n.startsWith('.em-restore-staging-')) return false
      try {
        return !fs.lstatSync(path.join(target, n)).isSymbolicLink()
      } catch { return false }
    })
    assert('docs_no_staging_leftover', stagingPattern.length === 0)

    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('include_docs', e.message) }

  // T17: cross-source duplicate id refused without --allow-duplicate-id
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-dup', { id: 'id-dup', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'dup' })
    fs.mkdirSync(path.join(backupDir, 'a', 'episodes'), { recursive: true })
    fs.mkdirSync(path.join(backupDir, 'b', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'a', 'episodes', 'id-dup.md'), ep)
    fs.writeFileSync(path.join(backupDir, 'b', 'episodes', 'id-dup.md'), ep)
    commitBackup(backupDir)
    const ta = path.join(root, 'ta')
    const tb = path.join(root, 'tb')
    fs.mkdirSync(ta, { recursive: true })
    fs.mkdirSync(tb, { recursive: true })
    let threw = false
    try {
      run({
        backupDir, sourceMap: new Map([['a', ta], ['b', tb]]),
        fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
        apply: false, conflictMode: 'skip', force: false, includeDocs: false,
        restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
        allowDuplicateId: false, rebuildIndex: false
      })
    } catch (e) { threw = true }
    assert('cross_source_dup_refused', threw)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('cross_source_dup', e.message) }

  // T18: sidecar mode writes .from-backup, leaves live untouched
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-1', { id: 'id-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'v2' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-1.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(target, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(target, 'episodes', 'id-1.md'), 'EXISTING_DIFFERENT_CONTENT\n')
    run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'sidecar', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    const live = fs.readFileSync(path.join(target, 'episodes', 'id-1.md'), 'utf8')
    assert('sidecar_live_untouched', live === 'EXISTING_DIFFERENT_CONTENT\n')
    const sidecar = fs.readFileSync(path.join(target, 'episodes', 'id-1.md.from-backup'), 'utf8')
    assert('sidecar_written_equals_backup', sidecar === ep)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('sidecar_mode', e.message) }

  // T19: sidecar refuses if .from-backup already exists
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-1', { id: 'id-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'v2' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-1.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(target, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(target, 'episodes', 'id-1.md'), 'LIVE\n')
    fs.writeFileSync(path.join(target, 'episodes', 'id-1.md.from-backup'), 'OLD-SIDECAR\n')
    const r = run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'sidecar', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    const oldSc = fs.readFileSync(path.join(target, 'episodes', 'id-1.md.from-backup'), 'utf8')
    assert('sidecar_refuses_existing', oldSc === 'OLD-SIDECAR\n' && r.summary.sidecar_collisions.length === 1)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('sidecar_refuse_existing', e.message) }

  // T20: round-trip with [REDACTED] segment in path retains it (P0-3)
  try {
    const { root, backupDir } = makeFakeBackup()
    // Episode with [REDACTED] in body simulating em-backup output
    const ep = makeEpisode('id-1', { id: 'id-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'redacted-trail' }, 'token: [REDACTED]\nemail: [REDACTED:user_email]\n')
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-1.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    const restored = fs.readFileSync(path.join(target, 'episodes', 'id-1.md'), 'utf8')
    assert('round_trip_retains_redaction_tokens', restored === ep && restored.includes('[REDACTED]'))
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('round_trip_redacted', e.message) }

  // T21: missing source-map for matched label → throws
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-1', { id: 'id-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'one' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-1.md'), ep)
    commitBackup(backupDir)
    let threw = false
    try {
      run({
        backupDir, sourceMap: new Map(), // no map → must throw
        fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
        apply: false, conflictMode: 'skip', force: false, includeDocs: false,
        restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
        allowDuplicateId: false, rebuildIndex: false
      })
    } catch { threw = true }
    assert('missing_source_map_refused', threw)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('missing_source_map', e.message) }

  // T-extra-1: path traversal in --source-map target → refused at write time
  // (Layer-3 explicit failure-scenario test per proof-rigor v2 discipline.)
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-trav-'))
    const root = path.join(tmp, 'root')
    fs.mkdirSync(root, { recursive: true })
    let threw = false
    try {
      ensureUnder(root, path.join(tmp, 'outside.md'))
    } catch { threw = true }
    assert('path_traversal_refused', threw)
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('path_traversal_test', e.message) }

  // T-extra-2: fault-injection for staging-dir cleanup (P1-10 promise).
  // Mock fs.renameSync to throw on the 2nd call; verify staging dir is
  // cleaned up and the error propagates.
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab')
    fs.mkdirSync(path.join(labRoot, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(labRoot, 'feedback_a.md'), 'a\n')
    fs.writeFileSync(path.join(labRoot, 'feedback_b.md'), 'b\n')
    fs.writeFileSync(path.join(labRoot, 'feedback_c.md'), 'c\n')
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    const origRename = fs.renameSync
    let renameCalls = 0
    let injectedError = null
    fs.renameSync = (src, dst) => {
      // Only inject on rename calls inside our staging-finalize phase
      // (signature: source path is inside the staging dir).
      if (typeof src === 'string' && src.includes('.em-restore-staging-')) {
        renameCalls++
        if (renameCalls === 2) {
          injectedError = new Error('INJECTED_RENAME_FAILURE')
          throw injectedError
        }
      }
      return origRename.call(fs, src, dst)
    }
    let caught = null
    try {
      run({
        backupDir, sourceMap: new Map([['lab', target]]),
        fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
        apply: true, conflictMode: 'skip', force: false, includeDocs: true,
        restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
        allowDuplicateId: false, rebuildIndex: false
      })
    } catch (e) { caught = e }
    fs.renameSync = origRename
    assert('staging_fault_propagates', caught && caught.message === 'INJECTED_RENAME_FAILURE')
    // Staging dir cleanup must have run despite the throw (try/finally).
    const leftover = fs.readdirSync(target).filter(n => n.startsWith('.em-restore-staging-'))
    assert('staging_fault_no_leftover_dir', leftover.length === 0, `leftover: ${leftover.join(',')}`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('staging_fault_injection', e.message) }

  // T-extra-3: byte-identical project CLAUDE.md is a no-op even without
  // --restore-claude-md (idempotent re-runs must not refuse harmlessly).
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab')
    fs.mkdirSync(path.join(labRoot, 'episodes'), { recursive: true })
    const claudeContent = 'project instructions identical\n'
    fs.writeFileSync(path.join(labRoot, 'CLAUDE.md'), claudeContent)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'CLAUDE.md'), claudeContent)
    const r = run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: true,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    // Identical CLAUDE.md = noop, NOT refused
    assert('claude_md_identical_no_refusal', r.summary.refused_claude_md.length === 0)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('claude_md_identical_noop', e.message) }

  // T-extra-4 (F1 regression): --include-docs must NOT clobber target's
  // local-only index entries. Reviewer P0: index.jsonl + tags.json are
  // owned exclusively by mergeIndexes; discoverDocFiles must skip them.
  try {
    const { root, backupDir } = makeFakeBackup()
    // Backup contains episode id-from-backup AND a snapshot index.jsonl
    // with only that one entry (em-backup includes .jsonl in its mirror).
    const epBack = makeEpisode('id-from-backup', { id: 'id-from-backup', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: ['x'], summary: 'from-backup' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-from-backup.md'), epBack)
    fs.writeFileSync(path.join(backupDir, 'lab', 'index.jsonl'), JSON.stringify({ id: 'id-from-backup', tags: ['x'], category: 'decision', date: '2026-05-01' }) + '\n')
    fs.writeFileSync(path.join(backupDir, 'lab', 'tags.json'), JSON.stringify({ x: ['id-from-backup'] }))
    commitBackup(backupDir)

    // Target has a pre-existing local-only entry that is NOT in backup.
    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(target, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(target, 'index.jsonl'), JSON.stringify({ id: 'id-local-only', tags: ['y'], category: 'lesson', date: '2026-05-02' }) + '\n')
    fs.writeFileSync(path.join(target, 'tags.json'), JSON.stringify({ y: ['id-local-only'] }))

    run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: true,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: true
    })
    const finalIndex = fs.readFileSync(path.join(target, 'index.jsonl'), 'utf8')
    assert('include_docs_preserves_local_index', finalIndex.includes('id-local-only') && finalIndex.includes('id-from-backup'),
      `index after restore: ${finalIndex}`)
    const finalTags = JSON.parse(fs.readFileSync(path.join(target, 'tags.json'), 'utf8'))
    assert('include_docs_preserves_local_tags', (finalTags.y || []).includes('id-local-only') && (finalTags.x || []).includes('id-from-backup'),
      `tags after restore: ${JSON.stringify(finalTags)}`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('include_docs_index_preservation', e.message) }

  // T-extra-5 (F4 regression): duplicate --source-map label refused.
  try {
    let threw = false
    try {
      parseSourceMap(['a=/x', 'a=/y'])
    } catch { threw = true }
    assert('duplicate_source_map_refused', threw)
  } catch (e) { bad('duplicate_source_map', e.message) }

  // T-extra-6 (F6 regression): access_count + last_accessed preserved on
  // force-overwrite. mergeIndexes must NOT silently zero em-search history.
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-f6-'))
    const indexFile = path.join(tmp, 'index.jsonl')
    fs.writeFileSync(indexFile, JSON.stringify({
      id: 'id-1', tags: ['t'], category: 'decision', date: '2026-04-01',
      access_count: 7, last_accessed: '2026-05-01T10:00:00Z'
    }) + '\n')
    const restored = [{
      id: 'id-1', tags: ['t', 'newtag'], category: 'decision', date: '2026-05-01',
      access_count: 0, last_accessed: null
    }]
    mergeIndexes(tmp, restored, 'force')
    const final = JSON.parse(fs.readFileSync(indexFile, 'utf8').trim())
    assert('force_preserves_access_count', final.access_count === 7, `got ${final.access_count}`)
    assert('force_preserves_last_accessed', final.last_accessed === '2026-05-01T10:00:00Z', `got ${final.last_accessed}`)
    // But the new tag should land
    assert('force_carries_new_tags', final.tags.includes('newtag'))
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('force_preserves_history', e.message) }

  // T-extra-7 (F9 regression): hash-fragment links extracted as the .md path.
  try {
    const md = '- [trigger](feedback_x.md#trigger-section) — hook\n[ref]: feedback_y.md#fragment\n'
    const refs = extractMarkdownLinks(md)
    assert('hash_fragment_inline', refs.includes('feedback_x.md'))
    assert('hash_fragment_reference_style', refs.includes('feedback_y.md'))
  } catch (e) { bad('hash_fragment_links', e.message) }

  // T-extra-8 (F2 regression): explicit --rebuild-index without --apply errors
  // at CLI parse — verified by spawning the script (preserves real CLI path).
  try {
    const r = execFileSync('node', [
      new URL(import.meta.url).pathname,
      '--from', os.tmpdir(),
      '--source-map', 'x=/tmp',
      '--rebuild-index'
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    bad('rebuild_index_without_apply_refused', `expected non-zero exit; got: ${r.slice(0, 200)}`)
  } catch (e) {
    // execFileSync throws on non-zero exit; check stdout contains the error
    const stdout = (e.stdout || '').toString()
    assert('rebuild_index_without_apply_refused', stdout.includes('--rebuild-index has no effect without --apply'),
      `got: ${stdout.slice(0, 300)}`)
  }

  // T-codex-1 (Codex round-1 F1 regression): doc target has 'dir' as a FILE
  // blocking 'dir/file.md'. Pre-fix, applyEpisodeWrites wrote episodes
  // BEFORE applyDocWrites mkdir failure → episodes on disk, indexes
  // unwritten. With the validation-timing fix, preflightTargetDirs runs
  // BEFORE any episode write and throws cleanly.
  // (Defensive ordering applied: assert resource-NOT-on-disk after the
  // refusal — the test would silently pass if the temp dir vanished early.)
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab')
    fs.mkdirSync(path.join(labRoot, 'episodes'), { recursive: true })
    const ep = makeEpisode('id-codex1', { id: 'id-codex1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'codex1' })
    fs.writeFileSync(path.join(labRoot, 'episodes', 'id-codex1.md'), ep)
    fs.mkdirSync(path.join(labRoot, 'docs-dir'), { recursive: true })
    fs.writeFileSync(path.join(labRoot, 'docs-dir', 'inner.md'), 'inner content\n')
    commitBackup(backupDir)

    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(target, 'episodes'), { recursive: true })
    // Place a regular file at the path the docs-dir/ would need to be a dir at.
    fs.writeFileSync(path.join(target, 'docs-dir'), 'I am a file blocking the dir\n')

    let caught = null
    try {
      run({
        backupDir, sourceMap: new Map([['lab', target]]),
        fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
        apply: true, conflictMode: 'skip', force: false, includeDocs: true,
        restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
        allowDuplicateId: false, rebuildIndex: false
      })
    } catch (e) { caught = e }
    assert('codex1_partial_state_refused', caught !== null && /Target directory pre-creation failed|EEXIST/.test(caught.message), `expected throw, got: ${caught && caught.message}`)
    // Defensive ordering: episode must NOT have been written.
    const epExists = fs.existsSync(path.join(target, 'episodes', 'id-codex1.md'))
    const dirStillBlocking = fs.existsSync(path.join(target, 'docs-dir')) && fs.statSync(path.join(target, 'docs-dir')).isFile()
    assert('codex1_no_partial_episode_write', !epExists && dirStillBlocking, `epExists=${epExists} dirStillBlocking=${dirStillBlocking}`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('codex1_partial_state', e.message) }

  // T-codex-2 (Codex round-1 F2 regression): cross-label same-id with
  // separate target dirs and --allow-duplicate-id. Pre-fix, only one
  // target received the file. Post-fix, BOTH targets receive their
  // respective label's content.
  try {
    const { root, backupDir } = makeFakeBackup()
    // Two labels, same episode id, different content (so we can verify
    // each target got the right one).
    const epA = makeEpisode('id-shared', { id: 'id-shared', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'from-label-a' }, 'CONTENT-FROM-A\n')
    const epB = makeEpisode('id-shared', { id: 'id-shared', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'from-label-b' }, 'CONTENT-FROM-B\n')
    fs.mkdirSync(path.join(backupDir, 'a', 'episodes'), { recursive: true })
    fs.mkdirSync(path.join(backupDir, 'b', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'a', 'episodes', 'id-shared.md'), epA)
    fs.writeFileSync(path.join(backupDir, 'b', 'episodes', 'id-shared.md'), epB)
    commitBackup(backupDir)

    const ta = path.join(root, 'ta')
    const tb = path.join(root, 'tb')
    fs.mkdirSync(ta, { recursive: true })
    fs.mkdirSync(tb, { recursive: true })

    run({
      backupDir, sourceMap: new Map([['a', ta], ['b', tb]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: true, rebuildIndex: false
    })
    // Defensive ordering: target dirs should still be present so existsSync
    // is meaningful. Both files must be there with their respective content.
    assert('codex2_dirs_still_present', fs.existsSync(ta) && fs.existsSync(tb))
    const aPath = path.join(ta, 'episodes', 'id-shared.md')
    const bPath = path.join(tb, 'episodes', 'id-shared.md')
    assert('codex2_label_a_target_written', fs.existsSync(aPath), `missing: ${aPath}`)
    assert('codex2_label_b_target_written', fs.existsSync(bPath), `missing: ${bPath}`)
    if (fs.existsSync(aPath) && fs.existsSync(bPath)) {
      const aContent = fs.readFileSync(aPath, 'utf8')
      const bContent = fs.readFileSync(bPath, 'utf8')
      assert('codex2_target_a_has_label_a_content', aContent.includes('CONTENT-FROM-A'), `a content: ${aContent.slice(0, 100)}`)
      assert('codex2_target_b_has_label_b_content', bContent.includes('CONTENT-FROM-B'), `b content: ${bContent.slice(0, 100)}`)
    }
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('codex2_cross_label_dup', e.message) }

  // T-codex-3 (Codex round-1 F3 regression): force-restore must drop stale
  // tag entries from tags.json. Pre-fix, set-union into existing tags.json
  // kept old tag pointing at id; post-fix, tags.json is rebuilt from the
  // merged index map (single source of truth).
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-restore-codex3-'))
    const indexFile = path.join(tmp, 'index.jsonl')
    const tagsFile = path.join(tmp, 'tags.json')
    // Pre-existing entry with tag "old"
    fs.writeFileSync(indexFile, JSON.stringify({
      id: 'id-tags', tags: ['old'], category: 'decision', date: '2026-04-01',
      access_count: 0, last_accessed: null
    }) + '\n')
    fs.writeFileSync(tagsFile, JSON.stringify({ old: ['id-tags'] }))
    // Force-restore the same id with NEW tag only
    const restored = [{
      id: 'id-tags', tags: ['new'], category: 'decision', date: '2026-05-01',
      access_count: 0, last_accessed: null
    }]
    mergeIndexes(tmp, restored, 'force')
    const finalTags = JSON.parse(fs.readFileSync(tagsFile, 'utf8'))
    // The "old" tag must NOT contain id-tags anymore (or the bucket should be gone).
    const oldHasId = (finalTags.old || []).includes('id-tags')
    const newHasId = (finalTags.new || []).includes('id-tags')
    assert('codex3_old_tag_dropped', !oldHasId, `tags.json: ${JSON.stringify(finalTags)}`)
    assert('codex3_new_tag_present', newHasId, `tags.json: ${JSON.stringify(finalTags)}`)
    // index.jsonl should reflect new tag only
    const finalIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8').trim())
    assert('codex3_index_reflects_new_tag', finalIndex.tags.includes('new') && !finalIndex.tags.includes('old'))
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch (e) { bad('codex3_stale_tag_cleanup', e.message) }

  // T-codex-r2-1 (Round-2 R1 regression): first-time restore where the
  // target dir doesn't exist (only its parent does). Pre-fix, ensureUnder
  // called realpathSync(root) which threw ENOENT before any user-friendly
  // error could surface. The headline use case (`--source-map home-em=
  // $HOME/.episodic-memory` on a fresh machine) was broken. Fix: preflight
  // creates the target dir; restore proceeds normally.
  // Defensive ordering: verify (a) the target dir was created AND (b) the
  // episode landed inside it — vacuous if either step gets skipped.
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-r2-1', { id: 'id-r2-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'r2-1' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-r2-1.md'), ep)
    commitBackup(backupDir)

    // Target does NOT exist — only its parent does (root)
    const target = path.join(root, 'fresh-machine-target')
    assert('first_time_target_initially_absent', !fs.existsSync(target))

    run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })

    // Defensive ordering: dir created, episode landed
    assert('first_time_target_created', fs.existsSync(target) && fs.statSync(target).isDirectory())
    assert('first_time_episode_landed', fs.existsSync(path.join(target, 'episodes', 'id-r2-1.md')))
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('first_time_restore', e.message) }

  // T-codex-r2-2 (Round-2 R2 regression): staging dir uses mkdtempSync, so
  // even if an attacker plants a symlink at a guessed staging-dir name
  // before this run, the new staging dir gets a different random suffix
  // and the symlink is irrelevant.
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab')
    fs.mkdirSync(path.join(labRoot, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(labRoot, 'doc.md'), 'doc content\n')
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })

    // Plant a symlink at a predictable old-style staging path. mkdtempSync
    // generates a random name so it ignores this entirely.
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere, { recursive: true })
    const trapPath = path.join(target, '.em-restore-staging-99999-1234567890')
    fs.symlinkSync(elsewhere, trapPath)

    run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'skip', force: false, includeDocs: true,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })

    // Defensive ordering: trap symlink still exists (was never followed),
    // doc landed at the real target (not in `elsewhere` via symlink).
    assert('staging_trap_symlink_unfollowed', fs.lstatSync(trapPath).isSymbolicLink())
    assert('staging_no_leak_to_elsewhere', fs.readdirSync(elsewhere).length === 0,
      `elsewhere contents: ${fs.readdirSync(elsewhere).join(',')}`)
    assert('staging_doc_landed_in_real_target', fs.existsSync(path.join(target, 'doc.md')))

    // Also assert no leftover staging dir (mkdtempSync naming + try/finally cleanup)
    const leftover = fs.readdirSync(target).filter(n => n.startsWith('.em-restore-staging-') && !fs.lstatSync(path.join(target, n)).isSymbolicLink())
    assert('staging_no_leftover_real_dir', leftover.length === 0,
      `leftover: ${leftover.join(',')}`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('staging_mkdtemp', e.message) }

  // T-rev-M1 (reviewer M1): --allow-symlink-overwrite + --force replaces the
  // SYMLINK with a regular file; the symlink's TARGET file is untouched.
  // Pre-fix the action 'overwrite-symlink' was cosmetic (no special dispatch);
  // this test pins behavior so a future "follow the symlink" regression would
  // surface immediately.
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-rm1', { id: 'id-rm1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'rm1' }, 'BACKUP_CONTENT\n')
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-rm1.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(target, 'episodes'), { recursive: true })
    // Symlink target must be UNDER the source-map root (ensureUnder refuses
    // traversal). The invariant — pointee file preserved while link path
    // becomes a regular file — holds regardless of pointee location.
    const realFile = path.join(target, 'real-pointee.md')
    fs.writeFileSync(realFile, 'OUTSIDE_PRESERVED\n')
    fs.symlinkSync(realFile, path.join(target, 'episodes', 'id-rm1.md'))
    run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: true, conflictMode: 'force', force: true, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: true,
      allowDuplicateId: false, rebuildIndex: false
    })
    // Defensive ordering: the symlink target file MUST still exist with original content
    assert('symlink_target_file_preserved', fs.existsSync(realFile) && fs.readFileSync(realFile, 'utf8') === 'OUTSIDE_PRESERVED\n',
      `outside content: ${fs.readFileSync(realFile, 'utf8')}`)
    // The target path is now a regular file with backup content
    const linkPath = path.join(target, 'episodes', 'id-rm1.md')
    assert('link_replaced_with_regular_file', !fs.lstatSync(linkPath).isSymbolicLink())
    assert('link_path_has_backup_content', fs.readFileSync(linkPath, 'utf8').includes('BACKUP_CONTENT'))
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('symlink_target_untouched', e.message) }

  // T-rev-M2 (reviewer M2): in-process call with invalid conflictMode throws.
  // Pre-fix: only CLI dispatcher validated; programmatic callers got silent
  // skip-on-overwrite (data loss class).
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-rm2', { id: 'id-rm2', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'rm2' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-rm2.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(target, 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(target, 'episodes', 'id-rm2.md'), 'EXISTING_DIFFERENT\n')
    let threw = false
    try {
      run({
        backupDir, sourceMap: new Map([['lab', target]]),
        fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
        apply: true, conflictMode: 'forec', force: false, includeDocs: false, // typo
        restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
        allowDuplicateId: false, rebuildIndex: false
      })
    } catch (e) { threw = /Invalid conflictMode/.test(e.message) }
    assert('invalid_conflict_mode_refused_in_run', threw)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('invalid_conflict_mode', e.message) }

  // T-rev-m3a (reviewer m3): isSafeId direct unit tests. parseFrontmatter
  // can't even represent some hostile shapes (newline-containing IDs are
  // truncated at YAML line break), so we test isSafeId directly to lock
  // the contract; the indirect end-to-end check below covers what survives
  // parsing.
  try {
    assert('isSafeId_simple_lowercase', isSafeId('20260505-074256-foo-9ba3'))
    assert('isSafeId_reject_path_traversal', !isSafeId('../escape'))
    assert('isSafeId_reject_forward_slash', !isSafeId('a/b'))
    assert('isSafeId_reject_backslash', !isSafeId('a\\b'))
    assert('isSafeId_reject_nul', !isSafeId('a\0b'))
    assert('isSafeId_reject_newline', !isSafeId('a\nb'))
    assert('isSafeId_reject_tab', !isSafeId('a\tb'))
    assert('isSafeId_reject_del', !isSafeId('a\x7Fb'))
    assert('isSafeId_reject_leading_dot', !isSafeId('.hidden'))
    assert('isSafeId_reject_empty', !isSafeId(''))
    assert('isSafeId_reject_too_long', !isSafeId('a'.repeat(201)))
    assert('isSafeId_reject_non_string', !isSafeId(null) && !isSafeId(undefined) && !isSafeId(42))
  } catch (e) { bad('isSafeId_direct', e.message) }

  // T-rev-m3b: hostile fm.id shapes that survive YAML parsing get refused at
  // discovery. (Newline / NUL ids fail to round-trip through frontmatter
  // parsing — they're caught by the file-write or YAML-parse stage, not the
  // isSafeId stage. We test only shapes that DO survive parsing here.)
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab', 'episodes')
    fs.mkdirSync(labRoot, { recursive: true })
    const cases = [
      { name: 'slash', id: '../escape' },
      { name: 'leading-dot', id: '.hidden' },
      { name: 'too-long', id: 'a'.repeat(201) }
    ]
    for (const c of cases) {
      const ep = makeEpisode(c.id, { id: c.id, date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: c.name })
      fs.writeFileSync(path.join(labRoot, `case-${c.name}.md`), ep)
    }
    commitBackup(backupDir)
    const { byId } = discoverEpisodes(backupDir, ['lab'], new Map([['lab', '/tmp/x']]), [])
    assert('hostile_fm_id_rejected_e2e', byId.size === 0, `byId has ${byId.size} entries: ${[...byId.keys()].join(',')}`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('hostile_fm_id_e2e', e.message) }

  // T-rev-n2 (reviewer n2): supersedes-chain cycle detection. A→B→A
  // terminates without infinite loop and includes both members in expanded.
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab', 'episodes')
    fs.mkdirSync(labRoot, { recursive: true })
    const epA = makeEpisode('cycle-a', { id: 'cycle-a', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', supersedes: 'cycle-b', tags: ['picked'], summary: 'a' })
    const epB = makeEpisode('cycle-b', { id: 'cycle-b', date: '2026-05-02', time: '"10:00"', project: 't', category: 'decision', status: 'active', supersedes: 'cycle-a', tags: [], summary: 'b' })
    fs.writeFileSync(path.join(labRoot, 'cycle-a.md'), epA)
    fs.writeFileSync(path.join(labRoot, 'cycle-b.md'), epB)
    commitBackup(backupDir)
    const { byId } = discoverEpisodes(backupDir, ['lab'], new Map([['lab', '/tmp/x']]), [])
    const selected = new Map([['cycle-a', byId.get('cycle-a')]])
    const { expanded, chainBreaks } = expandSupersedesChain(selected, byId)
    assert('cycle_terminates', expanded.size === 2 && expanded.has('cycle-a') && expanded.has('cycle-b'))
    assert('cycle_no_chain_break', chainBreaks.length === 0)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('cycle_termination', e.message) }

  // T-rev-n2b: orphan supersedes ref produces a chain_break entry.
  try {
    const { root, backupDir } = makeFakeBackup()
    const labRoot = path.join(backupDir, 'lab', 'episodes')
    fs.mkdirSync(labRoot, { recursive: true })
    const ep = makeEpisode('orphan-tip', { id: 'orphan-tip', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', supersedes: 'missing-ancestor-id', tags: ['picked'], summary: 'orphan' })
    fs.writeFileSync(path.join(labRoot, 'orphan-tip.md'), ep)
    commitBackup(backupDir)
    const { byId } = discoverEpisodes(backupDir, ['lab'], new Map([['lab', '/tmp/x']]), [])
    const selected = new Map([['orphan-tip', byId.get('orphan-tip')]])
    const { expanded, chainBreaks } = expandSupersedesChain(selected, byId)
    assert('orphan_chain_break_surfaced', chainBreaks.length === 1 && chainBreaks[0].tip === 'orphan-tip' && chainBreaks[0].missing_ancestor === 'missing-ancestor-id')
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('orphan_chain_break', e.message) }

  // T-codex-r3-1 (Codex round-2 P1): dry-run with a NONEXISTENT source-map
  // target leaves the filesystem untouched. Pre-fix the R1 preflight
  // unconditionally mkdir'd the target dir, violating the README "no disk
  // writes" contract for dry-run.
  // Defensive ordering: assert target absent BEFORE the run AND target
  // STILL absent after — vacuous if cleanup ran early.
  try {
    const { root, backupDir } = makeFakeBackup()
    const ep = makeEpisode('id-r3-1', { id: 'id-r3-1', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'r3-1' })
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-r3-1.md'), ep)
    commitBackup(backupDir)
    const target = path.join(root, 'never-create-on-dry-run')
    assert('r3_1_target_absent_pre_run', !fs.existsSync(target))

    const r = run({
      backupDir, sourceMap: new Map([['lab', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: false, conflictMode: 'skip', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: false, rebuildIndex: false
    })
    assert('r3_1_dry_run_status_ok', r.status === 'ok' && r.mode === 'dry-run')
    // Defensive ordering: target STILL absent at check time
    assert('r3_1_target_still_absent', !fs.existsSync(target),
      `target was created during dry-run: ${fs.readdirSync(path.dirname(target)).filter(n => n === path.basename(target))}`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('r3_1_dry_run_no_dir_creation', e.message) }

  // T-codex-r3-2 (Codex round-2 P1): failed validation (invalid category)
  // leaves a nonexistent target absent. Pre-fix preflight ran BEFORE
  // category validation and side-effected on a request that would later
  // fail. After: category validation runs FIRST.
  try {
    const { root, backupDir } = makeFakeBackup()
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    commitBackup(backupDir)
    const target = path.join(root, 'never-create-on-bad-category')
    assert('r3_2_target_absent_pre_run', !fs.existsSync(target))

    let threw = false
    try {
      run({
        backupDir, sourceMap: new Map([['lab', target]]),
        fromDate: undefined, toDate: undefined, tags: [], categories: ['BOGUS_CATEGORY'], sources: [],
        apply: true, conflictMode: 'skip', force: false, includeDocs: false,
        restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
        allowDuplicateId: false, rebuildIndex: false
      })
    } catch (e) { threw = /Invalid --category/.test(e.message) }
    assert('r3_2_invalid_category_throws', threw)
    // Defensive ordering: target STILL absent at check time
    assert('r3_2_target_still_absent', !fs.existsSync(target),
      `target was created before category validation`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('r3_2_invalid_category_no_dir_creation', e.message) }

  // T-codex-r3-3: dedicated duplicate_skips report field (Codex round-2
  // non-blocking note). Cross-source same-id mapped to same target, with
  // --allow-duplicate-id: first entry wins, second appears in
  // duplicate_skips (not in symlink_rejects.target).
  try {
    const { root, backupDir } = makeFakeBackup()
    const epA = makeEpisode('shared-id', { id: 'shared-id', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'from-a' }, 'A\n')
    const epB = makeEpisode('shared-id', { id: 'shared-id', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'from-b' }, 'B\n')
    fs.mkdirSync(path.join(backupDir, 'a', 'episodes'), { recursive: true })
    fs.mkdirSync(path.join(backupDir, 'b', 'episodes'), { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'a', 'episodes', 'shared-id.md'), epA)
    fs.writeFileSync(path.join(backupDir, 'b', 'episodes', 'shared-id.md'), epB)
    commitBackup(backupDir)
    // Both labels mapped to the SAME target dir — same-target same-id collision
    const target = path.join(root, 'shared-target')
    fs.mkdirSync(target, { recursive: true })
    const r = run({
      backupDir, sourceMap: new Map([['a', target], ['b', target]]),
      fromDate: undefined, toDate: undefined, tags: [], categories: [], sources: [],
      apply: false, conflictMode: 'skip', force: false, includeDocs: false,
      restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
      allowDuplicateId: true, rebuildIndex: false
    })
    assert('r3_3_duplicate_skips_field_present', Array.isArray(r.summary.duplicate_skips))
    assert('r3_3_duplicate_skips_records_collision', r.summary.duplicate_skips.length === 1 && r.summary.duplicate_skips[0].id === 'shared-id',
      `duplicate_skips: ${JSON.stringify(r.summary.duplicate_skips)}`)
    // Should NOT appear under symlink_rejects.target (reviewer NIT-1:
    // tighten — there are no symlinks in this fixture, so length must be
    // exactly 0; substring check would pass vacuously under future renames).
    assert('r3_3_no_symlink_rejects_at_all', r.summary.symlink_rejects.target.length === 0,
      `symlink_rejects.target leaked: ${JSON.stringify(r.summary.symlink_rejects.target)}`)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('r3_3_duplicate_skips_field', e.message) }

  // T-codex-r3-4 (reviewer MINOR-1): parameterized "every pre-apply throw
  // leaves a nonexistent target absent." Codex caught one member (invalid
  // category); the same invariant must hold for ALL pre-apply validation
  // throws. Single test walks the class so a future regression in any
  // member is caught.
  try {
    const cases = [
      {
        name: 'invalid_category',
        opts: { categories: ['BAD'], sources: [], allowDuplicateId: false },
        setup: (backupDir) => {
          fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
        },
        errMatch: /Invalid --category/
      },
      {
        name: 'unknown_source',
        opts: { categories: [], sources: ['nonexistent-label'], allowDuplicateId: false },
        setup: (backupDir) => {
          fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
        },
        errMatch: /--source "nonexistent-label" not found/
      },
      {
        name: 'unmapped_label_with_episodes',
        opts: { categories: [], sources: [], allowDuplicateId: false, sourceMapStrategy: 'wrong-label' },
        setup: (backupDir) => {
          // Episode under label "lab" but the test will pass --source-map other-label=...
          fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
          const ep = makeEpisode('id-um', { id: 'id-um', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'um' })
          fs.writeFileSync(path.join(backupDir, 'lab', 'episodes', 'id-um.md'), ep)
        },
        errMatch: /no --source-map|Pass --source-map/
      },
      {
        name: 'cross_source_dup_strict',
        opts: { categories: [], sources: [], allowDuplicateId: false },
        setup: (backupDir) => {
          fs.mkdirSync(path.join(backupDir, 'a', 'episodes'), { recursive: true })
          fs.mkdirSync(path.join(backupDir, 'b', 'episodes'), { recursive: true })
          const ep = makeEpisode('dup', { id: 'dup', date: '2026-05-01', time: '"10:00"', project: 't', category: 'decision', status: 'active', tags: [], summary: 'd' })
          fs.writeFileSync(path.join(backupDir, 'a', 'episodes', 'dup.md'), ep)
          fs.writeFileSync(path.join(backupDir, 'b', 'episodes', 'dup.md'), ep)
        },
        errMatch: /multiple source labels/,
        useTwoLabels: true
      }
    ]
    for (const c of cases) {
      const { root, backupDir } = makeFakeBackup()
      c.setup(backupDir)
      commitBackup(backupDir)
      const target1 = path.join(root, `target-${c.name}-1`)
      const target2 = path.join(root, `target-${c.name}-2`)
      let sourceMap
      if (c.opts.sourceMapStrategy === 'wrong-label') {
        sourceMap = new Map([['other-label', target1]])
      } else if (c.useTwoLabels) {
        sourceMap = new Map([['a', target1], ['b', target2]])
      } else {
        sourceMap = new Map([['lab', target1]])
      }
      assert(`r3_4_${c.name}_target_absent_pre`, !fs.existsSync(target1) && !fs.existsSync(target2))
      let threw = false
      let actualErr = null
      try {
        run({
          backupDir, sourceMap,
          fromDate: undefined, toDate: undefined, tags: [],
          categories: c.opts.categories, sources: c.opts.sources,
          apply: true, conflictMode: 'skip', force: false, includeDocs: false,
          restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
          allowDuplicateId: c.opts.allowDuplicateId, rebuildIndex: false
        })
      } catch (e) {
        actualErr = e.message
        threw = c.errMatch.test(e.message)
      }
      assert(`r3_4_${c.name}_throws_expected`, threw, `expected ${c.errMatch}, got: ${actualErr}`)
      // Defensive ordering: target STILL absent at check time
      assert(`r3_4_${c.name}_target_still_absent`, !fs.existsSync(target1) && !fs.existsSync(target2),
        `targets should be absent after ${c.name} throw`)
      fs.rmSync(root, { recursive: true, force: true })
    }
  } catch (e) { bad('r3_4_pre_apply_throws_no_side_effect', e.message) }

  // T22: invalid category → throws
  try {
    const { root, backupDir } = makeFakeBackup()
    fs.mkdirSync(path.join(backupDir, 'lab', 'episodes'), { recursive: true })
    commitBackup(backupDir)
    let threw = false
    try {
      run({
        backupDir, sourceMap: new Map([['lab', '/tmp']]),
        fromDate: undefined, toDate: undefined, tags: [], categories: ['NOT_A_REAL_CATEGORY'], sources: [],
        apply: false, conflictMode: 'skip', force: false, includeDocs: false,
        restoreClaudeMd: false, skipMemoryMd: false, allowSymlinkOverwrite: false,
        allowDuplicateId: false, rebuildIndex: false
      })
    } catch { threw = true }
    assert('invalid_category_refused', threw)
    fs.rmSync(root, { recursive: true, force: true })
  } catch (e) { bad('invalid_category', e.message) }

  return { pass, fail, skipped, total: pass + fail + skipped, results }
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------
function usage() {
  return `Usage:
  em-restore.mjs --from <backup-dir> --source-map LABEL=DIR [--source-map LABEL=DIR ...]
                 [--from-date YYYY-MM-DD] [--to-date YYYY-MM-DD]
                 [--tag T]... [--category C]... [--source LABEL]...
                 [--dry-run | --apply]
                 [--conflict-mode skip|sidecar|force] [--force]
                 [--include-docs] [--restore-claude-md] [--skip-memory-md]
                 [--allow-duplicate-id] [--allow-symlink-overwrite]
                 [--rebuild-index | --no-rebuild-index]
                 [--self-test]

Default mode is --dry-run. --apply required for any disk write.
Lossy-data note: backup is content+path-redacted; restore CANNOT undo redaction.`
}

try {
  if (bool('--self-test')) {
    const r = selfTest()
    out({ status: r.fail === 0 ? 'ok' : 'fail', ...r })
    process.exit(r.fail === 0 ? 0 : 1)
  } else if (bool('--help') || bool('-h')) {
    out({ status: 'help', script: 'em-restore.mjs', usage: usage() })
  } else {
    const backupDir = expandHome(flag('--from'))
    if (!backupDir) {
      out({ status: 'error', message: 'Missing --from <backup-dir>', usage: usage() })
      process.exit(2)
    }
    const sourceMap = parseSourceMap(multiFlag('--source-map'))
    const fromDate = flag('--from-date')
    const toDate = flag('--to-date')
    const tags = multiFlag('--tag')
    const categories = multiFlag('--category')
    const sources = multiFlag('--source')
    const apply = bool('--apply')
    const dryRun = bool('--dry-run') || !apply
    const conflictModeRaw = flag('--conflict-mode') || 'skip'
    if (!VALID_CONFLICT_MODES.includes(conflictModeRaw)) {
      throw new Error(`Invalid --conflict-mode "${conflictModeRaw}". Must be one of: ${VALID_CONFLICT_MODES.join(', ')}`)
    }
    const force = bool('--force')
    const includeDocs = bool('--include-docs')
    const restoreClaudeMd = bool('--restore-claude-md')
    const skipMemoryMd = bool('--skip-memory-md')
    const allowSymlinkOverwrite = bool('--allow-symlink-overwrite')
    const allowDuplicateId = bool('--allow-duplicate-id')
    const noRebuild = bool('--no-rebuild-index')
    const explicitRebuild = bool('--rebuild-index')
    // F2 (code review): explicit --rebuild-index without --apply is
    // a no-op trap. Refuse early so the user notices the missing --apply.
    if (explicitRebuild && !apply) {
      throw new Error('--rebuild-index has no effect without --apply (dry-run never writes). Pass --apply, or remove --rebuild-index.')
    }
    // Default: rebuild ON when --apply, OFF for dry-run.
    let rebuildIndex
    if (noRebuild) rebuildIndex = false
    else if (explicitRebuild) rebuildIndex = true
    else rebuildIndex = !!apply

    const r = run({
      backupDir, sourceMap, fromDate, toDate, tags, categories, sources,
      apply: !dryRun, conflictMode: conflictModeRaw, force,
      includeDocs, restoreClaudeMd, skipMemoryMd,
      allowSymlinkOverwrite, allowDuplicateId, rebuildIndex
    })
    out(r)
  }
} catch (e) {
  // F3 (code review): if applyDocWrites partially applied before failing,
  // surface which files made it so the user has a clear inventory rather
  // than discovering the partial state via filesystem walk.
  const errPayload = { status: 'error', message: String(e.message || e), stack: e.stack }
  if (Array.isArray(e.applied_before_failure)) errPayload.applied_before_failure = e.applied_before_failure
  if (e.staging_dir) errPayload.staging_dir = e.staging_dir
  out(errPayload)
  process.exit(1)
}
