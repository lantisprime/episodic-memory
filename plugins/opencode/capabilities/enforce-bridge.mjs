#!/usr/bin/env node
/**
 * enforce-bridge.mjs — OpenCode enforcement bridge (RFC-008 P5 S5, REQ-8/9/10/13/14).
 *
 * Zero external dependencies. Node.js stdlib + repo scripts only.
 *
 * Protocol:
 *   stdin  — JSON: {harness:"opencode", event:"pre_tool_use"|..., normalized:{...}}
 *   stdout — JSON: {action:"block"|"allow", effective_tier, reason, label}
 *   exit 0 — ok
 *   exit 2 — invalid input (schema / parse error)
 *   exit 3 — engine error (threw during decision)
 *
 * The decision is the §12 two-layer AND (B-NEW-2):
 *   L1: toolTargetsRepoSource(repoRoot, tool, target, label) → GATED|ALLOW
 *   L2: gateDisposition({...}) → token ∈ {enforce, block, allow, silence, clamp-off}
 * block only when BOTH L1=GATED AND L2.token ∈ {enforce, block}.
 *
 * Repo root = realpath(payload.cwd) ONLY. Never process.cwd().
 * Non-pre_tool_use events → {action:"allow"} immediately (MEDIUM observe).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(__dirname, "..", "..", ".."); // repo root relative to plugin dir

// ---------------------------------------------------------------------------
// Resolve script paths — bridge is installed alongside the repo scripts.
// Priority: co-located (deployed) → in-repo dev path.
// ---------------------------------------------------------------------------
function resolveScriptPath(relativeToBridge, relativeToRepo) {
  const deployed = path.resolve(__dirname, relativeToBridge);
  if (fs.existsSync(deployed)) return deployed;
  return path.resolve(BRIDGE_ROOT, relativeToRepo);
}

const REPO_SOURCE_MJS = resolveScriptPath(
  "../../scripts/lib/repo-source.mjs",
  "scripts/lib/repo-source.mjs"
);
const ENFORCE_CONTRACT_MJS = resolveScriptPath(
  "../../scripts/enforce-contract.mjs",
  "scripts/enforce-contract.mjs"
);

// ---------------------------------------------------------------------------
// classifyLabel — node port of command-classifier.sh tool→label mapping (§A.0 #3).
// Minimal subset: covers the OpenCode tool names (write/edit/bash/read) + bash
// command heuristic (read-only bash vs shared_write). Maps to
// _tool_targets_repo_source_shared's label-based branch for bash.
// ---------------------------------------------------------------------------
const READ_ONLY_BASH_RE = /^\s*(cat|head|tail|grep|find|ls|echo|printf|wc|du|df|pwd|which|type|file|stat|diff|sort|uniq|tr|cut|awk|sed|jq|git\s+(status|log|diff|show|branch|tag|remote|describe|rev-parse|ls-files|ls-tree|cat-file|shortlog|stash list|blame)|curl\s+(-[^>]*\s)?(--head|-I)\b|wget\s+(-[^>]*)?(--spider|-q)\b|node\s+--version|npm\s+(ls|list|outdated|audit)\b|which\s|test\s|true|false)\b/;

function classifyLabel(tool, args) {
  const t = (tool || "").toLowerCase();
  if (t === "read") return "read_only";
  if (t === "write" || t === "edit" || t === "multiedit") return "shared_write";
  if (t === "bash") {
    const cmd = (args && (args.command || args.cmd)) || "";
    if (READ_ONLY_BASH_RE.test(cmd)) return "read_only";
    // git push / gh pr → push_or_pr_create
    if (/\bgit\s+push\b|\bgh\s+(pr|release)\s+(create|push)\b/.test(cmd)) return "push_or_pr_create";
    return "shared_write";
  }
  // Unknown tool: fail-closed
  return "shared_write";
}

// ---------------------------------------------------------------------------
// Decision entry point.
// ---------------------------------------------------------------------------
async function decide(envelope) {
  const { toolTargetsRepoSource } = await import(REPO_SOURCE_MJS);
  const {
    gateDisposition,
    loadEnforceConfig,
    resolveContractRoot,
    resolveHarnessCap,
  } = await import(ENFORCE_CONTRACT_MJS);

  const { event, normalized } = envelope;
  const payload = normalized || {};

  // Non-pre_tool_use events are MEDIUM observe — always allow.
  if (event !== "pre_tool_use") {
    return { action: "allow", effective_tier: "MEDIUM", reason: "observe: non-blocking event", label: null };
  }

  // Resolve repo root from payload.cwd (ONLY source — never process.cwd()).
  const cwdRaw = payload.cwd;
  if (!cwdRaw || typeof cwdRaw !== "string") {
    throw new Error("enforce-bridge: payload.cwd is required and must be a string");
  }
  let repoRoot;
  try {
    repoRoot = fs.realpathSync(cwdRaw);
  } catch (e) {
    throw new Error(`enforce-bridge: cannot realpath payload.cwd ${JSON.stringify(cwdRaw)}: ${e.message}`);
  }

  const tool = payload.tool || "";
  const args = payload.tool_args || {};
  // Target path: for write/edit it's args.filePath; for bash it's empty (command text).
  const targetPath = args.filePath || args.file_path || "";
  const label = classifyLabel(tool, args);

  // Short-circuit: read_only / nonsrc_write labels never gate (regardless of path).
  // This extends the bash _tool_targets_repo_source_shared bash-branch logic to all
  // tools: a `read` tool with a repo-source path is not a write and must be allowed.
  if (label === "read_only" || label === "nonsrc_write") {
    return { action: "allow", effective_tier: null, reason: `allow: label=${label} (non-write)`, label };
  }

  // L1: repo-source check.
  const gatedWrite = toolTargetsRepoSource(repoRoot, tool, targetPath, label);

  // L2: gate disposition (reuse enforce-contract loaders; no logic re-impl).
  const contractRoot = resolveContractRoot();
  let registry = null, enforceConfigSchema = null, eventsJson = null;
  if (contractRoot) {
    try {
      const regPath = path.join(contractRoot, "plugins", "_index.json");
      registry = JSON.parse(fs.readFileSync(regPath, "utf8"));
    } catch { /* null → fail-closed */ }
    try {
      const schemaPath = path.join(contractRoot, "patterns", "enforce-config.schema.json");
      enforceConfigSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    } catch { /* null → identity config */ }
    try {
      const evPath = path.join(contractRoot, "patterns", "events.json");
      eventsJson = JSON.parse(fs.readFileSync(evPath, "utf8"));
    } catch { /* null → fail-closed */ }
  }

  const { tier: harnessCap, duplicate } = resolveHarnessCap(registry, "opencode", "pre_tool_use");
  const enforceConfig = loadEnforceConfig(repoRoot, enforceConfigSchema);
  const { active } = enforceConfig;

  // contractTier: bp-001 opencode gates not wired in P5 (OD-4) — null (no clamp).
  const contractTier = null;
  // configTier: operator per-gate clamp from enforce-config.json bp-001 — opencode
  // doesn't share the bp-001 lifecycle in P5, so no gate-specific clamp.
  const configTier = null;

  const disp = gateDisposition({
    duplicate,
    harnessCap,
    contractTier,
    active,
    configTier,
    events: eventsJson,
    event: "pre_tool_use",
  });

  const block = gatedWrite === "GATED" && (disp.token === "enforce" || disp.token === "block");
  const action = block ? "block" : "allow";
  const reason = block
    ? `repo-source write gated: ${targetPath || tool} (label:${label}, tier:${disp.effTier})`
    : `allow: gatedWrite=${gatedWrite}, disp.token=${disp.token}`;

  return { action, effective_tier: disp.effTier, reason, label };
}

