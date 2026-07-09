#!/usr/bin/env node
// test-activation-sessionstart.mjs — RFC-009 P2-S5 (R4) Group 3 E2E tests for
// the SessionStart advisory activation hook (activation-sessionstart.sh ->
// activation-hook-run.mjs, SHARED with the R3 hooks per §8.2 SYMMETRY) plus
// REQ-26's session-handoff blend switch.
//
// Fixture scaffold mirrors tests/test-activation-hook-e2e.mjs exactly (same
// rationale: activation-hook-run.mjs resolves scripts/lib/ relative to
// itself, so driving the REAL committed hook bytes needs an isolated repo-
// shaped temp tree) — extended with activation-sessionstart.sh in the copy
// loop and a `sessionstart` case in runHook, plus a violation-linking helper
// to earn the band-8/9 `critical_entries` fixtures need (RFC-009 REQ-13:
// effective_priority is DERIVED from linked violations, never declared).
//
// Run: node tests/test-activation-sessionstart.mjs   (exit 0 = pass)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const REAL_HOOKS_DIR = path.join(REPO_ROOT, "plugins/claude-code-activation/hooks");

let pass = 0, fail = 0;
const failures = [];
const ok = () => pass++;
const bad = (n, d) => { fail++; failures.push(`${n}${d ? " — " + d : ""}`); };
const assert = (c, n, d) => (c ? ok() : bad(n, d));

// ===========================================================================
// Fake-repo scaffold (module-level, built ONCE) + per-test fixture helpers.
// ===========================================================================
// realpathSync (macOS /var -> /private/var etc.): rebuildFresh() below invokes
// em-trigger-index.mjs DIRECTLY (bypassing the .sh wrapper's `cd -P`
// canonicalization) to force synchronous fixture builds; em-trigger-index's
// isMainModule() compares import.meta.url (resolved through any symlink)
// against a raw, unresolved argv[1] -- a mismatch there silently skips the
// entire CLI block (empty stdout, exit 0). Canonicalizing FAKE_ROOT once here
// keeps every path derived from it already-resolved, matching what the
// production .sh wrapper's `cd -P` guarantees for the real deployed hook.
const FAKE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "act-sessionstart-repo-")));
fs.cpSync(path.join(REPO_ROOT, "scripts"), path.join(FAKE_ROOT, "scripts"), { recursive: true });
fs.cpSync(path.join(REPO_ROOT, "schemas"), path.join(FAKE_ROOT, "schemas"), { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, "activation-classes.json"), path.join(FAKE_ROOT, "activation-classes.json"));
const FAKE_HOOKS_DIR = path.join(FAKE_ROOT, "plugins/claude-code-activation/hooks");
fs.mkdirSync(FAKE_HOOKS_DIR, { recursive: true });
for (const f of ["activation-sessionstart.sh", "activation-hook-run.mjs"]) {
  const dst = path.join(FAKE_HOOKS_DIR, f);
  fs.copyFileSync(path.join(REAL_HOOKS_DIR, f), dst);
  fs.chmodSync(dst, 0o755);
}
const FAKE_MANIFEST_PATH = path.join(FAKE_ROOT, "plugins/claude-code-activation/manifest.json");
const FAKE_TRIGGER_INDEX_SCRIPT = path.join(FAKE_ROOT, "scripts/em-trigger-index.mjs");

const _tmpDirs = [FAKE_ROOT];
process.on("exit", () => {
  for (const d of _tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

function writeManifest({ slug, root, harness = "claude-code" }) {
  fs.writeFileSync(FAKE_MANIFEST_PATH, JSON.stringify({
    type: "activation", schema_version: "1.0.0", id: harness, harness, version: "1.0.0",
    blocking: false,
    capabilities: { user_prompt_submit: "STRONG", pre_tool_use: "STRONG", session_start: "STRONG" },
    registrations: [],
    io_schema: "schemas/runtime/activation-io.schema.json",
    runbook: { full: "x", quickref: "y" },
    project_identity: { slug, root },
  }));
}
function removeManifest() {
  fs.rmSync(FAKE_MANIFEST_PATH, { force: true });
}

function mkFixture(label) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `act-sessionstart-${label}-`)));
  _tmpDirs.push(base);
  const home = path.join(base, "home");
  const proj = path.join(base, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true }); // marker only; resolveLocalDir falls back to cwd
  return { base, home, proj };
}

