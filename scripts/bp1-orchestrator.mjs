#!/usr/bin/env node
/**
 * bp1-orchestrator.mjs — BP-1 orchestrator runtime (RFC-004 §668, §722, M1).
 *
 * Subcommands:
 *   - init-run     (PR-1c-A) — mint + activation gate + key gen + run-started episode.
 *   - finalize-run (PR-1c-B Slice 2 commit 4 — plan v3.3 episode bef4) —
 *     7-step terminal closure: key-load gate, decision-log fence, records
 *     collection, manifest build/sign/emit, disk re-read fence, key shred,
 *     terminal state mark.
 *   - finalize-recover (PR-1c-B Slice 2 commit 4) — 4-state A/B/C/D recovery
 *     for partially-completed finalize-run (post-crash idempotence).
 *
 * init-run details:
 *   - Mints run_id.
 *   - Spawns bp1-flag-check.mjs (cwd: projectRoot) for activation gate.
 *     flag-check ALSO validates verify_key_id fingerprint vs activation map
 *     (RFC §682; bp1-flag-check.mjs:329-334). So a successful flag-check
 *     covers both activation AND key-drift gates.
 *   - Appends run to per-project run-state index.
 *   - Creates run dir, generates 32B run.key (mode 0o600).
 *   - Probes scheduled-tasks capability via M0 stub (PR-1b-A).
 *   - Builds bp1-run-started frontmatter via probe-result projection
 *     (Resolution 3).
 *   - Canonicalizes + HMAC-signs with run.key.
 *   - Writes the episode to `<projectRoot>/.episodic-memory/episodes/`.
 *   - Prints run_id + episode_id as JSON to stdout.
 *
 * Out of scope (later): replay, event-table, snapshot, full state machine,
 * CLI subcommands beyond init-run / finalize-run / finalize-recover.
 *
 * Exit codes:
 *   0 — success.
 *   1 — activation gate refused (init-run only).
 *   2 — bad CLI args / missing --project / not a git repo.
 *   3 — internal error (run_id collision / key gen failure / other).
 *   4 — finalize fence-fail / manifest-invalid (finalize-run / finalize-recover).
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'

import { signCanonical } from './lib/bp1-hmac.mjs'
import { canonicalize, projectProbeResultToFrontmatter } from './lib/bp1-canonicalize.mjs'
import {
  generateRunKey,
  loadRunKey,
  shredRunKey,
  runKeyPath,
  loadVerifyKey,
} from './lib/bp1-keys.mjs'
import { appendRun, markTerminal, getRunState } from './lib/bp1-run-state.mjs'
import { probeScheduledTasksCapability } from './lib/bp1-probe.mjs'
import {
  collectEpisodeRecords,
  buildManifestPayload,
  signManifest,
  verifyManifest,
  verifyOnDiskEqualsManifest,
  assertRunIdShape,
} from './lib/bp1-manifest.mjs'
import { parseBp1Frontmatter } from './lib/bp1-frontmatter.mjs'

const REPO_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const FLAG_CHECK = path.join(REPO_DIR, 'scripts', 'bp1-flag-check.mjs')

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function usage() {
  process.stderr.write(
    'Usage:\n' +
    '  bp1-orchestrator init-run --project <projectRoot> --rfc-id <rfcId>\n' +
    '  bp1-orchestrator finalize-run --project <projectRoot> --run-id <runId>\n' +
    '  bp1-orchestrator finalize-recover --project <projectRoot> --run-id <runId>\n',
  )
}

function parseArgs(argv) {
  const out = { subcommand: null, project: null, rfcId: null, runId: null }
  if (argv.length === 0) return out
  out.subcommand = argv[0]
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--project') out.project = argv[++i]
    else if (arg === '--rfc-id') out.rfcId = argv[++i]
    else if (arg === '--run-id') out.runId = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      usage()
      process.exit(0)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// run_id minting (RFC §598-602)
// ---------------------------------------------------------------------------

function mintRunId(rfcId) {
  const ts = Date.now()
  // rfcId may be "rfc-004", "RFC-004", "rfc-004-bp1-auto-pilot", "TEST", etc.
  // Slug is the sanitized lowercase form (alphanumeric + hyphens only).
  const slug = String(rfcId)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'noslug'
  const rand6 = crypto.randomBytes(3).toString('hex')   // 6 hex chars = 3 bytes
  return `bp1-run-${ts}-${slug}-${rand6}`
}

// ---------------------------------------------------------------------------
// Activation gate (delegate to bp1-flag-check.mjs)
// ---------------------------------------------------------------------------

/**
 * Spawn bp1-flag-check.mjs with cwd: projectRoot (Discipline #20 cwd-binding).
 * flag-check resolves --project arg first, but the cwd binding ensures any
 * cwd-fallback path inside flag-check (or its subprocesses) still routes
 * to the right project.
 *
 * flag-check covers:
 *   - bp1.enabled vs disabled (refused if disabled or missing).
 *   - artifact_version_hash drift (refused if installed runtime artifacts
 *     don't match the activation entry).
 *   - verify_key_id fingerprint mismatch (refused if HOME verify-key drifted
 *     from the activation map's recorded fingerprint).
 *
 * @param {string} projectRoot
 * @param {string} homeDir
 * @returns {{ ok: true, stdout: string } | { ok: false, exitCode: number, stderr: string, stdout: string }}
 */
