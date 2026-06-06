#!/usr/bin/env node
/**
 * validate-plugin-registry.mjs — static conformance checker for the harness
 * plugin registry (RFC-008 R0c P1b). Turns "the claude-code plugin" into a
 * checkable CONTRACT: walks plugins/_index.json + each entry's manifest.json
 * and asserts M1–M9 + M-cross + the typed/versioned MAX_SUPPORTED gate. Maps to
 * R1 (memory-as-substrate), R6 (plugin↔harness binding), R8 (typed+versioned
 * registry). ZERO runtime behavior change — CI-time static check only.
 *
 * Scope note (F5 split): M7c–M7f (§7 Table A/B + §8 modality + §9 agent-manifest
 * + §10 cross-binding, content-DERIVATION) are P1c, byte-coupled to runbook
 * authoring. P1b's M7 verifies runbook EXISTENCE + byte-floor + sentinel +
 * §-header presence only.
 *
 * Usage:
 *   node scripts/validate-plugin-registry.mjs --project <abs>            # live registry
 *   node scripts/validate-plugin-registry.mjs --project <abs> --json
 *   node scripts/validate-plugin-registry.mjs --project <abs> --manifest <path>      # inject one manifest
 *   node scripts/validate-plugin-registry.mjs --project <abs> --index <path>         # inject the _index
 *   node scripts/validate-plugin-registry.mjs --project <abs> --bypass-known <path>  # inject the bypass registry
 *
 * --project is REQUIRED — the explicit repo root, canonicalized via realpath.
 * With NO --project, the root is discovered via `git rev-parse --show-toplevel`
 * from cwd; a non-git cwd fails CLEAR (exit 2) with an empty read_trace (no
 * silent caller-cwd read). When --project is explicit, git is NEVER consulted.
 *
 * Output (stdout JSON): { status, project_root, checks, violations[], read_trace[] }
 * Exit: 0 = pass, 1 = violations, 2 = usage/IO error.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateInstance, assertAllSchemasModeled } from "./lib/json-instance-validate.mjs";
import { taxonomyVersion, eventsVersion } from "./lib/version-hash.mjs";

// --- closed vocabularies (re-asserted even where a schema already closes them) ---
export const MAX_SUPPORTED = "1.0.0"; // byte-equal'd to _corpus-index.current_schema_version (a test asserts equality)
const HARNESS_IDS = ["claude-code", "opencode", "codex", "pi-agent", "cursor", "windsurf"];
const EVENT_IDS = ["pre_tool_use", "tool_result", "stop", "session_start", "session_end"];
const TIERS = ["STRONG", "MEDIUM", "WEAK", "TBD"];
const TIER_RANK = { TBD: 0, WEAK: 1, MEDIUM: 2, STRONG: 3 };
const MIN_RUNBOOK_FULL_BYTES = 1024;
const MIN_RUNBOOK_QUICKREF_BYTES = 256;
const RUNBOOK_SENTINEL = "## ⚠️ Self-trigger checklist";
const RUNBOOK_SECTION_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const COMMON_BEGIN = "<!-- COMMON:BEGIN -->";
const COMMON_END = "<!-- COMMON:END -->";

// RESERVED_DIRS (M8): a closed allowlist of plugins/ subdirs that are NOT
// enforcement plugins and so are exempt from the bidirectional dir↔entry rule.
// Each carries a presence disposition: "on-disk" reserved dirs must EXIST (so a
// typo can't silently exempt a real orphan, planner #13); "reserved-for-Follow"
// dirs do not exist yet and are annotation-only (claude-subagent N2).
export const RESERVED_DIRS = {
  "episodic-memory": { presence: "on-disk", why: "Claude-Code plugin packaging (.claude-plugin/, scripts/, skills/); exists on main." },
  "second-opinion": { presence: "reserved-for-Follow", why: "RFC-008 L1257 second-opinion runbooks fork; dir authored in the post-P1 Follow, not yet on disk." },
};

// ---------------------------------------------------------------------------
// Typed/versioned gate (R8 L116/L118). Runs on the RAW schema_version BEFORE
// M1/M2 — pinned ordering, else the schema `pattern` short-circuits and the
// parse guard is never reached by its own fixture (claude-subagent F4).
// ---------------------------------------------------------------------------
export function parseSemverStrict(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s); // strict 3-part; rejects "1.0" / "1.0.0-beta"
  if (!m) return null;                        // NOTE: "01.0.0" matches -> {1,0,0}; intentional (F4: no leading-zero reject)
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function gateSchemaVersion(raw, maxSupported = MAX_SUPPORTED) {
  const v = parseSemverStrict(raw);
  if (!v) return { ok: false, reason: "unparseable", detail: `schema_version ${JSON.stringify(raw)} is not a strict 3-part semver` };
  const max = parseSemverStrict(maxSupported);
  // Forward gate on (major, minor) ONLY (RFC L118): PATCH > max still accepts.
  if (v.major > max.major || (v.major === max.major && v.minor > max.minor)) {
    return { ok: false, reason: "forward", detail: `schema_version ${raw} exceeds MAX_SUPPORTED ${maxSupported} (major/minor fail-closed-forward)` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------
function contained(abs, baseReal) {
  return abs === baseReal || abs.startsWith(baseReal + path.sep);
}

/**
 * Resolve an INJECTED file path (--manifest / --index / --bypass-known) and
 * realpath-contain it under the project root (F7/F29). An injected path is
 * caller-controlled, so it must not let the validator read outside the project:
 * lexical escape (../, absolute) OR symlink escape -> UsageError (exit 2). A
 * not-yet-existing path keeps its lexically-contained abs (the reader surfaces
 * ENOENT). `root` is already canonical (realpathSync in resolveProjectRoot).
 */
