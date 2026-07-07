/**
 * test-em-routines.mjs — the scheduled-tasks manager (em-routines.mjs).
 *
 * All platform binaries are shimmed via the EM_ROUTINES_* env overrides, so
 * the REAL script runs its REAL backends against capturable fakes:
 *   crontab  → file-backed store (reads/writes verified byte-level; foreign
 *              entries must survive every sync/uninstall)
 *   launchctl/plutil/systemctl → exit-0 recorders
 *
 * Covers: sync seeds routines.json + writes the managed block; list state +
 * STALE detection (exit 1); run records state incl. skip guards; custom
 * add/remove with cron validation; enable/disable re-sync; launchd plist +
 * systemd timer generation (namespace, weekly schedule); uninstall preserves
 * foreign cron entries and config; --dry-run writes nothing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emroutines-home-')));
const binDir = path.join(home, 'shim-bin');
fs.mkdirSync(binDir, { recursive: true });

// crontab shim: file-backed
const crontabShim = path.join(binDir, 'crontab');
fs.writeFileSync(crontabShim, `#!/bin/sh
STORE="${home}/.fake-crontab"
if [ "$1" = "-l" ]; then [ -f "$STORE" ] && cat "$STORE" || exit 1
elif [ "$1" = "-" ]; then cat > "$STORE"
else exit 2; fi
`);
for (const b of ['launchctl', 'plutil', 'systemctl']) {
  fs.writeFileSync(path.join(binDir, b), '#!/bin/sh\nexit 0\n');
}
for (const b of ['crontab', 'launchctl', 'plutil', 'systemctl']) fs.chmodSync(path.join(binDir, b), 0o755);

const env = {
  HOME: home,
  EM_ROUTINES_CRONTAB: crontabShim,
  EM_ROUTINES_LAUNCHCTL: path.join(binDir, 'launchctl'),
  EM_ROUTINES_PLUTIL: path.join(binDir, 'plutil'),
  EM_ROUTINES_SYSTEMCTL: path.join(binDir, 'systemctl'),
};

// The manager runs from the INSTALLED location so scheduler payloads point at
// the deployed substrate — mirror that: copy scripts into the fake global dir.
const globalScripts = path.join(home, '.episodic-memory', 'scripts');
fs.mkdirSync(globalScripts, { recursive: true });
fs.cpSync(SCRIPTS, globalScripts, { recursive: true });
const EM = path.join(globalScripts, 'em-routines.mjs');

function run(args) {
  const r = spawnSync('node', [EM, ...args], { encoding: 'utf8', cwd: home, env: { ...process.env, ...env } });
  let json = null; try { json = JSON.parse(r.stdout.trim()); } catch {}
  return { code: r.status, json, stdout: r.stdout };
}
const crontabContent = () => { try { return fs.readFileSync(path.join(home, '.fake-crontab'), 'utf8'); } catch { return ''; } };
const configPath = path.join(home, '.episodic-memory', 'routines.json');
const statePath = path.join(home, '.episodic-memory', 'logs', 'routines', 'state.json');

// seed one episode so the doctor routine has a store
spawnSync('node', [path.join(globalScripts, 'em-store.mjs'), '--project', 'fx', '--category', 'decision',
  '--summary', 'routines fixture', '--body', 'b', '--tags', 'r', '--scope', 'global'],
  { encoding: 'utf8', cwd: home, env: { ...process.env, ...env } });
// pre-existing foreign cron entry that must never be touched
fs.writeFileSync(path.join(home, '.fake-crontab'), '0 5 * * * /usr/bin/foreign-job\n');

// ---------------------------------------------------------------------------
t('sync seeds routines.json, writes managed cron block, preserves foreign entries', () => {
  const dry = run(['sync', '--scheduler', 'cron', '--dry-run']);
  assert.equal(dry.code, 0, dry.stdout);
  assert.ok(!fs.existsSync(configPath), '--dry-run must not write routines.json');
  assert.ok(!crontabContent().includes('em-routines'), '--dry-run must not touch the crontab');

  const r = run(['sync', '--scheduler', 'cron']);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.json.applied.map(a => a.routine), ['doctor', 'embed', 'backup-sync', 'hygiene-report']);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(cfg.routines.length, 4);
  assert.equal(cfg.scheduler, 'cron');
  const ct = crontabContent();
  assert.ok(ct.startsWith('0 5 * * * /usr/bin/foreign-job'), 'foreign entry must survive');
  assert.ok(ct.includes(`${EM} run doctor`), 'payload must target the INSTALLED manager');
  assert.ok(ct.includes('0 9 * * 0'), 'weekly hygiene schedule');
});

t('run records state; skip guards record "skipped"; list surfaces both', () => {
  const doc = run(['run', 'doctor']);
  assert.equal(doc.code, 0, doc.stdout);
  assert.equal(doc.json.status, 'ok');
  assert.ok(doc.json.detail.summary, 'doctor detail must carry the summary');
  const emb = run(['run', 'embed']);
  assert.equal(emb.code, 0);
  assert.equal(emb.json.status, 'skipped');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.doctor.status, 'ok');
  assert.equal(state.embed.status, 'skipped');
  const list = run(['list']);
  const byName = Object.fromEntries(list.json.routines.map(r => [r.name, r]));
  assert.equal(byName.doctor.last_run.status, 'ok');
  assert.equal(byName.embed.last_run.status, 'skipped');
  assert.ok(byName.doctor.scheduled && byName.doctor.enabled);
});

t('stale detection: enabled+scheduled routine with old last-run flags stale, exit 1', () => {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.doctor.ts = new Date(Date.now() - 3 * 24 * 3600e3).toISOString(); // 3d > 2x daily
  fs.writeFileSync(statePath, JSON.stringify(state));
  const list = run(['list']);
  assert.equal(list.code, 1, 'stale routines must fail the list exit code (cron-able health check)');
  const doctorRow = list.json.routines.find(r => r.name === 'doctor');
  assert.equal(doctorRow.stale, true);
  assert.ok(!list.json.routines.find(r => r.name === 'hygiene-report').stale, 'weekly routine within 2x interval is not stale');
  state.doctor.ts = new Date().toISOString();
  fs.writeFileSync(statePath, JSON.stringify(state));
});

t('disable removes the entry and re-syncs; enable restores it', () => {
  run(['disable', 'backup-sync']);
  assert.ok(!crontabContent().includes('run backup-sync'), 'disabled routine must leave the managed block');
  assert.ok(crontabContent().includes('run doctor'), 'others must remain');
  run(['enable', 'backup-sync']);
  assert.ok(crontabContent().includes('run backup-sync'));
});

t('custom routines: add validates cron, runs via shell, records state; remove de-schedules', () => {
  const bad = run(['add', '--name', 'bad', '--cron', '*/5 * * * *', '--cmd', 'x']);
  assert.equal(bad.code, 2, 'range/step cron must be rejected, not mistranslated');
  const dup = run(['add', '--name', 'doctor', '--cron', '0 1 * * *', '--cmd', 'x']);
  assert.equal(dup.code, 2, 'duplicate names rejected');
  const add = run(['add', '--name', 'custom-echo', '--cron', '0 4 * * *', '--cmd', 'echo custom-ran']);
  assert.equal(add.code, 0, add.stdout);
  assert.ok(crontabContent().includes('run custom-echo'));
  const r = run(['run', 'custom-echo']);
  assert.equal(r.json.status, 'ok');
  assert.ok(r.json.detail.output.includes('custom-ran'));
  run(['remove', 'custom-echo']);
  assert.ok(!crontabContent().includes('custom-echo'));
  assert.ok(!JSON.parse(fs.readFileSync(configPath, 'utf8')).routines.some(x => x.name === 'custom-echo'));
});

