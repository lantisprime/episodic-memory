#!/usr/bin/env node
/**
 * test-trigger-index-schema.mjs — #487
 *
 * The DERIVED trigger index (per-store trigger-index.json, emitted by
 * em-trigger-index.mjs) now has a discovered JSON Schema
 * (schemas/trigger-index.schema.json). This proves the schema matches the REAL
 * emitted v2 file — seeded with representative data so entries[] is non-empty
 * (codex-B2: a schema that only ever sees an empty entries[] never exercises
 * the entry subschema, and a `const:1` draft would reject the live v2 file).
 *
 * Zero deps — Node stdlib only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
const EM_TRIGGER = path.join(REPO, 'scripts/em-trigger-index.mjs');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/trigger-index.schema.json'), 'utf8'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trigidx-schema-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { cwd: d, home };
}
function run(script, args, { cwd, home } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch { /* non-json */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function storeLesson(cwd, home, extra) {
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 'l',
    '--body', 'b', '--scope', 'local', ...extra], { cwd, home });
  assert.equal(r.code, 0, r.stdout);
  return r.json.id;
}
function seededIndex() {
  const { cwd, home } = mkStore();
  // Two lessons: one with all three trigger kinds + a review_by (exercises the
  // optional review_by field), one without (exercises its absence).
  storeLesson(cwd, home, ['--trigger', 'a phrase', '--trigger', 'tool:Bash:git*',
    '--trigger', 'activity:plan', '--applies-to-tool', 'claude-code', '--review-by', '2099-01-01']);
  storeLesson(cwd, home, ['--trigger', 'another phrase', '--priority', '3']);
  const r = run(EM_TRIGGER, ['--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(cwd, '.episodic-memory', 'trigger-index.json'), 'utf8'));
}

// --- The real seeded v2 index validates, with entries exercised ---

t('schema validates a REAL seeded v3 trigger-index with non-empty entries', () => {
  const idx = seededIndex();
  assert.equal(idx.schema_version, 3, 'live producer emits v3 (RFC-011 R2.6)');
  assert.ok(idx.entries.length > 0, `entries[] must be non-empty to exercise the entry subschema, got ${idx.entries.length}`);
  const res = validateInstance(idx, SCHEMA);
  assert.ok(res.valid, `real seeded index rejected: ${JSON.stringify(res.errors).slice(0, 400)}`);
  // All three trigger kinds are present and validated.
  const kinds = new Set(idx.entries.map((e) => e.trigger_kind));
  assert.ok(kinds.has('phrase') && kinds.has('tool') && kinds.has('activity'),
    `expected all three kinds, got ${[...kinds].join(',')}`);
  // Top-level sections the contract mirror does NOT pin are still schema-covered.
  assert.ok(Object.keys(idx.activity_phrases).length > 0, 'activity_phrases baked + covered');
  assert.ok(idx.build_report && typeof idx.build_report.excluded_activity_classes === 'object', 'build_report covered');
  assert.ok(idx.session_start && Array.isArray(idx.session_start.critical_entries)
    && Array.isArray(idx.session_start.entries) && idx.session_start.preflight, 'session_start covered');
  // An entry carrying review_by validates (optional field present).
  assert.ok(idx.entries.some((e) => e.review_by === '2099-01-01'), 'review_by-bearing entry present + accepted');
  // RFC-011 v3 fields covered: the UNCONDITIONAL playbooks_* source fingerprint
  // (zero-state here — no preference file) + build_report.playbooks (empty but
  // present on every build). global_index_* is absent without a valid pref.
  assert.ok('playbooks_mtime_ms' in idx.source && 'playbooks_sha256' in idx.source, 'source.playbooks_* fingerprint present (v3, zero-state)');
  assert.ok(!('global_index_mtime_ms' in idx.source), 'no global_index_* without a valid preference file');
  assert.ok(idx.build_report.playbooks && Array.isArray(idx.build_report.playbooks.declared), 'build_report.playbooks present (v3)');
});

// --- Negative controls (each must be REJECTED) ---

t('schema_version 1 AND 2 are REJECTED (const 3; a cached v2 is stale, T12)', () => {
  const idx = seededIndex();
  for (const bad of [1, 2]) {
    const probe = { ...idx, schema_version: bad };
    const res = validateInstance(probe, SCHEMA);
    assert.ok(!res.valid, `a v${bad} index must not validate against the v3 schema`);
    assert.ok(res.errors.some((e) => e.path.includes('schema_version')), `wrong error for v${bad}: ${JSON.stringify(res.errors)}`);
  }
});

t('a malformed entry (bad trigger_kind) is REJECTED', () => {
  const idx = seededIndex();
  idx.entries[0].trigger_kind = 'bogus';
  const res = validateInstance(idx, SCHEMA);
  assert.ok(!res.valid, 'an entry with an out-of-enum trigger_kind must be rejected');
});

t('a missing required top-level section (session_start) is REJECTED', () => {
  const idx = seededIndex();
  delete idx.session_start;
  const res = validateInstance(idx, SCHEMA);
  assert.ok(!res.valid, 'a trigger-index without session_start must be rejected');
});

// A v3 index WITH a valid preference file: the playbooks section (session_start
// trio, build_report.playbooks, entry_class rows, global_index_* source) is
// non-empty and validates against the schema. Uses storeLesson + a real build.
function seededIndexWithPlaybooks() {
  const { cwd, home } = mkStore();
  const ss = storeLesson(cwd, home, ['--trigger', 'session phrase']);
  const od = storeLesson(cwd, home, ['--trigger', 'tool:Bash:git*', '--summary', 'od pb']);
  fs.writeFileSync(path.join(cwd, '.episodic-memory', 'playbooks.json'),
    JSON.stringify({ schema_version: 1, playbooks: [{ id: ss, mode: 'session_start' }, { id: od, mode: 'on_demand' }], bounds: { max_playbooks: 2 } }));
  const r = run(EM_TRIGGER, ['--scope', 'local'], { cwd, home });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(cwd, '.episodic-memory', 'trigger-index.json'), 'utf8'));
}

