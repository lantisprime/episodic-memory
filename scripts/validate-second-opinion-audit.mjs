#!/usr/bin/env node
/**
 * validate-second-opinion-audit.mjs — Drift validator for the
 * reader-canonicalization audit table (Rule 14: docs prose rots silently;
 * a failing CI step doesn't).
 *
 * Asserts every `verifying_paths` entry in audit-table.mjs exists in the
 * repo. Run from repo root:
 *
 *   node scripts/validate-second-opinion-audit.mjs
 *
 * Exits 0 if all paths exist; non-zero with JSON listing missing paths
 * otherwise.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AUDIT_TABLE, listAllVerifyingPaths }
  from './second-opinion/lib/audit-table.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const verifyingPaths = listAllVerifyingPaths()
const missing = []
for (const rel of verifyingPaths) {
  const abs = path.join(REPO_ROOT, rel)
  if (!fs.existsSync(abs)) missing.push(rel)
}

if (missing.length > 0) {
  console.log(JSON.stringify({
    status: 'error',
    code: 'audit-table-drift',
    message: `Audit table references ${missing.length} path(s) that do not exist; update audit-table.mjs or restore missing files`,
    missing,
    repo_root: REPO_ROOT,
  }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({
  status: 'ok',
  message: `Audit table validated: all ${verifyingPaths.length} verifying paths exist`,
  rows: AUDIT_TABLE.rows.length,
  paths_checked: verifyingPaths.length,
}))
