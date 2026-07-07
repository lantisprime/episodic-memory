#!/usr/bin/env node
/**
 * em-routines.mjs — scheduled maintenance manager for the memory substrate.
 *
 * Replaces the legacy machine-specific install-launchd-routines.sh with a
 * config-driven manager adapted to the target environment:
 *
 *   em routines sync        apply routines.json to the platform scheduler
 *                           (launchd on macOS, systemd user timers on Linux,
 *                           crontab fallback), seeding defaults on first run
 *   em routines list        config + platform presence + last-run state,
 *                           with STALE detection (an enabled, synced routine
 *                           whose last run is older than 2x its interval —
 *                           catches silently-dead schedulers)
 *   em routines run <r>     execute a routine now and record its state
 *   em routines enable <r> / disable <r>    flip + re-sync
 *   em routines add --name <n> --cron "<5-field>" --cmd "<command>"
 *   em routines remove <n>  drop a custom routine (+ de-schedule)
 *   em routines logs <r> [--lines <n>]
 *   em routines uninstall   remove every platform entry (config + logs kept)
 *
 * Definitions live in ~/.episodic-memory/routines.json (JSON-defs principle
 * — the schedule is data, this script is the adapter). Built-in routines,
 * all zero-LLM and safe unattended (no-op guards when unconfigured):
 *
 *   doctor          daily 08:15  em-doctor --scope global --fix
 *   embed           daily 03:30  em-embed --scope global (no-op w/o embed config)
 *   backup-sync     daily 23:00  em-backup --sync under em-lock (no-op w/o config)
 *   hygiene-report  Sun   09:00  read-only stats + consolidate/prune dry-runs
 *
 * Every scheduler entry runs `node <scripts>/em-routines.mjs run <name>`, so
 * state recording works identically for scheduled and manual runs, on every
 * platform. Cron expressions: 5 fields, each `*` or an integer (dom/month
 * must be `*` — translated to launchd StartCalendarInterval / systemd
 * OnCalendar; full cron only the cron backend could express is rejected
 * rather than silently mistranslated).
 *
 * State: ~/.episodic-memory/logs/routines/state.json (+ per-routine logs).
 * Outputs JSON. Exit 0 ok, 1 failure, 2 usage.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()
const GLOBAL_DIR = path.join(HOME, '.episodic-memory')
const CONFIG_PATH = path.join(GLOBAL_DIR, 'routines.json')
const LOG_DIR = path.join(GLOBAL_DIR, 'logs', 'routines')
const STATE_PATH = path.join(LOG_DIR, 'state.json')
const NAMESPACE = 'episodic-memory'
const CRON_BEGIN = '# BEGIN episodic-memory routines (managed by em-routines.mjs)'
const CRON_END = '# END episodic-memory routines'

const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-routines.mjs', usage: 'node em-routines.mjs <sync|list|run <r>|enable <r>|disable <r>|add --name <n> --cron "<5-field>" --cmd "<command>"|remove <n>|logs <r> [--lines <n>]|uninstall> [--dry-run] [--scheduler launchd|systemd|cron] — config-driven scheduled maintenance (routines.json), platform-adapted' }))
  process.exit(0)
}

function flag(name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const action = argv[0]
const dryRun = argv.includes('--dry-run')

function fail(message, code = 1) {
  console.log(JSON.stringify({ status: 'error', message }))
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Built-in routines (defaults seeded into routines.json on first sync)
// ---------------------------------------------------------------------------
const BUILTINS = {
  doctor: { cron: '15 8 * * *', description: 'auto-repair store health (em-doctor --fix)' },
  embed: { cron: '30 3 * * *', description: 'refresh semantic sidecar (no-op when unconfigured)' },
  'backup-sync': { cron: '0 23 * * *', description: 'push stores to backup repo (no-op when unconfigured)' },
  'hygiene-report': { cron: '0 9 * * 0', description: 'read-only consolidate/prune/stats report' },
}

// ---------------------------------------------------------------------------
// Config (routines.json) + state (state.json)
// ---------------------------------------------------------------------------
function defaultConfig() {
  return {
    version: '1.0.0',
    routines: Object.entries(BUILTINS).map(([name, b]) => ({
      name, cron: b.cron, builtin: name, enabled: true, description: b.description,
    })),
  }
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    if (!Array.isArray(cfg.routines)) throw new Error('routines.json: "routines" must be an array')
    return cfg
  } catch (e) {
    if (e.code === 'ENOENT') return null
    fail(`routines.json unreadable: ${e.message}`)
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  const tmp = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, CONFIG_PATH)
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) } catch { return {} }
}

function saveState(state) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const tmp = STATE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, STATE_PATH)
}

// ---------------------------------------------------------------------------
// Cron parsing (subset: each field * or integer; dom/month must be *)
// ---------------------------------------------------------------------------
function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron "${expr}" must have 5 fields`)
  const [minute, hour, dom, month, dow] = parts
  const num = (v, lo, hi, label) => {
    if (v === '*') return undefined
    const n = parseInt(v, 10)
    if (!Number.isInteger(n) || String(n) !== v || n < lo || n > hi) throw new Error(`cron "${expr}": ${label} must be * or ${lo}-${hi}`)
    return n
  }
  if (dom !== '*' || month !== '*') throw new Error(`cron "${expr}": day-of-month and month must be * (launchd/systemd translation)`)
  const m = num(minute, 0, 59, 'minute')
  const h = num(hour, 0, 23, 'hour')
  const w = num(dow, 0, 6, 'day-of-week')
  if (m === undefined || h === undefined) throw new Error(`cron "${expr}": minute and hour must be integers (wildcard minute/hour schedules are not supported)`)
  return { minute: m, hour: h, weekday: w }
}

function intervalMs(cron) {
  return parseCron(cron).weekday !== undefined ? 7 * 24 * 3600e3 : 24 * 3600e3
}

// ---------------------------------------------------------------------------
// Scheduler backends. Binaries overridable via env so tests can shim the
// platform without root; --scheduler forces a backend.
// ---------------------------------------------------------------------------
const BIN = {
  launchctl: process.env.EM_ROUTINES_LAUNCHCTL || 'launchctl',
  plutil: process.env.EM_ROUTINES_PLUTIL || 'plutil',
  systemctl: process.env.EM_ROUTINES_SYSTEMCTL || 'systemctl',
  crontab: process.env.EM_ROUTINES_CRONTAB || 'crontab',
}

function have(cmd) {
  return spawnSync('/bin/sh', ['-c', `command -v ${JSON.stringify(cmd)} >/dev/null 2>&1`], { encoding: 'utf8' }).status === 0
}

function detectScheduler() {
  const forced = flag('--scheduler')
  if (forced) {
    if (!['launchd', 'systemd', 'cron'].includes(forced)) fail(`Invalid --scheduler "${forced}". Must be launchd, systemd, or cron.`, 2)
    return forced
  }
  if (process.platform === 'darwin' && have(BIN.launchctl)) return 'launchd'
  if (process.platform === 'linux' && have(BIN.systemctl)) {
    if (spawnSync(BIN.systemctl, ['--user', 'show-environment'], { encoding: 'utf8' }).status === 0) return 'systemd'
  }
  if (have(BIN.crontab)) return 'cron'
  return null
}

const nodeBin = process.execPath
const selfPath = path.join(SCRIPT_DIR, 'em-routines.mjs')
const payload = name => `${nodeBin} ${selfPath} run ${name}`
const logFile = name => path.join(LOG_DIR, `${name}.log`)

// --- launchd ---------------------------------------------------------------
const LA_DIR = path.join(HOME, 'Library', 'LaunchAgents')
const plistPath = name => path.join(LA_DIR, `com.${NAMESPACE}.${name}.plist`)
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0)

function launchdApply(routines) {
  fs.mkdirSync(LA_DIR, { recursive: true })
  const applied = []
  for (const r of routines) {
    const { minute, hour, weekday } = parseCron(r.cron)
    const cal = [
      ...(weekday !== undefined ? [`        <key>Weekday</key>\n        <integer>${weekday}</integer>`] : []),
      `        <key>Hour</key>\n        <integer>${hour}</integer>`,
      `        <key>Minute</key>\n        <integer>${minute}</integer>`,
    ].join('\n')
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.${NAMESPACE}.${r.name}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodeBin}</string>
        <string>${selfPath}</string>
        <string>run</string>
        <string>${r.name}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
${cal}
    </dict>
    <key>StandardOutPath</key>
    <string>${logFile(r.name)}</string>
    <key>StandardErrorPath</key>
    <string>${logFile(r.name)}</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`
    const p = plistPath(r.name)
    if (dryRun) { applied.push({ routine: r.name, plist: p, dry_run: true }); continue }
    fs.writeFileSync(p + '.tmp', plist, 'utf8')
    const lint = spawnSync(BIN.plutil, ['-lint', p + '.tmp'], { encoding: 'utf8' })
    if (lint.status !== 0) { fs.rmSync(p + '.tmp', { force: true }); throw new Error(`plist lint failed for ${r.name}: ${lint.stderr || lint.stdout}`) }
    fs.renameSync(p + '.tmp', p)
    spawnSync(BIN.launchctl, ['bootout', `gui/${uid()}`, p], { encoding: 'utf8' })
    const boot = spawnSync(BIN.launchctl, ['bootstrap', `gui/${uid()}`, p], { encoding: 'utf8' })
    if (boot.status !== 0) throw new Error(`launchctl bootstrap failed for ${r.name}: ${boot.stderr}`)
    applied.push({ routine: r.name, plist: p })
  }
  return applied
}

function launchdRemove(names) {
  const removed = []
  for (const name of names) {
    const p = plistPath(name)
    if (!fs.existsSync(p)) continue
    if (!dryRun) {
      spawnSync(BIN.launchctl, ['bootout', `gui/${uid()}`, p], { encoding: 'utf8' })
      fs.rmSync(p, { force: true })
    }
    removed.push({ routine: name, plist: p })
  }
  return removed
}

const launchdPresent = name => fs.existsSync(plistPath(name))

// --- systemd user timers -----------------------------------------------------
const SYSTEMD_DIR = path.join(HOME, '.config', 'systemd', 'user')
const unitBase = name => `${NAMESPACE}-${name}`

function systemdApply(routines) {
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true })
  const applied = []
  for (const r of routines) {
    const { minute, hour, weekday } = parseCron(r.cron)
    const hh = String(hour).padStart(2, '0')
    const mm = String(minute).padStart(2, '0')
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const onCal = weekday !== undefined ? `${days[weekday]} *-*-* ${hh}:${mm}:00` : `*-*-* ${hh}:${mm}:00`
    const svcPath = path.join(SYSTEMD_DIR, `${unitBase(r.name)}.service`)
    const tmrPath = path.join(SYSTEMD_DIR, `${unitBase(r.name)}.timer`)
    if (dryRun) { applied.push({ routine: r.name, timer: tmrPath, dry_run: true }); continue }
    fs.writeFileSync(svcPath, `[Unit]\nDescription=episodic-memory ${r.name} routine\n\n[Service]\nType=oneshot\nExecStart=/bin/sh -c '${payload(r.name)} >> ${logFile(r.name)} 2>&1'\n`, 'utf8')
    fs.writeFileSync(tmrPath, `[Unit]\nDescription=episodic-memory ${r.name} schedule\n\n[Timer]\nOnCalendar=${onCal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`, 'utf8')
    applied.push({ routine: r.name, service: svcPath, timer: tmrPath })
  }
  if (!dryRun && applied.length) {
    const reload = spawnSync(BIN.systemctl, ['--user', 'daemon-reload'], { encoding: 'utf8' })
    if (reload.status !== 0) throw new Error(`systemctl --user daemon-reload failed: ${reload.stderr}`)
    for (const r of routines) {
      const en = spawnSync(BIN.systemctl, ['--user', 'enable', '--now', `${unitBase(r.name)}.timer`], { encoding: 'utf8' })
      if (en.status !== 0) throw new Error(`systemctl enable failed for ${r.name}: ${en.stderr}`)
    }
  }
  return applied
}

function systemdRemove(names) {
  const removed = []
  for (const name of names) {
    const svcPath = path.join(SYSTEMD_DIR, `${unitBase(name)}.service`)
    const tmrPath = path.join(SYSTEMD_DIR, `${unitBase(name)}.timer`)
    if (!fs.existsSync(tmrPath) && !fs.existsSync(svcPath)) continue
    if (!dryRun) {
      spawnSync(BIN.systemctl, ['--user', 'disable', '--now', `${unitBase(name)}.timer`], { encoding: 'utf8' })
      fs.rmSync(tmrPath, { force: true })
      fs.rmSync(svcPath, { force: true })
    }
    removed.push({ routine: name, timer: tmrPath })
  }
  if (removed.length && !dryRun) spawnSync(BIN.systemctl, ['--user', 'daemon-reload'], { encoding: 'utf8' })
  return removed
}

const systemdPresent = name => fs.existsSync(path.join(SYSTEMD_DIR, `${unitBase(name)}.timer`))

// --- cron (managed block; foreign entries preserved byte-for-byte) -----------
function readCrontab() {
  const r = spawnSync(BIN.crontab, ['-l'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout : ''
}

function writeCrontab(content) {
  const r = spawnSync(BIN.crontab, ['-'], { input: content, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`crontab write failed: ${r.stderr}`)
}

function stripManagedBlock(content) {
  const out = []
  let inBlock = false
  for (const line of content.split('\n')) {
    if (line.trim() === CRON_BEGIN) { inBlock = true; continue }
    if (line.trim() === CRON_END) { inBlock = false; continue }
    if (!inBlock) out.push(line)
  }
  return out.join('\n').replace(/\n{2,}$/, '\n')
}

function cronApply(routines) {
  const entries = routines.map(r => `${r.cron} ${payload(r.name)} >> ${logFile(r.name)} 2>&1`)
  if (dryRun) return routines.map((r, i) => ({ routine: r.name, entry: entries[i], dry_run: true }))
  const foreign = stripManagedBlock(readCrontab())
  const block = entries.length ? [CRON_BEGIN, ...entries, CRON_END].join('\n') + '\n' : ''
  writeCrontab((foreign && foreign.trim() ? foreign.replace(/\n?$/, '\n') : '') + block)
  return routines.map((r, i) => ({ routine: r.name, entry: entries[i] }))
}

function cronRemove() {
  const existing = readCrontab()
  if (!existing.includes(CRON_BEGIN)) return []
  if (!dryRun) writeCrontab(stripManagedBlock(existing))
  return [{ managed_block: 'removed' }]
}

const cronPresent = name => readCrontab().includes(`${selfPath} run ${name}`)

// ---------------------------------------------------------------------------
// Built-in executors (run in HOME; global scope — scheduled runs have no
// project cwd, so local-store resolution would be meaningless)
// ---------------------------------------------------------------------------
function runScript(name, args) {
  const r = spawnSync(nodeBin, [path.join(SCRIPT_DIR, name), ...args], { encoding: 'utf8', cwd: HOME, maxBuffer: 64 * 1024 * 1024 })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch {}
  return { code: r.status, json, stderr: (r.stderr || '').slice(0, 500) }
}

function execBuiltin(name) {
  if (name === 'doctor') {
    const r = runScript('em-doctor.mjs', ['--scope', 'global', '--fix'])
    return { ok: r.code === 0 && !!r.json, detail: r.json ? { summary: r.json.summary, fixes: r.json.fixes || [] } : { stderr: r.stderr } }
  }
  if (name === 'embed') {
    const configured = fs.existsSync(path.join(GLOBAL_DIR, 'embed-config.json')) || fs.existsSync(path.join(GLOBAL_DIR, 'embeddings.jsonl'))
    if (!configured) return { ok: true, skipped: 'semantic search not configured (no embed-config.json or embeddings.jsonl)' }
    const r = runScript('em-embed.mjs', ['--scope', 'global'])
    return { ok: r.code === 0 && !!r.json, detail: r.json?.scopes ? { scopes: r.json.scopes } : { stderr: r.stderr } }
  }
  if (name === 'backup-sync') {
    const candidates = [process.env.EM_BACKUP_CONFIG, path.join(HOME, '.config/em-backup/config.json')].filter(Boolean)
    if (!candidates.some(c => fs.existsSync(c))) return { ok: true, skipped: 'backup not configured (no em-backup config)' }
    const r = spawnSync(nodeBin, [
      path.join(SCRIPT_DIR, 'em-lock.mjs'), '--file', path.join(GLOBAL_DIR, 'backup-sync.lock'), '--timeout', '60', '--',
      nodeBin, path.join(SCRIPT_DIR, 'em-backup.mjs'), '--sync',
    ], { encoding: 'utf8', cwd: HOME, maxBuffer: 64 * 1024 * 1024 })
    return { ok: r.status === 0, detail: { exit: r.status, output: (r.stdout || '').trim().slice(-500) } }
  }
  if (name === 'hygiene-report') {
    const stats = runScript('em-stats.mjs', ['--scope', 'global'])
    const consolidate = runScript('em-consolidate.mjs', ['--scope', 'global'])
    const prune = runScript('em-prune.mjs', ['--scope', 'global', '--dry-run'])
    return {
      ok: stats.code === 0,
      detail: {
        episodes: stats.json?.scopes?.[0]?.episodes ?? null,
        prunable_estimate: stats.json?.scopes?.[0]?.prunable_estimate ?? null,
        consolidatable_clusters: consolidate.json?.clusters?.length ?? null,
        prunable: prune.json?.results?.[0]?.prunable ?? prune.json?.prunable ?? null,
        hint: 'read-only report — run em-consolidate --apply / em-prune yourself if warranted',
      },
    }
  }
  return { ok: false, detail: { error: `no builtin named "${name}"` } }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function requireConfig() {
  const cfg = loadConfig()
  if (!cfg) fail('No routines.json yet — run `em-routines sync` first (it seeds the defaults).')
  return cfg
}

function enabledRoutines(cfg) {
  return cfg.routines.filter(r => r.enabled !== false)
}

function doSync(cfg) {
  // Scheduler is STICKY: once synced, later syncs (enable/disable/add/remove)
  // reuse cfg.scheduler unless --scheduler explicitly overrides — otherwise a
  // re-sync could silently switch backends and orphan the old entries.
  const scheduler = flag('--scheduler') ? detectScheduler() : (cfg.scheduler || detectScheduler())
  if (!scheduler) fail('No usable scheduler found (need launchd, a user systemd session, or crontab).')
  // validate every cron up front — one bad expression must not half-apply
  for (const r of cfg.routines) parseCron(r.cron)
  if (!dryRun) fs.mkdirSync(LOG_DIR, { recursive: true })
  const enabled = enabledRoutines(cfg)
  const disabledNames = cfg.routines.filter(r => r.enabled === false).map(r => r.name)
  let applied, removed
  if (scheduler === 'launchd') { applied = launchdApply(enabled); removed = launchdRemove(disabledNames) }
  else if (scheduler === 'systemd') { applied = systemdApply(enabled); removed = systemdRemove(disabledNames) }
  else { applied = cronApply(enabled); removed = disabledNames.length ? [{ note: 'disabled routines omitted from managed block' }] : [] }
  if (!dryRun) {
    cfg.synced_at = new Date().toISOString()
    cfg.scheduler = scheduler
    saveConfig(cfg)
  }
  return { status: 'ok', scheduler, applied, removed, ...(dryRun ? { dry_run: true } : {}), log_dir: LOG_DIR }
}

if (action === 'sync') {
  const cfg = loadConfig() || defaultConfig()
  if (!fs.existsSync(CONFIG_PATH) && !dryRun) saveConfig(cfg)
  console.log(JSON.stringify(doSync(cfg)))
  process.exit(0)
}

if (action === 'list' || action === 'status' || action === undefined) {
  const cfg = loadConfig()
  if (!cfg) {
    console.log(JSON.stringify({ status: 'ok', configured: false, hint: 'run `em-routines sync` to seed routines.json and schedule the defaults' }))
    process.exit(0)
  }
  const scheduler = cfg.scheduler || detectScheduler()
  const state = loadState()
  const present = name =>
    scheduler === 'launchd' ? launchdPresent(name)
    : scheduler === 'systemd' ? systemdPresent(name)
    : scheduler === 'cron' ? cronPresent(name)
    : false
  const now = Date.now()
  const routines = cfg.routines.map(r => {
    const st = state[r.name] || null
    const lastMs = st ? Date.parse(st.ts) : NaN
    const baseline = Number.isFinite(lastMs) ? lastMs : (cfg.synced_at ? Date.parse(cfg.synced_at) : NaN)
    const stale = r.enabled !== false && present(r.name) && Number.isFinite(baseline)
      && (now - baseline) > 2 * intervalMs(r.cron)
    return {
      name: r.name,
      cron: r.cron,
      kind: r.builtin ? 'builtin' : 'custom',
      enabled: r.enabled !== false,
      scheduled: present(r.name),
      last_run: st,
      ...(stale ? { stale: true } : {}),
    }
  })
  console.log(JSON.stringify({ status: 'ok', configured: true, scheduler, synced_at: cfg.synced_at || null, routines, log_dir: LOG_DIR }))
  process.exit(routines.some(r => r.stale) ? 1 : 0)
}

if (action === 'run') {
  const name = argv[1]
  if (!name) fail('Usage: em-routines run <name>', 2)
  const cfg = requireConfig()
  const routine = cfg.routines.find(r => r.name === name)
  if (!routine) fail(`Unknown routine "${name}". Configured: ${cfg.routines.map(r => r.name).join(', ')}`, 2)
  const started = Date.now()
  let result
  if (routine.builtin) {
    result = execBuiltin(routine.builtin)
  } else {
    const r = spawnSync('/bin/sh', ['-c', routine.cmd], { encoding: 'utf8', cwd: HOME, maxBuffer: 64 * 1024 * 1024 })
    result = { ok: r.status === 0, detail: { exit: r.status, output: (r.stdout || '').trim().slice(-500), stderr: (r.stderr || '').slice(0, 300) } }
  }
  const record = {
    ts: new Date().toISOString(),
    status: result.ok ? (result.skipped ? 'skipped' : 'ok') : 'error',
    duration_ms: Date.now() - started,
    ...(result.skipped ? { skipped: result.skipped } : {}),
  }
  const state = loadState()
  state[name] = record
  saveState(state)
  console.log(JSON.stringify({ status: record.status === 'error' ? 'error' : 'ok', routine: name, ...record, ...(result.detail ? { detail: result.detail } : {}) }))
  process.exit(result.ok ? 0 : 1)
}

if (action === 'enable' || action === 'disable') {
  const name = argv[1]
  if (!name) fail(`Usage: em-routines ${action} <name>`, 2)
  const cfg = requireConfig()
  const routine = cfg.routines.find(r => r.name === name)
  if (!routine) fail(`Unknown routine "${name}".`, 2)
  routine.enabled = action === 'enable'
  saveConfig(cfg)
  console.log(JSON.stringify({ ...doSync(cfg), [action + 'd']: name }))
  process.exit(0)
}

if (action === 'add') {
  const name = flag('--name')
  const cron = flag('--cron')
  const cmd = flag('--cmd')
  if (!name || !cron || !cmd) fail('Usage: em-routines add --name <n> --cron "<5-field>" --cmd "<command>"', 2)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(`Invalid name "${name}" (lowercase alphanumerics and dashes).`, 2)
  try { parseCron(cron) } catch (e) { fail(e.message, 2) }
  const cfg = loadConfig() || defaultConfig()
  if (cfg.routines.some(r => r.name === name)) fail(`Routine "${name}" already exists (remove it first).`, 2)
  cfg.routines.push({ name, cron, cmd, enabled: true })
  saveConfig(cfg)
  console.log(JSON.stringify({ ...doSync(cfg), added: name }))
  process.exit(0)
}

if (action === 'remove') {
  const name = argv[1]
  if (!name) fail('Usage: em-routines remove <name>', 2)
  const cfg = requireConfig()
  const idx = cfg.routines.findIndex(r => r.name === name)
  if (idx === -1) fail(`Unknown routine "${name}".`, 2)
  const scheduler = cfg.scheduler || detectScheduler()
  if (!dryRun) {
    if (scheduler === 'launchd') launchdRemove([name])
    else if (scheduler === 'systemd') systemdRemove([name])
    cfg.routines.splice(idx, 1)
    saveConfig(cfg)
  }
  console.log(JSON.stringify({ ...doSync(cfg), removed_routine: name }))
  process.exit(0)
}

if (action === 'logs') {
  const name = argv[1]
  if (!name) fail('Usage: em-routines logs <name> [--lines <n>]', 2)
  const lines = parseInt(flag('--lines') || '20', 10)
  let content = ''
  try { content = fs.readFileSync(logFile(name), 'utf8') } catch {}
  const tail = content.split('\n').filter(Boolean).slice(-lines)
  console.log(JSON.stringify({ status: 'ok', routine: name, log: logFile(name), lines: tail, last_run: loadState()[name] || null }))
  process.exit(0)
}

if (action === 'uninstall') {
  const cfg = loadConfig()
  const scheduler = (cfg && cfg.scheduler) || detectScheduler()
  const names = cfg ? cfg.routines.map(r => r.name) : Object.keys(BUILTINS)
  let removed = []
  if (scheduler === 'launchd') removed = launchdRemove(names)
  else if (scheduler === 'systemd') removed = systemdRemove(names)
  else if (scheduler === 'cron') removed = cronRemove()
  if (cfg && !dryRun) { delete cfg.synced_at; delete cfg.scheduler; saveConfig(cfg) }
  console.log(JSON.stringify({ status: 'ok', scheduler, removed, ...(dryRun ? { dry_run: true } : {}), note: 'routines.json and logs preserved' }))
  process.exit(0)
}

fail(`Unknown action "${action}". Run with --help for usage.`, 2)
