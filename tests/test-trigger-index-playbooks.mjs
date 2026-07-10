/**
 * test-trigger-index-playbooks.mjs — RFC-011 P1-S2 (Group: playbooks schema + build).
 *
 * T1 schema group (parsePlaybooksConfig §12 + schemas/playbooks.schema.json parity);
 * T2 cross-store resolution + the exclusion matrix + declared + build-cap;
 * T3 freshness (create/edit/delete/global-revision/cache-hit);
 * T11 target-store binding (--project under caller_cwd != target);
 * T12 v2 -> v3 stale rebuild.
 *
 * Isolated fixtures ONLY: a tmp store OUTSIDE any git repo + a fake HOME; real
 * CLIs via spawnSync with explicit cwd. NEVER the real repo/HOME stores (a
 * worktree cwd converges to the MAIN repo store). rm trigger-index.json before
 * first-build assertions (R9a lazy-build, test-trigger-index.mjs:238-255).
 *
 * Every test asserts captured on-disk contents against a discriminating sentinel —
 * no assert(true), no aspirational output. The body-sentinel test (R2.8) is the
 * slice's red-then-green negative control: a distinctive string planted in the
 * playbook episode BODY must never appear in the derived index.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateInstance } from '../scripts/lib/json-instance-validate.mjs';
import { parsePlaybooksConfig } from '../scripts/em-trigger-index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_TRIGGER = path.join(REPO, 'scripts/em-trigger-index.mjs');
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
const PLAYBOOKS_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas/playbooks.schema.json'), 'utf8'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function mkStore() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-')));
  const home = path.join(d, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { cwd: d, home };
}
function storeDir(cwd) { return path.join(cwd, '.episodic-memory'); }
function globalDir(home) { return path.join(home, '.episodic-memory'); }
function tiPath(cwd) { return path.join(storeDir(cwd), 'trigger-index.json'); }
function readTi(cwd) { return JSON.parse(fs.readFileSync(tiPath(cwd), 'utf8')); }

function run(script, args, { cwd, home, env } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function build(cwd, home, extra = [], env = {}) {
  const r = run(EM_TRIGGER, ['--scope', 'local', ...extra], { cwd, home, env });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  return r;
}
function writePlaybooks(cwd, obj) {
  fs.mkdirSync(storeDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(storeDir(cwd), 'playbooks.json'), JSON.stringify(obj, null, 2));
}
function writeIndex(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Minimal index-row factory for chain/exclusion fixtures (precise control;
// the build reads index.jsonl rows — .md files are only for the oversized stat).
function row(id, over = {}) {
  return {
    id, date: '2026-07-08', time: '00:00', project: 't', category: 'lesson',
    status: 'active', supersedes: null, tags: [], summary: 's', triggers: ['x phrase'],
    priority: 5, access_count: 0, last_accessed: null, source: 'local',
    ...over,
  };
}

// parsePlaybooksConfig against a temp store dir carrying a playbooks.json object.
function parseIn(cwd, obj) {
  writePlaybooks(cwd, obj);
  return parsePlaybooksConfig(storeDir(cwd));
}
// Schema-doc verdict (validateInstance) — the parity counterpart the T1 group
// cross-checks the runtime parser against.
function schemaValid(obj) { return validateInstance(obj, PLAYBOOKS_SCHEMA).valid; }
// A fixture activity-class vocab with one known class ("plan") + one deprecated
// ("oldplan") so the F2 deprecated-class leg is exercisable (no shipped class is
// deprecated). Mirrors the EM_ACTIVATION_CLASSES_PATH env-override pattern used
// by testBuildDegradesOnUnloadableVocab (test-trigger-index.mjs).
function writeVocab(cwd) {
  fs.mkdirSync(storeDir(cwd), { recursive: true });
  const v = path.join(storeDir(cwd), 'vocab.json');
  fs.writeFileSync(v, JSON.stringify({
    version: '1.0.0',
    classes: [
      { name: 'plan', description: 'plan', phrases: ['plan'] },
      { name: 'oldplan', description: 'old', phrases: ['old'], deprecated_for: 'plan' },
    ],
  }));
  return v;
}

// ===========================================================================
// T1 — schema group (parser + schema-doc parity; requests/bounds/modes)
// ===========================================================================

t('T1a valid playbooks.json parses ok AND validates against the schema doc', () => {
  const { cwd } = mkStore();
  const obj = { schema_version: 1, playbooks: [{ id: 'pb-1', mode: 'session_start' }, { id: 'pb-2', mode: 'on_demand', triggers: ['multi-agent', 'tool:Bash:git*'] }], bounds: { max_playbooks: 2 } };
  const pb = parseIn(cwd, obj);
  assert.equal(pb.ok, true, 'parser: State B valid');
  assert.equal(pb.config.playbooks.length, 2);
  assert.ok(schemaValid(obj), 'schema doc accepts the valid file (parity)');
  assert.ok(pb.fingerprint.playbooks_sha256.match(/^[0-9a-f]{64}$/), 'real fingerprint');
});

t('T1b unknown top-level key rejected by parser AND schema doc', () => {
  const { cwd } = mkStore();
  const obj = { schema_version: 1, playbooks: [], bogus: 1 };
  const pb = parseIn(cwd, obj);
  assert.equal(pb.ok, false, 'parser rejects unknown key');
  assert.ok(/unknown key/.test(pb.reason), `reason names the key: ${pb.reason}`);
  assert.ok(!schemaValid(obj), 'schema doc rejects (parity)');
});

t('T1c bad mode rejected by parser AND schema doc', () => {
  const { cwd } = mkStore();
  const obj = { schema_version: 1, playbooks: [{ id: 'pb-1', mode: 'always' }] };
  assert.equal(parseIn(cwd, obj).ok, false, 'parser rejects bad mode');
  assert.ok(!schemaValid(obj), 'schema doc rejects (parity)');
});

t('T1d triggers on a session_start entry rejected by parser AND schema doc', () => {
  const { cwd } = mkStore();
  const obj = { schema_version: 1, playbooks: [{ id: 'pb-1', mode: 'session_start', triggers: ['x'] }] };
  assert.equal(parseIn(cwd, obj).ok, false, 'parser rejects triggers-on-session_start');
  assert.ok(!schemaValid(obj), 'schema doc rejects (if/then branch, parity)');
});

t('T1e max_playbooks 0 and 5 and non-integer rejected by parser AND schema doc', () => {
  const { cwd } = mkStore();
  for (const mp of [0, 5, 2.5, '2']) {
    const obj = { schema_version: 1, playbooks: [], bounds: { max_playbooks: mp } };
    assert.equal(parseIn(cwd, obj).ok, false, `parser rejects max_playbooks=${mp}`);
    assert.ok(!schemaValid(obj), `schema doc rejects max_playbooks=${mp} (parity)`);
  }
  // in-range values accepted
  for (const mp of [1, 2, 3, 4]) {
    const obj = { schema_version: 1, playbooks: [], bounds: { max_playbooks: mp } };
    assert.equal(parseIn(cwd, obj).ok, true, `parser accepts max_playbooks=${mp}`);
    assert.ok(schemaValid(obj), `schema doc accepts max_playbooks=${mp} (parity)`);
  }
});

t('T1f empty playbooks:[] is VALID (parses ok; renders nothing)', () => {
  const { cwd } = mkStore();
  const obj = { schema_version: 1, playbooks: [] };
  const pb = parseIn(cwd, obj);
  assert.equal(pb.ok, true, 'empty array is State B valid (EC1)');
  assert.ok(schemaValid(obj), 'schema doc accepts empty (parity)');
});

t('T1g duplicate literal ids rejected by the PARSER (schema cannot express unique-by-id)', () => {
  // JSON-Schema uniqueItems checks whole-item equality, NOT unique-by-id — two
  // entries with the same id but different mode slip through uniqueItems. R1
  // states dup-literal-id rejection is PARSER-enforced (the runtime authority).
  const { cwd } = mkStore();
  const obj = { schema_version: 1, playbooks: [{ id: 'dup', mode: 'session_start' }, { id: 'dup', mode: 'on_demand' }] };
  const pb = parseIn(cwd, obj);
  assert.equal(pb.ok, false, 'parser rejects dup literal id (same id, different mode)');
  assert.ok(/duplicate literal id/.test(pb.reason), `reason names the dup: ${pb.reason}`);
  // documented divergence: the schema doc CANNOT catch this unique-by-id case
  // (uniqueItems on object arrays checks deep-equality of whole items).
  assert.ok(schemaValid(obj), 'schema doc alone does NOT catch dup-by-id (parser-only by design)');
});

t('T1h over-bound: 33 entries handled as malformed (parser rejects; schema maxItems rejects)', () => {
  const { cwd } = mkStore();
  const obj = { schema_version: 1, playbooks: Array.from({ length: 33 }, (_, i) => ({ id: `e${i}`, mode: 'session_start' })) };
  assert.equal(parseIn(cwd, obj).ok, false, 'parser: >32 entries = malformed');
  assert.ok(!schemaValid(obj), 'schema doc rejects (maxItems 32, parity)');
});

t('T1i over-bound: >64 KiB file handled as malformed (parser stat; schema cannot express file size)', () => {
  const { cwd } = mkStore();
  const dir = storeDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  // a structurally-valid file inflated past 64 KiB with a huge-but-valid summary
  const huge = 'a'.repeat(70 * 1024);
  const obj = { schema_version: 1, playbooks: [{ id: huge, mode: 'session_start' }] };
  fs.writeFileSync(path.join(dir, 'playbooks.json'), JSON.stringify(obj));
  const pb = parsePlaybooksConfig(dir);
  assert.equal(pb.ok, false, '>64KiB file = malformed (State C)');
  assert.ok(/64 KiB/.test(pb.reason), `reason names the bound: ${pb.reason}`);
  assert.ok(pb.fingerprint.playbooks_size > 64 * 1024, 'fingerprint still records the real size (invalidation)');
});

t('T1j absent playbooks.json = State A (ok, config null, zero-state fingerprint)', () => {
  const { cwd } = mkStore();
  const pb = parsePlaybooksConfig(storeDir(cwd));
  assert.equal(pb.ok, true, 'absent = State A');
  assert.equal(pb.config, null);
  assert.deepEqual(pb.fingerprint, { playbooks_mtime_ms: 0, playbooks_size: 0, playbooks_sha256: pb.fingerprint.playbooks_sha256 });
  // sha256 of empty string (the zero-state)
  assert.equal(pb.fingerprint.playbooks_sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

// ===========================================================================
// T2 — cross-store resolution + exclusion matrix + declared + build-cap
// ===========================================================================

t('T2a cross-store chain resolution: local build resolves a GLOBAL terminal (R2.1)', () => {
  const { cwd, home } = mkStore();
  // the playbook episode lives in the GLOBAL store; the local build reads global
  // index.jsonl as build input for resolution only.
  const gid = '20260708-000000-global-playbook-0001';
  writeIndex(globalDir(home), [row(gid, { project: 'g', summary: 'flagship playbook', source: 'global' })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: gid, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const ti = readTi(cwd);
  assert.equal(ti.session_start.playbooks.length, 1);
  assert.equal(ti.session_start.playbooks[0].episode_id, gid, 'terminal id carried');
  assert.equal(ti.session_start.playbooks[0].summary, 'flagship playbook');
  assert.match(ti.session_start.playbooks[0].read_command, /node .*em-search\.mjs --read 20260708-000000-global-playbook-0001$/, 'read_command precomputed');
  assert.deepEqual(ti.build_report.playbooks.declared, [{ episode_id: gid, mode: 'session_start' }], 'declared lists the accepted set');
  assert.ok('global_index_mtime_ms' in ti.source, 'global_index_* fingerprint recorded (valid pref)');
});

t('T2b dup-id in both stores: the continuing-chain row wins (stale snapshot never shadows)', () => {
  const { cwd, home } = mkStore();
  // LOCAL: stale terminal snapshot of X (no superseded_by); GLOBAL: X continues
  // (superseded_by -> Y) and Y is the live terminal. The continuing global row
  // must outrank the stale local snapshot (protection.mjs:14-17 hazard).
  const xLocal = 'X-dup-chain'; const yTerm = 'Y-dup-terminal';
  writeIndex(storeDir(cwd), [row(xLocal, { summary: 'LOCAL stale snapshot' })]);
  writeIndex(globalDir(home), [row(xLocal, { summary: 'GLOBAL continuing', superseded_by: yTerm }), row(yTerm, { summary: 'live terminal', project: 'g' })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: xLocal, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const ti = readTi(cwd);
  assert.equal(ti.session_start.playbooks[0].episode_id, yTerm, 'resolved to the GLOBAL terminal Y, not the stale local X');
  assert.equal(ti.session_start.playbooks[0].summary, 'live terminal');
  // tie case: neither continues -> LOCAL wins (round-3 planner V4)
  const z = 'Z-tie';
  writeIndex(storeDir(cwd), [row(z, { summary: 'LOCAL tie' })]);
  writeIndex(globalDir(home), [row(z, { summary: 'GLOBAL tie', project: 'g' })]); // no superseded_by either side
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: z, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  assert.equal(readTi(cwd).session_start.playbooks[0].summary, 'LOCAL tie', 'neither continues -> LOCAL precedence');
});

t('T2c build-time cap: 3 session_start + max_playbooks 2 -> array 2, capped 1, capped_ids+first named', () => {
  const { cwd, home } = mkStore();
  const ids = ['pb-cap-1', 'pb-cap-2', 'pb-cap-3'];
  writeIndex(storeDir(cwd), ids.map((id) => row(id, { summary: id })));
  writePlaybooks(cwd, { schema_version: 1, playbooks: ids.map((id) => ({ id, mode: 'session_start' })), bounds: { max_playbooks: 2 } });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const ti = readTi(cwd);
  assert.equal(ti.session_start.playbooks.length, 2, 'array capped to max_playbooks');
  assert.deepEqual(ti.session_start.playbooks.map((p) => p.episode_id), ['pb-cap-1', 'pb-cap-2'], 'first two in preference-file order');
  assert.equal(ti.session_start.playbooks_capped, 1, 'one declaration capped');
  assert.equal(ti.session_start.playbooks_capped_first, 'pb-cap-3', 'first capped id named');
  assert.deepEqual(ti.build_report.playbooks.capped_ids, ['pb-cap-3'], 'full capped list in the build report');
});

t('T2d exclusion matrix: one case per excluded counter, each counted; declared excludes them', () => {
  const { cwd, home } = mkStore();
  // Build one fixture per exclusion reason + two accepted (for declared).
  const a = 'accepted-ss'; const b = 'accepted-od';
  const unre = 'unresolvable-id';                  // id in NEITHER store
  const cy1 = 'cycle-1'; const cy2 = 'cycle-2';    // cy1<->cy2 mutual supersedes cycle
  const ina = 'inactive-term';                     // terminal status: superseded (no successor)
  const non = 'non-lesson-term';                   // terminal category: decision
  const exp = 'expired-term';                      // terminal review_by past
  const col1 = 'collide-1'; const col2 = 'collide-2'; // both declared, same terminal chain
  const empty = 'empty-triggers-od';               // on_demand, no effective triggers

  // collision target: col1 -> col2 chain (col2 terminal). Both declared -> both drop.
  const localRows = [
    row(a, { summary: 'accepted session_start', triggers: ['x'] }),
    row(b, { summary: 'accepted on_demand', triggers: ['od phrase'] }),
    row(cy1, { summary: 'cyc', supersedes: cy2 }),
    row(cy2, { summary: 'cyc', supersedes: cy1 }),
    row(ina, { status: 'superseded', summary: 'inactive' }), // terminal is superseded, no successor
    row(non, { category: 'decision', summary: 'a decision, not a lesson' }),
    row(exp, { review_by: '2020-01-01', summary: 'expired' }),
    row(col1, { summary: 'collide chain old', supersedes: null }),
    row(col2, { summary: 'collide chain terminal', supersedes: col1 }), // col1->col2: terminal=col2
    row(empty, { summary: 'empty triggers od', triggers: [] }), // episode has no triggers; declared on_demand w/o override
  ];
  writeIndex(storeDir(cwd), localRows);
  writePlaybooks(cwd, {
    schema_version: 1,
    playbooks: [
      { id: a, mode: 'session_start' },
      { id: b, mode: 'on_demand' },
      { id: unre, mode: 'session_start' },                   // unresolvable
      { id: cy1, mode: 'session_start' },                    // cycle
      { id: ina, mode: 'session_start' },                     // inactive
      { id: non, mode: 'session_start' },                    // non_lesson
      { id: exp, mode: 'session_start' },                    // expired
      { id: col1, mode: 'session_start' },                   // collision (col1 resolves to terminal col2)
      { id: col2, mode: 'on_demand', triggers: ['col2 trigger'] }, // collision (same chain terminal col2)
      { id: empty, mode: 'on_demand' },                       // empty_triggers (episode triggers=[], no override)
    ],
  });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const ti = readTi(cwd);
  const ex = ti.build_report.playbooks.excluded;
  assert.equal(ex.unresolvable, 1, 'unresolvable counted');
  assert.equal(ex.cycle, 1, 'cycle counted');
  assert.equal(ex.inactive, 1, 'inactive counted');
  assert.equal(ex.non_lesson, 1, 'non_lesson counted');
  assert.equal(ex.expired, 1, 'expired counted');
  assert.equal(ex.chain_collision, 2, 'both entries of the colliding chain dropped');
  assert.equal(ex.empty_triggers, 1, 'empty effective triggers counted');
  // declared lists ONLY the accepted two (resolved, not excluded)
  assert.deepEqual(ti.build_report.playbooks.declared.map((d) => d.episode_id).sort(), [a, b].sort());
  // session_start: only `a` (col1/col2 dropped, empty is on_demand)
  assert.deepEqual(ti.session_start.playbooks.map((p) => p.episode_id), [a]);
  // on_demand: only `b` (col2 collided, empty excluded)
  const odRows = ti.entries.filter((e) => e.entry_class === 'playbook');
  assert.deepEqual(odRows.map((e) => e.episode_id), [b], 'only accepted on_demand expands to playbook rows');
});

t('T2e on_demand playbook rows carry the FULL verbatim shape (eff_pri 0, tools wildcard, slug, read_command)', () => {
  const { cwd, home } = mkStore();
  const id = 'od-shape-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'od pb', triggers: ['multi-agent', 'tool:Bash:git*'] })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const ti = readTi(cwd);
  const rows = ti.entries.filter((e) => e.entry_class === 'playbook');
  assert.equal(rows.length, 2, 'one row per effective trigger');
  const phrase = rows.find((e) => e.trigger_kind === 'phrase');
  assert.ok(phrase, 'phrase row present');
  assert.equal(phrase.effective_priority, 0, 'pinned below every lesson');
  assert.deepEqual(phrase.applies_to_tools, ['*'], 'wildcard, never empty');
  assert.equal(phrase.applies_to_projects.length, 1, "this project's slug");
  assert.ok(phrase.read_command.includes('--read ' + id), 'read_command present');
  assert.equal(phrase.episode_id, id);
  assert.equal(phrase.summary, 'od pb');
});

t('T2f --merged CLI carries session_start.playbooks unchanged (threads local persisted)', () => {
  const { cwd, home } = mkStore();
  const idSs = 'merged-pb-ss'; const idOd = 'merged-pb-od';
  writeIndex(storeDir(cwd), [row(idSs, { summary: 'merged ss' }), row(idOd, { summary: 'merged od', triggers: ['m od phrase'] })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: idSs, mode: 'session_start' }, { id: idOd, mode: 'on_demand' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  const r = run(EM_TRIGGER, ['--merged'], { cwd, home });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.json.session_start.playbooks, 'merged session_start carries the playbooks array');
  assert.equal(r.json.session_start.playbooks[0].episode_id, idSs);
  assert.equal(r.json.session_start.playbooks_capped, 0);
  // the on_demand row threads through (eff_pri preserved at 0, not recomputed)
  const pr = r.json.entries.find((e) => e.entry_class === 'playbook');
  assert.ok(pr, 'on_demand playbook row in merged entries');
  assert.equal(pr.effective_priority, 0, 'pinned 0 preserved through merge');
  assert.equal(pr.episode_id, idOd);
});

// ===========================================================================
// T2g/T2h — F2 activity-class guard (both legs: override + inherited).
// FC-009 EC11: unknown/deprecated `activity:` classes are excluded + counted,
// never silently matched. The lesson branch guards at build; the fix mirrors it
// for playbook triggers on BOTH legs (declared override AND inherited episode
// triggers). A filtered-to-empty set counts as empty_triggers (no new counter).
// ===========================================================================

t('T2g activity-class guard — OVERRIDE leg: unknown + deprecated dropped+counted; sibling phrase survives', () => {
  const { cwd, home } = mkStore();
  const vocab = writeVocab(cwd);
  // episode with its own (unrelated) phrase; the playbook OVERRIDES with a mix:
  // an unknown class, a deprecated class, and a surviving phrase.
  const id = 'f2-ov-grd-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'f2 ov', triggers: ['episode own phrase'] })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand', triggers: ['activity:bogus-class', 'activity:oldplan', 'survival phrase'] }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home, [], { EM_ACTIVATION_CLASSES_PATH: vocab });
  const ti = readTi(cwd);
  const rows = ti.entries.filter((e) => e.entry_class === 'playbook');
  assert.deepEqual(rows.map((e) => e.value), ['survival phrase'], 'unknown + deprecated dropped; sibling phrase survives');
  assert.equal(ti.build_report.excluded_activity_classes['bogus-class'], 1, 'unknown counted');
  assert.equal(ti.build_report.excluded_activity_classes.oldplan, 1, 'deprecated counted');
  assert.equal(ti.build_report.playbooks.excluded.empty_triggers, 0, 'NOT empty — a phrase survived');
  assert.deepEqual(ti.build_report.playbooks.declared, [{ episode_id: id, mode: 'on_demand' }], 'declared (accepted)');
});

t('T2h activity-class guard — INHERITED leg: unknown + deprecated filtered -> empty_triggers, not declared', () => {
  const { cwd, home } = mkStore();
  const vocab = writeVocab(cwd);
  // episode's OWN triggers are the bad classes; the playbook INHERITS them (no
  // declared triggers array) — the inherited leg must guard too.
  const id = 'f2-inh-grd-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'f2 inh', triggers: ['activity:bogus-class', 'activity:oldplan'] })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand' }] }); // no triggers -> inherits
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home, [], { EM_ACTIVATION_CLASSES_PATH: vocab });
  const ti = readTi(cwd);
  assert.deepEqual(ti.entries.filter((e) => e.entry_class === 'playbook'), [], 'no playbook rows (all activity triggers filtered)');
  assert.equal(ti.build_report.excluded_activity_classes['bogus-class'] >= 1, true, 'unknown counted (lesson branch + playbook inherited)');
  assert.equal(ti.build_report.excluded_activity_classes.oldplan >= 1, true, 'deprecated counted (lesson branch + playbook inherited)');
  assert.equal(ti.build_report.playbooks.excluded.empty_triggers, 1, 'empty effective triggers counted');
  assert.deepEqual(ti.build_report.playbooks.declared, [], 'not declared (excluded)');
});

// ===========================================================================
// T2i/T2j — F3 override muting in the merged view (R1 override clause; T6 E2E).
// A declared `triggers` array REPLACES the episode's own trigger set within this
// project. Playbook rows derived under an override carry triggers_overridden:true;
// loadMergedTriggerIndex DROPS the episode's own (superseded) non-playbook lesson
// rows for those ids (local AND global origin). No-override (inherited) keeps
// BOTH rows (R2.9(b) dedup unchanged). The hook-path sibling is S3 (REQ-6b).
// ===========================================================================

t('T2i override muting — DECLARED override: own-phrase lesson row absent from merged entries; playbook row carries triggers_overridden:true', () => {
  const { cwd, home } = mkStore();
  const id = 'f3-ov-mute-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'f3 ov', triggers: ['own phrase'] })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand', triggers: ['override phrase'] }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const r = run(EM_TRIGGER, ['--merged'], { cwd, home });
  assert.equal(r.code, 0, r.stderr);
  const mine = r.json.entries.filter((e) => e.episode_id === id);
  // the episode's own-phrase LESSON row is DROPPED (override replaces it); only
  // the override-phrase playbook row survives, carrying the marker.
  assert.deepEqual(mine.map((e) => ({ value: e.value, cls: e.entry_class || 'lesson', ov: e.triggers_overridden || false })),
    [{ value: 'override phrase', cls: 'playbook', ov: true }],
    'own-phrase lesson row absent; override playbook row present + triggers_overridden:true');
  // the per-store index KEEPS the lesson row (the override is a view-time
  // semantic; the audit surface is preserved). Only the merged view drops it.
  const ti = readTi(cwd);
  assert.ok(ti.entries.some((e) => e.value === 'own phrase' && !e.entry_class), 'per-store index still carries the own-phrase lesson row (untouched)');
});

t('T2j override muting — NO override (inherited): BOTH rows present, no marker (R2.9(b) unchanged)', () => {
  const { cwd, home } = mkStore();
  const id = 'f3-inh-mute-1';
  // no declared triggers -> inherits the episode's own phrase; both the lesson
  // row and the playbook row for the SAME phrase survive in the merged view.
  writeIndex(storeDir(cwd), [row(id, { summary: 'f3 inh', triggers: ['own phrase'] })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const r = run(EM_TRIGGER, ['--merged'], { cwd, home });
  const mine = r.json.entries.filter((e) => e.episode_id === id);
  assert.equal(mine.length, 2, 'both the lesson row and the playbook row survive');
  assert.ok(mine.some((e) => e.value === 'own phrase' && !e.entry_class && !e.triggers_overridden), 'lesson row present, no marker');
  assert.ok(mine.some((e) => e.value === 'own phrase' && e.entry_class === 'playbook' && !e.triggers_overridden), 'playbook row present, no marker');
});

t('T2k override muting — GLOBAL-store episode with override: global own-phrase lesson row dropped in merged view', () => {
  const { cwd, home } = mkStore();
  const id = 'f3-glob-mute-1';
  // the episode lives in the GLOBAL store only; the local playbook declares an
  // override. The local playbook row (overridden) + the global own-phrase lesson
  // row: the merged view must keep the playbook row and DROP the global lesson row.
  fs.mkdirSync(globalDir(home), { recursive: true });
  writeIndex(globalDir(home), [row(id, { project: 'g', summary: 'f3 global', source: 'global', triggers: ['own phrase'] })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand', triggers: ['override phrase'] }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const r = run(EM_TRIGGER, ['--merged'], { cwd, home });
  const mine = r.json.entries.filter((e) => e.episode_id === id);
  assert.deepEqual(mine.map((e) => ({ value: e.value, cls: e.entry_class || 'lesson', ov: e.triggers_overridden || false })),
    [{ value: 'override phrase', cls: 'playbook', ov: true }],
    'global own-phrase lesson row absent; local override playbook row present + ov:true');
});

// ===========================================================================
// T2l — F4 global-scope pref parse: a preference file is a per-project (LOCAL)
// artifact (R1 "no global variant"; R2 "the global store's index never carries
// playbook data"). A GLOBAL-scope build must NOT fingerprint/parse a global-store
// playbooks.json — neither a valid nor a malformed one. Validates the
// zero-state + no-note fix.
// ===========================================================================

t('T2l global-scope build skips a global playbooks.json: zero-state fingerprint + no note (valid + malformed)', () => {
  const { cwd, home } = mkStore();
  const gdir = globalDir(home);
  const gep = path.join(gdir, 'episodes');
  fs.mkdirSync(gep, { recursive: true });
  const gid = '20260708-000000-f4g-0001';
  fs.writeFileSync(path.join(gep, `${gid}.md`), [
    '---', `id: ${gid}`, 'date: 2026-07-08', 'time: "00:00"', 'project: g', 'category: lesson',
    'status: active', 'tags: []', 'summary: g', 'triggers: [g phrase]', 'priority: 5',
    '---', '', '# x', '', 'b', '',
  ].join('\n'));
  assert.equal(run(EM_REBUILD, ['--scope', 'global'], { cwd, home }).code, 0);
  // (a) VALID global playbooks.json -> zero-state fingerprint, no note, no declared
  fs.writeFileSync(path.join(gdir, 'playbooks.json'), JSON.stringify({ schema_version: 1, playbooks: [{ id: gid, mode: 'session_start' }] }));
  fs.rmSync(path.join(gdir, 'trigger-index.json'), { force: true });
  assert.equal(run(EM_TRIGGER, ['--scope', 'global'], { cwd, home }).code, 0);
  const ti = JSON.parse(fs.readFileSync(path.join(gdir, 'trigger-index.json'), 'utf8'));
  assert.equal(ti.source.playbooks_size, 0, 'valid global pref does NOT fingerprint the file (zero-state)');
  assert.ok(!ti.build_report.playbooks.note, 'no malformed-note leak from a valid file');
  assert.deepEqual(ti.build_report.playbooks.declared, [], 'no declared set on the global index');
  assert.ok(!('global_index_mtime_ms' in ti.source), 'no cross-store coupling on the global build');
  // (b) MALFORMED global playbooks.json -> STILL zero-state + no note (parse skipped)
  fs.writeFileSync(path.join(gdir, 'playbooks.json'), '{ not json');
  fs.rmSync(path.join(gdir, 'trigger-index.json'), { force: true });
  const rg = run(EM_TRIGGER, ['--scope', 'global'], { cwd, home });
  assert.equal(rg.code, 0, 'global build never fatal on a global pref');
  const ti2 = JSON.parse(fs.readFileSync(path.join(gdir, 'trigger-index.json'), 'utf8'));
  assert.equal(ti2.source.playbooks_size, 0, 'malformed global pref does NOT fingerprint the file (zero-state)');
  assert.ok(!ti2.build_report.playbooks.note, 'no malformed-note leak into the GLOBAL index (R2: global index never carries playbook data)');
});

// ===========================================================================
// T2m — codex-F1 pinned corner (RFC-011 R1 / R2.2): an EXCLUDED declaration fails
// to NOTHING. An empty `triggers:[]` OR an override whose triggers all drop to the
// activity-class guard emits NO playbook rows, NO `triggers_overridden` marker, and
// the episode's own trigger rows stay LIVE in the merged view. The exclusion is
// counted (empty_triggers / the activity-class counter), auditable, never silent.
// This PINS the corner so a future mute-on-empty "fix" cannot silently flip it
// (suppression is `lesson-suppress.json`'s job, not `triggers:[]`).
// ===========================================================================

t('T2m excluded override fails to nothing: empties do not mute; own triggers stay live (RFC R1/R2.2 corner)', () => {
  const { cwd, home } = mkStore();
  const vocab = writeVocab(cwd);
  const id = 'codex-f1-corner-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'f1 corner', triggers: ['own phrase'] })]);

  // (a) declared empty override: triggers:[]
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand', triggers: [] }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home, [], { EM_ACTIVATION_CLASSES_PATH: vocab });
  let r = run(EM_TRIGGER, ['--merged'], { cwd, home, env: { EM_ACTIVATION_CLASSES_PATH: vocab } });
  let ti = readTi(cwd);
  assert.equal(ti.build_report.playbooks.excluded.empty_triggers, 1, '(a) empty override counted as empty_triggers');
  assert.deepEqual(ti.build_report.playbooks.declared, [], '(a) excluded declaration not in declared set');
  assert.ok(!ti.entries.some((e) => e.entry_class === 'playbook'), '(a) no playbook row emitted');
  let mine = r.json.entries.filter((e) => e.episode_id === id);
  assert.deepEqual(mine.map((e) => ({ value: e.value, cls: e.entry_class || 'lesson', ov: e.triggers_overridden || false })),
    [{ value: 'own phrase', cls: 'lesson', ov: false }],
    '(a) episode own-phrase row STAYS LIVE in merged view; NO marker (no muting)');

  // (b) all-filtered override: a single deprecated activity class drops to the guard
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'on_demand', triggers: ['activity:oldplan'] }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home, [], { EM_ACTIVATION_CLASSES_PATH: vocab });
  r = run(EM_TRIGGER, ['--merged'], { cwd, home, env: { EM_ACTIVATION_CLASSES_PATH: vocab } });
  ti = readTi(cwd);
  assert.equal(ti.build_report.playbooks.excluded.empty_triggers, 1, '(b) fully-filtered override counted as empty_triggers');
  assert.equal(ti.build_report.excluded_activity_classes.oldplan, 1, '(b) the deprecated class counted in excluded_activity_classes (auditable)');
  assert.deepEqual(ti.build_report.playbooks.declared, [], '(b) excluded declaration not in declared set');
  assert.ok(!ti.entries.some((e) => e.entry_class === 'playbook'), '(b) no playbook row emitted');
  mine = r.json.entries.filter((e) => e.episode_id === id);
  assert.deepEqual(mine.map((e) => ({ value: e.value, cls: e.entry_class || 'lesson', ov: e.triggers_overridden || false })),
    [{ value: 'own phrase', cls: 'lesson', ov: false }],
    '(b) episode own-phrase row STAYS LIVE in merged view; NO marker (fatal to nothing)');
});

// ===========================================================================
// T3 — freshness (create/edit/delete/global-revision/cache-hit)
// ===========================================================================

t('T3a CREATING playbooks.json on a store whose index predates it invalidates (zero-state mismatch)', () => {
  const { cwd, home } = mkStore();
  const id = 'fresh-create-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'fresh', triggers: ['x'] })]);
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home); // build with NO playbooks.json -> playbooks_* zero-state
  const before = readTi(cwd);
  assert.ok(!('playbooks' in before.session_start), 'no trio before the file exists');
  assert.equal(before.source.playbooks_mtime_ms, 0, 'zero-state fingerprint recorded');
  // NOW create the preference file (mtime/size/sha all move off zero-state)
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }] });
  const r2 = build(cwd, home);
  assert.equal(r2.json.built[0].cache_hit, false, 'creation invalidates (zero-state mismatch)');
  const after = readTi(cwd);
  assert.equal(after.session_start.playbooks[0].episode_id, id, 'section now present');
  assert.notEqual(after.source.playbooks_mtime_ms, 0, 'real fingerprint now recorded');
});

t('T3b EDITING playbooks.json invalidates', () => {
  const { cwd, home } = mkStore();
  const id = 'fresh-edit-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'fresh' })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }], bounds: { max_playbooks: 1 } });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  // edit: bump max_playbooks (file size/sha change)
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }], bounds: { max_playbooks: 2 } });
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'edit invalidates');
});

t('T3c DELETING playbooks.json invalidates -> rebuild -> section gone (clean uninstall)', () => {
  const { cwd, home } = mkStore();
  const id = 'fresh-del-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'fresh' })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  assert.ok(readTi(cwd).session_start.playbooks, 'section present with the file');
  // delete the preference file -> zero-state mismatch -> rebuild -> section gone
  fs.rmSync(path.join(storeDir(cwd), 'playbooks.json'));
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'deletion invalidates');
  const after = readTi(cwd);
  assert.ok(!('playbooks' in after.session_start), 'section gone (clean uninstall)');
  assert.ok(!('global_index_mtime_ms' in after.source), 'no cross-store coupling without a valid pref');
});

t('T3d revising the GLOBAL playbook invalidates the LOCAL section', () => {
  const { cwd, home } = mkStore();
  const gid = 'global-rev-pb';
  writeIndex(globalDir(home), [row(gid, { project: 'g', summary: 'v1' })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: gid, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  // F5a fix: assert presence+SHAPE of the global_index fingerprint (64-hex sha,
  // non-zero mtime+size — a real cross-store coupling is active), NOT a self-compare.
  const before = readTi(cwd).source;
  assert.ok(typeof before.global_index_mtime_ms === 'number' && before.global_index_mtime_ms > 0, 'global_index_mtime_ms is a real stat');
  assert.ok(Number.isInteger(before.global_index_size) && before.global_index_size > 0, 'global_index_size is a real stat');
  assert.match(before.global_index_sha256, /^[0-9a-f]{64}$/, 'global_index_sha256 is a 64-hex sha256');
  const g0 = before.global_index_mtime_ms;
  // revise the GLOBAL store (its index.jsonl moves) -> global_index_* mismatch
  writeIndex(globalDir(home), [row(gid, { project: 'g', summary: 'v2 revised' })]);
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'global revision invalidates the local section (global_index_* mismatch)');
  assert.equal(readTi(cwd).session_start.playbooks[0].summary, 'v2 revised', 'rebased onto the revised terminal');
  assert.notEqual(readTi(cwd).source.global_index_mtime_ms, g0, 'global mtime moved');
});

t('T3e untouched inputs = cache hit (no rewrite)', () => {
  const { cwd, home } = mkStore();
  const id = 'cache-hit-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'hit' })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home); // first build (miss)
  const mtime1 = fs.statSync(tiPath(cwd)).mtimeMs;
  const r2 = build(cwd, home);
  assert.equal(r2.json.built[0].cache_hit, true, 'unchanged inputs = cache hit');
  assert.equal(fs.statSync(tiPath(cwd)).mtimeMs, mtime1, 'no rewrite on cache hit');
});

// ===========================================================================
// T11 — target-store binding (--project under caller_cwd != target)
// ===========================================================================

t('T11 preference-file read binds to the --project store under caller_cwd != target', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pb-bind-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  // target store: an episode + a playbooks.json preference file
  const tstore = path.join(target, '.episodic-memory');
  writeIndex(path.join(tstore, 'episodes'), []); // placeholder dir
  const id = '20260708-000000-target-bind-pb-0001';
  const epDir = path.join(tstore, 'episodes');
  fs.writeFileSync(path.join(epDir, `${id}.md`), [
    '---', `id: ${id}`, 'date: 2026-07-08', 'time: "00:00"', 'project: tgt', 'category: lesson',
    'status: active', 'tags: []', 'summary: target pb', 'triggers: [bind phrase]', 'priority: 5',
    '---', '', '# x', '', 'b', '',
  ].join('\n'));
  assert.equal(run(EM_REBUILD, ['--scope', 'local'], { cwd: target, home }).code, 0);
  writePlaybooks(target, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }] });
  // caller_cwd is an UNRELATED dir (not the target)
  const callerCwd = path.join(base, 'caller-cwd');
  fs.mkdirSync(callerCwd);
  const r = run(EM_TRIGGER, ['--scope', 'local', '--project', target], { cwd: callerCwd, home });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(fs.existsSync(path.join(tstore, 'trigger-index.json')), 'trigger-index lands under the TARGET store');
  const ti = JSON.parse(fs.readFileSync(path.join(tstore, 'trigger-index.json'), 'utf8'));
  assert.equal(ti.session_start.playbooks[0].episode_id, id, 'playbooks derived from the TARGET store preference file');
  assert.equal(ti.session_start.playbooks[0].read_command, `node ${path.join(REPO, 'scripts', 'em-search.mjs')} --read ${id}`, 'scripts root recorded at build');
});

// ===========================================================================
// T12 — schema-version migration (cached v2 -> v3 stale rebuild)
// ===========================================================================

t('T12 a cached v2 trigger-index.json is treated as stale and rebuilt to v3', () => {
  const { cwd, home } = mkStore();
  const id = 'migrate-v2-1';
  writeIndex(storeDir(cwd), [row(id, { summary: 'migrate' })]);
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  // plant a v2-shape cache (schema_version 2, no playbooks_* in source) on disk
  const v2 = JSON.parse(fs.readFileSync(tiPath(cwd), 'utf8'));
  v2.schema_version = 2;
  delete v2.source.playbooks_mtime_ms; // v2 source lacks playbooks_*
  delete v2.source.playbooks_size;
  delete v2.source.playbooks_sha256;
  fs.writeFileSync(tiPath(cwd), JSON.stringify(v2, null, 2));
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'v2 cache is stale (schema_version mismatch) -> rebuilt');
  const ti = readTi(cwd);
  assert.equal(ti.schema_version, 3, 'rebuilt to v3');
  assert.ok('playbooks_mtime_ms' in ti.source, 'v3 source carries the unconditional playbooks_* fingerprint');
});

t('T12b a v3-complete source block with ONLY schema_version forced to 2 rebuilds (isolates the version comparison)', () => {
  // F5b fix: the prior T12 leg deleted playbooks_* from the planted cache, so
  // sourceMatches failed independently of schema_version — green even if the
  // version comparison were dropped. This leg keeps a COMPLETE v3 source (all
  // playbooks_* + global_index_* fingerprints intact, matching the store) and
  // forces ONLY schema_version to 2, so the rebuild fires FOR THE VERSION ALONE.
  const { cwd, home } = mkStore();
  const id = 'migrate-v2-iso';
  writeIndex(storeDir(cwd), [row(id, { summary: 'migrate iso' })]);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home); // v3-complete build (playbooks_* + global_index_* present)
  const v3complete = JSON.parse(fs.readFileSync(tiPath(cwd), 'utf8'));
  // force ONLY schema_version to 2; leave the entire v3 source block untouched
  v3complete.schema_version = 2;
  fs.writeFileSync(tiPath(cwd), JSON.stringify(v3complete, null, 2));
  const r = build(cwd, home);
  assert.equal(r.json.built[0].cache_hit, false, 'stale on schema_version ALONE (the complete v3 source otherwise matches)');
  assert.equal(readTi(cwd).schema_version, 3, 'rebuilt to v3');
});

// ===========================================================================
// Negative control (R2.8): a body sentinel planted in a playbook episode BODY
// must NEVER appear in the derived index (summaries/metadata only). Red-then-
// green: if the build ever copied body content, this sentinel would leak.
// ===========================================================================

t('T5-body-sentinel playbook episode BODY content is never copied into the derived index', () => {
  const { cwd, home } = mkStore();
  const id = 'sentinel-pb-1';
  const sentinel = 'SENTINEL_BODY_STRING_NEVER_LEAK_7c9f1a';
  // episode .md with a distinctive body string + a trigger; build the index.
  fs.mkdirSync(path.join(storeDir(cwd), 'episodes'), { recursive: true });
  fs.writeFileSync(path.join(storeDir(cwd), 'episodes', `${id}.md`), [
    '---', `id: ${id}`, 'date: 2026-07-08', 'time: "00:00"', 'project: t', 'category: lesson',
    'status: active', 'tags: []', 'summary: sentinel summary', 'triggers: [sentinel phrase]', 'priority: 5',
    '---', '', '# body', '', sentinel, 'more body content with the ' + sentinel + ' repeated', '',
  ].join('\n'));
  assert.equal(run(EM_REBUILD, ['--scope', 'local'], { cwd, home }).code, 0);
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id, mode: 'session_start' }] });
  fs.rmSync(tiPath(cwd), { force: true });
  build(cwd, home);
  const ti = readTi(cwd);
  const serialized = JSON.stringify(ti);
  assert.ok(!serialized.includes(sentinel), 'body sentinel never appears in the derived index (R2.8 no-body-copy)');
  assert.ok(ti.session_start.playbooks[0].summary === 'sentinel summary', 'only summary/metadata carried');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
