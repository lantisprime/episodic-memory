// mini-jsonschema.mjs — thin re-export shim. The implementation was PROMOTED to
// scripts/lib/mini-jsonschema.mjs in RFC-008 P2a (it ships: the CI validator
// scripts/validate-schemas.mjs imports it for M1/M2, and a prod tool importing
// from tests/lib/ is a prod-depends-on-test inversion). This shim preserves the
// existing P0 importer (tests/test-p0-schemas.mjs) unchanged — same pattern as
// tests/lib/version-hash.mjs (P1b).
export { lintSchema, assertSelfConsistent, ALLOWLIST, SUBSCHEMA_KEYWORDS, VALUE_GRAMMAR } from "../../scripts/lib/mini-jsonschema.mjs";
