// run-direct.mjs — shared ESM direct-run guard (issue #380).
//
// `import.meta.url === pathToFileURL(process.argv[1]).href` fail-opens when the
// script is invoked through a symlink: Node realpaths the main module, so
// import.meta.url carries the real path while argv[1] keeps the symlink
// spelling. main() never runs and the CLI exits 0 with NO output — a vacuous
// green. The raw `file://${argv[1]}` form additionally breaks on paths with a
// space (the URL percent-encodes it; argv[1] does not).
//
// isMain resolves BOTH sides to their real filesystem path (falling back to the
// raw spelling when realpath throws) and compares them as file URLs, so it
// holds under symlinks, spaces, and --preserve-symlinks-main.
//
// Usage: if (isMain(import.meta.url)) main()

import fs from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'

function realOrRaw(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

export function isMain(importMetaUrl) {
  const arg = process.argv[1]
  if (!arg || !importMetaUrl) return false
  try {
    const self = realOrRaw(fileURLToPath(importMetaUrl))
    return pathToFileURL(realOrRaw(arg)).href === pathToFileURL(self).href
  } catch {
    return false
  }
}
