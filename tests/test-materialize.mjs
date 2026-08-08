/**
 * test-materialize.mjs — em-search --materialize (#634a).
 *
 * --materialize composes with --read <id> (never ambiguous — the anchor is resolved by exact id)
 * or with a filter query IFF the PRE-`--limit` filtered result set has exactly one member (audit
 * F3) — otherwise a typed `materialize-ambiguous` error envelope lists every pre-limit candidate.
 * On success it walks backward via the scalar `supersedes` edge from the anchor to root
 * (archived-aware, same live+archived merge as --history), reverses to root->terminal order, and
 * concatenates full bodies with a `<!-- id | summary -->` provenance delimiter.
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

// Mirrors the exact frontmatter+body construction em-search reads back (split on
// '---', slice(2).join('---').trim()) so expected body_len/content can be computed
// from the fixture spec directly, without re-parsing the written file.
function renderBody(ep) {
  return `# ${ep.id}\n\n${ep.body ?? `body-${ep.id}`}`;
}

// episodes: [{id, supersedes?, superseded_by?, summary?, body?, status?, archived?}]
// `archived: true` writes the episode to archived/ + archived-index.jsonl instead of
// episodes/ + index.jsonl (the em-prune / em-consolidate --fold-superseded shape).
function mkStore(episodes) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catmat-')));
  const dataDir = path.join(cwd, '.episodic-memory');
  const epDir = path.join(dataDir, 'episodes');
  fs.mkdirSync(epDir, { recursive: true });
  const archivedRows = [];
  for (const ep of episodes) {
    const summary = ep.summary ?? ep.id;
    const lines = ['---', `id: ${ep.id}`, 'date: 2026-07-06', 'time: "00:00"', 'project: fx', 'category: lesson', `status: ${ep.status ?? 'active'}`];
    if (ep.supersedes) lines.push(`supersedes: ${ep.supersedes}`);
    if (ep.superseded_by) lines.push(`superseded_by: ${ep.superseded_by}`);
    lines.push('tags: []', `summary: ${summary}`, '---', '', renderBody(ep), '');
    const targetDir = ep.archived ? path.join(dataDir, 'archived') : epDir;
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, `${ep.id}.md`), lines.join('\n'));
    if (ep.archived) {
      archivedRows.push({
        id: ep.id, date: '2026-07-06', time: '00:00', project: 'fx', category: 'lesson',
        status: ep.status ?? 'active',
        ...(ep.supersedes ? { supersedes: ep.supersedes } : {}),
        ...(ep.superseded_by ? { superseded_by: ep.superseded_by } : {}),
        tags: [], summary, access_count: 0,
      });
    }
  }
  spawnSync('node', [EM_REBUILD, '--scope', 'local'], { cwd, encoding: 'utf8' });
  if (archivedRows.length) {
    fs.writeFileSync(path.join(dataDir, 'archived-index.jsonl'), archivedRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return cwd;
}

function materialize(cwd, args) {
  const r = spawnSync('node', [EM_SEARCH, ...args, '--scope', 'local'], { cwd, encoding: 'utf8' });
  if (!r.stdout || !r.stdout.trim()) throw new Error(`no stdout (status ${r.status}); stderr: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

// (a) full+delta chain materializes root->terminal; body contains both bodies in order; members
// metadata correct (body_len matches the exact rendered body text).
t('materialize::readAnchorFullPlusDeltaChain', () => {
  const specs = [
    { id: 'v1', body: 'ROOT-BODY-TEXT' },
    { id: 'v2', supersedes: 'v1', body: 'DELTA-BODY-TEXT' },
  ];
  const cwd = mkStore(specs);
  const r = materialize(cwd, ['--read', 'v2', '--materialize']);
  assert.equal(r.status, 'ok');
  assert.equal(r.terminal_id, 'v2');
  assert.equal(r.count, 2);
  assert.deepEqual(r.members.map((m) => m.id), ['v1', 'v2']);
  assert.equal(r.members[0].body_len, renderBody(specs[0]).length, 'v1 body_len matches rendered body');
  assert.equal(r.members[1].body_len, renderBody(specs[1]).length, 'v2 body_len matches rendered body');
  const iRoot = r.body.indexOf('ROOT-BODY-TEXT');
  const iDelta = r.body.indexOf('DELTA-BODY-TEXT');
  assert.ok(iRoot >= 0 && iDelta >= 0 && iRoot < iDelta, 'body contains both bodies, root before terminal');
});

// (b) fork fixture — anchored via --read on branch-A member returns ONLY A's spine (the
// tombstone branch is absent, both from members and from body).
t('materialize::forkAnchorReturnsOnlyOwnBranch', () => {
  const cwd = mkStore([
    { id: 'root', body: 'ROOT-BODY' },
    { id: 'a', supersedes: 'root', body: 'BRANCH-A-BODY' },
    { id: 'tombstone', supersedes: 'root', body: 'BRANCH-B-TOMBSTONE-BODY' },
  ]);
  const r = materialize(cwd, ['--read', 'a', '--materialize']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.members.map((m) => m.id), ['root', 'a'], 'only the A branch spine, tombstone absent');
  assert.ok(!r.body.includes('BRANCH-B-TOMBSTONE-BODY'), 'tombstone branch body never appears');
});

// (c) archived intermediate member resolves body from archived/ and is flagged; the live root and
// live terminal are not.
t('materialize::archivedIntermediateResolvesFromArchivedDir', () => {
  const cwd = mkStore([
    { id: 'root', body: 'ROOT-LIVE-BODY' },
    { id: 'mid', supersedes: 'root', body: 'MID-ARCHIVED-BODY', archived: true },
    { id: 'term', supersedes: 'mid', body: 'TERM-LIVE-BODY' },
  ]);
  const r = materialize(cwd, ['--read', 'term', '--materialize']);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.members.map((m) => m.id), ['root', 'mid', 'term']);
  assert.equal(r.members[1].archived, true, 'archived member flagged');
  assert.ok(!('archived' in r.members[0]), 'live root not flagged archived');
  assert.ok(!('archived' in r.members[2]), 'live terminal not flagged archived');
  assert.ok(r.body.includes('MID-ARCHIVED-BODY'), 'archived body resolved from archived/ into the concatenation');
});

// (d) ambiguity — 2 active matches + --limit 1 STILL errors materialize-ambiguous listing both
// ids (pins the PRE-limit check: --limit must not mask the true candidate count).
t('materialize::ambiguousFilterPreLimitEvenWithLimit1', () => {
  const cwd = mkStore([
    { id: 'alpha', body: 'ALPHA-BODY' },
    { id: 'beta', body: 'BETA-BODY' },
  ]);
  const r = materialize(cwd, ['--category', 'lesson', '--materialize', '--limit', '1']);
  assert.equal(r.status, 'error');
  assert.equal(r.code, 'materialize-ambiguous');
  assert.deepEqual(r.matches.map((m) => m.id).sort(), ['alpha', 'beta']);
});

// (e) filter query with exactly 1 match succeeds.
t('materialize::filterQueryExactlyOneMatchSucceeds', () => {
  const cwd = mkStore([
    { id: 'solo', summary: 'unique-solo-summary', body: 'SOLO-BODY' },
    { id: 'other', summary: 'other-summary', body: 'OTHER-BODY' },
  ]);
  const r = materialize(cwd, ['--query', 'unique-solo-summary', '--materialize']);
  assert.equal(r.status, 'ok');
  assert.equal(r.terminal_id, 'solo');
  assert.equal(r.count, 1);
});

// (f) single-episode chain (count=1) is normal, not an error — via --read (distinct from case e's
// filter anchor).
t('materialize::singleEpisodeChainViaReadNotAnError', () => {
  const cwd = mkStore([{ id: 'lonely', body: 'LONELY-BODY' }]);
  const r = materialize(cwd, ['--read', 'lonely', '--materialize']);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 1);
  assert.deepEqual(r.members.map((m) => m.id), ['lonely']);
  assert.ok(r.body.includes('LONELY-BODY'));
});

// (g) cyclic corrupt store — mutual supersedes (a<->b, no root) on the BACKWARD spine walk. Pre-fix
// materializeChain's backward walk had no visited-set and would re-visit a/b forever; the fix seeds
// a spineVisited Set so it terminates gracefully instead of hanging, returning a finite,
// duplicate-free member list.
t('materialize::mutualSupersedesCycleTerminates', () => {
  const cwd = mkStore([
    { id: 'a', supersedes: 'b', body: 'A-BODY' },
    { id: 'b', supersedes: 'a', body: 'B-BODY' },
  ]);
  const r = materialize(cwd, ['--read', 'a', '--materialize']);
  assert.equal(r.status, 'ok');
  const ids = r.members.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids in members');
  assert.ok(ids.length <= 2, 'cycle terminates without unbounded growth');
});

console.log(`\n${pass}/${pass + fail} pass`);
process.exit(fail ? 1 : 0);
