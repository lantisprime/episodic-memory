#!/usr/bin/env node
/**
 * test-bp1-build-artifact-manifest.mjs — Determinism + surface coverage tests.
 *
 * RFC-004 §107-152 + A14: two consecutive runs on the same install MUST
 * produce identical sha256.
 *
 * Surface coverage (A9-A13, A15):
 *   - bp1-* scripts inventoried; em-review-request.mjs explicitly listed
 *   - bp1-*.sh hooks inventoried
 *   - settings.json bp1 lines filtered + hashed
 *   - plugin.json bp1 entries filtered + hashed
 *   - bp1-* agent loaders inventoried
 *   - canonical-prompt episode-id resolved per loader
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

// Static import for direct unit testing of V1 guard. Per codex r9 P1,
// testing the guard via buildCanonicalPrompts is preempted by Node's
// path.join() TypeError before the helper-layer guard executes.
import { resolveLatestEpisodeId } from '../scripts/lib/bp1-manifest.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs')

// Lib + transitive imports required by bp1-build-artifact-manifest.mjs.
// Copied wholesale into proj/scripts/ for cross-cwd fixtures (A12c-g).
const FIXTURE_LIB_FILES = ['bp1-manifest.mjs', 'bp1-frontmatter.mjs', 'bp1-canonicalize.mjs']

let pass = 0, fail = 0
function tap(name, fn) {
  try { fn(); pass++; console.log(`ok ${pass + fail} - ${name}`) }
  catch (e) { fail++; console.log(`not ok ${pass + fail} - ${name}\n  ${(e.stack || e.message).split('\n').join('\n  ')}`) }
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bp1-mfst-${label}-`))
}

function makeProj() {
  const dir = makeTempDir('proj')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  return fs.realpathSync(dir)
}

function run(proj) {
  const out = execFileSync('node', [SCRIPT, '--project', proj, '--json'], { encoding: 'utf8' })
  return JSON.parse(out)
}

// ---------------------------------------------------------------------------
// Determinism: empty install
// ---------------------------------------------------------------------------
tap('A14: empty install — two runs produce same sha256', () => {
  const proj = makeProj()
  const a = run(proj)
  const b = run(proj)
  assert.equal(a.sha256, b.sha256, 'sha256 drifts across runs')
  assert.equal(a.status, 'ok')
})

// ---------------------------------------------------------------------------
// Determinism: populated install
// ---------------------------------------------------------------------------
tap('A14: populated install — two runs produce same sha256', () => {
  const proj = makeProj()
  fs.writeFileSync(path.join(proj, 'scripts', 'bp1-orchestrator.mjs'), '// orchestrator\n')
  fs.writeFileSync(path.join(proj, 'scripts', 'bp1-rfc-scan.mjs'), '// scan\n')
  fs.writeFileSync(path.join(proj, '.claude', 'hooks', 'bp1-approval-check.sh'), '#!/usr/bin/env bash\n')
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'bp1-orchestrator.md'), 'See episode 20260506-100000-some-slug-abcd.\n')
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ command: '$CLAUDE_PROJECT_DIR/.claude/hooks/bp1-approval-check.sh' }] }
  }))
  fs.writeFileSync(path.join(proj, '.claude-plugin', 'plugin.json'), JSON.stringify({
    'scheduled-tasks': [{ name: 'bp1-deadline-tick', cron: '*/5 * * * *' }],
    'slash-commands': [{ name: 'bp1-auto', script: 'foo.mjs' }],
  }))
  const a = run(proj)
  const b = run(proj)
  assert.equal(a.sha256, b.sha256)
})

// ---------------------------------------------------------------------------
// A4 coverage: changing one bp1 script content changes the hash
// ---------------------------------------------------------------------------
tap('hash changes when a bp1-* script content drifts', () => {
  const proj = makeProj()
  fs.writeFileSync(path.join(proj, 'scripts', 'bp1-foo.mjs'), '// v1\n')
  const a = run(proj)
  fs.writeFileSync(path.join(proj, 'scripts', 'bp1-foo.mjs'), '// v2\n')
  const b = run(proj)
  assert.notEqual(a.sha256, b.sha256)
})

