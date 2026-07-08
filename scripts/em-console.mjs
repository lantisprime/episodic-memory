#!/usr/bin/env node
/**
 * em-console.mjs — local web console over the episodic-memory CLI contract.
 *
 * Usage:
 *   node em-console.mjs [--port <n>] [--host 127.0.0.1] [--allow-write]
 *                       [--idle-timeout <secs>] [--token <t>]
 *
 * Presentation layer (CAPABILITIES.md "Adjacent layers", Principle 11): serves
 * one self-contained HTML page and a single POST /api/run endpoint that spawns
 * the sibling em-* scripts from a CLOSED command registry and returns their
 * JSON verbatim. The server validates request SHAPE (command name, flag names,
 * value types); it never interprets episode semantics — the spawned script
 * decides everything, exactly as it would on the CLI.
 *
 * Bounded background work (Principle 6): user-started, loopback-only, prints
 * its URL + lifetime on startup, idles out after --idle-timeout seconds
 * (default 1800; 0 disables), does no polling and no work between requests.
 *
 * Consent (Principles 3/10): launched read-only by default. Commands that
 * write (store, revise, pin, feedback, move, doctor --fix, rebuild-index,
 * fold/prune apply) return 403 unless the server was started with
 * --allow-write.
 *
 * Auth: a per-launch random token. The printed URL carries it once as
 * ?token=; the page moves it to memory and sends X-EM-Token on every API
 * call. Everything except the token-bearing page load is rejected without it.
 *
 * Outputs exactly one JSON object to stdout on startup:
 *   { status, script, url, host, port, allow_write, idle_timeout_seconds, pid }
 * Lifecycle notices (idle shutdown, SIGINT) go to stderr so stdout stays a
 * single parseable object.
 */

import fs from 'fs'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({
    status: 'help',
    script: 'em-console.mjs',
    usage: 'node em-console.mjs [--port <n>] [--host 127.0.0.1] [--allow-write] [--idle-timeout <secs>] [--token <t>] — local web console over the em-* CLI contract (loopback-only, per-launch token auth, read-only unless --allow-write; idles out after --idle-timeout seconds, default 1800, 0 disables). Prints one startup JSON object with the tokenized URL; open it in a browser.',
  }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function die(message) {
  console.log(JSON.stringify({ status: 'error', message }))
  process.exit(2)
}

const host = flag('--host') || '127.0.0.1'
// Loopback only, by design. Remote exposure (TLS, users, CSRF beyond the
// token) is a different product; refusing here keeps the auth model honest.
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  die(`--host ${host} refused: em-console binds loopback only (127.0.0.1, localhost, ::1)`)
}

const portRaw = flag('--port') ?? '0'
if (!/^\d+$/.test(portRaw) || parseInt(portRaw, 10) > 65535) {
  die(`--port ${portRaw} invalid: expected an integer 0-65535 (0 = ephemeral)`)
}
const port = parseInt(portRaw, 10)

const idleRaw = flag('--idle-timeout') ?? '1800'
if (!/^\d+$/.test(idleRaw)) die(`--idle-timeout ${idleRaw} invalid: expected seconds (0 disables)`)
const idleTimeoutMs = parseInt(idleRaw, 10) * 1000

const allowWrite = argv.includes('--allow-write')
const token = flag('--token') || crypto.randomBytes(24).toString('base64url')

// ---------------------------------------------------------------------------
// Command registry — the CLOSED set of spawnable shapes. Each entry names the
// sibling script, fixed argv the command always carries, and the flags a
// request may set. Flag types bound the value SHAPE only; semantic validation
// (category vocabulary, id existence, scope rules) belongs to the spawned
// script, which already enforces it for the CLI.
// ---------------------------------------------------------------------------
const T = {
  str: { kind: 'str', max: 400 },
  text: { kind: 'str', max: 20000, multiline: true }, // summary/body/query prose
  int: { kind: 'int', max: 1000 },
  bool: { kind: 'bool' },
  id: { kind: 'id' }, // episode id
  scope3: { kind: 'enum', values: ['local', 'global', 'all'] },
  scope2: { kind: 'enum', values: ['local', 'global'] },
  taskType: { kind: 'enum', values: ['implementation', 'push', 'rule', 'general'] },
}

