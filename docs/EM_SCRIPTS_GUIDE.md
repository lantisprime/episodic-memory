# EM Scripts Guide (agent-facing)

This is the per-script reference for the episodic-memory substrate an agent uses at
runtime. After `install.mjs` runs, every script below lives at
`~/.episodic-memory/scripts/` and is invoked with `node` and an absolute path:

```
node ~/.episodic-memory/scripts/<script>.mjs [flags]
```

There is also a unified dispatcher: `em <command>` ≡ `node
~/.episodic-memory/scripts/em-<command>.mjs` (shim at
`~/.episodic-memory/bin/em`; `em help --json` lists every command). Both forms
are equivalent — use whichever the harness makes easier.

Every script prints a single JSON object to stdout. Parse that JSON. Do not scrape
prose, and do not read the episode `.md` files or the `index.jsonl` directly to get
data that a script will return for you.

This guide is deployed to `~/.episodic-memory/EM_SCRIPTS_GUIDE.md` on every install.
Human-facing walkthroughs live in `docs/USER_MANUAL.md`. Installation per harness is
in `docs/install/`.

All outputs shown below are trimmed from real runs (Node v26, isolated sandbox).

---

## Intent routing (pick the right command)

Match your intent to the command. The third column is the wrong habit it replaces.

| Your intent | Right command | Wrong habit it replaces |
|---|---|---|
| "What happened recently?" / "did X happen?" | `em-list --project <name> --limit <n>` or `em-search --since <date> --tag <t> --no-track` | Guessing `--query` keywords and hoping for a hit |
| Session-start context before working | `em-recall --project <name> [--task-type implementation]` | Reading random episode files, or skipping recall entirely |
| Save a decision / discovery / milestone | `em-store --project <name> --category <cat> --summary ... --body ...` (use `--body-file` for long bodies; `--scope local` for repo-tied episodes) | Hand-writing an episode `.md` file |
| Correct a wrong past decision | `em-revise --original <id> --summary ... --body ...` | Editing the original episode file in place |
| Investigative / exploratory search | `em-search --query ... --no-track --no-score` | A plain `em-search` that reorders results and bumps access counts |
| Index looks wrong / out of sync | `em-rebuild-index --scope all` | Hand-editing `index.jsonl` |
| Anything feels broken / slow / inconsistent | `em-doctor` (then `em-doctor --fix`) | Guessing at which index to rebuild, or ignoring warnings |
| Maintenance should run itself (doctor/embed/backup/hygiene) | `em-routines sync`, then `em-routines list` | Hand-written crontabs, or the legacy machine-specific launchd script |
| A recalled episode actually helped / kept being irrelevant | `em-feedback --id <id> --useful` / `--noise` | Letting access counts alone decide future ranking |
| A decision must never fade or be pruned | `em-pin --id <id>` (or `em-store --pin`) | Re-storing the same decision periodically to keep it fresh |
| Episode stored in the wrong scope (global vs local) | `em-move --id <id> --to local\|global` | `mv` + manual rebuild (loses counters, leaves stale rows) or re-storing (new id, broken chains) |
| Store cluttered with near-duplicate episodes on one topic | `em-consolidate` (dry-run), then `--apply` | Leaving duplicates to dilute search, or deleting episodes by hand |
| "What does memory actually hold?" | `em-stats` | Counting episode files by hand |
| Topic lookup where wording differs from storage | `em-semantic --query <text>` (after `em-embed`) | Guessing synonyms into `em-search --query` |
| Find a topic across all projects | `em-search --query <topic> --scope all` | Grepping episode files |
| Show the full history of one episode | `em-search --history <id> --full` | Guessing which revision is current |
| "What is connected to this episode?" (lineage, clusters, hubs) | `em-graph --from <id>` / `--orphans` / `--hubs` | Manual joins across multiple searches |
| Significant session ended, nothing stored yet | `em-capture extract` then `review` (or `em-capture list` when recall reports `pending_drafts`) | Reconstructing the session from memory, or silently storing without review |
| Session start printed an install version-drift notice | `em-sync-install` (this project, from the dist cache) or `node <repo>/install.mjs --update-consumers` (all registered projects) | Hand-copying hook/skill files, or re-running full installs in every consuming project |
| One view of EVERY registered project's store (analytics/health/fold) | `em-stats --all-projects`, `em-doctor --all-projects`, `em-consolidate --fold-superseded --all-projects --dry-run` | Cd-ing into each project and running per-store commands |
| The same lesson keeps recurring across projects | `em-promote` (dry-run), then `em-promote --apply` (EXPERIMENTAL) | Re-learning it per project, or hand-copying lesson episodes to global |
| User wants to SEE the store (dashboard, browse, drafts, hygiene) | `em-console` — hand the user the printed URL | Pasting walls of JSON at the user |
| User wants guided maintenance in the terminal | `em-manage` (interactive menu) | Dictating flag-by-flag commands to a human |
| Make a lesson surface on a phrase / tool / activity (or rebuild that index) | `em-store --category lesson --trigger ...` then `em-trigger-index` | Hoping search recall happens to resurface the lesson |

Default write scope is GLOBAL. Pass `--scope local` to keep an episode inside the
current repo's `.episodic-memory/`. Searches read local and global together by
default.

---

## Hard rules

1. NEVER hand-write an episode `.md` file, and NEVER append a row to `index.jsonl`
   by hand. On 2026-07-04 a Pi Agent session hand-authored an episode file plus a
   raw `index.jsonl` row with frontmatter `created:` instead of `date:`/`time:`.
   Every later session that ran `em-list` then crashed with
   `TypeError: (b.date + b.time).localeCompare is not a function` (the sort at
   `em-list.mjs:64` reads `date` and `time`, which the hand-written row lacked).
   Read-side hardening is PR #447; writer-side validation is tracked in issue #448.
   Use `em-store` / `em-revise` so the frontmatter and the index row are always
   written together and correctly.
2. Episode IDs are immutable. A decision is never edited. It is corrected by a
   revision chain: `em-revise --original <id>` writes a new episode that supersedes
   the old one, and default searches then return only the latest active version.
3. Every script prints JSON to stdout. Parse it. Do not scrape prose or log lines.
4. After install the scripts live at `~/.episodic-memory/scripts/`. Always invoke
   them with `node` and the absolute path shown above, from any working directory.
