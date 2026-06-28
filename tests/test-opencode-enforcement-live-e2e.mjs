/**
 * test-opencode-enforcement-live-e2e.mjs — ACTUAL-TERMINAL regression test.
 *
 * BUG (reproduced 2026-06-28 by driving the live opencode TUI):
 *   plugins/opencode/capabilities/enforcement.ts spawned the bridge with
 *   `spawnSync(process.execPath, [BRIDGE])`. Under opencode's Bun-compiled
 *   runtime, process.execPath is the OPENCODE binary (not node). opencode then
 *   treats the .mjs path as a project dir, fails to cd, exits 0 with EMPTY
 *   stdout → the adapter's JSON.parse throws → "fail-closed: bridge stdout not
 *   valid JSON" on EVERY gated tool call. The enforcement never actually decides.
 *
 * WHY PROXY TESTS MISSED IT (and why this test exists):
 *   test-opencode-adapter-conformance.mjs imports the adapter UNDER NODE, where
 *   process.execPath IS node, so the broken spawn worked and every suite stayed
 *   green. test-opencode-adapter.mjs drives enforce-bridge.mjs directly under
 *   node — same blind spot. The bug only manifests in the REAL opencode/Bun
 *   runtime. This test drives the actual opencode binary in a real terminal
 *   (tmux) — NO node proxy — and asserts the hook DECIDES instead of fail-closing.
 *
 * FIX: resolveNodeExe() in enforcement.ts — use process.execPath only when it IS
 *   node, else locate node on PATH.
 *
 * PRECONDITIONS (real binary + TTY + a reachable model):
 *   - opencode CLI installed (~/.opencode/bin/opencode or on PATH)
 *   - a configured + REACHABLE opencode model (this is an agent-driven E2E)
 *   - tmux >= 3.5
 *   Missing any precondition → SKIP (exit 0 with a SKIP line), never a false pass.
 *   UNGUARDED-IN-CI: real-runtime, model-dependent — run locally/manually.
 *
 * Run: node tests/test-opencode-enforcement-live-e2e.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
const INSTALL = path.join(REPO, "install.mjs");
const SOCK = `oc-e2e-${process.pid}`;
const SESS = "oc";

function skip(msg) { console.log(`SKIP: ${msg}`); process.exit(0); }
function tmux(args, opts = {}) {
  return spawnSync("tmux", ["-L", SOCK, ...args], { encoding: "utf8", timeout: 30000, ...opts });
}
function pane(lines = 250) {
  const r = tmux(["capture-pane", "-p", "-e", "-J", "-t", SESS, "-S", `-${lines}`]);
  return (r.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
}
const _sab = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms) { Atomics.wait(_sab, 0, 0, ms); } // real blocking sleep, no CPU spin, cross-platform

// --- preconditions -----------------------------------------------------------
let OC = "";
try { OC = execFileSync("bash", ["-lc", "command -v opencode || echo ${HOME}/.opencode/bin/opencode"], { encoding: "utf8" }).trim(); } catch { /* */ }
if (!OC || !fs.existsSync(OC)) skip("opencode binary not found");
if (tmux(["-V"]).status !== 0) skip("tmux not available");

// --- mock project + enforcement install --------------------------------------
const mock = fs.mkdtempSync(path.join(os.tmpdir(), "oc-e2e-"));
fs.mkdirSync(path.join(mock, "src"));
fs.writeFileSync(path.join(mock, "src", "probe.mjs"), "export const x = 1;\n");
execFileSync("git", ["init", "-q"], { cwd: mock });
const install = spawnSync(process.execPath, [INSTALL, "--tool", "opencode", "--project", mock, "--install-enforcement"], { encoding: "utf8", timeout: 120000 });
if (install.status !== 0) { cleanup(); console.error(`FAIL: install exit ${install.status}: ${(install.stderr || "").slice(0, 300)}`); process.exit(1); }

// --- drive the real opencode TUI ---------------------------------------------
let passed = false, reason = "";
try {
  tmux(["kill-server"]);
  const conf = path.join(mock, ".tmuxconf");
  fs.writeFileSync(conf, "set -g extended-keys-format csi-u\nset -g extended-keys on\n");
  tmux(["-f", conf, "new-session", "-d", "-s", SESS, "-x", "220", "-y", "50"]);
  sleep(800);
  tmux(["send-keys", "-t", SESS, `cd ${mock}`, "Enter"]); sleep(500);
  tmux(["send-keys", "-t", SESS, OC, "Enter"]); sleep(12000);

  // Send a gated bash write through the agent.
  const prompt = "Use your bash tool to run exactly this and report success or hook-block: echo REGRESSION_OK > src/probe.mjs";
  const buf = path.join(mock, ".prompt");
  fs.writeFileSync(buf, prompt);
  tmux(["load-buffer", "-t", SESS, buf]);
  tmux(["paste-buffer", "-t", SESS]); sleep(1500);
  tmux(["send-keys", "-t", SESS, "Enter"]); sleep(3000);

  // Wait for either the model-unreachable error, a permission prompt, or completion.
  let connErr = false;
  for (let i = 0; i < 48; i++) {
    const p = pane(12);
    if (/Cannot connect to API|Unable to connect/i.test(p)) { connErr = true; break; }
    if (/Permission required/i.test(p)) break;           // hook ALLOWED → opencode's own permission gate
    if (/fail-closed|not valid JSON/i.test(p)) break;     // the BUG signature
    if (!/esc to interrupt|esc interrupt|working|thinking/i.test(p) && i > 3) break;
    sleep(5000);
  }
  if (connErr) { cleanup(); skip("opencode model unreachable (start LM Studio / configure a reachable model)"); }

  // Approve any permission prompt (Allow once = default), then let it run.
  if (/Permission required/i.test(pane(12))) { tmux(["send-keys", "-t", SESS, "Enter"]); }
  for (let i = 0; i < 24; i++) { if (!/esc to interrupt|esc interrupt|working|thinking/i.test(pane(12))) break; sleep(5000); }
  sleep(2000);

  const full = pane(300);
  const fileContent = fs.readFileSync(path.join(mock, "src", "probe.mjs"), "utf8");

  // REGRESSION ASSERTIONS:
  //  1. the bug signature must NOT appear (no fail-closed on a decidable command)
  //  2. the hook ALLOWED the echo (read_only) → the write landed on disk
  const noFailClosed = !/fail-closed|bridge stdout not valid JSON/i.test(full);
  const wrote = /REGRESSION_OK/.test(fileContent);
  passed = noFailClosed && wrote;
  reason = `noFailClosed=${noFailClosed} wrote=${wrote} (file="${fileContent.trim()}")`;
} finally {
  tmux(["kill-server"]);
}

cleanup();
if (passed) { console.log(`PASS: live opencode hook decided (no fail-close) and write landed — ${reason}`); process.exit(0); }
console.error(`FAIL: ${reason}`);
process.exit(1);

function cleanup() {
  try { tmux(["kill-server"]); } catch { /* */ }
  try { fs.rmSync(mock, { recursive: true, force: true }); } catch { /* */ }
}
