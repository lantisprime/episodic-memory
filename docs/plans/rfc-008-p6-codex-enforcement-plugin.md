# P6 — Codex enforcement plugin Plan (RFC-008)

> Authored against `docs/PLAN_TEMPLATE.md` (§0–§20 + Appendix A). Executor altitude:
> **LOW** — full mechanical Appendix A is the build path. Grounded in the verified Codex
> hook interface (`memory/knowledge_base/codex-hooks.md`, fetched 2026-06-28) and the verified
> event-schema/binding-grammar constraints (`schemas/events/*.json`, `scripts/lib/field-bindings.mjs`).
>
> **Revision r3** — folds round-2 review (planner `…9eb7` + reviewer `…dea1`) + a plan-time
> schema verification:
> - **P6 declares `pre_tool_use` ONLY.** The event schemas require `turn_index:integer`
>   (`event-pre-tool-use.schema.json:15`) and stop/session_start additionally require
>   `is_subagent:boolean` / `harness`; the binding grammar's `$$const` only yields strings
>   (`field-bindings.mjs:86`), so these are satisfiable only from the adapter's **normalized**
>   output, never raw codex stdin. Declaring stop/session_start would force unsatisfiable step-8
>   replays (reviewer N1); they are deferred to a follow-up that must also close the binding/schema
>   gap. This also resolves the r2 C1/N4 tier tension.
> - `apply_patch` parses all four patch directives; empty/unknown → DENY (planner N1).
> - Bash repo-source writes gated via the label branch (reviewer N2).
> - Dynamic `import()`-inside-try pinned so a missing waist denies (exit 2), not exit 1 (planner N2).
> - Every test named in §7/§12/§13 is scheduled in §14 + Appendix (planner N3 + the named-test class).
>
> r2 already landed (round 1): single thin-waist-importing adapter (B1); "7 pass, 2 deferred-P3"
> (A1); #17532 firing/enforcement split; install merge/skill-collision/caller-cwd.
>
> **Revision r6 (final, MEDIUM-honest — 2026-06-28, codex interactive review, reply `…3634` + live
> tmux session):** the empirical probe (KB `codex-hooks.md`) proved the codex PreToolUse **MECHANISM**
> is STRONG (hard-blocked `apply_patch` + all 6 shell forms). BUT **mechanism-strong ≠
> capability-strong**: the delivered `{codex,pre_tool_use}` capability includes **Bash**, whose
> write-target detection needs shell lexing and has known escapes (3 one-shot review rounds each found
> a new statically-lexable one — quoted-space, GNU `cp -t`, attached `WORD>redirect`, word-concat).
> So the **honest tier is MEDIUM** with a `bypass_known` **MEDIUM ceiling** citing the Bash-write
> residual; "structured `apply_patch`/Edit/Write are mechanically STRONG" lives in design prose +
> tests, **NOT** the one-tier manifest. This **corrects r6's earlier over-claim** (STRONG +
> clean-audit), per codex's interactive recommendation.
> **Bash extractor is bounded and FROZEN to the §12.1 MUST-CATCH table** (redirects incl. attached +
> quoted-space + multi, `sed -i`/`tee`/`dd of=`, `cp`/`mv`/`install` dest incl. GNU `-t`; every
> relative target resolved under stdin cwd — codex F1). Everything outside it (dynamic
> `$()`/`$VAR`/glob, `eval`/`sh -c`/`bash -c`/aliases, awk/`python -c`/`node -e`, broad tools
> `tar`/`rsync`/`git apply`/`make`/`find -exec`) is **documented residual**. **STOP-RULE: a new shell
> form outside the table → document as residual, NEVER grow toward a full shell lexer.**
> The probe still earns the real RFC fixes (kept): `{block:true}`→exit-2/`permissionDecision`,
> "Python hooks"→node command hook, block-not-warn (the adapter BLOCKS at the gate, not warn). Real
> `apply_patch` stdin captured → REQ-11 fixture (`turn_id` string, no `turn_index`).

## §1 Status

`Planning only.` Do not implement until this plan, the plan review, and the adversarial review
are accepted (Rule 18). Current stage: **plan review ACCEPTED — codex r7 (interactive tmux,
2026-06-28) ACCEPT on the MEDIUM-honest revert after 6 fixes (1 BLOCKER #6 tier/cap split +
1 BLOCKER-class #1 label short-circuit + 4 consistency; §19.4). Design: tier MEDIUM (mechanism STRONG,
Bash residual caps), runtime STRONG mechanism cap for covered writes, bounded extractor frozen to the
§12.1 MUST-CATCH table with a no-lexer-growth stop-rule. NEXT = Rule 18 step 4: final plan + user
approval (plan-approval marker fires there), then implement.**

| Field | Value |
|---|---|
| RFC | `RFC-008` |
| Parent requirements | `R6` (plugin↔harness binding), `R10` (enforcement runbooks) |
| Workplan episode | `20260627-044606-workplan-v148-rfc-008-p5-complete-openco-af2d` |
| Target branch | `feat/rfc-008-p6-codex-enforcement` |
| Executor altitude (§0.1) | `low` |

## §2 Episode Search Summary

```bash
node scripts/em-search.mjs --tag rfc-008 --tag opencode --scope all --limit 10 --full --no-track
```

Key active memories:

- `…697c` (PR-level review catches slice-blind adapter conformance): whole-branch PR-level review
  before opening the PR; real-runtime E2E drives the deployed artifact. **§10 S2/S3, §19.**
- `…7918` (verify the strong claim, not the proxy layer). **§10 S3 gauntlet codex-native, §15.**
- `feedback_mock_project_test_not_mental_trace`. **S1, S4.**
- `feedback_enforcement_gate_only_repo_src` (LOCKED R1–R3): gate only repo-source; never block
  episodes/markers/plans. **The `apply_patch` over-block + Bash gating are the sharpest tests.**
- `…18aa` (drive any TUI via tmux). **S1/S4 interactive E2E.**
- KB `codex-hooks.md`: verified Codex interface. **S0/S2.**

Verified-at-plan-time artifacts (captured during review rounds 1–2):
- `codex-cli 0.141.0` installed.
- `harness` enum includes `"codex"`; `invocation_modality:"cli"` valid; `classifier:override`
  requires `override_path` (`plugins/manifest.schema.json`).
- `bypass_known.json` has `{ "harness": "codex", "event": "pre_tool_use", "ceiling": "MEDIUM" }`
  (the on-disk state; S2 step 2.4b KEEPS this MEDIUM ceiling and refines its citation per REQ-4).
- `test-plugin.mjs:92-93` hardcodes steps 5/6 `deferred-P3` → ceiling is `7 pass, 2 deferred-P3, 0 fail — OK`.
- `install.mjs:937` has a `case 'codex'` **skill** install (distinct from `--install-enforcement`).
- `enforce-contract.mjs` exports `gateDisposition`, `loadEnforceConfig`, `resolveContractRoot`,
  `resolveHarnessCap`, `decideStop`; `repo-source.mjs:149-165` gates Bash via the **label** branch
  (`toolTargetsRepoSource(root,"Bash","",label)` GATED for `shared_write`; **read_only/nonsrc_write
  short-circuit to ALLOW before the path check at :150-154 — so the adapter does NOT use this Bash-label
  branch; it gates each extracted path via `isRepoSource` direct, §8.2/REQ-5, codex r7 F1**).
- `event-pre-tool-use.schema.json:8,15` requires `turn_index:integer`; `event-stop.schema.json:8`
  requires `is_subagent:boolean`; `event-session-start.schema.json:8` requires `harness`.
  `field-bindings.mjs:86` `$$const` returns a **string**. → step-8 payloads must come from the
  adapter's normalized output, not raw codex stdin.

## §3 Objective

Ship `plugins/codex/` — a Codex CLI enforcement plugin that gates repo-source writes through the
shared thin waist, built to Codex's own hook contract (`.codex/hooks.json` command hook, exit-2 /
`permissionDecision:deny`, Codex stdin schema). **Scope: `PreToolUse` enforcement only** (the only
event whose canonical payload P6 can satisfy and the only one that blocks a write). Provable by
`test-plugin.mjs --harness codex` → `7 pass, 2 deferred-P3, 0 fail — OK`; an adapter-conformance
test driving real codex stdin (incl. multi-file `apply_patch` + Bash); and a tmux interactive E2E
against `codex 0.141.0`. Maps R6, R10.

## §4 Requirements (Ground Truth)

