#!/usr/bin/env node
/**
 * codex-adapter.mjs — Codex CLI enforcement command hook (RFC-008 P6 S2).
 *
 * Protocol (Codex PreToolUse command hook):
 *   stdin  — JSON: Codex PreToolUse payload
 *              {hook_event_name, tool_name, tool_input, cwd, session_id, ...}
 *   stdout — JSON on DENY: {hookSpecificOutput:{hookEventName,permissionDecision,permissionDecisionReason}}
 *   exit 2 — block (deny);  exit 0 — allow (no stdout required)
 *
 * Fail-closed states:
 *   State A — non-PreToolUse hook_event_name → exit 0 (pass-through).
 *   State B — garbage/non-object stdin, missing hook_event_name, non-absolute cwd,
 *             or ANY internal throw → deny JSON + exit 2.
 *   State C — apply_patch with unparseable or empty patch → deny JSON + exit 2.
 *   State D — no repo-source write targets extracted → exit 0 (allow).
 *   State E — GATED write + enforce/block token → deny JSON + exit 2.
 *   State F — GATED write + clamp-off/silence token (operator downgrade) → exit 0.
 *
 * Zero external dependencies. Node.js stdlib only.
 * Thin-waist (isRepoSource, gateDisposition) imported dynamically inside the
 * outer try so an import failure → deny + exit 2, NOT raw exit 1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root: 3 levels up from plugins/codex/capabilities/
const ADAPTER_ROOT = path.resolve(__dirname, "..", "..", "..");

// ---------------------------------------------------------------------------
// Script path resolution — co-located (deployed) → in-repo dev fallback.
// Mirrors enforce-bridge.mjs resolveScriptPath pattern.
// ---------------------------------------------------------------------------
function resolveScriptPath(relFromAdapter, relFromRepo) {
  const deployed = path.resolve(__dirname, relFromAdapter);
  if (fs.existsSync(deployed)) return deployed;
  return path.resolve(ADAPTER_ROOT, relFromRepo);
}

const REPO_SOURCE_MJS = resolveScriptPath(
  "../../scripts/lib/repo-source.mjs",
  "scripts/lib/repo-source.mjs",
);
const ENFORCE_CONTRACT_MJS = resolveScriptPath(
  "../../scripts/enforce-contract.mjs",
  "scripts/enforce-contract.mjs",
);

// ---------------------------------------------------------------------------
// Constants (§A.5)
// ---------------------------------------------------------------------------

// apply_patch file directives — the four recognized forms.
const APPLY_PATCH_DIRECTIVES = [
  /^\*\*\* Add File: (.+)$/,
  /^\*\*\* Update File: (.+)$/,
  /^\*\*\* Delete File: (.+)$/,
  /^\*\*\* Move to: (.+)$/,
];

// SINK_OR_FDDUP — drop operand: /dev/null or bare integer (fd-dup).
const SINK_OR_FDDUP = (x) => x === "/dev/null" || /^\d+$/.test(x);

// Commands whose DESTINATION operand is the write target.
const COPY_FAMILY = new Set(["cp", "mv", "install"]);

// ---------------------------------------------------------------------------
// deny — write canonical deny JSON to stdout + stderr, then exit 2.
// ---------------------------------------------------------------------------
function DENY_JSON(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function deny(reason) {
  try {
    process.stdout.write(JSON.stringify(DENY_JSON(reason)) + "\n");
  } catch {}
  process.stderr.write(`codex-adapter: deny — ${reason}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// classifyLabel — telemetry / deny-reason label ONLY. NOT gating.
// ---------------------------------------------------------------------------
function classifyLabel(tool, toolInput) {
  const t = (tool || "").toLowerCase();
  if (t === "read") return "read_only";
  if (t === "write" || t === "edit" || t === "multiedit") return "shared_write";
  if (t === "apply_patch") return "shared_write";
  if (t === "bash") {
    const cmd = (toolInput && (toolInput.command || toolInput.cmd)) || "";
    if (/\bgit\s+push\b|\bgh\s+pr\s+create\b/.test(cmd)) return "push_or_pr_create";
    return "shared_write";
  }
  return "shared_write";
}

// ---------------------------------------------------------------------------
// shellSplit — quote-aware tokenizer (§A.5, codex r6.2).
// Splits cmd on unquoted whitespace. Strips surrounding quotes from each
// token, preserving the inner content in .val. Sets .dynamic when the token
// contains $VAR, $(...), backtick, or unescaped glob metachar — dynamic
// tokens are NOT extracted as write targets (extract-only, §8.2 residual).
// ---------------------------------------------------------------------------
function shellSplit(cmd) {
  const tokens = [];
  let i = 0;
  const n = cmd.length;

  while (i < n) {
    // Skip unquoted whitespace.
    while (i < n && /[ \t\n]/.test(cmd[i])) i++;
    if (i >= n) break;

    let raw = "", val = "", dynamic = false;

    while (i < n && !/[ \t\n]/.test(cmd[i])) {
      const ch = cmd[i];
      if (ch === '"' || ch === "'") {
        const q = ch;
        raw += ch;
        i++;
        let closed = false;
        while (i < n) {
          if (cmd[i] === q) { raw += cmd[i]; i++; closed = true; break; }
          if (q === '"' && (cmd[i] === "$" || cmd[i] === "`")) dynamic = true;
          raw += cmd[i];
          val += cmd[i]; // quotes stripped — inner content only
          i++;
        }
        if (!closed) dynamic = true; // unmatched quote → dynamic
      } else {
        raw += ch;
        val += ch;
        // Dynamic markers in unquoted context.
        if (
          ch === "$" &&
          i + 1 < n &&
          (cmd[i + 1] === "(" || /[a-zA-Z_{]/.test(cmd[i + 1]))
        )
          dynamic = true;
        if (ch === "`") dynamic = true;
        if (
          (ch === "*" || ch === "?" || ch === "[") &&
          (raw.length <= 1 || cmd[i - 1] !== "\\")
        )
          dynamic = true;
        i++;
      }
    }

    if (raw.length > 0) tokens.push({ raw, val, dynamic });
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// detectRedirect — classify a token (by .val) as a redirect operator.
// Returns {operand, fd_dup} or null. operand is null for standalone (>).
// ---------------------------------------------------------------------------
function detectRedirect(v) {
  let m;

  // &>FILE — stdout+stderr to file (must check before >)
  m = v.match(/^&>(.*)$/);
  if (m) return { operand: m[1] || null };

  // >&N (fd-dup) or >&FILE
  m = v.match(/^>&(.*)$/);
  if (m) {
    const rest = m[1];
    if (!rest || /^\d+$/.test(rest)) return { fd_dup: true };
    return { operand: rest };
  }

  // N>> or >> — append (check before N> to avoid double-match)
  m = v.match(/^\d*>>(.*)$/);
  if (m) {
    const operand = m[1] || null;
    if (operand && /^&\d*$/.test(operand)) return { fd_dup: true };
    return { operand };
  }

  // N> or > — write (not >>)
  m = v.match(/^\d*>(?!>)(.*)$/);
  if (m) {
    const operand = m[1] || null;
    // &N in operand = fd-dup (e.g. 2>&1 → operand &1)
    if (operand && /^&\d*$/.test(operand)) return { fd_dup: true };
    return { operand };
  }

  return null;
}

// ---------------------------------------------------------------------------
// parseCopyFamilyDest — extract the destination for cp/mv/install.
// Handles: -t DEST, -tDEST, --target-directory DEST, --target-directory=DEST,
// and last-non-flag-operand convention. tokens[0] is the command name.
// ---------------------------------------------------------------------------
function parseCopyFamilyDest(tokens) {
  let targetDir = null;
  const operands = [];
  let j = 1; // skip command name

  while (j < tokens.length) {
    const t = tokens[j];
    const v = t.val;

    if (v === "-t") {
      j++;
      if (j < tokens.length && !tokens[j].dynamic) {
        targetDir = tokens[j].val;
        j++;
      }
      continue;
    }
    if (v.startsWith("-t") && v.length > 2) {
      if (!t.dynamic) targetDir = v.slice(2);
      j++;
      continue;
    }
    if (v === "--target-directory") {
      j++;
      if (j < tokens.length && !tokens[j].dynamic) {
        targetDir = tokens[j].val;
        j++;
      }
      continue;
    }
    if (v.startsWith("--target-directory=")) {
      if (!t.dynamic) targetDir = v.slice("--target-directory=".length);
      j++;
      continue;
    }
    if (v.startsWith("-")) { j++; continue; }
    if (!t.dynamic) operands.push(v);
    j++;
  }

  if (targetDir !== null) return targetDir;
  if (operands.length > 0) return operands[operands.length - 1]; // last non-flag = dest
  return null;
}

// ---------------------------------------------------------------------------
// extractBashTargets — FROZEN to §12.1 MUST-CATCH table.
// Returns [] when no write target is lexable. Dynamic/unlexable operands are
// silently NOT extracted (extract-only, never unknown; §8.2 Bash residual).
// ---------------------------------------------------------------------------
function extractBashTargets(cmd) {
  const tokens = shellSplit(cmd);
  if (tokens.length === 0) return [];

  const firstWord = tokens[0].val;
  const targets = [];

  // cp/mv/install — handle as a unit (destination extraction)
  if (COPY_FAMILY.has(firstWord) && !tokens[0].dynamic) {
    const dest = parseCopyFamilyDest(tokens);
    if (dest !== null) targets.push(dest);
    return targets;
  }

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const v = tok.val;

    // sed — in-place edit ONLY when -i/--in-place is present (without -i, sed writes
    // to stdout, not the file → no target). sed grammar: `sed [opts] SCRIPT [file...]`,
    // where the FIRST non-flag operand is the SCRIPT unless -e/-f gave it explicitly.
    // -i is GNU-attached (`-i`, `-i.bak`) or BSD-separate (`-i ''` — suffix is its own,
    // possibly empty, token). codex r7 S2-review fix: the old "next non-flag token"
    // rule mis-took the SCRIPT for the file (false-deny on carveouts like
    // `sed -i 's/a/b/' docs/plans/x.md`) and the BSD empty suffix for the file
    // (false-ALLOW = repo-source bypass on `sed -i '' 's/a/b/' src/x.mjs`).
    if (v === "sed") {
      i++;
      let inPlace = false;
      let explicitScript = false;
      const operands = [];
      while (i < tokens.length) {
        const t = tokens[i];
        const tv = t.val;
        if (tv === "-i" || tv === "--in-place") {
          inPlace = true;
          // BSD: a bare -i consumes a SEPARATE (possibly empty) suffix token. Consume
          // ONLY an empty next token as that suffix (a real script/file is never "");
          // a non-empty next token is the script/file (GNU bare -i).
          if (i + 1 < tokens.length && tokens[i + 1].val === "") i++;
          i++;
          continue;
        }
        if (/^-i/.test(tv) || /^--in-place=/.test(tv)) { inPlace = true; i++; continue; } // GNU -i.bak / --in-place=.bak
        if (tv === "-e" || tv === "-f" || tv === "--expression" || tv === "--file") {
          explicitScript = true;
          i++; if (i < tokens.length) i++; // skip the script/file argument
          continue;
        }
        if (/^(-e|--expression=|-f|--file=)/.test(tv)) { explicitScript = true; i++; continue; } // attached -e'…'
        if (tv.startsWith("-")) { i++; continue; } // other flags (-n, -E, -r, --quiet, …)
        operands.push(t);
        i++;
      }
      if (inPlace) {
        // Implicit script ⇒ the first operand is the SCRIPT (drop it); the rest are
        // in-place file targets. With -e/-f, every operand is a file.
        const files = explicitScript ? operands : operands.slice(1);
        for (const f of files) if (!f.dynamic && f.val) targets.push(f.val);
      }
      continue;
    }

    // tee [-a] FILE… — each following non-flag operand is a write target
    if (v === "tee") {
      i++;
      while (i < tokens.length) {
        const t = tokens[i];
        if (t.val === "-a" || t.val === "--append") { i++; continue; }
        if (t.val.startsWith("-")) break;
        if (!t.dynamic) targets.push(t.val);
        i++;
      }
      continue;
    }

    // dd of=FILE
    if (v === "dd") {
      i++;
      while (i < tokens.length) {
        const t = tokens[i];
        const m = t.val.match(/^of=(.+)$/);
        if (m && !t.dynamic) targets.push(m[1]);
        i++;
      }
      continue;
    }

    // Redirect operators — GLOBAL scan (catches all redirects in the command)
    const redir = detectRedirect(v);
    if (redir) {
      if (redir.fd_dup) { i++; continue; }

      const operand = redir.operand;
      if (operand !== null && operand !== "") {
        // Attached operand (already de-quoted by shellSplit)
        if (!tok.dynamic && !SINK_OR_FDDUP(operand)) targets.push(operand);
        i++;
      } else {
        // Standalone: next token is the operand
        i++;
        if (i < tokens.length) {
          const opTok = tokens[i];
          if (!opTok.dynamic && opTok.val && !SINK_OR_FDDUP(opTok.val)) {
            targets.push(opTok.val);
          }
          i++;
        }
      }
      continue;
    }

    i++;
  }

  return targets;
}

// ---------------------------------------------------------------------------
// extractTargetPaths — per-tool path extraction (§12).
// Returns {paths:string[], unknown:bool}.
// unknown=true ONLY for apply_patch; Bash NEVER sets unknown (§8.2).
// ---------------------------------------------------------------------------
function extractTargetPaths(toolName, toolInput) {
  const t = (toolName || "").toLowerCase();

  if (t === "write" || t === "edit" || t === "multiedit") {
    const p = toolInput && (toolInput.filePath || toolInput.file_path);
    return { paths: p ? [p] : [], unknown: false };
  }

  if (t === "apply_patch") {
    const command = (toolInput && toolInput.command) || "";
    const paths = [];
    let unknown = false;

    for (const line of command.split("\n")) {
      if (!line.startsWith("*** ")) continue;
      if (line === "*** Begin Patch" || line === "*** End Patch") continue;
      let matched = false;
      for (const re of APPLY_PATCH_DIRECTIVES) {
        const m = line.match(re);
        if (m) { paths.push(m[1].trim()); matched = true; break; }
      }
      if (!matched) { unknown = true; break; } // unrecognized *** directive
    }

    if (paths.length === 0) unknown = true; // empty patch
    return { paths, unknown };
  }

  if (t === "bash") {
    const cmd = (toolInput && (toolInput.command || toolInput.cmd)) || "";
    return { paths: extractBashTargets(cmd), unknown: false };
  }

  return { paths: [], unknown: false };
}

// ---------------------------------------------------------------------------
// buildNormalizedPayload — canonical event payload for step-8 and binding tests.
// Synthesizes an integer turn_index (per-process counter from 0). NOT on the
// live block/allow decision path.
// ---------------------------------------------------------------------------
let _turnIndex = 0;
export function buildNormalizedPayload(stdin) {
  return {
    tool: stdin.tool_name || null,
    tool_args: stdin.tool_input || null,
    cwd: stdin.cwd || null,
    session_id: stdin.session_id || null,
    turn_index: _turnIndex++,
    timestamp_iso8601: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// main — entry point (async; runs only when executed as script)
// ---------------------------------------------------------------------------
async function main() {
  try {
    // Read all stdin.
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");

    // JSON.parse throws on invalid input → caught by outer try → deny + exit 2.
    const stdin = JSON.parse(raw);

    // State B: non-object → fail-closed.
    if (typeof stdin !== "object" || stdin === null || Array.isArray(stdin)) {
      deny("stdin must be a JSON object (State B)");
    }
    if (typeof stdin.hook_event_name !== "string") {
      deny("missing or non-string hook_event_name (State B)");
    }

    // State A: non-PreToolUse hook → pass-through.
    if (stdin.hook_event_name !== "PreToolUse") {
      process.exit(0);
    }

    // State B: cwd must be an absolute path.
    const cwd = stdin.cwd;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
      deny("cwd must be an absolute path (State B)");
    }

    // Resolve root from stdin.cwd ONLY — never process.cwd() (codex r7 F1).
    let root;
    try {
      root = fs.realpathSync(cwd);
    } catch (e) {
      deny(`cannot realpath cwd ${JSON.stringify(cwd)}: ${e.message}`);
    }

    const toolName = stdin.tool_name || "";
    const toolInput = stdin.tool_input || {};
    const label = classifyLabel(toolName, toolInput); // telemetry only

    // Extract write-target paths (tool-specific, §12).
    const { paths: rawPaths, unknown } = extractTargetPaths(toolName, toolInput);

    // State C: apply_patch unknown → deny unconditionally (BEFORE disposition).
    if (unknown) {
      deny(`apply_patch: unparseable or empty patch (State C, label=${label})`);
    }

    // Normalize: resolve relative paths against stdin root (codex F1/F2).
    // shellSplit already de-quotes; path.resolve handles relative.
    const paths = rawPaths.map((p) =>
      path.isAbsolute(p) ? p : path.resolve(root, p),
    );

    // -----------------------------------------------------------------------
    // Dynamic imports INSIDE the outer try (planner N2):
    // A missing waist throws ERR_MODULE_NOT_FOUND → caught → deny + exit 2.
    // A static top-level import of a missing module exits 1 — NOT the block
    // signal — which would confuse Codex into thinking the hook passed.
    // -----------------------------------------------------------------------
    const { isRepoSource } = await import(REPO_SOURCE_MJS);
    const {
      gateDisposition,
      loadEnforceConfig,
      resolveContractRoot,
      resolveHarnessCap,
    } = await import(ENFORCE_CONTRACT_MJS);

    // Resolve contract artifacts (fail-closed on missing).
    const contractRoot = resolveContractRoot();
    let registry = null, enforceConfigSchema = null, eventsJson = null;
    if (contractRoot) {
      try { registry = JSON.parse(fs.readFileSync(path.join(contractRoot, "plugins", "_index.json"), "utf8")); } catch {}
      try { enforceConfigSchema = JSON.parse(fs.readFileSync(path.join(contractRoot, "patterns", "enforce-config.schema.json"), "utf8")); } catch {}
      try { eventsJson = JSON.parse(fs.readFileSync(path.join(contractRoot, "patterns", "events.json"), "utf8")); } catch {}
    }

    // Duplicate-binding check (M8).
    const { duplicate } = resolveHarnessCap(registry, "codex", "pre_tool_use");

    // Operator config: active + configTier.
    // configTier comes from enforce-config key bp-001.pre_checkpoint. The single
    // Codex PreToolUse hook models the PRE-IMPLEMENTATION CHECKPOINT gate (block
    // repo-source writes), so it clamps on the SAME key the native bash
    // checkpoint-gate.sh uses for that gate (cross-gate consistency, schema-valid).
    // CROSS-HARNESS NOTE (codex r7 S2-review, plan §12/runbook §5): unlike the Claude
    // bash layer — which resolves plan_approval, pre_checkpoint, and post_checkpoint
    // as three distinct pre_tool_use gate MOMENTS — this stateless single hook does
    // NOT separately model plan_approval/post_checkpoint; bp-001.pre_checkpoint:MEDIUM
    // clamps every covered Codex repo-source write. (opencode leaves configTier null.)
    const cfg = loadEnforceConfig(root, enforceConfigSchema);
    const { active } = cfg;
    const configTier =
      cfg.bps["bp-001"] && typeof cfg.bps["bp-001"]["pre_checkpoint"] === "string"
        ? cfg.bps["bp-001"]["pre_checkpoint"]
        : null;

    // State D: no repo-source path → ALLOW.
    // Call isRepoSource DIRECTLY per path (codex r7 F1: NOT toolTargetsRepoSource
    // which short-circuits read_only/nonsrc_write labels BEFORE path check).
    const GATED =
      paths.length > 0 &&
      paths.some((p) => isRepoSource(root, p).isRepoSource);

    // Gate disposition: runtime mechanism cap = STRONG (NOT manifest MEDIUM).
    // events.json maps MEDIUM → "warn" → clamp-off → allow. Using STRONG ensures
    // covered writes are blocked (codex r7 F6). Manifest/registry declare MEDIUM
    // for honesty; only the runtime decision passes STRONG (§19.4 design split).
    const disp = gateDisposition({
      duplicate,
      harnessCap: "STRONG",
      contractTier: null,
      active,
      configTier,
      events: eventsJson,
      event: "pre_tool_use",
    });

    // State E: GATED + enforce/block → deny.
    const block = GATED && (disp.token === "enforce" || disp.token === "block");
    if (block) {
      const blockedPath =
        paths.find((p) => isRepoSource(root, p).isRepoSource) || paths[0];
      const reason = `repo-source write gated: ${blockedPath} (tool=${toolName}, label=${label}, tier=${disp.effTier || "STRONG"})`;
      deny(reason);
    }

    // States D / F: allow.
    process.exit(0);
  } catch (e) {
    // Any uncaught error (including import failure) → fail-closed (State B).
    const reason = `internal error: ${e && e.message ? e.message : String(e)}`;
    try { process.stdout.write(JSON.stringify(DENY_JSON(reason)) + "\n"); } catch {}
    process.stderr.write(`codex-adapter: ${reason}\n`);
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Entry-point guard — run main() only when executed as a script.
// ---------------------------------------------------------------------------
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    const r = `unhandled: ${e && e.message ? e.message : String(e)}`;
    try { process.stdout.write(JSON.stringify(DENY_JSON(r)) + "\n"); } catch {}
    process.stderr.write(`codex-adapter: ${r}\n`);
    process.exit(2);
  });
}
