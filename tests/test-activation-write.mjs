/**
 * test-activation-write.mjs — RFC-009 P1b S2/S3/S7: R1 write flags + linkage + R9a (Group 2, §14).
 *
 * S2: REQ-1 (lesson-only flags), REQ-2 (round-trip), REQ-3/4/5 via the CLI, EC1/EC15.
 * S3: REQ-6 evidence linkage (merged-scope resolution, F1).
 * S7: REQ-18 R9a collision report (stderr-only, write always proceeds, self-exclusion).
 *
 * Every test asserts captured stdout JSON + on-disk contents — no assert(true).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
const EM_REVISE = path.join(REPO, 'scripts/em-revise.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// Fresh non-git dir → resolveLocalDir() lands at <dir>/.episodic-memory. A fake
// HOME isolates the GLOBAL store too (loadMergedIndex reads ~/.episodic-memory).
function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'actwrite-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { cwd: d, home };
}
function storeDir(cwd) { return path.join(cwd, '.episodic-memory'); }

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

function episodeFiles(cwd) {
  try { return fs.readdirSync(path.join(storeDir(cwd), 'episodes')).filter((f) => f.endsWith('.md')); }
  catch { return []; }
}
function readEpisode(cwd, id) {
  return fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${id}.md`), 'utf8');
}
function indexRows(cwd) {
  try {
    return fs.readFileSync(path.join(storeDir(cwd), 'index.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const LESSON = ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local'];

// --- S2: R1 write flags ---

t('testStoreActivationFieldsWritten', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON,
    '--trigger', 'second opinion', '--trigger', 'tool:Bash:git*', '--trigger', 'activity:plan',
    '--applies-to-project', '*', '--applies-to-tool', 'claude-code',
    '--priority', '3', '--review-by', '2027-01-01'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  const md = readEpisode(cwd, r.json.id);
  assert.match(md, /^triggers: \[second opinion, tool:Bash:git\*, activity:plan\]$/m, 'unquoted inline array');
  assert.match(md, /^applies_to_projects: \[\*\]$/m);
  assert.match(md, /^applies_to_tools: \[claude-code\]$/m);
  assert.match(md, /^priority: 3$/m);
  assert.match(md, /^review_by: 2027-01-01$/m);
  const row = indexRows(cwd).find((e) => e.id === r.json.id);
  assert.deepEqual(row.triggers, ['second opinion', 'tool:Bash:git*', 'activity:plan']);
  assert.deepEqual(row.applies_to_projects, ['*']);
  assert.deepEqual(row.applies_to_tools, ['claude-code']);
  assert.equal(row.priority, 3);
  assert.equal(row.review_by, '2027-01-01');
});

t('testActivationFlagsRejectedNonLesson', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, ['--project', 't', '--category', 'decision', '--trigger', 'x',
    '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(r.code, 1);
  assert.equal(r.json.status, 'error');
  assert.equal(r.json.errors[0].reason, 'activation-fields-lesson-only');
  assert.equal(r.json.errors[0].field, 'triggers', 'names the field');
  assert.equal(episodeFiles(cwd).length, 0, 'EC1: no partial write');
});

t('testFreeformLessonUnchanged', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON], { cwd, home });
  assert.equal(r.code, 0);
  const md = readEpisode(cwd, r.json.id);
  for (const key of ['triggers', 'applies_to_projects', 'applies_to_tools', 'priority', 'review_by', 'evidence']) {
    assert.ok(!new RegExp(`^${key}:`, 'm').test(md), `EC15: freeform lesson has no ${key} line`);
  }
  const row = indexRows(cwd).find((e) => e.id === r.json.id);
  for (const key of ['triggers', 'applies_to_projects', 'applies_to_tools', 'priority', 'review_by', 'evidence']) {
    assert.ok(!(key in row), `EC15: freeform index row has no ${key}`);
  }
  // non-lesson freeform still writes (the activation guard fires on activation INPUT only)
  const r2 = run(EM_STORE, ['--project', 't', '--category', 'decision', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(r2.code, 0, 'freeform non-lesson store unaffected');
});

t('testUnquotedRoundTrip', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON, '--trigger', 'plan review gate', '--applies-to-project', 'episodic-memory'], { cwd, home });
  assert.equal(r.code, 0);
  const storedRow = indexRows(cwd).find((e) => e.id === r.json.id);
  // rebuild from the .md and compare field values (REQ-9 parity, store-side leg)
  const rb = run(path.join(REPO, 'scripts/em-rebuild-index.mjs'), ['--scope', 'local'], { cwd, home });
  assert.equal(rb.code, 0);
  const rebuiltRow = indexRows(cwd).find((e) => e.id === r.json.id);
  assert.deepEqual(rebuiltRow.triggers, storedRow.triggers, 'triggers survive rebuild byte-equal');
  assert.deepEqual(rebuiltRow.applies_to_projects, storedRow.applies_to_projects);
  assert.equal(rebuiltRow.priority, storedRow.priority);
});

t('testStoreRejectsControlCharInjection', () => {
  // Reviewer F1: a raw newline in ANY serialized value fabricates adjacent
  // frontmatter keys (a forged superseded_by is chain/band forgery). The whole
  // control-char class rejects BEFORE any write, on every serialized surface.
  const { cwd, home } = mkStore();
  const victim = '20990101-000000-victim-lesson-0001';
  const r = run(EM_STORE, [...LESSON, '--trigger', `atk\nsuperseded_by: ${victim}\nx`], { cwd, home });
  assert.equal(r.code, 1, 'newline trigger rejected');
  assert.equal(r.json.errors[0].reason, 'illegal-char:\\x0a');
  assert.equal(episodeFiles(cwd).length, 0, 'no partial write');
  const r2 = run(EM_STORE, ['--project', 't', '--category', 'violation',
    '--violated-pattern', `x\ntriggers: [forged]\npriority: 9`,
    '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(r2.code, 1, 'newline in --violated-pattern rejected (passthrough scalar is the same class)');
  assert.match(r2.json.message, /illegal character/);
  assert.equal(episodeFiles(cwd).length, 0);
  const r3 = run(EM_STORE, [...LESSON, '--trigger', 'cr\rattack'], { cwd, home });
  assert.equal(r3.code, 1, 'CR rejected too');
  // rebuild proves no forged keys ever reached an index row
  run(path.join(REPO, 'scripts/em-rebuild-index.mjs'), ['--scope', 'local'], { cwd, home });
  assert.equal(indexRows(cwd).length, 0, 'nothing to rebuild — store byte-unchanged');
});

t('testStoreRejectsForgeAcrossAllSerializedScalars', () => {
  // Reviewer F1 round 2: the forge class spans EVERY serialized frontmatter
  // value, not just activation fields — a freeform lesson (no --evidence flag)
  // could inject `evidence: [<real-violation>]` via --summary/--project/--url/--tag
  // and earn the band, bypassing the linkage gate. Parameterize over the class.
  const victim = '20990101-000000-real-violation-0001';
  const payload = `x\nevidence: [${victim}]\nsuperseded_by: ${victim}`;
  const cases = [
    { label: '--summary', args: ['--project', 't', '--category', 'lesson', '--summary', payload, '--body', 'b', '--scope', 'local'] },
    { label: '--project', args: ['--project', payload, '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local'] },
    { label: '--url', args: [...LESSON, '--url', payload] },
    { label: '--tags', args: ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local', '--tags', payload] },
    { label: '--tag', args: ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local', '--tag', payload] },
  ];
  for (const c of cases) {
    const { cwd, home } = mkStore();
    const r = run(EM_STORE, c.args, { cwd, home });
    assert.equal(r.code, 1, `${c.label} newline payload rejected`);
    assert.match(r.json.message, /illegal/, `${c.label} names the illegal char`);
    assert.equal(episodeFiles(cwd).length, 0, `${c.label}: no partial write`);
    // even after a rebuild attempt, nothing forged reached an index row
    run(path.join(REPO, 'scripts/em-rebuild-index.mjs'), ['--scope', 'local'], { cwd, home });
    const rows = indexRows(cwd);
    assert.equal(rows.length, 0, `${c.label}: store byte-unchanged, no forged row`);
  }
});

t('testReviseRejectsForgeAcrossSerializedScalars', () => {
  // Reviewer round-3 NIT: cover the em-revise I4 surface too, so a future
  // refactor of the pre-supersede guard block cannot silently regress it.
  const victim = '20990101-000000-real-violation-0001';
  const payload = `x\nevidence: [${victim}]`;
  for (const label of ['--summary', '--project', '--tags', '--tag']) {
    const { cwd, home } = mkStore();
    const s = run(EM_STORE, [...LESSON], { cwd, home });
    assert.equal(s.code, 0);
    const base = ['--original', s.json.id, '--project', 't', '--summary', 'r', '--body', 'c', '--scope', 'local'];
    const args = label === '--summary' ? ['--original', s.json.id, '--project', 't', '--summary', payload, '--body', 'c', '--scope', 'local']
      : label === '--project' ? ['--original', s.json.id, '--project', payload, '--summary', 'r', '--body', 'c', '--scope', 'local']
        : [...base, label, payload];
    const r = run(EM_REVISE, args, { cwd, home });
    assert.equal(r.code, 1, `revise ${label} newline rejected`);
    assert.match(r.json.message, /illegal/);
    // I4: the original stays active, no revision written
    const md = readEpisode(cwd, s.json.id);
    assert.match(md, /^status: active$/m, `${label}: original untouched (pre-supersede guard)`);
    assert.equal(episodeFiles(cwd).length, 1, `${label}: no revision episode`);
  }
});

t('testStoreRejectsCommaTrigger', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON, '--trigger', 'a, b'], { cwd, home });
  assert.equal(r.code, 1);
  assert.equal(r.json.errors[0].reason, 'illegal-char:,');
  assert.equal(episodeFiles(cwd).length, 0, 'EC3: rejected write leaves store byte-unchanged');
});

t('testStoreRejectsPriority8ViaCli', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON, '--priority', '8'], { cwd, home });
  assert.equal(r.code, 1);
  assert.equal(r.json.errors[0].reason, 'earned-band');
  assert.match(r.json.message, /EARNED/, 'EC2: explains the earned band');
  assert.equal(episodeFiles(cwd).length, 0);
});

t('testStoreRejectsBadDateAndUnknownToolViaCli', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON, '--review-by', 'someday'], { cwd, home });
  assert.equal(r.code, 1);
  assert.equal(r.json.errors[0].reason, 'bad-date');
  const r2 = run(EM_STORE, [...LESSON, '--applies-to-tool', 'emacs'], { cwd, home });
  assert.equal(r2.code, 1);
  assert.equal(r2.json.errors[0].reason, 'unknown-tool');
  assert.equal(episodeFiles(cwd).length, 0);
});

t('testReviseActivationFields', () => {
  const { cwd, home } = mkStore();
  const s = run(EM_STORE, [...LESSON], { cwd, home });
  assert.equal(s.code, 0);
  const rev = run(EM_REVISE, ['--original', s.json.id, '--project', 't', '--summary', 'r', '--body', 'c',
    '--scope', 'local', '--trigger', 'activity:plan'], { cwd, home });
  assert.equal(rev.code, 0, rev.stdout);
  const md = readEpisode(cwd, rev.json.id);
  assert.match(md, /^triggers: \[activity:plan\]$/m);
  assert.match(md, /^priority: 5$/m, 'priority materialized to default 5');
  const row = indexRows(cwd).find((e) => e.id === rev.json.id);
  assert.deepEqual(row.triggers, ['activity:plan']);
  assert.equal(row.priority, 5);
  // revise-side rejection: priority 9 → no write, original chain intact
  const bad = run(EM_REVISE, ['--original', rev.json.id, '--project', 't', '--summary', 'r2', '--body', 'c',
    '--scope', 'local', '--priority', '9'], { cwd, home });
  assert.equal(bad.code, 1);
  assert.equal(bad.json.errors[0].reason, 'earned-band');
  const revMd = readEpisode(cwd, rev.json.id);
  assert.match(revMd, /^status: active$/m, 'rejected revise leaves the target active (no supersede mutation)');
});

t('testReviseInheritsActivation', () => {
  // Reviewer F3: a typo-revision must not demote a lesson to freeform — tags
  // inherit, so activation inherits too; a passed flag OVERRIDES per field.
  const { cwd, home } = mkStore();
  const s = run(EM_STORE, [...LESSON, '--trigger', 'keep me', '--applies-to-tool', 'codex',
    '--priority', '3', '--review-by', '2099-01-01'], { cwd, home });
  assert.equal(s.code, 0);
  const rev = run(EM_REVISE, ['--original', s.json.id, '--project', 't', '--summary', 'typo fix', '--body', 'c', '--scope', 'local'], { cwd, home });
  assert.equal(rev.code, 0, rev.stdout);
  const md = readEpisode(cwd, rev.json.id);
  assert.match(md, /^triggers: \[keep me\]$/m, 'triggers inherited');
  assert.match(md, /^applies_to_tools: \[codex\]$/m, 'scoping inherited');
  assert.match(md, /^priority: 3$/m, 'declared priority inherited');
  assert.match(md, /^review_by: 2099-01-01$/m, 'expiry inherited');
  // per-field override: new trigger replaces, priority stays inherited
  const rev2 = run(EM_REVISE, ['--original', rev.json.id, '--project', 't', '--summary', 'retarget', '--body', 'c',
    '--scope', 'local', '--trigger', 'new phrase'], { cwd, home });
  assert.equal(rev2.code, 0);
  const md2 = readEpisode(cwd, rev2.json.id);
  assert.match(md2, /^triggers: \[new phrase\]$/m, 'passed flag overrides the field');
  assert.ok(!/keep me/.test(md2), 'override replaces, not merges');
  assert.match(md2, /^priority: 3$/m, 'unpassed fields keep inheriting');
});

// --- S3: REQ-6 evidence linkage ---

function storeViolation(cwd, home, { scope = 'local' } = {}) {
  const r = run(path.join(REPO, 'scripts/em-violation.mjs'),
    ['--pattern', 'bp-001-implementation-workflow', '--summary', 'v', '--body', 'b', '--scope', scope], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}

t('testEvidenceValidViolation', () => {
  const { cwd, home } = mkStore();
  const vid = storeViolation(cwd, home);
  const r = run(EM_STORE, [...LESSON, '--evidence', vid], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  const md = readEpisode(cwd, r.json.id);
  assert.match(md, new RegExp(`^evidence: \\[${vid}\\]$`, 'm'));
  const row = indexRows(cwd).find((e) => e.id === r.json.id);
  assert.deepEqual(row.evidence, [vid]);
});

t('testEvidenceRejectsMissing', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON, '--evidence', 'no-such-violation'], { cwd, home });
  assert.equal(r.code, 1);
  assert.match(r.json.message, /no-such-violation/);
  assert.equal(episodeFiles(cwd).length, 0, 'no partial write');
});

t('testEvidenceRejectsNonViolation', () => {
  const { cwd, home } = mkStore();
  const other = run(EM_STORE, [...LESSON], { cwd, home });
  assert.equal(other.code, 0);
  const r = run(EM_STORE, [...LESSON, '--evidence', other.json.id], { cwd, home });
  assert.equal(r.code, 1, 'EC4: lesson id as --evidence is wrong-category');
  assert.match(r.json.message, /wrong-category/);
  assert.equal(episodeFiles(cwd).length, 1, 'only the first lesson exists');
});

t('testEvidenceCrossScopeResolves', () => {
  // F1: a LOCAL lesson may link a GLOBAL violation — resolution is MERGED, never per-active-scope.
  const { cwd, home } = mkStore();
  const globalVid = storeViolation(cwd, home, { scope: 'global' });
  assert.ok(fs.existsSync(path.join(home, '.episodic-memory', 'episodes', `${globalVid}.md`)), 'violation landed in the fake-HOME global store');
  const r = run(EM_STORE, [...LESSON, '--evidence', globalVid], { cwd, home });
  assert.equal(r.code, 0, `cross-scope evidence must resolve: ${r.stdout}`);
  const row = indexRows(cwd).find((e) => e.id === r.json.id);
  assert.deepEqual(row.evidence, [globalVid]);
});

// --- S7: REQ-18 R9a collision report ---

t('testFirstLessonNoSelfCollision', () => {
  // CX5: the post-write lazy rebuild contains the just-written episode; without
  // self-exclusion the FIRST trigger-bearing lesson would collide with itself.
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, [...LESSON, '--trigger', 'second opinion'], { cwd, home });
  assert.equal(r.code, 0);
  assert.ok(!/collision:/.test(r.stderr), `first trigger-bearing lesson emits NO collision: ${r.stderr}`);
});

t('testCollisionReportOnSharedTrigger', () => {
  const { cwd, home } = mkStore();
  const a = run(EM_STORE, [...LESSON, '--trigger', 'second opinion'], { cwd, home });
  assert.equal(a.code, 0);
  const b = run(EM_STORE, [...LESSON, '--trigger', 'second opinion'], { cwd, home });
  assert.equal(b.code, 0, 'the write ALWAYS proceeds');
  assert.match(b.stderr, /collision: trigger "second opinion" also on /, 'collision line on STDERR');
  assert.ok(b.stderr.includes(a.json.id), "names the EXISTING lesson's id");
  assert.ok(!b.stderr.includes(b.json.id), 'never names the just-written episode (self-exclusion)');
});

t('testCollisionStdoutUnchanged', () => {
  const { cwd, home } = mkStore();
  run(EM_STORE, [...LESSON, '--trigger', 'shared phrase'], { cwd, home });
  const b = run(EM_STORE, [...LESSON, '--trigger', 'shared phrase'], { cwd, home });
  assert.equal(b.code, 0);
  const parsed = JSON.parse(b.stdout.trim()); // stdout is EXACTLY the normal success JSON
  assert.equal(parsed.status, 'ok');
  assert.ok(parsed.id && parsed.file);
  assert.ok(!/collision/.test(b.stdout), 'report never leaks into stdout');
});

t('testNoCollisionNoReport', () => {
  const { cwd, home } = mkStore();
  run(EM_STORE, [...LESSON, '--trigger', 'phrase one'], { cwd, home });
  const b = run(EM_STORE, [...LESSON, '--trigger', 'phrase two'], { cwd, home });
  assert.equal(b.code, 0);
  assert.ok(!/collision:/.test(b.stderr), 'disjoint triggers -> no report');
});

t('testCollisionWriteProceeds', () => {
  // EC13: the collision READ fails (index.jsonl write-only -> the lazy build
  // cannot read it) -> NO report, write proceeds, exit unchanged, stdout normal.
  const { cwd, home } = mkStore();
  run(EM_STORE, [...LESSON, '--trigger', 'shared phrase'], { cwd, home });
  const idxPath = path.join(storeDir(cwd), 'index.jsonl');
  fs.chmodSync(idxPath, 0o200); // append still works; reads fail
  try {
    const b = run(EM_STORE, [...LESSON, '--trigger', 'shared phrase'], { cwd, home });
    assert.equal(b.code, 0, `write proceeds when the collision read fails: ${b.stdout}`);
    assert.equal(b.json.status, 'ok');
    assert.ok(!/collision:/.test(b.stderr), 'unreadable index -> no report, never fatal');
  } finally {
    fs.chmodSync(idxPath, 0o644);
  }
});

t('testReviseCollisionReport', () => {
  const { cwd, home } = mkStore();
  const a = run(EM_STORE, [...LESSON, '--trigger', 'revise phrase'], { cwd, home });
  const b = run(EM_STORE, [...LESSON], { cwd, home });
  const rev = run(EM_REVISE, ['--original', b.json.id, '--project', 't', '--summary', 'r', '--body', 'c',
    '--scope', 'local', '--trigger', 'revise phrase'], { cwd, home });
  assert.equal(rev.code, 0, 'revise write proceeds');
  assert.match(rev.stderr, /collision: trigger "revise phrase" also on /);
  assert.ok(rev.stderr.includes(a.json.id));
  assert.ok(!rev.stderr.includes(rev.json.id), 'self-excluded on the revise path too');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
