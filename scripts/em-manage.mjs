#!/usr/bin/env node
/**
 * em-manage.mjs — interactive day-2 maintenance wizard for the episodic
 * memory stores.
 *
 * Usage:
 *   node em-manage.mjs
 *
 * Presentation layer (CAPABILITIES.md "Adjacent layers", Principle 11): every
 * action spawns a sibling em-* script and presents its JSON; the wizard never
 * decides anything about episodes itself. Destructive-looking actions (fold,
 * prune) always run the dry-run first and ask before applying (Principle 10).
 *
 * This is an interactive PROSE surface (like `em help`): menus and summaries
 * are for humans. Every underlying operation still emits JSON — pick the raw
 * option on any action to see it verbatim, or run the printed command
 * directly.
 *
 * Scriptable via piped stdin (same buffered reader as install-wizard.mjs):
 *   printf '1\nn\nq\n' | node em-manage.mjs
 * EOF resolves any pending prompt to its default, so the wizard never hangs.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import readline from 'readline/promises'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const HOME = os.homedir()

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(JSON.stringify({
    status: 'help',
    script: 'em-manage.mjs',
    usage: 'node em-manage.mjs — interactive day-2 maintenance wizard (status, hygiene: rebuild-index/fold/prune/doctor-fix, backup, capture drafts, routines, launch em-console). Dry-run first on destructive-looking actions; scriptable via piped stdin (EOF takes defaults).',
  }))
  process.exit(0)
}

// Buffered line reader (pattern proven in install-wizard.mjs): queue lines as
// they arrive; EOF resolves pending/future asks to null so piped input can
// never hang the wizard.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })
const lineQueue = []
let stdinClosed = false
let lineWaiter = null
rl.on('line', (line) => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line) }
  else lineQueue.push(line)
})
rl.on('close', () => {
  stdinClosed = true
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(null) }
})

function nextLine() {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift())
  if (stdinClosed) return Promise.resolve(null)
  return new Promise((resolve) => { lineWaiter = resolve })
}

async function ask(question, def) {
  const suffix = def !== undefined && def !== '' ? ` [${def}]` : ''
  process.stdout.write(`${question}${suffix}: `)
  const raw = await nextLine()
  if (raw === null) { process.stdout.write('(eof — using default)\n'); return def ?? '' }
  const answer = raw.trim()
  return answer === '' ? (def ?? '') : answer
}

async function askYesNo(question, defYes = false) {
  process.stdout.write(`${question} [${defYes ? 'Y/n' : 'y/N'}]: `)
  const raw = await nextLine()
  if (raw === null) { process.stdout.write('(eof — using default)\n'); return defYes }
  const answer = raw.trim().toLowerCase()
  if (answer === '') return defYes
  return answer === 'y' || answer === 'yes'
}

function runJson(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPT_DIR, script), ...args], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim()) } catch { /* raw fallback below */ }
  return { code: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function printResult(label, r, { rawRequested = false } = {}) {
  if (!r.json) {
    console.log(`  ✗ ${label}: no JSON output (exit ${r.code})`)
    if (r.stdout.trim()) console.log(r.stdout.trim().slice(0, 2000))
    if (r.stderr.trim()) console.log(r.stderr.trim().slice(0, 2000))
    return
  }
  const mark = r.code === 0 && r.json.status !== 'error' ? '✓' : '✗'
  console.log(`  ${mark} ${label}: ${r.json.status}${r.json.message ? ` — ${r.json.message}` : ''}`)
  if (rawRequested) console.log(JSON.stringify(r.json, null, 2))
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function actionStatus() {
  const allProjects = await askYesNo('Include every registered project store (--all-projects)?', false)
  const extra = allProjects ? ['--all-projects'] : []

  const doctor = runJson('em-doctor.mjs', ['--scope', 'all', ...extra])
  if (doctor.json && doctor.json.summary) {
    const { ok, warn, error } = doctor.json.summary
    console.log(`\n  doctor: ${doctor.json.status} (${ok} ok, ${warn} warn, ${error} error)`)
    for (const c of (doctor.json.checks || []).filter((c) => c.level !== 'ok')) {
      console.log(`    ${c.level.toUpperCase().padEnd(5)} [${c.id}${c.scope && c.scope !== '-' ? `:${c.scope}` : ''}] ${c.message}`)
    }
  } else {
    printResult('doctor', doctor)
  }

  const stats = runJson('em-stats.mjs', ['--scope', 'all', ...extra])
  if (stats.json && stats.json.scopes) {
    console.log('  stats:')
    for (const s of stats.json.scopes) {
      const ep = s.episodes || {}
      console.log(`    ${String(s.scope || s.label || '?').padEnd(24)} active=${ep.active ?? '?'} superseded=${ep.superseded ?? '?'} pinned=${ep.pinned ?? '?'}`)
    }
  } else {
    printResult('stats', stats)
  }

  if (await askYesNo('Show raw JSON?', false)) {
    if (doctor.json) console.log(JSON.stringify(doctor.json, null, 2))
    if (stats.json) console.log(JSON.stringify(stats.json, null, 2))
  }
}

// Dry-run first, show the impact, then ask before applying. The dry-run and
// the apply are the SAME command shape minus the flag, so what you preview is
// what you run.
async function dryRunThenApply(label, script, applyArgs, dryArgs) {
  console.log(`\n  [preview] ${label} (dry-run)`)
  const dry = runJson(script, dryArgs)
  printResult(`${label} dry-run`, dry, { rawRequested: true })
  if (dry.code !== 0 || !dry.json || dry.json.status === 'error') {
    console.log('  dry-run failed — not offering apply.')
    return
  }
  if (!(await askYesNo(`Apply ${label}?`, false))) {
    console.log('  left untouched (dry-run only).')
    return
  }
  const applied = runJson(script, applyArgs)
  printResult(`${label} apply`, applied, { rawRequested: true })
}

async function actionHygiene() {
  console.log('\n  1. rebuild-index   regenerate index files (scope all)')
  console.log('  2. fold            archive non-terminal supersedes-chain members (dry-run first)')
  console.log('  3. prune           archive stale low-relevance episodes (dry-run first)')
  console.log('  4. doctor-fix      run em-doctor --fix (scope all)')
  const pick = await ask('Choose', '1')
  if (pick === '1') {
    printResult('rebuild-index', runJson('em-rebuild-index.mjs', ['--scope', 'all']), { rawRequested: true })
  } else if (pick === '2') {
    const scope = await ask('Scope (local|global)', 'local')
    if (!['local', 'global'].includes(scope)) return console.log('  invalid scope — back to menu.')
    await dryRunThenApply('fold-superseded', 'em-consolidate.mjs',
      ['--fold-superseded', '--scope', scope],
      ['--fold-superseded', '--dry-run', '--scope', scope])
  } else if (pick === '3') {
    const scope = await ask('Scope (local|global|all)', 'local')
    if (!['local', 'global', 'all'].includes(scope)) return console.log('  invalid scope — back to menu.')
    await dryRunThenApply('prune', 'em-prune.mjs',
      ['--scope', scope],
      ['--dry-run', '--scope', scope])
  } else if (pick === '4') {
    printResult('doctor --fix', runJson('em-doctor.mjs', ['--scope', 'all', '--fix']), { rawRequested: true })
  } else {
    console.log('  unknown choice — back to menu.')
  }
}

async function actionBackup() {
  const configPath = path.join(HOME, '.config/em-backup/config.json')
  if (!fs.existsSync(configPath)) {
    console.log(`\n  No backup config at ${configPath}.`)
    console.log('  Set one up with the install wizard (node install.mjs --wizard) or see: em backup --help')
    return
  }
  printResult('backup config', runJson('em-backup.mjs', ['--show-config']), { rawRequested: true })
  if (await askYesNo('Run a backup sync now?', false)) {
    printResult('backup --sync', runJson('em-backup.mjs', ['--sync']), { rawRequested: true })
  }
}

async function actionCapture() {
  const r = runJson('em-capture.mjs', ['list'])
  printResult('pending drafts', r, { rawRequested: true })
  console.log('  Review a draft (accept/reject episodes) with:')
  console.log('    em capture review --draft <id> --accept <n,...>   (or --accept-all | --discard)')
}

async function actionRoutines() {
  printResult('routines list', runJson('em-routines.mjs', ['list']), { rawRequested: true })
  if (await askYesNo('Sync routines.json to the platform scheduler now?', false)) {
    printResult('routines sync', runJson('em-routines.mjs', ['sync']), { rawRequested: true })
  }
}

async function actionConsole() {
  const write = await askYesNo('Enable write commands in the console (--allow-write)?', false)
  console.log('  Launching em-console — open the printed URL; Ctrl+C returns here.\n')
  const args = [path.join(SCRIPT_DIR, 'em-console.mjs'), ...(write ? ['--allow-write'] : [])]
  spawnSync(process.execPath, args, { stdio: 'inherit' })
}

// ---------------------------------------------------------------------------
// Menu loop
// ---------------------------------------------------------------------------
console.log('episodic-memory manager')
console.log('═══════════════════════')

const MENU = [
  ['1', 'status', 'store health + analytics (doctor, stats)', actionStatus],
  ['2', 'hygiene', 'rebuild-index / fold superseded / prune / doctor --fix', actionHygiene],
  ['3', 'backup', 'show backup config, run a sync', actionBackup],
  ['4', 'capture', 'pending session-capture drafts', actionCapture],
  ['5', 'routines', 'scheduled maintenance (list, sync)', actionRoutines],
  ['6', 'console', 'launch the local web console (em-console)', actionConsole],
]

let exit = 0
try {
  for (;;) {
    console.log('')
    for (const [key, name, desc] of MENU) console.log(`  ${key}. ${name.padEnd(9)} ${desc}`)
    console.log('  q. quit')
    const choice = (await ask('Choose', 'q')).toLowerCase()
    if (choice === 'q' || choice === 'quit' || choice === '') break
    const entry = MENU.find(([key, name]) => key === choice || name === choice)
    if (!entry) { console.log(`  unknown choice "${choice}"`); continue }
    await entry[3]()
    if (stdinClosed && lineQueue.length === 0) break // piped input exhausted
  }
} catch (err) {
  console.log(`  error: ${err.message}`)
  exit = 1
} finally {
  rl.close()
}
process.exit(exit)
