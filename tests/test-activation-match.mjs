#!/usr/bin/env node
// test-activation-match.mjs — RFC-009 P2-S3 (R3) Group 1 tests for the pure
// matcher core, scripts/lib/activation-match.mjs.
//
// Fixtures are built against the REAL trigger-index.json entry shape,
// behavior-simulated on an isolated fixture store before this file was
// written (em-store + em-trigger-index, explicit cwd, --scope local):
//   { trigger_kind, value, episode_id, summary, effective_priority,
//     applies_to_projects, applies_to_tools, review_by? }
// and the REAL top-level `activity_phrases` bake (loaded straight from the
// repo's activation-classes.json, the same source em-trigger-index.mjs bakes
// from) rather than an invented phrase list.
//
// Every one of the plan §12 contract states (A-K) is exercised at least once;
// the full Group 1 catalog (plan §14) is covered by name.
//
// Run: node tests/test-activation-match.mjs   (exit 0 = pass)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchActivation } from "../scripts/lib/activation-match.mjs";
import { validateInstance } from "../scripts/lib/json-instance-validate.mjs";

const REPO = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

let pass = 0, fail = 0;
const failures = [];
const ok = () => pass++;
const bad = (n, d) => { fail++; failures.push(`${n}${d ? " — " + d : ""}`); };
const assert = (c, n, d) => (c ? ok() : bad(n, d));

// ---------------------------------------------------------------------------
// Real activity phrase bake — same source em-trigger-index.mjs bakes from.
// ---------------------------------------------------------------------------
const classesDoc = JSON.parse(fs.readFileSync(path.join(REPO, "activation-classes.json"), "utf8"));
const BAKED_PHRASES = {};
for (const c of classesDoc.classes) {
  if (c.deprecated_for) continue;
  BAKED_PHRASES[c.name] = c.phrases;
}
const LAUNCH_CLASSES = ["plan", "design", "review", "troubleshoot", "implement", "push", "rule"];

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function entry(overrides) {
  return {
    trigger_kind: "phrase",
    value: "placeholder",
    episode_id: "20260701-000000-placeholder-aaaa",
    summary: "a fixture summary",
    effective_priority: 5,
    applies_to_projects: ["acme"],
    applies_to_tools: ["claude-code"],
    ...overrides,
  };
}
function idx(entries, activityPhrases) {
  return { entries, activity_phrases: activityPhrases === undefined ? BAKED_PHRASES : activityPhrases };
}
const IDENTITY = { slug: "acme", root: "/repo/acme", tool_id: "claude-code" };
const BOUNDS = { max_matches: 3, max_tokens: 500 };
const promptEvent = (prompt) => ({ kind: "prompt", prompt });
const toolEvent = (tool, target) => ({ kind: "tool", tool, target });

