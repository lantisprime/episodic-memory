#!/usr/bin/env node
// test-activation-manifest.mjs — RFC-009 R3 P2-S2 conformance tests for the
// activation manifest declaration: manifest.json validates against
// plugins/activation-manifest.schema.json, install-manifest.mjs agrees with
// the manifest on registrations + hook-file checksums, the runtime IO schema
// enforces the advisory (no decision/block/permissionDecision) invariant, and
// validate-plugin-registry.mjs's new activation sub-gauntlet dispatches
// correctly in single-manifest mode.
//
// Run: node tests/test-activation-manifest.mjs   (exit 0 = pass)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateInstance } from "../scripts/lib/json-instance-validate.mjs";
import { validateRegistry } from "../scripts/validate-plugin-registry.mjs";
import { activationRegistrations, activationHookFileBasenames } from "../scripts/lib/install-manifest.mjs";

const REPO = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PLUGIN_DIR = path.join(REPO, "plugins/claude-code-activation");
const MANIFEST_PATH = path.join(PLUGIN_DIR, "manifest.json");
const SCHEMA_PATH = path.join(REPO, "plugins/activation-manifest.schema.json");
const IO_SCHEMA_PATH = path.join(REPO, "schemas/runtime/activation-io.schema.json");

const readJson = (abs) => JSON.parse(fs.readFileSync(abs, "utf8"));
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

let pass = 0, fail = 0;
const failures = [];
const ok = () => pass++;
const bad = (n, d) => { fail++; failures.push(`${n}${d ? " — " + d : ""}`); };
const assert = (c, n, d) => (c ? ok() : bad(n, d));

const manifest = readJson(MANIFEST_PATH);
const schema = readJson(SCHEMA_PATH);
const ioSchema = readJson(IO_SCHEMA_PATH);

// Minimal context (the schemas + taxonomy/events + bypass_known loadContext()
// needs) copied into an isolated temp root, so a single-manifest validateRegistry
// call against a NON-repo projectRoot still resolves its context files. Declared
// up here (not in the helper block) so section 12's temp-root route can use it
// before the helper block's line is reached (avoids a const TDZ, cf. test-plugin-registry.mjs).
const CONTEXT_FILES = [
  "plugins/_index.schema.json", "plugins/manifest.schema.json", "plugins/bypass_known.schema.json",
  "plugins/installed-state.schema.json", "schemas/runtime/structured-alert.schema.json",
  "schemas/runbook-agent-manifest.schema.json", "plugins/activation-manifest.schema.json",
  "patterns/taxonomy.json", "patterns/events.json", "plugins/bypass_known.json",
];
function buildMinimalContext(tmp) {
  for (const rel of CONTEXT_FILES) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), dest);
  }
}

// A target that lives OUTSIDE any scratch project root. /etc/hosts exists on
// macOS + Linux (the forge scripts use the same); the resolver must refuse it
// regardless of whether it exists — containment, not existence, is the gate.
// Declared here (with CONTEXT_FILES) so section 13 can use it before the helper
// block is reached (avoids a const TDZ).
const OUTSIDE_TARGET = "/etc/hosts";

// ===========================================================================
// 1. manifest_validates_against_schema
// ===========================================================================
{
  const r = validateInstance(manifest, schema);
  assert(r.valid, "manifest_validates_against_schema: manifest.json validates against activation-manifest.schema.json", JSON.stringify(r.errors.slice(0, 4)));
}

// ===========================================================================
// 2. manifest_type_const_activation (neg: type:"enforcement" REJECTED)
// ===========================================================================
{
  const clone = structuredClone(manifest);
  clone.type = "enforcement";
  const r = validateInstance(clone, schema);
  assert(!r.valid, "manifest_type_const_activation: type:\"enforcement\" clone is REJECTED", "unexpectedly valid");
}

// ===========================================================================
// 3. manifest_blocking_const_false (neg: blocking:true REJECTED)
// ===========================================================================
{
  const clone = structuredClone(manifest);
  clone.blocking = true;
  const r = validateInstance(clone, schema);
  assert(!r.valid, "manifest_blocking_const_false: blocking:true is REJECTED", "unexpectedly valid");
}

// ===========================================================================
// 4. capabilities_keys_closed (neg: unknown key REJECTED; non-tier value REJECTED)
// ===========================================================================
{
  const cloneKey = structuredClone(manifest);
  cloneKey.capabilities.tool_result = "STRONG"; // not in {user_prompt_submit,pre_tool_use,session_start}
  const rKey = validateInstance(cloneKey, schema);
  assert(!rKey.valid, "capabilities_keys_closed: unknown capability key REJECTED", "unexpectedly valid");

  const cloneTier = structuredClone(manifest);
  cloneTier.capabilities.pre_tool_use = "BOGUS";
  const rTier = validateInstance(cloneTier, schema);
  assert(!rTier.valid, "capabilities_keys_closed: non-tier capability value REJECTED", "unexpectedly valid");
}

