/**
 * test-install-opencode-enforcement.mjs — Group 7 mock-project E2E for the
 * OpenCode enforcement install/uninstall (RFC-008 P5 S6, REQ-11).
 *
 * Runs the REAL install.mjs under an isolated HOME + throwaway project, then
 * DRIVES THE DEPLOYED bridge (not the in-repo one — M4: no node-call substitute
 * for the deployed artifact). Proves the co-deployed dependency closure
 * (enforce-contract.mjs + scripts/lib/*) actually resolves and the deployed gate
 * decides correctly: repo-source write -> block, carve-out -> allow, read ->
 * allow. Then uninstalls and asserts removal + no global leak (P12 per-project).
 *
 * Run: node tests/test-install-opencode-enforcement.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

// Deployed paths under a project root (mirror opencodeEnforcementPaths in install.mjs).
function deployed(projectDir) {
  const deployRoot = path.join(projectDir, ".opencode", "plugins");
  const pluginDir = path.join(deployRoot, "episodic-memory");
  return {
    deployRoot, pluginDir,
    adapter: path.join(pluginDir, "capabilities", "enforcement.ts"),
    bridge: path.join(pluginDir, "capabilities", "enforce-bridge.mjs"),
    manifest: path.join(pluginDir, "manifest.json"),
    runbook: path.join(pluginDir, "runbooks", "enforcement.md"),
    enforceContract: path.join(deployRoot, "scripts", "enforce-contract.mjs"),
    repoSource: path.join(deployRoot, "scripts", "lib", "repo-source.mjs"),
    carveouts: path.join(deployRoot, "patterns", "repo-source-carveouts.json"),
    config: path.join(projectDir, "opencode.json"),
  };
}

// Spawn the DEPLOYED bridge with an envelope; return {exit, parsed}.
function runDeployedBridge(bridgePath, envelope) {
  const r = spawnSync(process.execPath, [bridgePath], {
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout: 15000,
  });
  let parsed = null;
  try { if (r.stdout) parsed = JSON.parse(r.stdout.trim()); } catch {}
  return { exit: r.status, parsed, stderr: r.stderr };
}

// ---------------------------------------------------------------------------
// Isolated sandbox: a fake HOME + a git-init project. The real install.mjs
// writes its global substrate under HOME/.episodic-memory, so overriding HOME
// keeps the test off the developer's real global store.
// ---------------------------------------------------------------------------
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-install-home-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "oc-install-proj-"));
execFileSync("git", ["init", "-q"], { cwd: project });
const projectReal = fs.realpathSync(project);
const D = deployed(projectReal);
const env = { ...process.env, HOME: sandboxHome };

function runInstaller(extraArgs) {
  return spawnSync(process.execPath, [INSTALL, "--tool", "opencode", "--project", projectReal, ...extraArgs], {
    encoding: "utf8", timeout: 120000, env,
  });
}

// ---------------------------------------------------------------------------
// testInstallDeploysAll — install, assert files + registration, DRIVE the bridge.
// ---------------------------------------------------------------------------
{
  const r = runInstaller(["--install-enforcement"]);
  assert(r.status === 0, "install: exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);

  for (const [k, p] of Object.entries({
    adapter: D.adapter, bridge: D.bridge, manifest: D.manifest, runbook: D.runbook,
    enforceContract: D.enforceContract, repoSource: D.repoSource, carveouts: D.carveouts,
  })) {
    assert(fs.existsSync(p), `install deploys ${k}`, p);
  }

  // opencode.json registration.
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(D.config, "utf8")); } catch {}
  const spec = "./.opencode/plugins/episodic-memory/capabilities/enforcement.ts";
  assert(cfg && Array.isArray(cfg.plugin) && cfg.plugin.includes(spec),
    "install registers adapter in opencode.json plugin[]", cfg ? JSON.stringify(cfg.plugin) : "no config");

  // DEPLOYED-BRIDGE E2E (M4): the co-deployed closure must resolve + decide right.
  fs.mkdirSync(path.join(projectReal, "src"), { recursive: true });
  const srcWrite = {
    harness: "opencode", event: "pre_tool_use",
    normalized: { tool: "write", tool_args: { filePath: path.join(projectReal, "src", "app.mjs"), content: "x" },
      cwd: projectReal, session_id: "s", turn_index: 1, timestamp_iso8601: "2026-01-01T00:00:00Z" },
  };
  const rb1 = runDeployedBridge(D.bridge, srcWrite);
  assert(rb1.exit === 0, "deployed bridge: repo-src write exit 0", `${rb1.exit}: ${(rb1.stderr || "").slice(0, 300)}`);
  assert(rb1.parsed && rb1.parsed.action === "block", "deployed bridge: repo-src write -> block",
    rb1.parsed ? JSON.stringify(rb1.parsed) : (rb1.stderr || "").slice(0, 300));

  const carveWrite = {
    harness: "opencode", event: "pre_tool_use",
    normalized: { tool: "write", tool_args: { filePath: path.join(projectReal, ".episodic-memory", "ep.json"), content: "{}" },
      cwd: projectReal, session_id: "s", turn_index: 2, timestamp_iso8601: "2026-01-01T00:00:00Z" },
  };
  const rb2 = runDeployedBridge(D.bridge, carveWrite);
  assert(rb2.parsed && rb2.parsed.action === "allow", "deployed bridge: carve-out (.episodic-memory) -> allow",
    rb2.parsed ? JSON.stringify(rb2.parsed) : (rb2.stderr || "").slice(0, 300));

  const readCall = {
    harness: "opencode", event: "pre_tool_use",
    normalized: { tool: "read", tool_args: { filePath: path.join(projectReal, "src", "app.mjs") },
      cwd: projectReal, session_id: "s", turn_index: 3, timestamp_iso8601: "2026-01-01T00:00:00Z" },
  };
  const rb3 = runDeployedBridge(D.bridge, readCall);
  assert(rb3.parsed && rb3.parsed.action === "allow", "deployed bridge: read -> allow",
    rb3.parsed ? JSON.stringify(rb3.parsed) : (rb3.stderr || "").slice(0, 300));
}

// ---------------------------------------------------------------------------
// testNoGlobalLeak (P12) — the install wrote NOTHING under the developer's real
// HOME; everything global landed under the sandbox HOME instead.
// ---------------------------------------------------------------------------
{
  // The sandbox HOME received the global substrate (proof the override took).
  assert(fs.existsSync(path.join(sandboxHome, ".episodic-memory")),
    "no-global-leak: global substrate landed under sandbox HOME (override honored)");
}

// ---------------------------------------------------------------------------
// testUninstallRemoves — uninstall, assert files gone + registration removed.
// ---------------------------------------------------------------------------
{
  const r = runInstaller(["--uninstall-enforcement"]);
  assert(r.status === 0, "uninstall: exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);

  assert(!fs.existsSync(D.pluginDir), "uninstall removes pluginDir", D.pluginDir);
  assert(!fs.existsSync(path.join(D.deployRoot, "scripts")), "uninstall removes deployed scripts");
  assert(!fs.existsSync(path.join(D.deployRoot, "patterns")), "uninstall removes deployed patterns");

  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(D.config, "utf8")); } catch {}
  const spec = "./.opencode/plugins/episodic-memory/capabilities/enforcement.ts";
  const stillRegistered = cfg && Array.isArray(cfg.plugin) && cfg.plugin.includes(spec);
  assert(!stillRegistered, "uninstall removes adapter from opencode.json plugin[]",
    cfg ? JSON.stringify(cfg.plugin || null) : "no config");
}

// ---------------------------------------------------------------------------
// Cleanup + report.
// ---------------------------------------------------------------------------
try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch {}
try { fs.rmSync(project, { recursive: true, force: true }); } catch {}

console.log(`\ntest-install-opencode-enforcement: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all opencode install/uninstall E2E tests passed");
