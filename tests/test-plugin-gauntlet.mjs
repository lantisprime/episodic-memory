// test-plugin-gauntlet.mjs — RFC-008 R0c P1c C3. Locks the 9-step gauntlet's live
// outcome + the H2 invariant: `deferred-P3` is NEVER counted as pass (green-with-
// a-documented-gap, not green-meaning-complete). Run: node tests/test-plugin-gauntlet.mjs
//
// The step-8 (field_bindings replay) + step-9 (§9 surface-truth + N1 sandbox
// isolation) logic is the net-new gauntlet code; steps 1-3/7 reuse the static
// validator (covered by test-plugin-registry.mjs) and step 4 reuses the golden
// fixture. Step 9 dispatches the REAL gate hook in a tmpdir sandbox and asserts
// no marker leaks to the live repo (N1).

import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runGauntlet } from "../scripts/test-plugin.mjs";

const REPO = fs.realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
let pass = 0, fail = 0;
const failures = [];
const assert = (c, n, d) => (c ? pass++ : (fail++, failures.push(`${n}${d ? " — " + d : ""}`)));

const r = runGauntlet({ projectRoot: REPO });

assert(r.status === "ok", "live gauntlet status ok", JSON.stringify(r.steps.filter((s) => s.status === "fail")));
assert(r.steps.length === 9, "gauntlet has 9 steps", String(r.steps.length));
assert(r.summary.pass === 7 && r.summary.deferred === 2 && r.summary.fail === 0, "summary 7 pass / 2 deferred / 0 fail", JSON.stringify(r.summary));
assert(r.summary.pass + r.summary.deferred + r.summary.fail === 9, "summary accounts for every step");
assert(r.exit === 0, "exit 0 (no failing step)", String(r.exit));

// H2 — steps 5/6 are deferred-P3 (NOT pass); deferred is never folded into pass.
const s5 = r.steps.find((s) => s.n === 5), s6 = r.steps.find((s) => s.n === 6);
assert(s5.status === "deferred-P3", "step 5 is deferred-P3 (not pass)", s5.status);
assert(s6.status === "deferred-P3", "step 6 is deferred-P3 (not pass)", s6.status);
assert(r.summary.pass === r.steps.filter((s) => s.status === "pass").length, "pass count == #steps with status==pass (deferred excluded — H2)");
assert(r.summary.deferred === r.steps.filter((s) => s.status === "deferred-P3").length, "deferred count == #steps with status==deferred-P3");

// the net-new orchestration steps pass.
assert(r.steps.find((s) => s.n === 8).status === "pass", "step 8 (event replay F39) passes");
const s9 = r.steps.find((s) => s.n === 9);
assert(s9.status === "pass", "step 9 (invocation parity F47 + N1 isolation) passes");
// F1 non-vacuity lock (claude-subagent review): step 9 must ACTUALLY arm a
// marker in the sandbox — a regression to a read_only no-op dispatch (which
// produced no marker, making the absence-assertion vacuous) would drop this.
assert(/self-armed in sandbox/.test(s9.detail), "step 9 N1 is non-vacuous: gate self-armed a real marker in the sandbox", s9.detail);

// read_trace stays under the project root.
assert(r.read_trace.every((p) => p === REPO || p.startsWith(REPO + "/")), "every read_trace entry under the project root");

// usage: a non-resolving --project throws (the exit-2 usage path).
let threw = false;
try { runGauntlet({ projectRoot: "/nonexistent-xyz-123-tp" }); } catch { threw = true; }
assert(threw, "non-resolving --project throws (usage-error path)");

// testHarnessDefault — default (no harness arg) resolves claude-code entry + claude-code/ fixture path.
const rDefault = runGauntlet({ projectRoot: REPO });
assert(rDefault.read_trace.some((p) => p.includes("plugins/claude-code/manifest.json")), "testHarnessDefault: read_trace includes plugins/claude-code/manifest.json");
assert(rDefault.read_trace.some((p) => p.includes("harness-events/claude-code/")), "testHarnessDefault: read_trace includes harness-events/claude-code/ fixture path");

// testHarnessUnknownThrows — harness:"zzz" throws with zzz in the error message.
let harnessThrew = false, harnessErrMsg = "";
try { runGauntlet({ projectRoot: REPO, harness: "zzz" }); } catch (e) { harnessThrew = true; harnessErrMsg = e.message || ""; }
assert(harnessThrew, "testHarnessUnknownThrows: harness:zzz throws");
assert(/zzz/.test(harnessErrMsg), "testHarnessUnknownThrows: error message contains harness name 'zzz'", harnessErrMsg);

