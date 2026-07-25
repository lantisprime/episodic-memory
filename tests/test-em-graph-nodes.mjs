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
    ['café', 'caf'],   // decomposed e + combining acute. NFC composes it; the non-ASCII
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
