# RFC-001 Phase 2 Implementation Plan — Relevance Decay + Access Tracking

## Overview

Add relevance scoring, access tracking, performance health checks, and pruning to the episodic memory system. All changes are backwards-compatible (new fields default gracefully).

## Files modified (2)

### `scripts/em-search.mjs` (~227 → ~340 lines)

**1. New CLI flags:**
- `--no-score` — suppress relevance scoring (return results without `score` field)
- `--no-track` — disable access tracking write-back (side-effect-free search)
- `--warn-time-ms N` — performance warning threshold in ms (default: 500)
- `--warn-count N` — episode count warning threshold (default: 500)

**2. `text_match` scoring tiers:**
Current code uses boolean `includes()` for query matching. Phase 2 replaces this with numeric scoring:

| Match type | Score | Condition |
|------------|-------|-----------|
| Exact summary match | 1.0 | `summary.toLowerCase() === query.toLowerCase()` |
| Summary substring | 0.7 | `summary.toLowerCase().includes(query.toLowerCase())` |
| Body-only match | 0.4 | query found in body but not summary |
| Non-query search | 1.0 | tag/category/project filters without `--query` |

**3. `computeScore(entry, textMatchScore)` function:**
```
score = textMatchScore * max(0.1, 1 - (days_since_creation / 365)) * (1 + log1p(access_count) * 0.1)
```
- `days_since_creation`: computed via `new Date(entry.date)` — sub-day precision unnecessary
- `access_count`: defaults to `entry.access_count || 0` for backwards compat with pre-Phase-2 entries
- Time decay floors at 0.1 (memories never reach zero)
- Access boost is logarithmic (prevents runaway)

**4. Result ordering change:**
- Current: filter → sort by date descending → `slice(0, limit)`
- Phase 2: filter → compute scores → sort by score descending → `slice(0, limit)` → output
- When `--no-score`: keep current date-based sort

**5. Access tracking write-back:**
- After outputting results, update `access_count` and `last_accessed` in `index.jsonl`
- **Dual-scope handling:** group results by their source `_dataDir`, perform separate read-modify-write for each scope's `index.jsonl`
- **Atomic write:** re-read `index.jsonl` just before writing (narrow the race window with concurrent `em-store.mjs` appends), merge increments, write to temp, rename. Document the narrow race window in code comments — access tracking is best-effort, not critical.
- **Skip write-back when:** `--no-track`, `--history`, or `--include-superseded`

**6. Performance health check:**
- Measure wall-clock time (`Date.now()` before/after search)
- If execution > `--warn-time-ms` (default 500): add `"warning"` field to JSON output
- If episode count > `--warn-count` (default 500): add `"warning"` field
- Health check for `em-recall.mjs` deferred to Phase 3 (script does not exist yet)

### `scripts/em-rebuild-index.mjs` (~115 → ~140 lines)

1. Before rebuild: load old `index.jsonl` into a map keyed by episode ID
2. During rebuild: carry forward `access_count` and `last_accessed` for known IDs
3. Default to `0` and `null` for new entries
4. Add comment confirming rebuild ignores `archived/` directory (already correct — `readdirSync(episodesDir)` only reads `episodes/`)

## Files created (1)

### `scripts/em-prune.mjs` (~120 lines)

**Query-independent prune score:**
```
score = max(0.1, 1 - (days_since_creation / 365)) * (1 + log1p(access_count) * 0.1)
```
(Same as search formula with `text_match` fixed at 1.0)

**CLI flags:**
- `--threshold N` — prune score cutoff (default: 0.15)
- `--scope local|global|all` — which data stores to prune (default: `all`)
- `--dry-run` — preview pruneable episodes with scores, sizes; no file moves
- `--check` — report count only, exit 1 if prunable episodes exist (for hooks/CI)

**Behavior:**
1. Load `index.jsonl`, compute prune score for each episode
2. Episodes below threshold → move `.md` to `archived/` subdirectory
3. Remove pruned entries from `index.jsonl` and `tags.json` (atomic writes)
4. **Append** to `archived-index.jsonl` (read-merge-write, not overwrite — preserves previous prune runs)
5. Output: `{ "pruned": N, "remaining": M, "freed_bytes": B }`

**Breakpoint documentation:** Add comment noting episodes become prunable at ~310 days with 0 accesses at default threshold 0.15.

## Files NOT modified (deliberate)

- `em-store.mjs` — does NOT need to write `access_count`/`last_accessed` on new entries. Instead, `computeScore` defaults missing fields: `entry.access_count || 0`. New fields appear after first search access or next rebuild.

## Unit tests: `tests/test-phase2.mjs`

Written alongside implementation, following `test-seed-patterns.mjs` pattern (temp dir, `execSync`, JSON assertions).

**Test cases:**

1. Scoring with 0 `access_count` — no boost, pure time decay
2. Scoring with missing `access_count` field — backwards compat, defaults to 0
3. Time decay at 0 days — score near 1.0
4. Time decay at 365 days — score at floor (0.1)
5. Time decay at 730 days — score still at floor (0.1, not negative)
6. `text_match` tiers — exact summary (1.0), substring (0.7), body-only (0.4)
7. `--no-score` — results returned without `score` field, date-sorted
8. `--no-track` — `index.jsonl` unchanged after search
9. Access tracking increments — `access_count` increases, `last_accessed` updates
10. `--history` and `--include-superseded` — no access tracking
11. Dual-scope write-back — both local and global `index.jsonl` updated
12. Result ordering — high-score old episode ranks above low-score recent episode
13. Limit applied after scoring — top-N by score, not top-N by date
14. Performance warning — emitted when episode count > threshold
15. Prune `--dry-run` — reports scores, moves no files
16. Prune `--check` — exits 1 when prunable episodes exist, 0 when none
17. Prune default — moves files to `archived/`, updates indexes
18. Prune appends to `archived-index.jsonl` — second prune preserves first batch
19. Rebuild preserves `access_count` and `last_accessed`
20. Rebuild defaults missing metadata to `0` / `null`

## Dependency order

1. `em-search.mjs` — scoring + write-back (core feature)
2. `em-rebuild-index.mjs` — preserve metadata (needed before prune can rely on counts)
3. `em-prune.mjs` — depends on scoring formula from search + preserved metadata from rebuild
4. `tests/test-phase2.mjs` — written alongside each step above

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Concurrent `em-store.mjs` append during write-back | Re-read before write to narrow race window; document as known limitation; access tracking is best-effort |
| Large index slows scoring | Performance health check warns at 500 episodes; prune provides escape valve |
| Scoring changes result order (breaking for consumers) | `--no-score` opt-out preserves date-based sort |
