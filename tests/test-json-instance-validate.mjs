// test-json-instance-validate.mjs — unit tests for the closed-subset instance
// validator (RFC-008 R0c P1b §8 instance-validator tests 1-7 + value-shape).
//
// Run: node tests/test-json-instance-validate.mjs   (exit 0 = pass)
//
// Verifies the THREE closure properties (fail-closed, not fail-open) the codex
// F-c1 / planner GAP-3 / claude-subagent F2 review chain peeled apart:
//   (a) unmodeled keyword NAME  -> SchemaModelingError
//   (b) unmodeled VALUE-SHAPE   -> SchemaModelingError
//   (c) scan-set == interpret-set (assertAllSchemasModeled over the live 5)
// plus correct interpretation of additionalProperties(bool|schema), oneOf,
// $ref, propertyNames(KEY-semantic), if/then/else+not, const(any-JSON).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  validateInstance,
  assertSchemaModeled,
  assertAllSchemasModeled,
  SchemaModelingError,
} from "../scripts/lib/json-instance-validate.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; }
function bad(n, d) { fail++; failures.push(`${n}${d ? " — " + d : ""}`); }
function assert(c, n, d) { c ? ok(n) : bad(n, d); }
function throws(fn, n) {
  try { fn(); bad(n, "expected throw, none thrown"); }
  catch (e) { e instanceof SchemaModelingError ? ok(n) : bad(n, `wrong error: ${e}`); }
}

// The 5 interpreted schemas — single registry drives scan-set == interpret-set.
const SCHEMAS = {
  _index: read("plugins/_index.schema.json"),
  manifest: read("plugins/manifest.schema.json"),
  bypass_known: read("plugins/bypass_known.schema.json"),
  installed_state: read("plugins/installed-state.schema.json"),
  structured_alert: read("schemas/runtime/structured-alert.schema.json"),
};
const S = SCHEMAS;

// --- closure (c): the live 5 are all modeled -------------------------------
try {
  assertAllSchemasModeled(SCHEMAS);
  ok("assertAllSchemasModeled: live 5 schemas all use the modeled subset");
} catch (e) {
  bad("assertAllSchemasModeled", e.message);
}

// --- positive: good-manifest validates against manifest.schema -------------
{
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const { valid, errors } = validateInstance(gm, S.manifest);
  assert(valid, "good-manifest.json validates against manifest.schema", JSON.stringify(errors.slice(0, 3)));
}

// --- test (a): additionalProperties:false rejected at TOP and NESTED level -
{
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const topExtra = { ...gm, unexpected_top: 1 };
  let r = validateInstance(topExtra, S.manifest);
  assert(!r.valid && r.errors.some((e) => e.keyword === "additionalProperties"),
    "additionalProperties:false rejects extra TOP-level key", JSON.stringify(r.errors.slice(0, 2)));

  const nestedExtra = JSON.parse(JSON.stringify(gm));
  nestedExtra.classifier.bogus_nested = true;
  r = validateInstance(nestedExtra, S.manifest);
  assert(!r.valid && r.errors.some((e) => e.keyword === "additionalProperties"),
    "additionalProperties:false rejects extra NESTED key (classifier.*)", JSON.stringify(r.errors.slice(0, 2)));
}

// --- test (2): oneOf — both-match AND neither-match rejected, one-match ok --
{
  // bypass record branch 1 (ceiling) vs branch 2 (clean-audit).
  const recSchema = S.bypass_known.$defs.record;
  const wrapRoot = S.bypass_known; // $ref resolves against the bypass root
  const clean = { harness: "claude-code", event: "stop", no_known_bypass_evidence: true,
    last_audited_iso8601: "2026-06-06T00:00:00Z", auditor: "rfc008-p1b" };
  const ceiling = { harness: "codex", event: "pre_tool_use", ceiling: "MEDIUM", citation: "x" };
  // Validate a single record by wrapping records:[rec] through the full schema.
  const oneRec = (rec) => validateInstance({ records: [rec] }, wrapRoot);
  assert(oneRec(clean).valid, "oneOf: clean-audit record matches exactly one branch", JSON.stringify(oneRec(clean).errors));
  assert(oneRec(ceiling).valid, "oneOf: ceiling record matches exactly one branch", JSON.stringify(oneRec(ceiling).errors));
  // neither branch: missing the discriminating fields of both.
  const neither = { harness: "claude-code", event: "stop" };
  let r = oneRec(neither);
  assert(!r.valid && r.errors.some((e) => e.keyword === "oneOf"), "oneOf: neither-branch-match rejected");
  // both branches: carry ceiling AND no_known_bypass_evidence -> additionalProperties:false
  // in each branch makes neither validate, so this is also a oneOf!=1 case; assert reject.
  const both = { harness: "claude-code", event: "stop", ceiling: "MEDIUM", citation: "x",
    no_known_bypass_evidence: true, last_audited_iso8601: "2026-06-06T00:00:00Z", auditor: "z" };
  r = oneRec(both);
  assert(!r.valid && r.errors.some((e) => e.keyword === "oneOf"), "oneOf: both-branch superset rejected");
}