function resolveContained(root, p, label) {
  const absLex = path.resolve(root, p);
  // realpath FIRST for an existing path (canonicalizes e.g. macOS /var ->
  // /private/var so an absolute in-project path is not falsely rejected by a
  // lexical compare against the already-canonical root); lexical fallback only
  // for a not-yet-existing path (the reader then surfaces ENOENT).
  let real;
  try { real = fs.realpathSync(absLex); }
  catch {
    if (!contained(absLex, root)) throw new UsageError(`--${label} ${JSON.stringify(p)} escapes --project authority`);
    return absLex;
  }
  if (!contained(real, root)) throw new UsageError(`--${label} ${JSON.stringify(p)} resolves outside --project authority`);
  return real;
}

class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; }
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
  // discovery (only when --project absent)
  let top;
  try {
    top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new UsageError("no --project and cwd is not inside a git repository (no silent caller-cwd fallback)");
  }
  return fs.realpathSync(top);
}

// ---------------------------------------------------------------------------
// Context: the 5 interpreted schemas (asserted-modeled, single registry drives
// scan==interpret) + taxonomy + events + the (default or injected) bypass set.
// ---------------------------------------------------------------------------
function loadContext(root, readJson, bypassKnownPath) {
  const schemas = {
    _index: readJson(path.join(root, "plugins/_index.schema.json")),
    manifest: readJson(path.join(root, "plugins/manifest.schema.json")),
    bypass_known: readJson(path.join(root, "plugins/bypass_known.schema.json")),
    installed_state: readJson(path.join(root, "plugins/installed-state.schema.json")),
    structured_alert: readJson(path.join(root, "schemas/runtime/structured-alert.schema.json")),
  };
  assertAllSchemasModeled(schemas); // throws SchemaModelingError if any schema escapes the modeled subset
  const taxonomy = readJson(path.join(root, "patterns/taxonomy.json"));
  const events = readJson(path.join(root, "patterns/events.json"));
  const bypassAbs = bypassKnownPath != null ? resolveContained(root, bypassKnownPath, "bypass-known") : path.join(root, "plugins/bypass_known.json");
  const bypassKnown = readJson(bypassAbs);
  return { schemas, taxonomy, events, bypassKnown };
}

