/**
 * test-em-search-read.mjs — RFC-011 P1-S1 (REQ-14 / T10, amended): em-search --read <id>.
 *
 * Tracked single-episode read returning the FULL body; file-frontmatter merge;
 * body_missing handling; empty-id error. Every test asserts captured real output
 * (spawnSync stdout/stderr/exit) against an ISOLATED tmp store + fake HOME; no test
 * touches the operator's real store (spawn with explicit cwd + HOME env, always
 * --scope local — the CLAUDE.md "isolated scratch store" convention; resolveLocalDir()
 * falls back to cwd on the non-git fixture).
 *
 * Cases (brief P1-S1 + fix-brief amendments):
 *  1.  found:           exact id → {status:"ok", episode:{...full frontmatter+body}}, exit 0
 *  2.  missing:         unknown id → {status:"error"}, exit 1
 *  3.  --no-track:      index.jsonl row unchanged (before/after read)
 *  4.  tracked delta:   access_count +1 and last_accessed set on the read row ONLY
 *  5.  round-trip:      quote-heavy oversized body → returned IN FULL, byte-identical,
 *                       body_truncated ABSENT, empty stderr, valid JSON (inverted
 *                       2026-07-25 when the read cap was removed)
 *  6.  archived:        id in archived/ returns normally with its status field visible
 *  7.  deny-check:      --history output byte-identical across two runs (determinism only;
 *                       baseline --history protection lives in test-history-walk.mjs)
 *  8.  red-then-green:  --read <unknown> → error exit 1 (baseline: unknown flag → search, exit 0)
 *  -- fix-round additions (F1/F2/F-codex/F-kimi/F4/F5) --
 *  9.  F1 multibyte:    oversized CJK body → returned IN FULL, byte-identical, valid JSON
 *  10. F2a dangling:    index row present, body file absent → body_missing:true, status ok,
 *                       exit 0, stderr note, access_count stays 0 (tracking skipped)
 *  11. F2b torn-prune:  file moved to archived/, row still active → body_missing:true,
 *                       access_count stays 0
 *  12. F-codex merge:    custom frontmatter key in the episode FILE survives (file wins over row)
 *  13. F-kimi empty id:  --read '' → {status:"error"} exit 1 (presence, not truthiness)
 *  14. former-cap size: body whose serialized bytes == 49152 → returned in full
 *  15. past former cap:  body whose serialized bytes == 49153 → returned in full
 *  16. multibyte whole: CJK body round-trips byte-identically (multibyte leg, would
 *                       have caught F1; covers surrogate-safety)
 *  -- fix round 2 — merge-layer authority + LOCKSTEP coercions --
 *  17. F1 round-2 forged: forged operational frontmatter (access_count/last_accessed/
 *                       archived/source) on an active local row does NOT override the
 *                       resolution (operational fields forced from the row/store/dir)
 *  18. F2 round-2 LOCKSTEP: real em-store --priority 5 --pin → --read emits Number/boolean
 *                       (priority/pinned type-coerced to match list/index surfaces)
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_SEARCH = path.join(REPO, 'scripts/em-search.mjs');

// The read's FORMER serialized-byte cap, removed 2026-07-25. It is no longer a
// contract bound — nothing in em-search reads it. Cases 14 and 15 keep it only as
// a fixture SIZE, so they can sit exactly at and one byte past the value that used
// to change behavior and prove it no longer does.
const FORMER_CAP = 49152;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// mkStore() — isolated tmp store + fake HOME. The cwd is NOT a git repo, so
// resolveLocalDir() (git rev-parse) fails and falls back to cwd →
// <cwd>/.episodic-memory (the fixture's own store, never the operator's).
// fake HOME isolates the global store so even --scope all cannot reach the
// real ~/.episodic-memory; every test below additionally pins --scope local.
function mkStore() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emread-')));
  const home = path.join(cwd, 'home');
  fs.mkdirSync(path.join(cwd, '.episodic-memory', 'episodes'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.episodic-memory', 'archived'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { cwd, home };
}
function storeDir(cwd) { return path.join(cwd, '.episodic-memory'); }
function indexPath(cwd) { return path.join(storeDir(cwd), 'index.jsonl'); }
function archIndexPath(cwd) { return path.join(storeDir(cwd), 'archived-index.jsonl'); }
function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function rowById(rows, id) { return rows.find((r) => r.id === id); }

// writeEpisodeFile — hand-write ONLY an episode file (no index row). Used for
// the frontmatter-merge fixture where caller controls the index row separately.
function writeEpisodeFile(cwd, opts) {
  const {
    id, status = 'active', summary = 's', body = 'b',
    supersedes = null, category = 'lesson', tags = [],
    extraFrontmatter = [], sub = 'episodes', noHeading = false,
  } = opts;
  const subDir = path.join(storeDir(cwd), sub);
  fs.mkdirSync(subDir, { recursive: true });
  const lines = [
    '---',
    `id: ${id}`,
    'date: 2026-07-10',
    'time: "00:00"',
    'project: t',
    `category: ${category}`,
    `status: ${status}`,
    ...(supersedes ? [`supersedes: ${supersedes}`] : []),
    `tags: [${tags.join(', ')}]`,
    `summary: ${summary}`,
    ...extraFrontmatter,
    '---',
    '',
    ...(noHeading ? [] : [`# ${summary}`, '']),
    body,
    '',
  ];
  fs.writeFileSync(path.join(subDir, `${id}.md`), lines.join('\n'));
}

// writeEpisode — hand-write an episode file + index row (no em-store, so the
// fixture stays fully isolated and the body bytes are controlled exactly for
// the size-bound tests). Mirrors em-store's frontmatter + index-row shape.
function writeEpisode(cwd, opts) {
  const {
    id, status = 'active', summary = 's', body = 'b',
    supersedes = null, category = 'lesson', tags = [], archived = false,
    extraFrontmatter = [], noHeading = false,
  } = opts;
  writeEpisodeFile(cwd, { id, status, summary, body, supersedes, category, tags, extraFrontmatter, sub: archived ? 'archived' : 'episodes', noHeading });
  const row = {
    id, date: '2026-07-10', time: '00:00', project: 't', category,
    status, supersedes, tags, summary, access_count: 0, last_accessed: null,
  };
  // extraFrontmatter keys are file-only by design (F-codex); they are NOT added
  // to the index row, so the merge test can assert file-wins-over-row.
  const file = archived ? archIndexPath(cwd) : indexPath(cwd);
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return id;
}

const IS_WIN = process.platform === 'win32';

function run(cwd, home, args) {
  const r = spawnSync('node', [EM_SEARCH, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 10000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function readOne(cwd, home, id, extra = []) {
  return run(cwd, home, ['--read', id, '--scope', 'local', ...extra]);
}

// ---------------------------------------------------------------------------
// Case 1: found — exact id returns {status:"ok", episode:{...full + body}}, exit 0
// ---------------------------------------------------------------------------
t('readFoundReturnsFullEpisode', () => {
  const { cwd, home } = mkStore();
  writeEpisode(cwd, { id: 'ep-found-1', summary: 'found one', body: 'the body text', tags: ['alpha', 'beta'] });
  const r = readOne(cwd, home, 'ep-found-1');
  assert.equal(r.code, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(r.json.status, 'ok');
  const ep = r.json.episode;
  assert.ok(ep, 'episode object present');
  assert.equal(ep.id, 'ep-found-1');
  assert.equal(ep.summary, 'found one');
  assert.equal(ep.project, 't');
  assert.equal(ep.category, 'lesson');
  assert.equal(ep.status, 'active');
  assert.equal(ep.date, '2026-07-10');
  assert.equal(ep.time, '00:00');
  assert.deepEqual(ep.tags, ['alpha', 'beta']);
  assert.equal(ep.source, 'local');
  assert.ok(ep.body.includes('the body text'), `body present: ${ep.body}`);
  assert.equal(r.json.episodes, undefined, 'no episodes[] array on --read');
});

// ---------------------------------------------------------------------------
// Case 2: missing/unknown id → {status:"error"}, exit 1
// ---------------------------------------------------------------------------
t('readMissingReturnsErrorExit1', () => {
  const { cwd, home } = mkStore();
  writeEpisode(cwd, { id: 'ep-other', summary: 'other', body: 'x' });
  const r = readOne(cwd, home, 'no-such-id');
  assert.equal(r.code, 1, `exit 1; stdout=${r.stdout}`);
  assert.equal(r.json.status, 'error');
  assert.ok(r.json.message, 'error message present');
});

// ---------------------------------------------------------------------------
// Case 3: --no-track leaves the index row unchanged (before/after read)
// ---------------------------------------------------------------------------
t('readNoTrackLeavesRowUnchanged', () => {
  const { cwd, home } = mkStore();
  writeEpisode(cwd, { id: 'ep-notrack', summary: 'nt', body: 'b' });
  const before = rowById(readRows(indexPath(cwd)), 'ep-notrack');
  assert.equal(before.access_count, 0);
  assert.equal(before.last_accessed, null);
  const r = readOne(cwd, home, 'ep-notrack', ['--no-track']);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');
  const after = rowById(readRows(indexPath(cwd)), 'ep-notrack');
  assert.equal(after.access_count, 0, 'access_count unchanged under --no-track');
  assert.equal(after.last_accessed, null, 'last_accessed unchanged under --no-track');
});

// ---------------------------------------------------------------------------
// Case 4: tracked delta — access_count +1 and last_accessed set, ON THAT ROW ONLY
// ---------------------------------------------------------------------------
t('readTrackedBumpsAccessCountOnMatchedRowOnly', () => {
  const { cwd, home } = mkStore();
  writeEpisode(cwd, { id: 'ep-target', summary: 'tgt', body: 'b' });
  writeEpisode(cwd, { id: 'ep-bystander', summary: 'by', body: 'b' });
  const beforeTarget = rowById(readRows(indexPath(cwd)), 'ep-target');
  const beforeBy = rowById(readRows(indexPath(cwd)), 'ep-bystander');
  assert.equal(beforeTarget.access_count, 0);
  assert.equal(beforeBy.access_count, 0);
  const r = readOne(cwd, home, 'ep-target');
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');
  const afterTarget = rowById(readRows(indexPath(cwd)), 'ep-target');
  const afterBy = rowById(readRows(indexPath(cwd)), 'ep-bystander');
  assert.equal(afterTarget.access_count, 1, 'access_count +1 on the read row');
  assert.ok(
    typeof afterTarget.last_accessed === 'string' && afterTarget.last_accessed.length > 0,
    'last_accessed set on the read row'
  );
  assert.equal(afterBy.access_count, 0, 'bystander row untouched');
  assert.equal(afterBy.last_accessed, null, 'bystander last_accessed untouched');
});

// ---------------------------------------------------------------------------
// Case 5 (INVERTED 2026-07-25): quote-heavy oversized body → returned IN FULL,
//          valid JSON, no body_truncated, no stderr note. The read path no
//          longer bounds the body: the former 49152 serialized-byte cap was a
//          host DISPLAY limit implemented as a storage bound, which made the
//          round-trip lossy because em-store/em-revise bound nothing at write
//          time. This is the case the old cap cut hardest (JSON escaping
//          doubles each quote), so it is the sharpest round-trip leg.
// ---------------------------------------------------------------------------
t('readQuoteHeavyBodyReturnedInFull', () => {
  const { cwd, home } = mkStore();
  // Quote-heavy body: JSON.stringify doubles each " (→ \\"), so a 60k-quote raw
  // body serializes to ~120k — formerly truncated to 49152 serialized bytes.
  const big = '"'.repeat(60000);
  writeEpisode(cwd, { id: 'ep-big', summary: 'big', body: big });
  const expected = `# big\n\n${big}`;
  const r = readOne(cwd, home, 'ep-big');
  assert.equal(r.code, 0, `exit 0; stderr=${r.stderr}`);
  assert.equal(r.json.status, 'ok', `stdout parsed valid JSON; head=${r.stdout.slice(0, 160)}`);
  const ep = r.json.episode;
  assert.equal(ep.body_truncated, undefined, 'no read truncates; the flag is retired');
  assert.equal(
    ep.body.length, expected.length,
    `full body returned; got ${ep.body.length} chars of ${expected.length}`
  );
  assert.equal(ep.body, expected, 'body is byte-identical to what was stored');
  assert.equal(r.stderr, '', `no truncation note on stderr; stderr=${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Case 6: archived — id moved to archived/ returns normally with status visible
// ---------------------------------------------------------------------------
t('readArchivedReturnsWithStatusVisible', () => {
  const { cwd, home } = mkStore();
  // Reproduce the state em-prune produces: episode file + row moved to
  // archived/ (episodes/ entry absent). --read must surface status (R7: a
  // pointer must not dangle if its target was archived mid-session).
  writeEpisode(cwd, { id: 'ep-arch', summary: 'archived one', body: 'archbody', status: 'active', archived: true });
  assert.equal(rowById(readRows(indexPath(cwd)), 'ep-arch'), undefined, 'absent from active index');
  assert.ok(rowById(readRows(archIndexPath(cwd)), 'ep-arch'), 'present in archived index');
  const r = readOne(cwd, home, 'ep-arch');
  assert.equal(r.code, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(r.json.status, 'ok');
  const ep = r.json.episode;
  assert.equal(ep.id, 'ep-arch');
  assert.equal(ep.status, 'active', 'status field visible');
  assert.equal(ep.archived, true, 'archived flag set');
  assert.ok(ep.body.includes('archbody'), 'body resolved from archived/');
});

// ---------------------------------------------------------------------------
// Case 7: deny-check — --history output byte-identical across two runs
//          (determinism only; baseline --history protection lives in
//          test-history-walk.mjs, which stays green — done criteria)
// ---------------------------------------------------------------------------
t('readDenyCheckHistoryDeterministicAcrossRuns', () => {
  const { cwd, home } = mkStore();
  // A supersedes chain; --history must still produce the known-good walk
  // (root → c1 → c2, bodies resolvable with --full), byte-identically across
  // two runs. HARD STOP in the brief: do not touch --history behavior;
  // baseline protection is asserted by test-history-walk.mjs (5/5 green in
  // done criteria), this test asserts only determinism of the post-diff binary.
  writeEpisode(cwd, { id: 'root', summary: 'root', body: 'rb' });
  writeEpisode(cwd, { id: 'c1', summary: 'c1', body: 'c1b', supersedes: 'root' });
  writeEpisode(cwd, { id: 'c2', summary: 'c2', body: 'c2b', supersedes: 'c1' });
  const r1 = run(cwd, home, ['--history', 'root', '--scope', 'local', '--full']);
  const r2 = run(cwd, home, ['--history', 'root', '--scope', 'local', '--full']);
  assert.equal(r1.code, 0, `--history exit 0; stdout=${r1.stdout}`);
  assert.equal(r1.stdout, r2.stdout, '--history output byte-identical across runs (determinism)');
  const j = JSON.parse(r1.stdout.trim());
  assert.deepEqual(j.chain.map((e) => e.id), ['root', 'c1', 'c2'], '--history walk order preserved');
  assert.ok(j.chain[0].body.includes('rb'), '--history --full bodies resolvable');
});

// ---------------------------------------------------------------------------
// Case 8: red-then-green negative control
// ---------------------------------------------------------------------------
t('readUnknownIdRedThenGreen', () => {
  // RED (baseline, pre-change): `--read` was an unrecognized flag, so em-search
  // ignored it and fell through to the default search. On an empty local store
  // that produced {status:"ok", count:0, episodes:[]} with exit 0.
  //
  // GREEN (after change): `--read <unknown>` resolves to the read path, finds
  // no episode, and returns {status:"error"} with exit 1. The assertions below
  // would FAIL against baseline em-search (exit 0 / status "ok") and pass now.
  const { cwd, home } = mkStore();
  const r = readOne(cwd, home, 'totally-unknown-id');
  assert.equal(r.code, 1, 'exit 1 (baseline was 0 → red-then-green)');
  assert.equal(r.json.status, 'error', 'error status (baseline was "ok" → red-then-green)');
});

// ===========================================================================
// Fix-round additions (F1/F2/F-codex/F-kimi/F4/F5)
// ===========================================================================

// ---------------------------------------------------------------------------
// Case 9 (F1, INVERTED 2026-07-25): multibyte CJK oversized body → returned IN
// FULL, byte-identical, stdout still valid JSON at ~135,236 UTF-8 body bytes.
// This fixture originally proved the cap measured serialized BYTES rather than
// UTF-16 code units (a 45,000-char CJK body passes a `.length <= 49152` cap yet
// emits ~135,236 bytes). With the cap removed it proves the stronger property:
// a body three times the former bound survives the round trip untouched.
// ---------------------------------------------------------------------------
t('readMultibyteCJKBodyReturnedInFull', () => {
  const { cwd, home } = mkStore();
  const big = '字'.repeat(45000); // 45,000 chars, 135,000 UTF-8 bytes
  writeEpisode(cwd, { id: 'ep-cjk', summary: 'cjk', body: big });
  const expected = `# cjk\n\n${big}`;
  const r = readOne(cwd, home, 'ep-cjk');
  assert.equal(r.code, 0, `exit 0; stderr=${r.stderr}`);
  assert.equal(r.json.status, 'ok');
  const ep = r.json.episode;
  assert.equal(ep.body_truncated, undefined, 'no read truncates; the flag is retired');
  assert.equal(
    ep.body.length, expected.length,
    `full CJK body returned; got ${ep.body.length} chars of ${expected.length}`
  );
  assert.equal(ep.body, expected, 'CJK body is byte-identical to what was stored');
  // The whole stdout stays valid JSON at 135k+ UTF-8 body bytes (no mid-JSON
  // break under multibyte now that nothing slices the body).
  assert.ok(r.json, 'whole stdout parses as valid JSON');
  assert.equal(r.stderr, '', `no truncation note on stderr; stderr=${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Case 10 (F2a): dangling body — index row present, body file absent from BOTH
// episodes/ and archived/ → body_missing:true, status ok, exit 0, stderr note,
// access_count stays 0 (tracking skipped — a delivered-nothing read must not
// feed conversion telemetry). Panel probe P5 (deleted file).
// ---------------------------------------------------------------------------
t('readDanglingBodyReturnsBodyMissingNoTracking', () => {
  const { cwd, home } = mkStore();
  // Write the index row but NO episode file anywhere.
  fs.appendFileSync(indexPath(cwd), JSON.stringify({
    id: 'ep-dangle', date: '2026-07-10', time: '00:00', project: 't',
    category: 'lesson', status: 'active', supersedes: null, tags: [],
    summary: 'dangle', access_count: 0, last_accessed: null,
  }) + '\n');
  const r = readOne(cwd, home, 'ep-dangle');
  assert.equal(r.code, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(r.json.status, 'ok');
  const ep = r.json.episode;
  assert.equal(ep.body_missing, true, 'body_missing flag set');
  assert.equal(ep.body, undefined, 'no body field on a missing-body read');
  assert.ok(/missing/i.test(r.stderr), `stderr carries a missing-body note; stderr=${r.stderr}`);
  // Tracking MUST be skipped.
  const after = rowById(readRows(indexPath(cwd)), 'ep-dangle');
  assert.equal(after.access_count, 0, 'access_count stays 0 (tracking skipped)');
  assert.equal(after.last_accessed, null, 'last_accessed stays null (tracking skipped)');
});

// ---------------------------------------------------------------------------
// Case 11 (F2b): torn-prune — file moved to archived/, row still ACTIVE in the
// index. The active-row path checks episodes/ (miss) and returns body_missing
// (it does NOT fall through to archived/ for a row the local index holds as
// active). Panel probe P5b; access_count stays 0.
// ---------------------------------------------------------------------------
t('readTornPruneReturnsBodyMissingNoTracking', () => {
  const { cwd, home } = mkStore();
  // File ONLY in archived/ (simulating a torn prune: file moved, row not updated).
  writeEpisodeFile(cwd, { id: 'ep-torn', summary: 'torn', body: 'archbody', sub: 'archived' });
  // Row still ACTIVE in index.jsonl.
  fs.appendFileSync(indexPath(cwd), JSON.stringify({
    id: 'ep-torn', date: '2026-07-10', time: '00:00', project: 't',
    category: 'lesson', status: 'active', supersedes: null, tags: [],
    summary: 'torn', access_count: 0, last_accessed: null,
  }) + '\n');
  const r = readOne(cwd, home, 'ep-torn');
  assert.equal(r.code, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.episode.body_missing, true, 'torn-prune → body_missing');
  assert.ok(/missing/i.test(r.stderr), `stderr carries a missing-body note; stderr=${r.stderr}`);
  const after = rowById(readRows(indexPath(cwd)), 'ep-torn');
  assert.equal(after.access_count, 0, 'access_count stays 0 (tracking skipped)');
  assert.equal(after.last_accessed, null, 'last_accessed stays null (tracking skipped)');
});

// ---------------------------------------------------------------------------
// Case 12 (F-codex): custom frontmatter key in the episode FILE survives — the
// returned episode is the file frontmatter merged OVER the index row (file wins
// for frontmatter fields; the row supplies access_count/last_accessed/source).
// ---------------------------------------------------------------------------
t('readMergesFileFrontmatterOverIndexRow', () => {
  const { cwd, home } = mkStore();
  writeEpisode(cwd, {
    id: 'ep-custom', summary: 'customfile', body: 'b',
    extraFrontmatter: ['custom_key: custom-value', 'another_file_only: yes'],
  });
  const r = readOne(cwd, home, 'ep-custom', ['--no-track']);
  assert.equal(r.code, 0, `exit 0; stdout=${r.stdout}`);
  const ep = r.json.episode;
  // File-only custom keys survive (were DROPPED before the fix).
  assert.equal(ep.custom_key, 'custom-value', 'custom frontmatter key survives (file wins)');
  assert.equal(ep.another_file_only, 'yes', 'second custom key survives');
  // File summary wins over the row's summary.
  assert.equal(ep.summary, 'customfile', 'file frontmatter wins over row');
  // Operational fields flow from the index row.
  assert.equal(ep.access_count, 0, 'access_count from index row');
  assert.equal(ep.last_accessed, null, 'last_accessed from index row');
  assert.equal(ep.source, 'local', 'source from index row');
});

// ---------------------------------------------------------------------------
// Case 13 (F-kimi): --read '' (flag present, empty value) → error exit 1.
// The guard checks flag PRESENCE (readId !== undefined), not truthiness, so an
// empty id must NOT fall through to the search path.
// ---------------------------------------------------------------------------
t('readEmptyIdReturnsErrorExit1', () => {
  const { cwd, home } = mkStore();
  writeEpisode(cwd, { id: 'ep-real', summary: 'r', body: 'b' });
  const r = readOne(cwd, home, '');
  assert.equal(r.code, 1, `empty id → exit 1; stdout=${r.stdout}`);
  assert.equal(r.json.status, 'error', 'empty id → error status');
  // Must NOT have fallen through to search (no count/episodes[] array).
  assert.equal(r.json.episodes, undefined, 'empty id did not fall through to search');
  assert.equal(r.json.count, undefined, 'empty id did not produce a search count');
});

// ---------------------------------------------------------------------------
// Case 14: a body sized exactly at the FORMER 49152-byte bound round-trips whole.
// Retained after the 2026-07-25 cap removal as the at-the-old-boundary leg: it and
// case 15 (one byte past) bracket the value that used to change behavior, proving
// nothing changes there any more. For a pure-ASCII body N chars long,
// JSON.stringify adds 2 bytes (quotes) and no escaping, so N=49150 → 49152 bytes.
// ---------------------------------------------------------------------------
t('readFormerCapSizedBodyReturnedInFull', () => {
  const { cwd, home } = mkStore();
  // FORMER_CAP is now only a fixture size, not a contract bound.
  const n = FORMER_CAP - 2;
  const body = 'a'.repeat(n);
  writeEpisodeFile(cwd, { id: 'ep-atcap', summary: 'atcap', body, sub: 'episodes', noHeading: true });
  fs.appendFileSync(indexPath(cwd), JSON.stringify({
    id: 'ep-atcap', date: '2026-07-10', time: '00:00', project: 't',
    category: 'lesson', status: 'active', supersedes: null, tags: [],
    summary: 'atcap', access_count: 0, last_accessed: null,
  }) + '\n');
  const r = readOne(cwd, home, 'ep-atcap', ['--no-track']);
  assert.equal(r.code, 0, `exit 0; stderr=${r.stderr}`);
  const ep = r.json.episode;
  assert.equal(ep.body_truncated, undefined, 'no read truncates; the flag is retired');
  assert.equal(ep.body.length, n, `full body returned; got ${ep.body.length} of ${n}`);
  // Content equality, not just length: a same-length wrong body must fail here.
  assert.equal(ep.body, body, 'body is byte-identical to what was stored');
  assert.equal(r.stderr, '', 'no stderr note at the former boundary');
});

// ---------------------------------------------------------------------------
// Case 15: one byte PAST the former 49152 bound — the leg that used to truncate.
// It now round-trips whole. Paired with case 14 this brackets the old boundary.
// ---------------------------------------------------------------------------
t('readOverFormerCapBoundaryReturnedInFull', () => {
  const { cwd, home } = mkStore();
  const n = FORMER_CAP - 1; // 49151 chars → 49153 serialized bytes
  const body = 'a'.repeat(n);
  writeEpisodeFile(cwd, { id: 'ep-over', summary: 'over', body, sub: 'episodes', noHeading: true });
  fs.appendFileSync(indexPath(cwd), JSON.stringify({
    id: 'ep-over', date: '2026-07-10', time: '00:00', project: 't',
    category: 'lesson', status: 'active', supersedes: null, tags: [],
    summary: 'over', access_count: 0, last_accessed: null,
  }) + '\n');
  const r = readOne(cwd, home, 'ep-over', ['--no-track']);
  assert.equal(r.code, 0, `exit 0; stderr=${r.stderr}`);
  const ep = r.json.episode;
  assert.equal(ep.body_truncated, undefined, 'one byte over the former cap is no longer truncated');
  assert.equal(ep.body.length, n, `full body returned; got ${ep.body.length} of ${n}`);
  assert.equal(ep.body, body, 'body is byte-identical to what was stored');
  assert.equal(r.stderr, '', `no truncation note on stderr; stderr=${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Case 16 (INVERTED 2026-07-25): an oversized CJK body round-trips WHOLE, not as
// a prefix. This was the surrogate-safety leg for the old slicing code, which
// could cut a surrogate pair and relied on JSON.stringify escaping lone
// surrogates to stay valid. Nothing slices the body now, so the assertion is
// upgraded from prefix-integrity to full-content equality plus a serialized-byte
// equality check — every byte stored is a byte returned.
// ---------------------------------------------------------------------------
t('readMultibyteBodyIntegrityInFull', () => {
  const { cwd, home } = mkStore();
  const big = '字'.repeat(45000);
  writeEpisode(cwd, { id: 'ep-cjkprefix', summary: 'cjkprefix', body: big, noHeading: true });
  const r = readOne(cwd, home, 'ep-cjkprefix', ['--no-track']);
  assert.equal(r.code, 0, `exit 0; stderr=${r.stderr}`);
  const ep = r.json.episode;
  assert.equal(ep.body_truncated, undefined, 'no read truncates; the flag is retired');
  assert.equal(ep.body.length, big.length, `full body returned; got ${ep.body.length} of ${big.length}`);
  // Integrity across the whole body, not just a prefix of it.
  assert.equal(ep.body, big, 'CJK body round-trips byte-identically');
  assert.equal(
    Buffer.byteLength(JSON.stringify(ep.body), 'utf8'),
    Buffer.byteLength(JSON.stringify(big), 'utf8'),
    'serialized body carries every byte that was stored'
  );
});

// ===========================================================================
// Fix round 2 — merge-layer authority + LOCKSTEP coercions
// ===========================================================================

// ---------------------------------------------------------------------------
// Case 17 (F1 round-2, operational-field authority): a file whose frontmatter
// carries forged operational fields (access_count: 999, last_accessed: forged,
// archived: true, source: global) on an ACTIVE LOCAL row must NOT override the
// resolution. Amended R7: the index supplies access_count/last_accessed/source;
// archived comes from which directory the body resolved from. Pre-fix, all four
// forged values leaked into the output.
// ---------------------------------------------------------------------------
t('readForgedOperationalFrontmatterDoesNotOverrideRow', () => {
  const { cwd, home } = mkStore();
  writeEpisode(cwd, {
    id: 'ep-forge', summary: 'forge', body: 'b',
    extraFrontmatter: [
      'access_count: 999',
      'last_accessed: forged',
      'archived: true',
      'source: global',
    ],
  });
  // Row carries the real operational values (access_count 0, last_accessed
  // null, no archived, no source — the index never carries source/archived).
  const r = readOne(cwd, home, 'ep-forge', ['--no-track']);
  assert.equal(r.code, 0, `exit 0; stdout=${r.stdout}`);
  const ep = r.json.episode;
  // Operational fields come from the RESOLUTION, not file frontmatter.
  assert.equal(ep.access_count, 0, 'access_count from index row (forged 999 rejected)');
  assert.equal(ep.last_accessed, null, 'last_accessed from index row (forged rejected)');
  assert.equal(ep.source, 'local', 'source from the resolving store (forged global rejected)');
  assert.equal(ep.archived, undefined, 'no archived field for an active row (forged true rejected)');
});

// ---------------------------------------------------------------------------
// Case 18 (F2 round-2, LOCKSTEP type coercions): store an episode via the REAL
// em-store CLI with --priority 5 --pin, then assert --read emits Number/boolean
// (matching the list/index surfaces), NOT the strings the file-frontmatter
// parser yields. Hand-written fixtures cannot catch this class: em-store emits
// priority: 5 / pinned: true as YAML scalars in the FILE and Number/boolean in
// the INDEX ROW, so only a real em-store round-trip exercises the file-wins
// path that leaves them as strings without the LOCKSTEP coercions.
// ---------------------------------------------------------------------------
t('readLockstepCoercesPriorityPinnedTypesViaRealEmStore', () => {
  const { cwd, home } = mkStore();
  // REAL em-store CLI (not a hand-written fixture) with the activation flags
  // that produce priority + pinned frontmatter.
  const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
  const store = spawnSync('node', [EM_STORE,
    '--project', 't', '--category', 'lesson',
    '--summary', 'prio pin', '--body', 'b',
    '--scope', 'local', '--trigger', 'demo phrase',
    '--priority', '5', '--pin',
  ], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(store.status, 0, `em-store exit 0; stdout=${store.stdout} stderr=${store.stderr}`);
  const id = JSON.parse(store.stdout.trim()).id;
  // Sanity: the index row carries Number/boolean (the canonical surface).
  const row = rowById(readRows(indexPath(cwd)), id);
  assert.equal(typeof row.priority, 'number', 'index row priority is a Number');
  assert.equal(row.pinned, true, 'index row pinned is boolean true');
  // Sanith: the FILE frontmatter carries YAML scalars (strings post-parse).
  const fileContent = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${id}.md`), 'utf8');
  assert.ok(/^priority: 5$/m.test(fileContent), 'file frontmatter carries priority: 5 (YAML scalar)');
  assert.ok(/^pinned: true$/m.test(fileContent), 'file frontmatter carries pinned: true (YAML scalar)');
  // --read must emit Number/boolean (LOCKSTEP with em-rebuild-index:181-184/:208),
  // NOT the strings the file-frontmatter parser yields.
  const r = readOne(cwd, home, id, ['--no-track']);
  assert.equal(r.code, 0, `exit 0; stdout=${r.stdout}`);
  const ep = r.json.episode;
  assert.equal(typeof ep.priority, 'number', 'priority is a Number (LOCKSTEP coercion)');
  assert.equal(ep.priority, 5, 'priority value preserved (5)');
  assert.equal(ep.pinned, true, 'pinned is boolean true (LOCKSTEP coercion, not string "true")');
});

// ===========================================================================
// Issue #666/#667 S2 additions: FIFO-shaped episode bodies in the query
// tier. --read is a single-target authoritative read (typed abort); --full
// query and --materialize are per-row skip+warning (F5: non-ENOENT codes
// only — ENOENT/absent preserves each site's existing silent behavior).
// ===========================================================================

if (!IS_WIN) {
  t('readFifoBodyReturnsTypedAbort', () => {
    const { cwd, home } = mkStore();
    const id = writeEpisode(cwd, { id: 'ep-fifo', summary: 'fifo target', body: 'b' });
    const filePath = path.join(storeDir(cwd), 'episodes', `${id}.md`);
    fs.unlinkSync(filePath);
    const mk = spawnSync('mkfifo', [filePath]);
    assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`);
    const r = readOne(cwd, home, id);
    fs.unlinkSync(filePath);
    assert.equal(r.code, 1, `exit 1; stdout=${r.stdout}`);
    assert.equal(r.json.status, 'error');
    assert.equal(r.json.code, 'episode-unreadable:ENOTREG', `typed code, got ${JSON.stringify(r.json)}`);
    assert.ok(/episode body unreadable/.test(r.json.message || ''), `message names the defect, got ${JSON.stringify(r.json)}`);
  });

  t('searchFullWithFifoBodySkipsRowWithWarning', () => {
    const { cwd, home } = mkStore();
    writeEpisode(cwd, { id: 'ep-healthy', summary: 'healthy episode', body: 'healthy body text' });
    const fifoId = writeEpisode(cwd, { id: 'ep-fifobody', summary: 'fifo episode', body: 'will be replaced' });
    const fifoPath = path.join(storeDir(cwd), 'episodes', `${fifoId}.md`);
    fs.unlinkSync(fifoPath);
    const mk = spawnSync('mkfifo', [fifoPath]);
    assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`);
    const r = run(cwd, home, ['--full', '--scope', 'local', '--no-track']);
    fs.unlinkSync(fifoPath);
    assert.equal(r.code, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.json.status, 'ok');
    const healthy = r.json.episodes.find((e) => e.id === 'ep-healthy');
    const fifoEp = r.json.episodes.find((e) => e.id === fifoId);
    assert.ok(healthy && healthy.body, 'healthy episode body present');
    assert.ok(fifoEp, 'FIFO-shaped episode row still present (skip, not drop)');
    assert.equal(fifoEp.body, undefined, 'FIFO-shaped episode row emitted WITHOUT body');
    assert.ok(
      typeof r.json.warning === 'string' && r.json.warning.includes('ep-fifobody') && r.json.warning.includes('ENOTREG'),
      `warning names the skipped episode + code, got ${JSON.stringify(r.json.warning)}`
    );
  });

  // Review fix-round item 3 (§8 matrix control): a dangling row (ENOENT —
  // absent, not a shape defect) must stay silent per F5 — no warning field
  // at all, not even an empty one. Kills removal of the ENOENT guard in
  // em-search's noteBodySkip.
  t('searchFullWithDanglingRowStaysSilentControl', () => {
    const { cwd, home } = mkStore();
    fs.appendFileSync(indexPath(cwd), JSON.stringify({
      id: 'ep-dangle-full', date: '2026-07-10', time: '00:00', project: 't',
      category: 'lesson', status: 'active', supersedes: null, tags: [],
      summary: 'dangle full', access_count: 0, last_accessed: null,
    }) + '\n');
    const r = run(cwd, home, ['--full', '--scope', 'local', '--no-track']);
    assert.equal(r.code, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.json.status, 'ok');
    const row = r.json.episodes.find((e) => e.id === 'ep-dangle-full');
    assert.ok(row, 'dangling row still present in results');
    assert.equal(row.body, undefined, 'dangling row emitted WITHOUT body');
    assert.equal(r.json.warning, undefined, 'ENOENT (dangling row) stays silent — no warning field (F5)');
  });

  t('materializeChainWithFifoMemberSkipsWithWarning', () => {
    const { cwd, home } = mkStore();
    writeEpisode(cwd, { id: 'mat-root', summary: 'materialize root', body: 'root body text' });
    const midId = writeEpisode(cwd, { id: 'mat-mid', summary: 'materialize mid', body: 'to be fifo', supersedes: 'mat-root' });
    const midPath = path.join(storeDir(cwd), 'episodes', `${midId}.md`);
    fs.unlinkSync(midPath);
    const mk = spawnSync('mkfifo', [midPath]);
    assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`);
    const r = run(cwd, home, ['--read', 'mat-mid', '--materialize', '--scope', 'local']);
    fs.unlinkSync(midPath);
    assert.equal(r.code, 0, `exit 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.terminal_id, 'mat-mid');
    assert.equal(r.json.count, 2, 'both chain members present (skip, not drop)');
    const midMember = r.json.members.find((m) => m.id === 'mat-mid');
    assert.equal(midMember.body_len, 0, 'FIFO member contributes zero-length body');
    assert.ok(!r.json.body.includes('to be fifo'), 'skipped body text absent from the concatenated materialize body');
    assert.ok(
      typeof r.json.warning === 'string' && r.json.warning.includes('mat-mid') && r.json.warning.includes('ENOTREG'),
      `warning names the skipped member + code, got ${JSON.stringify(r.json.warning)}`
    );
  });
} else {
  console.log('  skip  FIFO legs (mkfifo unavailable on win32)');
}

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
