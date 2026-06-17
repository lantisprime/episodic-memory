#!/usr/bin/env node
/**
 * enforce-contract.mjs — Enforcement thin-waist (RFC-008 P3b, R1).
 *
 * P3b-1 scope: the `stop` gate decision, RELOCATED VERBATIM from em-recall.mjs's
 * `--gate stop` handler into the enforcement layer. This is the R1 strong-form
 * correction — the memory substrate (em-store / em-recall / em-search) MUST own
 * ZERO enforcement code (RFC-008:83,85); em-recall's surviving `--gate stop`
 * handler is the last violator and is DELETED in P3d once this consumer migrates.
 *
 * The claude-code stop decision is purely marker-state (RFC-008:464 — "the `stop`
 * gate is NOT per-label … it reads marker state, not command labels"). P3b-2 adds
 * the contract-driven effective-tier layer ON TOP of that marker logic:
 * effective_tier(stop) = min(harness_cap[stop], contract.stop.tier, config.<bp>.stop)
 * over the base-STRONG fold (scripts/lib/effective-tier.mjs). decideStop stays
 * PURE (no I/O — F-NEW-3) and receives the resolved effective stop tier as a
 * param; the tier RESOLUTION (registry/contract/config reads across the two roots)
 * and the M4 downgrade notice are I/O confined to the CLI boundary below.
 *
 * The anti-fail-open invariant (B1): default-STRONG / clamp-only-on-success. Every
 * tier source the boundary cannot resolve (missing contract root, missing
 * `plugins/_index.json`, absent/broken config) is passed as `null` and folded as
 * NO clamp — the base stays STRONG, i.e. today's unconditional refuse. A
 * resolution failure can therefore NEVER weaken the gate. enforce-contract changes
 * observable behavior ONLY when a project's enforce-config.json explicitly clamps
 * `stop` below STRONG (or sets `active:false`). See docs/rfcs/RFC-008/P3-thin-waist.md.
 *
 * Live wiring this slice = the stop gate ONLY (the `stop.tier` root-level
 * marker-state gate, F-NEW-1). The three `gates.*` classification gates resolve at
 * pre_tool_use and are DEFERRED (bash plan-gate.sh/checkpoint-gate.sh ↔ node
 * bridge, a later slice). CLASS-C(b) — the out-of-vocab F3 writer
 * (scripts/lib/structured-alert.mjs) — ships LIBRARY-ONLY (B2): the stop gate is
 * label-independent, so there is no live out-of-vocab site this slice.
 *
 * With NO enforce-config.json (or active:true, no clamps) behavior is
 * byte-identical to `em-recall --gate stop` — stdout, exit code, stderr (modulo
 * the script-name prefix), and no marker side-effects — proven by
 * tests/test-enforce-contract.mjs (parity suite vs em-recall + three-axis
 * inertness on contract-resolution failure).
 *
 * Marker reads are owned by scripts/lib/marker-state.mjs (the R1-owned reader
 * extracted in P3a). This module performs ZERO marker logic of its own — it only
 * orchestrates the marker-state helpers into the stop decision.
 */

import fs from 'fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from './lib/local-dir.mjs'
import {
  BASELINE_NAME,
  writeMarkerPath,
  namespacedMarkerBasenameForSession,
} from './lib/marker-paths.mjs'
import {
  _maxMtimeAcrossRootsStrict,
  _maxMtimeAcrossRootsForPlanMarkerStrict,
  resolveOwnSessionMarkerRead,
  stopGateCarveOutApplies,
} from './lib/marker-state.mjs'
import { validateSessionId } from './lib/session-id.mjs'
import { validateInstance } from './lib/json-instance-validate.mjs'
import {
  TIER_RANK,
  clampTier,
  effectiveTierStrong,
  eventActionId,
} from './lib/effective-tier.mjs'

// The harness this enforcement layer runs for (stop-gate.sh is the claude-code
// hook). The contract this layer governs is bp-001 (standard impl workflow).
const THIS_HARNESS = 'claude-code'
const BP_ID = 'bp-001'