t('a v3 index WITH playbooks validates (session_start trio + build_report.playbooks + entry_class rows)', () => {
  const idx = seededIndexWithPlaybooks();
  assert.equal(idx.schema_version, 3);
  // session_start.playbooks trio present (a valid preference file was processed)
  assert.ok(Array.isArray(idx.session_start.playbooks) && idx.session_start.playbooks.length === 1, 'session_start.playbooks array present');
  assert.equal(typeof idx.session_start.playbooks_capped, 'number');
  assert.ok(idx.session_start.playbooks_capped_first === null || typeof idx.session_start.playbooks_capped_first === 'string');
  // build_report.playbooks populated, all 7 excluded counters present
  assert.equal(idx.build_report.playbooks.declared.length, 2, 'both playbooks declared (accepted set)');
  assert.deepEqual(Object.keys(idx.build_report.playbooks.excluded).sort(),
    ['chain_collision', 'cycle', 'empty_triggers', 'expired', 'inactive', 'non_lesson', 'unresolvable'], 'all 7 excluded counters');
  // global_index_* recorded (valid preference file -> cross-store coupling active)
  assert.ok('global_index_mtime_ms' in idx.source, 'global_index_* fingerprint present (valid pref)');
  // an entry_class:"playbook" row (on_demand) carries read_command
  const prow = idx.entries.find((e) => e.entry_class === 'playbook');
  assert.ok(prow && prow.read_command, 'playbook row + read_command present');
  const res = validateInstance(idx, SCHEMA);
  assert.ok(res.valid, `real v3 playbooks-bearing index rejected: ${JSON.stringify(res.errors).slice(0, 400)}`);
});

t('minimum-0 branch: a playbook row eff_pri 0 validates; a lesson row eff_pri 0 is REJECTED (R2.6)', () => {
  const idx = seededIndexWithPlaybooks();
  // the real on_demand playbook row pins effective_priority to 0 and validates
  const prow = idx.entries.find((e) => e.entry_class === 'playbook');
  assert.ok(prow, 'a playbook row exists');
  assert.equal(prow.effective_priority, 0, 'pinned to 0');
  assert.ok(validateInstance(idx, SCHEMA).valid, 'playbook row eff_pri=0 is schema-valid (minimum-0 branch)');
  // negative control: a LESSON row (no entry_class) with eff_pri 0 is REJECTED
  const lessonRow = idx.entries.find((e) => !e.entry_class);
  assert.ok(lessonRow, 'a lesson row exists');
  const tampered = JSON.parse(JSON.stringify(idx));
  tampered.entries.find((e) => !e.entry_class).effective_priority = 0;
  const rej = validateInstance(tampered, SCHEMA);
  assert.ok(!rej.valid, 'a lesson row with eff_pri 0 must be rejected (minimum 1 for non-playbook)');
  assert.ok(rej.errors.some((e) => e.path.includes('effective_priority')), `wrong error: ${JSON.stringify(rej.errors).slice(0, 300)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
