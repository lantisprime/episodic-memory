#!/usr/bin/env node
// check-plugin-version-bump.mjs — CI gate for #644.
//
// `claude plugin update` is version-gated on .claude-plugin/plugin.json, so a
// merge that changes plugin content without bumping the version makes the
// update a permanent no-op: the installed cache silently pins the old commit
// until a manual uninstall+reinstall (observed: cache sat at 97a4309 while
// main advanced to 6964ea0).
//
// This gate compares HEAD against the merge-base with the baseline. If any
// install-surface path changed, .claude-plugin/plugin.json must carry a
// strictly greater semver than the merge-base copy.
//
// Baseline is event-specific (codex R1 F1, R2 F7): github.base_ref exists
// only on pull_request events; on push the checkout IS the pushed tip, so a
// ref baseline degenerates to merge-base(HEAD, HEAD) and the gate sees an
// empty diff. PRs pass --base-ref (merge-base semantics against the target
// branch); pushes pass --base-sha github.event.before, which is EXACT — no
// merge-base reduction, because on a non-fast-forward push the merge-base
// walks past the pre-push tip and hides a version downgrade. The all-zeros
// before-sha (branch creation) is the one case with no baseline and passes
// explicitly.
//
// Content paths are the plugin's install surface, not the whole repo: docs,
// tests, and workflow edits change the marketplace clone's sha but not the
// behavior an installed plugin executes, and requiring a bump for those would
// be pure churn. The set errs over-inclusive (all of scripts/ forces a bump
// even though repo-dev scripts ship nowhere — install-manifest.mjs P12
// classes) because over-inclusion is the safe direction; under-inclusion is
// locked by tests/test-plugin-version-bump.mjs's conformance axis against the
// install-version.mjs artifact enumerator.
//
// Usage: node scripts/check-plugin-version-bump.mjs [--project <path>] [--base-ref <ref> | --base-sha <sha>]
// Output: exactly one JSON report on stdout in every reachable outcome; exit 1
// when a required bump is missing or the comparison cannot be made (fail
// closed, matching the validate-bp-contract stable-ID precedent).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MANIFEST = '.claude-plugin/plugin.json'
const ZERO_SHA = /^0{40}$/

// The install surface: what an installed plugin or substrate deploy actually
// executes or reads. Directory entries end with '/'; anything else is an
// exact-file entry. Under-inclusion drift is caught by the conformance test.
export const CONTENT_PREFIXES = [
  '.claude-plugin/',
  '.claude/', // tracked hook shells, agents, skill links — per-project artifact sources
  'scripts/',
  'skills/',
  'plugins/',
  'instructions/',
  'patterns/',
  'schemas/', // runtime data of installed libs, e.g. structured-alert.mjs reads schemas/runtime/ (codex R2 F9)
  'learning/', // live registry descriptors — plugins/_index.json points at learning/*.json (codex R3 F13)
  'install.mjs',
  'categories.json',
  'activation-classes.json',
  'docs/EM_SCRIPTS_GUIDE.md',
]

export function isContentPath(p) {
  return CONTENT_PREFIXES.some((pre) => (pre.endsWith('/') ? p.startsWith(pre) : p === pre))
}

// Strict plain X.Y.Z: numeric identifiers without leading zeros (codex R1 F6).
// BigInt components so ordering never loses precision.
export function parseSemver(v) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(v ?? ''))
  if (!m) return null
  return [BigInt(m[1]), BigInt(m[2]), BigInt(m[3])]
}