// ---------------------------------------------------------------------------
// Per-manifest checks (M2–M7b). add(check, severity, detail, extra?) collects.
// ---------------------------------------------------------------------------
function validateManifest(ctx, manifest, root, readMaybe, add) {
  const { schemas, taxonomy, events, bypassKnown } = ctx;

  // M2 — schema (additionalProperties:false everywhere). A schema failure means
  // later semantic checks may crash on missing fields, so guard them on M2.
  const m2 = validateInstance(manifest, schemas.manifest);
  if (!m2.valid) {
    for (const e of m2.errors) add("M2", "error", `${e.path}: ${e.keyword} — ${e.detail}`, { keyword: e.keyword });
    return; // structure not trustworthy; do not run semantic checks
  }

  const harness = manifest.harness;
  const caps = manifest.capabilities || {};
  const capKeys = Object.keys(caps);
  const cls = manifest.classifier || {};
  const mode = cls.mode;
  const emits = cls.emits_labels || [];

  // M3 — stable identity. id==harness; harness ∈ enum (schema closes; re-assert).
  if (manifest.id !== harness) add("M3", "error", `id ${JSON.stringify(manifest.id)} must equal harness ${JSON.stringify(harness)}`);
  if (!HARNESS_IDS.includes(harness)) add("M3", "error", `unknown harness ${JSON.stringify(harness)}`);

  // M4 — capability key closure + tier vocabulary + M4b modality presence.
  for (const k of capKeys) {
    if (!EVENT_IDS.includes(k)) add("M4", "error", `unknown capability key ${JSON.stringify(k)}`);
    const tier = caps[k];
    if (!TIERS.includes(tier)) add("M4", "error", `capability ${k} tier ${JSON.stringify(tier)} not in ${TIERS.join("/")}`);
    if (k === "tool_result" && tier === "WEAK") add("M4", "error", `tool_result at WEAK is unsupported (events.json) — fails capability closure`);
  }
  if (typeof manifest.invocation_modality !== "string") add("M4b", "error", "invocation_modality missing");

  // M5 — classifier mode + emits_labels ⊆ taxonomy (F6) + default⇒canonical set.
  const taxIds = new Set(taxonomy.labels.map((l) => l.id));
  for (const lbl of emits) if (!taxIds.has(lbl)) add("M5", "error", `dangling emits_label ${JSON.stringify(lbl)} (not a taxonomy label)`, { keyword: "dangling" });
  if (mode === "default") {
    const emitsSet = new Set(emits);
    const sameSize = emitsSet.size === taxIds.size;
    const allPresent = [...taxIds].every((id) => emitsSet.has(id));
    if (!sameSize || !allPresent) add("M5", "error", `default mode must emit exactly the ${taxIds.size} canonical taxonomy labels`, { keyword: "default_set" });
  }
  // M5a — override must PRESERVE the non-overridable labels (safety fail-closed).
  if (mode === "override") {
    for (const lbl of taxonomy.non_overridable || []) {
      if (!emits.includes(lbl)) add("M5a", "error", `override classifier must preserve non-overridable label ${JSON.stringify(lbl)}`, { keyword: "non_overridable" });
    }
    // M5b (override-emits-NDJSON, F27) is RUNTIME (p3) — not statically checkable here.
  }
  // M5c — event_translations keys ⇔ capability keys (closed both ways).
  const transKeys = Object.keys(manifest.event_translations || {});
  for (const k of transKeys) if (!capKeys.includes(k)) add("M5c", "error", `orphan event_translation ${JSON.stringify(k)} (no matching capability)`);
  for (const k of capKeys) if (!transKeys.includes(k)) add("M5c", "error", `capability ${JSON.stringify(k)} has no event_translation`);

  // M6 / M6b — taxonomy_ref + version equality (shared byte-equality comparison).
  if (manifest.taxonomy_ref !== "patterns/taxonomy.json") add("M6", "error", `taxonomy_ref must be "patterns/taxonomy.json"`);
  const cmp = [
    ["M6", "taxonomy_version", manifest.taxonomy_version, taxonomyVersion(taxonomy)],
    ["M6b", "events_version", manifest.events_version, eventsVersion(events)],
  ];
  for (const [check, field, actual, expected] of cmp) {
    if (actual !== expected) add(check, "error", `stale ${field}: manifest=${actual} live=${expected}`);
  }

  // M4a — capability honesty JOIN against bypass_known (F28). Every declared
  // {harness,event} needs EXACTLY ONE record; a ceiling below the declared tier
  // is dishonest; no record is a vacuity failure.
  for (const event of capKeys) {
    const matches = (bypassKnown.records || []).filter((r) => r.harness === harness && r.event === event);
    if (matches.length === 0) { add("M4a", "error", `no bypass_known record for ${harness}/${event} (F28 vacuity)`, { reason: "no_record" }); continue; }
    if (matches.length > 1) { add("M4a", "error", `${matches.length} bypass_known records for ${harness}/${event} (expected exactly one)`, { reason: "duplicate" }); continue; }
    const r = matches[0];
    if ("ceiling" in r) {
      const declaredTier = caps[event];
      if ((TIER_RANK[declaredTier] ?? 0) > (TIER_RANK[r.ceiling] ?? 0)) {
        add("M4a", "error", `${harness}/${event} declares ${declaredTier} but known bypass ceiling is ${r.ceiling} (dishonest)`, { reason: "ceiling_below_tier" });
      }
    }
  }

  // M9 — installed_state, when present, validates vs installed-state.schema.
  if (manifest.installed_state !== undefined) {
    const m9 = validateInstance(manifest.installed_state, schemas.installed_state);
    if (!m9.valid) for (const e of m9.errors) add("M9", "error", `installed_state ${e.path}: ${e.keyword} — ${e.detail}`);
  }

  // M7 / M7b — runbook presence + path-authority containment. pluginDir is the
  // authority root; canonicalize BOTH sides of startsWith (planner GAP-6). When
  // the plugin dir is not on disk (a cross-harness fixture), fall back lexically
  // so M4a-attributed fixtures still report sensibly.
  const pluginDirLex = path.join(root, "plugins", harness);
  let pluginDirReal;
  try { pluginDirReal = fs.realpathSync(pluginDirLex); }
  catch { pluginDirReal = pluginDirLex; add("M7", "error", `plugin dir ${path.relative(root, pluginDirLex)} does not exist`, { keyword: "plugin_dir_missing" }); }

  const runbookPaths = [
    ["full", manifest.runbook && manifest.runbook.full, MIN_RUNBOOK_FULL_BYTES],
    ["quickref", manifest.runbook && manifest.runbook.quickref, MIN_RUNBOOK_QUICKREF_BYTES],
  ];
  // override_path (when present) is authority-checked too, but not content-checked.
  const authorityPaths = [...runbookPaths.map(([k, p]) => [k, p]), ...(cls.override_path ? [["override_path", cls.override_path]] : [])];

  // M7b — authority. Lexical containment first (catches ../traversal + absolute
  // + out-of-authority in-repo paths); then symlink resolution (catches symlink
  // escape / loop / dangling) WITHOUT following an escaping link.
  const symlinkEscaped = new Set();
  for (const [key, p] of authorityPaths) {
    if (typeof p !== "string" || p.length === 0) continue;
    const absLex = path.resolve(root, p);
    if (!contained(absLex, pluginDirReal)) {
      add("M7b", "error", `${key} path ${JSON.stringify(p)} escapes plugin authority ${path.relative(root, pluginDirReal)}`, { keyword: "path_outside_authority", key });
      continue; // out of authority; do not resolve/read it
    }
    let real;
    try { real = fs.realpathSync(absLex); }
    catch (e) {
      if (e.code === "ELOOP") { add("M7b", "error", `${key} path ${JSON.stringify(p)} is a symlink loop`, { keyword: "symlink_loop", key }); symlinkEscaped.add(key); continue; }
      // ENOENT (or other): distinguish a dangling SYMLINK (M7b) from a plain missing file (left to M7).
      let isLink = false;
      try { isLink = fs.lstatSync(absLex).isSymbolicLink(); } catch { /* truly absent */ }
      if (isLink) { add("M7b", "error", `${key} path ${JSON.stringify(p)} is a dangling/unresolvable symlink`, { keyword: "dangling_symlink", key }); symlinkEscaped.add(key); }
      continue;
    }
    if (!contained(real, pluginDirReal)) {
      add("M7b", "error", `${key} path ${JSON.stringify(p)} symlink-resolves outside plugin authority`, { keyword: "symlink_escape", key });
      symlinkEscaped.add(key);
    }
  }

  // M7 — presence + byte-floor + sentinel + §-headers (existence only in P1b).
  // Read only IN-REPO, non-symlink-escape paths (never follow an escaping link
  // out of the repo). Out-of-authority in-repo paths are still byte-readable.
  let fullText = null;
  for (const [key, p, floor] of runbookPaths) {
    if (typeof p !== "string" || p.length === 0) { add("M7", "error", `runbook.${key} missing from manifest`); continue; }
    if (symlinkEscaped.has(key)) continue; // M7b already flagged; refuse to read the escape target
    const absLex = path.resolve(root, p);
    if (!contained(absLex, fs.realpathSync(root)) && !contained(absLex, root)) { continue; } // never read outside the repo
    let text;
    try { text = readMaybe(absLex); }
    catch { add("M7", "error", `runbook.${key} ${JSON.stringify(p)} does not exist`, { keyword: "missing", key }); continue; }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes < floor) add("M7", "error", `runbook.${key} is ${bytes} bytes (< ${floor} floor)`, { keyword: "byte_floor", key });
    if (key === "full") fullText = text;
  }
  if (fullText != null) {
    if (!fullText.split("\n").some((ln) => ln === RUNBOOK_SENTINEL)) {
      add("M7", "error", `runbook.full missing sentinel line ${JSON.stringify(RUNBOOK_SENTINEL)}`, { keyword: "sentinel" });
    }
    const fullLines = fullText.split("\n");
    for (const n of RUNBOOK_SECTION_NUMBERS) {
      // precise prefix "## §N " so "§1" is not trivially satisfied by "§10".
      if (!fullLines.some((ln) => ln.startsWith(`## §${n} `))) {
        add("M7", "error", `runbook.full missing section header §${n}`, { keyword: "section_header", marker: `§${n}` });
      }
    }
    // M7a — §1/§5 COMMON rows byte-match the scaffold template.
    const tmplPath = path.join(root, "scripts/scaffold-plugin/templates/common-rows.md");
    let tmpl = null;
    try { tmpl = readMaybe(tmplPath); } catch { add("M7a", "error", "scaffold-plugin/templates/common-rows.md missing"); }
    if (tmpl != null) {
      const block = extractCommonBlock(fullText);
      if (block == null) add("M7a", "error", `runbook.full missing COMMON block (${COMMON_BEGIN} … ${COMMON_END})`, { keyword: "common_block" });
      else if (block !== tmpl) add("M7a", "error", "runbook.full COMMON block does not byte-match common-rows.md template", { keyword: "common_drift" });
    }
  }
}

