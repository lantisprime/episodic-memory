/**
 * test-category-write.mjs — RFC-009 P1a S2/S3: strict write surfaces (Group 2, §14).
 *
 * S2 (this file, first tranche): em-store + em-revise strict validation + category-index update
 *   REQ-4 (strict accept / reject deprecated / reject unknown / revise validates inherited),
 *   REQ-9 (store + revise maintain category-index.json), B1 (store fails closed on unloadable vocab).
 * S3 appends the em-restore matrix tests (testRestoreFilter*, testRestoreApply*, testRestoreMerges*).
 *
 * Every test asserts captured stdout JSON + on-disk file/index contents — no assert(true).
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

// Fresh non-git store dir → resolveLocalDir() lands at <dir>/.episodic-memory.
function mkStore() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'catwrite-'));
  return fs.realpathSync(d);
}
function storeDir(cwd) { return path.join(cwd, '.episodic-memory'); }

// Plant a vocab file with a deprecated member; returns its path (for EM_CATEGORIES_PATH).
function plantVocab(extra = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'catvocab-'));
  const p = path.join(d, 'categories.json');
  fs.writeFileSync(p, JSON.stringify({
    version: '1.0.0',
    categories: [
      { name: 'decision', description: 'd', lifecycle: 'standard' },
      { name: 'lesson', description: 'd', lifecycle: 'standard' },
      { name: 'old', description: 'd', lifecycle: 'standard', deprecated_for: 'lesson' },
      ...extra,
    ],
  }));
  return p;
}

function run(script, args, { cwd, env } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  return { code: r.status, stdout: r.stdout, json };
}

function readCatIndex(cwd) {
  try { return JSON.parse(fs.readFileSync(path.join(storeDir(cwd), 'category-index.json'), 'utf8')); }
  catch { return {}; }
}
function episodeFiles(cwd) {
  try { return fs.readdirSync(path.join(storeDir(cwd), 'episodes')).filter((f) => f.endsWith('.md')); }
  catch { return []; }
}

t('testStoreStrictAccept', () => {
  const cwd = mkStore();
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd });
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');
  assert.equal(episodeFiles(cwd).length, 1, 'exactly one episode written');
});

t('testStoreRejectsDeprecated', () => {
  const cwd = mkStore();
  const vocab = plantVocab();
  const r = run(EM_STORE, ['--project', 't', '--category', 'old', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, env: { EM_CATEGORIES_PATH: vocab } });
  assert.equal(r.code, 1);
  assert.equal(r.json.status, 'error');
  assert.match(r.json.message, /deprecated/);
  assert.match(r.json.message, /lesson/, 'names the successor');
  assert.equal(episodeFiles(cwd).length, 0, 'no partial write on rejection');
});

t('testStoreRejectsUnknown', () => {
  const cwd = mkStore();
  const r = run(EM_STORE, ['--project', 't', '--category', 'bogus', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd });
  assert.equal(r.code, 1);
  assert.match(r.json.message, /Invalid category "bogus"/);
  assert.equal(episodeFiles(cwd).length, 0);
  // EC5 empty-string leg: empty category is a MISSING required arg (caught before validation) —
  // still a non-zero exit with nothing written.
  const cwd2 = mkStore();
  const r2 = run(EM_STORE, ['--project', 't', '--category', '', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd: cwd2 });
  assert.notEqual(r2.code, 0);
  assert.equal(episodeFiles(cwd2).length, 0);
});

t('testStoreUpdatesCategoryIndex', () => {
  const cwd = mkStore();
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd });
  const idx = readCatIndex(cwd);
  assert.deepEqual(idx.lesson, [r.json.id], 'stored id appears under key lesson');
});

t('testReviseValidatesInheritedCategory', () => {
  const cwd = mkStore();
  // store under an active 'old' (planted vocab where old is active too? no — plant a vocab
  // where 'old' is ACTIVE for the store, then a second vocab where 'old' is DEPRECATED for revise).
  const activeVocab = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catvocab-')), 'categories.json');
  fs.writeFileSync(activeVocab, JSON.stringify({
    version: '1.0.0',
    categories: [
      { name: 'lesson', description: 'd', lifecycle: 'standard' },
      { name: 'old', description: 'd', lifecycle: 'standard' },
    ],
  }));
  const s = run(EM_STORE, ['--project', 't', '--category', 'old', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, env: { EM_CATEGORIES_PATH: activeVocab } });
  assert.equal(s.code, 0, 'store under active old succeeds');
  const origId = s.json.id;
  // Now revise with a vocab where 'old' is deprecated → reject, and the original stays active.
  const depVocab = plantVocab();
  const rev = run(EM_REVISE, ['--original', origId, '--project', 't', '--summary', 'r', '--body', 'c', '--scope', 'local'], { cwd, env: { EM_CATEGORIES_PATH: depVocab } });
  assert.equal(rev.code, 1);
  assert.match(rev.json.message, /deprecated/);
  assert.match(rev.json.message, /lesson/);
  // no partial write: original episode still status: active, no revision episode created
  const origMd = fs.readFileSync(path.join(storeDir(cwd), 'episodes', `${origId}.md`), 'utf8');
  assert.match(origMd, /^status: active$/m, 'original left byte-unchanged (still active)');
  assert.equal(episodeFiles(cwd).length, 1, 'no revision episode written');
});

t('testReviseUpdatesCategoryIndex', () => {
  const cwd = mkStore();
  const s = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd });
  const rev = run(EM_REVISE, ['--original', s.json.id, '--project', 't', '--summary', 'r', '--body', 'c', '--scope', 'local'], { cwd });
  assert.equal(rev.code, 0);
  const idx = readCatIndex(cwd);
  assert.ok(idx.lesson.includes(s.json.id) && idx.lesson.includes(rev.json.id), 'both ids under canonical key lesson');
});

t('testStoreFailsClosedOnMissingVocab', () => {
  const cwd = mkStore();
  const r = run(EM_STORE, ['--project', 't', '--category', 'lesson', '--summary', 's', '--body', 'b', '--scope', 'local'], { cwd, env: { EM_CATEGORIES_PATH: '/nonexistent/categories.json' } });
  assert.notEqual(r.code, 0, 'unloadable vocab → writer fails closed');
  assert.equal(episodeFiles(cwd).length, 0, 'nothing written');
});

// --- S3 restore-matrix tests are registered here (added in step 3.6) ---

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
