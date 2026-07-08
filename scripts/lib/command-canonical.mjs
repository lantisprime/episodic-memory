/**
 * scripts/lib/command-canonical.mjs — CONSERVATIVE canonical command form for
 * the classifier verdict cache (classifier-marker.mjs) and the read-only
 * command manifest (patterns/readonly-commands.json).
 *
 * Problem (gate-classifier UX E3): the per-session verdict cache keyed on the
 * literal normalized command string, so `node em-search.mjs --limit 1` and
 * `node em-search.mjs --limit 2` were DIFFERENT cache entries — verdicts never
 * generalized and every flag-value variant re-held for agent classification
 * (~770 near-duplicate verdict files observed in .checkpoints/classify/).
 *
 * Canonical form:
 *   <executable> [<subcommand-or-script-path>] <sorted set of flag names>
 *
 *   - executable: token 0, path-resolved against caller cwd when path-shaped,
 *     with absolute prefixes under the project root / $HOME normalized to
 *     `<REPO>` / `<HOME>` placeholders.
 *   - subject: for interpreters (node/python/python3/ruby/perl) the script
 *     path token (always path-resolved + placeholder-normalized); for other
 *     executables the subcommand token, ONLY when it immediately follows the
 *     executable (a non-flag token appearing after any flag is treated as a
 *     flag value / operand and dropped).
 *   - flags: the SET of flag NAMES (token up to the first `=`), deduped and
 *     sorted. Flag VALUES and positional operands are dropped — that is the
 *     generalization. Two commands with different flag-NAME sets can never
 *     share a key.
 *
 * CONSERVATIVE refusals — canonicalizeCommand returns { canonical: null }
 * (callers must fall back to the literal-key behavior) when the command:
 *   - contains ANY shell metacharacter, quote, expansion, glob, or redirect
 *     syntax (`> < | ; & $ \` ( ) ' " \\ * ? [ ] { } !`, newline). This is what
 *     guarantees "a command with an output-redirect or additional
 *     write-capable token MUST NOT hit a read_only verdict cached from a form
 *     without it": the redirect variant is never canonicalizable, so it can
 *     only key on its own literal form.
 *   - has a leading env-assignment (`FOO=bar cmd …`) — cross-session attack
 *     class (PR #271/#272); env-prefixed forms never share ANY cache lane.
 *   - has a non-flag operand containing `=` (`dd of=/x`, `key=value` payload
 *     args) — ambiguous write-capable shape.
 *   - is an interpreter invocation mixing leading flags with operands
 *     (`node -e code`) — we cannot tell which token is the script. A pure
 *     flag-only interpreter form (`node --version`) IS canonicalizable.
 *   - has a bare `-` / `--` operand (stdin markers, arg separators).
 *
 * Zero deps, Node stdlib only. Cross-platform: placeholder paths always use
 * forward slashes regardless of path.sep.
 */

import path from 'path'
import os from 'os'

export const CANONICAL_FORM_VERSION = 1

export const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl'])

