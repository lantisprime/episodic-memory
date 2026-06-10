#!/usr/bin/env node
/**
 * validate-bp-contract.mjs — the RFC-008 normative §Validation-contract
 * assertion checklist (P2b; R2/R3/R4). Implements assertions 0 + 1–8 and
 * 10–15 (RFC-008 L446–453 + L478–487). Assertion 9 (golden corpus) is owned
 * by tests/test-validate-bp-contract.mjs, which dispatches the fixtures
 * through this validator's injection flags.
 *
 * Checklist map (sub-codes in parentheses are this validator's check ids):
 *   0   bp instance validation (0-set / 0-schema / 0-idbind): the discovered
 *       patterns/bp-*.json set EQUALS the patterns/_index.json-derived id set
 *       (N-2 bidirectional — phantom AND missing contracts are violations,
 *       near-miss filenames like bp-07.json are named violations, F5);
 *       every contract instance-validates against patterns/schema.json
 *       (attack-target-4: fourth-gate-key / stop-in-gates / extra-root-key);
 *       interior `id` equals the filename stem (A1 — schema.json:10-13
 *       delegates the id requirement here).
 *   1   taxonomy.json instance-validates vs patterns/taxonomy.schema.json.
 *   2-4 per-label gates: completeness / no extra keys / values in {allow,block}.
 *   5   non_overridable equals the derived non-overridable set (both ways).
 *   6   label ids unique.
 *   7   vocabulary closure, de-vacuified (N-3 — contracts carry hashes, not
 *       label ids; the bp arm is the assertion-15 hash binding): (7a) every
 *       enforcement manifest's classifier.emits_labels is a subset of
 *       taxonomy labels (intentional double-cover with registry M5);
 *       (7b) the default classifier's _priority() case arms EQUAL the
 *       taxonomy label set (L473 OQ-2 — equality, not subset: a missing arm
 *       ranks priority 0, below read_only, a silent downgrade), with the
 *       exactly-one-definition guard (A3) and the fail-closed arm-line
 *       grammar (review F3: unrecognized arm spellings are violations, never
 *       silently skipped).
 *   8   taxonomy stable-ID via git (F7/F-4): set-difference vs the merge-base
 *       of HEAD and origin/main; removal/rename without a major version bump
 *       is a violation. Fail CLOSED: shallow repo (A2) or unresolvable
 *       merge-base is exit 2, never a skip. Bootstrap carve-out (N-5): path
 *       absent from the merge-base tree with the file present now passes.
 *   10  events.json instance-validates vs patterns/events.schema.json.
 *   11  events vocabulary closure, de-vacuified (N-3 symmetric): every
 *       manifest's capabilities keys + event_translations keys are subsets of
 *       events[].id (double-cover with registry M4/M5c).
 *   12  action-enum closure: every event x tier action id in the closed
 *       10-value enum; all three tier arms present.
 *   13  payload_schema resolution: resolves on disk under schemas/events/
 *       (path-contain; ENOENT = violation) + lints as a 2020-12 doc (same
 *       engine as validate-schemas.mjs, D2).
 *   14  events stable-ID (mirror of 8, same helper).
 *   15  version bindings: every bp contract AND every enforcement manifest
 *       carries taxonomy_version/events_version equal to the live computed
 *       hashes (F8/F37; single helper scripts/lib/version-hash.mjs).
 *
 * Evaluation discipline (review F4): assertions NEVER short-circuit — all of
 * them run on every invocation (assertions_run reports which), and semantic
 * assertions tolerate schema-invalid shapes by recording violations, never
 * throwing. Exit 1 is reachable ONLY via the violation tally; UsageError and
 * internal crashes are exit 2 (a crash must never read as "violations found").
 *
 * One-effective-source rule (planner A5): after flag resolution there is
 * exactly ONE effective taxonomy, ONE effective events, ONE effective bp dir;
 * every assertion INCLUDING the assertion-15 hash computations reads those
 * same documents. Injection (--taxonomy / --events / --bp-dir) exists only
 * for golden-corpus dispatch; the live CI invocation is uninjected.
 *
 * Usage:
 *   node scripts/validate-bp-contract.mjs --project <abs> [--json]
 *   node scripts/validate-bp-contract.mjs --project <abs> --taxonomy <path> --events <path> --bp-dir <path>
 *
 * Exit: 0 = pass, 1 = violations, 2 = usage/IO error or internal crash.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { validateInstance, assertAllSchemasModeled } from "./lib/json-instance-validate.mjs";
import { lintSchema, assertSelfConsistent } from "./lib/mini-jsonschema.mjs";
import { taxonomyVersion, eventsVersion } from "./lib/version-hash.mjs";
import { contained, resolveContained, UsageError } from "./lib/path-contain.mjs";
import { deriveBpIds } from "./scaffold-bp.mjs";

const BP_STRICT_RE = /^bp-[0-9]{3}\.json$/;
// Case-INSENSITIVE on purpose (step-6 F-3): on case-insensitive filesystems
// (macOS APFS, Windows) a `BP-099.JSON` is the same dead-data escape the F5
// guard names; the STRICT regex stays case-sensitive so any case variant is a
// named violation, never silently ignored.
const BP_LOOSE_RE = /^bp-.*\.json$/i;
const GATE_KEYS = ["plan_approval", "pre_checkpoint", "post_checkpoint"];
const GATE_ACTIONS = ["allow", "block"];
const ACTION_ENUM = ["block", "warn", "inject", "modify", "observe", "refuse_stop", "inject_context", "inject_static", "write_artifact", "unsupported"];
const TIER_ARMS = ["STRONG", "MEDIUM", "WEAK"];
// Step-6 F-1/F-1R2/F-1R3 — the enforcement boundary is a per-OCCURRENCE
// allowlist of _priority token contexts, not a blocklist of definition
// spellings and not a per-line short-circuit. Bash accepts `name()` followed
// by ANY compound command anywhere a command may appear (brace-next-line,
// `case` body, after `;`/`&&` — including on a line that ALSO holds a
// legitimate call site, the F-1R3 P1/P8 false-pass), so: every word-bounded
// _priority occurrence is classified individually — a paren-form opener
// `_priority()` or keyword-form `function _priority` ANYWHERE counts toward
// the exactly-one definition tally; a `$(`-preceded occurrence is a call
// site; a full-line comment is inert; anything else is a "cannot prove
// exactly-one definition" violation. Fail-closed by construction; the one
// accepted fail-open tail is an eval-built definition whose source never
// spells the token (`eval "_priori""ty() …"`) — closing that needs a bash
// parser, documented residual.
const PRIORITY_DEF_RE = /^\s*(?:function\s+_priority\s*(?:\(\s*\))?|_priority\s*\(\s*\))\s*\{/;
const PRIORITY_TOKEN_RE = /\b_priority\b/;
const ARM_PLAIN_RE = /^\s*([a-z_][a-z0-9_]*)\)/;
const ARM_STAR_RE = /^\s*\*\)/;
const ARM_INTRODUCING_RE = /^\s*\S+\)/;

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

/** Validation INPUTS (schemas, SoT index, registry) are UsageError on failure (exit 2). */
function readJsonInput(abs, label) {
  let raw;
  try { raw = fs.readFileSync(abs, "utf8"); }
  catch (e) { throw new UsageError(`${label} unreadable at ${abs}: ${e.message}`); }
  try { return JSON.parse(raw); }
  catch (e) { throw new UsageError(`${label} is not parseable JSON (${abs}): ${e.message}`); }
}

