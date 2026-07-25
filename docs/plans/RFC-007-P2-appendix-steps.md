# RFC-007-P2 — Appendix A.7 step table (frozen before review)

Companion to `docs/plans/RFC-007-P2-rule-rfc-nodes.md`. Every "Exact action" cell below is
verbatim Node ESM, copy-pasteable into the named file. The executor makes **no** design
decisions; on any missing anchor it emits the §A.3 STOP block and halts.

One editable file per step. Verify after every step; a red verify is fixed in that step before
moving on. Every verify is a single command (no `;`, `&&`, `||`, pipes, subshells).

---

## S1 — `scripts/lib/rule-nodes.mjs` (CREATE)

**File:** `scripts/lib/rule-nodes.mjs` (new). **Action:** CREATE with exactly this content.

```js
/**
 * rule-nodes.mjs — project `rule` and `rfc` nodes for the RFC-007 graph projection.
 *
 * RFC-007 Phase 2 (issue #588). Read-only: this module never writes.
 *
 * `rule` nodes come from the Claude Code memory corpus
 * (`feedback_*.md`, `reference_*.md`, `MEMORY.md`, `MEMORY_*.md`) and are keyed by
 * slugify(frontmatter `name`). Files with no frontmatter `name:` are SKIPPED and counted —
 * RFC-007:133 forbids filename-derived slugs, so a file without `name:` has no id.
 *
 * `rfc` nodes come from `docs/rfcs/RFC-*.md` and are keyed by frontmatter `rfc_id`,
 * using the same `/^RFC-(\d{3})$/` grammar as scripts/em-rfc-validate.mjs:72 so both
 * RFC readers agree on what an RFC id is.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveRepoRoot } from './local-dir.mjs'

const RULE_GLOB_RE = /^(feedback_.+\.md|reference_.+\.md|MEMORY\.md|MEMORY_.+\.md)$/
const RFC_FILE_RE = /^RFC-.+\.md$/
const RFC_ID_RE = /^RFC-(\d{3})$/

/**
 * RFC-007:124-131. NFC, trim, lowercase, non-alphanumeric to '-', collapse, strip.
 * NO truncation: RFC-007 specifies none, and 101 of 125 live rule names exceed 40 chars,
 * so the repo's existing 40-char-truncating slug helpers are NOT reusable here.
 */
export function slugify(name) {
  return String(name)
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Flat (column-0) YAML frontmatter. Shape follows scripts/em-rfc-validate.mjs:73-91.
 * Indented blocks (e.g. a nested `metadata:`) are intentionally not parsed — Phase 2
 * needs only the top-level `name` and `entry_point` keys.
 * Returns a null-prototype object so a key like `__proto__` cannot pollute.
 */
export function parseFlatFrontmatter(text) {
  const out = Object.create(null)
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v.slice(1, -1)
    }
    out[kv[1]] = v
  }
  return out
}

/**
 * The Claude Code memory directory for THIS repo.
 *
 * Derived from resolveRepoRoot() (scripts/lib/local-dir.mjs:43), the primitive that walks a
 * linked worktree back to the main repo root. Do NOT use resolveLocalDir() — that returns
 * `<root>/.episodic-memory` (local-dir.mjs:69-71), not the root, and stripping the suffix
 * back off is forbidden.
 *
 * Claude Code names a project directory by replacing every path separator with '-'.
 * That convention is observed, not published; if it changes this returns a non-existent
 * path and rule nodes go to zero (graceful, per REQ-11).
 */
export function resolveRuleDir(cwd = process.cwd()) {
  const root = resolveRepoRoot(cwd)
  const slug = root.split(path.sep).join('-')
  return path.join(os.homedir(), '.claude', 'projects', slug, 'memory')
}

/**
 * @returns {{ruleById: Map<string,object>, collisions: string[], skipped: number}}
 * A symlinked directory is skipped: nothing in this module executes file content, but a
 * symlink is the one shape that could redirect the read outside the intended tree.
 */
export function scanRuleNodes(dir) {
  const ruleById = new Map()
  const collisions = []
  let skipped = 0
  let st = null
  try {
    st = fs.lstatSync(dir)
  } catch {
    return { ruleById, collisions, skipped }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    skipped += 1
    return { ruleById, collisions, skipped }
  }
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    skipped += 1
    return { ruleById, collisions, skipped }
  }
  for (const entry of entries.slice().sort()) {
    if (!RULE_GLOB_RE.test(entry)) continue
    const full = path.join(dir, entry)
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    const fm = parseFlatFrontmatter(text)
    const slug = slugify(typeof fm.name === 'string' ? fm.name : '')
    if (!slug) {
      skipped += 1
      continue
    }
    if (ruleById.has(slug)) {
      collisions.push(slug)
      continue
    }
    ruleById.set(slug, {
      id: slug,
      type: 'rule',
      entry_point: /^true$/i.test(fm.entry_point ?? ''),
      file: full,
    })
  }
  return { ruleById, collisions, skipped }
}

/**
 * @returns {{rfcById: Map<string,object>, skipped: number}}
 * Files matching RFC-*.md but lacking a well-formed `rfc_id` are skipped — the live corpus
 * has two (RFC-001-review.md, RFC-002-phase1-plan.md), matching em-rfc-validate.mjs:100.
 */
export function scanRfcNodes(dir) {
  const rfcById = new Map()
  let skipped = 0
  let st = null
  try {
    st = fs.lstatSync(dir)
  } catch {
    return { rfcById, skipped }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    skipped += 1
    return { rfcById, skipped }
  }
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    skipped += 1
    return { rfcById, skipped }
  }
  for (const entry of entries.slice().sort()) {
    if (!RFC_FILE_RE.test(entry)) continue
    const full = path.join(dir, entry)
    let text = ''
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      skipped += 1
      continue
    }
    const fm = parseFlatFrontmatter(text)
    if (typeof fm.rfc_id !== 'string' || !RFC_ID_RE.test(fm.rfc_id)) {
      skipped += 1
      continue
    }
    // Asymmetry with scanRuleNodes is deliberate (R2-5): a duplicate rule slug is a
    // user-corpus authoring error the user must fix, so it exits 2. A duplicate rfc_id
    // is impossible in a well-formed repo because em-rfc-validate.mjs already fails CI
    // on it (`duplicate-id-across-files`), so here it degrades to skip+count rather
    // than breaking every graph query on a condition another gate already owns.
    if (rfcById.has(fm.rfc_id)) {
      skipped += 1
      continue
    }
    rfcById.set(fm.rfc_id, {
      id: fm.rfc_id,
      type: 'rfc',
      entry_point: /^true$/i.test(fm.entry_point ?? ''),
      file: full,
    })
  }
  return { rfcById, skipped }
}
```

