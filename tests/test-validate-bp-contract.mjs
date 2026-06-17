// test-validate-bp-contract.mjs — RFC-008 P2b: scripts/validate-bp-contract.mjs
// (assertions 0 + 1-15) is fail-CLOSED, and scripts/scaffold-bp.mjs is SoT-bound.
//
// Dispatch architecture (plan review F1): the golden corpus cannot run as bare
// fixture files — assertion 0's set-equality guard requires the full 11-contract
// set. So every case runs in a SANDBOX: a copy of patterns/ plugins/ schemas/
// (verbatimSymlinks, P2a F-A) turned into a real git repo with an origin/main
// ref (assertions 8/14 are git-backed; `git update-ref refs/remotes/origin/main`
// reproduces CI's fetch-depth:0 baseline). bp fixtures OVERLAY a canonical
// contract (bp-001.json) in the staged set; taxonomy/events fixtures inject via
// --taxonomy/--events; classifier negatives mutate the sandbox classifier
// (synthetic-root mechanism, review F3b).
//
// Hash tokens: bp fixtures carry __LIVE_TAXONOMY_VERSION__/__LIVE_EVENTS_VERSION__
// replaced at staging time from the sandbox's effective documents — committed
// digests would be hand-typed rot (lesson 20260610-000157-…-f9b5 class).
//
// Run: node tests/test-validate-bp-contract.mjs   (exit 0 = pass, non-zero = fail)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { taxonomyVersion, eventsVersion } from "../scripts/lib/version-hash.mjs";
import { EVENT_IDS } from "../scripts/validate-plugin-registry.mjs";

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const VALIDATOR = path.join(REPO_ROOT, "scripts", "validate-bp-contract.mjs");
const SCAFFOLD = path.join(REPO_ROOT, "scripts", "scaffold-bp.mjs");
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "bp-contract");
const COPY_ROOTS = ["patterns", "plugins", "schemas"];
const CLASSIFIER_REL = path.join("plugins", "claude-code", "hooks", "lib", "command-classifier.sh");
// 16 (P3b-2) is the gate-map mirror — LIVE mode only (the live repo run here is
// uninjected, so it runs; golden-corpus dispatches inject and skip it).
const EXPECTED_ASSERTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16];

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];

function ok() { pass++; }
function bad(name, detail) { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
function assert(cond, name, detail) { if (cond) ok(name); else bad(name, detail); }

// Both runners forward the isolated git env (step-6 NIT): the validator's own
// git subprocesses must not pick up developer-global config (hooks/signing).
function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: "utf8", env: GIT_ENV, ...opts });
  let payload = null;
  try { payload = JSON.parse(r.stdout); } catch { /* non-JSON (human/usage) output */ }
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, payload };
}

function runScaffold(args, opts = {}) {
  const r = spawnSync(process.execPath, [SCAFFOLD, ...args], { encoding: "utf8", env: GIT_ENV, ...opts });
  let payload = null;
  try { payload = JSON.parse(r.stdout); } catch { /* ignore */ }
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, payload };
}

function hasViolation(payload, check, substr) {
  return !!payload && Array.isArray(payload.violations) &&
    payload.violations.some((v) => v.check === check && (!substr || v.detail.includes(substr)));
}

// --- sandbox machinery ------------------------------------------------------
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "validate-bp-")));
let symlinksOk = true;
// Sandbox git runs under an ISOLATED config (no user hooks/signing/templates).
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull };

function gitIn(root, argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

function copyTree(src, dest) {
  try {
    fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  } catch (e) {
    if (e.code === "EPERM" || e.code === "EACCES") {
      symlinksOk = false;
      fs.cpSync(src, dest, { recursive: true, filter: (s) => !fs.lstatSync(s).isSymbolicLink() });
    } else {
      throw e;
    }
  }
}

/** Sandbox = tree copy + git repo + origin/main ref at the baseline commit. */
function makeRepo(name, { withOriginRef = true, excludeAtBaseline = [] } = {}) {
  const root = path.join(TMP, name);
  for (const rel of COPY_ROOTS) copyTree(path.join(REPO_ROOT, rel), path.join(root, rel));
  gitIn(root, ["init", "-q", "-b", "main"]);
  const aside = [];
  for (const rel of excludeAtBaseline) {
    const abs = path.join(root, rel);
    const tmpAbs = abs + ".aside";
    fs.renameSync(abs, tmpAbs);
    aside.push([abs, tmpAbs]);
  }
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"]);
  if (withOriginRef) gitIn(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  for (const [abs, tmpAbs] of aside) fs.renameSync(tmpAbs, abs);
  if (aside.length > 0) {
    gitIn(root, ["add", "-A"]);
    gitIn(root, ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "introduce excluded files"]);
  }
  return root;
}

function readJsonAt(root, rel) { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); }
function writeJsonAt(root, rel, doc) { fs.writeFileSync(path.join(root, rel), JSON.stringify(doc, null, 2) + "\n"); }