5. Every installed script supports `--help` / `-h` (PR #449): a standalone help
   token anywhere in the arguments prints one JSON object
   `{"status":"help","script":"<name>.mjs","usage":"..."}` and exits 0 with zero
   side effects. Exception: for `em-lock`, tokens after its `--` separator belong
   to the wrapped command and never trigger help. On OLDER deployed copies
   (before PR #449) `--help` was not universal and probing could RUN a script's
   default behavior, including a real `em-prune` pass; if `--help` returns
   anything other than `status: "help"`, refresh the install before probing
   further, and read the flag lists in this guide instead.

---

## Read-only manifest (checkpoint-gate integration, E4)

`patterns/readonly-commands.json` (schema:
`patterns/readonly-commands.schema.json`; deployed to
`~/.episodic-memory/patterns/readonly-commands.json`) is the first-party
registry of command shapes that are read-only BY DESIGN. The Claude Code
checkpoint gate consults it — via `scripts/classifier-hold-consult.mjs`, on
the canonical form from `scripts/lib/command-canonical.mjs` — before holding a
novel Bash command for agent classification, so by-design readers (`em-stats`,
`em-graph`, `em-doctor` without `--fix`, `em-pattern-health --check`,
`em-recall` with its documented read flags, `node --version`, and the readers
already hardcoded in the shell classifier) run without a false-positive hold.

Maintenance rule: when a script gains a WRITE flag, add it to that entry's
`deny_flags` (or move the entry to a closed `allow_flags` list) in the same
PR; when a new read-only script ships, add an entry citing this guide. A stale
manifest fails CLOSED (the hold returns) — never open. Tests:
`tests/test-readonly-manifest.mjs`.

On a manifest miss the gate additionally tries a non-interactive LLM
auto-classify (`llm-classify.mjs --three-way`; requires `ANTHROPIC_API_KEY`,
hard 10s timeout, confidence >= 0.8, verdict cached with `"source":"llm"`)
before falling back to the agent hold. See
`plugins/claude-code/hooks/README.md` for the full consult order.

---

## Category vocabulary (RFC-009 R10)

The set of valid episode categories is a closed vocabulary defined once in
`categories.json` (repo root; deployed to `~/.episodic-memory/categories.json`), read by
every script through `scripts/lib/categories.mjs`. Do not hardcode category names anywhere.

- Members: `decision`, `discovery`, `milestone`, `context`, `research`, `lesson`,
  `violation`, `workflow.lifecycle`, `workplan`, `temporary`.
- A **category** is a single load-bearing typed field (exactly one per episode, drawn from
  this vocabulary). **Tags** are a free-form, additive label set and are never load-bearing
  in control flow. Filter by category with `em-search --category`, by tag with `--tag`.
- **Write surfaces are strict**: `em-store` and `em-revise` reject an unknown or deprecated
  category (a deprecated one names its successor). `em-restore --apply` skips-and-surfaces an
  unknown-category episode instead of writing it through.
- **Read/index/prune surfaces are tolerant**: an episode with an unknown category never breaks
  listing, search, ranking, or index build; `em-rebuild-index --check` reports it as drift.
- **Lifecycle**: most categories are `standard`. `temporary` is `aggregate-then-prune` — once a
  temporary episode is consolidated (carries `superseded_by`), `em-prune` may archive it
  aggressively even if it is referenced by a successor's `consolidates` array.
- **Deprecation** is by mapping, never deletion: a member gains `deprecated_for: <successor>`
  and readers map it at read/index time; stored episode bytes are never rewritten.

---

## Lesson activation (RFC-009 R1/R2 write + index, R3/R4 event plane)

Lesson episodes may carry OPTIONAL activation frontmatter, written through flags on
`em-store`/`em-revise` (lesson-only; any other category rejects them):

- `--trigger <value>` (repeatable) — three explicit kinds: a plain **phrase**
  (`"second opinion"`), a **tool** binding (`tool:Bash:git*`), or an **activity**
  class (`activity:plan`). Activity classes come from the closed vocabulary in
  `activation-classes.json` (repo root; deployed to `~/.episodic-memory/`) —
  `plan|design|review|troubleshoot|implement|push|rule`; an unknown or deprecated
  class is rejected at write time. (Phrase sets inside the vocabulary are empty in
  P1b; the P2 activation adapter populates and consumes them.)
- `--applies-to-project <slug|*>` / `--applies-to-tool <id>` (repeatable) — scoping;
  tool ids are the fixed set `claude-code|codex|opencode|pi-agent|cursor|windsurf`.
- `--priority <1-7>` (default 5) — the DECLARED priority. **8-9 is the EARNED
  critical band and is never writer-declarable**: it is derived at trigger-index
  build time from linked violations (one linked violation → `effective_priority` 8,
  two or more → 9). Stored episode bytes are never mutated by the band.
- `--review-by <YYYY-MM-DD>` — expiry; an expired lesson drops out of the trigger index.
- `--evidence <violation-id>` (repeatable) — back-link a lesson to the violations
  that prove it matters. Validated at write time against the MERGED local+global
  index (existence + `category: violation`).

`em-violation` gains the symmetric `--lesson <lesson-id>` (repeatable) forward-link and
now writes a typed `violated_pattern: <pattern-id>` frontmatter scalar (T6): `em-recall`'s
violation preflight and `em-pattern-health`'s strike counting read the typed field,
dual-read with the legacy `violated:<id>` tag during the burn-in window (issue #457).

`em-trigger-index` builds ONE derived `trigger-index.json` per store (see its full
entry); writes of trigger-bearing lessons print an informational R9a collision report
on stderr when another active lesson shares a trigger phrase (the write always proceeds).
The `RFC-009-lesson-activation.contract.json` mirror + `validate-rfc-009-contract-mirror.mjs`
diff these surfaces against code in CI.

### Event plane — the advisory activation adapter (R3/R4, P2)

The adapter is the CONSUMER half: a Claude-Code-only, per-project, opt-in set of three thin
hooks installed by `install.mjs --install-activation` (reverse with `--uninstall-activation`).
It never enforces — every hook exits 0 and emits no decision/block field — and reads ONLY the
purpose-built derived indexes, never `index.jsonl`, episode bodies, or environment:

- `activation-prompt` (UserPromptSubmit) and `activation-tool` (PreToolUse) match the merged
  `trigger-index.json` against the event and inject up to `max_matches` bounded lesson pointers
  as `additionalContext` (band 8-9 rendered imperatively; ≤7 plain).
- `activation-sessionstart` (SessionStart) renders the precomputed `session_start` blend:
  tier-1 `critical_entries` (every active band 8-9 lesson, trigger-independent) then tier-2
  `entries` (static-score top-N, cross-tier deduped) plus the violation preflight (per-task-type
  counts derived from the `violated_pattern` field).
- All three share `activation-hook-run.mjs` and a co-located `manifest.json` carrying the
  project scope identity (slug + resolved root); the hook filters `applies_to_*` against THAT
  identity, never inherited cwd or environment.

Per-project suppression: a hand-authored `<project>/.episodic-memory/lesson-suppress.json`
(`{ "schema_version": 1, "suppress": [{ "episode_id", "reason", "added" }] }`, schema
`schemas/lesson-suppress.schema.json`) mutes lessons by id across ALL bands. The whole-file
load is fail-open: a **missing** file yields no suppression **silently** (no note — the common
case); a present-but-unreadable, syntax-malformed, or shape-malformed file yields no suppression
plus exactly one stderr note. Injection always proceeds — never fatal. There is no `em-suppress` writer
this phase; the file is hand-authored (RFC-009 R1). Suppression is for SCOPE errors; correct a
WRONG lesson via `em-revise` supersession instead (the superseded version drops from the index).

**Playbooks (RFC-011 R3/R4).** A per-project `<project>/.episodic-memory/playbooks.json`
extends the session-start surface and the on-demand matcher with DECLARED pointers
to playbook lesson episodes — the voluntary counterpart to the earned critical band
(see `em-trigger-index` for the derived data and `em-search --read` for the tracked
bounded read the pointers name). The session-start hook renders one imperative line
per `session_start` playbook, AFTER the tier-1 critical band and BEFORE the tier-2
static blend:

```
playbook (playbooks.json): READ <terminal-id> before proceeding (node <scripts>/em-search.mjs --read <terminal-id>): <summary>
```

The `playbook (playbooks.json):` provenance prefix is load-bearing — declared
injection is visible and auditable, never ambient. `lesson-suppress.json` mutes a
playbook id by episode id (applied before dedup, like every band). A playbook id
that is also a tier-1 candidate renders once in the critical form instead, and
playbook ids are excluded from the tier-2 blend (one id, one line). When the build
capped declarations the note carries `+N declared playbooks capped, incl. <id>`;
when the token budget drops a line, `+N more suppressed, incl. playbook <episode_id>`.
On demand, `entry_class: "playbook"` rows (derived from `on_demand` declarations)
flow through the existing `matchActivation` matcher untouched and render the same
playbook form when matched. The adapter stays advisory — every path exits 0 with no
decision field; an ABSENT `playbooks.json` is normal zero-state (renders nothing,
silent); a MALFORMED file renders nothing with a stderr note.

---

## Full entries

### em-store

Create a new episode.

- WHEN TO USE: a significant decision, a bug root cause or non-obvious discovery, a
  milestone, a critical constraint, or an explicit "remember this". Store 0 to 3 per
  session.
- WHEN NOT TO USE: routine edits, credentials, or anything already captured. Never
  as a substitute for `em-revise` when correcting an existing episode.

```
node ~/.episodic-memory/scripts/em-store.mjs \
  --project <name> \
  --category <decision|discovery|milestone|context|research|lesson|violation|workflow.lifecycle> \
  --tags "<t1,t2>" \
  --summary "<one line>" \
  --body "<detail>" \
  [--body-file <path>] [--scope local|global] [--url <source-url>]
```

Output on success:

```json
{"status":"ok","id":"20260704-133309-chose-jwt-over-sessions-7cd4","file":".../episodes/20260704-133309-chose-jwt-over-sessions-7cd4.md","scope":"global"}
```

Output when required args are missing:

```json
{"status":"error","message":"Missing required args. Usage: --project <name> --category <decision|discovery|milestone|context|research|lesson|violation|workflow.lifecycle> (--tags <t1,t2> | --tag <t> [--tag <t> ...]) --summary <text> (--body <text> | --body-file <path>) [--scope local|global]"}
```

Flags that matter:
- `--scope` defaults to `global`. Pass `--scope local` for episodes that should stay
  inside this repo.
- `--body-file <path>` reads the body from a file. Use it for long bodies (plan
  documents) so a huge inline `--body "$(cat ...)"` does not trip a shell or a
  permission gate. Mutually exclusive with `--body`.
- Tags accept `--tags a,b`, repeated `--tag a --tag b`, or a mix. They are merged,
  deduplicated, lowercased, and sorted.
- Lesson-only activation flags (`--trigger`, `--applies-to-project`, `--applies-to-tool`,
  `--priority`, `--review-by`, `--evidence`) — see "Lesson activation" above. Inline-array
  values may not contain `,` `[` `]` `"` (rejected before any write).

Common mistakes: forgetting `--category`; passing `--scope local` when you meant the
default global; hand-writing the file instead of calling this script; trying
`--priority 8` (the 8-9 band is earned, not declared).

### em-revise

Supersede an existing episode with a corrected one.

- WHEN TO USE: a stored decision proved wrong or changed. The original is marked
  `superseded` and the new episode becomes the active one.
- WHEN NOT TO USE: to fix a typo (that is still a revision, but consider whether it
  is worth a chain entry); never edit the original file directly.

```
node ~/.episodic-memory/scripts/em-revise.mjs \
  --original <episode-id> \
  --summary "<what changed>" \
  --body "<why / the correction>" \
  [--tags "<t1,t2>"] [--body-file <path>] [--scope inherit|local|global]
```

Output:

```json
{"status":"ok","id":"20260704-133309-switched-to-session-cookies-285f","file":".../episodes/20260704-133309-switched-to-session-cookies-285f.md","supersedes":"20260704-133309-chose-jwt-over-sessions-7cd4","scope":"global"}
```

Flags that matter:
- `--scope` defaults to `inherit` (the revision lands in the same store as the
  original). Only pass `local` or `global` to force a cross-store move.
- Tags are inherited from the original and merged with any you pass.
- The same lesson-only activation flags as `em-store` apply (validated against the
  INHERITED category). Activation, linkage, and `violated_pattern` are INHERITED
  from the original — like tags — so a typo-revision never demotes a lesson to
  freeform; a flag passed on the revise OVERRIDES that one field (replace, not merge).

Common mistakes: inventing a new episode with `em-store` instead of revising, which
leaves both versions active and searchable.

### em-search

Search episodes with local plus global fallback.

- WHEN TO USE: "what did we decide about X", finding an episode id to revise, or any
  topic lookup.
- WHEN NOT TO USE: to list the newest N episodes with no query (use `em-list`), or at
  session start (use `em-recall`).

```
node ~/.episodic-memory/scripts/em-search.mjs \
  [--project <name>] [--query <text>] [--tag <t>] [--category <cat>] \
  [--since <YYYY-MM-DD>] [--limit <n>] [--scope local|global|all] \
  [--full] [--include-superseded] [--read <id>] [--history <id>] [--no-score] [--no-track]
```

Output:

```json
{"status":"ok","count":1,"episodes":[{"id":"20260704-133309-chose-jwt-over-sessions-7cd4","date":"2026-07-04","time":"13:33","project":"demo","category":"decision","status":"active","supersedes":null,"tags":["api","auth"],"summary":"Chose JWT over sessions","source":"global"}]}
```

Flags that matter (from the script's own `Usage:` header):
- `--query` is tiered: exact summary match (1.0) > contiguous summary substring
  (0.7) > all-tokens-match across summary/tags/body (field-weighted, < 0.7) >
  contiguous body substring (0.4). Multi-word queries no longer need to be an
  exact substring — every token just has to land somewhere. Token order does
  not matter.
- Query lookups are accelerated by `tokens.json` (a token inverted index the
  writers maintain; rebuilt by `em-rebuild-index`). Results are identical to a
  full scan — the index only prunes candidates. Missing index → slow full
  scan + a rebuild warning. Tokens dropped by the df diet (recorded under the
  index's `_dropped` marker; see `em-rebuild-index`) are non-pruning: a query
  containing one falls back to full scoring for that token instead of
  returning zero candidates, so results stay identical there too.
- Partial tier: when strict matches leave `--limit` unfilled, multi-word
  queries also return episodes matching at least HALF the tokens, marked
  `"match":"partial"` and scored below every full match. `--no-score`
  suppresses partials (stable recency contract).
- By default `em-search` scores results by relevance and tracks access (each hit
  bumps the episode's `access_count` and reorders future relevance).
- `--no-score` skips relevance scoring so results come back in a stable
  recency order.
- `--no-track` skips access tracking. Use it (with `--no-score`) for investigative
  or repeated searches so you do not pollute the usage signals that recall relies on.
  History queries and `--include-superseded` already skip tracking.
- `--full` includes episode bodies. `--history <id>` returns the whole revision
  chain. The walk follows `supersedes`, `superseded_by`, and `consolidates` edges
  (cycle-safe); a single-`supersedes` chain is unchanged. Chain members that
  were archived (`em-prune`, `em-consolidate --fold-superseded`) still appear:
  the walk also reads `archived-index.jsonl`, flags them `"archived": true`,
  and `--full` resolves their bodies from `archived/`.
- `--read <id>` is the tracked, bounded, single-episode read (RFC-011 R7) the
  playbook pointers name. It fetches exactly ONE episode by exact id — no
  chain walk, no search fallthrough (an unknown OR empty id returns
  `{"status":"error"}` exit 1; an empty value never falls through to search).
  The episode payload is built from the episode FILE's parsed frontmatter
  merged over the index row (the file wins for frontmatter fields; the index
  row supplies `access_count`/`last_accessed`/`source`), so hand-authored or
  foreign frontmatter keys survive the read. The read resolves `episodes/`
  then `archived/` (an archived episode returns normally with its `status`
  field visible). The body is bound to its SERIALIZED form in bytes: it is
  truncated until `Buffer.byteLength(JSON.stringify(body), 'utf8') <= 49152`
  with `body_truncated: true` and a stderr note (a truncated body is a prefix
  of the original; output is always valid JSON). An index row whose body file
  is absent from BOTH `episodes/` and `archived/` returns `body_missing: true`
  with a stderr note and is NOT tracked (a delivered-nothing read must never
  feed the conversion metric a clean follow). Otherwise the read WRITES access
  tracking (`access_count` +1, `last_accessed`) on that row; `--no-track`
  skips it. If both `--read` and `--history` are passed, `--read` wins.
- `--category <cat>` is index-backed via `category-index.json` (same degrade-to-linear-scan
  fallback as `--tag`). A deprecated category name canonicalizes to its successor; an unknown
  category still filters (tolerant read).

`--history` output (chain, oldest first):

```json
{"status":"ok","count":2,"chain":[{"id":"...-chose-jwt-over-sessions-7cd4","status":"superseded",...},{"id":"...-switched-to-session-cookies-285f","status":"active","supersedes":"...-chose-jwt-over-sessions-7cd4",...}]}
```

`--read <id>` output (found — file frontmatter merged over the row, body
included, access tracked; an unknown OR empty id returns the `error` shape and
exit 1, never a search fallthrough):

```json
{"status":"ok","episode":{"id":"ep-read-1","date":"2026-07-08","time":"00:00","project":"t","category":"lesson","status":"active","summary":"tracked bounded read demo","tags":[],"triggers":["x phrase"],"priority":5,"access_count":0,"last_accessed":null,"source":"local","body":"# tracked bounded read demo\n\nthe playbook body text"}}
{"status":"error","message":"Episode \"unknown-id\" not found"}
```

The read tracks access on the matched row (it bumps the index row's
`access_count` +1 and stamps `last_accessed`); the values in the emitted
episode are the PRE-increment row values (`access_count` 0 and `last_accessed`
`null` on a first read), so the on-disk row reads `1` / a timestamp after the
read. `--no-track` leaves the row untouched. A body whose
`JSON.stringify(body)` exceeds 49152 bytes returns `body_truncated: true` (the
body is truncated to AT MOST the cap — <= 49152 serialized bytes, a prefix of
the original); a row with no body file in either `episodes/` or `archived/`
returns `body_missing: true` and is not tracked. Both print a stderr note.

Common mistakes: guessing `--query` words when you actually want a time or tag
filter (use `--since` / `--tag` / `--category`); running plain `em-search` in a loop
and skewing relevance instead of adding `--no-track --no-score`.

### em-list

List the most recent episodes, newest first. No relevance scoring.

- WHEN TO USE: "what happened recently", a quick catch-up, confirming a store landed.
- WHEN NOT TO USE: topic search (use `em-search`), or context assembly at session
  start (use `em-recall`).

```
node ~/.episodic-memory/scripts/em-list.mjs [--project <name>] [--limit <n>] [--scope local|global|all] [--include-superseded]
```

Output:

```json
{"status":"ok","count":1,"episodes":[{"id":"20260704-133309-chose-jwt-over-sessions-7cd4","date":"2026-07-04","time":"13:33","project":"demo","category":"decision","status":"active","supersedes":null,"tags":["api","auth"],"summary":"Chose JWT over sessions","source":"global"}]}
```

Common mistakes: expecting a `--query` flag (there is none); this is a pure recency
list.

### em-recall

Proactive session-start recall via a three-pass retrieval (project match, tag match,
recent cross-project) plus behavioral-pattern pre-flight warnings.

- WHEN TO USE: the first thing you do when starting work on a project. Pass
  `--task-type implementation` before code work to surface recent bp-001 / bp-006
  violations from the last 30 days.
- WHEN NOT TO USE: for a specific topic lookup (use `em-search`).

```
node ~/.episodic-memory/scripts/em-recall.mjs [--project <name>] [--task-type <implementation|push|rule|general>] [--scope local|global|all] [--limit <n>] [--days <n>] [--no-track]
```

Output shape:

```json
{"status":"ok","context":{"project":"demo","branch_tokens":["..."],"effective_tokens":["..."],"task_type":null},"count":3,"episodes":[{"id":"...","summary":"Chose JWT over sessions","source":"global","score":0.998}],"preflight_warnings":[],"prune_suggestion":null}
```

Flags that matter: `--task-type implementation` adds the violation pre-flight;
`--no-track` avoids bumping access counts if you are recalling repeatedly.

Common mistakes: skipping recall and re-deriving context that a past session already
recorded.

### em-pin

Pin/unpin an episode. Pinned episodes never decay below a 0.6 time factor in
search/recall scoring (unpinned floor 0.1) and are never archived by
`em-prune`. Revisions inherit pinning.

- WHEN TO USE: a foundational decision (architecture choice, hard-won
  constraint) that must stay competitive with fresh episodes indefinitely.
- WHEN NOT TO USE: routine notes — pinning everything defeats decay.

```
node ~/.episodic-memory/scripts/em-pin.mjs --id <episode-id> [--unpin]
```

Output: `{"status":"ok","id":"...","pinned":true,"scope":"local"}`. You can
also pin at creation time: `em-store --pin` / `em-revise --pin`.

### em-feedback

Record whether a recalled episode was actually useful. `access_count` says an
episode was SEEN; this counter says it HELPED (+1, `--useful`) or was noise
(-1, `--noise`). The scorer folds it in at ±5% per point (clamped −30%/+50%),
so consistently useful episodes rise and consistently irrelevant ones sink.

- WHEN TO USE: after a recalled/searched episode genuinely shaped a decision
  (`--useful`), or when the same irrelevant episode keeps surfacing
  (`--noise`).
- WHEN NOT TO USE: as a bookmark (that is `em-pin`) or reflexively on every
  search hit — feedback is signal precisely because it is deliberate.

```
node ~/.episodic-memory/scripts/em-feedback.mjs --id <episode-id> (--useful | --noise)
node ~/.episodic-memory/scripts/em-feedback.mjs --scan-text <file> [--scope local|global|all] [--dry-run]
```

Output: `{"status":"ok","id":"...","feedback":3,"scope":"global"}`. Counter
clamps to [-10, 10] and survives index rebuilds.

`--scan-text` is batch inference: an episode id cited in a session handoff,
PR body, or lessons write-up demonstrably shaped that artifact, which is the
`--useful` signal without the typing. It extracts episode-id patterns (shape
derived from em-store's generator), dedupes, skips ids that do not resolve in
the selected scope(s), and records ONE +1 per resolved id. `--dry-run`
previews without writing. Wrap-up habit: scan the handoff/PR body so cited
episodes earn recall weight.

Output: `{"status":"ok","mode":"scan-text","scope":"all","scanned":1,"matched":5,"resolved":4,"recorded":4,"skipped_unresolved":1,...}`

### em-move

Atomic episode relocation between scopes (RFC-005). Preserves the id,
supersedes chain, access/feedback counters, and pinned flag; updates
index.jsonl, tags.json, category-index.json, and tokens.json in BOTH scopes;
writes an audit episode (category `context`, tag `em-move`) to the
destination scope.

- WHEN TO USE: demoting a project-specific episode that leaked into global,
  or promoting a local lesson that proved cross-project.
- WHEN NOT TO USE: content edits (`em-revise`), archival (`em-prune`),
  cross-project moves (out of scope by design).

```
node ~/.episodic-memory/scripts/em-move.mjs (--id <full-id> | --ids <id1,id2,...> | --filter-tag <tag>) \
  --to local|global [--dry-run] [--reason <text>] [--no-audit] [--confirm] [--break-anchors]
```

Safety gates: full ids only; >10 episodes needs `--confirm`; ids hardcoded in
`MEMORY.md` anchors refuse without `--break-anchors`; found-in-both-scopes
with different content is a hard error (identical content completes the
interrupted move). Every refusal path writes nothing.

Output: `{"status":"ok","moved":[{"id":"...","from":"global","to":"local","audit_id":"..."}],"noop":[],"errors":[]}`

### em-consolidate

Fold clusters of near-duplicate episodes into digest episodes (RFC-001's
semantic-consolidation capability). Dry-run by DEFAULT — `--apply` writes.

- WHEN TO USE: a topic has accumulated several overlapping episodes that
  dilute search results; periodic store hygiene.
- WHEN NOT TO USE: correcting one wrong episode (`em-revise`), or archival
  (`em-prune`). Digests never re-fold; pinned members are excluded unless
  `--include-pinned`; violation/workplan/workflow.lifecycle never cluster.

```
node ~/.episodic-memory/scripts/em-consolidate.mjs [--scope local|global] \
  [--min-sim <0..1>] [--min-cluster <n>] [--category <cat>] [--project <name>] \
  [--include-pinned] [--apply] [--confirm]
node ~/.episodic-memory/scripts/em-consolidate.mjs --fold-superseded \
  [--min-chain <n>] [--dry-run] [--scope local|global]
node ~/.episodic-memory/scripts/em-consolidate.mjs --fold-superseded \
  --all-projects [--min-chain <n>] [--dry-run] [--confirm]
```

Clustering is body-token Jaccard within (project, category) groups; the
0.35 default separates genuine near-duplicates (~0.35–0.5) from unrelated
episodes (~0.0). On `--apply`, each cluster gets one digest episode carrying
`consolidates: [ids...]`, union tags, full member bodies, and inherited
pinning; members flip to `status: superseded` + `superseded_by: <digest>` in
file and index, so they stop surfacing but stay reachable via `--history`.
More than 5 clusters requires `--confirm`.

`--fold-superseded` targets long revision chains instead of duplicates: for
each LINEAR supersedes-chain with at least `--min-chain` members (default
10), the non-terminal members are archived via the same mechanism `em-prune`
uses (file to `archived/`, index row to `archived-index.jsonl`, `tags.json`
cleaned — a reversible move, never a delete). The terminal episode is
untouched, ids stay immutable, bodies are never edited, and
`em-search --history` still shows the full chain (the walk reads archived
metadata; archived members carry `"archived": true`). Pinned or
still-active members are kept and reported; forked/non-linear chains are
skipped whole. `--dry-run` lists exactly what a real run would move. Output:
`{"status":"ok","mode":"fold-superseded","dry_run":false,"chains":[{"terminal":"...","chain_length":12,"folded":[...],"kept":[...]}],"folded_total":11}`.

`--all-projects` (fold mode only, mutually exclusive with `--scope`) folds
every consumer-registry store in one pass; output gains a per-store `stores`
array. A REAL multi-store run requires `--confirm` and fails closed before
any move. R6 protection is unioned across cwd-local + global + ALL registered
stores, so a referencer in any store protects a chain member in any other.
Registrations whose substrate-resolved store is not `<project>/.episodic-memory`
(git-nested paths, linked worktrees, symlinked store dirs) are reported
`skipped_store: "non-root-store"` and never written.

### em-stats

Read-only store analytics — never writes, never bumps access counters.

```
node ~/.episodic-memory/scripts/em-stats.mjs [--scope local|global|all] [--top <n>] [--all-projects]
```

`--all-projects` appends one scope block per consumer-registry store (label
`project:<basename>`; the `dir` field is the identity — labels can collide,
dirs cannot). Stores already covered by the `--scope` blocks are skipped by
realpath, so a symlink-aliased local store never double-counts. Totals include
the appended blocks.

Per scope: episode totals (active/superseded/pinned), archived count,
category + project + tag distributions, age buckets, access/feedback
aggregates, a prunable estimate (same threshold as em-prune; pinned rows
excluded), index-file presence/sizes, the date range, and
`derived_index_bloat_ratio` (tokens.json bytes / index.jsonl bytes; `null`
when either file is absent). A ratio far above ~1-5x means the token index is
dominated by non-discriminating posting lists — `em-rebuild-index` applies
the df diet and shrinks it; `em-doctor` warns above 20x.

### em-embed

Build or update the embeddings sidecar (`embeddings.jsonl`) that powers
`em-semantic`. Incremental: only new/changed episodes re-embed; superseded
episodes are skipped and stale rows dropped.

```
node ~/.episodic-memory/scripts/em-embed.mjs [--scope local|global|all] \
  [--provider hash|cmd] [--cmd "<command>"] [--model <name>] [--rebuild]
```

Providers:
- `hash` (default) — built-in deterministic IDF-weighted feature hashing.
  Offline, zero-dep, no setup. Similarity = weighted exact-token overlap
  (rare terms count more). No substring/synonym awareness.
- `cmd` — pipes `{id,text}` JSONL to your command (`--cmd` or
  `$EM_EMBED_CMD`), reads `{id,vector}` JSONL back. Wire real embedding
  models here (ollama, API endpoints); the substrate stays zero-dependency.

Ready-made adapters live in the repo under `examples/embedders/`:
`ollama-embed.sh` (local Ollama, default model `nomic-embed-text`) and
`openai-embed.sh` (OpenAI-compatible endpoints, batched into one API call).
Both are python3-stdlib only:

```
node em-embed.mjs --scope all --cmd "sh <clone>/examples/embedders/ollama-embed.sh" --model ollama-nomic
```

Persistent configuration — no flags needed per call: the installer wizard's
semantic-search step (or your editor) writes
`~/.episodic-memory/embed-config.json`:

```json
{ "provider": "cmd", "cmd": "sh <clone>/examples/embedders/ollama-embed.sh", "model": "ollama-nomic" }
```

Both em-embed and em-semantic read it through the same resolver. Precedence:
explicit `--provider`/`--cmd`/`--model` flags > `$EM_EMBED_CMD` >
embed-config.json > built-in hash. A malformed config degrades to hash.

### em-semantic

Similarity search over the embeddings sidecar. Ranks by cosine similarity ×
the standard decay/usage/pinning/feedback score. Refuses model mismatches
(query and sidecar must be embedded by the same provider/model).

- WHEN TO USE: topic lookups where your wording may not overlap the stored
  wording (with a real `cmd` model), or IDF-weighted topical ranking (hash).
- WHEN NOT TO USE: exact phrases, tags, dates — `em-search` is sharper there.

```
node ~/.episodic-memory/scripts/em-semantic.mjs --query <text> [--scope local|global|all] \
  [--limit <n>] [--min-sim <0..1>] [--project <name>] [--provider hash|cmd] [--cmd "<command>"] [--full] [--no-track]
```

Output adds `similarity` per episode:
`{"status":"ok","count":2,"model":"hash-v1-256","episodes":[{"id":"...","similarity":0.71,"score":0.68,...}]}`

LLM re-ranking (optional): `--rerank-cmd "<command>"` (or `rerank_cmd` in
`~/.episodic-memory/embed-config.json`, or `$EM_RERANK_CMD`) pipes the top
candidate window (3× limit, capped at 30) through a reranker — stdin JSON
`{query, candidates:[{id,summary,similarity}]}` → stdout `{"order":[ids]}`.
The shipped `examples/rerankers/claude-rerank.sh` drives `claude -p` using
your existing Claude Code login (no API key; Anthropic has no embeddings API,
so Claude re-ranks rather than embeds). Reranker failure falls back to vector
order with a `warning`; `--no-rerank` bypasses a configured reranker. Output
gains `"reranked":true` when applied.

### em-routines

Scheduled-maintenance manager: definitions live in
`~/.episodic-memory/routines.json` (data, not code), applied to whatever
scheduler the machine actually has — launchd (macOS), systemd user timers
(Linux), or a managed crontab block (fallback; foreign entries preserved
byte-for-byte).

- WHEN TO USE: `sync` once after install (or via the wizard /
  `install.mjs --install-routines`); `list` to check health; `run <r>` to
  trigger one now; `add` for your own scheduled commands.
- WHEN NOT TO USE: one-off maintenance (call em-doctor etc. directly).

```
node ~/.episodic-memory/scripts/em-routines.mjs sync            # seed + schedule defaults
node ~/.episodic-memory/scripts/em-routines.mjs list            # config + platform + last-run + staleness
node ~/.episodic-memory/scripts/em-routines.mjs run doctor
node ~/.episodic-memory/scripts/em-routines.mjs enable|disable <r>
node ~/.episodic-memory/scripts/em-routines.mjs add --name <n> --cron "0 4 * * *" --cmd "<command>"
node ~/.episodic-memory/scripts/em-routines.mjs logs <r> [--lines <n>]
node ~/.episodic-memory/scripts/em-routines.mjs uninstall       # de-schedule; config + logs kept
```

Built-ins (all zero-LLM, safe unattended, no-op when their feature is
unconfigured): `doctor` daily 08:15 (auto-repair), `embed` daily 03:30
(sidecar refresh), `backup-sync` daily 23:00, `hygiene-report` Sunday 09:00
(read-only consolidate/prune/stats report). Every run — scheduled or manual —
records state (`logs/routines/state.json`); `list` flags a routine **stale**
when an enabled, scheduled routine hasn't run within 2× its interval (a
silently-dead scheduler) and exits 1 so you can cron-check the checker.
Cron expressions: 5 fields, each `*` or an integer (dom/month must be `*`) —
anything launchd/systemd can't express is rejected, never mistranslated.

### em-graph

Typed-edge traversal over the episode graph (RFC-007 core). Projection over
file storage, built fresh per query — no sidecar DB.

```
node ~/.episodic-memory/scripts/em-graph.mjs --from <id> [--depth <n>] [--limit <n>] \
  [--edges supersedes,consolidates,evidence,cites,tags|all] [--scope local|global|all]
node ~/.episodic-memory/scripts/em-graph.mjs --orphans     # no non-tag edges at all
node ~/.episodic-memory/scripts/em-graph.mjs --hubs [--top <n>]
```

Edges: `supersedes` (chains), `consolidates` (digest→member), `evidence`
(lesson↔violation), `cites` (episode ids in BODIES — fenced code/backticks
skipped, frontmatter excluded), `tags` (opt-in pseudo-nodes for cluster
queries). Undirected BFS, depth default 2, node limit 50 (closest first,
`truncated` flagged). Lineage keeps superseded nodes, marked via `status`.
Output: `{root, nodes:[{id,distance,summary,...}], edges:[{from,to,type}]}`.

### em-capture

Session auto-capture (wave-6 #2): draft candidate episodes from a session
transcript at session end; confirm them into the store later.
Confirm-before-store is the invariant — drafts are never silently promoted.

- WHEN TO USE: a significant session ended and nothing was stored; reviewing
  `pending_drafts` surfaced by `em-recall`; enabling continuous capture via
  the wizard.
- WHEN NOT TO USE: as a substitute for deliberate `em-store` at
  decision/lesson time — capture is the safety net, not the primary path.

```
node ~/.episodic-memory/scripts/em-capture.mjs extract [--transcript <path>] [--session-id <id>]
  [--project <name>] [--mode heuristic|cmd] [--cmd "<command>"] [--max <n>] [--dry-run]
node ~/.episodic-memory/scripts/em-capture.mjs list
node ~/.episodic-memory/scripts/em-capture.mjs review --draft <id>
  (--accept <n,...> | --accept-all | --reject <n,...> | --discard) [--scope local|global]
```

Drafts live at `~/.episodic-memory/drafts/<draft-id>.json` — not episodes, no
index rows, invisible to search/recall ranking (recall reports only a
`pending_drafts` count). Heuristic mode (default, zero-LLM) scans for explicit
markers ("remember this", "lesson:", "decision:"), assistant decision
language, error-then-fix command pairs, and merged-PR milestones; fenced code
and inline backticks are stripped first. `cmd` mode pipes
`{session_id, project, max, chunks}` to a user command returning
`{candidates:[...]}` — template: `examples/capturers/claude-capture.sh`
(drives `claude -p` via your existing login). Accepts write through
`em-store.mjs` as a subprocess (category validation + indexing apply) and are
tagged `auto-captured`. `em-doctor` warns on drafts older than 14 days.

### em-check-stale

Report research episodes whose source URL may be out of date.

- WHEN TO USE: at session start, or when you encounter a URL you have research for,
  to decide whether to re-fetch and `em-revise`.
- WHEN NOT TO USE: as a general search.

```
node ~/.episodic-memory/scripts/em-check-stale.mjs [--days 30] [--project <name>]
```

Output:

```json
{"status":"ok","count":1,"stale":[{"id":"...","category":"research","summary":"...","url":"https://...","fetched":"2026-05-26","daysOld":39}]}
```

### em-rebuild-index

Regenerate `index.jsonl` (plus `tags.json`, `category-index.json`, and the
`tokens.json` full-text token index) from the episode `.md` files on disk.
Atomic (temp plus rename). Idempotent: safe to run repeatedly. Preserves
`access_count`/`last_accessed`/`feedback` from the old index and `pinned:`
from frontmatter.

- WHEN TO USE: the index looks out of sync, after you manually removed an episode
  file, or to recover from a corrupted index.
- WHEN NOT TO USE: as a routine step. Never hand-edit `index.jsonl`; rebuild it.

```
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```

Output:

```json
{"status":"ok","rebuilt":[{"scope":"local","count":1,"category_drift":{"unknown":{},"deprecated":{}}}]}
```

`category-index.json` maps each canonical category to its episode ids (deprecated members
map to the successor key; unknown categories are indexed under their literal key AND counted
as drift). It backs `em-search --category` the same way `tags.json` backs `--tag`.

`tokens.json` df diet: posting lists for tokens appearing in more than 40% of the
corpus (`DF_DROP_RATIO` in `lib/relevance.mjs`) are dropped — they do not
discriminate, and they dominated the file (a 1811-episode store measured 49.9MB of
tokens.json against 1.3MB of index.jsonl). Dropped tokens are recorded sorted under
the `_dropped` key so readers treat them as non-pruning (full-scoring fallback)
rather than absent; search results are identical before and after the diet.
Incremental writers (`em-store`/`em-revise`/`em-move`) never regrow a dropped
token; the next rebuild recomputes df from scratch.

`--check` (RFC-009 R10f) is a read-only drift report: it lists every episode whose stored
category is unknown or deprecated and exits 1 if any exist, 0 otherwise. It writes nothing.
Use it in CI/hooks to catch taxonomy drift without correcting it (correction is a later phase).

```
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --check --scope all
```

Note: `--help` short-circuits safely (PR #449), but any OTHER unknown argument is
ignored and a rebuild runs. `--scope all` rebuilds both local and global.

### em-trigger-index

Build the derived lesson-activation trigger index (RFC-009 R2).

- WHEN TO USE: after storing/revising trigger-bearing lessons, to (re)build
  `trigger-index.json`; or `--merged` to see the deduped local+global view a
  consumer would read. Builds are lazy — an unchanged store is a cache hit.
- WHEN NOT TO USE: as a search surface (use `em-search`); to mutate episodes (it
  is read-only over the store and never rewrites stored bytes).

```
node ~/.episodic-memory/scripts/em-trigger-index.mjs [--project <root>] [--scope local|global|all] [--merged]
```

Output: `{"status":"ok","built":[{"scope":"local","store":".../.episodic-memory","entries":3,"cache_hit":false}]}`

Flags that matter:
- `--project <root>` is a PATH binding (unique among em-* scripts, where
  `--project` is a name filter): when `<root>` is an existing directory the local
  store is `<root>/.episodic-memory` regardless of caller cwd.
- `--merged` prints the local-precedence merged view (one store failing degrades
  to the other with a stderr note, never fatal). The merged view RECOMPUTES
  `effective_priority` and `session_start` against BOTH stores' rows, so a
  cross-scope link (local lesson, global violation) earns the band there; the
  per-store artifact keeps a per-store band (deterministic per store). Consumers
  read the merged view.

The artifact: `trigger-index.json` carries `schema_version`, a `source` fingerprint
(`index_mtime_ms` + `index_size` + `index_sha256`, TOCTOU-safe), a `build_report`
(excluded unknown/deprecated activity classes), `entries` (per-trigger rows with
`trigger_kind` phrase|tool|activity and the DERIVED `effective_priority` 1-9), and a
`session_start` section (`critical_entries` = every band-8/9 lesson, trigger-independent;
`entries` = top-10 by the `static_score` blend; `preflight` = per-task-type recent
violation counts keyed by `violated_pattern`) that the P2 session-start hook will read.

**Playbooks (RFC-011 R1/R2).** An OPTIONAL per-project file
`<project>/.episodic-memory/playbooks.json` declares which playbook lesson
episodes load at session start or on demand (`schemas/playbooks.schema.json`:
`schema_version: 1`, at most 32 entries / 64 KiB, unknown keys rejected;
`{ id, mode: session_start|on_demand, triggers?(on_demand only) }`; optional
`bounds.max_playbooks` integer 1..4, default 2). The `id` may be ANY member
of a supersedes chain; the build resolves it to the terminal active revision.
Resolution is cross-store: local + GLOBAL `index.jsonl` rows are merged for
playbook resolution only, and a continuing-chain row outranks a stale terminal
snapshot (a superseded copy in one store never shadows the live chain in the
other). Derivation is advisory fail-open — a malformed/over-bound/schema-invalid
file is skipped with a `build_report` note and a stderr line, never fatal, and
degrades to no playbooks loaded. Two derived forms persist ONLY in the LOCAL
store's index:

- `session_start.playbooks` — `[{ episode_id, summary, read_command }]` in
  preference-file order, CAPPED at build to `bounds.max_playbooks` (the cap
  lives in the derived artifact). Siblings: `session_start.playbooks_capped`
  (integer count) and `session_start.playbooks_capped_first` (first capped id,
  or `null`).
- `entries[]` rows with `entry_class: "playbook"` — one per effective trigger
  of an `on_demand` entry, carrying the standard row shape plus
  `effective_priority: 0` (sorts below every lesson in top-K),
  `applies_to_projects: [<this project's slug>]`, `applies_to_tools: ["*"]`,
  `read_command`, and `triggers_overridden: true` ONLY when the preference
  entry declared a `triggers` override (the merged view then mutes the
  episode's own trigger rows; an EXCLUDED declaration emits neither rows nor a
  marker, so the episode's own triggers stay live).

`build_report.playbooks = { declared: [{episode_id, mode}], capped_ids: [...],
excluded: { unresolvable, cycle, inactive, non_lesson, expired,
chain_collision, empty_triggers } }` plus an OPTIONAL `warnings: { oversized:
[...], unpinned: [...] }` key emitted only when one of its lists is non-empty —
the standing audit surface for what this project injects (`warnings.unpinned`
flags selected terminals that are not pinned; pin them with `em-pin`). The
`source` fingerprint extends on every v3 build: `playbooks_*` (mtime/size/sha256)
is recorded UNCONDITIONALLY (absent = zero-state, so first CREATION, edits, and
DELETION all invalidate), and `global_index_*` is recorded only when a valid
preference file exists (a global playbook revision invalidates the local
section; config-free projects pay no cross-store coupling). The event-plane
freshness check compares `playbooks_*`/`global_index_*` mtime+size only (sha256
is recorded for the build's own cache probe). `--merged` threads the local
`session_start.playbooks` through unchanged. (`trigger-index.json` is now
`schema_version: 3`; a cached v2 index is rebuilt on upgrade.)

Common mistakes: confusing the stored `priority` (1-7, declared) with
`effective_priority` (1-9, derived — the 8-9 band is earned from linked violations,
never written); expecting `--project` to filter by name like other scripts.

### em-doctor

Health check + repair for the stores and the installation. One command answers
"is memory healthy, and if not, what exactly is wrong and how do I fix it".

- WHEN TO USE: something feels off (searches slow, warnings about missing
  indexes, results missing), after a crash/interrupted write, after moving
  machines, or as a periodic maintenance check.
- WHEN NOT TO USE: as a data query (use search/list/recall).

```
node ~/.episodic-memory/scripts/em-doctor.mjs [--scope local|global|all] [--fix] [--strict] [--verbose] [--all-projects]
```

`--all-projects` additionally runs the store-class checks once per
consumer-registry store (scope label `project:<basename>`; every store-class
row carries `data_dir` — the identity, since labels can collide). `--fix`
routes rebuilds by `data_dir` (spawning `em-rebuild-index --scope local` with
`cwd` at that project's root) and reports `skipped: non-root-store` for
registrations whose substrate-resolved store is not
`<project>/.episodic-memory` (git-nested paths, linked worktrees) — a rebuild
there would repair a different store than the one diagnosed. Non-store checks
(gate friction, installs-drift, backup, drafts) still run exactly once.

Checks: Node version, index.jsonl parse, index↔episode-file drift (both
directions), tags.json + category-index.json consistency, tokens.json bloat
(warn when tokens.json exceeds 20x the size of index.jsonl — fix is a
rebuild, which applies the df diet), dangling `supersedes` pointers, stale
`.tmp` files from interrupted atomic writes, dead-pid `.lock` files,
installed-script presence/drift, backup config, consumer installs-drift
(registered projects behind the global install version or carrying locally
modified installed artifacts — fix hint: `install.mjs --update-consumers`),
gate friction (below).

**Gate friction** (`gate-friction`, `gate-false-positives`, `gate-log-size`;
local scope). The Claude Code enforcement gates (checkpoint-gate.sh,
plan-gate.sh, stop-gate.sh) append one JSON line per terminal decision to
`<repo>/.checkpoints/gate-log.jsonl`:

```json
{"ts":1783487852,"gate":"checkpoint","tool":"Bash","label":"read_only","reason":"read_only","decision":"allow","sid":"<session>","cmd_sha256":"<sha256 of the whitespace-normalized command>"}
```

`em-doctor` reports counts per decision (`allow` / `silence` / `hold` /
`block`) and the **false-positive metric**: a `hold` (novel Bash command
parked for agent classification) whose command shape later received a
`read_only` or `nonsrc_write` verdict in `.checkpoints/classify/` was
friction on a harmless command — the join re-hashes each verdict marker's
`command_normalized` with the same whitespace-collapse rules the gate hashes
with. Warns when downgraded holds exist and when the log exceeds 5MB (the
gates only append; rotate/truncate it yourself). Absent or partially
malformed logs degrade gracefully (absent → ok; bad lines counted and
skipped).

Output (trimmed):

```json
{"status":"issues","summary":{"ok":6,"warn":2,"error":1},"checks":[{"id":"index-parse","scope":"local","level":"error","message":"1 malformed line(s) in index.jsonl","fix":"em-rebuild-index"}]}
```

- Exit 0 when no `error`-level findings; 1 otherwise. `--strict` makes `warn`
  findings also exit 1 (CI mode).
- `--fix` rebuilds indexes (delegating to `em-rebuild-index`) and removes stale
  `.tmp`/`.lock` litter, then re-runs the store checks and reports the post-fix
  state. Everything else stays report-only.
- Every non-ok finding carries a `fix` hint when a safe automated repair exists.

### em-sync-install

Checksum-guarded refresh of the CURRENT project's installed episodic-memory
artifacts (skills, instruction files, hooks) from the global dist cache
(`~/.episodic-memory/dist/<version>/`), written by `install.mjs` on every
install. This is the apply-side of the SessionStart drift notice: only files
whose on-disk sha256 still matches the project's install manifest
(`<project>/.episodic-memory-install.json`) are overwritten; locally modified
files are always left untouched and reported. Only projects present in the
consumer registry (`~/.episodic-memory/installs.json`) are ever touched, and
enforcement artifacts are skipped unless the registry entry says
`enforcement_installed: true`.

- WHEN TO USE: the SessionStart hook printed a version-drift notice and you
  want to update just this project without the repo checkout (`install.mjs
  --update-consumers` sweeps ALL registered projects from the repo instead).
  Runs automatically at session start when the operator set
  `"auto_update": true` in `<project>/.episodic-memory/enforce-config.json`.
- WHEN NOT TO USE: to install into a NEW project (use `install.mjs`); it never
  adds files, only refreshes what a previous install recorded.

```
node ~/.episodic-memory/scripts/em-sync-install.mjs [--project <dir>] [--dry-run]
```

Output (trimmed):

```json
{"status":"refreshed","from_version":"1111111111111111111111111111111111111111","to_version":"ef0d77166644d02e34fe0644c3b27ece4cfb19cd","refreshed":[".claude/skills/episodic-memory/SKILL.md"],"skipped_modified":[".claude/hooks/checkpoint-gate.sh"],"notice":"episodic-memory: auto-updated 1 artifact(s) to ef0d77166644; 1 locally modified file(s) left untouched: .claude/hooks/checkpoint-gate.sh"}
```

Degrade statuses (always exit 0): `current` (nothing to do), `no-manifest`,
`no-cache`, `no-global-manifest`, `unregistered`.

### em-prune

Archive episodes that score below a relevance threshold.

- WHEN TO USE: when the store has grown large and you want to archive low-value
  episodes. Always start with `--dry-run`.
- WHEN NOT TO USE: casually. Running it with no flag performs a real prune pass.

```
node ~/.episodic-memory/scripts/em-prune.mjs --dry-run
node ~/.episodic-memory/scripts/em-prune.mjs --scope global --threshold 0.15
node ~/.episodic-memory/scripts/em-prune.mjs --check
```

Output:

```json
{"status":"ok","results":[{"scope":"local","pruned":0,"remaining":1779,"freed_bytes":0},{"scope":"global","pruned":0,"remaining":474,"freed_bytes":0}]}
```

`--check` exits 1 when prunable episodes exist (CI gate). `--dry-run` previews with
no writes.

**Protection set (RFC-009 R6).** Prune never archives, in any mode: violations
evidence-linked to a valid lesson (either direction: the lesson's `evidence` array
or the violation's `lessons` array); valid lessons carrying `triggers`; episodes
named in a valid episode's `consolidates` array; supersession-chain members of any
of those; and the latest `record_type: clerk-run` episode per store. "Valid" means
not superseded and `review_by` absent or unexpired — protection lapses when the
referencing episode is superseded or expires. Retained entries are counted in the
`protected` output field; `--dry-run` lists them in `protected_episodes` as
`{id, score, reason, via}` where `via` names the protecting episode. `remaining`
includes protected entries; the `--check` exit code ignores them.

**RFC-011 R5(b) playbook-referenced protection + SCOPED fail-closed abort.** A
playbook declared in `<project>/.episodic-memory/playbooks.json` is load-bearing
for that project, so `computeProtectedIds` resolves each declared id to its
terminal active revision and protects the WHOLE resolved chain (terminal + every
member) with reason `playbook-referenced` (members also carry `chain-member`).
`--dry-run` lists the protected chain in `protected_episodes` as
`{id, score, reason, via}` (`via` names the declared id). The same `playbooks.json`
is read by `em-prune` AND `em-consolidate --fold-superseded`, and retention FAILS
CLOSED where the advisory surfaces fail open — scoped by store:

- LOCAL archival aborts only when THIS project's `playbooks.json` is
  present-but-unparseable (exit 1, archives nothing; a sibling project's
  corruption never blocks a local prune — the blast radius is scoped).
- GLOBAL archival aborts when the registry is degraded
  (`~/.episodic-memory/installs.json` present-but-unparseable, including
  `readRegistry`'s silent `{entries:[], rebuilt:true}` rebuild) OR any
  registered project's `playbooks.json` is present-but-unparseable (global
  protection is then unknowable).

An ABSENT file is normal operation: no protection, no abort, prunable episodes
archive as usual. The abort message names the offending file. Pin a frequently
referenced playbook terminal with `em-pin` (pinned episodes floor scoring decay
and are never pruned); the build report's `warnings.unpinned` flags selected
terminals that are not.

`--dry-run` on a chain `pb-0 ← pb-1 ← pb-2` (active terminal) whose
`playbooks.json` references the intermediate `pb-1` (observed on an isolated
fixture — every member survives, terminal + members):

```json
{"status":"ok","results":[{"scope":"local","prunable":0,"remaining":3,"freed_bytes":0,"protected":3,"protected_episodes":[{"id":"pb-0","score":0.1,"reason":"chain-member","via":"pb-1"},{"id":"pb-1","score":0.1,"reason":"playbook-referenced","via":"pb-1"},{"id":"pb-2","score":0.1,"reason":"playbook-referenced","via":"pb-1"}],"episodes":[]}]}
```

(`--dry-run` uses the `prunable` key + an `episodes` preview list; a real
prune uses `pruned` and mutates.)

A torn-write (present-but-unparseable) local `playbooks.json` aborts LOCAL
archival and archives nothing:

```json
{"status":"error","message":"em-prune: aborting archival — local playbooks.json present but unparseable (not valid JSON: ...) (<project>/.episodic-memory/playbooks.json)"}
```

### em-promote

EXPERIMENTAL (promote-or-remove decision 2026-10-08) — cross-project
recurring-lesson promotion, the first learning-strategy capability
(CAPABILITIES.md experimental tier). Dry-run by DEFAULT — `--apply` writes.

- WHEN TO USE: the same lesson keeps getting re-learned in different
  registered projects; you want it surfaced globally with provenance.
- WHEN NOT TO USE: near-duplicates inside ONE store (`em-consolidate`),
  moving a single episode between scopes (`em-move`), or fewer than 2
  registered projects (nothing to correlate).

```
node ~/.episodic-memory/scripts/em-promote.mjs [--min-sim <0..1>] [--apply]
```

Scans every consumer-registry store for active `lesson` episodes and clusters
them by body-token Jaccard (default 0.35, same vocabulary as
`em-consolidate`). A candidate must span >=2 distinct stores with >=2 distinct
member identities: replicas (same id AND summary — clone/fork stores)
collapse to one member and never count as recurrence, while a coincident id
with different content stays two members. `--apply` writes ONE global lesson
episode per candidate via `em-store` (never hand-written files): project
`cross-project`, tags = member-tag union + `promoted-lesson` +
`promoted:<sha8>` (the identity hash over sorted `<id>#<sha8(summary)>`
member keys), body = per-member excerpts + a `## Sources` list. Source
stores are NEVER written. Re-runs are idempotent by hash; a grown cluster
promotes under its new hash with a `Supersedes-promotion:` back-reference.
Malformed existing promoted episodes (bad hash tag, missing `## Sources`)
are reported in `warnings`, never fatal. Exit 1 only when an `--apply` write
failed; usage errors exit 2.

### em-console

Local web console over the CLI contract: one page (dashboard, browse + history,
recall preview, capture drafts, maintenance) whose every action POSTs to a closed
command registry that spawns the sibling `em-*` scripts and returns their JSON.
Loopback-only, per-launch token in the printed URL, read-only unless launched with
`--allow-write`, idles out after `--idle-timeout` seconds (default 1800). Agent
rule: this is a HUMAN surface — launch it for the user and hand over the URL;
agents keep using the JSON CLI directly.

### em-manage

Interactive day-2 maintenance wizard: status (doctor + stats), hygiene
(rebuild-index, fold-superseded, prune, doctor --fix — dry-run first, apply only
on explicit confirm), backup, capture drafts, routines, and an em-console
launcher. Prose menus for humans; every underlying operation is a spawned `em-*`
script. Scriptable via piped stdin (EOF takes defaults). Agent rule: human
surface — suggest it to users; agents call the underlying scripts directly.

### em-pattern-health

Aggregate violation episodes per behavioral pattern within a rolling window and flag
which patterns need enforcement.

- WHEN TO USE: to see which behavioral patterns are being violated repeatedly and
  whether a hook exists to stop them.
- WHEN NOT TO USE: for ordinary recall.

```
node ~/.episodic-memory/scripts/em-pattern-health.mjs            # full report
node ~/.episodic-memory/scripts/em-pattern-health.mjs --summary  # one line
node ~/.episodic-memory/scripts/em-pattern-health.mjs --check    # exit 1 if attention needed
```

`needs-enforcement` means violated repeatedly with no hook found. `needs-attention`
means a hook exists but violations continue (escalate to a human).

**`--hermetic` (RFC-009 R5a).** Reads ONLY project surfaces: violations from the
project-local store, the patterns registry from `<project>/.episodic-memory/patterns/`
falling back to `<project>/patterns/_index.json`, and enforcement detection over
`<project>/.claude/hooks`, `<project>/.git/hooks`, `<project>/.github/workflows` —
zero `$HOME` reads, so output is identical under any HOME. Scope is forced to
`local`; combining with an explicit `--scope global|all` errors. Output shape and
the `--check` exit contract are unchanged.

```
node ~/.episodic-memory/scripts/em-pattern-health.mjs --hermetic --check   # project-only CI gate (R5b wires this in Phase 3)
```

### em-violation

Record a behavioral-pattern violation as a structured episode.

- WHEN TO USE: when you (or the user) catch a workflow rule being broken, so the
  system can track repeat offenses.
- WHEN NOT TO USE: for ordinary decisions or discoveries (use `em-store`).

```
node ~/.episodic-memory/scripts/em-violation.mjs \
  --pattern <pattern-id> \
  --summary "<what happened>" \
  --body "<detail>" \
  [--sequence "<actual actions>"] [--correct "<correct actions>"] [--scope global|local] \
  [--lesson <lesson-episode-id>]...
```

Flags that matter:
- `--lesson <id>` (repeatable) forward-links the violation to the lesson(s) whose
  surfacing failed — this is what feeds a lesson's earned 8-9 band (see "Lesson
  activation"). Each id must resolve to an existing `category: lesson` episode.
- The episode carries a typed `violated_pattern: <pattern-id>` field (T6); the
  legacy `violated:<id>` tag remains as a burn-in shim only.

Missing-args output:

```json
{"status":"error","message":"Missing required args. Usage: --pattern <pattern_id> --summary \"<text>\" (--body \"<text>\" | --body-file <path>) [--sequence \"<actions>\"] [--correct \"<actions>\"] [--project <name>] [--tags \"<extra>\"] [--scope global|local]"}
```

### em-seed-patterns

Seed the shipped behavioral patterns into the global store. Idempotent: already
seeded patterns are skipped.

- WHEN TO USE: once after install, or after adding a new pattern file, so patterns
  surface in normal search and recall.
- WHEN NOT TO USE: repeatedly in a session (it is a no-op after the first seed).

```
node ~/.episodic-memory/scripts/em-seed-patterns.mjs
```

Output:

```json
{"status":"ok","seeded":0,"skipped":11,"total":11}
```

---

## Operator-only / heavyweight scripts

These are for operators and specific workflows, not routine agent recall or storage.
As an agent you should NOT invoke them unless the user explicitly asks. Deep docs are
linked per entry.

### em-backup

Mirror the memory directories to a private GitHub repo with PII / secret redaction on
the staging copy (source files are never modified). Do NOT run `--init` / `--sync`
without a config; it refuses rather than ship raw personal memory. Deep docs:
`docs/em-backup.md` and README.md "Backup" section. Agent rule: do not touch unless
the user asks to back up.

### em-restore

Selectively restore from a cloned backup repo (filter by tag / date / category /
source). Dry-run by default; restore cannot undo redaction. Deep docs: README.md
"Restore" section and `docs/USER_MANUAL.md`. Agent rule: do not touch unless the user
asks to restore.

### em-audit-compliance

Heuristic measurement of rule-skip rates from Claude Code session transcripts (false
positives expected; for trend tracking). Deep docs: README.md "Compliance Audit &
Transcript Mining". Agent rule: operator reporting tool, not for recall.

### em-mine-transcripts

Surface decisions / lessons / violations buried in transcripts that were never
captured as episodes. Writes a staging file under `.claude/scratch/`; never calls
`em-store` directly (cold-storage discipline). Deep docs: README.md "Compliance Audit
& Transcript Mining". Agent rule: driven by the scheduled daily-mining routine; do
not invoke ad hoc.

### em-rfc-validate

CI-only validator that diffs prose-tier RFC content against the machine-readable
source of truth. Deep docs: README.md "RFC Validation". Agent rule: CI runs it
repo-relative; not part of the deployed recall flow.

### em-workflow-validate

Pure validator for the `workflow.lifecycle` episode chain at a given gate. Called by
enforcement hooks. Deep docs: README.md "Workflow Validation". Agent rule: hooks
shell out to it; do not call it by hand.

### em-review-request

Records that a review event happened in the workflow audit trail (refs to
plan / approval / checkpoints / tests). Orthogonal to `second-opinion`, which runs the
review. Deep docs: README.md "Review Request". Agent rule: lifecycle plumbing, not for
recall.

### em-lock

Zero-dependency atomic file lock (a `flock` replacement for macOS) used by the
auto-promote and backup-sync paths. Deep docs: header comment in the script. Agent
rule: infrastructure primitive; do not invoke directly.

### em-watch-codex

Polls the store for new Codex-authored reply episodes; the cursor mechanism behind
the second-opinion `episodic` storage backend. Deep docs: README.md "Codex Watcher".
Agent rule: prefer the `second-opinion` harness; do not poll by hand.

### second-opinion

The pluggable cross-tool review harness (request, provider dispatch, preamble
composition, consensus loop). This is a capability, not a memory command. Deep docs:
README.md "Second-Opinion Review Harness" and `docs/USER_MANUAL.md` Scenario 8b.
Agent rule: use it only when the user asks for a second-opinion / cross-tool review,
and route through the harness rather than invoking a provider CLI directly.
