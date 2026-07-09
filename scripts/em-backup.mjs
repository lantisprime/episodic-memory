#!/usr/bin/env node
/**
 * em-backup.mjs — Mirror personal episodic-memory state to a private GitHub
 * repo, with PII / secret redaction applied to the staging copy.
 *
 * Source files on disk are never modified. The backup repo holds redacted
 * copies; live state at ~/.episodic-memory/ etc. stays raw.
 *
 * Usage:
 *   node em-backup.mjs --audit       Scan all sources, report redactions, no writes
 *   node em-backup.mjs --init        Create private repo (gh repo create --private)
 *                                    + initial commit + push
 *   node em-backup.mjs --sync        Daily run: rsync sources, redact, commit, push
 *   node em-backup.mjs --self-test   Run built-in redaction unit tests
 *
 * Output: JSON to stdout. Exit non-zero on error.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { execSync, execFileSync } from 'child_process'

const HOME = os.homedir()

// ---------------------------------------------------------------------------
// Configuration loader
// ---------------------------------------------------------------------------
// Config sources, in priority order:
//   1. $EM_BACKUP_CONFIG env var (path to JSON file)
//   2. ~/.config/em-backup/config.json
//   3. Built-in defaults (no SOURCES, no repo info — won't push without config)
//
// Schema:
//   {
//     "repo_owner": "lantisprime",
//     "repo_name": "episodic-memory-backup",
//     "backup_dir": "~/.local/share/episodic-memory-backup",   // optional, default shown
//     "sources": [
//       { "src": "~/.episodic-memory", "dest": "global", "label": "global" },
//       ...
//     ],
//     "extra_allowlist_emails": ["alice@mycorp.io"],            // optional, added to allowlist
//     "extra_allowlist_domains": ["mycorp.io"]                  // optional, e.g. for company-internal addresses
//   }
//
// Codex F4: making this script a tracked project artifact requires the
// owner/repo/sources to be config-driven, not hardcoded. The script has no
// hardcoded personal info — refuses to --init or --sync without config.
function expandHome(p) {
  if (!p) return p
  if (p === '~') return HOME
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2))
  return p
}

function loadConfig() {
  const candidates = []
  if (process.env.EM_BACKUP_CONFIG) candidates.push(process.env.EM_BACKUP_CONFIG)
  candidates.push(path.join(HOME, '.config/em-backup/config.json'))
  for (const c of candidates) {
    if (!c) continue
    if (!fs.existsSync(c)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(c, 'utf8'))
      return { ...parsed, _path: c }
    } catch (e) {
      throw new Error(`em-backup: failed to parse config at ${c}: ${e.message}`)
    }
  }
  return null
}

// Codex round-3 P1: validate `dest` from config so a hostile/buggy entry
// like { dest: "../outside" } cannot escape BACKUP_DIR during sync or
// prune. Return the resolved absolute destBase (under backupDir) or throw.
function resolveDestUnderBackup(backupDir, dest) {
  if (typeof dest !== 'string' || dest.length === 0) {
    throw new Error(`em-backup: source dest must be a non-empty string (got ${JSON.stringify(dest)})`)
  }
  if (path.isAbsolute(dest)) {
    throw new Error(`em-backup: source dest must be relative to backup_dir, got absolute path "${dest}"`)
  }
  // Reject `.` and any path component equal to `..`. POSIX and Windows agree
  // on `..` as the parent-dir token; we reject both separator styles.
  const segments = dest.split(/[\\/]+/)
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`em-backup: source dest must not contain "${seg}" segment, got "${dest}"`)
    }
  }
  // Belt-and-suspenders: resolve and compare against backupDir prefix.
  const absBackup = path.resolve(backupDir)
  const absDest = path.resolve(absBackup, dest)
  if (absDest === absBackup) {
    throw new Error(`em-backup: source dest must not equal backup_dir root, got "${dest}"`)
  }
  if (!absDest.startsWith(absBackup + path.sep)) {
    throw new Error(`em-backup: source dest "${dest}" resolves to "${absDest}" which is outside backup_dir "${absBackup}"`)
  }
  return absDest
}

function resolveConfig(requirePushable = false) {
  const cfg = loadConfig()
  if (!cfg) {
    if (requirePushable) {
      throw new Error('em-backup: no config found. Create ~/.config/em-backup/config.json (see examples/em-backup.config.example.json) or set $EM_BACKUP_CONFIG.')
    }
    return { _path: null, sources: [], repo_owner: null, repo_name: null, backup_dir: null }
  }
  const backupDir = expandHome(cfg.backup_dir) || path.join(HOME, '.local/share/episodic-memory-backup')
  const out = {
    _path: cfg._path,
    repo_owner: cfg.repo_owner || null,
    repo_name: cfg.repo_name || null,
    backup_dir: backupDir,
    sources: (cfg.sources || []).map(s => {
      // Codex round-3: validate dest at config-load time so the resolved
      // absolute destBase is what every downstream caller uses. Any escape
      // attempt is caught here, before sync/prune ever touches the disk.
      const absDest = resolveDestUnderBackup(backupDir, s.dest)
      return {
        src: expandHome(s.src),
        dest: s.dest,
        absDest, // Pre-validated absolute path under backup_dir.
        label: s.label || s.dest,
      }
    }),
    extra_allowlist_emails: (cfg.extra_allowlist_emails || []).map(e => e.toLowerCase()),
    extra_allowlist_domains: (cfg.extra_allowlist_domains || []).map(d => d.toLowerCase()),
    extra_redact_strings: (cfg.extra_redact_strings || []).filter(s => typeof s === 'string' && s.length > 0),
  }
  if (requirePushable) {
    if (!out.repo_owner || !out.repo_name) {
      throw new Error(`em-backup: config at ${out._path} missing repo_owner/repo_name.`)
    }
    if (out.sources.length === 0) {
      throw new Error(`em-backup: config at ${out._path} has empty sources list.`)
    }
  }
  return out
}

// Mutable globals populated from config at CLI dispatch time. Self-test runs
// without config (these stay defaults; tests use isolated tmp dirs).
let BACKUP_DIR = path.join(HOME, '.local/share/episodic-memory-backup')
let REPO_OWNER = null
let REPO_NAME = null
const SOURCES = []
let EXTRA_ALLOWLIST_EMAILS = new Set()
let EXTRA_ALLOWLIST_DOMAINS = new Set()
// Live-reproduction finding (post-PR-#134 SHIP, first --init):
// home_path regex catches `/Users/<name>` with a path prefix but misses bare
// usernames that appear in narrative text / code-fences (e.g.
// "the literal `charltond.ho` was not redacted"). Synthetic test fixtures
// don't exercise narrative usage. Real-corpus run caught this.
//
// Fix: user-supplied list of literal strings to redact additionally. Applied
// BEFORE built-in REDACTIONS so user strings aren't partially eaten by
// generic regex.
let EXTRA_REDACT_PATTERN = null // RegExp built from cfg.extra_redact_strings

function buildExtraRedactPattern(strings) {
  if (!Array.isArray(strings) || strings.length === 0) return null
  // Sort longest-first so substring overlaps redact correctly (e.g. user
  // adds both "Foo Bar" and "Foo" — match "Foo Bar" first).
  const sorted = [...strings].filter(s => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length)
  if (sorted.length === 0) return null
  // Escape regex special chars in each literal.
  const escaped = sorted.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('|'), 'g')
}

// Skip these path fragments anywhere in source tree
const SKIP_FRAGMENTS = [
  '/.git/',
  '/node_modules/',
  '/.claude/worktrees/',
  '/.DS_Store',
]

// Skip backups for transient or oversized files
const SKIP_FILE_PATTERNS = [/\.tmp$/, /\.log$/, /\.swp$/, /^\..*\.swp$/]
const MAX_FILE_BYTES = 1024 * 1024 // 1 MB

// DERIVED-INDEX BACKUP POSTURE (#487): the derived indexes — index.jsonl,
// tags.json, tokens.json, category-index.json, trigger-index.json — are
// intentionally backed up as-is (not excluded here). They are deterministically
// rebuilt from the episodes on the next consumer read (via the fingerprint /
// em-rebuild-index), so a stale derived file in a backup is harmless, and
// index.jsonl is required for a clean restore. Excluding trigger-index.json in
// isolation would make it the odd one out; a full derived-file exclude sweep
// (coupled with a restore-time rebuild) is tracked separately, not done here.

// ---------------------------------------------------------------------------
// Redaction patterns
//
// Order matters: more specific patterns first so a less-specific one doesn't
// pre-empt a meaningful redaction marker.
// ---------------------------------------------------------------------------
const REDACTIONS = [
  // GitHub tokens — high specificity, catch first
  { name: 'github_token', pattern: /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/g, replacement: '[GITHUB_TOKEN]' },
  // OpenAI / Anthropic style sk- keys (40+ chars body)
  { name: 'sk_key', pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{32,}\b/g, replacement: '[SK_KEY]' },
  // Stripe live/test
  { name: 'stripe_key', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g, replacement: '[STRIPE_KEY]' },
  // AWS access key id
  { name: 'aws_akid', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[AWS_AKID]' },
  // Slack tokens
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[SLACK_TOKEN]' },
  // Google OAuth tokens
  { name: 'google_oauth', pattern: /\bya29\.[A-Za-z0-9_-]{20,}\b/g, replacement: '[GOOGLE_OAUTH]' },
  // JWT — three dot-separated base64url segments. Catches Bearer-style tokens
  // that wouldn't match generic_secret (which lacks `.` in its char class).
  // Reviewer P0 #3.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[JWT]' },
  // Generic high-entropy after key=, token=, secret=, password=, api_key=
  // Match values 16+ chars, mostly base64-ish. Char class includes `.` so
  // dotted tokens (JWTs after a key= prefix) get caught even if jwt didn't.
  {
    name: 'generic_secret',
    pattern: /\b(?:api[_-]?key|secret|password|passwd|token|auth(?:orization)?)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_.-]{16,})["']?/gi,
    replacement: (m, val) => m.replace(val, '[REDACTED_SECRET]'),
  },
  // Generic home-path-with-username → quasi-PII. Matches both macOS
  // (/Users/<name>) and Linux (/home/<name>). Username is whatever follows
  // the prefix up to the next path separator. Generic so it works for any
  // user on any project that adopts em-backup.
  { name: 'home_path', pattern: /(\/Users|\/home)\/[A-Za-z0-9._-]+(?=\/|"|'|\s|$|[,)])/g, replacement: (m) => m.replace(/\/[A-Za-z0-9._-]+$/, '/USER') },
  // Generic email — last so explicit allowlisted ones above don't get caught.
  // Allowlist:
  //   - sample identifiers (per Rule 2 / RFC 2606 reserved domains)
  //   - vendor commit-author constants (Copilot, Codex, Cursor, Windsurf, Continue)
  //   - GitHub no-reply addresses
  //   - SSH protocol address git@github.com
  {
    name: 'generic_email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: (match) => {
      const lower = match.toLowerCase()
      // RFC 2606 reserved sample domains
      if (lower.endsWith('@example.com') || lower.endsWith('@example.org') || lower.endsWith('@example.net')) return match
      if (lower === 'juan.delacruz@acme.com') return match
      // GitHub no-reply
      if (lower.endsWith('@users.noreply.github.com')) return match
      if (lower === 'git@github.com') return match
      // Vendor commit-author constants documented in Rule 3
      if (lower === 'noreply@anthropic.com') return match
      if (lower === 'copilot@github.com') return match
      if (lower === 'codex@openai.com') return match
      if (lower === 'cursor@cursor.sh') return match
      if (lower === 'windsurf@codeium.com') return match
      if (lower === 'noreply@continue.dev') return match
      // Config-supplied extras (additive, never bypass real-secret patterns)
      if (EXTRA_ALLOWLIST_EMAILS.has(lower)) return match
      const domain = lower.split('@')[1] || ''
      if (EXTRA_ALLOWLIST_DOMAINS.has(domain)) return match
      // Already-redacted markers
      if (match.startsWith('[USER_EMAIL]')) return match
      return '[EMAIL]'
    },
  },
  // Phone numbers — basic E.164 / US
  { name: 'phone_e164', pattern: /\+\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{2,4}[\s-]?\d{2,4}[\s-]?\d{2,4}\b/g, replacement: '[PHONE]' },
]

// Codex F3: do NOT use a small extension allowlist. The previous design
// would byte-copy any file whose extension wasn't in the set (.env, .pem,
// .key, extensionless text), bypassing redaction. The threat model says
// "if the repo is ever made public by mistake, no live secrets" — so the
// safe default is: try to decode every file as UTF-8 text and apply
// redaction; only files that look genuinely binary are skipped (with a
// manifest entry).
//
// Extensions retained as a *fast-path hint* — files matching these are
// known-text and skip the binary probe. Anything outside the set goes
// through `looksBinary()` and is either redacted-as-text or skipped.
const KNOWN_TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.mjs', '.js', '.ts', '.sh', '.bash',
  '.yml', '.yaml', '.toml', '.cfg', '.ini', '.html', '.xml', '.css',
  '.env', '.envrc', '.gitignore', '.gitattributes', '.editorconfig',
])

// Bytes we treat as definitive binary markers in the first 4KB probe.
// NUL is the strongest signal; high ratio of non-printable control chars
// is the secondary signal.
const BINARY_PROBE_BYTES = 4096
const BINARY_NONPRINTABLE_THRESHOLD = 0.30 // >30% non-printable in probe = binary

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function shouldSkipPath(p) {
  for (const frag of SKIP_FRAGMENTS) if (p.includes(frag)) return true
  const base = path.basename(p)
  for (const re of SKIP_FILE_PATTERNS) if (re.test(base)) return true
  return false
}

// Codex F3: classify file as text|binary by sampling content, not by
// extension allowlist. Returns 'text' | 'binary'. Files <= 4KB are probed
// in full; larger files are sampled at the head.
function classifyFileBytes(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  // Fast-path: known text extensions skip the probe and are always text.
  if (KNOWN_TEXT_EXTENSIONS.has(ext)) return 'text'
  // Probe the head of the file for binary markers.
  let buf
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const probe = Buffer.alloc(BINARY_PROBE_BYTES)
      const n = fs.readSync(fd, probe, 0, BINARY_PROBE_BYTES, 0)
      buf = probe.subarray(0, n)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return 'binary' // unreadable → treat as binary, skip
  }
  if (buf.length === 0) return 'text' // empty file is fine to redact-as-text
  // NUL byte is a definitive binary marker.
  if (buf.includes(0)) return 'binary'
  // Count non-printable, non-whitespace bytes.
  let nonPrintable = 0
  for (const b of buf) {
    // Printable ASCII range (0x20-0x7E) + common whitespace (\t \n \r) + extended UTF-8 (>=0x80)
    if (b >= 0x20 && b <= 0x7E) continue
    if (b === 0x09 || b === 0x0A || b === 0x0D) continue
    if (b >= 0x80) continue // assume UTF-8 multi-byte; not a binary marker by itself
    nonPrintable++
  }
  if (nonPrintable / buf.length > BINARY_NONPRINTABLE_THRESHOLD) return 'binary'
  return 'text'
}

function walk(dir, out = [], symlinkLog = null) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (shouldSkipPath(full)) continue
    if (e.isSymbolicLink()) {
      // Reviewer P0 #2: explicit symlink rejection. Source-side symlinks are
      // never followed (data exfiltration via crafted symlink target).
      if (symlinkLog) symlinkLog.push(full)
      continue
    }
    if (e.isDirectory()) walk(full, out, symlinkLog)
    else if (e.isFile()) out.push(full)
  }
  return out
}

// Prune-side walker: include all regular files under destRoot regardless of
// SKIP_FRAGMENTS / SKIP_FILE_PATTERNS. We only skip the dest's own .git/
// metadata. Reviewer P0 #1: rule changes shouldn't strand orphans.
function walkForPrune(dir, root, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    // Only skip the dest's own .git/ — every other file is prune-eligible.
    const rel = path.relative(root, full)
    if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git' + path.sep)) continue
    if (e.isSymbolicLink()) continue // never follow symlinks here either
    if (e.isDirectory()) walkForPrune(full, root, out)
    else if (e.isFile()) out.push(full)
  }
  return out
}

function applyRedactions(content) {
  const findings = []
  let redacted = content
  // User-supplied literal redactions FIRST so generic patterns can't
  // partially eat them (e.g. user adds "alice.smith"; if home_path were to
  // match it inside a code-fence, the partial redaction marker would be
  // confusing). Replacement marker is generic [REDACTED] — the originating
  // string is private; the marker doesn't disclose what was there.
  if (EXTRA_REDACT_PATTERN) {
    let extraCount = 0
    redacted = redacted.replace(EXTRA_REDACT_PATTERN, () => { extraCount++; return '[REDACTED]' })
    if (extraCount > 0) findings.push({ name: 'extra_redact', count: extraCount })
  }
  for (const r of REDACTIONS) {
    let realCount = 0
    // Operate on the IN-PIPELINE text, not the original. Earlier patterns may
    // have already redacted some matches (e.g. user_email runs before
    // generic_email; me@charltonho.com is gone by the time generic sees it).
    redacted = redacted.replace(r.pattern, (...args) => {
      const m = args[0]
      const repl = typeof r.replacement === 'function' ? r.replacement(...args) : r.replacement
      if (repl !== m) realCount++
      return repl
    })
    if (realCount > 0) findings.push({ name: r.name, count: realCount })
  }
  return { redacted, findings }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

// Codex review on PR #137: extra_redact_strings was content-only; backup
// pathnames, manifest entries, audit JSON `file:` fields, and --show-config
// output all leaked the literal strings. Redact policy must be artifact-wide.
//
// Two helpers:
// - redactArtifactString(s): for any string EMITTED in audit/manifest/config
//   output. Applies BOTH extra_redact and home_path so user paths in the
//   user's machine ($HOME) are scrubbed too.
// - redactPathSegments(rel): for filesystem subpaths actually written under
//   BACKUP_DIR. Applies ONLY extra_redact — fs operations need real path
//   characters; we don't want /Users/USER substituted into BACKUP_DIR.
function redactArtifactString(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  let out = value
  if (EXTRA_REDACT_PATTERN) {
    out = out.replace(EXTRA_REDACT_PATTERN, '[REDACTED]')
  }
  // Apply home_path: same regex as in REDACTIONS array, kept in sync.
  out = out.replace(/(\/Users|\/home)\/[A-Za-z0-9._-]+(?=\/|"|'|\s|$|[,)])/g, (m) => m.replace(/\/[A-Za-z0-9._-]+$/, '/USER'))
  return out
}

// Apply only EXTRA_REDACT_PATTERN. Used for the relative-path component
// inside BACKUP_DIR — keeps pathnames clean of literals while preserving
// the BACKUP_DIR prefix needed for fs operations. Deterministic so prune
// can recompute the same transformation from the source side.
function redactPathSegments(rel) {
  if (!EXTRA_REDACT_PATTERN) return rel
  return rel.replace(EXTRA_REDACT_PATTERN, '[REDACTED]')
}

// Codex PR-#137 round-2 F1: --show-config left raw backup_dir, sources[].src,
// sources[].absDest, sources[].label. Walk the entire config and redact every
// string value, preserving repo_owner/repo_name (operational identity, not
// user-secret) and replacing extra_redact_strings with a masked count.
function redactConfigForDisplay(cfg) {
  function walk(node, parentKey) {
    if (typeof node === 'string') return redactArtifactString(node)
    if (Array.isArray(node)) return node.map(item => walk(item, parentKey))
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) {
        if (k === 'extra_redact_strings' && Array.isArray(v) && v.length > 0) {
          out[k] = `<${v.length} strings configured (masked; read config file directly to inspect)>`
        } else if (k === 'repo_owner' || k === 'repo_name') {
          // Codex PR-#137 round-3 F1.A2: previously preserved owner/name
          // verbatim as "operational identity." But if user explicitly
          // listed those literals in extra_redact_strings, they want them
          // gone. Apply redactArtifactString — pattern won't match unless
          // the string is on the user's redact list, so values stay
          // verbatim by default.
          out[k] = redactArtifactString(v)
        } else {
          out[k] = walk(v, k)
        }
      }
      return out
    }
    return node
  }
  return walk(cfg, null)
}

// ---------------------------------------------------------------------------
// Audit / sync core
// ---------------------------------------------------------------------------
function auditSources({ sample = 0 } = {}) {
  const report = {
    sources: [],
    totals: { files: 0, text_files: 0, binary_files: 0, oversized_skipped: 0, redaction_findings: 0 },
    samples: [],
    findings_by_pattern: {},
  }
  for (const s of SOURCES) {
    const exists = fs.existsSync(s.src)
    // Codex PR-#137 round-1: `src` leaks raw source paths.
    // Codex PR-#137 round-2 F1: `label` also leaks. Apply redaction to both.
    const entry = { label: redactArtifactString(s.label), src: redactArtifactString(s.src), exists, files: 0, text_files: 0, binary_files: 0, oversized_skipped: 0, redactions: 0 }
    if (!exists) { report.sources.push(entry); continue }
    const files = walk(s.src)
    for (const f of files) {
      const stat = fs.statSync(f)
      if (stat.size > MAX_FILE_BYTES) { entry.oversized_skipped++; report.totals.oversized_skipped++; continue }
      entry.files++
      report.totals.files++
      if (classifyFileBytes(f) === 'binary') { entry.binary_files++; report.totals.binary_files++; continue }
      entry.text_files++; report.totals.text_files++
      const content = fs.readFileSync(f, 'utf8')
      const { redacted, findings } = applyRedactions(content)
      if (findings.length > 0) {
        const totalForFile = findings.reduce((a, b) => a + b.count, 0)
        entry.redactions += totalForFile
        report.totals.redaction_findings += totalForFile
        for (const fnd of findings) {
          report.findings_by_pattern[fnd.name] = (report.findings_by_pattern[fnd.name] || 0) + fnd.count
        }
        if (sample > 0 && report.samples.length < sample && redacted !== content) {
          // Codex F1: NEVER emit raw pre-redaction content. Codex PR-#137:
          // the `file:` field also leaks if a path segment matches an
          // extra-redact literal — apply redactArtifactString.
          const idx = firstDiffIndex(content, redacted)
          report.samples.push({
            file: redactArtifactString(f),
            patterns: findings.map(x => x.name),
            redacted_snippet: redacted.slice(Math.max(0, idx - 60), Math.min(redacted.length, idx + 60)),
          })
        }
      }
    }
    report.sources.push(entry)
  }
  return report
}

function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

function syncToBackup({ verbose = false } = {}) {
  if (!fs.existsSync(BACKUP_DIR)) {
    throw new Error(`Backup dir ${BACKUP_DIR} does not exist. Run --init first.`)
  }
  if (!fs.existsSync(path.join(BACKUP_DIR, '.git'))) {
    throw new Error(`Backup dir ${BACKUP_DIR} is not a git repo. Run --init first.`)
  }
  let totalCopied = 0
  let totalRedacted = 0
  const skippedSymlinks = []
  const skippedOversized = []
  const skippedBinary = [] // Codex F3: track skipped binaries explicitly.
  for (const s of SOURCES) {
    if (!fs.existsSync(s.src)) continue
    // Codex round-3: use the pre-validated absDest from resolveConfig. This
    // is guaranteed to be under BACKUP_DIR (escape attempts would have
    // thrown at config-load time, before any disk I/O).
    const destBase = s.absDest || path.join(BACKUP_DIR, s.dest)
    const sourceLog = []
    const files = walk(s.src, [], sourceLog)
    // Codex PR-#137 round-1: manifest entries leak raw paths.
    // Codex PR-#137 round-2 F1: `source` field (= s.label) leaks too.
    const safeLabel = redactArtifactString(s.label)
    for (const sym of sourceLog) skippedSymlinks.push({ source: safeLabel, path: redactArtifactString(sym) })

    // Codex PR-#137 round-3 F2: PRE-WALK ALL files in this source FIRST,
    // build the source→dest mapping, detect collisions BEFORE touching disk.
    // Inline-during-loop detection (round 2) left first-of-pair already
    // written when the second triggered the throw. Pre-walk is fail-closed:
    // no file written if any collision exists.
    const planned = [] // [{ source: f, destPath, kind: 'text'|'oversized'|'binary' }]
    const seenDest = new Map() // destPath → first source file mapped to it
    for (const f of files) {
      const stat = fs.statSync(f)
      if (stat.size > MAX_FILE_BYTES) {
        planned.push({ source: f, destPath: null, kind: 'oversized', size: stat.size })
        continue
      }
      if (classifyFileBytes(f) === 'binary') {
        planned.push({ source: f, destPath: null, kind: 'binary', size: stat.size })
        continue
      }
      const rel = path.relative(s.src, f)
      const transformedRel = redactPathSegments(rel)
      const destPath = path.join(destBase, transformedRel)
      if (seenDest.has(destPath)) {
        // Pre-walk collision detection — NO files written yet.
        throw new Error(`em-backup: extra_redact_strings collision detected during pre-walk — multiple source files map to the same backup path "${redactArtifactString(destPath)}". Adjust extra_redact_strings or rename source files to disambiguate. Refusing to sync (would silently overwrite). Source: ${safeLabel}. No backup files have been modified.`)
      }
      seenDest.set(destPath, f)
      planned.push({ source: f, destPath, kind: 'text' })
    }

    // Pre-walk passed: now do all the disk operations. expectedDestPaths is
    // used by source-driven prune.
    const expectedDestPaths = new Set()
    for (const p of planned) {
      if (p.kind === 'oversized') {
        skippedOversized.push({ source: safeLabel, path: redactArtifactString(p.source), size: p.size })
        continue
      }
      if (p.kind === 'binary') {
        skippedBinary.push({ source: safeLabel, path: redactArtifactString(p.source), size: p.size })
        continue
      }
      ensureDir(path.dirname(p.destPath))
      const content = fs.readFileSync(p.source, 'utf8')
      const { redacted, findings } = applyRedactions(content)
      fs.writeFileSync(p.destPath, redacted)
      totalRedacted += findings.reduce((a, b) => a + b.count, 0)
      totalCopied++
      expectedDestPaths.add(p.destPath)
    }
    // Source-driven prune: anything in dest not in expectedDestPaths is gone
    // from source and should be removed. This handles redacted pathnames
    // correctly (the original prune walked dest then checked source — but
    // the dest's redacted name doesn't correspond to any source entry, so
    // the original would have wrongly deleted the just-written backup).
    pruneSourceDriven(destBase, expectedDestPaths)
  }
  const manifest = {
    generated_at: new Date().toISOString(),
    skipped_symlinks: skippedSymlinks,
    skipped_oversized: skippedOversized.map(x => ({ ...x, max_bytes: MAX_FILE_BYTES })),
    skipped_binary: skippedBinary,
  }
  fs.writeFileSync(path.join(BACKUP_DIR, '.skipped-files.json'), JSON.stringify(manifest, null, 2) + '\n')
  return {
    totalCopied,
    totalRedacted,
    skippedSymlinks: skippedSymlinks.length,
    skippedOversized: skippedOversized.length,
    skippedBinary: skippedBinary.length,
  }
}

// Codex PR-#137: source-driven prune. The original pruneDeleted walked dest
// then checked if source still exists at the same rel path. With path
// redaction, the dest's redacted name doesn't correspond to any source
// entry, so source-existence-check would wrongly delete the just-written
// backup. Source-driven prune builds the expected dest set from source +
// the same path-redaction transformation, then deletes anything in dest
// NOT in that set. Deterministic; works whether redaction is on or off.
function pruneSourceDriven(destRoot, expectedDestPaths) {
  if (!fs.existsSync(destRoot)) return
  const destFiles = walkForPrune(destRoot, destRoot)
  for (const df of destFiles) {
    if (expectedDestPaths.has(df)) continue
    const real = fs.realpathSync(df)
    if (!real.startsWith(destRoot + path.sep) && real !== destRoot) continue
    fs.unlinkSync(df)
  }
}

function pruneDeleted(srcRoot, destRoot) {
  if (!fs.existsSync(destRoot)) return
  const destFiles = walkForPrune(destRoot, destRoot)
  for (const df of destFiles) {
    const rel = path.relative(destRoot, df)
    const srcFile = path.join(srcRoot, rel)
    // Defensive: ensure df is under destRoot (resolve real path; symlinks
    // would have been refused by walkForPrune, but check anyway).
    const real = fs.realpathSync(df)
    if (!real.startsWith(destRoot + path.sep) && real !== destRoot) continue
    if (!fs.existsSync(srcFile)) fs.unlinkSync(df)
  }
}

// Codex round-4 P1: validate that the backup repo's `origin` remote actually
// points at the configured repo_owner/repo_name BEFORE any commit/push. A
// reused/stale BACKUP_DIR could have origin pointing at an unrelated repo;
// without this check, --sync silently ships personal memory to whatever
// origin happens to be set to.
//
// Returns { ok: true, normalized } on match, throws Error on mismatch.
// Accepts these GitHub URL forms (with or without trailing .git):
//   - https://github.com/<owner>/<name>[.git]
//   - https://<token>@github.com/<owner>/<name>[.git]
//   - git@github.com:<owner>/<name>[.git]
//   - ssh://git@github.com/<owner>/<name>[.git]
function parseGitHubRemote(url) {
  if (!url) return null
  const u = url.trim().replace(/\/$/, '').replace(/\.git$/, '')
  // git@github.com:owner/name
  let m = u.match(/^git@github\.com:([^/]+)\/(.+)$/)
  if (m) return { owner: m[1], name: m[2] }
  // ssh://git@github.com/owner/name
  m = u.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/)
  if (m) return { owner: m[1], name: m[2] }
  // https://[creds@]github.com/owner/name
  m = u.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+)$/)
  if (m) return { owner: m[1], name: m[2] }
  return null
}

function validateBackupRemoteAndBranch() {
  const opts = { cwd: BACKUP_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
  let originUrl = ''
  try {
    originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], opts).toString().trim()
  } catch {
    throw new Error(`em-backup: backup repo at ${redactArtifactString(BACKUP_DIR)} has no 'origin' remote configured. Refusing to push.`)
  }
  const parsed = parseGitHubRemote(originUrl)
  if (!parsed) {
    // Codex PR-#137 round-3 F1.A3: error messages must redact too. Apply
    // redactArtifactString so an extra-redacted literal in the URL doesn't
    // leak via stderr / process output.
    throw new Error(`em-backup: backup repo origin "${redactArtifactString(originUrl)}" is not a recognized GitHub URL. Refusing to push.`)
  }
  if (parsed.owner !== REPO_OWNER || parsed.name !== REPO_NAME) {
    const got = redactArtifactString(`${parsed.owner}/${parsed.name}`)
    const want = redactArtifactString(`${REPO_OWNER}/${REPO_NAME}`)
    throw new Error(`em-backup: backup repo origin points at ${got} but config expects ${want}. Refusing to push (personal memory could ship to wrong repo).`)
  }
  // Branch invariant: must be on main. Refuse if HEAD is detached or on
  // a different branch — commit would land on the wrong ref and `git push
  // origin main` would push the stale local main, not the new commit.
  //
  // Use `symbolic-ref --short HEAD` (NOT `rev-parse --abbrev-ref HEAD`) so
  // freshly-initialized repos with no commits yet still resolve. `git init -b
  // main` creates HEAD as a symbolic ref to refs/heads/main BEFORE any commit
  // exists; symbolic-ref reads the ref text, rev-parse needs the ref to point
  // at a commit. Found by running --init for the first time on a new repo —
  // no amount of code review caught this; reproduction did.
  let branch = ''
  try {
    branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], opts).toString().trim()
  } catch {
    throw new Error(`em-backup: backup repo at ${BACKUP_DIR} has detached HEAD or no HEAD symbolic ref; cannot determine branch. Refusing to push.`)
  }
  if (branch !== 'main') {
    throw new Error(`em-backup: backup repo HEAD is on "${branch}" not "main". Refusing to commit/push (commit would land on wrong branch).`)
  }
  return { remote: originUrl, owner: parsed.owner, name: parsed.name, branch }
}

function gitCommitAndPush({ message, isFirstPush = false }) {
  // Codex round-4: validate remote + branch before ANY commit or push.
  validateBackupRemoteAndBranch()
  const opts = { cwd: BACKUP_DIR, stdio: ['ignore', 'pipe', 'pipe'] }
  execFileSync('git', ['add', '-A'], opts)
  let status = ''
  try { status = execFileSync('git', ['status', '--porcelain'], opts).toString().trim() } catch {}

  // Codex F2: a transient push failure on a previous run leaves an unpushed
  // local commit. Without this check, future no-source-change syncs would
  // return early and never retry the push, leaving the backup stale forever.
  // Detect "local ahead of upstream" so we always retry pending pushes.
  let unpushedAhead = 0
  try {
    const ahead = execFileSync('git', ['rev-list', '--count', 'origin/main..HEAD'], opts).toString().trim()
    unpushedAhead = parseInt(ahead, 10) || 0
  } catch {
    // origin/main may not exist yet (first push hasn't happened) — treat as
    // ahead so the first push runs even if no source changes since init.
    try {
      execFileSync('git', ['rev-parse', '--verify', 'HEAD'], opts)
      unpushedAhead = 1
    } catch {}
  }

  if (!status && unpushedAhead === 0) {
    return { committed: false, pushed: false, message: 'no changes' }
  }

  let didCommit = false
  if (status) {
    execFileSync('git', ['commit', '-m', message], opts)
    didCommit = true
  }

  try {
    const pushArgs = isFirstPush ? ['push', '-u', 'origin', 'main'] : ['push', 'origin', 'main']
    execFileSync('git', pushArgs, opts)
    return {
      committed: didCommit,
      pushed: true,
      retried_unpushed: !didCommit && unpushedAhead > 0 ? unpushedAhead : 0,
    }
  } catch (e) {
    return {
      committed: didCommit,
      pushed: false,
      push_error: String(e.stderr || e.message),
      pending_unpushed: unpushedAhead + (didCommit ? 1 : 0),
    }
  }
}

function initBackupRepo() {
  if (fs.existsSync(BACKUP_DIR) && fs.existsSync(path.join(BACKUP_DIR, '.git'))) {
    return { status: 'already_initialized', dir: BACKUP_DIR }
  }
  ensureDir(BACKUP_DIR)
  // Check if remote repo exists
  let repoExists = false
  try {
    execFileSync('gh', ['repo', 'view', `${REPO_OWNER}/${REPO_NAME}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    repoExists = true
  } catch {}
  if (!repoExists) {
    // Reviewer P1 #6: --confirm removed in gh 2.x. Positional name + --private
    // is non-interactive on its own.
    execFileSync('gh', [
      'repo', 'create', `${REPO_OWNER}/${REPO_NAME}`,
      '--private',
      '--description', 'Personal backup of episodic-memory state (auto-generated by em-backup.mjs). Redacted.',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
  }
  // Init local git, set remote
  execFileSync('git', ['init', '-b', 'main'], { cwd: BACKUP_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO_OWNER}/${REPO_NAME}.git`], { cwd: BACKUP_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
  // Reviewer P1 #5: set local repo author identity so unattended commits work
  // even if global gitconfig is missing user.email/user.name. Use the GitHub
  // no-reply pattern for the user.
  execFileSync('git', ['config', 'user.name', 'em-backup'], { cwd: BACKUP_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['config', 'user.email', `${REPO_OWNER}@users.noreply.github.com`], { cwd: BACKUP_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
  // README + .gitattributes + .gitignore (Reviewer P3 #18)
  fs.writeFileSync(path.join(BACKUP_DIR, 'README.md'),
    `# Episodic Memory Backup\n\nAuto-generated mirror of personal episodic-memory state. Redacted by \`em-backup.mjs\`.\n\nDo not edit. Source of truth lives on the local machine at \`~/.episodic-memory/\` and per-project \`.episodic-memory/\` dirs.\n\nSee \`.skipped-files.json\` for files deliberately not backed up (oversized, symlinks).\n`)
  fs.writeFileSync(path.join(BACKUP_DIR, '.gitattributes'), '* text=auto eol=lf\n')
  fs.writeFileSync(path.join(BACKUP_DIR, '.gitignore'), '*.swp\n.DS_Store\n*.tmp\n')
  return { status: 'initialized', dir: BACKUP_DIR, repo: `${REPO_OWNER}/${REPO_NAME}`, repo_existed: repoExists }
}

// ---------------------------------------------------------------------------
// Self-tests (redaction unit tests)
// ---------------------------------------------------------------------------
function selfTest() {
  // Test fixtures are constructed at runtime from split prefixes so the
  // source file does NOT contain contiguous literals matching real secret
  // formats. (Otherwise GitHub push protection / gitleaks / trufflehog
  // flag the test fixtures themselves as live secrets — which happened
  // on the first push of this file.) Pattern matching at runtime is
  // unaffected: the regex sees the full concatenated string.
  const fakeBody = (n) => Array(n).fill('A').join('')
  const SP = {
    gho: 'gh' + 'o_',
    ghp: 'gh' + 'p_',
    skAnt: 's' + 'k-ant-api03-',
    skProj: 's' + 'k-proj-',
    skLive: 's' + 'k_' + 'live_',
    aws: 'AK' + 'IA',
    slack: 'xo' + 'xb-',
    googleOauth: 'ya' + '29.',
    jwt: 'ey' + 'J',
  }
  const jwtFixture = `${SP.jwt}aGV0LWlzLW5vdC1yZWFs.${SP.jwt}cGF5bG9hZA.${fakeBody(40)}`
  const cases = [
    { name: 'github_token_oauth', input: `token ${SP.gho}${fakeBody(36)}`, expectContains: '[GITHUB_TOKEN]' },
    { name: 'github_token_pat', input: `use ${SP.ghp}${fakeBody(36)}`, expectContains: '[GITHUB_TOKEN]' },
    { name: 'sk_key_anthropic', input: `${SP.skAnt}${fakeBody(36)}`, expectContains: '[SK_KEY]' },
    { name: 'sk_key_openai', input: `${SP.skProj}${fakeBody(40)}`, expectContains: '[SK_KEY]' },
    { name: 'stripe_live', input: `${SP.skLive}${fakeBody(24)}`, expectContains: '[STRIPE_KEY]' },
    { name: 'aws_akid', input: `${SP.aws}${fakeBody(16).replace(/A/g, 'X')}`, expectContains: '[AWS_AKID]' },
    { name: 'slack', input: `${SP.slack}1234567890-${fakeBody(10).toLowerCase()}`, expectContains: '[SLACK_TOKEN]' },
    { name: 'google_oauth', input: `${SP.googleOauth}${fakeBody(28)}`, expectContains: '[GOOGLE_OAUTH]' },
    { name: 'jwt_bare', input: `token ${jwtFixture}`, expectContains: '[JWT]' },
    { name: 'jwt_in_bearer', input: `Authorization: Bearer ${jwtFixture}`, expectContains: '[JWT]' },
    { name: 'generic_secret_password', input: 'password="hunter2hunter2hunter2"', expectContains: '[REDACTED_SECRET]' },
    { name: 'generic_secret_apikey', input: 'api_key: longstring1234567890abcd', expectContains: '[REDACTED_SECRET]' },
    { name: 'generic_secret_dotted', input: 'token: longstring.with.dots.1234567890abcd', expectContains: '[REDACTED_SECRET]' },
    // user-specific email handled by generic_email after F4 generalization
    { name: 'user_email_via_generic', input: 'contact me@charltonho.com please', expectContains: '[EMAIL]' },
    { name: 'home_path_macos', input: 'cd /Users/charltond.ho/Documents', expectContains: '/Users/USER' },
    { name: 'home_path_in_quotes', input: 'path: "/Users/alice/.episodic-memory"', expectContains: '/Users/USER' },
    { name: 'home_path_linux', input: 'see /home/bob/projects', expectContains: '/home/USER' },
    { name: 'home_path_no_change_when_already_user', input: 'cd /Users/USER/somewhere', expectExact: 'cd /Users/USER/somewhere' },
    { name: 'allowlist_juan', input: 'sample: juan.delacruz@acme.com', expectExact: 'sample: juan.delacruz@acme.com' },
    { name: 'allowlist_noreply', input: 'Co-Authored-By: x <noreply@anthropic.com>', expectExact: 'Co-Authored-By: x <noreply@anthropic.com>' },
    { name: 'allowlist_github_noreply', input: 'me 12345+lantisprime@users.noreply.github.com', expectExact: 'me 12345+lantisprime@users.noreply.github.com' },
    { name: 'allowlist_copilot', input: 'Co-Authored-By: GitHub Copilot <copilot@github.com>', expectExact: 'Co-Authored-By: GitHub Copilot <copilot@github.com>' },
    { name: 'allowlist_cursor', input: 'Co-Authored-By: Cursor <cursor@cursor.sh>', expectExact: 'Co-Authored-By: Cursor <cursor@cursor.sh>' },
    { name: 'allowlist_codex', input: 'Co-Authored-By: Codex <codex@openai.com>', expectExact: 'Co-Authored-By: Codex <codex@openai.com>' },
    { name: 'allowlist_windsurf', input: 'Co-Authored-By: Windsurf <windsurf@codeium.com>', expectExact: 'Co-Authored-By: Windsurf <windsurf@codeium.com>' },
    { name: 'allowlist_continue', input: 'Co-Authored-By: Continue <noreply@continue.dev>', expectExact: 'Co-Authored-By: Continue <noreply@continue.dev>' },
    { name: 'allowlist_git_ssh', input: 'remote git@github.com:org/repo.git', expectExact: 'remote git@github.com:org/repo.git' },
    { name: 'allowlist_example_com', input: 'sample: jdoe@example.com', expectExact: 'sample: jdoe@example.com' },
    { name: 'generic_email', input: 'jdoe@somecorp.io somewhere', expectContains: '[EMAIL]' },
    { name: 'phone', input: 'call +1 415 555 0123 thanks', expectContains: '[PHONE]' },
    { name: 'no_false_positive_short', input: 'sk-tiny', expectExact: 'sk-tiny' },
    { name: 'no_false_positive_word', input: 'tokenization', expectExact: 'tokenization' },
    { name: 'redaction_idempotent', input: 'cd /Users/USER/somewhere', expectExact: 'cd /Users/USER/somewhere' },
  ]
  const results = []
  let pass = 0, fail = 0
  for (const c of cases) {
    const { redacted } = applyRedactions(c.input)
    let ok = true, why = ''
    if (c.expectContains && !redacted.includes(c.expectContains)) { ok = false; why = `expected substring "${c.expectContains}" missing` }
    if (c.expectExact && redacted !== c.expectExact) { ok = false; why = `expected exact "${c.expectExact}" got "${redacted}"` }
    if (ok) pass++; else fail++
    results.push({ name: c.name, pass: ok, ...(ok ? {} : { why, redacted }) })
  }

  // Codex F1 regression: audit sample output must NEVER contain raw secrets.
  // Build a minimal in-memory file with a known fake secret, route through
  // auditSources via a temp dir + spoofed SOURCES, and assert the JSON
  // doesn't include the original token.
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-test-'))
    // Same split-prefix trick: avoid contiguous secret-shaped literals in source.
    const ghoPrefix = 'gh' + 'o_'
    const fakeToken = ghoPrefix + 'FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'
    fs.writeFileSync(path.join(tmpDir, 'fixture.md'), `leaky token ${fakeToken} plus padding\n`)
    const savedSources = [...SOURCES]
    SOURCES.length = 0
    SOURCES.push({ src: tmpDir, dest: 'x', label: 'audit-leak-test' })
    const report = auditSources({ sample: 5 })
    SOURCES.length = 0
    for (const s of savedSources) SOURCES.push(s)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const json = JSON.stringify(report)
    const okF1 = !json.includes(fakeToken) && json.includes('[GITHUB_TOKEN]')
    if (okF1) pass++; else fail++
    results.push({ name: 'codex_f1_audit_no_raw_leak', pass: okF1, ...(okF1 ? {} : { why: 'audit output contained raw token or missed redaction marker' }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_f1_audit_no_raw_leak', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex round-3 regression: resolveDestUnderBackup rejects path-escape
  // attempts and accepts valid relative dests. Without this, a hostile
  // config could write/prune outside the backup repo root.
  try {
    const fakeBackup = '/tmp/em-backup-test-validation'
    const validCases = ['global', 'local/myproject', 'a/b/c', 'memory']
    const invalidCases = [
      '../outside',
      '../../outside',
      'good/../../escape',
      '/abs/outside',
      '.',
      '',
      'a/./b', // matches `.` segment check
    ]
    let okValid = 0
    for (const v of validCases) {
      try { resolveDestUnderBackup(fakeBackup, v); okValid++ } catch {}
    }
    let okInvalid = 0
    for (const i of invalidCases) {
      try { resolveDestUnderBackup(fakeBackup, i) } catch { okInvalid++ }
    }
    const okR3 = okValid === validCases.length && okInvalid === invalidCases.length
    if (okR3) pass++; else fail++
    results.push({ name: 'codex_r3_dest_escape_rejected', pass: okR3, ...(okR3 ? {} : { why: `valid=${okValid}/${validCases.length} invalid_rejected=${okInvalid}/${invalidCases.length}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_r3_dest_escape_rejected', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex round-4 regression part A: parseGitHubRemote handles all expected
  // forms and rejects non-GitHub URLs.
  try {
    const cases = [
      { url: 'https://github.com/foo/bar', expect: { owner: 'foo', name: 'bar' } },
      { url: 'https://github.com/foo/bar.git', expect: { owner: 'foo', name: 'bar' } },
      { url: 'https://github.com/foo/bar/', expect: { owner: 'foo', name: 'bar' } },
      { url: 'https://abc123@github.com/foo/bar.git', expect: { owner: 'foo', name: 'bar' } },
      { url: 'http://github.com/foo/bar', expect: { owner: 'foo', name: 'bar' } },
      { url: 'git@github.com:foo/bar.git', expect: { owner: 'foo', name: 'bar' } },
      { url: 'git@github.com:foo/bar', expect: { owner: 'foo', name: 'bar' } },
      { url: 'ssh://git@github.com/foo/bar.git', expect: { owner: 'foo', name: 'bar' } },
      { url: 'https://gitlab.com/foo/bar', expect: null },
      { url: 'https://example.com/foo/bar', expect: null },
      { url: '', expect: null },
      { url: 'not-a-url', expect: null },
    ]
    let okR4a = 0
    for (const c of cases) {
      const got = parseGitHubRemote(c.url)
      const matched = (got === null && c.expect === null) ||
                      (got && c.expect && got.owner === c.expect.owner && got.name === c.expect.name)
      if (matched) okR4a++
    }
    const okAllR4a = okR4a === cases.length
    if (okAllR4a) pass++; else fail++
    results.push({ name: 'codex_r4_parse_github_remote', pass: okAllR4a, ...(okAllR4a ? {} : { why: `${okR4a}/${cases.length} forms parsed correctly` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_r4_parse_github_remote', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex round-4 regression part B: validateBackupRemoteAndBranch refuses
  // when origin points at the wrong repo. Set up a temp git repo with
  // origin pointing elsewhere, point BACKUP_DIR at it, run validation.
  try {
    const tmpBackup = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-remote-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    fs.writeFileSync(path.join(tmpBackup, 'README'), 'init\n')
    execFileSync('git', ['add', '-A'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/wrong-owner/wrong-name.git'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })

    const savedBackupDir = BACKUP_DIR
    const savedOwner = REPO_OWNER
    const savedName = REPO_NAME
    BACKUP_DIR = tmpBackup
    REPO_OWNER = 'expected-owner'
    REPO_NAME = 'expected-name'

    let mismatchRefused = false
    try { validateBackupRemoteAndBranch() } catch (e) {
      if (/wrong-owner\/wrong-name/.test(e.message) && /expected-owner\/expected-name/.test(e.message)) {
        mismatchRefused = true
      }
    }

    // Now fix origin to match config and verify it accepts.
    execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:expected-owner/expected-name.git'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    let matchAccepted = false
    try { const r = validateBackupRemoteAndBranch(); matchAccepted = r.owner === 'expected-owner' && r.name === 'expected-name' && r.branch === 'main' } catch {}

    // Now switch to a non-main branch and verify it refuses.
    execFileSync('git', ['checkout', '-b', 'feature-foo'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    let nonMainRefused = false
    try { validateBackupRemoteAndBranch() } catch (e) {
      if (/feature-foo/.test(e.message) && /not "main"/.test(e.message)) nonMainRefused = true
    }

    // Now remove origin entirely and verify it refuses.
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['checkout', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    let noOriginRefused = false
    try { validateBackupRemoteAndBranch() } catch (e) {
      if (/no 'origin' remote/.test(e.message)) noOriginRefused = true
    }

    BACKUP_DIR = savedBackupDir
    REPO_OWNER = savedOwner
    REPO_NAME = savedName
    fs.rmSync(tmpBackup, { recursive: true, force: true })

    const okR4b = mismatchRefused && matchAccepted && nonMainRefused && noOriginRefused
    if (okR4b) pass++; else fail++
    results.push({ name: 'codex_r4_validate_remote_and_branch', pass: okR4b, ...(okR4b ? {} : { why: `mismatch=${mismatchRefused} match=${matchAccepted} nonMain=${nonMainRefused} noOrigin=${noOriginRefused}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_r4_validate_remote_and_branch', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex round-5 regression: runSync against a wrong-origin backup repo
  // must refuse BEFORE any file write to BACKUP_DIR. Asserts: throws
  // before sync, and the backup_dir worktree stays exactly as it was
  // pre-sync (no untracked files, no new content).
  try {
    const tmpBackup = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-syncguard-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    fs.writeFileSync(path.join(tmpBackup, 'README'), 'init\n')
    execFileSync('git', ['add', '-A'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/wrong-owner/wrong-name.git'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })

    const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-syncguard-src-'))
    fs.writeFileSync(path.join(tmpSrc, 'sample.md'), 'hello world\n')

    const filesBefore = fs.readdirSync(tmpBackup).sort()

    const savedBackupDir = BACKUP_DIR
    const savedOwner = REPO_OWNER
    const savedName = REPO_NAME
    const savedSources = [...SOURCES]
    BACKUP_DIR = tmpBackup
    REPO_OWNER = 'expected-owner'
    REPO_NAME = 'expected-name'
    SOURCES.length = 0
    SOURCES.push({ src: tmpSrc, dest: 'syncguard-src', absDest: path.join(tmpBackup, 'syncguard-src'), label: 'syncguard-src' })

    let threw = false
    let errMsg = ''
    try { runSync() } catch (e) { threw = true; errMsg = e.message }

    const filesAfter = fs.readdirSync(tmpBackup).sort()
    const cleanWorktree = JSON.stringify(filesBefore) === JSON.stringify(filesAfter)

    BACKUP_DIR = savedBackupDir
    REPO_OWNER = savedOwner
    REPO_NAME = savedName
    SOURCES.length = 0
    for (const s of savedSources) SOURCES.push(s)
    fs.rmSync(tmpBackup, { recursive: true, force: true })
    fs.rmSync(tmpSrc, { recursive: true, force: true })

    const okR5 = threw && /wrong-owner\/wrong-name/.test(errMsg) && cleanWorktree
    if (okR5) pass++; else fail++
    results.push({ name: 'codex_r5_sync_validates_before_writes', pass: okR5, ...(okR5 ? {} : { why: `threw=${threw} errMsg=${errMsg.slice(0, 200)} cleanWorktree=${cleanWorktree} before=${JSON.stringify(filesBefore)} after=${JSON.stringify(filesAfter)}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_r5_sync_validates_before_writes', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Live-reproduction regression: validateBackupRemoteAndBranch must accept
  // a freshly-initialized backup repo (no commits yet, HEAD is symbolic-ref
  // to refs/heads/main but doesn't resolve to a commit).
  // Caught by running --init for the first time on a brand-new repo:
  // `git rev-parse --abbrev-ref HEAD` errored, refused push despite
  // origin being correctly set. Switched to `git symbolic-ref --short HEAD`
  // which works on empty repos.
  try {
    const tmpBackup = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-emptyrepo-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    // INTENTIONALLY no commit — this is the empty-repo case.
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:expected-owner/expected-name.git'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })

    const savedBackupDir = BACKUP_DIR
    const savedOwner = REPO_OWNER
    const savedName = REPO_NAME
    BACKUP_DIR = tmpBackup
    REPO_OWNER = 'expected-owner'
    REPO_NAME = 'expected-name'

    let validateResult = null
    let validateErr = null
    try { validateResult = validateBackupRemoteAndBranch() } catch (e) { validateErr = e.message }

    BACKUP_DIR = savedBackupDir
    REPO_OWNER = savedOwner
    REPO_NAME = savedName
    fs.rmSync(tmpBackup, { recursive: true, force: true })

    const okEmpty = validateResult && validateResult.branch === 'main' && !validateErr
    if (okEmpty) pass++; else fail++
    results.push({ name: 'live_repro_empty_repo_head_resolves', pass: okEmpty, ...(okEmpty ? {} : { why: `result=${JSON.stringify(validateResult)} err=${validateErr}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'live_repro_empty_repo_head_resolves', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex F3 regression: classifyFileBytes correctly identifies binary vs
  // text and unknown-extension text gets redaction (not byte-copy).
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-classify-'))
    const ghpPrefix = 'gh' + 'p_'
    const ghoPrefix = 'gh' + 'o_'
    fs.writeFileSync(path.join(tmpDir, 'a.env'), `API_KEY=${ghpPrefix}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n`)
    fs.writeFileSync(path.join(tmpDir, 'noext'), `plain text content with token ${ghoPrefix}BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n`)
    fs.writeFileSync(path.join(tmpDir, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD, 0xFC, 0x00, 0x00, 0x00, 0x00]))
    const okEnv = classifyFileBytes(path.join(tmpDir, 'a.env')) === 'text'
    const okNoExt = classifyFileBytes(path.join(tmpDir, 'noext')) === 'text'
    const okBin = classifyFileBytes(path.join(tmpDir, 'binary.dat')) === 'binary'
    fs.rmSync(tmpDir, { recursive: true, force: true })
    const okF3 = okEnv && okNoExt && okBin
    if (okF3) pass++; else fail++
    results.push({ name: 'codex_f3_binary_detection', pass: okF3, ...(okF3 ? {} : { why: `env=${okEnv} noext=${okNoExt} binary=${okBin}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_f3_binary_detection', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Live-reproduction regression: extra_redact_strings catches bare username
  // in narrative text that home_path missed. Real-world bug discovered when
  // first --init landed a literal username in a code-fence inside an
  // episode body. Synthetic fixture-driven tests didn't cover narrative
  // usage; this test does.
  try {
    const savedPattern = EXTRA_REDACT_PATTERN
    EXTRA_REDACT_PATTERN = buildExtraRedactPattern(['alice.smith', 'CompanyX'])
    const cases = [
      { input: 'the user alice.smith was here', expectContains: '[REDACTED]', expectNotContains: 'alice.smith' },
      { input: 'CompanyX is referenced', expectContains: '[REDACTED]', expectNotContains: 'CompanyX' },
      { input: 'in code-fence: `alice.smith` quoted', expectContains: '[REDACTED]', expectNotContains: 'alice.smith' },
      { input: 'no match here', expectExact: 'no match here' },
    ]
    let okExtra = 0
    for (const c of cases) {
      const { redacted } = applyRedactions(c.input)
      let pass = true
      if (c.expectContains && !redacted.includes(c.expectContains)) pass = false
      if (c.expectNotContains && redacted.includes(c.expectNotContains)) pass = false
      if (c.expectExact && redacted !== c.expectExact) pass = false
      if (pass) okExtra++
    }
    EXTRA_REDACT_PATTERN = savedPattern
    const okAll = okExtra === cases.length
    if (okAll) pass++; else fail++
    results.push({ name: 'live_repro_extra_redact_strings', pass: okAll, ...(okAll ? {} : { why: `${okExtra}/${cases.length} cases passed` }) })
  } catch (e) {
    fail++
    results.push({ name: 'live_repro_extra_redact_strings', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 regression: extra_redact_strings is artifact-wide, not
  // content-only. Audit JSON `file:` field, manifest `path:` entries,
  // backup pathnames, and --show-config must NOT leak the literal.
  try {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-artifact-'))
    const tmpSrc = path.join(tmpRoot, 'src')
    const tmpBackup = path.join(tmpRoot, 'backup')
    // Source files where the LITERAL appears in path segment.
    const secretSegment = 'SecretCodename'
    fs.mkdirSync(path.join(tmpSrc, secretSegment), { recursive: true })
    fs.writeFileSync(path.join(tmpSrc, secretSegment, 'note.md'), 'plain text body — no secret in content here\n')
    // Binary file (will be skipped) under same segment to test manifest leak.
    fs.writeFileSync(path.join(tmpSrc, secretSegment, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xFF, 0x00, 0x01, 0x00]))

    const savedPattern = EXTRA_REDACT_PATTERN
    EXTRA_REDACT_PATTERN = buildExtraRedactPattern([secretSegment])
    const savedSources = [...SOURCES]
    SOURCES.length = 0
    SOURCES.push({ src: tmpSrc, dest: 'leakcheck', absDest: path.join(tmpBackup, 'leakcheck'), label: 'leakcheck' })
    const savedBackupDir = BACKUP_DIR
    BACKUP_DIR = tmpBackup

    // Set up backup as a real git repo so syncToBackup pre-checks pass.
    fs.mkdirSync(tmpBackup, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })

    // 1. Audit: --audit JSON's `file:` field must not leak literal.
    const auditReport = auditSources({ sample: 5 })
    const auditJson = JSON.stringify(auditReport)
    const auditClean = !auditJson.includes(secretSegment)

    // 2. Sync: backup pathnames must not contain literal.
    syncToBackup({})
    const allBackupPaths = walkForPrune(tmpBackup, tmpBackup)
    const pathClean = !allBackupPaths.some(p => p.includes(secretSegment))

    // 3. Manifest: .skipped-files.json must not contain literal.
    const manifestPath = path.join(tmpBackup, '.skipped-files.json')
    const manifestRaw = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : ''
    const manifestClean = !manifestRaw.includes(secretSegment)

    // Restore.
    EXTRA_REDACT_PATTERN = savedPattern
    SOURCES.length = 0
    for (const s of savedSources) SOURCES.push(s)
    BACKUP_DIR = savedBackupDir
    fs.rmSync(tmpRoot, { recursive: true, force: true })

    const okR1 = auditClean && pathClean && manifestClean
    if (okR1) pass++; else fail++
    results.push({ name: 'codex_pr137_artifact_wide_redaction', pass: okR1, ...(okR1 ? {} : { why: `audit=${auditClean} path=${pathClean} manifest=${manifestClean}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_artifact_wide_redaction', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 regression: --show-config masks extra_redact_strings
  // (would otherwise echo the literal list to anyone seeing the JSON).
  try {
    const tmpCfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-config-')), 'config.json')
    fs.writeFileSync(tmpCfg, JSON.stringify({
      repo_owner: 'x', repo_name: 'x',
      sources: [{ src: '/tmp', dest: 'd', label: 'l' }],
      extra_redact_strings: ['LeakyLiteral', 'AnotherSecret'],
    }))
    const result = execFileSync('node', [process.argv[1], '--show-config'], {
      env: { ...process.env, EM_BACKUP_CONFIG: tmpCfg },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    const noLeakyLiteral = !result.includes('LeakyLiteral')
    const noAnotherSecret = !result.includes('AnotherSecret')
    const masked = result.includes('2 strings configured')
    fs.rmSync(path.dirname(tmpCfg), { recursive: true, force: true })

    const okR2 = noLeakyLiteral && noAnotherSecret && masked
    if (okR2) pass++; else fail++
    results.push({ name: 'codex_pr137_show_config_masks_extras', pass: okR2, ...(okR2 ? {} : { why: `noLiteral=${noLeakyLiteral} noOther=${noAnotherSecret} masked=${masked} sample=${result.slice(0, 200)}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_show_config_masks_extras', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 round-2 F1: --show-config + audit + manifest must redact
  // backup_dir, sources[].src, sources[].absDest, sources[].label too.
  try {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-r2f1-'))
    const tmpSrc = path.join(tmpRoot, 'SecretCodename-src')
    const tmpBackup = path.join(tmpRoot, 'SecretCodename-backup')
    fs.mkdirSync(tmpSrc, { recursive: true })
    fs.writeFileSync(path.join(tmpSrc, 'note.md'), 'plain text\n')
    const tmpCfg = path.join(tmpRoot, 'config.json')
    fs.writeFileSync(tmpCfg, JSON.stringify({
      repo_owner: 'x', repo_name: 'x',
      backup_dir: tmpBackup,
      sources: [{ src: tmpSrc, dest: 'leakcheck', label: 'SecretCodename-label' }],
      extra_redact_strings: ['SecretCodename'],
    }))

    // 1. --show-config must not contain the literal anywhere
    const showCfgOut = execFileSync('node', [process.argv[1], '--show-config'], {
      env: { ...process.env, EM_BACKUP_CONFIG: tmpCfg },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    const showCfgClean = !showCfgOut.includes('SecretCodename')

    // 2. --audit must not contain the literal in label/src
    const auditOut = execFileSync('node', [process.argv[1], '--audit', '--sample', '0'], {
      env: { ...process.env, EM_BACKUP_CONFIG: tmpCfg },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    const auditClean = !auditOut.includes('SecretCodename')

    fs.rmSync(tmpRoot, { recursive: true, force: true })

    const okR2F1 = showCfgClean && auditClean
    if (okR2F1) pass++; else fail++
    results.push({ name: 'codex_pr137_r2_f1_label_and_config_fields', pass: okR2F1, ...(okR2F1 ? {} : { why: `showCfg=${showCfgClean} audit=${auditClean} showCfgSample=${showCfgOut.slice(0, 200)} auditSample=${auditOut.slice(0, 200)}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_r2_f1_label_and_config_fields', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 round-2 F2: path collision after redaction must fail-closed.
  // Two source files under different segment names that collapse to the same
  // [REDACTED] would silently overwrite. Refuse before any write.
  try {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-r2f2-'))
    const tmpSrc = path.join(tmpRoot, 'src')
    const tmpBackup = path.join(tmpRoot, 'backup')
    fs.mkdirSync(path.join(tmpSrc, 'Alpha'), { recursive: true })
    fs.mkdirSync(path.join(tmpSrc, 'Beta'), { recursive: true })
    fs.writeFileSync(path.join(tmpSrc, 'Alpha', 'same.md'), 'alpha content\n')
    fs.writeFileSync(path.join(tmpSrc, 'Beta', 'same.md'), 'beta content\n')

    fs.mkdirSync(tmpBackup, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })

    const savedPattern = EXTRA_REDACT_PATTERN
    EXTRA_REDACT_PATTERN = buildExtraRedactPattern(['Alpha', 'Beta'])
    const savedSources = [...SOURCES]
    SOURCES.length = 0
    SOURCES.push({ src: tmpSrc, dest: 'd', absDest: path.join(tmpBackup, 'd'), label: 'd' })
    const savedBackupDir = BACKUP_DIR
    BACKUP_DIR = tmpBackup

    let threw = false
    let errMsg = ''
    try { syncToBackup({}) } catch (e) { threw = true; errMsg = e.message }

    // Verify: no files actually written to dest (collision detected before second write)
    // Note: the FIRST file may have been written before the SECOND triggered the throw.
    // The contract is: refuse to silently overwrite, not "atomic all-or-nothing." So
    // we check the throw + the message, not strict cleanliness of dest.
    const errClean = !errMsg.includes('Alpha') && !errMsg.includes('Beta') // error message must redact
    const errMentionsCollision = /collision/.test(errMsg)

    EXTRA_REDACT_PATTERN = savedPattern
    SOURCES.length = 0
    for (const s of savedSources) SOURCES.push(s)
    BACKUP_DIR = savedBackupDir
    fs.rmSync(tmpRoot, { recursive: true, force: true })

    const okR2F2 = threw && errClean && errMentionsCollision
    if (okR2F2) pass++; else fail++
    results.push({ name: 'codex_pr137_r2_f2_collision_fails_closed', pass: okR2F2, ...(okR2F2 ? {} : { why: `threw=${threw} errClean=${errClean} mentionsCollision=${errMentionsCollision} errMsg=${errMsg.slice(0, 200)}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_r2_f2_collision_fails_closed', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 round-3 meta-feedback (20260503-131746-...-1167):
  // SINGLE end-to-end harness covering every surface the extra_redact_strings
  // invariant must hold across. The invariant:
  //
  //   "After configuring extra_redact_strings, the raw literal must NOT appear
  //    anywhere outside the user-private config file and source filesystem
  //    operations."
  //
  // Surfaces this harness exercises in ONE run:
  //   - Source path containing the literal (segment in src dir name)
  //   - backup_dir path containing the literal
  //   - sources[].label containing the literal
  //   - File content containing the literal
  //   - Binary file under literal-named subdir (skipped, manifested)
  //   - Collision pair (Alpha/Beta same.md) triggering fail-closed
  //   - Captured stdout from --show-config, --audit, --sync
  //   - Captured stderr from --sync (collision error)
  //   - Backup repo file paths
  //   - Backup repo file contents
  //   - .skipped-files.json
  //   - Collision error message (must redact Alpha/Beta)
  //
  // Recursive grep against captured output + backup repo (excluding .git/).
  // Expect ZERO matches for the literal everywhere outside config file +
  // source dir; collision error must redact Alpha/Beta as [REDACTED].
  try {
    const literal = 'SecretCodename'
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-harness-'))
    const tmpSrc = path.join(tmpRoot, `${literal}-src`)
    const tmpBackup = path.join(tmpRoot, `${literal}-backup`)
    fs.mkdirSync(path.join(tmpSrc, literal), { recursive: true })
    fs.writeFileSync(path.join(tmpSrc, literal, 'note.md'), `body has ${literal} reference\n`)
    fs.writeFileSync(path.join(tmpSrc, literal, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xFF, 0x00, 0x01, 0x00]))
    // Collision pair — Alpha/Beta both transform to [REDACTED] under sync.
    fs.mkdirSync(path.join(tmpSrc, 'Alpha'), { recursive: true })
    fs.mkdirSync(path.join(tmpSrc, 'Beta'), { recursive: true })
    fs.writeFileSync(path.join(tmpSrc, 'Alpha', 'collide.md'), 'a content\n')
    fs.writeFileSync(path.join(tmpSrc, 'Beta', 'collide.md'), 'b content\n')

    const tmpCfg = path.join(tmpRoot, 'config.json')
    fs.writeFileSync(tmpCfg, JSON.stringify({
      repo_owner: 'x', repo_name: 'x',
      backup_dir: tmpBackup,
      sources: [{ src: tmpSrc, dest: 'd', label: `${literal}-label` }],
      extra_redact_strings: [literal, 'Alpha', 'Beta'],
    }))

    fs.mkdirSync(tmpBackup, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:x/x.git'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })

    const env = { ...process.env, EM_BACKUP_CONFIG: tmpCfg }
    let showCfgOut = '', showCfgErr = '', auditOut = '', auditErr = '', syncOut = '', syncErr = ''
    try {
      showCfgOut = execFileSync('node', [process.argv[1], '--show-config'], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } catch (e) { showCfgOut = e.stdout?.toString() || ''; showCfgErr = e.stderr?.toString() || '' }
    try {
      auditOut = execFileSync('node', [process.argv[1], '--audit', '--sample', '5'], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } catch (e) { auditOut = e.stdout?.toString() || ''; auditErr = e.stderr?.toString() || '' }
    try {
      syncOut = execFileSync('node', [process.argv[1], '--sync'], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } catch (e) { syncOut = e.stdout?.toString() || ''; syncErr = e.stderr?.toString() || '' }

    // Grep backup repo for literal (excluding .git/). Use RELATIVE paths
    // within backup_dir — the backup_dir's OWN name is a user-supplied fs
    // mount (cannot be redacted; user typed it into config) so absolute
    // paths necessarily carry it. The invariant covers what the SCRIPT
    // writes inside the backup repo, not the mount point name.
    const backupFiles = walkForPrune(tmpBackup, tmpBackup) // walkForPrune skips .git
    let backupContentMatches = 0
    let backupPathMatches = 0
    for (const bf of backupFiles) {
      const relInBackup = path.relative(tmpBackup, bf)
      if (relInBackup.includes(literal)) backupPathMatches++
      try {
        const content = fs.readFileSync(bf, 'utf8')
        if (content.includes(literal)) backupContentMatches++
      } catch { /* binary or unreadable */ }
    }

    // Grep captured outputs for literal + collision pair
    const allOut = [showCfgOut, showCfgErr, auditOut, auditErr, syncOut, syncErr].join('\n')
    const literalInOut = (allOut.match(new RegExp(literal, 'g')) || []).length
    const alphaInOut = (allOut.match(/\bAlpha\b/g) || []).length
    const betaInOut = (allOut.match(/\bBeta\b/g) || []).length

    // Sync MUST have failed-closed on collision; error must mention "collision"
    const syncFailed = syncErr.length > 0 || /collision/.test(syncOut)
    const collisionMentioned = /collision/.test(syncOut + syncErr)

    // Codex PR-#137 round-3 F2: post-collision backup worktree must be clean.
    // Pre-walk collision detection means NO files written when collision
    // exists. Verify by listing backup repo files (excluding .git).
    //
    // ⚠️ CODEX CAUGHT: this check MUST run BEFORE fs.rmSync(tmpRoot). Running
    // it after the cleanup means walkForPrune sees a deleted directory,
    // returns [] (via walk()'s readdir catch), and the assertion passes for
    // the wrong reason. The walk's empty result would NOT prove pre-walk
    // collision detection — it would prove only that the test cleaned up.
    const postCollisionFiles = walkForPrune(tmpBackup, tmpBackup)
    const postCollisionRelativeFiles = postCollisionFiles
      .map(p => path.relative(tmpBackup, p))
      .filter(rel => !rel.startsWith('.git'))
    const backupCleanAfterCollision = postCollisionRelativeFiles.length === 0

    // Defensive sanity: assert the backup dir actually still exists when we
    // ran the walk, so a future refactor moving rmSync above this can't
    // silently re-introduce the false-positive.
    const backupDirStillPresentAtCheckTime = fs.existsSync(tmpBackup)

    fs.rmSync(tmpRoot, { recursive: true, force: true })

    // Assertions per Codex's invariant:
    //   - literal must appear ZERO times in any output, manifest, or backup file
    //   - Alpha/Beta must NOT appear in collision error (redacted as [REDACTED])
    //   - Sync must fail-closed
    //   - Backup worktree must be CLEAN after collision (round-3 F2)
    const okHarness =
      literalInOut === 0 &&
      backupContentMatches === 0 &&
      backupPathMatches === 0 &&
      alphaInOut === 0 &&
      betaInOut === 0 &&
      syncFailed &&
      collisionMentioned &&
      backupCleanAfterCollision &&
      backupDirStillPresentAtCheckTime
    if (okHarness) pass++; else fail++
    results.push({
      name: 'codex_pr137_invariant_harness',
      pass: okHarness,
      ...(okHarness ? {} : {
        why: `literalInOut=${literalInOut} backupContent=${backupContentMatches} backupPath=${backupPathMatches} alpha=${alphaInOut} beta=${betaInOut} syncFailed=${syncFailed} collisionMentioned=${collisionMentioned} backupCleanAfterCollision=${backupCleanAfterCollision} backupDirStillPresentAtCheckTime=${backupDirStillPresentAtCheckTime} (files: ${JSON.stringify(postCollisionRelativeFiles)})`,
      }),
    })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_invariant_harness', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 round-5: harness extension. Three new sub-scenarios
  // covering CLI output paths Codex caught outside the round-3 harness:
  //   - --sync with missing backup_dir → error stack must redact literal
  //   - --sync with detached HEAD → error stack must redact literal
  //   - --init against existing initialized repo → init.dir must redact
  try {
    const literal = 'OutputBoundary'
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-outboundary-'))

    // --- Scenario A: missing backup_dir ---
    const cfgA = path.join(tmpRoot, 'cfgA.json')
    fs.writeFileSync(cfgA, JSON.stringify({
      repo_owner: 'x', repo_name: 'x',
      backup_dir: path.join(tmpRoot, `${literal}-missing-backup`),
      sources: [{ src: tmpRoot, dest: 'd', label: 'l' }],
      extra_redact_strings: [literal],
    }))
    let outA = ''
    try {
      outA = execFileSync('node', [process.argv[1], '--sync'], {
        env: { ...process.env, EM_BACKUP_CONFIG: cfgA }, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString()
    } catch (e) { outA = (e.stdout?.toString() || '') + (e.stderr?.toString() || '') }
    const aClean = !outA.includes(literal)

    // --- Scenario B: detached HEAD ---
    const tmpBackupB = path.join(tmpRoot, `${literal}-detached-backup`)
    fs.mkdirSync(tmpBackupB, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    fs.writeFileSync(path.join(tmpBackupB, 'README'), 'init\n')
    execFileSync('git', ['add', '-A'], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:x/x.git'], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    // Detach HEAD by checking out the commit by SHA
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpBackupB }).toString().trim()
    execFileSync('git', ['checkout', '--detach', sha], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    const cfgB = path.join(tmpRoot, 'cfgB.json')
    fs.writeFileSync(cfgB, JSON.stringify({
      repo_owner: 'x', repo_name: 'x',
      backup_dir: tmpBackupB,
      sources: [{ src: tmpRoot, dest: 'd', label: 'l' }],
      extra_redact_strings: [literal],
    }))
    let outB = ''
    try {
      outB = execFileSync('node', [process.argv[1], '--sync'], {
        env: { ...process.env, EM_BACKUP_CONFIG: cfgB }, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString()
    } catch (e) { outB = (e.stdout?.toString() || '') + (e.stderr?.toString() || '') }
    const bClean = !outB.includes(literal)

    // --- Scenario C: --init against existing initialized repo ---
    // tmpBackupB is already initialized with matching origin (x/x). Re-checkout
    // main first so validateBackupRemoteAndBranch passes branch check.
    execFileSync('git', ['checkout', 'main'], { cwd: tmpBackupB, stdio: ['ignore', 'pipe', 'pipe'] })
    let outC = ''
    try {
      outC = execFileSync('node', [process.argv[1], '--init'], {
        env: { ...process.env, EM_BACKUP_CONFIG: cfgB }, stdio: ['ignore', 'pipe', 'pipe'],
      }).toString()
    } catch (e) { outC = (e.stdout?.toString() || '') + (e.stderr?.toString() || '') }
    const cClean = !outC.includes(literal)

    fs.rmSync(tmpRoot, { recursive: true, force: true })

    const okOutBoundary = aClean && bClean && cClean
    if (okOutBoundary) pass++; else fail++
    results.push({
      name: 'codex_pr137_r5_output_boundary_redaction',
      pass: okOutBoundary,
      ...(okOutBoundary ? {} : {
        why: `missingBackup=${aClean} detachedHead=${bClean} existingInit=${cClean} sampleA=${outA.slice(0, 200)} sampleB=${outB.slice(0, 200)} sampleC=${outC.slice(0, 200)}`,
      }),
    })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_r5_output_boundary_redaction', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 round-3 F1.A1: --show-config in setup mode (no
  // repo_owner/repo_name) must STILL redact extra_redact_strings literals
  // from all string fields. Previously the EXTRA_REDACT_PATTERN build was
  // gated on repo_owner being set.
  try {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-setup-'))
    const tmpCfg = path.join(tmpRoot, 'config.json')
    const literal = 'SetupModeSecret'
    fs.writeFileSync(tmpCfg, JSON.stringify({
      // INTENTIONALLY no repo_owner/repo_name (setup mode)
      backup_dir: `/tmp/${literal}-backup`,
      sources: [{ src: `/tmp/${literal}-src`, dest: 'd', label: `${literal}-label` }],
      extra_redact_strings: [literal],
    }))
    const out = execFileSync('node', [process.argv[1], '--show-config'], {
      env: { ...process.env, EM_BACKUP_CONFIG: tmpCfg },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    const okSetup = !out.includes(literal)
    if (okSetup) pass++; else fail++
    results.push({ name: 'codex_pr137_r3_show_config_setup_mode', pass: okSetup, ...(okSetup ? {} : { why: `setup-mode --show-config leaked literal; output sample: ${out.slice(0, 300)}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_r3_show_config_setup_mode', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 round-3 F1.A2: when extra_redact_strings includes the
  // literal value of repo_owner or repo_name, --show-config must redact them
  // (not preserve as "operational identity").
  try {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-ownername-'))
    const tmpCfg = path.join(tmpRoot, 'config.json')
    fs.writeFileSync(tmpCfg, JSON.stringify({
      repo_owner: 'SecretOwner',
      repo_name: 'SecretRepo',
      backup_dir: '/tmp/x',
      sources: [{ src: '/tmp/x', dest: 'd', label: 'l' }],
      extra_redact_strings: ['SecretOwner', 'SecretRepo'],
    }))
    const out = execFileSync('node', [process.argv[1], '--show-config'], {
      env: { ...process.env, EM_BACKUP_CONFIG: tmpCfg },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    const okOwnerName = !out.includes('SecretOwner') && !out.includes('SecretRepo')
    if (okOwnerName) pass++; else fail++
    results.push({ name: 'codex_pr137_r3_owner_name_redacted_when_listed', pass: okOwnerName, ...(okOwnerName ? {} : { why: `owner/name leaked despite being in extra_redact_strings; output sample: ${out.slice(0, 300)}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_r3_owner_name_redacted_when_listed', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Codex PR-#137 round-3 F1.A3: validateBackupRemoteAndBranch error
  // messages must redact owner/name when the literal is on the redact list.
  try {
    const tmpBackup = fs.mkdtempSync(path.join(os.tmpdir(), 'em-backup-errmsg-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.email', 't@e.x'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    fs.writeFileSync(path.join(tmpBackup, 'README'), 'init\n')
    execFileSync('git', ['add', '-A'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:WrongSecretOwner/wrong-name.git'], { cwd: tmpBackup, stdio: ['ignore', 'pipe', 'pipe'] })

    const savedBackup = BACKUP_DIR, savedOwner = REPO_OWNER, savedName = REPO_NAME, savedPattern = EXTRA_REDACT_PATTERN
    BACKUP_DIR = tmpBackup
    REPO_OWNER = 'expected-owner'
    REPO_NAME = 'expected-name'
    EXTRA_REDACT_PATTERN = buildExtraRedactPattern(['WrongSecretOwner'])

    let errMsg = ''
    try { validateBackupRemoteAndBranch() } catch (e) { errMsg = e.message }

    BACKUP_DIR = savedBackup; REPO_OWNER = savedOwner; REPO_NAME = savedName; EXTRA_REDACT_PATTERN = savedPattern
    fs.rmSync(tmpBackup, { recursive: true, force: true })

    const okErrRedacted = !errMsg.includes('WrongSecretOwner') && /\[REDACTED\]/.test(errMsg) && /points at/.test(errMsg)
    if (okErrRedacted) pass++; else fail++
    results.push({ name: 'codex_pr137_r3_error_msg_redacts_owner_name', pass: okErrRedacted, ...(okErrRedacted ? {} : { why: `errMsg leaked or didn't redact: ${errMsg.slice(0, 300)}` }) })
  } catch (e) {
    fail++
    results.push({ name: 'codex_pr137_r3_error_msg_redacts_owner_name', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  // Sanity: longer literal sorted-first so it matches before a shorter
  // overlapping literal (e.g. user adds both "Foo Bar" and "Foo" — "Foo Bar"
  // wins on overlap).
  try {
    const savedPattern = EXTRA_REDACT_PATTERN
    EXTRA_REDACT_PATTERN = buildExtraRedactPattern(['Foo', 'Foo Bar'])
    const { redacted } = applyRedactions('the Foo Bar value')
    EXTRA_REDACT_PATTERN = savedPattern
    const okOverlap = redacted === 'the [REDACTED] value'
    if (okOverlap) pass++; else fail++
    results.push({ name: 'extra_redact_longest_first', pass: okOverlap, ...(okOverlap ? {} : { why: `got "${redacted}"` }) })
  } catch (e) {
    fail++
    results.push({ name: 'extra_redact_longest_first', pass: false, why: `test infrastructure error: ${e.message}` })
  }

  return { pass, fail, total: pass + fail, results }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(JSON.stringify({ status: 'help', script: 'em-backup.mjs', usage: 'node em-backup.mjs (--audit | --init | --sync | --self-test | --show-config) [--sample <n>]' }))
  process.exit(0)
}

// Codex PR-#137 round-5: every CLI JSON output (success OR error) must pass
// through artifact redaction at the output boundary. Patching individual
// return objects + error strings was whack-a-mole. This is the LAST line of
// defense for any leak that escaped per-string redaction upstream.
//
// outSafe() walks the entire output object, applies redactArtifactString to
// every string value (error message, stack traces, nested config paths, etc).
// Stack traces are sanitized but kept (they're useful for debugging and the
// pattern catches their literal values).
function sanitizeOutputObject(o) {
  function walk(node) {
    if (typeof node === 'string') return redactArtifactString(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) {
        out[k] = walk(v)
      }
      return out
    }
    return node
  }
  return walk(o)
}

function out(o) {
  console.log(JSON.stringify(sanitizeOutputObject(o), null, 2))
}

// Populate globals from config (modes that touch real sources/push need it).
function applyConfig(cfg) {
  if (cfg.backup_dir) BACKUP_DIR = cfg.backup_dir
  REPO_OWNER = cfg.repo_owner
  REPO_NAME = cfg.repo_name
  SOURCES.length = 0
  for (const s of cfg.sources) SOURCES.push(s)
  EXTRA_ALLOWLIST_EMAILS = new Set(cfg.extra_allowlist_emails || [])
  EXTRA_ALLOWLIST_DOMAINS = new Set(cfg.extra_allowlist_domains || [])
  EXTRA_REDACT_PATTERN = buildExtraRedactPattern(cfg.extra_redact_strings || [])
}

// Codex round-5: run-sync + run-init wrappers. Validation must fire BEFORE
// syncToBackup() writes anything, so a wrong-remote backup_dir cannot leave
// stray backup files in the wrong worktree. Defense in depth: gitCommitAndPush
// also validates internally.
function runSync() {
  // BACKUP_DIR must be a git repo and validate before any disk writes.
  if (!fs.existsSync(BACKUP_DIR) || !fs.existsSync(path.join(BACKUP_DIR, '.git'))) {
    throw new Error(`Backup dir ${BACKUP_DIR} is not initialized. Run --init first.`)
  }
  validateBackupRemoteAndBranch()
  const sync = syncToBackup({})
  const commit = gitCommitAndPush({ message: `backup ${new Date().toISOString()}` })
  return { sync, commit }
}

function runInit() {
  const init = initBackupRepo()
  // If the repo was already initialized (not freshly created by this run),
  // we cannot trust its origin/branch — validate before writing anything.
  // For freshly-initialized repos we just configured origin/branch ourselves
  // and there's nothing to validate against pre-write.
  if (init.status === 'already_initialized') {
    validateBackupRemoteAndBranch()
  }
  const sync = syncToBackup({})
  const isFirst = init.status === 'initialized'
  const commit = gitCommitAndPush({ message: `init: seed backup ${new Date().toISOString()}`, isFirstPush: isFirst })
  return { init, sync, commit }
}

try {
  if (argv.includes('--self-test')) {
    // Self-test runs without config; uses isolated tmp dirs.
    const r = selfTest()
    out({ status: r.fail === 0 ? 'ok' : 'fail', ...r })
    process.exit(r.fail === 0 ? 0 : 1)
  } else if (argv.includes('--show-config')) {
    const cfg = resolveConfig(false)
    // Codex PR-#137 round-3 F1.A1: build EXTRA_REDACT_PATTERN UNCONDITIONALLY
    // from cfg.extra_redact_strings, regardless of whether repo_owner is set.
    // --show-config is a setup/debug command users run BEFORE the config is
    // complete; the previous gate (only applyConfig if repo_owner) caused
    // setup-mode runs to leak all string fields except the extra list.
    if (cfg && Array.isArray(cfg.extra_redact_strings)) {
      EXTRA_REDACT_PATTERN = buildExtraRedactPattern(cfg.extra_redact_strings)
    }
    out({ status: 'ok', config: redactConfigForDisplay(cfg) })
  } else if (argv.includes('--audit')) {
    applyConfig(resolveConfig(true))
    const sampleFlag = argv.indexOf('--sample')
    const sample = sampleFlag >= 0 ? parseInt(argv[sampleFlag + 1] || '5', 10) : 5
    const r = auditSources({ sample })
    out({ status: 'ok', ...r })
  } else if (argv.includes('--init')) {
    applyConfig(resolveConfig(true))
    out({ status: 'ok', ...runInit() })
  } else if (argv.includes('--sync')) {
    applyConfig(resolveConfig(true))
    out({ status: 'ok', ...runSync() })
  } else {
    out({ status: 'error', message: 'Usage: --audit | --init | --sync | --self-test | --show-config' })
    process.exit(2)
  }
} catch (e) {
  // Codex PR-#137 round-5: errors might fire BEFORE applyConfig built
  // EXTRA_REDACT_PATTERN (e.g. config parse failure, missing backup dir
  // detected at runSync entry, validateBackupRemoteAndBranch failures).
  // Defensively try to load + build the pattern from config so the error
  // output still gets redacted. If config can't be loaded, redaction
  // falls back to home_path-only (still scrubs the user's $HOME prefix).
  if (!EXTRA_REDACT_PATTERN) {
    try {
      const cfg = loadConfig()
      if (cfg && Array.isArray(cfg.extra_redact_strings)) {
        EXTRA_REDACT_PATTERN = buildExtraRedactPattern(cfg.extra_redact_strings)
      }
    } catch { /* config unparseable; can't redact extra_redact_strings */ }
  }
  out({ status: 'error', message: String(e.message || e), stack: e.stack })
  process.exit(1)
}
