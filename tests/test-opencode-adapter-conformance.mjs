/**
 * test-opencode-adapter-conformance.mjs — RFC-008 P5 (PR-level review BLOCKER-1/2 fix).
 *
 * The sibling test-opencode-adapter.mjs drives enforce-bridge.mjs directly; it
 * never loads enforcement.ts, so a broken adapter hook surface passed every
 * green suite. This test closes that gap: it LOADS the deployed adapter module
 * and asserts it conforms to the INSTALLED @opencode-ai/plugin `interface Hooks`
 * (dist/index.d.ts) — flat dotted hook keys, two-arg (input, output) calling
 * convention — and that its STRONG `tool.execute.before` hook actually throws on
 * a gated repo-source write (block) and returns on a carve-out (allow).
 *
 * BLOCKER-1 regression guard: the host indexes hooks by flat keys
 * (hooks["tool.execute.before"]). A nested {tool:{execute:{before}}} object —
 * the original bug — leaves that key undefined and the blocking hook never
 * fires (fails OPEN). This test fails RED on the nested shape.
 *
 * Adapter is TypeScript; loading it needs a type-stripping runtime (Node >=22.6
 * with --experimental-strip-types, default-on >=23.6). If the runtime cannot
 * strip types we FAIL LOUDLY rather than skip — an un-runnable conformance test
 * is the BLOCKER-2 gap, not an acceptable pass. CI pins this job to Node 24.
 *
 * Run: node tests/test-opencode-adapter-conformance.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
const INSTALL = path.join(REPO, "install.mjs");

let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

// --- Isolated install (mirror test-install-opencode-enforcement.mjs) ---------
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-conf-home-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "oc-conf-proj-"));
execFileSync("git", ["init", "-q"], { cwd: project });
const projectReal = fs.realpathSync(project);
const env = { ...process.env, HOME: sandboxHome };

const installRes = spawnSync(
  process.execPath,
  [INSTALL, "--tool", "opencode", "--project", projectReal, "--install-enforcement"],
  { encoding: "utf8", timeout: 120000, env },
);
assert(installRes.status === 0, "install: exit 0", `${installRes.status}: ${(installRes.stderr || "").slice(0, 300)}`);

const deployedAdapter = path.join(
  projectReal, ".opencode", "plugins", "episodic-memory", "capabilities", "enforcement.ts",
);
assert(fs.existsSync(deployedAdapter), "deployed adapter exists", deployedAdapter);

// --- Load the deployed adapter as a module (TS type-stripping required) -------
let mod = null;
let loadErr = null;
try {
  mod = await import(pathToFileURL(deployedAdapter).href);
} catch (e) {
  loadErr = e;
}
assert(
  mod !== null,
  "deployed adapter loads as a module (TS strip)",
  loadErr
    ? `import failed (${loadErr.code || ""}): ${String(loadErr.message).slice(0, 200)} — needs Node >=23.6 or --experimental-strip-types; CI pins Node 24`
    : "",
);

// Everything below depends on a loaded module + a callable plugin factory.
if (mod && typeof mod.EpisodicEnforcement === "function") {
  assert(true, "exports EpisodicEnforcement as a function");

  const hooks = await mod.EpisodicEnforcement({ directory: projectReal });
  assert(hooks && typeof hooks === "object", "plugin factory returns a hooks object");

  // --- BLOCKER-1 regression: flat dotted keys present, nested shape absent ----
  assert(typeof hooks["tool.execute.before"] === "function",
    'hooks["tool.execute.before"] is a function (flat key)');
  assert(typeof hooks["tool.execute.after"] === "function",
    'hooks["tool.execute.after"] is a function (flat key)');
  assert(typeof hooks["experimental.chat.system.transform"] === "function",
    'hooks["experimental.chat.system.transform"] is a function (flat key)');
  assert(typeof hooks.event === "function", "hooks.event is a function");

  // The original bug: a nested tool.execute.before. `hooks.tool`, if present, is
  // the ToolDefinition map per the Hooks interface — it must NOT carry an
  // execute.before hook (that would mean the adapter regressed to nesting).
  const nestedRegressed = !!(hooks.tool && hooks.tool.execute && typeof hooks.tool.execute.before === "function");
  assert(!nestedRegressed, "no nested tool.execute.before (BLOCKER-1 regression guard)");

  // --- before-hook actually BLOCKS a gated repo-source write (throws) ---------
  fs.mkdirSync(path.join(projectReal, "src"), { recursive: true });
  let threw = false, throwMsg = "";
  try {
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "s1", callID: "c1" },
      { args: { filePath: path.join(projectReal, "src", "app.mjs"), content: "x" } },
    );
  } catch (e) { threw = true; throwMsg = String(e.message || e); }
  assert(threw, "before-hook THROWS on gated repo-source write (STRONG block)", throwMsg ? "" : "did not throw");

  // --- before-hook ALLOWS a carve-out write (no throw) ------------------------
  let carveThrew = false, carveMsg = "";
  try {
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: "s1", callID: "c2" },
      { args: { filePath: path.join(projectReal, ".episodic-memory", "ep.json"), content: "{}" } },
    );
  } catch (e) { carveThrew = true; carveMsg = String(e.message || e); }
  assert(!carveThrew, "before-hook does NOT throw on carve-out (.episodic-memory) write", carveMsg);

  // --- before-hook ALLOWS a read (no throw) -----------------------------------
  let readThrew = false, readMsg = "";
  try {
    await hooks["tool.execute.before"](
      { tool: "read", sessionID: "s1", callID: "c3" },
      { args: { filePath: path.join(projectReal, "src", "app.mjs") } },
    );
  } catch (e) { readThrew = true; readMsg = String(e.message || e); }
  assert(!readThrew, "before-hook does NOT throw on read tool", readMsg);

  // --- observe hooks never throw ----------------------------------------------
  let observeThrew = false;
  try {
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: "s1", callID: "c4", args: { filePath: path.join(projectReal, "src", "app.mjs") } },
      { title: "t", output: "done", metadata: {} },
    );
    await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  } catch { observeThrew = true; }
  assert(!observeThrew, "observe hooks (tool_result, stop) never throw");
} else {
  assert(false, "exports EpisodicEnforcement as a function",
    mod ? `got ${typeof (mod && mod.EpisodicEnforcement)}` : "module did not load");
}

// --- cleanup -----------------------------------------------------------------
try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
try { fs.rmSync(project, { recursive: true, force: true }); } catch {}

// --- report ------------------------------------------------------------------
console.log(`\ntest-opencode-adapter-conformance: ${pass} pass / ${fail} fail`);
if (fail > 0) {
  console.error("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
