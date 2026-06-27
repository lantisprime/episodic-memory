/**
 * test-opencode-translations.mjs — S2 REQ-3 translation tests.
 * For each of the 4 opencode events, reads the fixture from
 * tests/fixtures/harness-events/opencode/<event>.json, runs the manifest
 * field_bindings via interpretBindings, validates the payload vs
 * schemas/events/event-<event>.schema.json, and asserts:
 *   - valid === true
 *   - payload.session_id === "ses_abc" (sentinel flows through)
 *
 * Plus testEmptySessionIdRejected: clones the pre-tool-use fixture with
 * sessionID:"" → assert invalid (the schema requires minLength:1).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { interpretBindings } from "../scripts/lib/field-bindings.mjs";
import { validateInstance } from "../scripts/lib/json-instance-validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));

let pass = 0, fail = 0;
const failures = [];
const assert = (cond, name, detail = "") => {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
};

const NOW = "2026-01-01T00:00:00Z";
const SENTINEL_SESSION = "ses_abc";

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), "utf8"));
}

const manifest = readJson("plugins/opencode/manifest.json");
const trans = manifest.event_translations;

// Events to test
const events = ["pre_tool_use", "tool_result", "session_start", "stop"];

for (const eventId of events) {
  const dash = eventId.replace(/_/g, "-");
  const fixturePath = `tests/fixtures/harness-events/opencode/${dash}.json`;
  const schemaPath = `schemas/events/event-${dash}.schema.json`;

  let fixture, schema;
  try { fixture = readJson(fixturePath); }
  catch (e) { assert(false, `${eventId}: fixture readable`, e.message); continue; }
  try { schema = readJson(schemaPath); }
  catch (e) { assert(false, `${eventId}: schema readable`, e.message); continue; }

  const bindings = trans[eventId] && trans[eventId].field_bindings;
  if (!bindings) { assert(false, `${eventId}: field_bindings present in manifest`); continue; }

  let payload;
  try {
    payload = interpretBindings(bindings, fixture, { now: NOW });
  } catch (e) {
    assert(false, `${eventId}: interpretBindings succeeds`, e.message);
    continue;
  }

  const v = validateInstance(payload, schema);
  assert(v.valid === true, `${eventId}: payload valid vs event schema`, v.valid ? "" : JSON.stringify((v.errors || []).slice(0, 2)));

  // Sentinel: session_id flows through
  assert(payload.session_id === SENTINEL_SESSION,
    `${eventId}: session_id === "${SENTINEL_SESSION}"`,
    `got: ${JSON.stringify(payload.session_id)}`);
}

// testEmptySessionIdRejected — sessionID:"" → payload invalid (schema minLength:1)
{
  const fixture = readJson("tests/fixtures/harness-events/opencode/pre-tool-use.json");
  const modifiedFixture = { ...fixture, sessionID: "" };
  const bindings = trans.pre_tool_use.field_bindings;
  let payload, didThrow = false;
  try {
    payload = interpretBindings(bindings, modifiedFixture, { now: NOW });
  } catch {
    // interpretBindings doesn't validate length; the schema does
    didThrow = true;
  }
  if (!didThrow) {
    const schema = readJson("schemas/events/event-pre-tool-use.schema.json");
    const v = validateInstance(payload, schema);
    assert(v.valid === false, "testEmptySessionIdRejected: empty sessionID → schema invalid",
      v.valid ? "incorrectly passed schema validation" : "");
  } else {
    // If interpretBindings threw on empty string (possible for non-$.path directives), that's fine too
    assert(true, "testEmptySessionIdRejected: empty sessionID rejected (threw at binding)");
  }
}

console.log(`\ntest-opencode-translations: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all opencode translation tests passed");
