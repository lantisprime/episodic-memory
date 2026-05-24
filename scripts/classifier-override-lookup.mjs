#!/usr/bin/env node
/**
 * classifier-override-lookup.mjs — Tier 0 override read helper.
 *
 * Called by hooks/lib/command-classifier.sh BEFORE the readonly-allowlist /
 * interpreter case-arms. Returns a project-local override when one exists and
 * the command is in the overridable-shape set; otherwise exits non-zero and
 * the shell falls through to existing Tier 1/2/3 flow.
 *
 * Usage:
 *   node classifier-override-lookup.mjs \
 *     --project-root <abs-path> \
 *     --caller-cwd  <abs-path> \
 *     --command     "<command text>"
 *
 * Output (stdout JSON on hit):
 *   { status: "hit", label, source: "project-override", confidence: 1,
 *     project_root_used, cache_key, reason }
 *
 * Output (stdout JSON on no-hit; exit 1):
 *   { status: "miss"|"not-overridable", reason, project_root_used }
 *
 * Output (stderr, exit 2): hard validation failure (caller treats as no-hit).
 *
 * # Carve-out semantics — INVERTED ALLOWLIST + STRICT FLAG-FORM REFUSAL
 *
 * Tier 0 placement (line 1448 in command-classifier.sh) sits AFTER all
 * structural denies (shell keywords, wrappers, bash -c / eval / source /
 * exec, marker handlers, git, gh) and BEFORE the read-only allowlist +
 * interpreter case-arm. By construction, Tier 0 cannot demote safety-
 * critical fail-closed lanes.
 *
 * The carve-out lists + shape check are in scripts/lib/classifier-cache.mjs
 * (`checkOverridableShape`) so the dispatcher (Tier 2) applies the same
 * gate. Codex REJECT on R1 of this file caught a bypass via
 * `node --require ./noop.js scripts/em-store.mjs ...` — a naive walker that
 * skipped flags found `noop.js` as the "script" and overrode em-store.mjs's
 * mutator classification. STRICT FIX: any flag at toks[1] disqualifies.
 *
 * # env-prefix defense (defense in depth)
 *
 * Shell wrapper at line 1448 gates Tier 0 invocation behind
 * `[ $env_prefix_count -eq 0 ]`. This helper applies the same check
 * independently via the shared module's `hasEnvPrefix`.
 *
 * # Cross-repo refusal
 *
 * Helper verifies `realpath(resolveRepoRoot(process.cwd())) === --project-root`.
 * Shell wrapper invokes via `(cd "$repo_root" && node helper ...)`.
 */

import path from 'path'
import {
  realpathOrSame,
  buildTuple,
  cacheKey,
  hasEnvPrefix,
  checkOverridableShape,
  lookupProjectOverride,
  LABELS
} from './lib/classifier-cache.mjs'
import { resolveRepoRoot } from './lib/local-dir.mjs'

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function die(code, msg) {
  process.stderr.write(`classifier-override-lookup: ${msg}\n`)
  process.exit(code)
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function main() {
  const argv = process.argv.slice(2)
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = flag(argv, '--command')

  if (!projectRootArg) die(2, '--project-root required')
  if (!callerCwd) die(2, '--caller-cwd required')
  if (command === undefined) die(2, '--command required')

  const projectRoot = realpathOrSame(path.resolve(projectRootArg))

  // Cross-repo defense.
  const resolvedFromCwd = realpathOrSame(resolveRepoRoot(process.cwd()))
  if (resolvedFromCwd !== projectRoot) {
    die(2, `--project-root (${projectRoot}) != resolveRepoRoot(process.cwd()) (${resolvedFromCwd}); refusing cross-repo lookup`)
  }

  // env-prefix defense in depth.
  if (hasEnvPrefix(command)) {
    emit({
      status: 'not-overridable',
      reason: 'env-prefix-rejected',
      project_root_used: projectRoot
    })
    process.exit(1)
  }

  // Carve-out check (shared with the dispatcher's Tier 2 lookup path).
  const shape = checkOverridableShape(command)
  if (!shape.overridable) {
    emit({
      status: 'not-overridable',
      reason: shape.reason,
      project_root_used: projectRoot
    })
    process.exit(1)
  }

  // Build tuple + look up. lookupProjectOverride applies symlink defense +
  // post-open parent-TOCTOU re-validation per shared module.
  const tuple = buildTuple({ command, projectRoot, callerCwd })
  const key = cacheKey(tuple)
  const hit = lookupProjectOverride(projectRoot, key, die)

  if (!hit) {
    emit({
      status: 'miss',
      reason: 'no-override-matches',
      project_root_used: projectRoot,
      cache_key: key
    })
    process.exit(1)
  }

  // Defense in depth: hand-edited override file with invalid label →
  // treat as not-overridable, let shell fall through to Tier 1.
  if (!LABELS.has(hit.label)) {
    emit({
      status: 'not-overridable',
      reason: `invalid-override-label:${hit.label}`,
      project_root_used: projectRoot,
      cache_key: key
    })
    process.exit(1)
  }

  emit({
    status: 'hit',
    label: hit.label,
    source: 'project-override',
    confidence: 1,
    project_root_used: projectRoot,
    cache_key: key,
    reason: hit.reason || 'project_override'
  })
  process.exit(0)
}

try { main() } catch (err) {
  die(1, err?.message || String(err))
}