function scrubEnv(env) {
  delete env.CLAUDE_CONFIG_DIR;
  delete env.SO_INSTALL_SNAPSHOT_PATH;
  delete env.SO_RUNBOOK_PATH;
  delete env.SO_QUICKREF_PATH;
  delete env.ANTHROPIC_API_KEY;
  delete env.EM_ACTIVATION_CLASSES_PATH;
  return env;
}

function storeEpisode(home, proj, opts) {
  const {
    project = "acme", summary, body = "body", appliesToProject = "acme",
    appliesToTool = "claude-code", priority = 4,
  } = opts;
  const args = [
    path.join(REPO_ROOT, "scripts/em-store.mjs"),
    "--project", project, "--category", "lesson", "--tags", "test",
    "--summary", summary, "--body", body, "--scope", "local",
  ];
  if (appliesToProject) args.push("--applies-to-project", appliesToProject);
  if (appliesToTool) args.push("--applies-to-tool", appliesToTool);
  if (priority !== undefined) args.push("--priority", String(priority));
  const env = scrubEnv({ ...process.env, HOME: home });
  const r = spawnSync("node", args, { cwd: proj, env, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`em-store failed (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

// Earn a band by linking N violations to a lesson (REQ-13: effective_priority
// is DERIVED, 0 links -> stored(1-7), 1 -> 8, >=2 -> 9; never declared).
function linkViolations(home, proj, lessonId, count) {
  for (let i = 0; i < count; i++) {
    const args = [
      path.join(REPO_ROOT, "scripts/em-violation.mjs"),
      "--pattern", "bp-001-implementation-workflow",
      "--summary", `probe violation ${i}`,
      "--body", "violation body",
      "--project", "acme",
      "--scope", "local",
      "--lesson", lessonId,
    ];
    const env = scrubEnv({ ...process.env, HOME: home });
    const r = spawnSync("node", args, { cwd: proj, env, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) throw new Error(`em-violation failed (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
}

function storeCritical(home, proj, opts, linkCount = 2) {
  const ep = storeEpisode(home, proj, opts);
  linkViolations(home, proj, ep.id, linkCount);
  return ep;
}

function triggerIndexPath(proj) {
  return path.join(proj, ".episodic-memory", "trigger-index.json");
}

function runHook({ home, stdin, extraEnv = {} }) {
  const env = scrubEnv({ ...process.env, HOME: home, ...extraEnv });
  const r = spawnSync("bash", [path.join(FAKE_HOOKS_DIR, "activation-sessionstart.sh")], {
    cwd: home,
    env,
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8",
    timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function noDecisionField(stdout) {
  return !/"decision"|"block"|"permissionDecision"/.test(stdout);
}
function parseHookOut(stdout) {
  const line = stdout.trim();
  if (!line) return null;
  return JSON.parse(line);
}

// Force the store to be re-forced BUILD-fresh before a test starts (the R2
// build ran once by em-store/em-violation already; this just names it).
function rebuildFresh(home, proj) {
  const env = scrubEnv({ ...process.env, HOME: home });
  spawnSync("node", [FAKE_TRIGGER_INDEX_SCRIPT, "--scope", "local", "--project", proj], { cwd: proj, env, encoding: "utf8", timeout: 15000 });
}

// GLOBAL-store helpers (F2/F3 cross-store merge coverage): under the mock HOME,
// `--scope global` writes to $HOME/.episodic-memory. The hook reads BOTH the
// local (identity.root) and the global store, so seeding a global lesson +
// building the global trigger-index.json exercises mergeSessionStart's
// cross-store path (preflight sum, static_score re-sort, cross-tier dedup).
function storeEpisodeGlobal(home, proj, opts) {
  const {
    project = "acme", summary, body = "body", appliesToProject = "acme",
    appliesToTool = "claude-code", priority = 4,
  } = opts;
  const args = [
    path.join(REPO_ROOT, "scripts/em-store.mjs"),
    "--project", project, "--category", "lesson", "--tags", "test",
    "--summary", summary, "--body", body, "--scope", "global",
  ];
  if (appliesToProject) args.push("--applies-to-project", appliesToProject);
  if (appliesToTool) args.push("--applies-to-tool", appliesToTool);
  if (priority !== undefined) args.push("--priority", String(priority));
  const env = scrubEnv({ ...process.env, HOME: home });
  const r = spawnSync("node", args, { cwd: proj, env, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`em-store (global) failed (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

function linkViolationsGlobal(home, proj, lessonId, count) {
  for (let i = 0; i < count; i++) {
    const args = [
      path.join(REPO_ROOT, "scripts/em-violation.mjs"),
      "--pattern", "bp-001-implementation-workflow",
      "--summary", `global probe violation ${i}`,
      "--body", "violation body",
      "--project", "acme",
      "--scope", "global",
      "--lesson", lessonId,
    ];
    const env = scrubEnv({ ...process.env, HOME: home });
    const r = spawnSync("node", args, { cwd: proj, env, encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) throw new Error(`em-violation (global) failed (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
}

function rebuildFreshGlobal(home, proj) {
  const env = scrubEnv({ ...process.env, HOME: home });
  spawnSync("node", [FAKE_TRIGGER_INDEX_SCRIPT, "--scope", "global"], { cwd: proj, env, encoding: "utf8", timeout: 15000 });
}

// ===========================================================================
// 1. tier1_critical_loads
// ===========================================================================
{
  const { home, proj } = mkFixture("tier1-loads");
  writeManifest({ slug: "acme", root: proj });
  const crit = storeCritical(home, proj, { summary: "critical loads probe" }, 2);
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart", source: "startup" } });
  const out = parseHookOut(r.stdout);
  assert(r.status === 0, "tier1_critical_loads: hook exits 0", `status=${r.status} stderr=${r.stderr}`);
  assert(!!out && out.hookSpecificOutput && out.hookSpecificOutput.hookEventName === "SessionStart",
    "tier1_critical_loads: emits hookSpecificOutput.hookEventName=SessionStart", r.stdout);
  assert(!!out && out.hookSpecificOutput.additionalContext.includes(`READ ${crit.id}`),
    "tier1_critical_loads: band-9 lesson renders imperative, trigger-independent (no --trigger was set)", r.stdout);
  removeManifest();
}

// ===========================================================================
// 2. tier1_determinism
// ===========================================================================
{
  const { home, proj } = mkFixture("tier1-determinism");
  writeManifest({ slug: "acme", root: proj });
  storeCritical(home, proj, { summary: "determinism probe a" }, 2);
  storeCritical(home, proj, { summary: "determinism probe b" }, 1);
  rebuildFresh(home, proj);
  const r1 = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const r2 = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  assert(r1.status === 0 && r2.status === 0 && r1.stdout === r2.stdout,
    "tier1_determinism: repeated SessionStart runs against an unchanged store yield byte-identical output", `${r1.stdout}\n---\n${r2.stdout}`);
  removeManifest();
}

// ===========================================================================
// 3. tier1_band_overflow_noted
// ===========================================================================
{
  const { home, proj } = mkFixture("tier1-overflow");
  writeManifest({ slug: "acme", root: proj });
  for (let i = 0; i < 4; i++) storeCritical(home, proj, { summary: `overflow probe ${i}` }, 2);
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  assert(r.status === 0 && !!out, "tier1_band_overflow_noted: hook exits 0 and emits output", `status=${r.status} stderr=${r.stderr}`);
  assert(out.hookSpecificOutput.additionalContext.includes("incl. critical"),
    "tier1_band_overflow_noted: 4 critical entries with a max_matches:3 bound emit the overflow note", r.stdout);
  assert(noDecisionField(r.stdout), "tier1_band_overflow_noted: overflow path still carries no decision field", r.stdout);
  removeManifest();
}

// ===========================================================================
// 4. tier2_static_order_plain_only / tier_dedup_cross_tier (EC13)
// ===========================================================================
{
  const { home, proj } = mkFixture("tier2-dedup");
  writeManifest({ slug: "acme", root: proj });
  const crit = storeCritical(home, proj, { summary: "dedup critical probe" }, 2);
  const plain = storeEpisode(home, proj, { summary: "dedup plain probe", priority: 6 });
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(ctx.includes(`READ ${crit.id}`), "tier2_static_order_plain_only: the critical lesson renders imperative (tier 1)", ctx);
  assert(ctx.includes(`lesson ${plain.id}:`), "tier2_static_order_plain_only: the plain lesson renders plain (tier 2)", ctx);
  // renderLine's imperative form legitimately repeats the id twice within its
  // OWN line (`READ <id> ... --history <id> --full`) -- the dedup assertion
  // is that the PLAIN tier-2 rendering of the critical id never appears, not
  // a raw substring count.
  assert(!ctx.includes(`lesson ${crit.id}:`),
    "tier_dedup_cross_tier: the critical lesson never ALSO renders plain in tier 2 (tier 1 wins)", ctx);
  removeManifest();
}

// ===========================================================================
// 5. preflight_advisory_derived
// ===========================================================================
{
  const { home, proj } = mkFixture("preflight");
  writeManifest({ slug: "acme", root: proj });
  const lesson = storeEpisode(home, proj, { summary: "preflight anchor lesson" });
  linkViolations(home, proj, lesson.id, 1); // 1 link -> band 8, also feeds the preflight count
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(r.status === 0 && !!out, "preflight_advisory_derived: hook exits 0 and emits output", `status=${r.status}`);
  assert(/preflight: \d+ recent implementation violation\(s\)/.test(ctx) && ctx.includes("bp-001-implementation-workflow"),
    "preflight_advisory_derived: implementation preflight line derived generically (count=sum, ids=keys)", ctx);
  removeManifest();
}

// ===========================================================================
// 6. fresh_path_no_substrate_read
// ===========================================================================
{
  const { home, proj } = mkFixture("fresh-path");
  writeManifest({ slug: "acme", root: proj });
  storeCritical(home, proj, { summary: "fresh path probe" }, 2);
  rebuildFresh(home, proj);
  const tiPath = triggerIndexPath(proj);
  const mtimeBefore = fs.statSync(tiPath).mtimeMs;
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const mtimeAfter = fs.statSync(tiPath).mtimeMs;
  assert(r.status === 0, "fresh_path_no_substrate_read: hook exits 0", `status=${r.status} stderr=${r.stderr}`);
  assert(mtimeBefore === mtimeAfter, "fresh_path_no_substrate_read: SessionStart hook does not rebuild trigger-index.json on the fresh path", `${mtimeBefore} -> ${mtimeAfter}`);
  removeManifest();
}

// ===========================================================================
// 7. stale_path_carveout (EC3)
// ===========================================================================
{
  const { home, proj } = mkFixture("stale-path");
  writeManifest({ slug: "acme", root: proj });
  const crit = storeCritical(home, proj, { summary: "stale path probe" }, 2);
  rebuildFresh(home, proj);
  const tiPath = triggerIndexPath(proj);
  const cached = JSON.parse(fs.readFileSync(tiPath, "utf8"));
  cached.source.index_size = cached.source.index_size + 999; // force staleness
  fs.writeFileSync(tiPath, JSON.stringify(cached));
  const mtimeBefore = fs.statSync(tiPath).mtimeMs;
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const mtimeAfter = fs.statSync(tiPath).mtimeMs;
  const out = parseHookOut(r.stdout);
  assert(mtimeAfter !== mtimeBefore, "stale_path_carveout: SessionStart hook rebuilds trigger-index.json via the carve-out on a stale store", `${mtimeBefore} -> ${mtimeAfter}`);
  assert(!!out && out.hookSpecificOutput.additionalContext.includes(crit.id), "stale_path_carveout: the rebuilt index still yields the correct critical entry", r.stdout);
  assert(r.status === 0 && noDecisionField(r.stdout), "stale_path_carveout: still advisory (exit 0, no decision field)", r.stdout);
  removeManifest();
}

// ===========================================================================
// 8. body_sentinel
// ===========================================================================
{
  const { home, proj } = mkFixture("body-sentinel");
  writeManifest({ slug: "acme", root: proj });
  const sentinel = `SENTINEL-${crypto.randomBytes(8).toString("hex")}`;
  const crit = storeCritical(home, proj, { summary: "sentinel critical probe", body: `body containing ${sentinel} never to leak` }, 2);
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  assert(!!out && out.hookSpecificOutput.additionalContext.includes(crit.id), "body_sentinel: the critical entry still renders", r.stdout);
  assert(!r.stdout.includes(sentinel), "body_sentinel: the planted body sentinel never appears in hook output", r.stdout);
  removeManifest();
}

// ===========================================================================
// 9. payload_schema
// ===========================================================================
{
  const { home, proj } = mkFixture("payload-schema");
  writeManifest({ slug: "acme", root: proj });
  storeCritical(home, proj, { summary: "payload schema probe" }, 2);
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas/runtime/activation-io.schema.json"), "utf8"));
  const jivPath = path.join(REPO_ROOT, "scripts/lib/json-instance-validate.mjs");
  const { validateInstance } = await import(`file://${jivPath}`);
  const result = validateInstance(out, schema);
  assert(result.valid, "payload_schema: SessionStart hook output validates against the activation-io schema", JSON.stringify(result.errors));
  const withExtra = { ...out, decision: "block" };
  const resultBad = validateInstance(withExtra, schema);
  assert(!resultBad.valid, "payload_schema: an unknown top-level key (e.g. decision) FAILS validation", JSON.stringify(resultBad));
  removeManifest();
}

// ===========================================================================
// 10. env_independence
// ===========================================================================
{
  const { home, proj } = mkFixture("env-independence");
  writeManifest({ slug: "acme", root: proj });
  storeCritical(home, proj, { summary: "env independence probe" }, 2);
  rebuildFresh(home, proj);
  const tiPath = triggerIndexPath(proj);
  const mtimeBaseline = fs.statSync(tiPath).mtimeMs;

  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "distractor" }));
  const bogusClassesPath = path.join(proj, "bogus-activation-classes.json");
  fs.writeFileSync(bogusClassesPath, JSON.stringify({ version: "9.9.9", classes: [] }));

  const variants = [
    { extraEnv: {} },
    { extraEnv: { EM_ACTIVATION_CLASSES_PATH: bogusClassesPath } },
    { extraEnv: { EM_ACTIVATION_CLASSES_PATH: path.join(proj, "does-not-exist.json") } },
  ];
  const outputs = variants.map((v) => runHook({ home, stdin: { hook_event_name: "SessionStart" }, extraEnv: v.extraEnv }));
  fs.rmSync(path.join(proj, ".git"), { recursive: true, force: true });
  outputs.push(runHook({ home, stdin: { hook_event_name: "SessionStart" } }));
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });

  const bytes = outputs.map((r) => r.stdout);
  assert(bytes.every((s) => s === bytes[0]), "env_independence: output byte-identical across git/package.json/EM_ACTIVATION_CLASSES_PATH variation", JSON.stringify(bytes));
  const mtimeAfter = fs.statSync(tiPath).mtimeMs;
  assert(mtimeAfter === mtimeBaseline, "env_independence: no rebuild fired across any variant (pure fresh-path reads)", `${mtimeBaseline} -> ${mtimeAfter}`);
  removeManifest();
}

// ===========================================================================
// 11. degraded_missing_section / degraded_partial_section (EC11) / EC12
// ===========================================================================
{
  const { home, proj } = mkFixture("degraded-missing");
  writeManifest({ slug: "acme", root: proj });
  storeEpisode(home, proj, { summary: "degraded missing probe" });
  rebuildFresh(home, proj);
  const tiPath = triggerIndexPath(proj);
  const cached = JSON.parse(fs.readFileSync(tiPath, "utf8"));
  delete cached.session_start; // whole section missing -- REQ-21
  fs.writeFileSync(tiPath, JSON.stringify(cached));
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  assert(r.status === 0, "degraded_missing_section: exits 0 with session_start entirely absent", `status=${r.status}`);
  assert(r.stdout.trim() === "", "degraded_missing_section: nothing rendered", JSON.stringify(r.stdout));
  assert(/session_start/.test(r.stderr), "degraded_missing_section: exactly one stderr note names session_start", JSON.stringify(r.stderr));
  removeManifest();
}
{
  const { home, proj } = mkFixture("degraded-partial");
  writeManifest({ slug: "acme", root: proj });
  const crit = storeCritical(home, proj, { summary: "degraded partial probe" }, 2);
  rebuildFresh(home, proj);
  const tiPath = triggerIndexPath(proj);
  const cached = JSON.parse(fs.readFileSync(tiPath, "utf8"));
  delete cached.session_start.entries; // section present, only `entries` missing -- EC11
  fs.writeFileSync(tiPath, JSON.stringify(cached));
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  assert(r.status === 0 && !!out && out.hookSpecificOutput.additionalContext.includes(crit.id),
    "degraded_partial_section: entries missing -> critical_entries renders alone", r.stdout);
  removeManifest();
}
{
  // EC12: stale-path build subprocess exits non-zero -> still exit 0, no decision field.
  const { home, proj } = mkFixture("degraded-ec12");
  writeManifest({ slug: "acme", root: proj });
  storeCritical(home, proj, { summary: "ec12 probe" }, 2);
  rebuildFresh(home, proj);
  const tiPath = triggerIndexPath(proj);
  const cached = JSON.parse(fs.readFileSync(tiPath, "utf8"));
  cached.source.index_size = cached.source.index_size + 999; // force staleness
  fs.writeFileSync(tiPath, JSON.stringify(cached));
  const hidden = FAKE_TRIGGER_INDEX_SCRIPT + ".hidden";
  fs.renameSync(FAKE_TRIGGER_INDEX_SCRIPT, hidden);
  let r;
  try {
    r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  } finally {
    fs.renameSync(hidden, FAKE_TRIGGER_INDEX_SCRIPT);
  }
  assert(r.status === 0, "sessionstart_no_decision_any_path (EC12): stale-rebuild-tool-missing still exits 0", `status=${r.status}`);
  assert(noDecisionField(r.stdout) && noDecisionField(r.stderr), "sessionstart_no_decision_any_path (EC12): no decision field when the carve-out subprocess cannot run", r.stdout);
  removeManifest();
}

// ===========================================================================
// 12. scope_filter_foreign_project
// ===========================================================================
{
  const { home, proj } = mkFixture("scope-foreign");
  writeManifest({ slug: "acme", root: proj });
  const foreign = storeCritical(home, proj, { summary: "foreign scope probe", appliesToProject: "other-project" }, 2);
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = !!out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : "";
  assert(r.status === 0, "scope_filter_foreign_project: hook exits 0", `status=${r.status}`);
  // Tiers 1/2 are per-episode applies_to-scoped (REQ-15) -- the foreign lesson
  // itself never renders, in EITHER form. The preflight advisory is a
  // store-wide violation-count aggregate carrying no applies_to field at all
  // (buildSessionStart), so it is INTENTIONALLY not scope-filterable per
  // episode; its presence here (from the violations `storeCritical` links to
  // earn the band) is expected, not a scope leak.
  assert(!ctx.includes(foreign.id), "scope_filter_foreign_project: the foreign-project lesson never renders in either tier", JSON.stringify(r.stdout));
  removeManifest();
}

// ===========================================================================
// 13. sessionstart_no_decision_any_path — force every branch, grep every
//     stdout/stderr for decision/block/permissionDecision.
// ===========================================================================
{
  const { home, proj } = mkFixture("no-decision");
  const runs = [];

  removeManifest();
  runs.push(["no-manifest", runHook({ home, stdin: { hook_event_name: "SessionStart" } })]);

  writeManifest({ slug: "acme", root: proj });
  runs.push(["empty-stdin", runHook({ home, stdin: "" })]);
  runs.push(["array-stdin", runHook({ home, stdin: "[1,2,3]" })]);
  runs.push(["garbage-stdin", runHook({ home, stdin: "not json at all" })]);
  runs.push(["missing-index", runHook({ home, stdin: { hook_event_name: "SessionStart" } })]);

  const crit = storeCritical(home, proj, { summary: "no-decision critical" }, 2);
  const plain = storeEpisode(home, proj, { summary: "no-decision plain" });
  rebuildFresh(home, proj);
  runs.push(["match", runHook({ home, stdin: { hook_event_name: "SessionStart" } })]);

  const tiPath = triggerIndexPath(proj);
  fs.writeFileSync(tiPath, "{not valid json");
  runs.push(["corrupt-recoverable", runHook({ home, stdin: { hook_event_name: "SessionStart" } })]);

  fs.writeFileSync(tiPath, "{still not valid json");
  const hidden = FAKE_TRIGGER_INDEX_SCRIPT + ".hidden2";
  fs.renameSync(FAKE_TRIGGER_INDEX_SCRIPT, hidden);
  try {
    runs.push(["corrupt-unrecoverable", runHook({ home, stdin: { hook_event_name: "SessionStart" } })]);
  } finally {
    fs.renameSync(hidden, FAKE_TRIGGER_INDEX_SCRIPT);
  }

  rebuildFresh(home, proj);
  fs.mkdirSync(path.join(proj, ".episodic-memory"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), JSON.stringify({
    schema_version: 1, suppress: [{ episode_id: crit.id, reason: "test", added: "2026-07-09" }],
  }));
  runs.push(["suppressed", runHook({ home, stdin: { hook_event_name: "SessionStart" } })]);
  fs.rmSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), { force: true });

  fs.writeFileSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), JSON.stringify({ schema_version: 1, suppress: [{ reason: "no id" }] }));
  runs.push(["suppress-shape-malformed", runHook({ home, stdin: { hook_event_name: "SessionStart" } })]);
  fs.rmSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), { force: true });

  let allZeroExit = true;
  let allClean = true;
  const dirty = [];
  for (const [label, r] of runs) {
    if (r.status !== 0) { allZeroExit = false; dirty.push(`${label}: status=${r.status}`); }
    if (!noDecisionField(r.stdout) || !noDecisionField(r.stderr)) { allClean = false; dirty.push(`${label}: ${r.stdout} / ${r.stderr}`); }
  }
  assert(allZeroExit, "sessionstart_no_decision_any_path: every forced branch exits 0", JSON.stringify(dirty));
  assert(allClean, "sessionstart_no_decision_any_path: no decision/block/permissionDecision field on any forced branch", JSON.stringify(dirty));

  const suppressedRun = runs.find(([l]) => l === "suppressed")[1];
  assert(!suppressedRun.stdout.includes(crit.id), "sessionstart_no_decision_any_path: the suppressed critical episode is really absent from output", JSON.stringify(suppressedRun.stdout));
  const shapeMalformedRun = runs.find(([l]) => l === "suppress-shape-malformed")[1];
  const outShapeMalformed = parseHookOut(shapeMalformedRun.stdout);
  assert(!!outShapeMalformed && outShapeMalformed.hookSpecificOutput.additionalContext.includes(crit.id),
    "sessionstart_no_decision_any_path: shape-malformed lesson-suppress.json fails open (injection proceeds)", shapeMalformedRun.stdout);

  removeManifest();
}

