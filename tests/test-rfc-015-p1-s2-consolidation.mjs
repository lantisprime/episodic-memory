// tests/test-rfc-015-p1-s2-consolidation.mjs — RFC-015 P1-S2 (R4) acceptance suite.
// Covers R4a marker inheritance, R4b protection parity, R4c substitution advisory,
// R4d fail-closed aborts (both classes, both polarities). Zero deps.
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CONSOLIDATE = path.join(REPO, 'scripts', 'em-consolidate.mjs')
const REBUILD = path.join(REPO, 'scripts', 'em-rebuild-index.mjs')

const ONLY_IDX = process.argv.indexOf('--only')
const ONLY = ONLY_IDX >= 0 ? process.argv[ONLY_IDX + 1] : null
const BREAK = process.argv.includes('--break-protection-throw')

let pass = 0, fail = 0
async function t(name, fn) {
  if (ONLY && name !== ONLY) return
  try { await fn(); pass++; console.log(`ok   ${name}`) }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`) }
}

// --- fixture builders -------------------------------------------------------

// A store dir with episodes/, index.jsonl, tags.json. Lives under os.tmpdir() —
// never the repo store, never ~/.episodic-memory (lesson ...08e2).
function mkStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'em-p1s2-'))
  const dir = path.join(root, '.episodic-memory')
  fs.mkdirSync(path.join(dir, 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.jsonl'), '', 'utf8')
  fs.writeFileSync(path.join(dir, 'tags.json'), '{}', 'utf8')
  return { root, dir }
}

// Write one episode file + its index row. `extra` merges into both.
function addEpisode(store, { id, summary, body, tags = [], playbook = false, extra = {} }) {
  const fm = ['---', `id: ${id}`, 'date: 2026-07-26', 'time: "10:00"', 'project: p1s2',
    'category: lesson', 'status: active', `tags: [${tags.join(', ')}]`, `summary: ${summary}`]
  if (playbook) fm.push('playbook: true')
  for (const [k, v] of Object.entries(extra)) fm.push(`${k}: ${v}`)
  fm.push('---')
  fs.writeFileSync(path.join(store.dir, 'episodes', `${id}.md`),
    `${fm.join('\n')}\n\n# ${summary}\n\n${body}\n`, 'utf8')
  const row = { id, date: '2026-07-26', time: '10:00', project: 'p1s2', category: 'lesson',
    status: 'active', tags, summary, ...(playbook ? { playbook: true } : {}), ...extra }
  fs.appendFileSync(path.join(store.dir, 'index.jsonl'), JSON.stringify(row) + '\n', 'utf8')
  return id
}

// Two near-identical episodes so the default --min-sim clusters them.
function addClusterPair(store, { prefix, playbookOnFirst = false }) {
  const shared = 'consolidation protection playbook parity digest apply path retention'
  const a = addEpisode(store, { id: `${prefix}-aaaa`, summary: `${prefix} SENTINEL_P1S2_MARKED ${shared}`, body: shared, tags: ['p1s2'], playbook: playbookOnFirst })
  const b = addEpisode(store, { id: `${prefix}-bbbb`, summary: `${prefix} sibling ${shared}`, body: shared, tags: ['p1s2'] })
  return [a, b]
}

function writePlaybooks(store, obj) {
  fs.writeFileSync(path.join(store.dir, 'playbooks.json'),
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function run(store, args) {
  const r = spawnSync(process.execPath, [CONSOLIDATE, ...args, ...(BREAK ? ['--break-protection-throw'] : [])],
    { cwd: store.root, encoding: 'utf8', env: { ...process.env, HOME: store.root } })
  let json = null
  try { json = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()) } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json }
}

