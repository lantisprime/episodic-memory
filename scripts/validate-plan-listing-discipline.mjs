#!/usr/bin/env node
// validate-plan-listing-discipline.mjs — issue #627 plan-authoring lint.
//
// CLASS A (DEFECT, exit 1): a §A.7 step's grep-count Verify states a RELATIVE
// expectation (decrease/increase/delta with no absolute observed → expected
// numbers) while a Listing the step references contains the counted pattern —
// the paste re-introduces the string, so the delta can never land as written.
// R2 (WARN, exit 0): a grep-count Verify is relative with no absolute numbers
// at all (unfalsifiable without a recorded baseline).
//
// Suppression: a line `<!-- plan-lint: accepted-defect step <n.m> ... -->`
// moves that step's Class A defect to `accepted` (post-execution errata for
// historical plans). `--strict` ignores suppressions (regression testing).
//
// Known limits (v1, by design): only quoted grep patterns are parsed; step
// rows and Listing headings inside fenced code blocks are ignored; plans with
// no step tables pass vacuously.
//
// Usage: node scripts/validate-plan-listing-discipline.mjs [--strict] <plan.md> [more...]
// JSON to stdout; exit 0 ok / 1 defect / 2 usage.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const GREP_COUNT_RE = /grep\s+-[a-zA-Z]*c[a-zA-Z]*\s+(['"])(.+?)\1\s+([^\s|;&`]+)/g;
const RELATIVE_RE = /\b(?:decrea\w*|increa\w*|drops?\s+by|goes\s+(?:up|down)|delta\b|from\s+the\s+baseline)/i;
const ABSOLUTE_RE = /(?:→|->)\s*\**`?\d+|\b\d+\s+before\b[^|]*?\b\d+\s+after\b/;
const LISTING_REF_RE = /\bListing\s+(L\d+[a-z]?)\b/g;
const LISTING_HEAD_RE = /^#{2,4}\s.*\bListing\s+(L\d+[a-z]?)\b/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const SUPPRESS_RE = /<!--\s*plan-lint:\s*accepted-defect\s+step\s+([\w.]+)/g;

function extractListings(lines) {
  const listings = new Map();
  let current = null;
  let inFence = false;
  let buf = [];
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inFence) {
      const head = line.match(LISTING_HEAD_RE);
      if (head) {
        if (current) listings.set(current, { line: startLine, code: buf.join('\n') });
        current = head[1];
        buf = [];
        startLine = i + 1;
        continue;
      }
      if (current && /^#{1,4}\s/.test(line)) {
        listings.set(current, { line: startLine, code: buf.join('\n') });
        current = null;
        continue;
      }
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (current && inFence) buf.push(line);
  }
  if (current) listings.set(current, { line: startLine, code: buf.join('\n') });
  return listings;
}

function extractStepRows(lines) {
  const rows = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.startsWith('|')) continue;
    const cells = line.replaceAll('\\|', '\u0000').split('|').slice(1, -1)
      .map((c) => c.replaceAll('\u0000', '\\|').trim());
    if (cells.length < 4) continue;
    const step = cells[0].replace(/\*/g, '');
    if (!/^\d+(?:\.\d+)?[a-z]?$/.test(step)) continue;
    rows.push({
      line: i + 1,
      step,
      file: cells[1].replace(/[`*]/g, ''),
      action: cells.slice(2, -1).join(' '),
      verify: cells[cells.length - 1],
    });
  }
  return rows;
}

function extractSuppressed(lines) {
  const set = new Set();
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(SUPPRESS_RE)) set.add(m[1]);
  }
  return set;
}

function lintFile(path, strict) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const listings = extractListings(lines);
  const rows = extractStepRows(lines);
  const suppressed = strict ? new Set() : extractSuppressed(lines);
  const defects = [];
  const accepted = [];
  const warns = [];
  let checked = 0;
  for (const row of rows) {
    for (const m of row.verify.matchAll(GREP_COUNT_RE)) {
      checked++;
      const pattern = m[2];
      const target = m[3].replace(/[`*]/g, '');
      const relative = RELATIVE_RE.test(row.verify) && !ABSOLUTE_RE.test(row.verify);
      if (!relative) continue;
      let hit = null;
      for (const ref of row.action.matchAll(LISTING_REF_RE)) {
        const l = listings.get(ref[1]);
        if (l && l.code.includes(pattern) && row.file === target) {
          hit = { listing: ref[1], listing_line: l.line };
          break;
        }
      }
      if (hit) {
        const finding = {
          class: 'A',
          step: row.step,
          row_line: row.line,
          file: row.file,
          pattern,
          ...hit,
          reason: 'relative-count verify counts a pattern its own Listing re-introduces (issue #627)',
        };
        if (suppressed.has(row.step)) accepted.push(finding);
        else defects.push(finding);
      } else {
        warns.push({
          class: 'R2',
          step: row.step,
          row_line: row.line,
          pattern,
          reason: 'relative-count verify with no absolute observed/expected values',
        });
      }
    }
  }
  return { file: path, steps: rows.length, grep_count_verifies: checked, defects, accepted, warns };
}

const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const files = argv.filter((a) => a !== '--strict');
if (files.length === 0) {
  console.log(JSON.stringify({ status: 'error', error: 'usage: validate-plan-listing-discipline.mjs [--strict] <plan.md> [...]' }));
  process.exit(2);
}
const results = files.map((f) => lintFile(f, strict));
const status = results.some((r) => r.defects.length > 0) ? 'defect' : 'ok';
console.log(JSON.stringify({ status, strict, files: results }, null, 2));
process.exit(status === 'defect' ? 1 : 0);
