// test-validate-schemas.mjs — RFC-008 P2a: the shipped scripts/validate-schemas.mjs
// is fail-CLOSED. Positive run against the real repo, then the Class A negative
// matrix in an os.tmpdir() sandbox built by copying the real scan roots with
// { verbatimSymlinks: true } — load-bearing: the cpSync DEFAULT rewrites
// relative symlink targets to absolute paths into the SOURCE tree, so sandbox
// links would silently resolve back into the real repo and the dangling-symlink
// axis would never be exercised (P2a plan review F-A, empirically probed).
// Verbatim copy preserves relative targets, which then dangle in the sandbox
// exactly as the no-follow walk must tolerate.
//
// Symlink-dependent axes loud-skip (printed count) where symlink creation/copy
// is not permitted (win32 without Developer Mode) — never a wholesale error.
//
// Run: node tests/test-validate-schemas.mjs    (exit 0 = pass, non-zero = fail)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const VALIDATOR = path.join(REPO_ROOT, "scripts", "validate-schemas.mjs");
const CORPUS_REL = path.join("tests", "fixtures", "schema-negative-corpus.json");
const SCAN_ROOTS = ["patterns", "plugins", "schemas"];

// The explicit P0 17-doc contract (mirrors tests/test-p0-schemas.mjs SCHEMA_DOCS).
// Rule-14 cross-check: the test asserts the CONTRACT list, the validator
// DISCOVERS — every contract doc must appear in the discovered set.
const P0_SCHEMA_DOCS = [
  "patterns/taxonomy.schema.json",
  "patterns/events.schema.json",
  "patterns/schema.json",
  "plugins/manifest.schema.json",
  "plugins/_index.schema.json",
  "plugins/installed-state.schema.json",
  "plugins/bypass_known.schema.json",
  "schemas/events/event-pre-tool-use.schema.json",
  "schemas/events/event-tool-result.schema.json",
  "schemas/events/event-stop.schema.json",
  "schemas/events/event-session-start.schema.json",
  "schemas/events/event-session-end.schema.json",
  "schemas/runtime/classifier-output.schema.json",
  "schemas/runtime/adapter-call.schema.json",
  "schemas/runtime/adapter-response.schema.json",
  "schemas/runtime/structured-alert.schema.json",
  "schemas/runbook-agent-manifest.schema.json",
];

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

function run(args) {
  const r = spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: "utf8" });
  let payload = null;
  try { payload = JSON.parse(r.stdout); } catch { /* non-JSON output (human/usage) */ }
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, payload };
}

function hasViolation(payload, check, substr) {
  return !!payload && Array.isArray(payload.violations) &&
    payload.violations.some((v) => v.check === check && (!substr || v.detail.includes(substr)));
}

