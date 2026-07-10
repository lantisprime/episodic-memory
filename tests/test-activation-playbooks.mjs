#!/usr/bin/env node
// test-activation-playbooks.mjs — RFC-011 P1-S3 (Group: playbook adapter rendering).
//
// T4 session-start render (provenance/suppress/dedup/caps/note-names-id);
// T5 body sentinel (REQ-11); T6 on-demand multi-trigger through the REAL HOOK
// path + declared-override E2E (R1 clause: "the episode's original phrase no
// longer fires") + excluded-override corner (R2.2 fail-to-nothing) +
// lesson-also-declared renders once (R2.9(b) playbook form wins at merge) +
// entry_class schema validation + agent-N1 negative control; T8 advisory
// conformance gauntlet extension (noDecisionField across every new path,
// REQ-12); T9 three strict-boundary legs (same-stat contradicting swap;
// same-stat corrupt swap byte-identical to baseline; stat-changing corruption
// — REQ-13).
//
// Fixture scaffold mirrors tests/test-activation-sessionstart.mjs exactly:
// activation-hook-run.mjs resolves scripts/lib/ relative to ITSELF (three
// directories above plugins/claude-code-activation/hooks -> repo root ->
// scripts + schemas + activation-classes.json), so driving the REAL committed
// hook bytes needs an isolated repo-shaped temp tree. Isolated HOME + project
// per test (never the developer's real ~/.episodic-memory or this repo's local
// store). Each test asserts captured real output with sentinels — no
// aspirational output. The proj-dir basename IS the manifest slug (the build's
// storeDir-slug discovery path is `path.basename(path.dirname(storeDir))` ==
// basename(proj); the playbook rows' applies_to_projects is set to it at
// build, so the manifest identity.slug must equal basename(proj) to scopeOk).
//
// Episode files (.md) are authored directly + em-rebuild-index.mjs builds the
// index.jsonl from them (this lets T9 author two episodes with the SAME
// byte-length id for size-identical content swaps). The build then derives
// the v3 trigger-index.json with session_start.playbooks + on_demand
// entry_class:"playbook" rows.
//
// Run: node tests/test-activation-playbooks.mjs   (exit 0 = pass)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateInstance } from "../scripts/lib/json-instance-validate.mjs";
import { matchActivation } from "../scripts/lib/activation-match.mjs";

const REPO = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const REAL_HOOKS_DIR = path.join(REPO, "plugins/claude-code-activation/hooks");
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, "schemas/trigger-index.schema.json"), "utf8"));

let pass = 0, fail = 0;
const failures = [];
const ok = () => pass++;
const bad = (n, d) => { fail++; failures.push(`${n}${d ? " — " + d : ""}`); };
const assert = (c, n, d) => (c ? ok() : bad(n, d));

