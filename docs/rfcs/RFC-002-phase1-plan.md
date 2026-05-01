# RFC-002 Phase 1: Violation Tracking — Implementation Plan

**Status:** Revised after 2nd opinion review (9 findings applied)
**Depends on:** Nothing (no blockers)
**Branch:** `feat/rfc002-phase1-violation-tracking`

---

## Overview

Structured violation tracking for behavioral patterns. New `violation` category, `em-violation.mjs` convenience wrapper, `em-session-end-prompt.mjs` hook script, bp-009 reconciliation.

## Architecture

### `em-violation.mjs` (~80 lines)

**Shells out to `em-store.mjs`** via `execSync` (not inlined). Rationale: em-violation is a pure create — unlike em-revise which also modifies the original episode. Shelling out avoids adding a 6th SYNC copy of store internals. ~50ms subprocess cost is negligible for a user-flagged action.

```
node em-violation.mjs --pattern <pattern_id> --summary "<text>" --body "<text>"
                      [--sequence "<action1,action2>"] [--correct "<action1,action2>"]
                      [--project <name>] [--scope global|local]
```

**Pattern validation:**
- Reads `patterns/_index.json` to get known pattern IDs
- Path resolution: check `./patterns/_index.json` (project-local) first, then `~/.episodic-memory/patterns/_index.json` (global install)
- On failure, output structured error:
  ```json
  {
    "status": "error",
    "message": "Unknown pattern \"bp-999\". Valid patterns: bp-001-implementation-workflow, bp-002-proactive-milestone-storage, ...",
    "known_patterns": ["bp-001-implementation-workflow", ...]
  }
  ```

**Auto-tagging:**
- Always adds: `violation`, `behavioral-pattern`, `violated:<pattern_id>`
- User can add extra tags via `--tags` (appended, not replaced)
- Colon in `violated:` tag is safe — survives normalizeTags (comma-split, trim, lowercase), JSON storage, tags.json indexing, rebuild, and search

**Body template** (structured markdown):
```markdown
# <summary>

## What happened
<body text>

## Violation sequence
<--sequence value, or "Not specified">

## Correct sequence
<--correct value, or "Not specified">
```

**Output:** `{ status, id, violated_pattern, file, scope }`

### `em-session-end-prompt.mjs` (~40 lines)

Outputs a JSON prompt template for SessionEnd hook consumption. The AI reads this output and asks the user; it is NOT interactive.

```json
{
  "prompt": "Were any behavioral patterns violated this session?",
  "known_patterns": [
    { "pattern_id": "bp-001-implementation-workflow", "name": "Standard implementation workflow" },
    ...
  ],
  "store_command": "node ~/.episodic-memory/scripts/em-violation.mjs --pattern <id> --summary \"...\" --body \"...\""
}
```

- Reads `patterns/_index.json` (same path resolution as em-violation.mjs)
- Hook registration: requires `--install-hooks` flag in installer (never auto-modifies settings.json)

### em-store.mjs change

Add `violation` to `VALID_CATEGORIES` array (line 48). Note: `lesson` already exists — no RFC-001 P4 coordination needed.

### bp-009 reconciliation (4 specific changes)

1. **Line 12:** Change "store the violation in episodic memory as a discovery" → "store the violation using `em-violation.mjs` (category: `violation`)"
2. **Lines 14-19 (What to store):** Align with em-violation.mjs fields: `--pattern`, `--summary`, `--body`, `--sequence`, `--correct`
3. **Line 41 (Scope):** Change "tags: violated rule name, `violation`, `learning`" → "auto-tagged: `violation`, `behavioral-pattern`, `violated:<pattern_id>`"
4. **Frontmatter:** Bump version from `1.0.0` to `2.0.0`, update `_index.json` version to match

### install.mjs changes

1. Add `em-violation.mjs` and `em-session-end-prompt.mjs` to the script copy list
2. Add `patterns/_index.json` copy to `~/.episodic-memory/patterns/` (new — needed for global pattern validation)
3. Add `--install-hooks` flag: registers `em-session-end-prompt.mjs` as `SessionEnd` hook in `~/.claude/settings.json` (opt-in only)

## Files

| Action | File | Lines | Description |
|--------|------|-------|-------------|
| MODIFY | `scripts/em-store.mjs` | ~1 | Add `violation` to VALID_CATEGORIES |
| CREATE | `scripts/em-violation.mjs` | ~80 | Structured violation storage, shells out to em-store |
| CREATE | `scripts/em-session-end-prompt.mjs` | ~40 | SessionEnd hook prompt template |
| MODIFY | `patterns/store-violations-as-evidence.md` | ~15 | bp-009 v2.0.0 reconciliation (4 changes) |
| MODIFY | `patterns/_index.json` | ~1 | bp-009 version bump |
| MODIFY | `install.mjs` | ~15 | Copy new scripts + patterns, --install-hooks flag |
| CREATE | `tests/test-rfc002-phase1.mjs` | ~200 | Unit tests for all acceptance criteria |
| MODIFY | `docs/rfcs/RFC-002-learning-loop.md` | ~5 | Mark Phase 1 status, update implementation table |

## Acceptance Tests

### From RFC
1. `violation` category accepted by `em-store.mjs`
2. `em-violation.mjs` stores structured violation with `violated:<pattern_id>` tag
3. `em-violation.mjs` validates pattern exists in `patterns/_index.json`
4. `em-violation.mjs` rejects unknown pattern_id with error listing known patterns
5. `em-violation.mjs` auto-tags with `violation`, `behavioral-pattern`, `violated:<pattern_id>`
6. Violation episodes searchable by `--category violation`
7. Violation episodes searchable by `--tag violated:<pattern_id>`
8. bp-009 updated to reference `em-violation.mjs`
9. `em-session-end-prompt.mjs` outputs valid JSON with prompt + known patterns

### Additional (from 2nd opinion)
10. `violated:` tag round-trip: store → rebuild-index → search by tag returns the violation
11. Extra `--tags` appended to auto-tags (not replaced)
12. `--sequence` and `--correct` appear in structured body sections
13. Missing `--pattern` flag rejected with usage error
14. Missing `--summary` or `--body` rejected with usage error
15. Pattern validation falls back to `~/.episodic-memory/patterns/_index.json` when local missing
16. `em-session-end-prompt.mjs` includes `store_command` template in output
17. Scope validation rejects invalid `--scope` values

## Implementation Order

1. Add `violation` to em-store.mjs VALID_CATEGORIES
2. Write `em-violation.mjs` (shells out to em-store)
3. Write `em-session-end-prompt.mjs`
4. Write tests alongside (steps 2-3)
5. Update bp-009 (4 changes + version bump)
6. Update install.mjs (copy list + --install-hooks)
7. Update RFC-002 implementation table
8. Code review → fix bugs → E2E → log bugs to Issues
