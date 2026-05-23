#!/usr/bin/env node
/**
 * classifier-config-loader.mjs — Resolve LLM-classifier config.
 *
 * Precedence: env > project > global > defaults.
 *   env:     LLM_CLASSIFIER_{MODEL,ENABLED,FAIL_MODE,TIMEOUT_MS,MAX_TOKENS,TEMPERATURE,CONFIDENCE_THRESHOLD,API_BASE,API_VERSION}
 *   project: <projectRoot>/.episodic-memory/classifier-config.json
 *   global:  ~/.episodic-memory/classifier-config.json
 *
 * Usage (CLI):
 *   node classifier-config-loader.mjs --project-root <abs-path>
 * Usage (import):
 *   import { loadConfig } from './classifier-config-loader.mjs'
 *   const cfg = loadConfig({ projectRoot, env: process.env })
 *
 * Output: canonical config JSON on stdout (CLI), or returned object (import).
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

const DEFAULTS = Object.freeze({
  model: 'claude-haiku-4-5-20251001',
  enabled: true,
  fail_mode: 'heuristic',
  timeout_ms: 5000,
  max_tokens: 200,
  temperature: 0,
  confidence_threshold: 0.7,
  api_base: 'https://api.anthropic.com',
  api_version: '2023-06-01'
})

const FAIL_MODES = new Set(['heuristic', 'block'])

function readJsonOrNull(p) {
  let txt
  try {
    txt = fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
  try {
    return JSON.parse(txt)
  } catch (err) {
    // F12-fix: surface malformed config — silently falling back to defaults
    // makes a corrupt project config invisible. stderr only; never throw
    // (the classifier must remain available).
    process.stderr.write(`classifier-config-loader: warning: failed to parse ${p}: ${err.message}\n`)
    return null
  }
}

function coerceBool(v) {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false
  return undefined
}

function coerceNum(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function coerceStr(v) {
  if (v === undefined || v === null) return undefined
  const s = String(v).trim()
  return s.length ? s : undefined
}

function fromEnv(env) {
  return {
    model: coerceStr(env.LLM_CLASSIFIER_MODEL),
    enabled: coerceBool(env.LLM_CLASSIFIER_ENABLED),
    fail_mode: coerceStr(env.LLM_CLASSIFIER_FAIL_MODE),
    timeout_ms: coerceNum(env.LLM_CLASSIFIER_TIMEOUT_MS),
    max_tokens: coerceNum(env.LLM_CLASSIFIER_MAX_TOKENS),
    temperature: coerceNum(env.LLM_CLASSIFIER_TEMPERATURE),
    confidence_threshold: coerceNum(env.LLM_CLASSIFIER_CONFIDENCE_THRESHOLD),
    api_base: coerceStr(env.LLM_CLASSIFIER_API_BASE),
    api_version: coerceStr(env.LLM_CLASSIFIER_API_VERSION)
  }
}

function fromFile(p) {
  const raw = readJsonOrNull(p)
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const k of Object.keys(DEFAULTS)) {
    if (raw[k] !== undefined) out[k] = raw[k]
  }
  return out
}

function merge(target, layer) {
  for (const k of Object.keys(layer)) {
    if (layer[k] !== undefined) target[k] = layer[k]
  }
  return target
}

function validate(cfg, warnings) {
  // fail_mode enum — reject unknown, also explicitly reject "allow" (R1-F4).
  if (!FAIL_MODES.has(cfg.fail_mode)) {
    warnings.push(`fail_mode "${cfg.fail_mode}" invalid; falling back to "heuristic"`)
    cfg.fail_mode = 'heuristic'
  }
  if (typeof cfg.enabled !== 'boolean') cfg.enabled = true
  if (!cfg.model || typeof cfg.model !== 'string') {
    warnings.push(`model invalid; falling back to default`)
    cfg.model = DEFAULTS.model
  }
  for (const k of ['timeout_ms', 'max_tokens', 'temperature', 'confidence_threshold']) {
    if (typeof cfg[k] !== 'number' || !Number.isFinite(cfg[k])) {
      warnings.push(`${k} invalid; using default`)
      cfg[k] = DEFAULTS[k]
    }
  }
  if (cfg.timeout_ms < 100 || cfg.timeout_ms > 60000) {
    warnings.push(`timeout_ms ${cfg.timeout_ms} out of [100,60000]; using default`)
    cfg.timeout_ms = DEFAULTS.timeout_ms
  }
  if (cfg.confidence_threshold < 0 || cfg.confidence_threshold > 1) {
    warnings.push(`confidence_threshold ${cfg.confidence_threshold} out of [0,1]; using default`)
    cfg.confidence_threshold = DEFAULTS.confidence_threshold
  }
  if (cfg.temperature < 0 || cfg.temperature > 2) {
    warnings.push(`temperature ${cfg.temperature} out of [0,2]; using default`)
    cfg.temperature = DEFAULTS.temperature
  }
  if (cfg.max_tokens < 1 || cfg.max_tokens > 4096) {
    warnings.push(`max_tokens ${cfg.max_tokens} out of [1,4096]; using default`)
    cfg.max_tokens = DEFAULTS.max_tokens
  }
}

export function loadConfig({ projectRoot, env = process.env, homeDir = os.homedir() } = {}) {
  const cfg = { ...DEFAULTS }
  const warnings = []

  const globalPath = path.join(homeDir, '.episodic-memory', 'classifier-config.json')
  merge(cfg, fromFile(globalPath))

  if (projectRoot) {
    const projectPath = path.join(projectRoot, '.episodic-memory', 'classifier-config.json')
    merge(cfg, fromFile(projectPath))
    cfg._project_config_path = projectPath
  }
  cfg._global_config_path = globalPath

  merge(cfg, fromEnv(env))
  validate(cfg, warnings)

  cfg._warnings = warnings
  cfg._sources_seen = {
    env: Object.entries(fromEnv(env)).filter(([, v]) => v !== undefined).map(([k]) => k),
    project: fs.existsSync(cfg._project_config_path || '') ? cfg._project_config_path : null,
    global: fs.existsSync(globalPath) ? globalPath : null
  }
  return cfg
}

// ---- CLI ----
function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--project-root')
  const projectRoot = i >= 0 ? argv[i + 1] : null
  const cfg = loadConfig({ projectRoot })
  process.stdout.write(JSON.stringify(cfg, null, 2) + '\n')
  if (cfg._warnings.length) {
    for (const w of cfg._warnings) process.stderr.write(`warning: ${w}\n`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
