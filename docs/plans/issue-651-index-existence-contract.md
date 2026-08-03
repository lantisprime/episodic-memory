# Plan: issue #651 — index existence-semantics contract (lstat-based), silent-[] fail-open + FIFO hang

Status: REVISED (Revision 1 — negative-scenario audit gaps folded in; pending second-opinion review)
Issue: #651 (split from #628 plan §17 DEFER-4; pre-declared at
`docs/plans/issue-628-sibling-init-guard.md:48`)
Branch: `fix-651-index-existence-contract`
Executor: low-capability builder subagent (fresh context) — the §7 site table is the
mechanical build path.

## §1 Problem

`existsSync(index.jsonl)` returns **false** for a symlink loop, a dangling symlink, or an
index under an EACCES parent, so every loader takes its missing-store branch and returns
`[]`. Scripts then exit 0 `status:ok` with the store's evidence silently gone — for
`em-prune` that is R5(b) protection evidence loss (FAIL-OPEN, strictly worse than the
EISDIR crash #628 fixed). `existsSync` returns **true** for a FIFO, and the unguarded
`readFileSync` blocks forever.

Runtime evidence (main @ 792ca0e, isolated fixture store, 2026-08-03):

- symloop / dangling / eaccess-parent: `em-search` → `{"status":"ok","count":0}` exit 0;
  `em-prune --scope local --dry-run` → `{"status":"ok","results":[{"scope":"local","pruned":0,"remaining":0,"protected":0,...}]}`
  exit 0 (control store shows `remaining:1`).
- fifo: `em-list`, `em-search`, `em-prune` all killed by a 5 s alarm (exit 142) — indefinite hang.
- Audit probes (same commit): chmod-000 on the index **file** itself → raw `node:fs:539`
  stack, exit 1, empty stdout on `em-list`/`em-recall`. Dangling **parent** symlink
  (`.episodic-memory` → missing) → lstat(index) ENOENT → silent-[] exit 0.
  `em-rebuild-index` under eaccess parent dies raw at lock acquisition
  (`store-write-lock.mjs:142-146`) **before** reaching its loader.

## §2 Contract decision

New shared classifier (lstat-based) defines index-file existence semantics for every
loader:

| observed shape | classification | rationale |
|---|---|---|
| `lstatSync(index)` throws ENOENT AND parent probe (below) is clean | **absent** | genuinely missing store — keep today's `[]` / skip / create-on-first-use |
| `lstatSync(index)` throws ENOENT, parent probe finds `.episodic-memory` is a symlink whose `statSync` fails (dangling/loop) or parent `lstatSync` throws non-ENOENT (EACCES/EIO/ELOOP) | **unreadable** (broken parent) | audit P2: a dangling-parent symlink is a defect, not an absent store |
| `lstatSync(index)` throws anything else (EACCES, ENOTDIR, EIO, ELOOP mid-path) | **unreadable** | inspection failed — fail closed |
| final component is a symlink, `statSync` resolves to a regular file | **ok** | healthy symlinked index stays supported (works today; audit P4: relative targets are cwd-independent) |
| symlink, `statSync` throws ENOENT | **unreadable** (dangling) | a dangling link is a defect, not an absent store |
| symlink, `statSync` throws ELOOP/other | **unreadable** (loop) | |
| resolves to directory | **unreadable**, code `EISDIR` | preserves #628 message compat (`(EISDIR)` in envelope) |
| resolves to FIFO/socket/device (incl. via symlink) | **unreadable**, code `ENOTREG` | classified BEFORE any open — this is the hang fix |
| regular file, classification `ok`, but the subsequent read throws (file-mode-000 EACCES, or a post-classify swap to dir) | **unreadable** — read errors inside the shared loaders are wrapped into `IndexUnreadableError` | audit Gap 2 (probe P1): classification alone cannot see file-mode-000; wrapping the read also types the swap-to-dir race. Residual: a post-classify swap to FIFO re-opens the hang — DEFER D1 (§4), same trust domain as #628 DEFER-1 |

Fail-direction doctrine (RFC-011 `docs/rfcs/RFC-011-playbook-activation-preferences.md:58,:122,:138`):
retention/mutation consumers fail closed (typed abort, exit 1); the enumerated advisory
degrade surfaces (§4 list) keep degrading on unreadable but MUST classify before read so
a FIFO can never be opened and MUST surface observability where a reporter exists
(doctor/stats — §7 steps 18, 22). Everything else — including read/query tools — aborts
typed: a recall surface returning fabricated-empty is still evidence loss (issue text:
"affects ALL loaders uniformly").

Known collision, decided here: no RFC binds an error-envelope contract for read-only
query tools (#628 plan `:44`). This plan extends the de-facto envelope
(`{status:'error', message}` + exit 1, `docs/EM_SCRIPTS_GUIDE.md:26-28`) to them for the
unreadable-index case only. That is a deliberate, documented contract extension, recorded
in EM_SCRIPTS_GUIDE (§7 step 24).

## §3 Requirements

| REQ | Statement | Test |
|---|---|---|
| REQ-1 | Shared classifier `classifyIndexFile(fsMod, filePath)` + `IndexUnreadableError` + `assertReadableIndex` in new `scripts/lib/index-state.mjs`; semantics exactly the §2 table incl. parent probe | T1 unit legs |
| REQ-2 | `relevance.mjs` `loadIndex`: absent → `[]`, unreadable → throw `IndexUnreadableError`, read errors wrapped into `IndexUnreadableError`; `loadArchivedIndex`: classify-then-degrade (no open on non-regular) | T2, T3 fifo/file-000 columns |
| REQ-3 | Every §7 in-scope loader/call-site adopts the contract; unreadable reaches the user as a typed envelope `{status:'error', message:/episode index unreadable/}` + exit 1, last stdout line, no stack frames on stderr — verified by the §7 step-28 importer sweep (baseline: 36 `loadIndex(` call sites in 20 files on main) with every site typed-abort / doctor-report / documented-degrade | T3 matrix + sweep |
| REQ-4 | FIFO-shaped index: no in-scope script blocks; each exits 1 typed within the spawn timeout | T3 fifo column |
| REQ-5 | Genuinely-missing index (ENOENT, clean parent): behavior byte-compatible with today (exit 0, same JSON) | T4 controls |
| REQ-6 | Healthy symlink → regular file keeps loading rows | T4 symlink-ok |
| REQ-7 | `em-prune` unreadable: exit 1, nothing archived, episode files + index untouched | T5 |
| REQ-8 | `em-rebuild-index`: classification runs BEFORE store-write-lock acquisition; never truncates/replaces the index when unreadable; envelope carries remediation hint ("remove the corrupt index.jsonl and re-run") | T6 |
| REQ-9 | Vendored copies `plugins/episodic-memory/scripts/{em-search,em-list,em-check-stale}.mjs` get the same semantics (inlined classifier — no lib/ in plugin dir; behavioral parity via T7, no byte-parity mechanism exists — accepted, repo vendoring precedent) | T7 |
| REQ-10 | #628 + #626 suites stay green: `test-628-sibling-init-guard` 5/5, `test-prune-protection` 32/32, `test-rfc-015-p1-s2-consolidation` green | §8 gate |
| REQ-11 | New suite CI-wired exactly as `node tests/test-651-index-existence.mjs` (registration lint `tests/test-ci-suite-registration.mjs:8-24`); `.claude-plugin/plugin.json` bumped 0.2.2 → 0.2.3 (#644 gate) | §8 gate |

## §4 Non-goals / exclusions / DEFERs (each deliberate, not an omission)

Exclusions:
- `em-promote.mjs:668,:686,:810` TOCTOU-only raw sites — #628 DEFER-1 stands.
- `em-consolidate.mjs:1604,:1637` silent-degrade catches — pre-existing #628-era decision.
- `tags.json` / `category-index.json` / `tokens.json` loaders — tolerant-JSON, rebuildable,
  non-authoritative; different class.
- `episodes/<id>.md` per-file existence checks (`em-search.mjs:152,:338`,
  `em-move.mjs:224,:279`) — row-level body resolution, not index integrity.
- `em-search.mjs:444` tokens-index gating — optimization gate; main load covered via
  relevance.mjs.
- `em-trigger-index.mjs` statSync fingerprint and activation-hook statSync zero-states —
  different (cache-freshness) contract.
- `em-revise.mjs:346,:358` — already fail-closed direction (unknown → revision rejected).
- Windows-specific symlink/FIFO/EACCES semantics — CI is ubuntu; T-legs guard
  `process.platform` / root-uid and skip-with-note.

Documented advisory degrade surfaces (classify-before-read; unreadable → degrade, never
open non-regular):
- `relevance.mjs loadArchivedIndex` (history walk) — degrade `[]`; observability via
  doctor/stats (§7 steps 18, 22).
- `em-store.mjs:563` post-write contradiction advisory (inside `catch{}`, stderr-only) —
  degrade automatic once loadIndex classifies. NOTE (review F3, Revision 3): the append
  path itself DOES block on a FIFO-shaped index (opening a FIFO for append blocks like a
  read) — pre-existing, outside this issue's loader scope; follow-up issue filed at PR
  time (classify-before-append), folded into the D1 revisit trigger.
- `em-mine-transcripts.mjs:98` dedupe corpus — unreadable store skipped (worst case: a
  duplicate episode, not evidence loss).
- `em-consolidate.mjs:1898` F4 last-accessed lower-bound scan (inside `try{}`,
  conservative on failure) — classify-before-read, keep conservative degrade.

DEFER D1 — FIFO-swap TOCTOU: (what) a regular→FIFO swap between classify and read
re-opens the hang; (why deferrable) requires a racing writer inside the store dir — same
trust domain #628 DEFER-1 accepted for path-TOCTOU; closed form is fd-based
classification (`openSync` O_NONBLOCK + `fstatSync`); (risk) hang recurrence,
adversarial-local only; (trigger) any post-fix hang report or #628 DEFER-1 revisit;
(owner) follow-up issue linked from the #651 PR.

DEFER D2 — real-socket/device test legs: (what) no live-socket fixture leg; (why
deferrable) same `!isFile()` branch as FIFO; cheap `symlink → /dev/null` T1 leg covers
the device path; (risk) negligible; (trigger) classifier refactor; (owner) none.

## §5 Blast radius / token budget (Rule 12)

26 script files + docs + tests. `wc -l` (2026-08-03): relevance.mjs 454, protection.mjs
322, em-prune 308, em-list 80, em-check-stale 91, em-workflow-validate 1018,
em-review-request 544, em-pattern-health 420, em-watch-codex 315, em-move 406, em-restore
2635, em-consolidate 2439, em-search 602, em-feedback 260, em-doctor 911, em-seed-patterns
324, em-rebuild-index 349, topic-tracks/engine.mjs 756, em-stats 195, em-recall / em-graph
/ em-semantic / em-embed (importer wraps only), plugin copies 184+67+85. Edits are
surgical per site (§7); large files get only their loader/call-sites touched.

`lib/relevance.mjs` was held byte-unchanged by #628 REQ-6. That was a scoping invariant
of THAT plan, and #628 §17 DEFER-4 / plan `:48` explicitly pre-authorized this follow-up
to change existence semantics "in ALL loaders including lib/relevance.mjs". This plan
supersedes that invariant.

## §6 Design notes

New `scripts/lib/index-state.mjs` (zero-dep ESM, ~80 lines):

```js
export function classifyIndexFile(fsMod, filePath) {
  let st
  try { st = fsMod.lstatSync(filePath) }
  catch (e) {
    if (e && e.code === 'ENOENT') return classifyParent(fsMod, filePath) // absent vs broken-parent
    return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN', detail: 'lstat failed' }
  }
  if (st.isSymbolicLink()) {
    try { st = fsMod.statSync(filePath) }
    catch (e) {
      if (e && e.code === 'ENOENT') return { state: 'unreadable', code: 'ENOENT', detail: 'dangling symlink' }
      return { state: 'unreadable', code: (e && e.code) || 'UNKNOWN', detail: 'symlink resolution failed' }
    }
  }
  if (st.isDirectory()) return { state: 'unreadable', code: 'EISDIR', detail: 'index is a directory' }
  if (!st.isFile()) return { state: 'unreadable', code: 'ENOTREG', detail: 'index is not a regular file' }
  return { state: 'ok' }
}

// classifyParent: lstat(dirname). ENOENT → {state:'absent'} (no store).
// lstat throws non-ENOENT → unreadable (parent inspection failed).
// parent is a symlink whose statSync fails → unreadable (broken parent, audit P2).
// otherwise → {state:'absent'} (store dir exists, index genuinely missing).

export class IndexUnreadableError extends Error {
  constructor(filePath, code, detail) {
    super(`episode index unreadable (${code}) (${filePath})`)
    this.code = code; this.file = filePath; this.detail = detail
  }
}

// returns 'absent' | 'ok'; throws IndexUnreadableError on unreadable
export function assertReadableIndex(fsMod, filePath) { ... }

// readIndexFileOrThrow(fsMod, filePath): assertReadableIndex; 'absent' → null;
// 'ok' → try readFileSync, catch e → throw IndexUnreadableError(filePath, e.code, 'read failed')
// (types file-mode-000 EACCES and the swap-to-dir race — §2 last row)
```

- `fsMod` injection mirrors `protection.mjs`'s existing injected-fs signature.
- Envelope for scripts without an existing #628 wrapper:
  `{status:'error', message:'<script>: episode index unreadable (<CODE>) (<file>)'}` +
  `process.exit(1)` — same family the #628 tests regex (`/episode index unreadable/`,
  `/index\.jsonl/`). Scripts WITH wrappers (`em-prune` `loadIndexRowsOrAbort:89`,
  `em-promote:137`, `em-review-request fail:85`, `em-workflow-validate fail:105`,
  `em-consolidate emitProtectionAbort:176`) keep their exact message shapes — the new
  throw simply flows into them.
- `em-rebuild-index` envelope appends: `remediation: 'remove the corrupt index.jsonl and re-run em-rebuild-index'`
  (episodes/*.md is the source of truth; ENOENT-after-removal takes the normal rebuild path).
- `em-doctor` is the non-abort adopter: it REPORTS `index: 'unreadable (<CODE>)'` as a
  problem entry instead of `'index.jsonl absent'` at ALL its loadIndex call sites
  (`em-doctor.mjs:135,:170,:674,:681`), and additionally classifies
  `archived-index.jsonl` (a health tool must not die on the disease it diagnoses, and
  must not report fail-open `ok`).

## §7 Site table (mechanical build path — execute top to bottom)

| step | file:site | action |
|---|---|---|
| 1 | new `scripts/lib/index-state.mjs` | write module per §6 |
| 2 | `scripts/lib/relevance.mjs:99` (`loadIndex`) | use `readIndexFileOrThrow`: absent → `[]`; unreadable (incl. wrapped read error) → throw |
| 3 | `scripts/lib/relevance.mjs:120` (`loadArchivedIndex`) | classify first: absent/unreadable → `[]` (documented advisory degrade), `ok` → existing read path; delete the `existsSync` line |
| 4 | `scripts/lib/protection.mjs:30` (`loadProtectionRows`) | classify with injected fs + wrapped read: absent → `[]`, unreadable → throw `IndexUnreadableError` |
| 5 | `scripts/em-prune.mjs:72` (`loadIndexRows`) | classify + wrapped read: absent → `[]`, unreadable → throw; confirm EVERY caller routes via `loadIndexRowsOrAbort:89` (incl. `partitionPrunable:109`) — reroute any that don't |
| 6 | `scripts/em-consolidate.mjs:150` (`loadProtectionRows` caller) | catch `IndexUnreadableError` → `emitProtectionAbort` with `kind:'protection'`, file = the store's index.jsonl |
| 7 | `scripts/em-consolidate.mjs:528` (skip-store site) | classify: absent → keep `skipped_store:'no-index'`; unreadable → typed abort (never skip) |
| 7b | `scripts/em-consolidate.mjs:577` (single-store `--fold-superseded` `foldStore(DATA_DIR, ...)` call) | catch `IndexUnreadableError` → `emitProtectionAbort`-family typed abort, exit 1, archive nothing (builder-found NEW-SITE, Revision 2) |
| 7c | `scripts/em-prune.mjs:251` + `scripts/em-consolidate.mjs:485` (archived-index.jsonl mutation-path reads) | classify `archived-index.jsonl` BEFORE any episode file is moved (pre-flight, alongside the main-index classification); unreadable → typed abort with nothing moved; also wrap the in-place read (review F2, Revision 3) |
| 7d | `scripts/em-feedback.mjs:129` (`resolveIds` raw read, `--scan-text` both modes) | route through `readIndexFileOrThrow` → typed envelope + exit 1 (review F1 BLOCKER, Revision 3) |
| 7e | `scripts/em-topic-tracks.mjs:172` (CLI catch fallthrough) | map `IndexUnreadableError` to a distinct error code (`episode-index-unreadable`), not `topic-tracks-config-invalid` (review F4, Revision 3) |
| 7f | `scripts/em-stats.mjs` archived field | emit `archived_unreadable` only when true (review F5, Revision 3) |
| 8 | `scripts/em-list.mjs:40` | classify + wrapped read: absent → `[]`; unreadable → envelope + exit 1 |
| 9 | `scripts/em-check-stale.mjs:41` | same as step 8 |
| 10 | `scripts/em-search.mjs` (loadIndex call sites via relevance import) | wrap in try/catch `IndexUnreadableError` → envelope + exit 1 |
| 11 | `scripts/em-recall.mjs:253,:256` | wrap loadIndex calls → envelope + exit 1 (audit Gap 1 — THE recall surface) |
| 12 | `scripts/em-graph.mjs:129-130` | same wrap |
| 13 | `scripts/em-semantic.mjs:142` | same wrap |
| 14 | `scripts/em-embed.mjs:81` | same wrap |
| 15 | `scripts/em-stats.mjs:78` (main load) | same wrap; `:131` archived read → classify-before-read, unreadable → `archived_unreadable: true` in output (degrade, observable) |
| 16 | `scripts/em-doctor.mjs:135,:170,:674,:681` | report-not-abort per §6; also classify `archived-index.jsonl` |
| 17 | `scripts/em-workflow-validate.mjs:128` | classify + wrapped read; unreadable → existing `fail(msg, 1)` (`:105`) |
| 18 | `scripts/em-review-request.mjs:202,:510` | classify + wrapped read; unreadable → existing `fail(1, msg)` (`:85`) |
| 19 | `scripts/em-pattern-health.mjs:153` | classify + wrapped read: absent → `[]`; unreadable → envelope + exit 1 |
| 20 | `scripts/em-watch-codex.mjs:92,:155,:247` | `:92` discovery predicate: absent → continue walk, unreadable → envelope abort (never bind parent store); `:155` loader per contract; `:247` unchanged if unreachable post-abort, else report state |
| 21 | `scripts/em-move.mjs:98` (`readIndexRows`) | classify + wrapped read: absent → `[]`, unreadable → envelope + exit 1 (mutation path) |
| 22 | `scripts/em-restore.mjs:411` (`loadIndexJsonl`) | classify + wrapped read: absent → empty Map, unreadable → envelope + exit 1 |
| 23 | `scripts/em-feedback.mjs:138,:208` (store-selection filters) | absent → drop store from set (today's behavior), unreadable → envelope + exit 1 (never silently drop a lock/write target) |
| 24 | `scripts/em-seed-patterns.mjs:44` | classify; absent → today's behavior, unreadable → envelope + exit 1 |
| 25 | `scripts/em-rebuild-index.mjs` | classification of index + episodesDir runs BEFORE `acquireStoreWriteLocksSync` (`:154`, audit Gap 4 — lock open dies raw under eaccess); any unreadable → envelope + remediation hint + exit 1 BEFORE any write/truncate; absent episodesDir with readable parent → today's create path; `loadOldIndex:134` classify + wrapped read |
| 26 | `scripts/topic-tracks/engine.mjs:160` | classify before read: absent → `[]`, unreadable → throw; route script entry to envelope |
| 27 | `scripts/em-mine-transcripts.mjs:98` + `scripts/em-consolidate.mjs:1898` + `scripts/em-store.mjs:563` | advisory dispositions per §4: classify-before-read, degrade on unreadable, never open non-regular |
| 28 | importer sweep (verify) | `grep -rn "loadIndex(" scripts/ plugins/` — baseline 36 sites / 20 files on main; post-build, table every site as typed-abort / doctor-report / documented-degrade (§4 list); any new site found = STOP and add a row |
| 29 | `plugins/episodic-memory/scripts/em-search.mjs:49`, `em-list.mjs:34`, `em-check-stale.mjs:35` | inline classifier + wrapped read (copy §6 functions into each file's local helpers, matching vendored style); same absent/unreadable behavior as steps 8–10 |
| 30 | `docs/EM_SCRIPTS_GUIDE.md` | add short "index existence contract" note (absent vs unreadable, envelope, exit 1, rebuild remediation) |
| 31 | new `tests/test-651-index-existence.mjs` | per §8 |
| 32 | `.github/workflows/tests.yml` | add step `node tests/test-651-index-existence.mjs` in the clerk-consolidation shard (exact-form rule, registration lint) |
| 33 | `.claude-plugin/plugin.json:3` | version 0.2.2 → 0.2.3 |

## §8 Test plan (`tests/test-651-index-existence.mjs`)

Harness pattern = `tests/test-628-sibling-init-guard.mjs` (mkdtemp + real `em-store` seed
+ spawnSync with `cwd` + pinned `HOME`/`USERPROFILE`; `lastJson()`; no-stack assert), with
`spawnSync` `timeout: 10000` on every leg so a FIFO regression FAILS (spawnSync returns
`status: null` + `signal: 'SIGTERM'` on timeout — assert `status === 1` catches it)
instead of hanging the suite.

Fixture shapes: `symloop` (index.jsonl → loop-b → index.jsonl), `dangling`
(→ does-not-exist), `eaccess` (chmod 000 on `.episodic-memory`; restore in finally; skip
when `process.getuid() === 0`), `fifo` (`mkfifo` via child_process; skip on win32),
`file000` (chmod 000 on index.jsonl itself; audit Gap 2), `parent-dangling`
(`.episodic-memory` → missing target; audit Gap 3).

- **T1** unit: import `classifyIndexFile`, assert every §2 table row directly, incl.
  healthy-symlink `ok`, directory `EISDIR`, `symlink → /dev/null` `ENOTREG` (DEFER D2
  cheap leg), parent-probe rows.
- **T3 matrix**: shapes {symloop, dangling, eaccess, fifo, file000, parent-dangling} ×
  scripts {`em-list`, `em-search --project p651 --no-track`, `em-recall`,
  `em-check-stale`, `em-prune --scope local --dry-run`, `em-pattern-health`,
  `em-rebuild-index --scope local`, `em-watch-codex` (status/read mode),
  `em-feedback` (read-then-write mode per script help), `em-restore` (dry/list mode)} →
  exit 1; last stdout line JSON `status:'error'`; `/episode index unreadable/`;
  `/index\.jsonl/`; no `at *.mjs` frames on stderr. Skip legs a given script cannot
  reach (document each skip inline with the reason).
- **T4 controls**: genuinely-missing index (clean parent) → `em-list`/`em-search`/`em-prune
  --dry-run` exit 0, `status:'ok'` (REQ-5); healthy symlink to a real index → `em-list`
  shows the seeded episode (REQ-6).
- **T5** protection: seeded store + each silent shape → `em-prune --scope local` (real,
  not dry-run) exits 1 and `episodes/<id>.md` still exists (REQ-7).
- **T6** rebuild guard: eaccess + symloop + file000 → `em-rebuild-index` exits 1 typed
  (envelope incl. remediation hint) AND `index.jsonl` shape is unchanged (REQ-8).
- **T7** vendored: shapes × {plugin em-search, em-list, em-check-stale} → typed abort
  (REQ-9).

Falsifiability gate (per #628 plan `:132`): before the fix lands, run the new suite
against pre-fix HEAD — every T3/T5/T6/T7 leg MUST fail (observed today: exit 0
`status:ok`, raw-stack exit 1, or timeout-kill `status:null`; expected post-fix: exit 1
typed). Record both runs in the PR.

Regression gates (absolute counts): `test-628-sibling-init-guard` → `5/5 pass`;
`test-prune-protection` → `32/32 pass`; `test-rfc-015-p1-s2-consolidation` → exit 0;
`test-ci-suite-registration` → exit 0; `test-plugin-version-bump` → exit 0;
`check-plugin-version-bump.mjs --base-ref origin/main` → exit 0.

## §9 Verification commands (orchestrator, post-build)

```
node tests/test-651-index-existence.mjs
node tests/test-628-sibling-init-guard.mjs
node tests/test-prune-protection.mjs
node tests/test-rfc-015-p1-s2-consolidation.mjs
node tests/test-ci-suite-registration.mjs
node tests/test-plugin-version-bump.mjs
node scripts/check-plugin-version-bump.mjs --base-ref origin/main
```

Plus independent behavior probes (not repo tests): re-run the §1 fixture probes on the
branch — symloop/dangling/eaccess/fifo/file000/parent-dangling must produce typed exit-1
envelopes on `em-list`, `em-search`, `em-recall`, `em-prune --dry-run`; control store
unchanged `status:ok`.

## §10 Review & handoff

Builder does not commit. Frozen diff goes to second-opinion review via
`scripts/second-opinion.mjs` (provider `claude-subagent`; GLM down 2026-08-02, codex
liveness unproven). Findings dispositioned ACCEPT/ACCEPT-WITH-MOD/REJECT/DEFER/
NEEDS-EVIDENCE in §11 below (appended at review time). Orchestrator commits the intended
slice only, opens PR "FIX-651: lstat-based index existence contract — typed aborts on
unreadable index shapes (fixes #651)", watches CI to green. Merge = operator.

## §11 Revision log

Revision 4 (2026-08-03, review round 2, reply 20260803-103806): F1-F5 all CLOSED by
independent runtime probe. New F2b MAJOR ACCEPT: `em-consolidate.mjs:459,:505` pass
archived-index failures to `indexUnreadableAbort(dataDir, e)` (`:194`), which hardcodes
`file: index.jsonl` — envelope names a healthy file. Fix: add an optional explicit
file param (default preserves main-index callers), pass `archivedIndexFile` at both
step-7c sites; new test leg asserts the fold abort envelope names
`archived-index.jsonl`, not `index.jsonl` (falsifiable: names the wrong file today).

Revision 3 (2026-08-03, second-opinion review round 1 REQUEST-CHANGES, reply
20260803-101837): F1 BLOCKER ACCEPT → step 7d (em-feedback scan-text FIFO hang);
F2 MAJOR ACCEPT → step 7c (archived-index mutation-path reads, classify pre-move);
F3 MAJOR ACCEPT-WITH-MOD → §4 sentence corrected, follow-up issue at PR time
(em-store append blocks on FIFO — pre-existing, out of scope); F4 MINOR ACCEPT →
step 7e (distinct error code); F5 NIT ACCEPT-WITH-MOD → step 7f (conditional field).
New test legs: T3 em-feedback --scan-text --dry-run × fifo; T5 archived-index fifo ×
em-prune real run with prunable row (falsifiable: SIGTERM-hang before, typed abort
nothing-moved after); em-topic-tracks error-code assert.

Revision 2 (2026-08-03, builder step-28 sweep NEW-SITE): added §7 step 7b —
`em-consolidate.mjs:366` `foldStore()` calls `loadIndex` and the single-store fold path
(`:577`) had no unreadable handling; post-step-2 it raw-crashed (fail-closed but
untyped, REQ-3 violation). Fix: typed abort at the single-store call site; new T3 leg
`em-consolidate --fold-superseded --dry-run` × silent shapes (falsifiable: raw
IndexUnreadableError stack before, typed envelope + no stack after). No other new
integration surface — the `--all-projects` loop already classifies pre-call (step 7).

Revision 1 (2026-08-03, negative-scenario audit HOLD → revised): (1) statement — folded
all 6 audit gaps + 2 DEFERs. (2) New things: parent-probe classifier branch
(`classifyParent`), read-error wrapping (`readIndexFileOrThrow`), `file000` +
`parent-dangling` fixture shapes, `archived_unreadable` stats field, rebuild lock
reorder + remediation envelope field, doctor archived-index report, §7 steps 11–16
(unswept importers), step 28 sweep verify, T3 legs for em-watch-codex/em-feedback/
em-restore/em-recall. (3) Each new branch has a §2 row (scope), no persistence beyond
process lifetime, terminal state = envelope/degrade per row, rollback = revert commit,
negative test = T1/T3 legs named above. (4) 8-axis re-walk on new surfaces: parent-probe
lstat EACCES → unreadable (§2 row 2); read-wrap changes the throw surface for all
importers at once → closed by step-28 sweep; remediation field is output-only. (5) New
integration surface: `index-state.mjs` is imported by relevance/protection/per-script
loaders; vendored copies remain inline (REQ-9 parity note).
