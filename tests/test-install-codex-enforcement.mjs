/**
 * test-install-codex-enforcement.mjs — mock-project E2E for the Codex enforcement
 * install/uninstall (RFC-008 P6 S4, REQ-13). Runs the REAL install.mjs under an
 * isolated HOME + throwaway project, drives the DEPLOYED adapter (M4 — not the
 * in-repo copy), and proves per-project deploy + hooks.json MERGE + cwd-safety +
 * skill-no-collision + trust-print + uninstall.  Run: node tests/test-install-codex-enforcement.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
const INSTALL = path.join(REPO, "install.mjs");
const FORCE_ALLOW = process.env.CODEX_FORCE_ALLOW === "1"; // §A.9 red-then-green break

let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; } else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

// Mirror codexEnforcementPaths in install.mjs.
function deployed(projectDir) {
  const codexDir = path.join(projectDir, ".codex");
  const pluginDir = path.join(codexDir, "episodic-memory");
  const scriptsDir = path.join(codexDir, "scripts");
  return {
    codexDir, pluginDir, scriptsDir,
    adapter: path.join(pluginDir, "capabilities", "codex-adapter.mjs"),
    enforceContract: path.join(scriptsDir, "enforce-contract.mjs"),
    repoSource: path.join(scriptsDir, "lib", "repo-source.mjs"),
    carveouts: path.join(codexDir, "patterns", "repo-source-carveouts.json"),
    index: path.join(scriptsDir, "plugins", "_index.json"),
    // review F3: the contract-pattern closure S4-L1 copies (resolveContractRoot candidate-0
    // + schema). If any is missing, config/registry resolution fails and the gate fail-closes
    // to deny — so a passing DENY assertion could be masking an incomplete deploy.
    bp001: path.join(scriptsDir, "patterns", "bp-001.json"),
    events: path.join(scriptsDir, "patterns", "events.json"),
    schema: path.join(scriptsDir, "patterns", "enforce-config.schema.json"),
    // R5 operator kill switch lives at <markerRoot>/.episodic-memory/enforce-config.json;
    // markerRoot resolves to the project root (enforce-contract.mjs loadEnforceConfig).
    enforceConfig: path.join(projectDir, ".episodic-memory", "enforce-config.json"),
    hooksJson: path.join(codexDir, "hooks.json"),
  };
}

// §A.9 break: a 1-line always-allow stub the deny test points at when CODEX_FORCE_ALLOW=1.
function allowStub() {
  const p = path.join(os.tmpdir(), `cx-allow-stub-${process.pid}.mjs`);
  fs.writeFileSync(p, "process.exit(0)\n");
  return p;
}

// Drive the DEPLOYED adapter with a RAW codex PreToolUse stdin envelope.
function runDeployedAdapter(adapterPath, stdin, procCwd) {
  const target = FORCE_ALLOW ? allowStub() : adapterPath;
  const r = spawnSync(process.execPath, [target], {
    input: JSON.stringify(stdin), cwd: procCwd, encoding: "utf8", timeout: 15000,
  });
  let parsed = null;
  try { if (r.stdout && r.stdout.trim()) parsed = JSON.parse(r.stdout.trim()); } catch {}
  return { exit: r.status, parsed, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function preToolUseStdin(target, cwd) {
  return { hook_event_name: "PreToolUse", tool_name: "Write",
    tool_input: { filePath: target, content: "x" }, cwd, session_id: "s4-test" };
}

function freshSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cx-install-home-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "cx-install-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: proj });
  const projReal = fs.realpathSync(proj);
  return {
    home, proj, projReal, D: deployed(projReal),
    install: (extra, opts = {}) => spawnSync(process.execPath,
      [INSTALL, "--tool", "codex", "--project", projReal, ...extra],
      { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: home }, cwd: opts.cwd || projReal }),
    cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
                     try { fs.rmSync(proj, { recursive: true, force: true }); } catch {} },
  };
}

const USER_CMD = "node /tmp/user-precheck.js"; // sentinel: a pre-existing user hook that MUST survive
const hookCmds = (cfg) => (cfg && cfg.hooks && Array.isArray(cfg.hooks.PreToolUse))
  ? cfg.hooks.PreToolUse.flatMap((b) => (b.hooks || []).map((h) => h.command)) : [];
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

// Mirror codexHookCommand in install.mjs: POSIX single-quote shell escaping (codex runs the
// hooks.json command via a shell, so the adapter path must be shell-quoted to survive spaces).
const shellQuote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const codexCommand = (adapter) => `node ${shellQuote(adapter)}`;

// Run a hooks.json command STRING through a shell (shell:true) — the REAL execution path codex
// uses — feeding the PreToolUse stdin. Used to prove the shell-quoted command still runs the
// deployed adapter when the project path contains spaces.
function runHookCommand(command, stdin, procCwd) {
  const r = spawnSync(command, [], {
    input: JSON.stringify(stdin), cwd: procCwd, encoding: "utf8", timeout: 15000, shell: true,
  });
  let parsed = null;
  try { if (r.stdout && r.stdout.trim()) parsed = JSON.parse(r.stdout.trim()); } catch {}
  return { exit: r.status, parsed, stdout: r.stdout || "", stderr: r.stderr || "" };
}

// testInstallMergesHooksJson — pre-seed a user PreToolUse hook; install KEEPS it + ADDS ours.
{
  const S = freshSandbox();
  try {
    fs.mkdirSync(S.D.codexDir, { recursive: true });
    fs.writeFileSync(S.D.hooksJson, JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: USER_CMD }] }] } }));
    const r = S.install(["--install-enforcement"]);
    assert(r.status === 0, "testInstallMergesHooksJson: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    const cmds = hookCmds(readJson(S.D.hooksJson));
    assert(cmds.includes(USER_CMD), "testInstallMergesHooksJson: user hook SURVIVES", JSON.stringify(cmds));
    assert(cmds.includes(codexCommand(S.D.adapter)), "testInstallMergesHooksJson: our adapter command ADDED", JSON.stringify(cmds));
  } finally { S.cleanup(); }
}

// testInstallDeploysClosure — closure on disk + DEPLOYED adapter DENIES repo-src, ALLOWS carve-out.
{
  const S = freshSandbox();
  try {
    const r = S.install(["--install-enforcement"]);
    assert(r.status === 0, "testInstallDeploysClosure: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    for (const [k, p] of Object.entries({ adapter: S.D.adapter, enforceContract: S.D.enforceContract,
      repoSource: S.D.repoSource, carveouts: S.D.carveouts, index: S.D.index,
      bp001: S.D.bp001, events: S.D.events, schema: S.D.schema })) {
      assert(fs.existsSync(p), `testInstallDeploysClosure: deploys ${k}`, p);
    }
    fs.mkdirSync(path.join(S.projReal, "src"), { recursive: true });
    const denyTarget = path.join(S.projReal, "src", "app.mjs");
    fs.writeFileSync(denyTarget, "// x\n");
    const deny = runDeployedAdapter(S.D.adapter, preToolUseStdin(denyTarget, S.projReal), S.projReal);
    assert(deny.exit === 2, "testInstallDeploysClosure: repo-src write -> exit 2", `${deny.exit}: ${deny.stderr.slice(0, 300)}`);
    assert(deny.parsed && deny.parsed.hookSpecificOutput && deny.parsed.hookSpecificOutput.permissionDecision === "deny",
      "testInstallDeploysClosure: repo-src write -> permissionDecision deny", deny.stdout.slice(0, 300));
    // ALLOW = the §A.9 negative control: proves the DENY above is not a constant-2 stub.
    fs.mkdirSync(path.join(S.projReal, "docs", "plans"), { recursive: true });
    const allowTarget = path.join(S.projReal, "docs", "plans", "note.md");
    const allow = runDeployedAdapter(S.D.adapter, preToolUseStdin(allowTarget, S.projReal), S.projReal);
    assert(allow.exit === 0, "testInstallDeploysClosure: carve-out write -> exit 0 (neg control)", `${allow.exit}: ${allow.stderr.slice(0, 300)}`);
    assert(allow.stdout.trim() === "", "testInstallDeploysClosure: carve-out write -> no output", allow.stdout.slice(0, 300));
    // active:false control (review F3, R5): with the FULL closure present, the operator
    // kill switch MUST be honored — the SAME repo-source write flips DENY -> ALLOW (exit 0).
    // This proves the DENY above is a genuine repo-source decision, not a fail-closed deny
    // caused by an incomplete closure (config/registry resolution miss defaults to active:true).
    fs.mkdirSync(path.join(S.projReal, ".episodic-memory"), { recursive: true });
    fs.writeFileSync(S.D.enforceConfig, JSON.stringify({ active: false }));
    const silenced = runDeployedAdapter(S.D.adapter, preToolUseStdin(denyTarget, S.projReal), S.projReal);
    assert(silenced.exit === 0, "testInstallDeploysClosure: repo-src write under active:false -> exit 0 (R5 silence honored, closure resolves)", `${silenced.exit}: ${silenced.stderr.slice(0, 300)}`);
    fs.rmSync(S.D.enforceConfig, { force: true }); // restore enforcing default for any later use
  } finally { S.cleanup(); }
}

// testInstallCallerCwdSafe — caller cwd != --project: artifacts under project_root ONLY (codex F3).
{
  const S = freshSandbox();
  const callerCwd = fs.mkdtempSync(path.join(os.tmpdir(), "cx-caller-"));
  try {
    const r = S.install(["--install-enforcement"], { cwd: callerCwd });
    assert(r.status === 0, "testInstallCallerCwdSafe: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    assert(fs.existsSync(S.D.adapter), "testInstallCallerCwdSafe: adapter under project_root", S.D.adapter);
    assert(!fs.existsSync(path.join(callerCwd, ".codex")), "testInstallCallerCwdSafe: NO .codex under caller cwd", callerCwd);
    assert(!fs.existsSync(path.join(S.home, ".codex")), "testInstallCallerCwdSafe: NO .codex under HOME", S.home);
  } finally { S.cleanup(); try { fs.rmSync(callerCwd, { recursive: true, force: true }); } catch {} }
}

// testInstallRelativeProjectAbsoluteCommand — review F4 (R-F3): a RELATIVE --project must
// still yield an ABSOLUTE hooks.json command (`node <abs adapter>`). codex runs the hook from
// its OWN cwd, so a relative adapter path would break enforcement. Install cwd=projReal,
// --project=".". Without the realpath/resolve in codexEnforcementPaths this goes RED.
{
  const S = freshSandbox();
  try {
    const r = spawnSync(process.execPath,
      [INSTALL, "--tool", "codex", "--project", ".", "--install-enforcement"],
      { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: S.home }, cwd: S.projReal });
    assert(r.status === 0, "testInstallRelativeProjectAbsoluteCommand: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    const cmds = hookCmds(readJson(S.D.hooksJson));
    // The stored command must equal `node '<ABS adapter>'` (shell-quoted, absolute). If the
    // relative --project were not realpath-resolved, the command would carry a relative path
    // and NOT match codexCommand(S.D.adapter) — so this still goes RED without the resolve.
    assert(cmds.includes(codexCommand(S.D.adapter)),
      "testInstallRelativeProjectAbsoluteCommand: command present + shell-quoted ABSOLUTE path", JSON.stringify(cmds));
    assert(path.isAbsolute(S.D.adapter),
      "testInstallRelativeProjectAbsoluteCommand: adapter path is ABSOLUTE", S.D.adapter);
  } finally { S.cleanup(); }
}

// testInstallSpacePathHookCommandShellQuoted — code-review finding (REQ-13/REQ-15): project
// paths with SPACES must still run under codex's SHELL-evaluated hooks.json command. Pre-fix,
// an unquoted `node <abs path>` split at the first space and failed OPEN before the adapter ran
// (silent enforcement bypass). The pair-programmer's real-codex probe confirmed codex shell-
// evaluates hook commands, so shell-quoting is the fix; this test runs the stored command
// THROUGH a shell (runHookCommand) to exercise the exact path the bug lived in.
{
  const S = freshSandbox();
  const spaced = fs.mkdtempSync(path.join(os.tmpdir(), "cx-install-proj space "));
  try {
    fs.rmSync(S.proj, { recursive: true, force: true });
    S.proj = spaced;
    S.projReal = fs.realpathSync(spaced);
    S.D = deployed(S.projReal);
    execFileSync("git", ["init", "-q"], { cwd: S.projReal });
    const r = spawnSync(process.execPath, [INSTALL, "--tool", "codex", "--project", S.projReal, "--install-enforcement"],
      { encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: S.home }, cwd: S.projReal });
    assert(r.status === 0, "testInstallSpacePathHookCommandShellQuoted: install exit 0", `${r.status}: ${(r.stderr || "").slice(0, 300)}`);
    const cmds = hookCmds(readJson(S.D.hooksJson));
    const expected = codexCommand(S.D.adapter);
    assert(cmds.includes(expected), "testInstallSpacePathHookCommandShellQuoted: hook command shell-quotes adapter path", JSON.stringify(cmds));
    fs.mkdirSync(path.join(S.projReal, "src"), { recursive: true });
    const denyTarget = path.join(S.projReal, "src", "app.mjs");
    fs.writeFileSync(denyTarget, "// x\n");
    const deny = runHookCommand(expected, preToolUseStdin(denyTarget, S.projReal), S.projReal);
    assert(deny.exit === 2, "testInstallSpacePathHookCommandShellQuoted: shell command runs deployed adapter despite spaces", `${deny.exit}: ${deny.stderr.slice(0, 300)}`);
    assert(deny.parsed && deny.parsed.hookSpecificOutput && deny.parsed.hookSpecificOutput.permissionDecision === "deny",
      "testInstallSpacePathHookCommandShellQuoted: repo-src write -> permissionDecision deny", deny.stdout.slice(0, 300));
  } finally { S.cleanup(); }
}

// testInstallNoSkillCollision — a prior `--tool codex` skill install is byte-unchanged by enforcement install.
{
  const S = freshSandbox();
  try {
    const skill = S.install([]); // bare `--tool codex` == skill install (install.mjs:937)
    assert(skill.status === 0, "testInstallNoSkillCollision: skill install exit 0", `${skill.status}`);
    const skillPath = path.join(S.projReal, ".agents", "skills", "episodic-memory", "SKILL.md");
    const before = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : null;
    assert(before !== null, "testInstallNoSkillCollision: skill file present after skill install", skillPath);
    S.install(["--install-enforcement"]);
    const after = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : null;
    assert(after === before, "testInstallNoSkillCollision: SKILL.md byte-unchanged by enforcement install");
  } finally { S.cleanup(); }
}

// testInstallPrintsTrust — install stdout instructs the operator to run /hooks (R3).
{
  const S = freshSandbox();
  try {
    const r = S.install(["--install-enforcement"]);
    assert(/\/hooks/.test(r.stdout || ""), "testInstallPrintsTrust: stdout names the /hooks trust step", (r.stdout || "").slice(0, 300));
  } finally { S.cleanup(); }
}

// testUninstallRemovesOnlyOurEntry — uninstall drops our hook + files, keeps the user hook.
{
  const S = freshSandbox();
  try {
    fs.mkdirSync(S.D.codexDir, { recursive: true });
    fs.writeFileSync(S.D.hooksJson, JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: USER_CMD }] }] } }));
    S.install(["--install-enforcement"]);
    const u = S.install(["--uninstall-enforcement"]);
    assert(u.status === 0, "testUninstallRemovesOnlyOurEntry: uninstall exit 0", `${u.status}: ${(u.stderr || "").slice(0, 300)}`);
    const cmds = hookCmds(readJson(S.D.hooksJson));
    assert(!cmds.includes(codexCommand(S.D.adapter)), "testUninstallRemovesOnlyOurEntry: our hook removed", JSON.stringify(cmds));
    assert(cmds.includes(USER_CMD), "testUninstallRemovesOnlyOurEntry: user hook PRESERVED", JSON.stringify(cmds));
    assert(!fs.existsSync(S.D.pluginDir), "testUninstallRemovesOnlyOurEntry: pluginDir removed", S.D.pluginDir);
    assert(!fs.existsSync(S.D.scriptsDir), "testUninstallRemovesOnlyOurEntry: scriptsDir removed (empty case)", S.D.scriptsDir);
  } finally { S.cleanup(); }
}

// testUninstallPreservesUserFilesInSharedDirs — review F1 (r2): unrelated user files pre-seeded
// inside the GENERIC dirs our closure shares (.codex/scripts/{lib,patterns,plugins}, .codex/patterns)
// MUST survive uninstall; our own closure files must be gone; the shared dir is kept (not pruned)
// because it still holds the user's file. Complements the empty-dir case above.
{
  const S = freshSandbox();
  try {
    S.install(["--install-enforcement"]);
    const userFiles = [
      path.join(S.D.scriptsDir, "lib", "user-helper.mjs"),
      path.join(S.D.scriptsDir, "patterns", "user-notes.json"),
      path.join(S.D.scriptsDir, "plugins", "user-plugin.json"),
      path.join(S.D.codexDir, "patterns", "user-carveout.json"),
    ];
    for (const p of userFiles) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, "// user\n"); }
    const u = S.install(["--uninstall-enforcement"]);
    assert(u.status === 0, "testUninstallPreservesUserFilesInSharedDirs: uninstall exit 0", `${u.status}: ${(u.stderr || "").slice(0, 300)}`);
    for (const p of userFiles) assert(fs.existsSync(p), "testUninstallPreservesUserFilesInSharedDirs: user file SURVIVES uninstall", p);
    assert(!fs.existsSync(S.D.enforceContract), "testUninstallPreservesUserFilesInSharedDirs: our enforce-contract.mjs removed", S.D.enforceContract);
    assert(!fs.existsSync(S.D.repoSource), "testUninstallPreservesUserFilesInSharedDirs: our lib/repo-source.mjs removed", S.D.repoSource);
    assert(fs.existsSync(S.D.scriptsDir), "testUninstallPreservesUserFilesInSharedDirs: scriptsDir KEPT (holds user files)", S.D.scriptsDir);
  } finally { S.cleanup(); }
}

console.log(`\ntest-install-codex-enforcement: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all codex install/uninstall E2E tests passed");
