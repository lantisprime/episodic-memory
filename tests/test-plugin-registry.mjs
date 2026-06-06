// test-plugin-registry.mjs — RFC-008 R0c P1b conformance tests for
// scripts/validate-plugin-registry.mjs (M-checks + corpus routing + 6-axis
// project-root binding matrix + 8-axis symlink/path-authority + version gate +
// M4a injection + M-cross). The instance-validator's own closure units live in
// tests/test-json-instance-validate.mjs.
//
// Run: node tests/test-plugin-registry.mjs   (exit 0 = pass)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  validateRegistry,
  gateSchemaVersion,
  parseSemverStrict,
  checkBidirectionalDirs,
  MAX_SUPPORTED,
  RESERVED_DIRS,
} from "../scripts/validate-plugin-registry.mjs";
import { validateInstance } from "../scripts/lib/json-instance-validate.mjs";

const REPO = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const VALIDATOR = path.join(REPO, "scripts/validate-plugin-registry.mjs");
const FIXDIR = path.join(REPO, "tests/fixtures/plugins");
const readJson = (abs) => JSON.parse(fs.readFileSync(abs, "utf8"));

let pass = 0, fail = 0, skip = 0;
const failures = [];
const ok = () => pass++;
const bad = (n, d) => { fail++; failures.push(`${n}${d ? " — " + d : ""}`); };
const assert = (c, n, d) => (c ? ok() : bad(n, d));
const log = (m) => process.stdout.write(`  · ${m}\n`);

const SCHEMAS = {
  manifest: readJson(path.join(REPO, "plugins/manifest.schema.json")),
  _index: readJson(path.join(REPO, "plugins/_index.schema.json")),
  "structured-alert": readJson(path.join(REPO, "schemas/runtime/structured-alert.schema.json")),
  bypass_known: readJson(path.join(REPO, "plugins/bypass_known.schema.json")),
};

// Minimal context for temp-dir symlink scenarios (copied from the real repo).
// Declared up here (not in the helper block) so section-4's symlink-temp route
// can use it before the helper block's line is reached (avoids a const TDZ).
const CONTEXT_FILES = [
  "plugins/_index.schema.json", "plugins/manifest.schema.json", "plugins/bypass_known.schema.json",
  "plugins/installed-state.schema.json", "schemas/runtime/structured-alert.schema.json",
  "patterns/taxonomy.json", "patterns/events.json", "plugins/bypass_known.json",
];

// ===========================================================================
// 1. LIVE registry PASS (the primary done-when) — in-process + CLI.
// ===========================================================================
{
  const r = validateRegistry({ projectRoot: REPO });
  assert(r.status === "ok" && r.violations.length === 0, "live claude-code registry validates (status ok, 0 violations)", JSON.stringify(r.violations.slice(0, 4)));
  assert(r.project_root === REPO, "live: project_root is the canonical repo root");
  assert(r.read_trace.every((p) => p === REPO || p.startsWith(REPO + path.sep)), "live: every read_trace entry is under the project root");
}
{
  const cli = runCLI(["--project", REPO, "--json"], REPO);
  assert(cli.exit === 0 && cli.json && cli.json.status === "ok", "CLI: --project <repo> exits 0 with status ok", `exit=${cli.exit}`);
}

// ===========================================================================
// 2. MAX_SUPPORTED is byte-equal to the corpus oracle (constant can't drift).
// ===========================================================================
{
  const corpus = readJson(path.join(FIXDIR, "_corpus-index.json"));
  assert(MAX_SUPPORTED === corpus.current_schema_version.value, "MAX_SUPPORTED == _corpus-index.current_schema_version oracle", `${MAX_SUPPORTED} vs ${corpus.current_schema_version.value}`);
}