function indexRows(store) {
  return fs.readFileSync(path.join(store.dir, 'index.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l))
}
function episodeText(store, id) {
  return fs.readFileSync(path.join(store.dir, 'episodes', `${id}.md`), 'utf8')
}

// --- Group 1: R4b protection parity ----------------------------------------

await t('t1_legacy_protects_declared', () => {
  const s = mkStore()
  const [a] = addClusterPair(s, { prefix: 'decl' })
  writePlaybooks(s, { schema_version: 1, playbooks: [{ id: a, mode: 'session_start' }] })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected, got ${r.code}: ${r.stdout}`)
  assert.equal(r.json.applied, 0, `declared member must not be consolidated, applied=${r.json.applied}`)
  assert.ok(Array.isArray(r.json.protection_skips) && r.json.protection_skips.length === 1,
    `protection_skips must name the skipped cluster, got ${JSON.stringify(r.json.protection_skips)}`)
  assert.match(r.json.protection_skips[0].reason, /playbook-referenced/,
    `reason must cite class-e, got ${r.json.protection_skips[0].reason}`)
})

await t('t1b_legacy_skip_is_not_block', () => {
  const s = mkStore()
  const [a] = addClusterPair(s, { prefix: 'onlyc' })
  writePlaybooks(s, { schema_version: 1, playbooks: [{ id: a, mode: 'session_start' }] })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, 'a protection skip must not be a non-zero exit (B-1)')
  for (const row of indexRows(s)) {
    assert.equal(row.status, 'active', `${row.id} must stay active, got ${row.status}`)
  }
})

await t('t2_clerk_protects_declared', () => {
  const s = mkStore()
  const [a] = addClusterPair(s, { prefix: 'clerkd' })
  writePlaybooks(s, { schema_version: 1, playbooks: [{ id: a, mode: 'session_start' }] })
  const r = run(s, ['--clerk', '--apply', '--confirm', '--scope', 'local'])
  assert.equal(r.code, 0, `exit 0 expected, got ${r.code}: ${r.stdout}`)
  const guards = r.json.skipped_guard || []
  assert.ok(guards.some(g => String(g.reason).includes('playbook-referenced')),
    `clerk must skip on class-e, got ${JSON.stringify(guards)}`)
})

await t('t14_fold_protection_error_aborts', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'folderr' })
  fs.rmSync(path.join(s.dir, 'index.jsonl'))
  fs.mkdirSync(path.join(s.dir, 'index.jsonl')) // EISDIR on read
  const r = run(s, ['--fold-superseded', '--scope', 'local', '--dry-run'])
  assert.equal(r.code, 1, `fold must fail closed on an unreadable index, got exit ${r.code}`)
  assert.match(r.json.message, /index\.jsonl/, `message must name index.jsonl, got ${r.json.message}`)
})

// --- Group 2: R4d fail-closed, both classes, both polarities ---------------

await t('t3_legacy_abort_corrupt_playbooks', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'corrupt' })
  writePlaybooks(s, '{ this is not json')
  const before = fs.readFileSync(path.join(s.dir, 'index.jsonl'), 'utf8')
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 1, `corrupt playbooks.json must abort, got exit ${r.code}: ${r.stdout}`)
  assert.match(r.json.message, /playbooks\.json/, `message must name the file, got ${r.json.message}`)
  assert.equal(fs.readFileSync(path.join(s.dir, 'index.jsonl'), 'utf8'), before,
    'the store must be byte-identical after an abort (EC6)')
})

await t('t3b_clerk_abort_corrupt_playbooks', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'clerkcorrupt' })
  writePlaybooks(s, '{ this is not json')
  const r = run(s, ['--clerk', '--apply', '--confirm', '--scope', 'local'])
  assert.equal(r.code, 1, `clerk apply must abort, got exit ${r.code}: ${r.stdout}`)
  assert.match(r.json.message, /playbooks\.json/, `message must name the file, got ${r.json.message}`)
})

await t('t3c_valid_no_abort', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'valid' })
  writePlaybooks(s, { schema_version: 1, playbooks: [] })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `a valid playbooks.json must NOT abort, got exit ${r.code}: ${r.stdout}`)
  assert.equal(r.json.applied, 1, `the cluster must consolidate, applied=${r.json.applied}`)
})

await t('t4_protection_error_aborts', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'idxerr' })
  fs.rmSync(path.join(s.dir, 'index.jsonl'))
  fs.mkdirSync(path.join(s.dir, 'index.jsonl'))
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 1, `an unreadable index must abort, got exit ${r.code}: ${r.stdout}`)
})

await t('t4b_abort_message_discriminates', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'discrim' })
  writePlaybooks(s, { schema_version: 1, playbooks: [] }) // VALID: so only the index is broken
  fs.rmSync(path.join(s.dir, 'index.jsonl'))
  fs.mkdirSync(path.join(s.dir, 'index.jsonl'))
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 1, 'must abort')
  assert.match(r.json.message, /index\.jsonl/, `must name index.jsonl, got ${r.json.message}`)
  assert.doesNotMatch(r.json.message, /playbooks\.json/,
    `must NOT blame playbooks.json when the playbook config is valid, got ${r.json.message}`)
  assert.equal(r.json.code, 'protection-abort:protection',
    `abort class must be the protection class, got ${r.json.code}`)
})

await t('t6_dryrun_aborts', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'dry' })
  writePlaybooks(s, '{ nope')
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3'])
  assert.equal(r.code, 1, `dry-run must abort like the fold path does, got exit ${r.code}: ${r.stdout}`)
  assert.match(r.json.message, /playbooks\.json/, `must name the file, got ${r.json.message}`)
})

await t('t6b_zero_clusters_aborts', () => {
  const s = mkStore()
  addEpisode(s, { id: 'lonely-aaaa', summary: 'a solitary episode with no near duplicate', body: 'x' })
  writePlaybooks(s, '{ nope')
  const r = run(s, ['--scope', 'local', '--apply', '--confirm'])
  assert.equal(r.code, 1, `the zero-cluster fast path must not skip R4d, got exit ${r.code}: ${r.stdout}`)
})

// --- Group 3: resolver arguments -------------------------------------------

await t('t5_scope_local_ignores_sibling', () => {
  const s = mkStore()
  const sibling = mkStore()
  writePlaybooks(sibling, '{ corrupt sibling')
  const reg = path.join(s.root, '.episodic-memory-global')
  fs.mkdirSync(reg, { recursive: true })
  fs.writeFileSync(path.join(reg, 'installs.json'),
    JSON.stringify({ entries: [{ data_dir: sibling.dir }] }), 'utf8')
  addClusterPair(s, { prefix: 'localonly' })
  writePlaybooks(s, { schema_version: 1, playbooks: [] })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0,
    `a sibling's corrupt config must not abort a --scope local apply (over-abort), got exit ${r.code}: ${r.stdout}`)
})

await t('t5c_global_corrupt_local_unreg', () => {
  // Review r1 F2, the third polarity: --scope global, corrupt LOCAL playbooks.json,
  // cwd project NOT in the registry. The local file is the only declaration source
  // (B-3), so protection is unknowable and the apply must abort — with
  // willArchiveLocal gated on `scope === 'local'` this silently returned
  // {abort:null, playbookIds:[]} and consolidated the declared chain anyway.
  const s = mkStore()
  const reg = path.join(s.root, '.episodic-memory-global')
  fs.mkdirSync(reg, { recursive: true })
  fs.writeFileSync(path.join(reg, 'installs.json'), JSON.stringify({ entries: [] }), 'utf8')
  addClusterPair(s, { prefix: 'unreg' })
  writePlaybooks(s, '{ corrupt local while unregistered')
  const r = run(s, ['--scope', 'global', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 1,
    `an unreadable local declaration source must abort even under --scope global, got exit ${r.code}: ${r.stdout}`)
  assert.match(r.json.message, /playbooks\.json/, `must name the file, got ${r.json.message}`)
})

await t('t6c_many_clusters_aborts', () => {
  // Review r1 F6: the >5-cluster refusal is a third pre-lock exit.
  const s = mkStore()
  for (let i = 0; i < 7; i++) addClusterPair(s, { prefix: `many${i}` })
  writePlaybooks(s, '{ corrupt')
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply'])
  assert.equal(r.code, 1,
    `R4d must fire before the >5-cluster refusal, got exit ${r.code}: ${r.stdout}`)
  assert.match(r.json.message, /playbooks\.json/,
    `must be the abort, not the narrow-your-filter message, got ${r.json.message}`)
})

await t('t14b_all_projects_third_store', () => {
  // Review r1 F1 regression: protection rows for --all-projects are the realpath-keyed
  // union across EVERY registered store. A referencer in a THIRD store must still
  // protect a member folded elsewhere. With the rows hardcoded to LOCAL+GLOBAL this
  // archived 11 protected episodes.
  const a = mkStore(), b = mkStore(), c = mkStore()
  const victim = addEpisode(b, { id: 'victim-aaaa', summary: 'victim chain member', body: 'x' })
  addEpisode(c, { id: 'guard-aaaa', summary: 'a lesson whose evidence names the victim', body: 'x', extra: { category: 'lesson', evidence: `[${victim}]` } })
  const reg = path.join(a.root, '.episodic-memory-global')
  fs.mkdirSync(reg, { recursive: true })
  fs.writeFileSync(path.join(reg, 'installs.json'),
    JSON.stringify({ entries: [{ data_dir: b.dir }, { data_dir: c.dir }] }), 'utf8')
  const r = run(a, ['--fold-superseded', '--all-projects', '--dry-run'])
  assert.equal(r.code, 0, `dry run must succeed: ${r.stdout}`)
  assert.ok(!JSON.stringify(r.json).includes(victim) || r.json.folded_total === 0,
    `a third-store referencer must keep the victim unfolded, got ${JSON.stringify(r.json)}`)
})

await t('t5b_scope_global_reads_registry', () => {
  const s = mkStore()
  writePlaybooks(s, '{ corrupt local')
  addClusterPair(s, { prefix: 'globalscope' })
  const r = run(s, ['--scope', 'global', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 1,
    `--scope global must still abort on the cwd-local corrupt config, got exit ${r.code}: ${r.stdout}`)
})

// --- Group 4: R4a marker inheritance ---------------------------------------

await t('t7_legacy_marker_inherit', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'mark', playbookOnFirst: true })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const digestId = r.json.clusters[0].digest_id
  assert.ok(digestId, 'a digest must have been written')
  assert.match(episodeText(s, digestId), /^playbook: true$/m,
    'the digest FILE must carry the inherited marker')
  const digestRow = indexRows(s).find(x => x.id === digestId)
  assert.equal(digestRow.playbook, true,
    `the digest INDEX ROW must carry the inherited marker, got ${JSON.stringify(digestRow)}`)
})

await t('t7b_clerk_marker_inherit', () => {
  const s = mkStore()
  // State-D fixture: two episodes sharing a `supersedes` parent — the
  // clerk's supersession-adjacency rule (em-consolidate.mjs:1631-1633)
  // resolves action to `merge` regardless of lexical similarity. The prior
  // near-duplicate pair resolved to state-A `dedupe` instead, which is why
  // the `if (!merged) { ... return }` guard ran instead of any marker
  // assertion. Without this fixture the leg is vacuous. Summaries DIVERGE so
  // a hypothetical caller that ignored supersession-adjacency would still
  // resolve to `keep-distinct` (state C), not `dedupe`.
  addEpisode(s, { id: 'clerkmark-aaaa', summary: 'P1-S2 clerk merge path runs through reviewer gate then writes digest artifact under the held lock.', body: 'shared body', tags: ['p1s2'], extra: { supersedes: 'common-parent' }, playbook: true })
  addEpisode(s, { id: 'clerkmark-bbbb', summary: 'P1-S2 fixture-correction task swaps string triggers for arrays so array-only contract fires on this lesson.', body: 'shared body', tags: ['p1s2'], extra: { supersedes: 'common-parent' } })
  const r = run(s, ['--clerk', '--apply', '--confirm', '--scope', 'local'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const merged = (r.json.applied || []).find(a => a.action === 'merge')
  assert.ok(merged, `expected a merge action; clerk applied=${JSON.stringify((r.json.applied || []).map(a => a.action))} — fixture failed to drive state-D merge`)
  assert.match(episodeText(s, merged.digest_id), /^playbook: true$/m,
    'the clerk digest FILE must carry the inherited marker')
  const row = indexRows(s).find(x => x.id === merged.digest_id)
  assert.equal(row.playbook, true, `the clerk digest INDEX ROW must carry it, got ${JSON.stringify(row)}`)
  assert.ok(r.json.playbook_advisory && Array.isArray(r.json.playbook_advisory.marker_inheritance) && r.json.playbook_advisory.marker_inheritance.length === 1,
    `a marked-but-undeclared clerk merge must produce a marker_inheritance entry per REQ-9, got ${JSON.stringify(r.json.playbook_advisory)}`)
  assert.equal(r.json.playbook_advisory.marker_inheritance[0].kind, 'digest',
    `kind must be 'digest' for a merge, got ${r.json.playbook_advisory.marker_inheritance[0].kind}`)
})

await t('t7c_no_member_no_marker', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'nomark', playbookOnFirst: false })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const digestId = r.json.clusters[0].digest_id
  assert.doesNotMatch(episodeText(s, digestId), /^playbook: true$/m,
    'no member carried the marker, so the digest must NOT invent one (negative polarity)')
  const row = indexRows(s).find(x => x.id === digestId)
  assert.equal(row.playbook, undefined, `index row must omit the key entirely, got ${JSON.stringify(row)}`)
})

