// json-instance-validate.mjs — zero-dep closed-subset JSON-Schema 2020-12
// INSTANCE validator with a fail-CLOSED closure guard (RFC-008 R0c P1b, §2.1).
//
// This is NOT a general 2020-12 validator and NOT the schema-DOC linter
// (tests/lib/mini-jsonschema.mjs asserts "a schema is a valid schema"; this
// asserts "an instance satisfies a schema"). It models exactly the keyword
// subset the P0 plugin/runtime schemas use, and is the FIRST consumer to
// instance-validate plugins/_index.json + plugins/claude-code/manifest.json
// (M1/M2). validate-plugin-registry.mjs imports it.
//
// Three closure properties make it fail CLOSED, not open (the class the
// negative-scenario-planner GAP-3 + codex F-c1 review peeled apart):
//
//   (a) ALLOWLIST — KEYWORD_SHAPE enumerates every modeled keyword. A keyword
//       NOT in it (a future 2020-12 applicator like anyOf/patternProperties/
//       contains/dependentSchemas/unevaluated*) is a HARD ERROR, never a silent
//       skip — the inverse of "ignore unknown keywords".
//
//   (b) VALUE-SHAPE — the ALLOWLIST keys on keyword NAME, but each keyword's
//       modeled VALUE SHAPE is asserted too. `additionalProperties` and `type`
//       are both allowlisted, so name-only closure (a) would still fail OPEN on
//       a schema-VALUED `additionalProperties` ({$ref}, {type:string}) or an
//       array-VALUED `type` (["string","null"]) the interpreter didn't model
//       (codex F-c1). An allowlisted keyword in an UNMODELED value-shape is the
//       SAME hard error as an unmodeled keyword name.
//
//   (c) SCAN==INTERPRET — assertSchemaModeled() pre-scans the WHOLE schema doc
//       (a) + (b) BEFORE any instance is validated, and validateInstance()
//       refuses to interpret a root schema that has not been asserted-modeled
//       (memoized by identity). So you cannot instance-validate against a schema
//       whose keyword/value-shape set the interpreter has not vetted.
//
// Modeled subset (the union the interpreted schemas use — the 5 P1b schemas
// _index, manifest, bypass_known, installed-state, structured-alert, PLUS the
// P1c consumers schemas/events/event-*.schema.json + runbook-agent-manifest):
//   applicators : properties additionalProperties(bool|schema) items
//                 propertyNames allOf oneOf if then else not $ref $defs
//   validation  : type(scalar|array) enum const(any-JSON deep-equal) pattern
//                 format(date-time) required minLength minItems maxItems
//                 minProperties minimum
//   annotations : $schema $id title description $comment  (explicit no-ops)
//
// `minimum` + `maxItems` added in P1c (RFC-008 R0c): the event schemas assert
// `minimum:0` on turn_index, and runbook-agent-manifest asserts `maxItems:0` on
// command_shapes (static-rules). `validateInstance` is the first P1c consumer of
// both schema sets, so without these the closure guard throws SchemaModelingError
// before validating. Both are fail-closed value-shape-checked like every keyword.
//
// Deliberately ABSENT (fail CLOSED if ever introduced): anyOf, contains,
// patternProperties, dependentSchemas, dependentRequired, prefixItems,
// unevaluatedItems, unevaluatedProperties, multipleOf, maximum, exclusiveMinimum,
// exclusiveMaximum, maxLength, uniqueItems, max/minContains, maxProperties,
// default, deprecated, readOnly, writeOnly, examples, content*, $anchor,
// $dynamicRef, $dynamicAnchor, $vocabulary.

const VALID_TYPES = new Set([
  "null", "boolean", "object", "array", "number", "string", "integer",
]);

// JSON-Schema annotations / core identifiers that assert NOTHING about an
// instance. The scanner skips them (never fail-on-unmodeled) and the
// interpreter ignores them — a no-op can never fail OPEN because it constrains
// nothing (§2.1f). $defs is a definition container (referenced via $ref), so it
// is also a non-asserting position, but it DOES bear subschemas that must be
// scanned — handled in SUBSCHEMA_POSITION, not here.
const ANNOTATION_KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "$comment",
]);

