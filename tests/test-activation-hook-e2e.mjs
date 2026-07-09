#!/usr/bin/env node
// test-activation-hook-e2e.mjs — RFC-009 P2-S4 (R3) Group 2 E2E tests for the
// two advisory event hooks (UserPromptSubmit -> activation-prompt.sh,
// PreToolUse -> activation-tool.sh), driven end-to-end: the REAL, COMMITTED
// hook .sh/.mjs bytes are spawned against a REAL fixture store built with the
// REAL em-store.mjs / em-trigger-index.mjs (isolated HOME + project, never
// the developer's real ~/.episodic-memory or this repo's own local store —
// feedback_mock_project_test_not_mental_trace).
//
// Fixture scaffold: activation-hook-run.mjs resolves its scripts/lib/
// dependencies relative to itself (three directories up from
// plugins/claude-code-activation/hooks -> repo root -> scripts/...), exactly
// like em-recall-sessionstart.sh resolves enforce-contract.mjs. To drive the
// real hook bytes without ever writing a scratch manifest.json into the
// TRACKED plugins/claude-code-activation/ directory, this file copies scripts/
// + schemas/ + activation-classes.json + the 3 activation hook files into an
// isolated temp tree that mirrors the real repo's relative depth (see
// buildFakeRepo below) — the hook's own repo-relative resolution then finds
// everything inside that scratch copy, and each test writes its own
// manifest.json (with project_identity) into the scratch copy only.
//
// Run: node tests/test-activation-hook-e2e.mjs   (exit 0 = pass)

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
const FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "act-hook-e2e-repo-"));
fs.cpSync(path.join(REPO_ROOT, "scripts"), path.join(FAKE_ROOT, "scripts"), { recursive: true });
fs.cpSync(path.join(REPO_ROOT, "schemas"), path.join(FAKE_ROOT, "schemas"), { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, "activation-classes.json"), path.join(FAKE_ROOT, "activation-classes.json"));
const FAKE_HOOKS_DIR = path.join(FAKE_ROOT, "plugins/claude-code-activation/hooks");
fs.mkdirSync(FAKE_HOOKS_DIR, { recursive: true });
for (const f of ["activation-prompt.sh", "activation-tool.sh", "activation-hook-run.mjs"]) {
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
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `act-hook-e2e-${label}-`)));
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
    project = "acme", summary, body = "body", trigger, appliesToProject = "acme",
    appliesToTool = "claude-code", priority = 5,
  } = opts;
  const args = [
    path.join(REPO_ROOT, "scripts/em-store.mjs"),
    "--project", project, "--category", "lesson", "--tags", "test",
    "--summary", summary, "--body", body, "--scope", "local",
  ];
  if (trigger) args.push("--trigger", trigger);
  if (appliesToProject) args.push("--applies-to-project", appliesToProject);
  if (appliesToTool) args.push("--applies-to-tool", appliesToTool);
  if (priority !== undefined) args.push("--priority", String(priority));
  const env = scrubEnv({ ...process.env, HOME: home });
  const r = spawnSync("node", args, { cwd: proj, env, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`em-store failed (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

function triggerIndexPath(proj) {
  return path.join(proj, ".episodic-memory", "trigger-index.json");
}

function runHook(which, { home, stdin, extraEnv = {} }) {
  const script = which === "prompt" ? "activation-prompt.sh" : "activation-tool.sh";
  const env = scrubEnv({ ...process.env, HOME: home, ...extraEnv });
  const r = spawnSync("bash", [path.join(FAKE_HOOKS_DIR, script)], {
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

// ===========================================================================
// 1. prompt_hook_emits_additionalContext
// ===========================================================================
{
  const { home, proj } = mkFixture("prompt-basic");
  writeManifest({ slug: "acme", root: proj });
  const ep = storeEpisode(home, proj, { summary: "probe lesson one", trigger: "probewidget" });
  const r = runHook("prompt", { home, stdin: { prompt: "the probewidget needs attention" } });
  const out = parseHookOut(r.stdout);
  assert(r.status === 0, "prompt_hook_emits_additionalContext: hook exits 0", `status=${r.status} stderr=${r.stderr}`);
  assert(!!out && out.hookSpecificOutput && out.hookSpecificOutput.hookEventName === "UserPromptSubmit",
    "prompt_hook_emits_additionalContext: emits hookSpecificOutput.hookEventName=UserPromptSubmit", r.stdout);
  assert(!!out && typeof out.hookSpecificOutput.additionalContext === "string" && out.hookSpecificOutput.additionalContext.includes(ep.id),
    "prompt_hook_emits_additionalContext: additionalContext names the matched episode id", r.stdout);
  removeManifest();
}

// ===========================================================================
// 2. prompt_hook_missing_index_exit0
// ===========================================================================
{
  const { home, proj } = mkFixture("prompt-missing");
  fs.mkdirSync(proj, { recursive: true });
  writeManifest({ slug: "acme", root: proj }); // no .episodic-memory ever created under proj
  const r = runHook("prompt", { home, stdin: { prompt: "anything at all" } });
  assert(r.status === 0, "prompt_hook_missing_index_exit0: exits 0 with no trigger-index.json at all", `status=${r.status}`);
  assert(r.stdout.trim() === "", "prompt_hook_missing_index_exit0: no output emitted", JSON.stringify(r.stdout));
  removeManifest();
}

// ===========================================================================
// 3. prompt_hook_corrupt_index_exit0 (recoverable rebuild + unrecoverable skip)
// ===========================================================================
{
  const { home, proj } = mkFixture("prompt-corrupt");
  writeManifest({ slug: "acme", root: proj });
  const ep = storeEpisode(home, proj, { summary: "corrupt-recovery lesson", trigger: "corruptthing" });
  const tiPath = triggerIndexPath(proj);

  // (a) recoverable: corrupt the file, expect a successful rebuild-once and a
  //     correct match, still exit 0, no decision field.
  fs.writeFileSync(tiPath, "{not valid json");
  const r1 = runHook("prompt", { home, stdin: { prompt: "corruptthing happened" } });
  const out1 = parseHookOut(r1.stdout);
  assert(r1.status === 0, "prompt_hook_corrupt_index_exit0: recoverable corruption still exits 0", `status=${r1.status} stderr=${r1.stderr}`);
  assert(!!out1 && out1.hookSpecificOutput.additionalContext.includes(ep.id),
    "prompt_hook_corrupt_index_exit0: rebuild-once recovers the match", r1.stdout);
  assert(noDecisionField(r1.stdout), "prompt_hook_corrupt_index_exit0: no decision field on the recoverable path", r1.stdout);

  // (b) unrecoverable: corrupt again AND hide the rebuild tool so the
  //     carve-out subprocess cannot succeed -> skip store with stderr, still
  //     exit 0, no output, no decision field (EC10 else-branch + EC12).
  fs.writeFileSync(tiPath, "{still not valid json");
  const hidden = FAKE_TRIGGER_INDEX_SCRIPT + ".hidden";
  fs.renameSync(FAKE_TRIGGER_INDEX_SCRIPT, hidden);
  let r2;
  try {
    r2 = runHook("prompt", { home, stdin: { prompt: "corruptthing happened" } });
  } finally {
    fs.renameSync(hidden, FAKE_TRIGGER_INDEX_SCRIPT);
  }
  assert(r2.status === 0, "prompt_hook_corrupt_index_exit0: unrecoverable corruption still exits 0", `status=${r2.status}`);
  assert(r2.stdout.trim() === "", "prompt_hook_corrupt_index_exit0: unrecoverable corruption emits no output (store skipped)", JSON.stringify(r2.stdout));
  assert(noDecisionField(r2.stdout), "prompt_hook_corrupt_index_exit0: no decision field on the unrecoverable path", r2.stdout);
  removeManifest();
}

// ===========================================================================
// 4. tool_hook_bash_match
// ===========================================================================
{
  const { home, proj } = mkFixture("tool-bash");
  writeManifest({ slug: "acme", root: proj });
  const ep = storeEpisode(home, proj, { summary: "bash trigger lesson", trigger: "tool:Bash:rm *" });
  const hit = runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } } });
  const miss = runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "ls -la" } } });
  const outHit = parseHookOut(hit.stdout);
  assert(hit.status === 0 && !!outHit && outHit.hookSpecificOutput.additionalContext.includes(ep.id),
    "tool_hook_bash_match: Bash command glob match fires", hit.stdout);
  assert(miss.status === 0 && miss.stdout.trim() === "",
    "tool_hook_bash_match: non-matching Bash command emits nothing", JSON.stringify(miss.stdout));
  removeManifest();
}

// ===========================================================================
// 5. tool_hook_edit_filepath
// ===========================================================================
{
  const { home, proj } = mkFixture("tool-edit");
  writeManifest({ slug: "acme", root: proj });
  const ep = storeEpisode(home, proj, { summary: "edit trigger lesson", trigger: "tool:Edit:src/*.mjs" });
  const hit = runHook("tool", { home, stdin: { tool_name: "Edit", tool_input: { file_path: "src/foo.mjs" } } });
  const miss = runHook("tool", { home, stdin: { tool_name: "Edit", tool_input: { file_path: "test/foo.mjs" } } });
  const outHit = parseHookOut(hit.stdout);
  assert(hit.status === 0 && !!outHit && outHit.hookSpecificOutput.additionalContext.includes(ep.id),
    "tool_hook_edit_filepath: Edit file_path glob match fires", hit.stdout);
  assert(miss.status === 0 && miss.stdout.trim() === "",
    "tool_hook_edit_filepath: non-matching file_path emits nothing", JSON.stringify(miss.stdout));

  // EC9 bonus: an unknown tool with a name-alone `tool:<Name>:*` trigger.
  storeEpisode(home, proj, { summary: "unknown-tool lesson", trigger: "tool:Grep:*" });
  const unk = runHook("tool", { home, stdin: { tool_name: "Grep", tool_input: { pattern: "foo" } } });
  const outUnk = parseHookOut(unk.stdout);
  assert(unk.status === 0 && !!outUnk && outUnk.hookSpecificOutput.additionalContext.includes("unknown-tool lesson"),
    "tool_hook_edit_filepath: EC9 unknown tool matches name-alone trigger with empty target", unk.stdout);
  removeManifest();
}

// ===========================================================================
// 6. tool_hook_missing_index_exit0
// ===========================================================================
{
  const { home, proj } = mkFixture("tool-missing");
  fs.mkdirSync(proj, { recursive: true });
  writeManifest({ slug: "acme", root: proj });
  const r = runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "ls" } } });
  assert(r.status === 0, "tool_hook_missing_index_exit0: exits 0 with no trigger-index.json at all", `status=${r.status}`);
  assert(r.stdout.trim() === "", "tool_hook_missing_index_exit0: no output emitted", JSON.stringify(r.stdout));
  removeManifest();
}

// ===========================================================================
// 7. tool_hook_corrupt_index_exit0
// ===========================================================================
{
  const { home, proj } = mkFixture("tool-corrupt");
  writeManifest({ slug: "acme", root: proj });
  const ep = storeEpisode(home, proj, { summary: "tool corrupt lesson", trigger: "tool:Bash:corruptcmd*" });
  const tiPath = triggerIndexPath(proj);
  fs.writeFileSync(tiPath, "]] not json [[");
  const r = runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "corruptcmd now" } } });
  const out = parseHookOut(r.stdout);
  assert(r.status === 0, "tool_hook_corrupt_index_exit0: exits 0 after corruption", `status=${r.status} stderr=${r.stderr}`);
  assert(!!out && out.hookSpecificOutput.additionalContext.includes(ep.id),
    "tool_hook_corrupt_index_exit0: rebuild-once recovers the match", r.stdout);
  assert(noDecisionField(r.stdout), "tool_hook_corrupt_index_exit0: no decision field", r.stdout);
  removeManifest();
}

// ===========================================================================
// 8. hook_no_decision_field_any_path — force every branch on both hooks,
//    grep every stdout for decision/block/permissionDecision.
// ===========================================================================
{
  const { home, proj } = mkFixture("no-decision");
  const runs = [];

  // no manifest at all
  removeManifest();
  runs.push(["no-manifest/prompt", runHook("prompt", { home, stdin: { prompt: "x" } })]);
  runs.push(["no-manifest/tool", runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "x" } } })]);

  writeManifest({ slug: "acme", root: proj });

  // empty / non-object stdin (EC1)
  runs.push(["empty-stdin/prompt", runHook("prompt", { home, stdin: "" })]);
  runs.push(["array-stdin/prompt", runHook("prompt", { home, stdin: "[1,2,3]" })]);
  runs.push(["garbage-stdin/tool", runHook("tool", { home, stdin: "not json at all" })]);

  // missing index (both hooks)
  runs.push(["missing-index/prompt", runHook("prompt", { home, stdin: { prompt: "x" } })]);
  runs.push(["missing-index/tool", runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "x" } } })]);

  const ep = storeEpisode(home, proj, { summary: "decision-gauntlet lesson", trigger: "gauntletphrase", priority: 7 });
  storeEpisode(home, proj, { summary: "gauntlet tool lesson", trigger: "tool:Bash:gauntlet*" });

  // match (both hooks)
  runs.push(["match/prompt", runHook("prompt", { home, stdin: { prompt: "gauntletphrase now" } })]);
  runs.push(["match/tool", runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "gauntlet now" } } })]);

  // no-match (both hooks)
  runs.push(["no-match/prompt", runHook("prompt", { home, stdin: { prompt: "totally unrelated text" } })]);
  runs.push(["no-match/tool", runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "unrelated" } } })]);

  // unknown tool name (EC9)
  runs.push(["unknown-tool/tool", runHook("tool", { home, stdin: { tool_name: "SomeMcpTool", tool_input: {} } })]);

  // corrupt index — recoverable
  fs.writeFileSync(triggerIndexPath(proj), "{{{broken");
  runs.push(["corrupt-recoverable/prompt", runHook("prompt", { home, stdin: { prompt: "gauntletphrase now" } })]);

  // corrupt index — unrecoverable (rebuild tool hidden)
  fs.writeFileSync(triggerIndexPath(proj), "{{{broken again");
  const hidden = FAKE_TRIGGER_INDEX_SCRIPT + ".hidden2";
  fs.renameSync(FAKE_TRIGGER_INDEX_SCRIPT, hidden);
  try {
    runs.push(["corrupt-unrecoverable/prompt", runHook("prompt", { home, stdin: { prompt: "gauntletphrase now" } })]);
    runs.push(["corrupt-unrecoverable/tool", runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "gauntlet now" } } })]);
  } finally {
    fs.renameSync(hidden, FAKE_TRIGGER_INDEX_SCRIPT);
  }

  // suppressed match — episode id muted via lesson-suppress.json
  fs.mkdirSync(path.join(proj, ".episodic-memory"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), JSON.stringify({
    schema_version: 1, suppress: [{ episode_id: ep.id, reason: "test", added: "2026-07-09" }],
  }));
  runs.push(["suppressed/prompt", runHook("prompt", { home, stdin: { prompt: "gauntletphrase now" } })]);
  fs.rmSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), { force: true });

  // malformed lesson-suppress.json (shape-malformed) — injection must still proceed
  fs.writeFileSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), JSON.stringify({ schema_version: 1, suppress: [{ reason: "no id" }] }));
  runs.push(["suppress-shape-malformed/prompt", runHook("prompt", { home, stdin: { prompt: "gauntletphrase now" } })]);
  fs.rmSync(path.join(proj, ".episodic-memory", "lesson-suppress.json"), { force: true });

  let allZeroExit = true;
  let allClean = true;
  const dirty = [];
  for (const [label, r] of runs) {
    if (r.status !== 0) { allZeroExit = false; dirty.push(`${label}: status=${r.status}`); }
    if (!noDecisionField(r.stdout) || !noDecisionField(r.stderr)) { allClean = false; dirty.push(`${label}: ${r.stdout} / ${r.stderr}`); }
  }
  assert(allZeroExit, "hook_no_decision_field_any_path: every forced branch exits 0", JSON.stringify(dirty));
  assert(allClean, "hook_no_decision_field_any_path: no decision/block/permissionDecision field on any forced branch", JSON.stringify(dirty));

  // sanity: the suppressed run really did suppress (proves the suppress branch
  // was actually exercised, not vacuously skipped).
  const suppressedRun = runs.find(([l]) => l === "suppressed/prompt")[1];
  assert(suppressedRun.stdout.trim() === "", "hook_no_decision_field_any_path: suppressed episode really is absent from output", JSON.stringify(suppressedRun.stdout));
  const shapeMalformedRun = runs.find(([l]) => l === "suppress-shape-malformed/prompt")[1];
  const outShapeMalformed = parseHookOut(shapeMalformedRun.stdout);
  assert(!!outShapeMalformed && outShapeMalformed.hookSpecificOutput.additionalContext.includes(ep.id),
    "hook_no_decision_field_any_path: shape-malformed lesson-suppress.json fails open (injection proceeds)", shapeMalformedRun.stdout);

  removeManifest();
}

// ===========================================================================
// 9. hook_no_track — index.jsonl and the episode file are byte-unchanged
//    across hook runs, including a forced stale rebuild.
// ===========================================================================
{
  const { home, proj } = mkFixture("no-track");
  writeManifest({ slug: "acme", root: proj });
  const ep = storeEpisode(home, proj, { summary: "no-track lesson", trigger: "notrackphrase" });
  storeEpisode(home, proj, { summary: "no-track tool lesson", trigger: "tool:Bash:notrack*" });

  const indexPath = path.join(proj, ".episodic-memory", "index.jsonl");
  const episodeFile = path.join(proj, ".episodic-memory", "episodes", `${ep.id}.md`);
  const before = { index: fs.readFileSync(indexPath), episode: fs.readFileSync(episodeFile) };

  runHook("prompt", { home, stdin: { prompt: "notrackphrase now" } });
  runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "notrack now" } } });

  // force a stale rebuild too (still must not touch index.jsonl/episode bytes)
  const cached = JSON.parse(fs.readFileSync(triggerIndexPath(proj), "utf8"));
  cached.source.index_size = -1;
  fs.writeFileSync(triggerIndexPath(proj), JSON.stringify(cached));
  runHook("prompt", { home, stdin: { prompt: "notrackphrase now" } });

  const after = { index: fs.readFileSync(indexPath), episode: fs.readFileSync(episodeFile) };
  assert(before.index.equals(after.index), "hook_no_track: index.jsonl byte-unchanged across hook runs (incl. a forced stale rebuild)");
  assert(before.episode.equals(after.episode), "hook_no_track: episode file byte-unchanged across hook runs");
  removeManifest();
}

// ===========================================================================
// 10. hook_body_sentinel_absent
// ===========================================================================
{
  const { home, proj } = mkFixture("body-sentinel");
  writeManifest({ slug: "acme", root: proj });
  const sentinel = `SENTINEL-${crypto.randomBytes(8).toString("hex")}`;
  const ep = storeEpisode(home, proj, { summary: "sentinel lesson", body: `body containing ${sentinel} never to leak`, trigger: "sentinelphrase" });
  const r = runHook("prompt", { home, stdin: { prompt: "sentinelphrase now" } });
  const out = parseHookOut(r.stdout);
  assert(!!out && out.hookSpecificOutput.additionalContext.includes(ep.id), "hook_body_sentinel_absent: the match still fires", r.stdout);
  assert(!r.stdout.includes(sentinel), "hook_body_sentinel_absent: the planted body sentinel never appears in hook output", r.stdout);
  removeManifest();
}

// ===========================================================================
// 11. r3_fresh_path_no_substrate_read (both hooks)
// ===========================================================================
{
  const { home, proj } = mkFixture("fresh-path");
  writeManifest({ slug: "acme", root: proj });
  storeEpisode(home, proj, { summary: "fresh phrase lesson", trigger: "freshphrase" });
  storeEpisode(home, proj, { summary: "fresh tool lesson", trigger: "tool:Bash:freshcmd*" });

  const tiPath = triggerIndexPath(proj);
  const mtimeBeforePrompt = fs.statSync(tiPath).mtimeMs;
  runHook("prompt", { home, stdin: { prompt: "freshphrase now" } });
  const mtimeAfterPrompt = fs.statSync(tiPath).mtimeMs;
  assert(mtimeBeforePrompt === mtimeAfterPrompt, "r3_fresh_path_no_substrate_read: prompt hook does not rebuild trigger-index.json on the fresh path", `${mtimeBeforePrompt} -> ${mtimeAfterPrompt}`);

  const mtimeBeforeTool = fs.statSync(tiPath).mtimeMs;
  runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "freshcmd now" } } });
  const mtimeAfterTool = fs.statSync(tiPath).mtimeMs;
  assert(mtimeBeforeTool === mtimeAfterTool, "r3_fresh_path_no_substrate_read: tool hook does not rebuild trigger-index.json on the fresh path", `${mtimeBeforeTool} -> ${mtimeAfterTool}`);
  removeManifest();
}

// ===========================================================================
// 12. r3_stale_path_carveout (both hooks)
// ===========================================================================
{
  const { home, proj } = mkFixture("stale-path");
  writeManifest({ slug: "acme", root: proj });
  const ep1 = storeEpisode(home, proj, { summary: "stale phrase lesson", trigger: "stalephrase" });
  storeEpisode(home, proj, { summary: "stale tool lesson", trigger: "tool:Bash:stalecmd*" });
  const tiPath = triggerIndexPath(proj);

  function breakFreshness() {
    const cached = JSON.parse(fs.readFileSync(tiPath, "utf8"));
    cached.source.index_size = cached.source.index_size + 999;
    fs.writeFileSync(tiPath, JSON.stringify(cached));
  }

  breakFreshness();
  const mtimeBeforePrompt = fs.statSync(tiPath).mtimeMs;
  const rPrompt = runHook("prompt", { home, stdin: { prompt: "stalephrase now" } });
  const mtimeAfterPrompt = fs.statSync(tiPath).mtimeMs;
  const outPrompt = parseHookOut(rPrompt.stdout);
  assert(mtimeAfterPrompt !== mtimeBeforePrompt, "r3_stale_path_carveout: prompt hook rebuilds trigger-index.json via the carve-out on a stale store", `${mtimeBeforePrompt} -> ${mtimeAfterPrompt}`);
  assert(!!outPrompt && outPrompt.hookSpecificOutput.additionalContext.includes(ep1.id), "r3_stale_path_carveout: the rebuilt index still yields a correct match", rPrompt.stdout);

  breakFreshness();
  const mtimeBeforeTool = fs.statSync(tiPath).mtimeMs;
  const rTool = runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "stalecmd now" } } });
  const mtimeAfterTool = fs.statSync(tiPath).mtimeMs;
  assert(mtimeAfterTool !== mtimeBeforeTool, "r3_stale_path_carveout: tool hook rebuilds trigger-index.json via the carve-out on a stale store", `${mtimeBeforeTool} -> ${mtimeAfterTool}`);
  assert(rTool.status === 0 && noDecisionField(rTool.stdout), "r3_stale_path_carveout: tool hook stale-rebuild path still advisory (exit 0, no decision field)", rTool.stdout);
  removeManifest();
}

// ===========================================================================
// 13. r3_env_independence (git + package.json + EM_ACTIVATION_CLASSES_PATH; both hooks)
// ===========================================================================
{
  const { home, proj } = mkFixture("env-independence");
  writeManifest({ slug: "acme", root: proj });
  storeEpisode(home, proj, { summary: "env phrase lesson", trigger: "envphrase" });
  storeEpisode(home, proj, { summary: "env tool lesson", trigger: "tool:Bash:envcmd*" });
  const tiPath = triggerIndexPath(proj);
  const mtimeBaseline = fs.statSync(tiPath).mtimeMs;

  fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "distractor" }));
  const bogusClassesPath = path.join(proj, "bogus-activation-classes.json");
  fs.writeFileSync(bogusClassesPath, JSON.stringify({ version: "9.9.9", classes: [] }));

  const variants = [
    { label: "baseline", extraEnv: {} },
    { label: "with-classes-env-set", extraEnv: { EM_ACTIVATION_CLASSES_PATH: bogusClassesPath } },
    { label: "with-classes-env-missing-file", extraEnv: { EM_ACTIVATION_CLASSES_PATH: path.join(proj, "does-not-exist.json") } },
  ];

  // vary git presence too (present at first two variants, removed for the third pass below)
  const promptOutputs = variants.map((v) => runHook("prompt", { home, stdin: { prompt: "envphrase now" }, extraEnv: v.extraEnv }));
  fs.rmSync(path.join(proj, ".git"), { recursive: true, force: true });
  promptOutputs.push(runHook("prompt", { home, stdin: { prompt: "envphrase now" } }));
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });

  const toolOutputs = variants.map((v) => runHook("tool", { home, stdin: { tool_name: "Bash", tool_input: { command: "envcmd now" } }, extraEnv: v.extraEnv }));

  const promptBytes = promptOutputs.map((r) => r.stdout);
  const toolBytes = toolOutputs.map((r) => r.stdout);
  assert(promptBytes.every((s) => s === promptBytes[0]), "r3_env_independence: prompt hook output byte-identical across git/package.json/EM_ACTIVATION_CLASSES_PATH variation", JSON.stringify(promptBytes));
  assert(toolBytes.every((s) => s === toolBytes[0]), "r3_env_independence: tool hook output byte-identical across git/package.json/EM_ACTIVATION_CLASSES_PATH variation", JSON.stringify(toolBytes));

  const mtimeAfter = fs.statSync(tiPath).mtimeMs;
  assert(mtimeAfter === mtimeBaseline, "r3_env_independence: no rebuild fired across any variant (pure fresh-path reads)", `${mtimeBaseline} -> ${mtimeAfter}`);
  removeManifest();
}

// ===========================================================================
// 14. identity_from_manifest_not_cwd
// ===========================================================================
{
  const { home, proj: projWithLesson } = mkFixture("identity-manifest-a");
  const { proj: projWithoutLesson } = mkFixture("identity-manifest-b");
  fs.mkdirSync(projWithoutLesson, { recursive: true });

  writeManifest({ slug: "acme", root: projWithLesson });
  const ep = storeEpisode(home, projWithLesson, { summary: "identity lesson", trigger: "identityphrase" });

  // stdin .cwd names the OTHER project (which has no matching lesson at all);
  // CLAUDE_PROJECT_DIR env also points elsewhere. The manifest's
  // project_identity.root must win over both.
  const r = runHook("prompt", {
    home,
    stdin: { cwd: projWithoutLesson, prompt: "identityphrase now" },
    extraEnv: { CLAUDE_PROJECT_DIR: projWithoutLesson },
  });
  const out = parseHookOut(r.stdout);
  assert(r.status === 0 && !!out && out.hookSpecificOutput.additionalContext.includes(ep.id),
    "identity_from_manifest_not_cwd: manifest project_identity.root wins over a mismatched stdin .cwd / CLAUDE_PROJECT_DIR", r.stdout);
  removeManifest();
}

// ===========================================================================
// 15. suppress_stderr_note (codex P2-S4 review F2) — a genuinely-absent
//     lesson-suppress.json is SILENT (no per-event note); an EXISTS-but-
//     malformed one emits exactly ONE observable stderr note (now that the
//     wrappers no longer discard the runner's stderr). Both fail OPEN
//     (injection proceeds), exit 0, and keep stdout to the additionalContext
//     envelope only.
// ===========================================================================
{
  const { home, proj } = mkFixture("suppress-stderr");
  writeManifest({ slug: "acme", root: proj });
  const ep = storeEpisode(home, proj, { summary: "suppress-stderr lesson", trigger: "suppressstderrphrase" });
  const suppressPath = path.join(proj, ".episodic-memory", "lesson-suppress.json");
  const promptFor = (extraCleanup) => {
    const r = runHook("prompt", { home, stdin: { prompt: "suppressstderrphrase now" } });
    if (extraCleanup) fs.rmSync(suppressPath, { force: true });
    return r;
  };
  const noteCount = (stderr) => stderr.split("\n").filter((l) => l.includes("activation-hook: lesson-suppress.json")).length;
  const stdoutIsEnvelopeOnly = (r, id) => {
    const out = parseHookOut(r.stdout);
    return !!out && Object.keys(out).length === 1 && !!out.hookSpecificOutput &&
      typeof out.hookSpecificOutput.additionalContext === "string" &&
      out.hookSpecificOutput.additionalContext.includes(id);
  };

  // (a) absent -> exit 0, NO note on stderr, injection proceeds.
  fs.rmSync(suppressPath, { force: true });
  const rAbsent = promptFor(false);
  assert(rAbsent.status === 0, "suppress_stderr_note: absent file exits 0", `status=${rAbsent.status}`);
  assert(noteCount(rAbsent.stderr) === 0, "suppress_stderr_note: absent file emits NO lesson-suppress note on stderr (common case is silent)", JSON.stringify(rAbsent.stderr));
  assert(stdoutIsEnvelopeOnly(rAbsent, ep.id), "suppress_stderr_note: absent file — injection proceeds, stdout is the additionalContext envelope only", rAbsent.stdout);

  // (b) shape-malformed (valid JSON, entry without episode_id) -> ONE note, injection proceeds.
  fs.writeFileSync(suppressPath, JSON.stringify({ schema_version: 1, suppress: [{ reason: "no id" }] }));
  const rShape = promptFor(true);
  assert(rShape.status === 0, "suppress_stderr_note: shape-malformed exits 0", `status=${rShape.status}`);
  assert(noteCount(rShape.stderr) === 1, "suppress_stderr_note: shape-malformed emits exactly ONE stderr note", JSON.stringify(rShape.stderr));
  assert(stdoutIsEnvelopeOnly(rShape, ep.id), "suppress_stderr_note: shape-malformed — injection proceeds, stdout is the envelope only (note did not leak into stdout)", rShape.stdout);

  // (c) syntax-malformed (invalid JSON) -> ONE note, injection proceeds.
  fs.writeFileSync(suppressPath, "{ not valid json at all");
  const rSyntax = promptFor(true);
  assert(rSyntax.status === 0, "suppress_stderr_note: syntax-malformed exits 0", `status=${rSyntax.status}`);
  assert(noteCount(rSyntax.stderr) === 1, "suppress_stderr_note: syntax-malformed emits exactly ONE stderr note", JSON.stringify(rSyntax.stderr));
  assert(stdoutIsEnvelopeOnly(rSyntax, ep.id), "suppress_stderr_note: syntax-malformed — injection proceeds, stdout is the envelope only", rSyntax.stdout);

  removeManifest();
}

// ===========================================================================
console.log(`\ntest-activation-hook-e2e: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all activation hook E2E checks passed");
