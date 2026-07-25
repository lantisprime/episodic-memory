/**
 * test-em-graph-links.mjs — RFC-007 Phase 3 S1 (#589): wiki-link edge,
 * dangling scaffold, rule-node mode integration.
 *
 * S1 scope: 21 cases from §14 groups 1, 2, 3b, 4, 5, 6, 7. S2 adds group 3
 * (composes-with) in a follow-up slice; not authored here.
 *
 * Every assertion inspects REAL captured CLI output (parsed stdout JSON or
 * exit code) from spawning scripts/em-graph.mjs. Harness shape follows
 * tests/test-em-graph-nodes.mjs:22-48. Discriminating sentinel: every fixture
 * rule slug carries `sentinel-a1b2c3` so a passing assertion cannot be
 * satisfied by an unrelated corpus entry.
 *
 * Negative-control break: passing --break-wikilink makes the runner copy
 * scripts/em-graph.mjs into a temp dir with linkTargets() stubbed to return
 * [], then run all tests against the broken copy. The suite exits non-zero
 * because the wiki-link assertions catch the break.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const SCRIPTS = path.join(REPO, 'scripts')

const BREAK_WIKILINK = process.argv.includes('--break-wikilink')

let pass = 0, fail = 0
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`) }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`) }
}

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgl-')))
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgl-home-')))
const env = { HOME: home }

const ruleDirFor = root => path.join(home, '.claude', 'projects', root.split(path.sep).join('-'), 'memory')
const RULE_DIR = ruleDirFor(cwd)

// Negative-control: when --break-wikilink is set, copy scripts/ to a temp dir
// and stub linkTargets() to return []. The runner then spawns from the temp
// dir, so wiki-link-dependent assertions fail (no edges, no dangling entries).
let SCRIPTS_USE = SCRIPTS
let breakTemp = null
if (BREAK_WIKILINK) {
  breakTemp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'emgl-break-')))
  for (const f of fs.readdirSync(SCRIPTS)) {
    const src = path.join(SCRIPTS, f)
    const dst = path.join(breakTemp, f)
    fs.cpSync(src, dst, { recursive: true })
  }
  const orig = fs.readFileSync(path.join(breakTemp, 'em-graph.mjs'), 'utf8')
  const re = /function linkTargets\(cleaned\) \{[\s\S]*?return \[\.\.\.new Set\(out\)\]\s*\}/
  if (!re.test(orig)) throw new Error('--break-wikilink: failed to locate linkTargets() in em-graph.mjs')
  const broken = orig.replace(re, 'function linkTargets(cleaned) { return [] }')
  fs.writeFileSync(path.join(breakTemp, 'em-graph.mjs'), broken)
  SCRIPTS_USE = breakTemp
}

function resetRuleDir() {
  fs.rmSync(RULE_DIR, { recursive: true, force: true })
  fs.mkdirSync(RULE_DIR, { recursive: true })
}
function writeRule(file, frontmatter, body = 'body') {
  fs.writeFileSync(path.join(RULE_DIR, file), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
}
function run(args) {
  const r = spawnSync('node', [path.join(SCRIPTS_USE, 'em-graph.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  })
  let json = null
  try { json = JSON.parse(r.stdout.trim()) } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}

// ---------------------------------------------------------------------------
// Group 1: wiki-link shape matrix (15 rows, one test)
// ---------------------------------------------------------------------------
t('t_wikilink_shape_matrix', () => {
  resetRuleDir()
  // Source rule carries 15 distinct shapes in one body. Targets exist for
  // 5 named shapes plus the filename-alias shape; 1 dangles; 9 are ignored.
  const SRC = 'sentinel-a1b2c3-source'
  writeRule('feedback_src.md', `name: ${SRC}`,
    `[[sentinel-a1b2c3-tgt-a]]\n` +
    `[[sentinel-a1b2c3-tgt-b#sec]]\n` +
    `[[sentinel-a1b2c3-tgt-c|alias]]\n` +
    `[[sentinel-a1b2c3-tgt-d#a|b]]\n` +
    `[[SENTINEL-A1B2C3-TGT-E]]\n` +
    `[[sentinel-a1b2c3-ghost-6]]\n` +
    `[[]]\n` +
    `[[   ]]\n` +
    `\`[[sentinel-a1b2c3-ingo-back-11]]\`\n` +
    `[sentinel-a1b2c3-md-link-12](path.md)\n` +
    `[[[[sentinel-a1b2c3-tgt-a]]]]\n` +
    `[[sentinel-a1b2c3-source]]\n` +
    `[[feedback-aliased-target]]\n` +
    `\n\`\`\`\n[[sentinel-a1b2c3-ingo-fence-9]]\n\`\`\`\n` +
    `\n~~~\n[[sentinel-a1b2c3-ingo-fence-10]]\n~~~\n`
  )
  writeRule('feedback_tgt_a.md', 'name: sentinel-a1b2c3-tgt-a')
  writeRule('feedback_tgt_b.md', 'name: sentinel-a1b2c3-tgt-b')
  writeRule('feedback_tgt_c.md', 'name: sentinel-a1b2c3-tgt-c')
  writeRule('feedback_tgt_d.md', 'name: sentinel-a1b2c3-tgt-d')
  writeRule('feedback_tgt_e.md', 'name: sentinel-a1b2c3-tgt-e')
  // Filename for the alias shape: basename 'feedback_aliased_target' slugs to
  // 'feedback-aliased-target'. The target rule's name-id is the different
  // string 'sentinel-a1b2c3-aliased-name', so the link MUST resolve via the
  // alias index (not via name-id lookup).
  writeRule('feedback_aliased_target.md', 'name: sentinel-a1b2c3-aliased-name')

  // --from so the output includes `edges` and `dangling`.
  const r = run(['--from', SRC, '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const edges = r.json.edges || []
  const dangling = r.json.dangling || []
  const srcEdges = edges.filter(e => e.from === SRC && e.type === 'wiki-link')

  // Shape 1: basic [[name]] resolves
  assert.ok(srcEdges.some(e => e.to === 'sentinel-a1b2c3-tgt-a'),
    'shape 1: basic [[name]] resolves to name-id target')

  // Shape 2: [[name#anchor]] — anchor stripped
  assert.ok(srcEdges.some(e => e.to === 'sentinel-a1b2c3-tgt-b'),
    'shape 2: [[name#anchor]] resolves with anchor stripped')

  // Shape 3: [[name|alias]] — alias dropped
  assert.ok(srcEdges.some(e => e.to === 'sentinel-a1b2c3-tgt-c'),
    'shape 3: [[name|alias]] resolves with alias dropped')

  // Shape 4: [[name#a|b]] — both stripped
  assert.ok(srcEdges.some(e => e.to === 'sentinel-a1b2c3-tgt-d'),
    'shape 4: [[name#a|b]] resolves with both anchor and alias stripped')

  // Shape 5: [[UPPERCASE]] — case-folded to lowercase
  assert.ok(srcEdges.some(e => e.to === 'sentinel-a1b2c3-tgt-e'),
    'shape 5: [[UPPERCASE]] case-folds to lowercase target')

  // Shape 6: unknown target — dangles
  const ghostDangling = dangling.filter(d => d.source === SRC && d.ref === 'sentinel-a1b2c3-ghost-6')
  assert.equal(ghostDangling.length, 1, 'shape 6: unknown target dangles; exactly one entry')

  // Shape 7: [[]] — empty, ignored
  assert.ok(!dangling.some(d => d.source === SRC && d.ref === ''),
    'shape 7: empty [[]] produces no dangling entry')

  // Shape 8: [[   ]] — whitespace, ignored
  assert.ok(!dangling.some(d => d.source === SRC && d.ref === '-'),
    'shape 8: whitespace [[   ]] slugifies to "-" and produces no dangling entry (ignored)')

  // Shape 9: fenced with backticks — ignored
  assert.ok(!dangling.some(d => d.source === SRC && d.ref === 'sentinel-a1b2c3-ingo-fence-9'),
    'shape 9: fenced ``` [[X]] ``` produces no dangling entry')
  assert.ok(!edges.some(e => e.from === SRC && e.to === 'sentinel-a1b2c3-ingo-fence-9'),
    'shape 9: fenced ``` [[X]] ``` produces no edge')

  // Shape 10: fenced with tildes — ignored
  assert.ok(!dangling.some(d => d.source === SRC && d.ref === 'sentinel-a1b2c3-ingo-fence-10'),
    'shape 10: ~~~fenced [[X]]~~~ produces no dangling entry')

  // Shape 11: inline backticks — ignored (backticks stripped before regex)
  assert.ok(!dangling.some(d => d.source === SRC && d.ref === 'sentinel-a1b2c3-ingo-back-11'),
    'shape 11: inline `[[X]]` produces no dangling entry')

  // Shape 12: markdown link, not wiki — ignored
  assert.ok(!dangling.some(d => d.source === SRC && d.ref === 'sentinel-a1b2c3-md-link-12'),
    'shape 12: [text](path.md) markdown link produces no dangling entry')

  // Shape 13: nested [[[[X]]]] — outer match, slug dedupes
  const edgesToA = srcEdges.filter(e => e.to === 'sentinel-a1b2c3-tgt-a')
  assert.equal(edgesToA.length, 1,
    'shape 13: nested [[[[X]]]] resolves to X target, deduped to single edge')

  // Shape 14: self-loop — dropped
  assert.ok(!srcEdges.some(e => e.to === SRC),
    'shape 14: [[self]] self-loop is dropped (no self-edge)')
  assert.ok(!dangling.some(d => d.source === SRC && d.ref === SRC),
    'shape 14: self-loop produces no dangling entry')

  // Shape 15: filename-alias resolves when name-id is absent
  assert.ok(srcEdges.some(e => e.to === 'sentinel-a1b2c3-aliased-name'),
    'shape 15: [[filename-slug]] resolves via filename-alias index')
})

// ---------------------------------------------------------------------------
// Group 2: exclusion (3)
// ---------------------------------------------------------------------------
t('t_wikilink_fence_exclusion', () => {
  resetRuleDir()
  writeRule('feedback_fence_src.md', 'name: sentinel-a1b2c3-fence-src',
    'before\n```\n[[sentinel-a1b2c3-ingo-fenced]]\n```\nafter')
  writeRule('feedback_fence_tgt.md', 'name: sentinel-a1b2c3-ingo-fenced')
  const r = run(['--from', 'sentinel-a1b2c3-fence-src', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const srcEdges = (r.json.edges || []).filter(e => e.from === 'sentinel-a1b2c3-fence-src')
  assert.equal(srcEdges.length, 0, 'fenced block wiki-link produces no edge')
  assert.equal((r.json.dangling || []).length, 0, 'fenced block wiki-link produces no dangling entry')
  // Source has degree 0 — only the source is in the traversal set
  assert.equal(r.json.count, 1, 'source has no resolved edges; traversal visits only the source')
})

t('t_wikilink_inline_backtick_exclusion', () => {
  resetRuleDir()
  writeRule('feedback_inline_src.md', 'name: sentinel-a1b2c3-inline-src',
    'before `[[sentinel-a1b2c3-ingo-inline]]` after')
  writeRule('feedback_inline_tgt.md', 'name: sentinel-a1b2c3-ingo-inline')
  const r = run(['--from', 'sentinel-a1b2c3-inline-src', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const srcEdges = (r.json.edges || []).filter(e => e.from === 'sentinel-a1b2c3-inline-src')
  assert.equal(srcEdges.length, 0, 'inline-backticked wiki-link produces no edge')
  assert.equal((r.json.dangling || []).length, 0, 'inline-backticked wiki-link produces no dangling entry')
})

// Parity with shipped cites (em-graph.mjs:207): stripFenced is non-greedy and needs a
// closing fence, so an unclosed fence swallows nothing. Asserted deliberately.
t('t_unclosed_fence_does_not_swallow_remainder', () => {
  resetRuleDir()
  writeRule('feedback_unclosed_src.md', 'name: sentinel-a1b2c3-unclosed-src',
    'before\n```\nafter [[sentinel-a1b2c3-ingo-unclosed]]')
  writeRule('feedback_unclosed_tgt.md', 'name: sentinel-a1b2c3-ingo-unclosed')
  const r = run(['--from', 'sentinel-a1b2c3-unclosed-src', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const srcEdges = (r.json.edges || []).filter(e => e.from === 'sentinel-a1b2c3-unclosed-src')
  assert.equal(srcEdges.length, 1, 'unclosed fence does NOT swallow remainder; the wiki-link IS extracted and produces one edge')
  assert.ok(srcEdges.some(e => e.to === 'sentinel-a1b2c3-ingo-unclosed'),
    'edge target is the in-body wiki-link target (proves the link was parsed after the unclosed fence)')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entry (target resolves)')
})

// ---------------------------------------------------------------------------
// Group 3b: target resolution (3)
// ---------------------------------------------------------------------------
t('t_alias_resolves_filename_style_link', () => {
  resetRuleDir()
  // Target rule: name = 'sentinel-a1b2c3-aliased-name', filename basename
  // 'feedback_aliased_target' slugs to 'feedback-aliased-target'. There is
  // no rule with name-id 'feedback-aliased-target', so the alias index
  // holds the entry. The source links by the filename slug.
  writeRule('feedback_aliased_target.md', 'name: sentinel-a1b2c3-aliased-name')
  writeRule('feedback_linker.md', 'name: sentinel-a1b2c3-alias-linker',
    '[[feedback-aliased-target]]')
  const r = run(['--from', 'sentinel-a1b2c3-alias-linker', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const edge = (r.json.edges || []).find(e =>
    e.from === 'sentinel-a1b2c3-alias-linker' &&
    e.to === 'sentinel-a1b2c3-aliased-name' &&
    e.type === 'wiki-link')
  assert.ok(edge, 'filename-style link resolves via alias index')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entries')
})

// Both guards (build-time ruleById.has(base) skip, and resolveTarget name-first
// ordering) enforce this jointly, so this test proves the observable contract --
// a filename cannot hijack a link away from the node that owns that id -- but it
// cannot isolate which of the two guards is doing the work.
t('t_name_id_wins_over_alias', () => {
  resetRuleDir()
  // Owner: glob-compatible filename, name-id = feedback-sentinel-a1b2c3-target
  writeRule('feedback_alpha_owner.md', 'name: feedback-sentinel-a1b2c3-target')
  // Decoy: glob-compatible filename whose basename slugifies to the OWNER's
  // name-id, with a DIFFERENT name-id. The alias build loop iterates the
  // decoy: base = 'feedback-sentinel-a1b2c3-target', and ruleById.has(base)
  // is true (the owner holds that id), so the alias is dropped.
  writeRule('feedback_sentinel-a1b2c3-target.md', 'name: sentinel-a1b2c3-decoy')
  // Source: links to the owner by its name-id
  writeRule('feedback_src.md', 'name: sentinel-a1b2c3-c',
    '[[feedback-sentinel-a1b2c3-target]]')
  // Precondition 1: owner is live (in ruleById). The owner has an incoming
  // edge from the source, so it is reachable from --from source and
  // appears in the BFS nodes[]. If it is absent, the glob dropped the
  // owner file and the test degenerates — STOP rather than report a
  // vacuous pass.
  const r = run(['--from', 'sentinel-a1b2c3-c', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  assert.ok(r.json.nodes.some(n => n.id === 'feedback-sentinel-a1b2c3-target'),
    'fixture is live: owner is in ruleById (reachable from source via the resolved edge)')
  // Precondition 2: decoy is live (in ruleById). The decoy has no edges
  // (the alias was dropped), so it is degree 0 and appears in --orphans.
  // If it is absent, the glob dropped the decoy file and the test
  // degenerates — STOP rather than report a vacuous pass.
  const rOrph = run(['--orphans', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(rOrph.code, 0, rOrph.stdout)
  assert.ok(rOrph.json.nodes.some(n => n.id === 'sentinel-a1b2c3-decoy'),
    'fixture is live: decoy is in ruleById (degree 0, in --orphans)')
  // Main assertion: the edge from the source goes to the name-id holder, NOT the decoy.
  const edgesFromC = (r.json.edges || []).filter(e => e.from === 'sentinel-a1b2c3-c')
  assert.equal(edgesFromC.length, 1, 'exactly one wiki-link edge from the source')
  assert.ok(edgesFromC.some(e => e.to === 'feedback-sentinel-a1b2c3-target'),
    'edge target is the name-id holder (owner), not the decoy')
  assert.ok(!edgesFromC.some(e => e.to === 'sentinel-a1b2c3-decoy'),
    'no edge from the source targets the decoy whose basename would have shadowed the name-id')
})

t('t_ambiguous_alias_dangles', () => {
  resetRuleDir()
  // Two files whose basenames slugify to the same string. Both files match
  // the rule glob (feedback_*.md) and have distinct name-ids. The alias
  // loop drops the alias (sets to null) when two basenames collide, so a
  // link to the ambiguous slug dangles.
  //   feedback_alpha.md    -> basename 'feedback_alpha'    -> slug 'feedback-alpha'
  //   feedback_alpha_.md   -> basename 'feedback_alpha_'   -> slug 'feedback-alpha' (trailing _ stripped)
  writeRule('feedback_alpha.md', 'name: sentinel-a1b2c3-amb-first')
  writeRule('feedback_alpha_.md', 'name: sentinel-a1b2c3-amb-second')
  writeRule('feedback_amb_linker.md', 'name: sentinel-a1b2c3-amb-linker',
    '[[feedback-alpha]]')
  const r = run(['--from', 'sentinel-a1b2c3-amb-linker', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const dangling = r.json.dangling || []
  const ambDangling = dangling.find(d =>
    d.source === 'sentinel-a1b2c3-amb-linker' && d.ref === 'feedback-alpha')
  assert.ok(ambDangling, 'ambiguous alias (two files with same slugified basename) dangles')
  assert.ok(!(r.json.edges || []).some(e => e.to === 'sentinel-a1b2c3-amb-first' && e.from === 'sentinel-a1b2c3-amb-linker'),
    'ambiguous alias does not resolve to first holder')
  assert.ok(!(r.json.edges || []).some(e => e.to === 'sentinel-a1b2c3-amb-second' && e.from === 'sentinel-a1b2c3-amb-linker'),
    'ambiguous alias does not resolve to second holder')
})

// ---------------------------------------------------------------------------
// Group 4: dangling (2)
// ---------------------------------------------------------------------------
t('t_dangling_distinct_from_orphans', () => {
  resetRuleDir()
  // Source has an outgoing wiki link that does not resolve. The source
  // gains no edge (the addEdge is skipped when target is null), so it is
  // still degree 0 and IS an orphan. It also appears in the dangling[]
  // list with kind='wiki-link'. The two facts coexist on the same node.
  const SRC = 'sentinel-a1b2c3-dangling-src'
  writeRule('feedback_dangling_src.md', `name: ${SRC}`,
    '[[sentinel-a1b2c3-nonexistent-1]] [[sentinel-a1b2c3-nonexistent-2]]')
  // Run both --from (sees edges and dangling) and --orphans (sees the
  // orphan list). The source must appear in BOTH: in dangling[] as the
  // source of two unresolved links, AND in --orphans (degree 0).
  const rFrom = run(['--from', SRC, '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(rFrom.code, 0, rFrom.stdout)
  const dangling = rFrom.json.dangling || []
  const refs = dangling.filter(d => d.source === SRC).map(d => d.ref).sort()
  assert.deepEqual(refs, ['sentinel-a1b2c3-nonexistent-1', 'sentinel-a1b2c3-nonexistent-2'],
    'two dangling entries with refs in dangling order')
  assert.equal(rFrom.json.count, 1, 'source has no resolved edges; BFS visits only the source')
  // And the source is in --orphans
  const rOrph = run(['--orphans', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(rOrph.code, 0, rOrph.stdout)
  assert.ok(rOrph.json.nodes.some(n => n.id === SRC),
    'source of dangling links is an orphan (degree 0) — orphan and dangling coexist')
})

t('t_dangling_kind_values', () => {
  resetRuleDir()
  const SRC = 'sentinel-a1b2c3-kind-src'
  writeRule('feedback_kind_src.md', `name: ${SRC}`,
    '[[sentinel-a1b2c3-ghost-kind-1]] [[sentinel-a1b2c3-ghost-kind-2]] [[sentinel-a1b2c3-ghost-kind-3]]')
  const r = run(['--from', SRC, '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const dangling = r.json.dangling || []
  assert.ok(dangling.length >= 3, 'three dangling entries from three ghost links')
  for (const d of dangling) {
    assert.equal(d.kind, 'wiki-link',
      `dangling entry kind must be 'wiki-link', got ${JSON.stringify(d.kind)} for source ${d.source}`)
  }
})

// ---------------------------------------------------------------------------
// Group 5: mode integration (4)
// ---------------------------------------------------------------------------
t('t_from_rule_slug_traverses', () => {
  resetRuleDir()
  writeRule('feedback_traversal_src.md', 'name: sentinel-a1b2c3-traversal-src',
    '[[sentinel-a1b2c3-traversal-tgt]]')
  writeRule('feedback_traversal_tgt.md', 'name: sentinel-a1b2c3-traversal-tgt')
  const r = run(['--from', 'sentinel-a1b2c3-traversal-src', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  assert.ok(r.json.nodes.some(n => n.id === 'sentinel-a1b2c3-traversal-src'),
    'source node is in traversal result')
  assert.ok(r.json.nodes.some(n => n.id === 'sentinel-a1b2c3-traversal-tgt'),
    'target node is in traversal result (multi-node, not single)')
  const edge = r.json.edges.find(e =>
    e.from === 'sentinel-a1b2c3-traversal-src' && e.to === 'sentinel-a1b2c3-traversal-tgt')
  assert.ok(edge, 'src→tgt edge is in traversal result')
  assert.ok(r.json.count >= 2, `count must be >= 2, got ${r.json.count}`)
})

t('t_linked_rule_not_orphan', () => {
  resetRuleDir()
  writeRule('feedback_linked_src.md', 'name: sentinel-a1b2c3-linked-src',
    '[[sentinel-a1b2c3-linked-tgt]]')
  writeRule('feedback_linked_tgt.md', 'name: sentinel-a1b2c3-linked-tgt')
  const r = run(['--orphans', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const orphanIds = r.json.nodes.map(n => n.id)
  assert.ok(!orphanIds.includes('sentinel-a1b2c3-linked-src'),
    'rule with a resolved wiki-link is NOT in --orphans (degree > 0)')
  assert.ok(!orphanIds.includes('sentinel-a1b2c3-linked-tgt'),
    'target rule with an incoming edge is NOT in --orphans (degree > 0)')
})

t('t_unlinked_rule_still_orphan', () => {
  resetRuleDir()
  writeRule('feedback_unlinked.md', 'name: sentinel-a1b2c3-unlinked')
  const r = run(['--orphans', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 0, r.stdout)
  const orphanIds = r.json.nodes.map(n => n.id)
  assert.ok(orphanIds.includes('sentinel-a1b2c3-unlinked'),
    'rule with no wiki-links IS in --orphans (degree 0)')
})

t('t_rule_node_can_be_hub', () => {
  resetRuleDir()
  writeRule('feedback_hub_src.md', 'name: sentinel-a1b2c3-hub-src',
    '[[sentinel-a1b2c3-hub-tgt-1]] [[sentinel-a1b2c3-hub-tgt-2]] [[sentinel-a1b2c3-hub-tgt-3]]')
  writeRule('feedback_hub_tgt_1.md', 'name: sentinel-a1b2c3-hub-tgt-1')
  writeRule('feedback_hub_tgt_2.md', 'name: sentinel-a1b2c3-hub-tgt-2')
  writeRule('feedback_hub_tgt_3.md', 'name: sentinel-a1b2c3-hub-tgt-3')
  const r = run(['--hubs', '--nodes', 'rule', '--edges', 'wiki-link', '--top', '20'])
  assert.equal(r.code, 0, r.stdout)
  const hub = r.json.nodes.find(n => n.id === 'sentinel-a1b2c3-hub-src')
  assert.ok(hub, 'rule with multiple wiki-link targets is in --hubs output')
  assert.equal(hub.type, 'rule', 'hub is a rule node, not an episode')
  assert.ok(hub.degree >= 3, `hub degree must be >= 3, got ${hub.degree}`)
})

// ---------------------------------------------------------------------------
// Group 6: regression + robustness (6)
// ---------------------------------------------------------------------------
t('t_default_output_byte_identical', () => {
  resetRuleDir()
  // No rules, no episodes; default orphans output is the baseline.
  const before = run(['--orphans'])
  assert.equal(before.code, 0, before.stdout)
  // Add several rules; default mode must NOT read the corpus, so output is
  // byte-identical.
  writeRule('feedback_a.md', 'name: sentinel-a1b2c3-a')
  writeRule('feedback_b.md', 'name: sentinel-a1b2c3-b')
  writeRule('feedback_c.md', 'name: sentinel-a1b2c3-c')
  const after = run(['--orphans'])
  assert.equal(after.code, 0, after.stdout)
  assert.deepEqual(after.json, before.json,
    'adding rule files must not change the default invocation output (byte-identical)')
})

t('t_default_mode_does_not_read_bodies', () => {
  resetRuleDir()
  // Corpus with a collision: two files with the same frontmatter name.
  // The rule slug is the SLUGIFIED form of the name, so 'same name' slugs
  // to 'same-name'. Default mode must NOT scan, so no exit 2. Opted-in
  // mode MUST scan and must exit 2 — this proves the collision is real.
  writeRule('feedback_x.md', 'name: same name')
  writeRule('feedback_y.md', 'name: same name')
  const dflt = run(['--orphans'])
  assert.equal(dflt.code, 0,
    'default mode (no --nodes) does not read rule bodies, so collision is invisible')
  const opted = run(['--orphans', '--nodes', 'rule'])
  assert.equal(opted.code, 2,
    'opt-in mode reads rule bodies, so the collision triggers exit 2')
  assert.equal(opted.json.status, 'error')
  assert.ok(opted.json.message.includes('same-name'),
    'collision error message names the slugified colliding slug')
})

t('t_edge_types_registered', () => {
  resetRuleDir()
  writeRule('feedback_edge_type_a.md', 'name: sentinel-a1b2c3-et-a')
  const wikiLink = run(['--edges', 'wiki-link', '--orphans', '--nodes', 'rule'])
  assert.equal(wikiLink.code, 0, 'wiki-link is a registered edge type')
  // composes-with is S2 but it IS in EDGE_TYPES per step 1.2; verify the
  // registration is already accepted even though S2 will add extraction.
  const composesWith = run(['--edges', 'composes-with', '--orphans', '--nodes', 'rule'])
  assert.equal(composesWith.code, 0, 'composes-with is a registered edge type')
  // And the bad-name case still exits 2 (regression).
  const bad = run(['--edges', 'not-a-type', '--orphans', '--nodes', 'rule'])
  assert.equal(bad.code, 2, 'unknown edge types still rejected with exit 2')
})

t('t_default_edges_unchanged', () => {
  resetRuleDir()
  // With no --edges flag, default mode (no --nodes) does not include
  // wiki-link, so the dangling key is NOT present.
  const r = run(['--orphans'])
  assert.equal(r.code, 0)
  assert.ok(!('dangling' in r.json),
    'default --edges (no wiki-link) does not produce a dangling key')
  // With no --edges flag and --nodes rule, still no dangling.
  const withNodes = run(['--orphans', '--nodes', 'rule'])
  assert.equal(withNodes.code, 0)
  assert.ok(!('dangling' in withNodes.json),
    'default --edges + --nodes rule does not produce a dangling key')
})

t('t_edges_all_emits_empty_dangling', () => {
  resetRuleDir()
  writeRule('feedback_all_a.md', 'name: sentinel-a1b2c3-all-a')
  const r = run(['--edges', 'all', '--orphans', '--nodes', 'rule'])
  assert.equal(r.code, 0, r.stdout)
  assert.ok('dangling' in r.json,
    '--edges all includes wiki-link and composes-with, so dangling key is present')
  assert.deepEqual(r.json.dangling, [],
    'no wiki-links in the corpus, so dangling is an empty array (not undefined)')
})

t('t_collision_still_exits_2_before_extraction', () => {
  resetRuleDir()
  // Two rules with identical slugs; the scanRuleNodes call must exit 2
  // BEFORE any body is read. The wiki-link loop never runs.
  writeRule('feedback_col1.md', 'name: same name')
  writeRule('feedback_col2.md', 'name: same name')
  // Add a third rule with a wiki link that, if extraction ran, would
  // produce a dangling entry. The collision guard must fire first.
  writeRule('feedback_col3.md', 'name: sentinel-a1b2c3-col3',
    '[[sentinel-a1b2c3-ghost-col3]]')
  const r = run(['--orphans', '--nodes', 'rule', '--edges', 'wiki-link'])
  assert.equal(r.code, 2, 'collision exits 2 even with --edges wiki-link')
  assert.equal(r.json.status, 'error')
  assert.ok(r.json.message.includes('same-name'),
    'collision error names the slugified colliding slug')
})

// ---------------------------------------------------------------------------
// Group 7: hostile input (2)
// ---------------------------------------------------------------------------
t('t_wikilink_pathological_input_bounded', () => {
  resetRuleDir()
  // 10,000 unclosed [[ at the start of the body. The regex is bounded by
  // [^\]|#]+, so it consumes greedily until the end of the file with no
  // nested-quantifier backtracking explosion. Must complete in well under
  // 5 seconds on a modern machine.
  const body = '[[' .repeat(10000)
  writeRule('feedback_pathological.md', 'name: sentinel-a1b2c3-pathological', body)
  const t0 = Date.now()
  const r = run(['--edges', 'wiki-link', '--orphans', '--nodes', 'rule'])
  const elapsed = Date.now() - t0
  assert.equal(r.code, 0, 'parser must complete without crashing on 10k unclosed [[')
  assert.ok(elapsed < 5000, `parser must complete in <5s; took ${elapsed}ms`)
  // And no edges / dangling entries (10k unclosed is malformed)
  assert.equal((r.json.edges || []).length, 0, 'no edges from malformed input')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entries from malformed input')
})

t('t_proto_key_wiki_target', () => {
  resetRuleDir()
  // Rules with name '__proto__' and 'constructor'. The slugified forms are
  // 'proto' and 'constructor'. Slug maps are `new Map()`, so prototype keys
  // cannot pollute Object.prototype. The edge map must remain a Map, not a
  // plain object.
  writeRule('feedback_proto.md', 'name: __proto__')
  writeRule('feedback_ctor.md', 'name: constructor')
  writeRule('feedback_proto_src.md', 'name: sentinel-a1b2c3-proto-src',
    '[[__proto__]] [[constructor]]')
  const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).length
  const r = run(['--from', 'sentinel-a1b2c3-proto-src', '--nodes', 'rule', '--edges', 'wiki-link'])
  const protoKeysAfter = Object.getOwnPropertyNames(Object.prototype).length
  assert.equal(r.code, 0, r.stdout)
  assert.equal(protoKeysAfter, protoKeysBefore,
    'Object.prototype own property count must not change after running em-graph with __proto__/constructor rules')
  // The src should have BOTH edges (both targets exist as rule nodes)
  const srcEdges = r.json.edges.filter(e => e.from === 'sentinel-a1b2c3-proto-src')
  const targets = srcEdges.map(e => e.to).sort()
  assert.deepEqual(targets, ['constructor', 'proto'],
    'both __proto__ and constructor targets resolve via slug map (no pollution)')
})

// ---------------------------------------------------------------------------
// Group 3: composes-with (8)
// ---------------------------------------------------------------------------
t('t_composes_toplevel_only', () => {
  resetRuleDir()
  writeRule('feedback_toplevel_src.md', 'name: sentinel-a1b2c3-toplevel-src',
    'body\n## Composes with\n- `sentinel-a1b2c3-toplevel-tgt`\n- some other text\n')
  writeRule('feedback_toplevel_tgt.md', 'name: sentinel-a1b2c3-toplevel-tgt')
  const r = run(['--from', 'sentinel-a1b2c3-toplevel-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  const edge = (r.json.edges || []).find(e =>
    e.from === 'sentinel-a1b2c3-toplevel-src' && e.to === 'sentinel-a1b2c3-toplevel-tgt' && e.type === 'composes-with')
  assert.ok(edge, 'top-level bullet target resolves via composes-with')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entries')
})

t('t_composes_nested_ignored', () => {
  resetRuleDir()
  // First bullet is nested (indented), second is top-level. The nested one
  // must be IGNORED (not parsed as a target), the top-level one must resolve.
  writeRule('feedback_nested_src.md', 'name: sentinel-a1b2c3-nested-src',
    'body\n## Composes with\n  - `sentinel-a1b2c3-nested-ignored`\n- `sentinel-a1b2c3-nested-tgt`\n')
  writeRule('feedback_nested_tgt.md', 'name: sentinel-a1b2c3-nested-tgt')
  // Note: no target rule for 'nested-ignored' — the assertion is that the
  // nested bullet was NEVER parsed, so no dangling entry exists for it.
  const r = run(['--from', 'sentinel-a1b2c3-nested-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  const edges = (r.json.edges || []).filter(e => e.from === 'sentinel-a1b2c3-nested-src' && e.type === 'composes-with')
  assert.equal(edges.length, 1, 'exactly one composes-with edge (nested bullet ignored, not parsed)')
  assert.ok(edges.some(e => e.to === 'sentinel-a1b2c3-nested-tgt'), 'top-level bullet is the edge target')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entries (nested bullet was ignored, not parsed)')
})

t('t_composes_markdown_link_basename', () => {
  resetRuleDir()
  // Markdown link form: the path in (...) resolves by basename. The target
  // rule's name-id is different from the basename-derived slug; resolution
  // must go through the alias index.
  writeRule('feedback_mdlink_target.md', 'name: sentinel-a1b2c3-mdlink-tgt')
  writeRule('feedback_mdlink_src.md', 'name: sentinel-a1b2c3-mdlink-src',
    'body\n## Composes with\n- [link text](feedback_mdlink_target.md)\n')
  const r = run(['--from', 'sentinel-a1b2c3-mdlink-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  const edge = (r.json.edges || []).find(e =>
    e.from === 'sentinel-a1b2c3-mdlink-src' && e.to === 'sentinel-a1b2c3-mdlink-tgt' && e.type === 'composes-with')
  assert.ok(edge, 'markdown link target resolves by basename (feedback_mdlink_target.md -> sentinel-a1b2c3-mdlink-tgt)')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entries')
})

t('t_composes_empty_section_no_dangling', () => {
  resetRuleDir()
  // Section heading present but no bullets before EOF: 0 edges AND 0 dangling.
  writeRule('feedback_empty_src.md', 'name: sentinel-a1b2c3-empty-src',
    'body\n## Composes with\n')
  const r = run(['--from', 'sentinel-a1b2c3-empty-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  assert.equal((r.json.edges || []).length, 0, 'empty composes-with section produces 0 edges (REQ-6 false-pass trap)')
  assert.equal((r.json.dangling || []).length, 0, 'empty composes-with section produces 0 dangling entries (REQ-6 false-pass trap)')
})

t('t_composes_terminated_by_next_heading', () => {
  resetRuleDir()
  // Section followed immediately by another ## heading: the section is
  // empty (EC6), so no edges and no dangling.
  writeRule('feedback_term_src.md', 'name: sentinel-a1b2c3-term-src',
    'body\n## Composes with\n## Other Section\n- `sentinel-a1b2c3-term-tgt`\n')
  writeRule('feedback_term_tgt.md', 'name: sentinel-a1b2c3-term-tgt')
  const r = run(['--from', 'sentinel-a1b2c3-term-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  assert.equal((r.json.edges || []).length, 0, 'section terminated by next heading: 0 edges (EC6)')
  assert.equal((r.json.dangling || []).length, 0, 'section terminated by next heading: 0 dangling entries')
})

t('t_composes_backticked_target_resolves', () => {
  resetRuleDir()
  // REQ-16: composes-with does NOT strip inline backticks. The real-world
  // form is "- `file.md` — text" and stripping inline code would delete
  // every target. The backticked token is the target; it resolves.
  writeRule('feedback_back_src.md', 'name: sentinel-a1b2c3-back-src',
    'body\n## Composes with\n- `sentinel-a1b2c3-back-tgt` — some text\n')
  writeRule('feedback_back_tgt.md', 'name: sentinel-a1b2c3-back-tgt')
  const r = run(['--from', 'sentinel-a1b2c3-back-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  const edge = (r.json.edges || []).find(e =>
    e.from === 'sentinel-a1b2c3-back-src' && e.to === 'sentinel-a1b2c3-back-tgt' && e.type === 'composes-with')
  assert.ok(edge, 'backticked target resolves (REQ-16: inline backticks NOT stripped for composes-with)')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entries')
})

t('t_composes_prose_bullet_skipped', () => {
  resetRuleDir()
  // A bullet that is neither a markdown link nor backtick-led: SKIP, no target.
  // Review r1 finding 5: earlier draft slugified the whole prose line and
  // manufactured a garbage dangling ref. The contract is: no target, no edge,
  // no dangling.
  writeRule('feedback_prose_src.md', 'name: sentinel-a1b2c3-prose-src',
    'body\n## Composes with\n- This is just prose, no link or backticks\n')
  const r = run(['--from', 'sentinel-a1b2c3-prose-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  assert.equal((r.json.edges || []).length, 0, 'prose bullet produces 0 edges (not slugified as a target)')
  assert.equal((r.json.dangling || []).length, 0, 'prose bullet produces 0 dangling entries (review r1 finding 5)')
})

t('t_composes_first_backtick_run_wins', () => {
  resetRuleDir()
  // A bullet with TWO backticked spans: only the FIRST is used as the target.
  // Review r1 finding 6: earlier draft silently kept only the first; that
  // behavior is kept and made explicit. The second backticked span is
  // IGNORED, not parsed as a second target.
  writeRule('feedback_first_src.md', 'name: sentinel-a1b2c3-first-src',
    'body\n## Composes with\n- `sentinel-a1b2c3-first-tgt` and `sentinel-a1b2c3-second-ignored`\n')
  writeRule('feedback_first_tgt.md', 'name: sentinel-a1b2c3-first-tgt')
  // NOTE: no target rule for 'second-ignored'. If the second backtick run
  // were parsed, it would dangle (no target). The assertion is that the
  // second run was NEVER parsed, so no dangling entry exists.
  const r = run(['--from', 'sentinel-a1b2c3-first-src', '--nodes', 'rule', '--edges', 'composes-with'])
  assert.equal(r.code, 0, r.stdout)
  const edges = (r.json.edges || []).filter(e => e.from === 'sentinel-a1b2c3-first-src' && e.type === 'composes-with')
  assert.equal(edges.length, 1, 'exactly one composes-with edge (first backtick run wins; review r1 finding 6)')
  assert.ok(edges.some(e => e.to === 'sentinel-a1b2c3-first-tgt'), 'first backtick run is the edge target')
  assert.equal((r.json.dangling || []).length, 0, 'no dangling entries (second backtick run ignored, not parsed)')
})

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------
fs.rmSync(cwd, { recursive: true, force: true })
fs.rmSync(home, { recursive: true, force: true })
if (breakTemp) fs.rmSync(breakTemp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