**Verify:** `node --check scripts/lib/rule-nodes.mjs`
**Expected:** no output, exit 0.

---

## S2 — `tests/test-em-graph-nodes.mjs` (CREATE)

**File:** `tests/test-em-graph-nodes.mjs` (new). **Action:** CREATE with exactly this content.

```js
/**
 * test-em-graph-nodes.mjs — RFC-007 Phase 2 (#588): rule + rfc node projection.
 *
 * Every behavioral assertion inspects REAL captured CLI output (stdout JSON + exit code)
 * from spawning scripts/em-graph.mjs. Pure-function cases call the lib directly.
 * Harness shape follows tests/test-em-graph.mjs:30-43.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { slugify, parseFlatFrontmatter, scanRuleNodes, scanRfcNodes } from '../scripts/lib/rule-nodes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const SCRIPTS = path.join(REPO, 'scripts')

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgn-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgn-home-')))
const env = { HOME: home }

const ruleDirFor = root => path.join(home, '.claude', 'projects', root.split(path.sep).join('-'), 'memory')
const RULE_DIR = ruleDirFor(cwd)
const RFC_DIR = path.join(cwd, 'docs', 'rfcs')

function resetRuleDir() {
  fs.rmSync(RULE_DIR, { recursive: true, force: true })
  fs.mkdirSync(RULE_DIR, { recursive: true })
}
function resetRfcDir() {
  fs.rmSync(RFC_DIR, { recursive: true, force: true })
  fs.mkdirSync(RFC_DIR, { recursive: true })
}
function writeRule(file, frontmatter) {
  fs.writeFileSync(path.join(RULE_DIR, file), `---\n${frontmatter}\n---\n\nbody\n`, 'utf8')
}
function writeRfc(file, frontmatter) {
  fs.writeFileSync(path.join(RFC_DIR, file), `---\n${frontmatter}\n---\n\nbody\n`, 'utf8')
}
function run(args, runCwd = cwd) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'em-graph.mjs'), ...args], {
    cwd: runCwd, encoding: 'utf8', env: { ...process.env, ...env },
  })
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  return { code: r.status, json, stdout: r.stdout }
}
function store(args) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'em-store.mjs'), '--project', 'fx', '--scope', 'local', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  })
  const j = JSON.parse(r.stdout.trim())
  assert.equal(j.status, 'ok', r.stdout)
  return j.id
}

resetRuleDir()
resetRfcDir()
store(['--category', 'decision', '--summary', 'lone episode', '--body', 'no edges here'])

// --- pure functions -------------------------------------------------------

t('t_slugify_spec_table', () => {
  const rows = [
    ['My Rule', 'my-rule'],
    ['  padded  ', 'padded'],
    ['UPPER', 'upper'],
    ['a  b', 'a-b'],
    ['a--b', 'a-b'],
    ['-lead-and-trail-', 'lead-and-trail'],
    ['dots.and_underscores', 'dots-and-underscores'],
    ['café', 'caf'],
    ['café', 'caf'],   // decomposed e + combining acute. NFC composes it; the non-ASCII
                        // codepoint then becomes '-' and strips (RFC :128). Both rows expecting
                        // 'caf' IS the NFC-convergence assertion. Expecting 'cafe' would demand
                        // diacritic folding, which RFC-007 does not specify.
    ['sym!!!bols', 'sym-bols'],
    ['123', '123'],
    ['x'.repeat(118), 'x'.repeat(118)],
  ]
  for (const [input, expected] of rows) {
    assert.equal(slugify(input), expected, `slugify(${JSON.stringify(input)})`)
  }
})

t('t_slugify_no_truncation', () => {
  // 60 x + separator + 60 y = exactly 121 characters. A 40- or 24-char truncating
  // slugifier (every existing one in this repo truncates) fails on the exact length.
  const long = `${'x'.repeat(60)} ${'y'.repeat(60)}`
  const expected = `${'x'.repeat(60)}-${'y'.repeat(60)}`
  assert.equal(slugify(long), expected)
  assert.equal(slugify(long).length, 121)
})

t('t_slugify_strips_path_chars', () => {
  const s = slugify('../../etc/passwd')
  assert.equal(s, 'etc-passwd')
  assert.ok(!s.includes('.'), 'no dots')
  assert.ok(!s.includes('/'), 'no separators')
})

t('t_parse_flat_frontmatter_null_proto', () => {
  const fm = parseFlatFrontmatter('---\nname: x\n---\nbody')
  assert.equal(Object.getPrototypeOf(fm), null)
  assert.equal(fm.name, 'x')
})

t('t_malformed_frontmatter_skipped', () => {
  resetRuleDir()
  fs.writeFileSync(path.join(RULE_DIR, 'feedback_bad.md'), '---\nname: never\nbody with no close\n', 'utf8')
  const r = scanRuleNodes(RULE_DIR)
  assert.equal(r.ruleById.size, 0)
  assert.equal(r.skipped, 1)
})

t('t_proto_key_rule_name', () => {
  resetRuleDir()
  writeRule('feedback_proto.md', 'name: __proto__')
  writeRule('feedback_ctor.md', 'name: constructor')
  const r = scanRuleNodes(RULE_DIR)
  assert.equal(r.ruleById.size, 2)
  assert.equal(r.ruleById.get('proto').type, 'rule')
  assert.equal(r.ruleById.get('constructor').type, 'rule')
})

t('t_only_globbed_files_read', () => {
  resetRuleDir()
  writeRule('feedback_yes.md', 'name: yes rule')
  fs.writeFileSync(path.join(RULE_DIR, 'notes.txt'), 'not markdown', 'utf8')
  fs.writeFileSync(path.join(RULE_DIR, 'random.md'), '---\nname: nope\n---\n', 'utf8')
  const r = scanRuleNodes(RULE_DIR)
  assert.deepEqual([...r.ruleById.keys()], ['yes-rule'])
})

t('t_symlinked_rule_dir_skipped', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'emgn-real-'))
  const link = path.join(os.tmpdir(), `emgn-link-${process.pid}`)
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(real, link, 'dir')
  const r = scanRuleNodes(link)
  assert.equal(r.ruleById.size, 0)
  assert.ok(r.skipped >= 1, 'symlinked dir must be counted as skipped, not silently empty')
  fs.rmSync(link, { recursive: true, force: true })
  fs.rmSync(real, { recursive: true, force: true })
})

t('t_entry_point_true_default_false_and_case', () => {
  resetRuleDir()
  writeRule('feedback_ep_true.md', 'name: ep true\nentry_point: true')
  writeRule('feedback_ep_absent.md', 'name: ep absent')
  writeRule('feedback_ep_caps.md', 'name: ep caps\nentry_point: True')
  const r = scanRuleNodes(RULE_DIR)
  assert.equal(r.ruleById.get('ep-true').entry_point, true)
  assert.equal(r.ruleById.get('ep-absent').entry_point, false)
  assert.equal(r.ruleById.get('ep-caps').entry_point, true, 'YAML True must not silently read false')
})

t('t_rule_no_name_skipped', () => {
  resetRuleDir()
  fs.writeFileSync(path.join(RULE_DIR, 'MEMORY.md'), '# no frontmatter at all\n', 'utf8')
  writeRule('feedback_empty_name.md', 'name:   ')
  const r = scanRuleNodes(RULE_DIR)
  assert.equal(r.ruleById.size, 0)
  assert.equal(r.skipped, 2)
})

t('t_rule_dir_present_but_empty', () => {
  resetRuleDir()
  const r = scanRuleNodes(RULE_DIR)
  assert.equal(r.ruleById.size, 0)
  assert.equal(r.skipped, 0)
  assert.equal(r.collisions.length, 0)
})

t('t_single_rule_node_corpus', () => {
  resetRuleDir()
  writeRule('feedback_only.md', 'name: only one')
  const r = scanRuleNodes(RULE_DIR)
  assert.equal(r.ruleById.size, 1)
  assert.equal(r.ruleById.get('only-one').id, 'only-one')
})

t('t_missing_rule_dir_graceful', () => {
  const r = scanRuleNodes(path.join(home, 'definitely', 'absent'))
  assert.equal(r.ruleById.size, 0)
  assert.equal(r.skipped, 0)
})

t('t_rfc_node_id_and_skips', () => {
  resetRfcDir()
  writeRfc('RFC-099-good.md', 'rfc_id: RFC-099\ntitle: Good')
  writeRfc('RFC-098-plan.md', 'title: no id here')
  writeRfc('RFC-097-bad.md', 'rfc_id: RFC-97')
  const r = scanRfcNodes(RFC_DIR)
  assert.deepEqual([...r.rfcById.keys()], ['RFC-099'])
  assert.equal(r.rfcById.get('RFC-099').type, 'rfc')
  assert.equal(r.skipped, 2, 'missing rfc_id and malformed rfc_id are both skipped')
})

// --- CLI behavior ---------------------------------------------------------

t('t_default_output_unchanged', () => {
  resetRuleDir()
  const before = run(['--orphans'])
  writeRule('feedback_added.md', 'name: added rule')
  const after = run(['--orphans'])
  assert.equal(after.code, 0)
  assert.deepEqual(after.json, before.json, 'adding rule files must not change default output')
  assert.ok(!('skipped_nodes' in after.json), 'no diagnostic key in default mode')
})

t('t_default_mode_does_not_scan', () => {
  resetRuleDir()
  writeRule('feedback_colide_a.md', 'name: A B')
  writeRule('feedback_colide_b.md', 'name: a-b')
  const dflt = run(['--orphans'])
  assert.equal(dflt.code, 0, 'default mode must NOT read the corpus; a scan would hit the collision and exit 2')
  const opted = run(['--orphans', '--nodes', 'rule'])
  assert.equal(opted.code, 2, 'probe must be live: the same fixtures exit 2 when opted in')
  assert.equal(opted.json.status, 'error')
})

t('t_orphans_surfaces_rule_nodes', () => {
  resetRuleDir()
  writeRule('feedback_surfaced.md', 'name: surfaced rule\nentry_point: true')
  const r = run(['--orphans', '--nodes', 'rule'])
  assert.equal(r.code, 0, r.stdout)
  const node = r.json.nodes.find(n => n.id === 'surfaced-rule')
  assert.ok(node, 'rule node must appear in --orphans output, not just in an internal Map')
  assert.equal(node.type, 'rule')
  assert.equal(node.entry_point, true)
  assert.equal(typeof r.json.skipped_nodes, 'number', 'diagnostic present when --nodes requested')
})

t('t_node_shape_no_episode_fields', () => {
  resetRuleDir()
  writeRule('feedback_shape.md', 'name: shape rule')
  const r = run(['--orphans', '--nodes', 'rule'])
  const node = r.json.nodes.find(n => n.id === 'shape-rule')
  for (const k of ['summary', 'category', 'project', 'status', 'date', 'source', 'pinned']) {
    assert.ok(!(k in node), `rule node must not carry episode-only field ${k}`)
  }
})

t('t_rfc_nodes_surface_via_cli', () => {
  resetRfcDir()
  writeRfc('RFC-099-good.md', 'rfc_id: RFC-099\ntitle: Good')
  const r = run(['--orphans', '--nodes', 'rfc'])
  assert.equal(r.code, 0, r.stdout)
  const node = r.json.nodes.find(n => n.id === 'RFC-099')
  assert.ok(node, 'rfc node must appear in --orphans output')
  assert.equal(node.type, 'rfc')
})

t('t_from_rule_id_returns_single_node', () => {
  resetRuleDir()
  writeRule('feedback_root.md', 'name: root rule')
  const r = run(['--from', 'root-rule', '--nodes', 'rule'])
  assert.equal(r.code, 0, r.stdout)
  assert.equal(r.json.count, 1)
  assert.equal(r.json.nodes[0].type, 'rule')
  assert.deepEqual(r.json.edges, [], 'Phase 2 gives rule nodes no edges')
})

t('t_from_unknown_id_still_exits_1', () => {
  const r = run(['--from', 'not-a-thing-at-all', '--nodes', 'rule'])
  assert.equal(r.code, 1)
  assert.equal(r.json.status, 'error')
})

t('t_nodes_unknown_exit_2', () => {
  const r = run(['--orphans', '--nodes', 'bogus'])
  assert.equal(r.code, 2)
  assert.equal(r.json.status, 'error')
  assert.ok(r.json.message.includes('bogus'))
})

t('t_hubs_excludes_degree_zero_rule_nodes', () => {
  resetRuleDir()
  writeRule('feedback_hub.md', 'name: hub candidate')
  const r = run(['--hubs', '--nodes', 'rule'])
  assert.equal(r.code, 0, r.stdout)
  assert.ok(!r.json.nodes.some(n => n.id === 'hub-candidate'), 'degree-0 nodes are not hubs')
})

t('t_no_writes', () => {
  resetRuleDir()
  writeRule('feedback_nw.md', 'name: nw rule')
  const snap = d => fs.readdirSync(d).sort().join(',')
  const beforeCwd = snap(cwd), beforeRule = snap(RULE_DIR)
  run(['--orphans', '--nodes', 'all'])
  assert.equal(snap(cwd), beforeCwd, 'em-graph must not write into cwd')
  assert.equal(snap(RULE_DIR), beforeRule, 'em-graph must not write into the rule corpus')
})

t('t_rule_dir_worktree_converged', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgn-repo-')))
  const git = (args, at) => spawnSync('git', args, { cwd: at, encoding: 'utf8' })
  git(['init', '-q'], repo)
  git(['config', 'user.email', 't@example.com'], repo)
  git(['config', 'user.name', 'T'], repo)
  fs.writeFileSync(path.join(repo, 'f.txt'), 'x', 'utf8')
  git(['add', '.'], repo)
  git(['commit', '-qm', 'init'], repo)
  const wt = path.join(os.tmpdir(), `emgn-wt-${process.pid}`)
  fs.rmSync(wt, { recursive: true, force: true })
  const added = git(['worktree', 'add', '-q', wt], repo)
  assert.equal(added.status, 0, `git worktree add failed: ${added.stderr}`)

  const sentinel = `zz-sentinel-${process.pid}`
  const dir = ruleDirFor(repo)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'feedback_sentinel.md'), `---\nname: ${sentinel}\n---\n\nbody\n`, 'utf8')

  const fromMain = run(['--orphans', '--nodes', 'rule'], repo)
  const fromWt = run(['--orphans', '--nodes', 'rule'], fs.realpathSync(wt))
  const ids = res => res.json.nodes.filter(n => n.type === 'rule').map(n => n.id).sort()
  assert.ok(ids(fromMain).includes(sentinel), 'main checkout must find the sentinel (empty set would pass vacuously)')
  assert.ok(ids(fromWt).includes(sentinel), 'linked worktree must converge on the SAME rule corpus')
  assert.deepEqual(ids(fromWt), ids(fromMain))

  git(['worktree', 'remove', '--force', wt], repo)
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- documentation invariants --------------------------------------------

t('t_guide_states_claude_code_scope', () => {
  const guide = fs.readFileSync(path.join(REPO, 'docs', 'EM_SCRIPTS_GUIDE.md'), 'utf8')
  assert.ok(/Rule-node availability is therefore Claude-Code-scoped/.test(guide),
    'REQ-16: the guide must state the Claude-Code scope of rule nodes')
})

t('t_rfc_states_no_name_policy', () => {
  const rfc = fs.readFileSync(path.join(REPO, 'docs', 'rfcs', 'RFC-007-graph-projection.md'), 'utf8')
  assert.ok(/no frontmatter `name:` key has no identifier and is SKIPPED/.test(rfc),
    'REQ-17: the no-name policy must be written into the RFC in this PR')
})

t('t_rfc_rows_flipped', () => {
  const rfc = fs.readFileSync(path.join(REPO, 'docs', 'rfcs', 'RFC-007-graph-projection.md'), 'utf8')
  assert.ok(!/\| `rule` \| UNBUILT — next phase \|/.test(rfc), 'REQ-15: rule row must no longer read UNBUILT')
  assert.ok(!/\| `rfc` \| UNBUILT — next phase \|/.test(rfc), 'REQ-15: rfc row must no longer read UNBUILT')
})

fs.rmSync(cwd, { recursive: true, force: true })
fs.rmSync(home, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

**Verify:** `node --check tests/test-em-graph-nodes.mjs`
**Expected:** no output, exit 0.

**Do NOT run the suite for green at this step.** At S2 the file exists but nothing it exercises
does: `em-graph.mjs` is unedited, so `--nodes` is an unknown flag and every CLI case fails; and the
three document-asserting cases depend on S5/S6. Roughly half the suite is red at S2 **by design**.
An executor following §A.2 rule 4 would otherwise try to "fix" a correct test file.

Green-gate schedule:

| After | Command | Expected |
|---|---|---|
| S2 | `node --check tests/test-em-graph-nodes.mjs` | syntax clean, exit 0 |
| S3 | `node tests/test-em-graph.mjs` | `10 passed, 0 failed` (the regression proof) |
| S3 | `node tests/test-em-graph-nodes.mjs` | all cases green EXCEPT the three doc-asserting ones |
| S6 | `node tests/test-em-graph-nodes.mjs` | `28 passed, 0 failed` |

---

## S3 — `scripts/em-graph.mjs` (EDIT, four anchored insertions)

**File:** `scripts/em-graph.mjs`. Four smallest-diff edits. If any anchor is not found
verbatim, STOP.

**S3.1 — imports.** Two changes on adjacent lines.

(a) Anchor (verbatim): `import { resolveLocalDir } from './lib/local-dir.mjs'`
Replace that ONE line with (widened, not duplicated — R2-6):
```js
import { resolveLocalDir, resolveRepoRoot } from './lib/local-dir.mjs'
```

(b) Anchor (verbatim): `import { loadIndex } from './lib/relevance.mjs'`
Insert immediately AFTER it:
```js
import { resolveRuleDir, scanRuleNodes, scanRfcNodes } from './lib/rule-nodes.mjs'
```

**S3.2 — node-type constants.** Anchor (verbatim):
`const EDGE_TYPES = ['supersedes', 'consolidates', 'evidence', 'cites', 'tags']`
Insert immediately BEFORE it:
```js
const NODE_TYPES = ['episode', 'rule', 'rfc']
const DEFAULT_NODES = ['episode']
const nodesRaw = flag('--nodes')
const nodeTypes = nodesRaw === 'all' ? NODE_TYPES
  : nodesRaw ? nodesRaw.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_NODES
