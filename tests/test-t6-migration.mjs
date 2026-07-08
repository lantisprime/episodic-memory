/**
 * test-t6-migration.mjs — RFC-009 P1b S4: index carry + T6 read retarget + T2 grep (Group 4, §14).
 *
 * REQ-9 (rebuild carries all new fields), REQ-10 (dual-read at both read sites),
 * REQ-11 (T2 construction-site grep gate, non-vacuous).
 *
 * Every test asserts captured output / on-disk contents — no assert(true).
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
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');
const EM_RECALL = path.join(REPO, 'scripts/em-recall.mjs');
const EM_HEALTH = path.join(REPO, 'scripts/em-pattern-health.mjs');

const PATTERN = 'bp-001-implementation-workflow';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't6mig-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  // patterns/_index.json so the preflight/pattern-health pattern set resolves in the fixture
  const pdir = path.join(d, 'patterns');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, '_index.json'), JSON.stringify({
    patterns: [
      { pattern_id: PATTERN, name: 'impl workflow' },
      { pattern_id: 'bp-006-push-after-verify', name: 'push after verify' },
      { pattern_id: 'bp-010-habits-override-knowledge', name: 'habits' },
    ],
  }));
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
function readIndexBytes(cwd) {
  return fs.readFileSync(path.join(storeDir(cwd), 'index.jsonl'), 'utf8');
}
// Typed-only violation: em-store direct write with --violated-pattern and NO violated: tag.
function storeTypedOnlyViolation(cwd, home) {
  const r = run(EM_STORE, ['--project', 't', '--category', 'violation', '--violated-pattern', PATTERN,
    '--summary', 'typed-only', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}
// Legacy-tag-only violation: pre-migration shape (tag, no typed field).
function storeTagOnlyViolation(cwd, home) {
  const r = run(EM_STORE, ['--project', 't', '--category', 'violation', '--tags', `violated:${PATTERN}`,
    '--summary', 'tag-only', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}

// --- REQ-9: rebuild carry ---

t('testRebuildCarriesActivationFields', () => {
  const { cwd, home } = mkStore();
  // plant a lesson .md with ALL activation fields, bypass the writers (rebuild reads files)
  const epDir = path.join(storeDir(cwd), 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  const id = '20260708-000000-planted-lesson-0001';
  fs.writeFileSync(path.join(epDir, `${id}.md`), [
    '---', `id: ${id}`, 'date: 2026-07-08', 'time: "00:00"', 'project: t', 'category: lesson',
    'status: active', 'tags: []', 'summary: planted',
    'triggers: [second opinion, tool:Bash:git*, activity:plan]',
    'applies_to_projects: [*]',
    'applies_to_tools: [claude-code, codex]',
    'evidence: [20260101-000000-v-0001]',
    'priority: 4',
    'review_by: 2027-06-30',
    '---', '', '# planted', '', 'b', '',
  ].join('\n'));
  const vid = '20260708-000001-planted-violation-0001';
  fs.writeFileSync(path.join(epDir, `${vid}.md`), [
    '---', `id: ${vid}`, 'date: 2026-07-08', 'time: "00:00"', 'project: t', 'category: violation',
    'status: active', 'tags: []', 'summary: planted v',
    `lessons: [${id}]`,
    `violated_pattern: ${PATTERN}`,
    '---', '', '# planted v', '', 'b', '',
  ].join('\n'));
  const rb = run(EM_REBUILD, ['--scope', 'local'], { cwd, home });
  assert.equal(rb.code, 0, rb.stdout);
  const row = indexRows(cwd).find((e) => e.id === id);
  assert.deepEqual(row.triggers, ['second opinion', 'tool:Bash:git*', 'activity:plan']);
  assert.deepEqual(row.applies_to_projects, ['*']);
  assert.deepEqual(row.applies_to_tools, ['claude-code', 'codex']);
  assert.deepEqual(row.evidence, ['20260101-000000-v-0001']);
  assert.equal(row.priority, 4, 'priority carried as a NUMBER');
  assert.equal(row.review_by, '2027-06-30');
  const vrow = indexRows(cwd).find((e) => e.id === vid);
  assert.deepEqual(vrow.lessons, [id]);
  assert.equal(vrow.violated_pattern, PATTERN);
});

t('testRebuildRoundTripByteEqual', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b',
    '--scope', 'local', '--trigger', 'x phrase', '--priority', '2', '--review-by', '2027-01-01'], { cwd, home });
  assert.equal(r.code, 0);
  const rb1 = run(EM_REBUILD, ['--scope', 'local'], { cwd, home });
  assert.equal(rb1.code, 0);
  const bytes1 = readIndexBytes(cwd);
  const rb2 = run(EM_REBUILD, ['--scope', 'local'], { cwd, home });
  assert.equal(rb2.code, 0);
  assert.equal(readIndexBytes(cwd), bytes1, 'rebuild is idempotent byte-equal');
  // and the rebuilt row's activation values equal the store-time row's
  const row = indexRows(cwd).find((e) => e.id === r.json.id);
  assert.deepEqual(row.triggers, ['x phrase']);
  assert.equal(row.priority, 2);
  assert.equal(row.review_by, '2027-01-01');
});

t('testRebuildOmitsAbsentFields', () => {
  const { cwd, home } = mkStore();
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0);
  run(EM_REBUILD, ['--scope', 'local'], { cwd, home });
  const row = indexRows(cwd).find((e) => e.id === r.json.id);
  for (const key of ['triggers', 'applies_to_projects', 'applies_to_tools', 'evidence', 'lessons', 'priority', 'review_by', 'violated_pattern']) {
    assert.ok(!(key in row), `absent field ${key} never appears (no null spam)`);
  }
});

// --- REQ-10: dual-read at both read sites ---

t('testRecallPreflightReadsTypedField', () => {
  const { cwd, home } = mkStore();
  storeTypedOnlyViolation(cwd, home);
  const r = run(EM_RECALL, ['--task-type', 'implementation', '--scope', 'local', '--no-track'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  const w = (r.json.preflight_warnings || []).find((x) => x.type === 'violation' && x.pattern_id === PATTERN);
  assert.ok(w, `typed-only violation must warn: ${JSON.stringify(r.json.preflight_warnings)}`);
  assert.equal(w.violations_last_30d, 1);
});

t('testRecallPreflightDualReadLegacyTag', () => {
  const { cwd, home } = mkStore();
  storeTypedOnlyViolation(cwd, home);
  storeTagOnlyViolation(cwd, home);
  const r = run(EM_RECALL, ['--task-type', 'implementation', '--scope', 'local', '--no-track'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  const w = (r.json.preflight_warnings || []).find((x) => x.type === 'violation' && x.pattern_id === PATTERN);
  assert.ok(w, 'warning present');
  assert.equal(w.violations_last_30d, 2, 'EC12: typed-only AND tag-only both count, deduped per episode');
});

t('testPatternHealthCountsTypedField', () => {
  const { cwd, home } = mkStore();
  storeTypedOnlyViolation(cwd, home);
  const r = run(EM_HEALTH, ['--pattern', PATTERN, '--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  const rep = r.json.patterns.find((p) => p.pattern_id === PATTERN);
  assert.equal(rep.violations, 1, 'typed-only violation strikes');
});

t('testPatternHealthDualRead', () => {
  const { cwd, home } = mkStore();
  const typedId = storeTypedOnlyViolation(cwd, home);
  const tagId = storeTagOnlyViolation(cwd, home);
  assert.notEqual(typedId, tagId);
  const r = run(EM_HEALTH, ['--pattern', PATTERN, '--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  const rep = r.json.patterns.find((p) => p.pattern_id === PATTERN);
  assert.equal(rep.violations, 2, 'EC12: union of typed field and legacy tag, deduped by id');
  // dedupe leg: a DUAL-written violation (tag + typed, the em-violation shape) counts ONCE
  const dual = run(EM_STORE, ['--project', 't', '--category', 'violation', '--violated-pattern', PATTERN,
    '--tags', `violated:${PATTERN}`, '--summary', 'dual', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(dual.code, 0);
  const r2 = run(EM_HEALTH, ['--pattern', PATTERN, '--scope', 'local'], { cwd, home });
  const rep2 = r2.json.patterns.find((p) => p.pattern_id === PATTERN);
  assert.equal(rep2.violations, 3, 'dual-written violation counts once, not twice');
});

t('testViolatedPatternRoundTrip', () => {
  const { cwd, home } = mkStore();
  const id = storeTypedOnlyViolation(cwd, home);
  const before = indexRows(cwd).find((e) => e.id === id);
  run(EM_REBUILD, ['--scope', 'local'], { cwd, home });
  const after = indexRows(cwd).find((e) => e.id === id);
  assert.equal(after.violated_pattern, before.violated_pattern, 'typed field survives rebuild');
  const md = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${id}.md`), 'utf8');
  assert.match(md, new RegExp(`^violated_pattern: ${PATTERN}$`, 'm'));
});

// --- REQ-11: T2 conformance grep gate (construction site, non-vacuous) ---

const CONSTRUCTION_RE = /`violated:\$\{/;
const EXPECTED_SHIM_FILES = {
  'em-recall.mjs': 1,
  'em-pattern-health.mjs': 2, // the key is built TWICE (fromTags + linearScan), codex r2
  'em-violation.mjs': 1, // WRITE-side construction — allow-listed marked shim
  'em-trigger-index.mjs': 1, // session_start.preflight dual-read leg (reviewer F4)
};
const EXPECTED_SHIM_LINES = 5;

function grepConstructionLines(scriptsDir) {
  const out = [];
  for (const f of fs.readdirSync(scriptsDir).filter((x) => x.endsWith('.mjs'))) {
    const lines = fs.readFileSync(path.join(scriptsDir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (CONSTRUCTION_RE.test(line)) out.push({ file: f, lineNo: i + 1, line, context: lines.slice(Math.max(0, i - 3), i + 1).join('\n') });
    });
  }
  return out;
}

t('testT2NoTagValueBranching', () => {
  const matches = grepConstructionLines(path.join(REPO, 'scripts'));
  assert.equal(matches.length, EXPECTED_SHIM_LINES, `exactly ${EXPECTED_SHIM_LINES} marked construction lines expected, got ${matches.length}: ${matches.map((m) => `${m.file}:${m.lineNo}`).join(', ')}`);
  const byFile = {};
  for (const m of matches) byFile[m.file] = (byFile[m.file] || 0) + 1;
  assert.deepEqual(byFile, EXPECTED_SHIM_FILES, 'the allow-listed shim distribution across the four files');
  for (const m of matches) {
    assert.ok(/T6/.test(m.context), `T6 sunset marker on/adjacent to ${m.file}:${m.lineNo}`);
  }
  // NON-VACUITY: an unmarked planted construction branch in a scratch copy MUST fail the gate
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 't2gate-'));
  for (const f of fs.readdirSync(path.join(REPO, 'scripts')).filter((x) => x.endsWith('.mjs'))) {
    fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(scratch, f));
  }
  fs.appendFileSync(path.join(scratch, 'em-recall.mjs'),
    '\nfunction plantedUnmarkedBranch(patternId, tags) { return tags.includes(`violated:${patternId}`) }\n');
  const planted = grepConstructionLines(scratch);
  assert.equal(planted.length, EXPECTED_SHIM_LINES + 1, 'planted branch is discovered');
  const unmarked = planted.filter((m) => !/T6/.test(m.context));
  assert.equal(unmarked.length, 1, 'the planted line has no T6 marker → the gate would fail on it (non-vacuous)');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