// ---------------------------------------------------------------------------
// 1. POSITIVE — the real repo passes, discovery covers the P0 contract.
// ---------------------------------------------------------------------------
{
  const r = run(["--project", REPO_ROOT, "--json"]);
  assert(r.exit === 0, "real repo: exit 0", `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`);
  assert(r.payload && r.payload.status === "ok", "real repo: status ok");
  assert(r.payload && r.payload.docs_checked >= 17, "real repo: docs_checked >= 17", `got ${r.payload && r.payload.docs_checked}`);
  assert(r.payload && r.payload.corpus_entries >= 14, "real repo: corpus_entries >= 14", `got ${r.payload && r.payload.corpus_entries}`);
  const discovered = new Set((r.payload && r.payload.docs) || []);
  const missing = P0_SCHEMA_DOCS.filter((d) => !discovered.has(d));
  assert(missing.length === 0, "real repo: all 17 P0 contract docs are in the discovered set (Rule-14 cross-check)", `missing: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Sandbox construction (verbatimSymlinks — see header).
// ---------------------------------------------------------------------------
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "validate-schemas-")));
let symlinksOk = true;

function copyTree(src, dest) {
  try {
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") {
      // win32 without symlink privilege: copy without symlinks; symlink axes loud-skip.
      symlinksOk = false;
      fs.cpSync(src, dest, {
        recursive: true,
        filter: (s) => !fs.lstatSync(s).isSymbolicLink(),
      });
    } else {
      throw e;
    }
  }
}

function makeCase(name) {
  const root = path.join(TMP, name);
  for (const rel of SCAN_ROOTS) copyTree(path.join(REPO_ROOT, rel), path.join(root, rel));
  fs.mkdirSync(path.join(root, "tests", "fixtures"), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, CORPUS_REL), path.join(root, CORPUS_REL));
  return root;
}

function readCorpus() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CORPUS_REL), "utf8"));
}
function writeCorpus(root, corpus) {
  fs.writeFileSync(path.join(root, CORPUS_REL), JSON.stringify(corpus));
}

// ---------------------------------------------------------------------------
// 2. Sandbox baseline — exit 0, and the copy is HERMETIC: no copied symlink
//    resolves back into the real repo (the F-A axis), and at least one dangles
//    (proving the no-follow walk tolerates dangling links — the F2b axis).
// ---------------------------------------------------------------------------
{
  const root = makeCase("baseline");
  if (symlinksOk) {
    const links = [];
    (function collect(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) links.push(p);
        else if (ent.isDirectory()) collect(p);
      }
    })(root);
    let escapes = 0;
    let dangling = 0;
    for (const l of links) {
      const target = path.resolve(path.dirname(l), fs.readlinkSync(l));
      let real = null;
      try { real = fs.realpathSync(l); } catch { dangling++; }
      if (real !== null && (real === REPO_ROOT || real.startsWith(REPO_ROOT + path.sep))) escapes++;
      if (real === null && (target === REPO_ROOT || target.startsWith(REPO_ROOT + path.sep))) escapes++;
    }
    assert(escapes === 0, "sandbox hermetic: no copied symlink resolves into the real repo (verbatimSymlinks)", `${escapes} escape(s) of ${links.length} link(s)`);
    assert(links.length === 0 || dangling >= 1, "sandbox carries >= 1 dangling symlink (the F2b axis is actually exercised)", `links=${links.length} dangling=${dangling}`);
  } else {
    skipped += 2;
  }
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 0, "sandbox baseline: exit 0 (dangling non-schema-named symlinks are inert)", `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// 3. NEGATIVE matrix (Class A — each must fail loudly, with attribution).
// ---------------------------------------------------------------------------

// planted invalid schema doc -> doc-lint violation naming the file
{
  const root = makeCase("bad-doc");
  fs.writeFileSync(path.join(root, "schemas", "bad-test.schema.json"), JSON.stringify({ requiredd: [] }));
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "planted bad doc: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "doc-lint", "bad-test.schema.json"), "planted bad doc: doc-lint violation names the file");
}

// unparseable schema doc -> doc-parse violation (content problem, exit 1 not 2)
{
  const root = makeCase("unparseable-doc");
  fs.writeFileSync(path.join(root, "schemas", "broken.schema.json"), "{ not json");
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "unparseable doc: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "doc-parse", "broken.schema.json"), "unparseable doc: doc-parse violation names the file");
}

// truncated corpus (13) -> non-vacuity guard
{
  const root = makeCase("short-corpus");
  writeCorpus(root, readCorpus().slice(0, 13));
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "truncated corpus (13): exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "corpus-non-vacuity"), "truncated corpus: corpus-non-vacuity violation");
}

// vacuously-valid entry ({} is a VALID 2020-12 schema) -> divergence, explained
{
  const root = makeCase("vacuous-entry");
  writeCorpus(root, [...readCorpus(), { name: "vacuous", schema: {} }]);
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "vacuously-valid entry: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "corpus-divergence", "vacuously valid"), "vacuously-valid entry: corpus-divergence violation explains {} is valid 2020-12");
}

// duplicate names -> uniqueness guard
{
  const root = makeCase("dup-names");
  const corpus = readCorpus();
  corpus[1] = { ...corpus[1], name: corpus[0].name };
  writeCorpus(root, corpus);
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "duplicate corpus names: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "corpus-shape", "unique"), "duplicate corpus names: corpus-shape uniqueness violation");
}

// corpus missing -> exit 2 (IO fail-closed, NOT a vacuous pass, NOT exit 1)
{
  const root = makeCase("no-corpus");
  fs.rmSync(path.join(root, CORPUS_REL));
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 2, "missing corpus: exit 2 (absence != vacuous pass)", `exit=${r.exit}`);
  assert(r.stderr.includes("corpus unreadable"), "missing corpus: stderr names the corpus", r.stderr.slice(0, 200));
}

// corpus malformed (object, not array) -> shape violation, exit 1
{
  const root = makeCase("malformed-corpus");
  fs.writeFileSync(path.join(root, CORPUS_REL), JSON.stringify({ nope: true }));
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "malformed corpus (object): exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "corpus-shape", "array"), "malformed corpus: corpus-shape violation");
}

// out-of-root docs: BOTH spellings (planner F1 + reviewer F-B) -> sweep violations
{
  const root = makeCase("out-of-root");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "stray.schema.json"), "{}");
  fs.writeFileSync(path.join(root, "scripts", "schema.json"), "{}"); // bare spelling (F-B)
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "out-of-root docs: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "out-of-root-doc", "stray.schema.json"), "out-of-root: *.schema.json spelling swept");
  assert(hasViolation(r.payload, "out-of-root-doc", `scripts${path.sep}schema.json`), "out-of-root: bare schema.json spelling swept (F-B)");
}

