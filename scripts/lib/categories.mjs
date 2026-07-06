// categories.mjs — the single source of the episode category vocabulary (RFC-009 R10b).
//
// Every SUBSTRATE script reads the closed vocabulary through this lib; no script carries a
// category-name array literal. Resolution: EM_CATEGORIES_PATH override (tests / break-input),
// else categories.json at the repo root (in-repo) or ~/.episodic-memory/ (deployed), reached
// via `../../categories.json` from this file's location (symmetric in both trees).
//
// Fail direction is a property of the CALLER, encoded in WHICH function it calls (RFC-009 §12, B1):
//   - WRITERS   call validateCategory  → THROWS on an unloadable vocab (caller fails CLOSED).
//   - READERS   call canonicalCategory / categoryLifecycle → DEGRADE on an unloadable vocab
//               (literal key / null) so no read/index/prune surface is ever fatal (R10c row 3).

import fs from 'node:fs';

export const CATEGORIES_PATH = new URL('../../categories.json', import.meta.url);

/**
 * Resolve + parse the vocabulary document. THROWS `vocab-unloadable` on any read/parse failure.
 * @returns {{version:string, categories:Array<{name:string,description:string,lifecycle:string,deprecated_for?:string}>}}
 */
export function loadCategories() {
  const path = process.env.EM_CATEGORIES_PATH || CATEGORIES_PATH;
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`categories.json unloadable: ${e.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`categories.json unloadable: ${e.message}`);
  }
  if (!doc || !Array.isArray(doc.categories)) {
    throw new Error('categories.json unloadable: missing categories array');
  }
  return doc;
}

// Internal: build a name → member map. Propagates loadCategories() throws.
function memberMap() {
  const map = new Map();
  for (const m of loadCategories().categories) {
    if (m && typeof m.name === 'string') map.set(m.name, m);
  }
  return map;
}

// Coerce any category value to a stable string key (never a live [object Object]); §13 EC9/EC10.
function categoryKey(name) {
  if (typeof name === 'string') return name;
  if (name === undefined || name === null) return String(name); // "undefined" / "null" literal
  return String(name);
}

/**
 * WRITER path — strict validation. THROWS `vocab-unloadable` when the vocab cannot load (§12 state E).
 * @param {string} name
 * @param {{allowDeprecated?:boolean}} [opts]
 * @returns {{ok:boolean, reason?:string, successor?:string}}
 */
export function validateCategory(name, { allowDeprecated = false } = {}) {
  const map = memberMap(); // throws on unloadable → caller fails closed
  const member = map.get(name);
  if (!member) return { ok: false, reason: 'unknown' };
  if (member.deprecated_for) {
    if (allowDeprecated) return { ok: true, successor: member.deprecated_for };
    return { ok: false, reason: 'deprecated', successor: member.deprecated_for };
  }
  return { ok: true };
}

/**
 * READER/index path — map a category to its canonical (successor) name. DEGRADES, never throws (§12).
 * deprecated → successor (one hop); unknown → the literal key (drift key); vocab unloadable → literal.
 * @param {string} name
 * @returns {string}
 */
export function canonicalCategory(name) {
  const key = categoryKey(name);
  let map;
  try {
    map = memberMap();
  } catch {
    return key; // degrade: caller behaves as pre-R10
  }
  const member = map.get(key);
  if (!member) return key; // unknown → literal drift key
  if (member.deprecated_for) return member.deprecated_for; // one hop
  return key;
}

/**
 * PRUNE path — the lifecycle of a category (canonicalized). DEGRADES to null, never throws (§12).
 * @param {string} name
 * @returns {("standard"|"aggregate-then-prune")|null}
 */
export function categoryLifecycle(name) {
  let map;
  try {
    map = memberMap();
  } catch {
    return null; // degrade: caller falls back to the standard score
  }
  const canonical = canonicalCategory(name);
  const member = map.get(canonical);
  return member ? member.lifecycle : null;
}
