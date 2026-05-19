#!/usr/bin/env node
/**
 * bp1-auto-stub.mjs — /bp1-auto slash command stub (RFC-004 §195).
 *
 * Slice 2f registers the slash command shape in .claude-plugin/plugin.json so
 * the artifact-version-hash filter (scripts/lib/bp1-manifest.mjs:124) captures
 * it deterministically. The stub itself prints a clear inert-mode message and
 * exits non-zero so an operator who invokes it before M5 ships gets a loud,
 * actionable error rather than a silent no-op.
 *
 * Behavior:
 *   - No flag mutation, no state read, no episode emission.
 *   - Print one-line inert notice to stderr + RFC pointer.
 *   - Exit 2.
 *
 * M5 will replace this entry point with the real /bp1-auto wrapper that
 * dispatches the orchestrator. Until then, the slot is registered + listable
 * + emits a clear "not yet active" message.
 */
'use strict'

process.stderr.write(
  'bp1-auto: BP-1 auto-pilot inert. M5 (cleanup + wiring + ACTIVATION) has not yet shipped.\n' +
  'See docs/rfcs/RFC-004-bp1-auto-pilot.md §195 (gated artifacts table) and §1736 (M5 milestone).\n' +
  'To check activation status for the current project: node scripts/bp1-flag-check.mjs --project <root>\n')
process.exit(2)