// ===========================================================================
// 5. registrations_shape (neg: missing checksum / bad checksum pattern / bad event)
// ===========================================================================
{
  const cloneMissing = structuredClone(manifest);
  delete cloneMissing.registrations[0].checksum;
  const rMissing = validateInstance(cloneMissing, schema);
  assert(!rMissing.valid, "registrations_shape: missing checksum REJECTED", "unexpectedly valid");

  const cloneBadChecksum = structuredClone(manifest);
  cloneBadChecksum.registrations[0].checksum = "sha256:not-hex";
  const rBadChecksum = validateInstance(cloneBadChecksum, schema);
  assert(!rBadChecksum.valid, "registrations_shape: bad checksum pattern REJECTED", "unexpectedly valid");

  const cloneBadEvent = structuredClone(manifest);
  cloneBadEvent.registrations[0].event = "ToolResult";
  const rBadEvent = validateInstance(cloneBadEvent, schema);
  assert(!rBadEvent.valid, "registrations_shape: bad event enum REJECTED", "unexpectedly valid");
}

// ===========================================================================
// 6. ownership_ids_unique_and_present
// ===========================================================================
{
  const ids = manifest.registrations.map((r) => r.id);
  assert(ids.length === 3, "ownership_ids_unique_and_present: exactly 3 registrations", `got ${ids.length}`);
  assert(ids.every((id) => typeof id === "string" && id.length > 0), "ownership_ids_unique_and_present: every id non-empty string", JSON.stringify(ids));
  assert(new Set(ids).size === ids.length, "ownership_ids_unique_and_present: ids are unique", JSON.stringify(ids));
}

// ===========================================================================
// 7. manifest_agreement — install-manifest.mjs source-of-truth agrees with the
//    manifest on {file, event, timeout}, order-insensitive by file.
// ===========================================================================
{
  const specRegs = activationRegistrations();
  const manifestRegs = manifest.registrations.map((r) => ({ file: r.file, event: r.event, timeout: r.timeout }));
  const bySpecFile = new Map(specRegs.map((r) => [r.file, r]));
  const byManifestFile = new Map(manifestRegs.map((r) => [r.file, r]));

  assert(bySpecFile.size === byManifestFile.size, "manifest_agreement: same number of distinct hook files", `spec=${bySpecFile.size} manifest=${byManifestFile.size}`);
  let allAgree = true;
  for (const [file, spec] of bySpecFile) {
    const m = byManifestFile.get(file);
    if (!m || m.event !== spec.event || m.timeout !== spec.timeout) allAgree = false;
  }
  assert(allAgree, "manifest_agreement: activationRegistrations() agrees with manifest on file/event/timeout", JSON.stringify({ specRegs, manifestRegs }));

  const specBasenames = new Set(activationHookFileBasenames());
  const manifestBasenames = new Set(manifest.registrations.map((r) => r.file));
  assert(specBasenames.size === manifestBasenames.size && [...specBasenames].every((f) => manifestBasenames.has(f)),
    "manifest_agreement: activationHookFileBasenames() equals the set of registration file basenames",
    JSON.stringify({ spec: [...specBasenames], manifest: [...manifestBasenames] }));
}

// ===========================================================================
// 8. manifest_checksum_matches_file
// ===========================================================================
{
  let allMatch = true;
  for (const r of manifest.registrations) {
    const abs = path.join(PLUGIN_DIR, "hooks", r.file);
    const bytes = fs.readFileSync(abs);
    const actual = "sha256:" + sha256(bytes);
    if (actual !== r.checksum) allMatch = false;
  }
  assert(allMatch, "manifest_checksum_matches_file: every registration checksum matches its hook file's sha256", "mismatch detected");

  // neg: mutate a byte IN-MEMORY (never touch the real file) -> the comparison
  // would fail (proves the check is sensitive to drift, not vacuously true).
  const firstReg = manifest.registrations[0];
  const abs = path.join(PLUGIN_DIR, "hooks", firstReg.file);
  const bytes = fs.readFileSync(abs);
  const mutated = Buffer.from(bytes);
  mutated[0] = mutated[0] ^ 0xff; // flip a byte
  const mutatedChecksum = "sha256:" + sha256(mutated);
  assert(mutatedChecksum !== firstReg.checksum, "manifest_checksum_matches_file: a mutated byte changes the checksum (comparison is sensitive)", "mutation produced the same checksum");
}

// ===========================================================================
// 9. io_schema_path_exists
// ===========================================================================
{
  const abs = path.join(REPO, manifest.io_schema);
  assert(fs.existsSync(abs), "io_schema_path_exists: manifest.io_schema resolves to an existing file under repo root", manifest.io_schema);
}

