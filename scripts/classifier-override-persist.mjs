#!/usr/bin/env node
/**
 * classifier-override-persist.mjs — Auto-persist an LLM classification as
 * a project-local override so subsequent invocations of the same command
 * shape hit Tier 0 without re-running the LLM.
 *
 * Invoked fire-and-forget by hooks/lib/llm-classifier.sh after a marker-cache
 * hit OR a legacy-dispatcher hit (per PR #336 plan v4-final). Silent on
 * success — no stdout output that could pollute the hook's classification
 * stream. Hard validation failures go to stderr + exit 2.
 *
 * Usage:
 *   node classifier-override-persist.mjs \
 *     --project-root <abs-path> \
 *     --caller-cwd  <abs-path> \
 *     --command     "<command text>" \
 *     --label       <read_only|shared_write|marker_write|push_or_pr_create|unsafe_complex> \
 *     --confidence  <0..1> \
 *     --source-tag  <llm-marker-autopersist|llm-legacy-autopersist>
 *     [--reason     "<note>"]
 *
 * # Persist policy (in order)
 *
 *   1. Cross-repo refusal: realpath(resolveRepoRoot(process.cwd())) ===
 *      --project-root. Shell wrapper invokes via `(cd "$repo_root" && ...)`.
 *
 *   2. env-prefix refusal: `hasEnvPrefix(command)` → silent skip (the LLM
 *      decision for an env-prefix-wrapped command is itself suspect; never
 *      persist).
 *
 *   3. Overridable-shape refusal: `checkOverridableShape(command)` — same
 *      gate as classifier-override-lookup.mjs and the dispatcher. If the
 *      command shape isn't overridable at READ time, persisting it pollutes
 *      the JSONL with entries lookup will refuse anyway. Silent skip.
 *
 *   4. Label allowlist: must be in shared LABELS Set.
 *
 *   5. Confidence threshold: must be ≥ cfg.confidence_threshold (default 0.7
 *      from classifier-config.json). Low-confidence LLM verdicts are not
 *      worth caching as overrides; let the next invocation re-classify.
 *
 *   6. Skip if user-correction exists for the same cache_key. A user-
 *      authored entry must NEVER be silently shadowed by an LLM-autopersist
 *      entry. (Last-write-wins means an unconditional append would let the
 *      auto-persist win — wrong outcome.)
 *
 *   7. Skip if recent auto-persist exists for the same cache_key (dedup —
 *      otherwise the JSONL grows unboundedly with one auto-persist entry
 *      per Bash invocation of the same command).
 *
 *   8. Append via shared `appendLine` (O_NOFOLLOW + O_APPEND + PIPE_BUF
 *      atomicity guard + post-open parent-TOCTOU re-validation).
 *
 * # Silent-on-success contract
 *
 * The shell wrapper calls us as `(cd "$repo_root" && node helper ... >/dev/null 2>&1 &)`.
 * But even with stdout/stderr redirected, defense in depth: helper writes
 * NOTHING to stdout on success. Hard failures go to stderr + exit 2; the
 * `>/dev/null 2>&1` swallows even those for the fire-and-forget caller.
 */

import fs from 'fs'
import path from 'path'
import {
  LABELS,
  realpathOrSame,
  buildTuple,
  cacheKey,
  hasEnvPrefix,
  checkOverridableShape,
  validateStoreDir,
  appendLine,
  readOverridesHardened
} from './lib/classifier-cache.mjs'
import { resolveRepoRoot } from './lib/local-dir.mjs'
import { loadConfig } from './classifier-config-loader.mjs'

const VALID_SOURCE_TAGS = new Set(['llm-marker-autopersist', 'llm-legacy-autopersist'])

