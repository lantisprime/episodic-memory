#!/usr/bin/env node
/**
 * validate-rfc-contract-mirror.mjs — CI gate for RFC-004 contract.json drift
 * (slice 2c, plan v4 §"Contract-mirror block").
 *
 * Diffs `docs/rfcs/RFC-004-bp1-auto-pilot.contract.json` against the code
 * surfaces it mirrors:
 *
 *   - `episode_canonical_fields` ↔ TYPE_SPECIFIC_CANONICAL_FIELDS in
 *     scripts/lib/bp1-canonicalize.mjs
 *   - `run_state_schemas.v2.states` ↔ VALID_V2_STATES in scripts/lib/bp1-run-state.mjs
 *   - `subcommand_contracts` ↔ scripts/bp1-orchestrator.mjs argv-parse logic
 *     (string-match on long-flag names)
 *   - C3 cross-check: every state value in v2.states (excluding the 5 v1-era
 *     terminal states) must have a matching `state-transition:<value>` entry
 *     in episode_canonical_fields.
 *
 * Exit 0 → contract matches code (silent ok in CI).
 * Exit 1 → drift detected; structured report printed to stdout.
 * Exit 2 → bad argv / can't find files.
 *
 * Usage: validate-rfc-contract-mirror.mjs [--repo <path>]
 *   Defaults --repo to repo root (parent of scripts/).
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..')

function parseArgs(argv) {
  const out = { repo: DEFAULT_REPO }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && i + 1 < argv.length) {
      out.repo = path.resolve(argv[++i])
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('usage: validate-rfc-contract-mirror.mjs [--repo <path>]\n')
      process.exit(0)
    } else {
      process.stderr.write(`unknown argv: ${argv[i]}\n`)
      process.exit(2)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const repoRoot = args.repo

const CONTRACT_PATH = path.join(repoRoot, 'docs', 'rfcs', 'RFC-004-bp1-auto-pilot.contract.json')
const CANON_PATH = path.join(repoRoot, 'scripts', 'lib', 'bp1-canonicalize.mjs')
const RUN_STATE_PATH = path.join(repoRoot, 'scripts', 'lib', 'bp1-run-state.mjs')
const ORCHESTRATOR_PATH = path.join(repoRoot, 'scripts', 'bp1-orchestrator.mjs')

const errors = []

function loadContract() {
  if (!fs.existsSync(CONTRACT_PATH)) {
    process.stderr.write(`error: contract.json not found at ${CONTRACT_PATH}\n`)
    process.exit(2)
  }
  try {
    return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'))
  } catch (e) {
    process.stderr.write(`error: contract.json parse failed: ${e.message}\n`)
    process.exit(2)
  }
}

async function loadCanonicalFields() {
  const url = new URL(`file://${CANON_PATH}`)
  const mod = await import(url.href)
  return mod.TYPE_SPECIFIC_CANONICAL_FIELDS
}

async function loadV2States() {
  const url = new URL(`file://${RUN_STATE_PATH}`)
  const mod = await import(url.href)
  return mod.VALID_V2_STATES
}

function setDiff(a, b) {
  return [...a].filter(x => !b.includes(x))
}

function checkCanonicalFields(contract, code) {
  // Check every subtype in contract.episode_canonical_fields matches code.
  for (const [subtype, contractFields] of Object.entries(contract.episode_canonical_fields)) {
    const codeFields = code[subtype]
    if (!codeFields) {
      errors.push(`canonical-fields: subtype "${subtype}" in contract.json but missing from TYPE_SPECIFIC_CANONICAL_FIELDS`)
      continue
    }
    const missingInCode = setDiff(contractFields, [...codeFields])
    const extraInCode = setDiff([...codeFields], contractFields)
    if (missingInCode.length > 0) {
      errors.push(`canonical-fields: subtype "${subtype}" contract has fields not in code: [${missingInCode.join(', ')}]`)
    }
    if (extraInCode.length > 0) {
      errors.push(`canonical-fields: subtype "${subtype}" code has fields not in contract: [${extraInCode.join(', ')}]`)
    }
  }
  // Reverse direction: subtypes the code declares that the contract doesn't
  // mirror. Limit to slice-2c-shape subtypes so we don't false-positive on
  // pre-slice-2c entries like 'state-transition:codex_review' / run-started /
  // evidence:* (those are documented in RFC §689-719 prose, not contract.json).
  const SLICE_2C_SUBTYPES_RE = /^(state-transition:(rfc-detected|classifier-dispatch-pending|classified|planning|needs-human)|failure:.+)$/
  for (const subtype of Object.keys(code)) {
    if (SLICE_2C_SUBTYPES_RE.test(subtype) && !contract.episode_canonical_fields[subtype]) {
      errors.push(`canonical-fields: code declares slice-2c subtype "${subtype}" but contract.json missing entry`)
    }
  }
}

function checkV2States(contract, codeStates) {
  const contractStates = contract.run_state_schemas?.v2?.states ?? []
  const missingInCode = setDiff(contractStates, [...codeStates])
  const extraInCode = setDiff([...codeStates], contractStates)
  if (missingInCode.length > 0) {
    errors.push(`v2-states: contract has states not in VALID_V2_STATES: [${missingInCode.join(', ')}]`)
  }
  if (extraInCode.length > 0) {
    errors.push(`v2-states: VALID_V2_STATES has states not in contract: [${extraInCode.join(', ')}]`)
  }
}

function checkSubcommandContracts(contract) {
  // String-match on the orchestrator's long-flag names. We don't parse the
  // argv-parse logic; we just check that every required arg appears as
  // `--flag` somewhere in the file. Drift detection, not full type-check.
  if (!fs.existsSync(ORCHESTRATOR_PATH)) {
    errors.push(`subcommand-contracts: orchestrator file not found at ${ORCHESTRATOR_PATH}`)
    return
  }
  const orchestratorSrc = fs.readFileSync(ORCHESTRATOR_PATH, 'utf8')
  for (const [subcmd, spec] of Object.entries(contract.subcommand_contracts)) {
    // Subcommand keyword must appear in the source.
    if (!orchestratorSrc.includes(`'${subcmd}'`) && !orchestratorSrc.includes(`"${subcmd}"`)) {
      errors.push(`subcommand-contracts: orchestrator missing subcommand keyword "${subcmd}"`)
    }
    for (const flag of spec.required_args ?? []) {
      if (!orchestratorSrc.includes(`'${flag}'`) && !orchestratorSrc.includes(`"${flag}"`)) {
        errors.push(`subcommand-contracts: orchestrator missing flag "${flag}" for subcommand "${subcmd}"`)
      }
    }
  }
}

function checkStateSubtypeConsistency(contract) {
  // Slice 2c plan v4 C3 — every state value in v2.states (minus v1-era
  // terminal states) MUST have a matching state-transition:<value> in the
  // canonical-fields table.
  const v1TerminalStates = ['active', 'complete', 'aborted', 'abandoned', 'archived']
  const v2States = contract.run_state_schemas?.v2?.states ?? []
  const transitionStates = v2States.filter(s => !v1TerminalStates.includes(s))
  for (const state of transitionStates) {
    const expectedKey = `state-transition:${state}`
    if (!contract.episode_canonical_fields[expectedKey]) {
      errors.push(`state-subtype-consistency: v2 state "${state}" has no matching "${expectedKey}" entry in episode_canonical_fields`)
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const contract = loadContract()
  const code = await loadCanonicalFields()
  const v2States = await loadV2States()
  checkCanonicalFields(contract, code)
  checkV2States(contract, v2States)
  checkSubcommandContracts(contract)
  checkStateSubtypeConsistency(contract)
  if (errors.length > 0) {
    process.stdout.write(JSON.stringify({
      status: 'drift',
      contract_path: CONTRACT_PATH,
      error_count: errors.length,
      errors,
    }, null, 2) + '\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({ status: 'ok', contract_path: CONTRACT_PATH }) + '\n')
  process.exit(0)
}

main().catch(e => {
  process.stderr.write(`internal error: ${e.stack || e.message}\n`)
  process.exit(2)
})