/**
 * decideStop — pure stop-gate decision (no I/O, no process exit).
 *
 * Relocated VERBATIM from em-recall.mjs:141-217 (R1). em-recall's handler had
 * three terminal control-flow points; all translate to a `return` here so the
 * function is pure and the CLI wrapper is the sole I/O boundary:
 *   em-recall:182 process.exit(0)  → return null                  (plan-pending allow)
 *   em-recall:211 console.log({…})  → return {decision,reason}     (block)
 *   em-recall:216 process.exit(0)  → return null                  (carve-out / no-marker allow)
 *
 * @param {{repoRoot: string, sid: string|null, stopTier?: string}} opts
 *   repoRoot — the gate root (caller resolves via resolveRepoRoot() from cwd, the
 *              same module-load semantics as em-recall.mjs:48; stop-gate.sh `cd`s
 *              to the hook input `.cwd` before spawning, so cwd IS the project).
 *   sid      — validated own-session id, or null (legacy-literal-only mode).
 *   stopTier — the resolved effective stop tier (F-NEW-3). 'STRONG' (default, and
 *              the no-clamp case) ⇒ refuse_stop semantics: today's marker logic.
 *              A successfully-resolved operator clamp to 'MEDIUM'/'WEAK' DEGRADES
 *              the refuse ⇒ allow stop (return null). Default 'STRONG' keeps the
 *              em-recall parity proof byte-identical: a caller that passes no tier
 *              gets exactly today's behavior. This is the function's only pure
 *              extension — tier RESOLUTION + the M4 notice are the CLI's job.
 * @returns {{decision:'block', reason:string} | null}  null = allow stop.
 */
export function decideStop({ repoRoot, sid, stopTier = 'STRONG' }) {
  // Effective stop tier below STRONG ⇒ the refuse is degraded (warn at MEDIUM,
  // unsupported at WEAK) by a deliberate operator clamp ⇒ allow the stop. Reached
  // ONLY via a successfully-resolved enforce-config.json clamp; a resolution
  // failure leaves the boundary's fold at STRONG, so this never fires by accident.
  // The CLI boundary emits the M4 audit notice whenever a config clamp lowers the
  // tier, so the degrade is never silent. (events.json maps stop MEDIUM→`warn`;
  // for claude-code MEDIUM is reachable ONLY via that config path — which is
  // already M4-logged — so the bare allow here is not an unlogged warn-drop.)
  if (stopTier !== 'STRONG') return null

  // #178 F1: defer stop-gate when plan is ACTIVELY pending at EITHER root.
  // The plan-gate blocks Write/Bash while .plan-approval-pending exists at
  // either root, creating an unrecoverable triangle when stop-gate ALSO
  // blocks. The exemption narrows to ACTIVE plan-pending only (mtime >
  // baseline) — orphan plan-pending falls through to the existing carve-out.
  //
  // Strict-lstat semantics via _maxMtimeAcrossRootsStrict (codex round-3 F11
  // + round-6 F17): ENOENT skips; any other lstat error (EACCES, ENOTDIR,
  // EIO, ELOOP) → hadOtherError → fail closed. Symlink at EITHER root → fail
  // closed (same-class with carve-out symmetric defense).
  //
  // Dual-root semantics (codex round-2 F8): plan-pending and baseline are BOTH
  // evaluated across primary and legacy.
  //
  // #268 fix E19: plan-pending deferral fires for ANY plan-marker variant
  // (legacy literal OR any suffixed) — own session or other.
  const planPending = _maxMtimeAcrossRootsForPlanMarkerStrict(repoRoot)
  const baseStrict = _maxMtimeAcrossRootsStrict(repoRoot, BASELINE_NAME)
  if (
    planPending.anyExisted && !planPending.hadSymlink && !planPending.hadOtherError &&
    baseStrict.anyExisted && !baseStrict.hadSymlink && !baseStrict.hadOtherError &&
    planPending.mtime > baseStrict.mtime
  ) {
    return null // em-recall:182 process.exit(0)
  }

  // Rank-2: session-aware reads. Resolution order for each quartet member:
  //   1. <root>/.checkpoints/<name>.<sid>   2. <root>/.claude/<name>.<sid>
  //   3. <root>/.checkpoints/<name>         4. <root>/.claude/<name>
  // When sid is null (invalid/missing), only steps 3-4 are checked (graceful
  // degrade per codex R2 Q3). Other sessions' suffixed markers are NOT probed.
  const preReqPath = resolveOwnSessionMarkerRead(repoRoot, '.checkpoint-required', sid)
  const postDonePath = resolveOwnSessionMarkerRead(repoRoot, '.post-checkpoint-done', sid)
  let postDoneSize = 0
  if (postDonePath) {
    try { postDoneSize = fs.statSync(postDonePath).size } catch {}
  }
  if (preReqPath && postDoneSize === 0) {
    if (!stopGateCarveOutApplies(repoRoot, sid)) {
      // Block-message path: emit suffixed write path when sid is valid; legacy
      // literal otherwise. Agent's block-write goes to the suffixed path.
      const writeBasename = sid
        ? namespacedMarkerBasenameForSession('.post-checkpoint-done', sid)
        : '.post-checkpoint-done'
      const writePath = writeMarkerPath(repoRoot, writeBasename)
      const reason = `Post-implementation checkpoint required. Write the Rule 18 post-implementation checkpoint block to ${writePath} (must be non-empty), then end your turn again. Hook: stop-gate.sh.`
      return { decision: 'block', reason } // em-recall:211 console.log
    }
    // else: carve-out applies — allow (return null below).
  }
  // Otherwise: allow stop. Empty stdout on Stop = allow Claude to stop.
  return null // em-recall:216 process.exit(0)
}