for (const n of nodeTypes) {
  if (!NODE_TYPES.includes(n)) {
    console.log(JSON.stringify({ status: 'error', message: `Unknown node type "${n}". Valid: ${NODE_TYPES.join(', ')} (or "all").` }))
    process.exit(2)
  }
}
```

**S3.3 — gated scan + diagnostic helper.** Anchor (verbatim):
`const byId = new Map(rows.map(r => [r.id, r]))`
Insert immediately AFTER it:
```js
// Opt-in only. With no --nodes flag the rule corpus is never read: no stat, no readdir,
// and nodeDiag() contributes nothing, so default output stays byte-identical (REQ-8).
const ruleById = new Map()
const rfcById = new Map()
let skippedNodes = 0
const REPO_ROOT = nodeTypes.includes('rfc') ? resolveRepoRoot() : null
if (nodeTypes.includes('rule')) {
  const scanned = scanRuleNodes(resolveRuleDir())
  if (scanned.collisions.length > 0) {
    console.log(JSON.stringify({ status: 'error', message: `Rule slug collision: ${scanned.collisions.join(', ')}. Two rule files produce the same slug; rename one frontmatter "name".` }))
    process.exit(2)
  }
  for (const [k, v] of scanned.ruleById) ruleById.set(k, v)
  skippedNodes += scanned.skipped
}
if (nodeTypes.includes('rfc')) {
  const scanned = scanRfcNodes(path.join(REPO_ROOT, 'docs', 'rfcs'))
  for (const [k, v] of scanned.rfcById) rfcById.set(k, v)
  skippedNodes += scanned.skipped
}
const nodeDiag = () => (nodesRaw === undefined ? {} : { skipped_nodes: skippedNodes })
```

**S3.4 — `nodeOut` type dispatch.** Anchor (verbatim):
`  if (id.startsWith('tag:')) return { id, type: 'tag', distance: dist }`
Insert immediately AFTER it:
```js
  if (ruleById.has(id)) {
    const n = ruleById.get(id)
    return { id, type: 'rule', distance: dist, entry_point: n.entry_point, file: n.file }
  }
  if (rfcById.has(id)) {
    const n = rfcById.get(id)
    return { id, type: 'rfc', distance: dist, entry_point: n.entry_point, file: n.file }
  }
