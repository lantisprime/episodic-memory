#!/usr/bin/env node
/**
 * test-bp1-approval-check-hook.mjs — Slice 2d-R E2E tests for the H1
 * SessionStart hook (`.claude/hooks/bp1-approval-check.sh`).
 *
 * The hook is invoked by Claude Code's SessionStart hook system. Its stdin is
 * JSON with at least `.cwd`. Its responsibilities (per §178 + §540 row 6):
 *   - Resolve canonical project root via `git rev-parse --show-toplevel`.
 *   - Scan `<canonical_root>/.checkpoints/bp1-approval-*.json` markers.
 *   - For each: derive run_id, call validator, branch on status:
 *       missing  → no-op
 *       ok+expired   → orchestrator confirm-approval --outcome auto_approved
 *       ok+!expired  → no-op
 *       invalid  → emit-marker-invalid-evidence (Case A signed | Case B stderr)
 *       (unparseable filename — Case C — hook stderr-logs directly)
 *   - ALWAYS exit 0 (§178 four-mode silent-exit contract).
 *
 * Coverage (12 cases):
 *   AC-1  bp1 inert (no config) → silent exit 0
 *   AC-2  not in git repo → silent exit 0
 *   AC-3  no markers present → silent exit 0
 *   AC-4  marker valid + expired → confirm-approval invoked → state=auto_approved + marker removed
 *   AC-5  marker valid + not expired → no-op; marker stays; state stays awaiting_approval
 *   AC-6  marker missing (validator returns status=missing — race) → no-op
 *   AC-7  marker invalid (corrupt JSON) + key present → Case A signed episode written
 *   AC-8  marker invalid + key missing → Case B stderr structured JSON
 *   AC-9  unparseable filename (Case C) → hook stderr-logs without invoking helpers
 *   AC-10 multiple markers in one session → each processed independently
 *   AC-11 hook exits 0 even when underlying tools fail (orchestrator transient error)
 *   AC-12 linked-worktree handling: marker under main checkout is found via git toplevel
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const HOOK = path.join(REPO, '.claude', 'hooks', 'bp1-approval-check.sh')
const INSTALL = path.join(REPO, 'install.mjs')
const ORCHESTRATOR = path.join(REPO, 'scripts', 'bp1-orchestrator.mjs')
const ARTIFACT_BUILDER = path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs')

const hmacMod = await import(new URL('../scripts/lib/bp1-hmac.mjs', import.meta.url).href)
const { verifyKeyFingerprint } = hmacMod
const rsmod = await import(new URL('../scripts/lib/bp1-run-state.mjs', import.meta.url).href)
const { loadIndex, updateRunState } = rsmod
const markerMod = await import(new URL('../scripts/lib/bp1-marker.mjs', import.meta.url).href)
const { markerPath, writeMarker } = markerMod
const keysMod = await import(new URL('../scripts/lib/bp1-keys.mjs', import.meta.url).href)
const { loadRunKey } = keysMod

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) {
    fail++
    console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`)
  }
}

// ---------------------------------------------------------------------------
// Sandbox setup — also install scripts globally under $HOME/.episodic-memory
// since the hook resolves scripts via $HOME (not relative paths).
// ---------------------------------------------------------------------------

function makeProj() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ac-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'docs', 'rfcs'), { recursive: true })
  return fs.realpathSync(dir)
}
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ac-home-'))
  fs.mkdirSync(path.join(dir, '.episodic-memory'), { recursive: true })
  return fs.realpathSync(dir)
}

/** Mirror install.mjs's section 1 (script copy) into a sandboxed HOME. */
function installGlobalScripts(homeDir) {
  const dst = path.join(homeDir, '.episodic-memory', 'scripts')
  fs.mkdirSync(dst, { recursive: true })
  // The hook reads from $HOME/.episodic-memory/scripts/; copy the whole tree.
  const src = path.join(REPO, 'scripts')
  function copyRec(s, d) {
    const stat = fs.statSync(s)
    if (stat.isDirectory()) {
      fs.mkdirSync(d, { recursive: true })
      for (const f of fs.readdirSync(s)) copyRec(path.join(s, f), path.join(d, f))
    } else {
      fs.copyFileSync(s, d)
    }
  }
  copyRec(src, dst)
}

