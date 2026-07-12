// activation-match.mjs — RFC-009 P2-S3 (R3). The pure matcher core.
//
// matchActivation(index, event, identity, suppress, bounds) -> MatchResult
//   MatchResult = { lines: string[], overflowNote: string|null }
//
// ZERO I/O. No fs, no process.env, no network, no Date.now(). Takes
// already-loaded data (the persisted per-store/merged trigger-index.json
// shape, or a hook-assembled equivalent) and returns a bounded, rendered
// result. The hooks (P2-S4/S5) do all I/O — read the index files, build the
// suppress Set, resolve identity from the adapter manifest — and call this.
//
// ADVISORY INVARIANT (the one thing that must never break): the return value
// NEVER carries a `decision`/`block`/`permissionDecision` field, and this
// function THROWS NOTHING. Any internal error (malformed index, malformed
// event, a regex that would otherwise throw) fails OPEN to
// `{ lines: [], overflowNote: null }` — the deliberate inverse of a gate
// (RFC-008 R1): a fail-closed advisory that ever blocked a tool call would be
// the bug, not a suppressed lesson pointer.
//
// STEP 0 (behavior-simulated, not guessed): the REAL trigger-index.json entry
// shape was probed against an isolated fixture store (em-store + em-trigger-
// index, explicit cwd, --scope local) before writing this file. The plan's
// approximate `applies_to` field name does NOT exist on disk — the real
// entry carries TWO separate arrays, `applies_to_projects` and
// `applies_to_tools` (see scripts/em-trigger-index.mjs TRIGGER_ENTRY_FIELDS).
// This matcher's REQ-15 scope predicate gates BOTH axes: `applies_to_projects`
// against `identity.slug` AND `applies_to_tools` against `identity.tool_id`
// (the S4 hook supplies tool_id = the activation manifest's `harness`, a
// constant "claude-code"). An empty EITHER array never fires (RFC-009 R1:54,
// R2:71; plan REQ-15). See the scopeOk() rationale for the full grounding.
//
// Real observed entry (fixture probe, trimmed):
//   {
//     "trigger_kind": "phrase",              // "phrase" | "tool" | "activity"
//     "value": "test phrase",
//     "episode_id": "20260709-003019-fixture-lesson-for-s3-probe-a334",
//     "summary": "fixture lesson for S3 probe",
//     "effective_priority": 5,                // DERIVED 1-9 (earned band)
//     "applies_to_projects": ["acme"],
//     "applies_to_tools": ["claude-code"]
//     // review_by?: "YYYY-MM-DD" (present only when the lesson set one)
//   }
// Activity phrase sets are baked ONCE at the INDEX top level (REQ-9), not
// duplicated per entry:
//   index.activity_phrases = { "plan": ["plan", "planning", ...], ... }
// so an `activity:<class>` entry's firing phrases are looked up via
// `index.activity_phrases[class]`, never re-read from activation-classes.json.

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// REQ-6: case-fold, word-boundary via negative lookaround on [\w-] (NOT the
// classic \b, which does not treat '-' as a word char and would let
// "plan-approval" false-match on "plan"/"approval" independently). The
// phrase is regex-escaped before the RegExp is built, so metacharacters in a
// phrase (e.g. "C++", "a.b") are matched LITERALLY and never throw / ReDoS.
function matchesPhrase(text, phrase) {
  if (typeof text !== "string" || !text) return false;
  if (typeof phrase !== "string" || !phrase) return false;
  let re;
  try {
    re = new RegExp(`(?<![\\w-])${escapeRegex(phrase)}(?![\\w-])`, "i");
  } catch {
    return false;
  }
  try {
    return re.test(text);
  } catch {
    return false;
  }
}

// REQ-7: parse `tool:<ToolName>:<glob>`. `\` escapes a literal `:` or `*`
// (only those two characters carry escape meaning). Returns null when the
// value is not tool-shaped or has no name/glob separator (malformed —
// caller treats as "does not match", never throws).
function parseToolTrigger(rawValue) {
  if (typeof rawValue !== "string" || !rawValue.startsWith("tool:")) return null;
  const rest = rawValue.slice("tool:".length);
  let i = 0;
  let toolNameRaw = "";
  for (; i < rest.length; i++) {
    const c = rest[i];
    if (c === "\\" && i + 1 < rest.length && (rest[i + 1] === ":" || rest[i + 1] === "*")) {
      toolNameRaw += rest[i] + rest[i + 1];
      i++;
      continue;
    }
    if (c === ":") break;
    toolNameRaw += c;
  }
  if (i >= rest.length) return null; // no unescaped ':' separator found
  const globRaw = rest.slice(i + 1);
  if (!toolNameRaw) return null;
  return { toolName: unescapeToolField(toolNameRaw), globRaw };
}