// ---------------------------------------------------------------------------
// A9: hook content drift changes hash
// ---------------------------------------------------------------------------
tap('A9: hook content drift changes hash', () => {
  const proj = makeProj()
  const hookPath = path.join(proj, '.claude', 'hooks', 'bp1-approval-check.sh')
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\n# v1\n')
  const a = run(proj)
  fs.writeFileSync(hookPath, '#!/usr/bin/env bash\n# v2\n')
  const b = run(proj)
  assert.notEqual(a.sha256, b.sha256)
})

// ---------------------------------------------------------------------------
// A10: settings.json bp1 lines drift changes hash
// ---------------------------------------------------------------------------
tap('A10: settings.json bp1-line drift changes hash', () => {
  const proj = makeProj()
  const sp = path.join(proj, '.claude', 'settings.json')
  fs.writeFileSync(sp, JSON.stringify({
    hooks: { SessionStart: [{ command: 'bp1-approval-check.sh' }] }
  }, null, 2))
  const a = run(proj)
  fs.writeFileSync(sp, JSON.stringify({
    hooks: { SessionStart: [{ command: 'bp1-approval-check.sh' }, { command: 'bp1-sweep.sh' }] }
  }, null, 2))
  const b = run(proj)
  assert.notEqual(a.sha256, b.sha256)
})

// ---------------------------------------------------------------------------
// A11: plugin.json bp1 entries drift changes hash
// ---------------------------------------------------------------------------
tap('A11: plugin.json bp1 entries drift changes hash', () => {
  const proj = makeProj()
  const pp = path.join(proj, '.claude-plugin', 'plugin.json')
  fs.writeFileSync(pp, JSON.stringify({
    'scheduled-tasks': [{ name: 'bp1-deadline-tick', cron: '*/5 * * * *' }]
  }))
  const a = run(proj)
  fs.writeFileSync(pp, JSON.stringify({
    'scheduled-tasks': [{ name: 'bp1-deadline-tick', cron: '*/1 * * * *' }]
  }))
  const b = run(proj)
  assert.notEqual(a.sha256, b.sha256)
})

// ---------------------------------------------------------------------------
// A13: agent loader content drift changes hash
// ---------------------------------------------------------------------------
tap('A13: agent loader file drift changes hash', () => {
  const proj = makeProj()
  const lp = path.join(proj, '.claude', 'agents', 'bp1-orchestrator.md')
  fs.writeFileSync(lp, 'v1 prompt episode 20260506-100000-some-slug-abcd.\n')
  const a = run(proj)
  fs.writeFileSync(lp, 'v2 prompt episode 20260506-100000-some-slug-abcd.\n')
  const b = run(proj)
  assert.notEqual(a.sha256, b.sha256)
})

// ---------------------------------------------------------------------------
// A15: em-review-request.mjs is explicitly listed in the manifest
// ---------------------------------------------------------------------------
tap('A15: em-review-request.mjs is in the manifest scripts when present', () => {
  const proj = makeProj()
  fs.writeFileSync(path.join(proj, 'scripts', 'em-review-request.mjs'), '// extension\n')
  const r = run(proj)
  const found = r.manifest.scripts.find(s => s.path === 'scripts/em-review-request.mjs')
  assert.ok(found, 'em-review-request.mjs missing from manifest')
})

// ---------------------------------------------------------------------------
// Surface contract: empty manifest has expected SEVEN surfaces (PR-1b-A added
// scripts_lib per Codex plan-review consensus round 1 Q3.2)
// ---------------------------------------------------------------------------
tap('manifest has all seven contract surfaces (even when empty)', () => {
  const proj = makeProj()
  const r = run(proj)
  const m = r.manifest
  assert.equal(m.schema_version, 2,
    'schema_version=2 since PR-1b-A added scripts_lib surface')
  assert.ok(Array.isArray(m.scripts))
  assert.ok(Array.isArray(m.scripts_lib))
  assert.ok(Array.isArray(m.hooks))
  assert.ok(typeof m.settings_lines.sha256 === 'string')
  assert.ok(typeof m.plugin_entries.sha256 === 'string')
  assert.ok(Array.isArray(m.agent_loaders))
  assert.ok(Array.isArray(m.canonical_prompts))
})