// ===========================================================================
// Fake-repo scaffold (module-level, built ONCE) + per-test fixture helpers.
// ===========================================================================
const FAKE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "act-playbooks-repo-")));
fs.cpSync(path.join(REPO, "scripts"), path.join(FAKE_ROOT, "scripts"), { recursive: true });
fs.cpSync(path.join(REPO, "schemas"), path.join(FAKE_ROOT, "schemas"), { recursive: true });
fs.copyFileSync(path.join(REPO, "activation-classes.json"), path.join(FAKE_ROOT, "activation-classes.json"));
const FAKE_HOOKS_DIR = path.join(FAKE_ROOT, "plugins/claude-code-activation/hooks");
fs.mkdirSync(FAKE_HOOKS_DIR, { recursive: true });
for (const f of ["activation-prompt.sh", "activation-tool.sh", "activation-sessionstart.sh", "activation-hook-run.mjs"]) {
  const dst = path.join(FAKE_HOOKS_DIR, f);
  fs.copyFileSync(path.join(REAL_HOOKS_DIR, f), dst);
  fs.chmodSync(dst, 0o755);
}
const FAKE_MANIFEST_PATH = path.join(FAKE_ROOT, "plugins/claude-code-activation/manifest.json");
const FAKE_TRIGGER_INDEX_SCRIPT = path.join(FAKE_ROOT, "scripts/em-trigger-index.mjs");
const FAKE_REBUILD_SCRIPT = path.join(FAKE_ROOT, "scripts/em-rebuild-index.mjs");

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
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `act-playbooks-${label}-`)));
  _tmpDirs.push(base);
  const home = path.join(base, "home");
  const proj = path.join(base, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  return { base, home, proj, slug: path.basename(proj) };
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

function storeDir(cwd) { return path.join(cwd, ".episodic-memory"); }
function globalDir(home) { return path.join(home, ".episodic-memory"); }
function tiPath(cwd) { return path.join(storeDir(cwd), "trigger-index.json"); }
function readTi(cwd) { return JSON.parse(fs.readFileSync(tiPath(cwd), "utf8")); }
function writePlaybooks(cwd, obj) {
  fs.mkdirSync(storeDir(cwd), { recursive: true });
  fs.writeFileSync(path.join(storeDir(cwd), "playbooks.json"), JSON.stringify(obj, null, 2));
}
function rebuildFresh({ home, proj }) {
  const env = scrubEnv({ ...process.env, HOME: home });
  spawnSync("node", [FAKE_TRIGGER_INDEX_SCRIPT, "--scope", "local", "--project", proj], { cwd: proj, env, encoding: "utf8", timeout: 15000 });
}
function rebuildIndex({ home, proj, scope }) {
  const env = scrubEnv({ ...process.env, HOME: home });
  spawnSync("node", [FAKE_REBUILD_SCRIPT, "--scope", scope || "local"], { cwd: proj, env, encoding: "utf8", timeout: 15000 });
}
function rebuildTriggerGlobal({ home, proj }) {
  const env = scrubEnv({ ...process.env, HOME: home });
  spawnSync("node", [FAKE_TRIGGER_INDEX_SCRIPT, "--scope", "global"], { cwd: proj, env, encoding: "utf8", timeout: 15000 });
}
function noDecisionField(stdout) {
  return !/"decision"|"block"|"permissionDecision"/.test(stdout);
}
function parseHookOut(stdout) {
  const line = stdout.trim();
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}
function runSessionStart({ home, stdin }) {
  const env = scrubEnv({ ...process.env, HOME: home });
  const r = spawnSync("bash", [path.join(FAKE_HOOKS_DIR, "activation-sessionstart.sh")], {
    cwd: home, env,
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8", timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function runPrompt({ home, stdin }) {
  const env = scrubEnv({ ...process.env, HOME: home });
  const r = spawnSync("bash", [path.join(FAKE_HOOKS_DIR, "activation-prompt.sh")], {
    cwd: home, env,
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8", timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function runTool({ home, stdin }) {
  const env = scrubEnv({ ...process.env, HOME: home });
  const r = spawnSync("bash", [path.join(FAKE_HOOKS_DIR, "activation-tool.sh")], {
    cwd: home, env,
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    encoding: "utf8", timeout: 15000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Author an episode .md file (the build's parseFrontmatter reads YAML from
// frontmatter: scalars, quoted scalars, and INLINE ARRAYS as `[a, b, c]`
// (whitespace-trimmed, comma-split) — never JSON-quote array items). Returns
// nothing; writes `<dir>/episodes/<id>.md`. The `extra` object's keys
// become frontmatter lines (e.g., {review_by:'2099-01-01'} → a scalar).
// applies_to_projects:[<slug>] + applies_to_tools:[claude-code] are REQUIRED in
// the frontmatter (em-rebuild-index does NOT default them) so the matcher's
// scopeOk accepts the row under the rendering identity.
function writeEpisodeFile(dir, { id, slug, summary, triggers = ["unused phrase"], priority = 5, extra = {}, body = "b" }) {
  fs.mkdirSync(path.join(dir, "episodes"), { recursive: true });
  const lines = [
    "---", `id: ${id}`, "date: 2026-07-08", 'time: "00:00"', `project: ${slug}`, "category: lesson",
    "status: active", "tags: []", `summary: ${summary}`, `triggers: [${triggers.join(", ")}]`, `priority: ${priority}`,
    `applies_to_projects: [${slug}]`, "applies_to_tools: [claude-code]",
  ];
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(", ")}]`);
    else if (typeof v === "string") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "", "# body", "", body, "");
  fs.writeFileSync(path.join(dir, "episodes", `${id}.md`), lines.join("\n"));
}

// Two bp-001 violations V1,V2 each linked to `crit` -> effectivePriority 9.
function writeBand9Violations(dir, crit) {
  fs.appendFileSync(path.join(dir, "index.jsonl"),
    [{ id: "v1", date: "2026-07-08", time: "00:00", project: "t", category: "violation", status: "active", supersedes: null, tags: ["violated:bp-001-implementation-workflow"], summary: "v1", violated_pattern: "bp-001-implementation-workflow", lessons: [crit], source: "local" },
     { id: "v2", date: "2026-07-08", time: "00:00", project: "t", category: "violation", status: "active", supersedes: null, tags: ["violated:bp-001-implementation-workflow"], summary: "v2", violated_pattern: "bp-001-implementation-workflow", lessons: [crit], source: "local" }]
      .map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// ===========================================================================
// T4a — session-start playbook render (provenance prefix + read_command,
// keyed off the EXACT R3 §8.2 VERBATIM line) PLUS positioning after tier-1
// critical_entries and before the tier-2 static blend.
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t4a-render");
  writeManifest({ slug, root: proj });
  const ss = "t4a-ss" + "x".repeat(14);
  const plain = "t4a-plain" + "x".repeat(11);
  const crit = "t4a-crit" + "x".repeat(11);
  writeEpisodeFile(storeDir(proj), { id: ss, slug, summary: "ss playbook summary" });
  writeEpisodeFile(storeDir(proj), { id: plain, slug, summary: "plain tier2" });
  writeEpisodeFile(storeDir(proj), { id: crit, slug, summary: "critical anchor" });
  rebuildIndex({ home, proj });
  writeBand9Violations(storeDir(proj), crit);  // appends the two violation rows to the index.jsonl
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: ss, mode: "session_start" }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : "";
  assert(r.status === 0 && !!out, "T4a_session_start_playbook_renders: hook exits 0 and emits output", `status=${r.status} stderr=${r.stderr}`);
  // The VERBATIM R3 provenance line: provenance prefix + imperative READ pair +
  // read_command + summary.
  assert(ctx.includes(`playbook (playbooks.json): READ ${ss} before proceeding`), "T4a_session_start_playbook_renders: provenance-prefixed READ line present", ctx);
  assert(ctx.includes(`node ${path.join(FAKE_ROOT, "scripts", "em-search.mjs")} --read ${ss}`), "T4a_session_start_playbook_renders: read_command names the verbatim tracked em-search --read command (precomputed at build)", ctx);
  assert(ctx.includes("ss playbook summary"), "T4a_session_start_playbook_renders: summary carried", ctx);
  // Positioning: critical (band-9 imperative form) -> playbook band -> tier-2 plain.
  const critIdx = ctx.indexOf(`READ ${crit} before proceeding (em-search --history ${crit} --full)`);
  const pbIdx = ctx.indexOf(`playbook (playbooks.json): READ ${ss}`);
  const plainIdx = ctx.indexOf(`lesson ${plain}:`);
  assert(critIdx !== -1 && pbIdx !== -1 && plainIdx !== -1 && critIdx < pbIdx && pbIdx < plainIdx,
    "T4a_session_start_playbook_renders: playbook band positioned AFTER tier-1 critical, BEFORE tier-2 plain (R3 'after tier-1, before tier-2')",
    JSON.stringify({ critIdx, pbIdx, plainIdx, ctx }));
  removeManifest();
}

// ===========================================================================
// T4b — absent file = no render; malformed file = exit 0 + nothing rendered.
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t4b-absent");
  writeManifest({ slug, root: proj });
  // (a) No playbooks.json ever written -> zero-state fingerprint, session_start
  //     trio absent -> hook renders NO playbook line.
  writeEpisodeFile(storeDir(proj), { id: "t4b-plain" + "x".repeat(10), slug, summary: "plain tier2" });
  rebuildIndex({ home, proj });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const rAbsent = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const outAbsent = parseHookOut(rAbsent.stdout);
  assert(rAbsent.status === 0, "T4b_absent_no_render: absent file exits 0", `status=${rAbsent.status}`);
  assert((outAbsent && outAbsent.hookSpecificOutput ? outAbsent.hookSpecificOutput.additionalContext : "").indexOf("playbook (playbooks.json)") === -1,
    "T4b_absent_no_render: absent file -> no playbook line rendered", rAbsent.stdout);
  // (b) MALFORMED playbooks.json (garbage) AFTER a valid build: the cached
  //     fingerprint records the valid file's stat; the on-disk corrupt file's
  //     mtime+size diverge -> hook freshness-mismatch -> rebuild -> build sees
  //     malformed -> derives no playbooks + a build-report note -> hook renders
  //     NO playbook line, exit 0, no decision field (advisory fail-open).
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: "t4b-ss" + "x".repeat(12), mode: "session_start" }] });
  writeEpisodeFile(storeDir(proj), { id: "t4b-ss" + "x".repeat(12), slug, summary: "ss playbook" });
  rebuildIndex({ home, proj });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const baseline = parseHookOut(runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } }).stdout);
  assert(baseline && baseline.hookSpecificOutput.additionalContext.includes("playbook (playbooks.json):"),
    "T4b_baseline_renders: valid playbooks.json DID render a playbook line before the corruption", JSON.stringify(baseline));
  fs.writeFileSync(path.join(storeDir(proj), "playbooks.json"), "{ not valid json at all }");
  const rBad = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const outBad = parseHookOut(rBad.stdout);
  assert(rBad.status === 0, "T4b_malformed_no_render: malformed playbooks.json exits 0", `status=${rBad.status} stderr=${rBad.stderr}`);
  assert((outBad && outBad.hookSpecificOutput ? outBad.hookSpecificOutput.additionalContext : "").indexOf("playbook (playbooks.json)") === -1,
    "T4b_malformed_no_render: malformed -> no playbook line (build skipped, advisory fail-open)", rBad.stdout);
  assert(noDecisionField(rBad.stdout), "T4b_malformed_no_render: no decision field on the malformed path (REQ-12)", rBad.stdout);
  removeManifest();
}

// ===========================================================================
// T4c — suppression by id BEFORE dedup (REQ-9): a suppressed session_start
// playbook id never renders in the playbook band.
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t4c-suppress");
  writeManifest({ slug, root: proj });
  const ss = "t4c-ss" + "x".repeat(12);
  writeEpisodeFile(storeDir(proj), { id: ss, slug, summary: "suppressed playbook" });
  rebuildIndex({ home, proj });
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: ss, mode: "session_start" }] });
  fs.mkdirSync(path.join(proj, ".episodic-memory"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), JSON.stringify({
    schema_version: 1, suppress: [{ episode_id: ss, reason: "test", added: "2026-07-10" }],
  }));
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : "";
  assert(r.status === 0, "T4c_suppress_before_dedup: hook exits 0", `status=${r.status}`);
  assert(!ctx.includes(`playbook (playbooks.json): READ ${ss}`),
    "T4c_suppress_before_dedup: a suppressed session_start playbook id never renders (suppression BEFORE dedup)", ctx);
  removeManifest();
}

// ===========================================================================
// T4d — EC5 / R2.9(b)/(c) dedup: a session_start playbook id that is ALSO a
// tier-1 candidate renders ONCE in critical form (existing candidacy rule;
// the playbook line for the same id never appears).
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t4d-critdual");
  writeManifest({ slug, root: proj });
  const ss = "t4d-dual" + "x".repeat(11);
  writeEpisodeFile(storeDir(proj), { id: ss, slug, summary: "dual crit+playbook" });
  rebuildIndex({ home, proj });
  writeBand9Violations(storeDir(proj), ss);
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: ss, mode: "session_start" }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : "";
  // Critical form verbatim: `READ ${ss} before proceeding (em-search --history ${ss} --full): ...`
  assert(ctx.includes(`READ ${ss} before proceeding (em-search --history ${ss} --full)`),
    "T4d_critical_wins: the dual id renders in CRITICAL form (em-search --history)", ctx);
  const pbMatchCount = (ctx.match(/playbook \(playbooks\.json\): READ /g) || []).length;
  assert(pbMatchCount === 0, "T4d_critical_wins: the playbook line for the dual id never renders (one id, one line, critical form wins; R2.9(c))", `pbMatchCount=${pbMatchCount}`);
  removeManifest();
}

// ===========================================================================
// T4e — build-cap note names the capped-first id: 3 session_start declarations
// with max_playbooks:2 -> array[2], playbooks_capped:1, playbooks_capped_first:<3rd>;
// the render's overflow note names the 3rd id (R3 verbatim "+N declared
// playbooks capped, incl. <id>").
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t4e-capnote");
  writeManifest({ slug, root: proj });
  const ids = ["t4e-capone-----x".padEnd(20, "x"), "t4e-captwo-----x".padEnd(20, "x"), "t4e-capthree---x".padEnd(20, "x")];
  for (const id of ids) writeEpisodeFile(storeDir(proj), { id, slug, summary: `pb ${id}` });
  rebuildIndex({ home, proj });
  writePlaybooks(proj, { schema_version: 1, playbooks: ids.map((id) => ({ id, mode: "session_start" })), bounds: { max_playbooks: 2 } });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const out = parseHookOut(r.stdout);
  const ctx = out && out.hookSpecificOutput ? out.hookSpecificOutput.additionalContext : "";
  assert(ctx.includes(`playbook (playbooks.json): READ ${ids[0]} before proceeding`), "T4e_cap_note_names_id: first playbook renders", ctx);
  assert(ctx.includes(`playbook (playbooks.json): READ ${ids[1]} before proceeding`), "T4e_cap_note_names_id: second playbook renders", ctx);
  assert(!ctx.includes(`playbook (playbooks.json): READ ${ids[2]} before proceeding`),
    "T4e_cap_note_names_id: the capped 3rd does NOT render (cap enforced at build, REQ-9)", ctx);
  assert(ctx.includes(`+1 declared playbooks capped, incl. ${ids[2]}`),
    "T4e_cap_note_names_id: R3 verbatim note '+N declared playbooks capped, incl. <id>' names the capped-first", ctx);
  removeManifest();
}

// ===========================================================================
// T4f — token-drop note precedence + naming (pure matcher against the
// renderSessionStart path; the hook always uses the 500-token budget so a
// token-overflow requires synthesized oversized entries).
// (1) Critical + playbook both token-dropped: critical id takes the named slot,
//     count aggregates (R3 N4 note-precedence).
// (2) Playbook-only token-drop: playbook form names the id (R3 §8.2 verbatim
//     "+N more suppressed, incl. playbook <episode_id>").
// ===========================================================================
{
  const IDENTITY = { slug: "acme", root: "/r", tool_id: "claude-code" };
  const ssEvent = { kind: "session_start" };
  // Case (1): 1 oversized band-9 critical + 1 oversized playbook. With a
  // 100-token budget BOTH are dropped; the critical's id takes the named slot
  // and the count is the aggregate (1 critical + 1 playbook = 2).
  const idxBig = 2600; // ~650 tokens at ~4 chars/token
  const idx1 = {
    entries: [], activity_phrases: {},
    session_start: {
      critical_entries: [{ episode_id: "crit-drop-id", summary: "Y".repeat(idxBig), effective_priority: 9, applies_to_projects: ["acme"], applies_to_tools: ["claude-code"] }],
      entries: [],
      playbooks: [
        { episode_id: "pb-survive-id", summary: "first", read_command: "node /scripts/em-search.mjs --read pb-survive-id" },
        { episode_id: "pb-drop-id", summary: "x".repeat(idxBig), read_command: "node /scripts/em-search.mjs --read pb-drop-id" },
      ],
      playbooks_capped: 0, playbooks_capped_first: null, preflight: {},
    },
  };
  const r1 = matchActivation(idx1, ssEvent, IDENTITY, undefined, { max_matches: 3, max_tokens: 100 });
  assert(r1.lines.length === 1 && r1.lines[0].includes("pb-survive-id"),
    "T4f_critical_precedence_setup: the small playbook survives (only one oversized dropped)", JSON.stringify(r1));
  assert(r1.overflowNote === "+2 more matches suppressed, incl. critical crit-drop-id",
    "T4f_critical_precedence: critical id takes the named slot + count aggregates (N4 precedence)",
    r1.overflowNote);
  // Case (2): only one playbook (oversized); it's the only drop -> R3 §8.2
  // verbatim "+1 more suppressed, incl. playbook <episode_id>".
  const idx2 = {
    entries: [], activity_phrases: {},
    session_start: {
      critical_entries: [], entries: [],
      playbooks: [{ episode_id: "pb-only-drop-id", summary: "x".repeat(idxBig), read_command: "node /scripts/em-search.mjs --read pb-only-drop-id" }],
      playbooks_capped: 0, playbooks_capped_first: null, preflight: {},
    },
  };
  const r2 = matchActivation(idx2, ssEvent, IDENTITY, undefined, { max_matches: 3, max_tokens: 100 });
  assert(r2.lines.length === 0 && r2.overflowNote === "+1 more suppressed, incl. playbook pb-only-drop-id",
    "T4f_playbook_named: playbook-only drop uses the R3 §8.2 verbatim 'more suppressed, incl. playbook <id>'",
    JSON.stringify(r2));
}

// ===========================================================================
// T5 — body sentinel (REQ-11): a distinctive string planted in the playbook
// episode BODY never appears in ANY hook output. Extends the RFC-009 R4
// fixture across BOTH activation paths (session_start line + on-demand prompt).
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t5-body-sentinel");
  writeManifest({ slug, root: proj });
  const sentinel = `SENTINEL-${crypto.randomBytes(8).toString("hex")}`;
  const odSentinel = `SENTINEL-OD-${crypto.randomBytes(8).toString("hex")}`;
  const ss = "t5-ss" + "x".repeat(14);
  const odEp = "t5-od" + "x".repeat(14);
  // LOCAL session_start episode containing the body sentinel.
  writeEpisodeFile(storeDir(proj), { id: ss, slug, summary: "sentinel playbook summary", body: `${sentinel} and more body content ${sentinel} repeated` });
  rebuildIndex({ home, proj });
  // GLOBAL on-demand episode containing a DIFFERENT body sentinel + a trigger.
  writeEpisodeFile(globalDir(home), { id: odEp, slug, summary: "od sentinel playbook summary", triggers: ["sentinel-od-trigger"], body: `${odSentinel} body content` });
  rebuildIndex({ home, proj, scope: "global" });
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: ss, mode: "session_start" }, { id: odEp, mode: "on_demand" }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const ssRun = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const odRun = runPrompt({ home, stdin: { prompt: "sentinel-od-trigger now" } });
  const ssCtx = (parseHookOut(ssRun.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  const odCtx = (parseHookOut(odRun.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(ssCtx.includes(`playbook (playbooks.json): READ ${ss} before proceeding`),
    "T5_sentinel_session_start: the session_start playbook renders (line present despite body sentinel)", ssCtx);
  assert(odCtx.includes(`playbook (playbooks.json): READ ${odEp} before proceeding`),
    "T5_sentinel_on_demand: the on_demand playbook renders on a trigger match", odCtx);
  assert(!ssRun.stdout.includes(sentinel), "T5_sentinel_session_start: the session-start body sentinel never appears in hook output (REQ-11)", ssRun.stdout);
  assert(!odRun.stdout.includes(odSentinel), "T5_sentinel_on_demand: the on-demand body sentinel never appears in hook output (REQ-11)", odRun.stdout);
  removeManifest();
}

// ===========================================================================
// T6a — MULTI-TRIGGER playbook: 3 triggers (phrase + tool + phrase) match on
// EACH trigger through the REAL HOOK path (pins the R2.9(a) merge-dedup-key
// fix — the latent RFC-009 first-row-wins collapse is repaired).
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t6a-multitrigger");
  writeManifest({ slug, root: proj });
  const od = "t6a-od" + "x".repeat(14);
  writeEpisodeFile(globalDir(home), { id: od, slug, summary: "multi-trigger playbook", triggers: ["mtphrase", "tool:Bash:git*", "mtsecondphrase"] });
  rebuildIndex({ home, proj, scope: "global" });
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: od, mode: "on_demand" }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r1 = runPrompt({ home, stdin: { prompt: "mtphrase now" } });
  const r2 = runPrompt({ home, stdin: { prompt: "mtsecondphrase now" } });
  const r3 = runTool({ home, stdin: { tool_name: "Bash", tool_input: { command: "git status" } } });
  for (const [label, r] of [["mtphrase", r1], ["mtsecondphrase", r2], ["tool:Bash:git*", r3]]) {
    const ctx = (parseHookOut(r.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
    assert(r.status === 0 && ctx.includes(`playbook (playbooks.json): READ ${od} before proceeding`),
      `T6a_multi_trigger_each_fires: ${label} fires the playbook form through the real hook`, `status=${r.status} ctx=${ctx}`);
  }
  // Control: an unrelated prompt does NOT fire it.
  const rNeg = runPrompt({ home, stdin: { prompt: "totally unrelated text here" } });
  const negCtx = (parseHookOut(rNeg.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(!negCtx.includes(od), "T6a_multi_trigger_each_fires: a non-matching prompt does NOT fire the multi-trigger playbook", rNeg.stdout);
  removeManifest();
}

// ===========================================================================
// T6b — DECLARED override E2E: the playbook's declared `triggers` REPLACE the
// episode's own, so the episode's ORIGINAL phrase no longer fires (R1 clause /
// T6 E2E). The override-phrase playbook row DOES fire.
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t6b-override");
  writeManifest({ slug, root: proj });
  const od = "t6b-od" + "x".repeat(13);
  writeEpisodeFile(globalDir(home), { id: od, slug, summary: "override playbook", triggers: ["own-phrase-ov"] });
  rebuildIndex({ home, proj, scope: "global" });
  rebuildTriggerGlobal({ home, proj });  // Build the GLOBAL trigger-index.json so the own-phrase lesson row
                                         // actually enters mergeIndexes — WITHOUT this, loadStoreIndex returns
                                         // null ("missing, skip") and the own-phrase row never enters the
                                         // merge, so "own phrase no longer fires" passes vacuously (fix-round
                                         // Item 3, agent F3). M2 (delete the override-drop `continue`) then
                                         // survives the suite green; WITH this build, M2 goes RED.
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: od, mode: "on_demand", triggers: ["override-phrase"] }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const rOverride = runPrompt({ home, stdin: { prompt: "override-phrase now" } });
  const rOwn = runPrompt({ home, stdin: { prompt: "own-phrase-ov now" } });
  const rOverrideCtx = (parseHookOut(rOverride.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  const rOwnCtx = (parseHookOut(rOwn.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(rOverrideCtx.includes(`playbook (playbooks.json): READ ${od} before proceeding`),
    "T6b_override_phrase_fires: the declared override phrase fires the playbook form", rOverrideCtx);
  assert(!rOwnCtx.includes(od),
    "T6b_own_phrase_no_longer_fires: the episode's original phrase does NOT fire (R1 override clause / R2.9 muting leg — NON-vacuous: the global trigger-index carries the own-phrase row and the merge override-drop `continue` drops it)", rOwnCtx);
  removeManifest();
}

// ===========================================================================
// T6c — EXCLUDED-override corner (R1 disambiguation / R2.2 fail-to-nothing):
// an empty `triggers:[]` override emits NO playbook rows, NO marker. The
// episode's OWN trigger rows stay LIVE in the merged view (suppression is
// lesson-suppress.json's job; `triggers:[]` is NOT a second suppression path).
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t6c-excl");
  writeManifest({ slug, root: proj });
  const od = "t6c-od" + "x".repeat(13);
  writeEpisodeFile(globalDir(home), { id: od, slug, summary: "excluded-override playbook", triggers: ["own-phrase-excl"] });
  rebuildIndex({ home, proj, scope: "global" });
  rebuildTriggerGlobal({ home, proj });  // the GLOBAL store's trigger-index has the own-phrase lesson row
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: od, mode: "on_demand", triggers: [] }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const ti = readTi(proj);
  assert(ti.build_report.playbooks.excluded.empty_triggers === 1, "T6c_excluded_override_counted: empty triggers:[] counted as empty_triggers (auditable, never silent)");
  assert(JSON.stringify(ti.build_report.playbooks.declared) === "[]", "T6c_excluded_override_not_declared: the excluded declaration is NOT in the declared set");
  assert(!ti.entries.some((e) => e.entry_class === "playbook"), "T6c_excluded_override_emit_no_rows: no playbook rows emitted (playbook row array is empty for empty_triggers)");
  // Real hook: the episode's own phrase fires in LESSON form (NOT playbook),
  // since the override is excluded; the corner stays live per the R1 disambiguation.
  const r = runPrompt({ home, stdin: { prompt: "own-phrase-excl now" } });
  const ctx = (parseHookOut(r.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(ctx.includes(`lesson ${od}:`),
    "T6c_excluded_override_own_phrase_stays_live: the episode's own phrase fires in LESSON form (no playbook marker)", ctx);
  assert(!ctx.includes("playbook (playbooks.json):"),
    "T6c_excluded_override_no_marker_emit: empty override emits NO playbook marker and does NOT mute the episode's own rows", ctx);
  removeManifest();
}

// ===========================================================================
// T6e — lesson-also-declared-renders-once (R2.9(b) "playbook form wins"):
// the SAME episode stored as a lesson AND declared as a playbook (inherited,
// no override) renders ONCE in the playbook form (the merge replaces the
// lesson row tuple with the playbook row tuple at MERGE time — zero new
// matching semantics on the matcher side, R4).
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t6e-lap");
  writeManifest({ slug, root: proj });
  const od = "t6e-od" + "x".repeat(13);
  writeEpisodeFile(storeDir(proj), { id: od, slug, summary: "lesson-also-playbook summary", triggers: ["lap-phrase"] });
  rebuildIndex({ home, proj });
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: od, mode: "on_demand" }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r = runPrompt({ home, stdin: { prompt: "lap-phrase now" } });
  const ctx = (parseHookOut(r.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(ctx.includes(`playbook (playbooks.json): READ ${od} before proceeding`),
    "T6e_lesson_also_declared_renders_once: the episode renders in the PLAYBOOK form (R2.9(b) playbook-wins at merge time)", ctx);
  const lessonFormSameId = (ctx.match(new RegExp(`lesson ${od}:`, "g")) || []).length;
  const playbookFormSameId = (ctx.match(new RegExp(`playbook \\(playbooks\\.json\\): READ ${od}`, "g")) || []).length;
  assert(lessonFormSameId === 0 && playbookFormSameId === 1,
    "T6e_lesson_also_declared_renders_once: renders exactly ONCE — playbook form present once, lesson form for the same id NEVER appears",
    `lessonHits=${lessonFormSameId} playbookHits=${playbookFormSameId} ctx=${ctx}`);
  removeManifest();
}

// ===========================================================================
// T6f — entry_class schema validation + agent-N1 negative control. A REAL
// built v3 index validates against schemas/trigger-index.schema.json; a FORGED
// playbook row carrying `review_by` is REJECTED (agent-N1, the S3 schema
// addition that binds review_by under the not-playbook conditional), while a
// lesson row carrying `review_by` is ACCEPTED (build keeps it when the lesson
// set one — unchanged from RFC-009).
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t6f-schema");
  writeManifest({ slug, root: proj });
  const od = "t6f-od" + "x".repeat(13);
  writeEpisodeFile(storeDir(proj), { id: od, slug, summary: "schema probe summary", triggers: ["sch-phrase"] });
  rebuildIndex({ home, proj });
  writePlaybooks(proj, { schema_version: 1, playbooks: [{ id: od, mode: "on_demand" }] });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const ti = readTi(proj);
  const valid = validateInstance(ti, SCHEMA);
  assert(valid.valid, "T6f_entry_class_schema_validation: a REAL built v3 index (incl. playbook rows) validates against the schema", JSON.stringify(valid.errors).slice(0, 400));
  const prow = ti.entries.find((e) => e.entry_class === "playbook");
  assert(prow && prow.read_command && prow.effective_priority === 0, "T6f_entry_class_schema_validation: a playbook row exists with read_command + eff_pri pinned 0", JSON.stringify(prow));
  // agent-N1 negative control: forge a playbook row carrying review_by -> REJECTED.
  const forged = JSON.parse(JSON.stringify(ti));
  forged.entries.push({
    trigger_kind: "phrase", value: "x", episode_id: "forged-1", summary: "s",
    effective_priority: 0, applies_to_projects: ["acme"], applies_to_tools: ["*"],
    entry_class: "playbook", read_command: "node /scripts/em-search.mjs --read forged-1", review_by: "2099-01-01",
  });
  const forgedRes = validateInstance(forged, SCHEMA);
  assert(!forgedRes.valid, "T6f_agent_n1_negative_control: a FORGED playbook row carrying review_by is REJECTED (agent-N1 binds review_by under the not-playbook conditional)", JSON.stringify(forgedRes.errors));
  // Regression: a lesson row WITH review_by is still ACCEPTED (build path
  // unchanged; the not-playbook conditional binding forbids review_by on
  // playbook rows but leaves it optional on lesson rows).
  const lessonWithReview = JSON.parse(JSON.stringify(ti));
  lessonWithReview.entries.push({
    trigger_kind: "phrase", value: "x", episode_id: "lesson-1", summary: "s",
    effective_priority: 5, applies_to_projects: ["acme"], applies_to_tools: ["claude-code"], review_by: "2099-01-01",
  });
  const lessonRes = validateInstance(lessonWithReview, SCHEMA);
  assert(lessonRes.valid, "T6f_agent_n1_lesson_review_by_accepted: a lesson row carrying review_by is still ACCEPTED (build keeps it when a lesson set one)", JSON.stringify(lessonRes.errors));
  removeManifest();
}

// ===========================================================================
// T8 — advisory-conformance gauntlet extension (REQ-12): every new playbook
// path forces exit 0 + no decision/block/permissionDecision on stdout AND
// stderr. Cross-hook: prompt + tool + session_start, all activation paths
// (multi-trigger, override, excluded override, lesson-also-declared, ss-band,
// malformed playbooks.json rebuild).
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t8-gauntlet");
  const runs = [];

  // (a) No manifest -> nothing injects (control).
  removeManifest();
  runs.push(["no-manifest/ss", runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } })]);
  runs.push(["no-manifest/prompt", runPrompt({ home, stdin: { prompt: "x" } })]);

  writeManifest({ slug, root: proj });
  const ss = "t8-ss" + "x".repeat(14);
  const odMt = "t8-odmt" + "x".repeat(13);
  const odOv = "t8-odov" + "x".repeat(13);
  const odExcl = "t8-odexcl" + "x".repeat(11);
  const odLap = "t8-odlap" + "x".repeat(12);
  writeEpisodeFile(storeDir(proj), { id: ss, slug, summary: "ss playbook" });
  writeEpisodeFile(storeDir(proj), { id: odLap, slug, summary: "lesson also playbook", triggers: ["lap-phrase"] });
  rebuildIndex({ home, proj });
  writeEpisodeFile(globalDir(home), { id: odMt, slug, summary: "od multi-trigger", triggers: ["mtphrase", "tool:Bash:git*", "mtsecondphrase"] });
  writeEpisodeFile(globalDir(home), { id: odOv, slug, summary: "od override", triggers: ["own-phrase-ov"] });
  writeEpisodeFile(globalDir(home), { id: odExcl, slug, summary: "od excluded override", triggers: ["own-phrase-excl"] });
  rebuildIndex({ home, proj, scope: "global" });
  rebuildTriggerGlobal({ home, proj });  // Build the global trigger-index so the own-phrase + override-phrase
                                         // rows enter the hook merge (fix-round Item 3 sweep: T8's
                                         // own-phrase-ov-no-fire leg had the SAME vacuity as T6b — without
                                         // this, the override-drop `continue` is never exercised in T8).
  writePlaybooks(proj, {
    schema_version: 1,
    playbooks: [
      { id: ss, mode: "session_start" },
      { id: odMt, mode: "on_demand" },
      { id: odOv, mode: "on_demand", triggers: ["override-phrase"] },
      { id: odExcl, mode: "on_demand", triggers: [] },
      { id: odLap, mode: "on_demand" },
    ],
  });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });

  // Force every playbook branch across all three hooks.
  runs.push(["ss", runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } })]);
  runs.push(["prompt/mtphrase", runPrompt({ home, stdin: { prompt: "mtphrase now" } })]);
  runs.push(["prompt/mtsecondphrase", runPrompt({ home, stdin: { prompt: "mtsecondphrase now" } })]);
  runs.push(["prompt/override-phrase", runPrompt({ home, stdin: { prompt: "override-phrase now" } })]);
  runs.push(["prompt/own-phrase-ov-no-fire", runPrompt({ home, stdin: { prompt: "own-phrase-ov now" } })]);
  runs.push(["prompt/own-phrase-excl-fires", runPrompt({ home, stdin: { prompt: "own-phrase-excl now" } })]);
  runs.push(["prompt/lap-phrase", runPrompt({ home, stdin: { prompt: "lap-phrase now" } })]);
  runs.push(["prompt/no-match", runPrompt({ home, stdin: { prompt: "totally unrelated text" } })]);
  runs.push(["tool/git", runTool({ home, stdin: { tool_name: "Bash", tool_input: { command: "git status" } } })]);
  // Malformed playbooks -> rebuild -> no playbooks -> still exit 0.
  fs.writeFileSync(path.join(storeDir(proj), "playbooks.json"), "{ not valid json at all }");
  runs.push(["ss/malformed", runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } })]);

  let allZeroExit = true;
  let allClean = true;
  const dirty = [];
  for (const [label, r] of runs) {
    if (r.status !== 0) { allZeroExit = false; dirty.push(`${label}: status=${r.status}`); }
    if (!noDecisionField(r.stdout) || !noDecisionField(r.stderr)) { allClean = false; dirty.push(`${label}: ${r.stdout} / ${r.stderr}`); }
  }
  assert(allZeroExit, "T8_advisory_gauntlet: every forced playbook branch exits 0", JSON.stringify(dirty));
  assert(allClean, "T8_advisory_gauntlet: no decision/block/permissionDecision on any playbook branch stdout OR stderr (REQ-12)", JSON.stringify(dirty));
  removeManifest();
}

// ===========================================================================
// T9 — strict boundary, THREE legs (REQ-13 / R2.5): the hook fingerprint STATS
// (mtime+size only) are the sanctioned freshness mechanism; CONTENT reads of
// playbooks.json flow only through the build.
// ===========================================================================

// Pad content to a target byte length with trailing whitespace (JSON parsers
// tolerate inter-token + trailing whitespace, and arbitrary corrupt content
// pads the same way) so the swap preserves the build-recorded playbooks_size.
// Returns the exact byte-sized string.
function padToBytes(content, targetBytes) {
  const cur = Buffer.byteLength(content, "utf8");
  if (cur > targetBytes) throw new Error(`padToBytes: ${cur} > target ${targetBytes}`);
  if (cur === targetBytes) return content;
  return content + " ".repeat(targetBytes - cur);
}
function statSnap(p) {
  const st = fs.statSync(p);
  // Capture BOTH Date-shaped (atime/mtime) and float-ms (atimeMs/mtimeMs).
  // restoreMtime uses the [sec, nsec] tuple form to preserve nanosecond
  // precision that a Date argument would round to 1ms (the build records
  // stat.mtimeMs as a float, and the hook compares with === — exactness is
  // load-bearing for the freshness check).
  return { atime: st.atime, mtime: st.mtime, atimeMs: st.atimeMs, mtimeMs: st.mtimeMs, size: st.size };
}
function restoreMtime(p, snap) {
  // Fractional-seconds form preserves nanosecond precision (a Date argument
  // would round to 1ms; the build records stat.mtimeMs as a float, and the
  // hook's freshness check uses strict === — exactness is load-bearing).
  fs.utimesSync(p, snap.atimeMs / 1000, snap.mtimeMs / 1000);
}

{
  // ---- T9 (a): same-stat contradicting content swap ----------------------
  // Build from config X (naming idX session_start). Capture X's stat snapshot
  // (the fingerprint the build recorded). Overwrite playbooks.json with
  // contradicting but VALID-JSON content Y (naming idY) padded to X's exact
  // byte size + restore X's mtime -> the hook's stat-only freshness check
  // PASSES (mtime+size match), no rebuild -> renders idX (the BUILT data; the
  // contradicting Y content is NEVER read at event time).
  const { home, proj, slug } = mkFixture("t9a-contradict");
  writeManifest({ slug, root: proj });
  const idX = "t9a-X" + "x".repeat(14);
  const idY = "t9a-Y" + "x".repeat(14);
  writeEpisodeFile(storeDir(proj), { id: idX, slug, summary: "T9 X playbook" });
  writeEpisodeFile(storeDir(proj), { id: idY, slug, summary: "T9 Y playbook" });
  rebuildIndex({ home, proj });
  const pbPath = path.join(storeDir(proj), "playbooks.json");
  const contentX = JSON.stringify({ schema_version: 1, playbooks: [{ id: idX, mode: "session_start" }] });
  fs.writeFileSync(pbPath, contentX);
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r1 = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const ctx1 = (parseHookOut(r1.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(ctx1.includes(`playbook (playbooks.json): READ ${idX} before proceeding`),
    "T9a_baseline: config X builds + renders idX playbook line", ctx1);
  // idY is stored as a LOCAL lesson (so it appears in tier-2 plain); the
  // BASELINE control is just that idY is NOT YET rendered as a playbook line
  // (the build hasn't seen idY in a playbooks declaration — only idX).
  assert(!ctx1.includes(`playbook (playbooks.json): READ ${idY}`), "T9a_baseline: idY not yet rendered as a playbook line (control)", ctx1);
  const snapX = statSnap(pbPath);
  // Contradicting Y content padded to X's exact byte length + restored mtime.
  const contentYRaw = JSON.stringify({ schema_version: 1, playbooks: [{ id: idY, mode: "session_start" }] });
  const contentY = padToBytes(contentYRaw, snapX.size);
  fs.writeFileSync(pbPath, contentY);
  restoreMtime(pbPath, snapX);
  const snapAfter = statSnap(pbPath);
  assert(snapAfter.mtimeMs === snapX.mtimeMs && snapAfter.size === snapX.size,
    "T9a_setup_swap: contradicting Y content preserves X's mtime+size exactly",
    `mtime=${snapAfter.mtimeMs} vs ${snapX.mtimeMs}; size=${snapAfter.size} vs ${snapX.size}`);
  const r2 = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const ctx2 = (parseHookOut(r2.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(r2.status === 0, "T9a_same_stat_swap: hook exits 0 on the same-stat swap", `status=${r2.status} stderr=${r2.stderr}`);
  assert(ctx2.includes(`playbook (playbooks.json): READ ${idX} before proceeding`),
    "T9a_same_stat_renders_built_data: hook renders the BUILT idX (content NEVER read at event time)", `ctx2=${ctx2}`);
  assert(!ctx2.includes(`playbook (playbooks.json): READ ${idY}`),
    "T9a_same_stat_contradict: contradicting idY never surfaces in the playbook band (same-mtime+size swap is invisible to the stat-only fingerprint)", `ctx2=${ctx2}`);
  assert(noDecisionField(r2.stdout), "T9a_same_stat_swap: no decision field on the same-stat swap", r2.stdout);
  removeManifest();
}

{
  // ---- T9 (b): same-stat corrupt swap -------------------------------------
  // Same setup as (a) but content Y is NON-JSON garbage (padded to X's exact
  // byte size, same mtime). The hook freshness check still passes (stat-only);
  // NO rebuild; output is BYTE-IDENTICAL to (a)'s baseline (idX rendered, no
  // idY, no playbook-drops). Exit 0.
  const { home, proj, slug } = mkFixture("t9b-corrupt");
  writeManifest({ slug, root: proj });
  const idX = "t9b-X" + "x".repeat(14);
  writeEpisodeFile(storeDir(proj), { id: idX, slug, summary: "T9b X playbook" });
  rebuildIndex({ home, proj });
  const pbPath = path.join(storeDir(proj), "playbooks.json");
  const contentX = JSON.stringify({ schema_version: 1, playbooks: [{ id: idX, mode: "session_start" }] });
  fs.writeFileSync(pbPath, contentX);
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r1 = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const ctx1 = (parseHookOut(r1.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(ctx1.includes(`playbook (playbooks.json): READ ${idX} before proceeding`), "T9b_baseline: idX builds + renders", ctx1);
  const snapX = statSnap(pbPath);
  // Corrupt content (NOT JSON) padded to X's byte size + restored mtime.
  const corrupt = padToBytes("{ not valid json at all ", snapX.size);
  fs.writeFileSync(pbPath, corrupt);
  restoreMtime(pbPath, snapX);
  const snapAfter = statSnap(pbPath);
  assert(snapAfter.mtimeMs === snapX.mtimeMs && snapAfter.size === snapX.size,
    "T9b_setup_swap: corrupt content preserves mtime+size exactly",
    `mtime=${snapAfter.mtimeMs} vs ${snapX.mtimeMs}; size=${snapAfter.size} vs ${snapX.size}`);
  const r2 = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const ctx2 = (parseHookOut(r2.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(r2.status === 0, "T9b_same_stat_corrupt: hook exits 0 on the corrupt same-stat swap", `status=${r2.status} stderr=${r2.stderr}`);
  assert(ctx2 === ctx1, "T9b_byte_identical_to_a: output is BYTE-IDENTICAL to (a)'s baseline (stat-only fingerprint holds; corrupt content never reaches the build)", `${JSON.stringify(ctx1)}\n---\n${JSON.stringify(ctx2)}`);
  assert(noDecisionField(r2.stdout), "T9b_same_stat_corrupt: no decision field on the corrupt same-stat swap", r2.stdout);
  removeManifest();
}

{
  // ---- T9 (c): stat-CHANGING corruption -----------------------------------
  // Overwrite playbooks.json with corrupt content AND a CHANGED stat (different
  // size + bumped mtime to the future). The hook freshness check now fails ->
  // rebuild fires; the build sees malformed playbooks.json -> skips playbooks
  // + records a build-report note -> writes the trigger-index WITHOUT the
  // playbooks trio. The hook re-reads the rebuilt index and renders NO playbook
  // line. Exit 0; no decision field; the rebuild is the "legitimate" path
  // isolated from the same-stat content-independence legs above.
  const { home, proj, slug } = mkFixture("t9c-statchange");
  writeManifest({ slug, root: proj });
  const idX = "t9c-X" + "x".repeat(14);
  writeEpisodeFile(storeDir(proj), { id: idX, slug, summary: "T9c X playbook" });
  rebuildIndex({ home, proj });
  const pbPath = path.join(storeDir(proj), "playbooks.json");
  const contentX = JSON.stringify({ schema_version: 1, playbooks: [{ id: idX, mode: "session_start" }] });
  fs.writeFileSync(pbPath, contentX);
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const r1 = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const ctx1 = (parseHookOut(r1.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(ctx1.includes(`playbook (playbooks.json): READ ${idX} before proceeding`), "T9c_baseline: idX builds + renders before corruption", ctx1);
  // Corrupt content of a DIFFERENT byte size + bumped mtime into the future
  // (so the build's recorded playbooks_* fingerprint NO LONGER matches).
  fs.writeFileSync(pbPath, "{ totally different size non-json garbage payload xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx }");
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(pbPath, future, future);
  const snapAfter = statSnap(pbPath);
  // The build's recorded fingerprint was contentX's mtime (now-in-the-past vs.
  // the bumped future), so the hook's freshness check must FAIL -> rebuild fires.
  const r2 = runSessionStart({ home, stdin: { hook_event_name: "SessionStart" } });
  const ctx2 = (parseHookOut(r2.stdout) || { hookSpecificOutput: { additionalContext: "" } }).hookSpecificOutput.additionalContext;
  assert(r2.status === 0, "T9c_stat_changing: hook exits 0 after the rebuild path", `status=${r2.status} stderr=${r2.stderr}`);
  assert(snapAfter.mtimeMs > Date.parse("2026-01-01"), "T9c_setup_corrupt_stat_bumped: the corruption DID change the stat (mtime+size differ from the build-recorded fingerprint)", `mtime=${snapAfter.mtimeMs}`);
  assert(!ctx2.includes("playbook (playbooks.json):"),
    "T9c_stat_changing: rebuild fires + malformed playbooks handling -> NO playbook line rendered",
    `ctx2=${ctx2}`);
  assert(noDecisionField(r2.stdout), "T9c_stat_changing: no decision field on the rebuild path", r2.stdout);
  removeManifest();
}

// ===========================================================================
// T6g — event-level per-episode render dedup regression (fix-round Item 2,
// agent F1 / R2.9(b)): an episode with 2+ triggers co-matching one prompt
// renders exactly ONE line (not N duplicates). When BOTH a lesson row AND a
// playbook row for the same episode match the same event, the PLAYBOOK form
// wins (one line, playbook form). Session-start bands are per-episode by
// construction (T4d) and are not routed through dedupByEpisodePreferPlaybook.
// Uses matchActivation directly (the pure matcher is the correct layer).
// ===========================================================================
{
  const IDENTITY = { slug: "acme", root: "/r", tool_id: "claude-code" };
  const BOUNDS = { max_matches: 3, max_tokens: 500 };
  const promptEvent = (prompt) => ({ kind: "prompt", prompt });
  function pbEntry(id, summary, value) {
    return { trigger_kind: "phrase", value, episode_id: id, summary, effective_priority: 0,
      applies_to_projects: ["acme"], applies_to_tools: ["*"], entry_class: "playbook",
      read_command: `node /scripts/em-search.mjs --read ${id}` };
  }
  function lsEntry(id, summary, value, pri = 5) {
    return { trigger_kind: "phrase", value, episode_id: id, summary, effective_priority: pri,
      applies_to_projects: ["acme"], applies_to_tools: ["claude-code"] };
  }

  // (a) PLAYBOOK with 2 co-matching triggers: prompt matches BOTH → one line.
  {
    const idx = { entries: [
      pbEntry("pb-1", "pb summary", "alphaword"),
      pbEntry("pb-1", "pb summary", "betaword"),
    ], activity_phrases: {} };
    const r = matchActivation(idx, promptEvent("alphaword and betaword together"), IDENTITY, undefined, BOUNDS);
    const pbCount = (r.lines.join("\n").match(/playbook \(playbooks\.json\):/g) || []).length;
    assert(pbCount === 1, "T6g_playbook_co_match_one_line: a playbook with 2 co-matching triggers renders exactly ONE line (R2.9(b)); duplicates no longer burn max_matches", JSON.stringify(r.lines));
    assert(r.lines.length === 1 && r.lines[0].includes("pb-1"), "T6g_playbook_co_match_one_line: the one line is the playbook form", JSON.stringify(r.lines));
  }
  // (b) PLAIN LESSON with 2 co-matching triggers: prompt matches BOTH → one line.
  {
    const idx = { entries: [
      lsEntry("ls-1", "ls summary", "alphaword"),
      lsEntry("ls-1", "ls summary", "betaword"),
    ], activity_phrases: {} };
    const r = matchActivation(idx, promptEvent("alphaword and betaword together"), IDENTITY, undefined, BOUNDS);
    const lsCount = (r.lines.join("\n").match(/lesson ls-1:/g) || []).length;
    assert(lsCount === 1, "T6g_lesson_co_match_one_line: a plain lesson with 2 co-matching triggers renders exactly ONE line (R2.9(b) first half)", JSON.stringify(r.lines));
  }
  // (c) BOTH a lesson row AND a playbook row for the SAME episode, different
  //     triggers, both match → ONE line, PLAYBOOK form wins (R2.9(b) second half).
  {
    const idx = { entries: [
      lsEntry("dual-1", "lesson form", "alphaword", 9),  // band-9 lesson (sorts first without dedup)
      pbEntry("dual-1", "playbook form", "betaword"),
    ], activity_phrases: {} };
    const r = matchActivation(idx, promptEvent("alphaword and betaword together"), IDENTITY, undefined, BOUNDS);
    const lines = r.lines;
    const pbForm = lines.filter((l) => l.includes("playbook (playbooks.json):"));
    const lsForm = lines.filter((l) => l.startsWith("lesson dual-1:") || l.startsWith("READ dual-1 before proceeding (em-search --history"));
    assert(lines.length === 1, "T6g_playbook_wins_one_line: exactly ONE line for the episode (R2.9(b) one-per-episode)", JSON.stringify(lines));
    assert(pbForm.length === 1 && lsForm.length === 0, "T6g_playbook_wins: the one line is the PLAYBOOK form, NOT the lesson imperative/plain form (R2.9(b) playbook-wins; the seen-set did not let the band-9 lesson row block the playbook row)", JSON.stringify(lines));
  }
  // (d) control: DIFFERENT episodes each with one trigger → TWO lines (dedup is per-episode, not per-event).
  {
    const idx = { entries: [
      pbEntry("pb-a", "pb a", "alphaword"),
      pbEntry("pb-b", "pb b", "betaword"),
    ], activity_phrases: {} };
    const r = matchActivation(idx, promptEvent("alphaword and betaword together"), IDENTITY, undefined, BOUNDS);
    assert(r.lines.length === 2, "T6g_different_episodes_not_deduped: two DIFFERENT episodes each render (dedup is per-episode, not a collapse of distinct episodes)", JSON.stringify(r.lines));
  }
}

// ===========================================================================
// T9d — config-free project + global-index-present: ZERO rebuild spawns across
// repeated events (fix-round Item 1, 3-way convergent: agent F2 + codex S3-F1 +
// kimi F1). R2.5(b): config-free stores pay NO cross-store coupling. The
// cached source has NO global_index_* keys (built with no playbooks.json). The
// hook must NOT compare the global index and must NOT spawn the rebuild
// subprocess on any event. Asserts SPAWN evidence (a log written by a wrapper
// replacing em-trigger-index.mjs), not JSON counters — the build's cache-hit is
// a no-op rewrite, so on-disk mtime is insufficient.
// ===========================================================================
{
  const { home, proj, slug } = mkFixture("t9d-nocoupling");
  writeManifest({ slug, root: proj });
  // Local lesson (no playbooks.json ever written → config-free).
  const localId = "t9d-local" + "x".repeat(11);
  writeEpisodeFile(storeDir(proj), { id: localId, slug, summary: "t9d local", triggers: ["t9dphrase"] });
  rebuildIndex({ home, proj });
  fs.rmSync(tiPath(proj), { force: true });
  rebuildFresh({ home, proj });
  const ti = readTi(proj);
  assert(!("global_index_mtime_ms" in ti.source), "T9d_setup_config_free: cached source has NO global_index_* (config-free build)", JSON.stringify(Object.keys(ti.source).sort()));
  // Global store with an index.jsonl (the default state of every real install).
  // fix-round N1: MUST build the global index.jsonl via rebuildIndex —
  // writeEpisodeFile writes ONLY the .md; without the rebuild, the global
  // index.jsonl is absent, the reverted bug's `expectGlobalIndex.mtimeMs !== 0`
  // is false, `eitherSide=false`, `fresh=true`, 0 spawns → the reverted bug
  // stays GREEN vacuously. With the rebuild, the global index.jsonl exists →
  // the reverted bug sees `eitherSide=true`, `undefined !== <mtime>` → spawns on
  // every event (RED at spawnCount=3); the fixed code still never stats it
  // (cached source has no global_index_*) → 0 spawns (GREEN).
  fs.mkdirSync(path.join(globalDir(home)), { recursive: true });
  fs.mkdirSync(path.join(globalDir(home), "episodes"), { recursive: true });
  const gId = "t9d-glob" + "x".repeat(11);
  writeEpisodeFile(globalDir(home), { id: gId, slug, summary: "global ep", triggers: ["gphrase"] });
  rebuildIndex({ home, proj, scope: "global" });  // builds the global index.jsonl from the .md
  // Instrument: replace FAKE_TRIGGER_INDEX_SCRIPT with a wrapper that logs
  // spawns to a file and exits 0 (no rewrite) so the hook reads back the cached
  // index. The spawn-log count IS the rebuild-spawn count.
  const spawnLog = path.join(home, "spawn.log");
  fs.writeFileSync(spawnLog, "");
  const realScript = fs.readFileSync(FAKE_TRIGGER_INDEX_SCRIPT, "utf8");
  fs.writeFileSync(FAKE_TRIGGER_INDEX_SCRIPT,
    "#!/usr/bin/env node\n" +
    "import fs from 'node:fs';\n" +
    `fs.appendFileSync(${JSON.stringify(spawnLog)}, 'spawn\\n');\n` +
    "process.exit(0);\n");
  fs.chmodSync(FAKE_TRIGGER_INDEX_SCRIPT, 0o755);
  try {
    // Run the prompt hook 3 times. With the fix: 0 spawns (no coupling).
    // WITHOUT the fix: 3 spawns (one per event, spurious rebuild subprocess).
    for (let i = 0; i < 3; i++) {
      const r = runPrompt({ home, stdin: { prompt: "t9dphrase now" } });
      assert(r.status === 0, `T9d run ${i}: hook exits 0`, `status=${r.status}`);
    }
    const spawnCount = fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
    assert(spawnCount === 0,
      "T9d_config_free_no_global_coupling: ZERO rebuild spawns across 3 repeated events when the cached source carries no global_index_* (R2.5(b) no cross-store coupling; fix-round Item 1)",
      `spawnCount=${spawnCount}`);
  } finally {
    // Restore the real script so subsequent tests use the real build.
    fs.writeFileSync(FAKE_TRIGGER_INDEX_SCRIPT, realScript);
    fs.chmodSync(FAKE_TRIGGER_INDEX_SCRIPT, 0o755);
  }
  removeManifest();
}

// ===========================================================================
console.log(`\ntest-activation-playbooks: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all activation-playbooks checks passed");