function unescapeToolField(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && (s[i + 1] === ":" || s[i + 1] === "*")) {
      out += s[i + 1];
      i++;
      continue;
    }
    out += s[i];
  }
  return out;
}

// `*` is the ONLY glob metachar (matches zero-or-more of anything); an
// escaped `\*` is a literal asterisk. Every other character (after
// unescaping `\:`) is matched literally.
function globToRegexSource(globRaw) {
  let pattern = "";
  for (let i = 0; i < globRaw.length; i++) {
    const c = globRaw[i];
    if (c === "\\" && (globRaw[i + 1] === ":" || globRaw[i + 1] === "*")) {
      pattern += escapeRegex(globRaw[i + 1]);
      i++;
      continue;
    }
    if (c === "*") {
      pattern += ".*";
      continue;
    }
    pattern += escapeRegex(c);
  }
  return pattern;
}

// REQ-7: tool name match + primary-target glob match. `tool:<Name>:*`
// matches on NAME ALONE (target may be '' for an unknown tool — EC9); a
// non-'*' glob requires the target to match the (escaped) glob pattern.
function matchesToolTrigger(entryValue, eventTool, eventTarget) {
  const parsed = parseToolTrigger(entryValue);
  if (!parsed) return false;
  const toolName = typeof eventTool === "string" ? eventTool : "";
  if (parsed.toolName !== toolName) return false;
  if (parsed.globRaw === "*") return true; // name-alone match, target ignored
  const target = typeof eventTarget === "string" ? eventTarget : "";
  try {
    const re = new RegExp(`^${globToRegexSource(parsed.globRaw)}$`);
    return re.test(target);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// REQ-15 scope predicate — BOTH axes gate (codex F1, ACCEPTED).
//
// The RFC scopes on project AND tool identity, both drawn from the adapter
// manifest: RFC-009 R1:54 defines `applies_to_projects` AND `applies_to_tools`;
// R2:71 filters an entry against the hook's project AND tool identity; plan
// REQ-15 (:63) makes the empty-never-fires rule apply to BOTH arrays. An
// earlier draft of this matcher gated projects only and treated
// `applies_to_tools` as a P3-reserved axis — that was the leak codex found: a
// lesson tagged for another tool (`applies_to_tools: ['codex']`, or an empty
// `[]`) still fired under a claude-code identity. Both predicates now gate.
//
// `identity.tool_id` is supplied by the S4 hook from the activation manifest's
// `harness` field — a constant "claude-code" for the STRONG-tier adapter P2
// ships (no S2 manifest change needed; the matcher just consumes it). Both
// axes honor the `'*'` wildcard. An empty EITHER array -> false -> NEVER fires
// (state F / EC7); an empty/absent `slug` OR `tool_id` must not accidentally
// match a `['*']` entry (EC5) — the predicate requires a non-empty value on
// every branch.
// ---------------------------------------------------------------------------
function scopeOk(entry, identity) {
  const slug = identity && typeof identity.slug === "string" ? identity.slug : "";
  const toolId = identity && typeof identity.tool_id === "string" ? identity.tool_id : "";
  const projects = Array.isArray(entry.applies_to_projects) ? entry.applies_to_projects : [];
  const tools = Array.isArray(entry.applies_to_tools) ? entry.applies_to_tools : [];
  if (slug === "" || toolId === "") return false;
  if (projects.length === 0 || tools.length === 0) return false;
  const projectOk = projects.includes(slug) || projects.includes("*");
  const toolOk = tools.includes(toolId) || tools.includes("*");
  return projectOk && toolOk;
}

// ---------------------------------------------------------------------------
// REQ-11 render. No decision/block/permissionDecision field in any form.
//
// RFC-011 R4 (S3): an entry with `entry_class: "playbook"` renders the R3
// playbook form (provenance prefix + READ + precomputed read_command) instead
// of the lesson forms, regardless of the pinned effective_priority 0. The
// matchers (sanitizeEntries/candidatesForEvent/scopeOk/selectAndBound) UNITE
// playbook + lesson rows under the SAME matching semantics — only the render
// branches on entry_class. read_command is precomputed at build (R2.4); a
// malformed row without one degrades to a non-empty fallback line rather than
// throwing (advisory fail-open, REQ-12).
// ---------------------------------------------------------------------------
function renderPlaybookLine(entry) {
  const id = entry && typeof entry.episode_id === "string" ? entry.episode_id : "";
  const summary = String((entry && entry.summary) ?? "");
  const rc = entry && typeof entry.read_command === "string" && entry.read_command
    ? entry.read_command
    : `node <scripts>/em-search.mjs --read ${id}`;
  // RFC-011 R3 / §8.2 verbatim — provenance prefix names the source file, so
  // declared injection is auditable (R1 threat model). No body content, ever
  // (R2.8 sentinel): only episode_id + summary + read_command appear.
  return `playbook (playbooks.json): READ ${id} before proceeding (${rc}): ${summary}`;
}

// isImperative(entry) — single source of truth for the imperative-vs-plain
// predicate. R4 (S3) playbook rows are ALWAYS imperative (read_command-bearing
// provenance prefix); lesson rows are imperative iff their effective_priority
// is in the critical band (>=8). Exported so the RFC-009 P4-S1 telemetry
// schema entries[] cannot diverge from the rendered lines[] (REQ-16/RFC-009
// R6 telemetry producer — S1).
function isImperative(entry) {
  if (entry && entry.entry_class === "playbook") return true;
  return Number(entry && entry.effective_priority) >= 8;
}

function renderLine(entry) {
  // R4 (S3): playbook rows render the playbook form regardless of priority.
  if (entry && entry.entry_class === "playbook") return renderPlaybookLine(entry);
  const id = entry.episode_id;
  const summary = String(entry.summary ?? "");
  if (isImperative(entry)) {
    return `READ ${id} before proceeding (em-search --read ${id}): ${summary}`;
  }
  return `lesson ${id}: ${summary}`;
}

// Rough, dependency-free token estimate (~4 chars/token, the standard
// order-of-magnitude heuristic) — the bound is advisory (~500), not an exact
// tokenizer contract, so a proportional proxy is sufficient and stays zero-I/O.
function estimateTokens(s) {
  return Math.ceil(String(s).length / 4);
}

// ---------------------------------------------------------------------------
// State J: malformed entries (missing value/id, or a non-integer priority)
// are skipped silently — never thrown, never counted toward overflow.
// ---------------------------------------------------------------------------
function sanitizeEntries(index) {
  const entries = index && Array.isArray(index.entries) ? index.entries : [];
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.episode_id !== "string" || !e.episode_id) continue;
    if (typeof e.value !== "string" || !e.value) continue;
    if (!Number.isInteger(e.effective_priority)) continue;
    out.push(e);
  }
  return out;
}