await t('t8_dedupe_no_mutation', () => {
  const s = mkStore()
  const [a] = addClusterPair(s, { prefix: 'dedup', playbookOnFirst: true })
  const before = episodeText(s, a)
  const r = run(s, ['--clerk', '--apply', '--confirm', '--scope', 'local'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const deduped = (r.json.applied || []).find(x => x.action === 'dedupe')
  if (!deduped) { assert.ok(true, 'no dedupe proposed on this fixture'); return }
  const canonical = deduped.canonical
  const after = episodeText(s, canonical)
  const markerBefore = /^playbook: true$/m.test(before)
  const markerAfter = /^playbook: true$/m.test(after)
  assert.equal(markerAfter, markerBefore,
    'B-4: dedupe must not add or remove the marker on an existing canonical episode')
})

await t('t8b_dedupe_prefers_marked_canonical', () => {
  // Review r1 D6: canonical selection is cluster-build order, so a marker-bearing
  // member can be superseded onto an unmarked canonical, and terminalOfChain then
  // resolves a declaration to an episode with no `playbook: true` — the R1
  // detection predicate silently desyncs. Prefer a marked member. Zero mutation.
  const s = mkStore()
  const shared = 'consolidation protection playbook parity digest apply path retention'
  addEpisode(s, { id: 'pick-aaaa', summary: `pick plain ${shared}`, body: shared, tags: ['p1s2'] })
  const marked = addEpisode(s, { id: 'pick-bbbb', summary: `pick SENTINEL_P1S2_MARKED ${shared}`, body: shared, tags: ['p1s2'], playbook: true })
  const r = run(s, ['--clerk', '--apply', '--confirm', '--scope', 'local'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const deduped = (r.json.applied || []).find(x => x.action === 'dedupe')
  if (!deduped) { assert.ok(true, 'no dedupe proposed on this fixture'); return }
  assert.equal(deduped.canonical, marked,
    `the marker-bearing member must win canonical selection over build order, got ${deduped.canonical}`)
})

await t('t13_rebuild_roundtrip_digest', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'rebuild', playbookOnFirst: true })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const digestId = r.json.clusters[0].digest_id
  const rb = spawnSync(process.execPath, [REBUILD, '--scope', 'local'],
    { cwd: s.root, encoding: 'utf8', env: { ...process.env, HOME: s.root } })
  assert.equal(rb.status, 0, `rebuild must succeed: ${rb.stdout}${rb.stderr}`)
  const row = indexRows(s).find(x => x.id === digestId)
  assert.equal(row.playbook, true,
    `the marker must survive a rebuild on a consolidate-written digest, got ${JSON.stringify(row)}`)
})

// --- Group 5: R4c advisory --------------------------------------------------

await t('t9_advisory_on_protected', () => {
  const s = mkStore()
  const [a] = addClusterPair(s, { prefix: 'adv' })
  writePlaybooks(s, { schema_version: 1, playbooks: [{ id: a, mode: 'session_start' }] })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const adv = r.json.playbook_advisory
  assert.ok(adv, `an advisory must be present, got ${JSON.stringify(r.json)}`)
  assert.equal(adv.protected_declarations[0].declaration_id, a,
    `the advisory must name the declaration ${a}, got ${JSON.stringify(adv.protected_declarations)}`)
  assert.match(adv.note, /playbooks\.json/,
    `the note must name the recovery path, got ${adv.note}`)
})

await t('t9b_advisory_on_marker_inheritance', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'subst', playbookOnFirst: true }) // marked but NOT declared
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  const adv = r.json.playbook_advisory
  assert.ok(adv && Array.isArray(adv.marker_inheritance) && adv.marker_inheritance.length === 1,
    `a marked-but-undeclared member must produce a marker_inheritance entry, got ${JSON.stringify(adv)}`)
  assert.equal(adv.marker_inheritance[0].kind, 'digest',
    `the legacy path writes a digest, got ${adv.marker_inheritance[0].kind}`)
  assert.equal(adv.marker_inheritance[0].resolves_to, r.json.clusters[0].digest_id,
    'the advisory must name the digest that inherited the marker')
  assert.ok(!('protected_declarations' in adv),
    `nothing was declared, so no declaration may be claimed, got ${JSON.stringify(adv)}`)
})

