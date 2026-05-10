/**
 * audit-table.mjs — Machine-readable reader-canonicalization audit table.
 *
 * Per v3.2 §Reader-canonicalization audit table + Rule 14 (machine-readable
 * blocks for drift-prone state):
 * Every reader of config/state in the harness has its authority root
 * tabulated. This module is the JSON source of truth; prose in plan files
 * mirrors it. Drift validator (validate-second-opinion-audit.mjs) diffs
 * this against actual code paths to catch divergence at CI time.
 */

export const AUDIT_TABLE = {
  schema_version: 1,
  description: 'Reader-canonicalization audit for second-opinion harness',
  rows: [
    {
      reader: 'Composer (default fragments) + freshness gate',
      reads_from: '<harnessRoot>/scripts/second-opinion/preambles/index.json + each fragments/*.md + composer.mjs',
      canonicalized_via: 'path.dirname(fileURLToPath(import.meta.url)) walk-up',
      writer: 'repo (committed source)',
      risk_class: 'stale-vs-source AND in-flight tamper',
      mitigation: 'Two-layer defense: §Registry freshness gatekeeper at harness start (registry-stale-at-gate); composer per-fragment SHA validation (preamble-tamper-at-composer)',
      verifying_paths: [
        'scripts/second-opinion/preambles/composer.mjs',
        'scripts/second-opinion/preambles/index.json',
        'scripts/second-opinion/lib/source-hash.mjs',
        'scripts/second-opinion/lib/install-snapshot.mjs',
      ],
    },
    {
      reader: 'Composer (repo override)',
      reads_from: 'resolveRepoRoot(projectRoot)/.review-store/preambles/<provider>.md',
      canonicalized_via: 'scripts/lib/local-dir.mjs:resolveRepoRoot (same as I-22 / storage)',
      writer: 'User / project maintainers',
      risk_class: 'Worktree orphan / canonical leak',
      mitigation: 'Shared algorithm with storage; worktree-local override invisible (canonical-only). Read-once into memory; validated before composition.',
      verifying_paths: [
        'scripts/second-opinion/preambles/composer.mjs',
        'scripts/lib/local-dir.mjs',
      ],
    },
    {
      reader: 'Hook (provider registry)',
      reads_from: '~/.claude/hooks/second-opinion-providers.json',
      canonicalized_via: 'shell $HOME (matches Claude Code expectation)',
      writer: 'install.mjs --install-second-opinion',
      risk_class: 'Worktree write to non-canonical settings (PR #214 class)',
      mitigation: 'Install writes via canonical-resolved HOME (os.homedir()); install snapshot path constant in install-snapshot.mjs',
      verifying_paths: [
        'hooks/second-opinion-gate.mjs',
        'install.mjs',
        'scripts/second-opinion/lib/install-snapshot.mjs',
      ],
    },
    {
      reader: 'Hook (worktree detection)',
      reads_from: '<process.cwd>/.git (file-vs-dir)',
      canonicalized_via: 'fs.statSync().isDirectory() per hook isWorktreeCwd',
      writer: 'git itself',
      risk_class: 'Hook process cwd ≠ harness projectRoot',
      mitigation: 'Hook reads cwd from PreToolUse stdin tool_input.cwd if present, else process.cwd(). Agreement with resolveRepoRoot verified by I-22 algorithm-parity test.',
      verifying_paths: [
        'hooks/second-opinion-gate.mjs',
        'tests/test-second-opinion-i22-algorithm-parity.mjs',
      ],
    },
    {
      reader: 'Harness (canonical repo)',
      reads_from: 'resolved via scripts/lib/local-dir.mjs:resolveRepoRoot',
      canonicalized_via: 'git rev-parse --git-common-dir',
      writer: 'n/a (resolution only)',
      risk_class: 'Mismatch with hook resolution',
      mitigation: 'Harness + hook share the algorithm; tests assert agreement (I-22)',
      verifying_paths: [
        'scripts/second-opinion.mjs',
        'scripts/lib/local-dir.mjs',
        'tests/test-second-opinion-i22-algorithm-parity.mjs',
      ],
    },
    {
      reader: 'Storage (episodic)',
      reads_from: '<projectRoot>/.episodic-memory/',
      canonicalized_via: '--project flag → resolveRepoRoot(process.cwd())',
      writer: 'em-store --scope local (subprocess cwd: projectRoot)',
      risk_class: 'Subprocess cwd inheritance = PR #218 orphaned-reply class',
      mitigation: 'All subprocess calls pass cwd: projectRoot explicitly',
      verifying_paths: [
        'scripts/second-opinion/storage/episodic.mjs',
        'scripts/em-store.mjs',
      ],
    },
    {
      reader: 'Storage (files)',
      reads_from: '<projectRoot>/.review-store/',
      canonicalized_via: 'Same as above',
      writer: 'Direct fs writes from harness',
      risk_class: 'Same',
      mitigation: 'Same',
      verifying_paths: [
        'scripts/second-opinion/storage/files.mjs',
      ],
    },
    {
      reader: 'CLAUDE_CONFIG_DIR redirect',
      reads_from: '$CLAUDE_CONFIG_DIR (if set) overrides ~/.claude',
      canonicalized_via: 'env var',
      writer: 'n/a',
      risk_class: 'Install writes to ~/.claude while Claude Code reads from redirected dir',
      mitigation: 'I-18 pre-merge probe: set CLAUDE_CONFIG_DIR; install; verify Claude Code reads installed registry. If unsupported, install fails-clear.',
      verifying_paths: [
        'install.mjs',
      ],
    },
  ],
}

export function listAllVerifyingPaths() {
  const set = new Set()
  for (const row of AUDIT_TABLE.rows) {
    for (const p of row.verifying_paths || []) set.add(p)
  }
  return [...set].sort()
}
