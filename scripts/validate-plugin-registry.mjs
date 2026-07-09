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
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { validateInstance, assertAllSchemasModeled } from "./lib/json-instance-validate.mjs";
import { taxonomyVersion, eventsVersion } from "./lib/version-hash.mjs";
import { contained, resolveContained, UsageError } from "./lib/path-contain.mjs";
// The tier algebra (TIER_RANK / effectiveTier / eventActionId) lives in
// scripts/lib/effective-tier.mjs (extracted P3b-2, R3) so this validator's Table B
// rendering and enforce-contract's runtime stop decision share ONE algebra
// (Rule 14). No behavior change here — the self-tests prove it byte-for-byte.
import { TIER_RANK, effectiveTier, eventActionId, GATE_CONTRACT_KEY } from "./lib/effective-tier.mjs";

// --- closed vocabularies (re-asserted even where a schema already closes them) ---
export const MAX_SUPPORTED = "1.1.0"; // byte-equal'd to _corpus-index.current_schema_version (a test asserts equality). RFC-009 P2-S6 MINOR bump: registry gains the `activation` plugin type.
const HARNESS_IDS = ["claude-code", "opencode", "codex", "pi-agent", "cursor", "windsurf"];
export const EVENT_IDS = ["pre_tool_use", "tool_result", "stop", "session_start", "session_end"]; // exported for the Rule-14 binding check in tests/test-validate-bp-contract.mjs (EVENT_IDS ≡ live events[].id)
const TIERS = ["STRONG", "MEDIUM", "WEAK", "TBD"];
// TIER_RANK is imported from ./lib/effective-tier.mjs (extracted P3b-2).
const MIN_RUNBOOK_FULL_BYTES = 1024;
const MIN_RUNBOOK_QUICKREF_BYTES = 256;
const RUNBOOK_SENTINEL = "## ⚠️ Self-trigger checklist";
const RUNBOOK_SECTION_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const COMMON_BEGIN = "<!-- COMMON:BEGIN -->";
const COMMON_END = "<!-- COMMON:END -->";

// M7c–M7f content-derivation (P1c, F5 split). §7 + §10 each carry an
// auto-generated block fenced by BEGIN/END markers that the validator
// regenerates from manifest+taxonomy+events and byte-diffs (same enforcement
// boundary as M7a COMMON-row drift). §8 is a single derived line; §9 is a
// sentinel-anchored fenced JSON block, schema-validated + cross-checked.
const RESOLUTION_BEGIN = "<!-- RESOLUTION:BEGIN -->";
const RESOLUTION_END = "<!-- RESOLUTION:END -->";
const CONFIG_BEGIN = "<!-- CONFIG:BEGIN -->";
const CONFIG_END = "<!-- CONFIG:END -->";
const AGENT_MANIFEST_SENTINEL = "## 🤖 Agent invocation manifest";
const MODALITY_LINE_RE = /^\*\*Invocation modality:\*\*\s+(\S+)\s*$/;
const EVENT_ORDER = ["pre_tool_use", "tool_result", "stop", "session_start", "session_end"];
const RESOLUTION_GATES = ["plan_approval", "pre_checkpoint", "post_checkpoint"];

