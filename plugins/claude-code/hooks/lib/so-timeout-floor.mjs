/**
 * so-timeout-floor.mjs — pure helpers enforcing a Bash-timeout floor on
 * second-opinion harness dispatch calls.
 *
 * Rationale: when an agent invokes `second-opinion.mjs request --dispatch`
 * (or `--consensus`) via the Claude Code Bash tool with the default 120000ms
 * timeout, the outer tool SIGTERMs the codex child long before codex returns,
 * surfacing as `provider-dispatch-nonzero` with `exitCode: null`. The harness
 * cannot defend against this from inside its own process; the Bash tool's
 * timeout is bound at the tool-call boundary. We enforce it at the hook layer.
 *
 * Trust model: honest agent. Tokenizer mirrors the harness's argv parser
 * semantics (`argv.indexOf` first-match). Exotic shell shapes (`$(...)`,
 * backticks, process substitution, here-docs) are documented limitations
 * (axis A38) — not in v1 scope.
 *
 * Sequencing in second-opinion-gate.mjs:
 *   isHarnessRequest() → checkTimeoutFloor() → checkRunbookGate()
 * Timeout-floor fires BEFORE runbook gate so insufficient-timeout callers
 * get one clear instruction instead of being routed through the runbook
 * acknowledgment loop and then SIGTERM'd anyway.
 */

export const TIMEOUT_FLOOR_MS = 600000

const TOP_LEVEL_SEPARATORS = new Set([';', '&&', '||', '|', '&'])

/**
 * tokenizeCommand — quote-respecting walk producing an argv-like token array.
 * Mirrors the shape the harness's argv parser sees: single-quoted runs are
 * literal; double-quoted runs honor backslash; bare runs split on whitespace.
 * Token-level matchers (`tokens.indexOf('--dispatch')`) align with the
 * harness's `argv.indexOf` semantics at scripts/second-opinion.mjs:50.
 */
export function tokenizeCommand(cmd) {
  const tokens = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let i = 0
  const flush = () => {
    if (cur.length > 0) {
      tokens.push(cur)
      cur = ''
    }
  }
  while (i < cmd.length) {
    const c = cmd[i]
    if (inSingle) {
      if (c === "'") {
        inSingle = false
      } else {
        cur += c
      }
      i++
      continue
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < cmd.length) {
        cur += cmd[i + 1]
        i += 2
        continue
      }
      if (c === '"') {
        inDouble = false
        i++
        continue
      }
      cur += c
      i++
      continue
    }
    if (c === "'") {
      inSingle = true
      i++
      continue
    }
    if (c === '"') {
      inDouble = true
      i++
      continue
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1]
      i += 2
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      flush()
      i++
      continue
    }
    cur += c
    i++
  }
  flush()
  return tokens
}

/**
 * splitTopLevelSegments — split command string at unquoted shell control
 * operators (`;`, `&&`, `||`, `|`, `&`, `\n`, `\r`). Returns the literal
 * substrings so each segment can be re-tokenized independently. Quoted
 * regions are opaque (a `;` inside `"..."` does not split). Command
 * substitution `$(...)` and backticks are NOT recognized; they fall under
 * axis A38 (documented DEFER). Newline is a top-level separator (axis A39)
 * — honest agents legitimately write multi-line `tool_input.command`.
 */
export function splitTopLevelSegments(cmd) {
  const segments = []
  let start = 0
  let inSingle = false
  let inDouble = false
  let i = 0
  // Backslash-escaped newline is a line-continuation in shell — preserve as
  // joining, not splitting. We model this by skipping the escape and the
  // newline together (handled by the existing `\\` lookahead in the bare
  // walk below, since `\` + any char = consume both as part of the segment).
  while (i < cmd.length) {
    const c = cmd[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      i++
      continue
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < cmd.length) { i += 2; continue }
      if (c === '"') inDouble = false
      i++
      continue
    }
    if (c === "'") { inSingle = true; i++; continue }
    if (c === '"') { inDouble = true; i++; continue }
    if (c === '\\' && i + 1 < cmd.length) { i += 2; continue }
    // Two-char operators first.
    if (c === '&' && cmd[i + 1] === '&') {
      segments.push(cmd.slice(start, i))
      i += 2
      start = i
      continue
    }
    if (c === '|' && cmd[i + 1] === '|') {
      segments.push(cmd.slice(start, i))
      i += 2
      start = i
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      segments.push(cmd.slice(start, i))
      i += 1
      start = i
      continue
    }
    i++
  }
  segments.push(cmd.slice(start))
  return segments
}

/**
 * unwrapExecPayload — if tokens look like `[env? bash|sh|zsh|dash|ksh, -c,
 * '<payload>', ...]` (with optional `VAR=val` env prefixes before the exec),
 * return the payload string. Otherwise null.
 *
 * Closes axis A40 (negative-scenario-reviewer MAJOR-2): honest agents
 * legitimately wrap long commands in `bash -c '...'` to control quoting.
 * tokenizeCommand returns the wrapped command as ONE quoted token, so a
 * per-segment token walk would miss the `--dispatch` inside. Recurse into
 * the payload by splitting + re-evaluating it.
 */
const EXEC_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])

