// body-file.mjs — Shared `--body-file <path>` reader for em-store, em-revise,
// em-violation. Centralizes the read/strip/validate logic so the three CLIs
// behave identically.
//
// On any failure (including empty argv `""`), prints a JSON `status: error`
// envelope to stdout and calls `process.exit(1)` — matches the existing
// validation pattern in the calling scripts.
//
// Strips a leading BOM and exactly one trailing `\n` or `\r\n`. Rejects
// directories (statSync follows symlinks; symlink-to-file is allowed),
// missing/unreadable paths, and empty post-strip content.

import fs from 'fs'

export function readBodyFile(p) {
  if (!p) {
    console.log(JSON.stringify({ status: 'error', message: '--body-file: empty path argument' }))
    process.exit(1)
  }
  let st
  try {
    st = fs.statSync(p)
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: `--body-file: cannot stat "${p}": ${e.message}` }))
    process.exit(1)
  }
  if (!st.isFile()) {
    console.log(JSON.stringify({ status: 'error', message: `--body-file: "${p}" is not a regular file` }))
    process.exit(1)
  }
  let text
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: `--body-file: cannot read "${p}": ${e.message}` }))
    process.exit(1)
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  if (text.endsWith('\r\n')) text = text.slice(0, -2)
  else if (text.endsWith('\n')) text = text.slice(0, -1)
  if (text.length === 0) {
    console.log(JSON.stringify({ status: 'error', message: `--body-file: "${p}" is empty` }))
    process.exit(1)
  }
  return text
}