// RESERVED_DIRS (M8): a closed allowlist of plugins/ subdirs that are NOT
// enforcement plugins and so are exempt from the bidirectional dir↔entry rule.
// Each carries a presence disposition: "on-disk" reserved dirs must EXIST (so a
// typo can't silently exempt a real orphan, planner #13); "reserved-for-Follow"
// dirs do not exist yet and are annotation-only (claude-subagent N2).
export const RESERVED_DIRS = {
  "episodic-memory": { presence: "on-disk", why: "Claude-Code plugin packaging (.claude-plugin/, scripts/, skills/); exists on main." },
  "second-opinion": { presence: "on-disk", why: "RFC-008 L1257/R10 second-opinion runbooks fork; runbook-carrier (NOT an enforcement plugin — manifest.schema is enforcement-only), authored on disk by the Follow move." },
  // RFC-009 P2-S6: claude-code-activation is no longer a RESERVED (entry-less)
  // dir — plugins/_index.json now carries its real `activation` descriptor, so
  // the bidirectional dir↔entry check (M8) resolves it as a normal plugin dir.
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
// Path helpers. contained/resolveContained/UsageError were extracted verbatim
// to ./lib/path-contain.mjs in P2a (shared with P2b's validate-bp-contract);
// the UsageError -> exit-2 boundary stays here in main() (N-7).
// ---------------------------------------------------------------------------

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
    runbook_agent_manifest: readJson(path.join(root, "schemas/runbook-agent-manifest.schema.json")),
    activation_manifest: readJson(path.join(root, "plugins/activation-manifest.schema.json")),
  };
  assertAllSchemasModeled(schemas); // throws SchemaModelingError if any schema escapes the modeled subset
  const taxonomy = readJson(path.join(root, "patterns/taxonomy.json"));
  const events = readJson(path.join(root, "patterns/events.json"));
  const bypassAbs = bypassKnownPath != null ? resolveContained(root, bypassKnownPath, "bypass-known") : path.join(root, "plugins/bypass_known.json");
  const bypassKnown = readJson(bypassAbs);
  return { schemas, taxonomy, events, bypassKnown };
}

// ---------------------------------------------------------------------------
// Two-stage path-authority resolver — the SINGLE resolver shared by M7b
// (enforcement runbook/override_path authority) AND the activation A-runbook /
// A-io-schema checks. Extracted so the enforcement and activation surfaces
// CANNOT diverge (RFC-009 P2-S2 review F1/F2: a hand-rolled second resolver in
// validateActivationManifest followed symlinks that resolved outside the
// authority — asymmetric with M7b, which does NOT). Stage 1: lexical
// containment (catches ../ + absolute + out-of-authority in-repo). Stage 2:
// realpath resolution (catches loop / dangling / symlink-escape) WITHOUT
// following an escaping link. Emits violations via `add` under the caller's
// `check` name (M7b vs A-runbook/A-io-schema) with keyword-EXACT strings
// (path_outside_authority / symlink_loop / dangling_symlink / symlink_escape),
// so both surfaces classify identically. Returns a status the caller uses to
// decide whether to read the target and (for M7b) whether to mark it escaped:
//   "outside" | "loop" | "dangling"  -> violation added, DO NOT read
//   "escape"                          -> violation added, DO NOT read (+real)
//   "absent"                          -> no violation (a truly-missing NON-symlink;
//                                        the caller's own existence read reports it)
//   "ok"                              -> resolves inside authority (+real); read OK
function resolveAuthorityPath(absLex, authorityReal, dispPath, add, check, key, authorityDesc) {
  if (!contained(absLex, authorityReal)) {
    add(check, "error", `${key} path ${JSON.stringify(dispPath)} escapes ${authorityDesc}`, { keyword: "path_outside_authority", key });
    return { status: "outside" };
  }
  let real;
  try { real = fs.realpathSync(absLex); }
  catch (e) {
    if (e.code === "ELOOP") { add(check, "error", `${key} path ${JSON.stringify(dispPath)} is a symlink loop`, { keyword: "symlink_loop", key }); return { status: "loop" }; }
    // ENOENT (or other): distinguish a dangling SYMLINK from a plain missing file.
    let isLink = false;
    try { isLink = fs.lstatSync(absLex).isSymbolicLink(); } catch { /* truly absent */ }
    if (isLink) { add(check, "error", `${key} path ${JSON.stringify(dispPath)} is a dangling/unresolvable symlink`, { keyword: "dangling_symlink", key }); return { status: "dangling" }; }
    return { status: "absent" };
  }
  if (!contained(real, authorityReal)) {
    add(check, "error", `${key} path ${JSON.stringify(dispPath)} symlink-resolves outside ${authorityDesc}`, { keyword: "symlink_escape", key });
    return { status: "escape", real };
  }
  return { status: "ok", real };
}