// ===========================================================================
// 14. handoff_consumes_blend (REQ-26) — the SEPARATE session-handoff hook
//     (.claude/hooks/session-handoff-prompt.sh), not the activation adapter.
//     Drives the REAL committed hook file end-to-end against an isolated
//     git-initialized fixture project + a scratch HOME, and proves the
//     mechanical em-search command it emits has switched to the
//     `session_start` static blend (no `--no-score` recency-only load) by
//     actually EXECUTING the extracted command and observing the rendered
//     lesson line.
// ===========================================================================
{
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "act-handoff-")));
  _tmpDirs.push(base);
  const home = path.join(base, "home");
  const proj = path.join(base, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  const git = (args) => spawnSync("git", args, { cwd: proj, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "juan.delacruz@acme.com"]);
  git(["config", "user.name", "test"]);

  // The handoff hook resolves scripts/em-trigger-index.mjs relative to its
  // OWN resolved REPO_ROOT (the fixture project), not this test's repo --
  // give the fixture its own copy, same rationale as the module-level scaffold.
  fs.cpSync(path.join(REPO_ROOT, "scripts"), path.join(proj, "scripts"), { recursive: true });

  const env = scrubEnv({ ...process.env, HOME: home });
  const storeArgs = [
    path.join(REPO_ROOT, "scripts/em-store.mjs"),
    "--project", "acme", "--category", "lesson", "--tags", "test",
    "--summary", "handoff blend probe lesson", "--body", "body", "--scope", "local",
    "--applies-to-project", "acme", "--applies-to-tool", "claude-code", "--priority", "5",
  ];
  const storeResult = spawnSync("node", storeArgs, { cwd: proj, env, encoding: "utf8", timeout: 30000 });
  if (storeResult.status !== 0) throw new Error(`handoff_consumes_blend: em-store failed: ${storeResult.stdout}\n${storeResult.stderr}`);
  const ep = JSON.parse(storeResult.stdout.trim().split("\n").pop());

  const hookPath = path.join(REPO_ROOT, ".claude/hooks/session-handoff-prompt.sh");
  const r = spawnSync("bash", [hookPath], {
    cwd: proj,
    env,
    input: JSON.stringify({ cwd: proj, session_id: "test", hook_event_name: "SessionStart", source: "startup" }),
    encoding: "utf8",
    timeout: 15000,
  });
  assert(r.status === 0, "handoff_consumes_blend: session-handoff-prompt.sh exits 0", `status=${r.status} stderr=${r.stderr}`);
  const out = parseHookOut(r.stdout);
  const ctx = !!out && out.hookSpecificOutput && typeof out.hookSpecificOutput.additionalContext === "string" ? out.hookSpecificOutput.additionalContext : "";
  assert(!!ctx, "handoff_consumes_blend: emits a directive", r.stdout);
  assert(!ctx.includes("--no-score"), "handoff_consumes_blend: the emitted command no longer invokes em-search --no-score (recency-only)", ctx);
  assert(ctx.includes("--merged") && ctx.includes("jq"), "handoff_consumes_blend: the emitted command reads the session_start blend via em-trigger-index --merged | jq", ctx);

  const cmdLine = (ctx.match(/^\s*cd .+$/m) || [""])[0].trim();
  assert(!!cmdLine, "handoff_consumes_blend: a mechanical `cd ... && node ... --merged | jq ...` command line was extracted from the directive", ctx);
  const exec = spawnSync("bash", ["-c", cmdLine], { env, encoding: "utf8", timeout: 15000 });
  assert(exec.status === 0, "handoff_consumes_blend: the extracted mechanical command itself exits 0", `status=${exec.status} stderr=${exec.stderr}`);
  assert(exec.stdout.includes(`lesson ${ep.id}: handoff blend probe lesson`),
    "handoff_consumes_blend: executing the extracted command renders the seeded lesson from the session_start blend", exec.stdout);
}

