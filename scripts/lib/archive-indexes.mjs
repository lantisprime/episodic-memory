// archive-indexes.mjs — drop archived episode ids from the store's inverted
// indexes (tags.json, category-index.json, tokens.json).
//
// Shared by em-prune and em-consolidate --fold-superseded (#476): both archive
// episodes (file -> archived/, row -> archived-index.jsonl) and must keep every
// inverted index in step with index.jsonl in the same transaction, so em-doctor
// does not report "<file> references N id(s) not in index.jsonl" until the
// next em-rebuild-index.
//
// Reads go through the null-prototype loaders (#469/#470: a key literally named
// "constructor"/"__proto__" must not resolve to an Object.prototype member).
// An index that is absent, unreadable, or corrupt (loader returns null) is left
// untouched: readers already degrade to a linear scan on it, and
// em-rebuild-index regenerates it — overwriting it here would swap a detected
// degradation for silently empty postings. A key whose posting list becomes
// empty is deleted, matching em-rebuild-index, which never emits an empty list;
// an empty-string key (category '') is a real key and is handled the same way.
// tokens.json's TOKENS_DROPPED_KEY lists tokens, not ids, and is kept as-is.
// Writes are atomic (temp + rename). Callers hold the store write lock where
// they take one.

import path from 'path'
import { loadTagsIndex, loadCategoryIndex, loadTokensIndex, TOKENS_DROPPED_KEY } from './relevance.mjs'
import { atomicReplaceFileSync } from './store-write-lock.mjs'

const INVERTED_INDEXES = [
  { fileName: 'tags.json', load: loadTagsIndex, pretty: true },
  { fileName: 'category-index.json', load: loadCategoryIndex, pretty: true },
  { fileName: 'tokens.json', load: loadTokensIndex, pretty: false },
]

export function removeIdsFromInvertedIndexes(dataDir, ids) {
  const drop = ids instanceof Set ? ids : new Set(ids)
  if (drop.size === 0) return
  for (const { fileName, load, pretty } of INVERTED_INDEXES) {
    const inverted = load(dataDir)
    if (inverted === null) continue
    for (const key of Object.keys(inverted)) {
      if (fileName === 'tokens.json' && key === TOKENS_DROPPED_KEY) continue
      if (!Array.isArray(inverted[key])) continue
      inverted[key] = inverted[key].filter(id => !drop.has(id))
      if (inverted[key].length === 0) delete inverted[key]
    }
    atomicReplaceFileSync(path.join(dataDir, fileName), JSON.stringify(inverted, ...(pretty ? [null, 2] : [])))
  }
}
