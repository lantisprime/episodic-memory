// mini-jsonschema.mjs — JSON-Schema 2020-12 keyword-grammar lint engine.
//
// RFC-008 P0 validity-verification gate (v11.8), PROMOTED from tests/lib/ in
// P2a: the single engine behind both the P0 test gate
// (tests/test-p0-schemas.mjs, via the tests/lib/ re-export shim) and the
// shipped CI validator scripts/validate-schemas.mjs (M1/M2, RFC L493-498) —
// one engine, so the two consumers cannot drift (D2); the shared negative
// corpus tests/fixtures/schema-negative-corpus.json guards any future
// refactor that forks them (#368).
//
// This is NOT a meta-schema interpreter — it never loads the official 2020-12
// meta-schema and never resolves $dynamicRef / $dynamicAnchor (replicating
// that machinery is the most error-prone corner of the spec and the wrong
// patch class — see the R0b plan review, rounds 2-3). It directly asserts that
// a document conforms to the 2020-12 keyword grammar, recursing into every
// subschema-bearing position.
//
// Two properties close the fail-open class the review identified:
//   (a) ALLOWLIST + fail-on-unknown-keyword — a keyword not in the canonical
//       2020-12 set is a HARD FAIL (a typo like `requiredd` can never silently
//       pass; the inverse of "ignore unknown keywords").
//   (b) The recurse-set is DERIVED from a single declared SUBSCHEMA_KEYWORDS
//       table covering ALL 2020-12 subschema-bearing keywords, and the module
//       SELF-ASSERTS on load that
//         keys(SUBSCHEMA_KEYWORDS) ∪ keys(VALUE_GRAMMAR) === ALLOWLIST
//       so a future allowlisted keyword that bears a subschema cannot be added
//       without classifying it — the recurse-set cannot silently go incomplete
//       (closing e.g. {"propertyNames":{"items":[]}} which would otherwise pass).

// ---------------------------------------------------------------------------
// Canonical 2020-12 keyword set — the independent source of truth (57 keywords:
// Core 9, Applicator 17, Validation 20, Meta-data 7, Format 1, Content 3).
// ---------------------------------------------------------------------------
const ALLOWLIST = new Set([
  // Core (9)
  "$schema", "$id", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor",
  "$vocabulary", "$comment", "$defs",
  // Applicator (17)
  "prefixItems", "items", "contains", "additionalProperties", "properties",
  "patternProperties", "dependentSchemas", "propertyNames", "if", "then",
  "else", "allOf", "anyOf", "oneOf", "not", "unevaluatedItems",
  "unevaluatedProperties",
  // Validation (20)
  "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum",
  "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern",
  "maxItems", "minItems", "uniqueItems", "maxContains", "minContains",
  "maxProperties", "minProperties", "required", "dependentRequired",
  // Meta-data (7)
  "title", "description", "default", "deprecated", "readOnly", "writeOnly",
  "examples",
  // Format (1)
  "format",
  // Content (3)
  "contentEncoding", "contentMediaType", "contentSchema",
]);

// ---------------------------------------------------------------------------
// SUBSCHEMA_KEYWORDS — the SINGLE declared recurse-set. Every 2020-12 keyword
// whose value contains one or more subschemas, classified by value shape.
//   single : value IS a schema (object|boolean)
//   array  : value is an array of schemas
//   map    : value is an object whose every value is a schema
// ---------------------------------------------------------------------------
const SUBSCHEMA_KEYWORDS = {
  // single-schema (11)
  items: "single",
  additionalProperties: "single",
  unevaluatedItems: "single",
  unevaluatedProperties: "single",
  contains: "single",
  propertyNames: "single",
  if: "single",
  then: "single",
  else: "single",
  not: "single",
  contentSchema: "single",
  // schema-array (4)
  prefixItems: "array",
  allOf: "array",
  anyOf: "array",
  oneOf: "array",
  // object -> schema-map (4)
  properties: "map",
  patternProperties: "map",
  $defs: "map",
  dependentSchemas: "map",
};

const VALID_TYPES = new Set([
  "null", "boolean", "object", "array", "number", "string", "integer",
]);

// ---------------------------------------------------------------------------
// VALUE_GRAMMAR — non-recursing keywords + their grammar check. Each returns
// null on success or an error string on failure.
// ---------------------------------------------------------------------------
const isString = (v) => (typeof v === "string" ? null : "must be a string");
const isBoolean = (v) => (typeof v === "boolean" ? null : "must be a boolean");
const isNumber = (v) =>
  typeof v === "number" && Number.isFinite(v) ? null : "must be a number";
const isPositiveNumber = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? null
    : "must be a number > 0";
const isNonNegInt = (v) =>
  Number.isInteger(v) && v >= 0 ? null : "must be a non-negative integer";
const isArray = (v) => (Array.isArray(v) ? null : "must be an array");
const isAny = () => null;

function isEnum(v) {
  if (!Array.isArray(v)) return "must be an array";
  if (v.length === 0) return "must be a non-empty array";
  return null;
}

function isStringArrayUnique(v) {
  if (!Array.isArray(v)) return "must be an array";
  if (!v.every((s) => typeof s === "string")) return "must be an array of strings";
  if (new Set(v).size !== v.length) return "must contain unique strings";
  return null;
}

function isTypeKeyword(v) {
  if (typeof v === "string") {
    return VALID_TYPES.has(v) ? null : `unknown type name: ${JSON.stringify(v)}`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "type array must be non-empty";
    if (new Set(v).size !== v.length) return "type array must be unique";
    for (const t of v) {
      if (typeof t !== "string" || !VALID_TYPES.has(t)) {
        return `unknown type name in array: ${JSON.stringify(t)}`;
      }
    }
    return null;
  }
  return "must be a type name or array of type names";
}