function liveHashesOf(root) {
  return {
    tax: taxonomyVersion(readJsonAt(root, path.join("patterns", "taxonomy.json"))),
    ev: eventsVersion(readJsonAt(root, path.join("patterns", "events.json"))),
  };
}

function stageBpFixture(root, fixtureName) {
  const { tax, ev } = liveHashesOf(root);
  const text = fs.readFileSync(path.join(FIXTURE_DIR, fixtureName), "utf8")
    .replaceAll("__LIVE_TAXONOMY_VERSION__", tax)
    .replaceAll("__LIVE_EVENTS_VERSION__", ev);
  fs.writeFileSync(path.join(root, "patterns", "bp-001.json"), text);
}

// ---------------------------------------------------------------------------
// 1. POSITIVE — the real repo passes; assertions all run; EVENT_IDS binding.
// ---------------------------------------------------------------------------
{
  const r = run(["--project", REPO_ROOT, "--json"]);
  assert(r.exit === 0, "real repo: exit 0", `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`);
  assert(r.payload && r.payload.status === "ok", "real repo: status ok");
  assert(r.payload && r.payload.bp_files_checked === 11, "real repo: 11 contracts checked", `got ${r.payload && r.payload.bp_files_checked}`);
  // Rule-14 cross-check: validator's derived set equals an independent derivation.
  const indexIds = readJsonAt(REPO_ROOT, path.join("patterns", "_index.json")).patterns
    .map((p) => /^(bp-[0-9]{3})-/.exec(p.pattern_id)[1]).sort();
  assert(JSON.stringify(r.payload && r.payload.derived_ids) === JSON.stringify(indexIds), "real repo: derived_ids equals _index.json derivation (bp-007 absent)", `got ${JSON.stringify(r.payload && r.payload.derived_ids)}`);
  assert(!indexIds.includes("bp-007"), "real repo: bp-007 stays absent (N-1)");
  assert(JSON.stringify(r.payload && r.payload.assertions_run) === JSON.stringify(EXPECTED_ASSERTIONS), "real repo: all 16 assertion groups ran (zero-run vacuity guard)", `got ${JSON.stringify(r.payload && r.payload.assertions_run)}`);
  assert(r.payload && r.payload.checks > 0, "real repo: non-zero check count");
  assert(r.payload && r.payload.classifiers_parsed >= 1, "real repo: >= 1 default classifier parsed (7b non-vacuous)");
  // EVENT_IDS <-> events.json binding (review FU, Rule 14): the registry's
  // hardcoded cross-file constant must equal the live data SoT.
  const liveEventIds = readJsonAt(REPO_ROOT, path.join("patterns", "events.json")).events.map((e) => e.id).sort();
  assert(JSON.stringify([...EVENT_IDS].sort()) === JSON.stringify(liveEventIds), "EVENT_IDS constant equals live events[].id set (Rule-14 binding)", `constant=${JSON.stringify(EVENT_IDS)} live=${JSON.stringify(liveEventIds)}`);
}

// ---------------------------------------------------------------------------
// 2. Sandbox baseline — a faithful copy with merge-base == HEAD passes.
// ---------------------------------------------------------------------------
const SANDBOX = makeRepo("corpus");
{
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 0, "sandbox baseline: exit 0", `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`);
}
const ORIG_BP001 = fs.readFileSync(path.join(SANDBOX, "patterns", "bp-001.json"), "utf8");
const ORIG_CLASSIFIER = fs.readFileSync(path.join(SANDBOX, CLASSIFIER_REL), "utf8");

