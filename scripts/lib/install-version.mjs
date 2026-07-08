/**
 * install-version.mjs — Layer 1 update-distribution primitives: version
 * manifests, the consumer registry, the checksum-guarded update sweep, and the
 * session-start dist-cache sync.
 *
 * The distribution problem this closes: install.mjs is copy-based; nothing
 * recorded where copies went, what version they were, or offered an update
 * path, so consuming projects silently fell behind on every repo update.
 *
 * Four cooperating pieces (all zero-dep, Node stdlib only):
 *
 *   1. VERSION MANIFEST — every install writes a manifest at the target root
 *      (global: ~/.episodic-memory/install-manifest.json; per-project:
 *      <project>/.episodic-memory-install.json) recording source version
 *      (git SHA of the repo install.mjs ran from, degrading to a content hash
 *      of the deployed file set when git is unavailable), timestamp, tool, and
 *      the artifact list with per-file sha256 (Node crypto, no shelling out).
 *
 *   2. CONSUMER REGISTRY — ~/.episodic-memory/installs.json, one entry per
 *      (project_path, tool): { project_path, tool, version,
 *      enforcement_installed, last_install_ts }. Malformed existing registry
 *      degrades (rebuilt from scratch with a stderr note), never blocks.
 *
 *   3. UPDATE SWEEP — updateConsumers(): iterate the registry; per artifact,
 *      compare on-disk sha256 to the manifest checksum. Unmodified → refresh
 *      to the current repo version; user-MODIFIED → skip with a warning
 *      (never silently overwritten — Principle 10); vanished projects →
 *      pruned. Only registry-listed projects are touched (Principle 3), and
 *      enforcement-class artifacts are never refreshed for a project whose
 *      registry says enforcement_installed:false.
 *
 *   4. DIST CACHE + SESSION SYNC — install.mjs deploys the current artifact
 *      payloads (copy SOURCE only; zero registrations, so Principle 12 is
 *      untouched) to ~/.episodic-memory/dist/<version>/<repo-relative-path>.
 *      syncProjectFromDist() applies the same checksum-guarded refresh from
 *      that cache, so the opt-in SessionStart auto-update works without the
 *      repo checkout present.
 *
 * MANIFEST MEMBERSHIP RULE (the safety core): an artifact is recorded ONLY
 * when its on-disk bytes equal the repo source at manifest-write time. A
 * skipped-divergent user file is therefore never recorded as "ours", so no
 * later sweep can overwrite it (its carried-forward stale entry keeps warning
 * instead). Refreshes never ADD files — manifest membership is the consent.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import {
  HOOK_SPECS, SESSION_END_SCRIPT,
  enforcementHookLibBasenames, enforcementEntryScripts, enforcementBundleLibs,
  globalEntryScripts, relocatedOnlyLibs, bp1EntryScripts, bp1ClosureLibs,
} from './install-manifest.mjs'

export const PROJECT_MANIFEST_BASENAME = '.episodic-memory-install.json'
export const GLOBAL_MANIFEST_BASENAME = 'install-manifest.json'
export const REGISTRY_BASENAME = 'installs.json'

export function projectManifestPath(projectDir) {
  return path.join(projectDir, PROJECT_MANIFEST_BASENAME)
}
export function globalManifestPath(globalDir) {
  return path.join(globalDir, GLOBAL_MANIFEST_BASENAME)
}
export function registryPath(globalDir) {
  return path.join(globalDir, REGISTRY_BASENAME)
}

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function toPosix(p) {
  return p.split(path.sep).join('/')
}

// Reader-degrade primitive: parse a JSON file to a plain object, or null on
// ANY failure (absent, unreadable, malformed, non-object). Never throws.
export function readJsonSafe(p) {
  let raw
  try { raw = fs.readFileSync(p, 'utf8') } catch { return null }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return null }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

// Atomic JSON write (temp + rename), unique temp name so concurrent writers
// can't race each other's rename (same rationale as install.mjs uniqueTmpPath).
export function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

// ---------------------------------------------------------------------------
// Source version: git SHA of the repo install.mjs runs from, with graceful
// degrade to a content hash of the deployed file set when git is unavailable
// (no git binary, not a repo, etc.). The degrade token is prefixed `content-`
// so consumers can tell the two forms apart.
// ---------------------------------------------------------------------------
export function gitHeadVersion(repoDir) {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return /^[0-9a-f]{40}$/.test(out) ? out : null
  } catch {
    return null
  }
}

export function contentVersion(artifacts) {
  const lines = (artifacts || [])
    .map((a) => `${a.source || a.path}:${a.sha256}`)
    .sort()
    .join('\n')
  return 'content-' + crypto.createHash('sha256').update(lines).digest('hex')
}

export function resolveSourceVersion(repoDir, artifacts) {
  return gitHeadVersion(repoDir) || contentVersion(artifacts)
}

// ---------------------------------------------------------------------------
// Artifact pair enumeration. A "pair" is a repo source file plus its install
// destination. Enumeration lists the full destination UNIVERSE for the target;
// buildArtifactEntries() then applies the membership rule (dest exists AND
// byte-equals source) so only repo-sourced copies are recorded.
//
// kind drives the sweep's enforcement consent guard:
//   core        — skills, instruction files, bp1 hooks (always-on set)
//   enforcement — the --install-enforcement set (gates, engine, contract cfg)
//   capability  — second-opinion per-project files
//
// v1 scope: the claude-code-family per-project sets + the shared instruction
// files (cursor/codex/pi/opencode/windsurf). The opencode/codex/pi-agent
// ENFORCEMENT adapter trees are not enumerated yet (registry still records
// those installs; the sweep simply has no artifact rows to refresh for them).
// ---------------------------------------------------------------------------
export function perProjectArtifactPairs(repoDir, projectDir) {
  const pairs = []
  const seenDest = new Set()
  const add = (sourceRel, destRel, kind) => {
    const source = path.join(repoDir, sourceRel)
    if (!fs.existsSync(source)) return
    const destKey = toPosix(destRel)
    if (seenDest.has(destKey)) return
    seenDest.add(destKey)
    pairs.push({
      source,
      dest: path.join(projectDir, destRel),
      sourceRel: toPosix(sourceRel),
      destRel: destKey,
      kind,
    })
  }

  // Core: instruction/skill artifacts (all tools) + the always-on bp1 set.
  add('instructions/SKILL.md', '.claude/skills/episodic-memory/SKILL.md', 'core')
  add('skills/classify-correction/SKILL.md', '.claude/skills/classify-correction/SKILL.md', 'core')
  add('instructions/cursor.mdc', '.cursor/rules/episodic-memory.mdc', 'core')
  add('instructions/SKILL.md', '.agents/skills/episodic-memory/SKILL.md', 'core')
  add('instructions/SKILL.md', '.opencode/skills/episodic-memory/SKILL.md', 'core')
  // .windsurfrules is create-or-APPEND; the append shape never passes the
  // byte-equality membership rule, so only whole-file installs are tracked.
  add('instructions/windsurf.md', '.windsurfrules', 'core')
  add('.claude/hooks/bp1-approval-check.sh', '.claude/hooks/bp1-approval-check.sh', 'core')
  add('.claude/hooks/bp1-sweep-on-session.sh', '.claude/hooks/bp1-sweep-on-session.sh', 'core')
  for (const f of bp1EntryScripts(repoDir)) add(`scripts/${f}`, `.claude/hooks/${f}`, 'core')
  for (const f of bp1ClosureLibs(repoDir)) add(`scripts/lib/${f}`, `.claude/hooks/lib/${f}`, 'core')

  // Enforcement: the --install-enforcement per-project set.
  for (const f of new Set(HOOK_SPECS.map((s) => s.file))) {
    add(`plugins/claude-code/hooks/${f}`, `.claude/hooks/${f}`, 'enforcement')
  }
  for (const f of enforcementHookLibBasenames(repoDir)) {
    add(`plugins/claude-code/hooks/lib/${f}`, `.claude/hooks/lib/${f}`, 'enforcement')
  }
  add(`scripts/${SESSION_END_SCRIPT}`, `.claude/hooks/${SESSION_END_SCRIPT}`, 'enforcement')
  for (const f of enforcementEntryScripts(repoDir)) {
    if (/^bp1-/.test(f)) continue // bp1 family is core, added above
    add(`scripts/${f}`, `.claude/hooks/${f}`, 'enforcement')
  }
  const bp1Libs = new Set(bp1ClosureLibs(repoDir))
  for (const f of enforcementBundleLibs(repoDir)) {
    if (bp1Libs.has(f)) continue
    add(`scripts/lib/${f}`, `.claude/hooks/lib/${f}`, 'enforcement')
  }
  for (const f of ['taxonomy.json', 'events.json', 'enforce-config.schema.json', 'bp-001.json']) {
    add(`patterns/${f}`, `.claude/hooks/patterns/${f}`, 'enforcement')
  }
  add('plugins/_index.json', '.claude/hooks/plugins/_index.json', 'enforcement')

  // Capability: second-opinion per-project files (the derived quickref is
  // GENERATED, has no repo source, and is deliberately not tracked).
  add('plugins/claude-code/hooks/second-opinion-gate.mjs', '.claude/hooks/second-opinion-gate.mjs', 'capability')
  add('scripts/second-opinion/lib/registry-validator.mjs', '.claude/hooks/lib/registry-validator.mjs', 'capability')
  add('scripts/lib/local-dir.mjs', '.claude/hooks/lib/local-dir.mjs', 'capability')
  add('plugins/claude-code/hooks/lib/so-timeout-floor.mjs', '.claude/hooks/lib/so-timeout-floor.mjs', 'capability')
  add('plugins/second-opinion/runbooks/harness.md', '.claude/hooks/runbooks/second-opinion-harness.md', 'capability')

  return pairs
}

export function globalArtifactPairs(repoDir, globalDir) {
  const pairs = []
  const add = (sourceRel, destRel) => {
    const source = path.join(repoDir, sourceRel)
    if (!fs.existsSync(source)) return
    pairs.push({
      source,
      dest: path.join(globalDir, destRel),
      sourceRel: toPosix(sourceRel),
      destRel: toPosix(destRel),
      kind: 'core',
    })
  }
  for (const f of globalEntryScripts(repoDir)) add(`scripts/${f}`, `scripts/${f}`)
  const relocated = new Set(relocatedOnlyLibs(repoDir))
  const libDir = path.join(repoDir, 'scripts', 'lib')
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir).filter((n) => n.endsWith('.mjs') && !relocated.has(n))) {
      add(`scripts/lib/${f}`, `scripts/lib/${f}`)
    }
  }
  // second-opinion subtree (recursive copy in install.mjs).
  const soRoot = path.join(repoDir, 'scripts', 'second-opinion')
  const walk = (dir, rel) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(path.join(dir, e.name), r)
      else if (e.isFile()) add(`scripts/second-opinion/${r}`, `scripts/second-opinion/${r}`)
    }
  }
  walk(soRoot, '')
  add('patterns/_index.json', 'patterns/_index.json')
  add('categories.json', 'categories.json')
  add('docs/EM_SCRIPTS_GUIDE.md', 'EM_SCRIPTS_GUIDE.md')
  return pairs
}

// ---------------------------------------------------------------------------
// Manifest build + merge.
// ---------------------------------------------------------------------------

// Membership rule: record an artifact ONLY when its destination exists and
// byte-equals the repo source right now (i.e. it is provably our copy).
export function buildArtifactEntries(pairs) {
  const out = []
  for (const p of pairs) {
    if (!fs.existsSync(p.dest)) continue
    let destSha, srcSha
    try {
      destSha = sha256File(p.dest)
      srcSha = sha256File(p.source)
    } catch { continue }
    if (destSha !== srcSha) continue
    out.push({ path: p.destRel, source: p.sourceRel, kind: p.kind, sha256: destSha })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

// Merge a freshly built entry list with the previous manifest: fresh entries
// win by path; previous entries whose file still exists are carried forward
// (this is what keeps a user-MODIFIED artifact visible to the sweep as
// "modified" instead of silently dropping off the radar). Entries whose file
// is gone are dropped (a deliberate deletion is respected — never re-added).
export function mergeArtifactEntries(previousManifest, freshEntries, targetRoot) {
  const byPath = new Map(freshEntries.map((e) => [e.path, e]))
  const prev = previousManifest && Array.isArray(previousManifest.artifacts)
    ? previousManifest.artifacts : []
  for (const e of prev) {
    if (!e || typeof e.path !== 'string' || typeof e.sha256 !== 'string') continue
    if (byPath.has(e.path)) continue
    if (!fs.existsSync(path.join(targetRoot, e.path))) continue
    byPath.set(e.path, e)
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function buildManifest({ scope, tool, sourceVersion, sourceRepo, artifacts }) {
  return {
    schema_version: 1,
    scope,
    tool: tool || null,
    source_version: sourceVersion,
    source_repo: sourceRepo,
    installed_at: new Date().toISOString(),
    artifacts,
  }
}

// ---------------------------------------------------------------------------
// Consumer registry.
// ---------------------------------------------------------------------------
export function normalizeProjectPath(p) {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

// Degrade-not-throw: malformed/alien registry shape → rebuild from scratch
// with a stderr note; never block the install.
export function readRegistry(regPath) {
  let raw
  try { raw = fs.readFileSync(regPath, 'utf8') } catch { return { entries: [], rebuilt: false } }
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.entries)) {
    console.error(`episodic-memory: consumer registry at ${regPath} is malformed; rebuilding from scratch (old content ignored).`)
    return { entries: [], rebuilt: true }
  }
  const entries = parsed.entries.filter((e) =>
    e && typeof e === 'object' && !Array.isArray(e) &&
    typeof e.project_path === 'string' && typeof e.tool === 'string')
  if (entries.length !== parsed.entries.length) {
    console.error(`episodic-memory: dropped ${parsed.entries.length - entries.length} malformed entr(y/ies) from ${regPath}.`)
  }
  return { entries, rebuilt: false }
}

export function writeRegistry(regPath, entries) {
  const sorted = [...entries].sort((a, b) =>
    a.project_path === b.project_path
      ? a.tool.localeCompare(b.tool)
      : a.project_path.localeCompare(b.project_path))
  writeJsonAtomic(regPath, { schema_version: 1, entries: sorted })
}

// Upsert entries deduped by (project_path, tool). `updates` entries fully
// replace matching existing entries.
export function upsertRegistryEntries(regPath, updates) {
  const { entries } = readRegistry(regPath)
  const key = (e) => `${e.project_path} ${e.tool}`
  const map = new Map(entries.map((e) => [key(e), e]))
  for (const u of updates) map.set(key(u), u)
  writeRegistry(regPath, [...map.values()])
  return map.size
}