// Modeled value-shape per keyword. The single source of truth for closure (a)
// (membership) AND (b) (value-shape assertion). Shape codes:
//   "schema"       value IS a schema (object or boolean)         -> recurse
//   "schemaArray"  value is a non-empty array of schemas         -> recurse each
//   "schemaMap"    value is an object whose every value is schema -> recurse each
//   "boolOrSchema" value is a boolean OR a schema (additionalProperties)
//   "typeValue"    value is a type name or non-empty array of unique type names
//   "stringArray"  value is an array of strings
//   "enumArray"    value is a non-empty array (any JSON members)
//   "any"          value is any JSON (const)
//   "string"       value is a string
//   "nonNegInt"    value is a non-negative integer
//   "number"       value is any finite JSON number (minimum — negative/float OK)
const KEYWORD_SHAPE = {
  // applicators (subschema-bearing)
  properties: "schemaMap",
  additionalProperties: "boolOrSchema",
  items: "schema",
  propertyNames: "schema",
  allOf: "schemaArray",
  oneOf: "schemaArray",
  if: "schema",
  then: "schema",
  else: "schema",
  not: "schema",
  $defs: "schemaMap",
  // reference
  $ref: "string",
  // validation (non-recursing)
  type: "typeValue",
  enum: "enumArray",
  const: "any",
  pattern: "string",
  format: "string",
  required: "stringArray",
  minLength: "nonNegInt",
  minItems: "nonNegInt",
  maxItems: "nonNegInt",
  minProperties: "nonNegInt",
  minimum: "number",
};

// The recurse-set: which shapes bear subschemas the scanner must descend into.
const RECURSING_SHAPES = new Set(["schema", "schemaArray", "schemaMap", "boolOrSchema"]);

export class SchemaModelingError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaModelingError";
  }
}

function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean"
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isSchemaShaped(node) {
  // A 2020-12 schema is an object OR a boolean.
  return typeof node === "boolean" || isPlainObject(node);
}