const COMMANDS = {
  // read
  stats: { script: 'em-stats.mjs', flags: { scope: T.scope3, top: T.int, 'all-projects': T.bool } },
  doctor: { script: 'em-doctor.mjs', flags: { scope: T.scope3, 'all-projects': T.bool } },
  search: {
    script: 'em-search.mjs', fixed: ['--no-track'],
    flags: { query: T.text, tag: T.str, category: T.str, project: T.str, scope: T.scope3, limit: T.int, since: T.str, full: T.bool, 'no-score': T.bool },
  },
  history: { script: 'em-search.mjs', fixed: ['--full', '--no-track'], flags: { history: T.id }, required: ['history'] },
  list: { script: 'em-list.mjs', flags: { project: T.str, limit: T.int, scope: T.scope3, 'include-superseded': T.bool } },
  recall: { script: 'em-recall.mjs', fixed: ['--no-track'], flags: { project: T.str, scope: T.scope3, limit: T.int, days: T.int, 'task-type': T.taskType } },
  graph: { script: 'em-graph.mjs', flags: { from: T.id, depth: T.int, orphans: T.bool, hubs: T.bool, top: T.int, scope: T.scope3, limit: T.int } },
  semantic: { script: 'em-semantic.mjs', fixed: ['--no-track'], flags: { query: T.text, scope: T.scope3, limit: T.int, project: T.str, full: T.bool }, required: ['query'] },
  'capture-list': { script: 'em-capture.mjs', fixed: ['list'], flags: {} },
  'fold-preview': { script: 'em-consolidate.mjs', fixed: ['--fold-superseded', '--dry-run'], flags: { scope: T.scope2, 'min-chain': T.int, 'all-projects': T.bool } },
  'prune-preview': { script: 'em-prune.mjs', fixed: ['--dry-run'], flags: { scope: T.scope3 } },
  // write (403 without --allow-write)
  store: {
    script: 'em-store.mjs', write: true,
    flags: { project: T.str, category: T.str, summary: T.text, body: T.text, tags: T.str, scope: T.scope2, pin: T.bool },
    required: ['project', 'category', 'summary', 'body'],
  },
  revise: {
    script: 'em-revise.mjs', write: true,
    flags: { original: T.id, project: T.str, summary: T.text, body: T.text, tags: T.str, scope: { kind: 'enum', values: ['inherit', 'local', 'global'] }, pin: T.bool },
    required: ['original', 'project', 'summary', 'body'],
  },
  pin: { script: 'em-pin.mjs', write: true, flags: { id: T.id, unpin: T.bool }, required: ['id'] },
  feedback: { script: 'em-feedback.mjs', write: true, flags: { id: T.id, useful: T.bool, noise: T.bool }, required: ['id'] },
  move: { script: 'em-move.mjs', write: true, flags: { id: T.id, to: T.scope2, reason: T.str }, required: ['id', 'to'] },
  'doctor-fix': { script: 'em-doctor.mjs', write: true, fixed: ['--fix'], flags: { scope: T.scope3 } },
  'rebuild-index': { script: 'em-rebuild-index.mjs', write: true, flags: { scope: T.scope3 } },
  // Apply forms are single-store on purpose: the multi-store fold's --confirm
  // consent semantics stay a CLI-only surface in v1 (plan §5).
  'fold-apply': { script: 'em-consolidate.mjs', write: true, fixed: ['--fold-superseded'], flags: { scope: T.scope2, 'min-chain': T.int } },
  'prune-apply': { script: 'em-prune.mjs', write: true, flags: { scope: T.scope3 } },
}

// ---------------------------------------------------------------------------
// Shape validation → argv array. No shell is ever involved (execFile with an
// argv array), so the residual risk is flag smuggling — a value that a child
// parser would read as a flag. Leading '-' values are rejected everywhere.
// ---------------------------------------------------------------------------
function buildArgs(entry, flags) {
  if (flags === undefined || flags === null) flags = {}
  if (typeof flags !== 'object' || Array.isArray(flags)) return { error: 'flags must be an object' }
  const args = [...(entry.fixed || [])]
  for (const name of Object.keys(flags)) {
    // Object.hasOwn, not a plain lookup: prototype keys (__proto__, valueOf,
    // hasOwnProperty, ...) resolve truthy through the chain and would ride the
    // allowlist (same invariant class as the #469 null-proto index fix).
    if (!Object.hasOwn(entry.flags, name)) return { error: `unknown flag "${name}" for this command` }
    const spec = entry.flags[name]
    const v = flags[name]
    if (spec.kind === 'bool') {
      if (v !== true) return { error: `flag "${name}" is boolean: pass true or omit it` }
      args.push(`--${name}`)
      continue
    }
    if (typeof v !== 'string' && typeof v !== 'number') return { error: `flag "${name}" must be a string or number` }
    const s = String(v)
    if (spec.kind === 'int') {
      if (!/^\d+$/.test(s) || parseInt(s, 10) > spec.max) return { error: `flag "${name}" must be an integer 0-${spec.max}` }
    } else if (spec.kind === 'enum') {
      if (!spec.values.includes(s)) return { error: `flag "${name}" must be one of: ${spec.values.join(', ')}` }
    } else if (spec.kind === 'id') {
      if (!/^[0-9]{8}-[0-9]{6}-[A-Za-z0-9-]{1,200}$/.test(s)) return { error: `flag "${name}" is not an episode id` }
    } else { // str
      if (s.length === 0 || s.length > spec.max) return { error: `flag "${name}" must be 1-${spec.max} characters` }
      if (s.startsWith('-')) return { error: `flag "${name}" may not start with "-"` }
      // Prose fields (multiline: summary/body/query) keep tab/LF/CR; short
      // token fields (tag, project, reason, ...) reject ALL control bytes so
      // no embedded line break rides into episode metadata or index rows.
      // eslint-disable-next-line no-control-regex
      const ctl = spec.multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/
      if (ctl.test(s)) return { error: `flag "${name}" contains control characters` }
    }
    args.push(`--${name}`, s)
  }
  for (const req of entry.required || []) {
    if (!(req in flags)) return { error: `missing required flag "${req}"` }
  }
  return { args }
}

