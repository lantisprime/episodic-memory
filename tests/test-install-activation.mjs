/**
 * test-install-activation.mjs — RFC-009 P1b S9: global deploy of activation-classes.json
 * (REQ-20) + docs grep gate (REQ-21). Mock-project isolated-HOME E2E with the REAL
 * install.mjs — never mental-trace (mirrors test-install-categories.mjs).
 *
 * The strong claim is not "the file was copied" but "the DEPLOYED em-store resolves the
 * DEPLOYED activity-class vocab": testInstallDeployedStoreLoadsClassVocab RUNS the deployed
 * script with an unknown `activity:` trigger and asserts the unknown-class rejection.
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
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'actinstall-home-')));
const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'actinstall-proj-')));
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

t('testInstallDeploysActivationClasses', () => {
  assert.ok(fs.existsSync(path.join(emHome, 'activation-classes.json')), 'activation-classes.json deployed to ~/.episodic-memory/');
  const doc = JSON.parse(fs.readFileSync(path.join(emHome, 'activation-classes.json'), 'utf8'));
  assert.equal(doc.classes.length, 7, 'the 7 launch classes deployed');
});

t('testActivationClassesNotInClaudeHome', () => {
  const claudeHome = path.join(home, '.claude');
  const hits = fs.existsSync(claudeHome) ? findFile(claudeHome, 'activation-classes.json') : [];
  assert.deepEqual(hits, [], `activation-classes.json must NOT be under ~/.claude/ (P12); found: ${hits.join(', ')}`);
});

t('testInstallDeployedStoreLoadsClassVocab', () => {
  // Run the DEPLOYED em-store (not the repo copy) with an unknown activity class,
  // EM_ACTIVATION_CLASSES_PATH unset — it must resolve ../../activation-classes.json
  // from the deployed tree and reject the unknown class (fail-closed write).
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.EM_ACTIVATION_CLASSES_PATH;
  const deployedStore = path.join(emHome, 'scripts', 'em-store.mjs');
  assert.ok(fs.existsSync(deployedStore), 'deployed em-store.mjs present');
  const r = spawnSync('node', [deployedStore, '--project', 't', '--category', 'lesson',
    '--trigger', 'activity:bogus', '--summary', 's', '--body', 'b', '--scope', 'global'], {
    cwd: proj, env, encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, `deployed store must reject the unknown class; stdout: ${r.stdout}`);
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  assert.ok(json && json.errors && json.errors[0].reason === 'unknown-activity-class', `unknown-activity-class expected; got: ${r.stdout}`);
  assert.match(json.errors[0].message, /plan/, 'the message lists the DEPLOYED class vocabulary');
  // positive control: a KNOWN class stores clean against the deployed vocab
  const ok = spawnSync('node', [deployedStore, '--project', 't', '--category', 'lesson',
    '--trigger', 'activity:plan', '--summary', 's', '--body', 'b', '--scope', 'global'], {
    cwd: proj, env, encoding: 'utf8',
  });
  assert.equal(ok.status, 0, `known class must store: ${ok.stdout} ${ok.stderr}`);
});

t('testDeployedTriggerIndexBuilds', () => {
  // the deployed em-trigger-index builds against the global store just written above
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const deployed = path.join(emHome, 'scripts', 'em-trigger-index.mjs');
  assert.ok(fs.existsSync(deployed), 'deployed em-trigger-index.mjs present');
  const r = spawnSync('node', [deployed, '--scope', 'global'], { cwd: proj, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  const ti = JSON.parse(fs.readFileSync(path.join(emHome, 'trigger-index.json'), 'utf8'));
  assert.equal(ti.entries.length, 1, 'the activity:plan lesson indexed by the DEPLOYED builder');
});

t('testDocsGrepGate', () => {
  const guide = fs.readFileSync(path.join(REPO, 'docs/EM_SCRIPTS_GUIDE.md'), 'utf8');
  for (const needle of ['trigger-index.json', 'violated_pattern', 'activation-classes.json', 'em-trigger-index', '--evidence', '--lesson', 'effective_priority']) {
    assert.ok(guide.includes(needle), `EM_SCRIPTS_GUIDE.md must document ${needle}`);
  }
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const needle of ['em-trigger-index', 'activation-classes.json']) {
    assert.ok(readme.includes(needle), `README.md must reference ${needle}`);
  }
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