function runFlagCheck(projectRoot, homeDir) {
  const result = spawnSync(
    'node',
    [FLAG_CHECK, '--project', projectRoot],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, HOME: homeDir },
    },
  )
  if (result.error) {
    return {
      ok: false,
      exitCode: 1,
      stderr: `flag-check spawn error: ${result.error.message}`,
      stdout: '',
    }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      exitCode: result.status ?? 1,
      stderr: result.stderr || '',
      stdout: result.stdout || '',
    }
  }
  return { ok: true, stdout: result.stdout || '' }
}

// ---------------------------------------------------------------------------
// Episode file writing
// ---------------------------------------------------------------------------

function episodeId(runId, suffix = 'run-started') {
  // Episode IDs are kept human-readable + run-prefixed for forensic walks.
  // Pattern: <run_id>-<suffix>-<rand4>
  const rand4 = crypto.randomBytes(2).toString('hex')
  return `${runId}-${suffix}-${rand4}`
}

function buildRunStartedBody(runId, projectRoot, probeResult, episodeIdValue) {
  return [
    `# bp1-run-started — ${runId}`,
    '',
    `Run \`${runId}\` started at ${new Date().toISOString()} for project \`${projectRoot}\`.`,
    '',
    `**Scheduled-tasks capability:** \`${probeResult.capability}\`  `,
    `**Probe reason:** \`${probeResult.reason}\`  `,
    `**Native probe performed:** \`${probeResult.native_probe_performed}\`  `,
    `**T2 fallback:** \`${probeResult.t2_fallback}\`  `,
    '',
    '**Degraded-mode statement (operator runbook):**',
    '',
    '```',
    probeResult.degraded_mode_message,
    '```',
    '',
    `Episode id: \`${episodeIdValue}\`.`,
    '',
  ].join('\n')
}

function buildEpisodeFile(frontmatter, body, runId, episodeIdValue, hmacHex) {
  // Frontmatter ordering: keep canonical-bearing fields first for readability,
  // then non-canonical metadata.
  const fmLines = []
  fmLines.push('---')
  fmLines.push(`id: ${episodeIdValue}`)
  fmLines.push(`run_id: ${runId}`)
  fmLines.push(`type: ${frontmatter.type}`)
  fmLines.push(`state: ${frontmatter.state}`)
  fmLines.push(`parent_episode: ${frontmatter.parent_episode === null ? 'null' : frontmatter.parent_episode}`)
  fmLines.push(`expected_post_episode_id: ${frontmatter.expected_post_episode_id === null ? 'null' : frontmatter.expected_post_episode_id}`)
  fmLines.push(`summary: ${JSON.stringify(frontmatter.summary)}`)
  fmLines.push(`scheduled_tasks_capability: ${JSON.stringify(frontmatter.scheduled_tasks_capability)}`)
  fmLines.push(`probe_reason: ${JSON.stringify(frontmatter.probe_reason)}`)
  fmLines.push(`degraded_mode_statement: ${JSON.stringify(frontmatter.degraded_mode_statement ?? '')}`)
  fmLines.push(`native_probe_performed: ${frontmatter.native_probe_performed}`)
  fmLines.push(`t2_fallback: ${frontmatter.t2_fallback}`)
  fmLines.push(`body_sha256: ${frontmatter.body_sha256}`)
  fmLines.push(`hmac_signature: ${hmacHex}`)
  fmLines.push(`tags: [bp1-run-started, bp1-evidence-snapshot]`)
  fmLines.push(`category: workflow.lifecycle`)
  fmLines.push(`date: ${new Date().toISOString().slice(0, 10)}`)
  fmLines.push(`time: "${new Date().toISOString().slice(11, 16)}"`)
  // JSON-quoted: path.basename can yield names with spaces, which the strict
  // bp1-frontmatter parser rejects as bare values (round-1 codex code-review
  // MAJOR finding 5). The strict parser accepts JSON-quoted strings.
  fmLines.push(`project: ${JSON.stringify(path.basename(frontmatter.project_root || 'unknown'))}`)
  fmLines.push('---')
  fmLines.push('')
  return fmLines.join('\n') + body
}

// ---------------------------------------------------------------------------
// Subcommand: init-run
// ---------------------------------------------------------------------------

