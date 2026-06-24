#!/usr/bin/env node
/**
 * test-plugin.mjs — the 9-step conformance gauntlet for a harness enforcement
 * plugin (RFC-008 R0c P1c). The universal "does this plugin conform" oracle that
 * complements the static validate-plugin-registry.mjs. Maps to R1 (substrate),
 * R3/R4 (translation + taxonomy), R6 (plugin↔harness binding), R8 (registry).
 *
 * Steps 1-4,7,8,9 run in P1; steps 5/6 report `deferred-P3` (NOT pass) — they
 * round-trip through enforce-contract.mjs, which does not exist until P3. The
 * output distinguishes "7 pass + 2 deferred" from "9 pass" (plan H2: deferred ≠
 * pass; green-with-a-documented-gap, not green-meaning-complete).
 *
 *   --project <abs>   REQUIRED (else `git rev-parse --show-toplevel`; non-git
 *                     cwd fails clear). Canonicalized via realpath.
 *   --json            machine-readable output
 *
 * Output (stdout JSON): { status, project_root, summary:{pass,deferred,fail},
 *   steps:[{n,title,status,detail}], read_trace }
 * Exit: 0 = no failing step (deferred allowed), 1 = a step failed, 2 = usage/IO.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateRegistry } from "./validate-plugin-registry.mjs";
import { validateInstance } from "./lib/json-instance-validate.mjs";
import { interpretBindings } from "./lib/field-bindings.mjs";

const TIERS = ["STRONG", "MEDIUM", "WEAK", "TBD"];
const AGENT_MANIFEST_SENTINEL = "## 🤖 Agent invocation manifest";
// fixed clock — the gauntlet's $$now is deterministic so step-8 is reproducible.
const NOW = "2026-01-01T00:00:00Z";

class UsageError extends Error { constructor(m) { super(m); this.name = "UsageError"; } }

function resolveRoot(argProject, cwd) {
  if (argProject != null) {
    let real;
    try { real = fs.realpathSync(argProject); }
    catch (e) { throw new UsageError(`--project ${argProject} does not resolve: ${e.message}`); }
    if (!fs.statSync(real).isDirectory()) throw new UsageError(`--project ${argProject} is not a directory`);
    return real;
  }
  let top;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new UsageError("no --project and cwd is not inside a git repository (no silent caller-cwd fallback)"); }
  return fs.realpathSync(top);
}

// ---------------------------------------------------------------------------
// The gauntlet. Each step returns { n, title, status: pass|deferred-P3|fail, detail }.
// ---------------------------------------------------------------------------
export function runGauntlet({ projectRoot, harness = "claude-code", now = NOW, cwd = process.cwd() } = {}) {
  const read_trace = [];
  const root = resolveRoot(projectRoot, cwd);
  const readJson = (rel) => { const abs = path.join(root, rel); const t = fs.readFileSync(abs, "utf8"); read_trace.push(abs); return JSON.parse(t); };
  const readText = (rel) => { const abs = path.join(root, rel); const t = fs.readFileSync(abs, "utf8"); read_trace.push(abs); return t; };

  const steps = [];
  const step = (n, title, status, detail) => steps.push({ n, title, status, detail });

  // Resolve the claude-code enforcement entry from the registry.
  const index = readJson("plugins/_index.json");
  const entry = (index.plugins || []).find((p) => p.type === "enforcement" && p.id === harness);
  if (!entry) throw new UsageError(`no enforcement entry '${harness}' in plugins/_index.json`);
  const manifest = readJson(entry.manifest);
  const taxonomy = readJson("patterns/taxonomy.json");
  const events = readJson("patterns/events.json");

  // Steps 1-3,7 reuse the static validator (single source of truth): run it once
  // in live mode and read whether the attributed M-checks are clean.
  const vr = validateRegistry({ projectRoot: root });
  const clean = (...checks) => !vr.violations.some((v) => checks.includes(v.check));
  const why = (...checks) => JSON.stringify(vr.violations.filter((v) => checks.includes(v.check)).slice(0, 3));

  step(1, "manifest schema (M2)", clean("M2") ? "pass" : "fail", clean("M2") ? "manifest validates vs manifest.schema" : why("M2"));
  step(2, "_index schema (M1 + typed/versioned)", clean("M1", "typed_versioned") ? "pass" : "fail", clean("M1", "typed_versioned") ? "_index validates + version gate" : why("M1", "typed_versioned"));
  step(3, "runbook present + sentinel + COMMON (M7/M7a)", clean("M7", "M7a") ? "pass" : "fail", clean("M7", "M7a") ? "runbook present, sentinel + COMMON byte-equal" : why("M7", "M7a"));

  // Step 4 — golden classifier inputs vocabulary coherence (M5a-shaped). P1 runs
  // against the golden-input fixture; the real claude-code classifier emits TSV
  // (command-classifier.sh), so input→label classification is deferred to the P3
  // NDJSON cutover. Here: every golden expected_label is non-overridable AND in
  // the plugin's emits vocabulary (a dropped non-overridable label fails).
  steps.push(stepGoldenInputs(readJson, manifest, taxonomy));

  // Steps 5/6 — deferred-P3 (NOT pass). The thin-waist round-trip + F3 hard-reject
  // REAL writer both need enforce-contract.mjs (P3). The P1-local probe (C4) is a
  // path-resolution stand-in, NOT this writer.
  step(5, "thin-waist round-trip (enforce-contract.mjs)", "deferred-P3", "decision engine lands in P3; not exercised in P1");
  step(6, "F3 hard-reject real writer", "deferred-P3", "real out-of-vocab writer lands in P3; not exercised in P1");

  // Step 7 — capability honesty / M4a bypass-ceiling JOIN.
  step(7, "capability honesty (M4a)", clean("M4a") ? "pass" : "fail", clean("M4a") ? "every declared {harness,event} has an honest bypass record" : why("M4a"));

  // Step 8 — event replay (F39) through the field_bindings interpreter (C1).
  steps.push(stepEventReplay(root, readJson, readText, manifest, events, now, read_trace, entry.id));

  // Step 9 — runbook-derived invocation parity (F47) + N1 sandbox isolation.
  steps.push(stepInvocationParity(root, readText, manifest, read_trace));

  const summary = { pass: 0, deferred: 0, fail: 0 };
  for (const s of steps) {
    if (s.status === "pass") summary.pass++;
    else if (s.status === "deferred-P3") summary.deferred++;
    else summary.fail++;
  }
  const status = summary.fail > 0 ? "fail" : "ok";
  return { status, project_root: root, summary, steps, read_trace, exit: summary.fail > 0 ? 1 : 0 };
}

function stepGoldenInputs(readJson, manifest, taxonomy) {
  const n = 4, title = "golden classifier inputs — vocabulary coherence (M5a-shape; real run P3)";
  let fixture;
  try { fixture = readJson("tests/fixtures/plugins/non-overridable-inputs.json"); }
  catch (e) { return { n, title, status: "fail", detail: `golden-input fixture unreadable: ${e.message}` }; }
  const emits = new Set((manifest.classifier && manifest.classifier.emits_labels) || []);
  const nonOverridable = new Set(taxonomy.non_overridable || []);
  const cases = fixture.cases || [];
  if (cases.length === 0) return { n, title, status: "fail", detail: "golden-input fixture has no cases" };
  const bad = [];
  for (const c of cases) {
    if (!nonOverridable.has(c.expected_label)) bad.push(`${JSON.stringify(c.input)}: expected_label ${c.expected_label} is not non-overridable`);
    else if (!emits.has(c.expected_label)) bad.push(`${JSON.stringify(c.input)}: plugin does not emit non-overridable label ${c.expected_label}`);
  }
  return bad.length === 0
    ? { n, title, status: "pass", detail: `${cases.length} golden inputs cohere with emits vocab + non-overridable set` }
    : { n, title, status: "fail", detail: bad.slice(0, 3).join("; ") };
}

function stepEventReplay(root, readJson, readText, manifest, events, now, read_trace, harness = "claude-code") {
  const n = 8, title = "event replay (F39) — field_bindings → canonical payload";
  const trans = manifest.event_translations || {};
  const caps = manifest.capabilities || {};
  const eventById = new Map((events.events || []).map((e) => [e.id, e]));
  const problems = [];
  let replayed = 0;
  for (const [eventId, t] of Object.entries(trans)) {
    const dash = eventId.replace(/_/g, "-");
    let raw, schema;
    try { raw = readJson(`tests/fixtures/harness-events/${harness}/${dash}.json`); }
    catch (e) { problems.push(`${eventId}: no harness-event fixture (${e.message})`); continue; }
    try { schema = readJson(`schemas/events/event-${dash}.schema.json`); }
    catch (e) { problems.push(`${eventId}: no event schema (${e.message})`); continue; }
    // (a) interpret bindings -> canonical payload, then validate vs event schema.
    let payload;
    try { payload = interpretBindings(t.field_bindings, raw, { now }); }
    catch (e) { problems.push(`${eventId}: field_bindings interpret failed: ${e.message}`); continue; }
    const v = validateInstance(payload, schema);
    if (!v.valid) { problems.push(`${eventId}: payload fails event schema: ${JSON.stringify(v.errors.slice(0, 2))}`); continue; }
    // (b) field_bindings produced expected values (spot-check the ones present in raw).
    if (raw.session_id != null && payload.session_id !== raw.session_id) problems.push(`${eventId}: session_id binding mismatch`);
    // (c) coherence (NOT enforcement outcome — that is P3): event is declared, its
    // tier is valid, and (event,tier) maps to a non-`unsupported` action in events.json.
    const tier = caps[eventId];
    if (!(eventId in caps)) problems.push(`${eventId}: replayed event not in capabilities`);
    else if (!TIERS.includes(tier)) problems.push(`${eventId}: tier ${tier} not in ${TIERS.join("/")}`);
    else {
      const ev = eventById.get(eventId);
      const action = ev && ev.actions && ev.actions[tier];
      if (!action || action.id === "unsupported") problems.push(`${eventId}: tier ${tier} resolves to unsupported/undefined action`);
    }
    replayed++;
  }
  return problems.length === 0
    ? { n, title, status: "pass", detail: `${replayed} event(s) replayed → schema-valid payload + coherent tier↔action` }
    : { n, title, status: "fail", detail: problems.slice(0, 3).join("; ") };
}

function parseAgentManifest(fullText) {
  const lines = fullText.split("\n");
  const sIdx = lines.findIndex((l) => l === AGENT_MANIFEST_SENTINEL);
  if (sIdx === -1) return { error: `missing sentinel ${JSON.stringify(AGENT_MANIFEST_SENTINEL)}` };
  let fs0 = -1;
  for (let i = sIdx + 1; i < lines.length; i++) { if (lines[i].trim() === "```json") { fs0 = i; break; } if (lines[i].startsWith("## ")) break; }
  if (fs0 === -1) return { error: "sentinel not followed by a ```json block" };
  let fe = -1;
  for (let i = fs0 + 1; i < lines.length; i++) { if (lines[i].trim() === "```") { fe = i; break; } }
  if (fe === -1) return { error: "```json fence not closed" };
  try { return { manifest: JSON.parse(lines.slice(fs0 + 1, fe).join("\n")) }; }
  catch (e) { return { error: `JSON parse: ${e.message}` }; }
}

function stepInvocationParity(root, readText, manifest, read_trace) {
  const n = 9, title = "invocation parity (F47) — §9 surface-truth + N1 sandbox isolation";
  const runbookRel = manifest.runbook && manifest.runbook.full;
  if (!runbookRel) return { n, title, status: "fail", detail: "manifest has no runbook.full" };
  let fullText;
  try { fullText = readText(runbookRel); }
  catch (e) { return { n, title, status: "fail", detail: `runbook unreadable: ${e.message}` }; }
  const parsed = parseAgentManifest(fullText);
  if (parsed.error) return { n, title, status: "fail", detail: `§9: ${parsed.error}` };
  const am = parsed.manifest;

  const problems = [];
  if (!Array.isArray(am.dispatch_examples) || am.dispatch_examples.length === 0) problems.push("no dispatch_examples");
  if (!am.expected_outputs || !am.expected_outputs.shape) problems.push("no expected_outputs.shape");
  if (!am.return_codes || Object.keys(am.return_codes).length === 0) problems.push("empty return_codes");

  // surface-truth: every command_shape's referenced script exists + is authority-
  // contained under plugins/<harness> (the core F47 drift catch — §9 must not lie
  // about the invocation surface). {plugin_dir} -> plugins/<harness>.
  const pluginDir = path.join(root, "plugins", manifest.harness);
  const pluginDirReal = fs.realpathSync(pluginDir);
  for (const shape of am.command_shapes || []) {
    for (const tok of shape) {
      if (typeof tok !== "string" || !tok.includes("{plugin_dir}")) continue;
      const rel = tok.replace("{plugin_dir}", "");
      const abs = path.join(pluginDir, rel.replace(/^\/+/, ""));
      let real;
      try { real = fs.realpathSync(abs); } catch { problems.push(`command_shape references a non-existent script: ${tok}`); continue; }
      if (real !== pluginDirReal && !real.startsWith(pluginDirReal + path.sep)) problems.push(`command_shape script escapes plugin authority: ${tok}`);
    }
  }

  // N1 — exercise the documented §9 invocation in an ISOLATED git-init sandbox and
  // prove (non-vacuously) that the gate's root-source is the INPUT cwd, not the
  // process cwd. The proof SHAPE depends on the harness enforcement modality the
  // runbook declares in expected_outputs.shape (S1 parameterization — the two
  // enforcement models differ and a single assertion cannot fit both):
  //   "exit-code-only" — a marker-arming gate (claude-code checkpoint-gate.sh):
  //       a push self-arms a `.checkpoints/.*` marker under the gate's resolved
  //       REPO_ROOT; assert it lands in the sandbox (stdin .cwd) and NONE leaks to
  //       the live --project or the divergent process cwd.
  //   "json-object"   — a stateless stdout-decision bridge (opencode
  //       enforce-bridge.mjs, OD-4): it writes NO marker by design and enforces by
  //       emitting a decision to stdout. Assert the documented dispatch (a
  //       pre_tool_use repo-source WRITE) actually resolves to action:block with an
  //       exit in return_codes, and that NO `.checkpoints/.*` marker is mutated
  //       under the live --project or the divergent process cwd.
  const modality = (am.expected_outputs && am.expected_outputs.shape) || "";
  let passDetail = "";
  if (modality === "exit-code-only") {
    const iso = sandboxDispatch(root, manifest, am);
    read_trace.push(...iso.read_trace);
    if (iso.error) problems.push(`N1 sandbox: ${iso.error}`);
    else {
      // The dispatch must ACTUALLY produce a marker (else the absence-assertions
      // below are vacuous — claude-subagent F1). A push_or_pr_create command
      // self-arms `.post-checkpoint-required` under the gate's resolved REPO_ROOT.
      if (!iso.markerArmedInSandbox) problems.push(`N1: dispatch armed no marker in the sandbox — the isolation assertion would be vacuous (expected push self-arm)`);
      // N1 proper: the marker landed in the sandbox (stdin .cwd), NOT the live repo.
      if (!iso.isolationHeld) problems.push(`N1 isolation breach: a .checkpoints/.* marker appeared under the live --project after dispatch (${iso.liveLeak})`);
      // Root-source proof: process cwd is DIVERGENT from stdin .cwd; a gate that
      // resolved its root from process cwd would have leaked here instead.
      if (!iso.cwdHeld) problems.push(`N1 root-source breach: a marker appeared under the divergent process cwd (${iso.procLeak}) — gate used process cwd, not stdin .cwd`);
      if (iso.exit != null && !(String(iso.exit) in am.return_codes)) problems.push(`dispatched gate exit ${iso.exit} not in §9 return_codes ${JSON.stringify(Object.keys(am.return_codes))}`);
    }
    passDetail = `§9 surface-truth ok; gate self-armed in sandbox (${iso.sandboxMarkers}); live + divergent-process-cwd untouched (N1: root from stdin .cwd)`;
  } else if (modality === "json-object") {
    const iso = bridgeDispatch(root, manifest, am);
    read_trace.push(...iso.read_trace);
    if (iso.error) problems.push(`N1 bridge: ${iso.error}`);
    else {
      // Surface-truth (stdout-decision form): the documented dispatch must emit the
      // documented decision. A repo-source write resolves to action:block (else the
      // §9 dispatch_example lies about the invocation surface).
      if (iso.exit == null || !(String(iso.exit) in am.return_codes)) problems.push(`dispatched bridge exit ${iso.exit} not in §9 return_codes ${JSON.stringify(Object.keys(am.return_codes))}`);
      if (!iso.decision || typeof iso.decision !== "object") problems.push(`N1: bridge stdout did not parse as a json-object decision (expected_outputs.shape=json-object)`);
      else if (iso.decision.action !== "block") problems.push(`N1 surface-truth: documented dispatch (repo-source write) did not resolve to action:block (got ${JSON.stringify(iso.decision.action)})`);
      // Isolation: a stateless bridge mutates NO marker anywhere (live or divergent
      // process cwd). Root-source is independently proven by the bridge's own
      // cwd-divergence unit test (test-enforce-bridge.mjs::testBridgeCwdDivergence).
      if (!iso.isolationHeld) problems.push(`N1 isolation breach: a .checkpoints/.* marker appeared under the live --project after a stateless-bridge dispatch (${iso.liveLeak})`);
      if (!iso.cwdHeld) problems.push(`N1 root-source breach: a .checkpoints/.* marker appeared under the divergent process cwd (${iso.procLeak})`);
    }
    passDetail = `§9 surface-truth ok; stdout-decision bridge emitted action:${iso.decision && iso.decision.action} (exit ${iso.exit}); no marker mutated live or divergent-process-cwd (N1: root from input cwd)`;
  } else {
    problems.push(`unsupported expected_outputs.shape ${JSON.stringify(modality)} — step 9 cannot prove invocation parity`);
  }

  return problems.length === 0
    ? { n, title, status: "pass", detail: passDetail }
    : { n, title, status: "fail", detail: problems.slice(0, 3).join("; ") };
}

// Dispatch the gate hook (first command_shape) in a throwaway git-init sandbox
// and PROVE N1 isolation non-vacuously (claude-subagent F1). Two deliberate
// design points:
//   1. The dispatched command is a marker-PRODUCING one — `git push` classifies
//      push_or_pr_create, which self-arms `.post-checkpoint-required` under the
//      gate's resolved REPO_ROOT regardless of prior state (checkpoint-gate.sh
//      :1558-1610). The earlier `git status` (read_only) exited the gate at
//      :1151 before any marker write, so the absence-assertion was vacuous.
//   2. The process cwd is a SEPARATE throwaway dir, DIVERGENT from stdin `.cwd`.
//      The gate resolves REPO_ROOT from an absolute stdin `.cwd` (:80-110) and
//      only falls back to process cwd when `.cwd` is empty/relative. With the
//      two divergent, a marker in the sandbox proves stdin `.cwd` won; a marker
//      under the process cwd would prove it lost.
// Asserts: marker present in the sandbox; ABSENT under the live --project (N1);
// ABSENT under the divergent process cwd (root-source proof).
function sandboxDispatch(root, manifest, am) {
  const read_trace = [];
  const shape = (am.command_shapes || [])[0];
  if (!Array.isArray(shape) || shape.length === 0) return { error: "no command_shape to dispatch", read_trace };
  const pluginDir = path.join(root, "plugins", manifest.harness);
  const argv = shape.map((tok) => (typeof tok === "string" ? tok.replace("{plugin_dir}", pluginDir) : tok));

  const SID = "00000000-0000-4000-8000-000000000000";
  const snapshot = (base) => { try { return new Set(fs.readdirSync(path.join(base, ".checkpoints"))); } catch { return new Set(); } };
  const newMarkers = (base, before) => [...snapshot(base)].filter((f) => !before.has(f));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tp-gauntlet-sbx-"));
  const procCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tp-gauntlet-cwd-")); // divergent process cwd
  const liveBefore = snapshot(root);
  const procBefore = snapshot(procCwd);

  let exit = null, err = null, sandboxMarkers = [];
  try {
    execFileSync("git", ["init", "-q"], { cwd: sandbox });
    const sandboxBefore = snapshot(sandbox); // fresh git-init → no .checkpoints yet
    const stdin = JSON.stringify({
      session_id: SID,
      cwd: fs.realpathSync(sandbox), // ABSOLUTE sandbox root — gate's authoritative root (:80-110)
      tool_name: "Bash",
      tool_input: { command: "git push" }, // push_or_pr_create — self-arms a REAL marker
      transcript: [],
    });
    try {
      execFileSync(argv[0], argv.slice(1), {
        cwd: procCwd, // DIVERGENT from stdin .cwd: a gate reading process cwd would leak HERE, not the sandbox
        input: stdin,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: SID },
        stdio: ["pipe", "ignore", "ignore"],
      });
      exit = 0;
    } catch (e) { exit = typeof e.status === "number" ? e.status : null; if (exit == null) err = e.message; }
    sandboxMarkers = newMarkers(sandbox, sandboxBefore); // snapshot BEFORE the finally rm
  } catch (e) { err = `sandbox setup failed: ${e.message}`; }
  finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(procCwd, { recursive: true, force: true }); } catch {}
  }

  const liveLeak = newMarkers(root, liveBefore);
  const procLeak = newMarkers(procCwd, procBefore);
  return {
    exit, error: err, read_trace,
    markerArmedInSandbox: sandboxMarkers.length > 0,
    sandboxMarkers: sandboxMarkers.join(","),
    isolationHeld: liveLeak.length === 0, // N1: no marker under the live --project
    liveLeak: liveLeak.join(","),
    cwdHeld: procLeak.length === 0, //       gate used stdin .cwd, not the divergent process cwd
    procLeak: procLeak.join(","),
  };
}

// Dispatch a stateless stdout-decision bridge (opencode enforce-bridge.mjs, OD-4)
// in a throwaway git-init sandbox and PROVE the json-object invocation surface is
// truthful + isolated. Two deliberate design points mirror sandboxDispatch:
//   1. The dispatch is the DOCUMENTED one — a pre_tool_use repo-source WRITE, which
//      the bridge resolves to {action:"block"} on stdout (§9 dispatch_example). The
//      sandbox holds a real src/ file so the L1 repo-source check is non-vacuous.
//   2. The process cwd is a SEPARATE throwaway dir, DIVERGENT from the bridge's
//      input cwd (normalized.cwd). The bridge resolves repo root from normalized.cwd
//      ONLY (enforce-bridge.mjs:94-104), never process.cwd().
// Asserts (in stepInvocationParity): decision.action === "block"; exit in
// return_codes; NO `.checkpoints/.*` marker mutated under the live --project or the
// divergent process cwd (a stateless bridge writes none).
function bridgeDispatch(root, manifest, am) {
  const read_trace = [];
  const shape = (am.command_shapes || [])[0];
  if (!Array.isArray(shape) || shape.length === 0) return { error: "no command_shape to dispatch", read_trace };
  const pluginDir = path.join(root, "plugins", manifest.harness);
  const argv = shape.map((tok) => (typeof tok === "string" ? tok.replace("{plugin_dir}", pluginDir) : tok));

  const SID = "00000000-0000-4000-8000-000000000000";
  const snapshot = (base) => { try { return new Set(fs.readdirSync(path.join(base, ".checkpoints"))); } catch { return new Set(); } };
  const newMarkers = (base, before) => [...snapshot(base)].filter((f) => !before.has(f));

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tp-bridge-sbx-"));
  const procCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tp-bridge-cwd-")); // divergent process cwd
  const liveBefore = snapshot(root);
  const procBefore = snapshot(procCwd);

  let exit = null, err = null, decision = null;
  try {
    execFileSync("git", ["init", "-q"], { cwd: sandbox });
    const sandboxRoot = fs.realpathSync(sandbox); // ABSOLUTE input cwd — bridge's authoritative root
    fs.mkdirSync(path.join(sandboxRoot, "src"), { recursive: true });
    const target = path.join(sandboxRoot, "src", "SENTINEL.mjs");
    fs.writeFileSync(target, "// sentinel\n");
    const stdin = JSON.stringify({
      harness: manifest.harness,
      event: "pre_tool_use",
      normalized: {
        tool: "write",
        tool_args: { filePath: target, content: "x" }, // repo-source write → action:block
        cwd: sandboxRoot,
        session_id: SID,
        turn_index: 1,
        timestamp_iso8601: "2026-01-01T00:00:00Z",
      },
    });
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: procCwd, // DIVERGENT from input cwd: a bridge reading process cwd resolves HERE
      input: stdin,
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env },
    });
    exit = typeof r.status === "number" ? r.status : null;
    try { if (r.stdout) decision = JSON.parse(r.stdout.trim()); } catch { /* decision stays null */ }
    if (exit == null && r.error) err = r.error.message;
  } catch (e) { err = `bridge setup failed: ${e.message}`; }
  finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(procCwd, { recursive: true, force: true }); } catch {}
  }

  const liveLeak = newMarkers(root, liveBefore);
  const procLeak = newMarkers(procCwd, procBefore);
  return {
    exit, error: err, read_trace, decision,
    isolationHeld: liveLeak.length === 0, // N1: no marker under the live --project
    liveLeak: liveLeak.join(","),
    cwdHeld: procLeak.length === 0, //       bridge used input cwd, not divergent process cwd
    procLeak: procLeak.join(","),
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { project: null, harness: "claude-code", json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--harness") args.harness = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  return args;
}

const HELP = `test-plugin.mjs — 9-step plugin conformance gauntlet (RFC-008 P1c)

  --project <abs>   repo root (canonicalized; else git rev-parse --show-toplevel)
  --json            machine-readable output

Exit: 0 no failing step (deferred-P3 allowed), 1 a step failed, 2 usage/IO.`;

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(e.message + "\n"); process.exit(2); }
  if (args.help) { process.stdout.write(HELP + "\n"); process.exit(0); }

  let result;
  try { result = runGauntlet({ projectRoot: args.project, harness: args.harness }); }
  catch (e) {
    process.stdout.write(JSON.stringify({ status: "usage_error", project_root: null, summary: { pass: 0, deferred: 0, fail: 0 }, steps: [], read_trace: [], violations: [{ detail: e.message }] }) + "\n");
    process.exit(2);
  }

  const { exit, ...payload } = result;
  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    const sym = { pass: "✓", "deferred-P3": "⏸", fail: "✗" };
    for (const s of payload.steps) process.stdout.write(`  ${sym[s.status] || "?"} step ${s.n} [${s.status}] ${s.title}\n      ${s.detail}\n`);
    const { pass, deferred, fail } = payload.summary;
    process.stdout.write(`\ntest-plugin gauntlet: ${pass} pass, ${deferred} deferred-P3, ${fail} fail — ${payload.status.toUpperCase()}\n`);
  }
  process.exit(exit);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
