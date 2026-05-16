// Fixture: monkey-patch fs operations to simulate crashes for #287 tests.
//
// FAIL_EPISODE_RENAME=1 — fs.renameSync throws on episode-file renames
//   (final .md rename). Used to simulate writer-crash mid-iteration so
//   the compensating rollback path is exercised.
//
// FAIL_SHRED_KEY=1 — fs.unlinkSync throws on run.key paths. Used to
//   force a rollback-step failure (key shred) so the sentinel-write
//   observability is verified end-to-end (not just smoke-tested).

import fs from 'node:fs'

const originalRenameSync = fs.renameSync
const originalUnlinkSync = fs.unlinkSync

fs.renameSync = function patchedRenameSync(src, dst) {
  if (process.env.FAIL_EPISODE_RENAME && typeof dst === 'string'
      && dst.includes('/.episodic-memory/episodes/')
      && dst.endsWith('.md')) {
    throw new Error(`injected episode renameSync failure for ${dst}`)
  }
  return originalRenameSync.call(this, src, dst)
}

fs.unlinkSync = function patchedUnlinkSync(target) {
  if (process.env.FAIL_SHRED_KEY && typeof target === 'string'
      && target.includes('/.episodic-memory/runs/')
      && target.endsWith('/run.key')) {
    throw new Error(`injected run.key unlinkSync failure for ${target}`)
  }
  return originalUnlinkSync.call(this, target)
}