function extractCommonBlock(text) {
  // line-based: the COMMON block is every line strictly between the two marker
  // lines (each on its own line), joined with \n + a trailing \n. The scaffold
  // template common-rows.md must equal exactly that (M7a byte-match).
  const lines = text.split("\n");
  const b = lines.findIndex((l) => l.trim() === COMMON_BEGIN);
  const e = lines.findIndex((l) => l.trim() === COMMON_END);
  if (b === -1 || e === -1 || e <= b) return null;
  return lines.slice(b + 1, e).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Top-level orchestrator. Returns { status, project_root, checks, violations, read_trace }.
// ---------------------------------------------------------------------------
export function validateRegistry({ projectRoot, manifestPath = null, indexPath = null, bypassKnownPath = null, cwd = process.cwd() } = {}) {
  const read_trace = [];
  const violations = [];
  let checkCount = 0;
  const seenChecks = new Set();
  const add = (check, severity, detail, extra = {}) => { seenChecks.add(check); violations.push({ check, severity, detail, ...extra }); };

  let root;
  try { root = resolveProjectRoot(projectRoot, cwd); }
  catch (e) {
    // Usage/IO error BEFORE any registry read — read_trace stays empty (binding residual b).
    return { status: "usage_error", project_root: null, checks: 0, violations: [{ check: "project_root", severity: "error", detail: e.message }], read_trace, exit: 2 };
  }

  const readJson = (abs) => { const text = fs.readFileSync(abs, "utf8"); read_trace.push(abs); return JSON.parse(text); };
  const readMaybe = (abs) => { const text = fs.readFileSync(abs, "utf8"); read_trace.push(abs); return text; };

  let ctx;
  try { ctx = loadContext(root, readJson, bypassKnownPath); }
  catch (e) {
    return { status: "usage_error", project_root: root, checks: 0, violations: [{ check: "context", severity: "error", detail: e.message }], read_trace, exit: 2 };
  }

  if (manifestPath != null) {
    // --- single-manifest mode: manifest-intrinsic checks only (no _index/M8/M-cross).
    checkCount = 1;
    let manifest;
    try { manifest = readJson(resolveContained(root, manifestPath, "manifest")); }
    catch (e) { return { status: "usage_error", project_root: root, checks: 0, violations: [{ check: "manifest", severity: "error", detail: e.message }], read_trace, exit: 2 }; }
    validateManifest(ctx, manifest, root, readMaybe, add);
  } else {
    // --- live registry mode: version gate -> M1 -> per-entry type switch -> M-cross -> M8.
    let index;
    try {
      const indexAbs = indexPath != null ? resolveContained(root, indexPath, "index") : path.join(root, "plugins/_index.json");
      index = readJson(indexAbs);
    }
    catch (e) { return { status: "usage_error", project_root: root, checks: 0, violations: [{ check: "index", severity: "error", detail: e.message }], read_trace, exit: 2 }; }

    // typed/versioned gate on the RAW schema_version BEFORE M1 (pinned ordering, F4).
    const gate = gateSchemaVersion(index.schema_version, MAX_SUPPORTED);
    if (!gate.ok) add("typed_versioned", "error", gate.detail, { reason: gate.reason });

    // M1 — _index schema.
    const m1 = validateInstance(index, ctx.schemas._index);
    if (!m1.valid) for (const e of m1.errors) add("M1", "error", `${e.path}: ${e.keyword} — ${e.detail}`, { keyword: e.keyword });

    const plugins = Array.isArray(index.plugins) ? index.plugins : [];
    for (const entry of plugins) {
      // per-type dispatch (R8): enforcement -> full manifest gauntlet; substrate
      // capability types -> descriptor-only (gauntlet deferred P9); unknown -> reject.
      if (entry.type !== "enforcement") {
        if (!["recall-strategy", "store-strategy", "learning"].includes(entry.type)) {
          add("typed_versioned", "error", `entry ${JSON.stringify(entry.id)} has unknown type ${JSON.stringify(entry.type)}`);
        }
        continue; // descriptor-only types validated by the _index schema (M1); no manifest gauntlet
      }
      const manAbs = path.join(root, entry.manifest);
      let manifest;
      try { manifest = readJson(manAbs); }
      catch (e) { add("M2", "error", `entry ${entry.id} manifest unreadable: ${e.message}`); continue; }
      validateManifest(ctx, manifest, root, readMaybe, add);

      // M-cross (R8 L114 single-source-of-truth): registry must mirror the manifest.
      if (!deepEqualJson(entry.capabilities, manifest.capabilities)) {
        add("M-cross", "error", `entry ${entry.id} capabilities differ from manifest capabilities`, { keyword: "capabilities" });
      }
      if (entry.classifier !== (manifest.classifier && manifest.classifier.mode)) {
        add("M-cross", "error", `entry ${entry.id} classifier ${JSON.stringify(entry.classifier)} != manifest classifier.mode ${JSON.stringify(manifest.classifier && manifest.classifier.mode)}`, { keyword: "classifier" });
      }
    }

    // M8 — bidirectional dir↔entry, excluding RESERVED_DIRS.
    checkBidirectionalDirs(root, plugins, add, read_trace);
    checkCount = plugins.length;
  }

  // M7a/M7/M7b/etc. checks all recorded; compute status.
  const status = violations.some((v) => v.severity === "error") ? "fail" : "ok";
  return { status, project_root: root, checks: Math.max(checkCount, seenChecks.size), violations, read_trace, exit: status === "ok" ? 0 : 1 };
}

function deepEqualJson(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a == null || b == null) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqualJson(a[k], b[k])) return false; }
  return true;
}