function isPattern(v) {
  if (typeof v !== "string") return "must be a string";
  try {
    new RegExp(v);
    return null;
  } catch (e) {
    return `not a compilable regex: ${e.message}`;
  }
}

function isVocabulary(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return "must be an object";
  }
  for (const val of Object.values(v)) {
    if (typeof val !== "boolean") return "values must be booleans";
  }
  return null;
}

function isDependentRequired(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return "must be an object";
  }
  for (const val of Object.values(v)) {
    const err = isStringArrayUnique(val);
    if (err) return `value ${err}`;
  }
  return null;
}

const VALUE_GRAMMAR = {
  // Core (8 — $defs is a subschema map, handled separately)
  $schema: isString,
  $id: isString,
  $ref: isString,
  $anchor: isString,
  $dynamicRef: isString,
  $dynamicAnchor: isString,
  $vocabulary: isVocabulary,
  $comment: isString,
  // Validation (20)
  type: isTypeKeyword,
  enum: isEnum,
  const: isAny,
  multipleOf: isPositiveNumber,
  maximum: isNumber,
  exclusiveMaximum: isNumber,
  minimum: isNumber,
  exclusiveMinimum: isNumber,
  maxLength: isNonNegInt,
  minLength: isNonNegInt,
  pattern: isPattern,
  maxItems: isNonNegInt,
  minItems: isNonNegInt,
  uniqueItems: isBoolean,
  maxContains: isNonNegInt,
  minContains: isNonNegInt,
  maxProperties: isNonNegInt,
  minProperties: isNonNegInt,
  required: isStringArrayUnique,
  dependentRequired: isDependentRequired,
  // Meta-data (7)
  title: isString,
  description: isString,
  default: isAny,
  deprecated: isBoolean,
  readOnly: isBoolean,
  writeOnly: isBoolean,
  examples: isArray,
  // Format (1)
  format: isString,
  // Content (2 — contentSchema is a subschema)
  contentEncoding: isString,
  contentMediaType: isString,
};

// ---------------------------------------------------------------------------
// Structural self-assertion (runs on module load). This is the guard the R0b
// review demanded: the union of the two classification maps' keys MUST equal
// the canonical allowlist, in both directions.
// ---------------------------------------------------------------------------
export function assertSelfConsistent() {
  const classified = new Set([
    ...Object.keys(SUBSCHEMA_KEYWORDS),
    ...Object.keys(VALUE_GRAMMAR),
  ]);
  const missing = [...ALLOWLIST].filter((k) => !classified.has(k));
  const extra = [...classified].filter((k) => !ALLOWLIST.has(k));
  // A keyword in both maps is a classification bug too (ambiguous handling).
  const both = Object.keys(SUBSCHEMA_KEYWORDS).filter(
    (k) => k in VALUE_GRAMMAR,
  );
  if (missing.length || extra.length || both.length) {
    throw new Error(
      "mini-jsonschema self-assertion FAILED: classification maps do not " +
        "partition the allowlist.\n" +
        `  unclassified (in allowlist, in neither map): ${JSON.stringify(missing)}\n` +
        `  unknown (in a map, not in allowlist): ${JSON.stringify(extra)}\n` +
        `  double-classified (in both maps): ${JSON.stringify(both)}`,
    );
  }
}
assertSelfConsistent();

// ---------------------------------------------------------------------------
// The linter. A "schema" in 2020-12 is a boolean OR an object.
// ---------------------------------------------------------------------------
function isSchemaShaped(node) {
  return typeof node === "boolean" || (node !== null && typeof node === "object" && !Array.isArray(node));
}

function lintNode(node, path, errors) {
  if (typeof node === "boolean") return; // boolean schema — always valid
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`${path}: not a schema (expected object or boolean)`);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const here = `${path}/${key}`;
    if (!ALLOWLIST.has(key)) {
      errors.push(`${here}: unknown keyword "${key}" (not in 2020-12 allowlist)`);
      continue;
    }
    const kind = SUBSCHEMA_KEYWORDS[key];
    if (kind === "single") {
      if (!isSchemaShaped(value)) {
        errors.push(`${here}: "${key}" must be a schema (object or boolean), got ${describe(value)}`);
      } else {
        lintNode(value, here, errors);
      }
    } else if (kind === "array") {
      if (!Array.isArray(value)) {
        errors.push(`${here}: "${key}" must be an array of schemas, got ${describe(value)}`);
      } else {
        value.forEach((sub, i) => {
          if (!isSchemaShaped(sub)) {
            errors.push(`${here}/${i}: "${key}" element must be a schema, got ${describe(sub)}`);
          } else {
            lintNode(sub, `${here}/${i}`, errors);
          }
        });
      }
    } else if (kind === "map") {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${here}: "${key}" must be an object whose values are schemas, got ${describe(value)}`);
      } else {
        for (const [subKey, sub] of Object.entries(value)) {
          if (!isSchemaShaped(sub)) {
            errors.push(`${here}/${subKey}: "${key}" value must be a schema, got ${describe(sub)}`);
          } else {
            lintNode(sub, `${here}/${subKey}`, errors);
          }
        }
      }
    } else {
      // value-grammar keyword
      const check = VALUE_GRAMMAR[key];
      const err = check(value);
      if (err) errors.push(`${here}: "${key}" ${err} (got ${describe(value)})`);
    }
  }
}

function describe(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/**
 * Lint a parsed JSON value as a JSON-Schema 2020-12 document.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function lintSchema(doc) {
  const errors = [];
  lintNode(doc, "#", errors);
  return { valid: errors.length === 0, errors };
}

export { ALLOWLIST, SUBSCHEMA_KEYWORDS, VALUE_GRAMMAR };
