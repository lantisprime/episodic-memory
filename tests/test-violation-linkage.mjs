/**
 * test-violation-linkage.mjs — RFC-009 P1b S3: violation linkage + T6 write side (Group 3, §14).
 *
 * REQ-7 (--lesson symmetric validation), REQ-8 (typed violated_pattern + tag shim).
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
const EM_VIOLATION = path.join(REPO, 'scripts/em-violation.mjs');
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');

const PATTERN = 'bp-001-implementation-workflow';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'viollink-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { cwd: d, home };
}
function storeDir(cwd) { return path.join(cwd, '.episodic-memory'); }

function run(script, args, { cwd, home } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); }
  catch { try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {} }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function indexRows(cwd) {
  try {
    return fs.readFileSync(path.join(storeDir(cwd), 'index.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function episodeCount(cwd) {
  try { return fs.readdirSync(path.join(storeDir(cwd), 'episodes')).filter((f) => f.endsWith('.md')).length; }
  catch { return 0; }
}
function storeLesson(cwd, home) {
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 'l', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}

t('testViolationLessonValid', () => {
  const { cwd, home } = mkStore();
  const lessonId = storeLesson(cwd, home);
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--lesson', lessonId, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 0, v.stdout);
  const md = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${v.json.id}.md`), 'utf8');
  assert.match(md, new RegExp(`^lessons: \\[${lessonId}\\]$`, 'm'), 'lessons inline array in frontmatter');
  const row = indexRows(cwd).find((e) => e.id === v.json.id);
  assert.deepEqual(row.lessons, [lessonId], 'lessons in the store-time index row');
});

t('testViolationLessonRejectsMissing', () => {
  const { cwd, home } = mkStore();
  const before = episodeCount(cwd);
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--lesson', 'no-such-episode', '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 1);
  assert.match(v.json.message, /no-such-episode/);
  assert.equal(episodeCount(cwd), before, 'EC5: no violation written');
});

t('testViolationLessonRejectsNonLesson', () => {
  const { cwd, home } = mkStore();
  const d = run(EM_STORE, ['--project', 't', '--category', 'decision', '--summary', 'd', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(d.code, 0);
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--lesson', d.json.id, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 1);
  assert.match(v.json.message, /wrong-category/);
  assert.equal(episodeCount(cwd), 1, 'only the decision episode exists');
});

t('testViolationLessonRoundTrip', () => {
  const { cwd, home } = mkStore();
  const lessonId = storeLesson(cwd, home);
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--lesson', lessonId, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 0);
  const storedRow = indexRows(cwd).find((e) => e.id === v.json.id);
  const rb = run(EM_REBUILD, ['--scope', 'local'], { cwd, home });
  assert.equal(rb.code, 0);
  const rebuiltRow = indexRows(cwd).find((e) => e.id === v.json.id);
  assert.deepEqual(rebuiltRow.lessons, storedRow.lessons, 'lessons survive rebuild');
  assert.equal(rebuiltRow.violated_pattern, storedRow.violated_pattern, 'violated_pattern survives rebuild');
});

t('testViolationWritesViolatedPatternField', () => {
  const { cwd, home } = mkStore();
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 0, v.stdout);
  assert.equal(v.json.violated_pattern, PATTERN, 'stdout echo unchanged');
  const md = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${v.json.id}.md`), 'utf8');
  assert.match(md, new RegExp(`^violated_pattern: ${PATTERN}$`, 'm'), 'REQ-8: typed scalar in frontmatter');
  const row = indexRows(cwd).find((e) => e.id === v.json.id);
  assert.equal(row.violated_pattern, PATTERN, 'typed field indexed at store time');
});

t('testViolationKeepsTagShim', () => {
  const { cwd, home } = mkStore();
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 0);
  const row = indexRows(cwd).find((e) => e.id === v.json.id);
  assert.ok(row.tags.includes(`violated:${PATTERN}`), 'legacy tag kept as the T6 burn-in shim');
  assert.equal(row.violated_pattern, PATTERN, 'dual-write: shim AND typed field');
});

t('testReviseViolationKeepsTypedFieldAndLessons', () => {
  // Reviewer F3: revising a violation (e.g. a summary correction) must not
  // strip its typed violated_pattern or its --lesson forward-links.
  const { cwd, home } = mkStore();
  const lessonId = storeLesson(cwd, home);
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--lesson', lessonId, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 0);
  const EM_REVISE = path.join(REPO, 'scripts/em-revise.mjs');
  const rev = run(EM_REVISE, ['--original', v.json.id, '--project', 't', '--summary', 'typo fix', '--body', 'c', '--scope', 'local'], { cwd, home });
  assert.equal(rev.code, 0, rev.stdout);
  const md = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${rev.json.id}.md`), 'utf8');
  assert.match(md, new RegExp(`^violated_pattern: ${PATTERN}$`, 'm'), 'typed field inherited');
  assert.match(md, new RegExp(`^lessons: \\[${lessonId}\\]$`, 'm'), 'forward-links inherited');
  const row = indexRows(cwd).find((e) => e.id === rev.json.id);
  assert.equal(row.violated_pattern, PATTERN);
  assert.deepEqual(row.lessons, [lessonId]);
});

t('testStoreDirectLessonGuard', () => {
  // I2 forge control: --lesson through em-store directly is category-guarded +
  // linkage-validated the same as the em-violation surface.
  const { cwd, home } = mkStore();
  const lessonId = storeLesson(cwd, home);
  const bad = run(EM_STORE, ['--project', 't', '--category', 'decision', '--lesson', lessonId, '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(bad.code, 1);
  assert.match(bad.json.message, /violation/, 'lessons is violation-only');
  const bad2 = run(EM_STORE, ['--project', 't', '--category', 'violation', '--lesson', 'missing-id', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(bad2.code, 1);
  assert.match(bad2.json.message, /missing-id/);
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