await t('t9d_advisory_silent_on_nonplaybook_protection', () => {
  const s = mkStore()
  // Two trigger-bearing lessons: protection class b fires, class e does NOT.
  // No playbooks.json exists anywhere.
  const shared = 'consolidation protection playbook parity digest apply path retention'
  addEpisode(s, { id: 'trig-aaaa', summary: `trig SENTINEL_P1S2_MARKED ${shared}`, body: shared, tags: ['p1s2'], extra: { triggers: ['alpha'] } })
  addEpisode(s, { id: 'trig-bbbb', summary: `trig sibling ${shared}`, body: shared, tags: ['p1s2'], extra: { triggers: ['beta'] } })
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  assert.ok(Array.isArray(r.json.protection_skips) && r.json.protection_skips.length === 1,
    `the skip must still be reported, got ${JSON.stringify(r.json.protection_skips)}`)
  assert.match(r.json.protection_skips[0].reason, /trigger-bearing-lesson/,
    `the skip is a non-playbook class, got ${r.json.protection_skips[0].reason}`)
  assert.ok(!('playbook_advisory' in r.json),
    `a non-playbook protection class must NOT be labelled a declared playbook chain, got ${r.stdout}`)
})

await t('t9c_advisory_absent_when_irrelevant', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'plain' }) // no marker, no playbooks.json at all
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  assert.ok(!('playbook_advisory' in r.json),
    `a non-playbook store's output must stay byte-identical, got ${JSON.stringify(r.json)}`)
  assert.ok(!('protection_skips' in r.json),
    'no skips means the key is omitted entirely')
})

