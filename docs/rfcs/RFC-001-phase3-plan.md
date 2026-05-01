# RFC-001 Phase 3: Proactive Recall — Implementation Plan

**Status:** Revised after 2nd opinion review, awaiting Codex
**Depends on:** Phase 2 (shipped in PR #13, #15)
**Branch:** `feat/rfc001-phase3-proactive-recall`

---

## Overview

New script `scripts/em-recall.mjs` (~120 lines) — multi-pass retrieval triggered at session start. Surfaces relevant episodes without explicit search queries by inferring context from the current project environment.

## Architecture

### Input: Context Inference (no CLI args required)

Sources for **project name** (first match wins, all optional):
1. `package.json` → `name` field
2. `git remote get-url origin` → parse repo name from URL (handles SSH `git@...:org/repo.git` and HTTPS `https://.../repo.git`)
3. `basename(cwd)` → directory name

Sources for **context tokens** (all merged, all optional):
4. `package.json` → `keywords` array → fed into pass 2 tag matching (after stopword filtering)
5. `git branch --show-current` → branch name tokens (split on `/`, `-`, `_`)
6. Falls back to empty context if all sources unavailable (detached HEAD, bare repo, no .git → empty branch tokens)

### Processing: Three Independent Passes

Indexes loaded **once** at startup (not per-pass). Each pass filters/scores the shared in-memory array independently. Results deduplicated by episode ID (highest score wins), then sorted and limited.

| Pass | Source | Match type | Base weight (as `textMatchScore`) |
|------|--------|-----------|-------------|
| 1. Project match | `project` field in `index.jsonl` | Exact match on inferred project name | 1.0 (highest) |
| 2. Tag match | `tags.json` inverted index | Overlap with effective tokens (branch + keywords, stopword-filtered) | 0.7 |
| 3. Recent cross-project | All episodes from last 7 days | Date filter, scored by `computeScore(entry, 0.5)` | 0.5 |

All three passes feed their base weight into `computeScore(entry, baseWeight)` so time decay and access boost apply uniformly (per RFC: "Uses Phase 2 scoring to rank results").

### Token Collision Handling

Stopword list for tag matching (pass 2):
```
fix, feat, feature, bug, test, app, src, lib, dev, main, master, release,
hotfix, docs, chore, refactor, style, ci, cd, build, user, data, add, update, new,
phase, merge, pr, push, implement, wip, draft, rule, enforce, pattern
```

Rules:
- Tokens < 4 characters excluded
- Tokens in stopword list excluded
- Each pass independent — no cross-pass token combination

### Output Format

```json
{
  "status": "ok",
  "context": {
    "project": "episodic-memory",
    "branch_tokens": ["feat", "rfc001", "phase3"],
    "effective_tokens": ["rfc001", "phase3"]
  },
  "count": 5,
  "episodes": [...],
  "preflight_warnings": [],
  "prune_suggestion": null
}
```

- `preflight_warnings`: array of strings (performance, missing index, etc.). RFC-002 Phase 3 will extend these to structured objects with `pattern_id`, `violations_last_30d`, `last_violation`, `message`. Current string format is forward-compatible (consumers should handle both).
- `prune_suggestion`: string if prunable episodes detected, null otherwise. Kept as separate top-level field (not inside `preflight_warnings`) — prune suggestions are operational, not behavioral warnings.
- `context`: shows inferred context for transparency/debugging
- Episodes include `source` and `score` fields (same as em-search)
- **Reserved extension points (RFC-002):** `--task-type` CLI flag, structured `preflight_warnings`, violation-aware pre-flight pass

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--limit N` | 5 | Max episodes returned |
| `--scope local\|global\|all` | all | Which stores to search |
| `--days N` | 7 | Lookback window for pass 3 (recent cross-project) |
| `--no-track` | false | Skip access tracking write-back |
| `--project NAME` | auto-inferred | Override project name inference |
| `--warn-time-ms N` | 500 | Performance warning threshold |
| `--warn-count N` | 500 | Episode count warning threshold |

### Shared Code (Inlined)

From `em-search.mjs`, inline into `em-recall.mjs` (zero-dep convention):
- `normalizeTags()`
- `loadTagsIndex()`
- `computeScore()`
- `writeBackAccessTracking()`
- `loadIndex()`

Each inlined function gets a `// SYNC: em-search.mjs:<functionName> — update both on change` comment. A drift-detection test in `test-phase3.mjs` extracts function bodies from both files and asserts they are identical.

### Prune Suggestion

After collecting results, scan all loaded entries using `computeScore(entry, 1.0)` (query-independent, matching `em-prune.mjs` behavior) for scores below prune threshold (0.15). If any found:
```
"prune_suggestion": "12 episodes below threshold. Run em-prune.mjs --dry-run to review."
```

## Files

| Action | File | Lines | Description |
|--------|------|-------|-------------|
| CREATE | `scripts/em-recall.mjs` | ~120 | Multi-pass proactive recall |
| CREATE | `tests/test-phase3.mjs` | ~350 | Unit tests for all 20 acceptance criteria |
| MODIFY | `docs/rfcs/RFC-001-memory-improvements.md` | ~5 | Mark Phase 3 status, update implementation table |

## Acceptance Tests (from RFC)

1. Recall ranks `project`-field matches above incidental tag matches
2. Recall excludes short/generic tokens from tag matching
3. Recall falls back gracefully when `package.json`, git, or cwd is unavailable
4. Recall updates access tracking for surfaced episodes

## Additional Test Cases

5. Empty store returns `{ status: "ok", count: 0, episodes: [] }` gracefully
6. `--no-track` suppresses access tracking write-back
7. `--project` override bypasses auto-inference
8. Pass 3 (recent cross-project) respects `--days` window
9. Stopword tokens filtered from branch name tokens
10. Prune suggestion appears when low-score episodes exist (uses query-independent score)
11. Performance warnings emitted when thresholds exceeded
12. Scope validation rejects invalid values
13. Deduplication: episode matching in multiple passes appears once with highest score
14. `--limit` applied after merging and deduplicating all three passes
15. `--days 0` returns no cross-project results without error
16. Detached HEAD (empty branch output) — graceful fallback to empty branch tokens
17. No `.git` directory — git commands fail silently, context still works from package.json/cwd
18. `package.json` with no `name` field or `name: ""` — falls back to git remote / basename
19. `package.json` keywords fed into pass 2 effective tokens (after stopword filtering)
20. Inlined function drift detection: function bodies match between em-recall.mjs and em-search.mjs

## Implementation Order

1. Write `em-recall.mjs` with all passes, context inference, output format
2. Write `test-phase3.mjs` alongside (tests written during implementation, not deferred)
3. Update RFC-001 implementation table
4. Commit, push, PR