function initRun(args) {
  // Step 1: resolve + validate projectRoot.
  if (!args.project) {
    usage()
    return 2
  }
  let projectRoot
  try {
    projectRoot = fs.realpathSync(args.project)
  } catch (_e) {
    process.stderr.write(`error: --project does not exist: ${args.project}\n`)
    return 2
  }
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    process.stderr.write(`error: --project is not a git repository: ${projectRoot}\n`)
    return 2
  }
  if (!args.rfcId) {
    usage()
    return 2
  }

  const homeDir = os.homedir()

  // Step 2: activation gate (also covers verify_key fingerprint drift —
  // bp1-flag-check.mjs:329-334).
  const flagCheck = runFlagCheck(projectRoot, homeDir)
  if (!flagCheck.ok) {
    // Codex code-review B1: forward flag-check's structured JSON (stdout) so
    // operators see the failure code/reason (e.g. bp1-flag-key-drift,
    // bp1-hmac-keyfile-fail, bp1-flag-version-drift). flag-check writes its
    // structured failure to stdout per its output contract; orchestrator
    // re-emits to stderr with a clear gate-refused prefix.
    process.stderr.write('bp1-orchestrator: activation gate refused\n')
    if (flagCheck.stdout) process.stderr.write(flagCheck.stdout)
    if (flagCheck.stderr) process.stderr.write(flagCheck.stderr)
    return 1
  }

  // Step 3: mint run_id.
  const runId = mintRunId(args.rfcId)

  // Step 4: append run to run-state index. Collision → fail closed.
  const append = appendRun(projectRoot, runId, projectRoot)
  if (append.error) {
    if (append.error === 'collision') {
      process.stderr.write(`error: run_id collision (extremely rare; retry): ${runId}\n`)
      return 3
    }
    if (append.error === 'lock-timeout') {
      process.stderr.write('error: run-state index lock timeout (concurrent contention; retry)\n')
      return 3
    }
    process.stderr.write(`error: appendRun failed: ${append.error}\n`)
    return 3
  }

  // Step 5: generate per-run key. Wraps step 4's directory create implicitly
  // via fs.mkdirSync inside generateRunKey.
  let keyResult
  try {
    keyResult = generateRunKey(projectRoot, runId)
  } catch (e) {
    process.stderr.write(`error: generateRunKey failed: ${e.message}\n`)
    return 3
  }
  const { key32B } = keyResult

  // Step 6: probe scheduled-tasks (M0 stub returns fallback).
  const probeResult = probeScheduledTasksCapability()

  // Step 7: build bp1-run-started frontmatter via Resolution 3 projection.
  const projected = projectProbeResultToFrontmatter(probeResult)
  const epId = episodeId(runId)
  const summary = `BP-1 run started: ${runId}`
  const fullFrontmatter = {
    ...projected,
    type: 'state-transition',
    run_id: runId,
    parent_episode: null,
    expected_post_episode_id: null,
    summary,
    project_root: projectRoot,
  }
  const body = buildRunStartedBody(runId, projectRoot, probeResult, epId)

  // Step 8: canonicalize + sign.
  const { canonicalBytes, payload } = canonicalize(fullFrontmatter, body)
  const hmacHex = signCanonical(canonicalBytes, key32B)
  fullFrontmatter.body_sha256 = payload.body_sha256

  // Step 9: write episode file.
  const episodesDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const episodePath = path.join(episodesDir, `${epId}.md`)
  const episodeText = buildEpisodeFile(fullFrontmatter, body, runId, epId, hmacHex)
  // Defense-in-depth: NEVER include the run.key bytes in the episode body
  // (RFC §672 / I4). We don't write key bytes anywhere except runKeyPath.
  fs.writeFileSync(episodePath, episodeText)

  // Step 10: print result JSON.
  process.stdout.write(JSON.stringify({ run_id: runId, episode_id: epId }) + '\n')
  return 0
}

// ---------------------------------------------------------------------------
// Subcommand: finalize-run (PR-1c-B Slice 2 commit 4 — plan v3.3 §B)
// ---------------------------------------------------------------------------

// §D test-hook triple-guard: prod cannot fire even if env var is set, because
// (a) NODE_ENV != 'test' guard, (b) explicit allow-list env, (c) projectRoot
// must live under os.tmpdir(). All three required.
//
// macOS realpath note (codex round-2 FU-2): validateFinalizeArgs realpaths
// `--project`, which on macOS resolves `/var/folders/...` → `/private/var/...`.
// Comparing against a non-realpathed os.tmpdir() would never match, so test
// fixtures using mkdtempSync(os.tmpdir()) wouldn't trigger the abort hook.
// Realpath the tmpdir once at module load so both sides match.
const TMPDIR_REAL = (() => {
  try { return fs.realpathSync(os.tmpdir()) } catch { return os.tmpdir() }
})()

