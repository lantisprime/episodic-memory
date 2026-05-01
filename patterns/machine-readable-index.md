---
pattern_id: bp-004-machine-readable-index
name: "Machine-readable index for token efficiency"
category: decision
tags: [behavioral-pattern, bp-004-machine-readable-index, token-efficiency, index]
scope: global
version: 1.0.0
---

# Machine-Readable Index for Token Efficiency

When a directory contains multiple files that AI tools need to discover, include a machine-readable `_index.json` alongside any human-readable `README.md`. This allows AI tools to read one small file (~200 tokens) instead of scanning all files (~2k+ tokens).

## When to apply

- Any directory with 3+ files that AI tools need to discover or enumerate
- Pattern directories, RFC directories, episode directories
- Any collection where an AI tool would otherwise `ls` + read each file

## Index structure

```json
{
  "items": [
    {
      "id": "<unique-id>",
      "file": "<filename>",
      "name": "<human-readable name>",
      "tags": ["<relevant>", "<tags>"],
      "version": "<semver>"
    }
  ]
}
```

## Key principles

- Index is the discovery mechanism — AI reads index first, then individual files only when needed
- Index must be updated in the same commit as any file addition/removal
- Keep the index minimal — just enough to decide whether to read the full file
- Human-readable README derives from the index, never maintained independently

## Detection triggers

- Creating a new directory with 3+ discoverable files
- AI tool performing `ls` + sequential reads on a directory
- Token budget concerns during session start

## Scope

All projects, all AI tools. Applies to any structured directory, not just episodic memory.
