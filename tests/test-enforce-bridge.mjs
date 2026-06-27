/**
 * test-enforce-bridge.mjs — Group 5 tests for the OpenCode enforce bridge
 * (RFC-008 P5 S5, REQ-8/9/10/13/14).
 *
 * Tests spawn the bridge as a subprocess, send JSON to stdin, and assert
 * on stdout + exit code. No global state mutation.
 *
 * Run: node tests/test-enforce-bridge.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
const BRIDGE = path.join(REPO, "plugins", "opencode", "capabilities", "enforce-bridge.mjs");

let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

// ---------------------------------------------------------------------------
// Helper: spawn the bridge with a given envelope, capture stdout/exit.
// ---------------------------------------------------------------------------
function runBridge(envelope, opts = {}) {
  const { cwd = REPO } = opts;
  const input = JSON.stringify(envelope);
  const r = spawnSync(process.execPath, [BRIDGE], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 15000,
    env: process.env,
  });
  let parsed = null;
  try { if (r.stdout) parsed = JSON.parse(r.stdout.trim()); } catch {}
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

// ---------------------------------------------------------------------------
// Set up a mock git repo for path-resolution tests.
// ---------------------------------------------------------------------------
function makeMockRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // Create a src file to represent a repo-source target
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "SENTINEL.mjs"), "// sentinel\n");
  // .episodic-memory carve-out
  fs.mkdirSync(path.join(dir, ".episodic-memory"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".episodic-memory", "ep.json"), "{}");
  return fs.realpathSync(dir);
}

// ---------------------------------------------------------------------------
// testBridgeRepoSrcBlock — pre_tool_use write to repo-source → action:block
// ---------------------------------------------------------------------------
{
  const mockRepo = makeMockRepo();
  const sentinelPath = path.join(mockRepo, "src", "SENTINEL.mjs");
  const envelope = {
    harness: "opencode",
    event: "pre_tool_use",
    normalized: {
      tool: "write",
      tool_args: { filePath: sentinelPath, content: "x" },
      cwd: mockRepo,
      session_id: "test-block-ses",
      turn_index: 1,
      timestamp_iso8601: "2026-01-01T00:00:00Z",
    },
  };
  const r = runBridge(envelope);
  assert(r.exit === 0, "testBridgeRepoSrcBlock: exit 0", String(r.exit));
  assert(r.parsed && r.parsed.action === "block", "testBridgeRepoSrcBlock: action=block",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
  assert(r.parsed && typeof r.parsed.reason === "string" && r.parsed.reason.length > 0,
    "testBridgeRepoSrcBlock: reason is non-empty string");
  fs.rmSync(mockRepo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// testBridgeReadAllow — read_only tool → action:allow
// ---------------------------------------------------------------------------
{
  const mockRepo = makeMockRepo();
  const sentinelPath = path.join(mockRepo, "src", "SENTINEL.mjs");
  const envelope = {
    harness: "opencode",
    event: "pre_tool_use",
    normalized: {
      tool: "read",
      tool_args: { filePath: sentinelPath },
      cwd: mockRepo,
      session_id: "test-read-ses",
      turn_index: 1,
      timestamp_iso8601: "2026-01-01T00:00:00Z",
    },
  };
  const r = runBridge(envelope);
  assert(r.exit === 0, "testBridgeReadAllow: exit 0", String(r.exit));
  assert(r.parsed && r.parsed.action === "allow", "testBridgeReadAllow: action=allow",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
  fs.rmSync(mockRepo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// testBridgeInvalidPayloadExit2 — malformed envelope → exit 2
// ---------------------------------------------------------------------------
{
  // Missing event field
  const r1 = runBridge({ harness: "opencode", normalized: {} });
  assert(r1.exit === 2, "testBridgeInvalidPayloadExit2 (missing event): exit 2", String(r1.exit));

  // Wrong harness
  const r2 = runBridge({ harness: "claude-code", event: "pre_tool_use", normalized: {} });
  assert(r2.exit === 2, "testBridgeInvalidPayloadExit2 (wrong harness): exit 2", String(r2.exit));

  // Non-JSON input via raw stdin
  const rBad = spawnSync(process.execPath, [BRIDGE], {
    cwd: REPO,
    input: "NOT JSON",
    encoding: "utf8",
    timeout: 5000,
  });
  assert(rBad.status === 2, "testBridgeInvalidPayloadExit2 (non-JSON): exit 2", String(rBad.status));
}

// ---------------------------------------------------------------------------
// testBridgeEngineThrowExit3 — unresolvable cwd → engine throws → exit 3
// ---------------------------------------------------------------------------
{
  const envelope = {
    harness: "opencode",
    event: "pre_tool_use",
    normalized: {
      tool: "write",
      tool_args: { filePath: "/nonexistent/SENTINEL.mjs" },
      cwd: "/nonexistent-bridge-test-xyz-123456",
      session_id: "test-eng-ses",
      turn_index: 1,
      timestamp_iso8601: "2026-01-01T00:00:00Z",
    },
  };
  const r = runBridge(envelope);
  assert(r.exit === 3, "testBridgeEngineThrowExit3: exit 3 on unresolvable cwd", String(r.exit));
}

// ---------------------------------------------------------------------------
// testBridgeCwdDivergence — process cwd=os.tmpdir(), payload.cwd=mock repo.
// Decision uses mock repo carve-outs (repo-source write blocks using mock
// repo as root), NOT the process cwd.
// ---------------------------------------------------------------------------
{
  const mockRepo = makeMockRepo();
  const procCwd = os.tmpdir();
  const sentinelPath = path.join(mockRepo, "src", "SENTINEL.mjs");
  const envelope = {
    harness: "opencode",
    event: "pre_tool_use",
    normalized: {
      tool: "write",
      tool_args: { filePath: sentinelPath },
      cwd: mockRepo,
      session_id: "test-cwd-div-ses",
      turn_index: 1,
      timestamp_iso8601: "2026-01-01T00:00:00Z",
    },
  };
  // Run with process cwd=tmpdir (divergent from payload.cwd=mockRepo)
  const r = runBridge(envelope, { cwd: procCwd });
  assert(r.exit === 0, "testBridgeCwdDivergence: exit 0", String(r.exit));
  // Should still block (uses payload.cwd=mockRepo as repo root, not procCwd)
  assert(r.parsed && r.parsed.action === "block",
    "testBridgeCwdDivergence: action=block (repo-root from payload.cwd, not process cwd)",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
  fs.rmSync(mockRepo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\ntest-enforce-bridge: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all enforce-bridge tests passed");
