/**
 * test-opencode-adapter.mjs — Group 4 tests for the OpenCode adapter
 * (RFC-008 P5 S5, REQ-8/9/10/13/14).
 *
 * These tests drive the enforce-bridge.mjs directly (the same protocol the
 * TypeScript adapter uses) to verify the end-to-end enforcement behavior.
 * The adapter spawns the bridge; these tests do the same. This is the
 * strongest testable form before OpenCode runtime integration.
 *
 * Run: node tests/test-opencode-adapter.mjs
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
// Helper: invoke bridge with a pre-normalized payload (mirrors adapter behavior)
// Returns {threw:bool, action:string|null, exit:number, stdout:string}
// ---------------------------------------------------------------------------
function invokeAdapter(mockRepo, event, normalized) {
  const envelope = { harness: "opencode", event, normalized };
  const input = JSON.stringify(envelope);
  const r = spawnSync(process.execPath, [BRIDGE], {
    cwd: REPO,
    input,
    encoding: "utf8",
    timeout: 15000,
    env: process.env,
  });
  let parsed = null;
  try { if (r.stdout) parsed = JSON.parse(r.stdout.trim()); } catch {}
  const threw = r.status !== 0;
  const action = parsed ? parsed.action : null;
  return { threw, action, exit: r.status, stdout: r.stdout, stderr: r.stderr, parsed };
}

// ---------------------------------------------------------------------------
// Set up a mock git repo.
// ---------------------------------------------------------------------------
function makeMockRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "SENTINEL.mjs"), "// sentinel\n");
  // Carve-out directories
  fs.mkdirSync(path.join(dir, ".episodic-memory", "episodes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true }); // already created by git init
  fs.mkdirSync(path.join(dir, ".checkpoints"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".review-store"), { recursive: true });
  return fs.realpathSync(dir);
}

const mockRepo = makeMockRepo();

// ---------------------------------------------------------------------------
// testRepoSrcWriteBlocks — write under repoRoot/src/SENTINEL.mjs → action:block
// ---------------------------------------------------------------------------
{
  const sentinelPath = path.join(mockRepo, "src", "SENTINEL.mjs");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "x" },
    cwd: mockRepo,
    session_id: "test-ses-001",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.exit === 0, "testRepoSrcWriteBlocks: bridge exits 0", String(r.exit));
  assert(r.action === "block", "testRepoSrcWriteBlocks: action=block",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// ---------------------------------------------------------------------------
// testReadAllows — read_only → action:allow
// ---------------------------------------------------------------------------
{
  const sentinelPath = path.join(mockRepo, "src", "SENTINEL.mjs");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "read",
    tool_args: { filePath: sentinelPath },
    cwd: mockRepo,
    session_id: "test-ses-002",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow", "testReadAllows: action=allow (read is not a write)",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// ---------------------------------------------------------------------------
// Carve-out negative controls: each must NOT block (action:allow)
// ---------------------------------------------------------------------------

// testEpisodeWriteAllows — .episodic-memory/ carve-out
{
  const sentinelPath = path.join(mockRepo, ".episodic-memory", "episodes", "SENTINEL.json");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "{}" },
    cwd: mockRepo,
    session_id: "test-ses-003",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow", "testEpisodeWriteAllows: .episodic-memory/ is carved out",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// testPlanFileWriteAllows — docs/plans/ carve-out
{
  const sentinelPath = path.join(mockRepo, "docs", "plans", "SENTINEL.md");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "plan" },
    cwd: mockRepo,
    session_id: "test-ses-004",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow", "testPlanFileWriteAllows: docs/plans/ is carved out",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// testGitWriteAllows — .git/ carve-out
{
  const sentinelPath = path.join(mockRepo, ".git", "SENTINEL_MSG");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "x" },
    cwd: mockRepo,
    session_id: "test-ses-005",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow", "testGitWriteAllows: .git/ is carved out",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// testCheckpointsWriteAllows — .checkpoints/ carve-out
{
  const sentinelPath = path.join(mockRepo, ".checkpoints", "SENTINEL.marker");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "x" },
    cwd: mockRepo,
    session_id: "test-ses-006",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow", "testCheckpointsWriteAllows: .checkpoints/ is carved out",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// testReviewStoreWriteAllows — .review-store/ carve-out
{
  const sentinelPath = path.join(mockRepo, ".review-store", "SENTINEL.json");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "{}" },
    cwd: mockRepo,
    session_id: "test-ses-007",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow", "testReviewStoreWriteAllows: .review-store/ is carved out",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// testNonRepoWriteAllows — write outside repo root → allow (outside-repo)
{
  const sentinelPath = path.join(os.tmpdir(), "SENTINEL_outside_repo.txt");
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "x" },
    cwd: mockRepo,
    session_id: "test-ses-008",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow", "testNonRepoWriteAllows: outside-repo write is allowed",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// ---------------------------------------------------------------------------
// testMalformedFailsClosed — normalized missing tool → bridge exits 2 (schema error)
// ---------------------------------------------------------------------------
{
  const r = invokeAdapter(mockRepo, "pre_tool_use", {
    // missing required fields; bridge should validate and exit 2 or 3
    session_id: "test-ses-009",
  });
  // Malformed = exit 2 (validation) or 3 (engine throw). Either counts as "fail-closed"
  // since the adapter (enforcement.ts) would throw on any non-zero exit.
  assert(r.exit !== 0 || r.action === "block",
    "testMalformedFailsClosed: malformed payload causes bridge failure or block",
    `exit=${r.exit}, action=${r.action}`);
}

// ---------------------------------------------------------------------------
// testBridgeErrorFailsClosed — simulate bridge error by sending garbage JSON
// (the adapter throws on bridge non-zero exit; this is the gateway to fail-closed)
// ---------------------------------------------------------------------------
{
  const r = spawnSync(process.execPath, [BRIDGE], {
    cwd: REPO,
    input: '{"harness":"opencode","event":"pre_tool_use","normalized":null}',
    encoding: "utf8",
    timeout: 5000,
  });
  // null normalized should fail schema validation (exit 2)
  assert(r.status === 2, "testBridgeErrorFailsClosed: null normalized → exit 2 (adapter would throw fail-closed)",
    String(r.status));
}

// ---------------------------------------------------------------------------
// testTurnIndexMonotonic — two calls with incrementing turn_index
// (turn_index is managed by the adapter; bridge just passes it through)
// ---------------------------------------------------------------------------
{
  const sentinelPath = path.join(mockRepo, "src", "SENTINEL.mjs");
  const r0 = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "x" },
    cwd: mockRepo,
    session_id: "test-ses-010",
    turn_index: 0,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  const r1 = invokeAdapter(mockRepo, "pre_tool_use", {
    tool: "write",
    tool_args: { filePath: sentinelPath, content: "y" },
    cwd: mockRepo,
    session_id: "test-ses-010",
    turn_index: 1,
    timestamp_iso8601: "2026-01-01T00:00:01Z",
  });
  // Both should block (same path, both gated). The turn_index flows through.
  assert(r0.action === "block" && r1.action === "block",
    "testTurnIndexMonotonic: both calls block (turn_index 0 then 1)",
    `r0.action=${r0.action}, r1.action=${r1.action}`);
}

// ---------------------------------------------------------------------------
// testCwdFromContext — bridge uses payload.cwd as repo root
// (even when process.cwd() differs — mirrors testBridgeCwdDivergence)
// ---------------------------------------------------------------------------
{
  const sentinelPath = path.join(mockRepo, "src", "SENTINEL.mjs");
  const envelope = {
    harness: "opencode",
    event: "pre_tool_use",
    normalized: {
      tool: "write",
      tool_args: { filePath: sentinelPath, content: "x" },
      cwd: mockRepo,
      session_id: "test-ses-011",
      turn_index: 1,
      timestamp_iso8601: "2026-01-01T00:00:00Z",
    },
  };
  const r = spawnSync(process.execPath, [BRIDGE], {
    cwd: os.tmpdir(), // divergent process cwd
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout: 15000,
    env: process.env,
  });
  let parsed = null;
  try { if (r.stdout) parsed = JSON.parse(r.stdout.trim()); } catch {}
  assert(parsed && parsed.action === "block",
    "testCwdFromContext: bridge uses payload.cwd (not process.cwd) → still blocks",
    parsed ? JSON.stringify(parsed) : r.stderr);
}

// ---------------------------------------------------------------------------
// testToolResultObserveNoMutate — tool_result event → action:allow (MEDIUM observe)
// ---------------------------------------------------------------------------
{
  const r = invokeAdapter(mockRepo, "tool_result", {
    tool: "write",
    tool_args: { filePath: path.join(mockRepo, "src", "SENTINEL.mjs") },
    result: "written",
    cwd: mockRepo,
    session_id: "test-ses-012",
    turn_index: 2,
    timestamp_iso8601: "2026-01-01T00:00:00Z",
  });
  assert(r.action === "allow",
    "testToolResultObserveNoMutate: tool_result event always allows (MEDIUM observe)",
    r.parsed ? JSON.stringify(r.parsed) : r.stderr);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
fs.rmSync(mockRepo, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\ntest-opencode-adapter: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all opencode adapter tests passed");
