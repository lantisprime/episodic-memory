/**
 * registry-validator.mjs — Validate provider registry shape.
 *
 * Contract: each provider entry must have:
 *   - id: non-empty string
 *   - prompt_max_chars: Number.isInteger(x) && x >= 0
 *   - cli_match: non-empty string + compilable regex (per hook block-class 1-3)
 *   - binary: non-empty string (per hook binary-resolution path)
 *   - agent_block_patterns: array of strings (per hook Agent branch block)
 *   - agent_allow_patterns: array of strings (per hook Agent branch allow)
 *
 * Plus N1 (empty providers vacuous-pass) + N10 (duplicate id dedupe).
 *
 * I-NEW-B: snapshot provider entries are validated against the same shape
 * contract as the source registry, before any hook reads them. This module
 * is invoked at install (write-time), readSnapshot (read-time), and hook
 * (gate-time) — single shared validator, single source of truth.
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

    // cli_match — non-empty string + compilable as RegExp.
    const cliMatch = provider.cli_match
    if (typeof cliMatch !== 'string' || cliMatch.length === 0) {
      const err = new Error(
        `Provider ${id} has invalid cli_match: observed ${JSON.stringify(cliMatch)}, expected non-empty string`
      )
      err.code = 'registry-invalid'
      err.provider = id
      err.field = 'cli_match'
      err.observed = cliMatch
      throw err
    }
    try {
      new RegExp(cliMatch)
    } catch (regexErr) {
      const err = new Error(
        `Provider ${id} has invalid cli_match regex: ${regexErr.message}`
      )
      err.code = 'registry-invalid'
      err.provider = id
      err.field = 'cli_match'
      err.observed = cliMatch
      err.regexError = regexErr.message
      throw err
    }

    // binary — non-empty string.
    const binary = provider.binary
    if (typeof binary !== 'string' || binary.length === 0) {
      const err = new Error(
        `Provider ${id} has invalid binary: observed ${JSON.stringify(binary)}, expected non-empty string`
      )
      err.code = 'registry-invalid'
      err.provider = id
      err.field = 'binary'
      err.observed = binary
      throw err
    }

    // agent_block_patterns / agent_allow_patterns — arrays of strings.
    for (const field of ['agent_block_patterns', 'agent_allow_patterns']) {
      const arr = provider[field]
      if (!Array.isArray(arr)) {
        const err = new Error(
          `Provider ${id} has invalid ${field}: observed ${JSON.stringify(arr)}, expected array of strings`
        )
        err.code = 'registry-invalid'
        err.provider = id
        err.field = field
        err.observed = arr
        throw err
      }
      for (let i = 0; i < arr.length; i++) {
        if (typeof arr[i] !== 'string') {
          const err = new Error(
            `Provider ${id} has non-string entry in ${field}[${i}]: observed ${JSON.stringify(arr[i])}`
          )
          err.code = 'registry-invalid'
          err.provider = id
          err.field = field
          err.observed = arr[i]
          err.index = i
          throw err
        }
      }
    }
  }

  return { ok: true, providerCount: reg.providers.length }
}