// ---------------------------------------------------------------------------
// Tier-resolution helpers (the CLI boundary's I/O — F-NEW-3). Each reads a
// contract artifact and degrades to null/identity on ANY failure (B1: a
// resolution miss is never a lowering value, never a silent-allow).
// ---------------------------------------------------------------------------

function realpathOrNull(p) {
  try { return fs.realpathSync(p) } catch { return null }
}

function readJsonSafe(abs) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')) } catch { return null }
}

/**
 * Resolve the CONTRACT root — where patterns/{bp-001,events,enforce-config.schema}
 * + plugins/_index.json live. Mirrors P3c's classifier candidate PATTERN (two
 * candidates, sentinel-gated, realpath round-trip) but with enforce-contract's OWN
 * depth: this module sits at scripts/, so the in-repo contract root is ONE level
 * up (B3 — copying P3c's 4-level climb would climb above $HOME and reborn the
 * ambient-parent-read bug P3c fixed). Returns an absolute path or null.
 *
 * Candidate 1 — global install root ($HOME/.episodic-memory == install GLOBAL_DIR,
 * os.homedir() with no env indirection, P3c root parity), accepted iff the
 * deployed bp-001 contract is present there.
 * Candidate 2 — the depth-1 in-repo root, accepted ONLY when it PROVES it is the
 * repo copy: repo sentinels present AND the climbed enforce-contract path
 * round-trips back to THIS module (an installed-layout module must not read an
 * ambient parent's patterns/).
 */
export function resolveContractRoot() {
  const c1 = path.join(os.homedir(), '.episodic-memory')
  if (fs.existsSync(path.join(c1, 'patterns', 'bp-001.json'))) {
    return realpathOrNull(c1) || c1
  }
  // Candidate 2 is DEV/CI-ONLY by construction: the installed layout never
  // satisfies it. taxonomy.schema.json (sentinel below) is NOT deployed to the
  // global root (install.mjs ships taxonomy.json + the contract set, not the
  // *.schema.json), so an installed module's depth-1 climb fails the first
  // sentinel and falls through to candidate-1 / null (fail-closed STRONG). The
  // realpath round-trip additionally pins candidate-2 to THIS module's own
  // location, so it can never read an ambient parent's patterns/ (B3; regression:
  // test-enforce-contract section D "ambient grandparent").
  const selfReal = realpathOrNull(fileURLToPath(import.meta.url))
  if (!selfReal) return null
  const selfDir = path.dirname(selfReal) // <root>/scripts
  const climbed = realpathOrNull(path.resolve(selfDir, '..')) // <root>
  if (!climbed) return null
  // (a) repo sentinels at the climbed root.
  if (!fs.existsSync(path.join(climbed, 'patterns', 'taxonomy.schema.json'))) return null
  if (!fs.existsSync(path.join(climbed, 'scripts', 'em-store.mjs'))) return null
  // (b) the climbed enforce-contract path round-trips back to THIS module.
  const rpClimbed = realpathOrNull(path.join(climbed, 'scripts', 'enforce-contract.mjs'))
  if (!rpClimbed || rpClimbed !== selfReal) return null
  return climbed
}

