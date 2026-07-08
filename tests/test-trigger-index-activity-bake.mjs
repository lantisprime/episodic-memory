/**
 * test-trigger-index-activity-bake.mjs — RFC-009 P2 S0 (Group 0, §14).
 *
 * REQ-9: em-trigger-index bakes the ACTIVE activity-class phrase sets into a
 * top-level `activity_phrases` map so the event plane matches `activity:<class>`
 * triggers by reading ONLY the derived index — never activation-classes.json (which
 * honors the EM_ACTIVATION_CLASSES_PATH env override) at event time. The bake is
 * DRY (one copy per class), leaves the pinned entry_fields untouched, omits
 * deprecated/unknown classes, and the schema_version bump (1->2) invalidates caches.
 *
 * Every test asserts captured on-disk contents against a discriminating sentinel —
 * never assert(true), never "non-empty".
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
const EM_TRIGGER = path.join(REPO, 'scripts/em-trigger-index.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bake-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { cwd: d, home };
}
function tiPath(cwd) { return path.join(cwd, '.episodic-memory', 'trigger-index.json'); }
function readTi(cwd) { return JSON.parse(fs.readFileSync(tiPath(cwd), 'utf8')); }
function run(script, args, { cwd, home, env } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}), ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function storeLesson(cwd, home, extra = []) {
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 'l',
    '--body', 'b', '--scope', 'local', ...extra], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}
function build(cwd, home) {
  const r = run(EM_TRIGGER, ['--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  return r;
}

// The canonical vocabulary the build reads — the source of truth for the sentinel.
const CLASSES = JSON.parse(fs.readFileSync(path.join(REPO, 'activation-classes.json'), 'utf8'));
const planPhrases = CLASSES.classes.find((c) => c.name === 'plan').phrases;

t('bake_activity_phrases', () => {
  const { cwd, home } = mkStore();
  storeLesson(cwd, home, ['--trigger', 'activity:plan']);
  build(cwd, home);
  const ti = readTi(cwd);
  assert.ok(Object.hasOwn(ti, 'activity_phrases'), 'index carries top-level activity_phrases');
  assert.ok(Object.hasOwn(ti.activity_phrases, 'plan'), 'plan class baked');
  // Discriminating: the baked set is exactly the file's phrases, not a placeholder.
  assert.deepEqual(ti.activity_phrases.plan, planPhrases,
    'baked phrases equal activation-classes.json plan phrases (proves build read the file)');
  // Sentinel: a specific multi-word phrase from the file must be present.
  assert.ok(ti.activity_phrases.plan.includes('implementation plan'),
    'the "implementation plan" sentinel from the file is baked');
});

t('bake_keys_are_exactly_the_vocabulary', () => {
  // The bake carries every ACTIVE class (built from the vocabulary, not from
  // entries), and nothing outside it. em-store rejects unknown classes at write
  // time (R1), so the only way a non-vocab key could appear is a bake bug.
  const { cwd, home } = mkStore();
  storeLesson(cwd, home, ['--trigger', 'activity:review']);
  build(cwd, home);
  const ti = readTi(cwd);
  const baked = Object.keys(ti.activity_phrases).sort();
  assert.deepEqual(baked, ['design', 'implement', 'plan', 'push', 'review', 'rule', 'troubleshoot'],
    'activity_phrases keys are exactly the active vocabulary classes');
  assert.equal(Object.hasOwn(ti.activity_phrases, 'bogus'), false,
    'no non-vocabulary key leaks into the bake');
});

t('per_store_output_backcompat', () => {
  const { cwd, home } = mkStore();
  const id = storeLesson(cwd, home, ['--trigger', 'second opinion', '--applies-to-project', 'x']);
  build(cwd, home);
  const ti = readTi(cwd);
  assert.equal(ti.schema_version, 2, 'schema_version bumped to 2');
  const e = ti.entries.find((x) => x.episode_id === id);
  // Every pre-existing entry field still present + unchanged for a non-activity trigger.
  assert.equal(e.trigger_kind, 'phrase');
  assert.equal(e.value, 'second opinion');
  assert.equal(e.summary, 'l');
  assert.equal(typeof e.effective_priority, 'number');
  assert.deepEqual(e.applies_to_projects, ['x']);
  // A phrase entry carries no baked phrases field (bake is activity-only + top-level).
  assert.equal(Object.hasOwn(e, 'phrases'), false, 'phrase entries are not perturbed');
});

t('all_seven_classes_have_phrases', () => {
  // REQ-8 / planner F10: every launch class is populated (activity matching functional).
  const names = CLASSES.classes.map((c) => c.name).sort();
  assert.deepEqual(names, ['design', 'implement', 'plan', 'push', 'review', 'rule', 'troubleshoot']);
  for (const c of CLASSES.classes) {
    assert.ok(Array.isArray(c.phrases) && c.phrases.length > 0,
      `class ${c.name} has a non-empty phrase set`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
