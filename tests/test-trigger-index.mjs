/**
 * test-trigger-index.mjs — RFC-009 P1b S5: trigger index core (Group 5, §14).
 *
 * REQ-12 (build, three kinds, exclusions), REQ-13 (earned band, chain-resolved,
 * dedup, retracted), REQ-14 (fingerprint cache, TOCTOU, same-size rewrite,
 * concurrent builds), REQ-16 (merge local precedence, target binding, degrade).
 *
 * Every test asserts captured output / on-disk contents — no assert(true).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
const EM_REVISE = path.join(REPO, 'scripts/em-revise.mjs');
const EM_VIOLATION = path.join(REPO, 'scripts/em-violation.mjs');
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');
const EM_TRIGGER = path.join(REPO, 'scripts/em-trigger-index.mjs');

const PATTERN = 'bp-001-implementation-workflow';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trigidx-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { cwd: d, home };
}
function storeDir(cwd) { return path.join(cwd, '.episodic-memory'); }
function tiPath(cwd) { return path.join(storeDir(cwd), 'trigger-index.json'); }
function readTi(cwd) { return JSON.parse(fs.readFileSync(tiPath(cwd), 'utf8')); }

function run(script, args, { cwd, home, env } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}), ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); }
  catch { try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {} }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function storeLesson(cwd, home, extra = []) {
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', extra.includes('--summary') ? undefined : 'l',
    '--body', 'b', '--scope', 'local', ...extra].filter((x) => x !== undefined), { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}
function storeViolation(cwd, home, extra = []) {
  const r = run(EM_VIOLATION, ['--pattern', PATTERN, '--summary', 'v', '--body', 'b', '--scope', 'local', ...extra], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}
function build(cwd, home, extra = []) {
  const r = run(EM_TRIGGER, ['--scope', 'local', ...extra], { cwd, home });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  return r;
}
function entryFor(cwd, episodeId) {
  return readTi(cwd).entries.filter((e) => e.episode_id === episodeId);
}

// --- REQ-12: build + kinds + exclusions ---

t('testTriggerIndexBuilds', () => {
  const { cwd, home } = mkStore();
  const id = storeLesson(cwd, home, ['--trigger', 'second opinion']);
  const r = build(cwd, home);
  assert.equal(r.json.built[0].entries, 1);
  const ti = readTi(cwd);
  assert.equal(ti.schema_version, 4); // RFC-012 R3a bumped 3->4 (cadence); was 3 at RFC-011 R2.6 (playbooks)
  assert.ok(ti.source.index_sha256.match(/^[0-9a-f]{64}$/), 'sha256 fingerprint present');
  assert.equal(ti.entries[0].episode_id, id);
  assert.equal(ti.entries[0].value, 'second opinion');
  assert.equal(ti.entries[0].effective_priority, 5, 'field is effective_priority, derived');
  assert.ok(!('priority' in ti.entries[0]), 'entry never carries the stored `priority` name');
});

t('testTriggerIndexThreeKinds', () => {
  const { cwd, home } = mkStore();
  const id = storeLesson(cwd, home, ['--trigger', 'a phrase', '--trigger', 'tool:Bash:git*', '--trigger', 'activity:plan']);
  build(cwd, home);
  const kinds = entryFor(cwd, id).map((e) => e.trigger_kind).sort();
  assert.deepEqual(kinds, ['activity', 'phrase', 'tool'], 'all three kinds discriminated EXPLICITLY');
  const byKind = Object.fromEntries(entryFor(cwd, id).map((e) => [e.trigger_kind, e.value]));
  assert.equal(byKind.phrase, 'a phrase');
  assert.equal(byKind.tool, 'tool:Bash:git*');
  assert.equal(byKind.activity, 'activity:plan');
});

t('testTriggerIndexExcludesExpired', () => {
  const { cwd, home } = mkStore();
  const past = storeLesson(cwd, home, ['--trigger', 'stale phrase', '--review-by', '2020-01-01']);
  const live = storeLesson(cwd, home, ['--trigger', 'live phrase', '--review-by', '2099-01-01']);
  build(cwd, home);
  assert.equal(entryFor(cwd, past).length, 0, 'expired (review_by past) excluded');
  assert.equal(entryFor(cwd, live).length, 1);
});

t('testTriggerIndexExcludesSuperseded', () => {
  const { cwd, home } = mkStore();
  const orig = storeLesson(cwd, home, ['--trigger', 'old phrase']);
  const rev = run(EM_REVISE, ['--original', orig, '--project', 't', '--summary', 'r', '--body', 'c',
    '--scope', 'local', '--trigger', 'new phrase'], { cwd, home });
  assert.equal(rev.code, 0);
  build(cwd, home);
  assert.equal(entryFor(cwd, orig).length, 0, 'superseded lesson excluded');
  assert.equal(entryFor(cwd, rev.json.id).length, 1);
});

// --- REQ-13: earned band ---

t('testBandZeroLinks', () => {
  const { cwd, home } = mkStore();
  const id = storeLesson(cwd, home, ['--trigger', 'x phrase', '--priority', '3']);
  build(cwd, home);
  assert.equal(entryFor(cwd, id)[0].effective_priority, 3, 'zero links -> stored priority');
});

t('testBandOneLink8', () => {
  const { cwd, home } = mkStore();
  const id = storeLesson(cwd, home, ['--trigger', 'x phrase']);
  storeViolation(cwd, home, ['--lesson', id]);
  build(cwd, home);
  assert.equal(entryFor(cwd, id)[0].effective_priority, 8, 'one linked violation -> 8');
  // stored bytes untouched (I3)
  const md = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${id}.md`), 'utf8');
  assert.ok(!/^priority: 8$/m.test(md), 'stored frontmatter never mutated to the band');
});

t('testBandTwoLinks9', () => {
  const { cwd, home } = mkStore();
  const id = storeLesson(cwd, home, ['--trigger', 'x phrase']);
  storeViolation(cwd, home, ['--lesson', id]);
  storeViolation(cwd, home, ['--lesson', id]);
  build(cwd, home);
  assert.equal(entryFor(cwd, id)[0].effective_priority, 9, 'two linked violations -> 9');
});

t('testBandForwardBackDedup', () => {
  const { cwd, home } = mkStore();
  const l1 = storeLesson(cwd, home, ['--trigger', 'x phrase']);
  const vid = storeViolation(cwd, home, ['--lesson', l1]);
  // revise the lesson adding the BACK-link to the SAME violation (EC6)
  const rev = run(EM_REVISE, ['--original', l1, '--project', 't', '--summary', 'r', '--body', 'c',
    '--scope', 'local', '--trigger', 'x phrase', '--evidence', vid], { cwd, home });
  assert.equal(rev.code, 0, rev.stdout);
  build(cwd, home);
  assert.equal(entryFor(cwd, rev.json.id)[0].effective_priority, 8, 'forward + back link to ONE violation counts once');
});

t('testBandChainResolvedLesson', () => {
  const { cwd, home } = mkStore();
  const l1 = storeLesson(cwd, home, ['--trigger', 'x phrase']);
  const vid = storeViolation(cwd, home, ['--lesson', l1]);
  assert.ok(vid);
  const rev = run(EM_REVISE, ['--original', l1, '--project', 't', '--summary', 'r2', '--body', 'c',
    '--scope', 'local', '--trigger', 'x phrase'], { cwd, home });
  assert.equal(rev.code, 0);
  build(cwd, home);
  assert.equal(entryFor(cwd, rev.json.id)[0].effective_priority, 8,
    'violation linked to the SUPERSEDED lesson follows the chain to the active terminal');
});

t('testBandChainResolvedViolation', () => {
  const { cwd, home } = mkStore();
  const v1 = storeViolation(cwd, home);
  const rev = run(EM_REVISE, ['--original', v1, '--project', 't', '--summary', 'v2', '--body', 'c', '--scope', 'local'], { cwd, home });
  assert.equal(rev.code, 0);
  const id = storeLesson(cwd, home, ['--trigger', 'x phrase', '--evidence', v1]);
  build(cwd, home);
  assert.equal(entryFor(cwd, id)[0].effective_priority, 8,
    'evidence naming the superseded violation resolves to its active terminal (counts once)');
});

t('testBandCrossStoreMergedView', () => {
  // Reviewer F2: a LOCAL lesson linking a GLOBAL violation (legitimate, REQ-6/F1)
  // earns the band in the MERGED consumer view. The per-store artifact keeps a
  // per-store band by design (a cached global index must not depend on the
  // caller's local store); consumers read loadMergedTriggerIndex.
  const { cwd, home } = mkStore();
  const gv = run(EM_VIOLATION, ['--pattern', PATTERN, '--summary', 'gv', '--body', 'b', '--scope', 'global'], { cwd, home });
  assert.equal(gv.code, 0);
  const id = storeLesson(cwd, home, ['--trigger', 'x phrase', '--evidence', gv.json.id]);
  const merged = run(EM_TRIGGER, ['--merged'], { cwd, home });
  assert.equal(merged.code, 0, merged.stdout);
  const entry = merged.json.entries.find((e) => e.episode_id === id);
  assert.equal(entry.effective_priority, 8, 'cross-store link earns the band in the merged view');
  const crit = merged.json.session_start.critical_entries.find((e) => e.episode_id === id);
  assert.ok(crit, 'merged session_start critical band sees the cross-store link');
  assert.equal(crit.effective_priority, 8);
});

t('testBandRetractedStops', () => {
  const { cwd, home } = mkStore();
  const v1 = storeViolation(cwd, home);
  const id = storeLesson(cwd, home, ['--trigger', 'x phrase', '--evidence', v1]);
  build(cwd, home);
  assert.equal(entryFor(cwd, id)[0].effective_priority, 8, 'pre-retraction: band 8');
  // retract: hand-plant a NON-violation revision superseding v1 (EC7 — the chain
  // terminates on a non-violation category), then rebuild the store index.
  const epDir = path.join(storeDir(cwd), 'episodes');
  const rid = '20990101-000000-retraction-0001';
  fs.writeFileSync(path.join(epDir, `${rid}.md`), [
    '---', `id: ${rid}`, 'date: 2026-07-08', 'time: "00:00"', 'project: t', 'category: temporary',
    'status: active', `supersedes: ${v1}`, 'tags: []', 'summary: retracted', '---', '', '# retracted', '', 'b', '',
  ].join('\n'));
  const v1md = path.join(epDir, `${v1}.md`);
  fs.writeFileSync(v1md, fs.readFileSync(v1md, 'utf8').replace(/^status: active$/m, 'status: superseded'));
  assert.equal(run(EM_REBUILD, ['--scope', 'local'], { cwd, home }).code, 0);
  build(cwd, home);
  assert.equal(entryFor(cwd, id)[0].effective_priority, 5, 'retracted violation stops counting; band drops at next build');
  const md = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${id}.md`), 'utf8');
  assert.match(md, new RegExp(`^evidence: \\[${v1}\\]$`, 'm'), 'stored bytes unchanged (I3)');
});

// --- REQ-14: fingerprint + cache ---

t('testCacheHitUnchanged', () => {
  const { cwd, home } = mkStore();
  storeLesson(cwd, home, ['--trigger', 'x phrase']);
  // the R9a collision read already lazy-built the index at store time (S7);
  // clear it so this test controls the first build itself
  fs.rmSync(tiPath(cwd), { force: true });
  const r1 = build(cwd, home);
  assert.equal(r1.json.built[0].cache_hit, false);
  const mtime1 = fs.statSync(tiPath(cwd)).mtimeMs;
  const r2 = build(cwd, home);
  assert.equal(r2.json.built[0].cache_hit, true, 'second build on an unchanged store is a cache hit');
  assert.equal(fs.statSync(tiPath(cwd)).mtimeMs, mtime1, 'no rewrite on cache hit');
});

t('testCacheInvalidatedByStore', () => {
  const { cwd, home } = mkStore();
  storeLesson(cwd, home, ['--trigger', 'x phrase']);
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  // plant the second lesson WITHOUT the writers (no R9a lazy rebuild), so the
  // explicit build below is what observes the fingerprint invalidation
  const id2 = '20260708-000000-planted-second-0001';
  fs.writeFileSync(path.join(storeDir(cwd), 'episodes', `${id2}.md`), [
    '---', `id: ${id2}`, 'date: 2026-07-08', 'time: "00:00"', 'project: t', 'category: lesson',
    'status: active', 'tags: []', 'summary: second', 'triggers: [y phrase]', 'priority: 5',
    '---', '', '# x', '', 'b', '',
  ].join('\n'));
  assert.equal(run(EM_REBUILD, ['--scope', 'local'], { cwd, home }).code, 0);
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'mid-session store invalidates the cache (sha/mtime/size moved)');
  assert.equal(entryFor(cwd, id2).length, 1, 'the new lesson is in the rebuilt index');
});

t('testFingerprintCatchesSameSizeRewrite', () => {
  const { cwd, home } = mkStore();
  storeLesson(cwd, home, ['--trigger', 'aaa phrase']);
  build(cwd, home);
  const idxPath = path.join(storeDir(cwd), 'index.jsonl');
  const st = fs.statSync(idxPath);
  const raw = fs.readFileSync(idxPath, 'utf8');
  const rewritten = raw.replace('aaa phrase', 'bbb phrase');
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(raw), 'SAME byte length');
  fs.writeFileSync(idxPath, rewritten);
  fs.utimesSync(idxPath, st.atime, st.mtime); // SAME mtime — only the bytes differ (EC8)
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'sha256 leg catches the same-size-same-mtime rewrite');
  const values = readTi(cwd).entries.map((e) => e.value);
  assert.deepEqual(values, ['bbb phrase'], 'rebuilt from the NEW bytes');
});

await ta('testFingerprintTOCTOUReReadOnStatMismatch', async () => {
  // EC9 in-process: patch fs.readFileSync so the FIRST read of index.jsonl
  // returns STALE bytes while the file on disk has already moved on (a
  // concurrent writer landing between stat and read). The builder must detect
  // the stat mismatch, re-read once, and fingerprint the bytes it actually used.
  const { cwd, home } = mkStore();
  void home;
  const epDir = path.join(storeDir(cwd), 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  const idxPath = path.join(storeDir(cwd), 'index.jsonl');
  const rowOld = JSON.stringify({ id: 'l-old', date: '2026-07-08', time: '00:00', project: 't', category: 'lesson', status: 'active', supersedes: null, tags: [], summary: 'old', triggers: ['old phrase'], priority: 5 }) + '\n';
  const rowNew = JSON.stringify({ id: 'l-new', date: '2026-07-08', time: '00:00', project: 't', category: 'lesson', status: 'active', supersedes: null, tags: [], summary: 'new', triggers: ['new phrase'], priority: 5 }) + '\n';
  fs.writeFileSync(idxPath, rowOld);
  const mod = await import('../scripts/em-trigger-index.mjs');
  const realRead = fs.readFileSync;
  let firstIndexRead = true;
  fs.readFileSync = function (p, ...rest) {
    if (String(p) === idxPath && firstIndexRead) {
      firstIndexRead = false;
      const stale = realRead.call(fs, p, ...rest); // the bytes as of the first stat
      // concurrent writer lands AFTER our read: file changes size + mtime
      fs.writeFileSync(idxPath, rowNew);
      return stale;
    }
    return realRead.call(fs, p, ...rest);
  };
  try {
    const { index } = mod.buildTriggerIndex({ project: cwd, scope: 'local', now: new Date('2026-07-08T12:00:00Z') });
    const expectedSha = crypto.createHash('sha256').update(rowNew).digest('hex');
    assert.equal(index.source.index_sha256, expectedSha, 'fingerprint is of the RE-READ bytes');
    assert.deepEqual(index.entries.map((e) => e.value), ['new phrase'], 'entries built from the re-read bytes');
  } finally {
    fs.readFileSync = realRead;
  }
});

await ta('testConcurrentBuildsNoTornTemp', async () => {
  const { cwd, home } = mkStore();
  for (let i = 0; i < 8; i++) storeLesson(cwd, home, ['--trigger', `phrase number ${i}`]);
  fs.rmSync(tiPath(cwd), { force: true });
  const runs = [0, 1].map(() => new Promise((resolve) => {
    const c = spawn('node', [EM_TRIGGER, '--scope', 'local'], {
      cwd, env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  }));
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.code, 0, `both concurrent builds exit 0: ${r.out}`);
  const ti = readTi(cwd); // parses -> not torn
  assert.equal(ti.entries.length, 8);
  const leftovers = fs.readdirSync(storeDir(cwd)).filter((f) => f.startsWith('trigger-index.json.tmp.'));
  assert.deepEqual(leftovers, [], 'no torn/leftover temp files');
});

// --- REQ-16: merge + binding + degrade ---

t('testMergeLocalPrecedence', () => {
  const { cwd, home } = mkStore();
  // SAME episode id planted in both stores with different summaries
  const id = '20260708-000000-shared-lesson-0001';
  for (const [dir, summary] of [[storeDir(cwd), 'LOCAL wins'], [path.join(home, '.episodic-memory'), 'GLOBAL loses']]) {
    const ep = path.join(dir, 'episodes');
    fs.mkdirSync(ep, { recursive: true });
    fs.writeFileSync(path.join(ep, `${id}.md`), [
      '---', `id: ${id}`, 'date: 2026-07-08', 'time: "00:00"', 'project: t', 'category: lesson',
      'status: active', 'tags: []', `summary: ${summary}`, 'triggers: [shared phrase]', 'priority: 5',
      '---', '', '# x', '', 'b', '',
    ].join('\n'));
  }
  assert.equal(run(EM_REBUILD, ['--scope', 'all'], { cwd, home }).code, 0);
  const r = run(EM_TRIGGER, ['--merged'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  const mine = r.json.entries.filter((e) => e.episode_id === id);
  assert.equal(mine.length, 1, 'deduped by episode id');
  assert.equal(mine[0].summary, 'LOCAL wins', 'LOCAL precedence');
});

t('testTargetStoreBindingWorktree', () => {
  // F6/EC16: caller cwd is a LINKED WORKTREE of an unrelated repo; --project
  // <target-root> must write under the TARGET's store, not the worktree's main root.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtbind-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const repoA = path.join(base, 'repoA');
  fs.mkdirSync(repoA);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoA });
  execFileSync('git', ['config', 'user.email', 'juan.delacruz@acme.com'], { cwd: repoA });
  execFileSync('git', ['config', 'user.name', 'jd'], { cwd: repoA });
  fs.writeFileSync(path.join(repoA, 'f.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: repoA });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: repoA });
  const wt = path.join(base, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: repoA });
  // target project (non-git) with one trigger-bearing lesson
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  const tEp = path.join(target, '.episodic-memory', 'episodes');
  fs.mkdirSync(tEp, { recursive: true });
  fs.writeFileSync(path.join(tEp, '20260708-000000-target-lesson-0001.md'), [
    '---', 'id: 20260708-000000-target-lesson-0001', 'date: 2026-07-08', 'time: "00:00"', 'project: tgt',
    'category: lesson', 'status: active', 'tags: []', 'summary: tgt', 'triggers: [target phrase]', 'priority: 5',
    '---', '', '# x', '', 'b', '',
  ].join('\n'));
  const rb = spawnSync('node', [EM_REBUILD, '--scope', 'local'], { cwd: target, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(rb.status, 0);
  const r = spawnSync('node', [EM_TRIGGER, '--scope', 'local', '--project', target], {
    cwd: wt, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(fs.existsSync(path.join(target, '.episodic-memory', 'trigger-index.json')),
    'trigger-index.json lands under the TARGET store (asserted by on-disk location)');
  assert.ok(!fs.existsSync(path.join(repoA, '.episodic-memory', 'trigger-index.json')),
    'nothing written under the worktree MAIN root');
  const ti = JSON.parse(fs.readFileSync(path.join(target, '.episodic-memory', 'trigger-index.json'), 'utf8'));
  assert.equal(ti.entries[0].value, 'target phrase');
});

t('testMalformedIndexRebuildsOnce', () => {
  const { cwd, home } = mkStore();
  storeLesson(cwd, home, ['--trigger', 'x phrase']);
  build(cwd, home);
  fs.writeFileSync(tiPath(cwd), '{ not json ///');
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'malformed cache is a miss');
  const ti = readTi(cwd);
  assert.equal(ti.entries.length, 1, 'rebuilt to a valid index');
});

t('testMalformedIndexDegrades', () => {
  // EC10: local store's index.jsonl unreadable -> merged view proceeds with
  // global + ONE stderr note, exit 0, never throws.
  const { cwd, home } = mkStore();
  const gEp = path.join(home, '.episodic-memory', 'episodes');
  fs.mkdirSync(gEp, { recursive: true });
  fs.writeFileSync(path.join(gEp, '20260708-000000-global-lesson-0001.md'), [
    '---', 'id: 20260708-000000-global-lesson-0001', 'date: 2026-07-08', 'time: "00:00"', 'project: g',
    'category: lesson', 'status: active', 'tags: []', 'summary: g', 'triggers: [global phrase]', 'priority: 5',
    '---', '', '# x', '', 'b', '',
  ].join('\n'));
  assert.equal(run(EM_REBUILD, ['--scope', 'global'], { cwd, home }).code, 0);
  // make the LOCAL index unreadable
  const idxPath = path.join(storeDir(cwd), 'index.jsonl');
  fs.mkdirSync(storeDir(cwd), { recursive: true });
  fs.writeFileSync(idxPath, 'x');
  fs.chmodSync(idxPath, 0o000);
  try {
    const r = run(EM_TRIGGER, ['--merged'], { cwd, home });
    assert.equal(r.code, 0, 'merged read never blocks');
    assert.match(r.stderr, /local build failed/, 'one stderr note');
    assert.deepEqual(r.json.entries.map((e) => e.value), ['global phrase'], 'global entries still served');
  } finally {
    fs.chmodSync(idxPath, 0o644);
  }
});

t('testTriggerBuildExcludesUnknownClass', () => {
  const { cwd, home } = mkStore();
  // unknown class enters via hand-authoring / vocab drift (the writers reject it)
  const epDir = path.join(storeDir(cwd), 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  fs.writeFileSync(path.join(epDir, '20260708-000000-drift-lesson-0001.md'), [
    '---', 'id: 20260708-000000-drift-lesson-0001', 'date: 2026-07-08', 'time: "00:00"', 'project: t',
    'category: lesson', 'status: active', 'tags: []', 'summary: drift',
    'triggers: [activity:bogus, ok phrase]', 'priority: 5',
    '---', '', '# x', '', 'b', '',
  ].join('\n'));
  assert.equal(run(EM_REBUILD, ['--scope', 'local'], { cwd, home }).code, 0);
  build(cwd, home);
  const ti = readTi(cwd);
  assert.deepEqual(ti.entries.map((e) => e.value), ['ok phrase'], 'EC11: unknown class excluded, sibling trigger kept');
  assert.equal(ti.build_report.excluded_activity_classes.bogus, 1, 'counted in the build report (the drift surface)');
});

t('testBuildDegradesOnUnloadableVocab', () => {
  const { cwd, home } = mkStore();
  storeLesson(cwd, home, ['--trigger', 'activity:plan', '--trigger', 'still here phrase']);
  // clear the R9a-built cache (built with a LOADABLE vocab at store time) so
  // the degraded build below actually rebuilds
  fs.rmSync(tiPath(cwd), { force: true });
  const r = run(EM_TRIGGER, ['--scope', 'local'], { cwd, home, env: { EM_ACTIVATION_CLASSES_PATH: '/nonexistent/x.json' } });
  assert.equal(r.code, 0, 'F4: unreadable vocab at BUILD degrades, never throws');
  const ti = readTi(cwd);
  assert.deepEqual(ti.entries.map((e) => e.value), ['still here phrase']);
  assert.equal(ti.build_report.excluded_activity_classes.plan, 1, 'every activity trigger excluded+counted');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
