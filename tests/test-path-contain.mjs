// test-path-contain.mjs — RFC-008 P2a: direct axis tests for the extracted
// scripts/lib/path-contain.mjs (contained / resolveContained / UsageError).
// The extraction is verbatim (behavior-preserving; tests/test-plugin-registry.mjs
// is the integration regression lock) — this suite pins the containment
// semantics per axis so the NEXT consumer (P2b validate-bp-contract) inherits
// a tested predicate, not an assumed one.
//
// Symlink-dependent axes loud-skip on platforms where symlink creation is not
// permitted (win32 without Developer Mode) — skipped count is printed, never
// silent.
//
// Run: node tests/test-path-contain.mjs    (exit 0 = pass, non-zero = fail)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { contained, resolveContained, UsageError } from "../scripts/lib/path-contain.mjs";

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

function ok(name) {
  pass++;
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}${detail ? " — " + detail : ""}`);
}
function assert(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

// Sandbox: root MUST be canonical (the resolveContained contract) — realpath
// the tmpdir (macOS os.tmpdir() is /var/..., canonically /private/var/...).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "path-contain-")));
const ROOT = path.join(SANDBOX, "project");
const OUTSIDE = path.join(SANDBOX, "outside");
fs.mkdirSync(path.join(ROOT, "sub"), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(ROOT, "sub", "in.json"), "{}");
fs.writeFileSync(path.join(OUTSIDE, "ext.json"), "{}");

/** Create a symlink; returns false (and counts a loud skip) if not permitted. */
function trySymlink(target, linkPath, kind) {
  try {
    fs.symlinkSync(target, linkPath, kind);
    return true;
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") {
      skipped++;
      return false;
    }
    throw e;
  }
}

function expectUsageError(name, fn) {
  try {
    fn();
    bad(name, "expected UsageError, got success");
  } catch (e) {
    assert(e instanceof UsageError && e.name === "UsageError", name, `threw ${e.name}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// contained() — pure lexical predicate.
// ---------------------------------------------------------------------------
assert(contained(ROOT, ROOT), "contained: root equals root");
assert(contained(path.join(ROOT, "sub", "in.json"), ROOT), "contained: child under root");
assert(!contained(OUTSIDE, ROOT), "contained: sibling dir rejected");
assert(!contained(ROOT + "2", ROOT), "contained: prefix-without-separator rejected (/root2 vs /root)");

// ---------------------------------------------------------------------------
// False-positive controls — legitimate paths must be accepted.
// ---------------------------------------------------------------------------
assert(
  resolveContained(ROOT, "sub/in.json", "t") === path.join(ROOT, "sub", "in.json"),
  "FP control: relative in-project path accepted",
);
assert(
  resolveContained(ROOT, path.join(ROOT, "sub", "in.json"), "t") === path.join(ROOT, "sub", "in.json"),
  "FP control: absolute in-project path accepted (root pre-canonicalized)",
);

// ---------------------------------------------------------------------------
// ENOENT branch — not-yet-existing paths: lexical containment decides.
// ---------------------------------------------------------------------------
assert(
  resolveContained(ROOT, "sub/new-not-yet.json", "t") === path.join(ROOT, "sub", "new-not-yet.json"),
  "ENOENT: lexically-contained nonexistent path returns absLex (reader surfaces ENOENT)",
);
expectUsageError("ENOENT: ../ lexical escape rejected", () =>
  resolveContained(ROOT, "../outside/new-not-yet.json", "t"),
);
expectUsageError("absolute outside path rejected", () =>
  resolveContained(ROOT, path.join(OUTSIDE, "ext.json"), "t"),
);
expectUsageError("traversal to existing outside file rejected", () =>
  resolveContained(ROOT, "../outside/ext.json", "t"),
);

// ---------------------------------------------------------------------------
// Symlink axes (loud-skip where symlinks cannot be created).
// ---------------------------------------------------------------------------

// Axis: internal symlink -> outside target (escape) — realpath lands outside.
const linkOut = path.join(ROOT, "link-out.json");
if (trySymlink(path.join(OUTSIDE, "ext.json"), linkOut, "file")) {
  expectUsageError("internal symlink to outside file rejected", () =>
    resolveContained(ROOT, "link-out.json", "t"),
  );
}

// Axis: external symlink -> existing in-project file — realpath lands inside.
const linkIn = path.join(OUTSIDE, "link-in.json");
if (trySymlink(path.join(ROOT, "sub", "in.json"), linkIn, "file")) {
  assert(
    resolveContained(ROOT, linkIn, "t") === path.join(ROOT, "sub", "in.json"),
    "external symlink resolving INTO project accepted (canonical target is what is read)",
  );
}

// Axis: symlinked external DIRECTORY -> traversal through it stays judged on realpath.
const dirLink = path.join(ROOT, "dir-link");
if (trySymlink(OUTSIDE, dirLink, "dir")) {
  expectUsageError("file under internal dir-symlink to outside rejected", () =>
    resolveContained(ROOT, "dir-link/ext.json", "t"),
  );
}

// Axis: symlink loop — realpathSync throws ELOOP -> lexical fallback branch.
const loopA = path.join(ROOT, "loop-a");
const loopB = path.join(ROOT, "loop-b");
if (trySymlink(loopB, loopA, "file") && trySymlink(loopA, loopB, "file")) {
  assert(
    resolveContained(ROOT, "loop-a", "t") === loopA,
    "symlink loop: ELOOP falls back to lexical check; in-project loop returns absLex",
  );
  // The loop members are unreadable; the reader surfaces the error — containment
  // never resolved them outside the root, so no authority escape.
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\ntest-path-contain: ${pass} passed, ${fail} failed, ${skipped} symlink-axis skipped`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
if (pass === 0) {
  console.error("✗ zero checks executed (vacuous run)");
  process.exit(1);
}
console.log("✓ all path-contain checks passed");
