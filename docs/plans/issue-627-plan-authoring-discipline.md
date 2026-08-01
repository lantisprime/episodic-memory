# Plan: issue #627 — plan-authoring discipline (self-counting verifies, prose-is-not-a-Listing)

**Issue:** #627. **Status:** FROZEN AT DISPATCH (playbook v5 seat contract). **Slice:** 627-1 (single slice, single commit).
**Branch:** `fix-627-plan-authoring-discipline`.

## §1 Problem

Two plan-authoring defect classes surfaced executing `docs/plans/rfc-015-p1-s2.md` (PR #625):

- **Class A** — step 1.13's Verify demanded `grep -c "catch {}"` drop by exactly 1, but Listing L9's
  comment re-introduces the counted string; the delta can never land (observed 29 → 29). The general
  defect is a **relative** count expectation over a pattern the step's own Listing contains.
- **Class B** — step 1.15 named both apply envelopes; Listing L11 coded only the legacy one. Prose
  described the clerk site, which correctly STOPped a disciplined executor (§A.2.3) and cost a round
  trip on a MUST requirement.

Corpus sweep (2026-08-01, two-scout pass over all 31 committed plans) found: one additional Class B
instance (`rfc-008-p6-codex-enforcement-plugin.md` step 3.5, 0-of-2 sites coded — follow-up, not this
PR); one unresolved unfalsifiable-relative verify (`em-search-read-paging.md` step 3.4 — same family,
follow-up); and multiple plans (`fix-635`, `rfc-015-p1-s3a`, `rfc-009-p3`) already practicing explicit
anti-self-counting defenses. The corpus norm for sound count verifies is **absolute observed →
expected values that account for occurrences the Listing itself introduces** — so the lint targets
relative-delta expectations, not every Listing-contained pattern (which would flag every legitimate
`grep -c 'export function X'` → 1 row).

## §2 Requirements

- **REQ-1 (MUST)** `docs/PLAN_TEMPLATE.md` §A.6b deny-list names the Class A shape: a relative count
  expectation over a pattern appearing anywhere in the step's own Listing/`REPLACE` text, comments
  included, is a planning bug; count Verifies state absolute observed → expected values accounting
  for Listing-introduced occurrences.
- **REQ-2 (MUST)** §A.7 executor-ready gate names the Class B rule: a step whose scope names N edit
  sites is backed by N fenced code blocks; prose describing a site is not a Listing.
- **REQ-3 (MUST)** A mechanical lint `scripts/validate-plan-listing-discipline.mjs` (zero-dep ESM,
  JSON to stdout) flags Class A as DEFECT (exit 1) and unfalsifiable-relative verifies as WARN
  (exit 0). It supports `<!-- plan-lint: accepted-defect step <n.m> ... -->` suppression markers
  (post-execution errata; shrink-only spirit of the #504 baseline) and a `--strict` flag that
  ignores them.
- **REQ-4 (MUST)** The lint detects the known real instance: `--strict` on
  `docs/plans/rfc-015-p1-s2.md` exits 1 naming step 1.13 / Listing L9 / pattern `catch {}`.
- **REQ-5 (MUST)** Test suite `tests/test-plan-listing-discipline.mjs` (5 checks incl. the REQ-4
  regression and a negative control via `BREAK_PLAN_LINT=1`), registered in `tests.yml`.
- **REQ-6 (MUST)** CI runs the lint on every changed `docs/plans/*.md` in PRs (new workflow
  `plan-lint.yml`, modeled on `rfc-validate.yml` path-trigger; changed-files-only so the 31
  historical plans are not retro-flagged).
- **REQ-7 (SHOULD)** `rfc-015-p1-s2.md` gains a post-execution Errata section documenting both
  defects, carrying the suppression marker so this PR's own CI stays green.
- **REQ-8 (MUST)** `.claude-plugin/plugin.json` version bumps 0.2.0 → 0.2.1 (new file under
  `scripts/` is plugin content; FIX-644 gate).

## §3 Non-goals / follow-ups (issue comments, not this PR)

- Fixing `rfc-008-p6` step 3.5 (unexecuted plan; needs its own authored Listings — flag on #627
  before that plan is executed).
- Retro-fixing `em-search-read-paging.md` 3.4 (executed, historical).
- Mechanizing Class B (natural-language site counting is not reliably mechanical; it lands as
  template text + review discipline).
- No changes to any `scripts/em-*.mjs` substrate code.

## §7 Safety

Lint is read-only over given paths; no store writes; no network. Workflow runs on `pull_request`
only, no secrets touched. Suppression markers are visible in-diff and reviewable.

---

# Appendix A

## A.0 Runtime

Node ≥ 20 ESM, zero deps, repo root as cwd. Break-input override for the suite: `BREAK_PLAN_LINT=1`.

## A.2/A.3 Executor contract & STOP protocol

Per `docs/PLAN_TEMPLATE.md` §A.2/§A.3 verbatim. Copy each Listing exactly; write no code outside
Listings; one file per step; STOP on any anchor miss.

## A.4 Pre-flight (step 1.0)

| Check | Command | Expected |
|---|---|---|
| Branch | `git branch --show-current` | `fix-627-plan-authoring-discipline` |
| No tracked changes | `git status --porcelain` | only `??` (untracked) lines — no modified/staged tracked files |
| Baseline suite lint | `node tests/test-ci-suite-registration.mjs` | pass (exit 0) |

## A.7 Step table — slice 627-1

**Files this slice may touch:** `docs/PLAN_TEMPLATE.md`, `scripts/validate-plan-listing-discipline.mjs`,
`tests/test-plan-listing-discipline.mjs`, `.github/workflows/plan-lint.yml`,
`.github/workflows/tests.yml`, `docs/plans/rfc-015-p1-s2.md`, `.claude-plugin/plugin.json`.
**Read-only:** everything else, notably `docs/plans/fix-626-consolidate-init-guard.md`,
`docs/plans/PLAN-session-auto-capture.md`, `.github/workflows/rfc-validate.yml`.

| Step | File | Kind | Exact action (anchor + literal change) | Verify (observed → expected; falsifiable, §A.6b) |
|---|---|---|---|---|
| 1.0 | — | — | Pre-flight §A.4. | every row passes |
| 1.1 | `docs/PLAN_TEMPLATE.md` | **EDIT** | Extend the §A.6b deny-list per **Listing L1**. | `grep -c "the delta can never land" docs/PLAN_TEMPLATE.md` → 1 |
| 1.2 | `docs/PLAN_TEMPLATE.md` | **EDIT** | Replace the "until a lint exists" author-obligation sentence per **Listing L2**. | `grep -c "validate-plan-listing-discipline" docs/PLAN_TEMPLATE.md` → 1 |
| 1.3 | `docs/PLAN_TEMPLATE.md` | **EDIT** | Add the N-sites/N-code-blocks rule to the §A.7 executor-ready gate per **Listing L3**. | `grep -c "prose describing a site is not a Listing" docs/PLAN_TEMPLATE.md` → 1 |
| 1.4 | `scripts/validate-plan-listing-discipline.mjs` | **CREATE** | Full verbatim contents = **Listing L4**. | `node scripts/validate-plan-listing-discipline.mjs docs/plans/fix-626-consolidate-init-guard.md` → exit 0, stdout JSON `"status": "ok"` with zero defects |
| 1.4b | `scripts/validate-plan-listing-discipline.mjs` | **EDIT** | Replace each of the two raw NUL (0x00) bytes inside the two `replaceAll` calls of `extractStepRows` with the six-character escape sequence `\u0000` (source becomes pure text; runtime string value unchanged). Amended Listing L4 shows the corrected lines. Added at fold-prep: raw NULs make git treat the file as binary in diffs. | `tr -dc '\0' < scripts/validate-plan-listing-discipline.mjs` piped to `wc -c` → 0 |
| 1.5 | `tests/test-plan-listing-discipline.mjs` | **CREATE** | Full verbatim contents = **Listing L5**. | `node tests/test-plan-listing-discipline.mjs` → stdout JSON `{"suite":"plan-listing-discipline","pass":5,"fail":0}`, exit 0 |
| 1.5b | — | — | Negative control (§A.9): break-input run. | `BREAK_PLAN_LINT=1 node tests/test-plan-listing-discipline.mjs` → non-zero exit |
| 1.4c | `scripts/validate-plan-listing-discipline.mjs` | **EDIT** | Fence-guard suppression markers per **Listing L9** (review finding R1: a marker inside a fenced code block must be inert; two edit sites, both coded in L9). Added post-review. | `node scripts/validate-plan-listing-discipline.mjs docs/plans/rfc-015-p1-s2.md` → exit 0, the 1.13 defect still under `accepted` (prose marker outside any fence keeps working) |
| 1.5c | `tests/test-plan-listing-discipline.mjs` | **EDIT** | Add check t6 per **Listing L10**: an in-fence suppression marker does not suppress. Added post-review. | `node tests/test-plan-listing-discipline.mjs` → stdout JSON `{"suite":"plan-listing-discipline","pass":6,"fail":0}`, exit 0 |
| 1.6 | `.github/workflows/plan-lint.yml` | **CREATE** | Full verbatim contents = **Listing L6**. | `grep -c "validate-plan-listing-discipline" .github/workflows/plan-lint.yml` → 2 (both L6-introduced occurrences: the `paths:` trigger entry and the `run:` line — corrected from 1 at the seat's §A.3 STOP; original count missed one L6 occurrence, the exact §A.6b class this plan closes) |
| 1.7 | `.github/workflows/tests.yml` | **EDIT** | Register the suite per **Listing L7**. | `node tests/test-ci-suite-registration.mjs` → pass (exit 0) |
| 1.8 | `docs/plans/rfc-015-p1-s2.md` | **APPEND** | Append the Errata section = **Listing L8** at end of file. | `grep -c "accepted-defect step 1.13" docs/plans/rfc-015-p1-s2.md` → 1 |
| 1.9 | `.claude-plugin/plugin.json` | **EDIT** | `ANCHOR:` `"version": "0.2.0",` → `REPLACE:` `"version": "0.2.1",` | `grep -c "\"version\": \"0.2.1\"" .claude-plugin/plugin.json` → 1 |
| 1.10 | — | — | Known-instance regression, visible artifact (REQ-4). | `node scripts/validate-plan-listing-discipline.mjs --strict docs/plans/rfc-015-p1-s2.md` → exit 1, JSON defect with `"step": "1.13"`, `"listing": "L9"` |
| 1.10b | — | — | Suppression honored (REQ-7): non-strict run on the same file. | `node scripts/validate-plan-listing-discipline.mjs docs/plans/rfc-015-p1-s2.md` → exit 0, JSON `"status": "ok"` with the 1.13 defect listed under `accepted` |
| 1.11 | — | — | Self-clean (dogfood): lint this plan document. | `node scripts/validate-plan-listing-discipline.mjs docs/plans/issue-627-plan-authoring-discipline.md` → exit 0, `"status": "ok"` |
| 1.12 | — | — | Commit all touched files: `FIX-627-1: plan-authoring discipline — template rules + listing lint (fixes #627)` + required trailer. | `git log -1 --oneline` → shows `FIX-627-1` |

## A.10 Listings (copy verbatim; the executor writes no code outside these)

### Listing L1 — §A.6b deny-list extension (step 1.1)

`ANCHOR` (verbatim, unique):

```text
- greps for a literal string the step *itself* writes into a comment, `echo`, or heredoc
  (self-fulfilling — it proves only that the author can type);
```

`REPLACE` with:

```text
- greps for a literal string the step *itself* writes into a comment, `echo`, or heredoc
  (self-fulfilling — it proves only that the author can type);
- states a **relative** count expectation ("decreases by 1", "drops from the baseline") over a
  pattern that appears **anywhere in the step's own Listing or `REPLACE` text, comments included** —
  the paste re-introduces the counted string, so the delta can never land (issue #627). Count-based
  Verifies state absolute observed → expected values and explicitly account for every occurrence
  their own Listing introduces;
```

### Listing L2 — §A.6b author-obligation lint pointer (step 1.2)

`ANCHOR` (verbatim, unique):

```text
Author obligation, discharged by hand until a lint exists: scan every Verify cell; any cell missing either the observed value or the expected value marks the
row as not-executor-ready.
```

`REPLACE` with:

```text
Author obligation: scan every Verify cell; any cell missing either the observed value or the expected value marks the
row as not-executor-ready. The relative-count subset is mechanized — run
`node scripts/validate-plan-listing-discipline.mjs <plan.md>` (CI lints every changed
`docs/plans/*.md`); the rest of the scan is still discharged by hand.
```

### Listing L3 — §A.7 executor-ready gate, N-sites rule (step 1.3)

`ANCHOR` (verbatim, unique):

```text
or in §A.5); every Verify passes §A.6b. A step that would touch a second file, rewrite a whole
```

`REPLACE` with:

```text
or in §A.5); every Verify passes §A.6b; **a step whose scope names N edit sites is backed by N
fenced code blocks** (in its Listing or inline) — prose describing a site is not a Listing, and a
step that codes some named sites while describing others will STOP a disciplined executor
(§A.2.3; issue #627). A step that would touch a second file, rewrite a whole
```

### Listing L4 — `scripts/validate-plan-listing-discipline.mjs` (step 1.4, full file)

```js
#!/usr/bin/env node
// validate-plan-listing-discipline.mjs — issue #627 plan-authoring lint.
//
// CLASS A (DEFECT, exit 1): a §A.7 step's grep-count Verify states a RELATIVE
// expectation (decrease/increase/delta with no absolute observed → expected
// numbers) while a Listing the step references contains the counted pattern —
// the paste re-introduces the string, so the delta can never land as written.
// R2 (WARN, exit 0): a grep-count Verify is relative with no absolute numbers
// at all (unfalsifiable without a recorded baseline).
//
// Suppression: a line `<!-- plan-lint: accepted-defect step <n.m> ... -->`
// moves that step's Class A defect to `accepted` (post-execution errata for
// historical plans). `--strict` ignores suppressions (regression testing).
//
// Known limits (v1, by design): only quoted grep patterns are parsed; step
// rows and Listing headings inside fenced code blocks are ignored; plans with
// no step tables pass vacuously.
//
// Usage: node scripts/validate-plan-listing-discipline.mjs [--strict] <plan.md> [more...]
// JSON to stdout; exit 0 ok / 1 defect / 2 usage.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const GREP_COUNT_RE = /grep\s+-[a-zA-Z]*c[a-zA-Z]*\s+(['"])(.+?)\1\s+([^\s|;&`]+)/g;
const RELATIVE_RE = /\b(?:decrea\w*|increa\w*|drops?\s+by|goes\s+(?:up|down)|delta\b|from\s+the\s+baseline)/i;
const ABSOLUTE_RE = /(?:→|->)\s*\**`?\d+|\b\d+\s+before\b[^|]*?\b\d+\s+after\b/;
const LISTING_REF_RE = /\bListing\s+(L\d+[a-z]?)\b/g;
const LISTING_HEAD_RE = /^#{2,4}\s.*\bListing\s+(L\d+[a-z]?)\b/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const SUPPRESS_RE = /<!--\s*plan-lint:\s*accepted-defect\s+step\s+([\w.]+)/g;

function extractListings(lines) {
  const listings = new Map();
  let current = null;
  let inFence = false;
  let buf = [];
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const head = line.match(LISTING_HEAD_RE);
      if (head) {
        if (current) listings.set(current, { line: startLine, code: buf.join('\n') });
        current = head[1];
        buf = [];
        startLine = i + 1;
        continue;
      }
      if (current && /^#{1,4}\s/.test(line)) {
        listings.set(current, { line: startLine, code: buf.join('\n') });
        current = null;
        continue;
      }
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (current && inFence) buf.push(line);
  }
  if (current) listings.set(current, { line: startLine, code: buf.join('\n') });
  return listings;
}

function extractStepRows(lines) {
  const rows = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.startsWith('|')) continue;
    const cells = line.replaceAll('\\|', '\u0000').split('|').slice(1, -1)
      .map((c) => c.replaceAll('\u0000', '\\|').trim());
    if (cells.length < 4) continue;
    const step = cells[0].replace(/\*/g, '');
    if (!/^\d+(?:\.\d+)?[a-z]?$/.test(step)) continue;
    rows.push({
      line: i + 1,
      step,
      file: cells[1].replace(/[`*]/g, ''),
      action: cells.slice(2, -1).join(' '),
      verify: cells[cells.length - 1],
    });
  }
  return rows;
}

function extractSuppressed(text) {
  const set = new Set();
  for (const m of text.matchAll(SUPPRESS_RE)) set.add(m[1]);
  return set;
}

function lintFile(path, strict) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const listings = extractListings(lines);
  const rows = extractStepRows(lines);
  const suppressed = strict ? new Set() : extractSuppressed(text);
  const defects = [];
  const accepted = [];
  const warns = [];
  let checked = 0;
  for (const row of rows) {
    for (const m of row.verify.matchAll(GREP_COUNT_RE)) {
      checked++;
      const pattern = m[2];
      const target = m[3].replace(/[`*]/g, '');
      const relative = RELATIVE_RE.test(row.verify) && !ABSOLUTE_RE.test(row.verify);
      if (!relative) continue;
      let hit = null;
      for (const ref of row.action.matchAll(LISTING_REF_RE)) {
        const l = listings.get(ref[1]);
        if (l && l.code.includes(pattern) && row.file === target) {
          hit = { listing: ref[1], listing_line: l.line };
          break;
        }
      }
      if (hit) {
        const finding = {
          class: 'A',
          step: row.step,
          row_line: row.line,
          file: row.file,
          pattern,
          ...hit,
          reason: 'relative-count verify counts a pattern its own Listing re-introduces (issue #627)',
        };
        if (suppressed.has(row.step)) accepted.push(finding);
        else defects.push(finding);
      } else {
        warns.push({
          class: 'R2',
          step: row.step,
          row_line: row.line,
          pattern,
          reason: 'relative-count verify with no absolute observed/expected values',
        });
      }
    }
  }
  return { file: path, steps: rows.length, grep_count_verifies: checked, defects, accepted, warns };
}

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const files = argv.filter((a) => a !== '--strict');
if (files.length === 0) {
  console.log(JSON.stringify({ status: 'error', error: 'usage: validate-plan-listing-discipline.mjs [--strict] <plan.md> [...]' }));
  process.exit(2);
}
const results = files.map((f) => lintFile(f, strict));
const status = results.some((r) => r.defects.length > 0) ? 'defect' : 'ok';
console.log(JSON.stringify({ status, strict, files: results }, null, 2));
process.exit(status === 'defect' ? 1 : 0);
```

### Listing L5 — `tests/test-plan-listing-discipline.mjs` (step 1.5, full file)

```js
#!/usr/bin/env node
// test-plan-listing-discipline.mjs — suite for the issue #627 lint.
// Run from repo root: node tests/test-plan-listing-discipline.mjs
// Negative control: BREAK_PLAN_LINT=1 makes the "clean" fixture defective, so
// t2 must fail and the suite must exit non-zero (§A.9 red-then-green).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const LINT = 'scripts/validate-plan-listing-discipline.mjs';
const BREAK = process.env.BREAK_PLAN_LINT === '1';

const DEFECTIVE = [
  '# Fixture plan (defective)',
  '## A.7 Steps',
  '| Step | File | Kind | Exact action (anchor + literal change) | Verify |',
  '|---|---|---|---|---|',
  '| 1.1 | `src/a.mjs` | **EDIT** | Remove the bare catch per **Listing L1**. | `grep -c "catch {}" src/a.mjs` → observed count decreases by exactly 1 from the baseline |',
  '',
  '## A.10 Listings',
  '### Listing L1 — replacement (step 1.1)',
  '```js',
  '} catch (err) {',
  '  // the bare catch {} that used to wrap this is the anti-pattern',
  '}',
  '```',
  '',
].join('\n');

const CLEAN = [
  '# Fixture plan (clean)',
  '## A.7 Steps',
  '| Step | File | Kind | Exact action (anchor + literal change) | Verify |',
  '|---|---|---|---|---|',
  '| 1.1 | `src/a.mjs` | **EDIT** | Remove the bare catch per **Listing L1**. | `grep -c "catch {}" src/a.mjs` → 1 (2 before this step, 1 after: the executable catch is gone, the L1 comment literal remains) |',
  '',
  '## A.10 Listings',
  '### Listing L1 — replacement (step 1.1)',
  '```js',
  '} catch (err) {',
  '  // the bare catch {} that used to wrap this is the anti-pattern',
  '}',
  '```',
  '',
].join('\n');

const CROSSFILE = [
  '# Fixture plan (cross-file, no Class A)',
  '## A.7 Steps',
  '| Step | File | Kind | Exact action (anchor + literal change) | Verify |',
  '|---|---|---|---|---|',
  '| 1.1 | `src/b.mjs` | **EDIT** | Mirror the removal per **Listing L1**. | `grep -c "catch {}" src/a.mjs` → observed count decreases by exactly 1 from the baseline |',
  '',
  '## A.10 Listings',
  '### Listing L1 — replacement (step 1.1)',
  '```js',
  '// the bare catch {} comment again',
  '```',
  '',
].join('\n');

function runLint(args) {
  return spawnSync(process.execPath, [LINT, ...args], { encoding: 'utf8' });
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.error(`ok - ${name}`);
  } else {
    fail++;
    console.error(`FAIL - ${name}: ${detail}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'plan-lint-'));
try {
  const defPath = join(dir, 'defective.md');
  writeFileSync(defPath, DEFECTIVE);
  const cleanPath = join(dir, 'clean.md');
  writeFileSync(cleanPath, BREAK ? DEFECTIVE : CLEAN);
  const crossPath = join(dir, 'crossfile.md');
  writeFileSync(crossPath, CROSSFILE);

  const r1 = runLint([defPath]);
  const j1 = JSON.parse(r1.stdout);
  const d1 = j1.files[0].defects;
  check(
    't1_defective_fixture_flagged',
    r1.status === 1 && j1.status === 'defect' && d1.length === 1
      && d1[0].step === '1.1' && d1[0].listing === 'L1' && d1[0].pattern === 'catch {}',
    r1.stdout,
  );

  const r2 = runLint([cleanPath]);
  const j2 = JSON.parse(r2.stdout);
  check(
    't2_clean_fixture_passes',
    r2.status === 0 && j2.status === 'ok' && j2.files[0].defects.length === 0,
    r2.stdout,
  );

  const r3 = runLint(['--strict', 'docs/plans/rfc-015-p1-s2.md']);
  const j3 = JSON.parse(r3.stdout);
  const hit = j3.files[0].defects.find(
    (d) => d.step === '1.13' && d.listing === 'L9' && d.pattern === 'catch {}',
  );
  check('t3_rfc015_s2_step113_regression', r3.status === 1 && Boolean(hit), r3.stdout);

  const r4 = runLint([crossPath]);
  const j4 = JSON.parse(r4.stdout);
  check(
    't4_crossfile_target_not_class_a',
    r4.status === 0 && j4.files[0].defects.length === 0 && j4.files[0].warns.length === 1,
    r4.stdout,
  );

  const r5 = runLint(['docs/plans/PLAN-session-auto-capture.md']);
  const j5 = JSON.parse(r5.stdout);
  check(
    't5_design_doc_vacuous_pass',
    r5.status === 0 && j5.status === 'ok' && j5.files[0].grep_count_verifies === 0,
    r5.stdout,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ suite: 'plan-listing-discipline', pass, fail }));
process.exit(fail === 0 ? 0 : 1);
```

### Listing L6 — `.github/workflows/plan-lint.yml` (step 1.6, full file)

```yaml
# Issue #627: plan-authoring listing discipline. Lints only the docs/plans/*.md
# files changed in the PR (historical plans are not retro-flagged; executed
# plans carry `plan-lint: accepted-defect` errata markers instead).
name: plan-lint

on:
  pull_request:
    paths:
      - 'docs/plans/**'
      - 'scripts/validate-plan-listing-discipline.mjs'
      - 'tests/test-plan-listing-discipline.mjs'

jobs:
  listing-discipline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Lint changed plan docs (issue #627)
        run: |
          base="${{ github.event.pull_request.base.sha }}"
          changed=$(git diff --name-only --diff-filter=d "$base" HEAD -- 'docs/plans/*.md')
          if [ -z "$changed" ]; then
            echo "no plan docs changed"
            exit 0
          fi
          node scripts/validate-plan-listing-discipline.mjs $changed
```

### Listing L7 — `tests.yml` suite registration (step 1.7)

`ANCHOR` (verbatim, unique):

```text
        run: node tests/test-install-drift-notice.mjs
```

`REPLACE` with:

```text
        run: node tests/test-install-drift-notice.mjs

      - name: Run plan-listing discipline lint suite (#627)
        run: node tests/test-plan-listing-discipline.mjs
```

### Listing L9 — fence-guard for suppression markers (step 1.4c, two edit sites)

Site 1 — `ANCHOR` (verbatim function):

```js
function extractSuppressed(text) {
  const set = new Set();
  for (const m of text.matchAll(SUPPRESS_RE)) set.add(m[1]);
  return set;
}
```

`REPLACE` with:

```js
function extractSuppressed(lines) {
  const set = new Set();
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(SUPPRESS_RE)) set.add(m[1]);
  }
  return set;
}
```

Site 2 — `ANCHOR` (verbatim call site):

```js
  const suppressed = strict ? new Set() : extractSuppressed(text);
```

`REPLACE` with:

```js
  const suppressed = strict ? new Set() : extractSuppressed(lines);
```

### Listing L10 — test t6, in-fence marker is inert (step 1.5c)

`ANCHOR` (verbatim t5 check block):

```js
  check(
    't5_design_doc_vacuous_pass',
    r5.status === 0 && j5.status === 'ok' && j5.files[0].grep_count_verifies === 0,
    r5.stdout,
  );
```

`REPLACE` with:

```js
  check(
    't5_design_doc_vacuous_pass',
    r5.status === 0 && j5.status === 'ok' && j5.files[0].grep_count_verifies === 0,
    r5.stdout,
  );

  const SUPPRESS_IN_FENCE = [
    '# Fixture plan (in-fence suppression marker must be inert)',
    '## A.7 Steps',
    '| Step | File | Kind | Exact action (anchor + literal change) | Verify |',
    '|---|---|---|---|---|',
    '| 1.1 | `src/a.mjs` | **EDIT** | Remove the bare catch per **Listing L1**. | `grep -c "catch {}" src/a.mjs` → observed count decreases by exactly 1 from the baseline |',
    '',
    '## A.10 Listings',
    '### Listing L1 — replacement (step 1.1)',
    '```js',
    '} catch (err) {',
    '  // the bare catch {} that used to wrap this is the anti-pattern',
    '  // <!-- plan-lint: accepted-defect step 1.1 -->',
    '}',
    '```',
    '',
  ].join('\n');
  const fencePath = join(dir, 'suppress-in-fence.md');
  writeFileSync(fencePath, SUPPRESS_IN_FENCE);
  const r6 = runLint([fencePath]);
  const j6 = JSON.parse(r6.stdout);
  check(
    't6_infence_marker_does_not_suppress',
    r6.status === 1 && j6.status === 'defect' && j6.files[0].defects.length === 1
      && j6.files[0].accepted.length === 0,
    r6.stdout,
  );
```

### Listing L8 — Errata appendix for `rfc-015-p1-s2.md` (step 1.8, append at end of file)

```text

## Errata (issue #627, recorded post-execution)

Two plan-authoring defects surfaced while executing this plan (PR #625); both are documented in
issue #627 and neither shipped broken code. Recorded so readers do not treat the affected rows as
sound patterns.

- Step 1.13's Verify (a relative `grep -c` delta of −1) can never land as written: Listing L9's
  comment re-introduces the counted string, netting the delta to zero. The functional evidence the
  step landed is the green `t2_clerk_protects_declared` + `t3b_clerk_abort_corrupt_playbooks`.
  <!-- plan-lint: accepted-defect step 1.13 issue #627 -->
- Step 1.15 named both apply envelopes; Listing L11 coded only the legacy envelope. The clerk site
  was transcribed from prose under review authorization during PR #625.
```

## §18 Done criteria (slice 627-1)

1. Steps 1.1–1.12 verifies all green, in order, artifacts captured.
2. `node tests/test-ci-suite-registration.mjs` exits 0 (suite wired).
3. `node scripts/validate-plan-listing-discipline.mjs --strict docs/plans/rfc-015-p1-s2.md` exits 1
   naming step 1.13 (REQ-4) and the non-strict run exits 0 with it under `accepted` (REQ-7).
4. Lint self-run on this plan document exits 0 (dogfood, step 1.11).
5. Second-opinion review round green; operator approval; single commit; PR referencing #627.