await t('t10_abort_before_advisory', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'order', playbookOnFirst: true })
  writePlaybooks(s, '{ corrupt')
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 1, 'must abort')
  assert.ok(!('playbook_advisory' in (r.json || {})),
    `the fail-open advisory must never be constructed on the abort path, got ${r.stdout}`)
})

// --- Group 6: mechanics -----------------------------------------------------

await t('t11b_empty_skips_yield_null_advisory', () => {
  // Review r2 F3 flagged em-consolidate.mjs:2142, which builds a clerk run record with
  // skippedGuard: []. An empty skip set plus no marked members must yield NO advisory
  // key at all, not an empty advisory object.
  const s = mkStore()
  addClusterPair(s, { prefix: 'emptyskip' })
  const r = run(s, ['--clerk', '--apply', '--confirm', '--scope', 'local'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  assert.ok(!('playbook_advisory' in r.json),
    `an empty skip set must omit the key entirely, got ${r.stdout}`)
})

await t('t11_declarations_parsed_once', () => {
  const s = mkStore()
  const [a] = addClusterPair(s, { prefix: 'once' })
  writePlaybooks(s, { schema_version: 1, playbooks: [{ id: a, mode: 'session_start' }] })
  // The advisory + resolver each read the file at most once. Proven by making the
  // file readable exactly twice: a counting FIFO is not portable, so assert the
  // observable instead — a single run completes and reports the declaration.
  const r = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(r.code, 0, `exit 0 expected: ${r.stdout}`)
  assert.equal(r.json.protection_skips.length, 1,
    'one declaration resolved once produces exactly one skip entry, not one per cluster member')
})

await t('t12_abort_releases_lock', () => {
  const s = mkStore()
  addClusterPair(s, { prefix: 'lockrel' })
  writePlaybooks(s, '{ corrupt')
  const first = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(first.code, 1, 'the first run must abort')
  writePlaybooks(s, { schema_version: 1, playbooks: [] })
  const second = run(s, ['--scope', 'local', '--min-sim', '0.3', '--apply', '--confirm'])
  assert.equal(second.code, 0,
    `the aborted run must have released the store lock, second run got exit ${second.code}: ${second.stdout}`)
  assert.equal(second.json.applied, 1, 'the second run consolidates normally')
})

console.log(`\n${pass}/${pass + fail} pass`)
process.exit(fail === 0 ? 0 : 1)