function maybeAbortHook(stepNum, projectRoot) {
  const abortStep = process.env.BP1_TEST_ABORT_AFTER_FINALIZE_STEP
  if (
    abortStep
    && process.env.NODE_ENV === 'test'
    && process.env.BP1_TEST_ALLOW_FINALIZE_ABORT === '1'
    && projectRoot.startsWith(TMPDIR_REAL)
    && Number(abortStep) === stepNum
  ) {
    throw new Error(`BP1_TEST_ABORT_AFTER_FINALIZE_STEP=${abortStep} fired (test-only)`)
  }
}

function nowIso() {
  return new Date().toISOString()
}

function buildFenceFailFrontmatterLines(epId, runId, projectRoot, summary, bodySha, hmacHex) {
  const iso = nowIso()
  return [
    '---',
    `id: ${epId}`,
    `run_id: ${runId}`,
    `type: evidence`,
    `state: fence-fail`,
    `parent_episode: null`,
    `expected_post_episode_id: null`,
    `summary: ${JSON.stringify(summary)}`,
    `body_sha256: ${bodySha}`,
    `hmac_signature: ${hmacHex}`,
    `tags: [bp1-finalize-fence-fail, bp1-evidence-snapshot]`,
    `category: workflow.lifecycle`,
    `date: ${iso.slice(0, 10)}`,
    `time: "${iso.slice(11, 16)}"`,
    `project: ${JSON.stringify(path.basename(projectRoot))}`,
    '---',
    '',
  ]
}

// Signed fence-fail evidence (run.key available). RFC §A.3.
function emitFenceFailEvidence(projectRoot, runId, runKey32B, reason, details) {
  const epId = episodeId(runId, 'fence-fail')
  const summary = `BP-1 finalize fence-fail (${reason}): ${runId}`
  const body = [
    `# bp1-finalize-fence-fail — ${runId}`,
    '',
    `Run \`${runId}\` finalize aborted at ${nowIso()}.`,
    '',
    `**Reason:** \`${reason}\``,
    '',
    '**Details:**',
    '',
    '```json',
    JSON.stringify(details, null, 2),
    '```',
    '',
    `Episode id: \`${epId}\`.`,
    '',
  ].join('\n')
  const frontmatter = {
    type: 'evidence',
    run_id: runId,
    parent_episode: null,
    expected_post_episode_id: null,
    summary,
  }
  const { canonicalBytes, payload } = canonicalize(frontmatter, body)
  const hmacHex = signCanonical(canonicalBytes, runKey32B)
  const fmLines = buildFenceFailFrontmatterLines(epId, runId, projectRoot, summary, payload.body_sha256, hmacHex)
  const episodesDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  fs.writeFileSync(path.join(episodesDir, `${epId}.md`), fmLines.join('\n') + body)
  return epId
}

// Unsigned diagnostic (run.key NOT loadable). RFC §A.2 missing/mode/size/unreadable.
function emitDiagnostic(projectRoot, runId, reason, details) {
  const iso = nowIso()
  const epId = `${runId}-diagnostic-${crypto.randomBytes(2).toString('hex')}`
  const summary = `BP-1 finalize diagnostic (${reason}): ${runId}`
  const body = [
    `# bp1-finalize-diagnostic — ${runId}`,
    '',
    `Run \`${runId}\` finalize aborted at ${iso} (no signed evidence: run.key not loadable).`,
    '',
    `**Reason:** \`${reason}\``,
    '',
    '**Details:**',
    '',
    '```json',
    JSON.stringify(details, null, 2),
    '```',
    '',
  ].join('\n')
  const fmLines = [
    '---',
    `id: ${epId}`,
    `run_id: ${runId}`,
    `type: evidence`,
    `state: diagnostic`,
    `parent_episode: null`,
    `expected_post_episode_id: null`,
    `summary: ${JSON.stringify(summary)}`,
    `tags: [bp1-finalize-diagnostic]`,
    `category: workflow.lifecycle`,
    `date: ${iso.slice(0, 10)}`,
    `time: "${iso.slice(11, 16)}"`,
    `project: ${JSON.stringify(path.basename(projectRoot))}`,
    '---',
    '',
  ]
  const episodesDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  fs.writeFileSync(path.join(episodesDir, `${epId}.md`), fmLines.join('\n') + body)
  return epId
}