// ===========================================================================
// 1-3. Phrase match (REQ-6)
// ===========================================================================
{
  const index = idx([entry({ value: "plan", episode_id: "id-wb" })]);
  const hit = matchActivation(index, promptEvent("we need to plan this out"), IDENTITY, undefined, BOUNDS);
  const miss = matchActivation(index, promptEvent("planning this out"), IDENTITY, undefined, BOUNDS);
  assert(hit.lines.length === 1 && hit.lines[0].includes("id-wb"), "match_phrase_word_boundary: standalone word matches", JSON.stringify(hit));
  assert(miss.lines.length === 0, "match_phrase_word_boundary: substring-within-word does not match", JSON.stringify(miss));
}
{
  const index = idx([entry({ value: "Deploy", episode_id: "id-cf" })]);
  const r = matchActivation(index, promptEvent("time to DEPLOY now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1, "match_case_fold: case-insensitive phrase match", JSON.stringify(r));
}
{
  const index = idx([entry({ value: "a.b(c)*", episode_id: "id-mc" })]);
  let threw = false;
  let r1, r2;
  try {
    r1 = matchActivation(index, promptEvent("literally a.b(c)* here"), IDENTITY, undefined, BOUNDS);
    r2 = matchActivation(index, promptEvent("axbxcxx nothing like it"), IDENTITY, undefined, BOUNDS);
  } catch {
    threw = true;
  }
  assert(!threw, "match_regex_metachar_literal: no throw on regex-metachar phrase");
  assert(r1 && r1.lines.length === 1, "match_regex_metachar_literal: metachar phrase matches literally", JSON.stringify(r1));
  assert(r2 && r2.lines.length === 0, "match_regex_metachar_literal: metachars not treated as regex wildcards", JSON.stringify(r2));
}

// ===========================================================================
// 4-7. Tool match (REQ-7)
// ===========================================================================
{
  const index = idx([entry({ trigger_kind: "tool", value: "tool:Bash:rm *", episode_id: "id-bg" })]);
  const hit = matchActivation(index, toolEvent("Bash", "rm -rf /tmp/x"), IDENTITY, undefined, BOUNDS);
  const miss = matchActivation(index, toolEvent("Bash", "ls -la"), IDENTITY, undefined, BOUNDS);
  assert(hit.lines.length === 1, "match_tool_bash_glob: glob-matching command fires", JSON.stringify(hit));
  assert(miss.lines.length === 0, "match_tool_bash_glob: non-matching command does not fire", JSON.stringify(miss));
}
{
  const index = idx([entry({ trigger_kind: "tool", value: "tool:Edit:src/*.mjs", episode_id: "id-ef" })]);
  const hit = matchActivation(index, toolEvent("Edit", "src/foo.mjs"), IDENTITY, undefined, BOUNDS);
  const missDir = matchActivation(index, toolEvent("Edit", "test/foo.mjs"), IDENTITY, undefined, BOUNDS);
  const missExt = matchActivation(index, toolEvent("Edit", "src/foo.js"), IDENTITY, undefined, BOUNDS);
  assert(hit.lines.length === 1, "match_tool_edit_filepath: file_path glob fires", JSON.stringify(hit));
  assert(missDir.lines.length === 0, "match_tool_edit_filepath: wrong dir prefix does not fire", JSON.stringify(missDir));
  assert(missExt.lines.length === 0, "match_tool_edit_filepath: wrong extension does not fire", JSON.stringify(missExt));
}
{
  const index = idx([entry({ trigger_kind: "tool", value: "tool:Bash:foo\\*bar", episode_id: "id-esc" })]);
  const hit = matchActivation(index, toolEvent("Bash", "foo*bar"), IDENTITY, undefined, BOUNDS);
  const miss = matchActivation(index, toolEvent("Bash", "fooXbar"), IDENTITY, undefined, BOUNDS);
  assert(hit.lines.length === 1, "match_escaped_glob: escaped asterisk matches the literal char", JSON.stringify(hit));
  assert(miss.lines.length === 0, "match_escaped_glob: escaped asterisk is not a wildcard", JSON.stringify(miss));
}
{
  const index = idx([entry({ trigger_kind: "tool", value: "tool:Read:*", episode_id: "id-unk" })]);
  const r = matchActivation(index, toolEvent("Read", ""), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1, "tool_hook_unknown_tool_name_only: name-alone match with empty target", JSON.stringify(r));
}

// ===========================================================================
// 8-14. Activity match, all 7 launch classes (REQ-8/9)
// ===========================================================================
for (const cls of LAUNCH_CLASSES) {
  const phrase = BAKED_PHRASES[cls][0];
  const index = idx([entry({ trigger_kind: "activity", value: `activity:${cls}`, episode_id: `id-act-${cls}` })]);
  const r = matchActivation(index, promptEvent(`let's talk about ${phrase} together`), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1 && r.lines[0].includes(`id-act-${cls}`), `match_activity_${cls}: baked phrase "${phrase}" fires the activity trigger`, JSON.stringify(r));
}

// ===========================================================================
// 15. activity_class_complete_has_phrases
// ===========================================================================
{
  const names = Object.keys(BAKED_PHRASES);
  const allSeven = LAUNCH_CLASSES.every((c) => names.includes(c) && Array.isArray(BAKED_PHRASES[c]) && BAKED_PHRASES[c].length > 0);
  assert(allSeven, "activity_class_complete_has_phrases: all 7 launch classes carry a non-empty baked phrase set", JSON.stringify(BAKED_PHRASES));
}

// ===========================================================================
// 16. activity_proto_key_no_match (state K, EC8)
// ===========================================================================
{
  const index = idx([
    entry({ trigger_kind: "activity", value: "activity:__proto__", episode_id: "id-proto1" }),
    entry({ trigger_kind: "activity", value: "activity:hasOwnProperty", episode_id: "id-proto2" }),
    entry({ trigger_kind: "activity", value: "activity:constructor", episode_id: "id-proto3" }),
  ]);
  let threw = false;
  let r;
  try {
    r = matchActivation(index, promptEvent("anything at all, constructor toString valueOf"), IDENTITY, undefined, BOUNDS);
  } catch {
    threw = true;
  }
  assert(!threw, "activity_proto_key_no_match: no throw on proto-key class names");
  assert(r && r.lines.length === 0, "activity_proto_key_no_match: __proto__/hasOwnProperty/constructor never match", JSON.stringify(r));
}

// ===========================================================================
// 17. activity_unknown_skipped
// ===========================================================================
{
  const index = idx([entry({ trigger_kind: "activity", value: "activity:bogus-unknown-class", episode_id: "id-unkcls" })]);
  const r = matchActivation(index, promptEvent("totally unrelated prompt text"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "activity_unknown_skipped: unknown class name never matches, no throw", JSON.stringify(r));
}

// ===========================================================================
// 18. bounds_max_matches (state G — overflow, no critical dropped)
// ===========================================================================
{
  const entries = [3, 4, 5, 6, 7].map((p, i) =>
    entry({ value: "widget", episode_id: `20260${70 + i}01-000000-w-${i}`, effective_priority: p, summary: `s${p}` }));
  const index = idx(entries);
  const r = matchActivation(index, promptEvent("the widget needs attention"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 3, "bounds_max_matches: selection capped at max_matches", JSON.stringify(r));
  assert(r.overflowNote === null, "bounds_max_matches (state G): overflow with no critical dropped emits no note", JSON.stringify(r));
}

// ===========================================================================
// 19. bounds_oversize_dropped (state I' — oversize, non-critical)
// ===========================================================================
{
  const bigSummary = "x".repeat(2600); // ~650 tokens at ~4 chars/token, > max_tokens(500)
  const index = idx([entry({ value: "gadget", episode_id: "id-oversize", effective_priority: 5, summary: bigSummary })]);
  const r = matchActivation(index, promptEvent("the gadget broke"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "bounds_oversize_dropped: oversize non-critical entry dropped whole", JSON.stringify({ lines: r.lines.length }));
  assert(r.overflowNote === null, "bounds_oversize_dropped (state I'): non-critical oversize drop emits no note", JSON.stringify(r));
}

// ===========================================================================
// bounds_negative_failopen (codex F2): zero/negative bounds must NOT emit a
// spurious critical note with empty lines — they fall back to the defaults.
// ===========================================================================
{
  const index = idx([entry({ value: "boundcrit", episode_id: "id-bc", effective_priority: 9 })]);
  const neg = matchActivation(index, promptEvent("boundcrit now"), IDENTITY, undefined, { max_matches: -1, max_tokens: -5 });
  const zero = matchActivation(index, promptEvent("boundcrit now"), IDENTITY, undefined, { max_matches: 0, max_tokens: 0 });
  assert(neg.overflowNote === null, "bounds_negative_failopen: negative bounds never yield a note with empty lines", JSON.stringify(neg));
  assert(zero.overflowNote === null, "bounds_negative_failopen: zero bounds never yield a note with empty lines", JSON.stringify(zero));
  // defaulted behavior: a single band-9 match within the default budget renders.
  assert(neg.lines.length === 1 && zero.lines.length === 1, "bounds_negative_failopen: out-of-range bounds fall back to defaults (entry still renders)", JSON.stringify({ neg: neg.lines, zero: zero.lines }));
}

// ===========================================================================
// 20-22. Render (REQ-11)
// ===========================================================================
{
  const index = idx([entry({ value: "criticalthing", episode_id: "id-band8", effective_priority: 8, summary: "do the thing" })]);
  const r = matchActivation(index, promptEvent("criticalthing happened"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1, "render_imperative_band8: one line rendered", JSON.stringify(r));
  assert(
    r.lines[0] === "READ id-band8 before proceeding (em-search --history id-band8 --full): do the thing",
    "render_imperative_band8: exact imperative form naming the tracked read command",
    r.lines[0],
  );
}
{
  const index = idx([entry({ value: "plainthing", episode_id: "id-band7", effective_priority: 7, summary: "note this" })]);
  const r = matchActivation(index, promptEvent("plainthing happened"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1 && r.lines[0] === "lesson id-band7: note this", "render_plain_band7: exact plain form, no imperative wording", JSON.stringify(r));
}
{
  // render_no_decision_field — across a representative sample of the 11 states.
  const bigSummary = "x".repeat(2600);
  const overflowEntries = ["9", "9", "9", "9"].map((p, i) =>
    entry({ value: "overflowthing", episode_id: `2026070${i}-000000-of-${i}`, effective_priority: Number(p) }));
  const samples = [
    matchActivation({}, promptEvent("plan"), IDENTITY, undefined, BOUNDS), // A
    matchActivation(idx([entry({ value: "zzz" })]), promptEvent("no overlap here"), IDENTITY, undefined, BOUNDS), // B
    matchActivation(idx([entry({ value: "plainmatch", episode_id: "id-c", effective_priority: 5 })]), promptEvent("plainmatch now"), IDENTITY, undefined, BOUNDS), // C
    matchActivation(idx([entry({ value: "critmatch", episode_id: "id-d", effective_priority: 9 })]), promptEvent("critmatch now"), IDENTITY, undefined, BOUNDS), // D
    matchActivation(idx([entry({ value: "supp", episode_id: "id-e", effective_priority: 9 })]), promptEvent("supp now"), IDENTITY, new Set(["id-e"]), BOUNDS), // E
    matchActivation(idx([entry({ value: "scopeoff", episode_id: "id-f", applies_to_projects: ["other"] })]), promptEvent("scopeoff now"), IDENTITY, undefined, BOUNDS), // F
    matchActivation(idx(overflowEntries), promptEvent("overflowthing now"), IDENTITY, undefined, BOUNDS), // G/H depending on ids
    matchActivation(idx([entry({ value: "oversizecrit", episode_id: "id-i", effective_priority: 9, summary: bigSummary })]), promptEvent("oversizecrit now"), IDENTITY, undefined, BOUNDS), // I
    matchActivation(idx([entry({ value: "oversizeplain", episode_id: "id-iprime", effective_priority: 5, summary: bigSummary })]), promptEvent("oversizeplain now"), IDENTITY, undefined, BOUNDS), // I'
    matchActivation(idx([entry({ episode_id: "" })]), promptEvent("anything"), IDENTITY, undefined, BOUNDS), // J (malformed skipped -> empty)
    matchActivation(idx([entry({ trigger_kind: "activity", value: "activity:__proto__", episode_id: "id-k" })]), promptEvent("anything"), IDENTITY, undefined, BOUNDS), // K
  ];
  let allClean = true;
  const dirty = [];
  for (const [i, s] of samples.entries()) {
    const keys = Object.keys(s).sort();
    const shapeOk = keys.length === 3 && keys[0] === "entries" && keys[1] === "lines" && keys[2] === "overflowNote";
    const noDecision = !Object.hasOwn(s, "decision") && !Object.hasOwn(s, "block") && !Object.hasOwn(s, "permissionDecision");
    const serialized = JSON.stringify(s);
    const noDecisionInJson = !/"decision"|"block"|"permissionDecision"/.test(serialized);
    if (!shapeOk || !noDecision || !noDecisionInJson) { allClean = false; dirty.push({ i, s }); }
  }
  assert(allClean, "render_no_decision_field: MatchResult carries only {entries, lines, overflowNote} across every sampled state, never decision/block/permissionDecision", JSON.stringify(dirty));
}

// ===========================================================================
// 23. overflow_selection_critical_named (state H)
// ===========================================================================
{
  const entries = ["0", "1", "2", "3"].map((n) =>
    entry({ value: "criticaloverflow", episode_id: `20260${70 + Number(n)}01-000000-co-${n}`, effective_priority: 9 }));
  const index = idx(entries);
  const r = matchActivation(index, promptEvent("criticaloverflow now"), IDENTITY, undefined, BOUNDS);
  const droppedId = entries[0].episode_id; // smallest/oldest id, last by recency-desc tiebreak
  assert(r.lines.length === 3, "overflow_selection_critical_named: top-K selection still holds max_matches lines", JSON.stringify(r));
  assert(
    r.overflowNote === `+1 more matches suppressed, incl. critical ${droppedId}`,
    "overflow_selection_critical_named (state H): overflow note names the dropped critical id",
    r.overflowNote,
  );
}

// ===========================================================================
// 24. oversize_drop_critical_named (state I)
// ===========================================================================
{
  const bigSummary = "y".repeat(2600);
  const index = idx([entry({ value: "oversizecrit2", episode_id: "id-oc2", effective_priority: 9, summary: bigSummary })]);
  const r = matchActivation(index, promptEvent("oversizecrit2 now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "oversize_drop_critical_named: the oversize critical entry is dropped whole", JSON.stringify({ lines: r.lines.length }));
  assert(
    r.overflowNote === "+1 more matches suppressed, incl. critical id-oc2",
    "oversize_drop_critical_named (state I): oversize drop of a critical entry emits the F5 note",
    r.overflowNote,
  );
}

// ===========================================================================
// 25-28. Suppress (REQ-13)
// ===========================================================================
{
  const index = idx([entry({ value: "muteme", episode_id: "id-mute9", effective_priority: 9 })]);
  const r = matchActivation(index, promptEvent("muteme now"), IDENTITY, new Set(["id-mute9"]), BOUNDS);
  assert(r.lines.length === 0 && r.overflowNote === null, "suppress_mutes_band9 (state E): suppressed critical entry is absent, no overflow note", JSON.stringify(r));
}
{
  // Hook-level "missing lesson-suppress.json" degrades to no suppress argument at all.
  const index = idx([entry({ value: "nosuppfile", episode_id: "id-nsf" })]);
  const r = matchActivation(index, promptEvent("nosuppfile now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1, "suppress_missing_file: undefined suppress arg is treated as nothing suppressed", JSON.stringify(r));
}
{
  // Hook-level syntax-malformed lesson-suppress.json degrades (S4) to an empty Set.
  const index = idx([entry({ value: "synmal", episode_id: "id-synmal" })]);
  const r = matchActivation(index, promptEvent("synmal now"), IDENTITY, new Set(), BOUNDS);
  assert(r.lines.length === 1, "suppress_syntax_malformed_failopen: empty Set (post hook-degrade) suppresses nothing", JSON.stringify(r));
}
{
  // Hook-level shape-malformed lesson-suppress.json (valid JSON, wrong shape) also
  // degrades (S4) to an empty Set — the core's boundary is identical to the two
  // cases above; the file-parsing fail-open logic itself is S4, not this core.
  const index = idx([entry({ value: "shapemal", episode_id: "id-shapemal", effective_priority: 9 })]);
  const r = matchActivation(index, promptEvent("shapemal now"), IDENTITY, new Set(), BOUNDS);
  assert(r.lines.length === 1, "suppress_shape_malformed_failopen: shape-malformed-degraded empty Set still injects (RFC line 400)", JSON.stringify(r));
}

// ===========================================================================
// 29. suppress_schema (REQ-14)
// ===========================================================================
{
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, "schemas/lesson-suppress.schema.json"), "utf8"));
  const valid = { schema_version: 1, suppress: [{ episode_id: "20260701-000000-x-aaaa", reason: "scope error", added: "2026-07-01" }] };
  const validMinimal = { schema_version: 1, suppress: [] };
  const badShape = { schema_version: 1, suppress: [{ reason: "no id here" }] }; // missing required episode_id
  const badVersion = { schema_version: 2, suppress: [] };
  const badAdditional = { schema_version: 1, suppress: [], extra: true };
  assert(validateInstance(valid, schema).valid, "suppress_schema: a valid mute doc validates");
  assert(validateInstance(validMinimal, schema).valid, "suppress_schema: an empty suppress list validates");
  assert(!validateInstance(badShape, schema).valid, "suppress_schema: an entry missing episode_id is rejected");
  assert(!validateInstance(badVersion, schema).valid, "suppress_schema: a non-1 schema_version is rejected");
  assert(!validateInstance(badAdditional, schema).valid, "suppress_schema: an unknown top-level property is rejected");
}

// ===========================================================================
// 30-33. Scope predicate (REQ-15)
// ===========================================================================
{
  const index = idx([entry({ value: "projmismatch", episode_id: "id-pm", applies_to_projects: ["other-project"] })]);
  const r = matchActivation(index, promptEvent("projmismatch now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "scope_project_mismatch (state F, prompt kind): foreign-project entry never fires", JSON.stringify(r));
}
{
  // "Also applies to tool matches" (REQ-15): the SAME applies_to_projects
  // predicate gates trigger_kind:'tool' entries, not just phrase/activity ones.
  const index = idx([entry({ trigger_kind: "tool", value: "tool:Bash:*", episode_id: "id-tm", applies_to_projects: ["other-project"] })]);
  const r = matchActivation(index, toolEvent("Bash", "ls"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "scope_project_mismatch_tool_kind (state F, tool kind): a tool-matching entry still respects the project scope predicate", JSON.stringify(r));
}
{
  const index = idx([entry({ value: "emptyapplies", episode_id: "id-ea", applies_to_projects: [] })]);
  const r = matchActivation(index, promptEvent("emptyapplies now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "scope_lesson_empty_applies_to_never_fires (EC7): empty applies_to_projects never fires", JSON.stringify(r));
}

// --- Tool-axis scope (codex F1 regression, Rule 15) — applies_to_tools gates too ---
{
  const index = idx([entry({ value: "othertool", episode_id: "id-ot", applies_to_tools: ["codex"] })]);
  const r = matchActivation(index, promptEvent("othertool now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "scope_tool_mismatch: an entry tagged applies_to_tools:['codex'] never fires under a claude-code identity (leak closed)", JSON.stringify(r));
}
{
  const index = idx([entry({ value: "emptytools", episode_id: "id-et", applies_to_tools: [] })]);
  const r = matchActivation(index, promptEvent("emptytools now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "scope_tool_empty_never_fires: empty applies_to_tools never fires", JSON.stringify(r));
}
{
  const index = idx([entry({ value: "wildcardtool", episode_id: "id-wct", applies_to_tools: ["*"] })]);
  const missingToolId = matchActivation(index, promptEvent("wildcardtool now"), { slug: "acme", root: "/x" }, undefined, BOUNDS);
  assert(missingToolId.lines.length === 0, "scope_identity_missing_tool_id: an identity without tool_id never fires, even against applies_to_tools:['*']", JSON.stringify(missingToolId));
}
{
  const index = idx([entry({ value: "wildcardtoolfires", episode_id: "id-wctf", applies_to_tools: ["*"], applies_to_projects: ["acme"] })]);
  const r = matchActivation(index, promptEvent("wildcardtoolfires now"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1, "scope_tool_wildcard_fires: applies_to_tools:['*'] + a matching project DOES fire (control)", JSON.stringify(r));
}
{
  const index = idx([entry({ value: "wildcardentry", episode_id: "id-wc", applies_to_projects: ["*"] })]);
  const emptySlug = matchActivation(index, promptEvent("wildcardentry now"), { slug: "", root: "/x", tool_id: "claude-code" }, undefined, BOUNDS);
  const noIdentity = matchActivation(index, promptEvent("wildcardentry now"), undefined, undefined, BOUNDS);
  const withSlug = matchActivation(index, promptEvent("wildcardentry now"), { slug: "any-project", root: "/x", tool_id: "claude-code" }, undefined, BOUNDS);
  assert(emptySlug.lines.length === 0, "empty_identity_no_wildcard_match (EC5): empty slug does not accidentally match ['*']", JSON.stringify(emptySlug));
  assert(noIdentity.lines.length === 0, "empty_identity_no_wildcard_match (EC5): absent identity does not accidentally match ['*']", JSON.stringify(noIdentity));
  assert(withSlug.lines.length === 1, "empty_identity_no_wildcard_match: a real non-empty slug DOES match a ['*'] entry (control)", JSON.stringify(withSlug));
}

// ===========================================================================
// Additional explicit contract-state coverage (§12: "every one gets a test")
// ===========================================================================
{
  assert(matchActivation({}, promptEvent("plan"), IDENTITY, undefined, BOUNDS).lines.length === 0, "state_a_no_index: empty index object yields no lines");
  assert(matchActivation(null, promptEvent("plan"), IDENTITY, undefined, BOUNDS).lines.length === 0, "state_a_no_index: null index yields no lines, no throw");
  assert(matchActivation({ entries: [] }, promptEvent("plan"), IDENTITY, undefined, BOUNDS).lines.length === 0, "state_a_no_index: explicit empty entries array yields no lines");
}
{
  const index = idx([entry({ value: "somethingelse", episode_id: "id-nomatch" })]);
  const r = matchActivation(index, promptEvent("this text shares nothing with the trigger"), IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0 && r.overflowNote === null, "state_b_no_match: a loaded index with zero firing entries yields {lines:[], overflowNote:null}");
}
{
  const index = idx([
    entry({ value: "goodmatch", episode_id: "id-good" }),
    { trigger_kind: "phrase", value: "goodmatch", summary: "no id here" }, // missing episode_id
    { trigger_kind: "phrase", episode_id: "id-noval", summary: "no value here" }, // missing value
    { trigger_kind: "phrase", value: "goodmatch", episode_id: "id-badpri", summary: "s", effective_priority: "high" }, // non-integer priority
  ]);
  let threw = false;
  let r;
  try {
    r = matchActivation(index, promptEvent("goodmatch now"), IDENTITY, undefined, BOUNDS);
  } catch {
    threw = true;
  }
  assert(!threw, "state_j_malformed_entry: malformed entries never throw");
  assert(r && r.lines.length === 1 && r.lines[0].includes("id-good"), "state_j_malformed_entry: only the well-formed entry is rendered, malformed siblings skipped", JSON.stringify(r));
  assert(r && r.overflowNote === null, "state_j_malformed_entry: malformed entries never contribute to the overflow note");
}

// ===========================================================================
// R4 SessionStart (RFC-009 REQ-18, P2-S5): matchActivation kind='session_start'
// reads index.session_start (caller-merged) via the pure renderSessionStart
// path -- covered here as core cases; the S5 hook E2E fan-out lives in
// tests/test-activation-sessionstart.mjs (Group 3).
// ===========================================================================
const sessionStartEvent = { kind: "session_start" };
function criticalEntry(overrides) {
  return {
    episode_id: "20260701-000000-critical-aaaa",
    summary: "critical fixture",
    category: "lesson",
    effective_priority: 9,
    applies_to_projects: ["acme"],
    applies_to_tools: ["claude-code"],
    ...overrides,
  };
}
function plainEntry(overrides) {
  return {
    episode_id: "20260701-000000-plain-aaaa",
    summary: "plain fixture",
    static_score: 0.5,
    applies_to_projects: ["acme"],
    applies_to_tools: ["claude-code"],
    ...overrides,
  };
}
function idxSS(sessionStart) {
  return { entries: [], activity_phrases: {}, session_start: sessionStart };
}

// render_plain_band7 -- tier 2 renders PLAIN regardless of any (malformed/
// forged) effective_priority smuggled onto an `entries` row; the renderer
// must never read that field for tier 2 (REQ-18/§8.2).
{
  const index = idxSS({
    critical_entries: [],
    entries: [plainEntry({ episode_id: "id-forged-hi", effective_priority: 9, summary: "forged-high plain" })],
    preflight: {},
  });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1 && r.lines[0] === "lesson id-forged-hi: forged-high plain",
    "render_plain_band7: tier 2 renders plain-only even when effective_priority is (illegally) present on the entry", JSON.stringify(r));
}

// tier1_critical_loads -- a band-9 critical entry always renders imperative.
{
  const index = idxSS({ critical_entries: [criticalEntry({ episode_id: "id-crit-1" })], entries: [], preflight: {} });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1 && r.lines[0].startsWith("READ id-crit-1"),
    "tier1_critical_loads: critical_entries render imperative, trigger-independent", JSON.stringify(r));
}

// tier1_determinism -- stable priority-desc/id-desc ordering across calls.
{
  const index = idxSS({
    critical_entries: [
      criticalEntry({ episode_id: "id-b", effective_priority: 8 }),
      criticalEntry({ episode_id: "id-a", effective_priority: 9 }),
      criticalEntry({ episode_id: "id-c", effective_priority: 9 }),
    ],
    entries: [],
    preflight: {},
  });
  const r1 = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  const r2 = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(JSON.stringify(r1) === JSON.stringify(r2), "tier1_determinism: repeated calls on the same index yield byte-identical output");
  assert(r1.lines[0].includes("id-c") && r1.lines[1].includes("id-a") && r1.lines[2].includes("id-b"),
    "tier1_determinism: priority-desc then episode_id-desc (recency) tie-break", JSON.stringify(r1));
}

// tier1_band_overflow_noted -- excess critical entries beyond max_matches
// drop with the state-H/I overflow note (every tier-1 drop is critical by
// construction). STRENGTHENED (F1): the SAME critical ids also live in tier 2
// `entries`; a dropped (overflowed) critical must NOT resurface as a plain
// `lesson <id>:` line — the exclusion is by tier-1 CANDIDACY, not by rendering.
{
  const ids = ["id-1", "id-2", "id-3", "id-4"].map((id) => `20260701-000000-${id}-aaaa`);
  const critical = ids.map((id) => criticalEntry({ episode_id: id, effective_priority: 9 }));
  const entries = ids.map((id) => plainEntry({ episode_id: id, summary: `plain twin of ${id}` }));
  const index = idxSS({ critical_entries: critical, entries, preflight: {} });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 3, "tier1_band_overflow_noted: bounded to max_matches", JSON.stringify(r));
  assert(typeof r.overflowNote === "string" && r.overflowNote.includes("incl. critical"),
    "tier1_band_overflow_noted: overflow note names a suppressed critical id", JSON.stringify(r));
  const noteId = (r.overflowNote.match(/incl\. critical (\S+)/) || [])[1];
  const droppedIds = ids.filter((id) => !r.lines.some((l) => l.startsWith(`READ ${id}`)));
  assert(droppedIds.length > 0 && droppedIds.every((id) => !r.lines.some((l) => l === `lesson ${id}: plain twin of ${id}`)),
    "tier1_band_overflow_noted (F1): a count-overflow-dropped critical never resurfaces as a plain tier-2 line", `dropped=${JSON.stringify(droppedIds)} lines=${JSON.stringify(r.lines)}`);
  assert(!!noteId && !r.lines.some((l) => l === `lesson ${noteId}: plain twin of ${noteId}`),
    "tier1_band_overflow_noted (F1): the exact id named 'suppressed' in the note is not simultaneously injected plain", `note=${r.overflowNote} lines=${JSON.stringify(r.lines)}`);
}

// tier1_token_overflow_dropped_critical_not_plain (F1, token-overflow variant)
// -- a band-9 critical whose OWN imperative line exceeds max_tokens is dropped
// WHOLE (state I); it must not then leak into tier 2 as a plain line either.
{
  const bigId = "20260701-000000-huge-crit-aaaa";
  const smallId = "20260701-000000-small-crit-aaaa";
  const index = idxSS({
    critical_entries: [
      criticalEntry({ episode_id: bigId, effective_priority: 9, summary: "X".repeat(400) }), // imperative line > 50 tokens
      criticalEntry({ episode_id: smallId, effective_priority: 9, summary: "small" }),
    ],
    entries: [plainEntry({ episode_id: bigId, summary: "plain twin big" }), plainEntry({ episode_id: smallId, summary: "plain twin small" })],
    preflight: {},
  });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, { max_matches: 3, max_tokens: 50 });
  assert(!r.lines.some((l) => l === "lesson " + bigId + ": plain twin big"),
    "tier1_token_overflow_dropped_critical_not_plain (F1): a token-overflow-dropped critical does not resurface plain in tier 2", JSON.stringify(r));
  assert(typeof r.overflowNote === "string" && r.overflowNote.includes(bigId),
    "tier1_token_overflow_dropped_critical_not_plain: the oversize critical is named in the overflow note", JSON.stringify(r));
}

// tier_dedup_cross_tier (EC13) -- a band lesson present in BOTH tiers only
// renders once, from tier 1 (imperative), never duplicated plain in tier 2.
{
  const id = "20260701-000000-dupe-aaaa";
  const index = idxSS({
    critical_entries: [criticalEntry({ episode_id: id })],
    entries: [plainEntry({ episode_id: id, summary: "should not render (tier-1 wins)" })],
    preflight: {},
  });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1 && r.lines[0].startsWith("READ " + id),
    "tier_dedup_cross_tier: tier 2 excludes an id already emitted by tier 1 (tier 1 wins)", JSON.stringify(r));
}

// tier2_static_order_plain_only -- tier 2 preserves the caller's pre-sorted
// (static_score desc) order and renders every entry plain.
{
  const index = idxSS({
    critical_entries: [],
    entries: [plainEntry({ episode_id: "id-first", summary: "first" }), plainEntry({ episode_id: "id-second", summary: "second" })],
    preflight: {},
  });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 2 && r.lines[0] === "lesson id-first: first" && r.lines[1] === "lesson id-second: second",
    "tier2_static_order_plain_only: preserves pre-sorted order, plain rendering", JSON.stringify(r));
}

// preflight_advisory_derived -- count=sum(values), ids=keys, generic (no
// hardcoded pattern-id knowledge in the matcher).
{
  const index = idxSS({
    critical_entries: [],
    entries: [],
    preflight: { implementation: { "bp-001-implementation-workflow": 2, "bp-006-push-after-verify": 1 }, push: {}, rule: {} },
  });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1 && r.lines[0].includes("3 recent implementation violation(s)") &&
    r.lines[0].includes("bp-001-implementation-workflow") && r.lines[0].includes("bp-006-push-after-verify"),
    "preflight_advisory_derived: count=sum(values), ids=keys, empty task types contribute nothing", JSON.stringify(r));
}

// scope_filter_foreign_project -- applies_to mismatch never renders, both tiers.
{
  const index = idxSS({
    critical_entries: [criticalEntry({ episode_id: "id-foreign-crit", applies_to_projects: ["other-project"] })],
    entries: [plainEntry({ episode_id: "id-foreign-plain", applies_to_projects: ["other-project"] })],
    preflight: {},
  });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0, "scope_filter_foreign_project: neither tier renders when applies_to excludes the identity's project", JSON.stringify(r));
}

// degraded_missing_section / degraded_partial_section -- pure-core side:
// missing session_start -> empty; entries-only-missing -> critical_entries alone.
{
  const r = matchActivation(idxSS(undefined), sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 0 && r.overflowNote === null, "degraded_missing_section: undefined session_start yields no lines, no throw", JSON.stringify(r));
}
{
  const index = idxSS({ critical_entries: [criticalEntry({ episode_id: "id-alone" })] }); // entries + preflight absent
  const r = matchActivation(index, sessionStartEvent, IDENTITY, undefined, BOUNDS);
  assert(r.lines.length === 1 && r.lines[0].includes("id-alone"), "degraded_partial_section: entries missing -> critical_entries alone renders", JSON.stringify(r));
}

// sessionstart_suppress -- suppression mutes an id in EITHER tier.
{
  const index = idxSS({
    critical_entries: [criticalEntry({ episode_id: "id-suppressed-crit" })],
    entries: [plainEntry({ episode_id: "id-suppressed-plain" })],
    preflight: {},
  });
  const r = matchActivation(index, sessionStartEvent, IDENTITY, new Set(["id-suppressed-crit", "id-suppressed-plain"]), BOUNDS);
  assert(r.lines.length === 0, "sessionstart_suppress: suppression mutes an id in either tier", JSON.stringify(r));
}

// ===========================================================================
// Garbage-input fail-open (advisory invariant: throws nothing, ever)
// ===========================================================================
{
  const garbageCalls = [
    () => matchActivation(42, "not an object", [], "not a set", null),
    () => matchActivation(undefined, undefined, undefined, undefined, undefined),
    () => matchActivation({ entries: "not an array" }, { kind: "prompt" }, {}, new Set(), {}),
    () => matchActivation({ entries: [{}] }, { kind: "tool", tool: 123, target: {} }, { slug: 7 }, null, { max_matches: "x" }),
    () => matchActivation(idx([entry({})]), { kind: "session_start" }, IDENTITY, undefined, BOUNDS),
  ];
  let allClean = true;
  const bad = [];
  for (const call of garbageCalls) {
    let r;
    try {
      r = call();
    } catch (e) {
      allClean = false;
      bad.push(String(e));
      continue;
    }
    if (!r || !Array.isArray(r.lines) || r.lines.length !== 0 || r.overflowNote !== null) {
      allClean = false;
      bad.push(JSON.stringify(r));
    }
  }
  assert(allClean, "matcher_fails_open_on_garbage_input: every garbage/edge shape (incl. session_start kind) returns {lines:[], overflowNote:null} without throwing", JSON.stringify(bad));
}

// ===========================================================================
console.log(`\ntest-activation-match: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ all activation-match core conformance checks passed");
