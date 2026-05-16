/**
 * bp1-episode-writer.mjs — Generic HMAC-signed BP-1 episode writer (slice 2c).
 *
 * Refactored from bp1-orchestrator.mjs:203-260 (initRun's `buildEpisodeFile`)
 * into a single entry point reusable by all 4 BP-1 slice 2c subcommands
 * (detect-rfcs, record-classifier-dispatch-pre, record-classification, plus
 * future state-transition emitters).
 *
 * ## Contract: canonicalize-stable values
 *
 * The bp1-frontmatter parser (lib/bp1-frontmatter.mjs) supports only:
 *   - string (bare-token or JSON-quoted)
 *   - boolean (`true` | `false`)
 *   - null literal
 *   - bare-token array (`[a, b, c]`)
 *
 * It does NOT support numeric values. So `customFm` values for canonical fields
 * MUST be pre-stringified by the caller. Specifically:
 *   - `classifier_confidence: 0.85` (number from JSON.parse) → caller passes
 *     `String(0.85)` = `"0.85"` so write-time and parse-time canonicalization
 *     see the same string and HMAC verification round-trips.
 *   - `observed_value` (any classifier field value) → 66-char-capped JSON
 *     repr per RFC §510-547 describeStatus policy.
 *
 * Canonicalize-stable means: the same JSON.stringify(payload) byte sequence is
 * produced before write AND after re-parse. Numbers cause divergence; strings
 * round-trip cleanly.
 *
 * ## API
 *
 *   writeBp1Episode({
 *     projectRoot,           // absolute path string
 *     runId,                 // shape-validated run_id (RUN_ID_RE)
 *     runKey32B,             // 32-byte Buffer
 *     type,                  // 'state-transition' | 'failure' | 'evidence'
 *     state,                 // for state-transition: state value (e.g. 'rfc-detected'); else null
 *     summary,               // string (used for the file's summary field)
 *     parentEpisode,         // episode-id string OR null
 *     expectedPostEpisodeId, // episode-id string OR null
 *     customFm,              // {field: value} object — type-specific canonical fields
 *                            // (caller-stringified per contract above)
 *     tags,                  // string[] — appended to file's tags array
 *     body,                  // body markdown text (string or Buffer)
 *     filenameSuffix,        // suffix in episode-id (e.g. 'rfc-detected', 'pre')
 *   }) → { episodeId, episodePath, hmacHex }
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { canonicalize } from './bp1-canonicalize.mjs'
import { signCanonical } from './bp1-hmac.mjs'

const RUN_ID_RE = /^[a-z0-9-]+$/

function assertString(name, v) {
  if (typeof v !== 'string' || v === '') {
    throw new TypeError(`writeBp1Episode: ${name} must be a non-empty string; got ${typeof v}`)
  }
}

function assertOptionalString(name, v) {
  if (v == null) return
  if (typeof v !== 'string') {
    throw new TypeError(`writeBp1Episode: ${name} must be a string or null; got ${typeof v}`)
  }
}

function genEpisodeId(runId, suffix) {
  const rand4 = crypto.randomBytes(2).toString('hex')
  return `${runId}-${suffix}-${rand4}`
}

function serializeFmValue(v) {
  // Per parser contract: support string, boolean, null, string-array.
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    for (const el of v) {
      if (typeof el !== 'string' || el === '' || /[,\[\]"'\s]/.test(el)) {
        throw new TypeError(`writeBp1Episode: array element must be a bare token; got ${JSON.stringify(el)}`)
      }
    }
    return `[${v.join(', ')}]`
  }
  if (typeof v === 'string') {
    // JSON-quote so the parser accepts whitespace, special chars, and so the
    // round-trip canonicalize() sees exactly this string.
    return JSON.stringify(v)
  }
  throw new TypeError(`writeBp1Episode: unsupported value type ${typeof v}; numbers must be pre-stringified by caller`)
}

/**
 * Build a single YAML key:value line with proper serialization.
 */
function fmLine(key, value) {
  return `${key}: ${serializeFmValue(value)}`
}

/**
 * Write a generic HMAC-signed BP-1 episode.
 *
 * @param {object} opts — see top-of-file API doc
 * @returns {{ episodeId: string, episodePath: string, hmacHex: string }}
 */
