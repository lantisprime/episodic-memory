#!/usr/bin/env node
/**
 * deploy-audit.mjs — authoritative, UNFILTERED post-merge deploy verification.
 *
 * WHY THIS EXISTS (2026-06-19, RFC-008 P4d S4 follow-up): `tools/migration-cutover.mjs`
 * verifies the global install against the install MANIFEST — but the manifest only
 * lists the `.mjs` substrate closure (em-* + second-opinion + their lib closure), so a
 * cutover pass is STRUCTURALLY BLIND to any other file class. When install logic
 * narrows over time (e.g. the S2 denylist→allowlist flip, or dropping a `.sh`/`.tmpl`
 * copy), files deployed by the OLD logic persist in `~/.episodic-memory/` as stale
 * orphans the cutover cannot see. "Cutover 37/37" rounded up to "global is clean" hid
 * 4 stale `.sh`/`.tmpl` orphans from a pre-allowlist install.
 *
 * The fix the deploy lesson (feedback_deploy_hooks_global_after_merge) actually asks
 * for: a clean install + UNFILTERED stale sweep across ALL classes. This tool does
 * exactly that — a clean install into a throwaway HOME (via the canonical
 * activation-scoping harness, so it inherits the env-scrub that keeps the audit
 * honest), then a byte-diff of EVERY file in the four global-deployed dirs:
 *
 *   MISSING  in a clean install, ABSENT from real global → an update never deployed
 *   DIFFER   present in both, bytes differ                → real global is stale
 *   EXTRA    in real global, NOT in a clean install       → orphan / stale leftover
 *
 * REPORT-ONLY by design. It never deletes: an "orphan" can be a feature file whose
 * consumers must be traced first (the S4 follow-up found `render-input-validation.sh`
 * looked prunable but is the launchd-routines install-time validator — confirm the
 * live consumers before removing). Pruning stays a deliberate, investigated action.
 *
 * Inherently a LOCAL/ops tool (it audits the developer's real ~/.episodic-memory and
 * ~/.claude/hooks); NOT a CI test — CI has no real global to audit.
 *
 * Usage:
 *   node tools/deploy-audit.mjs            # audit real $HOME against a clean install
 *   node tools/deploy-audit.mjs --json     # machine-readable
 *   node tools/deploy-audit.mjs --help
 *
 * Exit 0 if clean (MISSING=DIFFER=EXTRA=0), 1 if drift, 2 on harness/install failure.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkMock, runInstall } from '../tests/lib/activation-scoping-harness.mjs'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 46).join('\n').replace(/^\/\*\*?|\*\/$|^ \* ?/gm, ''))
  process.exit(0)
}
const JSON_OUT = argv.includes('--json')

// The four dirs a clean `--install-hooks --install-second-opinion` populates in GLOBAL
// scope. Per-project artifacts (<project>/.claude/hooks/…) are out of scope by design.
const DIRS = [
  '.episodic-memory/scripts',
  '.episodic-memory/patterns',
  '.episodic-memory/plugins',
  '.claude/hooks',
]
// User-owned files a clean install never writes — legitimately present, never "extra".
const IGNORE_EXTRA = new Set(['.claude/hooks/compound-bash-gate.sh'])
// Files whose ONLY per-install variance is a non-semantic field (install_timestamp);
// the content hash (source_hash) is install-invariant. A byte DIFFER here is cosmetic.
const COSMETIC_DIFFER = new Set(['.claude/hooks/second-opinion-providers.json'])

function walk(root) {
  const out = []
  const rec = (d, rel) => {
    let es
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) rec(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  rec(root, '')
  return out.sort()
}
const byteEqual = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)) } catch { return false } }
// A COSMETIC_DIFFER is cosmetic ONLY when the SOLE difference is the non-semantic
// `install_timestamp` — a real `source_hash` (provider-registry) change must still
// surface as DIFFER, never be swallowed (review F1). Unparseable → treat as real DIFFER.
function snapshotDiffIsOnlyTimestamp(realPath, mockPath) {
  try {
    const a = JSON.parse(fs.readFileSync(realPath, 'utf8'))
    const b = JSON.parse(fs.readFileSync(mockPath, 'utf8'))
    delete a.install_timestamp; delete b.install_timestamp
    return JSON.stringify(a) === JSON.stringify(b)
  } catch { return false }
}

const REAL = os.homedir()
const M = mkMock('deploy-audit')
const r = runInstall({
  home: M.home, project: M.project, callerCwd: M.callerCwd,
  flags: ['--install-hooks', '--install-hooks-force', '--install-second-opinion'],
})
if (r.status !== 0) {
  console.error(`deploy-audit: clean mock install failed (status=${r.status})\n${(r.stderr || '').slice(-800)}`)
  process.exit(2)
}

const findings = { missing: [], differ: [], cosmetic: [], extra: [] }
for (const d of DIRS) {
  const mockDir = path.join(M.home, d)
  const realDir = path.join(REAL, d)
  const mockFiles = walk(mockDir)
  const realSet = new Set(walk(realDir))
  const mockSet = new Set(mockFiles)
  for (const f of mockFiles) {
    const key = `${d}/${f}`
    if (!realSet.has(f)) { findings.missing.push(key); continue }
    const rp = path.join(realDir, f), mp = path.join(mockDir, f)
    if (!byteEqual(rp, mp)) {
      if (COSMETIC_DIFFER.has(key) && snapshotDiffIsOnlyTimestamp(rp, mp)) findings.cosmetic.push(key)
      else findings.differ.push(key)
    }
  }
  for (const f of walk(realDir)) {
    const key = `${d}/${f}`
    if (!mockSet.has(f) && !IGNORE_EXTRA.has(key)) findings.extra.push(key)
  }
}

const drift = findings.missing.length + findings.differ.length + findings.extra.length
if (JSON_OUT) {
  console.log(JSON.stringify({ clean: drift === 0, ...findings }, null, 2))
} else {
  for (const k of findings.missing) console.log(`  MISSING  ${k}  (an update never deployed)`)
  for (const k of findings.differ) console.log(`  DIFFER   ${k}  (real global is stale)`)
  for (const k of findings.extra) console.log(`  EXTRA    ${k}  (orphan — TRACE consumers before pruning)`)
  for (const k of findings.cosmetic) console.log(`  (info)   ${k}  cosmetic DIFFER (install_timestamp only; content current)`)
  console.log(`\nMISSING=${findings.missing.length}  DIFFER=${findings.differ.length}  EXTRA=${findings.extra.length}` +
    (findings.cosmetic.length ? `  (+${findings.cosmetic.length} cosmetic, ignored)` : ''))
  console.log(drift === 0
    ? 'CLEAN — real global == authoritative clean install.'
    : 'DRIFT — fix MISSING/DIFFER via `node install.mjs --tool claude-code --install-hooks --install-hooks-force --install-second-opinion`; investigate EXTRA before pruning.')
}
process.exit(drift === 0 ? 0 : 1)