// ---------------------------------------------------------------------------
// PR-1b-A: scripts_lib surface scopes to scripts/lib/bp1-*.mjs only
// (Codex plan-review round 1 Q3.2 — closes the load-bearing-helper drift hole)
// ---------------------------------------------------------------------------
tap('PR-1b-A: scripts_lib picks up scripts/lib/bp1-*.mjs files', () => {
  const proj = makeProj()
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'scripts', 'lib', 'bp1-helper.mjs'), '// helper\n')
  const r = run(proj)
  const found = r.manifest.scripts_lib.find(s => s.path === 'scripts/lib/bp1-helper.mjs')
  assert.ok(found, 'bp1-helper.mjs must be in scripts_lib')
})

tap('PR-1b-A: scripts_lib excludes non-bp1 lib files (closed glob)', () => {
  const proj = makeProj()
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'scripts', 'lib', 'bp1-keep.mjs'), '// keep\n')
  fs.writeFileSync(path.join(proj, 'scripts', 'lib', 'local-dir.mjs'), '// not bp1\n')
  fs.writeFileSync(path.join(proj, 'scripts', 'lib', 'helper.mjs'), '// not bp1\n')
  const r = run(proj)
  const paths = r.manifest.scripts_lib.map(s => s.path)
  assert.deepEqual(paths.sort(), ['scripts/lib/bp1-keep.mjs'])
})

tap('PR-1b-A: scripts_lib drift changes artifact_version_hash', () => {
  const proj = makeProj()
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'scripts', 'lib', 'bp1-thing.mjs'), '// v1\n')
  const a = run(proj)
  fs.writeFileSync(path.join(proj, 'scripts', 'lib', 'bp1-thing.mjs'), '// v2\n')
  const b = run(proj)
  assert.notEqual(a.sha256, b.sha256,
    'changing scripts/lib/bp1-*.mjs MUST trigger artifact-version drift')
})

// ---------------------------------------------------------------------------
// Round-3 regression: em-search subprocess error must propagate, not be
// swallowed by a bare catch in resolveLatestEpisodeId. Closes Codex round-3
// finding: I-P2-1 invariant must cover the canonical_prompts em-search path.
// ---------------------------------------------------------------------------
tap('Codex round-3: em-search returning {episodes:[]} falls back, does not throw', () => {
  // Exercises the legitimate fallback path: agent loader references an
  // episode id em-search has no history for. Pre-fix bare-catch and post-fix
  // explicit case both fall back to referencedId without throwing.
  const proj = makeProj()
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'bp1-fake.md'),
    'Canonical prompt episode 20260506-100000-fake-slug-abcd.\n')
  const r = run(proj)
  assert.equal(r.status, 'ok')
  // canonical_prompts populated with the fallback referencedId.
  const cps = r.manifest.canonical_prompts
  assert.equal(cps.length, 1)
  assert.equal(cps[0].latest_prompt_episode_id, '20260506-100000-fake-slug-abcd')
})

tap('Codex round-3: em-search subprocess malformed-output error propagates', () => {
  // Direct unit test on the lib via dynamic import — exercises the throw path
  // when em-search returns unexpected shape. Stubs the em-search.mjs file in
  // a temp scripts dir and points the lib at it via a copied lib + symlink
  // strategy is too fragile; instead we do a focused process-level test:
  // create a project that has its OWN scripts/em-search.mjs that prints
  // garbage, and copy the bp1-* lib + scripts over to that scratch project.
  const proj = makeProj()
  // Loader referencing a non-existent id
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'bp1-fake.md'),
    'Canonical prompt episode 20260506-100000-fake-slug-abcd.\n')
  // Copy the real lib + builder + a stubbed em-search into proj/scripts/.
  // bp1-manifest.mjs transitively imports bp1-frontmatter.mjs + bp1-canonicalize.mjs
  // (added in PR-1c-B Slice 2 commits 1/5 + 2/5); fixture must mirror that.
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true })
  for (const lib of ['bp1-manifest.mjs', 'bp1-frontmatter.mjs', 'bp1-canonicalize.mjs']) {
    fs.copyFileSync(path.join(REPO, 'scripts', 'lib', lib),
      path.join(proj, 'scripts', 'lib', lib))
  }
  fs.copyFileSync(path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    path.join(proj, 'scripts', 'bp1-build-artifact-manifest.mjs'))
  // Stub em-search to return malformed JSON (no episodes array)
  fs.writeFileSync(path.join(proj, 'scripts', 'em-search.mjs'),
    `#!/usr/bin/env node
console.log(JSON.stringify({status:'error', message:'simulated bad shape'}))
`)
  let threw = false
  try {
    execFileSync('node', [
      path.join(proj, 'scripts', 'bp1-build-artifact-manifest.mjs'),
      '--project', proj,
      '--json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    threw = true
    assert.ok(/unexpected shape/.test(e.message + (e.stderr || '')),
      `expected "unexpected shape" in error; got ${e.message}`)
  }
  assert.ok(threw, 'builder must propagate em-search malformed-output error')
})

