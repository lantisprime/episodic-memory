/**
 * test-categories-lib.mjs — RFC-009 P1a S1: the category vocabulary lib + schema (Group 1, §14).
 *
 * Covers REQ-1/2/3 + the safety fail-direction (B1):
 *   - categories.json instance-validates against schemas/categories.schema.json (validateInstance
 *     from lib/json-instance-validate.mjs — C6; mini-jsonschema only lints a schema DOC)
 *   - the schema rejects a bad lifecycle enum / extra property
 *   - deprecated_for must resolve to a NON-deprecated member (semantic check beyond JSON-schema)
 *   - loadCategories() resolves categories.json via import.meta.url
 *   - an unloadable vocab THROWS at the writer path (validateCategory) but DEGRADES at the reader
 *     path (canonicalCategory) — the two sides of §12
 *   - validateCategory states A-D; canonicalCategory active/deprecated/unknown mapping
 *
 * testNoHardcodedCategoryList (the grep gate over scripts/*.mjs) is added in S3 step 3.6, once the
 * VALID_CATEGORIES arrays in em-store/em-restore are removed — registering it earlier would make
 * S1 red against those still-present arrays.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs';
import {
  loadCategories,
  validateCategory,
  canonicalCategory,
  categoryLifecycle,
} from '../scripts/lib/categories.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// A category is well-formed iff every deprecated_for names a member that itself is NOT deprecated
// (one-hop resolution; no chains, no self-reference). Encoded here because JSON-schema cannot
// express a cross-member reference. §7 deprecated-map-cycle row, REQ-2.
function checkDeprecatedResolves(doc) {
  const byName = new Map(doc.categories.map((c) => [c.name, c]));
  const bad = [];
  for (const c of doc.categories) {
    if (!c.deprecated_for) continue;
    const successor = byName.get(c.deprecated_for);
    if (!successor) bad.push({ name: c.name, reason: 'successor-missing' });
    else if (successor.deprecated_for) bad.push({ name: c.name, reason: 'successor-deprecated' });
  }
  return bad;
}

t('testCategoriesJsonValidates', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'categories.json'), 'utf8'));
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/categories.schema.json'), 'utf8'));
  const res = validateInstance(doc, schema);
  assert.equal(res.valid, true, `categories.json must validate; errors: ${JSON.stringify(res.errors)}`);
  assert.equal(doc.categories.length, 10, 'launch vocabulary has 10 members');
});

t('testCategoriesSchema', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/categories.schema.json'), 'utf8'));
  // bad lifecycle enum → invalid
  const badEnum = { version: '1.0.0', categories: [{ name: 'x', description: 'd', lifecycle: 'forever' }] };
  assert.equal(validateInstance(badEnum, schema).valid, false, 'bad lifecycle enum must fail');
  // extra property (additionalProperties:false) → invalid
  const extraProp = { version: '1.0.0', categories: [{ name: 'x', description: 'd', lifecycle: 'standard', color: 'red' }] };
  assert.equal(validateInstance(extraProp, schema).valid, false, 'extra member property must fail');
  // a valid minimal instance → valid (control)
  const good = { version: '1.0.0', categories: [{ name: 'x', description: 'd', lifecycle: 'standard' }] };
  assert.equal(validateInstance(good, schema).valid, true, 'minimal valid instance must pass');
});

t('testDeprecatedForMustResolve', () => {
  const real = JSON.parse(fs.readFileSync(path.join(REPO, 'categories.json'), 'utf8'));
  assert.deepEqual(checkDeprecatedResolves(real), [], 'launch vocab has no unresolved deprecated_for');
  // plant a vocab whose deprecated_for names a deprecated member → must be flagged
  const planted = {
    version: '1.0.0',
    categories: [
      { name: 'old', description: 'd', lifecycle: 'standard', deprecated_for: 'mid' },
      { name: 'mid', description: 'd', lifecycle: 'standard', deprecated_for: 'new' },
      { name: 'new', description: 'd', lifecycle: 'standard' },
    ],
  };
  const bad = checkDeprecatedResolves(planted);
  assert.equal(bad.length, 1, 'the chained deprecated_for must be reported');
  assert.equal(bad[0].name, 'old');
  assert.equal(bad[0].reason, 'successor-deprecated');
});

t('testCategoriesLibResolution', () => {
  const doc = loadCategories();
  assert.equal(Array.isArray(doc.categories), true);
  assert.ok(doc.categories.find((c) => c.name === 'lesson'), 'lesson resolved via import.meta.url');
  assert.ok(doc.categories.find((c) => c.name === 'temporary'), 'temporary resolved');
});

t('testCategoriesLibThrowsOnMissing', () => {
  const saved = process.env.EM_CATEGORIES_PATH;
  process.env.EM_CATEGORIES_PATH = path.join(os.tmpdir(), 'no-such-categories-XXX.json');
  try {
    // writer path throws (fail-closed)
    assert.throws(() => validateCategory('lesson'), /unloadable/, 'validateCategory must throw');
    // reader paths degrade (never throw)
    assert.equal(canonicalCategory('lesson'), 'lesson', 'canonicalCategory degrades to literal');
    assert.equal(categoryLifecycle('lesson'), null, 'categoryLifecycle degrades to null');
  } finally {
    if (saved === undefined) delete process.env.EM_CATEGORIES_PATH;
    else process.env.EM_CATEGORIES_PATH = saved;
  }
});

t('testValidateCategoryStates', () => {
  // A. active
  assert.deepEqual(validateCategory('lesson'), { ok: true });
  // D. unknown
  assert.deepEqual(validateCategory('bogus'), { ok: false, reason: 'unknown' });
  // empty/whitespace treated as unknown (EC5)
  assert.equal(validateCategory('').ok, false);
  assert.equal(validateCategory('   ').ok, false);
  // B/C. deprecated — planted vocab so the launch file stays deprecation-free
  const saved = process.env.EM_CATEGORIES_PATH;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catvocab-')), 'categories.json');
  fs.writeFileSync(tmp, JSON.stringify({
    version: '1.0.0',
    categories: [
      { name: 'old', description: 'd', lifecycle: 'standard', deprecated_for: 'new' },
      { name: 'new', description: 'd', lifecycle: 'standard' },
    ],
  }));
  process.env.EM_CATEGORIES_PATH = tmp;
  try {
    // B. deprecated, disallowed
    assert.deepEqual(validateCategory('old'), { ok: false, reason: 'deprecated', successor: 'new' });
    // C. deprecated, allowed
    assert.deepEqual(validateCategory('old', { allowDeprecated: true }), { ok: true, successor: 'new' });
  } finally {
    if (saved === undefined) delete process.env.EM_CATEGORIES_PATH;
    else process.env.EM_CATEGORIES_PATH = saved;
  }
});

t('testCanonicalCategory', () => {
  // active → itself
  assert.equal(canonicalCategory('lesson'), 'lesson');
  // unknown → literal drift key
  assert.equal(canonicalCategory('bogus'), 'bogus');
  // undefined / non-scalar → stable string key, never a crash (EC9/EC10)
  assert.equal(canonicalCategory(undefined), 'undefined');
  assert.equal(typeof canonicalCategory({ x: 1 }), 'string');
  // deprecated → successor (planted)
  const saved = process.env.EM_CATEGORIES_PATH;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catvocab-')), 'categories.json');
  fs.writeFileSync(tmp, JSON.stringify({
    version: '1.0.0',
    categories: [
      { name: 'old', description: 'd', lifecycle: 'standard', deprecated_for: 'new' },
      { name: 'new', description: 'd', lifecycle: 'standard' },
    ],
  }));
  process.env.EM_CATEGORIES_PATH = tmp;
  try {
    assert.equal(canonicalCategory('old'), 'new', 'deprecated maps one hop to successor');
    assert.equal(categoryLifecycle('old'), 'standard', 'lifecycle resolves through the successor');
  } finally {
    if (saved === undefined) delete process.env.EM_CATEGORIES_PATH;
    else process.env.EM_CATEGORIES_PATH = saved;
  }
});

t('testNoHardcodedCategoryList', () => {
  // No scripts/*.mjs may carry a category-name ARRAY literal — the vocabulary lives only in
  // categories.json, read through this lib (REQ-3). The single-value `workflow.lifecycle`
  // constant emitted by the event-writer family (I2b) is NOT an array and is allowed.
  const VOCAB = ['decision', 'discovery', 'milestone', 'context', 'research', 'lesson', 'violation', 'workflow.lifecycle', 'workplan', 'temporary'];
  const dir = path.join(REPO, 'scripts');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // single-line array literals; flag any that quote >=2 distinct vocab names
    for (const m of src.matchAll(/\[[^\]\n]*\]/g)) {
      const span = m[0];
      const hits = VOCAB.filter((n) => span.includes(`'${n}'`) || span.includes(`"${n}"`));
      if (hits.length >= 2) offenders.push(`${f}: ${span.slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [], `hardcoded category-name array literal(s) survive: ${offenders.join(' | ')}`);
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
