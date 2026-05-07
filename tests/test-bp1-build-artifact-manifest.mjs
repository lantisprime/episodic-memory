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

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(REPO, 'scripts', 'bp1-build-artifact-manifest.mjs')

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
  // Copy the real lib + builder + a stubbed em-search into proj/scripts/
  fs.mkdirSync(path.join(proj, 'scripts', 'lib'), { recursive: true })
  fs.copyFileSync(path.join(REPO, 'scripts', 'lib', 'bp1-manifest.mjs'),
    path.join(proj, 'scripts', 'lib', 'bp1-manifest.mjs'))
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

console.log(`\n1..${pass + fail}`)
if (fail) { console.log(`# FAILED ${fail} of ${pass + fail}`); process.exit(1) }
else console.log(`# PASSED ${pass}`)