// ---------------------------------------------------------------------------
// Sorted ordering: scripts always come back in path order
// ---------------------------------------------------------------------------
tap('scripts are returned in sorted order', () => {
  const proj = makeProj()
  fs.writeFileSync(path.join(proj, 'scripts', 'bp1-zzz.mjs'), '// z\n')
  fs.writeFileSync(path.join(proj, 'scripts', 'bp1-aaa.mjs'), '// a\n')
  fs.writeFileSync(path.join(proj, 'scripts', 'bp1-mmm.mjs'), '// m\n')
  const r = run(proj)
  const paths = r.manifest.scripts.map(s => s.path)
  const sorted = [...paths].sort()
  assert.deepEqual(paths, sorted)
})

// ===========================================================================
// A12 — canonical-prompt drift detection (slice 2a-bis)
//
// Real em-search + real .episodic-memory/index.jsonl + supersedes chain.
// Closes the named-test gap from M0/M1 + verifies the codex r1-r10 fix
// chain: projectRoot binding, --scope local, terminal selection.
// ===========================================================================

// Fixture helper: build a tmp project with .episodic-memory/episodes + index.jsonl
// pre-populated with `episodes`. Each entry: { id, supersedes?, summary? }.
// index.jsonl shape mirrors em-store's emitted records (sufficient fields for
// em-search --history walk: id, supersedes, status, date, time).
function makeProjWithEpisodes(label, episodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bp1-mfst-${label}-`))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.episodic-memory', 'episodes'), { recursive: true })
  const indexLines = []
  for (const e of episodes) {
    const epPath = path.join(dir, '.episodic-memory', 'episodes', `${e.id}.md`)
    const sup = e.supersedes ? `supersedes: ${e.supersedes}` : 'supersedes: null'
    fs.writeFileSync(epPath,
      `---\nid: ${e.id}\ndate: 2026-05-13\ntime: "00:00"\nproject: ${label}\ncategory: lesson\nstatus: active\n${sup}\nsummary: ${e.summary || `fixture episode ${e.id}`}\n---\n\n# ${e.summary || e.id}\n\nfixture body\n`)
    indexLines.push(JSON.stringify({
      id: e.id, date: '2026-05-13', time: '00:00',
      project: label, category: 'lesson', status: 'active',
      supersedes: e.supersedes || null,
      summary: e.summary || `fixture episode ${e.id}`,
      tags: [],
    }))
  }
  fs.writeFileSync(path.join(dir, '.episodic-memory', 'index.jsonl'),
    indexLines.join('\n') + (indexLines.length ? '\n' : ''))
  return fs.realpathSync(dir)
}

