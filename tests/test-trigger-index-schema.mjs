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

t('schema validates a REAL seeded v2 trigger-index with non-empty entries', () => {
  const idx = seededIndex();
  assert.equal(idx.schema_version, 2, 'live producer emits v2');
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
});

// --- Negative controls (each must be REJECTED) ---

t('a schema_version:1 index is REJECTED (const 2)', () => {
  const idx = seededIndex();
  idx.schema_version = 1;
  const res = validateInstance(idx, SCHEMA);
  assert.ok(!res.valid, 'a v1 index must not validate against the v2 schema');
  assert.ok(res.errors.some((e) => e.path.includes('schema_version')), `wrong error: ${JSON.stringify(res.errors)}`);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