// ---------------------------------------------------------------------------
// CLOSURE GUARD — assertSchemaModeled (closures a + b + c-prescan).
// Walks the whole schema doc; throws SchemaModelingError on the first
// unmodeled keyword NAME or unmodeled VALUE-SHAPE. Mirrors the doc structure so
// nested subschemas (under properties / $defs / items / allOf / oneOf / if /
// then / else / not / additionalProperties / propertyNames) are all vetted.
// ---------------------------------------------------------------------------
function assertShape(keyword, value, path) {
  const shape = KEYWORD_SHAPE[keyword];
  switch (shape) {
    case "schema":
      if (!isSchemaShaped(value)) {
        throw new SchemaModelingError(
          `${path}: "${keyword}" must be a schema (object|boolean), got ${jsonType(value)}`,
        );
      }
      return;
    case "schemaArray":
      if (!Array.isArray(value) || value.length === 0) {
        throw new SchemaModelingError(
          `${path}: "${keyword}" must be a non-empty array of schemas, got ${jsonType(value)}`,
        );
      }
      value.forEach((el, i) => {
        if (!isSchemaShaped(el)) {
          throw new SchemaModelingError(
            `${path}/${i}: "${keyword}" element must be a schema, got ${jsonType(el)}`,
          );
        }
      });
      return;
    case "schemaMap":
      if (!isPlainObject(value)) {
        throw new SchemaModelingError(
          `${path}: "${keyword}" must be an object of schemas, got ${jsonType(value)}`,
        );
      }
      for (const [k, sub] of Object.entries(value)) {
        if (!isSchemaShaped(sub)) {
          throw new SchemaModelingError(
            `${path}/${k}: "${keyword}" value must be a schema, got ${jsonType(sub)}`,
          );
        }
      }
      return;
    case "boolOrSchema":
      // The codex F-c1 fail-open: BOTH boolean false AND a schema value are
      // modeled; anything else (array, number) is an unmodeled value-shape.
      if (typeof value === "boolean" || isPlainObject(value)) return;
      throw new SchemaModelingError(
        `${path}: "${keyword}" must be boolean or schema-object, got ${jsonType(value)}`,
      );
    case "typeValue":
      if (typeof value === "string") {
        if (!VALID_TYPES.has(value)) {
          throw new SchemaModelingError(`${path}: "${keyword}" unknown type name ${JSON.stringify(value)}`);
        }
        return;
      }
      if (Array.isArray(value)) {
        // array-VALUED type, e.g. ["string","null"] (structured-alert) — codex F-c1.
        if (value.length === 0) throw new SchemaModelingError(`${path}: "type" array must be non-empty`);
        if (new Set(value).size !== value.length) throw new SchemaModelingError(`${path}: "type" array must be unique`);
        for (const t of value) {
          if (typeof t !== "string" || !VALID_TYPES.has(t)) {
            throw new SchemaModelingError(`${path}: "type" unknown type name in array ${JSON.stringify(t)}`);
          }
        }
        return;
      }
      throw new SchemaModelingError(`${path}: "type" must be a type name or array of type names, got ${jsonType(value)}`);
    case "enumArray":
      if (!Array.isArray(value) || value.length === 0) {
        throw new SchemaModelingError(`${path}: "enum" must be a non-empty array, got ${jsonType(value)}`);
      }
      return;
    case "any":
      return; // const — any JSON literal (§2.1e)
    case "string":
      if (typeof value !== "string") {
        throw new SchemaModelingError(`${path}: "${keyword}" must be a string, got ${jsonType(value)}`);
      }
      if (keyword === "pattern") {
        try { new RegExp(value); }
        catch (e) { throw new SchemaModelingError(`${path}: "pattern" is not a compilable regex: ${e.message}`); }
      }
      return;
    case "stringArray":
      if (!Array.isArray(value) || !value.every((s) => typeof s === "string")) {
        throw new SchemaModelingError(`${path}: "${keyword}" must be an array of strings`);
      }
      return;
    case "nonNegInt":
      if (!Number.isInteger(value) || value < 0) {
        throw new SchemaModelingError(`${path}: "${keyword}" must be a non-negative integer, got ${JSON.stringify(value)}`);
      }
      return;
    case "number":
      // `minimum` bound — any finite JSON number (negative/float admitted; JSON
      // has no NaN/Infinity literal, but reject defensively if one is injected).
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SchemaModelingError(`${path}: "${keyword}" must be a finite number, got ${jsonType(value)}`);
      }
      return;
    default:
      // Unreachable: KEYWORD_SHAPE only carries the shapes above.
      throw new SchemaModelingError(`${path}: internal — unhandled shape "${shape}" for "${keyword}"`);
  }
}

function scanNode(node, path) {
  if (typeof node === "boolean") return; // boolean schema — nothing to model
  if (!isPlainObject(node)) {
    throw new SchemaModelingError(`${path}: not a schema (expected object or boolean), got ${jsonType(node)}`);
  }
  for (const [keyword, value] of Object.entries(node)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) continue; // §2.1f explicit no-op
    if (!(keyword in KEYWORD_SHAPE)) {
      // closure (a) — fail-on-unmodeled keyword NAME.
      throw new SchemaModelingError(
        `${path}: unmodeled keyword "${keyword}" — json-instance-validate models a closed 2020-12 subset; ` +
        `add it to KEYWORD_SHAPE (and its interpretation) or it fails CLOSED`,
      );
    }
    // closure (b) — assert the modeled value-SHAPE.
    assertShape(keyword, value, `${path}/${keyword}`);
    // recurse into subschema-bearing positions.
    const shape = KEYWORD_SHAPE[keyword];
    if (!RECURSING_SHAPES.has(shape)) continue;
    if (shape === "schema") scanNode(value, `${path}/${keyword}`);
    else if (shape === "boolOrSchema") { if (isPlainObject(value)) scanNode(value, `${path}/${keyword}`); }
    else if (shape === "schemaArray") value.forEach((el, i) => scanNode(el, `${path}/${keyword}/${i}`));
    else if (shape === "schemaMap") for (const [k, sub] of Object.entries(value)) scanNode(sub, `${path}/${keyword}/${k}`);
  }
}

const _modeledSchemas = new WeakSet();

/**
 * Assert a parsed schema doc uses ONLY the modeled keyword/value-shape subset.
 * Throws SchemaModelingError on the first violation. Idempotent + memoized by
 * object identity (so validateInstance can cheaply guarantee scan==interpret).
 * @param {object} schema parsed JSON-Schema 2020-12 doc (the root)
 */
