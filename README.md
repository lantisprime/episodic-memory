# episodic-memory

A cross-tool episodic memory system for AI coding assistants. Persistently stores decisions, discoveries, milestones, and context across sessions — with self-correcting revision chains.

Works with: **Claude Code**, **Cursor**, **Codex (OpenAI)**, **Windsurf / Continue**

## How it works

**Storage is entirely file-based** — no database required. Episodes are plain markdown files (`.md`) with YAML frontmatter, stored on your local filesystem. A JSONL text file serves as a lightweight index for fast filtering. Zero external dependencies beyond Node.js.

The AI assistant stores significant events during sessions and recalls relevant episodes when starting work or when asked.

When a decision proves wrong, the system creates a **revision chain** — the original is marked superseded and a new corrected episode takes its place. Future searches show only the latest active version.

### Episode Lifecycle

```mermaid
sequenceDiagram
    participant U as User
    participant AI as AI Assistant
    participant S as em-store.mjs
    participant R as em-search.mjs
    participant FS as Data Store

    rect rgb(230, 245, 255)
    Note over U,FS: Store Flow
    U->>AI: Makes significant decision
    AI->>S: em-store.mjs --category decision ...
    S->>FS: Write episode .md + append index
    S-->>AI: { status: ok, id }
    AI-->>U: Stored: "chose Express over Fastify"
    end

    rect rgb(255, 240, 240)
    Note over U,FS: Self-Correction Flow
    U->>AI: "That framework choice was wrong"
    AI->>R: em-search.mjs --query "framework"
    R-->>AI: Original episode found
    AI->>S: em-revise.mjs --original <id> ...
    S->>FS: Mark original superseded + write revision
    AI-->>U: Revised: now recommends Fastify
    end

    rect rgb(255, 245, 230)
    Note over U,FS: Recall Flow
    U->>AI: "What did we decide about the framework?"
    AI->>R: em-search.mjs --project X --query "framework"
    R->>FS: Search index (superseded filtered out)
    R-->>AI: Latest active decision only
    AI-->>U: "We revised to Fastify because..."
    end
```

## Installation

```bash
# Clone the repo
git clone <repo-url> episodic-memory
cd episodic-memory

# Install for a specific tool in a target project
node install.mjs --tool cursor --project /path/to/my-project

# Install for all supported tools
node install.mjs --tool all --project /path/to/my-project
```

The installer:
1. Copies scripts to `~/.episodic-memory/scripts/`
2. Creates `.episodic-memory/` in the target project for local episodes
3. Copies the appropriate instruction file for your tool

## Supported Tools

| Tool | Instruction file | Install location |
|------|-----------------|------------------|
| Claude Code | `SKILL.md` | `.claude/skills/episodic-memory/SKILL.md` |
| Cursor | `cursor.mdc` | `.cursor/rules/episodic-memory.mdc` |
| Codex | `codex-skill.md` | `.agents/skills/episodic-memory/` |
| Windsurf | `windsurf.md` | `.windsurfrules` (appended if exists) |

## Episode Categories

| Category | Use for |
|----------|---------|
| `decision` | Technology choices, architecture, trade-offs |
| `discovery` | Bug root causes, undocumented behavior, insights |
| `milestone` | Features shipped, migrations completed |
| `context` | Constraints, dependencies, environment quirks |

## Data Locations

```
~/.episodic-memory/           # Global (cross-project)
├── scripts/                  # Installed scripts
├── episodes/                 # Global episode .md files
├── index.jsonl               # Global index
└── tags.json                 # Inverted tag index

<project>/.episodic-memory/   # Per-project (local)
├── episodes/                 # Project-local episode .md files
├── index.jsonl               # Project-local index
└── tags.json                 # Inverted tag index

patterns/                     # Behavioral patterns (shipped with repo)
├── _index.json               # Machine-readable pattern registry
├── TEMPLATE.md               # Template for new patterns
└── *.md                      # Individual pattern files
```

