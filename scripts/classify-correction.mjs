#!/usr/bin/env node
/**
 * classify-correction.mjs — Record a user correction for the LLM classifier.
 *
 * Writes a line to <project_root>/.episodic-memory/classifier-overrides.jsonl
 * that Tier 0/2 will prefer over hardcoded labels and global cache for the
 * same command tuple.
 *
 * Usage:
 *   node classify-correction.mjs \
 *     --project-root <abs-path> \
 *     --caller-cwd  <abs-path> \
 *     --command     "<command text>" \
 *     --label       <read_only|nonsrc_write|shared_write|marker_write|push_or_pr_create|unsafe_complex> \
 *     [--reason     "<note>"] \
 *     [--allow-non-git]
 *
 * Recognized by command-classifier.sh as a `helper_write` invocation when the
 * argv shape matches `node <abs-path>/classify-correction.mjs --project-root ...`.
 * The helper rejects --project-root that does not match
 * resolveRepoRoot(process.cwd()) so a misrouted invocation cannot write into
 * a foreign repo's store.
 *
 * --allow-non-git: opt into non-git projects. The .episodic-memory/ directory
 * must already exist under --project-root (created by the user) and serves as
 * the explicit opt-in sentinel. The same hardened symlink/realpath validation
 * applies to both modes.
 *
 * PR #336: tuple primitives migrated to scripts/lib/classifier-cache.mjs.
 * Note this changes normalizeCommand from whitespace-only (the pre-#336 form)
 * to `#`-strip-then-whitespace. Pre-existing entries with `#` in the command
 * become unreachable; re-correction is one-shot. See the shared module's
 * top-of-file comment.
 */

import fs from 'fs'
import path from 'path'
import {
  LABELS,
  realpathOrSame,
  buildTuple,
  cacheKey,
  hasEnvPrefix,
  validateStoreDir,
  appendLine
} from './lib/classifier-cache.mjs'
import { resolveRepoRoot } from './lib/local-dir.mjs'

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function die(code, msg) {
  process.stderr.write(`classify-correction: ${msg}\n`)
  process.exit(code)
}

function main() {
  const argv = process.argv.slice(2)
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = flag(argv, '--command')
  const label = flag(argv, '--label')
  const reason = flag(argv, '--reason') || ''
  const allowNonGit = argv.includes('--allow-non-git')

  if (!projectRootArg) die(2, '--project-root required')
  if (!callerCwd) die(2, '--caller-cwd required')
  if (command === undefined) die(2, '--command required')
  if (!label) die(2, '--label required')
  if (!LABELS.has(label)) die(2, `invalid --label "${label}" (allowed: ${[...LABELS].join(', ')})`)

  // F-3 (negative-scenario-reviewer ACCEPT-with-FU): symmetric env-prefix
  // refusal on the WRITE side. The lookup + persist helpers already refuse
  // env-prefix-shaped commands (PR #271 / #272 attack class — env-prefix
  // is a cross-session vector). Without this check, a user could stage a
  // correction like `FOO=bar node scripts/foo.mjs` that would never be
  // served (lookup refuses env-prefix shape) — confusing dead entry.
  // Refusal at write time is the symmetric guard.
  if (hasEnvPrefix(command)) {
    die(2, `--command "${command}" has env-prefix shape (FOO=bar ...); refusing to stage override for env-prefix-wrapped commands (cross-session attack class). Remove the leading env assignment and re-run.`)
  }

  const projectRootCanon = realpathOrSame(path.resolve(projectRootArg))
  const resolved = realpathOrSame(resolveRepoRoot(process.cwd()))
  if (resolved !== projectRootCanon) {
    die(2, `--project-root (${projectRootCanon}) != resolveRepoRoot(process.cwd()) (${resolved}); refusing cross-repo write`)
  }

  // Mode-specific sentinel + store-dir validation (Gate 2).
  // Git mode: require .git AND allow first-time creation of .episodic-memory.
  // Non-git mode: skip .git check, require user-created .episodic-memory.
  let validated
  if (allowNonGit) {
    validated = validateStoreDir(projectRootCanon, { allowCreate: false }, die)
  } else {
    try {
      fs.statSync(path.join(projectRootCanon, '.git'))
    } catch {
      die(2, `--project-root (${projectRootCanon}) is not a git repository (.git not found); classifier overrides require a git context, or pass --allow-non-git to opt into .episodic-memory/-scoped overrides`)
    }
    validated = validateStoreDir(projectRootCanon, { allowCreate: true }, die)
  }

  const tuple = buildTuple({ command, projectRoot: projectRootCanon, callerCwd })
  const key = cacheKey(tuple)
  const entry = {
    schema: 1,
    cache_key: key,
    tuple,
    label,
    reason: String(reason).slice(0, 500),
    created_at: new Date().toISOString(),
    created_by: 'user-correction'
  }
  if (allowNonGit) entry.allow_non_git = true

  // Test seam: deterministic pause between Gate-2 validation and the append-time
  // TOCTOU recheck, so tests can plant a symlink/swap state into the window.
  // Capped at 5s to avoid hanging CI on a misconfigured env var.
  const pauseMs = Math.min(5000, Math.max(0, parseInt(process.env._CC_TEST_PAUSE_BEFORE_APPEND_MS || '0', 10) || 0))
  if (pauseMs > 0) {
    const end = Date.now() + pauseMs
    while (Date.now() < end) { /* busy-wait keeps the test seam synchronous */ }
  }

  // Gate 3 — TOCTOU recheck immediately before append (both modes).
  // Dir must already exist by this point; if it disappeared or was swapped
  // for a symlink, this catches it. Re-running validateStoreDir refreshes
  // parentIno/parentDev so appendLine's reValidateParent uses the right
  // expected identity.
  validated = validateStoreDir(projectRootCanon, { allowCreate: false }, die)
  const target = appendLine(validated, entry, die)
  process.stdout.write(JSON.stringify({
    status: 'ok',
    file: target,
    cache_key: key,
    label,
    project_root_used: projectRootCanon
  }) + '\n')
}

try { main() } catch (err) {
  die(1, err?.message || String(err))
}
