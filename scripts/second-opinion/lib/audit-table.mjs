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
        'plugins/claude-code/hooks/second-opinion-gate.mjs',
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
        'plugins/claude-code/hooks/second-opinion-gate.mjs',
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
    {
      // I-NEW-B (issue #221): snapshot provider entries validated by the same
      // shape contract as the source registry, before any hook reads them.
      reader: 'Hook + readSnapshot (provider registry shape)',
      reads_from: 'snapshot.providers[] entries (cli_match / binary / agent_block_patterns / agent_allow_patterns / id / prompt_max_chars)',
      canonicalized_via: 'shared validateProviderRegistry (single source of truth)',
      writer: 'install.mjs --install-second-opinion (Gate 2 pre-write validation)',
      risk_class: 'Fail-open on missing/malformed provider fields the hook depends on (empty providers[] vacuous-pass; invalid cli_match regex silent-skip)',
      mitigation: 'Shared validateProviderRegistry called at install (Gate 1 source-registry + Gate 2 installedProviders), readSnapshot (read-time), hook (gate-time via ./lib/registry-validator.mjs). All three fail-closed on violation. In-tree hook resolves via hooks/lib/registry-validator.mjs symlink; installed hook reads dereferenced copy at ~/.claude/hooks/lib/registry-validator.mjs.',
      verifying_paths: [
        'scripts/second-opinion/lib/registry-validator.mjs',
        'scripts/second-opinion/lib/install-snapshot.mjs',
        'install.mjs',
        'plugins/claude-code/hooks/second-opinion-gate.mjs',
        'plugins/claude-code/hooks/lib/registry-validator.mjs',
        'tests/test-second-opinion-preamble.mjs',
        'tests/test-second-opinion-install-snapshot.mjs',
        'tests/test-second-opinion-gate.mjs',
        'tests/test-install-second-opinion-e2e.mjs',
      ],
    },
    {
      // I-NEW-C (issue #221): --install-second-opinion is atomic w.r.t. its
      // own validation — Gate 1 hard-stops before any side effects; Gate 2
      // quarantines pre-existing snapshot on failure so hook fail-closes.
      reader: 'install.mjs --install-second-opinion atomicity guard',
      reads_from: 'REPO_DIR/scripts/second-opinion/providers/index.json (Gate 1, pre-copy); in-memory installedProviders (Gate 2, post-available()-filter)',
      canonicalized_via: 'Gate 1 via import.meta.url-relative repo path; Gate 2 in-memory after copy + filter',
      writer: 'install.mjs (writeSnapshot or rename to .stale.<unix-ms> on failure)',
      risk_class: 'Stale-snapshot fail-open class: failed install leaves snapshot pointing at superseded source',
      mitigation: 'Gate 1 hard-stops via process.exit(1) BEFORE any fs.copy / mkdir / write. Gate 2 quarantines pre-existing snapshot via fs.renameSync(snap, snap + ".stale." + Date.now()) on validation failure, so hook reads snapshot-not-installed and fail-closes. installFailed flag suppresses Done! success banner and sets process.exitCode = 1.',
      verifying_paths: [
        'install.mjs',
        'tests/test-install-second-opinion-e2e.mjs',
      ],
    },
    {
      // R7-F2: installed-hook validator import root.
      reader: 'Installed hook validator import',
      reads_from: '~/.claude/hooks/lib/registry-validator.mjs (dereferenced copy of repo symlink target)',
      canonicalized_via: 'Relative ./lib/ resolution from ~/.claude/hooks/second-opinion-gate.mjs',
      writer: 'install.mjs --install-second-opinion (fs.copyFileSync dereferences source-side symlink)',
      risk_class: 'Drift between in-tree validator (via symlink) and installed copy',
      mitigation: 'Single canonical source at scripts/second-opinion/lib/registry-validator.mjs. In-tree hook tests resolve through symlink; installed hook reads copy. Both paths verified by test-second-opinion-gate.mjs (in-tree) + test-install-second-opinion-e2e.mjs (installed copy).',
      verifying_paths: [
        'plugins/claude-code/hooks/lib/registry-validator.mjs',
        'install.mjs',
        'tests/test-second-opinion-gate.mjs',
        'tests/test-install-second-opinion-e2e.mjs',
      ],
    },
    {
      // R7-F2: SO_INSTALL_SNAPSHOT_PATH env override (test path).
      reader: 'SO_INSTALL_SNAPSHOT_PATH env override',
      reads_from: 'process.env.SO_INSTALL_SNAPSHOT_PATH (if set) overrides ~/.claude/hooks/second-opinion-providers.json',
      canonicalized_via: 'env var; honored by snapshotPath() in install-snapshot.mjs and SNAPSHOT_PATH in hooks/second-opinion-gate.mjs',
      writer: 'Tests + harness E2E set this to redirect snapshot writes/reads',
      risk_class: 'Test/runtime divergence if only one half honors the override',
      mitigation: 'Both readers (snapshotPath + hook SNAPSHOT_PATH) check the same env var name. Existing test-second-opinion-install-snapshot tests assert override is honored end-to-end.',
      verifying_paths: [
        'scripts/second-opinion/lib/install-snapshot.mjs',
        'plugins/claude-code/hooks/second-opinion-gate.mjs',
        'tests/test-second-opinion-install-snapshot.mjs',
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
