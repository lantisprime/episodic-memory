/**
 * test-pi-adapter.mjs — RFC-008 P7 S2 adapter unit suite (plan §14 Groups 1-3).
 *
 * Drives the REAL exported handler from plugins/pi-agent/capabilities/enforcement.js
 * IN-PROCESS (Pi loads the extension in its Node host; there is no child process). Each
 * test builds a real {toolName,input} event + {cwd} against a mkdtemp git fixture and
 * asserts the handler's return: {block:true} (deny) or undefined (allow), per the §12
 * State table.
 *
 * Negative controls (prove the block assertions have teeth) are TEST-SIDE, never env
 * hooks baked into the shipped adapter (an env-gated bypass in an enforcement adapter is
 * the fail-open class this plugin exists to prevent):
 *   BREAK_CTX_CWD=1   — feed the repo ROOT as ctx.cwd for the relative-resolution test, so
 *                       the target lands in the docs/plans carve-out and escapes (allow).
 *                       The real handler resolves against the nested cwd → block, so the
 *                       assertion goes RED, proving it depends on correct base resolution.
 *   BREAK_REPO_ROOT=1 — `git init` the nested cwd so git-toplevel conflates repoRoot with
 *                       ctx.cwd (BLOCKER 3); the sibling then resolves OUTSIDE the wrongly
 *                       narrowed repo and escapes (allow) → assertion RED.
 *
 * Run:  node tests/test-pi-adapter.mjs                    → <N>/<N> pass
 *       BREAK_CTX_CWD=1 node tests/test-pi-adapter.mjs    → non-zero (control fires)
 *       BREAK_REPO_ROOT=1 node tests/test-pi-adapter.mjs  → non-zero (control fires)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { handler } from "../plugins/pi-agent/capabilities/enforcement.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
const ADAPTER = path.join(REPO, "plugins", "pi-agent", "capabilities", "enforcement.js");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
const tmpDirs = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}
const isBlock = (res) => !!(res && res.block === true);
const isAllow = (res) => res === undefined;

// ---------------------------------------------------------------------------
// Fixture: mkdtemp + git init + src/SENTINEL.mjs + .gitignore + docs/plans/
// ---------------------------------------------------------------------------
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapter-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "SENTINEL.mjs"), "// sentinel\n");
  fs.mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  return fs.realpathSync(dir);
}

function cleanup() {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

// ===========================================================================
// GROUP 1 — adapter path extraction + disposition
// ===========================================================================

async function testWriteRepoSourceBlocked() {
  const R = makeRepo();
  const res = await handler({ toolName: "write", input: { path: "src/x.mjs" } }, { cwd: R });
  assert(isBlock(res), "testWriteRepoSourceBlocked", `got ${JSON.stringify(res)}`);
}

async function testEditRepoSourceBlocked() {
  const R = makeRepo();
  const res = await handler({ toolName: "edit", input: { path: "src/SENTINEL.mjs" } }, { cwd: R });
  assert(isBlock(res), "testEditRepoSourceBlocked", `got ${JSON.stringify(res)}`);
}

async function testOutsideRepoAllowed() {
  const R = makeRepo();
  const res = await handler({ toolName: "write", input: { path: "/tmp/pi-adapter-outside.txt" } }, { cwd: R });
  assert(isAllow(res), "testOutsideRepoAllowed", `got ${JSON.stringify(res)}`);
}

async function testCarveoutAllowed() {
  const R = makeRepo();
  const res = await handler({ toolName: "write", input: { path: "docs/plans/note.md" } }, { cwd: R });
  assert(isAllow(res), "testCarveoutAllowed", `got ${JSON.stringify(res)}`);
}

async function testGitignoredAllowed() {
  const R = makeRepo();
  const res = await handler({ toolName: "write", input: { path: "ignored.txt" } }, { cwd: R });
  assert(isAllow(res), "testGitignoredAllowed", `got ${JSON.stringify(res)}`);
}

async function testGitInternalAllowed() {
  const R = makeRepo();
  const res = await handler({ toolName: "write", input: { path: ".git/COMMIT_EDITMSG" } }, { cwd: R });
  assert(isAllow(res), "testGitInternalAllowed", `got ${JSON.stringify(res)}`);
}

// EC3 — relative path resolves against baseCwd (nested cwd). Negative control:
// BREAK_CTX_CWD feeds the repo root as cwd → docs/plans becomes the carve-out → allow → RED.
async function testRelativePathResolvedAgainstBaseCwd() {
  const R = makeRepo();
  const nested = path.join(R, "pkg", "a");
  fs.mkdirSync(nested, { recursive: true });
  const cwd = process.env.BREAK_CTX_CWD ? R : nested;
  const res = await handler({ toolName: "write", input: { path: "docs/plans/x.md" } }, { cwd });
  assert(isBlock(res), "testRelativePathResolvedAgainstBaseCwd",
    `expected block (relative under nested cwd is repo-source, not the repo-root carve-out); got ${JSON.stringify(res)}`);
}

// BLOCKER 3 — sibling from a nested cwd. Negative control: BREAK_REPO_ROOT `git init`s the
// nested cwd so git-toplevel conflates repoRoot with ctx.cwd → sibling escapes → allow → RED.
async function testSiblingFromNestedCwdBlocked() {
  const R = makeRepo();
  const nested = path.join(R, "pkg", "a");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(R, "pkg", "sibling", "src"), { recursive: true });
  if (process.env.BREAK_REPO_ROOT) {
    execFileSync("git", ["init", "-q"], { cwd: nested });
  }
  const res = await handler({ toolName: "write", input: { path: "../sibling/src/x.mjs" } }, { cwd: nested });
  assert(isBlock(res), "testSiblingFromNestedCwdBlocked",
    `expected block (sibling under the git-toplevel repo); got ${JSON.stringify(res)}`);
}

// EC2 — symlinked ctx.cwd realpaths on both sides; gate still fires.
async function testSymlinkedCwdStillGates() {
  const R = makeRepo();
  const link = path.join(os.tmpdir(), `pi-adapter-sym-${process.pid}-${pass}-${fail}`);
  fs.symlinkSync(R, link);
  const res = await handler({ toolName: "write", input: { path: "src/out.mjs" } }, { cwd: link });
  try { fs.unlinkSync(link); } catch {}
  assert(isBlock(res), "testSymlinkedCwdStillGates", `got ${JSON.stringify(res)}`);
}

// EC5 — `..` traversal that still lands inside the repo → repo-source → block.
async function testDotDotTraversal() {
  const R = makeRepo();
  const sub = path.join(R, "sub");
  fs.mkdirSync(sub, { recursive: true });
  const res = await handler({ toolName: "write", input: { path: "../src/x.mjs" } }, { cwd: sub });
  assert(isBlock(res), "testDotDotTraversal", `got ${JSON.stringify(res)}`);
}

// EC1 — write/edit with missing input.path → malformed → block (State C2, NOT allow).
async function testMalformedWriteBlocked() {
  const R = makeRepo();
  const wr = await handler({ toolName: "write", input: {} }, { cwd: R });
  assert(isBlock(wr), "testMalformedWriteBlocked(write)", `got ${JSON.stringify(wr)}`);
  const ed = await handler({ toolName: "edit", input: { path: "" } }, { cwd: R });
  assert(isBlock(ed), "testMalformedWriteBlocked(edit-empty)", `got ${JSON.stringify(ed)}`);
}

// EC1b — bash with no lexable write target → allow (State C1, extract-only residual).
async function testBashNoTargetAllows() {
  const R = makeRepo();
  const res = await handler({ toolName: "bash", input: { command: "ls -la src" } }, { cwd: R });
  assert(isAllow(res), "testBashNoTargetAllows", `got ${JSON.stringify(res)}`);
}

// codex r6 MAJOR — an UNKNOWN (non-read/write/bash) tool carrying a write surface is gated.
async function testUnknownToolWithWriteSurfaceGated() {
  const R = makeRepo();
  const res = await handler({ toolName: "apply_patch", input: { path: "src/x.mjs" } }, { cwd: R });
  assert(isBlock(res), "testUnknownToolWithWriteSurfaceGated", `got ${JSON.stringify(res)}`);
}

// Unknown tool with NO write surface → allow (State A-adjacent conservative allow).
async function testUnknownToolNoSurfaceAllows() {
  const R = makeRepo();
  const res = await handler({ toolName: "search", input: { query: "foo" } }, { cwd: R });
  assert(isAllow(res), "testUnknownToolNoSurfaceAllows", `got ${JSON.stringify(res)}`);
}

// State A — a KNOWN read-only tool allows without even requiring ctx.cwd.
async function testKnownReadToolAllows() {
  const res = await handler({ toolName: "read", input: { path: "src/SENTINEL.mjs" } }, {});
  assert(isAllow(res), "testKnownReadToolAllows", `got ${JSON.stringify(res)}`);
}

// ===========================================================================
// GROUP 2 — bash extraction (reuse of the copied codex extractor)
// ===========================================================================

async function testBashRedirectRepoSourceBlocked() {
  const R = makeRepo();
  const res = await handler({ toolName: "bash", input: { command: "echo hi > src/a.mjs" } }, { cwd: R });
  assert(isBlock(res), "testBashRedirectRepoSourceBlocked", `got ${JSON.stringify(res)}`);
}

async function testBashTeeRepoSourceBlocked() {
  const R = makeRepo();
  const res = await handler({ toolName: "bash", input: { command: "echo hi | tee src/b.mjs" } }, { cwd: R });
  assert(isBlock(res), "testBashTeeRepoSourceBlocked", `got ${JSON.stringify(res)}`);
}

async function testBashSedInPlaceBlocked() {
  const R = makeRepo();
  const res = await handler({ toolName: "bash", input: { command: "sed -i '' 's/a/b/' src/SENTINEL.mjs" } }, { cwd: R });
  assert(isBlock(res), "testBashSedInPlaceBlocked", `got ${JSON.stringify(res)}`);
}

async function testBashDynamicNotBlocked() {
  const R = makeRepo();
  const res = await handler({ toolName: "bash", input: { command: 'echo hi > "$TARGET"' } }, { cwd: R });
  assert(isAllow(res), "testBashDynamicNotBlocked", `got ${JSON.stringify(res)}`);
}

async function testBashOutsideAllowed() {
  const R = makeRepo();
  const res = await handler({ toolName: "bash", input: { command: "echo hi > /tmp/pi-adapter-out.txt" } }, { cwd: R });
  assert(isAllow(res), "testBashOutsideAllowed", `got ${JSON.stringify(res)}`);
}

// ===========================================================================
// GROUP 3 — fail-closed
// ===========================================================================

async function testMalformedEventFailsClosed() {
  const nonObj = await handler(42, { cwd: makeRepo() });
  assert(isBlock(nonObj), "testMalformedEventFailsClosed(number)", `got ${JSON.stringify(nonObj)}`);
  const nul = await handler(null, { cwd: makeRepo() });
  assert(isBlock(nul), "testMalformedEventFailsClosed(null)", `got ${JSON.stringify(nul)}`);
  const badInput = await handler({ toolName: "write", input: "notanobject" }, { cwd: makeRepo() });
  assert(isBlock(badInput), "testMalformedEventFailsClosed(input)", `got ${JSON.stringify(badInput)}`);
}

async function testBadCtxCwdFailsClosed() {
  const rel = await handler({ toolName: "write", input: { path: "src/x.mjs" } }, { cwd: "relative/path" });
  assert(isBlock(rel), "testBadCtxCwdFailsClosed(relative)", `got ${JSON.stringify(rel)}`);
  const missing = await handler({ toolName: "write", input: { path: "src/x.mjs" } }, {});
  assert(isBlock(missing), "testBadCtxCwdFailsClosed(missing)", `got ${JSON.stringify(missing)}`);
}

// EC4 — the dynamic import() of the waist throws → fail-closed (State D). Reproduced by
// importing a copy of the adapter placed where its ../../../scripts waist does not exist.
async function testWaistImportFailureFailsClosed() {
  const iso = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapter-iso-"));
  tmpDirs.push(iso);
  const capDir = path.join(iso, "plugins", "pi-agent", "capabilities");
  fs.mkdirSync(capDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: iso });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: iso });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: iso });
  const isoAdapter = path.join(capDir, "enforcement.js");
  fs.copyFileSync(ADAPTER, isoAdapter);
  const mod = await import(pathToFileURL(isoAdapter).href);
  const isoReal = fs.realpathSync(iso);
  const res = await mod.handler({ toolName: "write", input: { path: "src/x.mjs" } }, { cwd: isoReal });
  assert(isBlock(res), "testWaistImportFailureFailsClosed",
    `expected fail-closed block when the waist import throws; got ${JSON.stringify(res)}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const tests = [
    testWriteRepoSourceBlocked,
    testEditRepoSourceBlocked,
    testOutsideRepoAllowed,
    testCarveoutAllowed,
    testGitignoredAllowed,
    testGitInternalAllowed,
    testRelativePathResolvedAgainstBaseCwd,
    testSiblingFromNestedCwdBlocked,
    testSymlinkedCwdStillGates,
    testDotDotTraversal,
    testMalformedWriteBlocked,
    testBashNoTargetAllows,
    testUnknownToolWithWriteSurfaceGated,
    testUnknownToolNoSurfaceAllows,
    testKnownReadToolAllows,
    testBashRedirectRepoSourceBlocked,
    testBashTeeRepoSourceBlocked,
    testBashSedInPlaceBlocked,
    testBashDynamicNotBlocked,
    testBashOutsideAllowed,
    testMalformedEventFailsClosed,
    testBadCtxCwdFailsClosed,
    testWaistImportFailureFailsClosed,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { assert(false, t.name, `threw: ${(e && e.stack) || e}`); }
  }
  cleanup();
  const total = pass + fail;
  console.log(`\ntest-pi-adapter: ${pass} pass / ${fail} fail (${total} total)`);
  if (fail > 0) {
    console.error("FAILURES:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
}

main();
