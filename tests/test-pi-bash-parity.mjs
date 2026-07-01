/**
 * test-pi-bash-parity.mjs — RFC-008 P7 S2 bash-extractor drift guard (OD-1).
 *
 * The Pi adapter COPIES extractBashTargets verbatim from
 * plugins/codex/capabilities/codex-adapter.mjs rather than importing it (OD-1: the codex
 * adapter is frozen and does NOT export the function). This test runs a shared golden
 * corpus of bash commands + expected extracted targets through the Pi copy and asserts the
 * output, so any silent divergence from the codex original's grammar is caught. The corpus
 * mirrors the codex conformance bash cases (tests/test-codex-adapter-conformance.mjs Group 1),
 * including the sed -i regressions from the codex r7 S2-review.
 *
 * Extractor semantics under test: targets are returned AS WRITTEN (relative/absolute
 * strings, unresolved); sinks (/dev/null), fd-dups (2>&1), and dynamic tokens ($VAR, `cmd`,
 * globs, unclosed quotes) yield NO target. Carve-out / repo-source classification is a LATER
 * stage (isRepoSource) and is NOT this extractor's job.
 *
 * Run: node tests/test-pi-bash-parity.mjs
 */

import { extractBashTargets } from "../plugins/pi-agent/capabilities/enforcement.js";

let pass = 0, fail = 0;
const failures = [];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// [command, expectedTargets]
const CORPUS = [
  // redirects
  ["echo hi > src/out.mjs", ["src/out.mjs"]],
  ["grep x y &> src/z.mjs", ["src/z.mjs"]],
  ["echo a > /tmp/a.txt > src/evil.mjs", ["/tmp/a.txt", "src/evil.mjs"]],
  ["printf hi >>\"src/x.mjs\"", ["src/x.mjs"]],
  ["echo hi >\"docs/plans/x.md\"", ["docs/plans/x.md"]],
  ["printf hi > \"src/a b.txt\"", ["src/a b.txt"]],
  ["echo hi > \"docs/plans/a b.md\"", ["docs/plans/a b.md"]],
  ["echo hi > /tmp/output.txt", ["/tmp/output.txt"]],
  // sinks / fd-dups → no target
  ["echo hi > /dev/null", []],
  ["grep x src/SENTINEL.mjs 2>&1", []],
  // copy family
  ["cp /tmp/a.txt src/x.mjs", ["src/x.mjs"]],
  ["cp src/SENTINEL.mjs /tmp/y.txt", ["/tmp/y.txt"]],
  ["cp -t src /tmp/a.txt /tmp/b.txt", ["src"]],
  ["cp -t /tmp src/SENTINEL.mjs /tmp/b.txt", ["/tmp"]],
  ["mv /tmp/a.txt src/x.mjs", ["src/x.mjs"]],
  // sed in-place grammar (codex r7 S2-review regressions)
  ["sed -i 's/a/b/' src/SENTINEL.mjs", ["src/SENTINEL.mjs"]],
  ["sed -i '' 's/a/b/' src/x.mjs", ["src/x.mjs"]],
  ["sed -i 's/a/b/' docs/plans/x.md", ["docs/plans/x.md"]],
  ["sed 's/a/b/' src/SENTINEL.mjs", []],
  ["sed -i -e 's/a/b/' src/x.mjs", ["src/x.mjs"]],
  // tee / dd
  ["echo hi | tee src/b.mjs", ["src/b.mjs"]],
  ["echo hi | tee -a src/b.mjs", ["src/b.mjs"]],
  ["dd of=src/x.mjs", ["src/x.mjs"]],
  // read-only / no write target
  ["cat src/SENTINEL.mjs", []],
  ["ls -la src", []],
  ["git commit -m x", []],
  // dynamic → no target (extract-only residual, documented)
  ["echo hi > \"$TARGET\"", []],
  ["eval \"echo hi > $D\"", []],
  ["echo hi > $D", []],
];

for (const [cmd, expected] of CORPUS) {
  const got = extractBashTargets(cmd);
  if (eq(got, expected)) pass++;
  else { fail++; failures.push(`${JSON.stringify(cmd)} → expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`); }
}

const total = pass + fail;
console.log(`\ntest-pi-bash-parity: ${pass} pass / ${fail} fail (${total} total)`);
if (fail > 0) {
  console.error("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
