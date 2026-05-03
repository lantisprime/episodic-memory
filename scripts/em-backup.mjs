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
    const entry = { label: s.label, src: s.src, exists, files: 0, text_files: 0, binary_files: 0, oversized_skipped: 0, redactions: 0 }
    if (!exists) { report.sources.push(entry); continue }
    const files = walk(s.src)
    for (const f of files) {
      const stat = fs.statSync(f)
      if (stat.size > MAX_FILE_BYTES) { entry.oversized_skipped++; report.totals.oversized_skipped++; continue }
      entry.files++
      report.totals.files++
      // Codex F3: probe content; binary files are skipped (not byte-copied).
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
          // Codex F1: NEVER emit raw pre-redaction content. The audit JSON
          // itself is shareable artifact (review evidence, terminal logs) so
          // raw secrets/PII would leak through `before_snippet`. Show only
          // the redacted snippet plus the patterns that fired.
          const idx = firstDiffIndex(content, redacted)
          report.samples.push({
            file: f,
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
    for (const sym of sourceLog) skippedSymlinks.push({ source: s.label, path: sym })
    for (const f of files) {
      const stat = fs.statSync(f)
      if (stat.size > MAX_FILE_BYTES) {
        skippedOversized.push({ source: s.label, path: f, size: stat.size })
        continue
      }
      // Codex F3: redact-by-default. Anything that isn't binary gets the
      // redaction pipeline, regardless of extension. Binary files are
      // skipped with a manifest entry (NEVER byte-copied raw — would let
      // .pem / .key / .sqlite leak unredacted past the regex pipeline).
      if (classifyFileBytes(f) === 'binary') {
        skippedBinary.push({ source: s.label, path: f, size: stat.size })
        continue
      }
      const rel = path.relative(s.src, f)
      const destPath = path.join(destBase, rel)
      ensureDir(path.dirname(destPath))
      const content = fs.readFileSync(f, 'utf8')
      const { redacted, findings } = applyRedactions(content)
      fs.writeFileSync(destPath, redacted)
      totalRedacted += findings.reduce((a, b) => a + b.count, 0)
      totalCopied++
    }
    pruneDeleted(s.src, destBase)
  }
  const manifest = {
    generated_at: new Date().toISOString(),
    skipped_symlinks: skippedSymlinks,
    skipped_oversized: skippedOversized.map(x => ({ ...x, max_bytes: MAX_FILE_BYTES })),
    skipped_binary: skippedBinary, // Codex F3
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
    throw new Error(`em-backup: backup repo at ${BACKUP_DIR} has no 'origin' remote configured. Refusing to push.`)
  }
  const parsed = parseGitHubRemote(originUrl)
  if (!parsed) {
    throw new Error(`em-backup: backup repo origin "${originUrl}" is not a recognized GitHub URL. Refusing to push.`)
  }
  if (parsed.owner !== REPO_OWNER || parsed.name !== REPO_NAME) {
    throw new Error(`em-backup: backup repo origin points at ${parsed.owner}/${parsed.name} but config expects ${REPO_OWNER}/${REPO_NAME}. Refusing to push (personal memory could ship to wrong repo).`)
  }
  // Branch invariant: must be on main. Refuse if HEAD is detached or on
  // a different branch — commit would land on the wrong ref and `git push
  // origin main` would push the stale local main, not the new commit.
  let branch = ''
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts).toString().trim()
  } catch {
    throw new Error(`em-backup: backup repo at ${BACKUP_DIR} has no HEAD; cannot determine branch. Refusing to push.`)
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

  return { pass, fail, total: pass + fail, results }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
function out(o) { console.log(JSON.stringify(o, null, 2)) }

// Populate globals from config (modes that touch real sources/push need it).
function applyConfig(cfg) {
  if (cfg.backup_dir) BACKUP_DIR = cfg.backup_dir
  REPO_OWNER = cfg.repo_owner
  REPO_NAME = cfg.repo_name
  SOURCES.length = 0
  for (const s of cfg.sources) SOURCES.push(s)
  EXTRA_ALLOWLIST_EMAILS = new Set(cfg.extra_allowlist_emails || [])
  EXTRA_ALLOWLIST_DOMAINS = new Set(cfg.extra_allowlist_domains || [])
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
    out({ status: 'ok', config: cfg })
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
  out({ status: 'error', message: String(e.message || e), stack: e.stack })
  process.exit(1)
}