```

**S3.5 — emit rule/rfc nodes in `--orphans`.** Without this the S3.4 branches are dead code and
`--nodes` is a no-op (finding R2-1). Anchor (verbatim, two consecutive lines):
```js
    const out = rows.filter(r => reportable(r) && degree.get(r.id) === 0).map(r => nodeOut(r.id, 0))
    console.log(JSON.stringify({ status: 'ok', mode: 'orphans', count: out.length, nodes: out }))
```
Replace BOTH lines with:
```js
    const out = rows.filter(r => reportable(r) && degree.get(r.id) === 0).map(r => nodeOut(r.id, 0))
    // Phase 2 gives rule/rfc nodes no edges, so every one is degree 0 and is an orphan
    // by the mode's own definition. Appended only when --nodes opted them in; both maps
    // are empty otherwise, so the default result set is unchanged (REQ-8).
    for (const id of ruleById.keys()) out.push(nodeOut(id, 0))
    for (const id of rfcById.keys()) out.push(nodeOut(id, 0))
    console.log(JSON.stringify({ status: 'ok', mode: 'orphans', count: out.length, nodes: out, ...nodeDiag() }))
```

**S3.6 — `--hubs` is deliberately NOT changed.** No edit. Recorded so the omission is a decision,
not an oversight: the hubs filter at `em-graph.mjs:223` is `.filter(([id, d]) => d > 0 && …)`, and
a Phase-2 rule/rfc node has degree 0, so it is correctly excluded. When Phase 3 (#589) gives these
nodes edges they begin appearing in `--hubs` automatically with no further change. Adding them now
at degree 0 would contradict the mode's meaning.

**S3.7 — `--from <rule-id>` resolves instead of erroring.** Anchor (verbatim, four lines):
```js
if (!byId.has(from)) {
  console.log(JSON.stringify({ status: 'error', message: `Episode "${from}" not found in the selected scope.` }))
  process.exit(1)
}
```
Replace ALL FOUR lines with:
```js
if (!byId.has(from)) {
  if (ruleById.has(from) || rfcById.has(from)) {
    // A projected rule/rfc node is a legitimate traversal root. Phase 2 gives it no
    // edges, so the result is the node itself at depth 0. Once Phase 3 lands, these
    // ids gain adjacency entries and fall through to the normal BFS below.
    console.log(JSON.stringify({
      status: 'ok',
      root: from,
      depth,
      edge_types: edgeTypes,
      count: 1,
      nodes: [nodeOut(from, 0)],
      edges: [],
      ...nodeDiag(),
    }))
    process.exit(0)
  }
  console.log(JSON.stringify({ status: 'error', message: `Episode "${from}" not found in the selected scope.` }))
  process.exit(1)
}
```

**S3.8 — thread the diagnostic into the traversal response.** Anchor (verbatim):
```js
  edges: outEdges,
  ...(truncated ? { truncated: true } : {}),