// Fixture helper: copy real lib + real builder + real em-search into proj/scripts.
// The builder uses import.meta.url-relative paths so the copied tree is what
// gets exercised. resolveLatestEpisodeId's cwd: projectRoot binding directs
// em-search's local store reads to the project's .episodic-memory/.
function installRuntimeIntoProj(proj) {
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true })
  for (const lib of FIXTURE_LIB_FILES) {
    fs.copyFileSync(path.join(REPO, 'scripts', 'lib', lib),
      path.join(proj, 'scripts', 'lib', lib))
  }
  // em-search transitively imports lib/local-dir.mjs
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib', 'local-dir.mjs'),
    path.join(proj, 'scripts', 'lib', 'local-dir.mjs'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'em-search.mjs'),
    path.join(proj, 'scripts', 'em-search.mjs'))
  fs.copyFileSync(path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    path.join(proj, 'scripts', 'bp1-build-artifact-manifest.mjs'))
}

// Run the COPIED builder against an explicit proj root, optionally from a
// different caller cwd (default: REPO root, matching existing tests).
function runCopiedBuilder(proj, { callerCwd = REPO, env = process.env } = {}) {
  const copiedBuilder = path.join(proj, 'scripts', 'bp1-build-artifact-manifest.mjs')
  const out = execFileSync('node', [copiedBuilder, '--project', proj, '--json'],
    { encoding: 'utf8', cwd: callerCwd, env })
  return JSON.parse(out)
}

// ---------------------------------------------------------------------------
// A12: canonical-prompt episode superseded → flag-version-drift
// ---------------------------------------------------------------------------
tap('A12: canonical-prompt supersede flips terminal id and manifest sha', () => {
  const ROOT_ID = '20260506-100000-canonical-root-aaaa'
  const TERM_ID = '20260507-100000-canonical-term-bbbb'
  const proj = makeProjWithEpisodes('a12', [{ id: ROOT_ID }])
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'bp1-orchestrator.md'),
    `See canonical prompt episode ${ROOT_ID}.\n`)
  installRuntimeIntoProj(proj)

  // Phase 1: chain-of-1 (root == terminal)
  const r1 = runCopiedBuilder(proj)
  const cp1 = r1.manifest.canonical_prompts
  assert.equal(cp1.length, 1, 'one loader → one canonical_prompts entry')
  assert.equal(cp1[0].latest_prompt_episode_id, ROOT_ID,
    'A12 phase 1: terminal id is referenced id when chain has one entry')
  const sha1 = r1.sha256

  // Phase 1b idempotence: rerun against same state must produce same sha
  const r1b = runCopiedBuilder(proj)
  assert.equal(r1b.sha256, sha1,
    'A12 idempotence: sha must be stable across re-runs of identical state')

  // Phase 2: add a successor episode that supersedes ROOT_ID
  const successorPath = path.join(proj, '.episodic-memory', 'episodes', `${TERM_ID}.md`)
  fs.writeFileSync(successorPath,
    `---\nid: ${TERM_ID}\ndate: 2026-05-13\ntime: "01:00"\nproject: a12\ncategory: lesson\nstatus: active\nsupersedes: ${ROOT_ID}\nsummary: revised canonical prompt\n---\n\nbody\n`)
  const indexPath = path.join(proj, '.episodic-memory', 'index.jsonl')
  const existing = fs.readFileSync(indexPath, 'utf8')
  fs.writeFileSync(indexPath, existing + JSON.stringify({
    id: TERM_ID, date: '2026-05-13', time: '01:00',
    project: 'a12', category: 'lesson', status: 'active',
    supersedes: ROOT_ID, summary: 'revised canonical prompt', tags: [],
  }) + '\n')

  const r2 = runCopiedBuilder(proj)
  const cp2 = r2.manifest.canonical_prompts
  assert.equal(cp2[0].latest_prompt_episode_id, TERM_ID,
    'A12 post-revise: terminal id must flip to post-supersede id (codex r4 P1 closure)')
  assert.notEqual(r2.sha256, sha1,
    'A12 drift detection: manifest sha must change after canonical-prompt supersede')
})

