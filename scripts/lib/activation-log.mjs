// scripts/lib/activation-log.mjs (CREATE, S1) — shared by the hook writer AND the clerk reader.
import fs from 'node:fs'
import path from 'node:path'

export const LOG_FORMAT_VERSION = 1
export const ACTIVATION_LOG_NAME = 'activation-log.jsonl'
export const ACTIVATION_LOG_MAX_BYTES = 1024 * 1024 // 1 MiB (T8)
export const RENDERED_FORMS = ['imperative', 'plain']
export const INJECTION_SURFACES = ['session_start', 'per_prompt', 'tool', 'dispatcher']
// Clerk (em-consolidate) constants:
export const RUN_RECORD_CATEGORY = 'workflow.lifecycle'
export const RUN_RECORD_TYPE = 'clerk-run'          // scalar frontmatter key, NEVER a tag
export const CLERK_CUTOVER_MARKER = 'rfc-009-p4'     // the clerk STAMPS `clerk_cutover:<this>` frontmatter on every
                                                     // digest + run-record it writes; legacy digests LACK the field
                                                     // → clock-independent crash discriminator (NSP F6, NOT a date compare)
export const TAG_JACCARD_MIN = 0.5                   // T1
export const SUMMARY_JACCARD_MIN = 0.4               // T3
export const HIGH_DF_MIN = (activeCount) => Math.max(3, Math.ceil(0.10 * activeCount)) // T2
export const CADENCE_K_SHARED = 3                    // T4
export const CADENCE_N_LESSONS = 200                 // T5
export const ATTRIBUTION_WINDOW_MS = 4 * 60 * 60 * 1000 // T6, half-open [inject, inject+window)
export const PROPOSED_ACTIONS = ['merge', 'dedupe', 'keep-distinct']

// Portable negative-control break overrides (§A.0/A.9): cross-platform `--break-<x>`
// argv flags, NOT env vars — the activation hook + tests must run under Windows `cmd`.
// Production invocations never carry these; the S1 tests pass them to prove the
// drop-at-bound / non-fatal guards are not vacuous.
const BREAK_BOUND = process.argv.includes('--break-bound')
const BREAK_WRITEFAIL = process.argv.includes('--break-writefail')

// appendActivationLine(dataDir, line) — the R6 event-plane telemetry writer.
// Append-only, size-bounded, fire-and-forget: at the 1 MiB bound the new line is
// DROPPED (never truncates/rewrites — dropping preserves append-only, REQ-17); a
// failed write is a stderr note, never a throw (REQ-16, hook stays non-fatal).
export function appendActivationLine(dataDir, line) {
  try {
    const serialized = JSON.stringify({ v: LOG_FORMAT_VERSION, ...line })
    const withNewline = serialized + '\n'
    const lineBytes = Buffer.byteLength(withNewline)
    const logPath = path.join(dataDir, ACTIVATION_LOG_NAME)
    let size = 0
    try {
      size = fs.statSync(logPath).size
    } catch {
      size = 0 // log absent → 0
    }
    if (!BREAK_BOUND && size + lineBytes > ACTIVATION_LOG_MAX_BYTES) {
      process.stderr.write('activation-log: size bound reached; dropping line\n')
      return { dropped: true } // REQ-17: drop, do NOT append (never truncate)
    }
    fs.appendFileSync(logPath, withNewline)
    return { dropped: false }
  } catch (e) {
    if (BREAK_WRITEFAIL) throw e // negative control only: prove the guard has teeth
    process.stderr.write(`activation-log: write failed (${e && e.message}); dropping line\n`)
    return { error: true } // REQ-16: fire-and-forget, never a hook failure
  }
}
