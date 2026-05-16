// Fixture: monkey-patch fs.renameSync to fail on episode-file renames.
// Triggered by env var FAIL_EPISODE_RENAME=1. Used by #287 rollback tests
// to simulate a mid-iteration writer crash and verify the compensating
// rollback unwinds key + index row + episode tmp file.

import fs from 'node:fs'

const originalRenameSync = fs.renameSync

fs.renameSync = function patchedRenameSync(src, dst) {
  if (process.env.FAIL_EPISODE_RENAME && typeof dst === 'string'
      && dst.includes('/.episodic-memory/episodes/')
      && dst.endsWith('.md')) {
    throw new Error(`injected episode renameSync failure for ${dst}`)
  }
  return originalRenameSync.call(this, src, dst)
}
