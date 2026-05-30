// test-p0-schemas.mjs — RFC-008 P0 validity-verification gate (v11.8).
//
// Proves "each schema is itself a valid JSON-Schema 2020-12 doc" (the P0
// done-when) under the zero-dep constraint, via the test-only keyword-grammar
// linter tests/lib/mini-jsonschema.mjs. Also asserts all 20 P0 files exist and
// parse, and that the negative corpus (including the deep fail-open cases the
// R0b plan review surfaced) is rejected.
//
// Run: node tests/test-p0-schemas.mjs    (exit 0 = pass, non-zero = fail)

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  lintSchema,
  assertSelfConsistent,
  ALLOWLIST,
  SUBSCHEMA_KEYWORDS,
  VALUE_GRAMMAR,
} from "./lib/mini-jsonschema.mjs";
import { taxonomyVersion, eventsVersion } from "./lib/version-hash.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) {
  pass++;
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}${detail ? " — " + detail : ""}`);
}
function assert(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

// ---------------------------------------------------------------------------
// The 17 schema docs (linted as 2020-12) + 3 data files (existence/parse only).
// ---------------------------------------------------------------------------
const SCHEMA_DOCS = [
  "patterns/taxonomy.schema.json",
  "patterns/events.schema.json",
  "patterns/schema.json",
  "plugins/manifest.schema.json",
  "plugins/_index.schema.json",
  "plugins/installed-state.schema.json",
  "plugins/bypass_known.schema.json",
  "schemas/events/event-pre-tool-use.schema.json",
  "schemas/events/event-tool-result.schema.json",
  "schemas/events/event-stop.schema.json",
  "schemas/events/event-session-start.schema.json",
  "schemas/events/event-session-end.schema.json",
  "schemas/runtime/classifier-output.schema.json",
  "schemas/runtime/adapter-call.schema.json",
  "schemas/runtime/adapter-response.schema.json",
  "schemas/runtime/structured-alert.schema.json",
  "schemas/runbook-agent-manifest.schema.json",
];

const DATA_FILES = [
  "patterns/taxonomy.json",
  "patterns/events.json",
  "plugins/bypass_known.json",
];

// ---------------------------------------------------------------------------
// 1. Linter self-assertion (recurse-set completeness) — the R0b R3 guard.
// ---------------------------------------------------------------------------
try {
  assertSelfConsistent();
  ok("linter self-assertion: SUBSCHEMA_KEYWORDS ∪ VALUE_GRAMMAR == ALLOWLIST");
} catch (e) {
  bad("linter self-assertion", e.message);
}
assert(
  ALLOWLIST.size === 57,
  "allowlist cardinality is 57 (2020-12 keyword count)",
  `got ${ALLOWLIST.size}`,
);
assert(
  Object.keys(SUBSCHEMA_KEYWORDS).length === 19,
  "SUBSCHEMA_KEYWORDS cardinality is 19",
  `got ${Object.keys(SUBSCHEMA_KEYWORDS).length}`,
);
assert(
  Object.keys(VALUE_GRAMMAR).length === 38,
  "VALUE_GRAMMAR cardinality is 38",
  `got ${Object.keys(VALUE_GRAMMAR).length}`,
);

// ---------------------------------------------------------------------------
// 2. All 20 P0 files exist and parse as JSON.
// ---------------------------------------------------------------------------
const allFiles = [...SCHEMA_DOCS, ...DATA_FILES];
assert(allFiles.length === 20, "P0 file count is 20 (17 schemas + 3 data)", `got ${allFiles.length}`);

const parsed = {};
for (const rel of allFiles) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    bad(`exists: ${rel}`, "missing");
    continue;
  }
  try {
    parsed[rel] = JSON.parse(readFileSync(abs, "utf8"));
    ok(`exists + parses: ${rel}`);
  } catch (e) {
    bad(`parses: ${rel}`, e.message);
  }
}

// ---------------------------------------------------------------------------
// 3. POSITIVE: every schema doc is a valid 2020-12 doc per the linter.
// ---------------------------------------------------------------------------
for (const rel of SCHEMA_DOCS) {
  if (!parsed[rel]) continue; // already reported missing/unparseable
  const { valid, errors } = lintSchema(parsed[rel]);
  assert(valid, `lints clean: ${rel}`, errors.slice(0, 4).join(" | "));
}

// ---------------------------------------------------------------------------
// 4. NEGATIVE corpus — each MUST be rejected. Includes the deep fail-open
//    cases the R0b review (R3) demanded: subschema nested under propertyNames /
//    unevaluatedProperties / dependentSchemas.
// ---------------------------------------------------------------------------
const NEGATIVE = [
  ["items-is-array (R2)", { $schema: "https://json-schema.org/draft/2020-12/schema", items: [] }],
  ["required-is-string", { required: "x" }],
  ["type-banana", { type: "banana" }],
  ["properties-is-array", { properties: [] }],
  ["unknown-keyword (requiredd)", { requiredd: [] }],
  ["properties-value-not-schema", { properties: { a: [] } }],
  ["nested-bad-type-under-items", { items: { type: "strng" } }],
  ["deep: propertyNames.items=[]", { propertyNames: { items: [] } }],
  ["deep: unevaluatedProperties.type=banana", { unevaluatedProperties: { type: "banana" } }],
  ["deep: dependentSchemas.a.items=[]", { dependentSchemas: { a: { items: [] } } }],
  ["deep: allOf element bad", { allOf: [{ type: "banana" }] }],
  ["deep: contentSchema.items=[]", { contentSchema: { items: [] } }],
  ["enum-not-array", { enum: "x" }],
  ["minLength-negative", { minLength: -1 }],
];
for (const [name, schema] of NEGATIVE) {
  const { valid } = lintSchema(schema);
  assert(!valid, `rejects: ${name}`, "linter accepted an invalid schema (fail-open)");
}

// ---------------------------------------------------------------------------
// 5. POSITIVE sanity — a couple of hand-rolled valid schemas must pass.
// ---------------------------------------------------------------------------
const POSITIVE = [
  ["minimal object", { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }],
  ["items-as-schema", { type: "array", items: { type: "string" } }],
  ["if-then-else", { if: { required: ["a"] }, then: { type: "object" }, else: { type: "null" } }],
  ["type-array", { type: ["string", "null"] }],
];
for (const [name, schema] of POSITIVE) {
  const { valid, errors } = lintSchema(schema);
  assert(valid, `accepts: ${name}`, errors.join(" | "));
}

// ---------------------------------------------------------------------------
// 6. Golden corpus is staged (done-when: fixtures staged for P1/P2/P3).
// ---------------------------------------------------------------------------
const FIXDIR = join(REPO_ROOT, "tests/fixtures/plugins");
const corpusFiles = readdirSync(FIXDIR).filter(
  (f) => f.endsWith(".json") && f !== "_corpus-index.json" && f !== "non-overridable-inputs.json",
);
assert(corpusFiles.length >= 16, "golden corpus has >= 16 fixtures (M10)", `got ${corpusFiles.length}`);

let corpusIndex = null;
try {
  corpusIndex = JSON.parse(readFileSync(join(FIXDIR, "_corpus-index.json"), "utf8"));
  ok("_corpus-index.json parses");
} catch (e) {
  bad("_corpus-index.json parses", e.message);
}

if (corpusIndex) {
  for (const name of Object.keys(corpusIndex.fixtures || {})) {
    assert(existsSync(join(FIXDIR, name)), `corpus-index entry exists on disk: ${name}`, "referenced but missing");
  }
  // good-manifest's baked hashes must still match the live taxonomy/events
  // (guards against silent drift if the data files change without re-baking).
  const t = JSON.parse(readFileSync(join(REPO_ROOT, "patterns/taxonomy.json"), "utf8"));
  const ev = JSON.parse(readFileSync(join(REPO_ROOT, "patterns/events.json"), "utf8"));
  const c = corpusIndex.hash_serialization_contract || {};
  assert(
    c.taxonomy_version && c.taxonomy_version.value === taxonomyVersion(t),
    "corpus-index taxonomy_version matches live taxonomy.json",
    `index=${c.taxonomy_version && c.taxonomy_version.value} live=${taxonomyVersion(t)}`,
  );
  assert(
    c.events_version && c.events_version.value === eventsVersion(ev),
    "corpus-index events_version matches live events.json",
    `index=${c.events_version && c.events_version.value} live=${eventsVersion(ev)}`,
  );
  const gm = JSON.parse(readFileSync(join(FIXDIR, "good-manifest.json"), "utf8"));
  assert(gm.taxonomy_version === taxonomyVersion(t), "good-manifest taxonomy_version matches live taxonomy.json");
  assert(gm.events_version === eventsVersion(ev), "good-manifest events_version matches live events.json");
}

// harness-event fixtures staged
for (const f of ["pre-tool-use.json", "stop.json", "session-start.json", "session-end.json"]) {
  assert(
    existsSync(join(REPO_ROOT, "tests/fixtures/harness-events/claude-code", f)),
    `harness-event fixture staged: claude-code/${f}`,
    "missing",
  );
}

// ---------------------------------------------------------------------------
// 7. R8 typed + versioned registry contract (R0b' amendment).
//    Schema-shape assertions (P0-runnable; instance validation is P1) + the
//    Rule-14 CURRENT_SCHEMA_VERSION drift guard, asserted NON-VACUOUSLY.
// ---------------------------------------------------------------------------
const idxSchema = parsed["plugins/_index.schema.json"];
const manSchema = parsed["plugins/manifest.schema.json"];

if (idxSchema && manSchema) {
  // --- typed-registry (R8 line 116): closed pluginType + per-type type discriminator
  const pt = idxSchema.$defs && idxSchema.$defs.pluginType;
  assert(
    pt && Array.isArray(pt.enum) && pt.enum.length === 4 &&
      ["enforcement", "recall-strategy", "store-strategy", "learning"].every((v) => pt.enum.includes(v)),
    "_index $defs.pluginType is the closed 4-value type space (R8-116)",
    `got ${pt && JSON.stringify(pt.enum)}`,
  );
  assert(
    idxSchema.$defs.enforcementDescriptor &&
      idxSchema.$defs.enforcementDescriptor.required.includes("type"),
    "_index enforcementDescriptor requires `type` (R8-116)",
  );
  assert(
    idxSchema.$defs.recallStrategyDescriptor &&
      idxSchema.$defs.recallStrategyDescriptor.required.includes("type"),
    "_index recallStrategyDescriptor requires `type` (R8-116)",
  );
  assert(
    manSchema.required.includes("type") &&
      manSchema.properties.type && manSchema.properties.type.const === "enforcement",
    "manifest requires `type` const enforcement (R8-116, enforcement descriptor)",
  );

  // --- versioned-contract (R8 line 118): required schema_version, semver PATTERN not const
  assert(idxSchema.required.includes("schema_version"), "_index requires schema_version (R8-118)");
  assert(manSchema.required.includes("schema_version"), "manifest requires schema_version (R8-118)");
  for (const [label, sch] of [["_index", idxSchema], ["manifest", manSchema]]) {
    const sv = sch.properties.schema_version;
    assert(sv && sv.$ref === "#/$defs/semver", `${label} schema_version is {$ref: semver} (R8-118)`, JSON.stringify(sv));
    const semver = sch.$defs && sch.$defs.semver;
    // PATTERN, not pinned const — pinning would break backward-compat (a const-1.0.0
    // schema could not read a 1.1.0 registry the newer validator must accept).
    assert(
      semver && typeof semver.pattern === "string" && semver.const === undefined,
      `${label} $defs.semver is a pattern, NOT a pinned const (R8-118 backward-compat)`,
      JSON.stringify(semver),
    );
  }

  // --- top-level closure is the STATIC fail-closed for unknown future keys (R8-118 forward)
  assert(
    idxSchema.additionalProperties === false,
    "_index keeps top-level additionalProperties:false (static fail-closed for unknown future top-level keys)",
  );

  // --- Rule-14 CURRENT_SCHEMA_VERSION drift guard, asserted NON-VACUOUSLY (codex R2-FU).
  if (corpusIndex) {
    const oracle =
      corpusIndex.current_schema_version && corpusIndex.current_schema_version.value;
    assert(typeof oracle === "string", "_corpus-index declares current_schema_version oracle", `got ${oracle}`);
    // Every EXPECT-PASS fixture instance declaring schema_version must byte-equal the oracle.
    // Negative fixtures intentionally carry wrong/missing versions and are excluded.
    let versionedPassInstances = 0;
    for (const [name, meta] of Object.entries(corpusIndex.fixtures || {})) {
      if (!meta || meta.expect !== "pass") continue;
      let inst;
      try {
        inst = JSON.parse(readFileSync(join(FIXDIR, name), "utf8"));
      } catch {
        continue; // existence/parse already reported in section 6
      }
      if (typeof inst.schema_version === "string") {
        versionedPassInstances++;
        assert(
          inst.schema_version === oracle,
          `CURRENT_SCHEMA_VERSION drift: ${name}.schema_version == oracle`,
          `instance=${inst.schema_version} oracle=${oracle}`,
        );
      }
    }
    // Non-vacuity: the manifest side must be covered by >=1 real instance, else the
    // equality silently passes against an empty set. (Registry-instance non-vacuity is
    // a P1 obligation, since plugins/_index.json does not exist until P1.)
    assert(
      versionedPassInstances >= 1,
      "drift guard is non-vacuous: >=1 expect-pass instance declares schema_version (R8-118; codex R2-FU)",
      `got ${versionedPassInstances}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------
console.log(`\ntest-p0-schemas: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all P0 schema-validity checks passed");