function writeKey(homeDir) {
  const key = crypto.randomBytes(32)
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/.verify-key'), key, { mode: 0o600 })
  return verifyKeyFingerprint(key)
}
function buildHash(projectRoot, homeDir) {
  return JSON.parse(execFileSync('node', [ARTIFACT_BUILDER, '--project', projectRoot, '--json'],
    { encoding: 'utf8', env: { ...process.env, HOME: homeDir } })).sha256
}
function writeConfig(homeDir, projectRoot, fingerprint) {
  fs.writeFileSync(path.join(homeDir, '.episodic-memory/config.json'),
    JSON.stringify({
      bp1: {
        schema_version: 1,
        activations: {
          [projectRoot]: {
            enabled: true,
            artifact_version_hash: 'sha256:' + buildHash(projectRoot, homeDir),
            enabled_at: new Date().toISOString(),
            enabled_via: 'test-fixture',
            verify_key_id: fingerprint,
          },
        },
      },
    }, null, 2))
}
function writeRfc(projectRoot, name) {
  fs.writeFileSync(path.join(projectRoot, 'docs', 'rfcs', `${name}.md`),
    `---\nrfc_id: ${name}\nstatus: ${JSON.stringify('accepted')}\ntitle: ${JSON.stringify('T')}\n---\n\nbody.\n`)
}
function runOrch(args, { project, homeDir }) {
  return spawnSync('node', [ORCHESTRATOR, ...args], {
    cwd: project, encoding: 'utf8',
    env: { ...process.env, HOME: homeDir },
  })
}

/** Drive a project to state=awaiting_approval with marker on disk. */
function setupAwaitingApproval() {
  const project = makeProj()
  const home = makeHome()
  installGlobalScripts(home)
  const fp = writeKey(home)
  writeRfc(project, 'RFC-AC')
  writeConfig(home, project, fp)
  const detR = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  if (detR.status !== 0) throw new Error(`detect-rfcs: ${detR.stderr}`)
  const runId = JSON.parse(detR.stdout).detected[0].run_id
  const sha = crypto.randomBytes(32).toString('hex')
  const preR = runOrch([
    'record-classifier-dispatch-pre', '--project', project, '--run-id', runId,
    '--input-sha256', sha,
  ], { project, homeDir: home })
  if (preR.status !== 0) throw new Error(`pre: ${preR.stderr}`)
  const preEpisodeId = JSON.parse(preR.stdout).pre_episode_id
  const resultFile = path.join(project, 'classifier-result.json')
  fs.writeFileSync(resultFile, JSON.stringify({
    class: 'trivial', confidence: 0.9, rationale: 'r', classified_fields: ['x'],
  }))
  const clsR = runOrch([
    'record-classification', '--project', project, '--run-id', runId,
    '--pre-episode-id', preEpisodeId, '--result-file', resultFile,
  ], { project, homeDir: home })
  if (clsR.status !== 0) throw new Error(`cls: ${clsR.stderr}`)
  const classifiedEpisodeId = JSON.parse(clsR.stdout).classified_episode_id
  const raaR = runOrch([
    'record-awaiting-approval', '--project', project, '--run-id', runId,
    '--classified-episode-id', classifiedEpisodeId,
  ], { project, homeDir: home })
  if (raaR.status !== 0) throw new Error(`raa: ${raaR.stderr}`)
  return { project, home, runId }
}