function runCommand(cmd, flags) {
  return new Promise((resolve) => {
    const entry = COMMANDS[cmd]
    const built = buildArgs(entry, flags)
    if (built.error) return resolve({ code: 400, body: { status: 'error', cmd, message: built.error } })
    const scriptPath = path.join(SCRIPT_DIR, entry.script)
    execFile(process.execPath, [scriptPath, ...built.args], {
      cwd: process.cwd(),
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      let result
      try { result = JSON.parse(String(stdout).trim()) } catch { result = { raw: String(stdout) } }
      resolve({
        code: 200,
        body: {
          status: 'ok',
          cmd,
          exit_code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
          result,
          ...(stderr && String(stderr).trim() ? { stderr: String(stderr).slice(0, 4000) } : {}),
        },
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Auth — constant-time compare over digests so length never leaks.
// ---------------------------------------------------------------------------
const tokenDigest = crypto.createHash('sha256').update(token).digest()
function tokenOk(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const d = crypto.createHash('sha256').update(candidate).digest()
  return crypto.timingSafeEqual(d, tokenDigest)
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

let lastActivity = Date.now()

async function handle(req, res) {
  lastActivity = Date.now()
  const url = new URL(req.url, `http://${host}`)
  const candidate = req.headers['x-em-token'] || url.searchParams.get('token') || ''

  if (!tokenOk(candidate)) {
    return sendJson(res, 401, { status: 'error', message: 'missing or invalid token — relaunch em-console and open the printed URL' })
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const { renderPage } = await import('./lib/console-page.mjs')
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'",
    })
    return res.end(renderPage())
  }

  if (req.method === 'GET' && url.pathname === '/api/meta') {
    let categories = []
    try {
      const { loadCategories } = await import('./lib/categories.mjs')
      categories = loadCategories().categories.filter((c) => !c.deprecated_for).map((c) => c.name)
    } catch { /* category vocab is presentation sugar here; the store enforces it */ }
    return sendJson(res, 200, {
      status: 'ok',
      allow_write: allowWrite,
      cwd: process.cwd(),
      idle_timeout_seconds: idleTimeoutMs / 1000,
      categories,
      commands: Object.entries(COMMANDS).map(([name, e]) => ({ name, write: !!e.write })),
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    let parsed
    try {
      parsed = JSON.parse(await readBody(req))
    } catch (e) {
      return sendJson(res, e.message === 'body too large' ? 413 : 400, { status: 'error', message: `invalid request body: ${e.message}` })
    }
    const { cmd, flags } = parsed || {}
    const entry = typeof cmd === 'string' ? COMMANDS[cmd] : undefined
    if (!entry) return sendJson(res, 400, { status: 'error', message: `unknown command ${JSON.stringify(cmd)}` })
    if (entry.write && !allowWrite) {
      return sendJson(res, 403, { status: 'error', cmd, write_disabled: true, message: 'server is read-only — relaunch with --allow-write to enable write commands' })
    }
    const out = await runCommand(cmd, flags)
    return sendJson(res, out.code, out.body)
  }

  return sendJson(res, 404, { status: 'error', message: 'not found' })
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { sendJson(res, 500, { status: 'error', message: e.message }) } catch { /* socket gone */ }
  })
})

server.listen(port, host === 'localhost' ? '127.0.0.1' : host, () => {
  const actualPort = server.address().port
  console.log(JSON.stringify({
    status: 'ok',
    script: 'em-console.mjs',
    url: `http://${host === '::1' ? '[::1]' : host}:${actualPort}/?token=${token}`,
    host,
    port: actualPort,
    allow_write: allowWrite,
    idle_timeout_seconds: idleTimeoutMs / 1000,
    pid: process.pid,
  }))
})

if (idleTimeoutMs > 0) {
  // Check at min(30s, timeout) so sub-30s timeouts fire near when the flag says.
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > idleTimeoutMs) {
      process.stderr.write(`em-console: idle for ${idleTimeoutMs / 1000}s — shutting down\n`)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 2000).unref()
    }
  }, Math.min(30_000, idleTimeoutMs))
  timer.unref()
}

process.on('SIGINT', () => {
  process.stderr.write('em-console: SIGINT — shutting down\n')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
})