export function writeBp1Episode(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('writeBp1Episode: opts must be an object')
  }
  const {
    projectRoot,
    runId,
    runKey32B,
    type,
    state,
    summary,
    parentEpisode,
    expectedPostEpisodeId,
    customFm,
    tags,
    body,
    filenameSuffix,
  } = opts

  assertString('projectRoot', projectRoot)
  if (!path.isAbsolute(projectRoot)) {
    throw new TypeError(`writeBp1Episode: projectRoot must be absolute; got ${projectRoot}`)
  }
  assertString('runId', runId)
  if (!RUN_ID_RE.test(runId)) {
    throw new TypeError(`writeBp1Episode: runId shape invalid: ${JSON.stringify(runId)}`)
  }
  if (!Buffer.isBuffer(runKey32B) || runKey32B.length !== 32) {
    throw new TypeError('writeBp1Episode: runKey32B must be a 32-byte Buffer')
  }
  assertString('type', type)
  assertOptionalString('state', state)
  assertString('summary', summary)
  assertOptionalString('parentEpisode', parentEpisode)
  assertOptionalString('expectedPostEpisodeId', expectedPostEpisodeId)
  assertString('filenameSuffix', filenameSuffix)
  if (!RUN_ID_RE.test(filenameSuffix)) {
    throw new TypeError(`writeBp1Episode: filenameSuffix shape invalid: ${JSON.stringify(filenameSuffix)}`)
  }
  if (customFm != null && (typeof customFm !== 'object' || Array.isArray(customFm))) {
    throw new TypeError('writeBp1Episode: customFm must be an object or omitted')
  }
  if (tags != null && !Array.isArray(tags)) {
    throw new TypeError('writeBp1Episode: tags must be an array or omitted')
  }

  // 1. Compose frontmatter object for canonicalize() input.
  const frontmatter = {
    type,
    run_id: runId,
    parent_episode: parentEpisode ?? null,
    expected_post_episode_id: expectedPostEpisodeId ?? null,
    summary,
  }
  if (state != null) frontmatter.state = state
  if (customFm) {
    for (const [k, v] of Object.entries(customFm)) {
      if (k === 'type' || k === 'run_id' || k === 'parent_episode' ||
          k === 'expected_post_episode_id' || k === 'summary' || k === 'state' ||
          k === 'body_sha256' || k === 'hmac_signature' || k === 'id' ||
          k === 'tags' || k === 'category' || k === 'date' || k === 'time' ||
          k === 'project') {
        throw new Error(`writeBp1Episode: customFm field collides with reserved key: ${k}`)
      }
      frontmatter[k] = v
    }
  }

  // 2. Canonicalize + sign. canonicalize() picks subtype based on (type, state)
  //    or (type, failure_kind) and selects type-specific canonical fields from
  //    TYPE_SPECIFIC_CANONICAL_FIELDS in bp1-canonicalize.mjs.
  const bodyText = typeof body === 'string' ? body : (body ?? '')
  const { canonicalBytes, payload } = canonicalize(frontmatter, bodyText)
  const hmacHex = signCanonical(canonicalBytes, runKey32B)

  // 3. Generate episode_id + path.
  const episodeId = genEpisodeId(runId, filenameSuffix)
  const episodesDir = path.join(projectRoot, '.episodic-memory', 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const episodePath = path.join(episodesDir, `${episodeId}.md`)

  // 4. Serialize frontmatter YAML. Field order:
  //      id, run_id, type, [state], parent_episode, expected_post_episode_id,
  //      summary, <type-specific canonical fields in declared order>,
  //      body_sha256, hmac_signature, tags, category, date, time, project.
  const iso = new Date().toISOString()
  const lines = []
  lines.push('---')
  lines.push(fmLine('id', episodeId))
  lines.push(fmLine('run_id', runId))
  lines.push(`type: ${type}`)
  if (state != null) lines.push(`state: ${state}`)
  lines.push(`parent_episode: ${parentEpisode == null ? 'null' : parentEpisode}`)
  lines.push(`expected_post_episode_id: ${expectedPostEpisodeId == null ? 'null' : expectedPostEpisodeId}`)
  lines.push(fmLine('summary', summary))

  // Type-specific canonical fields — write in the order they appear in
  // TYPE_SPECIFIC_CANONICAL_FIELDS (the canonicalize subtype lookup). This
  // keeps the file readable next to the canonical-fields table.
  // Skip 'state' (already written above). Skip generic fields that aren't part
  // of the type-specific table.
  for (const [k, v] of Object.entries(frontmatter)) {
    if (k === 'type' || k === 'run_id' || k === 'parent_episode' ||
        k === 'expected_post_episode_id' || k === 'summary' || k === 'state') {
      continue
    }
    lines.push(fmLine(k, v))
  }

  lines.push(`body_sha256: ${payload.body_sha256}`)
  lines.push(`hmac_signature: ${hmacHex}`)
  // Tags include the type-default plus any caller-supplied additional tags.
  const allTags = ['bp1-evidence-snapshot']
  if (tags) {
    for (const t of tags) {
      if (typeof t !== 'string' || t === '' || /[,\[\]"'\s]/.test(t)) {
        throw new TypeError(`writeBp1Episode: tag must be a bare token; got ${JSON.stringify(t)}`)
      }
      if (!allTags.includes(t)) allTags.push(t)
    }
  }
  lines.push(`tags: [${allTags.join(', ')}]`)
  lines.push('category: workflow.lifecycle')
  lines.push(`date: ${iso.slice(0, 10)}`)
  lines.push(`time: "${iso.slice(11, 16)}"`)
  // path.basename can yield names with whitespace; JSON-quote per writer
  // contract used elsewhere in orchestrator (round-1 codex MAJOR finding 5).
  lines.push(fmLine('project', path.basename(projectRoot) || 'unknown'))
  lines.push('---')
  lines.push('')

  const fileText = lines.join('\n') + bodyText

  // Atomic write: tmp + fsync + rename. Crash between fsync and rename
  // leaves a recoverable tmp; crash before rename leaves no observable
  // final path (cluster #286/#287/#288 — codex round-5 ACCEPT).
  const tmpPath = `${episodePath}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  const fd = fs.openSync(tmpPath, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, fileText)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, episodePath)

  return { episodeId, episodePath, hmacHex }
}
