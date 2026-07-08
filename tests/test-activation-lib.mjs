/**
 * test-activation-lib.mjs — RFC-009 P1b S1: activation lib + activity-class vocab (Group 1, §14).
 *
 * REQ-2 (char reject), REQ-3 (priority band), REQ-4 (review_by), REQ-5 (tool vocab),
 * REQ-16b (single validator home), REQ-17 (activity-class vocabulary, names-only).
 *
 * Every test asserts a captured return value / throw — no assert(true).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOOL_IDS,
  ILLEGAL_ARRAY_CHARS,
  EARNED_BAND_MESSAGE,
  loadActivationClasses,
  validateActivation,
  parseTriggerKind,
  serializeInlineArray,
  resolveLinkage,
} from '../scripts/lib/activation.mjs';
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function errReasons(r) { return (r.errors || []).map(e => e.reason); }
function errFields(r) { return (r.errors || []).map(e => e.field); }

// --- activity-class vocabulary (REQ-17) ---

t('testActivationClassesValidates', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'activation-classes.json'), 'utf8'));
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/activation-classes.schema.json'), 'utf8'));
  const res = validateInstance(doc, schema);
  assert.equal(res.valid, true, `instance must validate: ${JSON.stringify(res.errors)}`);
  assert.equal(doc.classes.length, 7, 'exactly the 7 launch classes');
  const names = doc.classes.map(c => c.name).sort();
  assert.deepEqual(names, ['design', 'implement', 'plan', 'push', 'review', 'rule', 'troubleshoot']);
  for (const c of doc.classes) assert.deepEqual(c.phrases, [], `phrases EMPTY in P1b (F5c): ${c.name}`);
});

t('testActivationLibValidators', () => {
  // state G — a fully valid activation set normalizes with default priority 5
  const ok = validateActivation({ triggers: ['second opinion'], applies_to_projects: ['*'] }, { category: 'lesson' });
  assert.equal(ok.ok, true);
  assert.equal(ok.fields.priority, 5, 'priority materialized to default 5');
  assert.deepEqual(ok.fields.triggers, ['second opinion']);
  // no activation input at all → freeform (fields null), any category fine
  const freeform = validateActivation({}, { category: 'decision' });
  assert.equal(freeform.ok, true);
  assert.equal(freeform.fields, null);
  // state A — activation on non-lesson rejected naming the field
  const nonLesson = validateActivation({ triggers: ['x'] }, { category: 'decision' });
  assert.equal(nonLesson.ok, false);
  assert.ok(errReasons(nonLesson).includes('activation-fields-lesson-only'));
  assert.ok(errFields(nonLesson).includes('triggers'));
});

// --- REQ-2 inline-array char rejection ---

t('testTriggerRejectsComma', () => {
  const r = validateActivation({ triggers: ['a, b'] }, { category: 'lesson' });
  assert.equal(r.ok, false);
  assert.ok(errReasons(r).includes('illegal-char:,'), JSON.stringify(r.errors));
  assert.ok(errFields(r).includes('triggers'));
});

t('testTriggerRejectsBracket', () => {
  const r1 = validateActivation({ triggers: ['a[b'] }, { category: 'lesson' });
  assert.equal(r1.ok, false);
  assert.ok(errReasons(r1).includes('illegal-char:['));
  const r2 = validateActivation({ triggers: ['a]b'] }, { category: 'lesson' });
  assert.equal(r2.ok, false);
  assert.ok(errReasons(r2).includes('illegal-char:]'));
});

t('testTriggerRejectsQuote', () => {
  const r = validateActivation({ triggers: ['a"b'] }, { category: 'lesson' });
  assert.equal(r.ok, false);
  assert.ok(errReasons(r).includes('illegal-char:"'));
});

t('testAppliesToRejectsBadChar', () => {
  const r = validateActivation({ applies_to_projects: ['proj,2'] }, { category: 'lesson' });
  assert.equal(r.ok, false);
  assert.ok(errFields(r).includes('applies_to_projects'));
  assert.ok(errReasons(r).includes('illegal-char:,'));
});

t('testSerializeInlineArrayThrowsOnIllegal', () => {
  for (const c of ILLEGAL_ARRAY_CHARS) {
    let threw = false;
    try { serializeInlineArray([`x${c}y`]); } catch (e) { threw = true; assert.match(e.message, /illegal character/); }
    assert.equal(threw, true, `must throw on ${JSON.stringify(c)}`);
  }
  assert.equal(serializeInlineArray([' a ', 'b']), 'a, b', 'trims + joins unquoted');
});

// --- REQ-3 priority ---

t('testPriorityDefault5', () => {
  const r = validateActivation({ triggers: ['x'] }, { category: 'lesson' });
  assert.equal(r.ok, true);
  assert.equal(r.fields.priority, 5);
});

t('testPriorityRejectsNonInt', () => {
  const r = validateActivation({ priority: 3.5 }, { category: 'lesson' });
  assert.equal(r.ok, false);
  assert.ok(errReasons(r).includes('earned-band'));
  const r2 = validateActivation({ priority: 'high' }, { category: 'lesson' });
  assert.equal(r2.ok, false);
});

t('testPriorityRejects8Earned', () => {
  const r = validateActivation({ priority: 8 }, { category: 'lesson' });
  assert.equal(r.ok, false);
  const err = r.errors.find(e => e.field === 'priority');
  assert.equal(err.reason, 'earned-band');
  assert.equal(err.message, EARNED_BAND_MESSAGE, 'the earned-band explanation string is stable');
  assert.match(err.message, /8-9/);
  assert.match(err.message, /EARNED/);
  const r9 = validateActivation({ priority: 9 }, { category: 'lesson' });
  assert.equal(r9.ok, false);
});

t('testPriorityRejectsOutOfRange', () => {
  for (const p of [0, -1, 10]) {
    const r = validateActivation({ priority: p }, { category: 'lesson' });
    assert.equal(r.ok, false, `priority ${p} must reject`);
    assert.ok(errReasons(r).includes('earned-band'));
  }
  for (const p of [1, 7]) {
    const r = validateActivation({ priority: p }, { category: 'lesson' });
    assert.equal(r.ok, true, `priority ${p} must accept`);
    assert.equal(r.fields.priority, p);
  }
});

// --- REQ-4 review_by ---

t('testReviewByValidDate', () => {
  const r = validateActivation({ review_by: '2027-01-31' }, { category: 'lesson' });
  assert.equal(r.ok, true);
  assert.equal(r.fields.review_by, '2027-01-31');
});

t('testReviewByRejectsMalformed', () => {
  for (const bad of ['31-01-2027', '2027/01/31', '2027-13-99', 'soon', '2027-1-3']) {
    const r = validateActivation({ review_by: bad }, { category: 'lesson' });
    assert.equal(r.ok, false, `review_by ${bad} must reject`);
    const err = r.errors.find(e => e.field === 'review_by');
    assert.equal(err.reason, 'bad-date');
    assert.match(err.message, /YYYY-MM-DD/, 'names the accepted shape');
  }
});

// --- REQ-5 tool vocabulary ---

t('testAppliesToToolRejectsUnknown', () => {
  const r = validateActivation({ applies_to_tools: ['vim'] }, { category: 'lesson' });
  assert.equal(r.ok, false);
  const err = r.errors.find(e => e.field === 'applies_to_tools');
  assert.equal(err.reason, 'unknown-tool');
  for (const id of TOOL_IDS) assert.ok(err.message.includes(id), `message lists vocabulary member ${id}`);
});

t('testAppliesToToolAccepts', () => {
  const r = validateActivation({ applies_to_tools: [...TOOL_IDS] }, { category: 'lesson' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields.applies_to_tools, TOOL_IDS);
});

t('testAppliesToProjectWildcard', () => {
  const r = validateActivation({ applies_to_projects: ['*', 'episodic-memory'] }, { category: 'lesson' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fields.applies_to_projects, ['*', 'episodic-memory']);
});

// --- REQ-17 activity-class triggers ---

t('testActivityTriggerRejectsUnknownClass', () => {
  const r = validateActivation({ triggers: ['activity:bogus'] }, { category: 'lesson' });
  assert.equal(r.ok, false);
  const err = r.errors.find(e => e.field === 'triggers');
  assert.equal(err.reason, 'unknown-activity-class');
  assert.match(err.message, /bogus/);
  // every launch class accepted
  const ok = validateActivation({ triggers: ['activity:plan', 'activity:review'] }, { category: 'lesson' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

t('testActivityTriggerRejectsDeprecatedClass', () => {
  // plant a vocab where 'plan' is deprecated → reject (same class as unknown, state F)
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'actvocab-'));
  const p = path.join(d, 'activation-classes.json');
  fs.writeFileSync(p, JSON.stringify({
    version: '1.0.0',
    classes: [
      { name: 'plan', description: 'd', phrases: [], deprecated_for: 'design' },
      { name: 'design', description: 'd', phrases: [] },
    ],
  }));
  const prev = process.env.EM_ACTIVATION_CLASSES_PATH;
  process.env.EM_ACTIVATION_CLASSES_PATH = p;
  try {
    const r = validateActivation({ triggers: ['activity:plan'] }, { category: 'lesson' });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].reason, 'unknown-activity-class');
    assert.match(r.errors[0].message, /deprecated/);
    const ok = validateActivation({ triggers: ['activity:design'] }, { category: 'lesson' });
    assert.equal(ok.ok, true);
  } finally {
    if (prev === undefined) delete process.env.EM_ACTIVATION_CLASSES_PATH;
    else process.env.EM_ACTIVATION_CLASSES_PATH = prev;
  }
});

t('testValidateActivationFailsClosedOnUnloadableVocab', () => {
  // F4 write-side: activity trigger + unreachable vocab → rejected (fail closed)…
  const prev = process.env.EM_ACTIVATION_CLASSES_PATH;
  process.env.EM_ACTIVATION_CLASSES_PATH = '/nonexistent/activation-classes.json';
  try {
    const r = validateActivation({ triggers: ['activity:plan'] }, { category: 'lesson' });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].reason, 'unknown-activity-class');
    // …but a phrase/tool-only write never touches the vocab (lazy load, F4)
    const ok = validateActivation({ triggers: ['just a phrase', 'tool:Bash:git*'] }, { category: 'lesson' });
    assert.equal(ok.ok, true, 'phrase/tool-only write must not depend on the vocab');
  } finally {
    if (prev === undefined) delete process.env.EM_ACTIVATION_CLASSES_PATH;
    else process.env.EM_ACTIVATION_CLASSES_PATH = prev;
  }
});

t('testLoadActivationClassesThrowsOnUnloadable', () => {
  const prev = process.env.EM_ACTIVATION_CLASSES_PATH;
  process.env.EM_ACTIVATION_CLASSES_PATH = '/nonexistent/activation-classes.json';
  try {
    let threw = false;
    try { loadActivationClasses(); } catch (e) { threw = true; assert.match(e.message, /unloadable/); }
    assert.equal(threw, true);
  } finally {
    if (prev === undefined) delete process.env.EM_ACTIVATION_CLASSES_PATH;
    else process.env.EM_ACTIVATION_CLASSES_PATH = prev;
  }
});

// --- parseTriggerKind (REQ-12 discriminator) ---

t('testParseTriggerKind', () => {
  assert.equal(parseTriggerKind('tool:Bash:git*'), 'tool');
  assert.equal(parseTriggerKind('activity:plan'), 'activity');
  assert.equal(parseTriggerKind('second opinion'), 'phrase');
  assert.equal(parseTriggerKind('toolbox phrase'), 'phrase', 'prefix must be exact "tool:"');
});

// --- resolveLinkage (REQ-6/7 symmetric, pure-lib leg) ---

t('testResolveLinkageSymmetric', () => {
  const idx = [
    { id: 'v1', category: 'violation' },
    { id: 'l1', category: 'lesson' },
  ];
  assert.equal(resolveLinkage(['v1'], { requireCategory: 'violation', index: idx }).ok, true);
  const wrong = resolveLinkage(['l1'], { requireCategory: 'violation', index: idx });
  assert.equal(wrong.ok, false);
  assert.deepEqual(wrong.wrongCategory, ['l1']);
  const missing = resolveLinkage(['nope'], { requireCategory: 'lesson', index: idx });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['nope']);
  // symmetric: same shape both directions
  assert.equal(resolveLinkage(['l1'], { requireCategory: 'lesson', index: idx }).ok, true);
  assert.deepEqual(resolveLinkage(['v1'], { requireCategory: 'lesson', index: idx }).wrongCategory, ['v1']);
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
