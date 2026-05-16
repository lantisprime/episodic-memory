#!/usr/bin/env node
// check-automode-defaults.mjs
//
// Diff Claude Code's autoMode defaults against the effective config.
// Fails (or warns, with --warn) if the effective config has fewer entries
// than the defaults — signal that custom rules silently replaced stock
// protections.
//
// Background: custom autoMode.{allow,soft_deny,hard_deny,environment}
// arrays in settings.json REPLACE defaults per-key, not merge per-entry.
// Adding one custom hard_deny rule without re-including stock defaults
// silently disables Data Exfiltration + Safety-Check Bypass protections.
//
// Lesson: 20260516-000611-custom-automode-rules-in-claude-code-set-7e62

import { execFileSync } from 'node:child_process'

const KEYS = ['allow', 'soft_deny', 'hard_deny', 'environment']

function readJsonFromClaude(subcommand) {
  try {
    const out = execFileSync('claude', ['auto-mode', subcommand], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(out)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null  // claude CLI not installed; skip gracefully
    }
    throw new Error(`claude auto-mode ${subcommand} failed: ${err.message}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  const warnOnly = argv.includes('--warn')

  const defaults = readJsonFromClaude('defaults')
  const effective = readJsonFromClaude('config')

  if (!defaults || !effective) {
    console.log('skip: claude CLI not available')
    process.exit(0)
  }

  const issues = []
  for (const key of KEYS) {
    const defaultEntries = defaults[key] || []
    const effectiveEntries = effective[key] || []
    const effectiveSet = new Set(effectiveEntries)
    const missing = defaultEntries.filter(d => !effectiveSet.has(d))
    // Predicate: ANY default missing from effective config = drift.
    // Count alone (effCount < defCount) is insufficient — equal-count
    // SUBSTITUTION (default replaced by a different rule) would false-pass.
    // Codex r1 finding P1.1 (20260516-002119-...-e1a5).
    if (missing.length > 0) {
      issues.push({
        key,
        defaults_count: defaultEntries.length,
        effective_count: effectiveEntries.length,
        missing,
      })
    }
  }

  if (issues.length === 0) {
    console.log('ok: all autoMode defaults present in effective config')
    process.exit(0)
  }

  console.log(JSON.stringify({ status: 'drift', issues }, null, 2))
  console.error('')
  console.error(`autoMode defaults dropped from effective config — ${issues.length} key(s) affected.`)
  console.error('Custom autoMode rules REPLACE defaults per-key, not merge.')
  console.error('Fix: include stock defaults verbatim alongside custom rules in settings.json.')
  console.error('Lesson: 20260516-000611-custom-automode-rules-in-claude-code-set-7e62')

  process.exit(warnOnly ? 0 : 1)
}

main()