/**
 * The harness capability tier for `event` from the plugin registry. M8: more than
 * one ACTIVE enforcement entry binding the same harness ⇒ { duplicate:true } (the
 * caller fail-closes with a REAL block — R6 one-harness-one-plugin). Zero matches
 * ⇒ { tier:null } (B1 — a missing/inactive binding inside an already-firing hook
 * is a corrupted install, NOT "no plugin"; it leaves the gate at base-STRONG, it
 * NEVER degrades to allow).
 */
export function resolveHarnessCap(registry, harness, event = 'stop') {
  const plugins = Array.isArray(registry && registry.plugins) ? registry.plugins : []
  const matches = plugins.filter(
    (p) => p && p.type === 'enforcement' && p.status === 'active' && p.harness === harness,
  )
  if (matches.length > 1) return { tier: null, duplicate: true, count: matches.length }
  if (matches.length === 0) return { tier: null, duplicate: false, count: 0 }
  const caps = matches[0].capabilities
  const tier = caps && typeof caps[event] === 'string' ? caps[event] : null
  return { tier, duplicate: false, count: 1 }
}

/**
 * Load the per-project enforce-config.json from the MARKER root (NOT the contract
 * root — §6 two-root split). The `schema` is the deployed enforce-config schema
 * (read from the contract root by the caller); null when no contract is deployed.
 *
 * M2 fail-OPEN audit (the load-bearing safety class): EVERY error branch lands in
 * ONE stay-STRONG sink — returns the IDENTITY clamp { active:true, bps:{} } so a
 * broken/hostile/absent file can never WEAKEN a gate. Enumerated branches: (0) no
 * schema; (1) file absent (ENOENT); (2) read error (EACCES/EISDIR); (3) JSON.parse
 * throws; (4) parses but not a plain object (array/null/scalar); (5) schema-invalid;
 * (6) TOCTOU — read ONCE (no stat-then-read). A schema-VALID config is honored
 * (M4 observability for a real downgrade is the CLI boundary's job).
 */
export function loadEnforceConfig(markerRoot, schema, { readFileSync = fs.readFileSync } = {}) {
  const identity = { active: true, bps: {} }
  if (!schema) return identity // (0) no deployed schema → cannot validate → fail-closed
  const configPath = path.join(markerRoot, '.episodic-memory', 'enforce-config.json')
  let raw
  try { raw = readFileSync(configPath, 'utf8') } catch { return identity } // (1)/(2)/(6)
  let parsed
  try { parsed = JSON.parse(raw) } catch { return identity } // (3)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return identity // (4)
  let valid
  try { valid = validateInstance(parsed, schema).valid } catch { return identity } // schema crash → fail-closed
  if (!valid) return identity // (5)
  const active = parsed.active === undefined ? true : parsed.active
  const bps = {}
  for (const [k, v] of Object.entries(parsed)) { if (k === 'active') continue; bps[k] = v }
  return { active, bps }
}