// bare schema.json is ALSO discovered inside scan roots (F-B discovery side):
// plant an INVALID bare-named doc in a scan root -> doc-lint catches it.
{
  const root = makeCase("bare-name-discovery");
  fs.mkdirSync(path.join(root, "schemas", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "schemas", "sub", "schema.json"), JSON.stringify({ type: "banana" }));
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "bare-named doc in scan root: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "doc-lint", `sub${path.sep}schema.json`), "bare-named doc in scan root: discovered AND linted (F-B)");
}

// doc-named regular DIRECTORY in a scan root -> violation, never silently
// ignored (step-6 review F1: the symlink branch flagged doc-named entries but
// the directory branch stayed lenient — class fix judges doc-named entries by
// kind before any skip rule)
{
  const root = makeCase("doc-named-dir");
  fs.mkdirSync(path.join(root, "schemas", "dir.schema.json"));
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "doc-named directory: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "doc-regular-file", "dir.schema.json"), "doc-named directory: doc-regular-file violation (not a silent skip)");
}

// dot-prefixed doc-named FILE -> discovered and linted (step-6 review F2: the
// dot-skip applies to directories only; a hidden .bad.schema.json must not
// lurk unlinted)
{
  const root = makeCase("dotfile-doc");
  fs.writeFileSync(path.join(root, "schemas", ".hidden.schema.json"), JSON.stringify({ requiredd: [] }));
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "hidden doc-named file: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "doc-lint", ".hidden.schema.json"), "hidden doc-named file: discovered AND linted");
}

// discovery vacuity: empty scan roots -> min-docs violation
{
  const root = makeCase("min-docs");
  for (const rel of SCAN_ROOTS) fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1, "empty scan roots: exit 1", `exit=${r.exit}`);
  assert(hasViolation(r.payload, "min-docs"), "empty scan roots: min-docs vacuity violation");
}

// symlinked schema doc inside a scan root -> regular-file violation, never skipped
if (symlinksOk) {
  const root = makeCase("symlinked-doc");
  try {
    fs.symlinkSync(path.join("..", "tests", "fixtures", "schema-negative-corpus.json"), path.join(root, "schemas", "link.schema.json"), "file");
    const r = run(["--project", root, "--json"]);
    assert(r.exit === 1, "symlinked schema doc: exit 1", `exit=${r.exit}`);
    assert(hasViolation(r.payload, "doc-regular-file", "link.schema.json"), "symlinked schema doc: doc-regular-file violation (not a silent skip)");
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") skipped += 2;
    else throw e;
  }
} else {
  skipped += 2;
}

// ---------------------------------------------------------------------------
// 4. Usage errors — exit 2, never conflated with violations.
// ---------------------------------------------------------------------------
{
  const r = run(["--project", path.join(TMP, "does-not-exist")]);
  assert(r.exit === 2, "nonexistent --project: exit 2", `exit=${r.exit}`);
}
{
  const r = run(["--bogus"]);
  assert(r.exit === 2, "unknown argument: exit 2", `exit=${r.exit}`);
  assert(r.stderr.includes("--bogus"), "unknown argument: named in stderr");
}

// direct-run guard survives URL-encoding-requiring paths (step-6 review F4):
// with the raw `file://${argv[1]}` compare, a SPACE in the script path made
// main() never run -> exit 0 + empty output = vacuous green for the CI gate.
{
  const spacedScripts = path.join(TMP, "spaced dir", "scripts");
  fs.mkdirSync(path.join(spacedScripts, "lib"), { recursive: true });
  fs.copyFileSync(VALIDATOR, path.join(spacedScripts, "validate-schemas.mjs"));
  for (const lib of ["mini-jsonschema.mjs", "path-contain.mjs"]) {
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "lib", lib), path.join(spacedScripts, "lib", lib));
  }
  const r = spawnSync(
    process.execPath,
    [path.join(spacedScripts, "validate-schemas.mjs"), "--project", path.join(TMP, "does-not-exist")],
    { encoding: "utf8" },
  );
  assert(r.status === 2, "spaced script path: direct-run guard fires (exit 2, not a silent 0)", `exit=${r.status} stdout=${JSON.stringify(r.stdout.slice(0, 80))}`);
  assert(r.stderr.includes("does not resolve"), "spaced script path: real usage error surfaced", r.stderr.slice(0, 200));
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ntest-validate-schemas: ${pass} passed, ${fail} failed, ${skipped} symlink-axis skipped`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
if (pass === 0) {
  console.error("✗ zero checks executed (vacuous run)");
  process.exit(1);
}
console.log("✓ all validate-schemas checks passed");