function activityPhrasesMap(index) {
  const m = index && index.activity_phrases;
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

// REQ-8: activity match. Class lookup uses Object.hasOwn — NEVER
// `obj[key]`-as-membership (proto-key lesson `…3c55`). `activity:__proto__`
// / `activity:hasOwnProperty` etc. are never OWN keys of a JSON-built map
// (state K) -> Object.hasOwn returns false -> no match, no throw.
function activityFires(prompt, className, index) {
  const map = activityPhrasesMap(index);
  if (!Object.hasOwn(map, className)) return false;
  const phrases = map[className];
  if (!Array.isArray(phrases)) return false;
  return phrases.some((p) => typeof p === "string" && matchesPhrase(prompt, p));
}

// ---------------------------------------------------------------------------
// Kind-dispatched candidate gathering (fires-for-event AND scope-ok).
// ---------------------------------------------------------------------------
function candidatesForEvent(entries, event, index, identity) {
  const kind = event && event.kind;
  const out = [];
  for (const entry of entries) {
    let fires = false;
    if (kind === "prompt") {
      const prompt = typeof event.prompt === "string" ? event.prompt : "";
      if (entry.trigger_kind === "phrase") {
        fires = matchesPhrase(prompt, entry.value);
      } else if (entry.trigger_kind === "activity" && entry.value.startsWith("activity:")) {
        const cls = entry.value.slice("activity:".length);
        fires = activityFires(prompt, cls, index);
      }
    } else if (kind === "tool") {
      if (entry.trigger_kind === "tool") {
        fires = matchesToolTrigger(entry.value, event.tool, event.target);
      }
    }
    if (!fires) continue;
    if (!scopeOk(entry, identity)) continue;
    out.push(entry);
  }
  return out;
}

function filterSuppressed(candidates, suppress) {
  const s = suppress instanceof Set ? suppress : new Set();
  return candidates.filter((e) => !s.has(e.episode_id));
}

// ---------------------------------------------------------------------------
// RFC-011 R2.9(b) first half (fix-round Item 2, agent F1): event-level render
// dedup — ONE rendered entry per episode id per event. An episode with 2+
// triggers that co-match one prompt (e.g. triggers ["alphaword", "betaword"],
// prompt "alphaword and betaword together") produces N candidate rows → would
// render N duplicate lines and burn N max_matches slots (probe-confirmed:
// playbookLineCount=2, lessonLineCount=2). The session-start bands are
// per-episode by construction (T4d — the session_start.playbooks array carries
// one entry per episode; tier-1 critical_entries + tier-2 entries dedup by id
// via tier1CandidateIds) and are NOT routed through this function.
//
// R2.9(b) second half (playbook form wins): when BOTH a lesson row AND a
// playbook row for the SAME episode id match the same event, the PLAYBOOK form
// wins (it carries the read_command). resolve the form BEFORE dedup — pick the
// playbook representative when any playbook candidate exists for the group,
// else keep the FIRST-ENCOUNTERED lesson candidate (local precedence — the
// hook's mergeIndexes iterates local-then-global and candidatesForEvent
// preserves entry order; no priority comparison happens here). All lesson rows
// for one episode carry the SAME effective_priority (the band is derived
// per-episode via effectivePriority(lessonId, rows), never per-trigger), so
// which lesson row is the representative does not affect selectAndBound's
// downstream sort. Forged/malformed rows (no entry_class) are treated as
// lesson-form here; the schema-side F6a binding rejects forged playbook rows
// at validation.
// All playbook rows for one episode render identically (same episode_id /
// summary / read_command), so the first playbook candidate is the representative.
// The representative carries its OWN effective_priority into selectAndBound's
// sort — a playbook row (pinned 0 per R2) sorts below every lesson, preserving
// the R2 pinning invariant (a declared playbook never displaces an earned
// lesson inside max_matches).
// ---------------------------------------------------------------------------
function dedupByEpisodePreferPlaybook(candidates) {
  const byEpisode = new Map();
  for (const e of candidates) {
    if (!e || typeof e.episode_id !== "string" || !e.episode_id) continue;
    const existing = byEpisode.get(e.episode_id);
    if (!existing) { byEpisode.set(e.episode_id, e); continue; }
    // R2.9(b) playbook-wins: a playbook representative replaces an existing
    // lesson-form representative. Once a playbook row is the representative, a
    // later lesson row for the same episode does NOT displace it.
    if (e.entry_class === "playbook" && existing.entry_class !== "playbook") {
      byEpisode.set(e.episode_id, e);
    }
  }
  return [...byEpisode.values()];
}

// ---------------------------------------------------------------------------
// REQ-10/12 bounds + selection. Unifies states C/D/G/H/I/I' behind one pass:
//   - top-K by effective_priority desc, then recency (episode_id desc — ids
//     are date-prefixed, so lexical-desc IS recency-desc) via max_matches
//   - a single entry whose OWN rendered line exceeds max_tokens is dropped
//     WHOLE (never truncated) — state I / I'
//   - the running total must also stay <= max_tokens; once it would not,
//     remaining candidates are treated as count-overflow (state G/H)
//   - overflowNote fires iff ANY dropped entry (either reason) is band 8-9;
//     it names ONE such id (the highest-priority/most-recent dropped
//     critical) and the total dropped count. A plain-band-only drop (state
//     G, or state I' oversize-non-critical) never gets a note.
// ---------------------------------------------------------------------------
function selectAndBound(candidates, bounds) {
  // codex F2 (ACCEPTED): accept only POSITIVE integers. A zero/negative
  // max_matches made `lines.length >= maxMatches` always true, dropping every
  // entry AND emitting a spurious critical overflow note with empty lines —
  // the plan §12 fail-OPEN-to-empty contract inverted. Out-of-range bounds
  // fall back to the defaults.
  const maxMatches = Number.isInteger(bounds && bounds.max_matches) && bounds.max_matches > 0 ? bounds.max_matches : 3;
  const maxTokens = Number.isInteger(bounds && bounds.max_tokens) && bounds.max_tokens > 0 ? bounds.max_tokens : 500;

  const sorted = [...candidates].sort((a, b) => {
    if (b.effective_priority !== a.effective_priority) return b.effective_priority - a.effective_priority;
    return a.episode_id < b.episode_id ? 1 : a.episode_id > b.episode_id ? -1 : 0;
  });

  const lines = [];
  const entries = []; // RFC-009 P4-S1 (R6) telemetry: parallel to lines[], one
                      // entry per INJECTED lesson, carrying the schema fields
                      // {id, effective_priority, rendered, source_scope,
                      // access_count_at_inject}. Populated in lock-step with
                      // lines.push so result.entries.length === result.lines.length.
  const dropped = [];
  let totalTokens = 0;

  for (const entry of sorted) {
    if (lines.length >= maxMatches) {
      dropped.push(entry);
      continue;
    }
    const line = renderLine(entry);
    const lineTokens = estimateTokens(line);
    if (lineTokens > maxTokens) {
      dropped.push(entry); // state I / I' — oversize, dropped WHOLE
      continue;
    }
    if (totalTokens + lineTokens > maxTokens) {
      dropped.push(entry); // total-budget overflow — same bucket as count-overflow
      continue;
    }
    lines.push(line);
    // trigger-index entries carry effective_priority AND access_count (RFC-009
    // P4-S1 R6 / plan step 1.2cb: em-trigger-index.mjs stamps access_count from
    // the in-hand index.jsonl rows at build time, so the hook never reads
    // index.jsonl at event time). access_count defaults to 0 for any row whose
    // index.jsonl record did not carry an integer value. source_scope is
    // stamped by mergeIndexes in the hook.
    entries.push({
      id: entry.episode_id,
      effective_priority: entry.effective_priority,
      rendered: isImperative(entry) ? "imperative" : "plain",
      source_scope: entry.source_scope ?? null,
      access_count_at_inject: entry.access_count ?? 0,
    });
    totalTokens += lineTokens;
  }

  const criticalDropped = dropped.find((e) => Number(e.effective_priority) >= 8);
  const overflowNote = criticalDropped
    ? `+${dropped.length} more matches suppressed, incl. critical ${criticalDropped.episode_id}`
    : null;

  return { lines, overflowNote, entries };
}

// ---------------------------------------------------------------------------
// R4 SessionStart (RFC-009 REQ-18) — two-tier blend + preflight advisory,
// rendered from the caller-merged `index.session_start` (local+global,
// dedup-by-id LOCAL precedence — done by the S5 hook BEFORE calling this
// pure function, mirroring how R3's `index.entries` is already merged).
//
// Tier 1 = `critical_entries` (band 8/9, TRIGGER-INDEPENDENT): scope+suppress
// filtered, sorted priority-desc/recency-desc (same tie-break as
// selectAndBound), bounded by `max_matches`/`max_tokens` with the SAME
// overflow-note contract as states H/I (every dropped tier-1 entry is by
// construction band 8-9, so any drop is a critical drop) — REQ-18 test
// `tier1_band_overflow_noted`.
//
// Tier 2 = `entries` (the static blend), rendered PLAIN-ONLY — REQ-18/§8.2
// pins that tier 2 entries carry NO `effective_priority` and no code may read
// one even if a malformed/forged input smuggled it in; `renderPlainLine`
// below never inspects that field. Cross-tier dedup: any id already emitted
// in tier 1 is excluded from tier 2 (tier 1 wins, REQ-18/EC13). Oversize/
// over-budget tier-2 entries are dropped silently (never a critical entry by
// construction, so never an overflow note — mirrors state I').
//
// Preflight advisory is derived GENERICALLY (REQ-18): for each task type key
// in `preflight` (em-recall TASK TYPES — implementation/push/rule — never
// activity classes), `ids = Object.keys(counts)` and `count = sum(values)`;
// a task with no positive-count ids contributes no line. `Object.keys`/
// `Object.entries` only ever return OWN enumerable keys (proto-key safe by
// construction — no `obj[key]`-as-membership check is used here).
// ---------------------------------------------------------------------------
function renderPlainLine(entry) {
  return `lesson ${entry.episode_id}: ${String(entry.summary ?? "")}`;
}

function tieBreakDesc(a, b) {
  if (b.effective_priority !== a.effective_priority) return b.effective_priority - a.effective_priority;
  return a.episode_id < b.episode_id ? 1 : a.episode_id > b.episode_id ? -1 : 0;
}

function renderSessionStart(sessionStart, identity, suppress, bounds) {
  const ss = sessionStart && typeof sessionStart === "object" && !Array.isArray(sessionStart) ? sessionStart : {};
  const criticalRaw = Array.isArray(ss.critical_entries) ? ss.critical_entries : [];
  const entriesRaw = Array.isArray(ss.entries) ? ss.entries : [];
  const preflightRaw = ss.preflight && typeof ss.preflight === "object" && !Array.isArray(ss.preflight) ? ss.preflight : {};
  const patternHealthRaw = ss.pattern_health && typeof ss.pattern_health === "object" && !Array.isArray(ss.pattern_health) ? ss.pattern_health : null;

  const s = suppress instanceof Set ? suppress : new Set();
  const maxMatches = Number.isInteger(bounds && bounds.max_matches) && bounds.max_matches > 0 ? bounds.max_matches : 3;
  const maxTokens = Number.isInteger(bounds && bounds.max_tokens) && bounds.max_tokens > 0 ? bounds.max_tokens : 500;

  // ---- Tier 1: critical_entries -------------------------------------------
  const tier1Candidates = criticalRaw.filter((e) =>
    e && typeof e === "object" &&
    typeof e.episode_id === "string" && e.episode_id &&
    Number.isInteger(e.effective_priority) &&
    scopeOk(e, identity) &&
    !s.has(e.episode_id));

  const sortedTier1 = [...tier1Candidates].sort(tieBreakDesc);

  // Cross-tier exclusion set (F1, review-confirmed): tier 2 must exclude EVERY
  // scope+suppress-surviving tier-1 CANDIDATE id — the rendered ones AND the
  // ones dropped by count- or token-overflow. A dropped band-8/9 critical is
  // already accounted for by the overflow note ("…incl. critical <id>"); if it
  // were only the RENDERED ids here, that same dropped critical would resurface
  // as a PLAIN `lesson <id>:` line in tier 2 — simultaneously "suppressed" per
  // the note and re-injected demoted, the single most-important overflowed
  // lesson silently downgraded. The exclusion is by tier-1 CANDIDACY, not by
  // rendering.
  const tier1CandidateIds = new Set(tier1Candidates.map((e) => e.episode_id));

  const tier1Lines = [];
  const tier1Entries = []; // RFC-009 P4-S1 (R6) telemetry: parallel to tier1Lines.
  const droppedTier1 = [];
  let totalTokens = 0;
  for (const e of sortedTier1) {
    if (tier1Lines.length >= maxMatches) { droppedTier1.push(e); continue; }
    const line = renderLine(e); // tier 1 always carries effective_priority>=8 -> always imperative
    const t = estimateTokens(line);
    if (t > maxTokens || totalTokens + t > maxTokens) { droppedTier1.push(e); continue; }
    tier1Lines.push(line);
    // entries[] carries one entry per episode-bearing LESSON only.
    // preflight and pattern-health output are surface lines only and
    // never carry entries — they are spread into lines below, not entries.
    tier1Entries.push({
      id: e.episode_id,
      effective_priority: e.effective_priority,
      rendered: isImperative(e) ? "imperative" : "plain",
      source_scope: e.source_scope ?? null,
      access_count_at_inject: e.access_count ?? 0,
    });
    totalTokens += t;
  }

  // ---- Playbook band (RFC-011 R3, REQ-9): provenance-prefixed imperative
  // line, positioned AFTER tier-1 critical_entries and BEFORE the tier-2
  // static blend. The cap is enforced AT BUILD (R3/REQ-9: the array arrives
  // pre-capped to bounds.max_playbooks in preference-file order); the renderer
  // renders what is present. Playbooks consume ONLY the shared max_tokens
  // budget (NEVER tier-1/tier-2 count caps, R3). Suppression by id BEFORE dedup
  // (REQ-9). Dedup (R2.9(b)/EC5): a playbook id that is ALSO a tier-1 candidate
  // renders once in critical form (existing candidacy rule — the playbook band
  // skips it); playbook ids are then added to the tier-2 exclusion set the same
  // way tier-1 candidates are (one id, one line, always). The exclusion uses the
  // pre-budget candidacy set (mirrors the tier-1 F1 rule) so a playbook dropped
  // by the shared token budget is still excluded from tier 2.
  const playbooksRaw = Array.isArray(ss.playbooks) ? ss.playbooks : [];
  const playbookCandidates = playbooksRaw.filter((p) =>
    p && typeof p === "object" &&
    typeof p.episode_id === "string" && p.episode_id &&
    !s.has(p.episode_id) &&
    !tier1CandidateIds.has(p.episode_id));
  // Extend the cross-tier exclusion set so tier 2 also skips playbook ids
  // (mutates tier1CandidateIds in place — the variable is local to this call).
  for (const p of playbookCandidates) tier1CandidateIds.add(p.episode_id);
  const playbookLines = [];
  const droppedPlaybooks = [];
  const playbookEntries = []; // RFC-009 P4-S1 (R6) telemetry: parallel to playbookLines.
  for (const p of playbookCandidates) {
    const line = renderPlaybookLine(p);
    const t = estimateTokens(line);
    if (t > maxTokens || totalTokens + t > maxTokens) { droppedPlaybooks.push(p); continue; }
    playbookLines.push(line);
    playbookEntries.push({
      id: p.episode_id,
      effective_priority: p.effective_priority ?? 0, // playbooks pinned 0 (R2)
      rendered: "imperative", // playbooks always imperative (R4 S3)
      source_scope: p.source_scope ?? null,
      access_count_at_inject: p.access_count ?? 0,
    });
    totalTokens += t;
  }

  // ---- Tier 2: entries (plain-only, cross-tier dedup incl. playbook ids) ----
  const tier2Candidates = entriesRaw.filter((e) =>
    e && typeof e === "object" &&
    typeof e.episode_id === "string" && e.episode_id &&
    !tier1CandidateIds.has(e.episode_id) &&
    scopeOk(e, identity) &&
    !s.has(e.episode_id));
  // entriesRaw is already pre-sorted by static_score desc (buildSessionStart);
  // preserve that order rather than re-sorting on a field tier 2 must not read.

  const tier2Lines = [];
  const tier2Entries = []; // RFC-009 P4-S1 (R6) telemetry: parallel to tier2Lines.
  for (const e of tier2Candidates) {
    const line = renderPlainLine(e);
    const t = estimateTokens(line);
    if (t > maxTokens || totalTokens + t > maxTokens) continue; // state I' — silent, never critical
    tier2Lines.push(line);
    // tier-2 entries carry NO effective_priority by REQ-18/§8.2 — the schema
    // pin is plain-only, so the rendered form is unconditionally 'plain'.
    tier2Entries.push({
      id: e.episode_id,
      effective_priority: null,
      rendered: "plain",
      source_scope: e.source_scope ?? null,
      access_count_at_inject: e.access_count ?? 0,
    });
    totalTokens += t;
  }

  // ---- Preflight advisory (generic derivation), BUDGETED like the tiers ------
  // RFC-009 R4 (line 122: the violation-preflight advisory shares the R3 caps) /
  // F3-R2: cap ids with an explicit '+N more' form, shrink to fit the shared
  // totalTokens/maxTokens envelope, drop whole only if the zero-id form will not fit
  // (drop-if-over, matching the tiers and the pattern-health advisory below).
  const preflightLines = [];
  for (const [taskType, counts] of Object.entries(preflightRaw)) {
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) continue;
    const ids = Object.keys(counts);
    if (ids.length === 0) continue;
    let total = 0;
    for (const id of ids) {
      const v = counts[id];
      if (Number.isFinite(v)) total += v;
    }
    if (total <= 0) continue;
    const pfRender = (k) => {
      const shown = ids.slice(0, k);
      const more = ids.length - shown.length;
      const inside = shown.join(", ") + (more > 0 ? `${shown.length ? ", " : ""}+${more} more` : "");
      return `preflight: ${total} recent ${taskType} violation(s) (${inside})`;
    };
    let k = ids.length;
    while (k > 0 && totalTokens + estimateTokens(pfRender(k)) > maxTokens) k--;
    const pfLine = pfRender(k);
    if (totalTokens + estimateTokens(pfLine) <= maxTokens) {
      preflightLines.push(pfLine);
      totalTokens += estimateTokens(pfLine);
    }
  }

  // ---- Overflow notes (RFC-011 R3 / REQ-9) ----
  // Token-drop note: one named id per note. When BOTH a critical and a playbook
  // line were dropped by the shared token budget, the critical id takes the
  // named slot and counts aggregate (round-2 planner N4 note-precedence). When
  // only a playbook line was dropped (no critical), the playbook form names an
  // id (R3 §8.2 verbatim `+N more suppressed, incl. playbook <episode_id>`).
  // Build-cap note (R3/REQ-9): when the build capped declarations at
  // max_playbooks (playbooks_capped > 0), a SECOND note names the first capped
  // id from session_start.playbooks_capped_first (both fields arrive inside the
  // merged session_start — no other data path exists to the renderer).
  const notes = [];
  const criticalDropped = droppedTier1.find((e) => Number(e.effective_priority) >= 8);
  if (criticalDropped) {
    notes.push(`+${droppedTier1.length + droppedPlaybooks.length} more matches suppressed, incl. critical ${criticalDropped.episode_id}`);
  } else if (droppedPlaybooks.length > 0) {
    notes.push(`+${droppedPlaybooks.length} more suppressed, incl. playbook ${droppedPlaybooks[0].episode_id}`);
  }
  if (Number.isInteger(ss.playbooks_capped) && ss.playbooks_capped > 0) {
    const first = typeof ss.playbooks_capped_first === "string" && ss.playbooks_capped_first
      ? ss.playbooks_capped_first
      : "";
    notes.push(`+${ss.playbooks_capped} declared playbooks capped, incl. ${first}`);
  }
  const overflowNote = notes.length > 0 ? notes.join("\n") : null;

  // ---- Pattern-health advisory (RFC-009 R5b, F3): exactly one line, strict
  // enum, BUDGETED against the same running totalTokens/maxTokens as the tiers.
  // A large unhealthy set can never exceed the R3 bound: ids are capped with an
  // explicit '+N more' form, shrinking until the line fits; if even '(+N more)'
  // will not fit, the line is dropped (drop-if-over, matching the tiers above).
  const patternHealthLines = [];
  if (patternHealthRaw && (patternHealthRaw.verdict === "needs-attention" || patternHealthRaw.verdict === "needs-enforcement")) {
    const n = Number.isInteger(patternHealthRaw.unhealthy) ? patternHealthRaw.unhealthy : 0;
    const phIds = Array.isArray(patternHealthRaw.pattern_ids) ? patternHealthRaw.pattern_ids.filter((x) => typeof x === "string") : [];
    const phRender = (k) => {
      const shown = phIds.slice(0, k);
      const more = phIds.length - shown.length;
      const inside = shown.join(", ") + (more > 0 ? `${shown.length ? ", " : ""}+${more} more` : "");
      return `pattern-health: ${n} unhealthy (${inside}) - run node scripts/em-pattern-health.mjs --hermetic`;
    };
    let k = phIds.length;
    while (k > 0 && totalTokens + estimateTokens(phRender(k)) > maxTokens) k--;
    const phLine = phRender(k);
    if (totalTokens + estimateTokens(phLine) <= maxTokens) {
      patternHealthLines.push(phLine);
      totalTokens += estimateTokens(phLine);
    }
  }

  return {
    lines: [...tier1Lines, ...playbookLines, ...tier2Lines, ...preflightLines, ...patternHealthLines],
    overflowNote,
    entries: [...tier1Entries, ...playbookEntries, ...tier2Entries], // RFC-009 P4-S1 (R6) telemetry
  };
}

