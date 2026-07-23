#!/usr/bin/env node
/**
 * em-topic-tracks.mjs — Thin CLI over scripts/topic-tracks/engine.mjs
 * (NAPMEM-C S2). The CLI owns strict pairwise argv parsing and exit-class
 * mapping; the engine owns behavior. Writes happen ONLY through the spawned
 * em-store child process — the CLI itself touches no episode/index/tag/lock
 * file and reads no config or store on the --help path.
 *
 * Public CLI (§A.5):
 *   node em-topic-tracks.mjs [--max-episodes <n>] [--apply] [--confirm <64-hex>]...
 *   node em-topic-tracks.mjs --help
 *
 * Exit classes (§12):
 *   0 → successful help / dry-run / apply
 *   1 → runtime / config / lock / write error
 *   2 → invalid flags, bounds, confirmation, --auto, or hard-cap refusal
 *
 * Row 2.2 resync: exact pairwise parsing rejects every unknown flag, every
 * positional argument, every missing value, and every `--flag=value` spelling
 * (`unknown-flag`); --auto is the dedicated `auto-write-withdrawn` error;
 * `topic-tracks-max-episodes` maps to exit class 2.
 */

import {
  loadTopicTracksConfig,
  scanTopicTracks,
  applyTopicTracks,
} from './topic-tracks/engine.mjs'

const argv = process.argv.slice(2)
const SCRIPT_NAME = 'em-topic-tracks.mjs'

const VALID_VALUE_FLAGS = new Set(['--max-episodes', '--confirm'])

function emitError(errorCode, detail, exitCode) {
  const obj = { status: 'error', error: errorCode }
  if (detail !== undefined) obj.detail = detail
  console.log(JSON.stringify(obj))
  process.exit(exitCode)
}

// --- Strict pairwise argv parse BEFORE any help/config/store path ---
let maxEpisodesRaw
const confirmsRaw = []
let helpRequested = false
{
  let i = 0
  while (i < argv.length) {
    const tok = argv[i]
    // Reject every `--flag=value` spelling (known or unknown flags).
    if (tok.startsWith('--') && tok.includes('=')) {
      emitError('unknown-flag', tok, 2)
    }
    // Boolean flags: standalone, no value.
    if (tok === '--help' || tok === '-h') { helpRequested = true; i++; continue }
    if (tok === '--auto') { i++; continue } // handled after parse
    if (tok === '--apply') { i++; continue }
    // Value flags: must be followed by a non-flag value.
    if (VALID_VALUE_FLAGS.has(tok)) {
      const val = argv[i + 1]
      if (val === undefined) {
        emitError(tok === '--max-episodes' ? 'invalid-max-episodes' : 'confirm-malformed',
          `${tok} requires a value`, 2)
      }
      if (typeof val === 'string' && val.startsWith('-')) {
        emitError(tok === '--max-episodes' ? 'invalid-max-episodes' : 'confirm-malformed',
          `${tok} value cannot be a flag: ${val}`, 2)
      }
      if (tok === '--max-episodes') {
        if (maxEpisodesRaw !== undefined) {
          emitError('invalid-max-episodes', 'duplicate --max-episodes', 2)
        }
        maxEpisodesRaw = val
      } else {
        confirmsRaw.push(val)
      }
      i += 2
      continue
    }
    // Any other token starting with `-` is an unknown flag.
    if (tok.startsWith('-')) emitError('unknown-flag', tok, 2)
    // Anything else is a positional argument — reject.
    emitError('unknown-flag', tok, 2)
  }
}

// --- --auto: rejected (RFC-012 B-2 replaces RFC-001 --auto) ---
if (argv.includes('--auto')) emitError('auto-write-withdrawn', undefined, 2)

// --- Help succeeds only as the sole argument ---
if (helpRequested) {
  if (argv.length !== 1) {
    emitError('unknown-flag', argv.find(t => t !== '--help' && t !== '-h'), 2)
  }
  const help = {
    status: 'help',
    script: SCRIPT_NAME,
    usage: 'node em-topic-tracks.mjs [--max-episodes <n>] [--apply] [--confirm <64-hex>]... | --help',
    notes: [
      'Dry-run is the default. --apply requires one or more --confirm <fingerprint> values matching preview candidates.',
      '--auto is REJECTED (auto-write-withdrawn, RFC-001 Phase 4 superseded by RFC-012 B-2 per-candidate confirmation).',
      'Confirmed writes are global category:lesson episodes through em-store with typed promotion_sources; source episodes remain byte-identical.',
      'CLI --max-episodes may only TIGHTEN the committed hard cap; values above the configured max are rejected.',
    ],
    exit_codes: { '0': 'successful help / dry-run / apply', '1': 'runtime / config / lock / write error', '2': 'invalid flags / bounds / confirmation / --auto / hard-cap refusal' },
  }
  console.log(JSON.stringify(help, null, 2))
  process.exit(0)
}

