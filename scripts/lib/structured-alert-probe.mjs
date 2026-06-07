// structured-alert-probe.mjs — RFC-008 R0c P1c C4. A MINIMAL, P1-local probe
// that exercises the project-root → store-root resolution path with a PINNED
// output contract (F31/F36/F61, F4). It is NOT the real F3 hard-reject writer —
// that decision engine lands in P3 (gauntlet step 6 stays deferred-P3). This
// probe exists only so the harness-binding tests can assert the resolution
// contract end-to-end before the real writer exists.
//
// Pinned contract (F4 — two distinct fields, NEVER conflated):
//   input_project_root  the `--project`/env/discovered input (a linked worktree
//                       reports its OWN path here).
//   store_root          resolveRepoRoot(input_project_root) — where the alert
//                       actually lands; for a linked worktree this CONVERGES to
//                       the main checkout (F61).
// The written episode carries the same split: episode.project_root === input,
// episode.store_root === store_root, episode.episode_file === the written path.
//
// Resolution precedence (F36): --project  >  $EPISODIC_MEMORY_PROJECT_ROOT  >
// git discovery from cwd. With none of the three resolvable to a git work tree,
// discovery FAILS CLOSED (exit 2) — it never silently writes to a guessed root.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveRepoRoot } from "./local-dir.mjs";
import { validateInstance } from "./json-instance-validate.mjs";

const SCHEMA = JSON.parse(
  fs.readFileSync(new URL("../../schemas/runtime/structured-alert.schema.json", import.meta.url), "utf8"),
);

export class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeError";
  }
}

// Canonicalize so input_project_root and store_root are directly comparable
// (macOS /var → /private/var: git emits the realpath, so the input must too,
// else a non-worktree repo would spuriously report input != store).
function canonical(p) {
  return fs.realpathSync(path.resolve(p));
}

/**
 * Resolve the input project root (F36 precedence). Throws ProbeError if nothing
 * resolves to a git work tree.
 * @param {{project?: string, env?: string, cwd?: string}} src
 * @returns {string} canonical input project root
 */
export function resolveInput({ project, env, cwd = process.cwd() } = {}) {
  if (project) return canonical(project);
  if (env) return canonical(env);
  // discovery — must be a real git work tree, else fail closed.
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (top) return canonical(top);
  } catch {
    // not a git work tree
  }
  throw new ProbeError(
    "no --project and no $EPISODIC_MEMORY_PROJECT_ROOT, and cwd is not a git work tree — " +
    "structured-alert discovery failed closed (it will not guess a store root)",
  );
}

// Filesystem-safe episode filename from an injected ISO-8601 stamp (no colons).
function stampSlug(now) {
  return now.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build, schema-validate, and write a structured-alert episode under
 * resolveRepoRoot(input)/.episodic-memory/alerts/. Returns the pinned contract.
 * @param {{input: string, now: string, command?: string, scope?: string}} opts
 * @returns {{status, input_project_root, store_root, episode_file, alert_valid}}
 */
export function emitProbeAlert({ input, now, command = "", scope = "local" } = {}) {
  if (typeof input !== "string" || input.length === 0) {
    throw new ProbeError("emitProbeAlert: { input } (resolved project root) is required");
  }
  if (typeof now !== "string" || now.length === 0) {
    throw new ProbeError("emitProbeAlert: { now } (ISO-8601 string) must be injected — never Date.now() here");
  }
  const projectRoot = canonical(input);
  // realpath the resolved store root too (claude-subagent N-a): `input` is
  // canonicalized, but resolveRepoRoot returns git's path as-is, which on some
  // hosts is non-canonical for a worktree. Without this, project_root could be
  // canonical while store_root is not, spuriously breaking the F4 "input==store
  // for a non-worktree" invariant. storeRoot always exists, so realpath is safe.
  const storeRoot = fs.realpathSync(resolveRepoRoot(projectRoot));
  const alertsDir = path.join(storeRoot, ".episodic-memory", "alerts");
  const episodeFile = path.join(alertsDir, `structured-alert-${stampSlug(now)}.json`);

  // A `classifier_out_of_vocabulary` alert (the F62 conditional branch with a
  // non-null emitted_label and null event fields). The probe never emits a real
  // out-of-vocab label into the live vocabulary — it only proves the path math.
  const alert = {
    alert_type: "classifier_out_of_vocabulary",
    plugin_id: "claude-code",
    harness: "claude-code",
    emitted_label: "probe_out_of_vocabulary",
    emitted_event_id: null,
    events_version: null,
    command,
    timestamp_iso8601: now,
    project_root: projectRoot,
    store_root: storeRoot,
    store_scope: scope,
    episode_file: episodeFile,
  };

  const { valid, errors } = validateInstance(alert, SCHEMA);
  if (!valid) {
    throw new ProbeError(`probe built a schema-invalid structured-alert: ${JSON.stringify(errors)}`);
  }

  fs.mkdirSync(alertsDir, { recursive: true });
  fs.writeFileSync(episodeFile, JSON.stringify(alert, null, 2) + "\n");

  return {
    status: "ok",
    input_project_root: projectRoot, // F4: === episode.project_root
    store_root: storeRoot, //             F4: === episode.store_root (worktree → main)
    episode_file: episodeFile,
    alert_valid: true,
  };
}

// ---------------------------------------------------------------------------
// CLI — used by tests/test-plugin-harness-binding.mjs (spawned with cwd:project
// + EPISODIC_MEMORY_PROJECT_ROOT). Prints the pinned contract as one JSON line.
// ---------------------------------------------------------------------------
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  try {
    const input = resolveInput({
      project: flag("--project"),
      env: process.env.EPISODIC_MEMORY_PROJECT_ROOT,
      cwd: process.cwd(),
    });
    const now = flag("--now") || new Date().toISOString();
    const out = emitProbeAlert({ input, now, command: flag("--command") || "" });
    console.log(JSON.stringify(out));
  } catch (e) {
    console.log(JSON.stringify({ status: "error", message: e.message }));
    process.exit(2);
  }
}