function git(root, argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function majorOf(version) {
  const m = typeof version === "string" ? /^(\d+)\./.exec(version) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Stable-ID assertion core (8/14). Fail-closed environment handling lives
 * here: shallow repo (A2) or unresolvable merge-base throws UsageError
 * (exit 2 — "cannot verify" is an infra failure, never a data violation and
 * never a silent skip). Bootstrap (N-5): path absent in the merge-base tree
 * while present now passes (introduction; no removal possible).
 */
function stableIdCheck({ root, relPath, currentDoc, idsOf, label, violation }) {
  let shallow;
  try { shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim(); }
  catch (e) { throw new UsageError(`stable-ID (${label}): git unavailable in ${root}: ${e.message}`); }
  if (shallow === "true") {
    throw new UsageError(`stable-ID (${label}): repository is shallow — a grafted history can false-pass the merge-base diff; fetch full history (fetch-depth: 0)`);
  }
  let mergeBase;
  try { mergeBase = git(root, ["merge-base", "HEAD", "origin/main"]).trim(); }
  catch (e) {
    throw new UsageError(`stable-ID (${label}): cannot resolve merge-base of HEAD and origin/main — fetch full history (fetch-depth: 0): ${e.message}`);
  }
  const treePath = relPath.split(path.sep).join("/"); // git tree paths are slash-separated on every platform
  let lsTree;
  try { lsTree = git(root, ["ls-tree", mergeBase, "--", treePath]).trim(); }
  catch (e) { throw new UsageError(`stable-ID (${label}): git ls-tree failed: ${e.message}`); }
  if (lsTree === "") return { baseline: null, bootstrap: true }; // N-5: introduced since baseline
  let oldDoc;
  try { oldDoc = JSON.parse(git(root, ["show", `${mergeBase}:${treePath}`])); }
  catch (e) { throw new UsageError(`stable-ID (${label}): cannot read/parse baseline ${treePath} at ${mergeBase.slice(0, 12)}: ${e.message}`); }

  const oldIds = idsOf(oldDoc);
  const newIds = idsOf(currentDoc);
  const removed = [...oldIds].filter((id) => !newIds.has(id)).sort();
  if (removed.length > 0) {
    const oldMajor = majorOf(oldDoc && oldDoc.version);
    const newMajor = majorOf(currentDoc && currentDoc.version);
    if (oldMajor === null || newMajor === null) {
      violation(`${label} version field unparseable (old=${JSON.stringify(oldDoc && oldDoc.version)}, new=${JSON.stringify(currentDoc && currentDoc.version)}) — cannot certify the removal of ${removed.join(", ")}`);
    } else if (newMajor === oldMajor) {
      violation(`${label} id(s) removed/renamed without a major version bump: ${removed.join(", ")} — add the new id + mark the old deprecated, or bump major (set-difference invariant, F7)`);
    }
  }
  return { baseline: mergeBase, bootstrap: false };
}

/**
 * Assertion 7b arm extraction. Fail-closed grammar (review F3): inside the
 * case block, any line INTRODUCING a `)`-terminated pattern must be a plain
 * `name)` arm or the `*)` fallback — alternation/quoted/glob spellings are
 * violations, never silently skipped. Returns null when a violation already
 * explains why arms are unusable.
 */
export function extractPriorityArms(text, relPath, violation) {
  const lines = text.split(/\r?\n/);
  const defIdx = [];
  const unproven = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!PRIORITY_TOKEN_RE.test(line)) continue;
    if (line.trim().startsWith("#")) continue; // full-line comment: inert
    const tokenRe = /\b_priority\b/g;
    let m;
    while ((m = tokenRe.exec(line)) !== null) {
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + "_priority".length);
      // Definition opener, ANY position on the line (F-1R3): paren form
      // `_priority()` (bash cannot "call" with literal empty parens) or
      // keyword form `function _priority`.
      if (/^\s*\(\s*\)/.test(after) || /\bfunction\s+$/.test(before)) { defIdx.push(i); continue; }
      if (/\$\(\s*$/.test(before)) continue; // $( call site (this OCCURRENCE only — the rest of the line is still scanned)
      unproven.push(i + 1);
    }
  }
  if (unproven.length > 0) {
    violation(`${relPath}: cannot prove exactly-one _priority definition — unrecognized _priority token occurrence(s) at line(s) ${unproven.join(", ")}; allowlisted contexts are the definition opener, $(-call sites, and full-line comments — any other spelling could be a bash redefinition (fail-closed, F-1R2)`);
    return null;
  }
  if (defIdx.length === 0) { violation(`${relPath}: no _priority() definition found — cannot verify priority-arm closure`); return null; }
  if (defIdx.length > 1) { violation(`${relPath}: ${defIdx.length} _priority() definitions found (expected exactly one) — bash last-wins would diverge from a first-match parse (A3)`); return null; }
  if (!PRIORITY_DEF_RE.test(lines[defIdx[0]])) {
    violation(`${relPath}: the single _priority definition is not in canonical \`_priority() {\` form (line ${defIdx[0] + 1}) — cannot parse arms (fail-closed)`);
    return null;
  }

  let caseIdx = -1;
  for (let i = defIdx[0] + 1; i < lines.length; i++) {
    if (/^\s*case\s+"\$1"\s+in\b/.test(lines[i])) { caseIdx = i; break; }
    if (/^\s*\}\s*$/.test(lines[i])) break; // function closed before any case block (indent-tolerant, F-1 class)
  }
  if (caseIdx === -1) { violation(`${relPath}: _priority() carries no \`case "$1" in\` block — cannot verify priority-arm closure`); return null; }

  const arms = [];
  let sawEsac = false;
  for (let i = caseIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*esac\b/.test(line)) { sawEsac = true; break; }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const plain = ARM_PLAIN_RE.exec(line);
    if (plain) { arms.push(plain[1]); continue; }
    if (ARM_STAR_RE.test(line)) continue;
    if (ARM_INTRODUCING_RE.test(line)) {
      violation(`${relPath}: unrecognized _priority case-arm spelling ${JSON.stringify(trimmed.slice(0, 40))} — only plain \`name)\` arms and \`*)\` are parseable; alternation/quoted/glob arms would be silently skipped past the closure check (F3)`);
      return null;
    }
    // anything else is an arm-body continuation line; ignore
  }
  if (!sawEsac) { violation(`${relPath}: _priority() case block has no esac — unparseable (fail-closed)`); return null; }
  return arms;
}

