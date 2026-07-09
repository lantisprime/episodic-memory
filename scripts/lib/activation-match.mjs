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
// REQ-11 render. No decision/block/permissionDecision field in either form.
// ---------------------------------------------------------------------------
function renderLine(entry) {
  const id = entry.episode_id;
  const summary = String(entry.summary ?? "");
  if (Number(entry.effective_priority) >= 8) {
    return `READ ${id} before proceeding (em-search --history ${id} --full): ${summary}`;
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
    totalTokens += lineTokens;
  }

  const criticalDropped = dropped.find((e) => Number(e.effective_priority) >= 8);
  const overflowNote = criticalDropped
    ? `+${dropped.length} more matches suppressed, incl. critical ${criticalDropped.episode_id}`
    : null;

  return { lines, overflowNote };
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
  const droppedTier1 = [];
  let totalTokens = 0;
  for (const e of sortedTier1) {
    if (tier1Lines.length >= maxMatches) { droppedTier1.push(e); continue; }
    const line = renderLine(e); // tier 1 always carries effective_priority>=8 -> always imperative
    const t = estimateTokens(line);
    if (t > maxTokens || totalTokens + t > maxTokens) { droppedTier1.push(e); continue; }
    tier1Lines.push(line);
    totalTokens += t;
  }

  // ---- Tier 2: entries (plain-only, cross-tier dedup) ----------------------
  const tier2Candidates = entriesRaw.filter((e) =>
    e && typeof e === "object" &&
    typeof e.episode_id === "string" && e.episode_id &&
    !tier1CandidateIds.has(e.episode_id) &&
    scopeOk(e, identity) &&
    !s.has(e.episode_id));
  // entriesRaw is already pre-sorted by static_score desc (buildSessionStart);
  // preserve that order rather than re-sorting on a field tier 2 must not read.

  const tier2Lines = [];
  for (const e of tier2Candidates) {
    const line = renderPlainLine(e);
    const t = estimateTokens(line);
    if (t > maxTokens || totalTokens + t > maxTokens) continue; // state I' — silent, never critical
    tier2Lines.push(line);
    totalTokens += t;
  }

  // ---- Preflight advisory (generic derivation) -----------------------------
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
    preflightLines.push(`preflight: ${total} recent ${taskType} violation(s) (${ids.join(", ")})`);
  }

  const criticalDropped = droppedTier1.find((e) => Number(e.effective_priority) >= 8);
  const overflowNote = criticalDropped
    ? `+${droppedTier1.length} more matches suppressed, incl. critical ${criticalDropped.episode_id}`
    : null;

  return { lines: [...tier1Lines, ...tier2Lines, ...preflightLines], overflowNote };
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
    if (entries.length === 0) return { lines: [], overflowNote: null };

    if (kind !== "prompt" && kind !== "tool") {
      // any other/unknown kind: empty, advisory (fail open).
      return { lines: [], overflowNote: null };
    }

    const candidates = candidatesForEvent(entries, event, index, identity);
    const surviving = filterSuppressed(candidates, suppress);
    if (surviving.length === 0) return { lines: [], overflowNote: null };

    return selectAndBound(surviving, bounds);
  } catch {
    return { lines: [], overflowNote: null };
  }
}

// Exported for the test file's direct unit coverage of the parsing/escape
// helpers (word-boundary/regex-metachar/tool-glob edge cases) without
// re-deriving them through full matchActivation fixtures.
export { matchesPhrase, matchesToolTrigger, parseToolTrigger, scopeOk, renderLine, renderPlainLine, estimateTokens, renderSessionStart };
