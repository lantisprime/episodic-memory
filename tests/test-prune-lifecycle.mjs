/**
 * test-prune-lifecycle.mjs — RFC-009 P1a S6: per-category prune lifecycle (REQ-13, R10e).
 *
 * A consumed aggregate-then-prune (temporary) member — one carrying superseded_by — is aggressively
 * prunable and OVERRIDES the R6 class-c protection a consolidates-membership would grant. A temporary
 * without a successor, and every standard-lifecycle episode, follow the unchanged score + R6 rules.
 * On an unloadable vocab the override no-ops (B1 degrade).
 *
 * Fixtures use a RECENT date so a normally-high score isolates the override: if a recent episode is
 * pruned, only the R10e override could have done it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_PRUNE = path.join(REPO, 'scripts/em-prune.mjs');

const TODAY = new Date().toISOString().slice(0, 10);
const OLD = '2024-01-01'; // aged well past the ~310-day prune line

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// Build an isolated store (LOCAL) + an empty fake HOME (so GLOBAL is empty and hermetic).
function mkStore(rows) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catprune-')));
  const store = path.join(cwd, '.episodic-memory');
  fs.mkdirSync(store, { recursive: true });
  const jsonl = rows.map((r) => JSON.stringify({ status: 'active', access_count: 0, ...r })).join('\n') + '\n';
  fs.writeFileSync(path.join(store, 'index.jsonl'), jsonl);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catprunehome-')));
  return { cwd, home };
}
function dryRun({ cwd, home }, env) {
  const r = spawnSync('node', [EM_PRUNE, '--dry-run', '--scope', 'local'], {
    cwd, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}
function prunableIds(res) { return (res.json.results[0].episodes || []).map((e) => e.id); }
function protectedIds(res) { return (res.json.results[0].protected_episodes || []).map((e) => e.id); }

t('testTemporaryWithSuccessorPrunable', () => {
  // recent temporary WITH superseded_by → pruned by the override despite a high standard score
  const s = mkStore([{ id: 'tmp1', category: 'temporary', date: TODAY, superseded_by: 'succ1' }]);
  const res = dryRun(s);
  assert.equal(res.code, 0);
  assert.ok(prunableIds(res).includes('tmp1'), 'consumed temporary is aggressively prunable');
});

t('testTemporaryWithSuccessorOverridesClassC', () => {
  // tmp1 is named in succ1.consolidates → R6 class-c would protect it, but the R10e override wins
  const s = mkStore([
    { id: 'tmp1', category: 'temporary', date: TODAY, superseded_by: 'succ1' },
    { id: 'succ1', category: 'lesson', date: TODAY, consolidates: ['tmp1'] },
  ]);
  const res = dryRun(s);
  assert.ok(prunableIds(res).includes('tmp1'), 'override beats class-c protection');
  assert.ok(!protectedIds(res).includes('tmp1'), 'tmp1 is NOT in the protected set');
});

t('testTemporaryWithoutSuccessorSurvives', () => {
  // recent temporary WITHOUT superseded_by → standard score (high) → survives; no aggressive prune
  const s = mkStore([{ id: 'tmp2', category: 'temporary', date: TODAY }]);
  const res = dryRun(s);
  assert.ok(!prunableIds(res).includes('tmp2'), 'a temporary without a successor is not aggressively pruned');
});

t('testStandardLifecycleUnaffected', () => {
  // a standard-lifecycle episode WITH superseded_by is NOT aggressively pruned (only
  // aggregate-then-prune triggers the override); recent → survives
  const s = mkStore([{ id: 'std1', category: 'lesson', date: TODAY, superseded_by: 'x' }]);
  const res = dryRun(s);
  assert.ok(!prunableIds(res).includes('std1'), 'standard lifecycle unaffected by the override');
});

t('testStandardConsolidatesMemberStillProtected', () => {
  // aged standard-category member named in a valid referencer's consolidates array → class-c protects
  const s = mkStore([
    { id: 'std2', category: 'decision', date: OLD },
    { id: 'ref1', category: 'lesson', date: TODAY, consolidates: ['std2'] },
  ]);
  const res = dryRun(s);
  assert.ok(!prunableIds(res).includes('std2'), 'aged standard consolidates-member not pruned');
  assert.ok(protectedIds(res).includes('std2'), 'it stays R6 class-c protected');
});

t('testPruneDegradesOnMissingVocab', () => {
  // recent temporary + superseded_by, but vocab unloadable → categoryLifecycle null → override
  // no-ops → standard score (recent, high) → NOT pruned. No crash.
  const s = mkStore([{ id: 'tmp3', category: 'temporary', date: TODAY, superseded_by: 'succ1' }]);
  const res = dryRun(s, { EM_CATEGORIES_PATH: '/nonexistent/categories.json' });
  assert.equal(res.code, 0, 'prune never fatal on unloadable vocab');
  assert.ok(!prunableIds(res).includes('tmp3'), 'override no-ops; standard score keeps the recent row');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
