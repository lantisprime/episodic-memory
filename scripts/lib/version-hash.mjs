// version-hash.mjs — canonical taxonomy_version / events_version sha256 hashing
// (RFC-008 F8 / F37). SHIPPED helper (promoted from tests/lib/ in R0c P1b): the
// repo/CI tool scripts/validate-plugin-registry.mjs imports it for M6/M6b, so it
// must live under scripts/lib/ — a CI tool importing from tests/lib/ is a
// prod-depends-on-test inversion. tests/lib/version-hash.mjs is now a thin
// re-export shim (the P0 importer tests/test-p0-schemas.mjs:21 is unchanged).
// Pure node:crypto + stdlib; zero external deps.
//
// The serialization contract is mirrored in tests/fixtures/plugins/_corpus-index.json
// so P2's scripts/validate-bp-contract.mjs reuses the identical bytes (drift guard).
//
// F8:  taxonomy_version = "sha256:" + SHA256(JSON.stringify(labelsSortedById)).hex
//      labelsSortedById = taxonomy.labels sorted ascending by `id`.
// F37: events_version   = "sha256:" + SHA256(JSON.stringify(eventsSortedById)).hex
//      eventsSortedById = events.events sorted ascending by `id`.
// JSON.stringify uses no whitespace; object key order is preserved from the
// source document (parse → re-stringify is byte-stable).

import { createHash } from "node:crypto";

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function taxonomyVersion(taxonomy) {
  const sorted = taxonomy.labels.slice().sort(byId);
  return "sha256:" + sha256Hex(JSON.stringify(sorted));
}

export function eventsVersion(events) {
  const sorted = events.events.slice().sort(byId);
  return "sha256:" + sha256Hex(JSON.stringify(sorted));
}
