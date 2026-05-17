#!/usr/bin/env node
/**
 * bp1-emit-marker-invalid-evidence.mjs — Slice 2d-R failure-evidence helper.
 *
 * Invoked by `.claude/hooks/bp1-approval-check.sh` (H1) when
 * `bp1-marker-validate.mjs` returns `status: invalid` for a marker. This
 * helper handles the THREE-case evidence contract from the slice 2d-R round-2
 * plan (codex P1-B disposition):
 *
 *   Case A — run.key on disk:
 *     Write a signed `failure:bp1-marker-invalid` BP-1 episode via
 *     `writeBp1Episode()` (HMAC-signed with the per-run key). Exit 0; stdout
 *     contains `{ case: "A", episode_id, episode_path }`.
 *
 *   Case B — run.key missing OR mode-drift OR size-drift:
 *     Cannot HMAC-sign. Emit structured JSON to stderr only; NO episode
 *     written. The marker file itself is the persisting forensic artifact
 *     (per RFC §675-676 — key-shred cleanup callers leave the marker on disk).
 *     Exit 0; stdout contains `{ case: "B", marker_path }`.
 *
 *   Case C is owned by the hook, not this helper: when the marker is so
 *   corrupt that the run_id cannot be derived from the filename, the hook
 *   stderr-logs directly without invoking this helper. Documented in the
 *   hook (bp1-approval-check.sh §178 silent-exit table).
 *
 * Argv:
 *   --project <path>       required, absolute canonical project root
 *   --run-id <id>          required, RUN_ID_RE shape
 *   --reason <enum>        required, one of:
 *                            symlink | malformed-json | missing-fields
 *                          | run-id-mismatch | mtime-drift | sha256-mismatch
 *                          | hmac-mismatch | shape-error | not-a-file
 *                          | created-at-unparseable | lstat-failed | read-failed
 *   --marker-path <path>   required, absolute path of the invalid marker
 *
 * Exit codes:
 *   0 — emission completed (Case A signed OR Case B stderr-only)
 *   2 — argv shape error / project-root resolution failed
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'

import { writeBp1Episode } from './lib/bp1-episode-writer.mjs'
import { loadRunKey } from './lib/bp1-keys.mjs'

const RUN_ID_RE = /^[a-z0-9-]+$/
const VALID_REASONS = new Set([
  'symlink',
  'malformed-json',
  'missing-fields',
  'run-id-mismatch',
  'mtime-drift',
  'sha256-mismatch',
  'hmac-mismatch',
  'shape-error',
  'not-a-file',
  'created-at-unparseable',
  // The validator may emit reasons of the form `lstat-failed:<code>` /
  // `read-failed:<code>` / `key-<error>`; we accept any value matching these
  // prefixes (the prefix is the discriminator).
])
const VALID_REASON_PREFIXES = ['lstat-failed:', 'read-failed:', 'key-']

function isValidReason(reason) {
  if (typeof reason !== 'string' || reason === '') return false
  if (VALID_REASONS.has(reason)) return true
  for (const prefix of VALID_REASON_PREFIXES) {
    if (reason.startsWith(prefix)) return true
  }
  return false
}

function safeTruncate(s, max) {
  if (typeof s !== 'string') return ''
  return s.length > max ? s.slice(0, max) : s
}

function parseArgs(argv) {
  const out = { project: null, runId: null, reason: null, markerPath: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project' && i + 1 < argv.length) out.project = argv[++i]
    else if (a === '--run-id' && i + 1 < argv.length) out.runId = argv[++i]
    else if (a === '--reason' && i + 1 < argv.length) out.reason = argv[++i]
    else if (a === '--marker-path' && i + 1 < argv.length) out.markerPath = argv[++i]
    else if (a === '--help' || a === '-h') {
      process.stdout.write('usage: bp1-emit-marker-invalid-evidence.mjs --project <path> --run-id <id> --reason <enum> --marker-path <path>\n')
      process.exit(0)
    } else {
      process.stderr.write(`unknown argv: ${a}\n`)
      process.exit(2)
    }
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.project) { process.stderr.write('error: --project required\n'); process.exit(2) }
  if (!args.runId || !RUN_ID_RE.test(args.runId)) {
    process.stderr.write('error: --run-id required and must match RUN_ID_RE\n')
    process.exit(2)
  }
  if (!isValidReason(args.reason)) {
    process.stderr.write(`error: --reason invalid (got "${args.reason}"); see --help\n`)
    process.exit(2)
  }
  if (!args.markerPath || !path.isAbsolute(args.markerPath)) {
    process.stderr.write('error: --marker-path required and must be absolute\n')
    process.exit(2)
  }

  let projectRoot
  try {
    projectRoot = fs.realpathSync(args.project)
  } catch (_e) {
    process.stderr.write(`error: --project does not exist: ${args.project}\n`)
    process.exit(2)
  }

  // Try to load the per-run key. If absent / mode-drift / size-drift, Case B.
  const keyResult = loadRunKey(projectRoot, args.runId)
  if (keyResult.error) {
    // Case B: key unavailable. Emit structured stderr JSON; no episode.
    const stderrLine = JSON.stringify({
      kind: 'failure:bp1-marker-invalid-unsigned',
      case: 'B',
      reason: args.reason,
      key_load_error: keyResult.error,
      run_id: args.runId,
      marker_path: args.markerPath,
      project_root: projectRoot,
      note: 'run.key unavailable; marker file persists on disk as forensic artifact',
      emitted_at: new Date().toISOString(),
    })
    process.stderr.write(stderrLine + '\n')
    process.stdout.write(JSON.stringify({
      case: 'B',
      marker_path: args.markerPath,
      key_load_error: keyResult.error,
    }) + '\n')
    return 0
  }

  // Case A: key present. Emit signed failure episode.
  const reasonTruncated = safeTruncate(args.reason, 66)
  let result
  try {
    result = writeBp1Episode({
      projectRoot,
      runId: args.runId,
      runKey32B: keyResult.key32B,
      type: 'failure', state: null,
      summary: `BP-1 marker-invalid at approval-check hook: ${args.runId} (${reasonTruncated})`,
      parentEpisode: null,
      expectedPostEpisodeId: null,
      customFm: {
        failure_kind: 'bp1-marker-invalid',
        marker_path: args.markerPath,
        reason: reasonTruncated,
      },
      tags: ['bp1-marker-invalid'],
      body: `# bp1-marker-invalid\n\nmarker_path: \`${args.markerPath}\`\nreason: \`${reasonTruncated}\`\nrun_id: \`${args.runId}\`\n\nDetected by \`bp1-marker-validate.mjs\` at SessionStart hook (\`bp1-approval-check.sh\`). The marker is left on disk for operator inspection; the hook proceeded with exit 0 (silent-exit semantics, §178).\n`,
      filenameSuffix: 'bp1-marker-invalid',
    })
  } catch (e) {
    process.stderr.write(`error: writeBp1Episode threw: ${e.message}\n`)
    // Fall back to stderr-only (treat as Case B). The marker stays on disk.
    const stderrLine = JSON.stringify({
      kind: 'failure:bp1-marker-invalid-unsigned',
      case: 'B',
      reason: args.reason,
      writer_error: e.message,
      run_id: args.runId,
      marker_path: args.markerPath,
      project_root: projectRoot,
      emitted_at: new Date().toISOString(),
    })
    process.stderr.write(stderrLine + '\n')
    process.stdout.write(JSON.stringify({ case: 'B', marker_path: args.markerPath, writer_error: e.message }) + '\n')
    return 0
  }
  process.stdout.write(JSON.stringify({
    case: 'A',
    episode_id: result.episodeId,
    episode_path: result.episodePath,
    marker_path: args.markerPath,
  }) + '\n')
  return 0
}

const code = main()
process.exit(code)
