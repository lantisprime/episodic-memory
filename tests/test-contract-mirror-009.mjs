/**
 * test-contract-mirror-009.mjs — RFC-009 P1b S8: contract mirror (Group 7, §14).
 *
 * REQ-19: the shipped contract matches code (exit 0) AND a planted drift is
 * DETECTED (exit 1 naming it) — a validator never observed failing guards nothing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const VALIDATOR = path.join(REPO, 'scripts/validate-rfc-009-contract-mirror.mjs');
const CONTRACT = path.join(REPO, 'docs/rfcs/RFC-009-lesson-activation.contract.json');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function run(args) {
  const r = spawnSync('node', [VALIDATOR, ...args], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

t('testContractMirrorMatchesCode', () => {
  const r = run([]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(r.json.status, 'ok');
});

t('testContractMirrorDetectsDrift', () => {
  const doc = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctr009-'));

  // (a) bogus flag on em-store
  const withFlag = structuredClone(doc);
  withFlag.activation_flags['em-store'].push('--bogus-flag');
  const p1 = path.join(d, 'flag.json');
  fs.writeFileSync(p1, JSON.stringify(withFlag));
  const r1 = run(['--contract', p1]);
  assert.equal(r1.code, 1, 'drift exits 1');
  assert.ok(r1.json.errors.some((e) => e.includes('--bogus-flag')), `names the bogus flag: ${r1.stdout}`);

  // (b) missing activity class
  const withoutClass = structuredClone(doc);
  withoutClass.activity_classes = withoutClass.activity_classes.filter((c) => c !== 'plan');
  const p2 = path.join(d, 'class.json');
  fs.writeFileSync(p2, JSON.stringify(withoutClass));
  const r2 = run(['--contract', p2]);
  assert.equal(r2.code, 1);
  assert.ok(r2.json.errors.some((e) => e.includes('plan')), 'names the missing class');

  // (c) wrong trigger-kind enum
  const withKind = structuredClone(doc);
  withKind.trigger_index_shape.trigger_kind_enum = ['phrase', 'tool'];
  const p3 = path.join(d, 'kind.json');
  fs.writeFileSync(p3, JSON.stringify(withKind));
  const r3 = run(['--contract', p3]);
  assert.equal(r3.code, 1);
  assert.ok(r3.json.errors.some((e) => e.includes('activity')), 'functional parseTriggerKind cross-check fires');

  // (d) dropped field
  const withoutField = structuredClone(doc);
  withoutField.activation_fields = withoutField.activation_fields.filter((f) => f !== 'violated_pattern');
  const p4 = path.join(d, 'field.json');
  fs.writeFileSync(p4, JSON.stringify(withoutField));
  const r4 = run(['--contract', p4]);
  assert.equal(r4.code, 1);
  assert.ok(r4.json.errors.some((e) => e.includes('violated_pattern')), 'names the dropped field');
});

t('testContractMirrorBadArgvExits2', () => {
  const r = run(['--nonsense']);
  assert.equal(r.code, 2, 'bad argv is exit 2, never a fake drift');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