All episodes go to the **global common store by default**, making them available across all projects. Use `--scope local` for decisions private to one project. Scripts search **both local and global** by default.

## Self-Correction: Revision Chains

When a past decision proves wrong:

```bash
# Find the original decision
node ~/.episodic-memory/scripts/em-search.mjs --query "framework" --full

# Create a revision (original is auto-marked superseded)
node ~/.episodic-memory/scripts/em-revise.mjs \
  --original <episode-id> \
  --summary "Switched from Express to Fastify" \
  --body "Express middleware overhead became a bottleneck..."

# View the full revision history
node ~/.episodic-memory/scripts/em-search.mjs --history <episode-id> --full
```

## Behavioral Patterns

The system ships with behavioral patterns — reusable lessons learned from real sessions that AI assistants can recall proactively.

| ID | Pattern |
|----|---------|
| bp-001 | Standard implementation workflow |
| bp-002 | Proactive milestone storage |
| bp-003 | Promote project-specific best practices to global memory |
| bp-004 | Machine-readable index for token efficiency |
| bp-005 | Enforcement lives in consuming repos, not rule repos |
| bp-006 | Push only after all verification steps complete |
| bp-008 | Redo properly instead of patching retroactively |
| bp-009 | Store rule violations as evidence for enforcement |
| bp-010 | Habits override knowledge — always add mechanical enforcement |

Patterns are seeded into the global episode store via `em-seed-patterns.mjs` so they surface during normal search and recall. See `patterns/TEMPLATE.md` to create new ones.

### Enforcement

Behavioral patterns are documentation — they tell AI assistants **what** to follow, but don't mechanically **prevent** violations. For mechanical enforcement (hooks, CI checks, PR templates), see [user-preferences](https://github.com/lantisprime/user-preferences) as an optional companion. It provides:

- **Pre-tool hooks** (e.g., `plan-gate.sh`) that block writes during the planning phase
- **CI workflow templates** for status checks that enforce the implementation workflow
- **PR templates** with checklists mapped to behavioral patterns

Episodic-memory and user-preferences are fully independent — install either or both.

## RFCs

| RFC | Title | Status |
|-----|-------|--------|
| [RFC-001](docs/rfcs/RFC-001-memory-improvements.md) | Intelligent Memory: Tag Index, Relevance Scoring, Proactive Recall, Semantic Consolidation | Accepted |
| [RFC-002](docs/rfcs/RFC-002-learning-loop.md) | Learning Loop: Violation Tracking, Pattern Refinement, Actionable Recall | Draft |

## Scripts Reference

All scripts are zero-dependency `.mjs` files using Node.js stdlib only. They output JSON to stdout.

### Store
```bash
node ~/.episodic-memory/scripts/em-store.mjs \
  --project my-project \
  --category decision \
  --tags "auth,security" \
  --summary "Chose JWT over session cookies" \
  --body "JWT simplifies our stateless API design..." \
  --scope global
```

### Revise
```bash
node ~/.episodic-memory/scripts/em-revise.mjs \
  --original <episode-id> \
  --summary "Switched to session cookies" \
  --body "JWT token size became a problem..." \
  --tags "auth,security"
```

### Search
```bash
node ~/.episodic-memory/scripts/em-search.mjs --project my-project
node ~/.episodic-memory/scripts/em-search.mjs --query "JWT" --full
node ~/.episodic-memory/scripts/em-search.mjs --tag auth --category decision --since 2026-01-01
node ~/.episodic-memory/scripts/em-search.mjs --history <id> --full
node ~/.episodic-memory/scripts/em-search.mjs --include-superseded
```

### List
```bash
node ~/.episodic-memory/scripts/em-list.mjs --project my-project --limit 5
```

### Check Stale
```bash
node ~/.episodic-memory/scripts/em-check-stale.mjs --project my-project
```

### Seed Patterns
```bash
node ~/.episodic-memory/scripts/em-seed-patterns.mjs
```

### Rebuild Index
```bash
node ~/.episodic-memory/scripts/em-rebuild-index.mjs --scope all
```

## License

MIT