// ---------------------------------------------------------------------------
// 3. Golden corpus loop (assertion 9) — each fail-fixture fails AT its
//    attributed check, never merely exit 1.
// ---------------------------------------------------------------------------
const corpusIndex = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "_corpus-index.json"), "utf8"));
{
  const names = Object.keys(corpusIndex.fixtures);
  assert(names.length >= corpusIndex.min_fixtures, `corpus: >= ${corpusIndex.min_fixtures} fixtures (non-vacuity floor)`, `got ${names.length}`);
  const onDisk = fs.readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".json") && n !== "_corpus-index.json").sort();
  assert(JSON.stringify(onDisk) === JSON.stringify([...names].sort()), "corpus: index covers exactly the on-disk fixture files (no orphans, no ghosts)", `disk=${onDisk.length} index=${names.length}`);
}
for (const [name, meta] of Object.entries(corpusIndex.fixtures)) {
  let r;
  if (meta.inject === "bp-overlay") {
    stageBpFixture(SANDBOX, name);
    r = run(["--project", SANDBOX, "--json"]);
    fs.writeFileSync(path.join(SANDBOX, "patterns", "bp-001.json"), ORIG_BP001);
  } else if (meta.inject === "taxonomy" || meta.inject === "events") {
    const injectedAbs = path.join(SANDBOX, `injected-${name}`);
    fs.copyFileSync(path.join(FIXTURE_DIR, name), injectedAbs);
    r = run(["--project", SANDBOX, `--${meta.inject}`, injectedAbs, "--json"]);
    fs.rmSync(injectedAbs);
  } else {
    bad(`corpus ${name}: unknown inject mode ${meta.inject}`);
    continue;
  }
  assert(r.exit === 1, `corpus ${name}: exit 1`, `exit=${r.exit} stderr=${r.stderr.slice(0, 200)}`);
  assert(hasViolation(r.payload, meta.attributed_check), `corpus ${name}: fails AT attributed check ${meta.attributed_check}`, `violations=${JSON.stringify((r.payload && r.payload.violations || []).map((v) => v.check))}`);
}

// ---------------------------------------------------------------------------
// 4. Assertion 0-set — set properties (not file properties): missing, phantom,
//    near-miss filename (F5).
// ---------------------------------------------------------------------------
{
  const abs = path.join(SANDBOX, "patterns", "bp-003.json");
  const orig = fs.readFileSync(abs, "utf8");
  fs.rmSync(abs);
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "0-set", "missing contract bp-003"), "0-set: missing contract is a named violation", `exit=${r.exit}`);
  fs.writeFileSync(abs, orig);
}
{
  const { tax, ev } = liveHashesOf(SANDBOX);
  const phantom = { id: "bp-013", title: "phantom", gates: { plan_approval: "STRONG", pre_checkpoint: "STRONG", post_checkpoint: "STRONG" }, stop: { tier: "STRONG" }, taxonomy_ref: "patterns/taxonomy.json", taxonomy_version: tax, events_version: ev };
  writeJsonAt(SANDBOX, path.join("patterns", "bp-013.json"), phantom);
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "0-set", "phantom contract bp-013"), "0-set: phantom contract is a named violation", `exit=${r.exit}`);
  fs.rmSync(path.join(SANDBOX, "patterns", "bp-013.json"));
}
{
  fs.writeFileSync(path.join(SANDBOX, "patterns", "bp-07.json"), "{}");
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "0-set", "malformed contract filename"), "0-set: near-miss filename bp-07.json is a named violation (F5)", `exit=${r.exit}`);
  fs.rmSync(path.join(SANDBOX, "patterns", "bp-07.json"));
}
{
  // Step-6 F-3: case variants are the same dead-data escape on
  // case-insensitive filesystems — the loose filter is case-insensitive, the
  // strict regex is not, so the variant is a NAMED violation.
  fs.writeFileSync(path.join(SANDBOX, "patterns", "BP-099.JSON"), "{}");
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "0-set", "BP-099.JSON"), "0-set: case-variant filename BP-099.JSON is a named violation (F-3)", `exit=${r.exit}`);
  fs.rmSync(path.join(SANDBOX, "patterns", "BP-099.JSON"));
}

