#!/usr/bin/env node
/**
 * bp1-orchestrator.mjs — BP-1 orchestrator runtime (RFC-004 §668, §722, M1).
 *
 * PR-1c-A scope: `init-run` subcommand only.
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
 * Out of scope (PR-1c-B): finalize-run, replay, manifest emit, event-table,
 * snapshot, full state machine, CLI subcommands beyond init-run.
 *
 * Exit codes:
 *   0 — run started successfully; { run_id, episode_id } on stdout.
 *   1 — activation gate refused (project disabled / key drift / hash drift).
 *        flag-check stderr forwarded to operator.
 *   2 — bad CLI args / missing --project / not a git repo.
 *   3 — internal error (run_id collision / key gen failure / other).
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
import { generateRunKey } from './lib/bp1-keys.mjs'
import { appendRun } from './lib/bp1-run-state.mjs'
import { probeScheduledTasksCapability } from './lib/bp1-probe.mjs'

const REPO_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const FLAG_CHECK = path.join(REPO_DIR, 'scripts', 'bp1-flag-check.mjs')

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function usage() {
  process.stderr.write(
    'Usage: bp1-orchestrator init-run --project <projectRoot> --rfc-id <rfcId>\n',
  )
}

function parseArgs(argv) {
  const out = { subcommand: null, project: null, rfcId: null }
  if (argv.length === 0) return out
  out.subcommand = argv[0]
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--project') out.project = argv[++i]
    else if (arg === '--rfc-id') out.rfcId = argv[++i]
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
// main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
let exitCode
switch (args.subcommand) {
  case 'init-run':
    exitCode = initRun(args)
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