// ---------------------------------------------------------------------------
// Per-manifest checks (M2–M7b). add(check, severity, detail, extra?) collects.
// ---------------------------------------------------------------------------
function validateManifest(ctx, manifest, root, readMaybe, add, opts = {}) {
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

  // M7b — authority. Delegates to the shared two-stage resolver (extracted P2-S2
  // review F1/F2 so activation reuses the SAME branches, never a parallel one).
  // A loop/dangling/escape status marks the key escaped so the M7 read loop below
  // refuses to read the target; outside/absent are left for M7's own read.
  const authorityDesc = `plugin authority ${path.relative(root, pluginDirReal)}`;
  const symlinkEscaped = new Set();
  for (const [key, p] of authorityPaths) {
    if (typeof p !== "string" || p.length === 0) continue;
    const absLex = path.resolve(root, p);
    const res = resolveAuthorityPath(absLex, pluginDirReal, p, add, "M7b", key, authorityDesc);
    if (res.status === "loop" || res.status === "dangling" || res.status === "escape") symlinkEscaped.add(key);
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

    // ---- M7c–M7f content derivation (P1c, F5 split). Gated to LIVE registry
    // mode (opts.contentChecks): content-derivation byte-equality is meaningful
    // only for the registry's DECLARED manifest↔runbook pairing, never a
    // single-manifest fixture injected against an unrelated runbook.
    if (opts.contentChecks) {
      // M7c — §7 resolution matrix byte-equals the regenerated tables.
      const resBlock = extractBetween(fullText, RESOLUTION_BEGIN, RESOLUTION_END);
      if (resBlock == null) add("M7c", "error", `runbook §7 missing RESOLUTION block (${RESOLUTION_BEGIN} … ${RESOLUTION_END})`, { keyword: "resolution_block" });
      else if (resBlock !== renderResolutionMatrix(manifest, taxonomy, events)) add("M7c", "error", "runbook §7 resolution matrix does not byte-match the derived tables (capabilities × taxonomy × R3 ternary)", { keyword: "resolution_drift" });

      // M7d — §8 modality line byte-equals manifest.invocation_modality.
      let modalityVal = null;
      for (const ln of fullText.split("\n")) { const m = MODALITY_LINE_RE.exec(ln); if (m) { modalityVal = m[1]; break; } }
      if (modalityVal == null) add("M7d", "error", `runbook §8 missing the "**Invocation modality:** <value>" line`, { keyword: "modality_missing" });
      else if (modalityVal !== manifest.invocation_modality) add("M7d", "error", `runbook §8 modality ${JSON.stringify(modalityVal)} != manifest.invocation_modality ${JSON.stringify(manifest.invocation_modality)}`, { keyword: "modality_drift" });

      // M7e — §9 agent-manifest sentinel + fenced JSON + schema + cross-field.
      validateAgentManifest(fullText, manifest, schemas, add);

      // M7f — §10 config/taxonomy cross-binding byte-equals derived source-of-truth.
      const cfgBlock = extractBetween(fullText, CONFIG_BEGIN, CONFIG_END);
      if (cfgBlock == null) add("M7f", "error", `runbook §10 missing CONFIG block (${CONFIG_BEGIN} … ${CONFIG_END})`, { keyword: "config_block" });
      else if (cfgBlock !== renderConfigBlock(manifest)) add("M7f", "error", "runbook §10 config/taxonomy block does not byte-match the derived source-of-truth (manifest)", { keyword: "config_drift" });
    }
  }
}