function flag(argv, name) {
  const i = argv.indexOf(name)
  if (i === -1 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

function die(code, msg) {
  process.stderr.write(`classifier-override-persist: ${msg}\n`)
  process.exit(code)
}

function silentSkip(/* reason */) {
  // Silent on success/skip — fire-and-forget caller does not need to know.
  // The leading underscore-parameter name documents intent; reason is for
  // future telemetry if we ever wire one up (currently no log surface).
  process.exit(0)
}

function main() {
  const argv = process.argv.slice(2)
  const projectRootArg = flag(argv, '--project-root')
  const callerCwd = flag(argv, '--caller-cwd')
  const command = flag(argv, '--command')
  const label = flag(argv, '--label')
  const confidenceStr = flag(argv, '--confidence')
  const sourceTag = flag(argv, '--source-tag')
  const reasonRaw = flag(argv, '--reason') || ''

  if (!projectRootArg) die(2, '--project-root required')
  if (!callerCwd) die(2, '--caller-cwd required')
  if (command === undefined) die(2, '--command required')
  if (!label) die(2, '--label required')
  if (!LABELS.has(label)) die(2, `invalid --label "${label}"`)
  if (!sourceTag) die(2, '--source-tag required')
  if (!VALID_SOURCE_TAGS.has(sourceTag)) die(2, `invalid --source-tag "${sourceTag}"`)
  const confidence = Number(confidenceStr)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    die(2, `--confidence must be a number in [0,1]; got "${confidenceStr}"`)
  }

  const projectRoot = realpathOrSame(path.resolve(projectRootArg))

  // (1) Cross-repo refusal.
  const resolvedFromCwd = realpathOrSame(resolveRepoRoot(process.cwd()))
  if (resolvedFromCwd !== projectRoot) {
    die(2, `--project-root (${projectRoot}) != resolveRepoRoot(process.cwd()) (${resolvedFromCwd}); refusing cross-repo persist`)
  }

  // (2) env-prefix refusal — silent skip (don't persist suspect verdicts).
  if (hasEnvPrefix(command)) silentSkip('env-prefix-rejected')

  // (3) Overridable-shape refusal — symmetric with lookup helper.
  const shape = checkOverridableShape(command)
  if (!shape.overridable) silentSkip(`not-overridable:${shape.reason}`)

  // (5) Confidence threshold.
  const cfg = loadConfig({ projectRoot })
  if (confidence < cfg.confidence_threshold) silentSkip(`low-confidence:${confidence}<${cfg.confidence_threshold}`)

  // Tuple + key (symmetric with lookup helper + classify-correction).
  const tuple = buildTuple({ command, projectRoot, callerCwd })
  const key = cacheKey(tuple)

  // Validate store dir (auto-creates if absent — for repos that haven't had
  // a manual classify-correction run yet). Same git-mode-first-creation
  // contract as classify-correction.mjs. For non-git, .episodic-memory must
  // already exist (we DON'T auto-create for non-git auto-persist because
  // that'd silently opt-in a project the user hasn't blessed; non-git
  // projects must run a manual classify-correction first as the explicit
  // opt-in).
  //
  // Codex P1 (file 5/8 R2 HOLD): the `.git` presence check MUST be in a
  // narrow try/catch — wrapping validateStoreDir in the same try/catch lets
  // _fail throws (from hard validation failures: symlinked .em, wrong
  // realpath, EEXIST race losers) be silently swallowed and routed to the
  // non-git branch. Codex repro: git repo with unwritable root → expected
  // hard validation failure → actual silent skip via the broad catch.
  // Fix: narrow the try/catch to ONLY the .git lookup; validateStoreDir
  // calls live OUTSIDE the catch so _fail throws propagate normally.
  let isGitMode = false
  try {
    fs.statSync(path.join(projectRoot, '.git'))
    isGitMode = true
  } catch {
    // Not a git repo (or .git inaccessible). Fall through to non-git path.
    // validateStoreDir's own failures are NOT caught here.
  }
  let validated
  if (isGitMode) {
    validated = validateStoreDir(projectRoot, { allowCreate: true }, die)
  } else {
    const v = validateStoreDir(projectRoot, { allowCreate: false, missingIsMiss: true }, die)
    if (v.missing) silentSkip('non-git-no-store')
    validated = v
  }

  // (6) Skip if user-correction exists for the same key.
  // (7) Skip if recent auto-persist exists for the same key (dedup).
  //
  // Codex P1 (file 5/8 R1 HOLD): the pre-append scan MUST use the same
  // symlink-hardened read as the lookup path. Previously plain
  // fs.readFileSync followed a symlinked classifier-overrides.jsonl leaf
  // and let a foreign file suppress legitimate auto-persist. Fix:
  // readOverridesHardened applies O_NOFOLLOW + post-open parent re-validate.
  const rows = readOverridesHardened(validated)
  for (const r of rows) {
    if (r && r.cache_key === key) {
      if (r.created_by === 'user-correction') silentSkip('user-correction-exists')
      // Any prior entry with same key — could be older auto-persist OR
      // user-correction with same key under different normalization. Skip
      // to avoid duplicate-line bloat. Last-write-wins means the existing
      // entry is the served one; re-persisting wouldn't change behavior.
      silentSkip('entry-exists')
    }
  }

  // (8) Append.
  const entry = {
    schema: 1,
    cache_key: key,
    tuple,
    label,
    confidence,
    reason: String(reasonRaw).slice(0, 500),
    created_at: new Date().toISOString(),
    created_by: sourceTag
  }
  appendLine(validated, entry, die)

  // (9) Post-append rescan + retract. Closes the F-1 race surfaced by the
  // negative-scenario-reviewer on the full diff: a concurrent classify-
  // correction WRITE landing between our step-(6)/(7) scan and our step-(8)
  // append would otherwise let our autopersist entry shadow the user-
  // correction (last-write-wins, and pre-append scan saw no
  // user-correction).
  //
  // Fix: after our append, rescan the JSONL. If a user-correction entry
  // exists for the same cache_key, our autopersist entry MUST retract —
  // user authorship always beats auto-derived telemetry. Retract by
  // rewriting the JSONL with our entry filtered out, via atomic
  // temp+rename. Best-effort under multiple concurrent retracts (last
  // rename wins), but the primary race (user vs single autopersist) is
  // closed deterministically.
  const postRows = readOverridesHardened(validated)
  const userCorrectionExists = postRows.some(r =>
    r && r.cache_key === key && r.created_by === 'user-correction'
  )
  if (userCorrectionExists) {
    // Build the survivor set: every row EXCEPT this autopersist entry.
    // Match by exact cache_key + created_at + created_by (created_at is
    // ms-precision ISO so collision with another autopersist for the same
    // key would require sub-ms timing AND identical Date.now() — vanishing).
    const survivors = postRows.filter(r => !(
      r &&
      r.cache_key === entry.cache_key &&
      r.created_at === entry.created_at &&
      r.created_by === entry.created_by
    ))
    // Atomic rewrite via temp+rename. The temp lives in the same dir so
    // rename(2) is atomic on the same filesystem.
    const target = path.join(validated.storeDir, 'classifier-overrides.jsonl')
    const tmp = path.join(validated.storeDir,
      `.classifier-overrides.jsonl.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
    const body = survivors.map(r => JSON.stringify(r)).join('\n') + (survivors.length ? '\n' : '')
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
    let fd
    try { fd = fs.openSync(tmp, flags, 0o644) }
    catch {
      // Concurrent retract racer won OR symlink leaf — leave the file
      // alone; the survivors set converges last-write-wins. Silent.
      process.exit(0)
    }
    try { fs.writeSync(fd, body) } finally { fs.closeSync(fd) }
    try { fs.renameSync(tmp, target) }
    catch {
      try { fs.unlinkSync(tmp) } catch {}
      // Best-effort: rename failure leaves the appended entry in place;
      // the user-correction still wins because last-write-wins and the
      // user-correction landed AFTER our append. Acceptable.
    }
  }

  // Silent success.
  process.exit(0)
}

try { main() } catch (err) {
  die(1, err?.message || String(err))
}