// ===========================================================================
// 10. io_schema_rejects_decision_field
// ===========================================================================
{
  const badPayload = {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" },
    decision: "block",
  };
  const rBad = validateInstance(badPayload, ioSchema);
  assert(!rBad.valid, "io_schema_rejects_decision_field: payload carrying `decision` FAILS validation", "unexpectedly valid");

  const cleanPayload = {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "x" },
  };
  const rClean = validateInstance(cleanPayload, ioSchema);
  assert(rClean.valid, "io_schema_rejects_decision_field: clean advisory payload PASSES", JSON.stringify(rClean.errors));
}

// ===========================================================================
// 11. project_identity_schema
// ===========================================================================
{
  const rNoIdentity = validateInstance(manifest, schema); // repo template omits project_identity
  assert(rNoIdentity.valid, "project_identity_schema: manifest WITHOUT project_identity validates (repo template)", JSON.stringify(rNoIdentity.errors));

  const withIdentity = structuredClone(manifest);
  withIdentity.project_identity = { slug: "x", root: "/y" };
  const rWith = validateInstance(withIdentity, schema);
  assert(rWith.valid, "project_identity_schema: synthetic clone WITH valid project_identity validates", JSON.stringify(rWith.errors));

  const missingRoot = structuredClone(manifest);
  missingRoot.project_identity = { slug: "x" };
  const rMissingRoot = validateInstance(missingRoot, schema);
  assert(!rMissingRoot.valid, "project_identity_schema: project_identity missing root REJECTED", "unexpectedly valid");

  const nonStringSlug = structuredClone(manifest);
  nonStringSlug.project_identity = { slug: 1, root: "/y" };
  const rNonStringSlug = validateInstance(nonStringSlug, schema);
  assert(!rNonStringSlug.valid, "project_identity_schema: non-string slug REJECTED", "unexpectedly valid");
}

// ===========================================================================
// 12. validator_single_manifest_mode
// ===========================================================================
{
  const r = validateRegistry({ projectRoot: REPO, manifestPath: "plugins/claude-code-activation/manifest.json" });
  assert(r.status === "ok", "validator_single_manifest_mode: validateRegistry single-manifest mode returns status ok", JSON.stringify(r.violations.slice(0, 4)));

  // A deliberately-broken temp copy (blocking:true) in an isolated minimal
  // context returns status "fail" (exercises the new activation sub-gauntlet's
  // A2 schema-failure path end-to-end, not just validateInstance directly).
  const tmp = mkdtemp();
  try {
    buildMinimalContext(tmp);
    const broken = structuredClone(manifest);
    broken.blocking = true;
    fs.writeFileSync(path.join(tmp, "broken-manifest.json"), JSON.stringify(broken));
    const r2 = validateRegistry({ projectRoot: tmp, manifestPath: "broken-manifest.json" });
    assert(r2.status === "fail", "validator_single_manifest_mode: a deliberately-broken manifest returns status fail", JSON.stringify(r2));
  } finally {
    rmrf(tmp);
  }
}

