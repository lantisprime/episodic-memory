// structured-alert.mjs — the REAL parameterized F3 structured-alert writer
// (RFC-008 P3b-2, CLASS-C(b); maps to F3/F24/F62/F61/F4). Promoted out of the
// P1c probe (structured-alert-probe.mjs): that probe HARDCODED its payload
// (alert_type/emitted_label/plugin_id) to prove the project-root→store-root path
// math end-to-end before the real writer existed. This module REUSES that path
// math but PARAMETERIZES the alert fields (M1 — a blind rename+re-export of the
// probe would make every live alert say "probe_out_of_vocabulary" regardless of
// the real offending label: a useless alert + a silent F62 vocab lie).
//
// SHIPPED LIBRARY-ONLY this slice (B2): under P3b-2's stop-only wiring the stop
// gate is label-INDEPENDENT (RFC-008:464), so NO live site feeds an out-of-vocab
// label into this writer yet — out-of-vocab labels originate at the bash
// classifier → pre_tool_use gates, which P3b-2 DEFERS. So the writer + its unit
// tests ship now; the e2e hard-reject consumer lands when the pre_tool_use label
// gate is wired (later slice). emitProbeAlert (the P1c fixture) is kept as a thin
// wrapper so tests/test-plugin-harness-binding.mjs stays green.
//
// Pinned contract (F4 — two distinct fields, NEVER conflated):
//   project_root  the `--project`/env/discovered input (a linked worktree
//                 reports its OWN path here).
//   store_root    resolveRepoRoot(project_root) — where the alert actually lands;
//                 for a linked worktree this CONVERGES to the main checkout (F61).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveRepoRoot } from "./local-dir.mjs";
import { validateInstance } from "./json-instance-validate.mjs";

const SCHEMA = JSON.parse(
  fs.readFileSync(new URL("../../schemas/runtime/structured-alert.schema.json", import.meta.url), "utf8"),
);

export class AlertError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlertError";
  }
}

// Canonicalize so project_root and store_root are directly comparable (macOS
// /var → /private/var: git emits the realpath, so the input must too, else a
// non-worktree repo would spuriously report project_root != store_root).
export function canonical(p) {
  return fs.realpathSync(path.resolve(p));
}

/**
 * Resolve the input project root (F36 precedence: --project > env > git
 * discovery). Throws AlertError if nothing resolves to a git work tree (never
 * silently writes to a guessed root).
 * @param {{project?: string, env?: string, cwd?: string}} src
 * @returns {string} canonical input project root
 */
export function resolveInput({ project, env, cwd = process.cwd() } = {}) {
  if (project) return canonical(project);
  if (env) return canonical(env);
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (top) return canonical(top);
  } catch {
    // not a git work tree
  }
  throw new AlertError(
    "no --project and no $EPISODIC_MEMORY_PROJECT_ROOT, and cwd is not a git work tree — " +
    "structured-alert discovery failed closed (it will not guess a store root)",
  );
}

// Filesystem-safe episode filename from an injected ISO-8601 stamp (no colons).
export function stampSlug(now) {
  return now.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build, schema-validate, and write a structured-alert episode under
 * resolveRepoRoot(input)/.episodic-memory/alerts/. Returns the pinned contract.
 *
 * The caller supplies the alert vocabulary fields — the F62 conditional in the
 * schema enforces the exactly-one label-vs-event relation, so a malformed combo
 * throws here (never writes a half-valid alert). `now` is injected (NEVER
 * Date.now() in the lib — F4 + deterministic tests). `store_root`, when passed,
 * is the caller's ALREADY-RESOLVED store root (M5 resolve-once / B4): we assert
 * it equals resolveRepoRoot(input) so a stale param can never redirect the write.
 *
 * @param {{input:string, now:string, alert_type:string, plugin_id?:string,
 *          harness?:string, emitted_label?:string|null, emitted_event_id?:string|null,
 *          events_version?:string|null, command?:string, scope?:string,
 *          store_root?:string|null}} opts
 * @returns {{status, project_root, store_root, episode_file, alert_valid}}
 */
export function emitStructuredAlert({
  input,
  now,
  alert_type,
  plugin_id = "claude-code",
  harness = "claude-code",
  emitted_label = null,
  emitted_event_id = null,
  events_version = null,
  command = "",
  scope = "local",
  store_root = null,
} = {}) {
  if (typeof input !== "string" || input.length === 0) {
    throw new AlertError("emitStructuredAlert: { input } (resolved project root) is required");
  }
  if (typeof now !== "string" || now.length === 0) {
    throw new AlertError("emitStructuredAlert: { now } (ISO-8601 string) must be injected — never Date.now() here");
  }
  if (typeof alert_type !== "string" || alert_type.length === 0) {
    throw new AlertError("emitStructuredAlert: { alert_type } is required");
  }
  const projectRoot = canonical(input);
  // resolveRepoRoot returns git's path as-is, which can be non-canonical for a
  // worktree; realpath it so project_root (canonical) and store_root compare
  // cleanly. storeRoot always exists → realpath is safe.
  const derivedStore = fs.realpathSync(resolveRepoRoot(projectRoot));
  let storeRoot = derivedStore;
  if (store_root != null) {
    const canonStore = fs.realpathSync(path.resolve(store_root));
    if (canonStore !== derivedStore) {
      throw new AlertError(
        `emitStructuredAlert: store_root param ${canonStore} != resolveRepoRoot(input) ${derivedStore} ` +
        "(resolve-once invariant — a stale store_root must not redirect the write)",
      );
    }
    storeRoot = canonStore;
  }
  const alertsDir = path.join(storeRoot, ".episodic-memory", "alerts");
  const episodeFile = path.join(alertsDir, `structured-alert-${stampSlug(now)}.json`);

  const alert = {
    alert_type,
    plugin_id,
    harness,
    emitted_label,
    emitted_event_id,
    events_version,
    command,
    timestamp_iso8601: now,
    project_root: projectRoot,
    store_root: storeRoot,
    store_scope: scope,
    episode_file: episodeFile,
  };

  const { valid, errors } = validateInstance(alert, SCHEMA);
  if (!valid) {
    throw new AlertError(`structured-alert is schema-invalid: ${JSON.stringify(errors)}`);
  }

  fs.mkdirSync(alertsDir, { recursive: true });
  fs.writeFileSync(episodeFile, JSON.stringify(alert, null, 2) + "\n");

  return {
    status: "ok",
    project_root: projectRoot, // F4: === episode.project_root
    store_root: storeRoot, //       F4: === episode.store_root (worktree → main)
    episode_file: episodeFile,
    alert_valid: true,
  };
}