// testHarnessOpencode — opencode fixture-dir is parameterized (S1) + opencode plugin
// shipped (S2). Steps 1,2,4,7,8 pass; steps 3+9 require the runbook (S3).
const rOC = runGauntlet({ projectRoot: REPO, harness: "opencode" });
assert(rOC.read_trace.some((p) => p.includes("plugins/opencode/manifest.json")), "testHarnessOpencode: read_trace includes plugins/opencode/manifest.json");
assert(rOC.read_trace.some((p) => p.includes("harness-events/opencode/")), "testHarnessOpencode: read_trace includes harness-events/opencode/ fixture path");
// Steps that must pass in S2 (1,2,4,7,8); 3+9 are expected to fail until S3.
const ocPassRequired = [1, 2, 4, 7, 8];
for (const n of ocPassRequired) {
  const s = rOC.steps.find((st) => st.n === n);
  assert(s && s.status === "pass", `testHarnessOpencode: step ${n} passes`, s ? s.detail : "step not found");
}

// testHarnessPiAgent — pi-agent fixture-dir parameterized + plugin shipped (P7). Pi has a
// runbook (S4) + a harness-event fixture + an in-process-decision §9 dispatch (S5.6), so ALL
// non-deferred steps (1,2,3,4,7,8,9) pass; steps 5+6 are the universal P3 deferrals.
const rPi = runGauntlet({ projectRoot: REPO, harness: "pi-agent" });
assert(rPi.read_trace.some((p) => p.includes("plugins/pi-agent/manifest.json")), "testHarnessPiAgent: read_trace includes plugins/pi-agent/manifest.json");
assert(rPi.read_trace.some((p) => p.includes("harness-events/pi-agent/")), "testHarnessPiAgent: read_trace includes harness-events/pi-agent/ fixture path");
assert(rPi.summary.pass === 7 && rPi.summary.deferred === 2 && rPi.summary.fail === 0, "testHarnessPiAgent: summary 7 pass / 2 deferred / 0 fail", JSON.stringify(rPi.summary));
assert(rPi.exit === 0, "testHarnessPiAgent: exit 0 (no failing step)", String(rPi.exit));
for (const n of [1, 2, 3, 4, 7, 8, 9]) {
  const s = rPi.steps.find((st) => st.n === n);
  assert(s && s.status === "pass", `testHarnessPiAgent: step ${n} passes`, s ? s.detail : "step not found");
}
// step 9 must ACTUALLY exercise the in-process handler (deny+allow), not a vacuous pass.
const sPi9 = rPi.steps.find((s) => s.n === 9);
assert(/in-process handler deny\(exit 1\).*allow\(exit 0\)/.test(sPi9.detail), "testHarnessPiAgent: step 9 drove the in-process handler (deny exit 1 + allow exit 0)", sPi9.detail);

// testHarnessPiAgentHermeticHome (codex PR #437 review, MEDIUM) — the pi gauntlet's step-9
// in-process dispatch must be HERMETIC against a poison ambient $HOME/.episodic-memory
// contract. Pre-fix, piAgentDispatch spawned the child with inherited HOME, so a global
// events.json mapping STRONG pre_tool_use -> warn made step 9 pass a deny with exit 0
// (repo-source write NOT blocked). The fix gives the child a fresh empty HOME. This plants
// exactly that poison, runs the gauntlet under it, and asserts step 9 STILL blocks (exit 1).
{
  const poisonHome = fs.mkdtempSync(join(os.tmpdir(), "pi-poison-home-"));
  const pat = join(poisonHome, ".episodic-memory", "patterns");
  const plug = join(poisonHome, ".episodic-memory", "plugins");
  fs.mkdirSync(pat, { recursive: true });
  fs.mkdirSync(plug, { recursive: true });
  for (const f of ["bp-001.json", "enforce-config.schema.json"]) fs.copyFileSync(join(REPO, "patterns", f), join(pat, f));
  // downgrade pre_tool_use STRONG block -> warn in the POISON global events.json.
  const poisonEvents = fs.readFileSync(join(REPO, "patterns", "events.json"), "utf8").replace('"STRONG": { "id": "block"', '"STRONG": { "id": "warn"');
  fs.writeFileSync(join(pat, "events.json"), poisonEvents);
  fs.copyFileSync(join(REPO, "plugins", "_index.json"), join(plug, "_index.json"));
  const savedHome = process.env.HOME, savedUP = process.env.USERPROFILE;
  process.env.HOME = poisonHome; process.env.USERPROFILE = poisonHome;
  let rH;
  try { rH = runGauntlet({ projectRoot: REPO, harness: "pi-agent" }); }
  finally {
    process.env.HOME = savedHome;
    if (savedUP === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUP;
    try { fs.rmSync(poisonHome, { recursive: true, force: true }); } catch {}
  }
  assert(rH.summary.pass === 7 && rH.summary.fail === 0, "testHarnessPiAgentHermeticHome: gauntlet green under a poison $HOME (child uses a fresh HOME)", JSON.stringify(rH.summary));
  const sH9 = rH.steps.find((s) => s.n === 9);
  assert(sH9 && sH9.status === "pass" && /deny\(exit 1\)/.test(sH9.detail), "testHarnessPiAgentHermeticHome: step 9 still BLOCKS (deny exit 1) despite the poison STRONG->warn global", sH9 ? sH9.detail : "no step 9");
}

console.log(`\ntest-plugin-gauntlet: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ gauntlet outcome + H2 (deferred-P3 ≠ pass) invariant verified");
