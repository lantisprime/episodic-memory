/**
 * test-trigger-session-start.mjs — RFC-009 P1b S6: session_start section (Group 6, §14).
 *
 * REQ-15: critical_entries (band, TRIGGER-INDEPENDENT), entries (explicit
 * static_score blend, deterministic under a fixed `now`), preflight (typed
 * violated_pattern counts), NO environment inputs (I6).
 */

import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTriggerIndex, buildSessionStart } from '../scripts/em-trigger-index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
const EM_VIOLATION = path.join(REPO, 'scripts/em-violation.mjs');

const PATTERN = 'bp-001-implementation-workflow';
const NOW = new Date('2026-07-08T00:00:00Z');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { cwd: d, home };
}
function run(script, args, { cwd, home } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, stdout: r.stdout, json };
}
function lessonRow(id, { date = '2026-07-08', priority = 5, last_accessed = null, triggers, summary = id } = {}) {
  return {
    id, date, time: '00:00', project: 't', category: 'lesson', status: 'active',
    supersedes: null, tags: [], summary,
    ...(triggers ? { triggers } : {}), priority, last_accessed,
  };
}

t('testSessionStartCriticalEntriesBand', () => {
  const { cwd, home } = mkStore();
  const s = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 'banded', '--body', 'b',
    '--scope', 'local', '--trigger', 'x phrase'], { cwd, home });
  assert.equal(s.code, 0);
  for (let i = 0; i < 2; i++) {
    const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--lesson', s.json.id, '--summary', `v${i}`, '--body', 'b', '--scope', 'local'], { cwd, home });
    assert.equal(v.code, 0);
  }
  const { index } = buildTriggerIndex({ project: cwd, scope: 'local', now: NOW });
  const crit = index.session_start.critical_entries.find((e) => e.episode_id === s.json.id);
  assert.ok(crit, 'band-9 lesson in critical_entries');
  assert.equal(crit.effective_priority, 9);
});

t('testSessionStartTriggerIndependent', () => {
  // EC14: a band lesson with NO triggers (R8 always-tier class) is in
  // critical_entries but NOT in trigger entries.
  const { cwd, home } = mkStore();
  const s = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 'no-trigger band', '--body', 'b',
    '--scope', 'local', '--priority', '6'], { cwd, home });
  assert.equal(s.code, 0);
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--lesson', s.json.id, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 0);
  const { index } = buildTriggerIndex({ project: cwd, scope: 'local', now: NOW });
  const crit = index.session_start.critical_entries.find((e) => e.episode_id === s.json.id);
  assert.ok(crit, 'trigger-less band lesson scanned from ALL active lessons');
  assert.equal(crit.effective_priority, 8);
  assert.equal(index.entries.filter((e) => e.episode_id === s.json.id).length, 0, 'absent from trigger entries');
});

t('testSessionStartStaticBlendOrder', () => {
  // Fixed fixture -> hand-derived exact scores (formula REQ-15):
  //   A: age 0 (recency 1.0), never accessed (1.0), priority 7 (1.0)      -> 1.000000
  //   C: age 0 (recency 1.0), never accessed (1.0), priority 1 (1/7)      -> 0.828571
  //   B: age 30 (recency 0.5), accessed 1d ago (1/365), priority 5 (5/7)  -> 0.393679
  const rows = [
    lessonRow('b-lesson', { date: '2026-06-08', priority: 5, last_accessed: '2026-07-07T00:00:00Z' }),
    lessonRow('a-lesson', { date: '2026-07-08', priority: 7 }),
    lessonRow('c-lesson', { date: '2026-07-08', priority: 1 }),
  ];
  const ss = buildSessionStart(rows, NOW);
  assert.deepEqual(ss.entries.map((e) => e.episode_id), ['a-lesson', 'c-lesson', 'b-lesson'], 'deterministic blend order');
  const byId = Object.fromEntries(ss.entries.map((e) => [e.episode_id, e.static_score]));
  assert.equal(byId['a-lesson'], 1, 'exact score A');
  assert.equal(byId['c-lesson'], 0.828571, 'exact score C');
  assert.equal(byId['b-lesson'], 0.393679, 'exact score B');
});

t('testSessionStartTopNAndTieBreak', () => {
  // ties break by recency then episode id; list capped at N=10
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(lessonRow(`tie-${String(i).padStart(2, '0')}`, { date: '2026-07-08', priority: 5 }));
  const ss = buildSessionStart(rows, NOW);
  assert.equal(ss.entries.length, 10, 'top-N cap (N=10)');
  assert.deepEqual(ss.entries.map((e) => e.episode_id), [
    'tie-00', 'tie-01', 'tie-02', 'tie-03', 'tie-04', 'tie-05', 'tie-06', 'tie-07', 'tie-08', 'tie-09',
  ], 'equal scores + equal recency -> episode-id order');
});

t('testSessionStartPreflightByViolatedPattern', () => {
  const { cwd, home } = mkStore();
  const v = run(EM_VIOLATION, ['--pattern', PATTERN, '--summary', 'v', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(v.code, 0);
  // legacy-tag-only row must NOT count here: preflight is keyed by the TYPED field (REQ-15/T6 dep)
  const tagOnly = run(EM_STORE, ['--project', 't', '--category', 'violation', '--tags', `violated:${PATTERN}`,
    '--summary', 'tag-only', '--body', 'b', '--scope', 'local'], { cwd, home });
  assert.equal(tagOnly.code, 0);
  const { index } = buildTriggerIndex({ project: cwd, scope: 'local', now: new Date() });
  const pf = index.session_start.preflight;
  assert.equal(pf.implementation[PATTERN], 1, 'typed violated_pattern rows counted per task type');
  assert.deepEqual(pf.push, {}, 'no bp-006 violations');
});

t('testSessionStartExcludesExpiredAndSuperseded', () => {
  const rows = [
    lessonRow('live-lesson'),
    { ...lessonRow('gone-lesson'), status: 'superseded' },
    lessonRow('expired-lesson', { }),
  ];
  rows[2].review_by = '2020-01-01';
  const ss = buildSessionStart(rows, NOW);
  assert.deepEqual(ss.entries.map((e) => e.episode_id), ['live-lesson'], 'expired/superseded never appear');
});

t('testSessionStartNoEnvInputs', () => {
  // I6: identical store content, one dir carrying git metadata + package.json,
  // the other bare -> byte-identical session_start under the same `now`.
  const mk = (withEnvNoise) => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'envfree-')));
    const ep = path.join(d, '.episodic-memory', 'episodes');
    fs.mkdirSync(ep, { recursive: true });
    fs.writeFileSync(path.join(ep, '20260708-000000-env-lesson-0001.md'), [
      '---', 'id: 20260708-000000-env-lesson-0001', 'date: 2026-07-08', 'time: "00:00"', 'project: t',
      'category: lesson', 'status: active', 'tags: []', 'summary: env', 'triggers: [env phrase]', 'priority: 5',
      '---', '', '# x', '', 'b', '',
    ].join('\n'));
    const rb = spawnSync('node', [path.join(REPO, 'scripts/em-rebuild-index.mjs'), '--scope', 'local'], { cwd: d, encoding: 'utf8' });
    assert.equal(rb.status, 0);
    if (withEnvNoise) {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'noise-project' }));
    }
    return d;
  };
  const bare = mk(false);
  const noisy = mk(true);
  const a = buildTriggerIndex({ project: bare, scope: 'local', now: NOW }).index.session_start;
  const b = buildTriggerIndex({ project: noisy, scope: 'local', now: NOW }).index.session_start;
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'session_start is a pure function of index rows + now');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
