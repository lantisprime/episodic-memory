#!/usr/bin/env node
/**
 * test-so-timeout.mjs - RFC-009 P3-S2 (REQ-9 / #512): --timeout plumb through
 * provider dispatch, E2E against the REAL harness + stub provider.
 *
 * Negative control (step 2.11b / A.9): BREAK_SO_TIMEOUT=1 suppresses the stub
 * sleep in the expiry fixture while the assertions still expect the
 * provider-timeout envelope, so a suite that cannot fail is itself a failure.
 * Every assertion operates on captured runtime output (stdout JSON envelopes,
 * persisted .review-store artifacts, live-pid probes) - never constants.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const SO = path.join(REPO_ROOT, 'scripts/second-opinion.mjs')
const BREAK = process.env.BREAK_SO_TIMEOUT === '1'

let pass = 0, fail = 0
const failures = []
const assert = (c, n, d) => { if (c) pass++; else { fail++; failures.push(`${n}${d ? ' - ' + d : ''}`) } }

const _tmpDirs = []
process.on('exit', () => { for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })

function scrubEnv(env) {
  delete env.CLAUDE_CONFIG_DIR; delete env.SO_INSTALL_SNAPSHOT_PATH
  delete env.SO_RUNBOOK_PATH; delete env.SO_QUICKREF_PATH
  delete env.ANTHROPIC_API_KEY; delete env.BREAK_SO_TIMEOUT
  delete env.SO_STUB_SLEEP_MS; delete env.SO_STUB_SLEEP_ON_CALL
  delete env.SO_STUB_PID_FILE; delete env.SO_STUB_VERDICT; delete env.SO_STUB_DEFER_COUNT
  return env
}
function mkFixture(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `so-to-${label}-`)))
  _tmpDirs.push(base)
  const home = path.join(base, 'home')
  const proj = path.join(base, 'proj')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true })
  return { base, home, proj }
}
function runRequest({ home, proj, extraArgs = [], extraEnv = {} }) {
  const r = spawnSync('node', [SO, 'request', '--provider', 'stub', '--project', proj,
    '--storage', 'files', '--body', 'timeout probe body', '--summary', 'timeout probe',
    '--dispatch', ...extraArgs],
    { cwd: proj, env: { ...scrubEnv({ ...process.env, HOME: home, USERPROFILE: home }), ...extraEnv },
      encoding: 'utf8', timeout: 60000 })
  let envelope = null
  try { envelope = JSON.parse(r.stdout.trim().split('\n').pop()) } catch {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope }
}
function listDir(p) {
  try { return fs.readdirSync(p) } catch { return [] }
}

// 1. validate: bad values rejected exit 1 naming the shape; NOTHING dispatched or written
{
  for (const raw of ['0', '-1', 'abc', '500']) {
    const { home, proj } = mkFixture(`val${raw.replace('-', 'n')}`)
    const r = runRequest({ home, proj, extraArgs: ['--timeout', raw] })
    assert(r.status === 1, `validate(${raw}): exit 1`, `status=${r.status}`)
    assert(r.envelope && r.envelope.code === 'invalid-timeout', `validate(${raw}): code invalid-timeout`, JSON.stringify(r.envelope))
    assert(r.envelope && r.envelope.message.includes('>= 1000') && r.envelope.message.includes(`"${raw}"`),
      `validate(${raw}): message names the accepted shape and the raw value`, r.envelope && r.envelope.message)
    assert(listDir(path.join(proj, '.review-store', 'requests')).length === 0,
      `validate(${raw}): nothing written (EC6 validate-then-write)`)
  }
}
// 2. passthrough: fast stub unaffected by --timeout
{
  const { home, proj } = mkFixture('pass')
  const r = runRequest({ home, proj, extraArgs: ['--timeout', '5000'] })
  assert(r.status === 0, 'passthrough: exit 0', `status=${r.status} stderr=${r.stderr}`)
  assert(r.envelope && r.envelope.status === 'ok', 'passthrough: ok envelope', JSON.stringify(r.envelope))
  assert(listDir(path.join(proj, '.review-store', 'replies')).some(f => f.endsWith('.body.md')),
    'passthrough: reply file written')
}
// 3. expiry + forensics + kill (carries the BREAK negative-control inversion)
{
  const { base, home, proj } = mkFixture('expiry')
  const pidFile = path.join(base, 'sleeper.pid')
  const sleepEnv = BREAK ? {} : { SO_STUB_SLEEP_MS: '3000' }
  const r = runRequest({ home, proj, extraArgs: ['--timeout', '1500'],
    extraEnv: { ...sleepEnv, SO_STUB_PID_FILE: pidFile } })
  assert(r.status === 1, 'expiry: exit 1', `status=${r.status}`)
  assert(r.envelope && r.envelope.code === 'provider-timeout', 'expiry: code provider-timeout', JSON.stringify(r.envelope))
  assert(r.envelope && r.envelope.message.includes('timed out after 1500ms (round 1)'),
    'expiry: message names timeout and round', r.envelope && r.envelope.message)
  assert(r.envelope && r.envelope.round === 1 && r.envelope.timeoutMs === 1500,
    'expiry: envelope carries {round, timeoutMs}', JSON.stringify(r.envelope))
  assert(listDir(path.join(proj, '.review-store', 'replies')).length === 0,
    'expiry: no reply file (partial stdout never parsed as a verdict)')
  const fPath = r.envelope && r.envelope.forensics
  assert(typeof fPath === 'string' && fs.existsSync(fPath), 'forensics: file persisted', String(fPath))
  assert(fPath && fs.readFileSync(fPath, 'utf8').includes('stub-sleeper-partial'),
    'forensics: partial stdout captured')
  // F6: forensics evidence binds to the TARGET store LOCATION on disk - the envelope-named
  // path resolves UNDER <proj>/.review-store/forensics/ and never escapes the project root
  // (§12 forensics contract; axes: forensics-wrong-store, JSON-names-target-artifact-elsewhere).
  const forensicsRoot = path.resolve(path.join(proj, '.review-store', 'forensics'))
  assert(fPath && path.resolve(fPath).startsWith(forensicsRoot + path.sep),
    'forensics: envelope-named path lands under the target project forensics store', `fPath=${fPath} root=${forensicsRoot}`)
  const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10)
  let alive = true
  try { process.kill(pid, 0) } catch (e) { alive = e.code !== 'ESRCH' }
  assert(Number.isInteger(pid) && !alive, 'kill: expired child no longer alive (pid probe)', `pid=${pid} alive=${alive}`)
}
// 4. consensus: round 2 times out independently with its own full budget
{
  const { base, home, proj } = mkFixture('consensus')
  const cb = path.join(base, 'cb.mjs')
  fs.writeFileSync(cb, "#!/usr/bin/env node\nprocess.stdout.write('rebuttal probe body for the next round')\n")
  const r = runRequest({ home, proj,
    extraArgs: ['--consensus', '--max-rounds', '3', '--rebuttal-cb', cb, '--timeout', '1500'],
    extraEnv: { SO_STUB_VERDICT: 'HOLD', SO_STUB_SLEEP_MS: '3000', SO_STUB_SLEEP_ON_CALL: '2' } })
  assert(r.status === 1, 'consensus: exit 1', `status=${r.status}`)
  assert(r.envelope && r.envelope.code === 'provider-timeout', 'consensus: code provider-timeout', JSON.stringify(r.envelope))
  assert(r.envelope && r.envelope.round === 2 && r.envelope.message.includes('(round 2)'),
    'consensus: round 2 timed out independently (round 1 dispatched fine)', JSON.stringify(r.envelope))
}

console.log(`test-so-timeout: ${pass}/${pass + fail} pass`)
if (fail > 0) { console.error(failures.map(f => `FAIL ${f}`).join('\n')); process.exit(1) }