// ===========================================================================
// 15. dropped_critical_not_plain (F1, E2E) — 4 band-9 lessons in ONE store:
//     buildSessionStart puts all 4 in critical_entries AND (top-N by static
//     score) in entries. max_matches=3 drops one critical; the dropped id must
//     NOT resurface as a plain `lesson <id>:` line, and the note names it.
// ===========================================================================
{
  const { home, proj } = mkFixture("f1-dropped-critical");
  writeManifest({ slug: "acme", root: proj });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(storeCritical(home, proj, { summary: `f1 critical ${i}` }, 2).id);
  rebuildFresh(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  const note = out.hookSpecificOutput.additionalContext;
  const noteId = (ctx.match(/incl\. critical (\S+)/) || [])[1];
  assert(r.status === 0 && !!noteId, "dropped_critical_not_plain (F1): overflow note names a dropped critical", ctx);
  // The dropped critical id must appear NOWHERE as a plain `lesson <id>:` line.
  const anyPlainCritical = ids.some((id) => ctx.split("\n").some((l) => l === `lesson ${id}: ` + `f1 critical ${ids.indexOf(id)}`));
  assert(!anyPlainCritical, "dropped_critical_not_plain (F1): no band-9 critical ever renders as a plain tier-2 line", ctx);
  // And specifically the note's own named id is not injected plain.
  assert(!ctx.split("\n").some((l) => l.startsWith(`lesson ${noteId}:`)),
    "dropped_critical_not_plain (F1): the id the note calls 'suppressed' is not simultaneously injected plain", ctx);
  removeManifest();
}

// ===========================================================================
// 16. preflight_merges_local_and_global (F2, E2E) — local + global each carry
//     an `implementation` preflight (bp-001) with distinct counts; the merged
//     hook output must SUM them, not take local wholesale.
// ===========================================================================
{
  const { home, proj } = mkFixture("f2-preflight-merge");
  writeManifest({ slug: "acme", root: proj });
  // Local: 1 bp-001 violation. Global: 2 bp-001 violations. Merged -> 3.
  const localLesson = storeEpisode(home, proj, { summary: "f2 local anchor" });
  linkViolations(home, proj, localLesson.id, 1);
  const globalLesson = storeEpisodeGlobal(home, proj, { summary: "f2 global anchor" });
  linkViolationsGlobal(home, proj, globalLesson.id, 2);
  rebuildFresh(home, proj);
  rebuildFreshGlobal(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert(r.status === 0 && !!out, "preflight_merges_local_and_global (F2): hook exits 0 with output", `status=${r.status}`);
  assert(/preflight: 3 recent implementation violation\(s\)/.test(ctx),
    "preflight_merges_local_and_global (F2): local(1)+global(2) implementation counts SUM to 3 (global not dropped)", ctx);
  removeManifest();
}

// ===========================================================================
// 17. merged_tier2_static_score_order (F3, E2E) — a high-static_score GLOBAL
//     lesson must render BEFORE a low-static_score LOCAL one after the merge
//     re-sort (priority drives static_score when recency/staleness are equal).
// ===========================================================================
{
  const { home, proj } = mkFixture("f3-static-order");
  writeManifest({ slug: "acme", root: proj });
  const localLow = storeEpisode(home, proj, { summary: "f3 local low-score", priority: 1 });
  const globalHigh = storeEpisodeGlobal(home, proj, { summary: "f3 global high-score", priority: 7 });
  rebuildFresh(home, proj);
  rebuildFreshGlobal(home, proj);
  const r = runHook({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const lines = out.hookSpecificOutput.additionalContext.split("\n");
  const idxGlobal = lines.findIndex((l) => l.startsWith(`lesson ${globalHigh.id}:`));
  const idxLocal = lines.findIndex((l) => l.startsWith(`lesson ${localLow.id}:`));
  assert(idxGlobal !== -1 && idxLocal !== -1, "merged_tier2_static_score_order (F3): both merged tier-2 lessons render", out.hookSpecificOutput.additionalContext);
  assert(idxGlobal < idxLocal, "merged_tier2_static_score_order (F3): higher-static_score GLOBAL lesson renders before lower-score LOCAL (merge re-sorts by static_score desc)", out.hookSpecificOutput.additionalContext);
  removeManifest();
}

// ===========================================================================
console.log(`\ntest-activation-sessionstart: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all activation sessionstart checks passed");
