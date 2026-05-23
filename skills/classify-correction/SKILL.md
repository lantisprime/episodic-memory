---
name: classify-correction
description: Record a user correction for the LLM checkpoint-gate classifier. Use when a command was mislabeled (e.g. read-only inspector blocked as shared_write).
---

# classify-correction

Record a per-project override so the next time the Bash command-classifier sees
the same command shape (same project, same caller-cwd, same script content), it
returns the corrected label instead of consulting the LLM or its cached answer.

## When to use

- The pre-checkpoint or stop gate blocked a command you know is read-only
  (e.g. `python3 src/inspect.py` that only reads config and prints to stdout).
- The LLM classifier returned `shared_write` for a write you know is bounded
  to a marker path (should be `marker_write`).
- You want a command to ALWAYS classify as a given label in this project.

## Invocation

```bash
node ~/.episodic-memory/scripts/classify-correction.mjs \
  --project-root "$(git rev-parse --show-toplevel)" \
  --caller-cwd  "$(pwd)" \
  --command     "python3 src/inspect.py" \
  --label       read_only \
  --reason      "inspector — read-only diagnostic, no writes"
```

Labels (must be exactly one):
- `read_only` — pure observation; allowed through all gates.
- `shared_write` — writes project files / shared state.
- `marker_write` — writes only to `.checkpoints/.*` or `.claude/.*` markers.
- `push_or_pr_create` — git push / gh pr create / equivalent remote publish.
- `unsafe_complex` — cannot tokenize safely; gate should block.

## What the override stores

A line at `<project-root>/.episodic-memory/classifier-overrides.jsonl`
containing the cache tuple (project_root, caller-cwd-relative, normalized
command, executable absolute path, script sha256 digest), the corrected
label, your reason, and a timestamp. The helper validates that
`--project-root` matches `resolveRepoRoot(process.cwd())` and refuses
cross-repo writes.

## Why overrides are per-project

The cache key includes the project root and the script content digest, so an
override for one project's `src/inspect.py` does not apply to another
project's identically-named script. If the script content changes, the digest
changes, and the override no longer matches — re-run the correction with the
new content.

## Disabling Tier 3 entirely

If you do not want LLM dispatch at all (offline, no API key, or cost-
sensitive), set `enabled: false` in
`<project-root>/.episodic-memory/classifier-config.json` or globally at
`~/.episodic-memory/classifier-config.json`. Tier 1 heuristic (existing
em-* table + shared_write default) then applies.
