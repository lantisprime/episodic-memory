#!/usr/bin/env node
/**
 * test-consumer-registry-schema.mjs — #492
 *
 * The consumer registry (~/.episodic-memory/installs.json) rows that carry the
 * enforcement_installed / activation_installed flags now have a discovered JSON
 * Schema (plugins/consumer-registry.schema.json). installed-state.schema.json
 * covers a DIFFERENT artifact. This proves the schema validates the REAL
 * registry and is a CLOSED contract (not future-tolerant — codex nit).
 *
 * Zero deps — Node stdlib only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins/consumer-registry.schema.json'), 'utf8'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function validRow(over = {}) {
  return {
    project_path: '/Users/juan.delacruz/proj',
    tool: 'claude-code',
    version: 'abc123',
    enforcement_installed: false,
    activation_installed: true,
    last_install_ts: '2026-07-09T08:13:03.434Z',
    ...over,
  };
}
const validRegistry = () => ({ schema_version: 2, entries: [validRow()] });

// --- The REAL registry validates (if one exists on this machine) ---

t('the real ~/.episodic-memory/installs.json validates (when present, v2)', () => {
  const p = path.join(os.homedir(), '.episodic-memory', 'installs.json');
  if (!fs.existsSync(p)) { console.log('    (skipped — no real registry on this machine)'); return; }
  const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Degrade-not-fail when the real registry is at an older schema_version:
  // the next registry write upgrades it in place (consumer readRegistry is
  // shape-version-tolerant by design, install-version.mjs:336-352).
  if (reg.schema_version !== SCHEMA.properties.schema_version.const) {
    console.log(`    (skipped — real registry is at schema_version=${reg.schema_version}, schema asserts ${SCHEMA.properties.schema_version.const})`);
    return;
  }
  const res = validateInstance(reg, SCHEMA);
  assert.ok(res.valid, `real installs.json rejected: ${JSON.stringify(res.errors).slice(0, 400)}`);
});

t('a synthetic minimal registry validates', () => {
  const res = validateInstance(validRegistry(), SCHEMA);
  assert.ok(res.valid, `synthetic registry rejected: ${JSON.stringify(res.errors)}`);
});

// --- Negative controls (each must be REJECTED) ---

t('a row missing project_path is REJECTED', () => {
  const reg = validRegistry();
  delete reg.entries[0].project_path;
  const res = validateInstance(reg, SCHEMA);
  assert.ok(!res.valid, 'a row without project_path must be rejected');
});

t('a row with an unknown field is REJECTED (closed contract, not future-tolerant)', () => {
  const reg = { schema_version: 2, entries: [validRow({ repair_notes: 'oops' })] };
  const res = validateInstance(reg, SCHEMA);
  assert.ok(!res.valid, 'an extra field must be rejected — the schema is versioned/closed');
  assert.ok(res.errors.some((e) => e.keyword === 'additionalProperties'), `wrong error: ${JSON.stringify(res.errors)}`);
});

t('a wrong schema_version is REJECTED (const 2)', () => {
  const reg = { schema_version: 1, entries: [validRow()] };
  const res = validateInstance(reg, SCHEMA);
  assert.ok(!res.valid, 'schema_version must be const 2');
});

t('a non-boolean install flag is REJECTED', () => {
  const reg = { schema_version: 2, entries: [validRow({ activation_installed: 'yes' })] };
  const res = validateInstance(reg, SCHEMA);
  assert.ok(!res.valid, 'activation_installed must be a boolean');
});

t('a row with store_id + store_aliases validates', () => {
  const reg = { schema_version: 2, entries: [validRow({ store_id: '0123456789abcdef', store_aliases: ['fedcba9876543210'] })] };
  const res = validateInstance(reg, SCHEMA);
  assert.ok(res.valid, `mirror-fields row rejected: ${JSON.stringify(res.errors)}`);
});

t('a malformed store_id is REJECTED (pattern)', () => {
  const reg = { schema_version: 2, entries: [validRow({ store_id: 'not-hex' })] };
  const res = validateInstance(reg, SCHEMA);
  assert.ok(!res.valid, 'malformed store_id must be rejected by pattern');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
