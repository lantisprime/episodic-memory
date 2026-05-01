# RFC-001 Phase 3: Proactive Recall — Implementation Plan

**Status:** Awaiting review (2nd opinion + Codex)
**Depends on:** Phase 2 (shipped in PR #13, #15)
**Branch:** `feat/rfc001-phase3-proactive-recall`

---

## Overview

New script `scripts/em-recall.mjs` (~120 lines) — multi-pass retrieval triggered at session start. Surfaces relevant episodes without explicit search queries by inferring context from the current project environment.

## Architecture

### Input: Context Inference (no CLI args required)

Sources (all optional, graceful fallback):
1. `package.json` → `name` field, `keywords` array
2. `git branch --show-current` → branch name tokens (split on `/`, `-`, `_`)
3. `basename(cwd)` → directory name
4. Falls back to empty context if all sources unavailable

### Processing: Three Independent Passes

Each pass scores independently. Results merged by highest score (not additive).

| Pass | Source | Match type | Base weight |
|------|--------|-----------|-------------|
| 1. Project match | `project` field in `index.jsonl` | Exact match on inferred project name | 1.0 (highest) |
| 2. Tag match | `tags.json` inverted index | Overlap with inferred context tokens | 0.7 |
| 3. Recent cross-project | All episodes from last 7 days | Date filter only | 0.5 |

### Token Collision Handling

Stopword list for tag matching (pass 2):
```
fix, feat, feature, bug, test, app, src, lib, dev, main, master, release,
hotfix, docs, chore, refactor, style, ci, cd, build, user, data, add, update, new
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

- `preflight_warnings`: array of strings (performance, missing index, etc.)
- `prune_suggestion`: string if prunable episodes detected, null otherwise
- `context`: shows inferred context for transparency/debugging
- Episodes include `source` and `score` fields (same as em-search)
- Output wrapper designed for RFC-002 Phase 3 extension

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

### Prune Suggestion

After collecting results, scan all loaded entries for scores below prune threshold (0.15). If any found:
```
"prune_suggestion": "12 episodes below threshold. Run em-prune.mjs --dry-run to review."
```

## Files

| Action | File | Lines | Description |
|--------|------|-------|-------------|
| CREATE | `scripts/em-recall.mjs` | ~120 | Multi-pass proactive recall |
| CREATE | `tests/test-phase3.mjs` | ~250 | Unit tests for all acceptance criteria |
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
10. Prune suggestion appears when low-score episodes exist
11. Performance warnings emitted when thresholds exceeded
12. Scope validation rejects invalid values

## Implementation Order

1. Write `em-recall.mjs` with all passes, context inference, output format
2. Write `test-phase3.mjs` alongside (tests written during implementation, not deferred)
3. Update RFC-001 implementation table
4. Commit, push, PR