export function assertSchemaModeled(schema) {
  if (!isPlainObject(schema)) {
    throw new SchemaModelingError("#: root schema must be an object");
  }
  if (_modeledSchemas.has(schema)) return;
  scanNode(schema, "#");
  _modeledSchemas.add(schema);
}

/**
 * Assert every schema in a registry {name: parsedSchema} is modeled. Drives the
 * scan-set from a single registry so it cannot drift from the interpret-set
 * (claude-subagent F2). Returns the registry for chaining.
 */
export function assertAllSchemasModeled(registry) {
  for (const [name, schema] of Object.entries(registry)) {
    try {
      assertSchemaModeled(schema);
    } catch (e) {
      throw new SchemaModelingError(`schema "${name}": ${e.message}`);
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// DEEP EQUALITY — const / enum membership over any JSON value (§2.1e).
// Order-sensitive for arrays; order-insensitive (key-set + value) for objects.
// ---------------------------------------------------------------------------
function deepEqual(a, b) {
  if (a === b) return true;
  const ta = jsonType(a), tb = jsonType(b);
  if (ta !== tb) return false;
  if (ta === "array") {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (ta === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false; // primitives already handled by === (incl. NaN!==NaN, acceptable)
}

// RFC 3339 / ISO-8601 date-time (the only `format` used by the modeled schemas).
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// JSON-pointer $ref resolution. Supports the local "#/a/b/c" form (the schemas
// only use "#/$defs/NAME"); throws on external/malformed refs (fail closed).
// ---------------------------------------------------------------------------
function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new SchemaModelingError(`unsupported $ref ${JSON.stringify(ref)} (only local "#/..." pointers modeled)`);
  }
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = root;
  for (const p of parts) {
    if (!isPlainObject(node) || !(p in node)) {
      throw new SchemaModelingError(`$ref ${ref} does not resolve (missing segment ${JSON.stringify(p)})`);
    }
    node = node[p];
  }
  return node;
}

// ---------------------------------------------------------------------------
// THE INTERPRETER. validateAgainst pushes structured errors; isValid is the
// branch-selector helper (if/oneOf/allOf/not) that runs it into a scratch sink.
// Error shape: {path, keyword, detail}.
// ---------------------------------------------------------------------------
function err(errors, path, keyword, detail) {
  errors.push({ path, keyword, detail });
}

function isValid(instance, schema, root) {
  const sink = [];
  validateAgainst(instance, schema, root, "#", sink);
  return sink.length === 0;
}

function validateAgainst(instance, schema, root, path, errors) {
  // boolean schema: true accepts anything, false rejects everything.
  if (typeof schema === "boolean") {
    if (!schema) err(errors, path, "false", "boolean false schema rejects all instances");
    return;
  }
  if (!isPlainObject(schema)) {
    err(errors, path, "$schema", `not a schema node (${jsonType(schema)})`);
    return;
  }

  const it = jsonType(instance);

  // $ref — resolve and validate against the referenced subschema (siblings
  // still apply, 2020-12 semantics).
  if ("$ref" in schema) {
    const resolved = resolveRef(schema.$ref, root);
    validateAgainst(instance, resolved, root, path, errors);
  }

  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => t === it || (t === "integer" && it === "number" && Number.isInteger(instance)));
    if (!ok) err(errors, path, "type", `expected ${JSON.stringify(schema.type)}, got ${it}`);
  }

  if ("const" in schema) {
    if (!deepEqual(instance, schema.const)) {
      err(errors, path, "const", `must equal ${JSON.stringify(schema.const)}`);
    }
  }

  if ("enum" in schema) {
    if (!schema.enum.some((e) => deepEqual(instance, e))) {
      err(errors, path, "enum", `must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(instance)}`);
    }
  }

  // string assertions
  if (it === "string") {
    if ("pattern" in schema && !new RegExp(schema.pattern).test(instance)) {
      err(errors, path, "pattern", `${JSON.stringify(instance)} does not match /${schema.pattern}/`);
    }
    if ("minLength" in schema && instance.length < schema.minLength) {
      err(errors, path, "minLength", `length ${instance.length} < ${schema.minLength}`);
    }
    if ("format" in schema && schema.format === "date-time" && !DATE_TIME_RE.test(instance)) {
      err(errors, path, "format", `${JSON.stringify(instance)} is not a valid date-time`);
    }
  }

  // array assertions
  if (it === "array") {
    if ("minItems" in schema && instance.length < schema.minItems) {
      err(errors, path, "minItems", `${instance.length} items < ${schema.minItems}`);
    }
    if ("maxItems" in schema && instance.length > schema.maxItems) {
      err(errors, path, "maxItems", `${instance.length} items > ${schema.maxItems}`);
    }
    if ("items" in schema) {
      instance.forEach((el, i) => validateAgainst(el, schema.items, root, `${path}/${i}`, errors));
    }
  }

  // number assertions (integers are jsonType "number" too)
  if (it === "number") {
    if ("minimum" in schema && instance < schema.minimum) {
      err(errors, path, "minimum", `${instance} < ${schema.minimum}`);
    }
  }

  // object assertions
  if (it === "object") {
    if ("minProperties" in schema && Object.keys(instance).length < schema.minProperties) {
      err(errors, path, "minProperties", `${Object.keys(instance).length} properties < ${schema.minProperties}`);
    }
    if ("required" in schema) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(instance, key)) {
          err(errors, path, "required", `missing required property ${JSON.stringify(key)}`);
        }
      }
    }
    if ("propertyNames" in schema) {
      // applies the subschema to each KEY (as a string instance) — NOT the value.
      for (const key of Object.keys(instance)) {
        const sink = [];
        validateAgainst(key, schema.propertyNames, root, `${path}/${key}`, sink);
        if (sink.length) err(errors, `${path}/${key}`, "propertyNames", `key ${JSON.stringify(key)} violates propertyNames`);
      }
    }
    const props = isPlainObject(schema.properties) ? schema.properties : null;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (Object.prototype.hasOwnProperty.call(instance, key)) {
          validateAgainst(instance[key], sub, root, `${path}/${key}`, errors);
        }
      }
    }
    if ("additionalProperties" in schema) {
      const ap = schema.additionalProperties;
      for (const key of Object.keys(instance)) {
        if (props && Object.prototype.hasOwnProperty.call(props, key)) continue; // matched by properties
        if (ap === false) {
          err(errors, `${path}/${key}`, "additionalProperties", `unexpected property ${JSON.stringify(key)}`);
        } else if (isPlainObject(ap) || typeof ap === "boolean") {
          if (ap !== true && ap !== false) {
            validateAgainst(instance[key], ap, root, `${path}/${key}`, errors); // schema-valued — RECURSE (codex F-c1)
          }
        }
      }
    }
  }

  // applicators
  if ("allOf" in schema) {
    schema.allOf.forEach((sub, i) => validateAgainst(instance, sub, root, `${path}/allOf/${i}`, errors));
  }
  if ("oneOf" in schema) {
    const matches = schema.oneOf.filter((sub) => isValid(instance, sub, root)).length;
    if (matches !== 1) {
      err(errors, path, "oneOf", `must match exactly one branch, matched ${matches}`);
    }
  }
  if ("not" in schema) {
    if (isValid(instance, schema.not, root)) {
      err(errors, path, "not", "must NOT match the `not` subschema");
    }
  }
  if ("if" in schema) {
    if (isValid(instance, schema.if, root)) {
      if ("then" in schema) validateAgainst(instance, schema.then, root, `${path}/then`, errors);
    } else if ("else" in schema) {
      validateAgainst(instance, schema.else, root, `${path}/else`, errors);
    }
  }
}

/**
 * Validate a parsed instance against a parsed root schema (closed 2020-12
 * subset). $ref resolves against `schema`. The root schema is asserted-modeled
 * first (closure c — scan ⊇ interpret), so an unmodeled keyword/value-shape
 * throws SchemaModelingError rather than silently passing.
 * @returns {{valid: boolean, errors: Array<{path,keyword,detail}>}}
 */
export function validateInstance(instance, schema) {
  assertSchemaModeled(schema); // closure (c): cannot interpret an un-vetted schema
  const errors = [];
  validateAgainst(instance, schema, schema, "#", errors);
  return { valid: errors.length === 0, errors };
}

export { KEYWORD_SHAPE, ANNOTATION_KEYWORDS, deepEqual };