// Decision-log fence (§A.1). Returns {ok:true} | {ok:false, reason, details}.
// Reads pre-decision episodes from BOTH local + global stores; for each pre,
// requires exactly one matching post in either store satisfying all 7
// predicates per RFC-004 §689-696 / §619-623.
function decisionLogFence(runId, projectRoot, runKey32B) {
  const stores = [
    path.join(projectRoot, '.episodic-memory', 'episodes'),
    path.join(os.homedir(), '.episodic-memory', 'episodes'),
  ]
  const allEpisodes = new Map() // id → {fm, body, canonicalSha}
  for (const store of stores) {
    if (!fs.existsSync(store)) continue
    // Sort directory entries for deterministic iteration. Without this, the
    // order in which two pre-decisions are evaluated depends on filesystem
    // ordering — codex round-2 FU-1 showed `post-is-itself-pre` evidence
    // could be shadowed by `pre-decision-no-matching-post` when the bad
    // post was iterated before the original pre. Safety outcome is identical
    // (refusal either way); this just makes evidence reason deterministic.
    for (const f of fs.readdirSync(store).sort()) {
      if (!f.endsWith('.md')) continue
      const fp = path.join(store, f)
      let buf
      try {
        buf = fs.readFileSync(fp)
      } catch {
        continue
      }
      let parsed
      try {
        parsed = parseBp1Frontmatter(buf)
      } catch {
        continue // tolerated here; collectEpisodeRecords will hard-fail at step 2
      }
      const fm = parsed.frontmatter
      if (typeof fm.id !== 'string') continue
      // Index ALL episodes (any run_id) so that a post episode whose id
      // matches a pre's expected_post_episode_id but whose run_id differs
      // is still visible — predicate 1 (post.run_id == runId) can then
      // report `post-wrong-run-id` with structured detail per plan §A.1
      // (codex round-1 MAJOR 4: prior version filtered out wrong-run posts
      // and misclassified them as `pre-decision-no-matching-post`; reply
      // episode 20260509-030119-...-2d2f).
      // Last-writer-wins is fine for the fence; collectEpisodeRecords step 2
      // detects duplicate-id-with-different-content as a separate failure.
      allEpisodes.set(fm.id, { fm, body: parsed.body })
    }
  }
  for (const { fm } of allEpisodes.values()) {
    // Pre-decisions for THIS run only.
    if (fm.run_id !== runId) continue
    if (fm.expected_post_episode_id == null) continue
    const expectedPostId = fm.expected_post_episode_id
    const post = allEpisodes.get(expectedPostId)
    if (!post) {
      return {
        ok: false,
        reason: 'pre-decision-no-matching-post',
        details: { pre_id: fm.id, expected_post_episode_id: expectedPostId, found_post_id: null },
      }
    }
    const pfm = post.fm
    // Predicate 1: run_id alignment.
    if (pfm.run_id !== runId) {
      return { ok: false, reason: 'post-wrong-run-id', details: { pre_id: fm.id, post_id: pfm.id, post_run_id: pfm.run_id, expected_run_id: runId } }
    }
    // Predicate 2: parent_episode == pre.id.
    if (pfm.parent_episode !== fm.id) {
      return { ok: false, reason: 'post-wrong-parent-episode', details: { pre_id: fm.id, post_id: pfm.id, post_parent_episode: pfm.parent_episode } }
    }
    // Predicate 3: post is itself terminal (not another pre).
    if (pfm.expected_post_episode_id !== null) {
      return { ok: false, reason: 'post-is-itself-pre', details: { pre_id: fm.id, post_id: pfm.id, post_expected_post_episode_id: pfm.expected_post_episode_id } }
    }
    // Predicate 4: type == 'decision' (RFC-004 §689-696 canonical vocab).
    if (pfm.type !== 'decision') {
      return { ok: false, reason: 'post-wrong-type', details: { pre_id: fm.id, post_id: pfm.id, post_type: pfm.type, expected_type: 'decision' } }
    }
    // Predicate 5: tags includes 'bp1-decision' (RFC-004 §619-623).
    if (!Array.isArray(pfm.tags) || !pfm.tags.includes('bp1-decision')) {
      return { ok: false, reason: 'post-missing-bp1-decision-tag', details: { pre_id: fm.id, post_id: pfm.id, post_tags: pfm.tags || null } }
    }
    // Predicate 6: body_sha256 matches recomputed canonical body hash.
    const { canonicalBytes, payload } = canonicalize(pfm, post.body)
    if (pfm.body_sha256 !== payload.body_sha256) {
      return { ok: false, reason: 'post-body-sha256-mismatch', details: { pre_id: fm.id, post_id: pfm.id, frontmatter_body_sha256: pfm.body_sha256, recomputed_body_sha256: payload.body_sha256 } }
    }
    // Predicate 7: hmac_signature verifies against per-run key over canonical bytes.
    const expectedSig = signCanonical(canonicalBytes, runKey32B)
    if (typeof pfm.hmac_signature !== 'string' || pfm.hmac_signature.toLowerCase() !== expectedSig.toLowerCase()) {
      return { ok: false, reason: 'post-hmac-signature-invalid', details: { pre_id: fm.id, post_id: pfm.id } }
    }
  }
  return { ok: true }
}