// ---------------------------------------------------------------------------
// PUBLIC: matchActivation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ActivationEvent
 * @property {'prompt'|'tool'|'session_start'} kind
 * @property {string} [prompt]
 * @property {string} [tool]
 * @property {string} [target]
 *
 * @typedef {Object} MatchResult
 * @property {string[]} lines
 * @property {string|null} overflowNote
 */

/**
 * Pure, zero-I/O matcher core (RFC-009 R3, plan §12). Fails OPEN to
 * `{lines:[], overflowNote:null}` on any internal error; throws nothing;
 * never returns a decision/block/permissionDecision field.
 *
 * @param {{entries?:Array<object>, activity_phrases?:object}} index
 * @param {ActivationEvent} event
 * @param {{slug?:string, root?:string, tool_id?:string}} identity
 * @param {Set<string>} [suppress]
 * @param {{max_matches?:number, max_tokens?:number}} [bounds]
 * @returns {MatchResult}
 */
export function matchActivation(index, event, identity, suppress, bounds) {
  try {
    const kind = event && event.kind;

    // R4/S5: session_start is a distinct rendering path (two-tier blend +
    // preflight advisory from index.session_start), not the prompt/tool
    // trigger-matching path below.
    if (kind === "session_start") {
      return renderSessionStart(index && index.session_start, identity, suppress, bounds);
    }

    const entries = sanitizeEntries(index);
    if (entries.length === 0) return { lines: [], overflowNote: null, entries: [] };

    if (kind !== "prompt" && kind !== "tool") {
      // any other/unknown kind: empty, advisory (fail open).
      return { lines: [], overflowNote: null, entries: [] };
    }

    const candidates = candidatesForEvent(entries, event, index, identity);
    const surviving = filterSuppressed(candidates, suppress);
    const deduped = dedupByEpisodePreferPlaybook(surviving); // RFC-011 R2.9(b) one-per-episode + playbook-wins
    if (deduped.length === 0) return { lines: [], overflowNote: null, entries: [] };

    return selectAndBound(deduped, bounds);
  } catch {
    return { lines: [], overflowNote: null, entries: [] };
  }
}

// Exported for the test file's direct unit coverage of the parsing/escape
// helpers (word-boundary/regex-metachar/tool-glob edge cases) without
// re-deriving them through full matchActivation fixtures.
export { matchesPhrase, matchesToolTrigger, parseToolTrigger, scopeOk, isImperative, renderLine, renderPlainLine, renderPlaybookLine, estimateTokens, renderSessionStart, dedupByEpisodePreferPlaybook };
