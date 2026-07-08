#!/usr/bin/env node
/**
 * validate-rfc-009-contract-mirror.mjs — CI gate for RFC-009 contract.json drift
 * (P1b S8, REQ-19).
 *
 * A SIBLING of validate-rfc-contract-mirror.mjs (which is hardcoded to RFC-004
 * — verified at plan time; this validator follows its pattern rather than
 * editing it). Diffs `docs/rfcs/RFC-009-lesson-activation.contract.json`
 * against the code + data surfaces it mirrors:
 *
 *   - activation_flags        ↔ string-match on the long-flag literals in
 *                               em-store / em-revise / em-violation source
 *   - activation_fields       ↔ ACTIVATION_ARRAY_FIELDS + ACTIVATION_SCALAR_FIELDS
 *                               (+ the T6 `violated_pattern` scalar) in lib/activation.mjs
 *   - tool_ids                ↔ TOOL_IDS in lib/activation.mjs
 *   - activity_classes        ↔ activation-classes.json class names
 *   - trigger_index_shape     ↔ em-trigger-index.mjs exported schema constants
 *                               + parseTriggerKind's actual returns (functional)
 *
 * Exit 0 → contract matches code (silent ok in CI).
 * Exit 1 → drift detected; structured report printed to stdout.
 * Exit 2 → bad argv / can't find files.
 *
 * Usage: validate-rfc-009-contract-mirror.mjs [--repo <path>] [--contract <path>]
 *   --contract overrides the contract file (tests plant drifted copies).
 *
 * Zero deps; Node stdlib only.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, '..')

function parseArgs(argv) {
  const out = { repo: DEFAULT_REPO, contract: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && i + 1 < argv.length) {
      out.repo = path.resolve(argv[++i])
    } else if (argv[i] === '--contract' && i + 1 < argv.length) {
      out.contract = path.resolve(argv[++i])
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('usage: validate-rfc-009-contract-mirror.mjs [--repo <path>] [--contract <path>]\n')
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
const CONTRACT_PATH = args.contract || path.join(repoRoot, 'docs', 'rfcs', 'RFC-009-lesson-activation.contract.json')

const errors = []

function loadJson(p, label) {
  if (!fs.existsSync(p)) {
    process.stderr.write(`error: ${label} not found at ${p}\n`)
    process.exit(2)
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    process.stderr.write(`error: ${label} parse failed: ${e.message}\n`)
    process.exit(2)
  }
}

function setDiff(a, b) {
  return [...a].filter(x => !b.includes(x))
}
function diffBoth(label, contractList, codeList) {
  const notInCode = setDiff(contractList, codeList)
  const notInContract = setDiff(codeList, contractList)
  if (notInCode.length) errors.push(`${label}: contract has entries not in code/data: [${notInCode.join(', ')}]`)
  if (notInContract.length) errors.push(`${label}: code/data has entries not in contract: [${notInContract.join(', ')}]`)
}

function checkActivationFlags(contract) {
  // String-match on the long-flag literals (drift detection, not a type-check —
  // the RFC-004 checkSubcommandContracts pattern).
  for (const [script, flags] of Object.entries(contract.activation_flags ?? {})) {
    const p = path.join(repoRoot, 'scripts', `${script}.mjs`)
    if (!fs.existsSync(p)) {
      errors.push(`activation-flags: script "${script}" not found at ${p}`)
      continue
    }
    const src = fs.readFileSync(p, 'utf8')
    for (const f of flags) {
      if (!src.includes(`'${f}'`) && !src.includes(`"${f}"`)) {
        errors.push(`activation-flags: ${script}.mjs missing flag literal "${f}"`)
      }
    }
  }
}

async function main() {
  const contract = loadJson(CONTRACT_PATH, 'contract.json')

  const activationLib = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'activation.mjs')).href)
  const triggerIndex = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'em-trigger-index.mjs')).href)
  const classesDoc = loadJson(path.join(repoRoot, 'activation-classes.json'), 'activation-classes.json')

  checkActivationFlags(contract)

  const codeFields = [...activationLib.ACTIVATION_ARRAY_FIELDS, ...activationLib.ACTIVATION_SCALAR_FIELDS, 'violated_pattern']
  diffBoth('activation-fields', contract.activation_fields ?? [], codeFields)

  diffBoth('tool-ids', contract.tool_ids ?? [], activationLib.TOOL_IDS)

  diffBoth('activity-classes', contract.activity_classes ?? [], classesDoc.classes.map(c => c.name))

  const shape = contract.trigger_index_shape ?? {}
  if (shape.schema_version !== triggerIndex.TRIGGER_INDEX_SCHEMA_VERSION) {
    errors.push(`trigger-index-shape: schema_version contract=${shape.schema_version} code=${triggerIndex.TRIGGER_INDEX_SCHEMA_VERSION}`)
  }
  diffBoth('trigger-index-entry-fields', shape.entry_fields ?? [], triggerIndex.TRIGGER_ENTRY_FIELDS)
  diffBoth('trigger-kind-enum', shape.trigger_kind_enum ?? [], triggerIndex.TRIGGER_KIND_ENUM)
  // Functional cross-check: the enum members are what parseTriggerKind actually returns.
  const observed = [
    activationLib.parseTriggerKind('plain phrase value'),
    activationLib.parseTriggerKind('tool:Bash:git*'),
    activationLib.parseTriggerKind('activity:plan'),
  ]
  for (const kind of observed) {
    if (!(shape.trigger_kind_enum ?? []).includes(kind)) {
      errors.push(`trigger-kind-enum: parseTriggerKind returns "${kind}" which the contract enum does not carry`)
    }
  }

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