// ===========================================================================
// 3. Version parse/gate DIRECT units (F4 — the schema pattern short-circuits
//    the full validator, so the parse hardening is tested at the fn level).
// ===========================================================================
{
  assert(parseSemverStrict("1.0") === null, "parseSemverStrict rejects two-part '1.0'");
  assert(parseSemverStrict("1.0.0-beta") === null, "parseSemverStrict rejects prerelease '1.0.0-beta'");
  assert(parseSemverStrict("1.0.0") && parseSemverStrict("1.0.0").patch === 0, "parseSemverStrict accepts '1.0.0'");
  const g = (s) => gateSchemaVersion(s, "1.0.0");
  assert(!g("1.0").ok && g("1.0").reason === "unparseable", "gate: '1.0' -> unparseable (before any numeric compare; no NaN>max)");
  assert(!g("1.0.0-beta").ok && g("1.0.0-beta").reason === "unparseable", "gate: '1.0.0-beta' -> unparseable");
  assert(!g("1.1.0").ok && g("1.1.0").reason === "forward", "gate: '1.1.0' minor>max -> forward fail-closed");
  assert(!g("2.0.0").ok && g("2.0.0").reason === "forward", "gate: '2.0.0' major>max -> forward fail-closed");
  assert(g("1.0.1").ok, "gate: '1.0.1' patch>max -> ACCEPT (patch is bug-level, RFC L118)");
  assert(g("1.0.0").ok, "gate: '1.0.0' == max -> ACCEPT");
  assert(g("01.0.0").ok, "gate: '01.0.0' -> ACCEPT (no leading-zero reject; agrees with schema pattern, F4)");
}

// ===========================================================================
// 4. CORPUS ROUTING — dispatch every fixture by `inject`; assert behavior +
//    routing closure + bidirectional disk<->index parity (GAP-2 + F8).
// ===========================================================================
{
  const corpus = readJson(path.join(FIXDIR, "_corpus-index.json"));
  const fixtures = corpus.fixtures;
  const vocab = new Set(corpus.detected_by_vocabulary);
  const INJECT_MODES = new Set(["schema", "manifest", "index", "bypass-known", "symlink-temp", "deferred"]);
  let routed = 0;

  const hasViolation = (r, check, reason) =>
    r.violations.some((v) => v.check === check && (!reason || v.reason === reason || v.keyword === reason));

  for (const [name, meta] of Object.entries(fixtures)) {
    const abs = path.join(FIXDIR, name);
    assert(vocab.has(meta.detected_by) || meta.detected_by === null, `routing: ${name} detected_by in vocabulary`, String(meta.detected_by));
    assert(INJECT_MODES.has(meta.inject), `routing: ${name} inject mode known`, meta.inject);
    routed++;

    if (meta.inject === "schema") {
      const r = validateInstance(readJson(abs), SCHEMAS[meta.target_schema]);
      assert(!r.valid, `corpus[schema]: ${name} rejected by ${meta.target_schema}.schema`, JSON.stringify(r.errors.slice(0, 2)));
    } else if (meta.inject === "manifest") {
      const r = validateRegistry({ projectRoot: REPO, manifestPath: abs });
      if (meta.expect === "pass") {
        assert(r.status === "ok", `corpus[manifest]: ${name} PASSES`, JSON.stringify(r.violations.slice(0, 3)));
      } else {
        assert(hasViolation(r, meta.attributed_check, meta.attributed_reason), `corpus[manifest]: ${name} fails at attributed ${meta.attributed_check}${meta.attributed_reason ? "/" + meta.attributed_reason : ""}`, JSON.stringify(r.violations.slice(0, 4)));
      }
    } else if (meta.inject === "index") {
      const r = validateRegistry({ projectRoot: REPO, indexPath: abs });
      assert(hasViolation(r, meta.attributed_check, meta.attributed_reason), `corpus[index]: ${name} fails at attributed ${meta.attributed_check}/${meta.attributed_reason}`, JSON.stringify(r.violations.slice(0, 4)));
    } else if (meta.inject === "bypass-known") {
      const r = validateRegistry({ projectRoot: REPO, bypassKnownPath: abs });
      assert(hasViolation(r, meta.attributed_check, meta.attributed_reason), `corpus[bypass-known]: ${name} fails at attributed ${meta.attributed_check}/${meta.attributed_reason}`, JSON.stringify(r.violations.slice(0, 4)));
    } else if (meta.inject === "deferred") {
      // p3-runtime: recorded deferred, NOT run (must not be silently treated as pass).
      assert(meta.detected_by === "p3-runtime", `corpus[deferred]: ${name} is p3-runtime (recorded deferred, not run)`);
    } else if (meta.inject === "symlink-temp") {
      runSymlinkEscapeFixture(name, meta);
    }
  }

  // routing closure (GAP-2): every fixture routed.
  assert(routed === Object.keys(fixtures).length, "routing closure: count(routed) === count(fixtures)", `${routed}/${Object.keys(fixtures).length}`);

  // bidirectional disk<->index parity (F8): no disk-only or index-only fixture.
  const EXCLUDE = new Set(["_corpus-index.json", "non-overridable-inputs.json"]);
  const diskFixtures = fs.readdirSync(FIXDIR).filter((f) => f.endsWith(".json") && !EXCLUDE.has(f));
  for (const f of diskFixtures) assert(f in fixtures, `disk->index parity: ${f} has an index entry`, "disk-only fixture (unrouted)");
  for (const k of Object.keys(fixtures)) assert(fs.existsSync(path.join(FIXDIR, k)), `index->disk parity: ${k} exists on disk`, "index entry without a file");
}

