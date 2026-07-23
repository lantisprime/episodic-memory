#!/usr/bin/env node
/**
 * test-install-topic-tracks.mjs — NAPMEM-C §A.7 S2 row 2.5 real isolated-HOME
 * install gauntlet for the scripts/em-topic-tracks.mjs entry, the
 * scripts/topic-tracks/ subtree (engine + config), and the deployed CLI.
 *
 *   1. One real isolated-HOME runInstall with tool codex/default flags exits 0.
 *   2. Repo scripts/em-topic-tracks.mjs is byte-identical to
 *      HOME/.episodic-memory/scripts/em-topic-tracks.mjs.
 *   3. Repo scripts/topic-tracks/engine.mjs and config.json are byte-identical
 *      to the matching deployed subtree under HOME/.episodic-memory/.
 *   4. Deployed --help exits 0 with a structured JSON object whose script
 *      field is "em-topic-tracks.mjs".
 *   5. Deployed empty dry-run exits 0 with status:"ok", dry_run:true,
 *      candidates:[] and creates no new episode file anywhere in the
 *      isolated mock (global or project).
 *   6. Recursively walks isolated enforcement/config roots under the mock
 *      home and the mock project (.claude, .codex, .cursor, .windsurf,
 *      .agents, .opencode — each only where present) and asserts no
 *      deployed PATHNAME contains "topic-track" or "topic_tracks";
 *      ordinary instruction CONTENT mentioning the command is allowed.
 *
 * Zero deps. Node stdlib + tests/lib/activation-scoping-harness.mjs only.
 */

import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkMock, runInstall, REPO_ROOT } from './lib/activation-scoping-harness.mjs'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  ✓ ' + name)
  } catch (e) {
    failed++
    failures.push({ name, error: e.stack || e.message })
    console.log('  ✗ ' + name + ': ' + e.message)
  }
}

// Per-tool enforcement/config roots that §A.7 row 2.5 must scan for stray
// topic-track pathnames; "where present" means absent roots are skipped.
const ENFORCEMENT_ROOTS = ['.claude', '.codex', '.cursor', '.windsurf', '.agents', '.opencode']