// --- test (3): $ref "#/$defs/semver" actually resolved --------------------
{
  // manifest.version is {$ref:#/$defs/semver}; a non-semver must fail via pattern.
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const badVer = { ...gm, version: "1.0" };
  const r = validateInstance(badVer, S.manifest);
  assert(!r.valid && r.errors.some((e) => e.keyword === "pattern"),
    "$ref:#/$defs/semver resolved — non-semver version fails via pattern", JSON.stringify(r.errors.slice(0, 2)));
}

// --- test (4): self-assertion fires on unmodeled keyword NAME + VALUE-SHAPE -
{
  // unmodeled keyword name (anyOf is deliberately absent).
  throws(() => assertSchemaModeled({ type: "object", anyOf: [{ type: "string" }] }),
    "self-assertion: unmodeled keyword `anyOf` -> SchemaModelingError");
  throws(() => assertSchemaModeled({ patternProperties: { "^x": { type: "string" } } }),
    "self-assertion: unmodeled keyword `patternProperties` -> SchemaModelingError");
  // unmodeled VALUE-SHAPE: additionalProperties as an ARRAY (only bool|schema modeled).
  throws(() => assertSchemaModeled({ type: "object", additionalProperties: ["x"] }),
    "self-assertion: additionalProperties array value-shape -> SchemaModelingError (codex F-c1)");
  // unmodeled VALUE-SHAPE: type as a number.
  throws(() => assertSchemaModeled({ type: 42 }),
    "self-assertion: type non-string/array value-shape -> SchemaModelingError");
  // and validateInstance refuses an un-vetted schema (scan==interpret).
  throws(() => validateInstance({}, { type: "object", contains: { type: "string" } }),
    "validateInstance refuses a schema with unmodeled `contains` (scan==interpret)");
}

// --- test value-shape (1): schema-valued additionalProperties RECURSE ------
{
  // manifest.event_translations.<key>.field_bindings.additionalProperties:{type:string}
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const badBinding = JSON.parse(JSON.stringify(gm));
  badBinding.event_translations.pre_tool_use.field_bindings.tool = 123; // number, not string
  const r = validateInstance(badBinding, S.manifest);
  assert(!r.valid && r.errors.some((e) => e.keyword === "type"),
    "value-shape: schema-valued additionalProperties recurses (non-string field_binding fails)",
    JSON.stringify(r.errors.slice(0, 2)));
}

// --- test value-shape (2): event_translations value via $ref recursion -----
{
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const badTrans = JSON.parse(JSON.stringify(gm));
  delete badTrans.event_translations.stop.source_format; // eventTranslation requires it
  const r = validateInstance(badTrans, S.manifest);
  assert(!r.valid && r.errors.some((e) => e.keyword === "required"),
    "value-shape: additionalProperties:{$ref} recurses into eventTranslation (missing source_format fails)",
    JSON.stringify(r.errors.slice(0, 2)));
}

// --- test value-shape (3): array-valued type (["string","null"]) ----------
{
  // structured-alert.emitted_label is type ["string","null"].
  const base = {
    alert_type: "classifier_out_of_vocabulary", plugin_id: "p", harness: "claude-code",
    emitted_label: "x", emitted_event_id: null, events_version: null, command: "",
    timestamp_iso8601: "2026-06-06T00:00:00Z", project_root: "/r", store_root: "/r",
    store_scope: "local", episode_file: "/r/e.md",
  };
  assert(validateInstance(base, S.structured_alert).valid,
    "value-shape: array type accepts the string branch", JSON.stringify(validateInstance(base, S.structured_alert).errors.slice(0, 2)));
  // null branch on a field that is array-typed: emitted_event_id null is fine here.
  const numField = { ...base, emitted_label: 123 }; // neither string nor null
  const r = validateInstance(numField, S.structured_alert);
  assert(!r.valid && r.errors.some((e) => e.keyword === "type"),
    "value-shape: array type rejects non-string/non-null (number)", JSON.stringify(r.errors.slice(0, 2)));
}

