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
// missing/unreadable paths, files/streams exceeding MAX_BODY_BYTES, and empty
// post-strip content.
//
// Path semantics: relative paths resolve against the calling script's
// process.cwd() — same as fs.statSync's default. Pass an absolute path or
// run from the directory containing the body file.
//
// STDIN: pass `--body-file -` to read the body from standard input. This is
// the shell-interpolation-SAFE way to supply a body that contains backticks,
// `$(...)`, or `$VAR` — a quoted heredoc suppresses all substitution:
//
//     node em-store.mjs ... --body-file - <<'EOF'
//     body text with `backticks` and $(command) preserved verbatim
//     EOF
//
// Inline `--body "…"` is NOT safe for such bodies: the shell command-
// substitutes backticks / `$(...)` inside the double-quoted argument BEFORE
// the script ever sees it, silently corrupting the stored body. There is no
// way to recover the original in-script (the mangling already happened), so
// use `--body-file <path>` or `--body-file -` for any non-trivial body.
//
// A bare `-` reads stdin even if a real file named `-` exists; pass `./-` to
// target that file.
//
// Size cap: MAX_BODY_BYTES (1 MB) guards against accidental huge-file/huge-pipe
// blowups. It does NOT keep em-violation's delegated body within the OS argv
// limit — a 1 MB argv value overflows ARG_MAX — so em-violation pipes the body
// to its em-store child over stdin (`--body-file -`) rather than as `--body`.

import fs from 'fs'
import { isatty } from 'tty'

export const MAX_BODY_BYTES = 1024 * 1024  // 1 MB

// Shared post-read normalization: strip a leading BOM and exactly one trailing
// newline, then reject empty content. `label` prefixes the empty-content error
// so the caller can tell a file source from the stdin source.
function normalizeBody(text, label) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  if (text.endsWith('\r\n')) text = text.slice(0, -2)
  else if (text.endsWith('\n')) text = text.slice(0, -1)
  if (text.length === 0) {
    console.log(JSON.stringify({ status: 'error', message: `${label} is empty` }))
    process.exit(1)
  }
  return text
}

function readStdinBody() {
  // A pipe/redirect has no seekable size, so we cannot stat it up front. Read
  // in bounded chunks and abort the moment cumulative bytes exceed the cap, so
  // an unbounded producer (`head -c 5G /dev/zero | … --body-file -`) can never
  // allocate past MAX_BODY_BYTES + one chunk — the file path's st.size guard
  // has a byte-for-byte equivalent here. Guard against an interactive TTY,
  // where a synchronous read of fd 0 would block forever waiting for input.
  //
  // Use tty.isatty(0), NOT process.stdin.isTTY: merely *accessing* the latter
  // lazily constructs Node's stdin stream, which switches fd 0 to non-blocking
  // mode — after which a synchronous read throws EAGAIN the moment the ~64 KB
  // pipe buffer drains, so any body larger than that would fail. isatty() is a
  // pure syscall that leaves fd 0 blocking. (Regression guard: the >64 KB and
  // 1 MB real-pipe cases in test-em-body-file.mjs.)
  if (isatty(0)) {
    console.log(JSON.stringify({ status: 'error', message: "--body-file -: no data on stdin (it is a TTY); pipe the body in, e.g. `--body-file - <<'EOF'`" }))
    process.exit(1)
  }
  const CHUNK = 64 * 1024
  const chunk = Buffer.allocUnsafe(CHUNK)
  const parts = []
  let total = 0
  for (;;) {
    let n
    try {
      n = fs.readSync(0, chunk, 0, CHUNK, null)  // fd 0 = stdin
    } catch (e) {
      if (e.code === 'EAGAIN') continue          // non-blocking fd 0: retry
      if (e.code === 'EOF') break                // some platforms signal EOF by throwing
      console.log(JSON.stringify({ status: 'error', message: `--body-file -: cannot read stdin: ${e.message}` }))
      process.exit(1)
    }
    if (n === 0) break                            // EOF
    total += n
    if (total > MAX_BODY_BYTES) {
      console.log(JSON.stringify({ status: 'error', message: `--body-file -: stdin exceeds max ${MAX_BODY_BYTES} bytes (1 MB)` }))
      process.exit(1)
    }
    parts.push(Buffer.from(chunk.subarray(0, n)))
  }
  return normalizeBody(Buffer.concat(parts, total).toString('utf8'), '--body-file -: stdin')
}

export function readBodyFile(p) {
  if (!p) {
    console.log(JSON.stringify({ status: 'error', message: '--body-file: empty path argument' }))
    process.exit(1)
  }
  if (p === '-') return readStdinBody()
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
  if (st.size > MAX_BODY_BYTES) {
    console.log(JSON.stringify({ status: 'error', message: `--body-file: "${p}" is ${st.size} bytes; max is ${MAX_BODY_BYTES} bytes (1 MB)` }))
    process.exit(1)
  }
  let text
  try {
    text = fs.readFileSync(p, 'utf8')
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: `--body-file: cannot read "${p}": ${e.message}` }))
    process.exit(1)
  }
  return normalizeBody(text, `--body-file: "${p}"`)
}