export function semverGreater(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

// Pure decision core (unit-tested in tests/test-plugin-version-bump.mjs).
// `base` is an explicit state, never a bare nullable (codex R1 F4):
//   { state: 'absent' }                — manifest path proven missing at base
//   { state: 'present', version: any } — manifest exists; version may be junk
export function decideBump({ changedPaths, base, headVersion }) {
  const content = changedPaths.filter(isContentPath)
  if (content.length === 0) {
    return { ok: true, bump_required: false, content_paths: [], reason: 'no plugin-content changes' }
  }
  const head = parseSemver(headVersion)
  if (!head) {
    return {
      ok: false, bump_required: true, content_paths: content,
      reason: `head ${MANIFEST} version ${JSON.stringify(headVersion)} is not plain X.Y.Z semver`,
    }
  }
  if (base.state === 'absent') {
    return { ok: true, bump_required: true, content_paths: content, reason: 'manifest introduced in this change' }
  }
  const baseParsed = parseSemver(base.version)
  if (!baseParsed) {
    return {
      ok: false, bump_required: true, content_paths: content,
      reason: `base ${MANIFEST} exists but its version ${JSON.stringify(base.version)} is not plain X.Y.Z semver; cannot prove a bump — fail closed`,
    }
  }
  if (!semverGreater(head, baseParsed)) {
    return {
      ok: false, bump_required: true, content_paths: content,
      reason: `plugin content changed but version did not advance (${base.version} -> ${headVersion}); claude plugin update will no-op (#644)`,
    }
  }
  return { ok: true, bump_required: true, content_paths: content, reason: `version advanced ${base.version} -> ${headVersion}` }
}

function fail(report) {
  console.log(JSON.stringify({ status: 'error', ok: false, ...report }))
  process.exit(1)
}

// Strict fail-closed parser (codex R2 F10): known value-flags only — no
// unknown flags, positionals, duplicates, or missing values.
export function parseArgs(argv) {
  const KNOWN = new Set(['--project', '--base-ref', '--base-sha'])
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!KNOWN.has(a)) return { error: `unknown argument ${JSON.stringify(a)}; expected --project/--base-ref/--base-sha` }
    if (a in opts) return { error: `duplicate flag ${a}` }
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) return { error: `flag ${a} requires a value` }
    opts[a] = v
    i++
  }
  if ('--base-ref' in opts && '--base-sha' in opts) return { error: '--base-ref and --base-sha are mutually exclusive' }
  // --base-sha is an IMMUTABLE baseline: full 40-hex object names only.
  // HEAD, branch names, abbreviations, and revision expressions would let the
  // baseline float — --base-sha HEAD self-compares to an empty diff (codex R3
  // F12). Mutable baselines belong to --base-ref's merge-base semantics.
  if ('--base-sha' in opts && !/^[0-9a-f]{40}$/.test(opts['--base-sha'])) {
    return { error: `--base-sha must be a full 40-hex commit sha, got ${JSON.stringify(opts['--base-sha'])}` }
  }
  return { opts }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) fail({ reason: parsed.error })
  const opts = parsed.opts
  const baseSha = opts['--base-sha']
  const baseRef = opts['--base-ref'] ?? (baseSha === undefined ? 'origin/main' : undefined)

  // One explicit project root; every git call binds to it and the report
  // names it (codex R1 F2 — no ambient-cwd authority).
  let projectRoot
  try {
    projectRoot = fs.realpathSync(path.resolve(opts['--project'] ?? '.'))
  } catch (err) {
    fail({ reason: `cannot resolve --project: ${err.message}` })
  }
  // Sanitized environment: inherited repository-selection variables (GIT_DIR,
  // GIT_WORK_TREE, …) override cwd and would silently rebind every read to a
  // different repository while the JSON still names projectRoot (codex R3 F11).
  const gitEnv = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_INDEX_FILE']) {
    delete gitEnv[k]
  }
  const git = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', env: gitEnv })

  if (baseSha !== undefined && ZERO_SHA.test(baseSha)) {
    // push event with no previous tip (branch creation): nothing to diff against.
    console.log(JSON.stringify({
      status: 'ok', project_root: projectRoot, base_sha: baseSha, ok: true,
      bump_required: false, content_paths: [], reason: 'no pre-push baseline (all-zeros before sha)',
    }, null, 2))
    return
  }

  // Baseline commit: --base-sha is EXACT (codex R2 F7 — merge-base reduction
  // hides non-fast-forward downgrades); --base-ref keeps merge-base semantics
  // for PR branches that are behind their target.
  let baseline
  if (baseSha !== undefined) {
    try {
      baseline = git(['rev-parse', '--verify', `${baseSha}^{commit}`]).trim()
    } catch (err) {
      // Fail closed: an unreachable pre-push sha means the gate cannot run.
      fail({ project_root: projectRoot, reason: `--base-sha ${baseSha} does not resolve to a commit: ${err.message}` })
    }
  } else {
    try {
      baseline = git(['merge-base', 'HEAD', baseRef]).trim()
    } catch (err) {
      // Fail closed: shallow clone or missing baseline means the gate cannot run.
      fail({ project_root: projectRoot, reason: `merge-base with ${baseRef} failed: ${err.message}` })
    }
  }

  let changedPaths
  try {
    // -z: NUL-delimited raw paths — core.quotePath octal-escapes non-ASCII in
    // newline mode and breaks prefix matching (codex R1 F5). --no-renames:
    // rename detection would report only the destination endpoint, hiding a
    // content-path source that moved out of the surface (codex R2 F8).
    changedPaths = git(['diff', '--no-renames', '--name-only', '-z', baseline, 'HEAD']).split('\0').filter(Boolean)
  } catch (err) {
    fail({ project_root: projectRoot, baseline, reason: `git diff failed: ${err.message}` })
  }

  // Base manifest state: 'absent' only on a PROVEN missing path (empty
  // ls-tree). A manifest that exists but does not parse fails closed in
  // decideBump — corruption is never "first introduction" (codex R1 F4).
  let base
  try {
    const entry = git(['ls-tree', '--name-only', baseline, '--', MANIFEST]).trim()
    if (entry === '') {
      base = { state: 'absent' }
    } else {
      let version
      try {
        version = JSON.parse(git(['show', `${baseline}:${MANIFEST}`])).version
      } catch (err) {
        version = `<unreadable: ${err.message.split('\n')[0]}>`
      }
      base = { state: 'present', version }
    }
  } catch (err) {
    fail({ project_root: projectRoot, baseline, reason: `reading base ${MANIFEST} state failed: ${err.message}` })
  }

  let headVersion
  try {
    headVersion = JSON.parse(git(['show', `HEAD:${MANIFEST}`])).version
  } catch (err) {
    fail({ project_root: projectRoot, baseline, reason: `cannot read HEAD ${MANIFEST}: ${err.message}` })
  }

  const verdict = decideBump({ changedPaths, base, headVersion })
  console.log(JSON.stringify({
    status: 'ok',
    project_root: projectRoot,
    ...(baseSha !== undefined ? { base_sha: baseSha } : { base_ref: baseRef }),
    baseline,
    base_manifest: base,
    head_version: headVersion,
    ...verdict,
  }, null, 2))
  process.exit(verdict.ok ? 0 : 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