// --- test value-shape (5): boolean const (no_known_bypass_evidence:true) ---
{
  const wrapRoot = S.bypass_known;
  const falseEvidence = { harness: "claude-code", event: "stop", no_known_bypass_evidence: false,
    last_audited_iso8601: "2026-06-06T00:00:00Z", auditor: "z" };
  const r = validateInstance({ records: [falseEvidence] }, wrapRoot);
  // const:true means {no_known_bypass_evidence:false} fails branch-2; lacking
  // ceiling/citation it also fails branch-1 -> oneOf!=1.
  assert(!r.valid, "value-shape: boolean const:true rejects no_known_bypass_evidence:false (deep-equal, not string-only)",
    JSON.stringify(r.errors.slice(0, 2)));
}

// --- test value-shape (6): annotation no-op (real schemas carry $schema/$id) -
{
  // assertAllSchemasModeled above already passed despite every schema carrying
  // $schema/$id/title/description — assert explicitly that an isolated
  // annotation-only schema does not trip fail-on-unmodeled.
  try {
    assertSchemaModeled({ $schema: "x", $id: "y", title: "t", description: "d", $comment: "c", type: "object" });
    ok("value-shape: annotation keywords are explicit no-ops (not unmodeled-keyword errors)");
  } catch (e) {
    bad("value-shape: annotation no-op", e.message);
  }
}

// --- test (7): propertyNames is KEY-semantic, not value-semantic -----------
{
  // manifest.event_translations.propertyNames:{pattern:^[a-z][a-z0-9_]*$}.
  // A bad KEY must fail via propertyNames (the value would still be a valid
  // eventTranslation, so only a KEY-applied subschema can catch it).
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const badKey = JSON.parse(JSON.stringify(gm));
  badKey.event_translations["BadKey"] = badKey.event_translations.stop; // valid VALUE, bad KEY
  const r = validateInstance(badKey, S.manifest);
  assert(!r.valid && r.errors.some((e) => e.keyword === "propertyNames"),
    "test(7): propertyNames applies subschema to KEYS (BadKey rejected via propertyNames)",
    JSON.stringify(r.errors.slice(0, 2)));
}

// --- if/then/else + not: default-mode manifest with override_path fails ----
{
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  const defWithOverride = JSON.parse(JSON.stringify(gm)); // mode:default
  defWithOverride.classifier.override_path = "x/y.mjs";
  const r = validateInstance(defWithOverride, S.manifest);
  // else -> not:{required:[override_path]} -> present override_path fails `not`.
  assert(!r.valid && r.errors.some((e) => e.keyword === "not"),
    "if/then/else+not: default-mode + override_path fails via else->not", JSON.stringify(r.errors.slice(0, 2)));
  // and the override branch: mode:override WITHOUT override_path fails `then->required`.
  const overrideNoPath = JSON.parse(JSON.stringify(gm));
  overrideNoPath.classifier.mode = "override";
  const r2 = validateInstance(overrideNoPath, S.manifest);
  assert(!r2.valid && r2.errors.some((e) => e.keyword === "required"),
    "if/then/else: override mode without override_path fails via then->required", JSON.stringify(r2.errors.slice(0, 2)));
}

// --- allOf member + items element failure pins (cheap, per R3-1 note) ------
{
  const gm = read("tests/fixtures/plugins/good-manifest.json");
  // emits_labels items are labelId pattern ^[a-z][a-z0-9_]*$; inject an invalid one.
  const badLabel = JSON.parse(JSON.stringify(gm));
  badLabel.classifier.emits_labels = [...badLabel.classifier.emits_labels, "Bad-Label"];
  const r = validateInstance(badLabel, S.manifest);
  assert(!r.valid && r.errors.some((e) => e.keyword === "pattern"),
    "items: an invalid emits_labels element fails via items->pattern", JSON.stringify(r.errors.slice(0, 2)));
}

// ===========================================================================
// C0 (RFC-008 R0c P1c) — `minimum` + `maxItems` modeled. The event schemas and
// runbook-agent-manifest (P1c's NEW validateInstance consumers) use keywords
// that were on the fail-closed ABSENT list; without C0 they throw
// SchemaModelingError before any instance check (claude-subagent F1, verified
// on disk: event-*.schema use `minimum:0` on turn_index; runbook-agent-manifest
// uses `maxItems:0` on command_shapes).
// ===========================================================================

