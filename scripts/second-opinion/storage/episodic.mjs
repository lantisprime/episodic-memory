/**
 * episodic.mjs — Episodic-storage adapter for the second-opinion harness.
 *
 * Shells out to em-store.mjs with explicit cwd: projectRoot. NEVER relies on
 * subprocess cwd inheritance — that's the PR #218 orphaned-reply class.
 * Per v3 §Two roots: every subprocess passes cwd: projectRoot, shell: false.
 *
 * Returns the parsed em-store JSON envelope: { status, id, file, scope }.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Write a request as a local-scope episode via em-store.
 * Body is passed via --body-file (avoids argv-length limits).
 */
export function writeRequest({ projectRoot, harnessRoot, body, meta }) {
  if (!projectRoot) throw new Error('writeRequest: projectRoot is required')
  if (!harnessRoot) throw new Error('writeRequest: harnessRoot is required')
  if (typeof body !== 'string') throw new Error('writeRequest: body must be a string')
  if (!meta || typeof meta !== 'object') throw new Error('writeRequest: meta object required')

  // Write body to tmp file (em-store --body-file expects a path).
  const bodyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-episodic-req-'))
  const bodyPath = path.join(bodyTmp, 'body.md')
  try {
    fs.writeFileSync(bodyPath, body, 'utf8')

    const tags = Array.isArray(meta.tags) ? meta.tags.join(',') : (meta.tags || '')
    const summary = meta.summary || 'second-opinion request'
    const project = meta.project || 'episodic-memory'
    const category = meta.category || 'decision'

    const emStorePath = path.join(harnessRoot, 'scripts', 'em-store.mjs')

    const result = spawnSync('node', [
      emStorePath,
      '--project', project,
      '--scope', 'local',
      '--category', category,
      '--tags', tags,
      '--summary', summary,
      '--body-file', bodyPath,
    ], {
      cwd: projectRoot,            // CRITICAL: explicit cwd binding (I-22 / PR #218)
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (result.status !== 0) {
      const err = new Error(`em-store failed (exit ${result.status}): ${result.stderr.toString()}`)
      err.code = 'em-store-failed'
      err.stderr = result.stderr.toString()
      err.exitCode = result.status
      throw err
    }
    return JSON.parse(result.stdout.toString())
  } finally {
    try { fs.rmSync(bodyTmp, { recursive: true, force: true }) } catch {}
  }
}

/**
 * Write a reply as a local-scope episode via em-store. Tags include reply-to-<id>.
 */
export function writeReply({ projectRoot, harnessRoot, requestId, body, meta }) {
  if (!requestId) throw new Error('writeReply: requestId is required')
  const tags = Array.isArray(meta.tags) ? [...meta.tags] : (meta.tags ? meta.tags.split(',') : [])
  if (!tags.includes(`reply-to-${requestId}`)) {
    tags.push(`reply-to-${requestId}`)
  }
  return writeRequest({
    projectRoot,
    harnessRoot,
    body,
    meta: { ...meta, tags },
  })
}
