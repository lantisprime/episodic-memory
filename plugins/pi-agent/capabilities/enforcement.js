/**
 * enforcement.js — Pi coding-agent enforcement extension (RFC-008 P7 S2).
 *
 * Pi loads this as a project-local extension (`<project>/.pi/extensions/…`). It runs
 * IN-PROCESS in Pi's Node host (S0 2026-07-01: Node v26, hasBun=false). The `tool_call`
 * event is the blocking pre-tool hook: returning {block:true, reason} denies the tool
 * before it runs. Delivered capability {pi-agent, pre_tool_use} = MEDIUM (bash-lexing
 * residual, plugins/bypass_known.json); the runtime disposition passes harnessCap STRONG so
 * covered repo-source writes actually block (see gateDisposition call).
 *
 * §12 State table (handler return):
 *   A  non-write tool (read/grep/find/ls/…)            → undefined (allow)
 *   B  non-object event/input, or non-absolute ctx.cwd → {block:true} (fail-closed)
 *   B2 repoRoot unresolvable for an under-baseCwd path  → {block:true} (fail-closed)
 *   C1 bash with no lexable write target               → undefined (allow; extract-only residual)
 *   C2 write/edit missing/empty/non-string input.path  → {block:true} (malformed ≠ carveout)
 *   D  waist import() throws                            → {block:true} (fail-closed)
 *   E  ≥1 resolved path isRepoSource + token∈{enforce,block} → {block:true, reason}
 *   F  isRepoSource but operator clamp-off (warn/allow) → undefined (allow)
 *   G  no path isRepoSource (outside-repo/carveout/ignored) → undefined (allow; locked R3)
 *   H  any uncaught error                               → {block:true} (fail-closed)
 *
 * S0 facts baked in: in-process import of the .mjs waist works (no spawn); Pi ctx exposes
 * NO projectRoot, so repoRoot = git-toplevel(realpath(ctx.cwd)).
 *
 * Zero external dependencies. Node stdlib only.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Deployed layout: <project>/.pi/extensions/episodic-memory/{index.js|enforcement.js,
// scripts/…}. Repo-dev layout: plugins/pi-agent/capabilities/enforcement.js with the waist
// at ../../../scripts. resolveScriptPath tries the co-deployed copy first, then the repo dev
// path (mirrors codex-adapter.mjs).
const ADAPTER_ROOT = path.resolve(__dirname, "..", "..", "..");

function resolveScriptPath(relDeployed, relRepo) {
  const deployed = path.resolve(__dirname, relDeployed);
  if (fs.existsSync(deployed)) return deployed;
  return path.resolve(ADAPTER_ROOT, relRepo);
}

const REPO_SOURCE_MJS = resolveScriptPath("scripts/lib/repo-source.mjs", "scripts/lib/repo-source.mjs");
const ENFORCE_CONTRACT_MJS = resolveScriptPath("scripts/enforce-contract.mjs", "scripts/enforce-contract.mjs");

// ---------------------------------------------------------------------------
// Constants (mirrors codex-adapter §A.5)
// ---------------------------------------------------------------------------
const PI_WRITE_TOOLS = new Set(["write", "edit"]);
// Known read-only tools (State A allowlist). Any OTHER tool is treated conservatively: if it
// carries a write surface (string input.path or input.command) it is gated (codex r6 MAJOR —
// an unknown write-capable tool must not slip through); if it carries no surface it allows.
const PI_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SINK_OR_FDDUP = (x) => x === "/dev/null" || /^\d+$/.test(x);
const COPY_FAMILY = new Set(["cp", "mv", "install"]);

// ---------------------------------------------------------------------------
// Bash target extractor — COPIED verbatim from plugins/codex/capabilities/codex-adapter.mjs
// (RFC-008 P7 OD-1: copy + parity test rather than extract from the frozen codex adapter).
// codex-adapter.mjs does NOT export extractBashTargets, so the parity test
// (tests/test-pi-bash-parity.mjs) runs a shared golden corpus of bash commands + expected
// targets through this copy and asserts the expected output (a drift guard against the codex
// original). `extractBashTargets` is exported below for that test.
// ---------------------------------------------------------------------------
function shellSplit(cmd) {
  const tokens = [];
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    while (i < n && /[ \t\n]/.test(cmd[i])) i++;
    if (i >= n) break;
    let raw = "", val = "", dynamic = false;
    while (i < n && !/[ \t\n]/.test(cmd[i])) {
      const ch = cmd[i];
      if (ch === '"' || ch === "'") {
        const q = ch;
        raw += ch; i++;
        let closed = false;
        while (i < n) {
          if (cmd[i] === q) { raw += cmd[i]; i++; closed = true; break; }
          if (q === '"' && (cmd[i] === "$" || cmd[i] === "`")) dynamic = true;
          raw += cmd[i]; val += cmd[i]; i++;
        }
        if (!closed) dynamic = true;
      } else {
        raw += ch; val += ch;
        if (ch === "$" && i + 1 < n && (cmd[i + 1] === "(" || /[a-zA-Z_{]/.test(cmd[i + 1]))) dynamic = true;
        if (ch === "`") dynamic = true;
        if ((ch === "*" || ch === "?" || ch === "[") && (raw.length <= 1 || cmd[i - 1] !== "\\")) dynamic = true;
        i++;
      }
    }
    if (raw.length > 0) tokens.push({ raw, val, dynamic });
  }
  return tokens;
}

function detectRedirect(v) {
  let m;
  m = v.match(/^&>(.*)$/);
  if (m) return { operand: m[1] || null };
  m = v.match(/^>&(.*)$/);
  if (m) {
    const rest = m[1];
    if (!rest || /^\d+$/.test(rest)) return { fd_dup: true };
    return { operand: rest };
  }
  m = v.match(/^\d*>>(.*)$/);
  if (m) {
    const operand = m[1] || null;
    if (operand && /^&\d*$/.test(operand)) return { fd_dup: true };
    return { operand };
  }
  m = v.match(/^\d*>(?!>)(.*)$/);
  if (m) {
    const operand = m[1] || null;
    if (operand && /^&\d*$/.test(operand)) return { fd_dup: true };
    return { operand };
  }
  return null;
}

function parseCopyFamilyDest(tokens) {
  let targetDir = null;
  const operands = [];
  let j = 1;
  while (j < tokens.length) {
    const t = tokens[j];
    const v = t.val;
    if (v === "-t") { j++; if (j < tokens.length && !tokens[j].dynamic) { targetDir = tokens[j].val; j++; } continue; }
    if (v.startsWith("-t") && v.length > 2) { if (!t.dynamic) targetDir = v.slice(2); j++; continue; }
    if (v === "--target-directory") { j++; if (j < tokens.length && !tokens[j].dynamic) { targetDir = tokens[j].val; j++; } continue; }
    if (v.startsWith("--target-directory=")) { if (!t.dynamic) targetDir = v.slice("--target-directory=".length); j++; continue; }
    if (v.startsWith("-")) { j++; continue; }
    if (!t.dynamic) operands.push(v);
    j++;
  }
  if (targetDir !== null) return targetDir;
  if (operands.length > 0) return operands[operands.length - 1];
  return null;
}

export function extractBashTargets(cmd) {
  const tokens = shellSplit(cmd);
  if (tokens.length === 0) return [];
  const firstWord = tokens[0].val;
  const targets = [];
  if (COPY_FAMILY.has(firstWord) && !tokens[0].dynamic) {
    const dest = parseCopyFamilyDest(tokens);
    if (dest !== null) targets.push(dest);
    return targets;
  }
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    const v = tok.val;
    if (v === "sed") {
      i++;
      let inPlace = false, explicitScript = false;
      const operands = [];
      while (i < tokens.length) {
        const t = tokens[i];
        const tv = t.val;
        if (tv === "-i" || tv === "--in-place") { inPlace = true; if (i + 1 < tokens.length && tokens[i + 1].val === "") i++; i++; continue; }
        if (/^-i/.test(tv) || /^--in-place=/.test(tv)) { inPlace = true; i++; continue; }
        if (tv === "-e" || tv === "-f" || tv === "--expression" || tv === "--file") { explicitScript = true; i++; if (i < tokens.length) i++; continue; }
        if (/^(-e|--expression=|-f|--file=)/.test(tv)) { explicitScript = true; i++; continue; }
        if (tv.startsWith("-")) { i++; continue; }
        operands.push(t); i++;
      }
      if (inPlace) {
        const files = explicitScript ? operands : operands.slice(1);
        for (const f of files) if (!f.dynamic && f.val) targets.push(f.val);
      }
      continue;
    }
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
    const redir = detectRedirect(v);
    if (redir) {
      if (redir.fd_dup) { i++; continue; }
      const operand = redir.operand;
      if (operand !== null && operand !== "") {
        if (!tok.dynamic && !SINK_OR_FDDUP(operand)) targets.push(operand);
        i++;
      } else {
        i++;
        if (i < tokens.length) {
          const opTok = tokens[i];
          if (!opTok.dynamic && opTok.val && !SINK_OR_FDDUP(opTok.val)) targets.push(opTok.val);
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
// extractTargetPaths — Pi tool shapes (write/edit → input.path, bash → input.command).
// Returns {paths, malformed}. malformed=true only for write/edit with a bad path (State C2).
// ---------------------------------------------------------------------------
function extractTargetPaths(toolName, input) {
  const t = (toolName || "").toLowerCase();
  if (PI_WRITE_TOOLS.has(t)) {
    const p = input && input.path;
    if (typeof p !== "string" || p.length === 0) return { paths: [], malformed: true }; // C2
    return { paths: [p], malformed: false };
  }
  if (t === "bash") {
    const cmd = (input && input.command) || "";
    return { paths: extractBashTargets(cmd), malformed: false }; // C1: [] is allow
  }
  // Unknown (non-read, non-write, non-bash) tool: gate it if it carries a write surface.
  if (input && typeof input.path === "string" && input.path.length) return { paths: [input.path], malformed: false };
  if (input && typeof input.command === "string" && input.command.length) return { paths: extractBashTargets(input.command), malformed: false };
  return { paths: [], malformed: false }; // no write surface → allow
}

// ---------------------------------------------------------------------------
// resolveRepoRoot — git toplevel of baseCwd (S0: Pi exposes no ctx.projectRoot).
// Returns the realpath'd toplevel, or null if not a git repo (→ State B2 fail-closed).
// ---------------------------------------------------------------------------
function resolveRepoRoot(baseCwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: baseCwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    return fs.realpathSync(out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// handler — the tool_call event handler. Exported for tests.
// ---------------------------------------------------------------------------
export async function handler(event, ctx) {
  try {
    // State B: malformed event / input.
    if (!event || typeof event !== "object") return blockRes("malformed event (State B)");
    const toolName = event.toolName;
    const input = event.input;
    if (input != null && typeof input !== "object") return blockRes("malformed input (State B)");
    const t = (toolName || "").toLowerCase();

    // State A: KNOWN read-only tools → allow (no write surface; ctx.cwd not required).
    if (PI_READ_TOOLS.has(t)) return undefined;

    // Everything else (write/edit/bash or an UNKNOWN tool) may carry a write surface →
    // ctx.cwd must be usable (State B fail-closed).
    const cwd = ctx && ctx.cwd;
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return blockRes("ctx.cwd missing/non-absolute (State B)");
    let baseCwd;
    try { baseCwd = fs.realpathSync(cwd); } catch (e) { return blockRes(`cannot realpath ctx.cwd: ${e.message} (State B)`); }

    const { paths: rawPaths, malformed } = extractTargetPaths(toolName, input);
    if (malformed) return blockRes(`${t}: missing/empty input.path (State C2)`);
    if (rawPaths.length === 0) return undefined; // State C1 (no lexable write target)

    // Resolve target paths against baseCwd (relative → absolute).
    const paths = rawPaths.map((p) => (path.isAbsolute(p) ? p : path.resolve(baseCwd, p)));

    // Resolve repoRoot INDEPENDENTLY (BLOCKER 3; S0: no ctx.projectRoot). If baseCwd is not in
    // a git repo there is no repo to protect: a path OUTSIDE baseCwd is outside-repo → allow
    // (locked R3); a path UNDER baseCwd is fail-closed (State B2 — baseCwd could be a repo whose
    // git query transiently failed). codex r6 MAJOR: do NOT over-block absolute outside writes.
    const repoRoot = resolveRepoRoot(baseCwd);
    if (!repoRoot) {
      const underBase = paths.some((p) => p === baseCwd || p.startsWith(baseCwd + path.sep));
      if (underBase) return blockRes("repoRoot unresolvable and target under cwd (State B2)");
      return undefined; // outside-repo → allow (R3)
    }

    // Dynamic imports INSIDE their own try (State D: a missing/broken waist → fail-closed
    // with a DISTINCT reason, kept separate from the outer State H catch per §12).
    let isRepoSource, gateDisposition, loadEnforceConfig, resolveContractRoot, resolveHarnessCap;
    try {
      ({ isRepoSource } = await import(REPO_SOURCE_MJS));
      ({ gateDisposition, loadEnforceConfig, resolveContractRoot, resolveHarnessCap } = await import(ENFORCE_CONTRACT_MJS));
    } catch (e) {
      return blockRes(`waist import failed: ${(e && e.message) || String(e)} (State D)`);
    }

    const contractRoot = resolveContractRoot();
    let registry = null, enforceConfigSchema = null, eventsJson = null;
    if (contractRoot) {
      try { registry = JSON.parse(fs.readFileSync(path.join(contractRoot, "plugins", "_index.json"), "utf8")); } catch {}
      try { enforceConfigSchema = JSON.parse(fs.readFileSync(path.join(contractRoot, "patterns", "enforce-config.schema.json"), "utf8")); } catch {}
      try { eventsJson = JSON.parse(fs.readFileSync(path.join(contractRoot, "patterns", "events.json"), "utf8")); } catch {}
    }

    const { duplicate } = resolveHarnessCap(registry, "pi-agent", "pre_tool_use");
    const cfg = loadEnforceConfig(repoRoot, enforceConfigSchema);
    const { active } = cfg;
    const configTier =
      cfg.bps["bp-001"] && typeof cfg.bps["bp-001"]["pre_checkpoint"] === "string"
        ? cfg.bps["bp-001"]["pre_checkpoint"]
        : null;

    // Evaluate isRepoSource ONCE per path (find caches the first repo-source hit; avoids the
    // double git check-ignore codex r6 flagged).
    const blockedPath = paths.find((p) => isRepoSource(repoRoot, p).isRepoSource);
    const GATED = blockedPath !== undefined;

    // Runtime disposition uses harnessCap STRONG (manifest declares MEDIUM for honesty; the
    // events.json MEDIUM→warn mapping would otherwise clamp-off every covered write). Mirrors
    // codex-adapter.mjs.
    const disp = gateDisposition({
      duplicate, harnessCap: "STRONG", contractTier: null, active, configTier,
      events: eventsJson, event: "pre_tool_use",
    });

    // State E: repo-source write under enforce/block → block. State F/G → allow.
    if (GATED && (disp.token === "enforce" || disp.token === "block")) {
      return blockRes(`repo-source write gated: ${blockedPath} (tool=${toolName}, tier=${disp.effTier || "STRONG"})`);
    }
    return undefined;
  } catch (e) {
    // State H: any uncaught error → fail-closed.
    return blockRes(`internal error: ${(e && e.message) || String(e)}`);
  }
}

function blockRes(reason) {
  try { process.stderr.write(`pi-enforcement: block — ${reason}\n`); } catch {}
  return { block: true, reason: `episodic-memory enforcement: ${reason}` };
}

// ---------------------------------------------------------------------------
// Extension factory — Pi calls this with the ExtensionAPI.
// ---------------------------------------------------------------------------
export default function (pi) {
  pi.on("tool_call", handler);
}