// ---------------------------------------------------------------------------
// 5. Assertion 7b classifier negatives (synthetic-root mechanism, F3b).
// ---------------------------------------------------------------------------
const CLS_ABS = path.join(SANDBOX, CLASSIFIER_REL);
function classifierCase(name, mutate, expectSubstr) {
  mutate();
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "7", expectSubstr), `7b: ${name}`, `exit=${r.exit} violations=${JSON.stringify((r.payload && r.payload.violations || []).filter((v) => v.check === "7").map((v) => v.detail.slice(0, 80)))}`);
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER);
}
classifierCase("missing classifier script is fail-closed", () => fs.rmSync(CLS_ABS), "default classifier script missing");
classifierCase("duplicate _priority() definition (A3)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + '\n_priority() {\n  case "$1" in\n    read_only) printf \'1\' ;;\n  esac\n}\n');
}, "_priority() definitions");
classifierCase("alternation arm spelling is fail-closed (F3)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.replace(/^(\s*)read_only\)/m, "$1read_only|sneaky_alias)"));
}, "unrecognized _priority case-arm spelling");
classifierCase("missing arm = silent-downgrade violation (L473)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.split("\n").filter((l) => !/^\s*shared_write\)/.test(l)).join("\n"));
}, 'label "shared_write" has NO _priority arm');
classifierCase("extra arm not in taxonomy", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.replace(/^(\s*)read_only\)(.*)$/m, "$1bogus_label) printf '9' ;;\n$1read_only)$2"));
}, '"bogus_label" is not a taxonomy label');
// Step-6 F-1 class: the definition recognizer must cover bash's full spelling
// class — `function` keyword, space-before-parens, and indented duplicates are
// last-wins at runtime and must trip the A3 exactly-one guard, not slip past a
// single-spelling regex (captured false-pass repros N1/N2).
const PLANTED_BODY = '\n  case "$1" in\n    read_only) printf \'1\' ;;\n  esac\n}\n';
classifierCase("duplicate via `function _priority {` spelling (F-1)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\nfunction _priority {" + PLANTED_BODY);
}, "_priority() definitions");
classifierCase("duplicate via `_priority () {` spelling (F-1)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\n_priority () {" + PLANTED_BODY);
}, "_priority() definitions");
classifierCase("duplicate via INDENTED `_priority() {` spelling (F-1)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\n  _priority() {" + PLANTED_BODY);
}, "_priority() definitions");
// Step-6 F-1R2/F-1R3: per-OCCURRENCE token-context allowlist — every
// definition opener anywhere on any line counts toward the exactly-one
// tally; occurrences outside the allowlist are unproven violations.
const UNPROVEN = "cannot prove exactly-one _priority definition";
const DUP_DEFS = "_priority() definitions";
classifierCase("N11: brace-on-next-line definition (F-1R2)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\n_priority()\n{" + PLANTED_BODY);
}, DUP_DEFS);
classifierCase("N12: `function _priority` brace-on-next-line (F-1R2)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\nfunction _priority\n{" + PLANTED_BODY);
}, DUP_DEFS);
classifierCase("N13: non-brace compound body definition (F-1R2)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\n_priority() case \"$1\" in read_only) printf '1' ;; esac\n");
}, DUP_DEFS);
classifierCase("N14: definition after a same-line command (F-1R2)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\n: ; _priority() {" + PLANTED_BODY);
}, DUP_DEFS);
// F-1R3 P-members: a call site and a redefinition share one line — the call
// context must mask only its own OCCURRENCE, never the rest of the line.
classifierCase("P1: call site + same-line redefinition (F-1R3)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\nout=$(_priority read_only); _priority() { printf '9' ; }\n");
}, DUP_DEFS);
classifierCase("P8: call inside a string + same-line redefinition (F-1R3)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\nmsg=\"see $(_priority x)\"; _priority() { printf '9' ; }\n");
}, DUP_DEFS);
classifierCase("P-live: redefinition appended to an EXISTING allowlisted call-site line (F-1R3)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.replace('local lp=$(_priority "$lbl")', 'local lp=$(_priority "$lbl"); _priority() { printf \'9\' ; }'));
}, DUP_DEFS);
classifierCase("unproven branch: direct call without $() is fail-closed", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + '\n_priority "read_only"\n');
}, UNPROVEN);
// F-1R4: a backslash-newline continuation splits the token across physical
// lines — bash joins during lexing, so the scan must normalize first.
classifierCase("F-1R4: token split by backslash-newline continuation", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\n_prio\\\nrity() { printf '9' ; }\n");
}, DUP_DEFS);
// F-1R4 FP control: a legitimate continuation that does NOT touch the token
// stays green (the join must not manufacture spurious occurrences).
{
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + '\nprobe_continuation() {\n  printf \'%s\' \\\n    "harmless"\n}\n');
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 0, "7b FP control: harmless backslash-newline continuation stays green (F-1R4)", `exit=${r.exit} violations=${JSON.stringify((r.payload && r.payload.violations || []).filter((v) => v.check === "7").map((v) => v.detail.slice(0, 80)))}`);
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER);
}
// F-1R5: bash does NOT join a backslash-newline inside a comment — a trailing
// `\` on a comment line must not absorb a next-line definition into the
// comment skip (the R4 unconditional join regressed exactly this).
classifierCase("F-1R5: definition after a trailing-backslash COMMENT line", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + "\n# note \\\n_priority() { printf '9' ; }\n");
}, DUP_DEFS);
// F-1R5 FP control: comment-with-trailing-backslash followed by a harmless
// line stays green (the comment-aware join must not flag inert text).
{
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + '\n# trailing backslash here \\\nprobe_harmless() { printf \'ok\' ; }\n');
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 0, "7b FP control: comment trailing-backslash + harmless next line stays green (F-1R5)", `exit=${r.exit} violations=${JSON.stringify((r.payload && r.payload.violations || []).filter((v) => v.check === "7").map((v) => v.detail.slice(0, 80)))}`);
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER);
}
// FP controls (F-1R2): allowlisted contexts stay green — an extra $(-call
// site and a full-line comment mention are NOT violations.
{
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + '\n# _priority is documented here\nextra_probe() {\n  local x=$(_priority "read_only")\n  printf \'%s\' "$x"\n}\n');
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 0, "7b FP control: call-site + comment _priority mentions stay green (F-1R2)", `exit=${r.exit} violations=${JSON.stringify((r.payload && r.payload.violations || []).filter((v) => v.check === "7").map((v) => v.detail.slice(0, 80)))}`);
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER);
}

