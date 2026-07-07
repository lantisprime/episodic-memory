/**
 * test-embedder-presets.mjs — examples/embedders/*.sh adapters, exercised
 * for real: a local HTTP server emulates the Ollama and OpenAI embeddings
 * APIs (deterministic token-overlap vectors), the actual shell scripts run
 * against it, and the full em-embed → em-semantic pipeline is asserted on
 * ranking — not just "it produced output".
 *
 * Also covers: OpenAI batch semantics (one request for N inputs, order by
 * `index`), missing OPENAI_API_KEY refusal, and server-error propagation
 * (em-embed exits 1, sidecar untouched).
 */

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'scripts');
const EMBEDDERS = path.join(REPO, 'examples', 'embedders');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

function run(script, args, cwd, env) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

// The stub API server MUST be a separate process: the test drives em-embed
// via spawnSync, which blocks this process's event loop — an in-process
// http.Server could never answer the adapter's request (deadlock, observed).
// It logs each request as a JSONL line to REQLOG for the batching assertions.
const stubDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'empreset-stub-')));
const REQLOG = path.join(stubDir, 'requests.jsonl');
const stubScript = path.join(stubDir, 'stub-server.mjs');
fs.writeFileSync(stubScript, `
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
const DIM = 32;
function fakeVector(text) {
  const v = new Array(DIM).fill(0);
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    const h = crypto.createHash('sha256').update(raw).digest().readUInt32BE(0);
    v[h % DIM] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    fs.appendFileSync(process.env.REQLOG, JSON.stringify({ url: req.url, auth: req.headers.authorization || null }) + '\\n');
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    if (req.url === '/api/embeddings') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ embedding: fakeVector(payload.prompt) }));
    } else if (req.url === '/v1/embeddings') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: payload.input.map((text, index) => ({ index, embedding: fakeVector(text) })) }));
    } else {
      res.statusCode = 500;
      res.end('boom');
    }
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`);
const stub = spawn(process.execPath, [stubScript], { env: { ...process.env, REQLOG }, stdio: ['ignore', 'pipe', 'inherit'] });
const PORT = await new Promise((resolve, reject) => {
  stub.stdout.once('data', d => resolve(parseInt(String(d).trim(), 10)));
  stub.once('exit', () => reject(new Error('stub server died before reporting its port')));
});
const BASE = `http://127.0.0.1:${PORT}`;
const requestsSeen = () => fs.existsSync(REQLOG)
  ? fs.readFileSync(REQLOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

// Fixture store
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'empreset-')));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'empreset-home-')));
const env = { HOME: home };
const store = path.join(cwd, '.episodic-memory');
for (const [summary, body, tags] of [
  ['JWT auth token expiry handling', 'Access tokens expire after fifteen minutes; refresh token rotates.', 'auth'],
  ['Postgres connection pooling', 'pgbouncer transaction mode caps connections at one hundred.', 'postgres'],
]) {
  const r = run('em-store.mjs', ['--project', 'fx', '--scope', 'local', '--category', 'decision', '--summary', summary, '--body', body, '--tags', tags], cwd, env);
  assert.equal(r.json.status, 'ok');
}

const OLLAMA_CMD = `sh ${path.join(EMBEDDERS, 'ollama-embed.sh')}`;
const OPENAI_CMD = `sh ${path.join(EMBEDDERS, 'openai-embed.sh')}`;

t('ollama adapter: embed + semantic rank end-to-end against the emulated API', () => {
  const e = run('em-embed.mjs', ['--scope', 'local', '--cmd', OLLAMA_CMD, '--model', 'ollama-test'],
    cwd, { ...env, OLLAMA_URL: BASE, OLLAMA_MODEL: 'fake-model' });
  assert.equal(e.code, 0, e.stdout + e.stderr);
  assert.equal(e.json.scopes[0].embedded, 2);
  const q = run('em-semantic.mjs', ['--query', 'auth token refresh expire', '--scope', 'local', '--cmd', OLLAMA_CMD, '--model', 'ollama-test', '--no-track', '--min-sim', '0.05'],
    cwd, { ...env, OLLAMA_URL: BASE, OLLAMA_MODEL: 'fake-model' });
  assert.equal(q.code, 0, q.stdout + q.stderr);
  assert.ok(q.json.episodes[0].summary.startsWith('JWT auth'), `auth episode must rank first: ${q.stdout}`);
  assert.ok(q.json.episodes[0].similarity > 0.2);
});

t('openai adapter: ONE batched request for N inputs, order preserved by index', () => {
  const seenBefore = requestsSeen().length;
  const e = run('em-embed.mjs', ['--scope', 'local', '--cmd', OPENAI_CMD, '--model', 'openai-test', '--rebuild'],
    cwd, { ...env, OPENAI_API_KEY: 'sk-test', OPENAI_EMBED_URL: `${BASE}/v1/embeddings` });
  assert.equal(e.code, 0, e.stdout + e.stderr);
  assert.equal(e.json.scopes[0].embedded, 2);
  const embedCalls = requestsSeen().slice(seenBefore).filter(r => r.url === '/v1/embeddings');
  assert.equal(embedCalls.length, 1, 'batch adapter must make exactly one API call for the whole store');
  assert.equal(embedCalls[0].auth, 'Bearer sk-test', 'API key must be sent as bearer auth');
  const q = run('em-semantic.mjs', ['--query', 'pgbouncer connection pooling', '--scope', 'local', '--cmd', OPENAI_CMD, '--model', 'openai-test', '--no-track', '--min-sim', '0.05'],
    cwd, { ...env, OPENAI_API_KEY: 'sk-test', OPENAI_EMBED_URL: `${BASE}/v1/embeddings` });
  assert.ok(q.json.episodes[0].summary.startsWith('Postgres'), `postgres episode must rank first: ${q.stdout}`);
});

t('openai adapter refuses to run without OPENAI_API_KEY', () => {
  const r = spawnSync('/bin/sh', ['-c', OPENAI_CMD], {
    input: JSON.stringify({ id: 'x', text: 'y' }) + '\n',
    encoding: 'utf8',
    env: { ...process.env, OPENAI_API_KEY: '' },
  });
  assert.notEqual(r.status, 0);
  assert.ok((r.stderr || '').includes('OPENAI_API_KEY'), r.stderr);
});

t('server errors propagate: em-embed exits 1 and the sidecar is untouched', () => {
  const before = fs.readFileSync(path.join(store, 'embeddings.jsonl'), 'utf8');
  const e = run('em-embed.mjs', ['--scope', 'local', '--cmd', OLLAMA_CMD, '--model', 'broken', '--rebuild'],
    cwd, { ...env, OLLAMA_URL: `${BASE}/broken` });
  assert.equal(e.code, 1, e.stdout);
  assert.equal(e.json.status, 'error');
  assert.equal(fs.readFileSync(path.join(store, 'embeddings.jsonl'), 'utf8'), before, 'sidecar must be untouched on API failure');
});

stub.kill();
fs.rmSync(stubDir, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
