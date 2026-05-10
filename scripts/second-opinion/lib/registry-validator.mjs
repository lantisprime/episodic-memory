/**
 * registry-validator.mjs — Validate provider registry shape.
 *
 * v3.3 contract: each provider entry must have:
 *   - id: non-empty string
 *   - prompt_max_chars: Number.isInteger(x) && x >= 0
 *
 * Plus inline FU N1 (empty providers vacuous-pass) + N10 (duplicate id dedupe)
 * per planner round 2 final-sanity finding (`feedback_inline_fu_heuristic.md`
 * sub-3-LOC same-surface fixes; applied during commit 1 implementation).
 *
 * Throws { code, message, ... } on first failure; caller maps to exit.
 */

export function validateProviderRegistry(reg) {
  if (!reg || typeof reg !== 'object') {
    const err = new Error('Registry is not an object')
    err.code = 'registry-invalid'
    throw err
  }
  if (reg.schema_version !== 1) {
    const err = new Error(`Unsupported registry schema_version: ${reg.schema_version}`)
    err.code = 'registry-schema-unsupported'
    throw err
  }
  if (!Array.isArray(reg.providers)) {
    const err = new Error('registry.providers must be an array')
    err.code = 'registry-invalid'
    throw err
  }
  // Inline FU N1: empty providers[] is a vacuous-pass class — reject.
  if (reg.providers.length === 0) {
    const err = new Error('registry.providers[] is empty — at least one provider required')
    err.code = 'registry-invalid'
    err.field = 'providers'
    throw err
  }

  // Inline FU N10: duplicate provider id dedupe.
  const seenIds = new Set()
  for (const provider of reg.providers) {
    if (!provider || typeof provider !== 'object') {
      const err = new Error('Provider entry is not an object')
      err.code = 'registry-invalid'
      throw err
    }
    const id = provider.id
    if (typeof id !== 'string' || id.length === 0) {
      const err = new Error(`Provider entry missing valid 'id' field`)
      err.code = 'registry-invalid'
      err.field = 'id'
      err.observed = id
      throw err
    }
    if (seenIds.has(id)) {
      const err = new Error(`Duplicate provider id in registry: ${id}`)
      err.code = 'registry-invalid'
      err.field = 'id'
      err.duplicate = id
      throw err
    }
    seenIds.add(id)

    const max = provider.prompt_max_chars
    if (!(Number.isInteger(max) && max >= 0)) {
      const err = new Error(
        `Provider ${id} has invalid prompt_max_chars: observed ${JSON.stringify(max)}, expected non-negative integer`
      )
      err.code = 'registry-invalid'
      err.provider = id
      err.field = 'prompt_max_chars'
      err.observed = max
      throw err
    }
  }

  return { ok: true, providerCount: reg.providers.length }
}