// Any shell syntax that can change what the command writes or which words are
// tokens: redirects, pipes, separators, substitution, quoting, escapes, globs,
// brace expansion, history expansion, newlines.
const SHELL_META_RE = /[><|;&$`()'"\\\n\r*?[\]{}!]/

// POSIX env-assignment prefix shape.
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

// A "bare flag": -x / --long-name / --long.name — no `=value`, no operand.
const BARE_FLAG_RE = /^--?[A-Za-z][A-Za-z0-9._-]*$/

function toSlashes(p) {
  return p.split(path.sep).join('/')
}

function isUnder(child, parent) {
  return child === parent || child.startsWith(parent + path.sep)
}

// Expand a leading `~/` (or bare `~`) against homeDir. No other tilde forms.
function expandTilde(tok, homeDir) {
  if (tok === '~') return homeDir
  if (tok.startsWith('~/')) return path.join(homeDir, tok.slice(2))
  return tok
}

// Placeholder-normalize an ABSOLUTE path: project root first (a repo under
// $HOME must map to <REPO>, not <HOME>), then home. Non-contained absolute
// paths stay absolute (slash-normalized).
function placeholderize(abs, projectRoot, homeDir) {
  if (projectRoot && isUnder(abs, projectRoot)) {
    const rel = path.relative(projectRoot, abs)
    return rel ? `<REPO>/${toSlashes(rel)}` : '<REPO>'
  }
  if (homeDir && isUnder(abs, homeDir)) {
    const rel = path.relative(homeDir, abs)
    return rel ? `<HOME>/${toSlashes(rel)}` : '<HOME>'
  }
  return toSlashes(abs)
}

// Resolve a token that IS a path (interpreter script arg) to canonical
// placeholder form. Relative paths resolve against callerCwd.
function normalizePathToken(tok, callerCwd, projectRoot, homeDir) {
  const expanded = expandTilde(tok, homeDir)
  const abs = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(callerCwd, expanded)
  return placeholderize(abs, projectRoot, homeDir)
}

// Resolve a token that MAY be a path (executable, non-interpreter subcommand):
// only tokens that are path-shaped (contain a separator or start with ~) are
// resolved; bare words (`git`, `status`, `shasum`) stay literal.
function maybeNormalizePath(tok, callerCwd, projectRoot, homeDir) {
  if (tok.includes('/') || tok === '~' || tok.startsWith('~/')) {
    return normalizePathToken(tok, callerCwd, projectRoot, homeDir)
  }
  return tok
}

/**
 * canonicalizeCommand({ command, projectRoot, callerCwd, homeDir? })
 *
 * projectRoot and callerCwd MUST already be canonical absolute paths (the
 * callers realpath them). Returns:
 *   {
 *     canonical: string | null,   // null → NOT canonicalizable (fall back)
 *     reason: string,             // why null, or 'ok'
 *     execToken: string | null,   // placeholder-normalized executable token
 *     execBase: string | null,    // basename of the RAW executable token
 *     subject: string,            // subcommand / script path ('' if none)
 *     flags: string[],            // sorted deduped flag-name set
 *     interpreter: boolean
 *   }
 */
export function canonicalizeCommand({ command, projectRoot, callerCwd, homeDir = os.homedir() }) {
  const none = (reason) => ({
    canonical: null, reason, execToken: null, execBase: null, execBare: false, subject: '', flags: [], interpreter: false
  })

  // Same normalization as classifier-marker.mjs normalizeCommand: strip
  // trailing #-comment, collapse whitespace, trim.
  const norm = String(command).replace(/#.*$/, '').replace(/\s+/g, ' ').trim()
  if (!norm) return none('empty')
  if (SHELL_META_RE.test(norm)) return none('shell_metachar')

  const toks = norm.split(' ')
  if (ENV_PREFIX_RE.test(toks[0])) return none('env_prefix')

  for (let i = 1; i < toks.length; i++) {
    if (toks[i] === '-' || toks[i] === '--') return none('bare_dash_operand')
    if (!toks[i].startsWith('-') && toks[i].includes('=')) return none('operand_assignment')
  }

  const execBase = path.basename(expandTilde(toks[0], homeDir))
  const execToken = maybeNormalizePath(toks[0], callerCwd, projectRoot, homeDir)
  const interpreter = INTERPRETERS.has(execBase)
  // Bare = PATH-resolved name with no path component. `/tmp/evil/node`,
  // `./node`, and `~/bin/node` all share execBase "node" but are NOT the
  // system interpreter; trust surfaces (the read-only manifest) must require
  // bareness or an impostor binary rides a by-design entry.
  const execBare = !/[\\/]/.test(toks[0])

  let subject = ''
  let rest
  if (interpreter) {
    if (toks.length >= 2 && !toks[1].startsWith('-')) {
      // node <script> … — the script arg is a path by construction.
      subject = normalizePathToken(toks[1], callerCwd, projectRoot, homeDir)
      rest = toks.slice(2)
    } else {
      // Interpreter with leading flags: canonicalizable ONLY when every
      // remaining token is a bare flag (`node --version`). Any operand mixed
      // in (`node -e code`) → refuse; we cannot tell which token executes.
      rest = toks.slice(1)
      if (!rest.every((t) => BARE_FLAG_RE.test(t))) {
        return none('interpreter_flag_operand_mix')
      }
    }
  } else {
    // Subcommand only when it IMMEDIATELY follows the executable.
    if (toks.length >= 2 && !toks[1].startsWith('-')) {
      subject = maybeNormalizePath(toks[1], callerCwd, projectRoot, homeDir)
      rest = toks.slice(2)
    } else {
      rest = toks.slice(1)
    }
    // Positional operands are WRITE TARGETS for external tools (`sed -i EXPR
    // FILE`, `cp SRC DST`, `tee FILE`, `mv A B`): dropping them lets a
    // repo-source write ride a verdict cached from a /tmp-target sibling of
    // the same flag shape (review finding, runtime-confirmed sed -i bypass).
    // Refuse → canonical null → the marker falls back to the exact literal
    // key (pre-E3 safety; no cross-operand generalization). Interpreter+script
    // forms keep generalizing (the em-* reader shape) — there the SCRIPT, not
    // a positional, determines write behavior, and in-repo scripts are
    // content-key-pinned anyway. A non-flag token after the subcommand is a
    // positional operand (flag VALUES on external tools are the risky case too,
    // so this is deliberately conservative for non-interpreters).
    if (rest.some((t) => !t.startsWith('-'))) {
      return none('noninterpreter_positional_operand')
    }
  }

  const flags = [...new Set(rest.filter((t) => t.startsWith('-')).map((t) => t.split('=')[0]))].sort()

  const parts = [execToken]
  if (subject) parts.push(subject)
  parts.push(...flags)

  return {
    canonical: parts.join(' '),
    reason: 'ok',
    execToken,
    execBase,
    execBare,
    subject,
    flags,
    interpreter
  }
}
