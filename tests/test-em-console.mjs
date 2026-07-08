#!/usr/bin/env node
/**
 * test-em-console.mjs — behavioral tests for the em-console local web server.
 *
 * Spawns the real server against an isolated HOME + non-git cwd fixture (its
 * own local store), then exercises the HTTP surface:
 *   - startup JSON contract (url, port, allow_write, pid)
 *   - auth: no token → 401; wrong token → 401; header token → 200
 *   - loopback-only bind policy: non-loopback --host refused exit 2
 *   - /api/meta shape (allow_write, categories, commands)
 *   - /api/run read path (stats) returns the child script's JSON verbatim
 *   - unknown command → 400; unknown flag → 400; bad int → 400;
 *     leading-dash string value → 400 (flag-smuggling guard)
 *   - write command on a read-only server → 403 AND no store mutation
 *     (fail-closed negative, verified on disk)
 *   - write command on an --allow-write server: store → search roundtrip
 *   - --help contract short-circuit
 *
 * Zero deps — Node stdlib only.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import assert from 'assert'
import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CONSOLE = path.join(REPO, 'scripts', 'em-console.mjs')

let passed = 0
let failed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok ${name}`)
  } catch (e) {
    failed++
    failures.push({ name, error: e.message })
    console.log(`  FAIL ${name}: ${e.message}`)
  }
}

function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-console-test-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(cwd, { recursive: true })
  return { root, home, cwd, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const TOKEN = 'test-token-0123456789'

// Start a server; resolve {proc, port, startup} once the startup JSON arrives.
function startServer(sandbox, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CONSOLE, '--port', '0', '--token', TOKEN, ...extraArgs], {
      cwd: sandbox.cwd,
      env: { ...process.env, HOME: sandbox.home },
    })
    let out = ''
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`server startup timeout; output: ${out}`)) }, 10000)
    proc.stdout.on('data', (c) => {
      out += c
      try {
        const startup = JSON.parse(out.trim())
        clearTimeout(timer)
        resolve({ proc, port: startup.port, startup })
      } catch { /* partial line — keep buffering */ }
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited early (code ${code}): ${out}`))
    })
  })
}

async function req(port, pathname, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers['X-EM-Token'] = token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html pages */ }
  return { status: r.status, json, text }
}

function seedEpisode(sandbox) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'em-store.mjs'),
    '--project', 'console-fixture', '--category', 'decision', '--scope', 'local',
    '--summary', 'fixture decision for console tests', '--body', 'seeded by test-em-console'], {
    cwd: sandbox.cwd, env: { ...process.env, HOME: sandbox.home }, encoding: 'utf8',
  })
  const json = JSON.parse(r.stdout.trim())
  assert.strictEqual(json.status, 'ok', `seed store failed: ${r.stdout}`)
  return json
}

// Content hash of every FILE under root (relative path + bytes), so any
// mutation by a supposedly-read-only command flips the digest.
function treeHash(root) {
  const h = crypto.createHash('sha256')
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) { h.update(path.relative(root, p)); h.update(fs.readFileSync(p)) }
    }
  }
  walk(root)
  return h.digest('hex')
}

function localStoreSnapshot(sandbox) {
  const dir = path.join(sandbox.cwd, '.episodic-memory', 'episodes')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort()
}

// ---------------------------------------------------------------------------
await (async () => {
  console.log('--help contract:')
  await test('em-console.mjs --help short-circuits with the exact contract', () => {
    const s = makeSandbox()
    try {
      const r = spawnSync(process.execPath, [CONSOLE, '--help'], {
        cwd: s.cwd, env: { ...process.env, HOME: s.home }, encoding: 'utf8',
      })
      assert.strictEqual(r.status, 0)
      const json = JSON.parse(r.stdout.trim())
      assert.deepStrictEqual(Object.keys(json).sort(), ['script', 'status', 'usage'])
      assert.strictEqual(json.status, 'help')
      assert.strictEqual(json.script, 'em-console.mjs')
      assert.strictEqual(fs.existsSync(path.join(s.cwd, '.episodic-memory')), false, 'help created a store')
    } finally { s.cleanup() }
  })

  console.log('bind policy:')
  await test('non-loopback --host refused with exit 2', () => {
    const s = makeSandbox()
    try {
      const r = spawnSync(process.execPath, [CONSOLE, '--host', '0.0.0.0'], {
        cwd: s.cwd, env: { ...process.env, HOME: s.home }, encoding: 'utf8', timeout: 10000,
      })
      assert.strictEqual(r.status, 2, `expected exit 2, got ${r.status}: ${r.stdout}`)
      const json = JSON.parse(r.stdout.trim())
      assert.strictEqual(json.status, 'error')
      assert.ok(/loopback/.test(json.message), json.message)
    } finally { s.cleanup() }
  })

  console.log('read-only server:')
  const s1 = makeSandbox()
  const seeded = seedEpisode(s1)
  const ro = await startServer(s1)
  try {
    await test('startup JSON carries url/port/allow_write/pid', () => {
      assert.strictEqual(ro.startup.status, 'ok')
      assert.strictEqual(ro.startup.script, 'em-console.mjs')
      assert.ok(ro.startup.url.includes(`:${ro.port}/?token=`), ro.startup.url)
      assert.strictEqual(ro.startup.allow_write, false)
      assert.strictEqual(typeof ro.startup.pid, 'number')
    })
    await test('no token → 401', async () => {
      const r = await req(ro.port, '/api/meta')
      assert.strictEqual(r.status, 401)
    })
    await test('wrong token → 401', async () => {
      const r = await req(ro.port, '/api/meta', { token: 'wrong-token' })
      assert.strictEqual(r.status, 401)
    })
    await test('page load with query token serves HTML', async () => {
      const r = await req(ro.port, `/?token=${TOKEN}`)
      assert.strictEqual(r.status, 200)
      assert.ok(r.text.includes('<title>em-console</title>'), 'page HTML missing')
    })
    await test('/api/meta reports read-only + categories + commands', async () => {
      const r = await req(ro.port, '/api/meta', { token: TOKEN })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.allow_write, false)
      assert.ok(Array.isArray(r.json.categories) && r.json.categories.includes('decision'), JSON.stringify(r.json.categories))
      assert.ok(r.json.commands.some((c) => c.name === 'stats' && c.write === false))
      assert.ok(r.json.commands.some((c) => c.name === 'store' && c.write === true))
    })
    await test('/api/run stats returns the child JSON verbatim under result', async () => {
      const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'stats', flags: { scope: 'local' } } })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.status, 'ok')
      assert.strictEqual(r.json.exit_code, 0)
      assert.ok(Array.isArray(r.json.result.scopes), 'stats scopes missing')
    })
    await test('/api/run search finds the seeded episode', async () => {
      const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'search', flags: { query: 'fixture decision', scope: 'local' } } })
      assert.strictEqual(r.status, 200)
      assert.ok(r.json.result.episodes.some((e) => e.id === seeded.id), JSON.stringify(r.json.result).slice(0, 400))
    })
    await test('unknown command → 400', async () => {
      const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'rm-rf', flags: {} } })
      assert.strictEqual(r.status, 400)
    })
    await test('unknown flag → 400', async () => {
      const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'stats', flags: { evil: 'x' } } })
      assert.strictEqual(r.status, 400)
    })
    await test('non-integer limit → 400', async () => {
      const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'search', flags: { query: 'x', limit: 'abc' } } })
      assert.strictEqual(r.status, 400)
    })
    await test('leading-dash string value → 400 (flag smuggling guard)', async () => {
      const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'search', flags: { query: '--scope' } } })
      assert.strictEqual(r.status, 400)
      assert.ok(/may not start/.test(r.json.message), r.json.message)
    })
    await test('prototype-chain flag names are rejected (F1 regression)', async () => {
      // Plain-object lookup as allowlist membership resolves prototype keys
      // truthy (same class as the #469 null-proto index fix). JSON.parse is
      // used so "__proto__" lands as an OWN property of the flags object.
      for (const name of ['__proto__', 'hasOwnProperty', 'valueOf', 'constructor', 'toString']) {
        const flags = JSON.parse(`{"query":"x","${name}":"x"}`)
        const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'search', flags } })
        assert.strictEqual(r.status, 400, `prototype key "${name}" rode the allowlist (got ${r.status})`)
      }
    })
    await test('newline in a short token field is rejected; multiline body accepted (F2 regression)', async () => {
      const bad = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'search', flags: { query: 'x', tag: 'a\nb' } } })
      assert.strictEqual(bad.status, 400, `newline in tag accepted (got ${bad.status})`)
      const good = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'search', flags: { query: 'line one\nline two' } } })
      assert.strictEqual(good.status, 200, 'multiline prose query rejected')
    })
    await test('every write:false command leaves the store byte-identical (F5 conformance)', async () => {
      const READ_CASES = [
        ['stats', {}], ['doctor', {}], ['search', { query: 'fixture' }], ['list', {}],
        ['recall', {}], ['graph', { orphans: true }], ['semantic', { query: 'fixture' }],
        ['capture-list', {}], ['fold-preview', { scope: 'local' }], ['prune-preview', { scope: 'local' }],
        ['history', { history: seeded.id }],
      ]
      const meta = await req(ro.port, '/api/meta', { token: TOKEN })
      const readCmds = meta.json.commands.filter((c) => !c.write).map((c) => c.name).sort()
      assert.deepStrictEqual(readCmds, READ_CASES.map(([n]) => n).sort(),
        'READ_CASES drifted from the registry — add the new read command to this sweep')
      for (const [cmd, flags] of READ_CASES) {
        const before = treeHash(s1.root)
        const r = await req(ro.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd, flags } })
        assert.strictEqual(r.status, 200, `${cmd} HTTP ${r.status}`)
        assert.strictEqual(treeHash(s1.root), before, `read command "${cmd}" mutated the sandbox`)
      }
    })
    await test('write command on read-only server → 403 and no disk mutation', async () => {
      const before = localStoreSnapshot(s1)
      const r = await req(ro.port, '/api/run', {
        method: 'POST', token: TOKEN,
        body: { cmd: 'store', flags: { project: 'x', category: 'decision', summary: 'nope', body: 'nope', scope: 'local' } },
      })
      assert.strictEqual(r.status, 403)
      assert.strictEqual(r.json.write_disabled, true)
      assert.deepStrictEqual(localStoreSnapshot(s1), before, 'store mutated despite 403')
    })
  } finally {
    ro.proc.kill()
  }

  console.log('write-enabled server:')
  const rw = await startServer(s1, ['--allow-write'])
  try {
    await test('store → search roundtrip through the API', async () => {
      const st = await req(rw.port, '/api/run', {
        method: 'POST', token: TOKEN,
        body: { cmd: 'store', flags: { project: 'console-fixture', category: 'discovery', summary: 'stored via web api', body: 'roundtrip body', scope: 'local' } },
      })
      assert.strictEqual(st.status, 200)
      assert.strictEqual(st.json.exit_code, 0, JSON.stringify(st.json).slice(0, 400))
      const id = st.json.result.id
      assert.ok(id, 'no id returned from store')
      const se = await req(rw.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'search', flags: { query: 'stored via web api', scope: 'local' } } })
      assert.ok(se.json.result.episodes.some((e) => e.id === id), 'stored episode not found via search')
    })
    await test('history command walks the chain of a seeded episode', async () => {
      const r = await req(rw.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'history', flags: { history: seeded.id } } })
      assert.strictEqual(r.status, 200)
      assert.strictEqual(r.json.exit_code, 0)
      // Pin the FIELD the page's drawer reads: the chain rides under result.chain
      // with id/summary/body per member. The drawer showed "no chain found" when
      // this drifted silently (page read .episodes) — exit-0 alone missed it.
      assert.ok(Array.isArray(r.json.result.chain), `result.chain missing: ${JSON.stringify(Object.keys(r.json.result))}`)
      assert.ok(r.json.result.chain.length >= 1, 'empty chain for seeded episode')
      const m = r.json.result.chain[0]
      assert.ok(m.id && m.summary && 'body' in m, `chain member missing id/summary/body: ${JSON.stringify(Object.keys(m))}`)
    })
    await test('client render path: drawer resolves result.chain and miniMd neutralizes a hostile stored body', async () => {
      // Store an episode whose BODY is hostile markdown, walk its history via
      // the API, then drive the SERVED page's own esc/miniMd/autoRender on the
      // real payload — the drawer path the server-level test never exercised.
      const hostileBody = '# t <script>alert(1)</script>\n[x](javascript:alert(1)) [ok](https://example.com)\n<img src=x onerror=alert(2)>\n```\n<script>fence</script>\n```'
      const st = await req(rw.port, '/api/run', {
        method: 'POST', token: TOKEN,
        body: { cmd: 'store', flags: { project: 'console-fixture', category: 'lesson', summary: 'hostile md body', body: hostileBody, scope: 'local' } },
      })
      assert.strictEqual(st.json.exit_code, 0, JSON.stringify(st.json).slice(0, 300))
      const hist = await req(rw.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'history', flags: { history: st.json.result.id } } })
      assert.ok(Array.isArray(hist.json.result.chain) && hist.json.result.chain.length === 1, 'chain missing for hostile episode')

      const page = (await req(rw.port, `/?token=${TOKEN}`)).text
      const script = page.match(/<script>([\s\S]*?)<\/script>/)[1]
      // The drawer must resolve result.chain first (regression pin for the
      // "no chain found" bug: the page read .episodes, which history never emits).
      assert.ok(script.includes('res.body.result.chain ||'), 'drawer no longer resolves result.chain first')
      const escSrc = script.slice(script.indexOf('function esc('), script.indexOf('function el('))
      const mdSrc = script.slice(script.indexOf('function miniMd('), script.indexOf('// --- generic JSON humanizer'))
      const autoSrc = script.slice(script.indexOf('function autoRender('), script.indexOf('// --- typed renderers'))
      // eslint-disable-next-line no-eval
      const harness = eval(`(function(){ ${escSrc} ${mdSrc} ${autoSrc} return { esc, miniMd, autoRender } })()`)
      const html = harness.miniMd(hist.json.result.chain[0].body)
      assert.ok(!/<script>alert/.test(html), 'raw script tag survived miniMd')
      assert.ok(!/href="javascript/.test(html), 'javascript: href survived miniMd')
      assert.ok(!/<img/.test(html), 'raw img tag survived miniMd')
      assert.ok(/<a href="https:\/\/example.com"/.test(html), 'legitimate https link lost')
      assert.ok(/<pre><code>&lt;script&gt;fence/.test(html), 'fence content not escaped')
      // autoRender cap discipline (reviewer F2): huge objects render bounded.
      const big = {}
      for (let i = 0; i < 10000; i++) big['k' + i] = i
      const rendered = harness.autoRender(big)
      assert.ok((rendered.match(/<tr>/g) || []).length <= 40, 'object-entry rows uncapped')
      assert.ok(/more keys/.test(rendered), 'truncation note missing')
    })
    await test('write flag on wrong shape still validated (bad episode id → 400)', async () => {
      const r = await req(rw.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'pin', flags: { id: 'not-an-id' } } })
      assert.strictEqual(r.status, 400)
    })
    await test('child self-declared error relays as wrapper status error (codex R1-1)', async () => {
      const r = await req(rw.port, '/api/run', {
        method: 'POST', token: TOKEN,
        body: { cmd: 'store', flags: { project: 'x', category: 'not-a-category', summary: 's', body: 'b', scope: 'local' } },
      })
      assert.strictEqual(r.status, 200, 'transport still 200')
      assert.strictEqual(r.json.status, 'error', `wrapper hid the child failure: ${JSON.stringify(r.json).slice(0, 200)}`)
      assert.ok(/Invalid category/.test(r.json.message), r.json.message)
      assert.strictEqual(r.json.result.status, 'error', 'child JSON still verbatim under result')
    })
    await test('doctor exit-1-with-issues does NOT relay as wrapper error (report stays renderable)', async () => {
      // em-doctor exits 1 with status:'issues' on an unhealthy store — that is
      // a renderable report, not an invocation failure. Wrapper must stay ok.
      const r = await req(rw.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'doctor', flags: { scope: 'local' } } })
      assert.strictEqual(r.json.status, 'ok', `doctor report misrelayed: ${JSON.stringify(r.json).slice(0, 200)}`)
      assert.ok(r.json.result.summary, 'doctor summary missing')
    })
    await test('concurrent burst is bounded, never 5xx, server stays responsive (codex R1-2)', async () => {
      const burst = await Promise.all(Array.from({ length: 50 }, () =>
        req(rw.port, '/api/run', { method: 'POST', token: TOKEN, body: { cmd: 'stats', flags: { scope: 'local' } } })))
      for (const r of burst) assert.ok(r.status === 200 || r.status === 429, `unexpected status ${r.status}`)
      const after = await req(rw.port, '/api/meta', { token: TOKEN })
      assert.strictEqual(after.status, 200, 'server unresponsive after burst')
    })
    await test('query token authorizes ONLY the page load, never /api/* (codex R1-4)', async () => {
      const meta = await req(rw.port, `/api/meta?token=${TOKEN}`)
      assert.strictEqual(meta.status, 401, 'query token rode /api/meta')
      const run = await fetch(`http://127.0.0.1:${rw.port}/api/run?token=${TOKEN}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'stats', flags: {} }),
      })
      assert.strictEqual(run.status, 401, 'query token rode /api/run')
      const page = await req(rw.port, `/?token=${TOKEN}`)
      assert.strictEqual(page.status, 200, 'page bootstrap broke')
    })
  } finally {
    rw.proc.kill()
    s1.cleanup()
  }
})()

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`)
  process.exit(1)
}
