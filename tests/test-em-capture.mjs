/**
 * test-em-capture.mjs — wave-6 #2 session auto-capture. Real scripts against
 * an isolated HOME + synthetic transcript fixtures matching the
 * transcript-walker record shapes. Byte-level store snapshots prove no-write
 * on every refusal/dry-run path.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'scripts');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcap-home-')));
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emcap-cwd-')));
const GLOBAL = path.join(home, '.episodic-memory');
const DRAFTS = path.join(GLOBAL, 'drafts');

function run(script, args, opts = {}) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], {
    cwd: opts.cwd || cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home, ...(opts.env || {}) },
  });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

// Byte snapshot of a directory tree: relative path -> sha256.
function snapshot(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}
function assertSnapshotEqual(a, b, label) {
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort(), label);
}

// ---------------------------------------------------------------------------
// Synthetic transcript in transcript-walker's expected location + shapes.
// ---------------------------------------------------------------------------
const SLUG = '-tmp-emcap-project';
const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const tdir = path.join(home, '.claude', 'projects', SLUG);
fs.mkdirSync(tdir, { recursive: true });

const rec = {
  user: (text) => ({ type: 'user', timestamp: '2026-07-08T10:00:00Z', cwd, message: { role: 'user', content: [{ type: 'text', text }] } }),
  assistant: (text) => ({ type: 'assistant', timestamp: '2026-07-08T10:01:00Z', cwd, message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  bash: (command) => ({ type: 'assistant', timestamp: '2026-07-08T10:02:00Z', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }),
  toolResult: (isError) => ({ type: 'user', timestamp: '2026-07-08T10:02:30Z', cwd, message: { role: 'user', content: [{ type: 'tool_result', is_error: isError, content: isError ? 'boom' : 'fine' }] } }),
};

const transcript = [
  rec.user('please fix the flaky test'),
  rec.assistant('Looking at it now.'),
  rec.bash('node tests/test-flaky.mjs'),
  rec.toolResult(true),
  rec.bash('node tests/test-flaky.mjs'),
  rec.toolResult(false),
  rec.assistant('Root cause found. We are going with the retry-free fix since the race was in the fixture.'),
  rec.user('lesson: always seed the fixture clock explicitly'),
  rec.assistant('PR #999 wave test hardening merged and deployed.'),
  // Fabricated-signal bait: markers inside code must NOT create candidates.
  rec.user('here is a doc snippet:\n```\nlesson: fake inside fenced block\ndecision: also fake\n```\nand inline `lesson: fake inline` too'),
];
fs.writeFileSync(path.join(tdir, `${SESSION}.jsonl`), transcript.map(r => JSON.stringify(r)).join('\n') + '\n');

// ---------------------------------------------------------------------------

t('help short-circuits with {status:help}', () => {
  const r = run('em-capture.mjs', ['--help']);
  assert.equal(r.json.status, 'help');
  assert.equal(r.json.script, 'em-capture.mjs');
});

t('heuristic extract finds marker + decision + error-fix + milestone with evidence', () => {
  const r = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--max', '10']);
  assert.equal(r.json.status, 'ok', r.stdout + r.stderr);
  const draftFile = path.join(DRAFTS, `${r.json.draft}.json`);
  assert.ok(fs.existsSync(draftFile), 'draft file written');
  const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
  const signals = d.candidates.map(c => c.signal).sort();
  assert.ok(signals.includes('user-marker'), `signals: ${signals}`);
  assert.ok(signals.includes('assistant-decision'), `signals: ${signals}`);
  assert.ok(signals.includes('error-fix'), `signals: ${signals}`);
  assert.ok(signals.includes('milestone'), `signals: ${signals}`);
  for (const c of d.candidates) {
    assert.ok(typeof c.evidence_excerpt === 'string' && c.evidence_excerpt.length > 0, 'every candidate carries evidence');
    assert.ok(typeof c.confidence === 'number');
  }
  const lesson = d.candidates.find(c => c.signal === 'user-marker' && c.category === 'lesson');
  assert.ok(lesson && lesson.evidence_excerpt.includes('seed the fixture clock'), 'marker evidence is the salient line');
  fs.rmSync(draftFile);
});

t('code blocks and inline backticks never produce candidates (fabricated-signal guard)', () => {
  const r = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--max', '10', '--dry-run']);
  const texts = r.json.draft.candidates.map(c => c.evidence_excerpt + ' ' + c.summary).join(' ');
  assert.ok(!texts.includes('fake inside fenced block'), texts);
  assert.ok(!texts.includes('also fake'), texts);
  assert.ok(!texts.includes('fake inline'), texts);
});

t('--max caps candidates, keeping highest confidence first', () => {
  const r = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--max', '1', '--dry-run']);
  assert.equal(r.json.draft.candidates.length, 1);
  assert.equal(r.json.draft.candidates[0].confidence, 0.9, 'user-marker (0.9) wins the cap');
});

t('--dry-run writes nothing (byte snapshot)', () => {
  const before = snapshot(GLOBAL);
  const r = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--dry-run']);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.dry_run, true);
  assertSnapshotEqual(before, snapshot(GLOBAL), 'store bytes unchanged by dry-run');
});

t('drafts are not episodes: no index rows, invisible to em-search; em-recall counts them', () => {
  const r = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--max', '10']);
  assert.equal(r.json.status, 'ok');
  const indexFile = path.join(GLOBAL, 'index.jsonl');
  assert.ok(!fs.existsSync(indexFile) || !fs.readFileSync(indexFile, 'utf8').includes(r.json.draft), 'draft id never in index.jsonl');
  const search = run('em-search.mjs', ['--project', 'fx', '--scope', 'global', '--no-track']);
  assert.equal((search.json.episodes || []).length, 0, 'em-search sees no episodes from drafts');
  const recall = run('em-recall.mjs', ['--no-track']);
  assert.ok(recall.json.pending_drafts >= 1, `pending_drafts surfaced: ${recall.stdout.slice(0, 200)}`);
  // leave this draft in place for the review tests below
  globalThis.__draftId = r.json.draft;
});

t('review --accept stores through em-store: indexed, tagged auto-captured; draft resolves', () => {
  const draftId = globalThis.__draftId;
  const d = JSON.parse(fs.readFileSync(path.join(DRAFTS, `${draftId}.json`), 'utf8'));
  const first = d.candidates[0].n;
  const r = run('em-capture.mjs', ['review', '--draft', draftId, '--accept', String(first)]);
  assert.equal(r.json.status, 'ok', r.stdout + r.stderr);
  const epId = r.json.accepted[0].episode_id;
  assert.ok(epId, 'accept returns the episode id');
  assert.ok(fs.existsSync(path.join(GLOBAL, 'episodes', `${epId}.md`)), 'episode file exists');
  const idx = fs.readFileSync(path.join(GLOBAL, 'index.jsonl'), 'utf8');
  assert.ok(idx.includes(epId), 'episode indexed');
  const search = run('em-search.mjs', ['--project', 'fx', '--tag', 'auto-captured', '--scope', 'global', '--no-track']);
  assert.ok(search.json.episodes.some(e => e.id === epId), 'searchable by auto-captured tag');
  const updated = JSON.parse(fs.readFileSync(path.join(DRAFTS, `${draftId}.json`), 'utf8'));
  const c = updated.candidates.find(x => x.n === first);
  assert.equal(c.status, 'accepted');
  assert.equal(c.episode_id, epId, 'draft records the resulting episode id');
});

t('review --reject writes no episodes; fully-resolved draft file is deleted', () => {
  const draftId = globalThis.__draftId;
  const before = snapshot(path.join(GLOBAL, 'episodes'));
  const d = JSON.parse(fs.readFileSync(path.join(DRAFTS, `${draftId}.json`), 'utf8'));
  const pendingNs = d.candidates.filter(c => c.status === 'pending').map(c => c.n);
  const r = run('em-capture.mjs', ['review', '--draft', draftId, '--reject', pendingNs.join(',')]);
  assert.equal(r.json.status, 'ok', r.stdout);
  assertSnapshotEqual(before, snapshot(path.join(GLOBAL, 'episodes')), 'reject writes no episodes');
  assert.equal(r.json.pending_remaining, 0);
  assert.ok(!fs.existsSync(path.join(DRAFTS, `${draftId}.json`)), 'fully-resolved draft deleted');
});

t('review --discard deletes the draft without storing', () => {
  const r1 = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx']);
  const before = snapshot(path.join(GLOBAL, 'episodes'));
  const r2 = run('em-capture.mjs', ['review', '--draft', r1.json.draft, '--discard']);
  assert.equal(r2.json.discarded, true);
  assert.ok(!fs.existsSync(path.join(DRAFTS, `${r1.json.draft}.json`)));
  assertSnapshotEqual(before, snapshot(path.join(GLOBAL, 'episodes')), 'discard writes no episodes');
});

t('cmd mode: deterministic external capturer; invalid category fails with no partial draft', () => {
  const goodCmd = path.join(cwd, 'capturer-good.mjs');
  fs.writeFileSync(goodCmd, `
    import fs from 'node:fs'
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'))
    console.log(JSON.stringify({ candidates: [{ category: 'decision', summary: 'cmd-mode candidate for ' + payload.project, body: 'from cmd', tags: ['cmd'], confidence: 0.8, evidence_excerpt: 'ev' }] }))
  `);
  const g = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--mode', 'cmd', '--cmd', `node ${goodCmd}`]);
  assert.equal(g.json.status, 'ok', g.stdout + g.stderr);
  const gd = JSON.parse(fs.readFileSync(path.join(DRAFTS, `${g.json.draft}.json`), 'utf8'));
  assert.equal(gd.candidates[0].signal, 'cmd');
  assert.ok(gd.candidates[0].tags.includes('auto-captured'));
  run('em-capture.mjs', ['review', '--draft', g.json.draft, '--discard']);

  const badCmd = path.join(cwd, 'capturer-bad.mjs');
  fs.writeFileSync(badCmd, `console.log(JSON.stringify({ candidates: [{ category: 'not-a-category', summary: 'x' }] }))`);
  const before = snapshot(GLOBAL);
  const b = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--mode', 'cmd', '--cmd', `node ${badCmd}`]);
  assert.equal(b.json.status, 'error', b.stdout);
  assertSnapshotEqual(before, snapshot(GLOBAL), 'invalid cmd output leaves no partial drafts');

  const failCmd = path.join(cwd, 'capturer-fail.mjs');
  fs.writeFileSync(failCmd, `process.exit(3)`);
  const f = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx', '--mode', 'cmd', '--cmd', `node ${failCmd}`]);
  assert.equal(f.json.status, 'error');
  assert.ok(f.json.message.includes('exited 3'), f.stdout);
});

t('claude-capture.sh plumbing via $CLAUDE_BIN shim', function () {
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) { console.log('      (python3 unavailable — plumbing case skipped)'); return; }
  const shim = path.join(cwd, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\necho '{"candidates":[{"category":"lesson","summary":"shim lesson","body":"b","tags":["t"],"confidence":0.9,"evidence_excerpt":"e"}]}'\n`);
  fs.chmodSync(shim, 0o755);
  const payload = JSON.stringify({ session_id: SESSION, project: 'fx', max: 3, chunks: [{ role: 'user', text: 'hello' }] });
  const r = spawnSync('sh', [path.join(REPO, 'examples', 'capturers', 'claude-capture.sh')], {
    encoding: 'utf8', input: payload, env: { ...process.env, CLAUDE_BIN: shim },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.candidates[0].summary, 'shim lesson');
});

t('doctor: fresh drafts ok, 15-day-old draft warns with review hint', () => {
  const r1 = run('em-capture.mjs', ['extract', '--session-id', SESSION, '--project', 'fx']);
  const fresh = run('em-doctor.mjs', ['--scope', 'global']);
  const freshCheck = fresh.json.checks.find(c => c.id === 'drafts');
  assert.equal(freshCheck.level, 'ok', JSON.stringify(freshCheck));
  const draftFile = path.join(DRAFTS, `${r1.json.draft}.json`);
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(draftFile, old, old);
  const stale = run('em-doctor.mjs', ['--scope', 'global']);
  const staleCheck = stale.json.checks.find(c => c.id === 'drafts');
  assert.equal(staleCheck.level, 'warn', JSON.stringify(staleCheck));
  assert.ok(staleCheck.message.includes('em-capture list'));
  run('em-capture.mjs', ['review', '--draft', r1.json.draft, '--discard']);
});

t('usage errors exit 2: unknown command, bad mode, bad max, review without action', () => {
  assert.equal(run('em-capture.mjs', ['bogus']).code, 2);
  assert.equal(run('em-capture.mjs', ['extract', '--session-id', SESSION, '--mode', 'psychic']).code, 2);
  assert.equal(run('em-capture.mjs', ['extract', '--session-id', SESSION, '--max', 'lots']).code, 2);
  assert.equal(run('em-capture.mjs', ['extract']).code, 2, 'extract requires a transcript source');
  assert.equal(run('em-capture.mjs', ['review', '--draft', 'x']).code, 2);
});

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
