#!/usr/bin/env node
/**
 * llm-classifier-dispatch.mjs — Tier 2/3 orchestrator for command-classifier.sh.
 *
 * Flow:
 *   1. Build cache tuple (symmetric across tiers; resolves script args against
 *      caller_cwd; includes script_digest when exe is under project_root).
 *   2. Look up project-local override (<project>/.episodic-memory/
 *      classifier-overrides.jsonl). Project overrides win.
 *   3. Look up global cache (~/.episodic-memory/classifier-cache.json).
 *   4. On miss, dispatch Tier 3 (scripts/llm-classify.mjs) as subprocess.
 *      Validates project_root_used echo before consuming label.
 *   5. On Tier 3 success above confidence_threshold, record to global cache
 *      under lock + temp+rename.
 *
 * Output (stdout JSON):
 *   { label, source: "override"|"cache"|"tier3"|"tier3-fallback",
 *     confidence, reason, project_root_used, cache_key, model_used,
 *     latency_ms, fail_mode_applied }
 *
 * label may be null when Tier 3 fell back under fail_mode=heuristic; caller
 * (shell hook) MUST then use its own Tier 1 heuristic label.
 *
 * Exit codes:
 *   0  classification emitted (caller still verifies project_root_used)
 *   2  binding/arg error (caller MUST NOT consume label)
 *   3  Tier 3 dispatch failed (label may still be set under fail_mode=block)
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { loadConfig } from './classifier-config-loader.mjs'
import {
  realpathOrSame,
  hasEnvPrefix,
  buildTuple,
  cacheKey,
  checkOverridableShape,
  lookupProjectOverride
} from './lib/classifier-cache.mjs'

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function die(code, msg) {
  process.stderr.write(`llm-classifier-dispatch: ${msg}\n`)
  process.exit(code)
}

function readJsonOrEmpty(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

function lookupGlobalCache(homeDir, key) {
  const file = path.join(homeDir, '.episodic-memory', 'classifier-cache.json')
  const obj = readJsonOrEmpty(file)
  return obj && obj[key] ? obj[key] : null
}

// codex PR #326 R3 BLOCKER: dropped the lock helper entirely. Stale-lock
// identity binding can't be made fully atomic in pure POSIX, and each
// previous patch shifted the race rather than closing it (R1: mkdir+write
// race; R2: read+unlink race; R3: rename-without-inode-check race).
//
// Per the same-class stop rule (feedback_handoff_complete_bug_class.md),
// we change the enforcement boundary instead. The cache is read-modify-
// write with atomic temp+rename; under contention this is last-writer-wins
// — some entries may be lost in a race, but the file is always a valid
// JSON object (rename is atomic), so reads never see torn writes. A lost
// cache entry just triggers one extra Tier 3 dispatch the next time the
// same command is classified; cache-miss is the safe fallback.

function recordGlobalCache(homeDir, key, entry) {
  const dir = path.join(homeDir, '.episodic-memory')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'classifier-cache.json')
  // Lockless read-modify-write: read current map, merge our entry, write to
  // a uniquely-named temp file, atomic-rename over the target. rename() is
  // atomic, so readers never see a torn write. Under concurrent writers the
  // final state reflects the LAST rename to land — earlier writers' entries
  // for OTHER keys may be lost. For a classifier cache that's acceptable:
  // a lost entry triggers one extra Tier 3 dispatch on the next hit.
  const obj = readJsonOrEmpty(file)
  obj[key] = entry
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

function dispatchTier3({ projectRoot, callerCwd, command, cfgTimeout }) {
  // Subprocess cwd is forced to projectRoot — matches the shell wrapper's
  // `(cd "$REPO_ROOT" && ...)` invariant; we replicate it here so callers
  // that invoke this dispatcher with a different cwd still bind correctly.
  // LLM_CLASSIFY_OVERRIDE_PATH env seam (test-only): allows tests to inject
  // a synthetic classifier subprocess to exercise dispatcher post-processing
  // (e.g. project_root_used echo verification, synthesized-response cache
  // rejection) without standing up a full Anthropic API mock.
  const scriptPath = process.env.LLM_CLASSIFY_OVERRIDE_PATH
    || path.join(path.dirname(new URL(import.meta.url).pathname), 'llm-classify.mjs')
  const res = spawnSync(process.execPath, [
    scriptPath,
    '--project-root', projectRoot,
    '--caller-cwd', callerCwd,
    '--command', command
  ], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: cfgTimeout + 2000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (res.error) {
    return { _err: res.error.message, _exit: -1, _stderr: '' }
  }
  let parsed = null
  try { parsed = JSON.parse((res.stdout || '').trim().split('\n').pop() || 'null') } catch {}
  return { _exit: res.status ?? -1, _stderr: res.stderr || '', _parsed: parsed }
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

  // env-prefix escape: do not cache, do not dispatch Tier 3 — signal caller
  // to fall back to its existing heuristic.
  if (hasEnvPrefix(command)) {
    emit({
      label: null,
      source: 'env-prefix-rejected',
      reason: 'env_prefix_wrapper_not_cached',
      project_root_used: projectRoot,
      cache_key: null
    })
    process.exit(0)
  }

  const tuple = buildTuple({ command, projectRoot, callerCwd })
  const key = cacheKey(tuple)

  // Tier 2a: project-local override (highest priority). PR #336:
  //   1. The shared module's lookup applies validateStoreDir +
  //      reValidateParent for symlink and parent-swap TOCTOU defense; pass
  //      `die` so hard validation failures route through this dispatcher's
  //      stderr prefix + exit 2.
  //   2. checkOverridableShape gates the lookup so flag-prefixed interpreter
  //      forms (e.g. `node --require ./noop.js scripts/em-store.mjs`) cannot
  //      use overrides to hide a real mutator after a --require value.
  //      Codex REJECT on file 4/8 R1 caught this bypass; mitigation is
  //      centralized at the shared module so this dispatcher also benefits.
  const shape = checkOverridableShape(command)
  const override = shape.overridable ? lookupProjectOverride(projectRoot, key, die) : null
  if (override) {
    emit({
      label: override.label,
      source: 'override',
      confidence: 1,
      reason: override.reason || 'project_override',
      project_root_used: projectRoot,
      cache_key: key,
      model_used: null,
      latency_ms: 0,
      fail_mode_applied: null
    })
    process.exit(0)
  }

  // Tier 2b: global cache. F3-fix: reject entries whose embedded
  // {project_root_canonical, cache_key} don't match the lookup arguments —
  // defends against cache poisoning via FS-write that plants entries keyed
  // under a different project (the keys can collide if the attacker can
  // predict your tuple).
  const cfg = loadConfig({ projectRoot })
  const cached = lookupGlobalCache(os.homedir(), key)
  if (cached) {
    if (cached._project_root_canonical === projectRoot && cached._cache_key === key) {
      emit({
        ...cached,
        source: 'cache',
        project_root_used: projectRoot,
        cache_key: key
      })
      process.exit(0)
    } else {
      process.stderr.write(
        `llm-classifier-dispatch: cache entry rejected — tamper indicator ` +
        `(claimed root="${cached._project_root_canonical}" key="${cached._cache_key}", ` +
        `lookup root="${projectRoot}" key="${key}")\n`
      )
      // Fall through to Tier 3 — do NOT serve a suspect entry.
    }
  }

  // Tier 3: dispatch.
  if (!cfg.enabled) {
    emit({
      label: null,
      source: 'tier3-disabled',
      reason: 'tier3_disabled',
      project_root_used: projectRoot,
      cache_key: key,
      model_used: cfg.model,
      latency_ms: 0,
      fail_mode_applied: null
    })
    process.exit(0)
  }

  const t0 = Date.now()
  const r = dispatchTier3({ projectRoot, callerCwd, command, cfgTimeout: cfg.timeout_ms })
  const latency = Date.now() - t0
  const parsed = r._parsed

  if (!parsed || typeof parsed !== 'object') {
    emit({
      label: cfg.fail_mode === 'block' ? 'unsafe_complex' : null,
      source: 'tier3-fallback',
      confidence: cfg.fail_mode === 'block' ? 1 : 0,
      reason: `tier3_dispatch_failed exit=${r._exit} stderr=${(r._stderr || '').slice(0, 200)}`,
      project_root_used: projectRoot,
      cache_key: key,
      model_used: cfg.model,
      latency_ms: latency,
      fail_mode_applied: cfg.fail_mode
    })
    process.exit(3)
  }

  // FU-4: validate project_root_used echo before consuming label.
  if (parsed.project_root_used !== projectRoot) {
    emit({
      label: cfg.fail_mode === 'block' ? 'unsafe_complex' : null,
      source: 'tier3-fallback',
      confidence: 0,
      reason: `project_root_used mismatch: got "${parsed.project_root_used}" expected "${projectRoot}"`,
      project_root_used: projectRoot,
      cache_key: key,
      model_used: cfg.model,
      latency_ms: latency,
      fail_mode_applied: cfg.fail_mode
    })
    process.exit(3)
  }

  if (!parsed.label) {
    // Tier 3 returned no-label (enabled=false / fail_mode=heuristic on error inside subprocess).
    emit({
      label: null,
      source: 'tier3-fallback',
      confidence: 0,
      reason: parsed.reason || 'tier3_no_label',
      project_root_used: projectRoot,
      cache_key: key,
      model_used: parsed.model_used || cfg.model,
      latency_ms: latency,
      fail_mode_applied: parsed.fail_mode_applied || cfg.fail_mode
    })
    process.exit(parsed.tier3_skipped ? 0 : 3)
  }

  // Confidence gate.
  if ((parsed.confidence || 0) < cfg.confidence_threshold) {
    emit({
      label: cfg.fail_mode === 'block' ? 'unsafe_complex' : null,
      source: 'tier3-low-confidence',
      confidence: parsed.confidence || 0,
      reason: `confidence ${parsed.confidence} < threshold ${cfg.confidence_threshold}`,
      project_root_used: projectRoot,
      cache_key: key,
      model_used: parsed.model_used,
      latency_ms: latency,
      fail_mode_applied: cfg.fail_mode
    })
    process.exit(0)
  }

  // F2-fix: do NOT cache synthesized fail_mode=block responses. A non-zero
  // subprocess exit OR a non-null fail_mode_applied means the subprocess
  // could not reach the LLM and synthesized a defensive label. Caching
  // would freeze that defensive label until manual eviction, even after
  // the upstream failure heals.
  if (r._exit !== 0 || parsed.fail_mode_applied) {
    emit({
      label: parsed.label,
      source: 'tier3-fallback',
      confidence: parsed.confidence,
      reason: `synthesized_under_fail_mode=${parsed.fail_mode_applied || 'unknown'} exit=${r._exit}; not cached`,
      project_root_used: projectRoot,
      cache_key: key,
      model_used: parsed.model_used,
      latency_ms: latency,
      fail_mode_applied: parsed.fail_mode_applied || cfg.fail_mode
    })
    process.exit(3)
  }

  // Success: record cache + emit. F3-fix: cache entry embeds
  // project_root_canonical + cache_key so the read-side can detect tampering.
  const entry = {
    label: parsed.label,
    confidence: parsed.confidence,
    reason: parsed.reason,
    model_used: parsed.model_used,
    latency_ms: latency,
    fail_mode_applied: null,
    recorded_at: new Date().toISOString(),
    _project_root_canonical: projectRoot,
    _cache_key: key
  }
  try {
    recordGlobalCache(os.homedir(), key, entry)
  } catch (err) {
    // Cache write failure is non-fatal — label is still good.
    process.stderr.write(`llm-classifier-dispatch: cache write failed: ${err.message}\n`)
  }
  emit({
    ...entry,
    source: 'tier3',
    project_root_used: projectRoot,
    cache_key: key
  })
  process.exit(0)
}

try { main() } catch (err) {
  die(2, err?.message || String(err))
}
