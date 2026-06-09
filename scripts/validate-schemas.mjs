#!/usr/bin/env node
/**
 * validate-schemas.mjs — shipped CI validator: every schema DOC in the repo is
 * a valid JSON-Schema 2020-12 document (RFC-008 M1/M2, L493-498 — the F5
 * mirror at the doc layer), shipped in P2a.
 *
 * One engine (D2): the keyword-grammar linter scripts/lib/mini-jsonschema.mjs
 * — the SAME module behind the P0 test gate (tests/test-p0-schemas.mjs), so
 * the two consumers cannot drift. The shared negative corpus
 * tests/fixtures/schema-negative-corpus.json (#368) is re-asserted here: every
 * entry MUST be rejected by the engine, so any future refactor that forks the
 * engines fails CI loudly instead of silently diverging.
 *
 * Discovery, not a hand-maintained list: a no-follow Dirent walk of patterns/,
 * plugins/, schemas/ picks up any file named `*.schema.json` OR bare
 * `schema.json` (the repo's own patterns/schema.json spelling). Fail-closed
 * properties:
 *   - MIN_SCHEMA_DOCS non-vacuity: discovery collapsing to a near-empty set is
 *     a violation, not a pass.
 *   - Out-of-root sweep: a schema-doc-named file OUTSIDE the scan roots
 *     (excluding tests/fixtures/, node_modules/, dot-dirs) is a named
 *     violation — a doc someone drops in scripts/ cannot silently go unlinted.
 *   - Symlinked schema docs are violations ("must be a regular file"), never
 *     followed, never silently skipped.
 *
 * I/O surface is CLOSED: --project / --json / --help only. No injectable
 * corpus or schema-dir paths (one fixed shared corpus is the #368 contract).
 * All reads resolve from the canonical project root, never cwd/script-relative.
 *
 * Usage:
 *   node scripts/validate-schemas.mjs --project <abs>
 *   node scripts/validate-schemas.mjs --project <abs> --json
 *
 * With NO --project, the root is discovered via `git rev-parse --show-toplevel`
 * from cwd; a non-git cwd fails CLEAR (exit 2), no silent caller-cwd fallback.
 *
 * Output (stdout): human one-liner, or full JSON with --json.
 * Exit: 0 = pass, 1 = violations (ONLY via the violation tally), 2 = usage/IO
 * error or internal crash (a crash must never read as "violations found").
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { lintSchema, assertSelfConsistent } from "./lib/mini-jsonschema.mjs";
import { UsageError } from "./lib/path-contain.mjs";

const SCAN_ROOTS = ["patterns", "plugins", "schemas"];
const CORPUS_REL = "tests/fixtures/schema-negative-corpus.json";
const MIN_SCHEMA_DOCS = 17; // the P0 contract floor (17 schema docs shipped in P0)
const MIN_CORPUS_ENTRIES = 14; // #368 non-vacuity floor (the 14 P0 negatives)

function isSchemaDocName(name) {
  // Bare `schema.json` is the repo's own precedent (patterns/schema.json) and
  // fails the endsWith test at 11 < 12 chars — both spellings are schema docs.
  return name.endsWith(".schema.json") || name === "schema.json";
}

/**
 * No-follow walk (lstat semantics via Dirent): never traverses symlinked
 * directories, never resolves symlinked files; skips dot-prefixed DIRECTORIES
 * (harness-staged local state — .review-store/, .episodic-memory/ — is absent
 * from CI checkouts; sweeping it would diverge local vs CI) and node_modules.
 *
 * Doc-NAMED entries are judged by KIND before any skip rule (step-6 review
 * F1/F2 class fix — one guard, both branch leniencies):
 *   - regular file  -> discovery hit, even dot-prefixed (a hidden
 *     .bad.schema.json must not lurk unlinted);
 *   - anything else (symlink, directory, fifo) -> violation, never a silent
 *     skip and never recursed into.
 */
function walkNoFollow(dir, hits, nonRegularHits) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return; // absent scan root: MIN_SCHEMA_DOCS catches vacuity
    throw e;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (isSchemaDocName(ent.name)) {
      if (ent.isFile()) hits.push(p);
      else nonRegularHits.push(p);
      continue;
    }
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    if (ent.isDirectory()) walkNoFollow(p, hits, nonRegularHits);
  }
}

