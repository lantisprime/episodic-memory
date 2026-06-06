// version-hash.mjs — thin re-export shim. The implementation was PROMOTED to
// scripts/lib/version-hash.mjs in RFC-008 R0c P1b (it ships: the CI tool
// scripts/validate-plugin-registry.mjs imports it for M6/M6b, and a prod tool
// importing from tests/lib/ is a prod-depends-on-test inversion). This shim
// preserves the existing P0 importer (tests/test-p0-schemas.mjs:21) unchanged.
export { sha256Hex, taxonomyVersion, eventsVersion } from "../../scripts/lib/version-hash.mjs";