// ---------------------------------------------------------------------------
// Activation-manifest sub-gauntlet (RFC-009 R3, P2-S2). Mirrors validateManifest's
// shape but for the advisory activation adapter: schema check first (A2, the
// M2-analog — return early on failure since later checks assume valid shape),
// then content checks (id==harness, blocking==false re-assert, registration id
// uniqueness, checksum==file bytes, io_schema/runbook existence + path-authority
// containment under the PLUGIN dir `plugins/<harness>-activation`). Check names
// are A-prefixed (A2/A3/A4/A5/A-checksum/A-io-schema/A-runbook/A-plugin-dir) so
// they are distinguishable from the enforcement M-checks in one violations list.
// ---------------------------------------------------------------------------
// No `opts`/contentChecks param (P2-S2 review F4): activation carries no
// M7-style content-derivation gating, so there is nothing to gate — the dead
// param is removed rather than left as a misleading no-op. `readBytes` returns
// a raw Buffer (F3) so A-checksum hashes the exact on-disk bytes, not a
// UTF-8-re-encoded string (a non-UTF-8 hook body would otherwise false-mismatch).
function validateActivationManifest(ctx, manifest, root, readMaybe, readBytes, add) {
  const { schemas } = ctx;

  // A2 — schema (additionalProperties:false everywhere, incl. the blocking:false
  // const invariant). A schema failure means later checks may crash on missing
  // fields, so guard them here (mirrors M2).
  const a2 = validateInstance(manifest, schemas.activation_manifest);
  if (!a2.valid) {
    for (const e of a2.errors) add("A2", "error", `${e.path}: ${e.keyword} — ${e.detail}`, { keyword: e.keyword });
    return; // structure not trustworthy; do not run semantic checks
  }

  const harness = manifest.harness;

  // A3 — stable identity: id==harness (schema already closes both to the same
  // enum; re-assert the CROSS-field relationship, same discipline as M3).
  if (manifest.id !== harness) add("A3", "error", `id ${JSON.stringify(manifest.id)} must equal harness ${JSON.stringify(harness)}`);

  // A4 — advisory-only invariant re-assert. Schema already pins `blocking` to a
  // const false, so this can only fire if the schema check above were somehow
  // bypassed; kept as defense-in-depth (mirrors the M3 HARNESS_IDS re-assert).
  if (manifest.blocking !== false) add("A4", "error", `blocking must be false (advisory-only invariant), got ${JSON.stringify(manifest.blocking)}`);

  // A5 — registration ids unique (schema pins the per-id PATTERN; this is the SET check).
  const regs = Array.isArray(manifest.registrations) ? manifest.registrations : [];
  const ids = regs.map((r) => r.id).filter((id) => typeof id === "string" && id.length > 0);
  if (new Set(ids).size !== ids.length) add("A5", "error", `registration ids are not unique: ${JSON.stringify(ids)}`);

  // Plugin dir authority: plugins/<harness>-activation (RFC-009 activation
  // plugin directory naming — sibling to, not the same as, plugins/<harness>).
  const pluginDirLex = path.join(root, "plugins", `${harness}-activation`);
  let pluginDirReal;
  try { pluginDirReal = fs.realpathSync(pluginDirLex); }
  catch { pluginDirReal = pluginDirLex; add("A-plugin-dir", "error", `plugin dir ${path.relative(root, pluginDirLex)} does not exist`, { keyword: "plugin_dir_missing" }); }

  // A-checksum — each registration's declared checksum matches the on-disk hook
  // file bytes (the S2 ordering-decision guardrail: S4/S5 replace hook bodies
  // and must refresh these 3 checksums, or this check reddens). Hashes the raw
  // Buffer from readBytes (F3) — NOT a UTF-8-decoded string — so a future
  // non-UTF-8 hook body cannot false-mismatch via U+FFFD re-encoding. Single
  // read (readBytes), never a double-read.
  for (const r of regs) {
    if (typeof r.file !== "string" || r.file.length === 0) continue; // shape already flagged by A2
    const absLex = path.join(pluginDirReal, "hooks", r.file);
    if (!contained(absLex, pluginDirReal)) { add("A-checksum", "error", `registration ${JSON.stringify(r.id)} file ${JSON.stringify(r.file)} escapes plugin authority`, { keyword: "path_outside_authority" }); continue; }
    let buf;
    try { buf = readBytes(absLex); }
    catch (e) { add("A-checksum", "error", `registration ${JSON.stringify(r.id)} hook file ${JSON.stringify(r.file)} unreadable: ${e.message}`, { keyword: "missing" }); continue; }
    const actual = "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
    if (actual !== r.checksum) add("A-checksum", "error", `registration ${JSON.stringify(r.id)} checksum mismatch: manifest=${JSON.stringify(r.checksum)} actual=${actual}`, { keyword: "checksum_mismatch" });
  }

  // A-support-checksum — OWNED but non-registration hook artifacts declared in
  // `support_files` (the R3 runner activation-hook-run.mjs the .sh wrappers
  // exec). ALL the event-plane logic lives in the runner, so tampering with it
  // must redden a checksum (codex P2-S4 review F1) exactly like a .sh body would.
  // Same authority/containment/readBytes path as A-checksum (not hand-rolled).
  // Optional: an absent `support_files` runs no check.
  const supportFiles = Array.isArray(manifest.support_files) ? manifest.support_files : [];
  for (const sf of supportFiles) {
    if (typeof sf.file !== "string" || sf.file.length === 0) continue; // shape already flagged by A2
    const absLex = path.join(pluginDirReal, "hooks", sf.file);
    if (!contained(absLex, pluginDirReal)) { add("A-support-checksum", "error", `support file ${JSON.stringify(sf.file)} escapes plugin authority`, { keyword: "path_outside_authority" }); continue; }
    let buf;
    try { buf = readBytes(absLex); }
    catch (e) { add("A-support-checksum", "error", `support file ${JSON.stringify(sf.file)} unreadable: ${e.message}`, { keyword: "missing" }); continue; }
    const actual = "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
    if (actual !== sf.checksum) add("A-support-checksum", "error", `support file ${JSON.stringify(sf.file)} checksum mismatch: manifest=${JSON.stringify(sf.checksum)} actual=${actual}`, { keyword: "checksum_mismatch" });
  }

  // A-io-schema — io_schema resolves to an EXISTING file, contained under the
  // PROJECT root (it lives at schemas/runtime/, outside the plugin dir). Uses
  // the shared two-stage resolver (F2) so a symlink at that path escaping the
  // project root is caught (symlink_escape), not silently followed. rootReal is
  // the canonical project root the resolver contains against.
  if (typeof manifest.io_schema === "string" && manifest.io_schema.length > 0) {
    const absLex = path.resolve(root, manifest.io_schema);
    let rootReal;
    try { rootReal = fs.realpathSync(root); } catch { rootReal = root; }
    const res = resolveAuthorityPath(absLex, rootReal, manifest.io_schema, add, "A-io-schema", "io_schema", "project authority");
    // "ok" -> exists inside authority; "absent" -> a truly-missing non-symlink,
    // which we surface as the plain missing-file error via the existence read.
    // outside/loop/dangling/escape were already flagged by the resolver — refuse to read.
    if (res.status === "ok" || res.status === "absent") {
      try { readMaybe(absLex); }
      catch { add("A-io-schema", "error", `io_schema ${JSON.stringify(manifest.io_schema)} does not exist`, { keyword: "missing" }); }
    }
  }

  // A-runbook — full+quickref exist, path-authority CONTAINED UNDER THE PLUGIN
  // DIR, resolved through the SAME two-stage resolver M7b uses (F1): a runbook
  // path that is a symlink living inside the plugin dir but resolving OUTSIDE it
  // is caught (symlink_escape), never followed. Existence-only (no byte-floor /
  // sentinel) — the activation runbook carries no M7-style content-derivation.
  const runbookPaths = [
    ["full", manifest.runbook && manifest.runbook.full],
    ["quickref", manifest.runbook && manifest.runbook.quickref],
  ];
  const runbookAuthorityDesc = `plugin authority ${path.relative(root, pluginDirReal)}`;
  for (const [key, p] of runbookPaths) {
    if (typeof p !== "string" || p.length === 0) { add("A-runbook", "error", `runbook.${key} missing from manifest`); continue; }
    const absLex = path.resolve(root, p);
    const res = resolveAuthorityPath(absLex, pluginDirReal, p, add, "A-runbook", key, runbookAuthorityDesc);
    if (res.status === "ok" || res.status === "absent") {
      try { readMaybe(absLex); }
      catch { add("A-runbook", "error", `runbook.${key} ${JSON.stringify(p)} does not exist`, { keyword: "missing", key }); }
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

// Inner lines strictly between two marker lines, joined with \n (NO trailing
// newline — the §7/§10 generators emit the same shape, so the embedded runbook
// block byte-equals the generator output exactly).
function extractBetween(text, begin, end) {
  const lines = text.split("\n");
  const b = lines.findIndex((l) => l.trim() === begin);
  const e = lines.findIndex((l) => l.trim() === end);
  if (b === -1 || e === -1 || e <= b) return null;
  return lines.slice(b + 1, e).join("\n");
}

// ---------------------------------------------------------------------------
// §7 / §10 content GENERATORS (M7c / M7f). Single source of truth: the runbook
// embeds EXACTLY these strings between the markers; the validator regenerates +
// byte-diffs. One pure function per block — no author discretion (plan H1).
// ---------------------------------------------------------------------------

// effective_tier (min over PRESENT tier sources, null on all-absent) and
// eventActionId are imported from ./lib/effective-tier.mjs (extracted P3b-2, R3).
// On main only harness_cap exists; the min() folds contract/project_config tiers
// the moment a degrading contract/config lands, so the rendered table never
// silently lies. enforce-contract.mjs imports the SAME algebra (Rule 14).
export function renderResolutionMatrix(manifest, taxonomy, events) {
  const caps = manifest.capabilities || {};
  const emits = (manifest.classifier && manifest.classifier.emits_labels) || [];
  const nonOverridable = new Set(taxonomy.non_overridable || []);
  const labelById = new Map((taxonomy.labels || []).map((l) => [l.id, l]));

  // Table A — one column per canonical event; cell = declared tier or em-dash.
  const aHead = `| ${EVENT_ORDER.map((e) => "`" + e + "`").join(" | ")} |`;
  const aSep = `|${EVENT_ORDER.map(() => "---").join("|")}|`;
  const aRow = `| ${EVENT_ORDER.map((e) => caps[e] || "—").join(" | ")} |`;

  // Checkpoint-gate columns degrade by effective_tier(pre_tool_use); the stop
  // column is label-INDEPENDENT (F10) — same action for every row.
  const effPre = effectiveTier([caps.pre_tool_use]);
  const stopCell = eventActionId(events, "stop", effectiveTier([caps.stop]));

  const bRows = emits.map((label) => {
    const gates = (labelById.get(label) || {}).gates || {};
    const cells = RESOLUTION_GATES.map((g) =>
      gates[g] === "allow" ? "allow" : eventActionId(events, "pre_tool_use", effPre),
    );
    const mark = nonOverridable.has(label) ? " †" : "";
    return `| \`${label}\`${mark} | ${cells.join(" | ")} | ${stopCell} |`;
  });

  return [
    "**Table A — Per-event capability declaration.**",
    "",
    aHead, aSep, aRow,
    "",
    "**Table B — Resolved gate × label action grid** (cell = taxonomy policy degraded by `effective_tier`).",
    "",
    "| Label | plan_approval | pre_checkpoint | post_checkpoint | stop |",
    "|---|---|---|---|---|",
    ...bRows,
    "",
    "`†` non-overridable label — cells immutable regardless of plugin (`taxonomy.non_overridable`).",
    "`stop` is label-independent: `effective_tier(stop) = min(harness_cap.stop, …)` reads marker state, not the command label (F10).",
  ].join("\n");
}

export function renderConfigBlock(manifest) {
  const cls = manifest.classifier || {};
  const emits = cls.emits_labels || [];
  const trans = manifest.event_translations || {};
  const consumes = Object.keys(manifest.capabilities || {});
  // RFC-008 P4: enforce_config_keys derived from GATE_CONTRACT_KEY (Rule-14 single
  // source — same gate set the runtime resolver clamps; a drift here vs the runbook
  // fails M7f loud). `active` is the R5 project switch; the per-bp tier clamps are
  // the four contract gates this plugin reads from enforce-config.json.
  const ecGateKeys = Object.keys(GATE_CONTRACT_KEY).sort().join(",");
  const out = [
    "**10a — Configuration.**",
    "",
    `- \`enforce_config_keys\`: \`active\` (R5 project switch) + \`bp-001.{${ecGateKeys}}\` per-bp tier clamps (RFC-008 P4; schema \`patterns/enforce-config.schema.json\`; clamp-DOWN only; resolved by \`enforce-contract --gate stop\` / \`--resolve-gate <gate>\`).`,
    "- `install_time_config`: enforcement hooks deployed per-project under `<project>/.claude/` (or `<project>/.opencode/`), NEVER `~/.claude/` (Principle 12), by `install.mjs --install-hooks` / `--install-enforcement`.",
    "",
    "**10b — Taxonomies.**",
    "",
    `- \`taxonomy_ref\`: \`${manifest.taxonomy_ref}\``,
    `- \`taxonomy_version\`: \`${manifest.taxonomy_version}\``,
    `- \`emits_labels\`: ${emits.map((l) => "`" + l + "`").join(", ")}`,
    `- \`consumes_events\`: ${consumes.map((e) => "`" + e + "`").join(", ")}`,
    "- `event_translations_summary`:",
  ];
  for (const e of consumes) out.push(`  - \`${e}\`: \`${trans[e] && trans[e].source_format}\``);
  return out.join("\n");
}

// M7e — §9 agent-manifest: sentinel + fenced JSON + schema + cross-field. Pushes
// structured violations via `add`. Maps to F49/F50/F57/F64/F66 (R6, R10).
function validateAgentManifest(fullText, manifest, schemas, add) {
  const lines = fullText.split("\n");
  const sIdx = lines.findIndex((l) => l === AGENT_MANIFEST_SENTINEL);
  if (sIdx === -1) { add("M7e", "error", `runbook §9 missing sentinel ${JSON.stringify(AGENT_MANIFEST_SENTINEL)} at column 1`, { keyword: "sentinel" }); return; }
  let fenceStart = -1;
  for (let i = sIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "```json") { fenceStart = i; break; }
    if (lines[i].startsWith("## ")) break; // hit the next section before any fence
  }
  if (fenceStart === -1) { add("M7e", "error", "runbook §9 sentinel not followed by a ```json fenced block", { keyword: "fence_missing" }); return; }
  let fenceEnd = -1;
  for (let i = fenceStart + 1; i < lines.length; i++) { if (lines[i].trim() === "```") { fenceEnd = i; break; } }
  if (fenceEnd === -1) { add("M7e", "error", "runbook §9 ```json fence is not closed", { keyword: "fence_unclosed" }); return; }

  let am;
  try { am = JSON.parse(lines.slice(fenceStart + 1, fenceEnd).join("\n")); }
  catch (e) { add("M7e", "error", `runbook §9 agent-manifest JSON parse error: ${e.message}`, { keyword: "json_parse" }); return; }

  const v = validateInstance(am, schemas.runbook_agent_manifest);
  if (!v.valid) { for (const e of v.errors) add("M7e", "error", `§9 agent-manifest ${e.path}: ${e.keyword} — ${e.detail}`, { keyword: "schema" }); return; }

  // cross-field consistency (beyond what the schema alone can assert).
  if (am.invocation_modality !== manifest.invocation_modality) {
    add("M7e", "error", `§9 invocation_modality ${JSON.stringify(am.invocation_modality)} != manifest ${JSON.stringify(manifest.invocation_modality)}`, { keyword: "modality_xfield" });
  }
  if (am.invocation_modality === "api") {
    if (!am.credentials || typeof am.credentials.mechanism !== "string") add("M7e", "error", "§9 api modality requires credentials.mechanism", { keyword: "credentials_required" });
    if (!Array.isArray(am.log_paths)) add("M7e", "error", "§9 api modality requires log_paths (possibly empty, F64)", { keyword: "log_paths_required" });
  } else if (am.credentials && am.credentials.mechanism !== "none") {
    add("M7e", "error", `§9 non-api modality must have credentials absent or mechanism:"none", got ${JSON.stringify(am.credentials.mechanism)}`, { keyword: "credentials_nonapi" });
  }
  for (const er of am.env_requirements || []) {
    if (er.redaction_pattern != null) {
      try { new RegExp(er.redaction_pattern); }
      catch (e) { add("M7e", "error", `§9 env_requirements[${er.name}].redaction_pattern not a compilable regex: ${e.message}`, { keyword: "redaction_regex" }); }
    }
  }
  // posix forward-slash invariant on every command_shapes / dispatch_examples token
  // (the schema's posixPath only covers log_paths/config_path; argv tokens are posixSafeString).
  const argvTokens = [
    ...(am.command_shapes || []).flat(),
    ...(am.dispatch_examples || []).flatMap((d) => d.argv || []),
  ];
  for (const tok of argvTokens) {
    if (typeof tok === "string" && tok.includes("\\")) add("M7e", "error", `§9 argv token ${JSON.stringify(tok)} contains a backslash (forward-slash invariant, F58)`, { keyword: "backslash" });
  }
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
  // readBytes returns the raw Buffer (no utf8 decode) so the activation
  // A-checksum hashes exact on-disk bytes (P2-S2 review F3).
  const readBytes = (abs) => { const buf = fs.readFileSync(abs); read_trace.push(abs); return buf; };

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
    if (manifest.type === "activation") validateActivationManifest(ctx, manifest, root, readMaybe, readBytes, add);
    else validateManifest(ctx, manifest, root, readMaybe, add);
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
      // per-type dispatch (R8): enforcement -> full manifest gauntlet; activation
      // (RFC-009 R3, P2-S2) -> activation sub-gauntlet; other substrate capability
      // types -> descriptor-only (gauntlet deferred P9); unknown -> reject.
      if (entry.type === "activation") {
        const manAbs = path.join(root, entry.manifest);
        let manifest;
        try { manifest = readJson(manAbs); }
        catch (e) { add("A2", "error", `entry ${entry.id} manifest unreadable: ${e.message}`); continue; }
        validateActivationManifest(ctx, manifest, root, readMaybe, readBytes, add);

        // A-cross (M-cross analog): registry entry must mirror the manifest's
        // declared capabilities — single-source-of-truth (R8 L114).
        if (!deepEqualJson(entry.capabilities, manifest.capabilities)) {
          add("A-cross", "error", `entry ${entry.id} capabilities differ from manifest capabilities`, { keyword: "capabilities" });
        }
        continue;
      }
      if (entry.type !== "enforcement") {
        // Substrate capability types (recall-strategy/store-strategy/learning):
        // descriptor-only (gauntlet deferred, P9); unknown type -> reject.
        if (!["recall-strategy", "store-strategy", "learning"].includes(entry.type)) {
          add("typed_versioned", "error", `entry ${JSON.stringify(entry.id)} has unknown type ${JSON.stringify(entry.type)}`);
        }
        continue; // descriptor-only types validated by the _index schema (M1); no manifest gauntlet
      }
      const manAbs = path.join(root, entry.manifest);
      let manifest;
      try { manifest = readJson(manAbs); }
      catch (e) { add("M2", "error", `entry ${entry.id} manifest unreadable: ${e.message}`); continue; }
      validateManifest(ctx, manifest, root, readMaybe, add, { contentChecks: true });

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
// pathToFileURL, not `file://${argv[1]}`: a path needing URL-encoding (space,
// non-ASCII) makes the raw template compare false -> main() never runs ->
// exit 0 with empty output, a vacuous green for the CI gate (P2a step-6 F4;
// same fix as validate-schemas.mjs, pattern from test-plugin.mjs:361).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