/**
 * PR-level review PR-2 (R3/R5 observability): the M4/R5 downgrade NOTICES go to
 * stderr, which the production stop hook (stop-gate.sh) discards via `2>/dev/null`
 * — so a deliberate operator downgrade would otherwise leave NO durable trace.
 * Persist a one-line audit record to disk under the MARKER root (where
 * enforce-config.json lives), a channel the hook cannot suppress, so "a downgrade
 * of the project's strongest gate is always auditable" (M4) holds in prod. The
 * stderr notice is kept too (useful in dev/interactive). BEST-EFFORT: an audit
 * write failure must NEVER break the gate decision (B1 — observability is not on
 * the safety path).
 */
function appendEnforceAudit(markerRoot, line) {
  try {
    const dir = path.join(markerRoot, '.episodic-memory')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'enforce-audit.log'), `${new Date().toISOString()} ${line}\n`)
  } catch { /* best-effort; never block the gate on an audit write */ }
}

// ---------------------------------------------------------------------------
// CLI — the ONLY I/O + process.exit boundary. Invoked by hooks/stop-gate.sh as
// `node enforce-contract.mjs --gate stop [--session-id <sid>]`. Empty stdout =
// allow; `{decision:"block", reason}` = block. process.exit(0) on every decision
// path (exit-code parity with em-recall — a non-zero block would trip
// stop-gate.sh's `|| {block}` envelope and double-emit).
// ---------------------------------------------------------------------------
// Robust main-module detection. A plain `import.meta.url === pathToFileURL(argv[1])`
// compare FAILS when the install path contains a symlink component (macOS
// /var→/private/var, /tmp→/private/tmp, a symlinked $HOME or .episodic-memory):
// import.meta.url is canonical while pathToFileURL(argv[1]) is not, so isMain
// would be false, the CLI block would silently no-op, and the stop gate would
// degrade to allow-always — a fail-OPEN bug. realpath BOTH sides so a symlinked
// install path still resolves as main. (Caught by test-stop-gate.sh's
// /var/folders fixture during P3b-1 E2E; pinned by test-enforce-contract.mjs
// "CLI via symlinked path".)
const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf(name)
    if (i === -1 || i + 1 >= argv.length) return undefined
    return argv[i + 1]
  }

  const VALID_GATES = ['stop']
  const gateFlag = flag('--gate')
  if (gateFlag !== 'stop') {
    const got = gateFlag === undefined ? 'none' : `"${gateFlag}"`
    console.log(JSON.stringify({ status: 'error', message: `enforce-contract: --gate stop is required (got ${got}). Valid gates: ${VALID_GATES.join(', ')}` }))
    process.exit(1)
  }

  // --session-id parse + validate — verbatim semantics from em-recall.mjs:78-86.
  // Missing/invalid → legacy-literal-only mode (hook reliability outweighs strict
  // contract per codex R2 Q3). The stderr warning is reproduced verbatim with the
  // script-name prefix retargeted (the only allowed parity delta vs em-recall).
  const sessionIdFlag = flag('--session-id')
  let mySid = null
  if (sessionIdFlag !== undefined) {
    if (sessionIdFlag !== '' && validateSessionId(sessionIdFlag)) {
      mySid = sessionIdFlag
    } else if (sessionIdFlag !== '') {
      process.stderr.write(`enforce-contract: warn — --session-id "${sessionIdFlag}" failed validateSessionId; legacy-literal-only mode\n`)
    }
  }

  // Gate root resolved from cwd (em-recall.mjs:48 parity). stop-gate.sh `cd`s to
  // the hook input `.cwd` before spawning, so this converges with the project the
  // hook named (closes #106 worktree-orphan for this gate). This is the MARKER
  // root (where .checkpoints/ + .episodic-memory/enforce-config.json live).
  const markerRoot = resolveRepoRoot()

  // M5 — resolve BOTH roots ONCE at entry; thread them through; no path is
  // re-resolved mid-invocation (axis-6 TOCTOU hardening). The contract root is the
  // module-relative/global root (§6); reads degrade to null on any miss (B1).
  const contractRoot = resolveContractRoot()
  const registry = contractRoot ? readJsonSafe(path.join(contractRoot, 'plugins', '_index.json')) : null
  const contractDoc = contractRoot ? readJsonSafe(path.join(contractRoot, 'patterns', 'bp-001.json')) : null
  const events = contractRoot ? readJsonSafe(path.join(contractRoot, 'patterns', 'events.json')) : null
  const configSchema = contractRoot ? readJsonSafe(path.join(contractRoot, 'patterns', 'enforce-config.schema.json')) : null

  const harnessRes = registry ? resolveHarnessCap(registry, THIS_HARNESS, 'stop') : { tier: null, duplicate: false }
  const cfg = loadEnforceConfig(markerRoot, configSchema)

  const harnessCap = harnessRes.tier
  const contractTier = (contractDoc && contractDoc.stop && typeof contractDoc.stop.tier === 'string') ? contractDoc.stop.tier : null
  const configTier = (cfg.bps[BP_ID] && typeof cfg.bps[BP_ID].stop === 'string') ? cfg.bps[BP_ID].stop : null

  // M8 — >1 active enforcement plugin binding this harness ⇒ fail-closed REAL
  // block (never pick-first). R6 one-harness-one-plugin.
  if (harnessRes.duplicate) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `enforce-contract: ${harnessRes.count} active enforcement plugins bind harness "${THIS_HARNESS}" in plugins/_index.json — refusing to choose (R6 one-harness-one-plugin / M8). Fix the registry.`,
    }))
    process.exit(0)
  }

  // harness ∩ contract tier (BEFORE the operator config clamp). For claude-code
  // this is STRONG (capabilities.stop STRONG ∩ bp-001.stop.tier STRONG).
  const hcTier = effectiveTierStrong([harnessCap, contractTier])

  // CLASS-C(a) — the harness∩contract tier maps to an `unsupported` action at the
  // stop event ⇒ fail-closed REAL block, NOT a swallowed warn (N1; honest-
  // capability R3). NEVER fires for claude-code (hcTier STRONG → refuse_stop);
  // evaluated only when events.json resolved.
  if (events && eventActionId(events, 'stop', hcTier) === 'unsupported') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `enforce-contract: contract requires the stop gate but the harness∩contract tier "${hcTier}" maps to an unsupported action at the stop event (CLASS-C(a) fail-closed, R3). Fix the plugin capability declaration.`,
    }))
    process.exit(0)
  }

  // active:false ⇒ R5 silence — the operator turned enforcement OFF for this
  // project. Honored, but OBSERVABLE (M4): never silent-silent. NOTE the ordering:
  // CLASS-C(a) above fires FIRST, so a genuinely-incoherent harness (corrupt
  // plugin capability → unsupported) still REAL-blocks even under active:false —
  // a corrupt install is not silenceable by an opt-out, by design (fail-closed).
  if (!cfg.active) {
    appendEnforceAudit(markerRoot, `${BP_ID} enforcement disabled (active:false) — stop gate not applied (R5 silence)`)
    process.stderr.write(
      'enforce-contract: notice — enforcement disabled for this project via ' +
      '.episodic-memory/enforce-config.json {"active":false}; stop gate not applied (R5 silence).\n',
    )
    process.exit(0) // allow stop, empty stdout
  }

  // Apply the operator config clamp (clamp-DOWN only). When it actually lowers the
  // tier, emit the M4 downgrade notice (observability: a downgrade of the
  // project's strongest gate is always auditable in the hook log).
  const effTier = clampTier(hcTier, configTier)
  if ((TIER_RANK[effTier] ?? 0) < (TIER_RANK[hcTier] ?? 0)) {
    appendEnforceAudit(markerRoot, `stop refuse degraded ${hcTier}->${effTier} for ${BP_ID} (deliberate operator clamp via enforce-config.json)`)
    process.stderr.write(
      `enforce-contract: notice — stop refuse degraded ${hcTier}→${effTier} for ${BP_ID} via ` +
      '.episodic-memory/enforce-config.json (deliberate operator clamp, M4 audit → .episodic-memory/enforce-audit.log).\n',
    )
  }

  const decision = decideStop({ repoRoot: markerRoot, sid: mySid, stopTier: effTier })
  if (decision) {
    console.log(JSON.stringify(decision))
  }
  process.exit(0)
}