function unwrapExecPayload(tokens) {
  let i = 0
  // Skip env-prefix VAR=val tokens (positional shell env-prefix, e.g. `FOO=bar bash -c ...`).
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
  if (i >= tokens.length) return null
  const exec = tokens[i]
  // Strip leading path: /usr/bin/bash → bash.
  const execName = exec.split('/').pop()
  if (!EXEC_WRAPPERS.has(execName)) return null
  // Look ahead for -c (must be the next token; intervening flags like
  // `bash -l -c` are rare and intentionally not unwrapped — false-negative
  // tradeoff over false-positive).
  if (i + 1 >= tokens.length) return null
  if (tokens[i + 1] !== '-c') return null
  if (i + 2 >= tokens.length) return null
  return tokens[i + 2]
}

/**
 * isHarnessSegment — token-level check: does this segment invoke
 * `second-opinion.mjs request`? Stricter than the substring-level
 * `isHarnessRequest` in the gate (which intentionally catches more shapes
 * to keep the runbook gate broad). For timeout-floor we only enforce on
 * tokens we can actually parse — anything else falls through to runbook
 * gate handling.
 */
function isHarnessSegment(tokens) {
  let sawScript = false
  let sawRequest = false
  for (const t of tokens) {
    if (/second-opinion\.mjs$/.test(t) || t === 'second-opinion.mjs') {
      sawScript = true
    }
    if (sawScript && t === 'request') {
      sawRequest = true
      break
    }
  }
  return sawScript && sawRequest
}

/**
 * evaluateSegment — per-segment decision. Block if and only if:
 *   - segment is a harness `request` invocation
 *   - segment has `--dispatch` OR `--consensus` as a token
 *   - first `--provider` token (mirrors harness first-match parser) is NOT `stub`
 *   - tool_input.timeout (default 120000 per Claude Code Bash tool) < TIMEOUT_FLOOR_MS
 *
 * Recursion: if the segment is an exec-wrapper (`bash -c '<payload>'`),
 * the payload is split + re-evaluated. Depth-limited to prevent runaway
 * nested wrappers.
 *
 * Argv-semantics mirror: this function tracks the harness's
 * `argv.indexOf('--provider')` first-match parser (scripts/second-opinion.mjs:50).
 * Notable mirrored quirks: `--provider=codex` equals-form is NOT honored by
 * either parser (extra.provider will be null, outcome is conservatively to
 * block since null !== 'stub'). If the harness ever switches to honoring
 * equals-form, this function must change in lockstep.
 *
 * Registry-default coupling: this function does NOT read the provider
 * registry's `defaults.provider`. If that default ever becomes `stub`, this
 * function will continue to block missing-provider invocations whereas the
 * harness would dispatch to stub. Acceptable mismatch direction (over-block
 * is safe); the inverse would be a bypass.
 */
const MAX_UNWRAP_DEPTH = 3

function evaluateSegment(segment, toolInput, depth = 0) {
  const tokens = tokenizeCommand(segment)
  if (tokens.length === 0) return { block: false }

  // Exec-wrapper recursion (axis A40): if this segment is `bash -c '<payload>'`,
  // re-split and re-evaluate the payload. Depth-limited.
  if (depth < MAX_UNWRAP_DEPTH) {
    const payload = unwrapExecPayload(tokens)
    if (payload !== null) {
      const inner = splitTopLevelSegments(payload)
      for (const seg of inner) {
        const r = evaluateSegment(seg, toolInput, depth + 1)
        if (r.block) return r
      }
      // Wrapper not harness itself + no inner segment blocks → allow.
      return { block: false }
    }
  }

  if (!isHarnessSegment(tokens)) return { block: false }

  const hasDispatch = tokens.indexOf('--dispatch') !== -1
  const hasConsensus = tokens.indexOf('--consensus') !== -1
  if (!hasDispatch && !hasConsensus) return { block: false }

  const provIdx = tokens.indexOf('--provider')
  const firstProvider = (provIdx !== -1 && provIdx + 1 < tokens.length)
    ? tokens[provIdx + 1]
    : null
  // Stub carve-out: stub provider returns instantly; no SIGTERM risk.
  if (firstProvider === 'stub') return { block: false }

  const t = typeof toolInput?.timeout === 'number' ? toolInput.timeout : 120000
  if (t >= TIMEOUT_FLOOR_MS) return { block: false }

  return {
    block: true,
    reason:
      `second-opinion harness dispatch needs Bash timeout >= ${TIMEOUT_FLOOR_MS}ms ` +
      `(got ${t}ms). Default Claude Code Bash timeout is 120000ms; codex/gemini ` +
      `provider dispatch routinely exceeds this and the outer Bash SIGTERM ` +
      `surfaces as provider-dispatch-nonzero with exitCode:null. ` +
      `Retry with tool_input.timeout = ${TIMEOUT_FLOOR_MS}.`,
    extra: {
      code: 'so-timeout-below-floor',
      floorMs: TIMEOUT_FLOOR_MS,
      gotMs: t,
      provider: firstProvider,
    },
  }
}

/**
 * checkTimeoutFloor — main entry. Walks every top-level segment; first
 * segment that warrants a block wins. Used by second-opinion-gate.mjs
 * inside the isHarnessRequest() branch (before checkRunbookGate).
 *
 * Returns { block: false } OR { block: true, reason, extra }.
 */
export function checkTimeoutFloor(toolInput) {
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : ''
  if (cmd.length === 0) return { block: false }
  const segments = splitTopLevelSegments(cmd)
  for (const seg of segments) {
    const r = evaluateSegment(seg, toolInput)
    if (r.block) return r
  }
  return { block: false }
}