// Walk every regular file under `root`. Returns sorted absolute paths.
function walkFiles(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

// Build a flat list of every regular file under the mock home and project
// for the named enforcement/config roots, but only when the root exists
// ("where present"). Returns [{ root, abs, rel }] sorted by abs.
function deployedFilesUnder(home, project) {
  const out = []
  for (const base of [{ label: 'home', dir: home }, { label: 'project', dir: project }]) {
    for (const root of ENFORCEMENT_ROOTS) {
      const abs = path.join(base.dir, root)
      if (!fs.existsSync(abs)) continue
      for (const f of walkFiles(abs)) {
        out.push({
          root: root, base: base.label, abs: f,
          rel: path.relative(base.dir, f),
        })
      }
    }
  }
  return out.sort((a, b) => a.abs.localeCompare(b.abs))
}

// Group 1 — single isolated-HOME install with --tool codex, default flags.
// All assertions share one install so the byte-equality, help, dry-run, and
// enforcement-root scans are made against one consistent deployed tree.

let installResult = null
let mock = null

test('installExitsZero: real isolated-HOME --tool codex default install exits 0', () => {
  mock = mkMock('topic tracks install')
  installResult = runInstall({ home: mock.home, project: mock.project, callerCwd: mock.callerCwd, tool: 'codex' })
  assert.strictEqual(installResult.status, 0,
    'expected install exit 0, got ' + installResult.status + '\n' +
    'stdout=' + installResult.stdout + '\nstderr=' + installResult.stderr)
})

test('emTopicTracksDeployedByteIdentical: repo vs HOME/.episodic-memory/scripts/em-topic-tracks.mjs', () => {
  const deployed = path.join(mock.home, '.episodic-memory', 'scripts', 'em-topic-tracks.mjs')
  const repo = path.join(REPO_ROOT, 'scripts', 'em-topic-tracks.mjs')
  assert.ok(fs.existsSync(deployed), 'deployed entry must exist at ' + deployed)
  assert.ok(fs.readFileSync(deployed).equals(fs.readFileSync(repo)),
    'deployed em-topic-tracks.mjs must be byte-identical to repo (' + repo + ')')
})

test('engineDeployedByteIdentical: repo vs HOME/.episodic-memory/scripts/topic-tracks/engine.mjs', () => {
  const deployed = path.join(mock.home, '.episodic-memory', 'scripts', 'topic-tracks', 'engine.mjs')
  const repo = path.join(REPO_ROOT, 'scripts', 'topic-tracks', 'engine.mjs')
  assert.ok(fs.existsSync(deployed), 'deployed engine must exist at ' + deployed)
  assert.ok(fs.readFileSync(deployed).equals(fs.readFileSync(repo)),
    'deployed topic-tracks/engine.mjs must be byte-identical to repo (' + repo + ')')
})

test('configDeployedByteIdentical: repo vs HOME/.episodic-memory/scripts/topic-tracks/config.json', () => {
  const deployed = path.join(mock.home, '.episodic-memory', 'scripts', 'topic-tracks', 'config.json')
  const repo = path.join(REPO_ROOT, 'scripts', 'topic-tracks', 'config.json')
  assert.ok(fs.existsSync(deployed), 'deployed config must exist at ' + deployed)
  assert.ok(fs.readFileSync(deployed).equals(fs.readFileSync(repo)),
    'deployed topic-tracks/config.json must be byte-identical to repo (' + repo + ')')
})

// Group 2 — spawn the DEPLOYED CLI under isolated HOME.

test('deployedHelpExits0: em-topic-tracks.mjs --help is structured + script:"em-topic-tracks.mjs"', () => {
  const cli = path.join(mock.home, '.episodic-memory', 'scripts', 'em-topic-tracks.mjs')
  const r = spawnSync('node', [cli, '--help'], {
    cwd: mock.home,
    env: { ...process.env, HOME: mock.home },
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.strictEqual(r.status, 0, 'deployed --help must exit 0, got ' + r.status + '; stderr=' + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.strictEqual(out.script, 'em-topic-tracks.mjs',
    'deployed --help must carry script:"em-topic-tracks.mjs"; got ' + JSON.stringify(out))
})

test('deployedDryRunExits0AndCreatesNoEpisode: empty world, status:ok, dry_run:true, candidates:[]', () => {
  const cli = path.join(mock.home, '.episodic-memory', 'scripts', 'em-topic-tracks.mjs')
  // Run dry-run under a fresh, empty runtime HOME so the deployed
  // CLI sees a world with no .episodic-memory directory and thus
  // cannot seed or touch any episode. The real install has already
  // populated mock.home with behavioral-pattern episodes, so we
  // point HOME at an isolated runtime dir created just for this
  // dry-run. The postcondition is stronger than episode counts:
  // the runtime HOME must remain free of any .episodic-memory
  // directory (not merely unchanged episode counts).
  const runtimeHome = path.join(mock.base, 'empty-runtime-home')
  fs.mkdirSync(runtimeHome, { recursive: true })
  const runtimeStore = path.join(runtimeHome, '.episodic-memory')
  assert.ok(!fs.existsSync(runtimeStore),
    'runtime HOME must start free of .episodic-memory; found ' + runtimeStore)

  const r = spawnSync('node', [cli], {
    cwd: mock.home,
    env: { ...process.env, HOME: runtimeHome },
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.strictEqual(r.status, 0,
    'empty dry-run must exit 0, got ' + r.status + '; stdout=' + r.stdout + '; stderr=' + r.stderr)

  const out = JSON.parse(r.stdout)
  assert.strictEqual(out.status, 'ok',
    'dry-run status must be "ok"; got ' + JSON.stringify(out).slice(0, 200))
  assert.strictEqual(out.dry_run, true,
    'dry-run must report dry_run:true; got ' + out.dry_run)
  assert.ok(Array.isArray(out.candidates),
    'dry-run must expose a candidates array; got ' + typeof out.candidates)
  assert.strictEqual(out.candidates.length, 0,
    'empty-world dry-run must report zero candidates; got ' + out.candidates.length)

  // Stronger postcondition: the runtime HOME must still have no
  // .episodic-memory directory after the dry-run — not just an
  // unchanged episode count, but the whole store untouched.
  assert.ok(!fs.existsSync(runtimeStore),
    'dry-run must not create .episodic-memory under runtime HOME; ' +
    'found ' + runtimeStore)
})

// Group 3 — no topic-track artifacts under any tool-specific enforcement/
// config root ("where present"). Plain instruction CONTENT that mentions the
// command (e.g. SKILL.md prose) is allowed; only PATHNAMES are scanned.

test('noEnforcementPathnameLeaksTopicTrack: every per-tool root has zero matching paths', () => {
  const found = deployedFilesUnder(mock.home, mock.project)
  const banned = []
  for (const f of found) {
    if (/topic[-_]track/i.test(f.rel)) banned.push(f)
  }
  assert.deepStrictEqual(banned, [],
    'no deployed pathname may contain topic-track or topic_tracks; got: ' +
    banned.map((b) => b.base + '/' + b.root + '/' + b.rel).join('\n'))
  // Sanity: at least one root must have been present so the test is not a
  // vacuous pass. --tool codex (default flags) installs a Codex skill under
  // <project>/.agents/skills/episodic-memory/SKILL.md so .agents must exist.
  const presentRoots = new Set(found.map((f) => f.base + '/' + f.root))
  assert.ok(presentRoots.size > 0,
    'expected at least one per-tool enforcement/config root under the mock ' +
    'home or project; found none — install did not seed any tool layout')
})

// Summary
console.log('\n' + passed + '/' + (passed + failed) + ' pass')
if (failed > 0) {
  for (const f of failures) console.error('\n' + f.name + '\n' + f.error)
  process.exit(1)
}