// ---------------------------------------------------------------------------
// Assertion 7c (RFC-008 P3c — R4/F4/F6): default classifier runtime-sources
// taxonomy.json. Robust parser (codex R1-P2), two-emitter coverage (R1-P1),
// emit-site vocabulary closure (GAP-2), and the `declare -f _priority` allowlist
// regression that the runtime-sourcing derivation depends on.
// ---------------------------------------------------------------------------
// String forms exactly mirror the in-file guard blocks (\t/\n are literal
// backslash-escapes in the bash printf format).
const CP_GUARD = '  if ! _ensure_taxonomy_synced; then\n    printf \'%s\\t\\t%s\\n\' "unsafe_complex" "$_TAXONOMY_SYNC_REASON"\n    return 0\n  fi\n';
const CC_GUARD_INNER = '    if ! _ensure_taxonomy_synced; then\n      final_label="unsafe_complex"\n      final_target=""\n      final_reason="$_TAXONOMY_SYNC_REASON"\n    fi\n';
classifierCase("7c: missing _ensure_taxonomy_synced definition (helper deleted)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.replace("_ensure_taxonomy_synced() {", "_ensure_taxonomy_renamed_away() {"));
}, "no _ensure_taxonomy_synced() definition");
classifierCase("7c: classify_path does not call the guard (codex R1-P1)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.replace(CP_GUARD, ""));
}, "classify_path() does not call _ensure_taxonomy_synced");
classifierCase("7c: classify_command does not call the guard (codex R1-P1)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.replace(CC_GUARD_INNER, ""));
}, "classify_command() does not call _ensure_taxonomy_synced");
classifierCase("7c: typo'd emit-site label literal (GAP-2)", () => {
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER.replace('"shared_write" "rm_non_marker"', '"shared_writ" "rm_non_marker"'));
}, 'emit-site label literal "shared_writ"');
// FP control: `declare -f _priority` (the runtime-sourcing derivation) reads the
// function body — it is inert and must stay green (extractPriorityArms allowlist).
{
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER + '\nprobe_declare() {\n  local x="$(declare -f _priority)"\n  printf \'%s\' "$x"\n}\n');
  const r = run(["--project", SANDBOX, "--json"]);
  assert(r.exit === 0, "7c FP control: `declare -f _priority` read stays green (P3c)", `exit=${r.exit} violations=${JSON.stringify((r.payload && r.payload.violations || []).filter((v) => v.check === "7").map((v) => v.detail.slice(0, 80)))}`);
  fs.writeFileSync(CLS_ABS, ORIG_CLASSIFIER);
}