/** Resolve the project root. --project explicit -> realpath (git never consulted). */
function resolveProjectRoot(argProject, cwd) {
  if (argProject != null) {
    let real;
    try { real = fs.realpathSync(argProject); }
    catch (e) { throw new UsageError(`--project ${argProject} does not resolve: ${e.message}`); }
    if (!fs.statSync(real).isDirectory()) throw new UsageError(`--project ${argProject} is not a directory`);
    return real;
  }
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new UsageError("no --project and cwd is not inside a git repository (no silent caller-cwd fallback)");
  }
  return fs.realpathSync(top);
}

export function validateSchemas({ projectRoot }) {
  const root = resolveProjectRoot(projectRoot, process.cwd());
  const violations = [];
  let checks = 0;
  const violation = (check, detail) => violations.push({ check, severity: "error", detail });

  // Engine self-assertion, re-run fail-closed (also runs at module load).
  checks++;
  assertSelfConsistent();

  // --- discovery over the scan roots (no-follow, dedupe) ---
  const hits = [];
  const nonRegularHits = [];
  for (const rel of SCAN_ROOTS) walkNoFollow(path.join(root, rel), hits, nonRegularHits);
  for (const p of nonRegularHits) {
    checks++;
    violation("doc-regular-file", `${path.relative(root, p)} is doc-named but not a regular file (symlink/directory/other) — schema docs must be regular files (no-follow discovery would otherwise skip it silently)`);
  }
  const seenReal = new Set();
  const docs = [];
  for (const p of hits) {
    const real = fs.realpathSync(p);
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    docs.push(p);
  }
  docs.sort();

  // --- non-vacuity: discovery collapsing is a failure, not a pass ---
  checks++;
  if (docs.length < MIN_SCHEMA_DOCS) {
    violation("min-docs", `discovered ${docs.length} schema doc(s), expected >= ${MIN_SCHEMA_DOCS} — discovery vacuity is fail-closed`);
  }

  // --- every doc parses and lints clean as a 2020-12 document ---
  for (const p of docs) {
    checks++;
    const rel = path.relative(root, p);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      violation("doc-parse", `${rel}: not parseable JSON — ${e.message}`);
      continue;
    }
    const { valid, errors } = lintSchema(doc);
    if (!valid) violation("doc-lint", `${rel}: ${errors.slice(0, 4).join(" | ")}`);
  }

  // --- out-of-root sweep: same no-follow walker over the whole repo ---
  checks++;
  const sweepHits = [];
  const sweepNonRegular = [];
  walkNoFollow(root, sweepHits, sweepNonRegular);
  const scanRootAbs = SCAN_ROOTS.map((r) => path.join(root, r));
  const fixturesAbs = path.join(root, "tests", "fixtures");
  const insideAllowed = (p) =>
    scanRootAbs.some((r) => p === r || p.startsWith(r + path.sep)) ||
    p.startsWith(fixturesAbs + path.sep);
  for (const p of [...sweepHits, ...sweepNonRegular]) {
    if (!insideAllowed(p)) {
      violation("out-of-root-doc", `${path.relative(root, p)} is schema-doc-named but OUTSIDE the scan roots (${SCAN_ROOTS.join(", ")}) — it would never be linted; move it into a scan root`);
    }
  }

  // --- shared negative corpus (#368): engine must reject every entry ---
  const corpusAbs = path.join(root, CORPUS_REL);
  let corpusRaw;
  try {
    corpusRaw = fs.readFileSync(corpusAbs, "utf8");
  } catch (e) {
    // Missing corpus is an IO failure of the validation INPUTS (exit 2),
    // not a "checked and found violations" result — absence != vacuous pass.
    throw new UsageError(`shared negative corpus unreadable at ${CORPUS_REL}: ${e.message}`);
  }
  let corpus = null;
  try {
    corpus = JSON.parse(corpusRaw);
  } catch (e) {
    violation("corpus-shape", `${CORPUS_REL}: not parseable JSON — ${e.message}`);
  }
  const entries = Array.isArray(corpus) ? corpus : [];
  checks++;
  if (corpus !== null && !Array.isArray(corpus)) {
    violation("corpus-shape", `${CORPUS_REL}: must be an array of { name, schema } entries`);
  }
  checks++;
  if (entries.length < MIN_CORPUS_ENTRIES) {
    violation("corpus-non-vacuity", `${CORPUS_REL}: ${entries.length} entr(ies), expected >= ${MIN_CORPUS_ENTRIES} (#368 floor)`);
  }
  checks++;
  if (!entries.every((e) => e !== null && typeof e === "object" && typeof e.name === "string" && "schema" in e)) {
    violation("corpus-shape", `${CORPUS_REL}: every entry must carry string \`name\` + \`schema\` key`);
  }
  checks++;
  if (new Set(entries.map((e) => e && e.name)).size !== entries.length) {
    violation("corpus-shape", `${CORPUS_REL}: entry names must be unique — a duplicate keeps the >= ${MIN_CORPUS_ENTRIES} floor green while class coverage silently shrinks`);
  }
  for (const entry of entries) {
    // Shape violation already recorded above; string-name guard keeps the
    // divergence detail from printing `undefined` for a malformed entry.
    if (entry === null || typeof entry !== "object" || typeof entry.name !== "string" || !("schema" in entry)) continue;
    checks++;
    const { valid } = lintSchema(entry.schema);
    if (valid) {
      violation("corpus-divergence", `corpus entry ${JSON.stringify(entry.name)} is ACCEPTED by the engine — entries must be engine-rejected. If the entry looks "obviously wrong" but is accepted, it may be vacuously valid: {} and true are valid 2020-12 schemas. Fix the entry, do not weaken this check.`);
    }
  }

  return {
    status: violations.length === 0 ? "ok" : "violations",
    project_root: root,
    docs_checked: docs.length,
    docs: docs.map((p) => path.relative(root, p)),
    corpus_entries: entries.length,
    checks,
    violations,
    exit: violations.length === 0 ? 0 : 1,
  };
}