t('launchd backend: namespaced plists with correct weekly schedule; uninstall removes them', () => {
  const r = run(['sync', '--scheduler', 'launchd']);
  assert.equal(r.code, 0, r.stdout);
  const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.episodic-memory.hygiene-report.plist'), 'utf8');
  assert.ok(plist.includes('<key>Weekday</key>') && plist.includes('<integer>0</integer>'));
  assert.ok(plist.includes(`<string>${EM}</string>`), 'plist must invoke the installed manager');
  assert.ok(!plist.includes('charltonho'), 'no personal namespace');
  const un = run(['uninstall', '--scheduler', 'launchd']);
  assert.equal(un.code, 0);
  assert.ok(!fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.episodic-memory.doctor.plist')));
});

t('systemd backend: user timer units with OnCalendar; uninstall removes them', () => {
  const r = run(['sync', '--scheduler', 'systemd']);
  assert.equal(r.code, 0, r.stdout);
  const timer = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'episodic-memory-hygiene-report.timer'), 'utf8');
  assert.ok(timer.includes('OnCalendar=Sun *-*-* 09:00:00'));
  assert.ok(timer.includes('Persistent=true'));
  run(['uninstall', '--scheduler', 'systemd']);
  assert.equal(fs.readdirSync(path.join(home, '.config', 'systemd', 'user')).length, 0);
});

t('cron uninstall removes ONLY the managed block; config + foreign entries survive', () => {
  run(['sync', '--scheduler', 'cron']);
  assert.ok(crontabContent().includes('BEGIN episodic-memory'));
  const un = run(['uninstall', '--scheduler', 'cron']);
  assert.equal(un.code, 0);
  const ct = crontabContent();
  assert.ok(ct.includes('/usr/bin/foreign-job'), 'foreign entry must survive uninstall');
  assert.ok(!ct.includes('episodic-memory'), 'managed block fully removed');
  assert.ok(fs.existsSync(configPath), 'routines.json preserved');
});

t('usage errors exit 2; list before any sync reports unconfigured', () => {
  assert.equal(run(['frobnicate']).code, 2);
  assert.equal(run(['run']).code, 2);
  assert.equal(run(['sync', '--scheduler', 'atd']).code, 2);
  const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emroutines-fresh-')));
  const r = spawnSync('node', [EM, 'list'], { encoding: 'utf8', env: { ...process.env, ...env, HOME: fresh } });
  assert.equal(JSON.parse(r.stdout).configured, false);
  fs.rmSync(fresh, { recursive: true, force: true });
});

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