// ---------------------------------------------------------------------------
// 6. Stable-ID E2E (assertions 8/14) — all branches incl. A2 + N-5.
// ---------------------------------------------------------------------------
// (a) rename without major bump -> assertion 8 violation
{
  const root = makeRepo("rename-label");
  const tax = readJsonAt(root, path.join("patterns", "taxonomy.json"));
  tax.labels.find((l) => l.id === "read_only").id = "read_onlyx";
  writeJsonAt(root, path.join("patterns", "taxonomy.json"), tax);
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "8", "read_only"), "stable-ID (a): label rename w/o major bump fails at assertion 8", `exit=${r.exit}`);
}
// (b) removal without major bump -> assertion 8 violation
{
  const root = makeRepo("remove-label");
  const tax = readJsonAt(root, path.join("patterns", "taxonomy.json"));
  tax.labels = tax.labels.filter((l) => l.id !== "unknown");
  writeJsonAt(root, path.join("patterns", "taxonomy.json"), tax);
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "8", "unknown"), "stable-ID (b): label removal w/o major bump fails at assertion 8", `exit=${r.exit}`);
}
// (d) removal WITH major bump -> NO assertion-8 violation (other checks may fire)
{
  const root = makeRepo("remove-label-bump");
  const tax = readJsonAt(root, path.join("patterns", "taxonomy.json"));
  tax.labels = tax.labels.filter((l) => l.id !== "unknown");
  tax.version = "2.0.0";
  writeJsonAt(root, path.join("patterns", "taxonomy.json"), tax);
  const r = run(["--project", root, "--json"]);
  assert(!hasViolation(r.payload, "8"), "stable-ID (d): removal WITH major bump passes assertion 8", `violations=${JSON.stringify((r.payload && r.payload.violations || []).filter((v) => v.check === "8"))}`);
}
// (c) pure add + scaffold-refresh + classifier arm -> FULL green (FP control)
{
  const root = makeRepo("add-label");
  const tax = readJsonAt(root, path.join("patterns", "taxonomy.json"));
  tax.labels.push({ id: "new_label", meaning: "pure-add FP control", overridable: true, gates: { plan_approval: "allow", pre_checkpoint: "allow", post_checkpoint: "allow" } });
  writeJsonAt(root, path.join("patterns", "taxonomy.json"), tax);
  const s = runScaffold(["--project", root, "--json"]);
  assert(s.exit === 0 && s.payload && s.payload.updated.length === 11, "stable-ID (c): scaffold refreshes all 11 contracts after taxonomy add", `exit=${s.exit} updated=${s.payload && s.payload.updated.length}`);
  const clsAbs = path.join(root, CLASSIFIER_REL);
  fs.writeFileSync(clsAbs, fs.readFileSync(clsAbs, "utf8").replace(/^(\s*)read_only\)(\s*)printf '1' ;;$/m, "$1new_label)$2printf '1' ;;\n$1read_only)$2printf '1' ;;"));
  // A taxonomy change also stales the plugin manifest's hash binding (assertion
  // 15 covers manifests; scaffold refreshes contracts only) — refresh it as the
  // manifest author would.
  const manRel = path.join("plugins", "claude-code", "manifest.json");
  const man = readJsonAt(root, manRel);
  man.taxonomy_version = taxonomyVersion(readJsonAt(root, path.join("patterns", "taxonomy.json")));
  writeJsonAt(root, manRel, man);
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 0, "stable-ID (c): pure add + scaffold refresh + classifier arm + manifest hash refresh = exit 0 (FP control)", `exit=${r.exit} violations=${JSON.stringify((r.payload && r.payload.violations || []).map((v) => v.check + ":" + v.detail.slice(0, 60)))}`);
}
// (e) bootstrap carve-out (N-5): taxonomy absent at merge-base, present at HEAD
{
  const root = makeRepo("bootstrap", { excludeAtBaseline: [path.join("patterns", "taxonomy.json")] });
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 0, "stable-ID (e): N-5 bootstrap (file absent at merge-base) passes", `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`);
}
// (f) no origin/main ref -> exit 2 fail-closed, never exit 1
{
  const root = makeRepo("no-origin", { withOriginRef: false });
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 2, "stable-ID (f): unresolvable merge-base is exit 2 (fail-closed)", `exit=${r.exit}`);
  assert(r.stderr.includes("fetch full history"), "stable-ID (f): stderr names the fetch-depth remedy", r.stderr.slice(0, 200));
}
// (g) shallow repo WITH an origin/main ref present -> exit 2 via the A2 guard
{
  const base = makeRepo("shallow-base");
  const shallow = path.join(TMP, "shallow-clone");
  execFileSync("git", ["clone", "-q", "--depth", "1", pathToFileURL(base).href, shallow], { encoding: "utf8", env: GIT_ENV });
  try { gitIn(shallow, ["update-ref", "refs/remotes/origin/main", "HEAD"]); } catch { /* ref may already exist from the clone */ }
  const r = run(["--project", shallow, "--json"]);
  assert(r.exit === 2, "stable-ID (g): shallow repo with origin/main ref is exit 2 (A2 guard)", `exit=${r.exit}`);
  assert(r.stderr.includes("shallow"), "stable-ID (g): stderr names the shallow condition", r.stderr.slice(0, 200));
}
// (14) events mirror: rename an event id without major bump -> assertion 14
{
  const root = makeRepo("rename-event");
  const ev = readJsonAt(root, path.join("patterns", "events.json"));
  ev.events.find((e) => e.id === "stop").id = "halt";
  writeJsonAt(root, path.join("patterns", "events.json"), ev);
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 1 && hasViolation(r.payload, "14", "stop"), "stable-ID events mirror: event rename w/o major bump fails at assertion 14", `exit=${r.exit}`);
}

