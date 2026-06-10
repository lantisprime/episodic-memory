#!/usr/bin/env node
/**
 * scaffold-bp.mjs — generator for the bp-XXX enforcement-contract DATA files
 * (RFC-008 P2b, R2/R3). Derives the contract id-set from the single source of
 * truth `patterns/_index.json` (`patterns[].pattern_id`, stripped to the
 * `bp-NNN` stem) — the live set is 11 patterns with bp-007 ABSENT (P2 plan
 * finding N-1); the scaffold iterates the derived list, never a numeric range.
 *
 * Content: every NEW contract declares uniform STRONG for the three
 * classification gates + the root-level stop gate (the RFC's only normative
 * contract-content examples, L927-947, are STRONG; effective enforcement is
 * `min(harness_cap, contract_tier, project_config)` per L464, so per-pattern
 * relaxation is a later data edit, clamped by P4 project config).
 *
 * Merge-on-regenerate (plan-review F2): when `patterns/bp-XXX.json` already
 * exists, the scaffold PRESERVES the authored `gates`, `stop`, `title` and
 * `description` and refreshes ONLY the `taxonomy_version`/`events_version`
 * bindings (id/taxonomy_ref re-pinned). Contract data is authored state, not
 * derived state — a regeneration after a taxonomy bump must never silently
 * revert a hand-relaxed tier to STRONG.
 *
 * Hashes are computed LIVE from scripts/lib/version-hash.mjs (F8/F37, plan
 * F-11) — never hand-typed.
 *
 * Usage:
 *   node scripts/scaffold-bp.mjs --project <abs-repo-root> [--json]
 *
 * All writes bind to the resolved --project root (planner A6) — nothing is
 * ever written relative to caller cwd.
 *
 * Exit: 0 = success, 2 = usage/IO error (a generator has no violation
 * concept; there is no exit 1).
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { taxonomyVersion, eventsVersion } from "./lib/version-hash.mjs";
import { UsageError } from "./lib/path-contain.mjs";

const BP_STEM_RE = /^(bp-[0-9]{3})-/;
const TIER_DEFAULT = "STRONG";

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

function readJson(abs, label) {
  let raw;
  try { raw = fs.readFileSync(abs, "utf8"); }
  catch (e) { throw new UsageError(`${label} unreadable at ${abs}: ${e.message}`); }
  try { return JSON.parse(raw); }
  catch (e) { throw new UsageError(`${label} is not parseable JSON (${abs}): ${e.message}`); }
}

/**
 * Derive the bp id list from _index.json. A pattern_id that does not match
 * the `bp-NNN-<name>` shape is a malformed SoT -> fail closed (exit 2), never
 * a silent skip.
 */
export function deriveBpIds(index) {
  const patterns = Array.isArray(index && index.patterns) ? index.patterns : null;
  if (patterns === null || patterns.length === 0) {
    throw new UsageError("patterns/_index.json carries no patterns[] — refusing to scaffold from an empty SoT");
  }
  const out = [];
  for (const p of patterns) {
    const pid = p && p.pattern_id;
    const m = typeof pid === "string" ? BP_STEM_RE.exec(pid) : null;
    if (!m) throw new UsageError(`pattern_id ${JSON.stringify(pid)} does not match ^bp-NNN- — malformed SoT entry, refusing to scaffold`);
    out.push({ id: m[1], name: typeof p.name === "string" ? p.name : null });
  }
  const ids = out.map((e) => e.id);
  if (new Set(ids).size !== ids.length) throw new UsageError("duplicate bp ids derived from patterns/_index.json");
  return out;
}

/**
 * Build one contract object. `existing` (parsed prior file or null) drives
 * merge-on-regenerate: authored gates/stop/title/description survive; only
 * the version bindings (and the id/taxonomy_ref pins) are refreshed.
 */
export function buildContract({ id, name }, existing, taxVersion, evVersion) {
  const fresh = {
    gates: { plan_approval: TIER_DEFAULT, pre_checkpoint: TIER_DEFAULT, post_checkpoint: TIER_DEFAULT },
    stop: { tier: TIER_DEFAULT },
  };
  const src = existing !== null && typeof existing === "object" && !Array.isArray(existing) ? existing : null;
  const contract = { id };
  const title = src && typeof src.title === "string" ? src.title : name;
  if (title != null) contract.title = title;
  if (src && typeof src.description === "string") contract.description = src.description;
  contract.gates = src && src.gates !== undefined ? src.gates : fresh.gates;
  contract.stop = src && src.stop !== undefined ? src.stop : fresh.stop;
  contract.taxonomy_ref = "patterns/taxonomy.json";
  contract.taxonomy_version = taxVersion;
  contract.events_version = evVersion;
  return contract;
}

export function scaffoldBp({ projectRoot }) {
  const root = resolveProjectRoot(projectRoot, process.cwd());
  const patternsDir = path.join(root, "patterns");
  const index = readJson(path.join(patternsDir, "_index.json"), "patterns/_index.json");
  const taxonomy = readJson(path.join(patternsDir, "taxonomy.json"), "patterns/taxonomy.json");
  const events = readJson(path.join(patternsDir, "events.json"), "patterns/events.json");
  const taxVersion = taxonomyVersion(taxonomy);
  const evVersion = eventsVersion(events);

  const derived = deriveBpIds(index);
  const created = [];
  const updated = [];
  const unchanged = [];
  for (const entry of derived) {
    const abs = path.join(patternsDir, `${entry.id}.json`);
    let existing = null;
    let existed = false;
    if (fs.existsSync(abs)) {
      existed = true;
      // A corrupt existing contract cannot be merged safely -> fail closed.
      existing = readJson(abs, `existing contract ${entry.id}.json`);
    }
    const contract = buildContract(entry, existing, taxVersion, evVersion);
    const text = JSON.stringify(contract, null, 2) + "\n";
    if (existed && fs.readFileSync(abs, "utf8") === text) {
      unchanged.push(path.relative(root, abs));
      continue;
    }
    fs.writeFileSync(abs, text);
    (existed ? updated : created).push(path.relative(root, abs));
  }

  return {
    status: "ok",
    project_root: root,
    derived_ids: derived.map((e) => e.id),
    taxonomy_version: taxVersion,
    events_version: evVersion,
    created,
    updated,
    unchanged,
  };
}

const HELP = `scaffold-bp.mjs — generate/refresh the bp-XXX enforcement-contract data files (RFC-008 P2b)

Usage:
  node scripts/scaffold-bp.mjs --project <abs-repo-root> [--json]

Options:
  --project <path>  explicit project root (realpath'd; git never consulted)
  --json            full JSON payload on stdout
  --help            this message

Derives the id-set from patterns/_index.json; existing contracts keep their
authored gates/stop/title/description (only the version hashes refresh).
Exit: 0 success, 2 usage/IO error.`;

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
    result = scaffoldBp({ projectRoot: args.project });
  } catch (e) {
    if (e instanceof UsageError || e.name === "UsageError") {
      process.stderr.write(e.message + "\n");
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({ status: "error", detail: e.message }) + "\n");
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(`OK  scaffold-bp: ${result.derived_ids.length} contract(s) — ${result.created.length} created, ${result.updated.length} updated, ${result.unchanged.length} unchanged\n`);
  }
  process.exit(0);
}

// pathToFileURL main-guard (P2a step-6 F4 class: a raw-template compare can
// silently skip main() and green the CI step with no output).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
