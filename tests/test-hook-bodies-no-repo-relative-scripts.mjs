#!/usr/bin/env node
// tests/test-hook-bodies-no-repo-relative-scripts.mjs
//
// CI class-check for issue #441 (and its siblings). A PreToolUse/UserPromptSubmit
// gate hook installs PER-PROJECT into arbitrary repos. If it resolves a runtime
// .mjs dependency SOLELY from `$REPO_ROOT/scripts/...`, that path exists only
// inside the episodic-memory repo, so the hook breaks (or, for a fail-closed gate,
// hard-denies every edit) in every foreign project. #441 was exactly this in
// preflight-gate.sh.
//
// The correct pattern (already used by preflight-prompt-helper.sh) resolves the
// dep CO-LOCATED first — `$HOOK_DIR/...` or `$LIB_DIR/...`, which the installer
// deploys into <project>/.claude/hooks{,/lib}/ — and only THEN falls back to
// `$REPO_ROOT/scripts/...` for in-repo development.
//
// This check is deliberately PRECISE, not a blunt grep (codex review 2026-07-04):
// a bare `$REPO_ROOT/scripts/` grep would false-positive on the LEGITIMATE
// co-located-first fallback. Rule: for every non-comment reference to
// `$REPO_ROOT/scripts/.../<basename>.mjs`, the SAME file must contain an EARLIER
// non-comment reference to the same <basename> via `$HOOK_DIR` or `$LIB_DIR`.
// A fail-closed sole dependency (no prior co-located candidate) is the bug.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOKS_DIR = path.join(REPO_ROOT, 'plugins', 'claude-code', 'hooks')

const isComment = (line) => /^\s*#/.test(line)
// $REPO_ROOT/scripts/[optional/dirs/]<basename>.mjs
const REPO_SCRIPTS_RE = /\$REPO_ROOT\/scripts\/(?:[^\s"'\\]*\/)?([A-Za-z0-9._-]+\.mjs)/g
// A co-located reference to a basename via $HOOK_DIR or $LIB_DIR.
const coLocatedRe = (basename) =>
  new RegExp('\\$(?:HOOK_DIR|LIB_DIR)\\/(?:[^\\s"\'\\\\]*\\/)?' +
    basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

const violations = []
let refsChecked = 0

const shFiles = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.sh')).sort()
for (const file of shFiles) {
  const abs = path.join(HOOKS_DIR, file)
  const lines = fs.readFileSync(abs, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isComment(line)) continue
    let m
    REPO_SCRIPTS_RE.lastIndex = 0
    while ((m = REPO_SCRIPTS_RE.exec(line)) !== null) {
      const basename = m[1]
      refsChecked++
      const re = coLocatedRe(basename)
      // Require an EARLIER non-comment co-located reference to the same basename.
      let coLocatedFirst = false
      for (let j = 0; j < i; j++) {
        if (!isComment(lines[j]) && re.test(lines[j])) { coLocatedFirst = true; break }
      }
      if (!coLocatedFirst) {
        violations.push({
          file: `plugins/claude-code/hooks/${file}`,
          line: i + 1,
          basename,
          text: line.trim(),
        })
      }
    }
  }
}

if (violations.length > 0) {
  console.error('FAIL: hook(s) resolve a runtime .mjs dep from $REPO_ROOT/scripts/ with')
  console.error('no prior co-located ($HOOK_DIR/$LIB_DIR) candidate — breaks in foreign')
  console.error('projects (issue #441 class). Resolve co-located FIRST, then fall back.\n')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (${v.basename})`)
    console.error(`    ${v.text}`)
  }
  process.exit(1)
}

console.log(`OK: ${shFiles.length} hook file(s), ${refsChecked} $REPO_ROOT/scripts ref(s) checked — all co-located-first.`)
process.exit(0)