// ===========================================================================
// 4b. Injection containment (F7/F29; regression for negative-scenario-reviewer
//     FU-1). --manifest / --index / --bypass-known are caller-controlled, so an
//     out-of-project path must NOT be read: realpath-contain under --project,
//     escape -> exit 2, escape path never in read_trace.
// ===========================================================================
{
  const outside = path.join(os.tmpdir(), `vpr-evil-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ records: [] }));
  const outsideReal = fs.realpathSync(outside);
  try {
    for (const flag of ["--manifest", "--index", "--bypass-known"]) {
      const r = runCLI([flag, outside, "--project", REPO, "--json"], REPO);
      const trace = (r.json && r.json.read_trace) || [];
      assert(r.exit === 2 && !trace.includes(outsideReal), `injection containment: ${flag} <out-of-repo> -> exit 2, escape path never read (F7/F29 FU-1)`, `exit=${r.exit} traceHasEscape=${trace.includes(outsideReal)}`);
    }
    // a relative ../ escape is rejected too (not just absolute).
    const rel = runCLI(["--manifest", "../outside.json", "--project", REPO, "--json"], REPO);
    assert(rel.exit === 2, "injection containment: --manifest ../outside.json (relative escape) -> exit 2", `exit=${rel.exit}`);
  } finally { rmrf(outside); }
}

// ===========================================================================
// 5. RESERVED_DIRS annotation (N2) + M8 bidirectional dir<->entry (unit).
// ===========================================================================
{
  assert(RESERVED_DIRS["episodic-memory"] && RESERVED_DIRS["episodic-memory"].presence === "on-disk", "M8: episodic-memory reserved as on-disk");
  assert(RESERVED_DIRS["second-opinion"] && RESERVED_DIRS["second-opinion"].presence === "reserved-for-Follow", "M8: second-opinion reserved-for-Follow (annotation-only; dir not yet on disk — N2)");

  const tmp = mkdtemp();
  try {
    fs.mkdirSync(path.join(tmp, "plugins/claude-code"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "plugins/episodic-memory"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "plugins/rogue-plugin"), { recursive: true });
    const collect = () => { const vs = []; return { vs, add: (check, sev, detail, extra = {}) => vs.push({ check, ...extra }) }; };

    let c = collect();
    checkBidirectionalDirs(tmp, [{ directory: "plugins/claude-code" }], c.add, []);
    assert(c.vs.some((v) => v.keyword === "orphan_dir" && v.dir === "rogue-plugin"), "M8: a non-reserved orphan dir fails");
    assert(!c.vs.some((v) => v.dir === "episodic-memory"), "M8: episodic-memory reserved dir is skipped (present on disk)");
    assert(!c.vs.some((v) => v.dir === "claude-code"), "M8: claude-code dir with an entry passes");

    c = collect();
    checkBidirectionalDirs(tmp, [{ directory: "plugins/claude-code" }, { directory: "plugins/ghost" }], c.add, []);
    assert(c.vs.some((v) => v.keyword === "entry_dir_missing" && v.dir === "ghost"), "M8: an entry pointing at a missing dir fails");

    // reserved on-disk absent -> reserved_absent (stale exemption risk).
    const tmp2 = mkdtemp();
    fs.mkdirSync(path.join(tmp2, "plugins/claude-code"), { recursive: true }); // NO episodic-memory dir
    c = collect();
    checkBidirectionalDirs(tmp2, [{ directory: "plugins/claude-code" }], c.add, []);
    assert(c.vs.some((v) => v.keyword === "reserved_absent" && v.dir === "episodic-memory"), "M8: an on-disk reserved dir that is absent fails (typo can't silently exempt a real orphan)");
    rmrf(tmp2);
  } finally { rmrf(tmp); }
}

// ===========================================================================
// 6. 6-axis project-root binding matrix + read-path trace (R2-2/R3-1).
// ===========================================================================
{
  const realRepo = fs.realpathSync(REPO);
  const underRepo = (j) => j.read_trace.every((p) => p === realRepo || p.startsWith(realRepo + path.sep));

  // axis 1 — caller-cwd != --project.
  {
    const t = mkdtemp();
    const r = runCLI(["--project", REPO, "--json"], t);
    assert(r.exit === 0 && r.json.project_root === realRepo && underRepo(r.json), "binding axis 1: caller-cwd != --project -> reads + project_root under --project");
    rmrf(t);
  }
  // axis 2 — nested cwd inside target.
  {
    const r = runCLI(["--project", REPO, "--json"], path.join(REPO, "scripts"));
    assert(r.exit === 0 && r.json.project_root === realRepo, "binding axis 2: nested cwd inside target -> root is target, not cwd");
  }
  // axis 3 + residual a — non-git/explicit wins; a real git root at cwd is ignored.
  {
    const t = mkdtemp();
    try { execFileSync("git", ["init", "-q"], { cwd: t }); } catch {}
    const r = runCLI(["--project", REPO, "--json"], t);
    assert(r.exit === 0 && r.json.project_root === realRepo, "binding axis 3 + residual(a): explicit --project wins; git rev-parse NOT consulted (planted .git at cwd ignored)", `got ${r.json && r.json.project_root}`);
    rmrf(t);
  }
  // axis 4 + residual b — non-git cwd, no --project -> exit 2, read_trace == [].
  {
    const t = mkdtemp();
    const r = runCLI(["--json"], t);
    assert(r.exit === 2 && r.json && r.json.read_trace.length === 0, "binding axis 4 + residual(b): non-git cwd, no --project -> exit 2 with empty read_trace (no silent caller-cwd read)", `exit=${r.exit} trace=${r.json && r.json.read_trace.length}`);
    rmrf(t);
  }
  // axis 5 — linked worktree (git-dependent; SKIP-log on failure).
  {
    const wt = path.join(os.tmpdir(), `vpr-wt-${process.pid}`);
    let made = false;
    try { execFileSync("git", ["worktree", "add", "-q", "--detach", wt, "HEAD"], { cwd: REPO, stdio: ["ignore", "ignore", "ignore"] }); made = true; } catch { /* shallow/locked */ }
    if (made) {
      try {
        const r = runCLI(["--project", wt, "--json"], os.tmpdir());
        // Root RESOLUTION is what axis 5 asserts (the worktree is at committed
        // HEAD and may lack uncommitted registry files, so a full pass is not
        // the contract here): project_root canonicalizes to the worktree root.
        assert(r.json && r.json.project_root === fs.realpathSync(wt), "binding axis 5: linked worktree -> project_root resolves to the (canonical) worktree root, never the caller cwd", `got ${r.json && r.json.project_root}`);
      } finally {
        try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: REPO, stdio: ["ignore", "ignore", "ignore"] }); } catch {}
      }
    } else { skip++; log("binding axis 5 SKIP: git worktree add unavailable in this environment"); }
  }
  // axis 6 — HOME elsewhere; no leak to HOME.
  {
    const home = mkdtemp();
    const r = runCLI(["--project", REPO, "--json"], REPO, { HOME: home });
    assert(r.exit === 0 && r.json.project_root === realRepo && r.json.read_trace.every((p) => !p.startsWith(home + path.sep)), "binding axis 6: HOME elsewhere -> reads under --project, no leak to HOME");
    rmrf(home);
  }
}

// ===========================================================================
// 7. Symlink / path-authority axes 5/6/7 (§6) — temp-dir plants, capability
//    probe + explicit SKIP where symlinkSync is unprivileged (F9 / cross-OS).
// ===========================================================================
{
  if (!symlinkCapable()) {
    skip += 3;
    log("symlink axes 5/6/7 SKIP: symlinkSync unavailable/unprivileged on this platform");
  } else {
    // axis 5 — symlink -> out-of-bounds (the bad-runbook-symlink-escape class).
    runSymlinkScenario("axis5 symlink->out-of-bounds", "symlink_escape", (rbDir, tmp) => {
      const outside = path.join(tmp, "outside-target.md");
      fs.writeFileSync(outside, "x".repeat(2048));
      fs.symlinkSync(outside, path.join(rbDir, "enforcement.md"));
    });
    // axis 6 — dangling symlink (target missing).
    runSymlinkScenario("axis6 dangling symlink", "dangling_symlink", (rbDir) => {
      fs.symlinkSync(path.join(rbDir, "no-such-target.md"), path.join(rbDir, "enforcement.md"));
    });
    // axis 7 — symlink loop a->b->a.
    runSymlinkScenario("axis7 symlink loop", "symlink_loop", (rbDir) => {
      fs.symlinkSync(path.join(rbDir, "enforcement.md"), path.join(rbDir, "loop-b.md"));
      fs.symlinkSync(path.join(rbDir, "loop-b.md"), path.join(rbDir, "enforcement.md"));
    });
  }
}

// ===========================================================================
// Helpers.
// ===========================================================================
function runCLI(args, cwd, extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  try {
    const out = execFileSync("node", [VALIDATOR, ...args], { cwd, encoding: "utf8", env });
    return { exit: 0, json: tryParse(out) };
  } catch (e) {
    return { exit: e.status, json: tryParse(e.stdout), stderr: e.stderr };
  }
}
function tryParse(s) { try { return JSON.parse(s); } catch { return null; } }
function mkdtemp() { return fs.mkdtempSync(path.join(os.tmpdir(), "vpr-")); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function symlinkCapable() {
  const t = mkdtemp();
  try { fs.writeFileSync(path.join(t, "a"), "a"); fs.symlinkSync(path.join(t, "a"), path.join(t, "b")); return true; }
  catch { return false; }
  finally { rmrf(t); }
}

function buildMinimalContext(tmp) {
  for (const rel of CONTEXT_FILES) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), dest);
  }
}

// Build a temp project with a planted symlink at the runbook.full path, then
// run the live claude-code manifest against it and assert the M7b reason code.
function runSymlinkScenario(label, expectKeyword, plant) {
  const tmp = mkdtemp();
  try {
    buildMinimalContext(tmp);
    const rbDir = path.join(tmp, "plugins/claude-code/runbooks");
    fs.mkdirSync(rbDir, { recursive: true });
    fs.writeFileSync(path.join(rbDir, "enforcement.quickref.md"), "q".repeat(512)); // real quickref (>=256)
    plant(rbDir, tmp);
    const manifest = readJson(path.join(FIXDIR, "good-manifest.json"));
    const manPath = path.join(tmp, "manifest.json");
    fs.writeFileSync(manPath, JSON.stringify(manifest));
    const r = validateRegistry({ projectRoot: tmp, manifestPath: manPath });
    assert(r.violations.some((v) => v.check === "M7b" && v.keyword === expectKeyword), `symlink ${label}: M7b ${expectKeyword}`, JSON.stringify(r.violations.slice(0, 4)));
  } finally { rmrf(tmp); }
}

// The bad-runbook-symlink-escape corpus fixture (inject=symlink-temp): plant a
// symlink-escape and assert it via the same temp-dir scenario.
function runSymlinkEscapeFixture(name, meta) {
  if (!symlinkCapable()) { skip++; log(`corpus[symlink-temp]: ${name} SKIP (symlinkSync unavailable)`); return; }
  runSymlinkScenario(`corpus ${name}`, "symlink_escape", (rbDir, tmp) => {
    const outside = path.join(tmp, "escape-target.md");
    fs.writeFileSync(outside, "x".repeat(2048));
    fs.symlinkSync(outside, path.join(rbDir, "enforcement.md"));
  });
}

// ===========================================================================
console.log(`\ntest-plugin-registry: ${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all plugin-registry conformance checks passed");