// --- max-episodes: integer, must TIGHTEN the committed cap ---
let maxEpisodesOverride
if (maxEpisodesRaw !== undefined) {
  const n = Number(maxEpisodesRaw)
  if (!Number.isInteger(n) || n < 3 || String(n) !== String(maxEpisodesRaw).trim()) {
    emitError('invalid-max-episodes', maxEpisodesRaw, 2)
  }
  maxEpisodesOverride = n
}

// --- --confirm: repeatable 64-hex values ---
const HEX64 = /^[0-9a-f]{64}$/
const confirmSet = new Set()
const duplicateConfirms = new Set()
for (const c of confirmsRaw) {
  if (!HEX64.test(c)) emitError('confirm-malformed', c, 2)
  if (confirmSet.has(c)) duplicateConfirms.add(c)
  confirmSet.add(c)
}
if (duplicateConfirms.size > 0) {
  emitError('confirm-duplicate', [...duplicateConfirms].join(','), 2)
}

const applyMode = argv.includes('--apply')

// --- Load config (and apply max-episodes override tightening) ---
let config
try {
  config = loadTopicTracksConfig()
} catch (err) {
  const code = err && err.code ? err.code : 'topic-tracks-config-invalid'
  emitError(code, undefined, 1)
}

if (maxEpisodesOverride !== undefined) {
  // CLI may only TIGHTEN the committed hard cap (REQ-11).
  if (maxEpisodesOverride > config.max_episodes) {
    emitError('invalid-max-episodes',
      `${maxEpisodesOverride} > committed cap ${config.max_episodes}`, 2)
  }
  config = Object.freeze({ ...config, max_episodes: maxEpisodesOverride })
}

// --- Apply mode requires at least one --confirm ---
if (applyMode && confirmSet.size === 0) {
  emitError('confirm-required', undefined, 2)
}

// --- Execute scan, then optional apply ---
let scan
try {
  scan = scanTopicTracks({ config })
} catch (err) {
  if (err && err.code === 'topic-tracks-max-episodes') {
    // Hard-cap refusal maps to exit class 2 (§12).
    emitError('topic-tracks-max-episodes',
      err.observed !== undefined
        ? `members=${err.observed} > cap=${err.max_episodes}`
        : 'members exceeded committed hard cap',
      2)
  }
  emitError('topic-tracks-config-invalid', err && err.message, 1)
}

if (!applyMode) {
  console.log(JSON.stringify(scan, null, 2))
  process.exit(0)
}

// --- Apply: validate --confirm set against preview fingerprints ---
const previewFp = new Set(scan.candidates.map(c => c.fingerprint))
const unknown = [...confirmSet].filter(fp => !previewFp.has(fp))
if (unknown.length > 0) {
  emitError('confirm-unknown', unknown.join(','), 2)
}

let applyResult
try {
  // Pass the exact preview the CLI already produced; the engine rescans only
  // when no preview is supplied (REQ-8 single-scan contract).
  applyResult = applyTopicTracks({ config, confirmed: confirmSet, preview: scan })
} catch (err) {
  if (err && err.code === 'topic-tracks-max-episodes') {
    // Apply-time hard-cap refusal also maps to exit class 2 (§19.3 B4).
    emitError('topic-tracks-max-episodes',
      err.observed !== undefined
        ? `members=${err.observed} > cap=${err.max_episodes}`
        : 'members exceeded committed hard cap',
      2)
  }
  const code = err && err.code ? err.code : 'store-write-failed'
  emitError(code, err && err.message, 1)
}

// Surface any per-candidate apply errors from inside the engine via the
// apply-result warnings; we keep exit 0 when at least one candidate was
// written or skipped-already-derived — pure-error apply runs stay exit 1.
if (applyResult.written.length === 0 &&
      applyResult.skipped.length === 0 &&
      applyResult.warnings.some(w => /^(stale-fingerprint|store-write-lock-timeout|store-write-failed)$/.test(w.problem))) {
  console.log(JSON.stringify(applyResult, null, 2))
  process.exit(1)
}

console.log(JSON.stringify(applyResult, null, 2))
process.exit(0)