// ---------------------------------------------------------------------------
// A12c: caller-cwd != --project — resolution must come from target store
// (codex r2 F2 + r3 B1: real-em-search fixture, not hard-coded stub)
// ---------------------------------------------------------------------------
tap('A12c: caller cwd != --project — resolution binds to target, not caller', () => {
  const ROOT_ID = '20260506-100000-shared-root-aaaa'
  const TARGET_TERM = '20260507-100000-target-terminal-bbbb'
  const CALLER_TERM = '20260508-100000-caller-terminal-cccc'

  // Target store: chain ROOT_ID → TARGET_TERM
  const target = makeProjWithEpisodes('a12c-target', [
    { id: ROOT_ID },
    { id: TARGET_TERM, supersedes: ROOT_ID, summary: 'target terminal' },
  ])
  fs.writeFileSync(path.join(target, '.claude', 'agents', 'bp1-orchestrator.md'),
    `See canonical prompt episode ${ROOT_ID}.\n`)
  installRuntimeIntoProj(target)

  // Caller store: SAME ROOT_ID but a different terminal CALLER_TERM. If the
  // cwd binding is broken (the pre-fix bug), em-search runs from caller cwd
  // and resolves CALLER_TERM. Post-fix: cwd: projectRoot binds to target.
  const caller = makeProjWithEpisodes('a12c-caller', [
    { id: ROOT_ID },
    { id: CALLER_TERM, supersedes: ROOT_ID, summary: 'caller terminal (must be ignored)' },
  ])

  const r = runCopiedBuilder(target, { callerCwd: caller })
  const cp = r.manifest.canonical_prompts
  assert.equal(cp[0].latest_prompt_episode_id, TARGET_TERM,
    'A12c: terminal must come from --project target store, not caller cwd')
  assert.notEqual(cp[0].latest_prompt_episode_id, CALLER_TERM,
    'A12c regression guard: caller-cwd terminal must not leak into manifest')
})

