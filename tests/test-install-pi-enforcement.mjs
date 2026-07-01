/**
 * test-install-pi-enforcement.mjs — mock-project E2E for the Pi enforcement
 * install/uninstall (RFC-008 P7 S5). Runs the REAL install.mjs under an isolated
 * HOME + throwaway git project, then drives the DEPLOYED extension IN-PROCESS
 * (Pi loads it in-process; there is no stdin/exit hook). Proves per-project deploy
 * under <proj>/.pi/extensions/episodic-memory/, NO ~/.pi write, contained
 * uninstall, and the two P12 closure proofs (contract-root + carveout resolution
 * both stay project-local against a poison global).
 *
 * Run: node tests/test-install-pi-enforcement.mjs
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
  if (cond) { pass++; } else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

// Mirror piAgentEnforcementPaths in install.mjs.
function deployed(projectDir) {
  const piDir = path.join(projectDir, ".pi");
  const extensionsDir = path.join(piDir, "extensions");
  const pluginDir = path.join(extensionsDir, "episodic-memory");
  const scriptsDir = path.join(pluginDir, "scripts");
  return {
    piDir, extensionsDir, pluginDir, scriptsDir,
    index: path.join(pluginDir, "index.js"),
    manifest: path.join(pluginDir, "manifest.json"),
    enforceContract: path.join(scriptsDir, "enforce-contract.mjs"),
    repoSource: path.join(scriptsDir, "lib", "repo-source.mjs"),
    carveouts: path.join(pluginDir, "patterns", "repo-source-carveouts.json"),
    registryIndex: path.join(scriptsDir, "plugins", "_index.json"),
    bp001: path.join(scriptsDir, "patterns", "bp-001.json"),
    events: path.join(scriptsDir, "patterns", "events.json"),
    schema: path.join(scriptsDir, "patterns", "enforce-config.schema.json"),
    enforceConfig: path.join(projectDir, ".episodic-memory", "enforce-config.json"),
  };
}

function freshSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: proj });
  const projReal = fs.realpathSync(proj);
  return {
    home, proj, projReal, D: deployed(projReal),
    install: (extra, opts = {}) => spawnSync(process.execPath,
      [INSTALL, "--tool", "pi-agent", "--project", projReal, ...extra],
      { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: home }, cwd: opts.cwd || projReal }),
    cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
                     try { fs.rmSync(proj, { recursive: true, force: true }); } catch {} },
  };
}

// Drive the DEPLOYED extension IN-PROCESS: import its index.js and call the
// exported handler(event, ctx). Optionally point os.homedir() at a fake HOME
// (P12 poison tests) by setting process.env.HOME for the call window.
async function runDeployedHandler(indexPath, event, ctx, fakeHome) {
  const prev = process.env.HOME;
  if (fakeHome) process.env.HOME = fakeHome;
  try {
    const mod = await import(pathToFileURL(indexPath).href);
    return await mod.handler(event, ctx);
  } finally {
    if (fakeHome) process.env.HOME = prev;
  }
}
const isBlock = (r) => !!(r && r.block === true);
const writeEvent = (p) => ({ toolName: "write", input: { path: p } });

// Plant a FULL divergent global contract candidate under fakeHome so
// resolveContractRoot candidate-1 is genuinely ELIGIBLE (candidate-1 is accepted
// only if patterns/bp-001.json exists — a lone _index.json proves nothing).
function plantGlobalContract(home, dirsOverride) {
  const g = path.join(home, ".episodic-memory", "patterns");
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, "bp-001.json"), JSON.stringify({ poison: true }));
  fs.writeFileSync(path.join(g, "events.json"), JSON.stringify({ poison: true }));
  fs.writeFileSync(path.join(g, "enforce-config.schema.json"), JSON.stringify({ poison: true }));
  const gp = path.join(home, ".episodic-memory", "plugins");
  fs.mkdirSync(gp, { recursive: true });
  fs.writeFileSync(path.join(gp, "_index.json"), JSON.stringify({ poison: true }));
  if (dirsOverride) {
    fs.writeFileSync(path.join(g, "repo-source-carveouts.json"),
      JSON.stringify({ exact_segment_dirs: dirsOverride, git_check_ignore: true }));
  }
}

// testInstallPiEnforcementProjectLocal — deploys under <proj>/.pi/…; NO ~/.pi write.
{
  const S = freshSandbox();
  try {
    const r = S.install(["--install-enforcement"]);
    assert(r.status === 0, "testInstallPiEnforcementProjectLocal: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    for (const [k, p] of Object.entries({ index: S.D.index, manifest: S.D.manifest,
      enforceContract: S.D.enforceContract, repoSource: S.D.repoSource, carveouts: S.D.carveouts,
      registryIndex: S.D.registryIndex, bp001: S.D.bp001, events: S.D.events, schema: S.D.schema })) {
      assert(fs.existsSync(p), `testInstallPiEnforcementProjectLocal: deploys ${k}`, p);
    }
    assert(!fs.existsSync(path.join(S.home, ".pi")), "testInstallPiEnforcementProjectLocal: NO ~/.pi write (P12)", path.join(S.home, ".pi"));
    assert(/project trust|--approve/.test(r.stdout || ""), "testInstallPiEnforcementProjectLocal: stdout names the trust activation", (r.stdout || "").slice(0, 300));
    // DENY a repo-source write, ALLOW a carve-out (negative control) via the deployed handler.
    fs.mkdirSync(path.join(S.projReal, "src"), { recursive: true });
    const deny = await runDeployedHandler(S.D.index, writeEvent("src/app.mjs"), { cwd: S.projReal });
    assert(isBlock(deny), "testInstallPiEnforcementProjectLocal: deployed handler BLOCKS repo-src write", JSON.stringify(deny));
    const allow = await runDeployedHandler(S.D.index, writeEvent("docs/plans/note.md"), { cwd: S.projReal });
    assert(allow === undefined, "testInstallPiEnforcementProjectLocal: deployed handler ALLOWS carve-out (neg control)", JSON.stringify(allow));
  } finally { S.cleanup(); }
}

// testUninstallPiEnforcementContained — uninstall removes only <proj>/.pi/…; assertContained.
{
  const S = freshSandbox();
  try {
    S.install(["--install-enforcement"]);
    assert(fs.existsSync(S.D.pluginDir), "testUninstallPiEnforcementContained: pluginDir present pre-uninstall", S.D.pluginDir);
    const u = S.install(["--uninstall-enforcement"]);
    assert(u.status === 0, "testUninstallPiEnforcementContained: uninstall exit 0", `${u.status}: ${(u.stderr || "").slice(0, 300)}`);
    assert(!fs.existsSync(S.D.pluginDir), "testUninstallPiEnforcementContained: pluginDir removed", S.D.pluginDir);
    assert(!fs.existsSync(S.D.piDir), "testUninstallPiEnforcementContained: empty .pi pruned", S.D.piDir);
    assert(!fs.existsSync(path.join(S.home, ".pi")), "testUninstallPiEnforcementContained: NO ~/.pi touched", path.join(S.home, ".pi"));
    // Contained: a user file in .pi (outside our namespace) SURVIVES; empty-.pi prune skips it.
    const S2 = freshSandbox();
    try {
      S2.install(["--install-enforcement"]);
      const userFile = path.join(S2.D.piDir, "user-note.txt");
      fs.writeFileSync(userFile, "keep me\n");
      const u2 = S2.install(["--uninstall-enforcement"]);
      assert(u2.status === 0, "testUninstallPiEnforcementContained: uninstall (user file) exit 0", `${u2.status}`);
      assert(!fs.existsSync(S2.D.pluginDir), "testUninstallPiEnforcementContained: our pluginDir removed", S2.D.pluginDir);
      assert(fs.existsSync(userFile), "testUninstallPiEnforcementContained: unrelated .pi user file SURVIVES", userFile);
    } finally { S2.cleanup(); }
  } finally { S.cleanup(); }
}

// testPiClosureNeverConsultsGlobal (P12/R6) — with a FULL eligible poison global
// contract, resolveContractRoot still realpaths to the project-local <pluginDir>/scripts
// (candidate-0 beats candidate-1), and the deployed handler still blocks a covered write.
{
  const S = freshSandbox();
  try {
    S.install(["--install-enforcement"]);
    plantGlobalContract(S.home); // full eligible candidate-1 under fake HOME
    const prev = process.env.HOME;
    process.env.HOME = S.home;
    let resolvedRoot = null;
    try {
      const ec = await import(pathToFileURL(S.D.enforceContract).href);
      resolvedRoot = ec.resolveContractRoot();
    } finally { process.env.HOME = prev; }
    assert(resolvedRoot && fs.realpathSync(resolvedRoot) === fs.realpathSync(S.D.scriptsDir),
      "testPiClosureNeverConsultsGlobal: resolveContractRoot -> project-local scripts, NOT global",
      `got ${resolvedRoot}; want ${S.D.scriptsDir}`);
    fs.mkdirSync(path.join(S.projReal, "src"), { recursive: true });
    const deny = await runDeployedHandler(S.D.index, writeEvent("src/app.mjs"), { cwd: S.projReal }, S.home);
    assert(isBlock(deny), "testPiClosureNeverConsultsGlobal: deployed handler still BLOCKS under poison global HOME", JSON.stringify(deny));
  } finally { S.cleanup(); }
}

// testPiCarveoutsPreferProjectLocalOverGlobal (P12/BLOCKER 2, R1/R2) — a poison global
// carveouts file (adds `src`, omits `docs/plans`) must NOT win over the co-deployed
// project-local carveouts. The deployed handler still BLOCKS src/x.mjs and ALLOWS
// docs/plans/z.md. If loadCarveouts preferred global, both assertions invert.
{
  const S = freshSandbox();
  try {
    S.install(["--install-enforcement"]);
    plantGlobalContract(S.home, ["src"]); // global carveouts poison: carve `src`, drop `docs/plans`
    fs.mkdirSync(path.join(S.projReal, "src"), { recursive: true });
    const denySrc = await runDeployedHandler(S.D.index, writeEvent("src/x.mjs"), { cwd: S.projReal }, S.home);
    assert(isBlock(denySrc), "testPiCarveoutsPreferProjectLocalOverGlobal: src/x.mjs still BLOCKED (project-local carveouts win)", JSON.stringify(denySrc));
    const allowPlan = await runDeployedHandler(S.D.index, writeEvent("docs/plans/z.md"), { cwd: S.projReal }, S.home);
    assert(allowPlan === undefined, "testPiCarveoutsPreferProjectLocalOverGlobal: docs/plans/z.md still ALLOWED (project-local carveouts win)", JSON.stringify(allowPlan));
  } finally { S.cleanup(); }
}

console.log(`\ntest-install-pi-enforcement: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all pi install/uninstall E2E tests passed");