function buildManifestEpisodeFile(epId, runId, projectRoot, payload, manifestSig) {
  const iso = nowIso()
  const summary = `BP-1 run manifest: ${runId}`
  const body = JSON.stringify(payload, null, 2) + '\n'
  const fmLines = [
    '---',
    `id: ${epId}`,
    `run_id: ${runId}`,
    `type: evidence`,
    `state: run-manifest`,
    `parent_episode: null`,
    `expected_post_episode_id: null`,
    `summary: ${JSON.stringify(summary)}`,
    `manifest_signature: ${manifestSig}`,
    `terminal_state: ${payload.terminal_state}`,
    `finalized_at: ${JSON.stringify(payload.finalized_at)}`,
    `episodes_records_root: ${payload.episodes_records_root}`,
    `manifest_schema_version: ${JSON.stringify(payload.manifest_schema_version)}`,
    `tags: [bp1-run-manifest, bp1-evidence-snapshot]`,
    `category: workflow.lifecycle`,
    `date: ${iso.slice(0, 10)}`,
    `time: "${iso.slice(11, 16)}"`,
    `project: ${JSON.stringify(path.basename(projectRoot))}`,
    '---',
    '',
  ]
  return fmLines.join('\n') + body
}

// Locate manifest episode for runId in local store. DEFER `1bfc`: concurrent
// finalize could create multiple bp1-run-manifest tagged episodes for the same
// run; current best-effort is "first by lex sort". Manifest uniqueness under
// concurrent finalize is M2 follow-up.
function findManifestEpisode(projectRoot, runId) {
  const local = path.join(projectRoot, '.episodic-memory', 'episodes')
  if (!fs.existsSync(local)) return null
  const candidates = []
  for (const f of fs.readdirSync(local)) {
    if (!f.endsWith('.md')) continue
    const fp = path.join(local, f)
    let buf
    try {
      buf = fs.readFileSync(fp)
    } catch { continue }
    let parsed
    try { parsed = parseBp1Frontmatter(buf) } catch { continue }
    const fm = parsed.frontmatter
    if (fm.run_id !== runId) continue
    if (!Array.isArray(fm.tags) || !fm.tags.includes('bp1-run-manifest')) continue
    candidates.push({ path: fp, frontmatter: fm, body: parsed.body })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return candidates[0]
}

function validateFinalizeArgs(args) {
  if (!args.project) { usage(); return { error: 2 } }
  if (!args.runId) {
    process.stderr.write('error: --run-id is required\n')
    usage()
    return { error: 2 }
  }
  // Shape-validate runId BEFORE any filesystem path use. Without this, raw
  // runId is interpolated into runKeyPath / episode ids / unlink targets
  // (codex round-1 BLOCKER 1: --run-id ../escape wrote artifacts outside
  // .episodic-memory/episodes; reply episode 20260509-030119-...-2d2f).
  try {
    assertRunIdShape(args.runId)
  } catch (e) {
    process.stderr.write(`error: --run-id has invalid shape: ${e.message}\n`)
    return { error: 2 }
  }
  let projectRoot
  try {
    projectRoot = fs.realpathSync(args.project)
  } catch (_e) {
    process.stderr.write(`error: --project does not exist: ${args.project}\n`)
    return { error: 2 }
  }
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    process.stderr.write(`error: --project is not a git repository: ${projectRoot}\n`)
    return { error: 2 }
  }
  return { projectRoot, runId: args.runId }
}

