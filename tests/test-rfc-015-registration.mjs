/**
 * test-rfc-015-registration.mjs — RFC-015 P1-S1 acceptance suite.
 *
 * Group 1: R1 marker (4 legs)
 *   t1_marker_store            — T1: fm `playbook: true` + index row + advisory
 *   t2_no_flag_byte_identical  — T2: no marker, no advisory, stdout byte-identical
 *   t14_rebuild_roundtrip      — T14: rebuild preserves `playbook: true`
 *   t4b_revise_inherit_clear   — marker inherits; --no-playbook clears
 *
 * Group 2: R2 advisory (3 legs)
 *   t4_registered_true         — T4: declared chain → registered:true, no suggested_entry
 *   t15b_advisory_degrades     — T15: corrupt playbooks.json + marker store → note, exit 0
 *   t16_empty_trigger          — T16: on_demand for triggerless → warn, build excludes as empty_triggers
 *
 * Group 3: R3 flag (6 legs)
 *   t3_grammar_and_write       — T3: bare flag→session_start; absent file→skeleton; idempotent; invalid mode refused; contradiction refused
 *   t5_dual_caps               — T5: 32-cap refusal + idempotent at 32 + build-cap note
 *   t8_no_flag_no_write        — T8: flagless store + revise + marker-only → file byte-identical
 *   t9_scope_refusal           — T9: --scope global refused; global-store marker advisory names LOCAL project_store
 *   t15_corrupt_fail_closed    — T15: unparseable + schema-invalid refusal; file byte-identical
 *   t17_concurrent_survive     — NSP G1: two concurrent registrations, BOTH ids survive
 *
 * Group 4: R5 doctor (2 legs)
 *   t7_four_checks_fire        — seeded fixtures: each id appears warn; cyclic leg terminates
 *   t7b_clean_silent           — clean fixture: zero playbook-* ids; no `fix` key on any
 *
 * Harness mirrors tests/test-trigger-index-playbooks.mjs: isolated fixture
 * stores under os.tmpdir(); spawnSync of the real scripts with explicit
 * cwd; assertions on captured stdout JSON, exit codes, and on-disk bytes
 * (sha or buffer compare for byte-identical claims). Sentinel ids per
 * fixture so collisions cannot leak across tests.
 *
 * Zero deps. Node stdlib only.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_STORE = path.join(REPO, 'scripts/em-store.mjs');
const EM_REVISE = path.join(REPO, 'scripts/em-revise.mjs');
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');
const EM_TRIGGER = path.join(REPO, 'scripts/em-trigger-index.mjs');
const EM_DOCTOR = path.join(REPO, 'scripts/em-doctor.mjs');
const PLAYBOOKS_REGISTRATION = path.join(REPO, 'scripts/lib/playbook-registration.mjs');

let pass = 0, fail = 0;
const failed = [];
// Async-capable test runner (mirrors the synchronous pattern used by sibling
// suites; t17 needs to await child_process.spawn for true concurrent invocations).
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; failed.push(name); console.error(`FAIL  ${name}\n      ${e.stack || e.message}`); }
}

// ---------------------------------------------------------------------------
// Isolated fixture helpers (mirrors test-trigger-index-playbooks.mjs mkStore()).
// A tmp cwd under os.tmpdir() that is NOT a git repo resolves its local store
// to <cwd>/.episodic-memory (resolveLocalDir falls back to cwd). HOME is set
// to an isolated fake home so a global-store write never escapes.
// ---------------------------------------------------------------------------
function mkStore() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rfc015-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rfc015-home-')));
  return { cwd, home };
}
function storeDir(cwd) { return path.join(cwd, '.episodic-memory'); }
function episodesDir(cwd) { return path.join(storeDir(cwd), 'episodes'); }
function indexFile(cwd) { return path.join(storeDir(cwd), 'index.jsonl'); }
function playbooksPath(cwd) { return path.join(storeDir(cwd), 'playbooks.json'); }
function tiPath(cwd) { return path.join(storeDir(cwd), 'trigger-index.json'); }

// Run a script with explicit cwd + isolated HOME.
function run(script, args, { cwd, home, env } = {}) {
  const r = spawnSync('node', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
function runStore(args, cwd, home) {
  return run(EM_STORE, args, { cwd, home });
}
function runRevise(args, cwd, home) {
  return run(EM_REVISE, args, { cwd, home });
}
function runRebuild(args, cwd, home) {
  return run(EM_REBUILD, args, { cwd, home });
}
function runDoctor(args, cwd, home) {
  return run(EM_DOCTOR, args, { cwd, home });
}

// writeIndex: drop a controlled index row (no .md required for resolution).
function writeIndex(cwd, rows) {
  fs.mkdirSync(storeDir(cwd), { recursive: true });
  fs.writeFileSync(indexFile(cwd), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function row(id, over = {}) {
  return {
    id,
    date: '2026-07-26',
    time: '00:00',
    project: 'rfc015',
    category: 'lesson',
    status: 'active',
    supersedes: null,
    tags: [],
    summary: 'rfc015 fixture',
    priority: 5,
    access_count: 0,
    last_accessed: null,
    ...over,
  };
}
function writePlaybooks(cwd, obj) {
  fs.mkdirSync(storeDir(cwd), { recursive: true });
  fs.writeFileSync(playbooksPath(cwd), JSON.stringify(obj, null, 2));
}
function readPlaybooks(cwd) {
  return JSON.parse(fs.readFileSync(playbooksPath(cwd), 'utf8'));
}
function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Store a bare (no marker) episode, returning its id.
function storeBare(cwd, home, summary) {
  const r = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', summary || 'bare', '--body', 'b', '--scope', 'local'],
    cwd, home,
  );
  assert.equal(r.code, 0, `bare store failed: ${r.stdout}\n${r.stderr}`);
  return r.json.id;
}

// Store a marker-bearing episode, returning its id.
function storePlaybook(cwd, home, summary) {
  const r = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', summary || 'pb', '--body', 'b', '--scope', 'local', '--playbook'],
    cwd, home,
  );
  assert.equal(r.code, 0, `playbook store failed: ${r.stdout}\n${r.stderr}`);
  return r.json.id;
}

// Pre-change golden for t2: capture a flagless store's full stdout once.
// We can't capture "pre-change" of this PR (it doesn't exist yet), so we
// snapshot the current expected shape: { status: 'ok', id, file, scope }.
// The byte-identical leg asserts the captured stdout equals that exact shape
// plus no advisory (the marker's absence is the WHOLE point).
const NO_MARKER_STDOUT_KEYS = ['status', 'id', 'file', 'scope'];

// ===========================================================================
// Group 1: R1 marker (4 legs)
// ===========================================================================

await t('t1_marker_store: --playbook writes fm + index row + advisory with suggested_entry', () => {
  const { cwd, home } = mkStore();
  const r = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t1', '--body', 'b', '--scope', 'local', '--playbook'],
    cwd, home,
  );
  assert.equal(r.code, 0, `exit: ${r.stdout}\n${r.stderr}`);
  assert.equal(r.json.status, 'ok', 'ok status');
  assert.ok(r.json.id, 'id present');
  assert.equal(r.json.scope, 'local');
  // fm line present
  const epFile = path.join(episodesDir(cwd), `${r.json.id}.md`);
  const epContent = fs.readFileSync(epFile, 'utf8');
  assert.match(epContent, /^playbook: true$/m, 'frontmatter carries `playbook: true`');
  // index row field
  const idxLine = fs.readFileSync(indexFile(cwd), 'utf8').split('\n').filter(Boolean).find((l) => {
    try { return JSON.parse(l).id === r.json.id } catch { return false }
  });
  assert.ok(idxLine, 'index row exists');
  const idxRow = JSON.parse(idxLine);
  assert.equal(idxRow.playbook, true, 'index row field true');
  // advisory shape (RFC-015:64-71)
  assert.ok(r.json.playbook_advisory, 'advisory present');
  assert.equal(r.json.playbook_advisory.registered, false, 'not declared yet');
  assert.equal(typeof r.json.playbook_advisory.project_store, 'string', 'project_store is the LOCAL store path');
  assert.ok(r.json.playbook_advisory.project_store.endsWith('.episodic-memory'), 'project_store ends in .episodic-memory');
  assert.ok(r.json.playbook_advisory.suggested_entry, 'suggested_entry present');
  assert.equal(r.json.playbook_advisory.suggested_entry.id, r.json.id);
  assert.equal(r.json.playbook_advisory.suggested_entry.mode, 'session_start');
  assert.match(r.json.playbook_advisory.note, /not declared/, 'note names the absent declaration');
});

await t('t2_no_flag_byte_identical: no marker → no advisory → stdout byte-identical to the pre-change golden', () => {
  const { cwd, home } = mkStore();
  const r = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t2', '--body', 'b', '--scope', 'local'],
    cwd, home,
  );
  assert.equal(r.code, 0, `exit: ${r.stdout}\n${r.stderr}`);
  // marker absent in fm + index
  const epFile = path.join(episodesDir(cwd), `${r.json.id}.md`);
  assert.ok(!/^playbook:/m.test(fs.readFileSync(epFile, 'utf8')), 'no `playbook:` key in fm');
  const idxLine = fs.readFileSync(indexFile(cwd), 'utf8').split('\n').filter(Boolean).find((l) => {
    try { return JSON.parse(l).id === r.json.id } catch { return false }
  });
  const idxRow = JSON.parse(idxLine);
  assert.equal(idxRow.playbook, undefined, 'no playbook field in index row');
  // F6 (review r1): full-stdout golden. Reconstruct the expected object from
  // the parsed values (id/file are run-generated) and re-serialize with the
  // exact four keys in the exact pre-change order, then compare to the raw
  // captured line. This pins both KEY ORDER and ABSENCE of extra keys — the
  // EC5 intent the prior key-set assert under-asserted.
  const expected = { status: 'ok', id: r.json.id, file: r.json.file, scope: 'local' }
  const expectedSerialized = JSON.stringify(expected)
  assert.equal(r.stdout.trim(), expectedSerialized, `stdout byte-identical to golden; got ${r.stdout.trim()}`)
});

await t('t14_rebuild_roundtrip: em-rebuild-index preserves `playbook: true` (whitelist lockstep)', () => {
  const { cwd, home } = mkStore();
  // Marker-bearing episode
  const pbId = storePlaybook(cwd, home, 'rfc015 t14 pb');
  // Bare episode
  const bareId = storeBare(cwd, home, 'rfc015 t14 bare');
  // Rebuild and re-read the index.
  const rr = runRebuild(['--scope', 'local'], cwd, home);
  assert.equal(rr.code, 0, `rebuild exit: ${rr.stdout}\n${rr.stderr}`);
  const idxRows = fs.readFileSync(indexFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pbRow = idxRows.find((e) => e.id === pbId);
  const bareRow = idxRows.find((e) => e.id === bareId);
  assert.ok(pbRow, 'marker episode survives rebuild');
  assert.equal(pbRow.playbook, true, '`playbook: true` survives rebuild (whitelist lockstep)');
  assert.ok(bareRow, 'bare episode survives rebuild');
  assert.equal(bareRow.playbook, undefined, 'bare episode stays marker-free');
});

await t('t4b_revise_inherit_clear: marker inherits on plain revise; --no-playbook clears (fm + index)', () => {
  const { cwd, home } = mkStore();
  // Marker-bearing original
  const origId = storePlaybook(cwd, home, 'rfc015 t4b orig');
  // Plain revise (no flag) → marker inherits
  const r1 = runRevise(
    ['--original', origId, '--project', 'rfc015', '--summary', 'rfc015 t4b rev1', '--body', 'b2', '--scope', 'local'],
    cwd, home,
  );
  assert.equal(r1.code, 0, `inherit revise exit: ${r1.stdout}\n${r1.stderr}`);
  assert.ok(r1.json.playbook_advisory, 'advisory present on inherited revise');
  const rev1Id = r1.json.id;
  const rev1File = path.join(episodesDir(cwd), `${rev1Id}.md`);
  assert.match(fs.readFileSync(rev1File, 'utf8'), /^playbook: true$/m, 'inherited fm carries marker');
  const idxLines1 = fs.readFileSync(indexFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(idxLines1.find((e) => e.id === rev1Id).playbook, true, 'inherited index row carries marker');

  // --no-playbook on a marker-bearing revise → cleared
  const r2 = runRevise(
    ['--original', rev1Id, '--project', 'rfc015', '--summary', 'rfc015 t4b rev2 clear', '--body', 'b3', '--scope', 'local', '--no-playbook'],
    cwd, home,
  );
  assert.equal(r2.code, 0, `clear revise exit: ${r2.stdout}\n${r2.stderr}`);
  const rev2Id = r2.json.id;
  assert.equal(r2.json.playbook_advisory, undefined, 'cleared revise has NO advisory');
  const rev2File = path.join(episodesDir(cwd), `${rev2Id}.md`);
  assert.ok(!/^playbook:/m.test(fs.readFileSync(rev2File, 'utf8')), '--no-playbook removes fm marker');
  const idxLines2 = fs.readFileSync(indexFile(cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(idxLines2.find((e) => e.id === rev2Id).playbook, undefined, '--no-playbook removes index marker');
});

// ===========================================================================
// Group 2: R2 advisory (3 legs)
// ===========================================================================

await t('t4_registered_true: declare chain, revise with marker → registered:true, NO suggested_entry, playbooks.json untouched', () => {
  const { cwd, home } = mkStore();
  // Plant a marker-bearing episode + a playbooks.json declaring its chain.
  const pbId = storePlaybook(cwd, home, 'rfc015 t4 orig');
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: pbId, mode: 'session_start' }] });
  const beforeSha = sha256(playbooksPath(cwd));
  // Revise the marker-bearing episode (no new flag — the marker inherits).
  const r = runRevise(
    ['--original', pbId, '--project', 'rfc015', '--summary', 'rfc015 t4 rev', '--body', 'b2', '--scope', 'local'],
    cwd, home,
  );
  assert.equal(r.code, 0, `exit: ${r.stdout}\n${r.stderr}`);
  assert.ok(r.json.playbook_advisory, 'advisory present');
  assert.equal(r.json.playbook_advisory.registered, true, 'declared → registered:true');
  assert.equal(r.json.playbook_advisory.suggested_entry, undefined, 'declared → NO suggested_entry');
  assert.match(r.json.playbook_advisory.note, /declared/, 'note names the declaration');
  // playbooks.json untouched (no registration, no write)
  assert.equal(sha256(playbooksPath(cwd)), beforeSha, 'playbooks.json byte-identical');
});

await t('t15b_advisory_degrades: corrupt playbooks.json + marker store → note + registered:false + exit 0 + file untouched', () => {
  const { cwd, home } = mkStore();
  // Plant a CORRUPT playbooks.json (unparseable).
  fs.mkdirSync(storeDir(cwd), { recursive: true });
  const corruptPath = playbooksPath(cwd);
  fs.writeFileSync(corruptPath, '{ not valid json');
  const beforeSha = sha256(corruptPath);
  // Marker-bearing store WITHOUT --register-playbook (advisory path)
  const r = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t15b', '--body', 'b', '--scope', 'local', '--playbook'],
    cwd, home,
  );
  assert.equal(r.code, 0, 'advisory path: exit 0 (fail-open by spec on the advisory leg)');
  assert.ok(r.json.playbook_advisory, 'advisory present even on corrupt file');
  assert.equal(r.json.playbook_advisory.registered, false, 'corrupt → not declared');
  assert.match(r.json.playbook_advisory.note, /playbooks\.json present but|unreadable/, 'note carries the parse reason');
  assert.equal(sha256(corruptPath), beforeSha, 'file untouched (advisory NEVER writes)');
});

await t('t16_empty_trigger: register on_demand for triggerless → succeeds + empty_triggers warn; build excludes it', () => {
  const { cwd, home } = mkStore();
  // Seed an episode WITH NO TRIGGERS (on_demand with empty effective triggers).
  // The store leg needs --register-playbook on_demand to fire the empty_triggers
  // warning at registration time.
  const r = runStore(
    [
      '--project', 'rfc015',
      '--category', 'lesson',
      '--summary', 'rfc015 t16 pb',
      '--body', 'b',
      '--scope', 'local',
      '--playbook',
      '--register-playbook', 'on_demand',
    ],
    cwd, home,
  );
  assert.equal(r.code, 0, `exit: ${r.stdout}\n${r.stderr}`);
  assert.equal(r.json.status, 'ok');
  // The episode is stored with marker + an advisory that warns empty_triggers.
  assert.ok(r.json.playbook_advisory, 'advisory present');
  // F3 (review r1): STRENGTHEN. The advisory must carry the empty_triggers
  // warning at write time (REQ-12) — the build-half assert below stays, but
  // the write-half is what tells the operator to add triggers before the
  // build silently excludes the entry.
  assert.equal(r.json.playbook_advisory.empty_triggers, true, 'advisory carries empty_triggers:true');
  assert.match(r.json.playbook_advisory.note, /empty_triggers/, 'advisory note names empty_triggers');
  assert.match(r.json.playbook_advisory.note, /no effective triggers/, 'note names the missing triggers');
  // playbooks.json was written
  const pb = readPlaybooks(cwd);
  assert.equal(pb.playbooks.length, 1);
  assert.equal(pb.playbooks[0].id, r.json.id);
  assert.equal(pb.playbooks[0].mode, 'on_demand');
  // Now build the trigger-index and verify the entry is excluded as empty_triggers.
  fs.rmSync(tiPath(cwd), { force: true });
  const build = run(EM_TRIGGER, ['--scope', 'local'], { cwd, home });
  assert.equal(build.code, 0, `build exit: ${build.stdout}\n${build.stderr}`);
  // The build_report lives in the trigger-index.json file (the on-disk
  // derived index), NOT in the stdout JSON of em-trigger-index.mjs.
  const ti = JSON.parse(fs.readFileSync(tiPath(cwd), 'utf8'));
  // The playbook was declared but has no triggers, so it must be excluded as empty_triggers.
  assert.equal(ti.build_report.playbooks.excluded.empty_triggers, 1, 'build excludes the triggerless on_demand as empty_triggers');
});

// ===========================================================================
// Group 3: R3 flag (6 legs)
// ===========================================================================

await t('t3_grammar_and_write: bare flag→session_start; absent file→skeleton; idempotent; invalid mode refused; contradiction refused', async () => {
  const { cwd, home } = mkStore();
  // No playbooks.json exists yet.
  assert.ok(!fs.existsSync(playbooksPath(cwd)), 'fixture absent');

  // (a) Bare --register-playbook defaults to session_start + skeleton created.
  const r1 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t3a', '--body', 'b', '--scope', 'local', '--playbook', '--register-playbook'],
    cwd, home,
  );
  assert.equal(r1.code, 0, `bare flag exit: ${r1.stdout}\n${r1.stderr}`);
  let pb = readPlaybooks(cwd);
  assert.equal(pb.schema_version, 1, 'skeleton schema_version 1');
  assert.equal(pb.playbooks.length, 1, 'one entry from skeleton');
  assert.equal(pb.playbooks[0].id, r1.json.id);
  assert.equal(pb.playbooks[0].mode, 'session_start', 'bare flag → session_start');

  // (b) Second store with a DIFFERENT summary → DIFFERENT id → new entry.
  const r1b = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t3b', '--body', 'b2', '--scope', 'local', '--playbook', '--register-playbook', 'on_demand'],
    cwd, home,
  );
  assert.equal(r1b.code, 0);
  pb = readPlaybooks(cwd);
  assert.equal(pb.playbooks.length, 2, 'second registration appends a new entry');

  // (c) Idempotent on the SAME id: re-register the ORIGINAL id via the lib
  //     directly. The upsert REPLACES the entry in place (mode updated if
  //     different), array size unchanged.
  const regLib = await import('../scripts/lib/playbook-registration.mjs');
  const r2 = regLib.registerPlaybook({ episodeId: r1.json.id, mode: 'session_start', localDataDir: storeDir(cwd) });
  assert.equal(r2.ok, true, `same-id upsert refused: ${JSON.stringify(r2)}`);
  pb = readPlaybooks(cwd);
  assert.equal(pb.playbooks.length, 2, 'idempotent upsert: array stays at 2 (same id → replace)');
  const upserted = pb.playbooks.find((e) => e.id === r1.json.id);
  assert.equal(upserted.mode, 'session_start', 'mode replaced with the new value');

  // (d) Invalid mode refused exit 1 (BEFORE any episode write).
  const r3 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t3d', '--body', 'b', '--scope', 'local', '--playbook', '--register-playbook', 'always'],
    cwd, home,
  );
  assert.equal(r3.code, 1, 'invalid mode refused (exit 1)');
  assert.match(r3.stdout, /session_start or on_demand/, 'message names the bound');

  // (e) Contradiction refused exit 1 — --register-playbook + --no-playbook
  const r4 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t3e', '--body', 'b', '--scope', 'local', '--no-playbook', '--register-playbook'],
    cwd, home,
  );
  assert.equal(r4.code, 1, 'contradiction refused (exit 1)');
  assert.match(r4.stdout, /contradictory/, 'message names the contradiction');
});

await t('t5_dual_caps: 32-entry refusal + idempotent at 32 + build-cap note', async () => {
  const { cwd, home } = mkStore();
  // Build a 32-entry playbooks.json (existing ids). Each needs an index row
  // so terminalOf can resolve them in any chain-shape check; here all 32 are
  // leaf entries.
  const ids = [];
  for (let i = 0; i < 32; i++) {
    ids.push(`20260726-000000-existing-${String(i).padStart(4, '0')}`);
  }
  writeIndex(cwd, ids.map((id) => row(id, { summary: `existing ${id}` })));
  writePlaybooks(cwd, { schema_version: 1, playbooks: ids.map((id) => ({ id, mode: 'session_start' })), bounds: { max_playbooks: 1 } });
  const beforeSha = sha256(playbooksPath(cwd));

  // (a) New id → refused, file byte-identical.
  const rNew = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t5 new', '--body', 'b', '--scope', 'local', '--playbook', '--register-playbook', 'session_start'],
    cwd, home,
  );
  assert.equal(rNew.code, 1, 'new id at 32-cap refused (exit 1)');
  assert.equal(rNew.json.code, 'playbooks-full', 'code = playbooks-full');
  assert.match(rNew.json.message, /32 entries/, 'message names the bound');
  assert.equal(sha256(playbooksPath(cwd)), beforeSha, 'file untouched on refusal');

  // (b) Idempotent upsert of an EXISTING id → succeeds, array stays at 32.
  //     Call registerPlaybook directly with one of the existing 32 ids.
  const targetId = ids[0];
  const regLib = await import('../scripts/lib/playbook-registration.mjs');
  const rIdem = regLib.registerPlaybook({ episodeId: targetId, mode: 'session_start', localDataDir: storeDir(cwd) });
  assert.equal(rIdem.ok, true, `idempotent at 32 ok: ${JSON.stringify(rIdem)}`);
  const pb2 = readPlaybooks(cwd);
  assert.equal(pb2.playbooks.length, 32, 'array stays at 32 (no new id)');

  // (c) session_start count > max_playbooks (1) → ok:true with build-cap note.
  assert.equal(rIdem.buildCapped, true, 'build-capped flag set on registration result');
});

await t('t8_no_flag_no_write: flagless store + revise + marker-only store → playbooks.json bytes identical', () => {
  const { cwd, home } = mkStore();
  // Plant a playbooks.json (this is the consent file we will NOT touch).
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: 'preexisting', mode: 'session_start' }] });
  const beforeSha = sha256(playbooksPath(cwd));
  const beforeSize = fs.statSync(playbooksPath(cwd)).size;

  // (a) flagless store: NO write to playbooks.json
  const r1 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t8a', '--body', 'b', '--scope', 'local'],
    cwd, home,
  );
  assert.equal(r1.code, 0);

  // (b) flagless revise
  const origId = storeBare(cwd, home, 'rfc015 t8b orig');
  const r2 = runRevise(
    ['--original', origId, '--project', 'rfc015', '--summary', 'rfc015 t8b rev', '--body', 'b2', '--scope', 'local'],
    cwd, home,
  );
  assert.equal(r2.code, 0);

  // (c) marker-only store (--playbook, NO --register-playbook)
  const r3 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t8c', '--body', 'b', '--scope', 'local', '--playbook'],
    cwd, home,
  );
  assert.equal(r3.code, 0);

  // Static half: the only playbooks.json write site is registerPlaybook.
  const libSrc = fs.readFileSync(PLAYBOOKS_REGISTRATION, 'utf8');
  assert.match(libSrc, /export function registerPlaybook/, 'single writer function exported');
  // Static check: no other module references a playbooks.json write surface
  for (const file of [EM_STORE, EM_REVISE]) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/playbooksPath|atomicWritePlaybooks/.test(src), `${path.basename(file)} does NOT reference the write surface`);
  }

  // Runtime half: file bytes identical across all three writes.
  assert.equal(sha256(playbooksPath(cwd)), beforeSha, 'playbooks.json SHA256 unchanged');
  assert.equal(fs.statSync(playbooksPath(cwd)).size, beforeSize, 'playbooks.json size unchanged');
});

await t('t9_scope_refusal: --scope global refused exit 1; global-store marker advisory names LOCAL project_store; global marker declared locally resolves registered:true', async () => {
  const { cwd, home } = mkStore();
  // (a) --scope global --register-playbook refused (B-3)
  const r1 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t9a', '--body', 'b', '--scope', 'global', '--playbook', '--register-playbook', 'session_start'],
    cwd, home,
  );
  assert.equal(r1.code, 1, 'global + --register-playbook refused');
  assert.match(r1.stdout, /local-scope/, 'message names the local-scope rule');

  // (b) Global-store marker write advisory names the LOCAL project_store.
  const r2 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t9b', '--body', 'b', '--scope', 'global', '--playbook'],
    cwd, home,
  );
  assert.equal(r2.code, 0, 'global marker store exit 0');
  assert.ok(r2.json.playbook_advisory, 'advisory present');
  const localStore = storeDir(cwd);
  assert.equal(r2.json.playbook_advisory.project_store, localStore, 'advisory project_store = local cwd store');

  // (c) F5 (review r1): global-store marker whose chain is declared locally
  // → advisory registered:true. The episode's own store dir (global) is the
  // INDEX source for terminal resolution (so the marker finds its GLOBAL
  // terminal), while project_store stays the local cwd path. This is the
  // v15 canonical layout: episode lives global, declared local.
  const gid = r2.json.id
  writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: gid, mode: 'session_start' }] });
  // Re-run a no-op store to refresh the advisory (the marker is on the existing
  // episode, so we just need to fetch a fresh advisory via buildPlaybookAdvisory).
  // The cleanest way is to import the lib directly.
  const regLib = await import('../scripts/lib/playbook-registration.mjs');
  const adv = regLib.buildPlaybookAdvisory({
    episodeId: gid,
    localDataDir: localStore,
    episodeStoreDir: path.join(home, '.episodic-memory'),
    effectiveTriggers: [],
    mode: 'session_start',
  });
  assert.equal(adv.registered, true, 'global marker declared locally → registered:true (F5)');
  assert.equal(adv.project_store, localStore, 'project_store still the local store (B-3)');
});

await t('t15_corrupt_fail_closed: unparseable + schema-invalid refusal; file byte-identical', () => {
  const { cwd, home } = mkStore();
  fs.mkdirSync(storeDir(cwd), { recursive: true });

  // (a) Unparseable JSON
  fs.writeFileSync(playbooksPath(cwd), '{ not json');
  const aBefore = sha256(playbooksPath(cwd));
  const r1 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t15a', '--body', 'b', '--scope', 'local', '--playbook', '--register-playbook', 'session_start'],
    cwd, home,
  );
  assert.equal(r1.code, 1, 'unparseable refused');
  assert.equal(r1.json.code, 'playbooks-parse', 'code = playbooks-parse');
  assert.match(r1.json.message, /playbooks\.json/, 'message names playbooks.json');
  assert.equal(sha256(playbooksPath(cwd)), aBefore, 'file byte-identical');

  // (b) Schema-invalid JSON (extra unknown top-level key)
  fs.writeFileSync(playbooksPath(cwd), JSON.stringify({ schema_version: 1, playbooks: [], bogus: true }));
  const bBefore = sha256(playbooksPath(cwd));
  const r2 = runStore(
    ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t15b', '--body', 'b', '--scope', 'local', '--playbook', '--register-playbook', 'session_start'],
    cwd, home,
  );
  assert.equal(r2.code, 1, 'schema-invalid refused');
  assert.equal(r2.json.code, 'playbooks-invalid', 'code = playbooks-invalid');
  assert.match(r2.json.message, /playbooks\.json/, 'message names playbooks.json');
  assert.equal(sha256(playbooksPath(cwd)), bBefore, 'file byte-identical');
});

await t('t17_concurrent_survive: two concurrent --register-playbook invocations → BOTH ids survive', async () => {
  const { cwd, home } = mkStore();
  // Two concurrent em-store invocations, each with its own
  // --register-playbook session_start. Each em-store process acquires the
  // store-write lock for the local store; the lock serializes the two
  // registrations exactly the way the NSP G1 concurrency contract pins
  // (registerPlaybook runs INSIDE the held lock; the caller holds it; no
  // new lock site). With the lock, BOTH ids survive; without it, the
  // last rename wins and one entry is silently lost.
  const args1 = ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t17 one', '--body', 'b', '--scope', 'local', '--playbook', '--register-playbook', 'session_start'];
  const args2 = ['--project', 'rfc015', '--category', 'decision', '--summary', 'rfc015 t17 two', '--body', 'b', '--scope', 'local', '--playbook', '--register-playbook', 'session_start'];

  const [r1, r2] = await Promise.all([
    new Promise((resolve, reject) => {
      const p = spawn('node', [EM_STORE, ...args1], {
        cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
      });
      let out = '', err = '';
      p.stdout.on('data', (d) => out += d);
      p.stderr.on('data', (d) => err += d);
      p.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
      p.on('error', reject);
    }),
    new Promise((resolve, reject) => {
      const p = spawn('node', [EM_STORE, ...args2], {
        cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
      });
      let out = '', err = '';
      p.stdout.on('data', (d) => out += d);
      p.stderr.on('data', (d) => err += d);
      p.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
      p.on('error', reject);
    }),
  ]);

  let j1 = null, j2 = null;
  try { j1 = JSON.parse(r1.stdout); } catch {}
  try { j2 = JSON.parse(r2.stdout); } catch {}
  assert.equal(r1.code, 0, `child1 exit: ${r1.stdout}\n${r1.stderr}`);
  assert.equal(r2.code, 0, `child2 exit: ${r2.stdout}\n${r2.stderr}`);
  assert.ok(j1 && j1.status === 'ok' && j1.id, `child1 ok: ${r1.stdout}`);
  assert.ok(j2 && j2.status === 'ok' && j2.id, `child2 ok: ${r2.stdout}`);
  const id1 = j1.id, id2 = j2.id;
  assert.notEqual(id1, id2, 'distinct ids');

  // BOTH ids present in the final playbooks.json.
  const pb = readPlaybooks(cwd);
  assert.equal(pb.playbooks.length, 2, `two entries survive, got ${pb.playbooks.length}`);
  const gotIds = pb.playbooks.map((e) => e.id).sort();
  assert.deepEqual(gotIds, [id1, id2].sort(), `both ids present, got ${gotIds.join(',')}`);
  // File schema-valid.
  assert.equal(pb.schema_version, 1);
  assert.equal(Array.isArray(pb.playbooks), true);
  assert.ok(pb.playbooks.every((e) => typeof e.id === 'string' && (e.mode === 'session_start' || e.mode === 'on_demand')), 'every entry shape valid');
});

// t9c (F5): global marker declared locally → registered:true (now part of t9
// above). The t9 leg was extended in place rather than split.

// F4 (review r1): em-revise --register-playbook on a global original
// (default scope=inherit) is refused PRE-WRITE — exit 1, code
// playbooks-scope, no revision landed. Count the global store's episode
// files before + after; the count must be unchanged.
await t('t17b_revise_global_original_register_refused: pre-write scope refusal (F4)', () => {
  const { cwd, home } = mkStore();
  // Seed an original episode IN THE GLOBAL STORE so scope=inherit resolves
  // to GLOBAL_DIR. The episode + index row live there.
  const gid = '20260726-013000-t17b-g-original-abcd';
  const globalEpDir = path.join(home, '.episodic-memory', 'episodes');
  const globalIndex = path.join(home, '.episodic-memory', 'index.jsonl');
  fs.mkdirSync(globalEpDir, { recursive: true });
  fs.writeFileSync(path.join(globalEpDir, `${gid}.md`), [
    '---', `id: ${gid}`, 'date: 2026-07-26', 'time: "01:30"', 'project: rfc015', 'category: decision',
    'status: active', 'tags: []', 'summary: t17b global orig',
    '---', '', '# t17b global orig', '', 'body', '',
  ].join('\n'));
  fs.appendFileSync(globalIndex, JSON.stringify({
    id: gid, date: '2026-07-26', time: '01:30', project: 'rfc015', category: 'decision',
    status: 'active', supersedes: null, tags: [], summary: 't17b global orig',
  }) + '\n');

  // Count global episode files BEFORE the refused revise.
  const beforeFiles = fs.readdirSync(globalEpDir).filter((f) => f.endsWith('.md')).length;
  const beforeIndexRows = fs.readFileSync(globalIndex, 'utf8').split('\n').filter(Boolean).length;

  // Run the refused revise. Default --scope=inherit → dataDir=GLOBAL_DIR →
  // --register-playbook refused pre-write (F4).
  const r = runRevise(
    [
      '--original', gid,
      '--project', 'rfc015',
      '--summary', 'rfc015 t17b refused rev',
      '--body', 'b2',
      '--register-playbook', 'session_start',
    ],
    cwd, home,
  );
  assert.equal(r.code, 1, 'pre-write scope refusal exit 1');
  assert.equal(r.json.code, 'playbooks-scope', 'code = playbooks-scope');
  assert.match(r.json.message, /local-scope/, 'message names the local-scope rule');
  // No stored_id (pre-write refusal — nothing stored).
  assert.equal(r.json.stored_id, undefined, 'no stored_id on pre-write refusal (F7 asymmetry resolved)');

  // Count AFTER: global episode count unchanged.
  const afterFiles = fs.readdirSync(globalEpDir).filter((f) => f.endsWith('.md')).length;
  const afterIndexRows = fs.readFileSync(globalIndex, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(afterFiles, beforeFiles, `global episode file count unchanged (pre=${beforeFiles}, post=${afterFiles})`);
  assert.equal(afterIndexRows, beforeIndexRows, `global index row count unchanged (pre=${beforeIndexRows}, post=${afterIndexRows})`);
});

// ===========================================================================
// Group 4: R5 doctor (2 legs)
// ===========================================================================

await t('t7_four_checks_fire: seeded fixtures → each id warn; cyclic leg terminates', () => {
  const { cwd, home } = mkStore();

  // Cyclic chain (a <-> b mutual supersedes); em-store marker on `a`.
  const cycA = '20260726-000000-cyc-a-0001';
  const cycB = '20260726-000000-cyc-b-0001';
  writeIndex(cwd, [
    row(cycA, { supersedes: cycB, playbook: true, summary: 'cyc a' }),
    row(cycB, { supersedes: cycA, summary: 'cyc b' }),
  ]);
  fs.mkdirSync(episodesDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(episodesDir(cwd), `${cycA}.md`), [
    '---', `id: ${cycA}`, 'date: 2026-07-26', 'time: "00:00"', 'project: rfc015', 'category: lesson',
    'status: active', 'tags: []', 'summary: cyc a', 'playbook: true',
    '---', '', '# cyc a', '', 'body', '',
  ].join('\n'));
  fs.writeFileSync(path.join(episodesDir(cwd), `${cycB}.md`), [
    '---', `id: ${cycB}`, 'date: 2026-07-26', 'time: "00:00"', 'project: rfc015', 'category: lesson',
    'status: active', 'tags: []', 'summary: cyc b',
    '---', '', '# cyc b', '', 'body', '',
  ].join('\n'));

  const r = runDoctor(['--scope', 'local'], cwd, home);
  assert.equal(r.code, 0, `cyclic doctor exit: ${r.stdout}\n${r.stderr}`);
  const checks = r.json.checks.filter((c) => c.id.startsWith('playbook'));
  const ids = checks.map((c) => `${c.id}:${c.level}`).sort();
  // We expect FOUR distinct check ids:
  //   playbook-unregistered   warn (cycA is marker-bearing, undeclared)
  //   playbook-registration-health   ok (no declared playbooks in this store)
  //   playbook-content-substitution  ok (no declared playbooks)
  //   playbook-global-file   ok (no global file)
  assert.ok(ids.includes('playbook-unregistered:warn'), `playbook-unregistered:warn present, got ${ids.join(',')}`);
  assert.ok(ids.includes('playbook-registration-health:ok'), 'health:ok');
  assert.ok(ids.includes('playbook-content-substitution:ok'), 'substitution:ok');
  assert.ok(ids.includes('playbook-global-file:ok'), 'global-file:ok');
  // No `fix` key on any playbook-* check.
  for (const c of checks) assert.equal(c.fix, undefined, `${c.id} carries NO fix key`);
});

await t('t7b_clean_silent: clean fixture → all four playbook-* ids present at ok (no warns)', () => {
  const { cwd, home } = mkStore();
  // Bare episode (NO marker) to make the store non-empty.
  storeBare(cwd, home, 'rfc015 t7b clean');
  const r = runDoctor(['--scope', 'all'], cwd, home);
  assert.equal(r.code, 0, `clean doctor exit: ${r.stdout}\n${r.stderr}`);
  const playbookChecks = r.json.checks.filter((c) => c.id.startsWith('playbook'));
  const requiredIds = ['playbook-unregistered', 'playbook-registration-health', 'playbook-content-substitution', 'playbook-global-file'];
  for (const id of requiredIds) {
    const check = playbookChecks.find((c) => c.id === id);
    assert.ok(check, `${id} present`);
    assert.equal(check.level, 'ok', `${id} silent (ok) on a clean fixture, got ${check.level}`);
    assert.equal(check.fix, undefined, `${id} carries NO fix key`);
  }
});

// F1 (review r1): em-doctor --all-projects must NOT crash with a TDZ
// ReferenceError. The per-store check references `registeredStores` (which
// is now hoisted above the scan); without the hoist the first --all-projects
// invocation crashed at collectDeclarationTerminalSet. This leg asserts
// (a) exit is either 0 or 1 (never a crash signal), (b) stdout is valid
// JSON (parseable), (c) the four playbook check ids are present and
// behave as on a non-all-projects fixture (both polarities NOT required —
// crash absence + valid JSON is the assertion).
await t('t7c_all_projects_no_tdz: em-doctor --all-projects runs without TDZ crash (F1)', () => {
  const { cwd, home } = mkStore();
  storeBare(cwd, home, 'rfc015 t7c clean');
  const r = runDoctor(['--scope', 'all', '--all-projects'], cwd, home);
  // Exit 0 (healthy) or 1 (warns) — BOTH are valid; a crash would surface
  // as a non-zero exit from Node's ReferenceError before JSON is emitted.
  assert.ok(r.code === 0 || r.code === 1, `exit in {0,1}, got ${r.code}: ${r.stdout.slice(0, 200)}\n${r.stderr.slice(0, 400)}`);
  // Stdout IS valid JSON (no ReferenceError text leaked into stdout).
  assert.ok(r.json && typeof r.json === 'object', 'stdout is valid JSON');
  assert.ok(Array.isArray(r.json.checks), 'JSON has checks array');
  // No TDZ ReferenceError text leaked.
  assert.ok(!/ReferenceError/.test(r.stdout) && !/ReferenceError/.test(r.stderr), 'no ReferenceError in output');
  // The four playbook check ids still fire.
  const playbookChecks = r.json.checks.filter((c) => c.id.startsWith('playbook'));
  const requiredIds = ['playbook-unregistered', 'playbook-registration-health', 'playbook-content-substitution', 'playbook-global-file'];
  for (const id of requiredIds) {
    const check = playbookChecks.find((c) => c.id === id);
    assert.ok(check, `${id} present under --all-projects`);
  }
});

// F2 (review r1): global-store marker episode declared in the cwd-local
// playbooks.json → no false `playbook-unregistered` warn (and no
// `unresolvable` failure on the health check). The v15 canonical layout.
// Also: the inverse — global marker NOT declared → playbook-unregistered
// fires once. Both polarities.
await t('t7d_global_marker_declared_locally: cross-store resolution parity (F2)', () => {
  // (a) Declare locally → silent
  {
    const { cwd, home } = mkStore();
    // A global-store marker episode (v15 canonical layout).
    const gid = '20260726-013000-t7d-g-pb-abcd';
    const gDir = path.join(home, '.episodic-memory');
    const gEpDir = path.join(gDir, 'episodes');
    fs.mkdirSync(gEpDir, { recursive: true });
    fs.writeFileSync(path.join(gEpDir, `${gid}.md`), [
      '---', `id: ${gid}`, 'date: 2026-07-26', 'time: "01:30"', 'project: rfc015', 'category: lesson',
      'status: active', 'tags: []', 'summary: t7d g pb', 'playbook: true',
      '---', '', '# t7d g pb', '', 'body', '',
    ].join('\n'));
    fs.writeFileSync(path.join(gDir, 'index.jsonl'), JSON.stringify({
      id: gid, date: '2026-07-26', time: '01:30', project: 'rfc015', category: 'lesson',
      status: 'active', supersedes: null, tags: [], summary: 't7d g pb', playbook: true,
    }) + '\n');
    // Declare the chain LOCALLY (cwd-local playbooks.json).
    writePlaybooks(cwd, { schema_version: 1, playbooks: [{ id: gid, mode: 'session_start' }] });
    // Run doctor --scope all on the fixture.
    const r = runDoctor(['--scope', 'all'], cwd, home);
    assert.equal(r.code, 0, `declared doctor exit: ${r.stdout}\n${r.stderr}`);
    const playbookChecks = r.json.checks.filter((c) => c.id.startsWith('playbook'));
    // The four polarities:
    const ureg = playbookChecks.find((c) => c.id === 'playbook-unregistered');
    assert.equal(ureg.level, 'ok', `playbook-unregistered silent when declared locally, got ${ureg.level}; message: ${ureg.message}`);
    const health = playbookChecks.find((c) => c.id === 'playbook-registration-health');
    assert.equal(health.level, 'ok', `playbook-registration-health silent when declared resolves, got ${health.level}; message: ${health.message}`);
  }

  // (b) NOT declared → warn (the inverse polarity). F9 (review r2): the
  // marker lives in the GLOBAL store; the GLOBAL scan sees it (warn);
  // the LOCAL scan does NOT (ok, because F9 scopes the marker scan to
  // the scanned store's dataDir rows — a marker in another store is not
  // a finding for a scan that doesn't touch that store).
  {
    const { cwd, home } = mkStore();
    const gid = '20260726-013000-t7d-g-undec-abcd';
    const gDir = path.join(home, '.episodic-memory');
    const gEpDir = path.join(gDir, 'episodes');
    fs.mkdirSync(gEpDir, { recursive: true });
    fs.writeFileSync(path.join(gEpDir, `${gid}.md`), [
      '---', `id: ${gid}`, 'date: 2026-07-26', 'time: "01:30"', 'project: rfc015', 'category: lesson',
      'status: active', 'tags: []', 'summary: t7d g undec', 'playbook: true',
      '---', '', '# t7d g undec', '', 'body', '',
    ].join('\n'));
    fs.writeFileSync(path.join(gDir, 'index.jsonl'), JSON.stringify({
      id: gid, date: '2026-07-26', time: '01:30', project: 'rfc015', category: 'lesson',
      status: 'active', supersedes: null, tags: [], summary: 't7d g undec', playbook: true,
    }) + '\n');
    // No declaration — the global scan warns; the local scan is silent.
    const r = runDoctor(['--scope', 'all'], cwd, home);
    const playbookChecks = r.json.checks.filter((c) => c.id.startsWith('playbook'));
    const uregLocal = playbookChecks.find((c) => c.id === 'playbook-unregistered' && c.scope === 'local');
    const uregGlobal = playbookChecks.find((c) => c.id === 'playbook-unregistered' && c.scope === 'global');
    assert.ok(uregLocal, 'local-scope playbook-unregistered row present');
    assert.ok(uregGlobal, 'global-scope playbook-unregistered row present');
    assert.equal(uregLocal.level, 'ok', `local scan silent on marker-unreachable, got ${uregLocal.level}`);
    assert.equal(uregGlobal.level, 'warn', `global scan warns on undeclared marker, got ${uregGlobal.level}`);
    assert.match(uregGlobal.message, /marker-bearing playbook terminal\(s\) not declared/, 'global warn names the failure class');
    // The id list lives under verbose `episode_ids`; re-run with --verbose
    // to pin it. This protects against a future regression that drops the
    // id from the diagnostic payload entirely.
    const rV = runDoctor(['--scope', 'global', '--verbose'], cwd, home);
    const uregV = rV.json.checks.find((c) => c.id === 'playbook-unregistered');
    assert.ok(Array.isArray(uregV.episode_ids) && uregV.episode_ids.includes(gid), `verbose episode_ids includes ${gid}`);
  }
});

// F9 (review r2): the marker SCAN must scope to the scanned store's dataDir
// rows. Fixture: cwd-local store holds an UNDECLARED marker episode; the
// GLOBAL store holds none. The cwd-local scan emits exactly ONE warn; the
// global scan emits ZERO warns (the cwd-local marker is unreachable from
// the global scanned store per RFC:99). Pre-F9 this test failed because
// the marker scan over-merged and produced a warn in EVERY scanned store.
await t('t7e_marker_scan_scoped_to_scanned_store: cwd marker undeclared, second store silent (F9)', () => {
  const { cwd, home } = mkStore();
  // (a) Cwd-local store: a marker-bearing, undeclared playbook episode.
  const lid = '20260726-013000-t7e-l-pb-undec-abcd';
  fs.mkdirSync(episodesDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(episodesDir(cwd), `${lid}.md`), [
    '---', `id: ${lid}`, 'date: 2026-07-26', 'time: "01:30"', 'project: rfc015', 'category: lesson',
    'status: active', 'tags: []', 'summary: t7e l pb undec', 'playbook: true',
    '---', '', '# t7e l pb undec', '', 'body', '',
  ].join('\n'));
  fs.appendFileSync(indexFile(cwd), JSON.stringify({
    id: lid, date: '2026-07-26', time: '01:30', project: 'rfc015', category: 'lesson',
    status: 'active', supersedes: null, tags: [], summary: 't7e l pb undec', playbook: true,
  }) + '\n');
  // No declaration in cwd-local playbooks.json (the marker is intentionally undeclared).
  // The global store is empty (no marker episodes there).
  const r = runDoctor(['--scope', 'all'], cwd, home);
  const playbookChecks = r.json.checks.filter((c) => c.id.startsWith('playbook'));
  const uregLocal = playbookChecks.find((c) => c.id === 'playbook-unregistered' && c.scope === 'local');
  const uregGlobal = playbookChecks.find((c) => c.id === 'playbook-unregistered' && c.scope === 'global');
  assert.ok(uregLocal, 'local-scope playbook-unregistered row present');
  assert.ok(uregGlobal, 'global-scope playbook-unregistered row present');
  assert.equal(uregLocal.level, 'warn', `cwd-local scan warns on its own undeclared marker, got ${uregLocal.level}`);
  assert.equal(uregGlobal.level, 'ok', `global scan silent (marker unreachable from scanned store), got ${uregGlobal.level}`);
  // The cwd-local scan warns EXACTLY once (the single marker, lid).
  const rV = runDoctor(['--scope', 'local', '--verbose'], cwd, home);
  const uregV = rV.json.checks.find((c) => c.id === 'playbook-unregistered');
  assert.ok(Array.isArray(uregV.episode_ids), 'cwd-local verbose episode_ids is an array');
  assert.equal(uregV.episode_ids.length, 1, `cwd-local scan warns EXACTLY once, got ${uregV.episode_ids.length}`);
  assert.equal(uregV.episode_ids[0], lid, 'cwd-local warn names the lid id');
});

// ===========================================================================
// Done
// ===========================================================================
console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);