// ===========================================================================
// 13. PATH-AUTHORITY negatives (RFC-009 P2-S2 review F1/F2 regression, Rule 15).
//     Before the fix, A-runbook / A-io-schema resolved the path lexically then
//     read it, FOLLOWING a symlink — a runbook/io_schema symlink living inside
//     the authority but resolving OUTSIDE it passed (status ok). These assert
//     the two-stage resolver now fails closed. Scratch temp projects (NOT the
//     repo); symlinkSync gated for cross-OS (F9-style skip).
// ===========================================================================
{
  if (!symlinkCapable()) {
    process.stdout.write("  · section 13 SKIP: symlinkSync unavailable/unprivileged on this platform\n");
  } else {
    // baseline: an unmutated full activation project passes (isolates the mutation;
    // a stray checksum/existence failure below would then be the mutation's, not harness noise).
    {
      const tmp = mkdtemp();
      try {
        buildActivationProject(tmp);
        fs.writeFileSync(path.join(tmp, "m.json"), JSON.stringify(manifest));
        const r = validateRegistry({ projectRoot: tmp, manifestPath: "m.json" });
        assert(r.status === "ok", "section 13 baseline: clean full activation project passes", JSON.stringify(r.violations.slice(0, 4)));
      } finally { rmrf(tmp); }
    }
    // (a) runbook.full symlink INSIDE the plugin dir resolving OUTSIDE it -> symlink_escape (F1).
    runActivationScenario("F1 runbook symlink-escape -> A-runbook/symlink_escape", "A-runbook", "symlink_escape", (tmp, m) => {
      const link = path.join(tmp, "plugins/claude-code-activation/runbooks/escape.md");
      fs.symlinkSync(OUTSIDE_TARGET, link);
      m.runbook.full = "plugins/claude-code-activation/runbooks/escape.md";
    });
    // (b) io_schema symlink resolving OUTSIDE the project root -> symlink_escape (F2).
    runActivationScenario("F2 io_schema symlink-escape -> A-io-schema/symlink_escape", "A-io-schema", "symlink_escape", (tmp) => {
      const p = path.join(tmp, "schemas/runtime/activation-io.schema.json");
      fs.rmSync(p);
      fs.symlinkSync(OUTSIDE_TARGET, p);
    });
    // (c) runbook.full LEXICAL ../ escape (absolute-in-repo, out of plugin authority) -> path_outside_authority.
    runActivationScenario("runbook lexical escape -> A-runbook/path_outside_authority", "A-runbook", "path_outside_authority", (tmp, m) => {
      fs.mkdirSync(path.join(tmp, "plugins/claude-code/runbooks"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "plugins/claude-code/runbooks/enforcement.md"), "x".repeat(64));
      m.runbook.full = "plugins/claude-code/runbooks/enforcement.md";
    });
    // (d) runbook.full DANGLING symlink (target missing) -> dangling_symlink.
    runActivationScenario("runbook dangling symlink -> A-runbook/dangling_symlink", "A-runbook", "dangling_symlink", (tmp, m) => {
      const link = path.join(tmp, "plugins/claude-code-activation/runbooks/dangle.md");
      fs.symlinkSync(path.join(tmp, "plugins/claude-code-activation/runbooks/no-such-target.md"), link);
      m.runbook.full = "plugins/claude-code-activation/runbooks/dangle.md";
    });
    // (e) sibling-prefix dir (plugins/claude-code-activation-evil) is NOT inside authority -> path_outside_authority.
    runActivationScenario("runbook sibling-prefix escape -> A-runbook/path_outside_authority", "A-runbook", "path_outside_authority", (tmp, m) => {
      const sib = path.join(tmp, "plugins/claude-code-activation-evil/runbooks");
      fs.mkdirSync(sib, { recursive: true });
      fs.writeFileSync(path.join(sib, "activation.md"), "x".repeat(64));
      m.runbook.full = "plugins/claude-code-activation-evil/runbooks/activation.md";
    });
  }
}

// ===========================================================================
// Helpers.
// ===========================================================================
function mkdtemp() { return fs.mkdtempSync(path.join(os.tmpdir(), "tam-")); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function symlinkCapable() {
  const t = mkdtemp();
  try { fs.writeFileSync(path.join(t, "a"), "a"); fs.symlinkSync(path.join(t, "a"), path.join(t, "b")); return true; }
  catch { return false; }
  finally { rmrf(t); }
}

// Lay down a FULL activation plugin project in a temp dir: loadContext's schema/
// data files + the io schema + the plugin dir (hooks + runbooks) so every check
// but the mutated one is green. Returns the temp root.
function buildActivationProject(tmp) {
  buildMinimalContext(tmp); // CONTEXT_FILES (schemas + taxonomy/events + bypass_known + activation-manifest.schema)
  fs.copyFileSync(path.join(REPO, "schemas/runtime/activation-io.schema.json"), (() => {
    const d = path.join(tmp, "schemas/runtime/activation-io.schema.json");
    fs.mkdirSync(path.dirname(d), { recursive: true });
    return d;
  })());
  const pd = path.join(tmp, "plugins/claude-code-activation");
  fs.mkdirSync(path.join(pd, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(pd, "runbooks"), { recursive: true });
  for (const h of manifest.registrations.map((r) => r.file)) {
    fs.copyFileSync(path.join(PLUGIN_DIR, "hooks", h), path.join(pd, "hooks", h));
  }
  for (const rb of ["activation.md", "activation.quickref.md"]) {
    fs.copyFileSync(path.join(PLUGIN_DIR, "runbooks", rb), path.join(pd, "runbooks", rb));
  }
  return tmp;
}

// Build the project, apply `mutate(tmp, manifestClone)`, write the (possibly
// mutated) manifest, run the validator, assert status fail + the attributed
// check/keyword. Cleans up the temp dir.
function runActivationScenario(label, check, keyword, mutate) {
  const tmp = mkdtemp();
  try {
    buildActivationProject(tmp);
    const m = structuredClone(manifest);
    mutate(tmp, m);
    fs.writeFileSync(path.join(tmp, "m.json"), JSON.stringify(m));
    const r = validateRegistry({ projectRoot: tmp, manifestPath: "m.json" });
    assert(
      r.status === "fail" && r.violations.some((v) => v.check === check && v.keyword === keyword),
      `${label}`,
      `status=${r.status} violations=${JSON.stringify(r.violations.slice(0, 4))}`,
    );
  } finally {
    rmrf(tmp);
  }
}

console.log(`\ntest-activation-manifest: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all activation-manifest conformance checks passed");
