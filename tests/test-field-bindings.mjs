// test-field-bindings.mjs — unit tests for the closed-grammar field_bindings
// interpreter (RFC-008 R0c P1c C1; F39). Run: node tests/test-field-bindings.mjs
//
// Covers every directive form (positive) + the full fail-closed boundary (H3 in
// the P1c plan: an unknown directive must THROW, never echo into the payload).
// The integration case replays the real pre-tool-use fixture through the real
// good-manifest pre_tool_use bindings — the same path the gauntlet step 8 uses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { interpretBindings, FieldBindingError } from "../scripts/lib/field-bindings.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; }
function bad(n, d) { fail++; failures.push(`${n}${d ? " — " + d : ""}`); }
function assert(c, n, d) { c ? ok(n) : bad(n, d); }
function eq(actual, expected, n) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), n, `got ${JSON.stringify(actual)}`);
}
function throwsFB(fn, n) {
  try { fn(); bad(n, "expected FieldBindingError, none thrown"); }
  catch (e) { e instanceof FieldBindingError ? ok(n) : bad(n, `wrong error: ${e}`); }
}

const RAW = {
  session_id: "s-123",
  cwd: "/repo",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  transcript: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
  reason: "clear",
  nested: { deep: { leaf: 7 } },
};
const NOW = "2026-06-07T00:00:00Z";

// --- positive: each directive form -----------------------------------------
eq(interpretBindings({ x: "$.tool_name" }, RAW), { x: "Bash" }, "$.path — scalar lookup");
eq(interpretBindings({ x: "$.tool_input" }, RAW), { x: { command: "ls" } }, "$.path — object value returned as-is");
eq(interpretBindings({ x: "$.nested.deep.leaf" }, RAW), { x: 7 }, "$.a.b.c — deep nested lookup");
eq(interpretBindings({ x: "$.transcript.length" }, RAW), { x: 3 }, "$.x.length — array length");
eq(interpretBindings({ x: "$.cwd.length" }, RAW), { x: 5 }, "$.x.length — string length");
eq(interpretBindings({ x: "$$now" }, RAW, { now: NOW }), { x: NOW }, "$$now — injected timestamp");
eq(interpretBindings({ x: "$$const:claude-code" }, RAW), { x: "claude-code" }, "$$const:VALUE — literal");
eq(interpretBindings({ x: "$$const:" }, RAW), { x: "" }, "$$const: — empty literal allowed");
eq(interpretBindings({ x: "$$const:$.foo" }, RAW), { x: "$.foo" }, "$$const:$.foo — const value NOT re-interpreted");
eq(interpretBindings({}, RAW), {}, "empty bindings -> empty payload");

// --- integration: real fixture through real good-manifest bindings ----------
{
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const raw = read("tests/fixtures/harness-events/claude-code/pre-tool-use.json");
  const bindings = gm.event_translations.pre_tool_use.field_bindings;
  const payload = interpretBindings(bindings, raw, { now: NOW });
  eq(payload, {
    tool: "Bash",
    tool_args: { command: "git push origin main" },
    session_id: "8157082d-1c2a-4c40-a3b1-4a8d50475042",
    cwd: "/Users/juan.delacruz/repo",
    turn_index: 3,
    timestamp_iso8601: NOW,
  }, "integration: pre-tool-use fixture -> canonical payload (F39 step-8 path)");
}

// --- negative: the fail-closed boundary (H3 — never echo, always throw) -----
throwsFB(() => interpretBindings({ x: "$$env:HOME" }, RAW), "unknown $$macro ($$env:) throws");
throwsFB(() => interpretBindings({ x: "claude-code" }, RAW), "bare string (no directive prefix) throws");
throwsFB(() => interpretBindings({ x: "$$nowx" }, RAW, { now: NOW }), "$$nowx (close-but-not-$$now) throws");
throwsFB(() => interpretBindings({ x: "$$now " }, RAW, { now: NOW }), "$$now with trailing space throws (strict)");
throwsFB(() => interpretBindings({ x: "$$const" }, RAW), "$$const without colon throws");
throwsFB(() => interpretBindings({ x: "$.x[0]" }, RAW), "$.x[0] bracket/index throws");
throwsFB(() => interpretBindings({ x: "$." }, RAW), "$. empty path throws");
throwsFB(() => interpretBindings({ x: "$.nope" }, RAW), "missing leaf path throws");
throwsFB(() => interpretBindings({ x: "$.nested.missing.leaf" }, RAW), "missing intermediate path throws");
throwsFB(() => interpretBindings({ x: "$.tool_input.length" }, RAW), ".length on an object throws");
throwsFB(() => interpretBindings({ x: "$.transcript.role" }, RAW), "traversal INTO an array throws (arrays are leaves)");
throwsFB(() => interpretBindings({ x: "$.nested.deep.leaf.length" }, RAW), ".length on a number throws");
throwsFB(() => interpretBindings({ x: 123 }, RAW), "non-string directive throws");
throwsFB(() => interpretBindings({ x: "$$now" }, RAW), "$$now without injected now throws");
throwsFB(() => interpretBindings(null, RAW), "non-object bindings throws");
throwsFB(() => interpretBindings([], RAW), "array bindings throws");

// --- negative: the closed grammar holds on the KEY axis too (F2) -------------
// `{ ["__proto__"]: … }` (computed key) is an OWN enumerable property, so
// Object.entries sees it — it must THROW, not no-op or mutate the prototype.
throwsFB(() => interpretBindings({ ["__proto__"]: "$.tool_name" }, RAW), "__proto__ key throws (closed key grammar, F2)");
throwsFB(() => interpretBindings({ _leading: "$.tool_name" }, RAW), "leading-underscore key throws");
throwsFB(() => interpretBindings({ Tool: "$.tool_name" }, RAW), "uppercase-leading key throws");
throwsFB(() => interpretBindings({ "bad-key": "$.tool_name" }, RAW), "hyphen in key throws");
assert(Object.getPrototypeOf(interpretBindings({ tool: "$.tool_name" }, RAW)) === null, "payload is prototype-less (no __proto__ pollution surface, F2)");

console.log(`\ntest-field-bindings: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all field_bindings interpreter checks passed");
