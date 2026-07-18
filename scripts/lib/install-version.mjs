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
import { resolveLocalDir } from './local-dir.mjs'
import { mintStoreIdentity, resolveStoreIdentity } from './store-identity.mjs'

export const PROJECT_MANIFEST_BASENAME = '.episodic-memory-install.json'
export const GLOBAL_MANIFEST_BASENAME = 'install-manifest.json'
export const REGISTRY_BASENAME = 'installs.json'
export const DIST_DIR_BASENAME = 'dist'

export function projectManifestPath(projectDir) {
  return path.join(projectDir, PROJECT_MANIFEST_BASENAME)
}
export function globalManifestPath(globalDir) {
  return path.join(globalDir, GLOBAL_MANIFEST_BASENAME)
}
export function registryPath(globalDir) {
  return path.join(globalDir, REGISTRY_BASENAME)
}
export function distDir(globalDir, version) {
  return path.join(globalDir, DIST_DIR_BASENAME, version)
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

  // Codex RFC-009 advisory activation runtime. The generated deployed manifest
  // is intentionally excluded because it carries project_identity; the owned
  // hook/runtime bytes are stable and checksum-refreshable.
  for (const file of [
    'activation-prompt.sh', 'activation-tool.sh', 'activation-sessionstart.sh',
    'activation-hook-run.mjs', 'activation-match.mjs', 'json-instance-validate.mjs',
  ]) {
    add(`plugins/codex-activation/hooks/${file}`, `.codex/episodic-memory-activation/hooks/${file}`, 'capability')
  }

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

// The unique payload source set behind the per-project pairs — what the dist
// cache mirrors (keyed by repo-relative path, matching manifest `source`).
export function perProjectSourceSet(repoDir) {
  const seen = new Map()
  for (const p of perProjectArtifactPairs(repoDir, repoDir /* dests unused */)) {
    if (!seen.has(p.sourceRel)) seen.set(p.sourceRel, p.source)
  }
  return seen
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
  writeJsonAtomic(regPath, { schema_version: 2, entries: sorted })
}

// Upsert entries deduped by (project_path, tool). `updates` entries fully
// replace matching existing entries.
export function upsertRegistryEntries(regPath, updates) {
  const { entries } = readRegistry(regPath)
  const key = (e) => `${e.project_path}${String.fromCharCode(0)}${e.tool}`
  const map = new Map(entries.map((e) => [key(e), e]))
  for (const u of updates) map.set(key(u), u)
  // RFC-012 P2 REQ-6: mirror store identities into every row before the write;
  // fail-loud collisions (copied store / ambiguous alias / duplicate chain)
  // THROW here and abort the registry write (callers surface the message).
  const mirrored = mirrorStoreIdentities([...map.values()])
  writeRegistry(regPath, mirrored)
  return mirrored.length
}

// ---------------------------------------------------------------------------
// Checksum-guarded refresh core — shared by the update sweep (sources = repo)
// and the session-start auto-update (sources = dist cache).
//
// Per manifest artifact:
//   on-disk sha == manifest sha  → OURS, unmodified → refresh to the current
//                                  source bytes (skip when already current)
//   on-disk sha != manifest sha  → user-MODIFIED → skip + report (P10)
//   dest missing                 → user deleted → skip + report, never re-add
//   kind enforcement, consent off→ skip silently (spec guard)
//   source unavailable           → skip + report (repo/cache lacks the file)
// ---------------------------------------------------------------------------
export function refreshProjectArtifacts({ projectDir, manifest, resolveSource, allowEnforcement, dryRun }) {
  const refreshed = []          // [{path, sha256}]
  const skippedModified = []    // [{path, reason: 'modified'|'missing'}]
  const missingSource = []      // [path]
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  for (const a of artifacts) {
    if (!a || typeof a.path !== 'string' || typeof a.sha256 !== 'string') continue
    if (a.kind === 'enforcement' && !allowEnforcement) continue
    const dest = path.join(projectDir, a.path)
    if (!fs.existsSync(dest)) {
      skippedModified.push({ path: a.path, reason: 'missing' })
      continue
    }
    let diskSha
    try { diskSha = sha256File(dest) } catch { continue }
    if (diskSha !== a.sha256) {
      skippedModified.push({ path: a.path, reason: 'modified' })
      continue
    }
    const src = resolveSource(a)
    if (!src || !fs.existsSync(src)) {
      missingSource.push(a.path)
      continue
    }
    let srcSha
    try { srcSha = sha256File(src) } catch { missingSource.push(a.path); continue }
    if (srcSha === diskSha) continue // already current
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      // Executables: hooks + hook scripts are installed 0755 by install.mjs.
      if (a.path.startsWith('.claude/hooks/') && /\.(sh|mjs)$/.test(a.path)) {
        try { fs.chmodSync(dest, 0o755) } catch {}
      }
    }
    refreshed.push({ path: a.path, sha256: srcSha })
  }
  return { refreshed, skippedModified, missingSource }
}

