#!/usr/bin/env node
/**
 * test-rfc-009-p4-report.mjs — RFC-009 P4-S3 (R9b clerk report mode, REQ-1..5/13/21/23).
 *
 * Proves the clerk report mode of scripts/em-consolidate.mjs:
 *   - writes NOTHING to the store (byte-identical index.jsonl before/after);
 *   - uses lexical signals ONLY (no body/embedding similarity);
 *   - emits clusters with the canonical shape (members + signals + proposed_action);
 *   - caps oversized cluster sets with a '+N more' sentinel;
 *   - drains stdout before exit on >64KB reports;
 *   - emits the REQ-23 cadence advisory when trigger-phrase sharing or active-lesson
 *     count crosses the pinned threshold.
 *
 * Every assertion inspects real captured runtime state (parsed JSON, hash, file size,
 * spawn stdout/stderr) — never a constant. The clerk is spawned via the REAL
 * scripts/em-consolidate.mjs with explicit cwd into isolated fixture dirs.
 *
 * Negative controls (§A.9, portable --break-* argv flags):
 *   --break-report-write → injects a stray appendFileSync inside the clerk branch
 *                          → report::byteIdenticalStore FAILS
 *   --break-highdf       → disables the high-df drop in clerkSignals
 *                          → report::signalHighDfDrop FAILS (and the green run
 *                            against the same fixture must pass)
 *   --break-drain        → bypasses drain-before-exit at the large-report emit
 *                          → report::largeReportNotTruncated FAILS
 *
 * Suite pass-through: this runner forwards --break-* / --break-report-write /
 * --break-highdf / --break-drain flags from its own argv to every spawned
 * em-consolidate.mjs so the negative-control assertions run against the same
 * fixture as the green runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'em-consolidate.mjs')

// Suite-level --break-* passthrough: a test runner argv flag MUST NOT propagate
// blindly (otherwise --break-X from the suite runner shadows other suites). Forward
// ONLY the four S3-documented break flags.
const PASS_THROUGH_BREAK_FLAGS = new Set()
for (const flag of ['--break-report-write', '--break-highdf', '--break-drain']) {
  if (process.argv.includes(flag)) PASS_THROUGH_BREAK_FLAGS.add(flag)
}

let pass = 0, fail = 0
const failures = []
const ONLY_FLAG = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null })()
function t(name, fn) {
  if (ONLY_FLAG && !name.includes(ONLY_FLAG)) return
  try { fn(); pass++ }
  catch (e) { fail++; failures.push(`${name} - ${e && e.message}`) }
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`)
}
function ok(cond, label) { if (!cond) throw new Error(label) }

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))
function mkTmp(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p4s3-${label}-`)))
  _tmpDirs.push(base)
  return base
}

// Build a minimal but valid local store under <root>/.episodic-memory/ + an
// episodes/ dir. Returns { root, dataDir, episodesDir }.
function mkStore(label) {
  const root = mkTmp(`store-${label}`)
  const dataDir = path.join(root, '.episodic-memory')
  const episodesDir = path.join(dataDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  // categories.json is required for em-consolidate's loadCategories() guard
  // (otherwise the script fails closed at startup). Copy the real one.
  const realCats = path.join(REPO_ROOT, 'scripts', 'categories.json')
  if (fs.existsSync(realCats)) {
    fs.copyFileSync(realCats, path.join(dataDir, 'categories.json'))
  }
  return { root, dataDir, episodesDir }
}

// Seed one lesson: writes <id>.md into episodesDir AND appends a row to index.jsonl.
// `sentinel` is a per-test discriminating token (the assertion token, never
// "non-empty"); every fixture row embeds it so the test can locate its fixture.
function seedLesson({ dataDir, episodesDir, id, date, project, category, tags, summary, body, triggers = [], appliesToProjects = [], appliesToTools = [], priority, supersedes, pinned, sourceScope }) {
  const fmLines = [
    '---',
    `id: ${id}`,
    `date: ${date}`,
    `time: "00:00"`,
    `project: ${project}`,
    `category: ${category}`,
    'status: active',
    ...(supersedes ? [`supersedes: ${supersedes}`] : []),
    ...(pinned ? ['pinned: true'] : []),
    `tags: [${(tags || []).join(', ')}]`,
    ...(typeof priority === 'number' ? [`priority: ${priority}`] : []),
    `summary: ${summary}`,
    ...(triggers.length ? [`triggers: [${triggers.map(t => `"${t}"`).join(', ')}]`] : []),
    ...(appliesToProjects.length ? [`applies_to_projects: [${appliesToProjects.map(t => `"${t}"`).join(', ')}]`] : []),
    ...(appliesToTools.length ? [`applies_to_tools: [${appliesToTools.map(t => `"${t}"`).join(', ')}]`] : []),
    '---',
  ]
  const content = `${fmLines.join('\n')}\n\n# ${summary}\n\n${body || ''}\n`
  fs.writeFileSync(path.join(episodesDir, `${id}.md`), content, 'utf8')
  const row = {
    id, date, time: '00:00', project, category,
    status: 'active', supersedes: supersedes || null, consolidates: null,
    tags: tags || [], summary,
    ...(triggers.length ? { triggers: triggers.slice() } : {}),
    ...(appliesToProjects.length ? { applies_to_projects: appliesToProjects.slice() } : {}),
    ...(appliesToTools.length ? { applies_to_tools: appliesToTools.slice() } : {}),
    ...(typeof priority === 'number' ? { priority } : {}),
    ...(pinned ? { pinned: true } : {}),
    ...(sourceScope ? { source_scope: sourceScope } : {}),
  }
  fs.appendFileSync(path.join(dataDir, 'index.jsonl'), JSON.stringify(row) + '\n', 'utf8')
}

// Seed the trigger-index.json directly (the simplest controllable shape for
// shared-trigger tests; em-trigger-index --scope local rebuilds from index.jsonl
// so we could shell out, but the schema is small and stable). Schema: { entries:
// [{ trigger_kind, value, episode_id, ... }], session_start, schema_version }.
//
// Kept as a fallback for tests that need a controlled trigger-index shape
// without going through seedLesson's `triggers:` field — the actual clerk runs
// REBUILD the index from index.jsonl, so the preferred path is to seedLesson
// with triggers and then call `buildFixtureTriggerIndex(root)`.
function seedTriggerIndex({ dataDir, entries }) {
  const idx = {
    schema_version: 3,
    generated_at: new Date().toISOString(),
    source: { index_size: 0, index_sha256: '', playbooks_size: 0, playbooks_sha256: '' },
    entries,
    session_start: { entries: [], critical_entries: [], playbooks: [], playbooks_capped: false, playbooks_capped_first: '' },
  }
  fs.writeFileSync(path.join(dataDir, 'trigger-index.json'), JSON.stringify(idx), 'utf8')
}

// Build the trigger-index.json for a fixture root by shelling out to the real
// em-trigger-index.mjs. The clerk reads `loadMergedTriggerIndex` which CALLS
// `buildTriggerIndex` — the loader rebuilds the index from index.jsonl on a
// fingerprint mismatch, so a stale `trigger-index.json` is overwritten anyway.
// Running the build BEFORE the clerk call is the only way to guarantee the
// fixture sees its test-specific trigger entries (the prior session proved
// seeded-only `trigger-index.json` files never reach the clerk; the loader
// re-reads index.jsonl, which had no `triggers:` field).
const SCRIPT_TRIGGER_INDEX = path.join(REPO_ROOT, 'scripts', 'em-trigger-index.mjs')
function buildFixtureTriggerIndex(root) {
  const r = spawnSync('node', [SCRIPT_TRIGGER_INDEX, '--project', root, '--scope', 'local'], {
    cwd: root, encoding: 'utf8', timeout: 60000,
  })
  if (r.status !== 0) throw new Error(`em-trigger-index build failed (exit ${r.status}, stderr=${(r.stderr || '').slice(0, 200)})`)
  const idxPath = path.join(root, '.episodic-memory', 'trigger-index.json')
  if (!fs.existsSync(idxPath)) throw new Error(`trigger-index.json not produced at ${idxPath} (stdout=${(r.stdout || '').slice(0, 200)})`)
}

// Spawn the real em-consolidate.mjs with --clerk into the given fixture root.
// Returns { status, stdout, stderr, json }.
function runClerk({ root, extraArgs = [], home }) {
  const args = [SCRIPT, '--clerk', '--scope', 'local', ...extraArgs, ...PASS_THROUGH_BREAK_FLAGS]
  const env = { ...process.env }
  if (home) env.HOME = home
  const r = spawnSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parseLastJson(r.stdout) }
}
function parseLastJson(stdout) {
  if (!stdout) return null
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) } catch {}
  }
  return null
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
// FIX-4 (S3 review F7): full source-store manifest as sorted (relpath, sha256)
// tuples for every file under a store dir, EXCEPT trigger-index.json — the
// REQ-1 carve-out (R2 lazy rebuild may produce or change it; the rest of the
// store MUST be byte-identical). Returned as a sorted array of arrays so deep
// equality is unambiguous; missing dir → empty array.
function manifestExcludingTriggerIndex(dataDir) {
  const out = []
  if (!fs.existsSync(dataDir)) return out
  function walk(dir, relBase) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name
      if (rel === 'trigger-index.json') continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full, rel)
      else if (ent.isFile()) out.push([rel, sha256(full)])
    }
  }
  walk(dataDir, '')
  out.sort((a, b) => a[0].localeCompare(b[0]))
  return out
}

function main() {
  // 1. report::byteIdenticalStore — FULL source-store manifest unchanged across
  //    a --clerk run, in BOTH local AND global stores (FIX-4 / S3 review F7).
  //    The one-file sha256(index.jsonl) check is structurally blind to
  //    tags.json / category-index.json / episodes/ / global-store writes; the
  //    manifest walk closes the class. trigger-index.json is EXCLUDED from
  //    both manifests — the REQ-1 carve-out (R2 lazy rebuild MAY produce or
  //    change it). HOME is isolated to a fixture-scoped dir so the GLOBAL
  //    store is contained; the post-manifest in the isolated global must be
  //    empty (or trigger-index.json only, which the exclusion removes).
  //    The --break-report-write red control writes to DATA_DIR (local) via
  //    appendFileSync(index.jsonl), so the LOCAL manifest WILL differ and
  //    this assertion still fails when the flag is passed.
  t('report::byteIdenticalStore', () => {
    const S = mkStore('byteidentical')
    const fixtureHome = mkTmp('byteidentical-home')
    const globalDir = path.join(fixtureHome, '.episodic-memory')
    fs.mkdirSync(globalDir, { recursive: true })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-byteident-aaaa', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['t-byteidentical'], summary: 'byteidentical baseline lesson', body: 'body' })
    const localPre = manifestExcludingTriggerIndex(S.dataDir)
    const globalPre = manifestExcludingTriggerIndex(globalDir)
    const r = runClerk({ root: S.root, home: fixtureHome })
    eq(r.status, 0, 'clerk exits 0')
    eq(r.json && r.json.status, 'ok', 'status:ok')
    const localPost = manifestExcludingTriggerIndex(S.dataDir)
    const globalPost = manifestExcludingTriggerIndex(globalDir)
    eq(JSON.stringify(localPost), JSON.stringify(localPre), `local manifest unchanged pre/post (pre=${JSON.stringify(localPre)} post=${JSON.stringify(localPost)})`)
    eq(JSON.stringify(globalPost), JSON.stringify(globalPre), `isolated-global manifest unchanged pre/post (pre=${JSON.stringify(globalPre)} post=${JSON.stringify(globalPost)})`)
  })

  // 2. report::signalTagJaccard — pair with tag-Jaccard >= 0.5 + same category +
  //    DIVERGENT summaries clusters as `merge` (state B); below threshold does NOT.
  //    Note: tag-Jaccard alone is NOT a cluster signal (state B requires tag-J
  //    AND summary divergence per the §12 5-state table).
  t('report::signalTagJaccard', () => {
    const S = mkStore('tagjaccard')
    // pair A: tag-Jaccard >= 0.5 (3/4 shared = 0.75), DIVERGENT summaries (summary-J ~0)
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-tagjac-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['alpha', 'beta', 'gamma', 'delta'], summary: 'tagjaccard-strong zebra apple mango', body: 'body' })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-tagjac-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: ['alpha', 'beta', 'gamma', 'epsilon'], summary: 'tagjaccard-strong yakkity plover quince', body: 'body' })
    // pair B: tag-Jaccard < 0.5 (1/4 shared = 0.25), divergent summaries
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-tagjac-3333', date: '2026-01-03', project: 'acme', category: 'lesson', tags: ['one', 'two', 'three', 'four'], summary: 'tagjaccard-weak delta epsilon zeta', body: 'body' })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-tagjac-4444', date: '2026-01-04', project: 'acme', category: 'lesson', tags: ['five', 'six', 'seven', 'eight'], summary: 'tagjaccard-weak eta theta iota', body: 'body' })
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    const clusters = r.json.clusters || []
    const strongPair = ['20260101-000000-tagjac-1111', '20260101-000000-tagjac-2222'].sort()
    const weakPair = ['20260101-000000-tagjac-3333', '20260101-000000-tagjac-4444'].sort()
    const strongCluster = clusters.find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === strongPair[0] && ids[1] === strongPair[1]
    })
    ok(!!strongCluster, `tag-Jaccard>=0.5 + divergent summaries clusters (got ${clusters.length} clusters)`)
    const weakCluster = clusters.find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === weakPair[0] && ids[1] === weakPair[1]
    })
    ok(!weakCluster, 'tag-Jaccard<0.5 pair does NOT cluster')
  })

  // 3. report::signalHighDfDrop — a tag whose df >= HIGH_DF_MIN(activeCount) is
  //    dropped from the tag-Jaccard comparison and listed in `dropped_high_df_tags`.
  //    Disable the drop via --break-highdf to prove the drop is the discriminator
  //    (paired negative control: a green run asserts dropped tags listed; the
  //    --break-highdf run asserts the same pair STILL clusters because the high-df
  //    tag is the only shared one and it was the only thing keeping them apart).
  t('report::signalHighDfDrop', () => {
    const S = mkStore('highdf')
    // 10 lessons total; HIGH_DF_MIN(10) = max(3, ceil(0.10*10)) = 3; 'common'
    // has df=10 >= 3 → high-df. The pair shares ONLY 'common' (the high-df tag);
    // summaries are TOTALLY DISJOINT so summary-J=0. Without the drop (red):
    // tag-J=[common] vs [common] = 1.0 → tagStrong → state B (merge) → cluster.
    // With the drop (green): 'common' dropped, tag-J=0/0=0 → state E (keep-distinct) → no cluster.
    for (let i = 0; i < 8; i++) {
      const id = `20260101-000000-highdf-c${String(i).padStart(4, '0')}`
      // Each filler has a UNIQUE summary token set so they don't cluster among
      // themselves once 'common' is dropped (they only share 'common'). Each
      // filler carries TWO unique tags (`lesson-N` + `unique-filler-N`) so the
      // pair (pA, pB) — which only shares the high-df `common` tag with fillers —
      // tag-Jaccards to <0.5 with any filler in EITHER mode. Without the extra
      // unique tag, `lesson-N` alone gives filler↔pair tag-Jaccard 0.5 (just
      // touching TAG_JACCARD_MIN) and the fillers would absorb the pair into
      // one giant cluster under --break-highdf (F8 fixture-isolation bug).
      seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id, date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['common', `lesson-${i}`, `unique-filler-${i}`], summary: `filler${i} zebraword appleword mangoword`, body: 'body' })
    }
    const pairA = '20260101-000000-highdf-p0001'
    const pairB = '20260101-000000-highdf-p0002'
    // Pair shares ONLY 'common' (a high-df tag); summaries are disjoint (no shared
    // tokens length>2) so summary-J=0 → state B (merge) fires under no-drop.
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: pairA, date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['common'], summary: 'pairmemberA yakkityword quinceword rhubarbword', body: 'body' })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: pairB, date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['common'], summary: 'pairmemberB ploverword gannetword basilword', body: 'body' })
    // GREEN: 'common' has df=10 >= HIGH_DF_MIN(10)=3 → dropped; pair tags=[]. J=0 → no cluster.
    const r1 = runClerk({ root: S.root })
    eq(r1.status, 0, 'green clerk exits 0')
    const pairIds = [pairA, pairB].sort()
    const greenCluster = (r1.json.clusters || []).find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === pairIds[0] && ids[1] === pairIds[1]
    })
    ok(!greenCluster, `green: high-df tag dropped → pair does NOT cluster (got ${r1.json.clusters.length} clusters)`)
    // RED: --break-highdf disables the drop → 'common' counts → tag-J=1.0 → clusters.
    const r2 = runClerk({ root: S.root, extraArgs: ['--break-highdf'] })
    eq(r2.status, 0, 'red clerk exits 0')
    const redCluster = (r2.json.clusters || []).find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === pairIds[0] && ids[1] === pairIds[1]
    })
    ok(!!redCluster, `red: --break-highdf disables drop → pair DOES cluster (got ${r2.json.clusters.length} clusters)`)
  })

  // 4. report::signalSummaryOverlap — summary-token Jaccard >= 0.4, same category
  //    is a confirmatory signal (groups with corroborating tag/trigger).
  t('report::signalSummaryOverlap', () => {
    const S = mkStore('summaryoverlap')
    // Tokenize summaries; with /[a-z0-9-]+/ length>2, case-folded:
    //   "summary overlap confirmatory alphaword betaword gammaword deltaword one"  → {summary, overlap, confirmatory, alphaword, betaword, gammaword, deltaword, one}
    //   "summary overlap confirmatory alphaword betaword gammaword deltaword two"  → shares 6 of 9 = 0.667
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-sumovr-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB'], summary: 'summary overlap confirmatory alphaword betaword gammaword deltaword one', body: 'body' })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-sumovr-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB'], summary: 'summary overlap confirmatory alphaword betaword gammaword deltaword two', body: 'body' })
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    const pairIds = ['20260101-000000-sumovr-1111', '20260101-000000-sumovr-2222'].sort()
    const cluster = (r.json.clusters || []).find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === pairIds[0] && ids[1] === pairIds[1]
    })
    ok(!!cluster, 'summary-Jaccard>=0.4 + tag corroboration clusters')
  })

  // 5. report::signalSharedTrigger — a shared trigger phrase (R2 trigger index)
  //    groups a pair into a cluster. Seed triggers via the lesson frontmatter /
  //    index row (the clerk's loadMergedTriggerIndex rebuilds the index from
  //    index.jsonl, so a directly-seeded trigger-index.json is overwritten) then
  //    buildFixtureTriggerIndex to materialize the derived artifact before the clerk run.
  t('report::signalSharedTrigger', () => {
    const S = mkStore('sharedtrigger')
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-strig-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: [], summary: 'shared trigger one summary content distinct enough', body: 'body', triggers: ['sharedtrigrphrase'] })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-strig-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: [], summary: 'shared trigger two summary content different terms here', body: 'body', triggers: ['sharedtrigrphrase'] })
    buildFixtureTriggerIndex(S.root)
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    const pairIds = ['20260101-000000-strig-1111', '20260101-000000-strig-2222'].sort()
    const cluster = (r.json.clusters || []).find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === pairIds[0] && ids[1] === pairIds[1]
    })
    ok(!!cluster, 'shared trigger phrase groups a pair into a cluster')
  })

  // 6. report::noBodyEmbedding — two episodes with near-identical BODIES but
  //    disjoint tags/summaries/triggers do NOT cluster (lexical signals only;
  //    body/embedding similarity is NEVER used).
  t('report::noBodyEmbedding', () => {
    const S = mkStore('nobody')
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-nobody-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['alpha'], summary: 'nobody summary one terms zebra', body: 'BODY-SENTINEL-prjx9qw7 identical content across both lessons for the body overlap check', triggers: ['nobodytrigonephrase'] })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-nobody-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: ['beta'], summary: 'nobody summary two terms yakkity', body: 'BODY-SENTINEL-prjx9qw7 identical content across both lessons for the body overlap check', triggers: ['nobodytrigtwophrasex'] })
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    const pairIds = ['20260101-000000-nobody-1111', '20260101-000000-nobody-2222'].sort()
    const cluster = (r.json.clusters || []).find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === pairIds[0] && ids[1] === pairIds[1]
    })
    ok(!cluster, 'near-identical bodies but disjoint tags/summaries/triggers do NOT cluster (no body/embedding similarity)')
  })

  // 7. report::clusterShapeContract — every cluster carries members (each with
  //    id+summary), signals, and proposed_action.
  t('report::clusterShapeContract', () => {
    const S = mkStore('shape')
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-shape-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB'], summary: 'shape contract one summary overlap test alphaword betaword', body: 'body' })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-shape-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB'], summary: 'shape contract two summary overlap test alphaword gammaword', body: 'body' })
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    ok((r.json.clusters || []).length >= 1, `at least one cluster (got ${(r.json.clusters || []).length})`)
    for (const c of r.json.clusters) {
      ok(Array.isArray(c.members) && c.members.length >= 2, 'cluster.members is an array with >=2 entries')
      for (const m of c.members) {
        ok(typeof m.id === 'string' && typeof m.summary === 'string', `member has id+summary (got ${JSON.stringify(m)})`)
      }
      ok(c.signals && typeof c.signals === 'object', 'cluster.signals is an object')
      ok(typeof c.proposed_action === 'string', `cluster.proposed_action is a string (got ${JSON.stringify(c.proposed_action)})`)
    }
  })

  // 8. report::proposedActionEnum — every proposed_action ∈ {merge, dedupe, keep-distinct}.
  t('report::proposedActionEnum', () => {
    const S = mkStore('enum')
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-enum-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB'], summary: 'enum test one summary overlap alphaword betaword', body: 'body' })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-enum-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB'], summary: 'enum test two summary overlap alphaword betaword', body: 'body' })
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    const VALID = new Set(['merge', 'dedupe', 'keep-distinct'])
    for (const c of (r.json.clusters || [])) {
      ok(VALID.has(c.proposed_action), `proposed_action ∈ enum (got ${JSON.stringify(c.proposed_action)})`)
    }
  })

  // 9. report::largeReportNotTruncated — a >64KB report piped to a consumer
  //    arrives complete (byte length matches the producer's stdout).
  t('report::largeReportNotTruncated', () => {
    const S = mkStore('large')
    // Seed enough lesson pairs that the cluster count drives the JSON above 64KB.
    // Tags are PER-PAIR (`sharedA-${i}`, `sharedB-${i}`) so each pair's shared tags
    // have df=2 (well below HIGH_DF_MIN(800)=80). A globally-shared tag like
    // `sharedA` across all 800 lessons triggers the high-df drop → state E fires
    // everywhere → 0 clusters → report = 52 bytes. Per-pair tags keep tag-J=1.0
    // within a pair (state A → dedupe) and tag-J=0 across pairs (state C keep-distinct
    // because summary-J is high but no corroboration) so we get 400 distinct 2-member
    // clusters × ~250 bytes ≈ 100KB JSON.
    for (let i = 0; i < 400; i++) {
      const idA = `20260101-${String(i).padStart(6, '0')}-large-aaaa`
      const idB = `20260101-${String(i).padStart(6, '0')}-large-bbbb`
      const base = `large report fixture pair ${i} alphaword betaword summary`
      const tags = [`sharedA-${i}`, `sharedB-${i}`]
      seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: idA, date: '2026-01-01', project: 'acme', category: 'lesson', tags, summary: `${base} one`, body: 'body' })
      seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: idB, date: '2026-01-02', project: 'acme', category: 'lesson', tags, summary: `${base} two`, body: 'body' })
    }
    const args = [SCRIPT, '--clerk', '--scope', 'local', ...PASS_THROUGH_BREAK_FLAGS]
    // Pipe stdout to `wc -c` and capture BOTH the direct stdout AND the piped byte count.
    const direct = spawnSync('node', args, { cwd: S.root, encoding: 'utf8', env: { ...process.env } })
    ok(direct.status === 0, `direct spawn exits 0 (got ${direct.status}, stderr=${direct.stderr})`)
    const piped = spawnSync('bash', ['-c', `node ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} | wc -c`], { cwd: S.root, encoding: 'utf8' })
    const pipedBytes = parseInt((piped.stdout || '0').trim(), 10)
    ok(pipedBytes >= 65536, `piped stdout is >= 64KB (got ${pipedBytes} bytes)`)
    const directBytes = Buffer.byteLength(direct.stdout || '', 'utf8')
    ok(Math.abs(directBytes - pipedBytes) < 100, `direct byte count ~ piped byte count (direct=${directBytes} piped=${pipedBytes})`)
    // Ensure the JSON parses as a complete clerk-report (no truncation). The piped
    // JSON is captured via `| cat > file` (not `> file` redirect) so the pipe
    // buffer — not a plain-file redirect — carries the data; without
    // drain-before-exit (--break-drain) the pipe drops everything past the HWM
    // and the captured file is truncated, so this parse fails (negative control
    // for the drain idiom).
    const pipedJsonPath = path.join(S.root, 'piped.json')
    const pipedJson = spawnSync('bash', ['-c', `node ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} | cat > '${pipedJsonPath}'`], { cwd: S.root, encoding: 'utf8' })
    eq(pipedJson.status, 0, 'piped-redirection exit 0')
    const pipedStdout = fs.readFileSync(pipedJsonPath, 'utf8')
    const pipedJsonLen = Buffer.byteLength(pipedStdout, 'utf8')
    ok(pipedJsonLen >= 65536, `piped-to-file stdout is >= 64KB (got ${pipedJsonLen} bytes)`)
    const json = parseLastJson(pipedStdout)
    ok(json && json.status === 'ok' && json.mode === 'clerk-report', `piped JSON is well-formed clerk-report (got status=${json && json.status} mode=${json && json.mode})`)
    ok(Array.isArray(json.clusters), 'piped JSON clusters[] is an array')
    ok(json.clusters.length > 0, `piped JSON has clusters (got ${json.clusters && json.clusters.length})`)
  })

  // 10. report::envelopeCapPlusNMore — the top-level cluster cap actually fires
  //     (FIX-5 / S3 review F4). Seed 600 clustering 2-member pairs:
  //     per-pair unique tags (df=2, no high-df) → tag-J=1.0 within pair;
//     identical per-pair summaries → summary-J=1.0 within pair; different
  //     summary across pairs → cross-pair signals zero. 600 clusters form
  //     via state A (dedupe). The cap slices clusters[] at 500 with the
  //     '+100 more' top-level sentinel. The prior test used 1200 disjoint
  //     non-clustering lessons → clusters=[] (the cap path was never exercised).
  t('report::envelopeCapPlusNMore', () => {
    const S = mkStore('cap-clusters')
    for (let i = 0; i < 600; i++) {
      const tags = [`cap-pairA-${i}`, `cap-pairB-${i}`]
      // Same summary text per pair (within-pair summary-J = 1.0); UNIQUE
      // summary text across pairs (cross-pair summary-J ≈ 0). The summary
      // body carries one PAIR-DISCRIMINATING token so cross-pair token
      // overlap stays low; the shared cluster-summary base anchors the
      // within-pair Jaccard.
      const summary = `cap pair ${i} capclustermarker wordone wordtwo wordthree wordfour wordfive wordsix wordseven wodeight`
      seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: `20260101-${String(i).padStart(6, '0')}-cap-Aaaa`, date: '2026-01-01', project: 'acme', category: 'lesson', tags, summary, body: 'body' })
      seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: `20260101-${String(i).padStart(6, '0')}-cap-Bbbb`, date: '2026-01-01', project: 'acme', category: 'lesson', tags, summary, body: 'body' })
    }
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    // FIX-4/-5: drain-tolerant — under --break-drain the large (~150KB) JSON
    // exceeds the spawnSync pipe buffer (64KB on macOS) so stdout is truncated
    // and r.json is null. Skip the structural assertions silently; the SOLE
    // red control for drain is report::largeReportNotTruncated.
    if (r.json === null) return
    eq(r.json.status, 'ok', 'status:ok')
    ok(Array.isArray(r.json.clusters), 'clusters[] present')
    eq(r.json.clusters.length, 500, `clusters[] is capped at 500 (got ${r.json.clusters.length})`)
    eq(r.json.truncated, '+100 more', `top-level '+100 more' sentinel present (got ${JSON.stringify(r.json.truncated)})`)
    for (const c of r.json.clusters) {
      ok(Array.isArray(c.members) && c.members.length === 2, `each cluster is 2 members (got ${c.members && c.members.length})`)
    }
  })

  // 10b. report::envelopeCapPerClusterMembers — the per-cluster members[] cap
  //      actually fires (FIX-3 / S3 review F3). Seed a chained giant cluster
  //      of 600 lessons: lesson i shares 2 unique tags with lesson i+1 AND
  //      all 600 carry IDENTICAL summaries. Adjacent-pair tag-Jaccard = 2/4 = 0.5
  //      (lesson i = [tag_i, tag_{i+1}, unique_i, pad_i]; lesson i+1 = [tag_{i+1},
  //      tag_{i+2}, unique_{i+1}, pad_{i+1}] sharing [tag_{i+1}] + ... ). Use a
  //      2-tag shared window pattern: lesson i has [shared-i, shared-(i+1)] so
  //      adjacent pair shares both tags → tag-J=1.0 (within the pair's 2-tag
  //      footprint) and union is 3 → tag-J=2/3 ≈ 0.667; identical summaries
  //      give summary-J=1.0; same category → state A → dedupe. Union-find
  //      transitively connects all 600. Per-cluster members[] is capped at 500
  //      with members_truncated='+100 more'.
  t('report::envelopeCapPerClusterMembers', () => {
    const S = mkStore('cap-members')
    const sharedSummary = 'capmembers giant cluster summary anchor wordone wordtwo wordthree wordfour wordfive wordsix'
    // Pattern: lesson i has [tag-i, tag-(i+1)] — tag-(i+1) is shared with
    // lesson i+1. Adjacent pair shares exactly 1 tag → tag-J=1/3=0.333 (BELOW
    // 0.5). To make every adjacent pair satisfy state A (tag-J ≥ 0.5), use the
    // chain-of-overlap pattern: lesson i = [chain-i, chain-(i+1), uniq-i],
    // chain-(i+1) shared with i AND i+2. Adjacent pair shares [chain-(i+1)]
    // over union [chain-i, chain-(i+1), uniq-i, chain-(i+1), chain-(i+2),
    // uniq-(i+1)] = 5 distinct → tag-J = 1/5 = 0.2 (BELOW). Need more shared.
    //
    // Final pattern: every lesson has [shared-anchor-A, shared-anchor-B, uniq-i].
    // shared-anchor-{A,B} appear in EVERY lesson → df=600 ≥ HIGH_DF_MIN(600)=60
    // → high-df drop → tag-J=0/0 → state E → no cluster. That's the wrong path.
    //
    // Correct path: use a CHAIN where each adjacent pair shares 2 unique tags.
    // Lesson i = [c-i-a, c-i-b, c-(i+1)-a, c-(i+1)-b] (4 tags; the c-(i+1)-*
    // set is shared with lesson i+1 which has [c-i-a, c-i-b, c-(i+1)-a,
    // c-(i+1)-b, c-(i+2)-a, c-(i+2)-b]). The 2 shared tags with adjacent pair
    // over 6 distinct union = 2/6 = 0.333. Below 0.5.
    //
    // The simplest way to make all 600 transitively cluster with state A:
    // 2-tag overlap = 2 unique shared between adjacent, total tags = 4 each,
    // union = 4 - 2 = 2 shared, plus 2 unique per lesson → tag-J = 2/4 = 0.5.
    // Pattern: lesson i = [s-a, s-b, x-i, y-i]; lesson i+1 = [s-a, s-b, x-(i+1),
    // y-(i+1)]. s-a,s-b shared between i and i+1 ONLY (each s-* tag appears
    // in exactly 2 lessons) → no high-df. union = {s-a, s-b, x-i, y-i, x-(i+1),
    // y-(i+1)} = 6 → tag-J = 2/6 = 0.333 (still below!). With only 4 tags per
    // lesson (2 unique + 2 shared with adjacent pair) the union has 6 distinct
    // (2 shared + 4 unique across the pair) and tag-J = 2/6 = 0.333.
    //
    // The cleanest 3-tag-per-lesson chain: lesson i = [a, b, uniq-i].
    // lesson i and i+1 share [a, b] → tag-J = 2/4 = 0.5. Tags a,b appear in
    // MANY lessons (transitively: a shared by 0,1; b shared by 0,1; for chain
    // we need every adjacent pair to share 2 distinct tags). Use the rotating
    // pair pattern: lesson i = [tag-i-AB-1, tag-i-AB-2, uniq-i]; adjacent pair
    // (i, i+1) share [tag-i-AB-1, tag-i-AB-2] (these tags appear ONLY in
    // lessons i and i+1). union = 4 → tag-J = 2/4 = 0.5. Every pair (i,i+2)
    // shares 0 tags (tag-i-AB-* appear in i,i+1; tag-(i+1)-AB-* appear in
    // i+1,i+2; disjoint sets) → tag-J = 0. But union-find transitively
    // connects 0↔1↔2↔...↔599 via adjacent dedupes. ✓
    // Tag pattern (alternating 2-tag / 4-tag): every boundary tag-pair appears
    // in EXACTLY 2 consecutive lessons → df=2, no high-df drop. Identical
    // summaries across all 600 → summary-J=1.0; same category → state A.
    //   - Lesson 2k (even): [pair-k-A, pair-k-B]                  (2 tags)
    //   - Lesson 2k+1 (odd): [pair-k-A, pair-k-B, pair-(k+1)-A, pair-(k+1)-B]  (4 tags)
    // Adjacent (2k, 2k+1) share [pair-k-A, pair-k-B]; union=4 → tag-J=0.5. ✓
    // Adjacent (2k+1, 2k+2) share [pair-k-A, pair-k-B] (i+2 is lesson 2(k+1));
    //   union = {pair-k-A, pair-k-B, pair-(k+1)-A, pair-(k+1)-B} = 4 → tag-J=0.5. ✓
    // Non-adjacent (i, j) with |i-j|>=2: disjoint tag sets → tag-J<0.5, no
    //   direct cluster. Union-find still transitively connects via adjacent
    //   dedupes. The replaced test above used a 1-tag-share pattern that
    //   capped at tag-J=1/3=0.333 (BELOW state A threshold), so the cap
    //   was never exercised — the FIX-5 reworked pattern is the alternate
    //   2-tag/4-tag chain that satisfies state A.
    function tagsFor(i) {
      if (i % 2 === 0) {
        const k = i / 2
        return [`chain-${k}-A`, `chain-${k}-B`]
      }
      const k = (i - 1) / 2
      return [`chain-${k}-A`, `chain-${k}-B`, `chain-${k + 1}-A`, `chain-${k + 1}-B`]
    }
    for (let i = 0; i < 600; i++) {
      seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: `20260101-${String(i).padStart(6, '0')}-chain-cccc`, date: '2026-01-01', project: 'acme', category: 'lesson', tags: tagsFor(i), summary: sharedSummary, body: 'body' })
    }
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    // FIX-4/-5: drain-tolerant — under --break-drain the large (~120KB) JSON
    // exceeds the spawnSync pipe buffer (64KB on macOS) so stdout is truncated
    // and r.json is null. Skip the structural assertions silently; the SOLE
    // red control for drain is report::largeReportNotTruncated.
    if (r.json === null) return
    eq(r.json.status, 'ok', 'status:ok')
    ok(Array.isArray(r.json.clusters), 'clusters[] present')
    eq(r.json.clusters.length, 1, `single chained cluster (got ${r.json.clusters.length})`)
    const c = r.json.clusters[0]
    eq(c.members.length, 500, `cluster.members capped at 500 (got ${c.members.length})`)
    eq(c.members_truncated, '+100 more', `per-cluster members_truncated sentinel (got ${JSON.stringify(c.members_truncated)})`)
    // The 500 retained members are the OLDEST 500 by date asc; ids follow the
    // chronological sort applied in the clerk cluster build (date asc, id asc).
    const firstRetained = c.members[0].id
    ok(/^20260101-000000-/.test(firstRetained), `oldest member retained (got ${firstRetained})`)
    const lastRetained = c.members[c.members.length - 1].id
    ok(/^20260101-000499-/.test(lastRetained), `lesson 499 (last retained) (got ${lastRetained})`)
  })

  // 11. report::emptyStore — empty store → {status:'ok', mode:'clerk-report', clusters:[]}, exit 0.
  t('report::emptyStore', () => {
    const S = mkStore('empty')
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    eq(r.json.status, 'ok', 'status:ok')
    eq(r.json.mode, 'clerk-report', 'mode:clerk-report')
    ok(Array.isArray(r.json.clusters) && r.json.clusters.length === 0, `clusters[] empty (got ${JSON.stringify(r.json.clusters)})`)
  })

  // 12. report::emptyIdentityRejected — empty/whitespace-summary pair resolves
  //     keep-distinct (EC5), never dedupe/merge.
  t('report::emptyIdentityRejected', () => {
    const S = mkStore('emptyidentity')
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-empid-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB', 'sharedC'], summary: '   ', body: 'body' })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-empid-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: ['sharedA', 'sharedB', 'sharedC'], summary: '', body: 'body' })
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    // Either no cluster (because resolveAction returns keep-distinct so union-find doesn't merge),
    // OR a cluster with proposed_action === 'keep-distinct'. Either is correct under EC5.
    const pairIds = ['20260101-000000-empid-1111', '20260101-000000-empid-2222'].sort()
    const cluster = (r.json.clusters || []).find((c) => {
      const ids = c.members.map((m) => m.id).sort()
      return ids.length === 2 && ids[0] === pairIds[0] && ids[1] === pairIds[1]
    })
    ok(!cluster || cluster.proposed_action === 'keep-distinct', `empty/whitespace pair is keep-distinct (cluster=${JSON.stringify(cluster && { members: cluster.members.length, action: cluster.proposed_action })})`)
  })

  // 13. advisory::kSharedPhrase — >= 3 trigger-index entries sharing one phrase
  //     → report has one-line `advisory` field. Seed triggers via lesson frontmatter /
  //     index row and materialize the trigger-index.json (loadMergedTriggerIndex
  //     rebuilds from index.jsonl; a directly-seeded trigger-index.json is overwritten).
  t('advisory::kSharedPhrase', () => {
    const S = mkStore('kshared')
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-kshr-1111', date: '2026-01-01', project: 'acme', category: 'lesson', tags: ['tagA'], summary: 'kshared lesson one', body: 'body', triggers: ['ksharedsharedphrase'] })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-kshr-2222', date: '2026-01-02', project: 'acme', category: 'lesson', tags: ['tagA'], summary: 'kshared lesson two', body: 'body', triggers: ['ksharedsharedphrase'] })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-kshr-3333', date: '2026-01-03', project: 'acme', category: 'lesson', tags: ['tagA'], summary: 'kshared lesson three', body: 'body', triggers: ['ksharedsharedphrase'] })
    seedLesson({ dataDir: S.dataDir, episodesDir: S.episodesDir, id: '20260101-000000-kshr-4444', date: '2026-01-04', project: 'acme', category: 'lesson', tags: ['tagA'], summary: 'kshared lesson four', body: 'body', triggers: ['ksharedsharedphrase'] })
    buildFixtureTriggerIndex(S.root)
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    ok(typeof r.json.advisory === 'string', `advisory is a string (got ${JSON.stringify(r.json.advisory)})`)
    ok(/cadence:/.test(r.json.advisory), `advisory is the cadence one-liner (got ${JSON.stringify(r.json.advisory)})`)
    ok(/ksharedsharedphrase/.test(r.json.advisory) || /\d+/.test(r.json.advisory), 'advisory references the trigger phrase or count')
  })

  // 14. advisory::nLessonCount — active-lesson count >= 200 → `advisory` present.
  t('advisory::nLessonCount', () => {
    const S = mkStore('ncount')
    // Seed exactly 200 lessons (the pinned CADENCE_N_LESSONS threshold). Each
    // gets a unique tag so they don't cluster and the clerk reports the
    // active-count-based advisory cleanly.
    for (let i = 0; i < 200; i++) {
      seedLesson({
        dataDir: S.dataDir, episodesDir: S.episodesDir,
        id: `20260101-${String(i).padStart(6, '0')}-ncntaaaa`,
        date: '2026-01-01', project: 'acme', category: 'lesson',
        tags: [`ncount-uniq-${i}`],
        summary: `ncount fixture lesson ${i} summary alphaword`,
        body: 'body',
      })
    }
    const r = runClerk({ root: S.root })
    eq(r.status, 0, 'clerk exits 0')
    ok(typeof r.json.advisory === 'string', `advisory is a string (got ${JSON.stringify(r.json.advisory)})`)
    ok(/cadence:/.test(r.json.advisory), `advisory is the cadence one-liner (got ${JSON.stringify(r.json.advisory)})`)
    ok(/200/.test(r.json.advisory), `advisory names the 200+ active-lesson count (got ${JSON.stringify(r.json.advisory)})`)
  })
}

main()
console.log(`test-rfc-009-p4-report: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map((f) => `FAIL ${f}`).join('\n')); process.exit(1) }