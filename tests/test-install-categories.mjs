/**
 * test-install-categories.mjs — RFC-009 P1a S7: global deploy of categories.json (REQ-15) + docs
 * grep gate (REQ-16). Mock-project isolated-HOME E2E with the REAL install.mjs — never mental-trace.
 *
 * The strong claim (M3/C2) is not "the file was copied" but "the DEPLOYED em-store resolves the
 * DEPLOYED vocab": testInstallDeployedStoreLoadsVocab RUNS the deployed script and asserts the
 * vocab-list error, proving `../../categories.json` resolves in the deployed tree.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// --- one real install into an isolated HOME ---
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catinstall-home-')));
const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catinstall-proj-')));
const install = spawnSync('node', [path.join(REPO, 'install.mjs'), '--tool', 'claude-code', '--project', proj], {
  env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
});

const emHome = path.join(home, '.episodic-memory');

function findFile(root, name) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === name) hits.push(full);
    }
  };
  walk(root);
  return hits;
}

t('installSucceeded', () => {
  assert.equal(install.status, 0, `install.mjs must succeed; stderr: ${install.stderr}`);
});

t('testInstallDeploysCategoriesJson', () => {
  assert.ok(fs.existsSync(path.join(emHome, 'categories.json')), 'categories.json deployed to ~/.episodic-memory/');
});

t('testCategoriesJsonNotInClaudeHome', () => {
  const claudeHome = path.join(home, '.claude');
  const hits = fs.existsSync(claudeHome) ? findFile(claudeHome, 'categories.json') : [];
  assert.deepEqual(hits, [], `categories.json must NOT be under ~/.claude/ (P12); found: ${hits.join(', ')}`);
});

t('testInstallDeployedStoreLoadsVocab', () => {
  // Run the DEPLOYED store (not the repo copy) with an invalid category, cwd inside the fake
  // project, EM_CATEGORIES_PATH unset — it must resolve ../../categories.json from the deployed
  // scripts/lib/ and reject with the vocab-list message.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.EM_CATEGORIES_PATH;
  const deployedStore = path.join(emHome, 'scripts', 'em-store.mjs');
  assert.ok(fs.existsSync(deployedStore), 'deployed em-store.mjs present');
  const r = spawnSync('node', [deployedStore, '--project', 't', '--category', 'definitely-bogus', '--summary', 's', '--body', 'b', '--scope', 'global'], {
    cwd: proj, env, encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, `deployed store must reject bogus category; stdout: ${r.stdout} stderr: ${r.stderr}`);
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  assert.ok(json && /Invalid category "definitely-bogus"/.test(json.message), `vocab-list error expected; got: ${r.stdout}`);
  assert.match(json.message, /workplan|temporary|lesson/, 'the message lists the deployed vocabulary');
});

t('testDocsGrepGate', () => {
  const guide = fs.readFileSync(path.join(REPO, 'docs/EM_SCRIPTS_GUIDE.md'), 'utf8');
  for (const needle of ['categories.json', 'category-index.json', '--category', '--check']) {
    assert.ok(guide.includes(needle), `EM_SCRIPTS_GUIDE.md must document ${needle}`);
  }
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