// ---------------------------------------------------------------------------
// Validate the incoming envelope against a minimal schema.
// ---------------------------------------------------------------------------
function validateEnvelope(envelope) {
  if (typeof envelope !== "object" || envelope === null) throw new Error("envelope must be a JSON object");
  if (envelope.harness !== "opencode") throw new Error(`harness must be "opencode", got ${JSON.stringify(envelope.harness)}`);
  const validEvents = ["pre_tool_use", "tool_result", "session_start", "stop"];
  if (!validEvents.includes(envelope.event)) throw new Error(`event must be one of ${validEvents.join("|")}, got ${JSON.stringify(envelope.event)}`);
  if (typeof envelope.normalized !== "object" || envelope.normalized === null) throw new Error("normalized must be a JSON object");
}

// ---------------------------------------------------------------------------
// Main — read stdin, decide, emit stdout.
// ---------------------------------------------------------------------------
async function main() {
  let raw = "";
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
  } catch (e) {
    process.stderr.write(`enforce-bridge: stdin read error: ${e.message}\n`);
    process.exit(3);
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`enforce-bridge: JSON parse error: ${e.message}\n`);
    process.exit(2);
  }

  try {
    validateEnvelope(envelope);
  } catch (e) {
    process.stderr.write(`enforce-bridge: validation error: ${e.message}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = await decide(envelope);
  } catch (e) {
    process.stderr.write(`enforce-bridge: engine error: ${e.message}\n`);
    process.exit(3);
  }

  try {
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (e) {
    process.stderr.write(`enforce-bridge: stdout write error: ${e.message}\n`);
    process.exit(3);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`enforce-bridge: unhandled error: ${e.message}\n`);
  process.exit(3);
});