// --- C0 closure: the P1c consumer schemas are now all modeled --------------
const P1C_SCHEMAS = {
  event_pre_tool_use: read("schemas/events/event-pre-tool-use.schema.json"),
  event_stop: read("schemas/events/event-stop.schema.json"),
  event_session_start: read("schemas/events/event-session-start.schema.json"),
  event_session_end: read("schemas/events/event-session-end.schema.json"),
  event_tool_result: read("schemas/events/event-tool-result.schema.json"),
  runbook_agent_manifest: read("schemas/runbook-agent-manifest.schema.json"),
};
try {
  assertAllSchemasModeled(P1C_SCHEMAS);
  ok("C0 closure: event-* + runbook-agent-manifest schemas all modeled (no SchemaModelingError)");
} catch (e) {
  bad("C0 closure: P1c consumer schemas modeled", e.message);
}

// --- C0 `minimum`: positive + negative + boundary over a real event schema --
{
  const ev = P1C_SCHEMAS.event_pre_tool_use;
  const base = {
    tool: "Bash", tool_args: { command: "ls" }, cwd: "/r",
    session_id: "s", turn_index: 3, timestamp_iso8601: "2026-06-06T00:00:00Z",
  };
  assert(validateInstance(base, ev).valid,
    "C0 minimum: turn_index 3 satisfies `minimum:0`", JSON.stringify(validateInstance(base, ev).errors.slice(0, 2)));
  const below = { ...base, turn_index: -1 };
  const r = validateInstance(below, ev);
  assert(!r.valid && r.errors.some((e) => e.keyword === "minimum"),
    "C0 minimum: turn_index -1 fails via `minimum`", JSON.stringify(r.errors.slice(0, 2)));
  assert(validateInstance({ ...base, turn_index: 0 }, ev).valid, "C0 minimum: turn_index 0 (== bound) passes");
}

// --- C0 `minimum`: negative/float BOUND admitted (value-shape number, not nonNegInt)
{
  const negSchema = { type: "number", minimum: -2.5 };
  assert(validateInstance(-1, negSchema).valid, "C0 minimum: -1 satisfies minimum:-2.5 (negative/float bound)");
  const r = validateInstance(-10, negSchema);
  assert(!r.valid && r.errors.some((e) => e.keyword === "minimum"), "C0 minimum: -10 fails minimum:-2.5");
}

// --- C0 `maxItems`: positive + negative over the agent-manifest static-rules -
{
  const ram = P1C_SCHEMAS.runbook_agent_manifest;
  const staticOk = {
    invocation_modality: "static-rules", command_shapes: [], required_args: [], optional_args: [],
    expected_outputs: { shape: "exit-code-only" }, env_requirements: [], return_codes: { "0": "ok" },
    dispatch_examples: [{ description: "deploy rules file" }],
  };
  assert(validateInstance(staticOk, ram).valid,
    "C0 maxItems: static-rules manifest with command_shapes:[] passes maxItems:0",
    JSON.stringify(validateInstance(staticOk, ram).errors.slice(0, 3)));
  const staticBad = { ...staticOk, command_shapes: [["python", "x"]] }; // 1 item > maxItems:0
  const r = validateInstance(staticBad, ram);
  assert(!r.valid && r.errors.some((e) => e.keyword === "maxItems"),
    "C0 maxItems: static-rules with a non-empty command_shapes fails via `maxItems`", JSON.stringify(r.errors.slice(0, 3)));
}

// --- C0 value-shape: malformed BOUNDS fail closed; `maximum` stays unmodeled -
{
  throws(() => assertSchemaModeled({ type: "integer", minimum: "0" }),
    "C0 value-shape: `minimum` with a string bound -> SchemaModelingError");
  throws(() => assertSchemaModeled({ type: "array", maxItems: -1 }),
    "C0 value-shape: `maxItems` with a negative bound -> SchemaModelingError");
  throws(() => assertSchemaModeled({ type: "array", maxItems: 1.5 }),
    "C0 value-shape: `maxItems` with a non-integer bound -> SchemaModelingError");
  throws(() => assertSchemaModeled({ type: "number", maximum: 10 }),
    "C0 value-shape: `maximum` still unmodeled -> SchemaModelingError (only minimum added, not maximum)");
}

console.log(`\ntest-json-instance-validate: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all instance-validator closure + interpretation checks passed");