```
Replace BOTH lines with:
```js
  edges: outEdges,
  ...(truncated ? { truncated: true } : {}),
  ...nodeDiag(),
```

**Verify:** `node tests/test-em-graph.mjs`
**Expected:** `10 passed, 0 failed`, exit 0 — the unchanged-default regression proof.

---

## S4 — `.github/workflows/tests.yml` (EDIT, one insertion)

**File:** `.github/workflows/tests.yml`.
Anchor (verbatim, two consecutive lines):
```yaml
      - name: Run em-graph suite (RFC-007 core + wave-6 hardening)
        run: node tests/test-em-graph.mjs
```
Insert immediately AFTER those two lines:
```yaml

      - name: Run em-graph node-projection suite (RFC-007 Phase 2)
        run: node tests/test-em-graph-nodes.mjs
```

**Verify:** `node tests/test-ci-suite-registration.mjs`
**Expected:** passes; `tests/test-em-graph-nodes.mjs` must NOT be added to `KNOWN_UNWIRED`.

---

## S5 — `docs/rfcs/RFC-007-graph-projection.md` (EDIT, five changes)

**S5.1 — node table.** Anchor: `| \`rule\` | UNBUILT — next phase |`
Replace with: `| \`rule\` | SHIPPED (\`em-graph.mjs:<LINE>\`), opt-in via \`--nodes rule\` |`
where `<LINE>` is the actual line of the `ruleById.has(id)` branch after S3.4. Same for
`| \`rfc\` | UNBUILT — next phase |`.