const HELP = `validate-schemas.mjs — every repo schema doc is a valid JSON-Schema 2020-12 document (RFC-008 M1/M2)

Usage:
  node scripts/validate-schemas.mjs --project <abs-repo-root> [--json]

Options:
  --project <path>  explicit project root (realpath'd; git never consulted)
  --json            full JSON payload on stdout
  --help            this message

Exit: 0 pass, 1 violations, 2 usage/IO error or internal crash.`;

function parseArgs(argv) {
  const args = { project: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") { args.project = argv[++i]; if (args.project == null) throw new UsageError("--project requires a value"); }
    else if (a === "--json") args.json = true;
    else if (a === "--help") args.help = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  return args;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(e.message + "\n"); process.exit(2); }
  if (args.help) { process.stdout.write(HELP + "\n"); process.exit(0); }

  let result;
  try {
    result = validateSchemas({ projectRoot: args.project });
  } catch (e) {
    if (e instanceof UsageError || e.name === "UsageError") {
      process.stderr.write(e.message + "\n");
      process.exit(2);
    }
    // Internal crash — fail closed as usage/IO (exit 2), NEVER exit 1: a crash
    // must not masquerade as "checked everything and found violations".
    process.stdout.write(JSON.stringify({ status: "error", project_root: null, checks: 0, violations: [{ check: "internal", severity: "error", detail: e.message }] }) + "\n");
    process.exit(2);
  }

  const { exit, ...payload } = result;
  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (payload.status === "ok") {
    process.stdout.write(`OK  validate-schemas: ${payload.docs_checked} doc(s) lint clean, ${payload.corpus_entries} corpus negative(s) rejected, ${payload.checks} check(s) for ${payload.project_root}\n`);
  } else {
    process.stderr.write(`FAIL  validate-schemas (${payload.status}): ${payload.violations.length} violation(s)\n`);
    for (const v of payload.violations) process.stderr.write(`  ✗ [${v.check}] ${v.detail}\n`);
  }
  process.exit(exit);
}

// Run as CLI only when invoked directly (not when imported by tests).
// pathToFileURL, not `file://${argv[1]}`: a path needing URL-encoding (space,
// non-ASCII) makes the raw template compare false -> main() never runs ->
// exit 0 with empty output, a vacuous green for the CI gate (step-6 F4).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