function finalizeRun(args) {
  const v = validateFinalizeArgs(args)
  if (v.error) return v.error
  const { projectRoot, runId } = v
  const homeDir = os.homedir()

  // Step 0: key-load gate (§A.2). Three branches.
  const keyResult = loadRunKey(projectRoot, runId)
  if (keyResult.error) {
    emitDiagnostic(projectRoot, runId, `run-key-${keyResult.error}`, { run_id: runId, key_path: runKeyPath(projectRoot, runId) })
    process.stderr.write(`bp1-finalize-run: run.key ${keyResult.error}\n`)
    return 4
  }
  const { key32B } = keyResult
  maybeAbortHook(0, projectRoot)

  // Step 1: decision-log fence (§A.1).
  const fence = decisionLogFence(runId, projectRoot, key32B)
  if (!fence.ok) {
    emitFenceFailEvidence(projectRoot, runId, key32B, fence.reason, fence.details)
    process.stderr.write(`bp1-finalize-run: decision-log fence-fail (${fence.reason})\n`)
    return 4
  }
  maybeAbortHook(1, projectRoot)

  // Step 2: collect on-disk records. THROW PROPAGATES → signed fence-fail + exit 4.
  let records
  try {
    records = collectEpisodeRecords(runId, projectRoot)
  } catch (e) {
    emitFenceFailEvidence(projectRoot, runId, key32B, 'collect-records-failed', { message: e.message })
    process.stderr.write(`bp1-finalize-run: collectEpisodeRecords failed: ${e.message}\n`)
    return 4
  }
  maybeAbortHook(2, projectRoot)

  // Step 3: records root (computed inside buildManifestPayload; nothing to
  // separately do here other than the abort hook for crash-after-collect).
  maybeAbortHook(3, projectRoot)

  // Step 4: build + sign + emit manifest episode. Verify-key load fail
  // (cannot emit signed manifest) → signed fence-fail + exit 4.
  const verifyKeyLoad = loadVerifyKey(homeDir)
  if (verifyKeyLoad.error) {
    emitFenceFailEvidence(projectRoot, runId, key32B, `verify-key-${verifyKeyLoad.error}`, { home_dir: homeDir })
    process.stderr.write(`bp1-finalize-run: verify-key ${verifyKeyLoad.error}\n`)
    return 4
  }
  // FU-1 ordering wording (§F): per_episode_records is in deterministic
  // episode_id order (lexicographic) — NOT chronological. Same-second IDs
  // tie on suffix. See plan-review round-2 FU-1 (episode 20260508-112437-...-4b9f).
  const payload = buildManifestPayload(records, runId, projectRoot, 'complete', nowIso(), records.length)
  const manifestSig = signManifest(payload, verifyKeyLoad.key32B)
  const manifestEpId = episodeId(runId, 'manifest')
  const episodesDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const manifestPath = path.join(episodesDir, `${manifestEpId}.md`)
  fs.writeFileSync(manifestPath, buildManifestEpisodeFile(manifestEpId, runId, projectRoot, payload, manifestSig))
  maybeAbortHook(4, projectRoot)

  // Step 5: disk re-read fence — parse, verify signature, verify on-disk
  // records still equal manifest. Either fails → signed fence-fail + exit 4.
  let reread
  try {
    reread = parseBp1Frontmatter(fs.readFileSync(manifestPath))
  } catch (e) {
    emitFenceFailEvidence(projectRoot, runId, key32B, 'manifest-reread-parse-failed', { manifest_path: manifestPath, message: e.message })
    process.stderr.write(`bp1-finalize-run: manifest re-read parse failed: ${e.message}\n`)
    return 4
  }
  let rereadPayload
  try {
    rereadPayload = JSON.parse(reread.body)
  } catch (e) {
    emitFenceFailEvidence(projectRoot, runId, key32B, 'manifest-reread-json-invalid', { manifest_path: manifestPath, message: e.message })
    return 4
  }
  if (!verifyManifest(rereadPayload, reread.frontmatter.manifest_signature, verifyKeyLoad.key32B)) {
    emitFenceFailEvidence(projectRoot, runId, key32B, 'manifest-signature-invalid', { manifest_path: manifestPath })
    process.stderr.write('bp1-finalize-run: manifest signature invalid on re-read\n')
    return 4
  }
  const eq = verifyOnDiskEqualsManifest(rereadPayload, runId, projectRoot)
  if (!eq.ok) {
    emitFenceFailEvidence(projectRoot, runId, key32B, 'manifest-disk-mismatch', { mismatches: eq.mismatches })
    process.stderr.write(`bp1-finalize-run: on-disk records do not match manifest (${eq.mismatches.length} mismatch(es))\n`)
    return 4
  }
  maybeAbortHook(5, projectRoot)

  // Step 6: shred run.key. After this point the run cannot be re-finalized
  // (no live signing key remains). Failure with key-still-on-disk violates
  // I4 ("terminal state after no usable live run.key remains under single-
  // process semantics") — fail closed; do NOT mark terminal. Operator can
  // call finalize-recover after addressing the shred failure root cause
  // (codex round-1 BLOCKER 2; reply episode 20260509-030119-...-2d2f).
  const shred = shredRunKey(projectRoot, runId)
  if (shred.error && shred.error !== 'missing') {
    emitFenceFailEvidence(projectRoot, runId, key32B, `shred-failed-${shred.error}`, { run_id: runId, key_path: runKeyPath(projectRoot, runId) })
    process.stderr.write(`bp1-finalize-run: shredRunKey returned ${shred.error} — refusing to mark terminal (live run.key remains)\n`)
    return 4
  }
  maybeAbortHook(6, projectRoot)

  // Step 7: mark terminal state. DEFER `4b35`: compound State-D terminal/key
  // transition atomicity (M2 follow-up).
  const term = markTerminal(projectRoot, runId, 'complete')
  if (term.error && term.error !== 'already-terminal') {
    process.stderr.write(`bp1-finalize-run: markTerminal returned ${term.error}\n`)
    return 3
  }
  maybeAbortHook(7, projectRoot)

  process.stdout.write(JSON.stringify({
    run_id: runId,
    manifest_episode_id: manifestEpId,
    terminal_state: 'complete',
    episode_count: payload.episode_count,
    episodes_records_root: payload.episodes_records_root,
  }) + '\n')
  return 0
}