**S5.2 — no-`name:` policy (REQ-17).** Anchor (verbatim), the rule-node detail sentence at `:61`:
`\`rule\` — source would be \`~/.claude/projects/.../memory/feedback_*.md\`, \`reference_*.md\`, \`MEMORY.md\`, \`MEMORY_*.md\`; identifier = filename (slug from frontmatter \`name\`).`
Append to that paragraph:
```
A rule file with no frontmatter `name:` key has no identifier and is SKIPPED, counted in the
scan's `skipped` total, never projected under a filename-derived slug (which `:133` forbids).
As observed on 2026-07-25, eight files in the reference corpus are in this state and every one of
them is a `MEMORY*` file: `MEMORY.md`, `MEMORY_alwaystier_incidents.md`, `MEMORY_anchors.md`,
`MEMORY_incidents_2026-07-10.md`, `MEMORY_open_issues.md`, `MEMORY_pr_history.md`,
`MEMORY_seat_ops.md`, `MEMORY_tooling.md` — eight of the nine files matching the `MEMORY.md` plus
`MEMORY_*.md` globs, the exception being `MEMORY_workplan_changelog.md`. Note that `:233` names
`MEMORY.md` among the canonical entry-point roots, so a canonical root is currently
unprojectable. That tension is tracked on issue #585 with the other `entry_point` contradictions.
```

