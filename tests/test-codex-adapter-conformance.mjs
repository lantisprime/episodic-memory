/**
 * test-codex-adapter-conformance.mjs — RFC-008 P6 S2 conformance suite.
 *
 * Conformance scenarios driving codex-adapter.mjs via spawnSync (stdin JSON → exit
 * code). Groups: 23 Bash (incl. sed grammar regressions from the codex r7 S2-review),
 * 4 apply_patch, 4 fail-closed, 1 import-fail, 1 cwd-symlink, 2 Write/Edit block,
 * 3 carveout-allow, 2 binding-match (raw-stdin + manifest-binding coherence),
 * 2 tier/cap regression.
 *
 * All tests use a shared mkdtemp git-init sandbox with src/SENTINEL.mjs.
 * apply_patch tests re-use the harness-event fixture (cwd re-pointed to sandbox).
 * Tier tests create/delete .episodic-memory/enforce-config.json in the sandbox.
 *
 * Run: node tests/test-codex-adapter-conformance.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { buildNormalizedPayload } from "../plugins/codex/capabilities/codex-adapter.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
const ADAPTER = path.join(REPO, "plugins", "codex", "capabilities", "codex-adapter.mjs");
const FIXTURE = path.join(REPO, "tests", "fixtures", "harness-events", "codex", "pre-tool-use.json");

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function assert(cond, name, detail = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

// ---------------------------------------------------------------------------
// Shared sandbox: mkdtemp + git init + src/SENTINEL.mjs
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conf-"));
execFileSync("git", ["init", "-q"], { cwd: sandbox });
execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: sandbox });
execFileSync("git", ["config", "user.name", "Test"], { cwd: sandbox });
fs.mkdirSync(path.join(sandbox, "src"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "src", "SENTINEL.mjs"), "// sentinel\n");
const sandboxReal = fs.realpathSync(sandbox);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function runAdapter(payload, opts = {}) {
  const res = spawnSync(process.execPath, [ADAPTER], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 60000,
    ...opts,
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function mkPayload(overrides = {}) {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    cwd: sandboxReal,
    session_id: "test-session-001",
    ...overrides,
  };
}

function assertBlock(name, res) {
  assert(res.status === 2, `${name}: exit 2`, `got ${res.status}; stderr: ${res.stderr.slice(0, 200)}`);
  let d;
  try { d = JSON.parse(res.stdout); } catch {
    assert(false, `${name}: stdout is valid JSON deny`, res.stdout.slice(0, 200));
    return;
  }
  assert(
    d.hookSpecificOutput && d.hookSpecificOutput.permissionDecision === "deny",
    `${name}: permissionDecision=deny`,
    JSON.stringify(d.hookSpecificOutput).slice(0, 200),
  );
}

function assertAllow(name, res) {
  assert(res.status === 0, `${name}: exit 0`, `got ${res.status}; stderr: ${res.stderr.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// GROUP 1: Bash extraction — 19 tests
// ---------------------------------------------------------------------------

// 1. sed -i block (GNU implicit script form: sed -i SCRIPT FILE)
assertBlock("bash/sed-i-block",
  runAdapter(mkPayload({ tool_input: { command: "sed -i 's/a/b/' src/SENTINEL.mjs" } })));

// 2. redirect write block (>)
assertBlock("bash/redirect-write-block",
  runAdapter(mkPayload({ tool_input: { command: "echo hi > src/out.mjs" } })));

// 3. &> block (stdout+stderr to file)
assertBlock("bash/both-stderr-block",
  runAdapter(mkPayload({ tool_input: { command: "grep x y &> src/z.mjs" } })));

// 4. multi-redirect block (two > in one command)
assertBlock("bash/multi-redirect-block",
  runAdapter(mkPayload({ tool_input: { command: "echo a > /tmp/a.txt > src/evil.mjs" } })));

// 5. cp dest block
assertBlock("bash/cp-dest-block",
  runAdapter(mkPayload({ tool_input: { command: "cp /tmp/a.txt src/x.mjs" } })));

// 6. /dev/null allow (sink)
assertAllow("bash/dev-null-allow",
  runAdapter(mkPayload({ tool_input: { command: "echo hi > /dev/null" } })));

// 7. 2>&1 allow (fd-dup)
assertAllow("bash/fd-dup-allow",
  runAdapter(mkPayload({ tool_input: { command: "grep x src/SENTINEL.mjs 2>&1" } })));

// 8. non-repo redirect allow
assertAllow("bash/non-repo-redirect-allow",
  runAdapter(mkPayload({ tool_input: { command: "echo hi > /tmp/output.txt" } })));

// 9. cp non-repo dest allow
assertAllow("bash/cp-non-repo-dest-allow",
  runAdapter(mkPayload({ tool_input: { command: "cp src/SENTINEL.mjs /tmp/y.txt" } })));

// 10. cat (read-only) allow
assertAllow("bash/cat-read-allow",
  runAdapter(mkPayload({ tool_input: { command: "cat src/SENTINEL.mjs" } })));

// 11. git commit allow (no write target extracted)
assertAllow("bash/git-commit-allow",
  runAdapter(mkPayload({ tool_input: { command: "git commit -m x" } })));

// 12. eval dynamic allow (unlexable → no target extracted)
assertAllow("bash/eval-dynamic-allow",
  runAdapter(mkPayload({ tool_input: { command: 'eval "echo hi > $D"' } })));

// 13. quoted redirect block (F2: >>"src/x.mjs" — quoted path, still a write)
assertBlock("bash/quoted-redirect-block",
  runAdapter(mkPayload({ tool_input: { command: 'printf hi >>"src/x.mjs"' } })));

// 14. quoted carveout allow (>"docs/plans/x.md" — carveout)
assertAllow("bash/quoted-carve-allow",
  runAdapter(mkPayload({ tool_input: { command: 'echo hi >"docs/plans/x.md"' } })));

// 15. cwd divergence (process cwd ≠ stdin cwd; adapter must use stdin.cwd)
{
  const divDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conf-div-"));
  const res = spawnSync(process.execPath, [ADAPTER], {
    cwd: divDir,
    input: JSON.stringify(mkPayload({ tool_input: { command: "echo hi > src/out.mjs" } })),
    encoding: "utf8",
    timeout: 60000,
  });
  assert(res.status === 2, "bash/cwd-divergence-block: exit 2",
    `got ${res.status}; stderr: ${(res.stderr || "").slice(0, 200)}`);
  let d;
  try { d = JSON.parse(res.stdout || ""); } catch { d = null; }
  assert(d && d.hookSpecificOutput && d.hookSpecificOutput.permissionDecisionReason
    && d.hookSpecificOutput.permissionDecisionReason.includes(sandboxReal),
    "bash/cwd-divergence-block: deny reason references sandbox (stdin.cwd used)",
    d && d.hookSpecificOutput ? d.hookSpecificOutput.permissionDecisionReason : "(no reason)");
  try { fs.rmSync(divDir, { recursive: true, force: true }); } catch {}
}

// 16. quoted space path block (F2: > "src/a b.txt")
assertBlock("bash/quoted-space-path-block",
  runAdapter(mkPayload({ tool_input: { command: 'printf hi > "src/a b.txt"' } })));

// 17. quoted space carveout allow (> "docs/plans/a b.md")
assertAllow("bash/quoted-space-carve-allow",
  runAdapter(mkPayload({ tool_input: { command: 'echo hi > "docs/plans/a b.md"' } })));

// 18. GNU -t dest block (cp -t src a b — target-directory = src/)
assertBlock("bash/gnu-t-block",
  runAdapter(mkPayload({ tool_input: { command: "cp -t src /tmp/a.txt /tmp/b.txt" } })));

// 19. GNU -t non-repo allow (cp -t /tmp a b — target-directory = /tmp)
assertAllow("bash/gnu-t-non-repo-allow",
  runAdapter(mkPayload({ tool_input: { command: "cp -t /tmp src/SENTINEL.mjs /tmp/b.txt" } })));

// 19b. sed BSD empty-suffix block (sed -i '' SCRIPT src/file — the empty '' is the
// BSD in-place suffix, NOT the file; regression for the codex r7 S2-review bypass).
assertBlock("bash/sed-bsd-empty-suffix-block",
  runAdapter(mkPayload({ tool_input: { command: "sed -i '' 's/a/b/' src/x.mjs" } })));

// 19c. sed -i carveout allow (sed -i SCRIPT docs/plans/x.md — the script must NOT be
// mistaken for the file; the real target is a carveout → allow, no false-deny).
assertAllow("bash/sed-i-carve-allow",
  runAdapter(mkPayload({ tool_input: { command: "sed -i 's/a/b/' docs/plans/x.md" } })));

// 19d. sed WITHOUT -i allow (no in-place flag → sed writes to stdout, not the file).
assertAllow("bash/sed-no-inplace-allow",
  runAdapter(mkPayload({ tool_input: { command: "sed 's/a/b/' src/SENTINEL.mjs" } })));

// 19e. sed -i -e explicit-script block (with -e, every operand is a file).
assertBlock("bash/sed-i-e-block",
  runAdapter(mkPayload({ tool_input: { command: "sed -i -e 's/a/b/' src/x.mjs" } })));

// ---------------------------------------------------------------------------
// GROUP 2: apply_patch — 4 tests
// ---------------------------------------------------------------------------

const fixtureRaw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

// 20. multi-file block: patch contains src/probe.mjs (repo-source)
{
  const payload = {
    ...fixtureRaw,
    cwd: sandboxReal,
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Add File: src/probe.mjs",
        "+export const probe = 42;",
        "*** Add File: docs/plans/note.md",
        "+# note",
        "*** End Patch",
        "",
      ].join("\n"),
    },
  };
  assertBlock("apply_patch/multi-file-block", runAdapter(payload));
}

// 21. docs-only allow: patch only touches docs/plans/ (carveout)
{
  const payload = {
    ...fixtureRaw,
    cwd: sandboxReal,
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Add File: docs/plans/note.md",
        "+# note",
        "*** End Patch",
        "",
      ].join("\n"),
    },
  };
  assertAllow("apply_patch/docs-only-allow", runAdapter(payload));
}

// 22. marker bundle allow: patch only touches .checkpoints/ and docs/plans/ (carveouts)
{
  const payload = {
    ...fixtureRaw,
    cwd: sandboxReal,
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Add File: .checkpoints/.post-checkpoint-done",
        "+done",
        "*** Add File: docs/plans/x.md",
        "+# x",
        "*** End Patch",
        "",
      ].join("\n"),
    },
  };
  assertAllow("apply_patch/marker-bundle-allow", runAdapter(payload));
}

// 23. unknown/empty patch → fail-closed (State C)
{
  const payload = {
    ...fixtureRaw,
    cwd: sandboxReal,
    tool_input: { command: "*** Begin Patch\n*** End Patch\n" }, // no file directives
  };
  assertBlock("apply_patch/empty-patch-fail-closed", runAdapter(payload));
}

// ---------------------------------------------------------------------------
// GROUP 3: fail-closed — 4 tests
// ---------------------------------------------------------------------------

// 24. garbage JSON → JSON.parse throws → outer catch → deny + exit 2
{
  const res = spawnSync(process.execPath, [ADAPTER], {
    input: "{not valid json",
    encoding: "utf8",
    timeout: 60000,
  });
  assertBlock("fail-closed/bad-json", res);
}

// 25. non-object stdin (42) → deny + exit 2
{
  const res = spawnSync(process.execPath, [ADAPTER], {
    input: "42",
    encoding: "utf8",
    timeout: 60000,
  });
  assertBlock("fail-closed/non-object-number", res);
}

// 26. array input ([]) → deny + exit 2
{
  const res = spawnSync(process.execPath, [ADAPTER], {
    input: "[]",
    encoding: "utf8",
    timeout: 60000,
  });
  assertBlock("fail-closed/array-input", res);
}

// 27. relative cwd → deny + exit 2 (State B)
{
  const res = runAdapter(mkPayload({ cwd: "relative/path" }));
  assertBlock("fail-closed/relative-cwd", res);
}

// ---------------------------------------------------------------------------
// GROUP 4: import-fail — 1 test
// ---------------------------------------------------------------------------

// 28. Adapter copied to isolated dir (waist modules absent) → import throws → deny + exit 2
{
  const isoDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conf-iso-"));
  const isoCapDir = path.join(isoDir, "capabilities");
  fs.mkdirSync(isoCapDir, { recursive: true });
  // Seed a real git repo so cwd checks pass
  execFileSync("git", ["init", "-q"], { cwd: isoDir });
  const isoAdapter = path.join(isoCapDir, "codex-adapter.mjs");
  fs.copyFileSync(ADAPTER, isoAdapter);

  const isoRes = spawnSync(process.execPath, [isoAdapter], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo hi > src/x.mjs" },
      cwd: isoDir,
      session_id: "iso-test",
    }),
    encoding: "utf8",
    timeout: 60000,
  });
  assertBlock("import-fail/isolated-dir", isoRes);
  try { fs.rmSync(isoDir, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// GROUP 5: cwd matrix — 1 test
// ---------------------------------------------------------------------------

// 29. Symlinked cwd → realpathSync resolves symlink → src write blocked
{
  const symTarget = sandboxReal;
  const symLink = path.join(os.tmpdir(), `codex-conf-sym-${Date.now()}`);
  fs.symlinkSync(symTarget, symLink);
  const res = runAdapter(mkPayload({
    cwd: symLink,
    tool_input: { command: "echo hi > src/out.mjs" },
  }));
  assertBlock("cwd-matrix/symlink-block", res);
  try { fs.unlinkSync(symLink); } catch {}
}

// ---------------------------------------------------------------------------
// GROUP 6: Write/Edit block — 2 tests
// ---------------------------------------------------------------------------

// 30. Write tool — repo-source path → exit 2
assertBlock("write-edit/write-block",
  runAdapter(mkPayload({
    tool_name: "Write",
    tool_input: { filePath: path.join(sandboxReal, "src", "new.mjs"), content: "x" },
  })));

// 31. Edit tool — repo-source path → exit 2
assertBlock("write-edit/edit-block",
  runAdapter(mkPayload({
    tool_name: "Edit",
    tool_input: { filePath: path.join(sandboxReal, "src", "SENTINEL.mjs"), old_string: "//", new_string: "//" },
  })));

// ---------------------------------------------------------------------------
// GROUP 7: carveout allow — 3 tests
// ---------------------------------------------------------------------------

// 32. Write to .episodic-memory/ → carveout → exit 0
assertAllow("carveout/episodic-allow",
  runAdapter(mkPayload({
    tool_name: "Write",
    tool_input: { filePath: path.join(sandboxReal, ".episodic-memory", "ep.json"), content: "{}" },
  })));

// 33. Write to .checkpoints/ → carveout → exit 0
assertAllow("carveout/checkpoint-allow",
  runAdapter(mkPayload({
    tool_name: "Write",
    tool_input: { filePath: path.join(sandboxReal, ".checkpoints", ".post-checkpoint-done"), content: "done" },
  })));

// 34. Write to docs/plans/ → carveout → exit 0
assertAllow("carveout/docs-plans-allow",
  runAdapter(mkPayload({
    tool_name: "Write",
    tool_input: { filePath: path.join(sandboxReal, "docs", "plans", "note.md"), content: "# note" },
  })));

// ---------------------------------------------------------------------------
// GROUP 8: binding match — 1 test
// ---------------------------------------------------------------------------

// 35. Raw Codex stdin (turn_id present, no turn_index) — fixture cwd re-pointed to sandbox
// The patch contains src/probe.mjs → repo-source → block (confirms adapter handles
// real Codex stdin format, including missing turn_index field).
{
  const rawPayload = {
    ...fixtureRaw,
    cwd: sandboxReal,
    tool_input: {
      command: [
        "*** Begin Patch",
        "*** Add File: src/probe.mjs",
        "+export const probe = 42;",
        "*** End Patch",
        "",
      ].join("\n"),
    },
  };
  // GENUINE raw Codex stdin: a string turn_id and NO turn_index at all (the
  // normalized fixture synthesizes turn_index; strip it to exercise the raw path).
  delete rawPayload.turn_index;
  assert(
    "turn_id" in rawPayload && typeof rawPayload.turn_id === "string" && !("turn_index" in rawPayload),
    "binding-match/raw-no-turn-index",
    "raw payload must carry a string turn_id and NO turn_index",
  );
  assertBlock("binding-match/raw-stdin-block", runAdapter(rawPayload));
}

// 36. Manifest binding coherence — buildNormalizedPayload output keys byte-match the
// manifest pre_tool_use field_bindings targets (drift guard; plan §14 / REQ-11).
{
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO, "plugins", "codex", "manifest.json"), "utf8"),
  );
  const bindingKeys = Object.keys(
    manifest.event_translations.pre_tool_use.field_bindings,
  ).sort();
  const np = buildNormalizedPayload(fixtureRaw);
  const payloadKeys = Object.keys(np).sort();
  assert(
    JSON.stringify(bindingKeys) === JSON.stringify(payloadKeys),
    "binding-match/manifest-bindings",
    `manifest field_bindings ${JSON.stringify(bindingKeys)} != buildNormalizedPayload keys ${JSON.stringify(payloadKeys)}`,
  );
  // turn_index must be a SYNTHESIZED integer (Codex emits a string turn_id, no turn_index).
  assert(
    typeof np.turn_index === "number",
    "binding-match/synthesized-turn-index",
    `buildNormalizedPayload.turn_index must be an integer, got ${typeof np.turn_index}`,
  );
}

// ---------------------------------------------------------------------------
// GROUP 9: tier/cap regression — 2 tests
// ---------------------------------------------------------------------------

// 36. No enforce-config → MEDIUM manifest but STRONG runtime → block (codex r7 F6)
// Verifies the manifest MEDIUM ceiling does NOT prevent enforcement; the runtime
// passes harnessCap:"STRONG" to gateDisposition, which maps STRONG → block.
assertBlock("tier-cap/medium-manifest-strong-runtime",
  runAdapter(mkPayload({ tool_input: { command: "sed -i 's/a/b/' src/SENTINEL.mjs" } })));

// 37. Operator enforce-config with bp-001.pre_checkpoint=MEDIUM → clampTier lowers
// STRONG → MEDIUM → warn → clamp-off → exit 0 (proves operator downgrade works).
{
  const emDir = path.join(sandboxReal, ".episodic-memory");
  fs.mkdirSync(emDir, { recursive: true });
  const cfgPath = path.join(emDir, "enforce-config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ active: true, "bp-001": { pre_checkpoint: "MEDIUM" } }));
  const res = runAdapter(mkPayload({ tool_input: { command: "sed -i 's/a/b/' src/SENTINEL.mjs" } }));
  assertAllow("tier-cap/config-clamp-medium-allows", res);
  try { fs.rmSync(cfgPath); } catch {} // clean up so other tests are not affected
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log(`\ntest-codex-adapter-conformance: ${pass} pass / ${fail} fail (${total} total)`);
if (fail > 0) {
  console.error("FAILURES:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