// ---------------------------------------------------------------------------
// 7. Scaffold — SoT binding, round-trip, idempotency, merge-on-regenerate (F2),
//    malformed SoT, A6 cwd-negative.
// ---------------------------------------------------------------------------
{
  const root = makeRepo("scaffold-roundtrip");
  for (const f of fs.readdirSync(path.join(root, "patterns"))) {
    if (/^bp-[0-9]{3}\.json$/.test(f)) fs.rmSync(path.join(root, "patterns", f));
  }
  const s = runScaffold(["--project", root, "--json"]);
  assert(s.exit === 0 && s.payload && s.payload.created.length === 11, "scaffold: creates exactly 11 contracts from a clean slate", `exit=${s.exit} created=${s.payload && s.payload.created.length}`);
  assert(s.payload && !s.payload.derived_ids.includes("bp-007"), "scaffold: bp-007 NOT generated (N-1)");
  const r = run(["--project", root, "--json"]);
  assert(r.exit === 0, "scaffold round-trip: scaffolded repo passes the validator end-to-end", `exit=${r.exit} stderr=${r.stderr.slice(0, 300)}`);

  // idempotency: second run is byte-stable
  const before = fs.readFileSync(path.join(root, "patterns", "bp-001.json"), "utf8");
  const s2 = runScaffold(["--project", root, "--json"]);
  assert(s2.exit === 0 && s2.payload && s2.payload.unchanged.length === 11 && s2.payload.created.length === 0 && s2.payload.updated.length === 0, "scaffold: re-run is byte-stable (11 unchanged)", `payload=${JSON.stringify(s2.payload && { c: s2.payload.created.length, u: s2.payload.updated.length, n: s2.payload.unchanged.length })}`);
  assert(fs.readFileSync(path.join(root, "patterns", "bp-001.json"), "utf8") === before, "scaffold: bp-001.json byte-identical after re-run");

  // merge-on-regenerate (F2): hand-relaxed tier survives a hash refresh
  const bp2 = readJsonAt(root, path.join("patterns", "bp-002.json"));
  bp2.gates.plan_approval = "WEAK";
  writeJsonAt(root, path.join("patterns", "bp-002.json"), bp2);
  const tax = readJsonAt(root, path.join("patterns", "taxonomy.json"));
  tax.labels[0].meaning = tax.labels[0].meaning + " (editorial change -> new hash)";
  writeJsonAt(root, path.join("patterns", "taxonomy.json"), tax);
  const newTax = taxonomyVersion(tax);
  const s3 = runScaffold(["--project", root, "--json"]);
  const bp2After = readJsonAt(root, path.join("patterns", "bp-002.json"));
  assert(s3.exit === 0 && bp2After.gates.plan_approval === "WEAK", "scaffold F2: hand-relaxed tier survives regeneration", `tier=${bp2After.gates.plan_approval}`);
  assert(bp2After.taxonomy_version === newTax, "scaffold F2: taxonomy_version refreshed to the new live hash", `have=${bp2After.taxonomy_version}`);
}
{
  const root = makeRepo("scaffold-badsot");
  const idx = readJsonAt(root, path.join("patterns", "_index.json"));
  idx.patterns[0].pattern_id = "bp-7-bad";
  writeJsonAt(root, path.join("patterns", "_index.json"), idx);
  const s = runScaffold(["--project", root, "--json"]);
  assert(s.exit === 2, "scaffold: malformed pattern_id in the SoT is exit 2 (fail-closed)", `exit=${s.exit}`);
  assert(s.stderr.includes("bp-7-bad"), "scaffold: stderr names the malformed pattern_id", s.stderr.slice(0, 200));
}
{
  // A6: nothing lands under the CALLER cwd — writes bind to --project only.
  const root = makeRepo("scaffold-cwd");
  const cwdDir = path.join(TMP, "elsewhere-cwd");
  fs.mkdirSync(cwdDir, { recursive: true });
  const s = runScaffold(["--project", root, "--json"], { cwd: cwdDir });
  assert(s.exit === 0, "scaffold A6: runs from a foreign cwd", `exit=${s.exit}`);
  const strays = fs.readdirSync(cwdDir).filter((n) => /^bp-.*\.json$/.test(n));
  assert(strays.length === 0, "scaffold A6: no bp-*.json written under the caller cwd", `strays=${strays.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 8. Injection containment + usage errors — exit 2, never conflated with 1.
// ---------------------------------------------------------------------------
{
  const outside = path.join(TMP, "outside-taxonomy.json");
  fs.copyFileSync(path.join(REPO_ROOT, "patterns", "taxonomy.json"), outside);
  const r = run(["--project", SANDBOX, "--taxonomy", outside, "--json"]);
  assert(r.exit === 2, "injection containment: --taxonomy outside --project root is exit 2", `exit=${r.exit}`);
}
{
  const r = run(["--project", SANDBOX, "--bp-dir", path.join("..", ".."), "--json"]);
  assert(r.exit === 2, "injection containment: --bp-dir ../ escape is exit 2", `exit=${r.exit}`);
}
{
  const r = run(["--project", path.join(TMP, "does-not-exist")]);
  assert(r.exit === 2, "nonexistent --project: exit 2", `exit=${r.exit}`);
}
{
  const r = run(["--bogus"]);
  assert(r.exit === 2 && r.stderr.includes("--bogus"), "unknown argument: exit 2, named in stderr", `exit=${r.exit}`);
}
{
  // corrupt effective taxonomy is an INPUT failure -> exit 2 (never exit 1)
  const broken = path.join(SANDBOX, "injected-broken.json");
  fs.writeFileSync(broken, "{ not json");
  const r = run(["--project", SANDBOX, "--taxonomy", broken, "--json"]);
  assert(r.exit === 2, "corrupt injected taxonomy: exit 2 (input failure, not a violation)", `exit=${r.exit}`);
  fs.rmSync(broken);
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ntest-validate-bp-contract: ${pass} passed, ${fail} failed, ${skipped} skipped`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
if (pass === 0) {
  console.error("✗ zero checks executed (vacuous run)");
  process.exit(1);
}
console.log("✓ all validate-bp-contract checks passed");
