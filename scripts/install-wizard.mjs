#!/usr/bin/env node
/**
 * install-wizard.mjs — interactive guided setup for episodic-memory.
 * Invoked via `node install.mjs --wizard` (or directly). Repo-dev script:
 * runs from the clone, ships nowhere (Principle 12 — it drives install.mjs,
 * which is only meaningful clone-side).
 *
 * Three flows:
 *   install  — prerequisite checks → tool + project selection → optional
 *              Claude Code hooks / second-opinion → optional backup config →
 *              runs install.mjs non-interactively per tool → PATH shim offer
 *              → verifies the result with em-doctor.
 *   migrate  — clone (or reuse) an em-backup repository and restore it into
 *              the stores via em-restore (dry-run preview, then confirmed
 *              --apply), then verify with em-doctor.
 *   doctor   — health-check the stores; offer --fix when issues are found.
 *
 * Answers are read from stdin, so the wizard is scriptable:
 *   printf '1\n1\n/path/to/proj\nn\nn\nn\n' | node install.mjs --wizard
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import readline from 'readline/promises'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.dirname(SCRIPT_DIR)
const INSTALL = path.join(REPO_DIR, 'install.mjs')
const HOME = os.homedir()
const GLOBAL_DIR = path.join(HOME, '.episodic-memory')

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'install-wizard.mjs', usage: 'node install.mjs --wizard — interactive guided setup (install | migrate-from-backup | doctor)' }))
  process.exit(0)
}

// Buffered line reader. Plain rl.question() drops piped lines that arrive
// while no question is pending (and leaves an unsettled await at EOF), which
// breaks the scriptable `printf '...' | node install.mjs --wizard` shape.
// Queue every line as it arrives; EOF resolves pending/future asks to null
// (callers then take the default), so the wizard can never hang.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })
const lineQueue = []
let stdinClosed = false
let lineWaiter = null
rl.on('line', line => {
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
  return new Promise(resolve => { lineWaiter = resolve })
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

function expandHome(p) {
  if (!p) return p
  if (p === '~') return HOME
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2))
  return p
}

function runVisible(cmd, args, opts) {
  console.log(`\n$ ${cmd === process.execPath ? 'node' : cmd} ${args.join(' ')}`)
  return spawnSync(cmd, args, { stdio: 'inherit', ...opts })
}

function runJson(args, opts) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', ...opts })
  let json = null
  try { json = JSON.parse((r.stdout || '').trim().split('\n').pop()) } catch {}
  return { code: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const OK = '  ✓'
const BAD = '  ✗'

// ---------------------------------------------------------------------------
// Step 1: prerequisites. Zero npm dependencies by design — the "dependencies"
// are the two runtime tools everything else assumes.
// ---------------------------------------------------------------------------
function checkPrerequisites() {
  console.log('\n[1/2] Checking prerequisites (zero npm dependencies — Node.js stdlib only)')
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10)
  if (nodeMajor >= 18) {
    console.log(`${OK} Node.js ${process.versions.node}`)
  } else {
    console.log(`${BAD} Node.js ${process.versions.node} — version 18+ required. Install a current LTS from https://nodejs.org and re-run.`)
    return false
  }
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' })
  if (git.status === 0) {
    console.log(`${OK} ${git.stdout.trim()}`)
  } else {
    console.log(`${BAD} git not found — required for backup/restore and updating the clone. Install git, or continue without backup features.`)
  }
  return true
}

// ---------------------------------------------------------------------------
// Install flow
// ---------------------------------------------------------------------------
const TOOL_MENU = [
  ['claude-code', 'Claude Code (skill + optional session hooks)'],
  ['cursor', 'Cursor (.cursor/rules)'],
  ['codex', 'Codex / OpenAI (.agents/skills)'],
  ['windsurf', 'Windsurf / Continue (.windsurfrules)'],
  ['opencode', 'OpenCode (.opencode/skills)'],
  ['pi-agent', 'Pi Agent (.agents/skills, shared with Codex)'],
]

async function flowInstall() {
  // --- tools ---------------------------------------------------------------
  console.log('\nWhich tools should share the memory? (all selected tools read/write the SAME store)')
  TOOL_MENU.forEach(([id, desc], i) => console.log(`  ${i + 1}. ${id.padEnd(12)} ${desc}`))
  const rawTools = await ask('Select by number, comma-separated, or "all"', '1')
  let tools
  if (rawTools.toLowerCase() === 'all') {
    tools = TOOL_MENU.map(([id]) => id)
  } else {
    tools = [...new Set(rawTools.split(',').map(s => parseInt(s.trim(), 10)))]
      .filter(n => n >= 1 && n <= TOOL_MENU.length)
      .map(n => TOOL_MENU[n - 1][0])
  }
  if (tools.length === 0) {
    console.log('No valid tool selection — aborting.')
    return 1
  }

  // --- project -------------------------------------------------------------
  let projectDir
  for (let attempts = 0; ; attempts++) {
    if (attempts >= 3) {
      console.log('No usable project path after 3 attempts — aborting.')
      return 1
    }
    projectDir = path.resolve(expandHome(await ask('Project to install into (absolute path)', process.cwd())))
    if (path.resolve(projectDir) === path.resolve(REPO_DIR)) {
      const sure = await askYesNo('That is the episodic-memory clone itself — installing here is usually a mistake. Continue anyway?', false)
      if (!sure) continue
    }
    if (!fs.existsSync(projectDir)) {
      if (await askYesNo(`${projectDir} does not exist. Create it?`, false)) {
        fs.mkdirSync(projectDir, { recursive: true })
      } else {
        continue
      }
    }
    break
  }

  // --- claude-code extras ----------------------------------------------------
  const extras = []
  if (tools.includes('claude-code')) {
    if (await askYesNo('Install Claude Code session hooks (proactive recall on session start)?', true)) {
      extras.push('--install-hooks')
    }
    if (await askYesNo('Install the second-opinion review harness registry?', false)) {
      extras.push('--install-second-opinion')
    }
  }

  // --- backup config ---------------------------------------------------------
  await maybeConfigureBackup()

  // --- run the installs -------------------------------------------------------
  console.log(`\nInstalling for: ${tools.join(', ')}  →  ${projectDir}`)
  for (const t of tools) {
    const args = [INSTALL, '--tool', t, '--project', projectDir, ...(t === 'claude-code' ? extras : [])]
    const r = runVisible(process.execPath, args)
    if (r.status !== 0) {
      console.log(`\n${BAD} install failed for ${t} (exit ${r.status}) — stopping here so you can inspect the output above.`)
      return 1
    }
  }

  await maybeAddPathShim()
  await maybeConfigureSemantic(projectDir)
  await maybeConfigureRoutines()
  return verifyWithDoctor(projectDir)
}

async function maybeConfigureBackup() {
  const configPath = path.join(HOME, '.config/em-backup/config.json')
  if (fs.existsSync(configPath)) {
    console.log(`${OK} Backup already configured (${configPath})`)
    return
  }
  if (!(await askYesNo('Configure automatic backup to a private git repository?', false))) return
  const owner = await ask('GitHub owner (user/org) for the backup repo')
  const repo = await ask('Backup repository name', 'episodic-memory-backup')
  const backupDir = expandHome(await ask('Local backup working dir', '~/.local/share/episodic-memory-backup'))
  if (!owner || !repo) {
    console.log('  Skipping backup config (owner/repo required).')
    return
  }
  const config = {
    repo_owner: owner,
    repo_name: repo,
    backup_dir: backupDir,
    sources: [{ src: '~/.episodic-memory', dest: 'global', label: 'global' }],
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  console.log(`${OK} Wrote ${configPath}`)
  console.log('    Initialize + first sync when ready:  em backup --init && em backup --sync')
}

async function maybeAddPathShim() {
  const binDir = path.join(GLOBAL_DIR, 'bin')
  if ((process.env.PATH || '').split(path.delimiter).includes(binDir)) {
    console.log(`${OK} ${binDir} already on PATH — the "em" command is ready`)
    return
  }
  const exportLine = 'export PATH="$HOME/.episodic-memory/bin:$PATH"'
  const shell = process.env.SHELL || ''
  const rc = shell.endsWith('zsh') ? path.join(HOME, '.zshrc')
    : shell.endsWith('bash') ? path.join(HOME, '.bashrc')
    : path.join(HOME, '.profile')
  if (await askYesNo(`Add the "em" command to your PATH via ${rc}?`, true)) {
    const existing = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : ''
    if (existing.includes('.episodic-memory/bin')) {
      console.log(`${OK} ${rc} already references .episodic-memory/bin`)
    } else {
      fs.appendFileSync(rc, `\n# episodic-memory unified CLI\n${exportLine}\n`, 'utf8')
      console.log(`${OK} Appended to ${rc} — restart your shell (or: source ${rc})`)
    }
  } else {
    console.log(`    You can add it later:  ${exportLine}`)
  }
}

// ---------------------------------------------------------------------------
// Semantic search setup: writes ~/.episodic-memory/embed-config.json so
// em-embed/em-semantic need no flags afterwards. EOF/enter → skip, so
// scripted installs are unaffected unless they opt in.
// ---------------------------------------------------------------------------
async function maybeConfigureSemantic(projectDir) {
  const configPath = path.join(GLOBAL_DIR, 'embed-config.json')
  if (fs.existsSync(configPath)) {
    console.log(`${OK} Semantic search already configured (${configPath})`)
    return
  }
  console.log('\nSemantic search (optional): rank recall by meaning, not just word overlap.')
  console.log('  1. built-in    offline token-overlap similarity, zero setup')
  console.log('  2. claude      built-in vectors + Claude re-ranking via your Claude Code login (claude CLI, no API key)')
  console.log('  3. ollama      local embedding model via Ollama (needs `ollama pull nomic-embed-text`)')
  console.log('  4. openai      OpenAI-compatible embeddings API (needs OPENAI_API_KEY)')
  console.log('  5. custom      your own {id,text}→{id,vector} JSONL command')
  console.log('  6. skip        set up later (em embed --help)')
  const choice = await ask('Choose', '6')

  let config = null
  if (choice === '1' || choice === 'built-in' || choice === 'hash') {
    config = { provider: 'hash' }
  } else if (choice === '2' || choice === 'claude') {
    config = {
      provider: 'hash',
      rerank_cmd: `sh ${path.join(REPO_DIR, 'examples', 'rerankers', 'claude-rerank.sh')}`,
    }
    console.log('    Vectors stay offline (built-in); the claude CLI re-orders top results per query.')
    console.log('    Requires `claude` on PATH and a logged-in Claude Code session.')
  } else if (choice === '3' || choice === 'ollama') {
    config = {
      provider: 'cmd',
      cmd: `sh ${path.join(REPO_DIR, 'examples', 'embedders', 'ollama-embed.sh')}`,
      model: await ask('Model label for the sidecar', 'ollama-nomic'),
    }
    console.log('    Uses $OLLAMA_URL / $OLLAMA_MODEL at run time (defaults: localhost:11434, nomic-embed-text).')
  } else if (choice === '4' || choice === 'openai') {
    config = {
      provider: 'cmd',
      cmd: `sh ${path.join(REPO_DIR, 'examples', 'embedders', 'openai-embed.sh')}`,
      model: await ask('Model label for the sidecar', 'openai-3-small'),
    }
    console.log('    Requires $OPENAI_API_KEY in your shell; $OPENAI_MODEL/$OPENAI_EMBED_URL override the defaults.')
  } else if (choice === '5' || choice === 'custom') {
    const cmd = await ask('Embedding command (reads {id,text} JSONL on stdin, writes {id,vector} JSONL)')
    if (!cmd) { console.log('    No command given — skipping semantic setup.'); return }
    config = { provider: 'cmd', cmd, model: await ask('Model label for the sidecar', 'custom') }
  } else {
    console.log('    Skipped. Configure later: em embed --help (or re-run the wizard).')
    return
  }

  fs.mkdirSync(GLOBAL_DIR, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  console.log(`${OK} Wrote ${configPath} — em embed / em semantic now use it automatically`)

  if (config.provider === 'hash') {
    // Offline provider: build the sidecar right now.
    const embed = path.join(GLOBAL_DIR, 'scripts', 'em-embed.mjs')
    const r = runJson([fs.existsSync(embed) ? embed : path.join(SCRIPT_DIR, 'em-embed.mjs'), '--scope', 'all'], { cwd: projectDir })
    if (r.json && r.json.status === 'ok') {
      console.log(`${OK} Built the embeddings sidecar: ${r.json.scopes.map(s => `${s.scope}=${s.total}`).join(', ')}`)
    } else {
      console.log(`${BAD} Initial embed failed (run manually: em embed --scope all)`)
    }
  } else {
    console.log('    Build the sidecar once your embedding service is reachable:  em embed --scope all')
  }
}

// ---------------------------------------------------------------------------
// Scheduled maintenance: sync routines.json to the platform scheduler
// (launchd / systemd user timers / cron) via the installed em-routines.mjs.
// EOF/enter → skip, so scripted installs are unaffected unless they opt in.
// ---------------------------------------------------------------------------
async function maybeConfigureRoutines() {
  console.log('\nScheduled maintenance (optional): daily doctor auto-repair, semantic sidecar refresh,')
  console.log('backup sync, and a weekly hygiene report — adapted to this machine (launchd/systemd/cron).')
  if (!(await askYesNo('Schedule the maintenance routines?', false))) {
    console.log('    Skipped. Later: em routines sync   (manage: em routines list|enable|disable|run)')
    return
  }
  const routinesScript = path.join(GLOBAL_DIR, 'scripts', 'em-routines.mjs')
  const r = runJson([fs.existsSync(routinesScript) ? routinesScript : path.join(SCRIPT_DIR, 'em-routines.mjs'), 'sync'], { cwd: HOME })
  if (r.json && r.json.status === 'ok') {
    console.log(`${OK} Scheduled via ${r.json.scheduler}: ${r.json.applied.map(a => a.routine).join(', ')}`)
    console.log(`    Logs: ${r.json.log_dir} — manage with: em routines list|enable|disable|run`)
  } else {
    console.log(`${BAD} Scheduling failed (${r.json ? r.json.message : `exit ${r.code}`}). Try later: em routines sync`)
  }
}

function verifyWithDoctor(projectDir) {
  console.log('\n[verify] Running em-doctor against the fresh install...')
  const doctor = path.join(GLOBAL_DIR, 'scripts', 'em-doctor.mjs')
  const r = runJson([fs.existsSync(doctor) ? doctor : path.join(SCRIPT_DIR, 'em-doctor.mjs'), '--scope', 'all'], { cwd: projectDir })
  if (r.json) {
    const { ok, warn, error } = r.json.summary
    console.log(`  doctor: ${r.json.status} (${ok} ok, ${warn} warn, ${error} error)`)
    for (const c of r.json.checks.filter(c => c.level !== 'ok')) {
      console.log(`  ${c.level.toUpperCase().padEnd(5)} [${c.id}] ${c.message}`)
    }
  }
  console.log('\nDone. Try it out:')
  console.log('  em recall            # what does memory know about this project?')
  console.log('  em store --help      # save your first episode')
  console.log('  em doctor            # re-check health any time')
  return r.code === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// Migrate flow — restore stores from an em-backup repository (new machine, or
// disaster recovery).
// ---------------------------------------------------------------------------
async function flowMigrate() {
  console.log('\nMigrate: restore episodic stores from an em-backup repository.')
  console.log('Note: backups are content-redacted at backup time; restore cannot undo redaction.')

  const source = await ask('Backup source — git URL (git@.../https://...) or existing local backup dir')
  if (!source) {
    console.log('A source is required — aborting.')
    return 1
  }

  let backupDir = expandHome(source)
  if (!fs.existsSync(backupDir)) {
    // Treat as a git URL and clone it.
    backupDir = expandHome(await ask('Clone backup into', '~/.local/share/episodic-memory-backup'))
    if (fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0) {
      console.log(`${BAD} ${backupDir} exists and is not empty — pass it directly as a local dir, or choose another location.`)
      return 1
    }
    const clone = runVisible('git', ['clone', source, backupDir])
    if (clone.status !== 0) {
      console.log(`${BAD} git clone failed — check the URL and your access, then re-run.`)
      return 1
    }
  }

  const target = expandHome(await ask('Restore the "global" store into', '~/.episodic-memory'))
  const restore = path.join(SCRIPT_DIR, 'em-restore.mjs')
  const baseArgs = [restore, '--from', backupDir, '--source-map', `global=${target}`]

  console.log('\n[preview] Dry run (no disk writes):')
  const dry = runVisible(process.execPath, [...baseArgs, '--dry-run'])
  if (dry.status !== 0) {
    console.log(`${BAD} dry-run failed — inspect the output above (is this a valid em-backup repo?).`)
    return 1
  }

  if (!(await askYesNo('Apply this restore?', false))) {
    console.log('Left everything untouched (dry-run only).')
    return 0
  }
  const apply = runVisible(process.execPath, [...baseArgs, '--apply', '--rebuild-index'])
  if (apply.status !== 0) {
    console.log(`${BAD} restore failed — the output above has the reason.`)
    return 1
  }
  return verifyWithDoctor(process.cwd())
}

// ---------------------------------------------------------------------------
// Doctor flow
// ---------------------------------------------------------------------------
async function flowDoctor() {
  const doctorInstalled = path.join(GLOBAL_DIR, 'scripts', 'em-doctor.mjs')
  const doctor = fs.existsSync(doctorInstalled) ? doctorInstalled : path.join(SCRIPT_DIR, 'em-doctor.mjs')
  const r = runJson([doctor, '--scope', 'all'], { cwd: process.cwd() })
  if (!r.json) {
    console.log(`${BAD} doctor did not produce a report (exit ${r.code})`)
    return 1
  }
  const { ok, warn, error } = r.json.summary
  console.log(`\ndoctor: ${r.json.status} (${ok} ok, ${warn} warn, ${error} error)`)
  for (const c of r.json.checks) {
    console.log(`  ${c.level === 'ok' ? OK.trim() : c.level.toUpperCase().padEnd(5)} [${c.id}${c.scope !== '-' ? `:${c.scope}` : ''}] ${c.message}`)
  }
  if (r.json.status !== 'ok' && (await askYesNo('Attempt automatic repair (em-doctor --fix)?', true))) {
    const f = runJson([doctor, '--scope', 'all', '--fix'], { cwd: process.cwd() })
    if (f.json) {
      console.log(`after --fix: ${f.json.status} (${f.json.summary.ok} ok, ${f.json.summary.warn} warn, ${f.json.summary.error} error)`)
      return f.code === 0 ? 0 : 1
    }
    return 1
  }
  return r.json.status === 'ok' ? 0 : 1
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('episodic-memory setup wizard')
console.log('════════════════════════════')

if (!checkPrerequisites()) {
  rl.close()
  process.exit(1)
}

console.log('\n[2/2] What would you like to do?')
console.log('  1. install   Set up episodic memory for your AI coding tools')
console.log('  2. migrate   Restore memory stores from an em-backup repository')
console.log('  3. doctor    Health-check an existing installation')
const action = await ask('Choose', '1')

let exit = 1
try {
  if (action === '1' || action === 'install') exit = await flowInstall()
  else if (action === '2' || action === 'migrate') exit = await flowMigrate()
  else if (action === '3' || action === 'doctor') exit = await flowDoctor()
  else console.log(`Unknown choice "${action}" — expected 1, 2, or 3.`)
} finally {
  rl.close()
}
process.exit(exit)
