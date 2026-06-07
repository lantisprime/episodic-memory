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
import { execFileSync } from "node:child_process";
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
export function runGauntlet({ projectRoot, now = NOW, cwd = process.cwd() } = {}) {
  const read_trace = [];
  const root = resolveRoot(projectRoot, cwd);
  const readJson = (rel) => { const abs = path.join(root, rel); const t = fs.readFileSync(abs, "utf8"); read_trace.push(abs); return JSON.parse(t); };
  const readText = (rel) => { const abs = path.join(root, rel); const t = fs.readFileSync(abs, "utf8"); read_trace.push(abs); return t; };

  const steps = [];
  const step = (n, title, status, detail) => steps.push({ n, title, status, detail });

  // Resolve the claude-code enforcement entry from the registry.
  const index = readJson("plugins/_index.json");
  const entry = (index.plugins || []).find((p) => p.type === "enforcement" && p.id === "claude-code");
  if (!entry) throw new UsageError("no enforcement entry 'claude-code' in plugins/_index.json");
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
  steps.push(stepEventReplay(root, readJson, readText, manifest, events, now, read_trace));

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

function stepEventReplay(root, readJson, readText, manifest, events, now, read_trace) {
  const n = 8, title = "event replay (F39) — field_bindings → canonical payload";
  const trans = manifest.event_translations || {};
  const caps = manifest.capabilities || {};
  const eventById = new Map((events.events || []).map((e) => [e.id, e]));
  const problems = [];
  let replayed = 0;
  for (const [eventId, t] of Object.entries(trans)) {
    const dash = eventId.replace(/_/g, "-");
    let raw, schema;
    try { raw = readJson(`tests/fixtures/harness-events/claude-code/${dash}.json`); }
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

  // N1 — exercise the gate dispatch in an ISOLATED tmpdir+git-init sandbox with
  // hook stdin `.cwd` = absolute sandbox root, and assert NO new `.checkpoints/.*`
  // marker appears under the live --project root (the gate resolves its root from
  // stdin .cwd, not process cwd/env, so markers land in the sandbox by construction).
  const iso = sandboxDispatch(root, manifest, am);
  read_trace.push(...iso.read_trace);
  if (iso.error) problems.push(`N1 sandbox: ${iso.error}`);
  else {
    if (!iso.isolationHeld) problems.push(`N1 isolation breach: a .checkpoints/.* marker appeared under the live --project after dispatch (${iso.leaked})`);
    if (iso.exit != null && !(String(iso.exit) in am.return_codes)) problems.push(`dispatched gate exit ${iso.exit} not in §9 return_codes ${JSON.stringify(Object.keys(am.return_codes))}`);
  }

  return problems.length === 0
    ? { n, title, status: "pass", detail: `§9 surface-truth ok; sandbox dispatch exit ${iso.exit} ∈ return_codes; live markers untouched (N1)` }
    : { n, title, status: "fail", detail: problems.slice(0, 3).join("; ") };
}

// Dispatch the first command_shape (gate hook) in a throwaway git-init sandbox
// with hook stdin `.cwd` = sandbox root. Returns the captured exit + whether the
// live --project's .checkpoints set was left unchanged (N1 absence-assertion).
function sandboxDispatch(root, manifest, am) {
  const read_trace = [];
  const shape = (am.command_shapes || [])[0];
  if (!Array.isArray(shape) || shape.length === 0) return { error: "no command_shape to dispatch", read_trace };
  const pluginDir = path.join(root, "plugins", manifest.harness);
  const argv = shape.map((tok) => (typeof tok === "string" ? tok.replace("{plugin_dir}", pluginDir) : tok));

  const liveCheckpoints = path.join(root, ".checkpoints");
  const snapshot = () => { try { return new Set(fs.readdirSync(liveCheckpoints)); } catch { return new Set(); } };
  const before = snapshot();

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tp-gauntlet-"));
  let exit = null, err = null;
  try {
    execFileSync("git", ["init", "-q"], { cwd: sandbox });
    const stdin = JSON.stringify({
      session_id: "00000000-0000-4000-8000-000000000000",
      cwd: fs.realpathSync(sandbox), // ABSOLUTE sandbox root (N1: gate reads root from stdin .cwd)
      tool_name: "Bash",
      tool_input: { command: "git status" }, // read_only — a no-op for the gate
      transcript: [],
    });
    try {
      execFileSync(argv[0], argv.slice(1), {
        cwd: sandbox, // belt-and-suspenders for the empty/relative .cwd fallback
        input: stdin,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-000000000000" },
        stdio: ["pipe", "ignore", "ignore"],
      });
      exit = 0;
    } catch (e) { exit = typeof e.status === "number" ? e.status : null; if (exit == null) err = e.message; }
  } catch (e) { err = `sandbox setup failed: ${e.message}`; }
  finally { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} }

  const after = snapshot();
  const leaked = [...after].filter((f) => !before.has(f));
  return { exit, error: err, isolationHeld: leaked.length === 0, leaked: leaked.join(","), read_trace };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { project: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
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
  try { result = runGauntlet({ projectRoot: args.project }); }
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

if (import.meta.url === `file://${process.argv[1]}`) main();
