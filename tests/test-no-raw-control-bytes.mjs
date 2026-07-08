/**
 * test-no-raw-control-bytes.mjs — repo-wide guard: tracked source files must
 * not contain raw C0 control bytes (NUL etc.; tab/newline/CR allowed).
 *
 * Regression anchor (2026-07-08, wave-6 hardening): em-graph.mjs and
 * em-consolidate.mjs shipped in 28c8873 with literal NUL bytes embedded as
 * edge-key / cluster-key separators. Runtime behavior was correct, but the
 * files became "binary" to file(1), BSD grep, and diff-oriented review
 * tooling: grep-based CI guards silently skipped them, and structured-edit
 * tools could not match their contents. The separator design is fine — NUL
 * is a legitimate collision-proof joiner — but it must be spelled in source
 * as an escape (String.fromCharCode(0) or a backslash-u0000 escape), never
 * as a raw byte.
 *
 * Scope: every git-tracked file with a text-source extension. Fixture
 * directories are excluded — a fixture may legitimately embed control bytes
 * to exercise exactly this class.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const NUL = String.fromCharCode(0);
const TEXT_EXTS = new Set(['.mjs', '.js', '.cjs', '.sh', '.md', '.mdc', '.json', '.yml', '.yaml', '.txt']);
const EXCLUDE_SEGMENTS = ['tests/fixtures/'];

const ls = spawnSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (ls.status !== 0) {
  console.error(`FAIL  git ls-files exited ${ls.status}: ${ls.stderr}`);
  process.exit(1);
}
const files = ls.stdout.split(NUL).filter(Boolean)
  .filter(f => TEXT_EXTS.has(path.extname(f)))
  .filter(f => !EXCLUDE_SEGMENTS.some(seg => f.startsWith(seg) || f.includes(`/${seg}`)));

const offenders = [];
let scanned = 0;
for (const rel of files) {
  const abs = path.join(REPO, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; } // deleted-but-tracked: skip
  scanned++;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      const line = buf.subarray(0, i).filter(x => x === 0x0a).length + 1;
      offenders.push({ file: rel, byte: `0x${b.toString(16).padStart(2, '0')}`, line });
      break; // one report per file is enough to fail
    }
  }
}

if (offenders.length) {
  for (const o of offenders) {
    console.error(`FAIL  raw control byte ${o.byte} in ${o.file}:${o.line} — spell it as an escape (e.g. String.fromCharCode(0)); raw control bytes make the file binary to grep/diff/review tooling`);
  }
  console.log(`\n0 passed, ${offenders.length} failed (${scanned} files scanned)`);
  process.exit(1);
}
console.log(`  ok  no raw control bytes in ${scanned} tracked source files`);
console.log('\n1 passed, 0 failed');
process.exit(0);
