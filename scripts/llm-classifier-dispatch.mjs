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
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { loadConfig } from './classifier-config-loader.mjs'

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function die(code, msg) {
  process.stderr.write(`llm-classifier-dispatch: ${msg}\n`)
  process.exit(code)
}

function realpathOrSame(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl'])

function resolveExeAgainstCwd(command, callerCwd) {
  const toks = command.trim().split(/\s+/)
  for (let i = 0; i < toks.length; i++) {
    if (INTERPRETERS.has(path.basename(toks[i]))) {
      const script = toks[i + 1]
      if (script && !script.startsWith('-')) {
        return path.resolve(callerCwd, script)
      }
      return null
    }
  }
  if (toks[0]) {
    if (toks[0].startsWith('/') || toks[0].startsWith('./') || toks[0].startsWith('../')) {
      return path.resolve(callerCwd, toks[0])
    }
    return toks[0]
  }
  return null
}

function sha256File(p) {
  try {
    const buf = fs.readFileSync(p)
    return crypto.createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

function normalizeCommand(raw) {
  return String(raw).replace(/#.*$/, '').replace(/\s+/g, ' ').trim()
}

// R1-F2 (env-prefix wrapper): reject `FOO=bar python3 ...` shape — caller
// should route those to default classification, not Tier 2/3.
function hasEnvPrefix(command) {
  const first = command.trim().split(/\s+/)[0] || ''
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)
}

function buildTuple({ command, projectRoot, callerCwd }) {
  const cwdCanon = realpathOrSame(callerCwd)
  const callerCwdRelOrAbs = isUnder(cwdCanon, projectRoot)
    ? (path.relative(projectRoot, cwdCanon) || '.')
    : cwdCanon
  const exeResolved = resolveExeAgainstCwd(command, cwdCanon)
  let exeAbs = null
  let digest = null
  if (exeResolved && exeResolved.startsWith('/')) {
    try {
      if (fs.statSync(exeResolved).isFile()) {
        exeAbs = realpathOrSame(exeResolved)
        if (isUnder(exeAbs, projectRoot)) {
          digest = sha256File(exeAbs)
        }
      }
    } catch {}
  }
  return {
    project_root_canonical: projectRoot,
    caller_cwd_or_rel: callerCwdRelOrAbs,
    normalized_command: normalizeCommand(command),
    executable_resolved: exeAbs || exeResolved,
    script_digest: digest
  }
}

function canonicalTupleString(tuple) {
  // Sort keys lexicographically; nested values are primitives so this suffices.
  const sorted = {}
  for (const k of Object.keys(tuple).sort()) sorted[k] = tuple[k]
  return JSON.stringify(sorted)
}

function cacheKey(tuple) {
  return crypto.createHash('sha256').update(canonicalTupleString(tuple)).digest('hex')
}

function readJsonOrEmpty(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return {} }
}

function readJsonlOrEmpty(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

function lookupProjectOverride(projectRoot, key) {
  const file = path.join(projectRoot, '.episodic-memory', 'classifier-overrides.jsonl')
  const rows = readJsonlOrEmpty(file)
  // Last write wins per key.
  let hit = null
  for (const r of rows) {
    if (r && r.cache_key === key) hit = r
  }
  return hit
}

function lookupGlobalCache(homeDir, key) {
  const file = path.join(homeDir, '.episodic-memory', 'classifier-cache.json')
  const obj = readJsonOrEmpty(file)
  return obj && obj[key] ? obj[key] : null
}

// F1-fix (round 2): atomic file-create lock to close the TOCTOU race
// codex caught in round 1 — `mkdir(lock_dir) + writeFile(pid)` was a
// two-step operation; a racing process could see EEXIST, read no pid yet,
// and "reclaim" a live lock. `open(path, 'wx')` is O_CREAT|O_EXCL|O_WRONLY
// in one syscall, so pid creation and content write are inseparable.
//
// Stale detection: on EEXIST, read pid → check `kill(pid, 0)` ESRCH → reclaim.
// Pidless / unparseable + age > 1s → reclaim (the only way to land here with
// atomic create is a crashed writer between open and write, very rare).
function acquireLock(lockPath, timeoutMs = 5000) {
  const start = Date.now()
  while (true) {
    let fd
    try {
      fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return
    } catch (err) {
      if (fd) { try { fs.closeSync(fd) } catch {} }
      if (err.code !== 'EEXIST') throw err
      let staleReclaimed = false
      try {
        const pidStr = fs.readFileSync(lockPath, 'utf8').trim()
        const pid = parseInt(pidStr, 10)
        if (!Number.isFinite(pid) || pid <= 0) {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs
          if (age > 1000) {
            fs.unlinkSync(lockPath)
            staleReclaimed = true
          }
        } else {
          try { process.kill(pid, 0) } catch (e) {
            if (e.code === 'ESRCH') {
              fs.unlinkSync(lockPath)
              staleReclaimed = true
            }
          }
        }
      } catch (statErr) {
        if (statErr.code === 'ENOENT') {
          staleReclaimed = true  // racing release; try again immediately
        }
      }
      if (staleReclaimed) continue
      if (Date.now() - start > timeoutMs) throw new Error(`lock timeout: ${lockPath}`)
      const end = Date.now() + 25
      while (Date.now() < end) { /* spin */ }
    }
  }
}

function releaseLock(p) { try { fs.unlinkSync(p) } catch {} }

function recordGlobalCache(homeDir, key, entry) {
  const dir = path.join(homeDir, '.episodic-memory')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'classifier-cache.json')
  const lock = path.join(dir, '.classifier-cache.lock')
  acquireLock(lock)
  try {
    const obj = readJsonOrEmpty(file)
    obj[key] = entry
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, file)
  } finally {
    releaseLock(lock)
  }
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

  // Tier 2a: project-local override (highest priority).
  const override = lookupProjectOverride(projectRoot, key)
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