export function checkBidirectionalDirs(root, plugins, add, read_trace) {
  const pluginsDir = path.join(root, "plugins");
  let dirents;
  try { dirents = fs.readdirSync(pluginsDir, { withFileTypes: true }); read_trace.push(pluginsDir); }
  catch (e) { add("M8", "error", `cannot read plugins/: ${e.message}`); return; }
  const onDiskDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  const entryDirs = new Set(plugins.map((p) => (typeof p.directory === "string" ? p.directory.replace(/^plugins\//, "") : null)).filter(Boolean));

  // direction 1: every on-disk dir is an entry OR reserved.
  for (const dir of onDiskDirs) {
    if (entryDirs.has(dir)) continue;
    if (dir in RESERVED_DIRS) continue; // exempt
    add("M8", "error", `plugins/${dir}/ has no _index entry and is not in RESERVED_DIRS`, { keyword: "orphan_dir", dir });
  }
  // direction 2: every entry dir exists on disk.
  for (const p of plugins) {
    const dir = typeof p.directory === "string" ? p.directory.replace(/^plugins\//, "") : null;
    if (dir && !onDiskDirs.includes(dir)) add("M8", "error", `_index entry directory plugins/${dir}/ does not exist on disk`, { keyword: "entry_dir_missing", dir });
  }
  // reserved-dir presence discipline: an "on-disk" reserved dir MUST exist (a typo
  // can't silently exempt a real orphan). "reserved-for-Follow" dirs are
  // annotation-only — asserted present in RESERVED_DIRS, not on disk (N2).
  for (const [name, meta] of Object.entries(RESERVED_DIRS)) {
    if (meta.presence === "on-disk" && !onDiskDirs.includes(name)) {
      add("M8", "error", `RESERVED_DIRS lists on-disk reserved dir plugins/${name}/ but it is absent (stale exemption risk)`, { keyword: "reserved_absent", dir: name });
    }
  }
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { project: null, manifest: null, index: null, bypassKnown: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--index") args.index = argv[++i];
    else if (a === "--bypass-known") args.bypassKnown = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  return args;
}

const HELP = `validate-plugin-registry.mjs — static plugin-registry conformance (RFC-008 P1b)

  --project <abs>        repo root (canonicalized; git never consulted when set)
  --manifest <path>      validate a single manifest (intrinsic checks only)
  --index <path>         inject the _index (version-gate / M-cross fixtures)
  --bypass-known <path>  inject the bypass registry (M4a self-negatives)
  --json                 machine-readable output
  --help                 this message

Exit: 0 pass, 1 violations, 2 usage/IO error.`;

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(e.message + "\n"); process.exit(2); }
  if (args.help) { process.stdout.write(HELP + "\n"); process.exit(0); }

  let result;
  try {
    result = validateRegistry({ projectRoot: args.project, manifestPath: args.manifest, indexPath: args.index, bypassKnownPath: args.bypassKnown });
  } catch (e) {
    // SchemaModelingError or unexpected — fail closed as a usage/IO error.
    process.stdout.write(JSON.stringify({ status: "usage_error", project_root: null, checks: 0, violations: [{ check: "internal", severity: "error", detail: e.message }], read_trace: [] }) + "\n");
    process.exit(2);
  }

  const { exit, ...payload } = result;
  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (payload.status === "ok") {
    process.stdout.write(`OK  validate-plugin-registry: ${payload.checks} check(s) passed for ${payload.project_root}\n`);
  } else {
    process.stderr.write(`FAIL  validate-plugin-registry (${payload.status}): ${payload.violations.length} violation(s)\n`);
    for (const v of payload.violations) process.stderr.write(`  ✗ [${v.check}] ${v.detail}\n`);
  }
  process.exit(exit);
}

// Run as CLI only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) main();