export function validateBpContract({ projectRoot, taxonomyPath = null, eventsPath = null, bpDirPath = null } = {}) {
  const root = resolveProjectRoot(projectRoot, process.cwd());
  const violations = [];
  let checks = 0;
  const assertionsRun = new Set();
  const violation = (check, detail) => violations.push({ check, severity: "error", detail });

  // --- effective sources (A5: one taxonomy, one events, one bp dir for ALL assertions) ---
  const taxonomyAbs = taxonomyPath != null ? resolveContained(root, taxonomyPath, "taxonomy") : path.join(root, "patterns", "taxonomy.json");
  const eventsAbs = eventsPath != null ? resolveContained(root, eventsPath, "events") : path.join(root, "patterns", "events.json");
  const bpDirAbs = bpDirPath != null ? resolveContained(root, bpDirPath, "bp-dir") : path.join(root, "patterns");

  const schemas = {
    bp: readJsonInput(path.join(root, "patterns", "schema.json"), "patterns/schema.json"),
    taxonomy: readJsonInput(path.join(root, "patterns", "taxonomy.schema.json"), "patterns/taxonomy.schema.json"),
    events: readJsonInput(path.join(root, "patterns", "events.schema.json"), "patterns/events.schema.json"),
  };
  assertAllSchemasModeled(schemas); // throws SchemaModelingError -> exit 2 at the boundary
  assertSelfConsistent(); // lint engine self-check, fail-closed (assertion 13 uses it)

  const taxonomy = readJsonInput(taxonomyAbs, "taxonomy");
  const events = readJsonInput(eventsAbs, "events");
  const patternsIndex = readJsonInput(path.join(root, "patterns", "_index.json"), "patterns/_index.json");
  const pluginsIndex = readJsonInput(path.join(root, "plugins", "_index.json"), "plugins/_index.json");

  const labels = Array.isArray(taxonomy.labels) ? taxonomy.labels : [];
  const labelIds = new Set(labels.map((l) => l && l.id).filter((id) => typeof id === "string"));
  const eventList = Array.isArray(events.events) ? events.events : [];
  const eventIds = new Set(eventList.map((e) => e && e.id).filter((id) => typeof id === "string"));
  const liveTaxVersion = taxonomyVersion({ labels });
  const liveEvVersion = eventsVersion({ events: eventList });

  // --- enforcement manifests (shared input for 7a / 11 / 15) ---
  const enforcementEntries = (Array.isArray(pluginsIndex.plugins) ? pluginsIndex.plugins : []).filter((p) => p && p.type === "enforcement");
  const manifests = [];
  for (const entry of enforcementEntries) {
    // An unloadable manifest skips arms in THREE assertion groups — attribute
    // the skip in each so no consumer reads a green 11/15 as "checked"
    // (step-6 NIT: attribution-only, exit was already 1).
    const skipAll = (why) => { for (const check of ["7", "11", "15"]) violation(check, why); };
    if (typeof entry.manifest !== "string") { skipAll(`_index entry ${JSON.stringify(entry.id)} has no manifest path — closure arms cannot run for it`); continue; }
    const abs = path.join(root, entry.manifest);
    try { manifests.push({ entry, manifest: JSON.parse(fs.readFileSync(abs, "utf8")) }); }
    catch (e) { skipAll(`manifest ${entry.manifest} unreadable/unparseable (${e.message}) — closure arms cannot run for it`); }
  }

  // ---------------------------------------------------------------------------
  // Assertion 0 — bp contract set + instance + id binding (sub-coded).
  // ---------------------------------------------------------------------------
  assertionsRun.add(0);
  let derived;
  try { derived = deriveBpIds(patternsIndex); }
  catch (e) { throw new UsageError(`patterns/_index.json SoT derivation failed: ${e.message}`); }
  const derivedIds = new Set(derived.map((d) => d.id));

  let bpDirents;
  try { bpDirents = fs.readdirSync(bpDirAbs, { withFileTypes: true }); }
  catch (e) { throw new UsageError(`bp dir unreadable at ${bpDirAbs}: ${e.message}`); }
  const discovered = new Map(); // id -> abs path
  for (const ent of bpDirents) {
    if (!BP_LOOSE_RE.test(ent.name)) continue;
    checks++;
    if (!BP_STRICT_RE.test(ent.name)) {
      // F5: near-miss filenames are dead data a lenient consumer could load.
      violation("0-set", `${ent.name}: malformed contract filename (must match bp-NNN.json) — would sit unvalidated and invisible to the set-equality guard`);
      continue;
    }
    if (!ent.isFile()) {
      violation("0-set", `${ent.name}: contract is not a regular file (symlink/directory/other) — contracts must be regular files`);
      continue;
    }
    discovered.set(ent.name.replace(/\.json$/, ""), path.join(bpDirAbs, ent.name));
  }
  checks++;
  for (const id of derivedIds) if (!discovered.has(id)) violation("0-set", `missing contract ${id}.json (pattern enumerated in patterns/_index.json has no contract) — run scripts/scaffold-bp.mjs`);
  for (const id of discovered.keys()) if (!derivedIds.has(id)) violation("0-set", `phantom contract ${id}.json (no matching pattern_id in patterns/_index.json)`);

  const bpDocs = new Map(); // id -> parsed doc (only parseable ones)
  for (const [id, abs] of [...discovered.entries()].sort()) {
    checks++;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(abs, "utf8")); }
    catch (e) { violation("0-schema", `${id}.json: not parseable JSON — ${e.message}`); continue; }
    bpDocs.set(id, doc);
    const res = validateInstance(doc, schemas.bp);
    if (!res.valid) for (const err of res.errors) violation("0-schema", `${id}.json ${err.path}: ${err.keyword} — ${err.detail}`);
    checks++;
    if (doc === null || typeof doc !== "object" || doc.id !== id) {
      violation("0-idbind", `${id}.json: interior id ${JSON.stringify(doc && doc.id)} must equal the filename stem ${JSON.stringify(id)} (A1 — schema.json leaves id optional and delegates the binding here)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion 1 — taxonomy meta-schema instance validation.
  // ---------------------------------------------------------------------------
  assertionsRun.add(1);
  checks++;
  {
    const res = validateInstance(taxonomy, schemas.taxonomy);
    if (!res.valid) for (const err of res.errors) violation("1", `taxonomy ${err.path}: ${err.keyword} — ${err.detail}`);
  }

  // ---------------------------------------------------------------------------
  // Assertions 2/3/4 — per-label gate completeness / closure / action enum.
  // Defensive (F4): tolerate schema-invalid shapes; assertion 1 already
  // recorded them, these record their own view without throwing.
  // ---------------------------------------------------------------------------
  assertionsRun.add(2); assertionsRun.add(3); assertionsRun.add(4);
  for (const l of labels) {
    const id = l && typeof l.id === "string" ? l.id : "<unnamed label>";
    const gates = l && l.gates !== null && typeof l.gates === "object" && !Array.isArray(l.gates) ? l.gates : null;
    checks++;
    if (gates === null) { violation("2", `label ${id}: gates object missing/mistyped`); continue; }
    for (const g of GATE_KEYS) if (!(g in gates)) violation("2", `label ${id}: gate ${g} missing (gate-completeness, F1a)`);
    for (const k of Object.keys(gates)) if (!GATE_KEYS.includes(k)) violation("3", `label ${id}: extra gate key ${JSON.stringify(k)} (closed gate set, F1e)`);
    for (const [k, v] of Object.entries(gates)) {
      if (GATE_KEYS.includes(k) && !GATE_ACTIONS.includes(v)) violation("4", `label ${id}: gate ${k} value ${JSON.stringify(v)} not in {allow, block} (F1b)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion 5 — overridability equality (stored ≡ derived, both directions).
  // ---------------------------------------------------------------------------
  assertionsRun.add(5);
  checks++;
  {
    const derivedNo = labels.filter((l) => l && l.overridable === false).map((l) => l.id).filter((id) => typeof id === "string").sort();
    const stored = Array.isArray(taxonomy.non_overridable) ? [...taxonomy.non_overridable].sort() : null;
    if (stored === null) violation("5", "non_overridable missing/mistyped (must be an array)");
    else if (JSON.stringify(stored) !== JSON.stringify(derivedNo)) {
      violation("5", `non_overridable ${JSON.stringify(stored)} != derived non-overridable set ${JSON.stringify(derivedNo)} (F1c/F9 — per-label overridable is canonical)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion 6 — duplicate label ids.
  // ---------------------------------------------------------------------------
  assertionsRun.add(6);
  checks++;
  {
    const ids = labels.map((l) => l && l.id).filter((id) => typeof id === "string");
    if (new Set(ids).size !== ids.length) {
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      violation("6", `duplicate label id(s): ${[...new Set(dup)].join(", ")} (F1d)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion 7 — vocabulary closure (7a manifests, 7b default classifier).
  // ---------------------------------------------------------------------------
  assertionsRun.add(7);
  checks++;
  if (enforcementEntries.length === 0) violation("7", "zero enforcement plugins in plugins/_index.json — closure arms 7a/11/15 would be vacuous (fail-closed)");
  for (const { entry, manifest } of manifests) {
    checks++;
    const emits = manifest.classifier && Array.isArray(manifest.classifier.emits_labels) ? manifest.classifier.emits_labels : [];
    for (const lbl of emits) if (!labelIds.has(lbl)) violation("7", `manifest ${entry.id}: dangling emits_label ${JSON.stringify(lbl)} (not a taxonomy label, F6)`);
  }
  let classifiersParsed = 0;
  for (const { entry, manifest } of manifests) {
    if (!manifest.classifier || manifest.classifier.mode !== "default") continue;
    checks++;
    const dir = typeof entry.directory === "string" ? entry.directory : `plugins/${entry.harness}`;
    const clsLex = path.join(root, dir, "hooks", "lib", "command-classifier.sh");
    const rel = path.relative(root, clsLex);
    let clsReal;
    try { clsReal = fs.realpathSync(clsLex); }
    catch { violation("7", `${rel}: default classifier script missing — R4 requires the default classifier; arm closure cannot be verified (fail-closed)`); continue; }
    if (!contained(clsReal, root)) { violation("7", `${rel}: classifier resolves outside the project root — refusing to read`); continue; }
    const arms = extractPriorityArms(fs.readFileSync(clsReal, "utf8"), rel, (d) => violation("7", d));
    if (arms === null) continue;
    classifiersParsed++;
    const armSet = new Set(arms);
    if (new Set(arms).size !== arms.length) violation("7", `${rel}: duplicate _priority case arm(s)`);
    for (const a of armSet) if (!labelIds.has(a)) violation("7", `${rel}: _priority arm ${JSON.stringify(a)} is not a taxonomy label (extra arm)`);
    for (const id of labelIds) if (!armSet.has(id)) violation("7", `${rel}: taxonomy label ${JSON.stringify(id)} has NO _priority arm — it would rank priority 0, below read_only, a silent downgrade in most-restrictive-wins reduction (L473)`);
  }
  checks++;
  if (manifests.some((m) => m.manifest.classifier && m.manifest.classifier.mode === "default") && classifiersParsed === 0) {
    violation("7", "no default classifier was successfully parsed — assertion 7b ran zero times (vacuity, fail-closed)");
  }

  // ---------------------------------------------------------------------------
  // Assertions 8 / 14 — stable-ID integrity (taxonomy, events).
  // ---------------------------------------------------------------------------
  assertionsRun.add(8);
  checks++;
  stableIdCheck({
    root,
    relPath: path.relative(root, taxonomyAbs),
    currentDoc: taxonomy,
    idsOf: (doc) => new Set((Array.isArray(doc && doc.labels) ? doc.labels : []).map((l) => l && l.id).filter((id) => typeof id === "string")),
    label: "taxonomy",
    violation: (d) => violation("8", d),
  });
  assertionsRun.add(14);
  checks++;
  stableIdCheck({
    root,
    relPath: path.relative(root, eventsAbs),
    currentDoc: events,
    idsOf: (doc) => new Set((Array.isArray(doc && doc.events) ? doc.events : []).map((e) => e && e.id).filter((id) => typeof id === "string")),
    label: "events",
    violation: (d) => violation("14", d),
  });

  // ---------------------------------------------------------------------------
  // Assertion 10 — events meta-schema instance validation.
  // ---------------------------------------------------------------------------
  assertionsRun.add(10);
  checks++;
  {
    const res = validateInstance(events, schemas.events);
    if (!res.valid) for (const err of res.errors) violation("10", `events ${err.path}: ${err.keyword} — ${err.detail}`);
  }

  // ---------------------------------------------------------------------------
  // Assertion 11 — events vocabulary closure over manifests (de-vacuified).
  // ---------------------------------------------------------------------------
  assertionsRun.add(11);
  for (const { entry, manifest } of manifests) {
    checks++;
    for (const k of Object.keys(manifest.capabilities || {})) {
      if (!eventIds.has(k)) violation("11", `manifest ${entry.id}: capability key ${JSON.stringify(k)} is not an events.json event id`);
    }
    for (const k of Object.keys(manifest.event_translations || {})) {
      if (!eventIds.has(k)) violation("11", `manifest ${entry.id}: event_translations key ${JSON.stringify(k)} is not an events.json event id`);
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion 12 — action-enum closure per event x tier, plus event-id
  // uniqueness (step-6 F-2 — the events mirror of assertion 6; without it a
  // duplicate event id silently dedups into the eventIds Set. RFC L448-453
  // carries no explicit dup-id assertion — asymmetry flagged for the P2c
  // doc sweep).
  // ---------------------------------------------------------------------------
  assertionsRun.add(12);
  checks++;
  {
    const ids = eventList.map((e) => e && e.id).filter((id) => typeof id === "string");
    if (new Set(ids).size !== ids.length) {
      const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
      violation("12", `duplicate event id(s): ${[...new Set(dup)].join(", ")} (events mirror of F1d)`);
    }
  }
  for (const ev of eventList) {
    const id = ev && typeof ev.id === "string" ? ev.id : "<unnamed event>";
    const actions = ev && ev.actions !== null && typeof ev.actions === "object" && !Array.isArray(ev.actions) ? ev.actions : null;
    checks++;
    if (actions === null) { violation("12", `event ${id}: actions object missing/mistyped`); continue; }
    for (const tier of TIER_ARMS) {
      const a = actions[tier];
      if (a === undefined) { violation("12", `event ${id}: tier arm ${tier} missing (all three arms required)`); continue; }
      const actionId = a && typeof a === "object" ? a.id : undefined;
      if (!ACTION_ENUM.includes(actionId)) violation("12", `event ${id}: ${tier} action id ${JSON.stringify(actionId)} not in the closed enum {${ACTION_ENUM.join(", ")}} (F37)`);
    }
  }

  // ---------------------------------------------------------------------------
  // Assertion 13 — payload_schema resolution + containment + doc lint.
  // Path values come from DATA, so escapes are violations (exit 1), not usage
  // errors; ENOENT = fail (payload schemas MUST exist).
  // ---------------------------------------------------------------------------
  assertionsRun.add(13);
  const eventsSchemaDirAbs = path.join(root, "schemas", "events");
  for (const ev of eventList) {
    const id = ev && typeof ev.id === "string" ? ev.id : "<unnamed event>";
    checks++;
    const p = ev && ev.payload_schema;
    if (typeof p !== "string" || p.length === 0) { violation("13", `event ${id}: payload_schema missing/mistyped`); continue; }
    let real;
    try { real = resolveContained(root, p, "payload-schema"); }
    catch (e) { violation("13", `event ${id}: payload_schema ${JSON.stringify(p)} escapes the project root — ${e.message}`); continue; }
    if (!contained(real, eventsSchemaDirAbs)) { violation("13", `event ${id}: payload_schema ${JSON.stringify(p)} resolves outside schemas/events/ (containment, F-7 axis 6)`); continue; }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(real, "utf8")); }
    catch (e) { violation("13", `event ${id}: payload_schema ${JSON.stringify(p)} unreadable/unparseable (ENOENT = fail, F-7 axis 5): ${e.message}`); continue; }
    const { valid, errors } = lintSchema(doc);
    if (!valid) violation("13", `event ${id}: payload_schema ${JSON.stringify(p)} is not a valid 2020-12 schema doc: ${errors.slice(0, 3).join(" | ")}`);
  }

  // ---------------------------------------------------------------------------
  // Assertion 15 — version bindings (bp contracts + manifests, both hashes).
  // Hashes computed from the EFFECTIVE taxonomy/events (A5).
  // ---------------------------------------------------------------------------
  assertionsRun.add(15);
  const bindingTargets = [
    ...[...bpDocs.entries()].map(([id, doc]) => [`${id}.json`, doc]),
    ...manifests.map(({ entry, manifest }) => [`manifest ${entry.id}`, manifest]),
  ];
  for (const [name, doc] of bindingTargets) {
    checks++;
    const pairs = [["taxonomy_version", liveTaxVersion], ["events_version", liveEvVersion]];
    for (const [field, expected] of pairs) {
      const actual = doc && doc[field];
      if (actual !== expected) violation("15", `${name}: stale ${field} (have ${JSON.stringify(actual)}, live ${expected}) — regenerate via scripts/scaffold-bp.mjs (F8/F37)`);
    }
  }

  return {
    status: violations.length === 0 ? "ok" : "violations",
    project_root: root,
    bp_files_checked: bpDocs.size,
    derived_ids: [...derivedIds].sort(),
    manifests_checked: manifests.length,
    classifiers_parsed: classifiersParsed,
    assertions_run: [...assertionsRun].sort((a, b) => a - b),
    taxonomy_version: liveTaxVersion,
    events_version: liveEvVersion,
    checks,
    violations,
    exit: violations.length === 0 ? 0 : 1,
  };
}

const HELP = `validate-bp-contract.mjs — RFC-008 normative bp-contract assertion checklist 0 + 1-15 (P2b)

Usage:
  node scripts/validate-bp-contract.mjs --project <abs-repo-root> [--json]

Options:
  --project <path>   explicit project root (realpath'd; git never consulted)
  --taxonomy <path>  inject a taxonomy fixture (golden-corpus dispatch only)
  --events <path>    inject an events fixture (golden-corpus dispatch only)
  --bp-dir <path>    inject a staged bp-contract dir (golden-corpus dispatch only)
  --json             full JSON payload on stdout
  --help             this message

Exit: 0 pass, 1 violations, 2 usage/IO error or internal crash (incl.
unverifiable stable-ID: shallow repo or no origin/main merge-base).`;

function parseArgs(argv) {
  const args = { project: null, taxonomy: null, events: null, bpDir: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") { args.project = argv[++i]; if (args.project == null) throw new UsageError("--project requires a value"); }
    else if (a === "--taxonomy") { args.taxonomy = argv[++i]; if (args.taxonomy == null) throw new UsageError("--taxonomy requires a value"); }
    else if (a === "--events") { args.events = argv[++i]; if (args.events == null) throw new UsageError("--events requires a value"); }
    else if (a === "--bp-dir") { args.bpDir = argv[++i]; if (args.bpDir == null) throw new UsageError("--bp-dir requires a value"); }
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
    result = validateBpContract({ projectRoot: args.project, taxonomyPath: args.taxonomy, eventsPath: args.events, bpDirPath: args.bpDir });
  } catch (e) {
    if (e instanceof UsageError || e.name === "UsageError") {
      process.stderr.write(e.message + "\n");
      process.exit(2);
    }
    // Internal crash — fail closed as usage/IO (exit 2), NEVER exit 1.
    process.stdout.write(JSON.stringify({ status: "error", project_root: null, checks: 0, violations: [{ check: "internal", severity: "error", detail: e.message }] }) + "\n");
    process.exit(2);
  }

  const { exit, ...payload } = result;
  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (payload.status === "ok") {
    process.stdout.write(`OK  validate-bp-contract: ${payload.bp_files_checked} contract(s), ${payload.manifests_checked} manifest(s), ${payload.assertions_run.length} assertion group(s), ${payload.checks} check(s) for ${payload.project_root}\n`);
  } else {
    process.stderr.write(`FAIL  validate-bp-contract (${payload.status}): ${payload.violations.length} violation(s)\n`);
    for (const v of payload.violations) process.stderr.write(`  ✗ [${v.check}] ${v.detail}\n`);
  }
  process.exit(exit);
}

// pathToFileURL main-guard (P2a step-6 F4 class).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
