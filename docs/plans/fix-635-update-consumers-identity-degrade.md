# FIX-635: one store's identity defect must not abort the fleet sweep; dry-run must predict it; the repair must be executable

**Issue:** #635 — `install.mjs --update-consumers` throws `duplicate-identity-chain`
from `mirrorStoreIdentities` and writes zero registry stamps for all 14 consumers;
`--dry-run` does not reproduce it; the sanctioned data repair has no entry point.

**Altitude:** LOW. The builder executes the numbered steps mechanically from the
Appendix A listings. Prose in this document is context, NOT an edit instruction —
only `L<N>` listings are edits (issue #627 lesson).

**Branch:** `fix/635-update-consumers-identity-degrade` off `main` (`5ffd0f5`).
**Builder writes:** `scripts/lib/install-version.mjs`, `scripts/lib/store-identity.mjs`,
`scripts/em-identity.mjs` (new), `tests/test-install-manifest.mjs`,
`tests/test-store-identity.mjs`. Nothing else. Builder does NOT commit.

---

## Evidence base (orchestrator runtime probes, 2026-07-31)

Real store: `resolveStoreIdentity('<repo>/.episodic-memory')` →
`{"error":"duplicate-identity-chain"}`; `resolveLocalDir(repo)` → `<repo>/.episodic-memory`.

Fixture probe (isolated scratch store, two forged roots replicating the real store):

| repair episode shape | resolver outcome |
|---|---|
| detach-only (`detaches_identity_root` only) | still `duplicate-identity-chain` (repair ep is itself a 3rd root) |
| supersede-only (`supersedes` only) | still `duplicate-identity-chain` (other root untouched) |
| **both** (`supersedes: <survivor terminal>` + `detaches_identity_root: <stray root>`) | `{"active_id":"<fresh>","aliases":["<survivor store_id>"],"root_id":"<survivor root>","terminal_episode_id":"<repair ep>"}` |

Only the both-fields shape collapses to one active chain. This is what the
`detachRootId` path (L3) writes and what the operator ceremony will execute.

## Root-cause class (context, no edit)

Identity-unaware bulk episode writes (`em-restore.mjs` — zero references to
`store-identity`/`store_id`; sync flows likewise) can (re)introduce a second active
root after a legitimate mint on a fresh clone (clone → mint → restore ordering).
Guarding the restore path is OUT of scope (follow-up issue, step 9).

## Scope

- **S1** `mirrorStoreIdentities` gains an opt-in per-row degrade mode used ONLY by the
  `updateConsumers` sweep tail. Registration path (`upsertRegistryEntries`) keeps
  RFC-012 REQ-6 fail-loud semantics ("a second chain fails loud at build and at
  registration" — registration only; the sweep is not registration, and the mirror is
  "derived, never authoritative" per the header comment at `install-version.mjs:638`).
  A degraded row is still version-stamped; only its identity mirror fields are left
  untouched.
- **S2** `--update-consumers --dry-run` performs a resolve-only identity probe (never
  mints) under the same write condition as the apply-path mirror, populating the same
  report field. Parity is RESOLVE-ERROR parity (`duplicate-identity-chain`,
  `identity-chain-cycle` — the #635 class): for those, dry-run and apply record the
  same `${error}: ${project_path}` strings. Apply-only failure classes the probe
  cannot see (documented blind spots, R1-F1): `copied-store-rejected`,
  `ambiguous-alias-ownership`, `reserved-id-abuse`, `identity-mint-failed` — mint and
  the cross-row claims map exist only on apply. Counts may also diverge on multi-tool
  projects: the probe dedups per store DIR, the apply degrade records per registry
  ROW (R1-F2). Neither path runs when the sweep has nothing to prune or refresh —
  `--dry-run` is not a standalone identity health check; that is
  `em-identity.mjs --status` (R1-F6).
- **S3** `detachStoreIdentity` gains `{ detachRootId }`: named-root detach that
  collapses a duplicate-root store by writing ONE episode carrying both
  `supersedes` (survivor chain terminal) and `detaches_identity_root` (stray root).
  Validate-then-write: every error path returns before any write.
- **S4** `scripts/em-identity.mjs` (new, zero-dep, JSON stdout): `--status` diagnosis
  and `--detach-root <id> [--confirm]` repair adapter. Auto-deploys as a substrate
  script (`isSubstrateScript` matches `em-*.mjs`).
- **S5** Regression tests in the two existing registered suites (no new test file, no
  workflow edit — avoids the #614 class).

## Exclusions (record, do not build)

- No change to `upsertRegistryEntries` / registration fail-loud behavior.
- `syncProjectFromDist` fleet-exposure (silent SessionStart auto-refresh suppression) —
  follow-up issue at step 9.
- `em-restore`/backup identity-awareness guard — follow-up issue at step 9.
- The unresolved 07-28 timeline question (why the 07-28 00:03 sweep succeeded with
  both root files apparently on disk since 07-19; `*.pre-sync-20260728-103818`
  artifacts suggest an identity-unaware sync may have introduced the stray root later
  with preserved mtime) — recorded as an open question on #635, not blocking.
- The live-store data repair itself. NOT in this PR. Operator-gated ceremony after
  merge, using the L4 CLI.

## Accepted risks (named, not built — R1-F5)

- Crash mid-collapse: covered by the existing atomic identity-episode write
  (temp+fsync+rename); a crash after the episode write but before the index update
  leaves the index stale until `em-rebuild-index` heals it — the same fail-safe
  precedent as mint/rebind/detach.
- Concurrent sweeps: pre-existing registry TOCTOU (last-writer-wins on
  `writeJsonAtomic`); the degrade path adds no new shared state.

## R1 disposition (2026-08-01, GLM seat, verdict APPROVE-WITH-CHANGES)

- R1-F1 MAJOR ACCEPT — S2 narrowed to resolve-error parity with enumerated
  apply-only blind spots (this revision).
- R1-F2 MINOR ACCEPT-WITH-MOD — per-dir/per-row divergence documented in S2; T8b
  clarified (single-tool fixture makes the counts coincide).
- R1-F3 MINOR ACCEPT — falsifiability note corrected: still-ambiguous (3 roots) and
  T8c are preservation legs.
- R1-F4 NIT DEFER — the double `identityGraph` call under the store lock is
  correctness-neutral; the runtime-validated L3c listing stays frozen.
- R1-F5 NIT ACCEPT — accepted-risks section added.
- R1-F6 NIT ACCEPT — write-condition gating documented in S2.

## Steps

- 1.0 Branch `fix/635-update-consumers-identity-degrade` off `5ffd0f5`.
- 1.1 Apply L1 to `scripts/lib/install-version.mjs` (`updateConsumers`).
- 1.2 Apply L2 to `scripts/lib/install-version.mjs` (`mirrorStoreIdentities`).
- 1.3 Apply L3 to `scripts/lib/store-identity.mjs` (`identityGraph` helper +
  `resolveStoreIdentity` refactor + `detachStoreIdentity` extension +
  `storeIdentityStatus` export).
- 1.4 Create `scripts/em-identity.mjs` from L4.
- 1.5 Apply L5 test legs to `tests/test-install-manifest.mjs`.
- 1.6 Apply L6 test legs to `tests/test-store-identity.mjs`.
- 1.7 Run verification block below; all green → report BUILD-DONE with counts.

## Verification

```bash
node tests/test-install-manifest.mjs        # pre-existing T-legs + new T8 all green
node tests/test-store-identity.mjs          # pre-existing + new collapse/CLI legs green
node tests/test-consumer-registry-schema.mjs
node --input-type=module -e "import('./scripts/lib/install-version.mjs').then(()=>console.log('import-ok'))"
node scripts/em-identity.mjs --help
```

Falsifiability notes:
- The T8 apply leg fails against current `main` with the uncaught
  `duplicate-identity-chain` stack (exit ≠ 0) — it is a true repro of #635.
- The T8 dry-run leg fails against current `main` because `identity_degraded` is
  absent from the dry-run report.
- The L6 collapse-success, detach-root-not-active, and store-not-duplicate legs fail
  against current `main` because `detachStoreIdentity` has no `detachRootId`
  parameter. The still-ambiguous (3 roots) leg and T8c are preservation legs, not
  regressions — they pass on main too and guard the fixed code (R1-F3).
- Greps in this plan target `scripts/` and `tests/` paths only, never `docs/plans/`
  (a verify grep must not count its own Listing — #627).

---

## Appendix A — Listings

### L1 — `scripts/lib/install-version.mjs`, `updateConsumers`

L1a: in the `report` initializer (currently ending `dry_run: !!dryRun,`), add one field:

```js
    identity_degraded: [],
```

L1b: replace the sweep tail (the `if (!dryRun && (report.pruned.length > 0 || report.refreshed.length > 0)) { ... }` block that wraps `writeRegistry(regPath, mirrorStoreIdentities(keptEntries))`) with:

```js
  if (report.pruned.length > 0 || report.refreshed.length > 0) {
    if (dryRun) {
      // FIX-635: dry-run predicts the apply-path mirror with a resolve-only probe
      // (never mints; no-identity is not a degrade — apply would mint successfully).
      probeStoreIdentities(keptEntries, report.identity_degraded)
    } else {
      // F2 fold (GLM r1 MAJOR-2): mirror store identities on the sweep path too,
      // so a post-rebind/detach registry carries the fresh active id + aliases
      // (otherwise the sweep writes the stale active id from the prior upsert and
      // omits store_aliases). The merge happens through mirrorStoreIdentities,
      // NOT upsertRegistryEntries — upsert would read-merge and resurrect pruned rows.
      // FIX-635: one row's identity defect degrades that row instead of aborting
      // the whole sweep (the mirror is derived, never authoritative).
      writeRegistry(regPath, mirrorStoreIdentities(keptEntries, { degraded: report.identity_degraded }))
    }
  }
  return report
```

L1c: immediately above `export function mirrorStoreIdentities`, insert:

```js
// FIX-635: dry-run counterpart of the sweep-tail mirror. Resolve-only — never
// mints, never writes. For resolve-class errors (duplicate-identity-chain,
// identity-chain-cycle) it pushes the same `${error}: ${project_path}` strings the
// degrade path records; apply-only classes (copied-store-rejected,
// ambiguous-alias-ownership, reserved-id-abuse, identity-mint-failed) have no
// dry-run counterpart, and the probe dedups per dir while apply degrades per row.
function probeStoreIdentities(entries, out) {
  const seenDirs = new Set()
  for (const e of entries) {
    let projectReal
    try { projectReal = fs.realpathSync(e.project_path) } catch { continue }
    let dir
    try { dir = resolveLocalDir(projectReal) } catch { dir = path.join(projectReal, '.episodic-memory') }
    if (!fs.existsSync(dir) || seenDirs.has(dir)) continue
    seenDirs.add(dir)
    const idn = resolveStoreIdentity(dir)
    if (idn.error && idn.error !== 'no-identity') {
      out.push({ project_path: e.project_path, error: `${idn.error}: ${e.project_path}` })
    }
  }
}
```

### L2 — `scripts/lib/install-version.mjs`, `mirrorStoreIdentities`

Change the signature and wrap the existing per-row body in a try/catch. The body
between `for (const e of entries) {` and the loop's closing brace is byte-identical
to current main except for the added `try {` / `} catch` frame and one indent level.
Existing bare `continue` statements keep their meaning.

```js
export function mirrorStoreIdentities(entries, { degraded } = {}) {
  const claims = new Map() // store_id/alias -> { dir, kind }
  for (const e of entries) {
    try {
      // ... existing per-row body, unchanged, one indent deeper ...
    } catch (err) {
      // FIX-635: degrade mode (sweep path only) — record and continue; the row
      // keeps its version stamp and its prior identity fields. Registration
      // (upsertRegistryEntries) does not pass `degraded` and still fails loud.
      if (!degraded) throw err
      degraded.push({ project_path: e.project_path, error: err.message })
    }
  }
  return entries
}
```

Update the header comment's final sentence (currently "…A missing or unresolvable
store dir leaves the row unmirrored (mirror is derived).") by appending:

```js
// With `degraded` (sweep path, FIX-635), resolve/mint/collision failures for a row
// are pushed to that array and the row is skipped instead of aborting the sweep.
```

### L3 — `scripts/lib/store-identity.mjs`

L3a: extract the analysis prefix of `resolveStoreIdentity` into a helper placed
directly above it, and have `resolveStoreIdentity` use it. The logic is
byte-equivalent; the resolver's observable behavior is unchanged.

```js
// Shared identity-graph analysis (FIX-635): roots, detached roots, active roots.
// Single source of truth for resolveStoreIdentity and the named-root detach path.
function identityGraph(storeDir) {
  const eps = listIdentityEpisodes(storeDir)
  const byId = new Map(eps.map((e) => [e.id, e]))
  const roots = eps.filter((e) => !e.supersedes || !byId.has(e.supersedes))
  const detachedRootIds = new Set()
  for (const e of eps) {
    if (e.detaches_identity_root && byId.has(e.detaches_identity_root)) {
      detachedRootIds.add(e.detaches_identity_root)
    }
  }
  const activeRoots = roots.filter((r) => !detachedRootIds.has(r.id))
  return { eps, byId, roots, detachedRootIds, activeRoots }
}

function walkChain(eps, root) {
  const visited = new Set([root.id])
  const chainMembers = [root]
  let current = root
  while (true) {
    const successor = eps.find((e) => e.supersedes === current.id)
    if (!successor) break
    if (visited.has(successor.id)) return { error: 'identity-chain-cycle' }
    visited.add(successor.id)
    chainMembers.push(successor)
    current = successor
  }
  return { chainMembers }
}
```

`resolveStoreIdentity` becomes:

```js
export function resolveStoreIdentity(storeDir) {
  const { eps, activeRoots } = identityGraph(storeDir)
  if (eps.length === 0) return { error: 'no-identity' }
  if (activeRoots.length === 0) return { error: 'identity-chain-cycle' }
  if (activeRoots.length > 1) return { error: 'duplicate-identity-chain' }
  const root = activeRoots[0]
  const walked = walkChain(eps, root)
  if (walked.error) return { error: walked.error }
  const chainMembers = walked.chainMembers
  // Episodes belonging to detached chains (their root is in detachedRootIds) are
  // intentionally not reachable from the active root — they stay in the store but
  // contribute no active id and no aliases (§A.5 lib error 'detachedChainExcluded').
  const terminal = chainMembers[chainMembers.length - 1]
  const aliases = chainMembers.slice(0, -1).map((m) => m.store_id)
  return {
    active_id: terminal.store_id,
    aliases,
    root_id: root.id,
    terminal_episode_id: terminal.id,
  }
}
```

L3b: new exported diagnosis surface, placed after `resolveStoreIdentity`:

```js
// FIX-635: operator-facing diagnosis. Never writes. Lists every active root so a
// duplicate-root store can be repaired by naming which root to detach.
export function storeIdentityStatus(storeDir) {
  const resolution = resolveStoreIdentity(storeDir)
  const { activeRoots, detachedRootIds } = identityGraph(storeDir)
  return {
    resolution,
    active_roots: activeRoots.map((r) => ({ episode_id: r.id, store_id: r.store_id })),
    detached_root_ids: [...detachedRootIds],
  }
}
```

L3c: `detachStoreIdentity` gains `detachRootId`. The legacy no-argument path is
byte-identical to current behavior. New signature and inserted branch:

```js
export function detachStoreIdentity(storeDir, { lockTimeoutS, detachRootId } = {}) {
  return withStoreLockSync(storeDir, () => {
    const existing = resolveStoreIdentity(storeDir)
    if (detachRootId) {
      // FIX-635 duplicate-collapse: name the stray root; the surviving chain's
      // terminal is superseded by ONE new episode that also detaches the stray
      // root (the only single-episode shape that yields exactly one active root
      // — see plan Evidence table). Validate-then-write: no write on any error.
      if (existing.error && existing.error !== 'duplicate-identity-chain') {
        return { error: existing.error }
      }
      if (!existing.error) return { error: 'store-not-duplicate' }
      const { eps, activeRoots } = identityGraph(storeDir)
      const target = activeRoots.find((r) => r.id === detachRootId)
      if (!target) return { error: 'detach-root-not-active' }
      const remaining = activeRoots.filter((r) => r.id !== detachRootId)
      if (remaining.length !== 1) return { error: 'duplicate-identity-chain' }
      const walked = walkChain(eps, remaining[0])
      if (walked.error) return { error: walked.error }
      const terminal = walked.chainMembers[walked.chainMembers.length - 1]
      const newStoreId = crypto.randomBytes(8).toString('hex')
      const now = new Date()
      const id = newEpisodeId(newStoreId, now)
      const y = now.getFullYear()
      const mo = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const h = String(now.getHours()).padStart(2, '0')
      const mi = String(now.getMinutes()).padStart(2, '0')
      const project = path.basename(path.dirname(storeDir)) || 'store'
      const fields = {
        id,
        date: `${y}-${mo}-${d}`,
        time: `${h}:${mi}`,
        project,
        summary: `Store identity duplicate-collapse ${newStoreId}`,
        store_id: newStoreId,
        supersedes: terminal.id,
        detaches_identity_root: detachRootId,
        bodyLine: 'Store identity duplicate-collapse successor (issue #635; RFC-012 P2 REQ-5 detach + P7 successor revision). Detached chain contributes no active id and no aliases; the surviving chain continues through this terminal.',
      }
      const episodesDir = path.join(storeDir, 'episodes')
      const content = identityEpisodeContent(fields)
      const writeResult = writeIdentityEpisodeAtomic(episodesDir, id, content)
      if (writeResult.error) return writeResult
      const idx = applyIdentityIndexUpdate(storeDir, fields)
      const out = {
        active_id: newStoreId,
        detached_root_id: detachRootId,
        superseded_terminal: terminal.id,
        prior_id: terminal.store_id,
      }
      if (idx.stale) out.index_stale = true
      return out
    }
    if (existing.error) return { error: existing.error }
    // ... legacy path below unchanged ...
```

### L4 — `scripts/em-identity.mjs` (new file)

```js
#!/usr/bin/env node
/**
 * em-identity.mjs — store-identity diagnosis + sanctioned duplicate-root repair
 * (issue #635). Zero deps; JSON to stdout.
 *
 *   node em-identity.mjs [--project <path>|--store <dir>] [--status]
 *   node em-identity.mjs --detach-root <episode-id> [--confirm]
 *
 * Without --confirm, --detach-root prints the planned write and touches nothing
 * (#623 blast-radius discipline). The repair itself is detachStoreIdentity's
 * named-root collapse: one successor episode carrying supersedes + 
 * detaches_identity_root (P7: revision, never an edit).
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { resolveLocalDir } from './lib/local-dir.mjs'
import { storeIdentityStatus, detachStoreIdentity } from './lib/store-identity.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}

if (flag('--help')) {
  console.log(JSON.stringify({
    status: 'help',
    script: 'em-identity.mjs',
    usage: 'node em-identity.mjs [--project <path>|--store <dir>] [--status] | --detach-root <episode-id> [--confirm]',
  }))
  process.exit(0)
}

let storeDir = opt('--store')
if (!storeDir) {
  const project = opt('--project') || process.cwd()
  try { storeDir = resolveLocalDir(fs.realpathSync(project)) } catch { storeDir = path.join(project, '.episodic-memory') }
}
if (!fs.existsSync(path.join(storeDir, 'episodes'))) {
  console.log(JSON.stringify({ status: 'error', error: 'store-not-found', store: storeDir }))
  process.exit(1)
}

const detachRootId = opt('--detach-root')
if (!detachRootId) {
  console.log(JSON.stringify({ status: 'ok', store: storeDir, ...storeIdentityStatus(storeDir) }))
  process.exit(0)
}

const before = storeIdentityStatus(storeDir)
const target = before.active_roots.find((r) => r.episode_id === detachRootId)
const survivors = before.active_roots.filter((r) => r.episode_id !== detachRootId)
if (!flag('--confirm')) {
  console.log(JSON.stringify({
    status: 'plan',
    store: storeDir,
    would_detach: target || null,
    would_survive: survivors,
    note: target && survivors.length === 1
      ? 'one successor episode will supersede the survivor terminal and detach the named root; re-run with --confirm to write'
      : 'refused: --detach-root must name one of exactly two active roots',
  }))
  process.exit(target && survivors.length === 1 ? 0 : 1)
}
const result = detachStoreIdentity(storeDir, { detachRootId })
const ok = !result.error
console.log(JSON.stringify({ status: ok ? 'ok' : 'error', store: storeDir, ...result, after: ok ? storeIdentityStatus(storeDir) : undefined }))
process.exit(ok ? 0 : 1)
```

### L5 — `tests/test-install-manifest.mjs`: new group T8

Follow the file's existing harness idioms exactly (its `mkSandbox`, its runner/assert
helpers, its way of triggering a refresh for the T5 sweep legs — read them first;
reuse, do not reinvent). Group T8 "identity degrade + dry-run parity (#635)":

Setup: sandbox with TWO consumer projects (A, B) both installed/registered against
the sandbox repo copy; then forge a second active identity root into A's
`.episodic-memory/episodes/` with a local `handRoot`-equivalent helper copied from
`tests/test-store-identity.mjs` (two frontmatter files, distinct 16-hex `store_id`s,
no `supersedes`); then make the sweep refresh-eligible the same way T5 legs do.

Legs and required assertions:

- **T8a dry-run predicts**: run `install.mjs --update-consumers --dry-run`.
  Exit 0. Report `identity_degraded` has exactly one entry; `entry.project_path`
  === A's path; `entry.error` matches `/^duplicate-identity-chain: /`. A's episode
  file count unchanged (no mint on dry-run).
- **T8b apply degrades instead of aborting**: run `install.mjs --update-consumers`.
  Exit 0 (this leg is the #635 repro — on unfixed main it crashes with an uncaught
  stack). Report `identity_degraded` as in T8a and string-identical to T8a's entry
  (resolve-error parity; the single-tool-per-project fixture makes per-dir and
  per-row counts coincide — R1-F2). Registry: B's row(s) stamped to the new version AND carry
  `store_id`; A's row(s) stamped to the new version (stamp survives degrade) with
  identity fields untouched.
- **T8c no-identity still mints on apply, silent on dry-run**: project B built with
  an EMPTY store: dry-run reports no `identity_degraded` entry for B; apply mints
  exactly one identity episode in B's store (count 0 → 1) and B's row gains a
  `store_id`.

### L6 — `tests/test-store-identity.mjs`: named-root detach + CLI legs

Group 1 additions (in-process lib, use existing `mkStore`/`handRoot`/`episodesMd`):

- **collapse success**: `handRoot(dir,'aaaa…')`, `handRoot(dir,'bbbb…')` (distinct
  ids); `detachStoreIdentity(dir, { detachRootId: <bbbb root episode id> })` returns
  `active_id` (fresh 16-hex), `detached_root_id`, `superseded_terminal` = aaaa-root
  episode id, `prior_id` = `'aaaa…'`; `resolveStoreIdentity(dir)` then returns that
  same `active_id` with `aliases` containing `'aaaa…'`; episode count went +1 only.
- **detach-root-not-active**: two roots, `detachRootId: 'no-such-episode'` →
  `{ error: 'detach-root-not-active' }`, episode count unchanged.
- **still-ambiguous (3 roots)**: three `handRoot`s, detach one →
  `{ error: 'duplicate-identity-chain' }`, episode count unchanged.
- **store-not-duplicate**: one root, `detachRootId` = that root's episode id →
  `{ error: 'store-not-duplicate' }`, episode count unchanged.
- **legacy path untouched**: existing detach tests must pass unmodified.

Group 2 addition (spawned CLI, use existing spawn idioms):

- **CLI ceremony**: two-root store; `em-identity.mjs --store <dir>` → status JSON
  with `resolution.error === 'duplicate-identity-chain'` and 2 `active_roots`;
  `--detach-root <id>` WITHOUT `--confirm` → `status: 'plan'`, episode count
  unchanged; with `--confirm` → `status: 'ok'`, subsequent `--status` resolves
  cleanly with 1 active root and the survivor store_id in `aliases`.

---

## Step 9 (orchestrator, post-merge — record here so it is not lost)

- File follow-up: `syncProjectFromDist` mirrors the whole registry and silently
  suppresses SessionStart auto-refresh under the same one-bad-row condition.
- File follow-up: `em-restore`/backup-sync flows are identity-unaware and can
  reintroduce a detached/foreign identity root (root-cause class of #635).
- Comment on #635: the 07-28 timeline open question (pre-sync artifacts).
- Operator ceremony (separate from PR): `node scripts/em-identity.mjs --status`,
  then `--detach-root 20260719-221917-store-identity-09d0` (plan), operator
  confirms, `--confirm`, then `install.mjs --update-consumers` + verify all 14
  stamps + audit deploy legs for `49a4e3e`/`6e82fee`/`5ffd0f5`.
