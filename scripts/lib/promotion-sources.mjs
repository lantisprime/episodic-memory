// promotion-sources.mjs — RFC-012 P2 S2 typed promotion provenance.

import crypto from 'node:crypto'
import { STORE_ID_RE } from './store-identity.mjs'

export const STRUCTURED_FIELDS = ['promotion_sources']
export const PROMOTION_SOURCE_KEYS = ['content_sha256', 'episode_id', 'store_id']
export const CONTENT_SHA256_RE = /^[0-9a-f]{64}$/

function hasIllegalChars(value) {
  for (const ch of String(value)) {
    const code = ch.codePointAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}

export function validatePromotionSources(value) {
  if (!Array.isArray(value)) return { ok: false, error: 'promotion-sources-shape' }
  if (value.length === 0) return { ok: false, error: 'promotion-sources-empty' }
  for (let index = 0; index < value.length; index++) {
    const source = value[index]
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        Object.keys(source).sort().join('\0') !== [...PROMOTION_SOURCE_KEYS].sort().join('\0') ||
        PROMOTION_SOURCE_KEYS.some(key => typeof source[key] !== 'string') ||
        source.episode_id.length === 0 || !STORE_ID_RE.test(source.store_id)) {
      return { ok: false, error: 'promotion-sources-shape', index }
    }
    if (!CONTENT_SHA256_RE.test(source.content_sha256)) return { ok: false, error: 'promotion-sources-hash', index }
    if (PROMOTION_SOURCE_KEYS.some(key => hasIllegalChars(source[key]))) return { ok: false, error: 'promotion-sources-chars', index }
  }
  return { ok: true }
}

export function canonicalizePromotionSources(value) {
  const validation = validatePromotionSources(value)
  if (!validation.ok) {
    const err = new Error(validation.error)
    Object.assign(err, validation)
    throw err
  }
  return value.map(source => ({
    content_sha256: source.content_sha256,
    episode_id: source.episode_id,
    store_id: source.store_id,
  })).sort((a, b) => {
    const aj = JSON.stringify(a)
    const bj = JSON.stringify(b)
    return aj < bj ? -1 : aj > bj ? 1 : 0
  })
}

export function serializePromotionSources(value) {
  return JSON.stringify(canonicalizePromotionSources(value))
}

export function computeContentSha256(buf) {
  const normalized = Buffer.from(buf).toString('utf8').replace(/\r\n/g, '\n')
  return crypto.createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')
}

export function resolveSourceRefs(refs, registry) {
  const byId = new Map()
  for (const store of Array.isArray(registry) ? registry : []) {
    if (typeof store?.store_id === 'string') byId.set(store.store_id, store)
    for (const alias of Array.isArray(store?.store_aliases) ? store.store_aliases : []) byId.set(alias, store)
  }
  const resolved = []
  const missing = []
  for (const source of Array.isArray(refs) ? refs : []) {
    const store = byId.get(source.store_id)
    if (store) resolved.push({ source, store })
    else missing.push(source)
  }
  return { resolved, missing }
}
