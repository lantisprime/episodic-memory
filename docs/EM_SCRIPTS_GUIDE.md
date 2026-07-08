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

Common mistakes: forgetting `--category`; passing `--scope local` when you meant the
default global; hand-writing the file instead of calling this script.

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
  [--full] [--include-superseded] [--history <id>] [--no-score] [--no-track]
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
- `--category <cat>` is index-backed via `category-index.json` (same degrade-to-linear-scan
  fallback as `--tag`). A deprecated category name canonicalizes to its successor; an unknown
  category still filters (tolerant read).

`--history` output (chain, oldest first):

```json
{"status":"ok","count":2,"chain":[{"id":"...-chose-jwt-over-sessions-7cd4","status":"superseded",...},{"id":"...-switched-to-session-cookies-285f","status":"active","supersedes":"...-chose-jwt-over-sessions-7cd4",...}]}
```

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

### em-stats

Read-only store analytics — never writes, never bumps access counters.

```
node ~/.episodic-memory/scripts/em-stats.mjs [--scope local|global|all] [--top <n>]
```

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

### em-doctor

Health check + repair for the stores and the installation. One command answers
"is memory healthy, and if not, what exactly is wrong and how do I fix it".

- WHEN TO USE: something feels off (searches slow, warnings about missing
  indexes, results missing), after a crash/interrupted write, after moving
  machines, or as a periodic maintenance check.
- WHEN NOT TO USE: as a data query (use search/list/recall).

```
node ~/.episodic-memory/scripts/em-doctor.mjs [--scope local|global|all] [--fix] [--strict] [--verbose]
```

Checks: Node version, index.jsonl parse, index↔episode-file drift (both
directions), tags.json + category-index.json consistency, tokens.json bloat
(warn when tokens.json exceeds 20x the size of index.jsonl — fix is a
rebuild, which applies the df diet), dangling `supersedes` pointers, stale
`.tmp` files from interrupted atomic writes, dead-pid `.lock` files,
installed-script presence/drift, backup config.

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
  [--sequence "<actual actions>"] [--correct "<correct actions>"] [--scope global|local]
```

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
