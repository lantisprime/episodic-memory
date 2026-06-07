// field-bindings.mjs — closed-grammar interpreter for manifest event_translations
// `field_bindings` (RFC-008 R0c P1c; F39, gp F2). PURE: translates a raw harness
// event into a canonical event payload by resolving each binding directive. Maps
// to R3 (capability/translation), R6 (plugin↔harness binding), R8 (registry).
//
// This is the FIRST and only interpreter of the directive grammar that
// `plugins/claude-code/manifest.json` (P0 fixture good-manifest.json) commits to.
// It is the claude-code adapter used by the gauntlet's step-8 event replay.
//
// Grammar (CLOSED — anything outside it throws FieldBindingError; the interpreter
// NEVER silently echoes an unrecognized directive into the payload):
//
//   $.a.b.c       dotted-path lookup on the raw event. Each segment matches
//                 /^[A-Za-z_][A-Za-z0-9_]*$/ — no brackets, wildcards, filters,
//                 or array indices. A missing intermediate/leaf, or traversal
//                 INTO an array, throws (arrays are leaves; see `.length`).
//   $.a.b.length  trailing literal `.length` (only as the FINAL segment of a
//                 ≥2-segment path) -> the length of the resolved value, which
//                 MUST be an array or string (else throw). `$.length` alone is
//                 an ordinary property lookup of a field named "length".
//   $$now         ISO-8601 timestamp, taken from the injected `now` option.
//                 NEVER Date.now() inside this pure fn — callers inject
//                 `new Date().toISOString()` so tests stay deterministic.
//   $$const:VALUE the literal string after the colon, verbatim (may be empty).
//
// Fail-closed rationale: an adapter that passed an unknown directive through
// verbatim would inject the literal directive string ("$.foo") into the canonical
// payload, which would then either fail event-schema validation noisily or — for
// a string-typed field — pass silently with garbage. Throwing localizes the bug
// to the binding, not three layers downstream.

export class FieldBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = "FieldBindingError";
  }
}

const SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONST_PREFIX = "$$const:";
// Canonical-field KEY grammar — the same pattern `manifest.schema.json` pins on
// `field_bindings` keys (and `labelId`). The closed grammar must hold on the KEY
// axis too (claude-subagent F2): a key like `__proto__` is outside it and MUST
// throw, never silently no-op or mutate the payload prototype.
const FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Interpret a whole `field_bindings` object into a canonical payload.
 * @param {Object<string,string>} bindings  { canonicalField: directive }
 * @param {*} rawEvent                       the raw harness event (parsed JSON)
 * @param {{now?: string}} [opts]            `now` injected for `$$now` directives
 * @returns {Object} the canonical payload
 * @throws {FieldBindingError} on any directive outside the closed grammar
 */
export function interpretBindings(bindings, rawEvent, opts = {}) {
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new FieldBindingError(`field_bindings must be an object of {field: directive}, got ${describe(bindings)}`);
  }
  const now = opts && typeof opts === "object" ? opts.now : undefined;
  // Prototype-less payload: even if a caller bypasses the schema's propertyNames
  // pin, `payload["__proto__"] = …` cannot reach an inherited accessor (F2 belt).
  const payload = Object.create(null);
  for (const [key, directive] of Object.entries(bindings)) {
    if (!FIELD_KEY_RE.test(key)) {
      throw new FieldBindingError(
        `field_bindings key ${JSON.stringify(key)} is outside the closed key grammar ` +
        `/^[a-z][a-z0-9_]*$/ (keys are canonical field names; e.g. "__proto__" is rejected, not silently mishandled)`,
      );
    }
    payload[key] = interpretDirective(directive, rawEvent, now, key);
  }
  return payload;
}

function interpretDirective(directive, rawEvent, now, key) {
  if (typeof directive !== "string") {
    throw new FieldBindingError(`binding "${key}": directive must be a string, got ${describe(directive)}`);
  }
  if (directive === "$$now") {
    if (typeof now !== "string" || now.length === 0) {
      throw new FieldBindingError(`binding "${key}": "$$now" requires an injected { now } ISO-8601 string`);
    }
    return now;
  }
  if (directive.startsWith(CONST_PREFIX)) {
    return directive.slice(CONST_PREFIX.length); // literal remainder, may be ""
  }
  if (directive.startsWith("$.")) {
    return resolvePath(directive, rawEvent, key);
  }
  throw new FieldBindingError(
    `binding "${key}": unknown directive ${JSON.stringify(directive)} ` +
    `(closed grammar: $.path, $.x.length, $$now, $$const:VALUE)`,
  );
}

function resolvePath(directive, rawEvent, key) {
  const body = directive.slice(2); // strip "$."
  if (body.length === 0) throw new FieldBindingError(`binding "${key}": empty path "${directive}"`);
  const segments = body.split(".");

  // trailing `.length` (only on a ≥2-segment path) is a length accessor.
  let lengthAccessor = false;
  if (segments.length >= 2 && segments[segments.length - 1] === "length") {
    lengthAccessor = true;
    segments.pop();
  }

  let node = rawEvent;
  const traversed = [];
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) {
      throw new FieldBindingError(`binding "${key}": invalid path segment ${JSON.stringify(seg)} in "${directive}"`);
    }
    // arrays are leaves (only `.length` extracts from them); a non-plain-object
    // or a missing own property is a fail-closed miss.
    if (node === null || typeof node !== "object" || Array.isArray(node) ||
        !Object.prototype.hasOwnProperty.call(node, seg)) {
      throw new FieldBindingError(`binding "${key}": path "${directive}" has no value at ${[...traversed, seg].join(".")}`);
    }
    node = node[seg];
    traversed.push(seg);
  }

  if (lengthAccessor) {
    if (typeof node === "string" || Array.isArray(node)) return node.length;
    throw new FieldBindingError(
      `binding "${key}": ".length" requires an array or string at "${directive}", got ${describe(node)}`,
    );
  }
  return node;
}

function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