**Count provenance (do not restate from memory).** The eight-file list above came from
`grep -L "^name:" <corpus>/feedback_*.md <corpus>/reference_*.md <corpus>/MEMORY.md <corpus>/MEMORY_*.md`
run at `9cb9e8b`. The pre-build plan text said seven; the observed count is eight. If the corpus
has drifted again by build time, re-run that grep and write the observed list, never the number
frozen here.

**S5.3 — Phase 2 row.** Anchor: the Phase 2 row at `:359`. Change `**UNBUILT**` to `**SHIPPED**`
and append the delivering PR to the row.

**S5.4 — ledger + OQ-1.** Add an Implementation-table row whose SHA comes from
`git log --oneline --follow -- scripts/em-graph.mjs` after merge, never copied from another RFC
row. Mark OQ-1 (`:543`) `**RESOLVED**`.

**S5.5 — retire the self-refuting `entry_point` status line (pre-build delta Δ2).** Anchor
(verbatim, the whole line at `:246`):
```
**Status: UNBUILT — next phase.** `entry_point` is not read by any shipped code (`grep entry_point scripts/` is empty). It belongs with the `rule` node type phase (Phase 2) where rule nodes themselves are first projected. The design is preserved verbatim so RFC-007-B can file it.
```
Replace that entire line with:
```
**Status: PARTIAL — key parsed in Phase 2, consumed in Phase 4.** The key is read and carried on
`rule` nodes by `scripts/lib/rule-nodes.mjs` and surfaced as `entry_point` on projected rule nodes
(opt-in via `--nodes rule`). Its audit consumption — suppression from `nodes_with_no_edges[]` and
appearance in `entry_points[]` via `--graph-health` — remains Phase 4 (`:304`, `:361`), and its
persisted form inside `graph.json` remains Phase 6 (`:363`). This three-way split is the
reconciliation of the phase assignments that this section, `:304`, and `:363` previously gave
without narrating; adopted by the Phase 2 PR.
```

