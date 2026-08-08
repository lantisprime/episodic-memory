/**
 * test-history-walk.mjs — RFC-009 P1a S5: em-search --history multi-parent walk (REQ-14).
 *
 * The walk follows inverted `supersedes` (existing), the scalar `superseded_by`, and a
 * `consolidates` successor, cycle-safe. Single-supersedes chains stay byte-identical.
 *
 * #634b anchor fix: the backward walk collects the whole SPINE (requested id ... root), not just
 * root, and the forward walk resumes FROM the requested id with `visited` seeded by the entire
 * spine. This guarantees the requested id is always present in its own history and that a
 * cyclic/contradictory back-edge into the spine cannot re-splice a duplicate (audit F1). A
 * supersedes FORK *beyond* the anchor (what supersedes/succeeds a node forward of the requested
 * id) stays CHARACTERIZED — last-writer-wins, deferred, relates #621.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const EM_SEARCH = path.join(REPO, 'scripts/em-search.mjs');
const EM_REBUILD = path.join(REPO, 'scripts/em-rebuild-index.mjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// No-duplicate-ids invariant (audit F1): a chain must never repeat an id — the
// spine-seeded visited-set is what guarantees this once the forward walk can
// resume from a non-root anchor.
function assertNoDupIds(ids, label) {
  assert.equal(new Set(ids).size, ids.length, `${label}: chain has duplicate ids ${JSON.stringify(ids)}`);
}

// episodes: [{id, supersedes?, superseded_by?, consolidates?:[ids]}]
function mkStore(episodes) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cathist-')));
  const epDir = path.join(cwd, '.episodic-memory', 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  for (const ep of episodes) {
    const lines = ['---', `id: ${ep.id}`, 'date: 2026-07-06', 'time: "00:00"', 'project: fx', 'category: lesson', 'status: active'];
    if (ep.supersedes) lines.push(`supersedes: ${ep.supersedes}`);
    if (ep.superseded_by) lines.push(`superseded_by: ${ep.superseded_by}`);
    if (ep.consolidates) lines.push(`consolidates: [${ep.consolidates.join(', ')}]`);
    lines.push('tags: []', `summary: ${ep.id}`, '---', '', '# x', '', 'body', '');
    fs.writeFileSync(path.join(epDir, `${ep.id}.md`), lines.join('\n'));
  }
  spawnSync('node', [EM_REBUILD, '--scope', 'local'], { cwd, encoding: 'utf8' });
  return cwd;
}
function history(cwd, id) {
  const r = spawnSync('node', [EM_SEARCH, '--history', id, '--scope', 'local'], { cwd, encoding: 'utf8' });
  return JSON.parse(r.stdout.trim());
}

t('testHistoryFollowsSupersededBy', () => {
  const cwd = mkStore([{ id: 'A', superseded_by: 'B' }, { id: 'B' }]);
  const r = history(cwd, 'A');
  assert.deepEqual(r.chain.map((e) => e.id), ['A', 'B'], 'follows the superseded_by edge forward');
});

t('testHistorySurfacesConsolidatesSuccessor', () => {
  const cwd = mkStore([{ id: 'M1' }, { id: 'C', consolidates: ['M1'] }]);
  const r = history(cwd, 'M1');
  assert.deepEqual(r.chain.map((e) => e.id), ['M1', 'C'], 'surfaces the consolidates successor');
});

t('testHistorySingleSupersedesUnchanged', () => {
  // root ← c1 ← c2 via supersedes; byte-identical to the pre-change linear walk.
  const cwd = mkStore([{ id: 'root' }, { id: 'c1', supersedes: 'root' }, { id: 'c2', supersedes: 'c1' }]);
  const r = history(cwd, 'root');
  assert.deepEqual(r.chain.map((e) => e.id), ['root', 'c1', 'c2']);
  // querying mid-chain still resolves the root then walks forward
  const r2 = history(cwd, 'c1');
  assert.deepEqual(r2.chain.map((e) => e.id), ['root', 'c1', 'c2']);
});

t('testHistorySupersedesForkCharacterized', () => {
  // root superseded by BOTH b and c (fork immediately below root). #634b anchors the walk at the
  // REQUESTED id: querying either fork branch member returns THAT member's own line — the
  // requested id is always present in its own history (previously it could be entirely absent
  // when the forward-from-root walk happened to surface the OTHER branch). Fork selection BEYOND
  // the anchor stays characterized (last-writer-wins, deferred, relates #621) — not asserted here.
  const cwd = mkStore([{ id: 'root' }, { id: 'b', supersedes: 'root' }, { id: 'c', supersedes: 'root' }]);
  for (const branch of ['b', 'c']) {
    const r = history(cwd, branch);
    const ids = r.chain.map((e) => e.id);
    assert.ok(ids.includes(branch), `history(${branch}) contains the requested id itself (#634b invariant)`);
    assert.equal(ids[0], 'root', `history(${branch}) is anchored at root`);
    assertNoDupIds(ids, `history(${branch})`);
  }
});

t('testHistorySpineSeededVisitedPreventsDuplicate', () => {
  // root <- c1 <- c2 via supersedes, PLUS a contradictory c2.superseded_by = 'c1' back-edge (c2's
  // own parent, already on the spine). Queried from the MIDDLE of the spine ('c1'): the forward
  // walk starts at c1 (not root), discovers c2 via supersedes, then hits the contradictory
  // back-edge to c1. Seeding `visited` with the WHOLE spine (not just root, audit F1) is what
  // stops this from re-pushing c1 and duplicating it in `chain` — seeding root only would have
  // let this contradiction re-splice c1.
  const cwd = mkStore([
    { id: 'root' },
    { id: 'c1', supersedes: 'root' },
    { id: 'c2', supersedes: 'c1', superseded_by: 'c1' },
  ]);
  const r = history(cwd, 'c1');
  const ids = r.chain.map((e) => e.id);
  assert.deepEqual(ids, ['root', 'c1', 'c2'], 'spine + forward discovery, no re-splice');
  assertNoDupIds(ids, 'history(c1) with contradictory back-edge');
});

t('testHistoryCycleSafe', () => {
  // A superseded_by B, B superseded_by A → a cycle. The visited Set must terminate the walk.
  const cwd = mkStore([{ id: 'A', superseded_by: 'B' }, { id: 'B', superseded_by: 'A' }]);
  const r = history(cwd, 'A');
  assert.ok(r.chain.length <= 2, 'cycle terminates without repeating');
  assert.equal(r.chain[0].id, 'A');
});

t('testHistoryMutualSupersedesCycleTerminates', () => {
  // Corrupt store: a supersedes b, b supersedes a (mutual cycle on the BACKWARD supersedes edge —
  // no root exists). Pre-fix the spine-collection walk had no visited-set and would re-visit a/b
  // forever; the fix seeds a spineVisited Set so it breaks gracefully (truncation, matching the
  // forward walk's posture) instead of hanging.
  const cwd = mkStore([{ id: 'a', supersedes: 'b' }, { id: 'b', supersedes: 'a' }]);
  const r = history(cwd, 'a');
  assert.equal(r.status, 'ok');
  const ids = r.chain.map((e) => e.id);
  assertNoDupIds(ids, 'history(a) with mutual supersedes cycle');
  assert.ok(ids.length <= 2, 'cycle terminates without unbounded growth');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
