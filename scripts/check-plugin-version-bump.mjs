#!/usr/bin/env node
// check-plugin-version-bump.mjs — CI gate for #644.
//
// `claude plugin update` is version-gated on .claude-plugin/plugin.json, so a
// merge that changes plugin content without bumping the version makes the
// update a permanent no-op: the installed cache silently pins the old commit
// until a manual uninstall+reinstall (observed: cache sat at 97a4309 while
// main advanced to 6964ea0).
//
// This gate compares HEAD against the merge-base with the base ref. If any
// plugin-content path changed, .claude-plugin/plugin.json must carry a
// strictly greater semver than the merge-base copy.
//
// Content paths are the plugin's install surface, not the whole repo: docs,
// tests, and workflow edits change the marketplace clone's sha but not the
// behavior an installed plugin executes, and requiring a bump for those would
// be pure churn.
//
// Usage: node scripts/check-plugin-version-bump.mjs [--base-ref origin/main]
// Output: one JSON report on stdout; exit 1 when a required bump is missing
// (or the comparison cannot be made — fail closed, matching the
// validate-bp-contract stable-ID precedent).

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MANIFEST = '.claude-plugin/plugin.json'

// The install surface: what an installed plugin actually executes or exposes.
export const CONTENT_PREFIXES = [
  '.claude-plugin/',
  'scripts/',
  'skills/',
  'plugins/',
  'instructions/',
  'install.mjs',
]

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? ''))
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function semverGreater(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

// Pure decision core (unit-tested in tests/test-plugin-version-bump.mjs).
export function decideBump({ changedPaths, baseVersion, headVersion }) {
  const content = changedPaths.filter((p) =>
    CONTENT_PREFIXES.some((pre) => (pre.endsWith('/') ? p.startsWith(pre) : p === pre))
  )
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
  // No manifest at the merge-base (first introduction): any valid version passes.
  const base = parseSemver(baseVersion)
  if (baseVersion == null) {
    return { ok: true, bump_required: true, content_paths: content, reason: 'manifest introduced in this change' }
  }
  if (!base) {
    return {
      ok: false, bump_required: true, content_paths: content,
      reason: `merge-base ${MANIFEST} version ${JSON.stringify(baseVersion)} is not plain X.Y.Z semver; cannot prove a bump`,
    }
  }
  if (!semverGreater(head, base)) {
    return {
      ok: false, bump_required: true, content_paths: content,
      reason: `plugin content changed but version did not advance (${baseVersion} -> ${headVersion}); claude plugin update will no-op (#644)`,
    }
  }
  return { ok: true, bump_required: true, content_paths: content, reason: `version advanced ${baseVersion} -> ${headVersion}` }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function main() {
  const argv = process.argv.slice(2)
  const baseRefIdx = argv.indexOf('--base-ref')
  const baseRef = baseRefIdx !== -1 ? argv[baseRefIdx + 1] : 'origin/main'

  let mergeBase
  try {
    mergeBase = git(['merge-base', 'HEAD', baseRef])
  } catch (err) {
    // Fail closed: shallow clone or missing ref means the gate cannot run.
    console.log(JSON.stringify({ status: 'error', ok: false, reason: `merge-base with ${baseRef} failed: ${err.message}` }))
    process.exit(1)
  }

  const changedPaths = git(['diff', '--name-only', mergeBase, 'HEAD']).split('\n').filter(Boolean)

  let baseVersion = null
  try {
    baseVersion = JSON.parse(git(['show', `${mergeBase}:${MANIFEST}`])).version
  } catch {
    baseVersion = null // manifest absent at merge-base
  }
  let headVersion
  try {
    headVersion = JSON.parse(git(['show', `HEAD:${MANIFEST}`])).version
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', ok: false, reason: `cannot read HEAD ${MANIFEST}: ${err.message}` }))
    process.exit(1)
  }

  const verdict = decideBump({ changedPaths, baseVersion, headVersion })
  console.log(JSON.stringify({
    status: 'ok',
    merge_base: mergeBase,
    base_version: baseVersion,
    head_version: headVersion,
    ...verdict,
  }, null, 2))
  process.exit(verdict.ok ? 0 : 1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