**Why this step exists.** The `:246` line asserts `grep entry_point scripts/` is empty. That is
true before this PR and FALSE after S1, because `scripts/lib/rule-nodes.mjs` parses the key.
Shipping S5.1-S5.4 without this step would leave the RFC stating a verification command that
refutes the RFC. This is the PR #598 class: fix the whole class the grep reveals, not the sites
someone enumerated.

**Class check (run it, do not reason about it):**
`grep -n "entry_point" docs/rfcs/RFC-007-graph-projection.md` — expect hits at `:233`, `:234`,
`:246`, `:252`, `:304`, `:359`, `:361`, `:363`, `:454`. Only `:246` asserts a build state that this
PR changes. `:304` / `:361` / `:363` describe Phase 4 and Phase 6 work that stays unbuilt and MUST
NOT be flipped. `:233` / `:234` / `:252` are design text that stays accurate. `:454` is review
history. If the grep returns a line not in this list, STOP and ask per A.3.

**Verify:** `node scripts/em-rfc-validate.mjs`
**Expected:** `✓ RFC registry consistent: 14 RFCs in _index.json, 14 canonical files, 14 README table rows.`, exit 0.

---

## S6 — `docs/EM_SCRIPTS_GUIDE.md` (EDIT, one paragraph)

**File:** `docs/EM_SCRIPTS_GUIDE.md`, the `em-graph` section (around `:732-750`).
Append to that section:
```
`--nodes rule` reads the Claude Code memory corpus at
`~/.claude/projects/<project-slug>/memory/`. On installs without that directory — any
non-Claude-Code tool, or a fresh machine — the rule-node set is empty and the command still
exits 0. Rule-node availability is therefore Claude-Code-scoped, not portable across tools.
```

**Verify:** `node tests/test-em-graph-nodes.mjs`
**Expected:** `<N> passed, 0 failed` including `t_guide_states_claude_code_scope`.
