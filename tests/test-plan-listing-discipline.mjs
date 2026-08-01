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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ suite: 'plan-listing-discipline', pass, fail }));
process.exit(fail === 0 ? 0 : 1);