// ---------------------------------------------------------------------------
// Subcommand: finalize-recover (PR-1c-B Slice 2 commit 4 — plan v3.3 §C)
// ---------------------------------------------------------------------------

function finalizeRecover(args) {
  const v = validateFinalizeArgs(args)
  if (v.error) return v.error
  const { projectRoot, runId } = v
  const homeDir = os.homedir()

  // Locate manifest. No manifest = State C (manifest invalid / missing).
  const manifest = findManifestEpisode(projectRoot, runId)
  if (!manifest) {
    process.stderr.write(`bp1-finalize-recover: no bp1-run-manifest episode for ${runId} (State C)\n`)
    return 4
  }
  let payload
  try {
    payload = JSON.parse(manifest.body)
  } catch (e) {
    process.stderr.write(`bp1-finalize-recover: manifest body JSON-invalid (State C): ${e.message}\n`)
    return 4
  }

  // Manifest validity: signature + on-disk equality. Any failure → State C.
  const verifyKeyLoad = loadVerifyKey(homeDir)
  if (verifyKeyLoad.error) {
    process.stderr.write(`bp1-finalize-recover: verify-key ${verifyKeyLoad.error} (cannot validate manifest; State C)\n`)
    return 4
  }
  const sig = manifest.frontmatter.manifest_signature
  if (!verifyManifest(payload, sig, verifyKeyLoad.key32B)) {
    process.stderr.write('bp1-finalize-recover: manifest signature invalid (State C)\n')
    return 4
  }
  const eq = verifyOnDiskEqualsManifest(payload, runId, projectRoot)
  if (!eq.ok) {
    process.stderr.write(`bp1-finalize-recover: on-disk records do not match manifest (State C; ${eq.mismatches.length} mismatch(es))\n`)
    return 4
  }

  // Manifest is valid. Branch on key state.
  const keyResult = loadRunKey(projectRoot, runId)
  let state
  if (keyResult.error === 'missing') {
    // State B: manifest valid, key already shredded. Terminal mark idempotent.
    state = 'B'
    const term = markTerminal(projectRoot, runId, 'complete')
    if (term.error && term.error !== 'already-terminal') {
      process.stderr.write(`bp1-finalize-recover: markTerminal returned ${term.error} (State B)\n`)
      return 3
    }
  } else if (keyResult.error) {
    // State D: manifest valid, key damaged (mode/size/unreadable). Unlink
    // damaged key then mark terminal. DEFER `4b35`: compound terminal/key
    // transition atomic helper (M2 follow-up). I4 + I5 require failing
    // closed when key removal fails (codex round-1 BLOCKER 3; reply
    // episode 20260509-030119-...-2d2f).
    state = 'D'
    try {
      fs.unlinkSync(runKeyPath(projectRoot, runId))
    } catch (e) {
      // ENOENT is benign (race with prior finalize cleanup).
      if (e.code !== 'ENOENT') {
        process.stderr.write(`bp1-finalize-recover: failed to unlink damaged run.key: ${e.message} (State D) — refusing to mark terminal (key still present)\n`)
        return 4
      }
    }
    const term = markTerminal(projectRoot, runId, 'complete')
    if (term.error && term.error !== 'already-terminal') {
      process.stderr.write(`bp1-finalize-recover: markTerminal returned ${term.error} (State D)\n`)
      return 3
    }
  } else {
    // State A: manifest valid, key still present. Shred then terminal.
    // I4 requires failing closed when shred fails with key still on disk
    // (codex round-1 BLOCKER 3; reply episode 20260509-030119-...-2d2f).
    state = 'A'
    const shred = shredRunKey(projectRoot, runId)
    if (shred.error && shred.error !== 'missing') {
      process.stderr.write(`bp1-finalize-recover: shredRunKey returned ${shred.error} (State A) — refusing to mark terminal (live run.key remains)\n`)
      return 4
    }
    const term = markTerminal(projectRoot, runId, 'complete')
    if (term.error && term.error !== 'already-terminal') {
      process.stderr.write(`bp1-finalize-recover: markTerminal returned ${term.error} (State A)\n`)
      return 3
    }
  }

  process.stdout.write(JSON.stringify({
    run_id: runId,
    state,
    manifest_episode_id: manifest.frontmatter.id,
    terminal_state: getRunState(projectRoot, runId)?.state ?? null,
  }) + '\n')
  return 0
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
let exitCode
switch (args.subcommand) {
  case 'init-run':
    exitCode = initRun(args)
    break
  case 'finalize-run':
    exitCode = finalizeRun(args)
    break
  case 'finalize-recover':
    exitCode = finalizeRecover(args)
    break
  case null:
  case undefined:
    usage()
    exitCode = 2
    break
  default:
    process.stderr.write(`error: unknown subcommand: ${args.subcommand}\n`)
    usage()
    exitCode = 2
    break
}
process.exit(exitCode)