| ID | Requirement (concrete, testable) | Parent R | Test(s) | Priority | Notes |
|---|---|---|---|---|---|
| REQ-1 | RFC-008 + `P5-P7-tool-plugins.md` corrected: block via exit-2 / `permissionDecision:deny` (not `{block:true}`); the plugin is a **node command hook**, not "Python" (correct **all** sites incl. RFC:833/:1189/:1320); **codex `pre_tool_use` tier STAYS MEDIUM but the rationale is corrected — the refuted multi-edit-bypass basis is replaced with the honest Bash-write lexing residual (matrix L915, correction L919, plan-approval example L934, P5-P7:48); no tier flip**; the historical entries (L1298/L1368) are **annotated, not deleted** (MEDIUM remains the correct call; only the basis is refined); a P6-scope note records that P6 ships `pre_tool_use` only and stop/session_start stay deferred. | R6 | `grep -rn "Codex.*Python\|{block:true}" docs/rfcs/` → 0; `grep -c "declared MEDIUM, not STRONG" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → 0 (old framing removed; new annotations reuse "multi-edit" so do NOT grep the bare token); `grep -c "| Codex | \*\*MEDIUM\*\*" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → 1 (tier retained); doc review | MUST | Rule 10. |
| REQ-2 | `plugins/codex/manifest.json` validates: `harness:"codex"`, `invocation_modality:"cli"`, capabilities `{pre_tool_use:"MEDIUM"}` **only**, a single `pre_tool_use` `event_translation`, runbook paths. | R6 | gauntlet step 1; `validate-schemas.mjs` | MUST | MEDIUM is the honest one-tier value (mechanism STRONG but Bash sub-channel has known escapes); declaring only pre_tool_use keeps M5c bijection satisfiable. |
| REQ-3 | `plugins/codex` registered in `plugins/_index.json` (typed + versioned), gauntlet step 2 green. | R6 | gauntlet step 2; `test-plugin-registry.mjs` | MUST | |
| REQ-4 | The one declared `{codex,pre_tool_use}` keeps exactly one `bypass_known.json` record (M4a): a **MEDIUM `ceiling`** with a citation to the Bash-write residual — the statically-**unlexable** forms outside the §12.1 MUST-CATCH table (`eval`/`sh -c`/`bash -c`, command-substitution, `$VAR`-expanded paths, here-docs, awk/`python -c`/`node -e`-internal writes). **NOT clean-audit** — those forms escape the frozen extractor, so `no_known_bypass_evidence:true` would be dishonest. (NB: `echo > src/x` / `sed -i src/x` are §12.1 MUST-CATCH and DO hard-block — they are not the escape; the escape is the unlexable class.) (opencode's clean-audit on the same gap is a precedent to FIX via backport, not copy.) No new {harness,event} records. | R6 | gauntlet step 7; `validate-plugin-registry.mjs` | MUST | MEDIUM ceiling, NOT clean-audit; the unlexable Bash residual IS a known bypass. |
| REQ-5 | Adapter blocks **iff** repo-source-GATED **and** disposition ∈ {enforce,block}. **GATED = `isRepoSource(root,p).isRepoSource` per extracted (normalized) path** — the per-path predicate imported directly, **NOT** `toolTargetsRepoSource(...,"Bash",...,label)`, whose Bash-label branch (`repo-source.mjs:150-154`) short-circuits `read_only`/`nonsrc_write` to ALLOW **before** checking the path (`sed -i`/`echo>` classify `read_only` → would re-open the bypass). **Disposition** comes from `gateDisposition` called with a **runtime mechanism cap of `STRONG`** for covered writes (NOT the manifest's declared `MEDIUM` — `events.json` maps `pre_tool_use@MEDIUM`→`warn`→`clamp-off`→no block; see §8.2 tier/cap split). Both imported **directly** via dynamic `import()` **inside a try** (a missing waist → deny, exit 2; never exit 1). | R6 | conformance; `testImportFailClosed`; `testBlocksUnderDeclaredMedium`; `testConfigClampMediumWarns` | MUST | B1 + planner N2 + codex r7 F1 (label short-circuit) + F6 (tier/cap split). |
| REQ-6 | Adapter reads Codex stdin (`hook_event_name`/`tool_name`/`tool_input`/`cwd`), and on a block emits exit `2` **and** `hookSpecificOutput.permissionDecision:"deny"` JSON. | R6 | conformance (real stdin + real fixture) | MUST | strong-claim surface. |
| REQ-7 | Root from stdin `cwd` **only** (`path.isAbsolute` required, then `realpathSync`); relative/empty cwd → deny. | R6 | `testCwdDivergence`, `testCwdRelative`, `testCwdSymlink` | MUST | EC2; all three scheduled. |
| REQ-8 | **`apply_patch` multi-path safety:** extract **all** target paths from the patch (parsing `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`); GATE if **any** is repo-source; carve-check **each**; an **empty or unknown-directive** patch → DENY (fail-closed). | R1, R6 | `testApplyPatchMultiFileBlocks`, `testApplyPatchDocsOnlyAllows`, `testApplyPatchMarkerBundleAllows`, `testApplyPatchUnparseableDenies` | MUST | planner N1 (over-block + bypass + empty-set). |
| REQ-9 | **Bash repo-source gating — extract-only (gate iff an extracted target is repo-source; never on a label):** GLOBAL-extract all write targets — redirects (`>`/`>>`/`&>`/`>&`-to-file), `sed -i`, `tee`, `dd of=`, **and the destination operand of `cp`/`mv`/`install`** — and check each via the per-path repo-source check; gate if **any** is repo-source. A repo-source write (`sed -i src/x`, `echo > src/x`, `grep x &> src/z`, `> /tmp/a > src/evil`, `cp a src/x`) blocks; a **sink/fd-dup** (`echo > /dev/null`, `grep x 2>&1`), a non-repo redirect or copy (`echo > /tmp/y`, `cp a /tmp/y`), a read-only command (`cat src/x`), and **any command with no extracted repo-source target** (`git commit`, `mkdir -p x`, `npm test`) are ALLOWED. Because the now-real hard block would brick normal tooling, there is **no label-branch fallback** — an empty target set ALLOWS. Writes via mechanisms the extractor cannot lex (`eval`, command substitution, here-docs, variable-expanded paths, awk-internal `{print > "f"}`) **also ALLOW** — this is the documented residual (§16 R8), NOT a deny, so they do not brick legitimate non-repo commands. | R1, R6 | `testBashRepoSourceWriteBlocks`, `testBashRedirectWriteBlocks`, `testBashAmpRedirectToFileBlocks`, `testBashMultiRedirectBlocks`, `testBashCpDestBlocks`, `testBashDevNullAllows`, `testBashStderrDupAllows`, `testBashRedirectToTmpAllows`, `testBashCpToTmpAllows`, `testBashReadOnlyAllows`, `testBashGitCommitAllows`, `testBashUnlexableResidualAllows`, `testBashQuotedRedirectBlocks`, `testBashQuotedDocsAllows`, `testBashTargetResolvedUnderStdinCwd`, `testBashQuotedPathWithSpaceBlocks`, `testBashQuotedDocsWithSpaceAllows`, `testBashCpTargetDirBlocks`, `testBashCpTargetDirAllows` | MUST | planner NEW-1 (bypass) + N-r4-1 (/dev/null over-block) + N-r4-2 (multi-redirect) + reviewer N-r4 (`&>`file) + r6 extract-only (no-target → ALLOW; cp/mv/install dest; unlexable → allow-residual) + codex F1 (target resolved under stdin root) + codex F2 (quote-strip) + codex round-6 (tokenizer: quoted-space paths; GNU `cp -t` dest). |
| REQ-10 | Adapter fails **closed**: garbage stdin, valid-JSON-non-object (`null`/`[]`/`42`), import error, internal throw → deny (exit 2), never silent allow; the `JSON.parse` + non-object check sit inside the try. | R6 | `testFailClosed` (4 rows: `""`,`42`,`null`,`[]`) | MUST | §12; planner N5. |
| REQ-11 | The step-8 fixture `tests/fixtures/harness-events/codex/pre-tool-use.json` is the **normalized** form (real captured `codex 0.141.0` apply_patch stdin **plus** a synthesized `turn_index:0` — the field the adapter adds at runtime, since `event-pre-tool-use.schema` requires integer `turn_index` and codex sends only `turn_id`). The manifest binds `$.turn_index` from this normalized fixture. Separately, a conformance row drives the adapter with **raw** codex stdin (`turn_id`, no `turn_index`) to prove the live path synthesizes it. | R6 | gauntlet step 8; `testAdapterHandlesRawStdin` | MUST | provenance disclosed (A.7 1.2); not hand-invented decision values. EC6/EC11. |
| REQ-12 | `test-plugin.mjs` step 9 proves the **Codex-native** invocation surface (exit-2/permissionDecision driving the real adapter). | R6 | gauntlet step 9 at `--harness codex` | MUST | new `expected_outputs.shape:"codex-native"` branch — §10 S3. |
| REQ-13 | `install.mjs --install-enforcement --tool codex` deploys per-project under `<project>/.codex/`, **merges** the adapter command hook into an existing `.codex/hooks.json` (never clobbers), prints the `/hooks` trust instruction, co-locates the thin-waist closure, does **not** collide with the `case 'codex'` skill (install.mjs:937); uninstall removes only our entry. **All artifacts (`.codex/hooks.json`, closure) land under the resolved `project_root`, NEVER caller cwd or `$HOME` (codex F3 — install is cwd-sensitive, same cwd-binding class as F1).** | R6, R10 | `test-install-codex-enforcement.mjs` — full **cwd-divergence matrix** with on-disk assertions: (1) caller cwd ≠ `--project` target, (2) caller cwd in a linked git worktree ≠ main target, (3) nested subdir cwd, (4) non-git caller cwd with explicit `--project`, (5) subprocess cwd inheritance, (6) artifact-location assert (`statSync` under `project_root`, ABSENT under caller cwd + `$HOME`) | MUST | per-project only; never `~/.codex/`. |
| REQ-14 | **tmux firing-proof:** real `codex 0.141.0` TUI in a mock project proves the project-local `PreToolUse` hook **fires** interactively (allow/logging stub records it). | R6 | `manual: codex-tmux-e2e.mjs::firingProof` | MUST `UNGUARDED-IN-CI` | #17532 surface; STOP if it doesn't fire. |
| REQ-15 | **tmux enforcement-proof (post-install):** the deployed adapter, via tmux, DENIES a repo-source `apply_patch` write **and** ALLOWS a `docs/plans/` `apply_patch` write (discriminating pair) + positive control that `PreToolUse` fired. | R6 | `manual: codex-tmux-e2e.mjs::enforcementProof` | MUST `UNGUARDED-IN-CI` | not a deny-stub. |
| REQ-16 | `plugins/codex/runbooks/enforcement.md` has the 10 sections + `## ⚠️ Self-trigger` + `## 🤖 Agent invocation manifest` JSON + COMMON/RESOLUTION/CONFIG byte-equal blocks; documents the `/hooks` trust step **and** the Bash-write-via-unlexable-shell **coverage** residual (§16 R8 — the sub-channel limit that caps the declared tier at MEDIUM; the extractor is frozen to the §12.1 MUST-CATCH table with a no-lexer-growth stop-rule). | R10 | gauntlet steps 3 + 9 | MUST | |
| REQ-17 | CI `plugin-validate.yml` runs `test-plugin.mjs --harness codex` + codex suites on Node 24, **plus** a CI-guardable smoke validating the fixture shape + `.codex/hooks.json` structure. | R6 | CI run; `grep` of workflow | MUST | live interactive run stays manual (G1). |
| REQ-18 | **RESOLVED → MEDIUM (mechanism STRONG, capability MEDIUM).** The empirical probe (real `codex 0.142.3`, KB `codex-hooks.md`) confirmed the deny hook hard-blocks `apply_patch` AND all 6 shell forms with no bypass reproduced — the **mechanism** is STRONG. But the delivered capability includes Bash, whose write-target lexing has known escapes (§16 R8; extractor frozen to §12.1), so `pre_tool_use` is declared **MEDIUM** with a `bypass_known` MEDIUM ceiling. S1's interactive firing-proof re-confirms the hard block on the installed binary. | R6 | KB probe; conformance; S1 firing-proof | MUST | OD-1 resolved (MEDIUM-honest). |

REQ-14/15 are `UNGUARDED-IN-CI` (real binary + TTY); REQ-17 guards the CI-checkable partial.

## §5 Non-Goals

- **stop / session_start hooks (deferred).** Not declared as capabilities and not registered. Beyond
  the bp-001-lifecycle reason, the canonical event schemas require fields raw codex stdin lacks
  (`is_subagent:boolean`, `harness`, integer `turn_index`) that the binding grammar cannot synthesize
  from `$$const` (string-only). Delivering STRONG stop-gate needs schema/binding work tracked as a
  follow-up (§17 OD-4). §16 R6 states the enforcement-strength consequence.
- The full bp-001 marker lifecycle.
- `config.toml` registration (we use `.codex/hooks.json` only).
- `tool_result` / `PostToolUse`.
- Global `~/.codex/` install (per-project only, Principle 12).
- Changing the thin waist; touching the `case 'codex'` skill install beyond no-collision.

## §6 Token Budget (Rule 12)

| File | `wc -l` | Reads | Writes | Notes |
|---|---|---|---|---|
| RFC body | 1534 | ~7.7k (grep) | ~1k | S0: block mech + Python (3 sites) + scope note + indexes |
| `P5-P7-tool-plugins.md` | 70 | 0.4k | 0.4k | S0 |
| `enforce-bridge.mjs` (template) | 229 | 1.1k | — | reference |
| `codex-adapter.mjs` (new) | ~210 | — | ~3k | S2 (single file; imports waist; apply_patch parser) |
| `manifest.json` (new) | ~35 | — | 0.5k | S2 (single capability) |
| `runbooks/enforcement.md` (new) | ~190 | — | ~3k | S5 |
| `test-plugin.mjs` | 473 | 2.4k | ~1.5k | S3 codex-native branch |
| `install.mjs` (opencode region) | ~200 read | 1.0k | ~2.5k | S4 |
| `tests/test-codex-*.mjs` + tmux | ~380 | — | ~5.5k | S1/S2/S4 |

**Baseline:** ~45k work + ~38k overhead ≈ **83k** — split by slice. **Optimized:** A: S0+S1 (~24k);
B: S2 (~30k); C: S3+S4+S5 (~45k).

## §7 Safety / Security

Trust boundary with stdin-injection, multi-path extraction, and path-authority logic.
**`negative-scenario-planner` dispatched rounds 1–2 (replies `…020b`, `…9eb7`)**; findings folded.

| Concern | Severity | Scenario | Mitigation | Test(s) (incl. ≥1 negative) |
|---|---|---|---|---|
| `apply_patch` over-block (R1) | High | no `filePath` → empty → fail-closed GATED before carve → marker/plan write blocked → deadlock | extract all patch paths; carve-check each | `testApplyPatchMarkerBundleAllows` (NOT blocked) |
| `apply_patch` multi-edit bypass (R6) | High | 2-file patch `docs/plans/x.md`+`src/evil.mjs`; gate on carved first → allow | GATE if **any** path repo-source | `testApplyPatchMultiFileBlocks` |
| `apply_patch` empty/unknown-directive (R1/R6) | High | parser misses a directive form → `[]` → vacuous allow | empty/unknown patch → DENY (parse all 4 directives) | `testApplyPatchUnparseableDenies` |
| **Bash repo-source not gated** (R1) | High | `sed -i src/x.mjs` / `cp a src/x.mjs` extracts no target → write escapes | extract write targets incl. redirects + `sed -i`/`tee`/`dd of=` + `cp`/`mv`/`install` dest; gate iff any is repo-source | `testBashRepoSourceWriteBlocks`, `testBashCpDestBlocks` + `testBashReadOnlyAllows` (NEG) |
| **Bash over-block bricks tooling** (r6 extract-only) | High (deadlock) | a real hard block on a no-write command (`git commit`, `mkdir`, `npm test`) halts normal work | extract-only: empty repo-source target set → ALLOW; no label-branch fallback | `testBashGitCommitAllows` (NEG), `testBashCpToTmpAllows` (NEG) |
| Fail-open on malformed stdin | High | garbage / non-object | parse/shape failure inside try → deny exit 2 | `testFailClosed` (4 rows) |
| **Import fail-open** (B1 collapse) | High | static import of missing waist → exit 1 (not the exit-2 block signal) → fail-open | dynamic `import()` inside the top-level try → deny exit 2 | `testImportFailClosed` (unresolvable waist → exit 2) |
| Root-source spoofing | High | relative/symlinked cwd | `isAbsolute` then `realpathSync`; never `process.cwd()` | `testCwdDivergence`, `testCwdRelative`, `testCwdSymlink` |
| **Extracted-target resolved via process.cwd()** (codex F1) | High | a relative extracted target (`src/x.mjs`) reaches the waist; `canonicalizePossiblyNonexistent` (`repo-source.mjs:66`) resolves it under the adapter's process cwd, not stdin root → ALLOW under a divergent cwd | normalize: quote-strip then `path.resolve(root, target)` for every extracted target BEFORE the waist | `testBashTargetResolvedUnderStdinCwd` (NEG) |
| **Install artifacts land off project_root** (codex F3) | High | install run from a divergent caller cwd / linked worktree writes `.codex/` under caller cwd or `$HOME` instead of `project_root` | resolve `project_root` once; assert artifacts under it | REQ-13 cwd-divergence matrix (6 rows) |
| Marker/escape over-block | High (deadlock) | misclassify `.checkpoints/.*`/plan as write | classifyLabel + per-path carve; `.git/` carved | `testMarkerWriteAllowed`, `testEpisodeWriteAllowed`, `testGitWriteAllowed` |
| Trust-prompt inactivity | Med | inactive until `/hooks` trust | runbook + install print; tmux trustGate | `manual:` trustGate; `testInstallPrintsTrust` |

### 8-axis symlink/path matrix (stdin `cwd` + extracted target path[])

| Axis | Case | Required | Test |
|---|---|---|---|
| 1 | cwd absent/empty/relative | deny; isAbsolute guard; never process.cwd() | `testCwdRelative`, `testFailClosed` |
| 2 | cwd symlinked dir | realpath before check | `testCwdSymlink` |
| 3 | macOS `/var`→`/private/var` | realpath canonicalizes | `testCwdSymlink` (macOS) |
| 4 | target symlink escaping repo | isRepoSource realpaths target → ALLOW | reuse `repo-source.mjs` suite |
| 5 | `.git/` (incl. via apply_patch) | carved | `testGitWriteAllowed` |
| 6 | episode-store | never gated (R1) | `testEpisodeWriteAllowed` |
| 7 | marker/plan (incl. apply_patch bundle) | never gated (R1) | `testMarkerWriteAllowed`, `testApplyPatchMarkerBundleAllows` |
| 8 | multi-path apply_patch (carved + src) | GATE (any-repo-source) | `testApplyPatchMultiFileBlocks` |

Adapter consumes only stdin (no argv path), so `isMain`/`argv[1]` (`…16c4`) + lstat-before-realpath
(`…937a`) traps do not apply — asserted by the adapter reading only stdin.

**Named-test completeness (planner N3 class):** every test identifier in §7/§12/§13 appears in §14
Group 1 and an Appendix A.7 step. Verify with a sweep, not instance-by-instance.

## §8 Design

### 8.1 Component shape

Two files under `plugins/codex/` + the shared thin waist (unchanged):

- `capabilities/codex-adapter.mjs` — the Codex-native command hook AND the whole decision path in
  one process. It reads Codex stdin, and **only for `PreToolUse`**: extracts target path(s) (incl.
  multi-file `apply_patch`), runs the two-layer AND by **dynamically importing**
  `isRepoSource` (per-path, NOT the Bash-label `toolTargetsRepoSource`) + `gateDisposition` + loaders **inside the top-level try** (the hook is its
  own subprocess — no separate bridge, per KB `codex-hooks.md:48-49,81-83`), synthesizes the
  normalized payload (incl. an integer `turn_index`), and writes Codex's native response (exit 2 +
  `permissionDecision:deny` on block; exit 0 on allow; exit 2 + deny on any fail-closed path). Any
  non-`PreToolUse` `hook_event_name` → exit 0 (P6 declares only pre_tool_use).
- `manifest.json`, `runbooks/enforcement.md`, `runbooks/enforcement.quickref.md`.

```mermaid
sequenceDiagram
    participant CX as Codex CLI
    participant AD as codex-adapter.mjs (.codex/hooks.json PreToolUse command)
    participant TW as thin waist (isRepoSource + gateDisposition), dynamic import inside try
    CX->>AD: PreToolUse stdin {hook_event_name, tool_name, tool_input, cwd, ...}
    AD->>AD: isAbsolute(cwd)+realpath; classifyLabel; extract path[] (apply_patch → all dirs, unknown→deny; Bash → write targets incl cp/mv/install dest, unresolvable→not extracted)
    AD->>TW: per extracted path isRepoSource(path) ; gateDisposition(harnessCap=STRONG)  (extract-only — NO label-branch fallback; empty paths → ALLOW)
    TW-->>AD: GATED iff (any extracted path repo-source) ; token
    alt GATED ∧ token∈{enforce,block}  OR  fail-closed
        AD-->>CX: exit 2 + {"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":reason}}
    else allow / non-PreToolUse
        AD-->>CX: exit 0
    end
```

### 8.2 Key invariants

- **Fail-closed first (unconditional):** bad input (non-object / missing `hook_event_name` /
  relative-or-empty cwd) **and** an unparseable/empty-directive `apply_patch` → DENY **before** the
  disposition/label logic runs — these never depend on `gateDisposition`'s token (NEW-4). **The
  apply_patch/Bash asymmetry (r6, deliberate):** `apply_patch` is the structured primary write path,
  so an unparseable patch is genuinely anomalous and denying it cannot brick normal use (well-formed
  patches always parse). A `Bash` write-indicator with an unresolvable operand is routine in
  legitimate non-repo commands, and under the now-real hard block a deny would brick them — so Bash
  no-target → ALLOW (the §16 R8 residual), never deny.
- **Else block iff GATED ∧ token∈{enforce,block}**, where `GATED = (any extracted path is
  repo-source)`. **Extract-only — no label-branch fallback:** an empty extracted-target set ALLOWS
  (the hard block must not gate on a coarse `shared_write` label, which would brick
  `git commit`/`mkdir`/`npm test`).
- **Target normalization BEFORE the waist (r6, codex F1/F2 — REQUIRED):** every extracted target is
  (a) **quote-stripped** — a matched pair of surrounding single/double quotes is removed (`>>"src/x"`
  → `src/x`) so an ordinary quoted path is a real, lexable write, NOT the residual; then
  (b) **resolved under the stdin root** — `path.isAbsolute(t) ? t : path.resolve(root, t)` — before
  `toolTargetsRepoSource`/`isRepoSource`. **Never pass a relative target to the waist:**
  `canonicalizePossiblyNonexistent` resolves a relative path via `process.cwd()`
  (`repo-source.mjs:66`), so a relative `src/x.mjs` under a divergent adapter process cwd resolves to
  the WRONG root and returns ALLOW (a reproduced cwd-divergence bypass). Only an operand that is
  **still dynamic after quote-stripping** (`$(…)`, backtick, `$VAR`, an unmatched quote) is the §16 R8
  residual (not extracted → ALLOW). This composes with "root from stdin cwd only".
- **Root from stdin `cwd` only** — `path.isAbsolute` then `realpathSync`. Never `process.cwd()`.
- **Fail closed** — garbage/non-object stdin, relative cwd, dynamic-import throw, internal throw → deny.
- **`apply_patch` extraction** — parse `*** Add/Update/Delete File:` + `*** Move to:`; empty or any
  unrecognized directive → unknown → DENY (fail-closed; structured path).
- **`Bash` extraction** — extract write targets (`>`/`>>`/`&>`/`>&`-to-file non-sink, `sed -i`,
  `tee`, `dd of=`, and the `cp`/`mv`/`install` destination operand) and check each as a path; gate
  iff **any** is repo-source. A write indicator with no resolvable target, a non-repo target, or a
  read-only command → ALLOW. Writes via unlexable shells (`eval`, command-subst, here-docs,
  variable-expanded paths, awk-internal) are the documented residual that caps the tier at MEDIUM (§16 R8) and ALLOW.
- **Normalized payload** — adapter synthesizes integer `turn_index` (per-process counter from 0) so
  the step-8 fixture (the adapter's output) satisfies `event-pre-tool-use.schema:turn_index:integer`.
- **Cross-platform:** `os.tmpdir()`+`path` in tests; `command_windows` in hooks.json; realpath for
  macOS `/private/var`.
- **Atomicity:** install **merges** `.codex/hooks.json` via read-modify-`writeJSONAtomic`.

### 8.3 Capability matrix (declared)

| Event | Tier | Basis |
|---|---|---|
| `pre_tool_use` | **MEDIUM** | **Mechanism is STRONG** (KB probe, codex 0.142.3: the deny hook hard-blocked `apply_patch` + all 6 shell forms, no bypass reproduced — the adapter BLOCKS (deny), it does not warn). **But the delivered capability includes Bash**, whose write-target lexing has known escapes (§16 R8; the extractor is frozen to the §12.1 MUST-CATCH table), so the honest one-tier value is **MEDIUM** with a `bypass_known` MEDIUM ceiling. "apply_patch/Edit/Write are mechanically STRONG" lives in design prose + tests, NOT the manifest. RFC's multi-edit-bypass rationale is refuted; the honest MEDIUM basis is the Bash-write lexing residual. **P6's only declared event + enforcement surface.** |

`stop`/`session_start`/`tool_result`/`session_end` not declared (§5). S0 **keeps the codex
pre_tool_use tier cells at MEDIUM** but corrects the rationale (matrix L915, correction L919,
plan-approval example L934, P5-P7:48 — replace the refuted multi-edit-bypass basis with the honest
Bash-write lexing residual) AND adds a P6-scope note. The stop/session_start cells are **LEFT**
(STRONG matrix target, deferred delivery), so the rationale fix touches only the event P6 actually
delivers; codex stop/session_start STRONG is a tracked follow-up.

## §9 Existing Hook Points

| File | Line(s) | Today | Impact |
|---|---|---|---|
| `plugins/_index.json` | `plugins[]` | claude-code + opencode | APPEND a `codex` entry |
| `plugins/bypass_known.json` | codex pre_tool_use L3-8 | M4a MEDIUM-ceiling record | **KEEP** the MEDIUM `ceiling` record; refine its citation to the Bash-write lexing residual (§16 R8; forms outside the §12.1 MUST-CATCH table); one record, no new pairs |
| `scripts/test-plugin.mjs` | step-9 modality switch L233-272; steps 5/6 `deferred-P3` L92-93 | two shapes | ADD `codex-native` branch |
| `install.mjs` | `REPO_PLUGIN_OPENCODE` L68; `VALID_TOOLS` L200; `case 'codex'` **skill** L937; opencode dispatch L1649-1655; `opencodeEnforcementPaths` L1481-1506; install/uninstall L1508-1628 | per-project opencode | ADD codex enforcement fns + `--install-enforcement`+`tool==='codex'` branch that does NOT touch L937 |
| `.github/workflows/plugin-validate.yml` | opencode gauntlet L61-62; Node 24 L41 | opencode suites | ADD `--harness codex` + suites + fixture/hooks.json smoke |
| `docs/rfcs/RFC-008-…md` | block ~L336; "Python" L833/L1189/L1320; tier matrix L915; correction L919; plan-approval example L934; alternatives L1298; review-finding L1368; stop-gate L946 (LEAVE — stop, already STRONG) | Codex assumptions + stale MEDIUM rationale | CORRECT block + all 3 Python sites; CORRECT the pre_tool_use MEDIUM rationale at L915/L919/L934 (refuted multi-edit basis → Bash-lexing residual; tier STAYS MEDIUM, no flip); annotate historical L1298/L1368 (MEDIUM retained, basis refined); ADD P6-scope note (stop/session_start still deferred) |

**Verify all line numbers at build time** (§A.6 STOP-and-ask on a miss).

## §10 Slice Ladder

| Slice | Objective | Primary files | Deliverables | Tests | Hard stops |
|---|---|---|---|---|---|
| `P6-S0` | Rule 10 RFC/doc correction | RFC body, `P5-P7-tool-plugins.md`, `docs/README.md`, `docs/_index.json`, `_repo-context.md` | block mech + all 3 Python sites + **pre_tool_use MEDIUM rationale correction (L915/L919/L934, P5-P7:48 — refuted multi-edit basis → Bash-lexing residual; no tier flip)** + history annotations (L1298/L1368) + P6-scope note + index sync + stop-STRONG follow-up issue | `grep -rn` sweeps; `validate-schemas.mjs` | tier STAYS MEDIUM; correct rationale only; LEAVE stop/session_start (deferred); no code |
| `P6-S1` | tmux firing-proof + normalized fixture | `tests/integration/codex-tmux-e2e.mjs`, `tests/fixtures/harness-events/codex/pre-tool-use.json` | drive live TUI; assert PreToolUse fires (allow stub); capture real multi-file apply_patch stdin → derive the normalized fixture (incl. synthesized turn_index) | `manual: firingProof` | if PreToolUse doesn't fire → STOP, escalate #17532 |
| `P6-S2` | adapter + manifest + registry + conformance | `plugins/codex/capabilities/codex-adapter.mjs`, `plugins/codex/manifest.json`, `plugins/_index.json`, `tests/test-codex-adapter-conformance.mjs` | single-file adapter (apply_patch parser, Bash extract-only target extraction incl. cp/mv/install dest, isAbsolute, dynamic-import-in-try, turn_index synth, fail-closed); single-capability MEDIUM manifest; registry; bypass_known MEDIUM ceiling; conformance loads the real fixture | `test-codex-adapter-conformance.mjs`; gauntlet steps 1,2,7,8 | no step-9 branch yet |
| `P6-S3` | gauntlet `codex-native` modality + runbook agent-manifest | `scripts/test-plugin.mjs`, `plugins/codex/runbooks/enforcement.md` | new step-9 branch driving the real adapter; agent-invocation manifest | gauntlet step 9 at `--harness codex` | **focused review before build** (shared high-blast file) |
| `P6-S4` | per-project install + enforcement-proof | `install.mjs`, `tests/test-install-codex-enforcement.mjs`, `codex-tmux-e2e.mjs` (enforcementProof) | merge hooks.json; skill-collision-safe; trust-print; caller-cwd; closure; post-install tmux discriminating-pair | `test-install-codex-enforcement.mjs`; `manual: enforcementProof` | per-project only; don't touch L937 |
| `P6-S5` | CI + runbook finalize + docs DONE | `plugin-validate.yml`, `runbooks/*.md`, RFC/index | CI gauntlet + suites + fixture/hooks.json smoke; 10-section runbook; P6→DONE | `manual: CI`; gauntlet `7 pass, 2 deferred` | — |

### 10.1 Dependency graph

```text
S0 ──┐
S1 ──┴─> S2 ── S3 ──┐
            └── S4 ──┴─> S5
```

S2 needs S1's normalized fixture (step 8). S3 drives the S2 adapter. S4 deploys S2 + re-runs it.
S5 needs S3 + S4 in CI. S0/S1 interleave.

## §11 Cut Order

1. S5 runbook quickref polish (keep gauntlet step + fixture smoke).
2. `cp`/`mv`/`install` dest extraction — if token-pressed, ship redirect+`sed -i`+`tee`+`dd of=`
   extraction first and defer copy-family dest to a fast follow (the residual widens by exactly those
   three commands, documented in §16 R8). Do **not** cut the redirect/`sed -i` extraction or the
   extract-only no-label-branch rule (those are the gating-correctness core).
3. S1 harness packaging — keep the tmux run + capture + fixture, cut helper factoring.

Do **not** cut: REQ-8 (apply_patch safety), REQ-9 (Bash gating), REQ-5/10 (import + fail-closed),
REQ-7 (root from cwd), REQ-14/15 (the only #17532 + discriminating enforcement proof), REQ-1.

## §12 Contracts

### `decideForCodexStdin(stdin) → {block, reason, label, paths}` (in codex-adapter.mjs)

**Input contract:** parsed Codex stdin object; requires `hook_event_name` (string). For `PreToolUse`:
`tool_name`, `tool_input`, `cwd`. Rejects non-object / missing `hook_event_name` → block (deny).
**Output:** `block:boolean`, `reason:string`, `label:string|null`, `paths:string[]`. Process maps
`block→exit 2 + deny`, `!block→exit 0`.

**`extractTargetPaths(tool_name, tool_input) → {paths:string[], unknown:boolean}`:**

| tool_name | Extraction | unknown flag |
|---|---|---|
| `Write`/`Edit` | `[filePath ?? file_path]` (filter empty) | false |
| `apply_patch` | every path under `*** Add File:`/`*** Update File:`/`*** Delete File:`/`*** Move to:` | **true** if the patch text contains a `*** ` directive line none of the four patterns match, or yields zero paths |
| `Bash` | **ALL write targets** via the §A.5 quote-aware **tokenizer** (global scan): redirects `>`/`>>`/`&>`/`>&`-to-file (operand may contain spaces inside quotes — `> "src/a b.txt"`), `sed -i[suffix]`, `tee [-a]`, `dd … of=`, **and the `cp`/`mv`/`install` destination** = the `-t`/`--target-directory[=]` value if present (GNU dest-first) **else** the last non-flag operand. A **sink/fd-dup** (`/dev/null`, bare digit `2>&1`/`>&2`) is **dropped** (`SINK_OR_FDDUP`) | **always false** — a **dynamic** operand (`$(…)`, backtick, `$VAR`, unmatched quote, awk-internal) is **not extracted** → ALLOW as the §16 R8 residual (r6: Bash never fail-closes). Quoted static paths and `-t` dests ARE extracted, not residual. |
| other | `[]` | false |

**Bash boundary change (reviewer/planner Bash-class, round 2→r4; r6 makes it extract-only):** the
inherited subset `classifyLabel` (`enforce-bridge.mjs:57`) anchors on the first word and labels
`sed -i src/x`, `echo > src/x`, `awk … > src/x` as `read_only` — a live repo-source-write bypass. The
fix is to **extract the write target and route it through the same per-path repo-source check** (not
to relabel the whole command): `sed -i src/x` → `[src/x]` → repo-source → GATE; `echo > /tmp/y` →
`[/tmp/y]` → non-repo → ALLOW (no over-gate). The scan is **global** (collect all targets, so
`> /tmp/a > src/evil` gates on `src/evil` — N-r4-2), and a **sink/fd-dup** operand (`/dev/null`, bare
digit) is **dropped**, not treated as unknown (so `echo > /dev/null` and `2>&1` ALLOW — N-r4-1).
Extraction **also covers the `cp`/`mv`/`install` destination operand** (the last non-flag token), so
`cp a src/x` → `[src/x]` → GATE while `cp a /tmp/y` → `[/tmp/y]` → ALLOW.

**r6 extract-only (driven by the hard-block pivot — KB `codex-hooks.md`):** because the block is now a
**real hard deny** (not a warn), there is **no label-branch fallback** and **no fail-closed on
an unresolvable Bash operand** — both would brick legitimate tooling. An empty extracted-target set
(`git commit`, `mkdir`, `npm test`, a read-only command, or an unlexable write) **ALLOWS**. **Residual
(accept + document — needs a real shell lexer, not more regex; the extractor is FROZEN to the §12.1
MUST-CATCH table with a no-lexer-growth stop-rule):** a write through a mechanism
the §A.5 tokenizer cannot lex (`eval "…"`, command substitution, here-docs, variable-expanded paths,
awk-internal `{print > "f"}`) escapes the gate — a known coverage residual scoped to the Bash
write sub-channel, documented in the runbook (REQ-16) + §16 R8. apply_patch/Edit/Write and all
§12.1-listed Bash writes are **mechanically STRONG** (hard-block, no reproduced bypass — KB probe),
but because this Bash residual is a real known bypass, the **declared capability tier is MEDIUM**
with a `bypass_known` MEDIUM ceiling (REQ-4) — NOT clean-audit. (opencode declared clean-audit on the
same adapter gap; that is a precedent to FIX via backport, not copy.) opencode inherits the same
Bash-extraction gaps → backport follow-up.

**State table (exhaustive):**

Evaluated **in order**; the fail-closed states (B, C) deny **unconditionally**, before any disposition
logic. **C is apply_patch-only** — a Bash write with an unresolvable operand is NOT fail-closed; it
extracts no path and falls through to D (ALLOW) as the §16 R8 residual.

| State | Condition | Output |
|---|---|---|
| A. non-PreToolUse | `hook_event_name ≠ PreToolUse` | `block:false` (exit 0) |
| B. bad input | non-object / missing hook_event_name / relative-or-empty cwd | `block:true` (fail-closed, unconditional) |
| C. apply_patch unparseable | `tool==="apply_patch"` ∧ (empty patch **or** a `*** ` directive matching none of the four patterns) | `block:true` (fail-closed, unconditional) |
| D. no repo-source target | extracted paths contain **no** repo-source path — empty set (`git commit`, `mkdir`, read-only cmd, unlexable-Bash residual) **or** all targets non-repo | `block:false` (exit 0) |
| E. repo-source target, disp enforce | any extracted path L1 GATED ∧ token∈{enforce,block} | `block:true` |
| F. repo-source target, disp observe | any extracted path L1 GATED ∧ token∉{enforce,block} | `block:false` (warn/observe) |

No label-branch state: extract-only means an **empty target set always ALLOWS** (D). A
read-only-*named* Bash command that nonetheless carries an extracted write target (`sed -i src/x`) is
gated via that target (E), not short-circuited. **Gating is `isRepoSource(root,p).isRepoSource` per
normalized path — NEVER `toolTargetsRepoSource(...,"Bash",...,label)`**: that function's Bash-label
branch (`repo-source.mjs:150-154`) returns ALLOW for `read_only`/`nonsrc_write` **before** it checks
the path, and `classifyLabel` labels `sed -i`/`echo>` as `read_only`, so routing through it would
re-open the exact bypass (codex r7 F1). `classifyLabel` is still computed (for the deny reason /
disposition telemetry) but is **never** a gating input.

**Tier/cap split (codex r7 F6 — REQUIRED, else the gate never blocks):** the manifest declares the
capability tier `MEDIUM` (honesty — the unlexable Bash residual), but `events.json` maps
`pre_tool_use@MEDIUM`→`warn` and `gateDisposition` turns `warn`→`clamp-off` (no block). So the adapter
MUST call `gateDisposition` with a **runtime mechanism `harnessCap:"STRONG"`** for covered extracted
repo-source writes (those ARE hard-blockable), NOT the declared `MEDIUM`. This keeps the covered-write
default a real block while every operator control still works (separate `gateDisposition` inputs):
`duplicate`→block, `active:false`→silence(allow), explicit `configTier:MEDIUM`→`clampTier`→warn/allow.
The declared MEDIUM and the runtime STRONG cap are not in tension: MEDIUM is the capability's
worst-case honesty (it has an unlexable escape), STRONG is the mechanism tier for the specific writes
the extractor DOES cover.

**Error codes:** exit 0 = allow (states A, D, F); exit 2 + `permissionDecision:deny` = block (state E)
**or** any fail-closed path (B/C / dynamic-import throw / internal throw). **No exit 3** — a single
process has no engine/validation split; every non-allow is exit-2 deny.

### §12.1 Bash extractor — frozen MUST-CATCH table (the tier basis)

The §A.5 Bash tokenizer is **FROZEN** to exactly the write forms below. Every relative target is
resolved under the stdin `cwd` before the waist (codex F1). The forms NOT in this table are the
documented Bash-write residual — this is precisely why the declared `pre_tool_use` tier is **MEDIUM**
(mechanism STRONG, capability MEDIUM; §16 R8, REQ-4). **STOP-RULE: a newly-discovered shell write form
outside this table is documented as a new residual entry, NEVER added to the lexer — no growth toward
a full shell parser (handoff_complete_bug_class: patch the class boundary, not each spelling).**

**MUST-CATCH (GATE when the resolved target is repo-source; mechanically STRONG):**

| Form | Examples | Operand rule |
|---|---|---|
| redirect to file | `> f`, `>> f`, `&> f`, `>& f`, fd-prefixed `2> f`, attached `>f`, quoted incl. spaces `> "a b.txt"`, multiple per command | remainder-of-token or next token; `/dev/null` + bare-digit fd-dup dropped (SINK) |
| `sed -i[suffix]` (GNU `-i`/`-i.bak`, BSD `-i ''`) | `sed -i 's/a/b/' src/x`, `sed -i -e 's/a/b/' src/x`, `sed -i '' 's/a/b/' src/x` | requires `-i`/`--in-place` (without it sed writes to stdout, not the file); sed grammar is `sed [opts] SCRIPT FILE…` so the FIRST non-flag operand is the SCRIPT unless `-e`/`-f` supplied it (then ALL operands are files); a bare `-i` consumes an EMPTY next token as the BSD suffix. (codex r7 S2-review: the old "next non-flag operand" rule mis-took the script for the file = false-deny on carveouts, and the BSD empty suffix for the file = false-ALLOW bypass.) |
| `tee [-a]` | `tee src/x` | each following non-flag operand |
| `dd … of=X` | `dd of=src/x` | the `of=` value |
| `cp`/`mv`/`install` dest | `cp a src/x`, `cp -t src a b`, `mv a src/x`, `install a src/x` | dest = `-t`/`--target-directory[=]` value if present (GNU dest-first), else last non-flag operand; sources are READS |

**RESIDUAL (NOT extracted → ALLOW; the MEDIUM-ceiling cap):** dynamic operands (`$(…)`, backtick,
`$VAR`, unmatched quote, glob); indirect shells (`eval`, `sh -c`, `bash -c`, aliases/functions);
interpreter-internal writes (`awk '{print > "f"}'`, `python -c`, `node -e`, here-docs); broad tools
(`tar`, `rsync`, `git apply`, `make`, `find -exec`). These ALLOW (r6: Bash never fail-closes — a deny
would brick legitimate tooling). `apply_patch` unparseable STILL denies (structured path, State C).

## §13 Edge Cases

| # | Scenario | Expected | Test |
|---|---|---|---|
| EC1 | empty/garbage/non-object stdin (`""`,`42`,`null`,`[]`) | deny exit 2 | `testFailClosed` (4 rows) |
| EC2 | symlinked/relative/`/private/var` cwd; divergent process cwd | isAbsolute guard; realpath; gate uses stdin cwd | `testCwdRelative`, `testCwdSymlink`, `testCwdDivergence` |
| EC3 | concurrent invocations | each own process/stdin | inherent |
| EC4 | apply_patch `docs/plans/x.md`+`src/y.mjs` | GATE | `testApplyPatchMultiFileBlocks` |
| EC5 | apply_patch only docs/plans / only markers | ALLOW | `testApplyPatchDocsOnlyAllows`, `testApplyPatchMarkerBundleAllows` |
| EC6 | apply_patch unparseable / unknown directive | DENY | `testApplyPatchUnparseableDenies` |
| EC7 | Bash `sed -i src/x` / `echo>src/x` / `&>src/z` / multi-redirect / `cp a src/x` (block) vs `cat` / `echo>/tmp` / `echo>/dev/null` / `2>&1` / `cp a /tmp/y` (allow) | block repo-source writes; allow reads + sinks/fd-dups + non-repo targets; no over-gate | `testBashRepoSourceWriteBlocks`, `testBashRedirectWriteBlocks`, `testBashAmpRedirectToFileBlocks`, `testBashMultiRedirectBlocks`, `testBashCpDestBlocks`, `testBashDevNullAllows`, `testBashStderrDupAllows`, `testBashRedirectToTmpAllows`, `testBashCpToTmpAllows`, `testBashReadOnlyAllows` |
| EC12 | Bash no-write / unlexable (`git commit`, `mkdir -p x`, `npm test`, `eval "echo > $D"`) under the hard block | ALLOW — extract-only, empty repo-source target set never blocks (no tooling brick); unlexable repo-write is the §16 R8 residual (the tier-MEDIUM cap) | `testBashGitCommitAllows`, `testBashUnlexableResidualAllows` |
| EC13 | relative extracted target + divergent adapter cwd (codex F1); quoted target `>>"src/x"` / `>"docs/plans/x.md"` (codex F2) | normalize each target: quote-strip then `path.resolve(root,t)` BEFORE the waist; quoted repo-source → DENY, quoted carve → ALLOW; relative target gates under stdin root not process.cwd() | `testBashTargetResolvedUnderStdinCwd`, `testBashQuotedRedirectBlocks`, `testBashQuotedDocsAllows` |
| EC8 | `.git/` write (incl. apply_patch) | ALLOW (carved) | `testGitWriteAllowed` |
| EC9 | missing co-located waist | deny exit 2 (not exit 1) | `testImportFailClosed` |
| EC10 | fixture provenance | real stdin + synthesized turn_index, not invented decision values | REQ-11; step 8 |
| EC11 | raw codex stdin (turn_id, no turn_index) | adapter synthesizes turn_index; correct decision | `testAdapterHandlesRawStdin` |

## §14 Test Case Catalog

```text
Group 1: adapter conformance (test-codex-adapter-conformance.mjs) (37 tests) — spawnSync(node,[ADAPTER],{input});
         PreToolUse cases LOAD tests/fixtures/harness-events/codex/pre-tool-use.json
  testAdapterBlocksRepoSourceWrite   — Write src/x.mjs → exit 2 + permissionDecision:deny
  testApplyPatchMultiFileBlocks      — apply_patch [docs/plans/x.md, src/y.mjs] → exit 2 deny
  testApplyPatchDocsOnlyAllows       — apply_patch [docs/plans/x.md] → exit 0
  testApplyPatchMarkerBundleAllows   — apply_patch [.checkpoints/.x, docs/plans/y.md] → exit 0 (NEG)
  testApplyPatchUnparseableDenies    — apply_patch with an unrecognized directive → exit 2 deny (NEG)
  testBashRepoSourceWriteBlocks      — Bash "sed -i src/x.mjs" → exit 2 deny (target extraction, NOT relabel)
  testBashRedirectWriteBlocks        — Bash "echo hi > src/x.mjs" → exit 2 deny
  testBashAmpRedirectToFileBlocks    — Bash "grep x y &> src/z.mjs" → exit 2 deny (&>FILE is a write, not fd-dup)
  testBashMultiRedirectBlocks        — Bash "echo a > /tmp/a > src/evil.mjs" → exit 2 deny (global scan; src/evil caught)
  testBashCpDestBlocks               — Bash "cp a src/x.mjs" → exit 2 deny (cp DEST extraction, NOT label branch)
  testBashDevNullAllows              — Bash "echo hi > /dev/null" → exit 0 (NEG — sink not unknown)
  testBashStderrDupAllows            — Bash "grep x src 2>&1" → exit 0 (NEG — fd-dup not unknown)
  testBashRedirectToTmpAllows        — Bash "echo hi > /tmp/y" → exit 0 (NEG — no over-gate)
  testBashCpToTmpAllows              — Bash "cp a /tmp/y" → exit 0 (NEG — non-repo dest, no over-block)
  testBashReadOnlyAllows             — Bash "cat src/x.mjs" → exit 0 (NEG)
  testBashGitCommitAllows            — Bash "git commit -m x" → exit 0 (NEG — no write target; extract-only never bricks tooling)
  testBashUnlexableResidualAllows    — Bash "eval \"echo hi > $D\"" → exit 0 (NEG — documented §16 R8 residual; allow, not fail-closed)
  testBashQuotedRedirectBlocks       — Bash "printf hi >>\"src/x.mjs\"" → exit 2 deny (codex F2 — quote-strip then extract; quoted path is a lexable write, NOT residual)
  testBashQuotedDocsAllows           — Bash "echo hi >\"docs/plans/x.md\"" → exit 0 (NEG — quote-strip then carve-allow; no false-deny)
  testBashTargetResolvedUnderStdinCwd — process cwd ≠ stdin cwd; Bash "echo hi > src/x.mjs" (RELATIVE target) → exit 2 deny (codex F1 — target resolved under stdin root, not process.cwd())
  testBashQuotedPathWithSpaceBlocks  — Bash "printf hi > \"src/a b.txt\"" → exit 2 deny (codex round-6 — tokenizer keeps the quoted space-bearing path; regex would truncate at the space)
  testBashQuotedDocsWithSpaceAllows  — Bash "echo hi > \"docs/plans/a b.md\"" → exit 0 (NEG — quoted-space carve, no false-deny)
  testBashCpTargetDirBlocks          — Bash "cp -t src a b" → exit 2 deny (codex round-6 — GNU -t DEST is FIRST; src is the write target, a/b are reads)
  testBashCpTargetDirAllows          — Bash "cp -t /tmp a src/x" → exit 0 (NEG — dest /tmp non-repo; a + src/x are READ sources, not targets; no false-deny)
  testAdapterAllowsRead              — read tool → exit 0
  testAdapterHandlesRawStdin         — raw codex stdin (turn_id, NO turn_index) on a src write → exit 2 deny (adapter synthesizes turn_index internally)
  testCwdDivergence                  — process cwd ≠ stdin cwd → uses stdin cwd (sentinel in reason)
  testCwdRelative                    — relative cwd → exit 2 deny (NEG)
  testCwdSymlink                     — symlinked cwd realpath'd → gate still fires
  testFailClosed                     — "", "42", "null", "[]" → exit 2 deny (4 NEG rows)
  testImportFailClosed               — co-located waist removed → exit 2 deny (NOT exit 1) (NEG)
  testMarkerWriteAllowed / testEpisodeWriteAllowed / testGitWriteAllowed — exit 0 (carve-outs)
  testAdapterMatchesManifestBindings — adapter normalized payload == manifest pre_tool_use bindings on the fixture
  testBlocksUnderDeclaredMedium      — covered Bash repo-source write (`sed -i src/x`), manifest declares MEDIUM → STILL exit 2 deny (codex r7 F6 — runtime STRONG mechanism cap, NOT manifest MEDIUM; guards against a future "simplify to manifest tier" regression that would make events.json map MEDIUM→warn→no block)
  testConfigClampMediumWarns         — same covered write but operator enforce-config configTier=MEDIUM → exit 0 (clampTier lowers STRONG→MEDIUM→warn; proves the operator downgrade still works under the STRONG runtime cap)

Group 2: install/uninstall (test-install-codex-enforcement.mjs) (6 tests) — isolated HOME mock
  testInstallMergesHooksJson / testInstallDeploysClosure / testInstallCallerCwdSafe /
  testInstallNoSkillCollision / testInstallPrintsTrust / testUninstallRemovesOnlyOurEntry

Group 3: gauntlet (test-plugin.mjs --harness codex) → 7 pass, 2 deferred-P3, 0 fail (step 9 = codex-native)

Group 4: tmux interactive E2E (codex-tmux-e2e.mjs) (3 checks) — UNGUARDED-IN-CI
  firingProof — real TUI; PreToolUse fired (allow stub) — #17532 (S1)
  enforcementProof — deployed adapter; repo-source apply_patch DENIED AND docs/plans apply_patch ALLOWED + positive control (S4)
  trustGate — hook skipped before trust, fires after
```

Total: 37 conformance + 6 install + 9-step gauntlet (`7 pass, 2 deferred-P3, 0 fail`) + 3 tmux.
Runners: `node tests/test-codex-adapter-conformance.mjs`, `node tests/test-install-codex-enforcement.mjs`,
`node scripts/test-plugin.mjs --project . --harness codex`.

> **No aspirational output**; assertions on real captured exit/stdout; `testCwdDivergence` asserts a
> unique sentinel path in the deny reason. **Install/hook E2E is a mock-project test** (real
> `install.mjs` / real `codex` via tmux), never mental-trace.

## §15 Verification Ledger

| Claim | Command | Observed (fill at build) |
|---|---|---|
| Adapter conformance | `node tests/test-codex-adapter-conformance.mjs` | `37/37 pass`; block rows = exit 2 + deny |
| Bash target extraction (neg controls) | conformance `testBash*` rows | `sed -i`/`echo>src`/`&>src`/multi-redirect/`cp a src` deny; `/dev/null`+`2>&1`+`/tmp`+`cp a /tmp`+`cat`+`git commit`+unlexable-`eval` allow (extract-only — `cp` src deny via DEST extraction, not label) |
| Fail-closed + import-fail-closed (neg) | conformance `testFailClosed`/`testImportFailClosed` | exit 2 deny (incl. missing waist → 2, not 1) |
| apply_patch + Bash safety | conformance `testApplyPatch*` + `testBash*` | multi/unparseable/bash-write block; docs/marker/read allow |
| Install merges (mock E2E) | `node tests/test-install-codex-enforcement.mjs` | `45 passed, 0 failed` (9 scenarios); user hook intact; skill untouched; trust printed; user files survive uninstall; spaced-project command shell-quoted + runs under a shell |
| Gauntlet | `node scripts/test-plugin.mjs --project . --harness codex` | **S3 observed:** `7 pass, 2 deferred-P3, 0 fail — status:ok`; step 9 `codex-native deny exit 2 + permissionDecision:deny; allow exit 0; no marker leak (N1)` |
| #17532 firing (real codex/tmux) | `manual: node tests/integration/codex-tmux-e2e.mjs --firing` | `PreToolUse fired` |
| Enforcement (real codex/tmux) | `manual: … --enforcement` | `repo-source apply_patch DENIED; docs/plans ALLOWED; PreToolUse fired` + pane |
| Regression | `--harness opencode` and (sep.) `--harness claude-code` | **S3 observed:** each `7 pass, 2 deferred-P3, 0 fail — status:ok`; step 9 non-vacuous (opencode `cwd-divergence`, claude-code `divergent-process-cwd untouched`) |
| S3 code review (BP-1 step 6) | interactive codex via cmux (gpt-5.5 high, codex 0.142.3) | **R1 HOLD** (1 P1: buildLiveProject omitted active codex plugin -> `test-plugin-registry.mjs` red) -> fixed inline (copy codex manifest+runbooks, mirror opencode) -> **R2 ACCEPT** (`test-plugin-registry.mjs` 199 pass/0 fail/1 env-skip). Reply-episode `20260628-130139-…-6728` (local) |
| RFC corrected (block/Python) | `grep -rn "Codex.*Python\|{block:true}" docs/rfcs/` | 0 |
| RFC tier retained MEDIUM, rationale corrected | `grep -c "declared MEDIUM, not STRONG" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` | 0 (old framing gone; tier cell stays MEDIUM; do NOT grep bare "multi-edit" — new annotations reuse it) |
| Merged | `gh pr view <n> --json state,mergeCommit` | `<commit>` |

**Order rule** + **strong-not-proxy:** step 9 drives the REAL adapter; "E2E" = the real `codex`
binary via tmux; green = `status:ok` (fail==0), not a pass-count.

## §16 Risk Analysis

| Risk | Sev | Lik | Mitigation |
|---|---|---|---|
| R1: #17532 — hooks don't fire interactively | High | Med | S1 tmux firing-proof before shipping; STOP if PreToolUse doesn't fire; `codex exec` would not catch it |
| R6: stop/session_start enforcement deferred (scope, not strength) | Med | — | `pre_tool_use` is a real hard block (mechanism STRONG — KB probe; declared MEDIUM only because of the Bash-lexing residual), so write-time enforcement is **not** weak; the deferral is stop/session_start only, gated on the event-schema/binding gap (§5), matching opencode's delivered scope; tracked follow-up issue (S0); flagged to maintainer |
| R7: turn_index synthesis / fixture provenance | Med | Low | adapter synthesizes integer `turn_index`; step-8 fixture = real stdin + synthesized field (REQ-11); `testAdapterHandlesRawStdin` proves the live raw path |
| **R8: Bash write-via-unlexable-shell residual** | Med | Med | `eval`/command-subst/here-doc/var-expanded-path/awk-internal (`{print > "f"}`) writes escape `WRITE_BASH_RE` — under r6 these **ALLOW** (extract-only: a dynamic operand is not extracted, so it is not gated; a deny would brick legitimate non-repo commands now that the block is real). A known coverage residual **scoped to the Bash write sub-channel**, narrowed by the §A.5 **tokenizer** to only genuinely-dynamic operands (`$(…)`, backtick, `$VAR`, unmatched quote); documented in the runbook + the MEDIUM-ceiling citation (REQ-4). This residual is exactly why the **declared capability tier is MEDIUM** (mechanism is STRONG: apply_patch/Edit/Write + all §12.1 MUST-CATCH Bash writes — `sed -i`, `>`/`>>`/`&>`/`>&`-to-file incl. **quoted paths with spaces**, `tee`, `dd of=`, multi-redirect, `cp`/`mv`/`install` dest incl. **GNU `-t`/`--target-directory`** — hard-block with no reproduced bypass; sinks (`/dev/null`, fd-dups) and non-repo targets correctly ALLOW). **STOP-RULE: the §A.5 extractor is FROZEN to the §12.1 MUST-CATCH table — a newly-discovered shell write form outside that table is documented as a new residual entry, NEVER added to the lexer (no growth toward a full shell parser).** opencode shares the same Bash-extraction gap (it declared clean-audit) → backport follow-up to fix, not copy. |
| R2: step-9 branch destabilizes other harnesses | High | Low | additive; A.8 reruns opencode + claude-code; S3 focused-review |
| R3: trust model inactive-until-trusted | Med | High | runbook + install print; tmux trustGate + `testInstallPrintsTrust` |
| R4: CI lacks codex binary | Med | High | tag UNGUARDED-IN-CI; REQ-17 fixture/hooks.json smoke; gauntlet is the CI guard |
| R5: apply_patch tool_input shape | Med | Med | shape captured from the real S1 fixture; parser covers all 4 directives; unknown → deny |

## §17 Open Decisions

- **OD-1 (RESOLVED → MEDIUM, mechanism STRONG):** the empirical probe (real `codex 0.142.3`, KB
  `codex-hooks.md`) refuted the multi-edit-bypass rationale — the deny hook hard-blocked `apply_patch`
  + all 6 shell forms, no bypass reproduced, so the **mechanism is STRONG**. But the delivered
  capability includes Bash, whose unlexable-write residual (§16 R8) is a real known bypass, so the
  **declared tier is MEDIUM** with a `bypass_known` MEDIUM ceiling (REQ-4) — not clean-audit. The
  extractor is frozen to the §12.1 MUST-CATCH table (no-lexer-growth stop-rule). S1's interactive
  firing-proof re-confirms the hard block on the installed binary.
- **OD-2 (resolved):** single thin-waist-importing adapter (B1); dynamic import inside try.
- **OD-3 (resolved):** new `codex-native` gauntlet branch (S3), not `json-object` reuse.
- **OD-4: stop/session_start (STRONG block-on-stop + baseline).** Deferred. 5-field DEFER: (1)
  scenario — session ends with checkpoints incomplete and Codex stop does not block; (2) spec —
  RFC:915/:946 list STRONG, but the canonical event schemas require `is_subagent:boolean` /
  `harness` / integer `turn_index` that raw codex stdin lacks and the binding grammar can't
  synthesize, so the slice is blocked on schema/binding work, not just the bp-001 lifecycle; (3)
  history — opencode shipped MEDIUM (a harness limit there; a deferral here); (4) same-class —
  session_start same disposition; (5) residual — no stop-time enforcement on Codex until the port;
  `pre_tool_use` still gates writes. **Tracked: follow-up issue filed at S0**; the issue must scope
  the binding-grammar/event-schema change too. Surfaced to the maintainer as a scope choice.

## §18 Done Criteria

- [ ] All MUST (REQ-1..17) tests green.
- [ ] `test-plugin.mjs --harness codex` → `7 pass, 2 deferred-P3, 0 fail — OK`.
- [ ] REQ-14 firing + REQ-15 enforcement run against real `codex 0.141.0`; pane captures in §15.
- [ ] Install E2E green; isolated HOME proves per-project-only; user hooks intact.
- [ ] RFC + indexes corrected (Rule 10); stop-STRONG follow-up issue filed; P6 → DONE.
- [ ] PR-level whole-branch review before opening the PR (`…697c`).
- [ ] Every deferred finding has an issue/comment/violation (Rule 18 step 9).

## §19 Review Consensus (Rule 18)

| Pass | Reviewer | Provider | Blockers | Verdict | Reply episode |
|---|---|---|---|---|---|
| 1 | negative-scenario-planner | claude | 1 BLOCKER | HOLD | `…020b` |
| 1 | negative-scenario-reviewer | claude | 1 BLOCKER + 6 MAJOR | HOLD | `…db34` |
| 2 | negative-scenario-planner | claude | 1 BLOCKER + 2 MAJOR | HOLD | `…9eb7` |
| 2 | negative-scenario-reviewer | claude | 1 BLOCKER + 2 MAJOR | HOLD | `…dea1` |
| 3 | negative-scenario-reviewer | claude | 0 BLOCKER (2 NIT) | **ACCEPT** | `…fa57` |
| 3 | negative-scenario-planner | claude | 1 BLOCKER + 1 MAJOR | HOLD | `…ed65` |
| 4 | negative-scenario-reviewer | claude | 0 BLOCKER (1 fold-inline MINOR) | **ACCEPT** | `…c2a7` |
| 4 | negative-scenario-planner | claude | 1 BLOCKER (over-block, NOT bash-bypass) + 1 MAJOR | HOLD | `…f560` |
| 5 | codex (r6 STRONG version; user-directed provider) | codex | 2 BLOCKER + 2 MAJOR | HOLD | `…d033` |
| 6 | codex (r6.1 — F1-F4 re-review + fresh pass) | codex | 2 BLOCKER + 1 MAJOR | HOLD | `…8bad` |
| 7 | codex (r7 — MEDIUM-honest revert consistency review, interactive tmux) | codex | 1 BLOCKER (#6 tier/cap) + 1 BLOCKER-class (#1 label short-circuit) + 4 consistency | **ACCEPT** (after the 6 fixes; diff re-checked) | tmux session 2026-06-28 |
| S4/S5-1 | codex (S4/S5 step-table + listings review, interactive cmux) | codex | 5 findings, all ACCEPTED (uninstall ownership; S4-L3 harness-API + discriminating logic; active:false false-green; raw projectDir; weak apply_patch assert) | HOLD | `…a656` |
| S4/S5-2 | codex (re-review of applied fixes + r2 refinements, interactive cmux) | codex | 0 blocker (F1-F5 confirmed resolved) | **ACCEPT** | `…534a` |

### 19.5 S4/S5 table review (interactive cmux, HOLD → ACCEPT)

Round 1 HOLD, 5 findings (all valid, verified against real code; codex ran 2 shell probes building the deploy layout in tmp dirs). An interactive pressure-test exchange confirmed F3/F4, caught a real pane-capture-order bug in the F2 rewrite, and pushed F1 to file-level removal + a user-file-survival test. All fixes + r2 refinements applied to the S4/S5 listings (S4-L2 grew 6 → 8 scenarios). Round 2 re-review of the APPLIED listings → codex **ACCEPT**, all five resolved with file:line. Reply episodes `…a656` (r1) / `…534a` (r2 consensus).

### 19.4 Round-7 codex disposition (MEDIUM-honest revert — interactive tmux, ACCEPT)

All six ACCEPT; applied and diff-re-checked → codex **ACCEPT**, no blocker/major remaining.

| # | Finding (R) | Verdict | Resolution |
|---|---|---|---|
| F1 | **BLOCKER-class** (R1/R6): gating via `toolTargetsRepoSource(...,"Bash",...,label)` — the Bash-label branch (`repo-source.mjs:150-154`) ALLOWs `read_only`/`nonsrc_write` before the path check, and `sed -i`/`echo>` are `read_only`, re-opening the bypass | **ACCEPT** | gate via `isRepoSource(root,p).isRepoSource` per normalized path (REQ-5, §8.2, §8.1, mermaid, §A.5 import, A.7 2.1); `classifyLabel` for deny-reason only |
| F6 | **BLOCKER** (R6): declared MEDIUM cap fed to `gateDisposition` → `events.json` MEDIUM→warn→clamp-off → runtime does NOT block (defeats block-not-warn) | **ACCEPT** | tier/cap split: manifest/registry/bypass MEDIUM (honesty), runtime `harnessCap:"STRONG"` for covered writes (§8.2 split, REQ-5, A.7 2.1); regression `testBlocksUnderDeclaredMedium` + `testConfigClampMediumWarns` |
| F2 | **MAJOR** (R6): REQ-4/A.7 cited `echo>src/x`/`sed -i src/x` as the MEDIUM-justifying escapes, but §12.1 makes them MUST-CATCH | **ACCEPT** | cite the unlexable forms (`eval`/`sh -c`/command-subst/`$VAR`/here-doc/awk-internal); note §12.1 forms hard-block |
| F3 | **MAJOR** (R10): `codex-hooks.md` still concluded "Declare STRONG" (cited as ground truth) | **ACCEPT** | KB conclusions rewritten (mechanism STRONG / capability MEDIUM) + superseded note; tracked via S0 step 0.2b |
| F4 | **MAJOR**: `grep -c "multi-edit" → 0` self-fails against the new annotations | **ACCEPT** | REQ-1/§15/0.4 retarget to `"declared MEDIUM, not STRONG" → 0`; KB superseded note reworded so 0.2b's grep holds |
| F5 | **MINOR**: §12.1 residual (`glob`) absent from §A.5 DYNAMIC; attached-redirect quote-strip underspecified | **ACCEPT** | §A.5 DYNAMIC adds `glob` (`*`/`?`/`[`); operand quote-stripped after the operator (`>>"src/x"`→`src/x`) |

### 19.2 Round-5 codex disposition (r6 → r6.1)

| # | Finding (R) | Verdict | Resolution |
|---|---|---|---|
| F1 | **BLOCKER** (R1/R6): extracted relative target resolved via `process.cwd()` (`repo-source.mjs:66`), not stdin root → ALLOW under divergent cwd; codex reproduced (relative ALLOW vs absolute GATED) | **ACCEPT** | §8.2 normalization invariant + §A.5/§A.7 2.1 + §7 row: quote-strip then `path.resolve(root,t)` for EVERY extracted target before the waist; `testBashTargetResolvedUnderStdinCwd` |
| F2 | **BLOCKER** (R1/R6): simple quoted operand (`>>"src/x"`) wrongly classed as the unlexable residual → escape; raw quotes could false-deny carve-outs | **ACCEPT** | quote-strip surrounding matched quotes, THEN extract; only post-strip-dynamic operands are the residual; `testBashQuotedRedirectBlocks` (deny) + `testBashQuotedDocsAllows` (allow) |
| F3 | **MAJOR** (R6/R10): install cwd matrix not enumerated (only `testInstallCallerCwdSafe`) | **ACCEPT WITH MODIFICATION** | REQ-13 + §7 now name the 6-row cwd-divergence matrix with on-disk assertions (artifacts under `project_root`, absent under caller cwd/`$HOME`); full S4 step table fills at build |
| F4 | **MAJOR** (R6): stale r3/r4 text contradicts r6 (no-tier-cell-edits at §8.3/§A.9; unknown-deny + cp over-block at §19.1; 25-vs-28 count) | **ACCEPT** | §8.3 + §A.9 reworded (flip pre_tool_use, leave stop/session_start); §19.1 row 4 marked SUPERSEDED; counts reconciled to 31 throughout (the 25 was already gone) |

### 19.3 Round-6 codex disposition (r6.1 → r6.2)

Round 6 confirmed F1+F3 CLOSED; F2 partially closed; 2 new findings. The recurring shell-lexing class
(quoting/spaces, then GNU `-t`) triggered a **boundary change**: §A.5 Bash extraction moves from regex
to a quote-aware **tokenizer** (handoff_complete_bug_class — patch the class, not the spelling).

| # | Finding (R) | Verdict | Resolution |
|---|---|---|---|
| R6-1 | **BLOCKER** (R1/R6): `> "src/a b.txt"` — regex operand stops at whitespace → quoted path with spaces escapes (codex reproduced on-disk) | **ACCEPT** | §A.5 tokenizer keeps `"src/a b.txt"` as one de-quoted token; §12 Bash row; `testBashQuotedPathWithSpaceBlocks` (deny) + `testBashQuotedDocsWithSpaceAllows` (carve allow) |
| R6-2 | **BLOCKER** (R1/R6): "last non-flag operand" is wrong for GNU `cp -t DEST a b` (dest-first) — missed-gate one way, false-deny the other (codex reproduced parser-level) | **ACCEPT** | §A.5 `TARGET_DIR_FLAG`: parse `-t`/`-tDEST`/`--target-directory[=]DEST` as dest if present, else last operand; sources are reads; `testBashCpTargetDirBlocks` (`cp -t src a b`→deny) + `testBashCpTargetDirAllows` (`cp -t /tmp a src/x`→allow) |
| R6-3 | **MAJOR** (R6): A.8 DoD still said `25/25 pass` (F4 count fix missed this spelling) | **ACCEPT** | A.8 → `35/35 pass`; full count sweep reconciled to 35 (Group 1) |

### 19.1 Resolved blockers (round 4 → r5)

| # | Blocker (R) | Verdict | Resolution |
|---|---|---|---|
| 1 | `echo > /dev/null` over-blocks: unknown-detection conflated a recognized **sink** with an unresolvable target → State C deny (planner N-r4-1) | ACCEPT | `SINK_OR_FDDUP` operands (`/dev/null`, bare-digit fd-dup) are **dropped**, not flagged unknown; `testBashDevNullAllows` + `testBashStderrDupAllows` |
| 2 | non-global redirect regex misses 2nd target `> /tmp/a > src/evil` (planner N-r4-2) | ACCEPT | `WRITE_BASH_RE` is `/g`, collect ALL targets, gate if any; `testBashMultiRedirectBlocks` |
| 3 | `&>FILE`/`>&FILE` wrongly skipped as fd-dup (reviewer N-r4) | ACCEPT | skip only `>&<digit>`; `&>`/`>&`-to-file extracted; `testBashAmpRedirectToFileBlocks` |
| 4 | awk-internal redirect garbled; `cp` non-repo over-block (planner N-r4-3/-4) | ACCEPT-document | **SUPERSEDED by r6 extract-only:** quote/brace operands are now quote-STRIPPED then extracted (codex F2), genuinely-dynamic operands ALLOW as the §16 R8 residual (not unknown-deny), and `cp` DEST is extracted so `cp a /tmp/y` ALLOWS (no over-block). The r4 unknown-deny / cp-over-block framing no longer holds under the real hard block. |

Both r4 reviewers confirmed the bash **boundary** is correct (target extraction) and the genuinely
unlexable cases are correctly accept+documented (not a same-class re-litigation). The r4 planner
blocker was the mirror **over-block** failure mode (lexable, fixed inside the boundary), explicitly
not a bash-bypass HOLD. Counts: R1 7 → R2 3 → R3 (1 ACCEPT / 2) → R4 (1 ACCEPT / 1 lexable). Prior
resolutions in `…020b/…db34`, `…9eb7/…dea1`, `…ed65/…fa57`, `…f560/…c2a7`.

## §20 Lessons Encoded

| Lesson | Rule | Enforced in |
|---|---|---|
| `…697c` PR-level / real-runtime | test the deployed adapter | §10 S2/S3, §19 |
| `…7918` strong not proxy | gauntlet codex-native; real codex tmux | §10 S3, §15, OD-3 |
| KB research corrects RFC; verify schema before designing | block mech + Python + the turn_index/schema-bijection catch | S0, §2, §5 |
| mock-project not mental-trace | S1/S4 tmux + install on real binary | §14, REQ-13/14/15 |
| `feedback_enforcement_gate_only_repo_src` R1-R3 | never gate episodes/markers/plans; apply_patch carve per-path; Bash extract-only (empty target → ALLOW, no over-block) | §7, §12, EC4-8 |
| model-scratch-I/O | `.git/` carved | §7 axis 5, EC8 |
| plan symlink-matrix | 8-axis in-plan | §7 |
| bp1 step-9 5-field DEFER | OD-4 + filed issue | §17 |
| honesty: declare what you deliver | pre_tool_use only; RFC scope note, no half-edit | §8.3, S0, OD-4 |
| `…18aa` drive TUI via tmux | firing + discriminating enforcement | §10 S1/S4, REQ-14/15 |
| verify-by-artifact | grepped schemas → caught the pre_tool_use turn_index issue both reviewers missed | §2, §16 R7 |
| named-test completeness (planner N3) | every named test scheduled in §14 + Appendix | §7, §14 |

---

# Appendix A: Mechanical Execution Spec (low-capability executor)

## A.1 Forbidden-phrase lint

```bash
grep -niE "decide|choose|figure out|as appropriate|if needed|handle accordingly|\betc\.|and so on|TBD|should probably|something like|or similar" docs/plans/rfc-008-p6-codex-enforcement-plugin.md
```
Expected: no matches **inside Appendix A step tables** (code identifiers like `decideForCodexStdin`
and §17 prose are not executor instructions). Reading pass required (`…2f5d`).

## A.2 Executor contract

Numeric order; one editable file per step; no design decisions (STOP-and-ask §A.3); run each verify
before proceeding; one command per verify (no `;`/`&&`/pipes); one slice = one commit `P6-Sn: <title>`
+ trailer; no aspirational output.

## A.3 STOP-and-ask

```text
STOP — step <n.m> blocked. Reason: <…>. File: <path>  Expected anchor: <verbatim>  Found: <±3 lines>  Question: <the one decision>
```

## A.4 Pre-flight

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `feat/rfc-008-p6-codex-enforcement` |
| Clean tree | `git status --porcelain` | empty |
| Baseline gauntlet | `node scripts/test-plugin.mjs --project . --harness opencode` | `7 pass, 2 deferred-P3, 0 fail — OK` |
| Node | `node --version` | `v24`+ |
| Codex (S1/S4) | `codex --version` | `codex-cli 0.141.0`+ |
| tmux (S1/S4) | `tmux -V` | `3.5`+ |

## A.5 Shared constants

```js
// install.mjs (S4): const REPO_PLUGIN_CODEX = path.join(REPO_DIR, 'plugins', 'codex');
// codex-adapter.mjs (S2):
//   const APPLY_PATCH_DIRECTIVES = [/^\*\*\* Add File: (.+)$/m, /^\*\*\* Update File: (.+)$/m,
//     /^\*\*\* Delete File: (.+)$/m, /^\*\*\* Move to: (.+)$/m];
//   // Bash write-target extraction — TOKENIZER-based (r6.2; codex round-6 closed the regex's
//   // quoted-space + `cp -t` gaps). Bare regex truncates `> "src/a b.txt"` at the space and mis-picks
//   // the `cp -t DEST` operand; quoting/spaces/`-t` are the same lexing class recurring, so the
//   // boundary changes from regex to a quote-aware tokenizer (handoff_complete_bug_class).
//   // shellSplit(cmd) → token[]: split on unquoted whitespace, keep `"..."`/`'...'` as ONE token with
//   //   the surrounding matched quotes STRIPPED (so `"src/a b.txt"` → token `src/a b.txt`). A token
//   //   carrying an unmatched quote, `$(`, a backtick, `$VAR`, or an **unescaped glob metachar
//   //   (`*`/`?`/`[`)** is flagged DYNAMIC (matches §12.1 residual: glob is NOT extracted → ALLOW).
//   // Walk tokens, collect write targets (GLOBAL — a command may have >1):
//   //   - redirect op `>`/`>>`/`&>`/`>&` (optionally fd-prefixed `2>`), attached (`>src/x`) or
//   //     standalone (`>` then next token): operand = remainder-of-token or next token. The operand
//   //     is **quote-stripped after splitting the operator off** — so an attached quoted redirect
//   //     `>>"src/x"` yields operand `src/x` (strip the matched quotes that trail the operator),
//   //     matching §8.2; a still-unmatched quote after that strip is DYNAMIC.
//   //       /dev/null → SINK (ignore); `>&<digit>` or bare-digit operand → fd-dup (ignore, N-r4-1);
//   //       DYNAMIC → residual (ignore); else push. `&>FILE`/`>&FILE` non-digit ARE writes (N-r4).
//   //   - `sed`: only when `-i`/`--in-place` present (else writes stdout). Grammar `sed [opts]
//   //     SCRIPT FILE…`: first non-flag operand is the SCRIPT unless `-e`/`-f` gave it (then all
//   //     operands are files); the rest are in-place targets. A bare `-i` consumes an EMPTY next
//   //     token as the BSD suffix (codex r7 S2-review — script-vs-file + BSD `-i ''`).
//   //   - `tee [-a]` → each following non-flag operand.
//   //   - `dd … of=X` → X.
//   //   - first word ∈ {cp,mv,install}: DEST = the value of `-t DEST` / `-tDEST` /
//   //     `--target-directory DEST` / `--target-directory=DEST` IF PRESENT (GNU puts DEST first —
//   //     "last operand" is WRONG when `-t` present, codex round-6, both directions), ELSE the LAST
//   //     non-flag operand. Sources are READS, never targets.
//   // NORMALIZE every collected target (tokenizer already de-quoted): if (!path.isAbsolute(t))
//   //   t = path.resolve(root, t) — BEFORE the waist (codex F1; never pass a relative target —
//   //   isRepoSource → canonicalizePossiblyNonexistent (repo-source.mjs:66) resolves relatives via
//   //   process.cwd(), so a divergent adapter cwd makes `src/x.mjs` resolve to the wrong root → ALLOW).
//   // DYNAMIC / unresolvable operand → NOT extracted → ALLOW (the §16 R8 residual; r6 Bash never
//   //   fail-closes). apply_patch unparseable STILL denies (structured path, §12 State C).
//   // Same normalization applies to Write/Edit `filePath` and every apply_patch directive path.
//   const SINK_OR_FDDUP = (x) => x === '/dev/null' || /^\d+$/.test(x);  // ignore, not a target
//   const COPY_FAMILY = new Set(['cp','mv','install']);
//   const TARGET_DIR_FLAG = /^(?:-t|--target-directory)(?:=(.*))?$/;  // value may be inline or next token
//   const DENY = (reason) => ({ hookSpecificOutput: { hookEventName:'PreToolUse',
//     permissionDecision:'deny', permissionDecisionReason: reason } });
//   // MUST be a dynamic import INSIDE the top-level try (planner N2 — a STATIC top-level import of a
//   // missing waist exits 1, which is NOT the exit-2 block signal → fail-open). Do not hoist:
//   //   const { isRepoSource } = await import(resolveScriptPath('repo-source.mjs'));
//   //     // gate per-path via isRepoSource(root,p).isRepoSource — NOT toolTargetsRepoSource
//   //     // (its Bash-label branch short-circuits read_only→ALLOW before the path check,
//   //     // repo-source.mjs:150-154; codex r7 F1).
//   //   const { gateDisposition, loadEnforceConfig, resolveContractRoot }
//   //     = await import(resolveScriptPath('enforce-contract.mjs'));
//   //   // gateDisposition harnessCap = "STRONG" (runtime mechanism cap for covered writes), NOT
//   //   // resolveHarnessCap()'s manifest MEDIUM — events.json maps MEDIUM→warn→clamp-off→no block
//   //   // (codex r7 F6). configTier/active still come from loadEnforceConfig as normal.
//   // resolveScriptPath: co-located (../../scripts/...) → in-repo fallback (enforce-bridge:36-49)
//   // turn_index: the adapter exports buildNormalizedPayload(stdin) which adds an integer turn_index
//   //   (per-process counter from 0) for the step-8 fixture + the binding-match test ONLY; the live
//   //   block/allow decision path never reads or computes turn_index.
```

## A.6 / A.6b Anchor + falsifiable verify

Verbatim unique ANCHOR; exact strings/fields/exit codes; label CREATE/EDIT/APPEND; every verify
names observed+expected and fails on a stub; negative-control rows run before the green run; one
command per row.

## A.7 Per-slice step tables

> Fully specified for **S0-S5**. S4/S5 step tables authored 2026-06-28 (post-S3), grounded in the
> shipped P5 opencode install/CI precedent (§7 anchors, §14 test names, REQ-13/14/15/17, §16 R-F3).
> Token estimate (Rule 12): S4 ~16k (install.mjs ~200-line read + 4 fns + the 6-test E2E + tmux
> enforcementProof), S5 ~9k (4 CI steps + runbook verify + RFC/index DONE edits) — one session each,
> S4 then S5 (S5 needs S4's `test-install-codex-enforcement.mjs` green in CI).

### `P6-S0` — RFC + doc correction (REQ-1, REQ-4)

**Files (one per step):** RFC body, `P5-P7-tool-plugins.md`, `memory/knowledge_base/codex-hooks.md`
(EDIT in step 0.2b), `docs/README.md`, `docs/_index.json`, `_repo-context.md`. **Read-only:** none
(the KB is now an edited file, not a reference).

| Step | File | Kind | Exact action | Verify |
|---|---|---|---|---|
| 0.0 | — | — | Pre-flight §A.4. | passes |
| 0.1 | RFC body | EDIT | ANCHOR `Codex: dict {block:true}` → REPLACE `Codex: exit code 2 + stderr reason, or hookSpecificOutput.permissionDecision:"deny" (legacy {decision:"block"} also accepted)`. | `grep -c "{block:true}" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → 0 |
| 0.2 | RFC body | EDIT | Three plugin-language fixes (NOT the generic `python ~/.codex/...` cli examples at L512/L1121): ANCHOR `Codex Python hook` (L833) → `Codex node command hook`; ANCHOR `Codex plugin (Python)` (L1189) → `Codex plugin (node command hook)`; ANCHOR `Codex plugin (Python)` (L1320 mermaid) → `Codex plugin (node command hook)`. | `grep -rn "Codex.*Python\|Codex plugin (Python)" docs/rfcs/` → 0 |
| 0.2b | `memory/knowledge_base/codex-hooks.md` | EDIT | Correct the KB conclusion so the cited ground truth no longer says "Declare STRONG" (codex r7 F3): the probe's blanket-deny proves the MECHANISM is STRONG, NOT that the extractor detects unlexable writes; conclude **mechanism STRONG, delivered capability MEDIUM** (unlexable-shell residual), declare MEDIUM with a bypass_known ceiling. Keep all empirical probe facts; add a one-line "[Superseded interpretation]" note. (Applied during r7 review.) | `grep -c "Declare STRONG" memory/knowledge_base/codex-hooks.md` → 0; `grep -c "delivered capability is MEDIUM\|delivered capability tier is MEDIUM" memory/knowledge_base/codex-hooks.md` → ≥1 |
| 0.3 | `P5-P7-tool-plugins.md` | EDIT | (a) ANCHOR `Python hooks` → `node command hooks`. (b) Correct the P6 capability-cell rationale — **tier stays MEDIUM**: ANCHOR `` `pre_tool_use: MEDIUM` *(multi-edit bypass documented)* `` → `` `pre_tool_use: MEDIUM` *(mechanism STRONG; Bash-write lexing residual caps the tier — KB codex-hooks.md)* ``. (c) Rewrite the honesty note (L51-53) ANCHOR `Codex `pre_tool_use` is declared **MEDIUM**, not STRONG —` … `for Codex.` → a corrected MEDIUM note: the empirical probe (codex 0.142.3, `memory/knowledge_base/codex-hooks.md`) blocked apply_patch + all 6 shell forms with no bypass reproduced, so the MECHANISM is STRONG and the prior multi-edit-bypass rationale is refuted; the tier stays MEDIUM because the Bash-write lexing residual (forms outside the §12.1 MUST-CATCH table) is a real known bypass (bypass_known MEDIUM ceiling, not clean-audit); stop/session_start deferred (schema/binding gap). | `grep -c "Python hooks" docs/rfcs/RFC-008/P5-P7-tool-plugins.md` → 0; `grep -c "multi-edit bypass documented" …/P5-P7-tool-plugins.md` → 0; `grep -c "mechanism STRONG" …/P5-P7-tool-plugins.md` → ≥1 (tier cell stays MEDIUM) |
| 0.4 | RFC body | EDIT | (a) **LEAVE** the per-harness matrix cell `| Codex | **MEDIUM** | — | STRONG | STRONG | — | `plugins/codex/` |` UNCHANGED — MEDIUM is the honest tier; no flip. (b) Rewrite the correction para (L919) ANCHOR `**Codex pre_tool_use correction (R3 → P5):** declared MEDIUM, not STRONG.` … `Bypass documented in the manifest.` → `**Codex pre_tool_use correction (R3 → P6):** declared **MEDIUM** (mechanism STRONG). Empirically verified (real codex 0.142.3, `memory/knowledge_base/codex-hooks.md`): a project-local PreToolUse deny hook hard-blocked apply_patch and all 6 shell forms; no bypass reproduced — the prior multi-edit-bypass rationale is refuted and the mechanism is STRONG. The tier stays MEDIUM because the delivered capability includes Bash, whose write-target lexing has a known residual (forms outside the §12.1 MUST-CATCH table) — a MEDIUM ceiling in bypass_known.json, not clean-audit.` | `grep -c "| Codex | \*\*MEDIUM\*\*" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → 1 (retained); `grep -c "Codex pre_tool_use correction (R3 → P6)" …` → 1; `grep -c "declared MEDIUM, not STRONG" …` → 0 (old framing gone; the new para legitimately contains "multi-edit", so target the removed sentence not the token) |
| 0.5 | RFC body | (no-op) | **LEAVE** the plan-approval effective-tier example (L934) `| Codex | MEDIUM | STRONG | STRONG | **MEDIUM** |` UNCHANGED — pre_tool_use stays MEDIUM, so the effective tier is unchanged. (Stop-gate example L946 is already STRONG — also LEAVE; P6 defers stop delivery, matrix target unchanged.) | `grep -c "| Codex | MEDIUM | STRONG | STRONG | \*\*MEDIUM\*\* |" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → 1 (retained) |
| 0.6 | RFC body | EDIT | Annotate (do NOT delete — audit trail) the two historical entries to refine the rationale; **MEDIUM stays the correct call**. (a) Alternatives row (L1298) ANCHOR `| Declare Codex `pre_tool_use` STRONG | Dishonest per P5` … `for Codex. |` → append `**Refined (P6, 2026-06-28):** the probe (KB codex-hooks.md) refuted the multi-edit basis and proved the MECHANISM is STRONG, but the Bash-write lexing residual keeps the declared tier at MEDIUM (bypass_known ceiling) — declaring STRONG would still be dishonest.` (b) Review-finding row (L1368) ANCHOR `| 4 | Codex pre_tool_use: STRONG dishonest | Corrected to MEDIUM with bypass documented | R3 |` → `| 4 | Codex pre_tool_use: STRONG dishonest | Corrected to MEDIUM (R3); **basis refined (P6): multi-edit refuted, mechanism STRONG, but Bash-lexing residual caps the tier at MEDIUM — KB codex-hooks.md** | R3 |`. | `grep -c "Refined (P6, 2026-06-28)" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → 1 |
| 0.7 | RFC body | EDIT | ADD a P6-scope note immediately after the rewritten L919 correction paragraph: `**Codex P6 scope (R6 → P6):** P6 ships pre_tool_use enforcement only (declared MEDIUM — mechanism STRONG, capped by the Bash-write lexing residual); the manifest declares pre_tool_use. stop/session_start (STRONG in the matrix above) are deferred — the canonical event schemas require fields (is_subagent, harness, integer turn_index) that raw codex stdin lacks and the binding grammar cannot synthesize; tracked in the P6 follow-up issue.` | `grep -n "Codex P6 scope" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → 1 |
| 0.8 | `docs/README.md` | EDIT | Update the RFC-008 P6 status cell. ANCHOR the P6 row. | `grep -n "P6" docs/README.md` → updated |
| 0.9 | `docs/_index.json` | EDIT | Sync `rfc_status` for RFC-008 P6. ANCHOR the RFC-008 key. | `node -e "JSON.parse(require('fs').readFileSync('docs/_index.json','utf8'))"` exits 0 |
| 0.10 | `_repo-context.md` | EDIT | Update the RFC-008 phase line for P6. ANCHOR the phase summary. | `grep -n "P6" _repo-context.md` → updated |
| 0.11 | — | — | File the stop-STRONG + schema/binding follow-up issue (`gh issue create`), then commit `P6-S0: correct Codex hook-interface assumptions + pre_tool_use MEDIUM rationale + P6 scope note (R6, R10)` + trailer. | `git log -1 --oneline` → `P6-S0` |

### `P6-S1` — tmux firing-proof + normalized fixture (REQ-14, REQ-11)

**Files (one per step):** `tests/integration/codex-tmux-e2e.mjs`,
`tests/fixtures/harness-events/codex/pre-tool-use.json`. **Read-only:** KB `codex-hooks.md`, `…18aa`.

> S1 uses a temporary hand-written `.codex/hooks.json` + a tiny **logging-allow** capture hook (NOT
> the real adapter — S2) to answer "does the interactive project-local PreToolUse hook fire on
> 0.141.0, and what is the real apply_patch `tool_input` shape". An allow stub (not deny) keeps
> firingProof non-vacuous (round-1 axis 5). The fixture is then the **normalized** form the S2
> adapter would emit (raw captured stdin + a synthesized `turn_index:0`), so it satisfies
> `event-pre-tool-use.schema:turn_index:integer` at step 8.

| Step | File | Kind | Exact action | Verify (UNGUARDED-IN-CI — real codex+tmux) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4 incl. `codex --version` + `tmux -V`. | passes |
| 1.1 | `tests/integration/codex-tmux-e2e.mjs` | CREATE | Whole-file. Mock project in `mkdtempSync` (git-init); `.codex/hooks.json` registering a **logging-allow** PreToolUse hook (`node -e` appends parsed stdin to `$CAPTURE_LOG`, exit 0). Drive codex per `…18aa`: isolated `tmux -L drive-<pid>`, CSI-u conf, `new-session -d -x 200 -y 50`, launch `codex` in the mock cwd, trust via `/hooks`, `paste-buffer` a prompt to create `src/probe.mjs` AND `docs/plans/note.md` in one apply_patch, poll `capture-pane -p -e -J`, `kill-server`. `firingProof`: `$CAPTURE_LOG` has a `hook_event_name:"PreToolUse"`, `tool_name:"apply_patch"` line. `trustGate`: pre-trust logs nothing, post-trust logs. Register in `main()`. | `node tests/integration/codex-tmux-e2e.mjs` → firingProof+trustGate pass; `$CAPTURE_LOG`+pane saved to scratch, pasted into §15. **If firingProof fails → STOP (§A.3), escalate #17532.** |
| 1.2 | `tests/fixtures/harness-events/codex/pre-tool-use.json` | CREATE | Whole-file = the captured PreToolUse stdin from 1.1 (the multi-file apply_patch), **plus a synthesized `"turn_index": 0`** (the normalized form), trimmed to documented fields incl. the exact `tool_input` patch text (S2's `extractTargetPaths` parses it). | `node -e "const o=JSON.parse(require('fs').readFileSync('tests/fixtures/harness-events/codex/pre-tool-use.json','utf8'));process.exit(typeof o.turn_index==='number'&&/apply_patch/.test(JSON.stringify(o))?0:1)"` → exit 0 |
| 1.3 | — | — | Commit `P6-S1: tmux firing-proof + normalized Codex pre_tool_use fixture (R6)` + trailer. | `git log -1 --oneline` → `P6-S1` |

### `P6-S2` — adapter + manifest + registry + conformance (REQ-2/3/5/6/7/8/9/10/11)

**Files (one per step):** `plugins/codex/capabilities/codex-adapter.mjs`,
`plugins/codex/manifest.json`, `plugins/_index.json`, `tests/test-codex-adapter-conformance.mjs`.
**Read-only:** `plugins/opencode/capabilities/enforce-bridge.mjs`, the S1 fixture.

| Step | File | Kind | Exact action | Verify (falsifiable) |
|---|---|---|---|---|
| 2.0 | — | — | Pre-flight §A.4. | passes |
| 2.1 | `plugins/codex/capabilities/codex-adapter.mjs` | CREATE | Whole-file. Read all stdin → `JSON.parse` **inside the top-level try** (throw/parse-fail → `DENY` + exit 2). Non-object / missing `hook_event_name` → deny+exit2 (State B). `hook_event_name !== "PreToolUse"` → exit 0 (State A). Else: require `path.isAbsolute(cwd)` (else deny+exit2, State B), `realpathSync(cwd)`; `classifyLabel`; `extractTargetPaths` per §12: Write/Edit → `[filePath]`; apply_patch via `APPLY_PATCH_DIRECTIVES` (empty patch **or** a `*** ` line matching none → `unknown:true`); **Bash via the §A.5 quote-aware tokenizer → write-target paths (de-quoted; redirects incl. quoted-space paths, `sed -i`/`tee`/`dd of=`, and `cp`/`mv`/`install` dest via `TARGET_DIR_FLAG`-or-last); SINK_OR_FDDUP operands dropped; a dynamic operand is NOT extracted (no `unknown` flag for Bash — r6 extract-only)**. **apply_patch** `unknown` → deny+exit2 (State C, **unconditional**, before disposition); **Bash never sets `unknown`**. **NORMALIZE each extracted target before the waist (codex F1/round-6): tokens are already de-quoted; `if (!path.isAbsolute(p)) p = path.resolve(root, p)`** — never pass a relative target to the waist (`isRepoSource`→`canonicalizePossiblyNonexistent`, `repo-source.mjs:66`, resolves relatives via `process.cwd()` → a divergent adapter cwd makes `src/x.mjs` resolve to the wrong root → ALLOW bypass). **Dynamically `import()` the waist inside the try** (§A.5; NOT a static top-level import — that exits 1 on a missing waist). `GATED = paths.some(p=>isRepoSource(root,p).isRepoSource)` (paths already normalized; **`isRepoSource` DIRECT — NOT `toolTargetsRepoSource(...,"Bash",...,label)`: its label branch short-circuits `read_only`/`nonsrc_write`→ALLOW before the path check (`repo-source.mjs:150-154`), and `sed -i`/`echo>` classify `read_only`, so routing through it re-opens the bypass — codex r7 F1**; extract-only — no label-branch fallback; empty `paths` ⇒ `GATED===false` ⇒ State D ALLOW, so `git commit`/`mkdir`/unlexable do not brick). `block = GATED && gateDisposition({duplicate,harnessCap:"STRONG",contractTier,active,configTier,events,event:"pre_tool_use"}).token∈{enforce,block}` (**runtime mechanism cap `STRONG` — NOT the manifest `MEDIUM`, which `events.json` maps `warn`→`clamp-off`→no block; codex r7 F6**; State E; GATED∧observe/clamp-off → State F allow). `classifyLabel` is computed for the deny reason only, never gating. block → `DENY(reason)` stdout + reason stderr + `exit(2)`; else exit 0. `buildNormalizedPayload` (turn_index synthesis) is a separate export used by tests/step-8 only — the decision path never computes it. Any internal throw caught → deny+exit2. | `node -e "import('./plugins/codex/capabilities/codex-adapter.mjs')"` exits 0 |
| 2.2 | `tests/test-codex-adapter-conformance.mjs` | CREATE | Whole-file (Group 1, **37 tests** — every name in §14 Group 1). Drive via `spawnSync(process.execPath,[ADAPTER],{input})`. apply_patch/Write cases LOAD the S1 fixture and re-point paths into a `mkdtempSync` git-init sandbox with a real `src/SENTINEL.mjs`; assert exit 2 + `JSON.parse(stdout).hookSpecificOutput.permissionDecision==="deny"` for blocks, exit 0 for allows. `testFailClosed` 4 rows (`""`,`42`,`null`,`[]`). `testImportFailClosed`: copy the adapter to a temp dir with NO co-located/in-repo waist reachable → exit 2 (not 1). **Bash (19): `testBashRepoSourceWriteBlocks` (`sed -i src/x`→deny), `testBashRedirectWriteBlocks` (`echo>src/x`→deny), `testBashAmpRedirectToFileBlocks` (`grep x y &> src/z`→deny), `testBashMultiRedirectBlocks` (`echo a > /tmp/a > src/evil`→deny), `testBashCpDestBlocks` (`cp a src/x`→deny via DEST extraction, NOT label), `testBashQuotedRedirectBlocks` (`printf hi >>"src/x.mjs"`→deny, codex F2 quote-strip), `testBashTargetResolvedUnderStdinCwd` (relative target, process cwd≠stdin cwd→deny, codex F1), `testBashDevNullAllows` (`echo>/dev/null`→exit 0), `testBashStderrDupAllows` (`grep x src 2>&1`→exit 0), `testBashRedirectToTmpAllows` (`echo>/tmp/y`→exit 0), `testBashCpToTmpAllows` (`cp a /tmp/y`→exit 0), `testBashQuotedDocsAllows` (`echo hi >"docs/plans/x.md"`→exit 0, codex F2 carve), `testBashReadOnlyAllows` (`cat src/x`→exit 0), `testBashGitCommitAllows` (`git commit -m x`→exit 0, no write target), `testBashUnlexableResidualAllows` (`eval "echo hi > $D"`→exit 0, §16 R8 residual), `testBashQuotedPathWithSpaceBlocks` (`printf hi > "src/a b.txt"`→deny, tokenizer), `testBashQuotedDocsWithSpaceAllows` (`echo hi > "docs/plans/a b.md"`→exit 0), `testBashCpTargetDirBlocks` (`cp -t src a b`→deny, GNU -t dest-first), `testBashCpTargetDirAllows` (`cp -t /tmp a src/x`→exit 0, sources are reads).** `testApplyPatchUnparseableDenies`. **`testAdapterHandlesRawStdin`: raw codex stdin (`turn_id`, NO `turn_index`) on a src write → exit 2 deny.** `testCwdSymlink`/`testCwdRelative`/`testCwdDivergence` (sentinel in reason). `testAdapterMatchesManifestBindings` asserts `buildNormalizedPayload(fixture)` matches the manifest pre_tool_use bindings. **Tier/cap (codex r7 F6): `testBlocksUnderDeclaredMedium` (covered `sed -i src/x`, manifest declares MEDIUM → STILL exit 2 deny via the runtime STRONG mechanism cap) + `testConfigClampMediumWarns` (same write, operator `enforce-config` `configTier:MEDIUM` → exit 0, clamp works).** Register in `main()`. | `node tests/test-codex-adapter-conformance.mjs` → `37/37 pass`; NEG-block rows exit 2 (incl. quoted-redirect, quoted-space path, `cp -t src`, relative-target-under-divergent-cwd); carve + `/dev/null` + `2>&1` + `/tmp` + `cp /tmp` + `cp -t /tmp` + quoted-docs(+space) + read + `git commit` + unlexable rows exit 0; import-fail row exits 2 not 1 |
| 2.3 | `plugins/codex/manifest.json` | CREATE | Whole-file. `type:"enforcement"`, `id:"codex"`, `harness:"codex"`, `invocation_modality:"cli"`, capabilities `{pre_tool_use:"MEDIUM"}` ONLY, `classifier:{mode:"override",emits_labels:[…5…],override_path:"plugins/codex/capabilities/codex-adapter.mjs"}`, `taxonomy_ref`/`taxonomy_version`/`events_version` = current `patterns` hashes, a SINGLE `event_translations.pre_tool_use` binding `tool:"$.tool_name"`, `tool_args:"$.tool_input"`, `cwd:"$.cwd"`, `session_id:"$.session_id"`, `turn_index:"$.turn_index"`, `timestamp_iso8601:"$$now"`, `runbook` paths. | `node scripts/test-plugin.mjs --project . --harness codex --json` → steps 1 + 8 `pass` |
| 2.4 | `plugins/_index.json` | EDIT | APPEND a `codex` entry to `plugins[]`: `{type,id:"codex",harness:"codex",directory:"plugins/codex",capabilities:{pre_tool_use:"MEDIUM"},classifier:"override",manifest:"plugins/codex/manifest.json",status:"active"}`. | `node scripts/test-plugin.mjs --project . --harness codex --json` → steps 2 + 7 `pass` |
| 2.4b | `plugins/bypass_known.json` | EDIT | **KEEP** the existing `{harness:"codex",event:"pre_tool_use",ceiling:"MEDIUM",citation:…}` record; refine its `citation` to the Bash-write lexing residual — the statically-**unlexable** forms outside the §12.1 MUST-CATCH table (`eval`/`sh -c`/`bash -c`, command-substitution, `$VAR`-expanded paths, here-docs, awk/`python -c`/`node -e`-internal writes; `repo-source.mjs`/§16 R8). Do **NOT** convert to a clean-audit and do **NOT** add a new pair — those unlexable forms escape the frozen extractor, so `no_known_bypass_evidence:true` would be dishonest. (`echo > src/x` / `sed -i src/x` are §12.1 MUST-CATCH and DO hard-block; they are not the escape.) (opencode declared clean-audit on the same gap — a precedent to FIX via backport, not copy.) | `node -e "JSON.parse(require('fs').readFileSync('plugins/bypass_known.json','utf8'))"` exits 0; `node scripts/test-plugin.mjs --project . --harness codex --json` → step 7 `pass`; `grep -c '"ceiling": "MEDIUM"' plugins/bypass_known.json` INCLUDES the codex line (record retained); `grep -c "no_known_bypass_evidence" plugins/bypass_known.json` does NOT add a codex entry |
| 2.5 | — | — | Commit `P6-S2: Codex-native adapter + MEDIUM manifest + registry + MEDIUM-ceiling bypass_known + conformance (R6)` + trailer. | `git log -1 --oneline` → `P6-S2` |

### `P6-S3` — gauntlet codex-native step-9 modality + runbook shape (REQ-12, REQ-16)

**Files (one per step):** `schemas/runbook-agent-manifest.schema.json`,
`plugins/codex/runbooks/enforcement.md`, `docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md`,
`scripts/test-plugin.mjs` (3.4 = Add fn `codexDispatch`; 3.5 = fix the two existing dispatch helpers;
3.6 = EDIT `stepInvocationParity`). **Read-only:** `plugins/codex/capabilities/codex-adapter.mjs`
(deny contract — exit 2 + `hookSpecificOutput.permissionDecision:"deny"`, `codex-adapter.mjs:72-87`),
the `bridgeDispatch`/`sandboxDispatch` precedents, the S1 fixture.

> S3 edits the **shared high-blast** gauntlet (`test-plugin.mjs` is routed by all 3 harnesses) — §10
> hard stop = **focused review BEFORE build** (step 3.0b). The codex adapter fits NEITHER existing
> modality: opencode's `json-object` branch asserts `decision.action==="block"` (codex emits
> `hookSpecificOutput.permissionDecision:"deny"`, not `action:block` — this is the one known-red check,
> §10/handoff); claude-code's `exit-code-only` branch asserts a self-armed `.checkpoints/.*` marker
> (the codex adapter is stateless, writes none). So S3 adds a THIRD `codex-native` modality (exit-2 +
> permissionDecision driving the real adapter) and re-points the runbook's `expected_outputs.shape` at
> it. Non-vacuity (S1 axis-5 lesson): `codexDispatch` drives a **discriminating pair** — a repo-source
> write DENIED and a `docs/plans/` write ALLOWED — so a stub that always exits 2 (or always 0) fails.
> The new `codex-native` value is also a closed enum member of `expected_outputs.shape` in
> `schemas/runbook-agent-manifest.schema.json`, enforced by M7e (`validate-plugin-registry.mjs:466`);
> the enum MUST be extended (step 3.1) BEFORE the runbook flips to it (step 3.2), or M7e + CI go red.
>
> **Codex pre-build review (step 3.0b, DONE this cycle, interactive) hardened three things** (verdict
> HOLD → converged ACCEPT): (a) marker-leak snapshots are captured BEFORE the `finally` `rmSync` — the
> existing `bridgeDispatch`/`sandboxDispatch` compute `procLeak` AFTER deleting `procCwd`
> (`test-plugin.mjs:408` then `:413`), so today's `cwdHeld` is vacuous; S3 fixes all three (step 3.5);
> (b) the branch asserts BOTH exits against the closed `return_codes` map and that the allow case emits
> empty stdout (step 3.6); (c) `codex-native` is registered in RFC-008 prose (`:815`, `:1125`), not
> only the schema enum (step 3.3).

| Step | File | Kind | Exact action (anchor + literal change) | Verify (observed → expected; falsifiable, §A.6b) |
|---|---|---|---|---|
| 3.0 | — | — | Pre-flight §A.4. | passes |
| 3.0b | — | — | **§10 hard stop — focused review BEFORE editing the shared gauntlet** (DONE this cycle, interactive codex). Reviewed the `codex-native` branch + `codexDispatch` design against the adapter deny contract (`codex-adapter.mjs:72-87`) and the `sandboxDispatch`/`bridgeDispatch` precedents. Verdict HOLD → converged ACCEPT; the 3 findings are folded into steps 3.3 (RFC prose), 3.4 (leaks-before-rm), 3.5 (pre-existing vacuous `cwdHeld` in both helpers), 3.6 (both-exits + allow-stdout-empty). | verdict recorded HOLD→ACCEPT; each finding maps to a step below |
| 3.1 | `schemas/runbook-agent-manifest.schema.json` | EDIT | ANCHOR `        "shape": { "type": "string", "enum": ["ndjson-per-line", "json-object", "exit-code-only"] },` → REPLACE `        "shape": { "type": "string", "enum": ["ndjson-per-line", "json-object", "exit-code-only", "codex-native"] },`. (M7e schema-validates the runbook agent-manifest against this closed enum at `validate-plugin-registry.mjs:466`; the `codex-native` shape (step 3.2) would otherwise fail M7e → red `validate-plugin-registry` + S5 CI. Extend the enum BEFORE the runbook flip.) | `node -e "const s=JSON.parse(require('fs').readFileSync('schemas/runbook-agent-manifest.schema.json','utf8'));process.exit(s.properties.expected_outputs.properties.shape.enum.includes('codex-native')?0:1)"` → exit 0 |
| 3.2 | `plugins/codex/runbooks/enforcement.md` | EDIT | ANCHOR `  "expected_outputs": { "shape": "json-object" },` → REPLACE `  "expected_outputs": { "shape": "codex-native" },`. (codex blocks via exit-2 + `permissionDecision:deny`, NOT opencode's `action:block`; leaving `json-object` routes step 9 to `bridgeDispatch`, which fails on `decision.action!=="block"`. M7e now accepts the value because step 3.1 extended the enum.) | `grep -c '"shape": "codex-native"' plugins/codex/runbooks/enforcement.md` → 1; `grep -c '"shape": "json-object"' plugins/codex/runbooks/enforcement.md` → 0; `node scripts/validate-plugin-registry.mjs --project .` → exit 0 (M7e green) |
| 3.3 | `docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` | EDIT | **(P2 — codex Q3; Rule 10 RFC-prose sync.)** Two anchored edits registering `codex-native` in the shape enumerations. (a) ANCHOR `(NDJSON/JSON-object/exit-only as declared)` → REPLACE `(NDJSON/JSON-object/exit-only/codex-native as declared)`. (b) ANCHOR `` `ndjson-per-line` | `json-object` | `exit-code-only`, with optional `schema_ref` `` → REPLACE `` `ndjson-per-line` | `json-object` | `exit-code-only` | `codex-native` (exit-2 + `hookSpecificOutput.permissionDecision:"deny"` for block, exit-0 no-output for allow), with optional `schema_ref` ``. | `grep -c "codex-native" docs/rfcs/RFC-008-decouple-enforcement-from-substrate.md` → ≥2 |
| 3.4 | `scripts/test-plugin.mjs` | Add fn | Add `function codexDispatch(root, manifest, am)` immediately BEFORE ANCHOR `// CLI.` (the `// ----…----` divider preceding `function parseArgs`). Mirror `bridgeDispatch`: `mkdtempSync` sandbox + `git init -q`; a DIVERGENT `procCwd` `mkdtempSync`; `.checkpoints` snapshot/`newMarkers` helpers. Expand `command_shapes[0]` (`{plugin_dir}` → `path.join(root,"plugins",manifest.harness)`). Run the adapter TWICE via `spawnSync(argv[0], argv.slice(1), {cwd:procCwd, input, encoding:"utf8", timeout:15000})` with **raw codex PreToolUse stdin** `{hook_event_name:"PreToolUse", tool_name:"Write", tool_input:{filePath:<target>, content:"x"}, cwd:fs.realpathSync(sandbox), session_id:SID}`: (a) DENY `target=<sandbox>/src/SENTINEL.mjs` (mkdir `src/`+write the file first); (b) ALLOW `target=<sandbox>/docs/plans/note.md` (mkdir `docs/plans/`). Parse each stdout in a `try` (null on failure); keep raw `denyStdout`/`allowStdout`. **codex P1a: declare `let liveLeak=[], procLeak=[];` and compute them BEFORE the `finally` `rmSync` (a deleted `procCwd` snapshots empty → vacuous `cwdHeld`).** Return `{denyExit, denyDecision, denyStdout, allowExit, allowStdout, isolationHeld:liveLeak.length===0, cwdHeld:procLeak.length===0, liveLeak, procLeak, read_trace, error}`. | `node --check scripts/test-plugin.mjs` → exits 0; `grep -c "function codexDispatch" scripts/test-plugin.mjs` → 1 |
| 3.5 | `scripts/test-plugin.mjs` | EDIT | **(codex P1a — pre-existing vacuous `cwdHeld`.)** The pair `  const liveLeak = newMarkers(root, liveBefore);` + `  const procLeak = newMarkers(procCwd, procBefore);` appears IDENTICALLY after the `finally` in BOTH `bridgeDispatch` (`test-plugin.mjs:413-414`) and `sandboxDispatch` (`:337-338`), AFTER `procCwd` is `rmSync`'d in the `finally` (`:410`/`:334`) → `procLeak` is always empty. For EACH function: declare `let liveLeak=[], procLeak=[];` above the `try`, assign that pair inside the `finally` BEFORE the `fs.rmSync(procCwd,...)` line, and delete the post-`finally` duplicate. Behavior is unchanged unless a real `procCwd` leak was being hidden. Also update the step-9 modality comment (~`:221`) to name the third `codex-native` model. | `node scripts/test-plugin.mjs --project . --harness opencode --json` → step 9 `pass`; `node scripts/test-plugin.mjs --project . --harness claude-code --json` → step 9 `pass` (both now compute `procLeak` pre-rm — non-vacuous) |
| 3.6 | `scripts/test-plugin.mjs` | EDIT | In `stepInvocationParity`, ANCHOR the fallback block `  } else {` + its body `    problems.push(\`unsupported expected_outputs.shape ${JSON.stringify(modality)} — step 9 cannot prove invocation parity\`);` → REPLACE by inserting, BEFORE that `} else {`, a new branch `} else if (modality === "codex-native") {` that calls `const iso = codexDispatch(root, manifest, am); read_trace.push(...iso.read_trace);` then (on `!iso.error`) pushes a problem unless ALL hold: `iso.denyExit === 2`; `iso.denyDecision && iso.denyDecision.hookSpecificOutput && iso.denyDecision.hookSpecificOutput.permissionDecision === "deny"`; `iso.denyStdout.trim() !== ""` (codex P1b diagnostic); `String(iso.denyExit) in am.return_codes` **and** `String(iso.allowExit) in am.return_codes` (codex P1b — both exits in the closed map); `iso.allowExit === 0` (discriminating pair — non-vacuous, S1 axis-5); `iso.allowStdout.trim() === ""` (codex P1b — allow = no output, `codex-adapter.mjs:9`); `iso.isolationHeld`; `iso.cwdHeld`. Set `passDetail` to name `denyExit`, the `permissionDecision`, and `allowExit`. KEEP the original `} else {` unsupported-shape push as the final fallback. | `node scripts/test-plugin.mjs --project . --harness codex --json` → step 9 `status:"pass"`; summary = `7 pass, 2 deferred-P3, 0 fail` (`status:"ok"`) |
| 3.7 | — | — | **Regression — the shared file routes all 3 harnesses (§A.8).** Rerun the gauntlet for opencode and claude-code; both pre-existing step-9 branches green (and now non-vacuous, step 3.5). | `node scripts/test-plugin.mjs --project . --harness opencode --json` → step 9 `pass` (json-object branch intact); `node scripts/test-plugin.mjs --project . --harness claude-code --json` → step 9 `pass` (exit-code-only branch intact) |
| 3.8 | — | — | **BP-1 step 6 — code review** the `test-plugin.mjs` + runbook + schema + RFC diff (interactive codex per session constraint, or `negative-scenario-reviewer`). Disposition findings via inline-FU heuristic; file deferred per step 9. Record reply-episode id in §15. | review reply-episode id in §15; every finding dispositioned (inline / issue / DEFER) |
| 3.9 | — | — | Commit `P6-S3: gauntlet codex-native step-9 modality + runbook/schema/RFC registration + dispatch-helper leak-snapshot fix (R6)` + trailer. | `git log -1 --oneline` → `P6-S3` |

### `P6-S4` — per-project install + enforcement-proof (REQ-13, REQ-15)

**Files (one concern per step):** `install.mjs` (4.1 const; 4.2-4.4 = 3 new fns; 4.5 = dispatch
wiring), `tests/test-install-codex-enforcement.mjs` (CREATE), `tests/integration/codex-tmux-e2e.mjs`
(EDIT — add `enforcementProof`). **Read-only:** the opencode precedent `install.mjs:68` +
`opencodeEnforcementPaths`:1481-1506 + `installOpenCodeEnforcement`:1508-1592 +
`uninstallOpenCodeEnforcement`:1594-1628 + dispatch :1639-1655; `codex-adapter.mjs:36-48`
(`resolveScriptPath` — fixes the deploy layout); `test-install-opencode-enforcement.mjs` (E2E shape).

> **Deploy layout (fixes the one S4 design point).** The shipped adapter resolves its waist via
> `resolveScriptPath("../../scripts/…")` from its own `capabilities/` dir (`codex-adapter.mjs:36-48`),
> so the deployed closure MUST sit at `<.codex root>/scripts/` — exactly mirroring opencode's
> `.opencode/plugins/scripts/`. Deploy root = `<project>/.codex`; adapter →
> `.codex/episodic-memory/capabilities/codex-adapter.mjs`; waist closure → `.codex/scripts/` +
> `.codex/scripts/lib/`; patterns → `.codex/patterns/` + `.codex/scripts/patterns/`; registration →
> `.codex/hooks.json` (merge, never `config.toml` — §5; never `~/.codex/` — Principle 12). Per-project
> only (REQ-13); cwd-divergence is the headline risk (§16 R-F3): every artifact lands under the
> resolved `project_root`, never caller cwd or `$HOME`.

| Step | File | Kind | Exact action (anchor + literal change) | Verify (falsifiable) |
|---|---|---|---|---|
| 4.0 | — | — | Pre-flight §A.4 incl. `codex --version` + `tmux -V`. | passes |
| 4.1 | `install.mjs` | EDIT | ANCHOR `const REPO_PLUGIN_OPENCODE = path.join(REPO_DIR, 'plugins', 'opencode')` → append the next line `const REPO_PLUGIN_CODEX = path.join(REPO_DIR, 'plugins', 'codex')` (§A.6 L705). | `grep -c "REPO_PLUGIN_CODEX" install.mjs` → ≥2 (decl + use in 4.3) |
| 4.2 | `install.mjs` | Add fn | Add `function codexEnforcementPaths(projectDir)` immediately AFTER the line matching ANCHOR `const REPO_PLUGIN_CODEX = path.join(REPO_DIR, 'plugins', 'codex')` (added in 4.1). **Exact body = Listing S4-L1 §A (verbatim).** Returns `{codexDir, pluginDir, capabilitiesDir, runbooksDir, scriptsDir, scriptsLibDir, carveoutPatternsDir, contractPatternsDir, contractIndexPath, adapterAbs, hooksJsonPath}`, all under `<projectDir>/.codex`. | `node --check install.mjs` → exit 0; `grep -c "function codexEnforcementPaths" install.mjs` → 1 |
| 4.3 | `install.mjs` | Add fn | Add `function codexHookCommand(adapterAbs)` + `function installCodexEnforcement(projectDir)` after `codexEnforcementPaths`. **Exact body = Listing S4-L1 §B (verbatim)** — parse-or-skeleton `.codex/hooks.json` with `JSON.parse` (malformed → `report.warnings.push('.codex/hooks.json is not valid JSON …'); return report` BEFORE any file is written, MAJOR-1 parity); copy adapter + `manifest.json` + `runbooks/`; copy `enforce-contract.mjs` + every `scripts/lib/*.mjs`; copy `repo-source-carveouts.json`; copy `bp-001.json`/`events.json`/`enforce-config.schema.json` + `_index.json`; MERGE the `{matcher:'.*', hooks:[{type:'command', command: codexHookCommand(adapterAbs) (= `node '<shell-quoted adapterAbs>'`, S4-review shell-quote fix), statusMessage:'episodic-memory enforcement', timeout:30}]}` block into `config.hooks.PreToolUse[]` via `writeJSONAtomic`, idempotent on the `command` string; `console.log` the `/hooks` trust line. | `node --check install.mjs` → exit 0; `grep -c "function installCodexEnforcement" install.mjs` → 1 |
| 4.4 | `install.mjs` | Add fn | Add `function uninstallCodexEnforcement(projectDir)` after `installCodexEnforcement`. **Exact body = Listing S4-L1 §C (verbatim)** — parse-or-abort `.codex/hooks.json`; remove ONLY hooks whose `command === \`node ${adapterAbs}\``, drop emptied matcher blocks, `delete` an emptied `PreToolUse`/`hooks`; recursive-rm ONLY the fully-owned `pluginDir` (`.codex/episodic-memory`); for the GENERIC shared dirs remove only the EXACT copied files (`enforce-contract.mjs`, each `scripts/lib/*.mjs`, the 3 `scripts/patterns/*` contract files, `scripts/plugins/_index.json`, `patterns/repo-source-carveouts.json`), then prune each dir bottom-up only if empty (review F1 r2); prune an empty `.codex`. `assertContained(_, P.codexDir)` guards every removal. | `node --check install.mjs` → exit 0; `grep -c "function uninstallCodexEnforcement" install.mjs` → 1 |
| 4.5 | `install.mjs` | EDIT | Wire dispatch WITHOUT touching the `case 'codex'` **skill** (:937). **Exact ANCHOR → REPLACE = Listing S4-L1 §D (verbatim).** (a) install: ANCHOR `if (installEnforcement && tool === 'opencode') {` (:1649) — insert the `} else if (installEnforcement && tool === 'codex') {` branch BEFORE the claude-code `} else if (installHooks || installEnforcement) {`. (b) uninstall: ANCHOR the `uninstallEnforcement` ternary (:1640-1642) → extend with the `tool === 'codex' ? uninstallCodexEnforcement(projectDir) :` arm. | `grep -c "installCodexEnforcement(projectDir)" install.mjs` → 1 dispatch site; `grep -c "\.agents/skills/episodic-memory" install.mjs` → unchanged from pre-4.5 count (skill path intact) |
| 4.6 | `tests/test-install-codex-enforcement.mjs` | CREATE | Whole-file. **Exact verbatim contents = Listing S4-L2** (the 9 §14 Group-2 scenarios, each asserting the DEPLOYED adapter's captured exit/stdout or the on-disk hooks.json `command` strings — never a constant; the `USER_CMD` sentinel flows through merge + uninstall; the carve-out ALLOW row + the `active:false` control are the negative controls proving the repo-source DENY is non-vacuous per §A.9; plus the relative-`--project` absolute-command and user-file-survival controls from review r2; plus the spaced-project shell-quoted-command control from S4 code review, which runs the stored command through a shell). | `node tests/test-install-codex-enforcement.mjs` → `… passed, 0 failed`; stdout includes all 9 scenario names |
| 4.6b | `tests/test-install-codex-enforcement.mjs` | — (verify) | **Red-then-green negative control (§A.9):** the deny assertion must go RED if the deployed adapter is allow-stubbed. Run with the env break `CODEX_FORCE_ALLOW=1` honored by the test (Listing S4-L2 reads it and points the deployed-adapter spawn at a 1-line allow stub). | `CODEX_FORCE_ALLOW=1 node tests/test-install-codex-enforcement.mjs` → exits NON-zero (the `repo-src write -> exit 2` assertion fails) |
| 4.7 | `tests/integration/codex-tmux-e2e.mjs` | APPEND | Add `import { fileURLToPath } from 'node:url'` + `function bareMock()` + `const ENFORCE_PROMPT` + `function testEnforcementProof()` and register `['enforcementProof', testEnforcementProof]` in `main()`'s tests array. **Exact verbatim body = Listing S4-L3** (real `install.mjs --tool codex --install-enforcement` into a capture-hook-free `bareMock` project, drive real codex per `…18aa`, dir-trust + `/hooks` trust, `pastePrompt` TWO sequential single-file apply_patch calls — `docs/plans/note.md` (ALLOW) then `src/probe.mjs` (DENY, a mixed patch is denied wholesale); `waitIdle` + settle then `capture(t,win,400)`; assert the pane shows the deny on `src/probe.mjs`, `docs/plans/note.md` written on disk, and `src/probe.mjs` absent — firing is proven by the DENY itself, not a separate capture hook). Tag UNGUARDED-IN-CI. | `node tests/integration/codex-tmux-e2e.mjs` (real codex) → `enforcementProof` pass (discriminating pair); pane → §15 |
| 4.8 | — | — | Run `node tests/test-install-codex-enforcement.mjs` (9 scenarios) + the manual `enforcementProof`; paste both captures into §15. | `45 passed, 0 failed` (9 scenarios); enforcementProof discriminating-pair pass |
| 4.9 | — | — | **BP-1 step 6 code review** (interactive codex via cmux, or `negative-scenario-reviewer`) of the `install.mjs` + test diff. Disposition via inline-FU; file deferred per step 9; reply-episode in §15. | reply-episode id in §15; every finding dispositioned |
| 4.10 | — | — | Commit `P6-S4: per-project codex enforcement install (merge .codex/hooks.json + closure + trust-print + uninstall) + install E2E + tmux enforcement-proof (R6, R10)` + trailer. | `git log -1 --oneline` → `P6-S4` |

#### Listing S4-L1 — `install.mjs` additions (verbatim; mirrors `installOpenCodeEnforcement` :1508-1592)

**§A — `codexEnforcementPaths` (step 4.2).** Deploy root `<project>/.codex`; the adapter's
`resolveScriptPath('../../scripts/…')` (codex-adapter.mjs:36-48) lands the waist at `.codex/scripts`.

```js
function codexEnforcementPaths(projectDir) {
  // R-F3 (review F4): normalize the project root ONCE so a relative or symlinked
  // --project still yields an ABSOLUTE root. This matters because adapterAbs below is
  // embedded verbatim in the hooks.json `command` string (`node <adapterAbs>`); codex
  // runs that command from its own cwd, so a relative adapterAbs would break the hook.
  // realpath when the dir exists (install operates on an existing project); path.resolve
  // as the fallback so a not-yet-existing --project still absolutizes. Scoped to codex
  // (NOT install.mjs:46) to keep the claude-code/opencode install paths unchanged.
  let root
  try { root = fs.realpathSync(projectDir) } catch { root = path.resolve(projectDir) }
  const codexDir = path.join(root, '.codex')
  const pluginDir = path.join(codexDir, 'episodic-memory')
  const scriptsDir = path.join(codexDir, 'scripts')
  return {
    codexDir,
    pluginDir,
    capabilitiesDir: path.join(pluginDir, 'capabilities'),
    runbooksDir: path.join(pluginDir, 'runbooks'),
    scriptsDir,
    scriptsLibDir: path.join(scriptsDir, 'lib'),
    // repo-source.mjs candidate-2 carve-out JSON = <.codex>/patterns (its own ../../patterns).
    carveoutPatternsDir: path.join(codexDir, 'patterns'),
    // resolveContractRoot candidate-0 (bp-001.json) + events.json + enforce-config.schema.json,
    // BESIDE the deployed engine at <.codex>/scripts/patterns.
    contractPatternsDir: path.join(scriptsDir, 'patterns'),
    contractIndexPath: path.join(scriptsDir, 'plugins', '_index.json'),
    // ABSOLUTE host path embedded in the hooks.json command STRING (a real exec path — NOT the
    // forward-slash-normalized opencode adapterSpec; codex hooks.json `command` is `node <path>`).
    adapterAbs: path.join(pluginDir, 'capabilities', 'codex-adapter.mjs'),
    hooksJsonPath: path.join(codexDir, 'hooks.json'),
  }
}
```

**§B — `codexHookCommand` + `installCodexEnforcement` (step 4.3).**

```js
function codexHookCommand(adapterAbs) {
  // S4 code-review fix: codex runs the hooks.json `command` via a SHELL (empirically confirmed
  // on 0.142.3 — a `>` redirect inside a hook command evaluates), so an unquoted path with a
  // space would split the argv and the hook would silently fail OPEN. POSIX single-quote escape.
  const quoted = "'" + String(adapterAbs).replaceAll("'", "'\\''") + "'"
  return `node ${quoted}`
}

function installCodexEnforcement(projectDir) {
  const report = { deployedFiles: [], registration: null, warnings: [] }
  const P = codexEnforcementPaths(projectDir)

  // 0. PARSE .codex/hooks.json FIRST — abort the WHOLE deploy on malformed JSON
  //    (MAJOR-1 parity: never leave unregistered files the agent then can't enforce with).
  let config
  if (fs.existsSync(P.hooksJsonPath)) {
    try { config = JSON.parse(fs.readFileSync(P.hooksJsonPath, 'utf8')) }
    catch (e) {
      report.warnings.push(`.codex/hooks.json is not valid JSON (${e.message}); aborted — nothing deployed`)
      return report
    }
  } else {
    config = {}
  }

  // 1. adapter + manifest + runbooks.
  fs.mkdirSync(P.capabilitiesDir, { recursive: true })
  const adDst = path.join(P.capabilitiesDir, 'codex-adapter.mjs')
  fs.copyFileSync(path.join(REPO_PLUGIN_CODEX, 'capabilities', 'codex-adapter.mjs'), adDst)
  report.deployedFiles.push(adDst)
  const manDst = path.join(P.pluginDir, 'manifest.json')
  fs.copyFileSync(path.join(REPO_PLUGIN_CODEX, 'manifest.json'), manDst)
  report.deployedFiles.push(manDst)
  const rbSrc = path.join(REPO_PLUGIN_CODEX, 'runbooks')
  if (fs.existsSync(rbSrc)) { copyDirRecursive(rbSrc, P.runbooksDir); report.deployedFiles.push(P.runbooksDir) }

  // 2. thin-waist closure: enforce-contract.mjs + ALL scripts/lib/*.mjs.
  fs.mkdirSync(P.scriptsLibDir, { recursive: true })
  const ecDst = path.join(P.scriptsDir, 'enforce-contract.mjs')
  fs.copyFileSync(path.join(REPO_SCRIPTS, 'enforce-contract.mjs'), ecDst)
  report.deployedFiles.push(ecDst)
  const repoLib = path.join(REPO_SCRIPTS, 'lib')
  for (const f of fs.readdirSync(repoLib).filter((f) => f.endsWith('.mjs')).sort()) {
    const dst = path.join(P.scriptsLibDir, f)
    fs.copyFileSync(path.join(repoLib, f), dst)
    report.deployedFiles.push(dst)
  }

  // 3. carve-out JSON (repo-source.mjs candidate-2).
  const coSrc = path.join(REPO_DIR, 'patterns', 'repo-source-carveouts.json')
  if (fs.existsSync(coSrc)) {
    fs.mkdirSync(P.carveoutPatternsDir, { recursive: true })
    const coDst = path.join(P.carveoutPatternsDir, 'repo-source-carveouts.json')
    fs.copyFileSync(coSrc, coDst)
    report.deployedFiles.push(coDst)
  }

  // 4. project-local contract set beside the engine (resolveContractRoot candidate-0).
  fs.mkdirSync(P.contractPatternsDir, { recursive: true })
  for (const f of ['bp-001.json', 'events.json', 'enforce-config.schema.json']) {
    const src = path.join(REPO_DIR, 'patterns', f)
    if (fs.existsSync(src)) {
      const dst = path.join(P.contractPatternsDir, f)
      fs.copyFileSync(src, dst)
      report.deployedFiles.push(dst)
    }
  }
  const idxSrc = path.join(REPO_DIR, 'plugins', '_index.json')
  if (fs.existsSync(idxSrc)) {
    fs.mkdirSync(path.dirname(P.contractIndexPath), { recursive: true })
    fs.copyFileSync(idxSrc, P.contractIndexPath)
    report.deployedFiles.push(P.contractIndexPath)
  }

  // 5. register a PreToolUse command hook in .codex/hooks.json — MERGE, idempotent,
  //    NEVER clobber a user hook (codex shape: hooks.PreToolUse[].hooks[].command string).
  const cmd = codexHookCommand(P.adapterAbs)
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {}
  if (!Array.isArray(config.hooks.PreToolUse)) config.hooks.PreToolUse = []
  const already = config.hooks.PreToolUse.some(
    (b) => Array.isArray(b.hooks) && b.hooks.some((h) => h && h.command === cmd))
  if (!already) {
    config.hooks.PreToolUse.push({
      matcher: '.*',
      hooks: [{ type: 'command', command: cmd, statusMessage: 'episodic-memory enforcement', timeout: 30 }],
    })
    writeJSONAtomic(P.hooksJsonPath, config)
    report.deployedFiles.push(P.hooksJsonPath)
    report.registration = cmd
  } else {
    report.registration = `${cmd} (already present)`
  }

  // 6. trust is inactive until the operator runs /hooks (R3) — print the instruction.
  console.log(`[codex enforcement] deployed under ${P.codexDir}. Run "/hooks" inside codex (cwd ${projectDir}) and TRUST the PreToolUse hook to activate enforcement.`)
  return report
}
```

**§C — `uninstallCodexEnforcement` (step 4.4).**

```js
function uninstallCodexEnforcement(projectDir) {
  const report = { removedFiles: [], removedRegistration: null, warnings: [] }
  const P = codexEnforcementPaths(projectDir)
  const cmd = codexHookCommand(P.adapterAbs)

  // (a) hooks.json FIRST — parse-or-abort; remove ONLY our command, keep user hooks.
  if (fs.existsSync(P.hooksJsonPath)) {
    let config
    try { config = JSON.parse(fs.readFileSync(P.hooksJsonPath, 'utf8')) }
    catch (e) { report.warnings.push(`.codex/hooks.json not valid JSON (${e.message}); aborted — nothing changed`); return report }
    if (config.hooks && Array.isArray(config.hooks.PreToolUse)) {
      let changed = false
      config.hooks.PreToolUse = config.hooks.PreToolUse
        .map((b) => {
          if (!Array.isArray(b.hooks)) return b
          const kept = b.hooks.filter((h) => !(h && h.command === cmd))
          if (kept.length !== b.hooks.length) changed = true
          return { ...b, hooks: kept }
        })
        .filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0)
      if (changed) {
        if (config.hooks.PreToolUse.length === 0) delete config.hooks.PreToolUse
        if (Object.keys(config.hooks).length === 0) delete config.hooks
        writeJSONAtomic(P.hooksJsonPath, config)
        report.removedRegistration = cmd
      }
    }
  }

  // (b) remove ONLY what we deployed (review F1). pluginDir (.codex/episodic-memory) is
  //     a namespace WE create and fully own -> recursive rm is safe. But scriptsDir
  //     (.codex/scripts) and carveoutPatternsDir (.codex/patterns) sit DIRECTLY under
  //     codex's own config dir and may hold unrelated user files; unlike opencode (whose
  //     closure is namespaced under .opencode/plugins/), the codex adapter's ../../scripts
  //     waist forces these bare paths. So remove only our KNOWN members there, then prune
  //     the parent dir only if it is left empty. Never blanket-rm a shared codex dir.
  if (fs.existsSync(P.pluginDir)) {
    assertContained(P.pluginDir, P.codexDir)
    fs.rmSync(P.pluginDir, { recursive: true, force: true })
    report.removedFiles.push(P.pluginDir)
  }
  // Review F1 (round 2): even .codex/scripts/{lib,patterns,plugins} are GENERIC dir names —
  // remove only the EXACT files we copied, then prune each dir bottom-up ONLY if empty. Never
  // recursive-rm a subdir a user might share. The deployed lib set == the repo's scripts/lib/*.mjs
  // that install §B copied; recompute it from the repo (fall back to the deployed *.mjs names if
  // the repo lib is unreachable).
  const removeFile = (p) => { if (fs.existsSync(p)) { assertContained(p, P.codexDir); fs.rmSync(p, { force: true }); report.removedFiles.push(p) } }
  const pruneIfEmpty = (d) => { try { if (fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); report.removedFiles.push(d) } } catch {} }

  removeFile(path.join(P.scriptsDir, 'enforce-contract.mjs'))
  let libFiles = []
  try { libFiles = fs.readdirSync(path.join(REPO_SCRIPTS, 'lib')).filter((f) => f.endsWith('.mjs')) }
  catch { libFiles = fs.existsSync(P.scriptsLibDir) ? fs.readdirSync(P.scriptsLibDir).filter((f) => f.endsWith('.mjs')) : [] }
  for (const f of libFiles) removeFile(path.join(P.scriptsLibDir, f))
  for (const f of ['bp-001.json', 'events.json', 'enforce-config.schema.json']) removeFile(path.join(P.contractPatternsDir, f))
  removeFile(P.contractIndexPath) // .codex/scripts/plugins/_index.json
  removeFile(path.join(P.carveoutPatternsDir, 'repo-source-carveouts.json'))
  // prune bottom-up: leaf dirs first, then their parents, each only when now empty.
  for (const d of [P.scriptsLibDir, P.contractPatternsDir, path.dirname(P.contractIndexPath), P.scriptsDir, P.carveoutPatternsDir]) pruneIfEmpty(d)

  // (c) prune an empty .codex (leave it if a user hooks.json or other files remain).
  try { if (fs.existsSync(P.codexDir) && fs.readdirSync(P.codexDir).length === 0) { fs.rmdirSync(P.codexDir); report.removedFiles.push(P.codexDir) } } catch {}
  return report
}
```

**§D — dispatch wiring (step 4.5).** install dispatch `ANCHOR → REPLACE`:

```js
// ANCHOR (verbatim, :1649):
//   if (installEnforcement && tool === 'opencode') {
//     const rep = installOpenCodeEnforcement(projectDir)
//     console.log(JSON.stringify(rep, null, 2))
//   } else if (installHooks || installEnforcement) {
// REPLACE with (inserts the codex arm; claude-code arm unchanged):
  if (installEnforcement && tool === 'opencode') {
    const rep = installOpenCodeEnforcement(projectDir)
    console.log(JSON.stringify(rep, null, 2))
  } else if (installEnforcement && tool === 'codex') {
    const rep = installCodexEnforcement(projectDir)
    console.log(JSON.stringify(rep, null, 2))
  } else if (installHooks || installEnforcement) {
```

uninstall dispatch `ANCHOR → REPLACE` (:1640-1642):

```js
// ANCHOR (verbatim):
//   const rep = tool === 'opencode'
//     ? uninstallOpenCodeEnforcement(projectDir)
//     : runUninstallEnforcement(projectDir, { purgeConfig })
// REPLACE with:
  const rep = tool === 'opencode'
    ? uninstallOpenCodeEnforcement(projectDir)
    : tool === 'codex'
      ? uninstallCodexEnforcement(projectDir)
      : runUninstallEnforcement(projectDir, { purgeConfig })
```

#### Listing S4-L2 — `tests/test-install-codex-enforcement.mjs` (verbatim, CREATE — step 4.6)

```js
/**
 * test-install-codex-enforcement.mjs — mock-project E2E for the Codex enforcement
 * install/uninstall (RFC-008 P6 S4, REQ-13). Runs the REAL install.mjs under an
 * isolated HOME + throwaway project, drives the DEPLOYED adapter (M4 — not the
 * in-repo copy), and proves per-project deploy + hooks.json MERGE + cwd-safety +
 * skill-no-collision + trust-print + uninstall.  Run: node tests/test-install-codex-enforcement.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
const INSTALL = path.join(REPO, "install.mjs");
const FORCE_ALLOW = process.env.CODEX_FORCE_ALLOW === "1"; // §A.9 red-then-green break

let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; } else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

// Mirror codexEnforcementPaths in install.mjs.
function deployed(projectDir) {
  const codexDir = path.join(projectDir, ".codex");
  const pluginDir = path.join(codexDir, "episodic-memory");
  const scriptsDir = path.join(codexDir, "scripts");
  return {
    codexDir, pluginDir, scriptsDir,
    adapter: path.join(pluginDir, "capabilities", "codex-adapter.mjs"),
    enforceContract: path.join(scriptsDir, "enforce-contract.mjs"),
    repoSource: path.join(scriptsDir, "lib", "repo-source.mjs"),
    carveouts: path.join(codexDir, "patterns", "repo-source-carveouts.json"),
    index: path.join(scriptsDir, "plugins", "_index.json"),
    // review F3: the contract-pattern closure S4-L1 copies (resolveContractRoot candidate-0
    // + schema). If any is missing, config/registry resolution fails and the gate fail-closes
    // to deny — so a passing DENY assertion could be masking an incomplete deploy.
    bp001: path.join(scriptsDir, "patterns", "bp-001.json"),
    events: path.join(scriptsDir, "patterns", "events.json"),
    schema: path.join(scriptsDir, "patterns", "enforce-config.schema.json"),
    // R5 operator kill switch lives at <markerRoot>/.episodic-memory/enforce-config.json;
    // markerRoot resolves to the project root (enforce-contract.mjs loadEnforceConfig).
    enforceConfig: path.join(projectDir, ".episodic-memory", "enforce-config.json"),
    hooksJson: path.join(codexDir, "hooks.json"),
  };
}

// §A.9 break: a 1-line always-allow stub the deny test points at when CODEX_FORCE_ALLOW=1.
function allowStub() {
  const p = path.join(os.tmpdir(), `cx-allow-stub-${process.pid}.mjs`);
  fs.writeFileSync(p, "process.exit(0)\n");
  return p;
}

// Drive the DEPLOYED adapter with a RAW codex PreToolUse stdin envelope.
function runDeployedAdapter(adapterPath, stdin, procCwd) {
  const target = FORCE_ALLOW ? allowStub() : adapterPath;
  const r = spawnSync(process.execPath, [target], {
    input: JSON.stringify(stdin), cwd: procCwd, encoding: "utf8", timeout: 15000,
  });
  let parsed = null;
  try { if (r.stdout && r.stdout.trim()) parsed = JSON.parse(r.stdout.trim()); } catch {}
  return { exit: r.status, parsed, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function preToolUseStdin(target, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "Write",
    tool_input: { filePath: target, content: "x" }, cwd, session_id: "s4-test" };
}

function freshSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cx-install-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "cx-install-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: proj });
  const projReal = fs.realpathSync(proj);
  return {
    home, proj, projReal, D: deployed(projReal),
    install: (extra, opts = {}) => spawnSync(process.execPath,
      [INSTALL, "--tool", "codex", "--project", projReal, ...extra],
      { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: home }, cwd: opts.cwd || projReal }),
    cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
                     try { fs.rmSync(proj, { recursive: true, force: true }); } catch {} },
  };
}

const USER_CMD = "node /tmp/user-precheck.js"; // sentinel: a pre-existing user hook that MUST survive
const hookCmds = (cfg) => (cfg && cfg.hooks && Array.isArray(cfg.hooks.PreToolUse))
  ? cfg.hooks.PreToolUse.flatMap((b) => (b.hooks || []).map((h) => h.command)) : [];
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

// testInstallMergesHooksJson — pre-seed a user PreToolUse hook; install KEEPS it + ADDS ours.
{
  const S = freshSandbox();
  try {
    fs.mkdirSync(S.D.codexDir, { recursive: true });
    fs.writeFileSync(S.D.hooksJson, JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: USER_CMD }] }] } }));
    const r = S.install(["--install-enforcement"]);
    assert(r.status === 0, "testInstallMergesHooksJson: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    const cmds = hookCmds(readJson(S.D.hooksJson));
    assert(cmds.includes(USER_CMD), "testInstallMergesHooksJson: user hook SURVIVES", JSON.stringify(cmds));
    assert(cmds.includes(`node ${S.D.adapter}`), "testInstallMergesHooksJson: our adapter command ADDED", JSON.stringify(cmds));
  } finally { S.cleanup(); }
}

// testInstallDeploysClosure — closure on disk + DEPLOYED adapter DENIES repo-src, ALLOWS carve-out.
{
  const S = freshSandbox();
  try {
    const r = S.install(["--install-enforcement"]);
    assert(r.status === 0, "testInstallDeploysClosure: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    for (const [k, p] of Object.entries({ adapter: S.D.adapter, enforceContract: S.D.enforceContract,
      repoSource: S.D.repoSource, carveouts: S.D.carveouts, index: S.D.index,
      bp001: S.D.bp001, events: S.D.events, schema: S.D.schema })) {
      assert(fs.existsSync(p), `testInstallDeploysClosure: deploys ${k}`, p);
    }
    fs.mkdirSync(path.join(S.projReal, "src"), { recursive: true });
    const denyTarget = path.join(S.projReal, "src", "app.mjs");
    fs.writeFileSync(denyTarget, "// x\n");
    const deny = runDeployedAdapter(S.D.adapter, preToolUseStdin(denyTarget, S.projReal), S.projReal);
    assert(deny.exit === 2, "testInstallDeploysClosure: repo-src write -> exit 2", `${deny.exit}: ${deny.stderr.slice(0, 300)}`);
    assert(deny.parsed && deny.parsed.hookSpecificOutput && deny.parsed.hookSpecificOutput.permissionDecision === "deny",
      "testInstallDeploysClosure: repo-src write -> permissionDecision deny", deny.stdout.slice(0, 300));
    // ALLOW = the §A.9 negative control: proves the DENY above is not a constant-2 stub.
    fs.mkdirSync(path.join(S.projReal, "docs", "plans"), { recursive: true });
    const allowTarget = path.join(S.projReal, "docs", "plans", "note.md");
    const allow = runDeployedAdapter(S.D.adapter, preToolUseStdin(allowTarget, S.projReal), S.projReal);
    assert(allow.exit === 0, "testInstallDeploysClosure: carve-out write -> exit 0 (neg control)", `${allow.exit}: ${allow.stderr.slice(0, 300)}`);
    assert(allow.stdout.trim() === "", "testInstallDeploysClosure: carve-out write -> no output", allow.stdout.slice(0, 300));
    // active:false control (review F3, R5): with the FULL closure present, the operator
    // kill switch MUST be honored — the SAME repo-source write flips DENY -> ALLOW (exit 0).
    // This proves the DENY above is a genuine repo-source decision, not a fail-closed deny
    // caused by an incomplete closure (config/registry resolution miss defaults to active:true).
    fs.mkdirSync(path.join(S.projReal, ".episodic-memory"), { recursive: true });
    fs.writeFileSync(S.D.enforceConfig, JSON.stringify({ active: false }));
    const silenced = runDeployedAdapter(S.D.adapter, preToolUseStdin(denyTarget, S.projReal), S.projReal);
    assert(silenced.exit === 0, "testInstallDeploysClosure: repo-src write under active:false -> exit 0 (R5 silence honored, closure resolves)", `${silenced.exit}: ${silenced.stderr.slice(0, 300)}`);
    fs.rmSync(S.D.enforceConfig, { force: true }); // restore enforcing default for any later use
  } finally { S.cleanup(); }
}

// testInstallCallerCwdSafe — caller cwd != --project: artifacts under project_root ONLY (codex F3).
{
  const S = freshSandbox();
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cx-caller-"));
  try {
    const r = S.install(["--install-enforcement"], { cwd: callerCwd });
    assert(r.status === 0, "testInstallCallerCwdSafe: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    assert(fs.existsSync(S.D.adapter), "testInstallCallerCwdSafe: adapter under project_root", S.D.adapter);
    assert(!fs.existsSync(path.join(callerCwd, ".codex")), "testInstallCallerCwdSafe: NO .codex under caller cwd", callerCwd);
    assert(!fs.existsSync(path.join(S.home, ".codex")), "testInstallCallerCwdSafe: NO .codex under HOME", S.home);
  } finally { S.cleanup(); try { fs.rmSync(callerCwd, { recursive: true, force: true }); } catch {} }
}

// testInstallRelativeProjectAbsoluteCommand — review F4 (R-F3): a RELATIVE --project must
// still yield an ABSOLUTE hooks.json command (`node <abs adapter>`). codex runs the hook from
// its OWN cwd, so a relative adapter path would break enforcement. Install cwd=projReal,
// --project=".". Without the realpath/resolve in codexEnforcementPaths this goes RED.
{
  const S = freshSandbox();
  try {
    const r = spawnSync(process.execPath,
      [INSTALL, "--tool", "codex", "--project", ".", "--install-enforcement"],
      { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: S.home }, cwd: S.projReal });
    assert(r.status === 0, "testInstallRelativeProjectAbsoluteCommand: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    const cmds = hookCmds(readJson(S.D.hooksJson));
    const ours = cmds.find((c) => c && c.startsWith("node ") && c.includes(".codex"));
    assert(!!ours, "testInstallRelativeProjectAbsoluteCommand: our adapter command present", JSON.stringify(cmds));
    assert(ours && path.isAbsolute(ours.slice("node ".length)),
      "testInstallRelativeProjectAbsoluteCommand: hooks.json command path is ABSOLUTE", String(ours));
  } finally { S.cleanup(); }
}

// testInstallNoSkillCollision — a prior `--tool codex` skill install is byte-unchanged by enforcement install.
{
  const S = freshSandbox();
  try {
    const skill = S.install([]); // bare `--tool codex` == skill install (install.mjs:937)
    assert(skill.status === 0, "testInstallNoSkillCollision: skill install exit 0", `${skill.status}`);
    const skillPath = path.join(S.projReal, ".agents", "skills", "episodic-memory", "SKILL.md");
    const before = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : null;
    assert(before !== null, "testInstallNoSkillCollision: skill file present after skill install", skillPath);
    S.install(["--install-enforcement"]);
    const after = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : null;
    assert(after === before, "testInstallNoSkillCollision: SKILL.md byte-unchanged by enforcement install");
  } finally { S.cleanup(); }
}

// testInstallPrintsTrust — install stdout instructs the operator to run /hooks (R3).
{
  const S = freshSandbox();
  try {
    const r = S.install(["--install-enforcement"]);
    assert(/\/hooks/.test(r.stdout || ""), "testInstallPrintsTrust: stdout names the /hooks trust step", (r.stdout || "").slice(0, 300));
  } finally { S.cleanup(); }
}

// testUninstallRemovesOnlyOurEntry — uninstall drops our hook + files, keeps the user hook.
{
  const S = freshSandbox();
  try {
    fs.mkdirSync(S.D.codexDir, { recursive: true });
    fs.writeFileSync(S.D.hooksJson, JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: USER_CMD }] }] } }));
    S.install(["--install-enforcement"]);
    const u = S.install(["--uninstall-enforcement"]);
    assert(u.status === 0, "testUninstallRemovesOnlyOurEntry: uninstall exit 0", `${u.status}: ${(u.stderr || "").slice(0, 300)}`);
    const cmds = hookCmds(readJson(S.D.hooksJson));
    assert(!cmds.includes(`node ${S.D.adapter}`), "testUninstallRemovesOnlyOurEntry: our hook removed", JSON.stringify(cmds));
    assert(cmds.includes(USER_CMD), "testUninstallRemovesOnlyOurEntry: user hook PRESERVED", JSON.stringify(cmds));
    assert(!fs.existsSync(S.D.pluginDir), "testUninstallRemovesOnlyOurEntry: pluginDir removed", S.D.pluginDir);
    assert(!fs.existsSync(S.D.scriptsDir), "testUninstallRemovesOnlyOurEntry: scriptsDir removed (empty case)", S.D.scriptsDir);
  } finally { S.cleanup(); }
}

// testUninstallPreservesUserFilesInSharedDirs — review F1 (r2): unrelated user files pre-seeded
// inside the GENERIC dirs our closure shares (.codex/scripts/{lib,patterns,plugins}, .codex/patterns)
// MUST survive uninstall; our own closure files must be gone; the shared dir is kept (not pruned)
// because it still holds the user's file. Complements the empty-dir case above.
{
  const S = freshSandbox();
  try {
    S.install(["--install-enforcement"]);
    const userFiles = [
      path.join(S.D.scriptsDir, "lib", "user-helper.mjs"),
      path.join(S.D.scriptsDir, "patterns", "user-notes.json"),
      path.join(S.D.scriptsDir, "plugins", "user-plugin.json"),
      path.join(S.D.codexDir, "patterns", "user-carveout.json"),
    ];
    for (const p of userFiles) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "// user\n"); }
    const u = S.install(["--uninstall-enforcement"]);
    assert(u.status === 0, "testUninstallPreservesUserFilesInSharedDirs: uninstall exit 0", `${u.status}: ${(u.stderr || "").slice(0, 300)}`);
    for (const p of userFiles) assert(fs.existsSync(p), "testUninstallPreservesUserFilesInSharedDirs: user file SURVIVES uninstall", p);
    assert(!fs.existsSync(S.D.enforceContract), "testUninstallPreservesUserFilesInSharedDirs: our enforce-contract.mjs removed", S.D.enforceContract);
    assert(!fs.existsSync(S.D.repoSource), "testUninstallPreservesUserFilesInSharedDirs: our lib/repo-source.mjs removed", S.D.repoSource);
    assert(fs.existsSync(S.D.scriptsDir), "testUninstallPreservesUserFilesInSharedDirs: scriptsDir KEPT (holds user files)", S.D.scriptsDir);
  } finally { S.cleanup(); }
}

console.log(`\ntest-install-codex-enforcement: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all codex install/uninstall E2E tests passed");
```

#### Listing S4-L3 — `enforcementProof` appended to `tests/integration/codex-tmux-e2e.mjs` (step 4.7)

```js
// Append after testTrustGate; register it in main() as ['enforcementProof', testEnforcementProof].
// UNGUARDED-IN-CI (real codex + tmux). Drives the DEPLOYED per-project adapter (post REAL
// install), discriminating pair. Review F2: this uses the harness's ACTUAL helpers
// (have/tmuxFactory/startCodex/waitFor/waitIdle/pastePrompt/sleepMs/assert, execFileSync) —
// there is NO hasBin/buildMockProject/trust/INSTALL/spawnSync in this file. Add
// `import { fileURLToPath } from 'node:url'` to the import block at the top of the file.

// A capture-hook-free mock: enforcement comes from the REAL install below, not makeMock's
// logging hook. Mirrors makeMock's git seed but writes NO .codex/hooks.json.
function bareMock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-enforce-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'probe@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'probe']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# mock codex project\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed']);
  return dir;
}

// Two SEQUENTIAL single-file apply_patch calls (review F2 — the discriminating-logic fix):
// a single MIXED patch that touches a repo-source path is denied WHOLESALE, so the ALLOW
// half is never observable from the same call. Split them: docs/plans first (ALLOWED ->
// file written), src second (DENIED -> pane shows deny, file absent).
const ENFORCE_PROMPT =
  'Make two SEPARATE apply_patch calls, in this order, and run no shell commands:\n' +
  '1) First call: one apply_patch that adds ONLY docs/plans/note.md whose single line is: # note\n' +
  '2) Second call: one apply_patch that adds ONLY src/probe.mjs whose single line is: export const probe = 42;\n' +
  'Proceed without asking for confirmation. If a call is blocked, continue to the next.';

function testEnforcementProof() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(here, '..', '..');
  const INSTALL = path.join(REPO, 'install.mjs');
  const dir = bareMock();
  // Install the REAL per-project enforcement (writes .codex/hooks.json + closure).
  const ins = execFileSync(process.execPath,
    [INSTALL, '--tool', 'codex', '--project', dir, '--install-enforcement'], { encoding: 'utf8' });
  assert(/\/hooks/.test(ins), `enforcementProof: install must print the /hooks trust instruction.\n${ins}`);
  const sock = `codex-enforce-${process.pid}`;
  const win = 'codex:0';
  const t = tmuxFactory(sock);
  try {
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server yet */ }
    startCodex(t, win, dir);
    waitFor(t, win, /trust the contents of this directory/i, 30000, 'dir-trust');
    t('send-keys', '-t', win, 'Enter');                            // option 1: Yes, continue
    waitFor(t, win, /Hooks need review|hook is new or changed/i, 30000, 'hook-trust');
    t('send-keys', '-t', win, '2', 'Enter');                       // Trust all and continue
    waitFor(t, win, /gpt-5\.5\s+(high|medium|low|default|minimal)/i, 45000, 'model-ready');
    sleepMs(3000);
    pastePrompt(t, win, ENFORCE_PROMPT);
    sleepMs(2000);
    waitIdle(t, win, 240000);
    sleepMs(2500);                                                 // let the deny FULLY render
    const pane = capture(t, win, 400);                             // capture AFTER the settle (review F2 r2)
    const deniedSrc = /src\/probe\.mjs/.test(pane) && /deny|denied|blocked|not permitted|permission/i.test(pane);
    const allowedDocs = fs.existsSync(path.join(dir, 'docs', 'plans', 'note.md'));
    const blockedSrc = !fs.existsSync(path.join(dir, 'src', 'probe.mjs'));
    fs.writeFileSync(path.join(os.tmpdir(), `enforcementProof-${process.pid}.pane`), pane);
    assert(deniedSrc && allowedDocs && blockedSrc,
      `enforcementProof: expected repo-source src/probe.mjs DENIED and docs/plans/note.md ALLOWED.\n` +
      `deniedSrc=${deniedSrc} allowedDocs=${allowedDocs} blockedSrc=${blockedSrc}\n--- pane ---\n${pane}`);
  } finally {
    try { t('kill-server'); } catch { /* already gone */ }
  }
}
```

### `P6-S5` — CI wiring + runbook finalize + docs DONE (REQ-17, Rule 10)

**Files (one concern per step):** `.github/workflows/plugin-validate.yml` (5.1-5.4),
`tests/test-codex-fixture-smoke.mjs` (CREATE, 5.4), `plugins/codex/runbooks/*.md` (5.5 verify/finalize),
`docs/rfcs/RFC-008/P5-P7-tool-plugins.md` (5.6), `_repo-context.md` + any present index (5.7).
**Read-only:** `plugin-validate.yml:41` (Node 24) + opencode step block :61-83; P5 DONE precedent
(`f5dbaef`).

| Step | File | Kind | Exact action (anchor + literal change) | Verify (falsifiable) |
|---|---|---|---|---|
| 5.0 | — | — | Pre-flight §A.4. | passes |
| 5.1 | `.github/workflows/plugin-validate.yml` | EDIT | After the opencode gauntlet step (ANCHOR `node scripts/test-plugin.mjs --project "$GITHUB_WORKSPACE" --harness opencode`, ~:61-62) ADD a step `Run codex plugin gauntlet` → `node scripts/test-plugin.mjs --project "$GITHUB_WORKSPACE" --harness codex`. (Step is parametric — no script change.) | `grep -c "harness codex" .github/workflows/plugin-validate.yml` → ≥1 |
| 5.2 | `plugin-validate.yml` | EDIT | After the opencode adapter-conformance step (ANCHOR `node tests/test-opencode-adapter-conformance.mjs`, ~:79-80) ADD `Run codex adapter conformance` → `node tests/test-codex-adapter-conformance.mjs`. | `grep -c "test-codex-adapter-conformance" .github/workflows/plugin-validate.yml` → 1 |
| 5.3 | `plugin-validate.yml` | EDIT | After the opencode install E2E step (ANCHOR `node tests/test-install-opencode-enforcement.mjs`, ~:82-83) ADD `Run codex install/uninstall E2E` → `node tests/test-install-codex-enforcement.mjs`. | `grep -c "test-install-codex-enforcement" .github/workflows/plugin-validate.yml` → 1 |
| 5.4 | `tests/test-codex-fixture-smoke.mjs` | CREATE | Whole-file. **Exact verbatim contents = Listing S5-L1** (CI-guardable, no codex binary): asserts the fixture parses + has an integer `turn_index`, exact `hook_event_name === "PreToolUse"` and `tool_name === "apply_patch"` (not a substring), and both Add File directives in `tool_input.command`; and the runbook §9 agent-manifest block has `expected_outputs.shape === "codex-native"`, a `node` `command_shapes[0]` argv, and a `return_codes` map containing `"2"` — every operand is the parsed file/runbook value, never a constant. | `node tests/test-codex-fixture-smoke.mjs` → `… passed, 0 failed` |
| 5.4b | `.github/workflows/plugin-validate.yml` | EDIT | After 5.3's codex install-E2E step ADD the verbatim yaml step `      - name: Run codex fixture + runbook §9 smoke (REQ-17)` / `        run: node tests/test-codex-fixture-smoke.mjs`. | `grep -c "test-codex-fixture-smoke" .github/workflows/plugin-validate.yml` → 1 |
| 5.4c | `tests/test-codex-fixture-smoke.mjs` | — (verify) | **Red-then-green (§A.9):** the smoke must go RED if the runbook §9 shape regresses. Point it at a broken runbook via env (Listing S5-L1 honors `SMOKE_RUNBOOK=<path>`); feed a copy whose `shape` is reverted to `json-object`. | `SMOKE_RUNBOOK=/tmp/bad-runbook.md node tests/test-codex-fixture-smoke.mjs` → exits NON-zero (shape assertion fails) |
| 5.5 | `plugins/codex/runbooks/enforcement.md` (+`.quickref.md`) | VERIFY/EDIT | Confirm the 10-section runbook is complete + M7e-valid; finalize §10 `install_time_config` now that S4 fixed the layout — name `.codex/hooks.json` + `.codex/episodic-memory/`. | `node scripts/validate-plugin-registry.mjs --project .` → exit 0; `grep -c "\.codex/hooks.json" plugins/codex/runbooks/enforcement.md` → ≥1 |
| 5.6 | `docs/rfcs/RFC-008/P5-P7-tool-plugins.md` | EDIT | Set the P6 status cell (ANCHOR the P6 status line) → `P6 DONE`; confirm the P6 plugin row (`plugins/codex/`, `pre_tool_use: MEDIUM`) + the MEDIUM honesty note are present. (`plugins/_index.json` codex entry already `status:"active"` from S2 — NO edit.) | `grep -c "P6 DONE" docs/rfcs/RFC-008/P5-P7-tool-plugins.md` → 1 |
| 5.7 | `_repo-context.md` (+ `rfc-validate.yml` stale-grep) | EDIT | Rule 10 index sync: update the RFC-008 phase line for P6 in `_repo-context.md`; update the `rfc-validate.yml` stale-phase grep (~:189-194) if it gates phase status. **CONFIRM via `ls` that `docs/README.md` + `docs/_index.json` do NOT exist at repo root (explorer 2026-06-28) — SKIP if absent.** | `grep -n "P6" _repo-context.md` → updated; `node -e "JSON.parse(require('fs').readFileSync('<any touched .json>','utf8'))"` exits 0 |
| 5.8 | — | — | Confirm the stop-STRONG + schema/binding follow-up issue is filed (OD-4 = #429, S0) and tick the §18 done-criteria boxes. | `gh issue view 429 --json state` → open; §18 boxes checked |
| 5.9 | — | — | **PR-level whole-branch review** of the full S0-S5 diff (`…697c`) BEFORE opening the PR — interactive codex via cmux. Disposition all findings; file deferred per step 9; reply-episode in §19. | whole-branch review reply-episode in §19; 0 blockers remaining |
| 5.10 | — | — | Commit `P6-S5: codex CI wiring (gauntlet + conformance + install E2E + fixture smoke) + runbook finalize + RFC/index P6 DONE (R6, R10)` + trailer; mark P6 DONE in indexes; open PR (Rule 17, bot `--comment` review, user approves). | `git log -1 --oneline` → `P6-S5`; `grep "P6 DONE"` in indexes |

#### Listing S5-L1 — `tests/test-codex-fixture-smoke.mjs` (verbatim, CREATE — step 5.4)

```js
/**
 * test-codex-fixture-smoke.mjs — CI-guardable smoke (RFC-008 P6 S5, REQ-17): no
 * codex binary required. Validates the recorded fixture shape + the runbook §9
 * agent-invocation manifest (codex-native shape, node command_shapes, return_codes).
 * Run: node tests/test-codex-fixture-smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
let pass = 0, fail = 0; const failures = [];
function assert(c, n, d = "") { if (c) pass++; else { fail++; failures.push(`${n}${d ? " — " + d : ""}`); } }

// (a) fixture: parses, integer turn_index, apply_patch present.
const fxPath = path.join(REPO, "tests", "fixtures", "harness-events", "codex", "pre-tool-use.json");
let fx = null;
try { fx = JSON.parse(fs.readFileSync(fxPath, "utf8")); } catch (e) { fail++; failures.push(`fixture parse: ${e.message}`); }
assert(fx && Number.isInteger(fx.turn_index), "fixture: turn_index is an integer", fx ? String(fx.turn_index) : "no fixture");
// Strong, non-self-satisfying assertions (review F5): a bare /apply_patch/ substring
// match is met by the fixture's own _note text, so it survives a tool_name regression.
// Assert the structural fields + both Add File directives in the patch body instead.
assert(fx && fx.hook_event_name === "PreToolUse", "fixture: hook_event_name === PreToolUse", fx ? String(fx.hook_event_name) : "no fixture");
assert(fx && fx.tool_name === "apply_patch", "fixture: tool_name === apply_patch (exact, not substring)", fx ? String(fx.tool_name) : "no fixture");
assert(fx && fx.tool_input && typeof fx.tool_input.command === "string"
  && /^\*\*\* Add File: src\/probe\.mjs$/m.test(fx.tool_input.command)
  && /^\*\*\* Add File: docs\/plans\/note\.md$/m.test(fx.tool_input.command),
  "fixture: apply_patch command carries BOTH Add File directives",
  fx && fx.tool_input ? String(fx.tool_input.command).slice(0, 200) : "no tool_input");

// (b) runbook §9 agent-invocation manifest block (SMOKE_RUNBOOK override = §A.9 red-then-green break).
const rbPath = process.env.SMOKE_RUNBOOK || path.join(REPO, "plugins", "codex", "runbooks", "enforcement.md");
const rb = fs.readFileSync(rbPath, "utf8");
const m = rb.match(/##\s*🤖 Agent invocation manifest\s*\n+```json\n([\s\S]*?)\n```/);
assert(!!m, "runbook: sentinel-anchored agent-manifest json block present");
let am = null;
if (m) { try { am = JSON.parse(m[1]); } catch (e) { fail++; failures.push(`runbook §9 parse: ${e.message}`); } }
assert(am && am.expected_outputs && am.expected_outputs.shape === "codex-native",
  "runbook: expected_outputs.shape === codex-native", am ? JSON.stringify(am.expected_outputs) : "no block");
assert(am && Array.isArray(am.command_shapes) && am.command_shapes.length >= 1
  && Array.isArray(am.command_shapes[0]) && am.command_shapes[0][0] === "node",
  "runbook: command_shapes[0] is a node argv", am ? JSON.stringify(am.command_shapes) : "no block");
assert(am && am.return_codes && Object.prototype.hasOwnProperty.call(am.return_codes, "2"),
  "runbook: return_codes closed map includes \"2\"", am ? JSON.stringify(am.return_codes) : "no block");

console.log(`\ntest-codex-fixture-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error("\nFAILURES:"); for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
console.log("✓ codex fixture + runbook §9 smoke passed");
```

## A.8 Definition of done (mechanical)

```bash
node tests/test-codex-adapter-conformance.mjs                  # → 37/37 pass
node tests/test-install-codex-enforcement.mjs                 # → 45 passed, 0 failed (9 scenarios, S4)
node scripts/test-plugin.mjs --project . --harness codex      # → 7 pass, 2 deferred-P3, 0 fail — OK
node scripts/test-plugin.mjs --project . --harness opencode   # → 7 pass, 2 deferred-P3, 0 fail — OK (regression)
node scripts/test-plugin.mjs --project . --harness claude-code # → OK (step-9 exit-code-only branch intact)
node tools/deploy-audit.mjs                                    # → clean (substrate scope)
```

Plus the manuals (UNGUARDED-IN-CI): `node tests/integration/codex-tmux-e2e.mjs --firing` and
`--enforcement` against real `codex 0.141.0` (REQ-14/15) — pane captures pasted into §15. Green =
`status:ok` (fail==0), never a raw pass-count.

## A.9 Blast-radius patterns applied

- **Red-then-green:** `testFailClosed` (4), `testImportFailClosed`, `testCwdRelative`,
  `testApplyPatchUnparseableDenies`, `testApplyPatchMarkerBundleAllows`, `testBashReadOnlyAllows`.
- **No extra process:** adapter imports the waist directly (B1) — zero spawn surface to fail open.
- **Discriminating sentinel:** `testCwdDivergence` asserts the sandbox sentinel in the deny reason;
  tmux `enforcementProof` uses a discriminating pair (repo-source denied AND docs/plans allowed).
- **Flag high-blast slice:** S3 (`test-plugin.mjs`) **focused-review-before-build**; A.8 reruns all 3 harnesses.
- **Fixture-change ledger:** S0 keeps the codex pre_tool_use tier cells at MEDIUM and corrects ONLY
  the rationale (refuted multi-edit basis → Bash-lexing residual) for the delivered event, and LEAVES
  stop/session_start (deferred) — so no half-edited min() row for the delivered event (reviewer N4
  honored, r6).
- **Mock-project E2E:** S4 via real `install.mjs`; S1/S4 tmux drive real `codex`.