/** Invoke the H1 hook with SessionStart-shape stdin. */
function runHook({ cwd, home }) {
  const input = JSON.stringify({ cwd })
  return spawnSync('bash', [HOOK], {
    input, cwd, encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
}

function expireDeadline(project, runId, msAgo = 1) {
  const expired = new Date(Date.now() - msAgo).toISOString()
  // Update run-state's deadline_at so the orchestrator's defense-in-depth
  // deadline check passes.
  const r = updateRunState(project, runId, { deadline_at: expired })
  if (r.error) throw new Error(`updateRunState: ${r.error}`)
  // The marker file on disk has the ORIGINAL deadline_at from record-awaiting-
  // approval (now+1hr). The validator reads from the marker, not run-state.
  // Re-write the marker with the expired deadline using the run's key so HMAC
  // verifies. createdAt = now so the mtime-vs-baseline check passes
  // (±10s tolerance).
  const keyResult = loadRunKey(project, runId)
  if (keyResult.error) throw new Error(`loadRunKey: ${keyResult.error}`)
  // Read existing marker to get decided_class.
  const existing = JSON.parse(fs.readFileSync(markerPath(project, runId), 'utf8'))
  const now = new Date().toISOString()
  // Remove existing marker so writeMarker doesn't see `alreadyPresent`.
  fs.unlinkSync(markerPath(project, runId))
  const w = writeMarker({
    projectRoot: project,
    runId,
    decidedClass: existing.decided_class,
    createdAt: now,
    deadlineAt: expired,
    runKey32B: keyResult.key32B,
  })
  if (w.status !== 'ok') throw new Error(`writeMarker (rewrite): ${w.code} ${w.message}`)
}

// ---------------------------------------------------------------------------
// AC-1 — bp1 inert (no activation)
// ---------------------------------------------------------------------------

tap('AC-1 bp1 inert (no config) → silent exit 0', () => {
  const project = makeProj()
  const home = makeHome()
  installGlobalScripts(home)
  // No config.json. Hook must silently no-op.
  const r = runHook({ cwd: project, home })
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} stderr=${r.stderr}`)
  assert.equal(r.stdout, '', 'no stdout per §178 silent-exit')
})

// ---------------------------------------------------------------------------
// AC-2 — not in git repo
// ---------------------------------------------------------------------------

tap('AC-2 not a git repo → silent exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-ac-nogit-'))
  const home = makeHome()
  installGlobalScripts(home)
  const r = runHook({ cwd: fs.realpathSync(dir), home })
  // flag-check is reached first and refuses (no activation) → exits 0.
  assert.equal(r.status, 0)
})

// ---------------------------------------------------------------------------
// AC-3 — active project, no markers
// ---------------------------------------------------------------------------

tap('AC-3 active project, no markers present → silent exit 0', () => {
  const project = makeProj()
  const home = makeHome()
  installGlobalScripts(home)
  const fp = writeKey(home)
  writeConfig(home, project, fp)
  // No markers. .checkpoints/ doesn't exist yet.
  const r = runHook({ cwd: project, home })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

// ---------------------------------------------------------------------------
// AC-4 — marker valid + expired → confirm-approval invoked
// ---------------------------------------------------------------------------

tap('AC-4 marker valid + expired → state=auto_approved + marker removed', () => {
  const ctx = setupAwaitingApproval()
  expireDeadline(ctx.project, ctx.runId)
  const mp = markerPath(ctx.project, ctx.runId)
  assert.ok(fs.existsSync(mp), 'marker present before hook')
  const r = runHook({ cwd: ctx.project, home: ctx.home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'auto_approved',
    'hook transitioned run to auto_approved')
  assert.equal(fs.existsSync(mp), false, 'marker file removed')
})

// ---------------------------------------------------------------------------
// AC-5 — marker valid + not expired → no-op
// ---------------------------------------------------------------------------

tap('AC-5 marker valid + not expired → no-op; state stays awaiting_approval', () => {
  const ctx = setupAwaitingApproval()
  // Do NOT expire the deadline.
  const mp = markerPath(ctx.project, ctx.runId)
  const r = runHook({ cwd: ctx.project, home: ctx.home })
  assert.equal(r.status, 0)
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'awaiting_approval',
    'state must remain awaiting_approval when deadline not yet expired')
  assert.ok(fs.existsSync(mp), 'marker stays on disk')
})

// ---------------------------------------------------------------------------
// AC-6 — marker missing (race) → no-op
// ---------------------------------------------------------------------------

tap('AC-6 marker file removed mid-flight (race) → hook exits 0 no-op', () => {
  const ctx = setupAwaitingApproval()
  // Delete the marker manually before hook runs. The hook's find will not
  // see it, so no validator call is made — equivalent to AC-3.
  const mp = markerPath(ctx.project, ctx.runId)
  fs.unlinkSync(mp)
  const r = runHook({ cwd: ctx.project, home: ctx.home })
  assert.equal(r.status, 0)
  // State unchanged.
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'awaiting_approval')
})

// ---------------------------------------------------------------------------
// AC-7 — marker invalid (corrupt JSON) + key present → Case A signed episode
// ---------------------------------------------------------------------------

tap('AC-7 marker invalid (corrupt JSON) + key present → Case A signed failure episode', () => {
  const ctx = setupAwaitingApproval()
  const mp = markerPath(ctx.project, ctx.runId)
  // Corrupt the marker.
  fs.writeFileSync(mp, '{"corrupted":true}')
  const r = runHook({ cwd: ctx.project, home: ctx.home })
  assert.equal(r.status, 0)
  // Look for signed bp1-marker-invalid episode under project episodes dir.
  const episodesDir = path.join(ctx.project, '.episodic-memory', 'episodes')
  const files = fs.readdirSync(episodesDir).filter(f => f.endsWith('.md'))
  const invalidFile = files.find(f => f.includes('bp1-marker-invalid') && f.includes(ctx.runId))
  assert.ok(invalidFile, `expected bp1-marker-invalid episode; got files: ${files.join(', ')}`)
  const content = fs.readFileSync(path.join(episodesDir, invalidFile), 'utf8')
  assert.ok(content.includes('hmac_signature:'), 'episode is HMAC-signed (Case A)')
  assert.ok(content.includes('failure_kind: "bp1-marker-invalid"'))
})

// ---------------------------------------------------------------------------
// AC-8 — marker invalid + key missing → Case B stderr
// ---------------------------------------------------------------------------

tap('AC-8 marker invalid + run.key missing → Case B stderr unsigned JSON surfaces through hook', () => {
  const ctx = setupAwaitingApproval()
  const mp = markerPath(ctx.project, ctx.runId)
  fs.writeFileSync(mp, '{"corrupted":true}')
  // Remove run.key to force Case B in the emit helper.
  const keyPath = path.join(ctx.project, '.episodic-memory/runs', ctx.runId, 'run.key')
  fs.unlinkSync(keyPath)
  const r = runHook({ cwd: ctx.project, home: ctx.home })
  assert.equal(r.status, 0)
  // Case B = stderr-only emission. Helper writes a single-line JSON record to
  // its stderr; hook MUST pass that stderr through (codex r1 P1 closure —
  // previously `>/dev/null 2>&1` discarded the only forensic record).
  const stderrLines = r.stderr.split('\n').filter(l => l.trim().length > 0)
  const caseBLine = stderrLines.find(l => {
    try {
      const o = JSON.parse(l)
      return o.kind === 'failure:bp1-marker-invalid-unsigned' && o.case === 'B' && o.run_id === ctx.runId
    } catch {
      return false
    }
  })
  assert.ok(caseBLine, `Case B JSON must appear on hook stderr; got: ${r.stderr.slice(0, 500)}`)
  // No signed episode under project episodes (Case B = stderr-only — no run.key).
  const episodesDir = path.join(ctx.project, '.episodic-memory', 'episodes')
  const files = fs.existsSync(episodesDir)
    ? fs.readdirSync(episodesDir).filter(f => f.includes('bp1-marker-invalid'))
    : []
  assert.equal(files.length, 0, 'no signed episode written when run.key missing (Case B)')
})

// ---------------------------------------------------------------------------
// AC-9 — unparseable filename (Case C) → hook stderr-logs directly
// ---------------------------------------------------------------------------

tap('AC-9 unparseable marker filename → Case C stderr from hook itself (JSON-parseable)', () => {
  const project = makeProj()
  const home = makeHome()
  installGlobalScripts(home)
  const fp = writeKey(home)
  writeConfig(home, project, fp)
  // Manufacture a marker with a malformed run_id suffix.
  const ckptDir = path.join(project, '.checkpoints')
  fs.mkdirSync(ckptDir, { recursive: true })
  // Filename matches bp1-approval-*.json glob but the suffix is not a valid
  // RUN_ID per the hook's regex /^bp1-run-[a-z0-9-]+$/.
  const badPath = path.join(ckptDir, 'bp1-approval-NOT_A_VALID_RUN_ID.json')
  fs.writeFileSync(badPath, '{}')
  const r = runHook({ cwd: project, home })
  assert.equal(r.status, 0)
  // Codex r2 P2 closure: assert structured JSON, not substring matching.
  // Previously substring-asserted; that hid the shell-interpolation bug where
  // adversarial filenames could break the JSON shape.
  const stderrLines = r.stderr.split('\n').filter(l => l.trim().length > 0)
  const caseCLine = stderrLines.find(l => {
    try {
      const o = JSON.parse(l)
      return o.kind === 'failure:bp1-marker-invalid-unparseable' && o.case === 'C'
    } catch {
      return false
    }
  })
  assert.ok(caseCLine, `expected JSON-parseable Case C stderr line; got: ${r.stderr.slice(0, 500)}`)
  const parsed = JSON.parse(caseCLine)
  assert.equal(parsed.basename, 'bp1-approval-NOT_A_VALID_RUN_ID.json')
  assert.equal(parsed.marker_path, badPath)
  assert.equal(parsed.hook, 'bp1-approval-check.sh')
})

// AC-9b: adversarial filename with JSON-special characters — codex r2 P2.
// Previously the hook used `printf '%s\n' "{\"marker_path\":\"$MARKER_PATH\"...}"`
// which broke when MARKER_PATH contained `"` or `\`. With jq -nc --arg, the
// emitted line MUST remain JSON-parseable.
tap('AC-9b adversarial filename with JSON-special chars → Case C stderr remains JSON-parseable', () => {
  const project = makeProj()
  const home = makeHome()
  installGlobalScripts(home)
  const fp = writeKey(home)
  writeConfig(home, project, fp)
  const ckptDir = path.join(project, '.checkpoints')
  fs.mkdirSync(ckptDir, { recursive: true })
  // Filename containing a literal `"` (legal on POSIX filesystems) plus
  // backslash + newline-like chars. The glob `bp1-approval-*.json` still
  // matches; the run_id regex still rejects it (so it routes to Case C).
  const adversarialBasename = 'bp1-approval-bad"id\\with-special.json'
  const adversarialPath = path.join(ckptDir, adversarialBasename)
  fs.writeFileSync(adversarialPath, '{}')
  const r = runHook({ cwd: project, home })
  assert.equal(r.status, 0, `hook should exit 0 even on adversarial filename; stderr=${r.stderr}`)
  const stderrLines = r.stderr.split('\n').filter(l => l.trim().length > 0)
  const caseCLine = stderrLines.find(l => {
    try {
      const o = JSON.parse(l)
      return o.kind === 'failure:bp1-marker-invalid-unparseable' && o.case === 'C'
    } catch {
      return false
    }
  })
  assert.ok(caseCLine,
    `Case C JSON must be parseable even for adversarial filename; got: ${r.stderr.slice(0, 500)}`)
  const parsed = JSON.parse(caseCLine)
  // Roundtrip: parsed.basename must equal the original adversarial basename
  // exactly (jq --arg preserves the bytes; string interpolation would have
  // mangled or broken the JSON).
  assert.equal(parsed.basename, adversarialBasename,
    'JSON.parse must roundtrip the adversarial basename exactly')
})

// ---------------------------------------------------------------------------
// AC-10 — multiple markers in one session
// ---------------------------------------------------------------------------

tap('AC-10 multiple markers in one session → each processed independently', () => {
  // Create TWO runs both in awaiting_approval; expire both deadlines.
  const project = makeProj()
  const home = makeHome()
  installGlobalScripts(home)
  const fp = writeKey(home)
  writeRfc(project, 'RFC-AC1')
  writeRfc(project, 'RFC-AC2')
  writeConfig(home, project, fp)
  const detR = runOrch(['detect-rfcs', '--project', project], { project, homeDir: home })
  assert.equal(detR.status, 0)
  const detected = JSON.parse(detR.stdout).detected
  assert.equal(detected.length, 2, 'two RFCs detected')
  const runs = []
  for (const det of detected) {
    const runId = det.run_id
    const sha = crypto.randomBytes(32).toString('hex')
    const preR = runOrch([
      'record-classifier-dispatch-pre', '--project', project, '--run-id', runId,
      '--input-sha256', sha,
    ], { project, homeDir: home })
    assert.equal(preR.status, 0)
    const preEpisodeId = JSON.parse(preR.stdout).pre_episode_id
    const resultFile = path.join(project, `classifier-result-${runId.slice(-6)}.json`)
    fs.writeFileSync(resultFile, JSON.stringify({
      class: 'trivial', confidence: 0.9, rationale: 'r', classified_fields: ['x'],
    }))
    const clsR = runOrch([
      'record-classification', '--project', project, '--run-id', runId,
      '--pre-episode-id', preEpisodeId, '--result-file', resultFile,
    ], { project, homeDir: home })
    assert.equal(clsR.status, 0)
    const classifiedEpisodeId = JSON.parse(clsR.stdout).classified_episode_id
    const raaR = runOrch([
      'record-awaiting-approval', '--project', project, '--run-id', runId,
      '--classified-episode-id', classifiedEpisodeId,
    ], { project, homeDir: home })
    assert.equal(raaR.status, 0)
    expireDeadline(project, runId)
    runs.push(runId)
  }
  const r = runHook({ cwd: project, home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const idx = loadIndex(project)
  for (const runId of runs) {
    assert.equal(idx.runs[runId].state, 'auto_approved',
      `run ${runId} must be auto_approved`)
    assert.equal(fs.existsSync(markerPath(project, runId)), false,
      `marker for ${runId} must be removed`)
  }
})

// ---------------------------------------------------------------------------
// AC-11 — orchestrator transient error → hook still exits 0
// ---------------------------------------------------------------------------

tap('AC-11 confirm-approval transient failure → hook exits 0 (next session retries)', () => {
  const ctx = setupAwaitingApproval()
  // Force confirm-approval to fail: backdate deadline_at, then corrupt run.key
  // so the orchestrator's loadRunKey returns an error (exit 5). The hook
  // swallows the failure (`|| true`) and must still exit 0.
  expireDeadline(ctx.project, ctx.runId)
  const keyPath = path.join(ctx.project, '.episodic-memory/runs', ctx.runId, 'run.key')
  fs.chmodSync(keyPath, 0o644)  // mode-drift → loadRunKey returns error
  const r = runHook({ cwd: ctx.project, home: ctx.home })
  assert.equal(r.status, 0, `hook must exit 0 even when orchestrator failed; stderr=${r.stderr}`)
  // State unchanged because confirm-approval bailed at loadRunKey.
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'awaiting_approval')
})

// ---------------------------------------------------------------------------
// AC-12 — git toplevel resolution: hook works when cwd is a subdir of project
// ---------------------------------------------------------------------------

tap('AC-12 hook invoked from subdir of project → resolves canonical root via git toplevel', () => {
  const ctx = setupAwaitingApproval()
  expireDeadline(ctx.project, ctx.runId)
  // Create a subdir and invoke the hook with that cwd.
  const subdir = path.join(ctx.project, 'docs')
  // subdir already exists (docs/rfcs/) from setup. Use it.
  const r = runHook({ cwd: subdir, home: ctx.home })
  assert.equal(r.status, 0, `stderr=${r.stderr}`)
  const idx = loadIndex(ctx.project)
  assert.equal(idx.runs[ctx.runId].state, 'auto_approved',
    'hook found marker via git toplevel resolution from subdir')
})

// ---------------------------------------------------------------------------
// AC-13 — real `git worktree add` linked worktree (codex r1 P2 closure)
// ---------------------------------------------------------------------------
//
// AC-12 covered a nested subdir of the main checkout (a sub-path of the main
// working tree). Codex r1 P2: a *linked worktree* (`git worktree add`) is a
// distinct directory with its own .git file pointing to the main checkout. The
// reader/writer symmetry claim per RFC §646 is that BOTH canonicalize via
// `git rev-parse --show-toplevel`, which in a linked worktree returns the
// WORKTREE root (not the main checkout's root). This test exercises that real
// disk shape: writer in worktree → marker under <worktree>/.checkpoints/;
// reader in worktree → finds marker and transitions state.
// ---------------------------------------------------------------------------

tap('AC-13 linked worktree (git worktree add) → writer + reader land on worktree root', () => {
  // 1. Set up main checkout with an initial commit (worktree needs a branch
  //    that points at a real commit).
  const main = makeProj()
  execFileSync('git', ['-C', main, 'config', 'user.email', 'juan.delacruz@acme.com'])
  execFileSync('git', ['-C', main, 'config', 'user.name', 'Juan Dela Cruz'])
  fs.writeFileSync(path.join(main, 'README.md'), '# main\n')
  execFileSync('git', ['-C', main, 'add', '.'])
  execFileSync('git', ['-C', main, 'commit', '-q', '-m', 'initial'])

  // 2. Create a linked worktree at a sibling path. New branch so it doesn't
  //    collide with main's HEAD.
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-wt-'))
  fs.rmdirSync(worktree)  // git worktree add needs the target to not exist
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'wt-branch', worktree])
  const worktreeReal = fs.realpathSync(worktree)

  // try/finally so cleanup runs even if an assertion throws partway through
  // (codex r2 test-hygiene closure 2026-05-17). Without this, an early throw
  // leaves the linked-worktree admin entry in `main/.git/worktrees/wt-branch/`
  // alive after the test exits; harmless given main is also a tmpdir, but
  // cleaner CI logs.
  try {
    // Sanity: `git rev-parse --show-toplevel` from inside worktree returns the
    // worktree path, NOT main. This is the §646 invariant.
    const toplevelFromWt = execFileSync('git', ['-C', worktreeReal, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    assert.equal(fs.realpathSync(toplevelFromWt), worktreeReal,
      'git toplevel from worktree must equal worktree path, not main')
    assert.notEqual(fs.realpathSync(toplevelFromWt), main,
      'worktree toplevel must NOT equal main checkout')

    // 3. Build BP-1 fixture INSIDE the worktree (RFC file, .episodic-memory dir).
    //    Activation map keys on the worktree's canonical path.
    fs.mkdirSync(path.join(worktreeReal, '.episodic-memory'), { recursive: true })
    fs.mkdirSync(path.join(worktreeReal, 'docs', 'rfcs'), { recursive: true })
    writeRfc(worktreeReal, 'RFC-WT')
    const home = makeHome()
    installGlobalScripts(home)
    const fp = writeKey(home)
    writeConfig(home, worktreeReal, fp)

    // 4. Run the writer pipeline FROM the worktree cwd.
    const detR = runOrch(['detect-rfcs', '--project', worktreeReal], { project: worktreeReal, homeDir: home })
    if (detR.status !== 0) throw new Error(`detect-rfcs: ${detR.stderr}`)
    const runId = JSON.parse(detR.stdout).detected[0].run_id
    const sha = crypto.randomBytes(32).toString('hex')
    const preR = runOrch([
      'record-classifier-dispatch-pre', '--project', worktreeReal, '--run-id', runId,
      '--input-sha256', sha,
    ], { project: worktreeReal, homeDir: home })
    if (preR.status !== 0) throw new Error(`pre: ${preR.stderr}`)
    const preEpisodeId = JSON.parse(preR.stdout).pre_episode_id
    const resultFile = path.join(worktreeReal, 'classifier-result.json')
    fs.writeFileSync(resultFile, JSON.stringify({
      class: 'trivial', confidence: 0.9, rationale: 'r', classified_fields: ['x'],
    }))
    const clsR = runOrch([
      'record-classification', '--project', worktreeReal, '--run-id', runId,
      '--pre-episode-id', preEpisodeId, '--result-file', resultFile,
    ], { project: worktreeReal, homeDir: home })
    if (clsR.status !== 0) throw new Error(`cls: ${clsR.stderr}`)
    const classifiedEpisodeId = JSON.parse(clsR.stdout).classified_episode_id
    const raaR = runOrch([
      'record-awaiting-approval', '--project', worktreeReal, '--run-id', runId,
      '--classified-episode-id', classifiedEpisodeId,
    ], { project: worktreeReal, homeDir: home })
    if (raaR.status !== 0) throw new Error(`raa: ${raaR.stderr}`)

    // 5. Writer-side assertion: marker landed under <worktree>/.checkpoints/,
    //    NOT under <main>/.checkpoints/.
    const wtMarker = path.join(worktreeReal, '.checkpoints', `bp1-approval-${runId}.json`)
    const mainMarker = path.join(main, '.checkpoints', `bp1-approval-${runId}.json`)
    assert.ok(fs.existsSync(wtMarker), `marker must exist under worktree root: ${wtMarker}`)
    assert.ok(!fs.existsSync(mainMarker), `marker must NOT exist under main root: ${mainMarker}`)

    // 6. Backdate deadline (uses writeMarker via expireDeadline — re-signs HMAC
    //    against worktree root).
    expireDeadline(worktreeReal, runId)

    // 7. Run hook from the worktree cwd. Reader-side: must resolve toplevel to
    //    worktree, scan <worktree>/.checkpoints/, find marker, transition state.
    const r = runHook({ cwd: worktreeReal, home })
    assert.equal(r.status, 0, `stderr=${r.stderr}`)

    // 8. State assertion: run-state index for the WORKTREE root records the
    //    terminal transition. The main checkout has no run-state for this run.
    const idxWt = loadIndex(worktreeReal)
    assert.equal(idxWt.runs[runId].state, 'auto_approved',
      'worktree run-state must reflect auto_approved transition')

    // 9. Marker cleaned up by orchestrator confirm-approval (still under
    //    worktree root, never under main).
    assert.ok(!fs.existsSync(wtMarker), 'marker must be cleaned up under worktree root')
  } finally {
    // 10. Cleanup the linked worktree (best-effort — harness will tmpdir-rm too).
    try {
      execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', worktreeReal])
    } catch {
      // ignore — main is a tmpdir, will be pruned regardless
    }
  }
})

console.log(`# tests ${pass + fail}`)
console.log(`# pass  ${pass}`)
console.log(`# fail  ${fail}`)
process.exit(fail > 0 ? 1 : 0)