// ---------------------------------------------------------------------------
// A12d: linked-worktree axis — CONTRACT-PRESERVATION ONLY (codex r4 P2)
// scripts/lib/local-dir.mjs maps a linked worktree back through
// git rev-parse --git-common-dir, so caller=worktree, target=main-of-worktree
// may legitimately resolve the SAME local store. This test documents that
// resolution still produces target's terminal (no regression), but is NOT a
// discriminating regression guard for cwd binding — A12c/e/f are.
// ---------------------------------------------------------------------------
tap('A12d: linked-worktree resolution (contract-preservation, not regression guard)', () => {
  const ROOT_ID = '20260506-100000-wt-root-aaaa'
  const TERM_ID = '20260507-100000-wt-term-bbbb'
  const target = makeProjWithEpisodes('a12d-target', [
    { id: ROOT_ID },
    { id: TERM_ID, supersedes: ROOT_ID },
  ])
  fs.writeFileSync(path.join(target, '.claude', 'agents', 'bp1-orchestrator.md'),
    `See canonical prompt episode ${ROOT_ID}.\n`)
  installRuntimeIntoProj(target)

  // Create linked worktree. CI runners may have no global git user config,
  // so scope identity to this invocation only (-c) — avoids polluting global
  // config and lets the test run anywhere git is installed.
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-mfst-a12d-wt-'))
  execFileSync('git', [
    '-C', target,
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=test',
    'commit', '--allow-empty', '-m', 'init', '-q'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['-C', target, 'worktree', 'add', '-q', wtDir, '-b', 'a12d-wt-branch'],
    { stdio: ['ignore', 'pipe', 'pipe'] })

  const r = runCopiedBuilder(target, { callerCwd: wtDir })
  assert.equal(r.manifest.canonical_prompts[0].latest_prompt_episode_id, TERM_ID,
    'A12d: worktree caller still resolves target terminal (contract preserved)')

  // Cleanup
  execFileSync('git', ['-C', target, 'worktree', 'remove', '--force', wtDir],
    { stdio: ['ignore', 'pipe', 'pipe'] })
})

// ---------------------------------------------------------------------------
// A12e: nested cwd inside target (CONTRACT-PRESERVATION ONLY)
// `resolveLocalDir(target/subdir)` walks up via `git rev-parse --git-common-dir`
// and resolves to target's .episodic-memory anyway. So caller-cwd=target/subdir
// resolves the SAME store as caller-cwd=target — A12e is NOT a discriminating
// regression guard for the cwd-binding bug (it would pass even if cwd:
// projectRoot were silently removed). Documented contract-preservation only;
// A12c (caller-with-conflicting-chain) and A12f (non-git caller) are the
// discriminating cwd-binding tests. Per negative-scenario-reviewer F1.
// ---------------------------------------------------------------------------
tap('A12e: nested cwd resolution (contract-preservation, not regression guard)', () => {
  const ROOT_ID = '20260506-100000-nested-root-aaaa'
  const TERM_ID = '20260507-100000-nested-term-bbbb'
  const target = makeProjWithEpisodes('a12e', [
    { id: ROOT_ID },
    { id: TERM_ID, supersedes: ROOT_ID },
  ])
  fs.writeFileSync(path.join(target, '.claude', 'agents', 'bp1-orchestrator.md'),
    `See canonical prompt episode ${ROOT_ID}.\n`)
  installRuntimeIntoProj(target)

  const nested = path.join(target, 'subdir')
  fs.mkdirSync(nested, { recursive: true })

  const r = runCopiedBuilder(target, { callerCwd: nested })
  assert.equal(r.manifest.canonical_prompts[0].latest_prompt_episode_id, TERM_ID,
    'A12e: nested cwd inside target resolves target terminal (contract preserved)')
})

// ---------------------------------------------------------------------------
// A12f: non-git caller cwd with --project — resolution still pins to target
// ---------------------------------------------------------------------------
tap('A12f: non-git caller cwd — resolution still pins to target', () => {
  const ROOT_ID = '20260506-100000-nogit-root-aaaa'
  const TERM_ID = '20260507-100000-nogit-term-bbbb'
  const target = makeProjWithEpisodes('a12f', [
    { id: ROOT_ID },
    { id: TERM_ID, supersedes: ROOT_ID },
  ])
  fs.writeFileSync(path.join(target, '.claude', 'agents', 'bp1-orchestrator.md'),
    `See canonical prompt episode ${ROOT_ID}.\n`)
  installRuntimeIntoProj(target)

  // Non-git tmp dir as caller
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-mfst-a12f-nogit-'))

  const r = runCopiedBuilder(target, { callerCwd: nogit })
  assert.equal(r.manifest.canonical_prompts[0].latest_prompt_episode_id, TERM_ID,
    'A12f: non-git caller cwd resolves target terminal')
})

// ---------------------------------------------------------------------------
// A12g: HOME redirection with conflicting global chain — --scope local must win
// (codex r3 B2 closure)
// ---------------------------------------------------------------------------
tap('A12g: HOME redirection — --scope local binds resolution to project store', () => {
  const ROOT_ID = '20260506-100000-home-root-aaaa'
  const TARGET_TERM = '20260507-100000-target-term-bbbb'
  const GLOBAL_TERM = '20260508-100000-global-term-dddd'

  const target = makeProjWithEpisodes('a12g-target', [
    { id: ROOT_ID },
    { id: TARGET_TERM, supersedes: ROOT_ID, summary: 'target local terminal' },
  ])
  fs.writeFileSync(path.join(target, '.claude', 'agents', 'bp1-orchestrator.md'),
    `See canonical prompt episode ${ROOT_ID}.\n`)
  installRuntimeIntoProj(target)

  // Build a fake HOME with a conflicting global supersedes chain. If
  // --scope local is NOT pinned, em-search would consider both stores and
  // could return GLOBAL_TERM.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bp1-mfst-a12g-home-'))
  fs.mkdirSync(path.join(fakeHome, '.episodic-memory', 'episodes'), { recursive: true })
  fs.writeFileSync(path.join(fakeHome, '.episodic-memory', 'episodes', `${ROOT_ID}.md`),
    `---\nid: ${ROOT_ID}\ndate: 2026-05-13\ntime: "00:00"\nproject: global\ncategory: lesson\nstatus: active\nsupersedes: null\nsummary: global root\n---\n\nbody\n`)
  fs.writeFileSync(path.join(fakeHome, '.episodic-memory', 'episodes', `${GLOBAL_TERM}.md`),
    `---\nid: ${GLOBAL_TERM}\ndate: 2026-05-13\ntime: "02:00"\nproject: global\ncategory: lesson\nstatus: active\nsupersedes: ${ROOT_ID}\nsummary: global terminal\n---\n\nbody\n`)
  fs.writeFileSync(path.join(fakeHome, '.episodic-memory', 'index.jsonl'),
    JSON.stringify({ id: ROOT_ID, date: '2026-05-13', time: '00:00', project: 'global', category: 'lesson', status: 'active', supersedes: null, summary: 'global root', tags: [] }) + '\n' +
    JSON.stringify({ id: GLOBAL_TERM, date: '2026-05-13', time: '02:00', project: 'global', category: 'lesson', status: 'active', supersedes: ROOT_ID, summary: 'global terminal', tags: [] }) + '\n')

  const r = runCopiedBuilder(target, { env: { ...process.env, HOME: fakeHome } })
  assert.equal(r.manifest.canonical_prompts[0].latest_prompt_episode_id, TARGET_TERM,
    'A12g: --scope local must select target local terminal, not HOME global terminal')
  assert.notEqual(r.manifest.canonical_prompts[0].latest_prompt_episode_id, GLOBAL_TERM,
    'A12g regression guard: HOME global chain must not leak into manifest')
})

// ---------------------------------------------------------------------------
// A12h / A12h-2: V1 guard — resolveLatestEpisodeId rejects bad projectRoot
// (validation-contract audit V1; codex r9 P1: must test at helper layer
// directly, not via buildCanonicalPrompts which preempts with path.join)
// ---------------------------------------------------------------------------
tap('A12h: resolveLatestEpisodeId throws on undefined projectRoot (V1 guard)', () => {
  assert.throws(
    () => resolveLatestEpisodeId('20260506-100000-some-slug-abcd', undefined),
    /projectRoot must be an absolute path string/,
    'V1 guard must fire when projectRoot is undefined'
  )
})

tap('A12h-2: resolveLatestEpisodeId throws on relative projectRoot (V1 guard)', () => {
  assert.throws(
    () => resolveLatestEpisodeId('20260506-100000-some-slug-abcd', './relative'),
    /projectRoot must be an absolute path string/,
    'V1 guard must fire when projectRoot is a relative path'
  )
})

// ---------------------------------------------------------------------------
// A12i: V2 guard — terminal entry without id throws (validation-contract V2)
// Stub-style fixture: em-search returns a chain entry with no `id` field.
// ---------------------------------------------------------------------------
tap('A12i: terminal selection throws on malformed em-search chain entry (V2 guard)', () => {
  const proj = makeProj()
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'bp1-orchestrator.md'),
    'See canonical prompt episode 20260506-100000-malformed-aaaa.\n')
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true })
  for (const lib of FIXTURE_LIB_FILES) {
    fs.copyFileSync(path.join(REPO, 'scripts', 'lib', lib),
      path.join(proj, 'scripts', 'lib', lib))
  }
  fs.copyFileSync(path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs'),
    path.join(proj, 'scripts', 'bp1-build-artifact-manifest.mjs'))
  // Stub em-search returns chain with no id field
  fs.writeFileSync(path.join(proj, 'scripts', 'em-search.mjs'),
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({status:'ok', count:1, chain:[{not_id:'x'}]}))\n`)

  let threw = false
  try {
    execFileSync('node', [
      path.join(proj, 'scripts', 'bp1-build-artifact-manifest.mjs'),
      '--project', proj, '--json',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    threw = true
    // Per negative-scenario-reviewer F2: tighten assertion. Check stderr
    // explicitly (Buffer.toString()) + require nonzero exit, rather than
    // concatenating message+stderr which can Buffer-coerce ambiguously.
    const stderr = (e.stderr || '').toString()
    assert.ok(typeof e.status === 'number' && e.status !== 0,
      `V2 guard must produce nonzero exit; got status=${e.status}`)
    assert.ok(stderr.includes('malformed terminal entry'),
      `V2 guard must emit "malformed terminal entry" in stderr; got: ${stderr.slice(0, 500)}`)
  }
  assert.ok(threw, 'builder must propagate V2 guard error')
})

console.log(`\n1..${pass + fail}`)
if (fail) { console.log(`# FAILED ${fail} of ${pass + fail}`); process.exit(1) }
else console.log(`# PASSED ${pass}`)