// In-place manifest update after a refresh: bump refreshed artifact hashes +
// the manifest version/timestamp. Modified entries keep their old sha so the
// sweep keeps flagging them.
export function applyRefreshToManifest(manifest, refreshed, newVersion) {
  const byPath = new Map((manifest.artifacts || []).map((a) => [a.path, a]))
  for (const r of refreshed) {
    const a = byPath.get(r.path)
    if (a) a.sha256 = r.sha256
  }
  manifest.source_version = newVersion
  manifest.installed_at = new Date().toISOString()
  return manifest
}

// ---------------------------------------------------------------------------
// UPDATE SWEEP (install.mjs --update-consumers [--dry-run]).
// Returns one JSON-able report; a dry run computes the identical report and
// writes NOTHING (tests assert byte-parity of the fixture tree).
// ---------------------------------------------------------------------------
export function updateConsumers({ repoDir, globalDir, dryRun = false }) {
  const regPath = registryPath(globalDir)
  const { entries } = readRegistry(regPath)
  const globalArtifacts = buildArtifactEntries(globalArtifactPairs(repoDir, globalDir))
  const version = resolveSourceVersion(repoDir, globalArtifacts)
  const report = {
    projects_scanned: 0,
    refreshed: [],
    skipped_modified: [],
    pruned: [],
    skipped_no_manifest: [],
    dry_run: !!dryRun,
  }

  const byProject = new Map()
  for (const e of entries) {
    if (!byProject.has(e.project_path)) byProject.set(e.project_path, [])
    byProject.get(e.project_path).push(e)
  }

  const keptEntries = []
  const now = new Date().toISOString()
  for (const [projectPath, projEntries] of [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    report.projects_scanned++
    if (!fs.existsSync(projectPath)) {
      report.pruned.push(projectPath)
      continue // entries dropped (pruned from registry on a real run)
    }
    const mPath = projectManifestPath(projectPath)
    const manifest = readJsonSafe(mPath)
    if (!manifest || !Array.isArray(manifest.artifacts)) {
      report.skipped_no_manifest.push(projectPath)
      keptEntries.push(...projEntries)
      continue
    }
    const allowEnforcement = projEntries.some((e) => e.enforcement_installed === true)
    const res = refreshProjectArtifacts({
      projectDir: projectPath,
      manifest,
      resolveSource: (a) => (typeof a.source === 'string' ? path.join(repoDir, a.source) : null),
      allowEnforcement,
      dryRun,
    })
    for (const s of res.skippedModified) {
      report.skipped_modified.push({ project: projectPath, path: s.path, reason: s.reason })
      console.error(`! ${path.join(projectPath, s.path)} — ${s.reason === 'missing' ? 'removed locally' : 'locally modified'}; left untouched (re-run install.mjs against this project to review)`)
    }
    const versionChanges = manifest.source_version !== version
    if (res.refreshed.length > 0 || versionChanges) {
      report.refreshed.push({
        project: projectPath,
        version,
        files: res.refreshed.map((r) => r.path).sort(),
      })
      if (!dryRun) {
        applyRefreshToManifest(manifest, res.refreshed, version)
        writeJsonAtomic(mPath, manifest)
        for (const e of projEntries) {
          keptEntries.push({ ...e, version, last_install_ts: now })
        }
        continue
      }
    }
    keptEntries.push(...projEntries)
  }

  if (!dryRun && (report.pruned.length > 0 || report.refreshed.length > 0)) {
    // F2 fold (GLM r1 MAJOR-2): mirror store identities on the sweep path too,
    // so a post-rebind/detach registry carries the fresh active id + aliases
    // (otherwise the sweep writes the stale active id from the prior upsert and
    // omits store_aliases). The merge happens through mirrorStoreIdentities,
    // NOT upsertRegistryEntries — upsert would read-merge and resurrect pruned rows.
    writeRegistry(regPath, mirrorStoreIdentities(keptEntries))
  }
  return report
}

// ---------------------------------------------------------------------------
// DIST CACHE deploy (install-time): mirror the current per-project payload
// SOURCES to ~/.episodic-memory/dist/<version>/<repo-relative-path>. Payload
// files only — no registrations, no hooks wiring (Principle 12 untouched;
// this is a copy source, like a plugin-marketplace cache). Older version dirs
// are pruned (keep only current).
// ---------------------------------------------------------------------------
export function deployDistCache(repoDir, globalDir, version) {
  const distRoot = path.join(globalDir, DIST_DIR_BASENAME)
  const target = path.join(distRoot, version)
  const tmp = path.join(distRoot, `.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  const sources = perProjectSourceSet(repoDir)
  fs.mkdirSync(tmp, { recursive: true })
  try {
    for (const [rel, abs] of sources) {
      const dst = path.join(tmp, ...rel.split('/'))
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(abs, dst)
    }
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(tmp, target)
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
    throw e
  }
  // Prune superseded version dirs (best-effort).
  let pruned = 0
  try {
    for (const e of fs.readdirSync(distRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === version) continue
      fs.rmSync(path.join(distRoot, e.name), { recursive: true, force: true })
      pruned++
    }
  } catch {}
  return { target, files: sources.size, pruned }
}

// ---------------------------------------------------------------------------
// SESSION-START AUTO-UPDATE (opt-in): refresh ONE project from the dist cache,
// checksum-guarded exactly like the sweep. Degrades to a no-op status on any
// missing precondition — the SessionStart hook falls back to the plain drift
// notice and never blocks session start.
//
// `notice` (when present) is a single plain line, safe for the hook to lift
// verbatim into SessionStart output (no quotes, no newlines).
// ---------------------------------------------------------------------------
export function syncProjectFromDist({ globalDir, projectDir, dryRun = false }) {
  const projectAbs = normalizeProjectPath(projectDir)
  const gm = readJsonSafe(globalManifestPath(globalDir))
  if (!gm || typeof gm.source_version !== 'string') {
    return { status: 'no-global-manifest', project: projectAbs }
  }
  const version = gm.source_version
  const mPath = projectManifestPath(projectAbs)
  const manifest = readJsonSafe(mPath)
  if (!manifest || !Array.isArray(manifest.artifacts)) {
    return { status: 'no-manifest', project: projectAbs }
  }
  if (manifest.source_version === version) {
    return { status: 'current', project: projectAbs, version }
  }
  const cache = distDir(globalDir, version)
  if (!fs.existsSync(cache)) {
    return { status: 'no-cache', project: projectAbs, from_version: manifest.source_version, to_version: version }
  }
  // Consent: only registry-listed projects are ever touched (Principle 3).
  const { entries } = readRegistry(registryPath(globalDir))
  const projEntries = entries.filter((e) => {
    try { return normalizeProjectPath(e.project_path) === projectAbs } catch { return false }
  })
  if (projEntries.length === 0) {
    return { status: 'unregistered', project: projectAbs }
  }
  const allowEnforcement = projEntries.some((e) => e.enforcement_installed === true)
  const fromVersion = manifest.source_version
  const res = refreshProjectArtifacts({
    projectDir: projectAbs,
    manifest,
    resolveSource: (a) => (typeof a.source === 'string' ? path.join(cache, ...a.source.split('/')) : null),
    allowEnforcement,
    dryRun,
  })
  if (!dryRun) {
    applyRefreshToManifest(manifest, res.refreshed, version)
    writeJsonAtomic(mPath, manifest)
    const now = new Date().toISOString()
    upsertRegistryEntries(registryPath(globalDir), projEntries.map((e) => ({ ...e, version, last_install_ts: now })))
  }
  const out = {
    status: 'refreshed',
    project: projectAbs,
    from_version: fromVersion,
    to_version: version,
    refreshed: res.refreshed.map((r) => r.path).sort(),
    skipped_modified: res.skippedModified.map((s) => s.path).sort(),
    dry_run: !!dryRun,
  }
  if (out.refreshed.length > 0 || out.skipped_modified.length > 0) {
    const short = version.slice(0, 12)
    let notice = `episodic-memory: auto-updated ${out.refreshed.length} artifact(s) to ${short}`
    if (out.skipped_modified.length > 0) {
      const shown = out.skipped_modified.slice(0, 3).join(', ')
      const more = out.skipped_modified.length > 3 ? ` (+${out.skipped_modified.length - 3} more)` : ''
      notice += `; ${out.skipped_modified.length} locally modified file(s) left untouched: ${shown}${more}`
    }
    out.notice = notice
  }
  return out
}

// ---------------------------------------------------------------------------
// RFC-012 P2 REQ-6 — store-identity mirror (derived, never authoritative).
// Runs on every registry write via upsertRegistryEntries: resolves each row's
// store, mints on next registration when absent, mirrors active id + retired
// aliases, and fails LOUD (throw) on duplicate chains, copied stores (one
// active id at two paths), and ambiguous alias ownership. A missing or
// unresolvable store dir leaves the row unmirrored (mirror is derived).
// ---------------------------------------------------------------------------
export function mirrorStoreIdentities(entries) {
  const claims = new Map() // store_id/alias -> { dir, kind }
  for (const e of entries) {
    let projectReal
    try { projectReal = fs.realpathSync(e.project_path) } catch { continue }
    let dir
    try { dir = resolveLocalDir(projectReal) } catch { dir = path.join(projectReal, '.episodic-memory') }
    if (!fs.existsSync(dir)) continue
    let idn = resolveStoreIdentity(dir)
    if (idn.error === 'no-identity') {
      const minted = mintStoreIdentity(dir)
      if (minted.error) {
        // F3 fold (GLM r1 MAJOR-3): identity-exists / lock-timeout are benign
        // concurrent-mint outcomes (the lib-level lock serialized us; another
        // process minted, or its lock-holder just released after a retry budget).
        // Re-resolve and mirror the EXISTING identity instead of throwing — this
        // is the §8.2 EC12 "later holder re-resolves" pattern. Other mint errors
        // (duplicate-identity-chain, identity-chain-cycle, reserved-id-invalid,
        // break-identity-write, store-dir-missing, …) stay fatal.
        if (minted.error === 'identity-exists' || minted.error === 'lock-timeout') {
          idn = resolveStoreIdentity(dir)
        } else {
          throw new Error(`identity-mint-failed: ${minted.error} at ${dir}`)
        }
      } else {
        idn = resolveStoreIdentity(dir)
      }
    }
    if (idn.error) throw new Error(`${idn.error}: ${e.project_path}`)
    let dirReal
    try { dirReal = fs.realpathSync(dir) } catch { dirReal = dir }
    for (const [id, kind] of [[idn.active_id, 'active'], ...idn.aliases.map((a) => [a, 'alias'])]) {
      // F5 fold (GLM r1 MINOR-2): the reserved id `global` belongs only to the
      // global store, which is never a registry row. A project row resolving
      // active_id or alias === 'global' is a hand-forgery / misconfiguration
      // — reject loudly rather than silently exempting it from the collision
      // map (the old `continue` let two forged-global project rows coexist).
      if (id === 'global') throw new Error(`reserved-id-abuse: ${e.project_path}`)
      const prev = claims.get(id)
      if (prev && prev.dir !== dirReal) {
        if (prev.kind === 'active' && kind === 'active') throw new Error(`copied-store-rejected: ${id} at ${prev.dir} + ${dirReal}`)
        throw new Error(`ambiguous-alias-ownership: ${id} at ${prev.dir} + ${dirReal}`)
      }
      if (!prev) claims.set(id, { dir: dirReal, kind })
    }
    e.store_id = idn.active_id
    if (idn.aliases.length) e.store_aliases = idn.aliases
    else delete e.store_aliases
  }
  return entries
}
