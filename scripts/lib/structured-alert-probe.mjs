// structured-alert-probe.mjs — RFC-008 R0c P1c C4. The MINIMAL P1-local probe
// that exercised the project-root → store-root resolution path with a PINNED
// output contract (F31/F36/F61, F4) BEFORE the real F3 writer existed.
//
// P3b-2 landed the real writer at scripts/lib/structured-alert.mjs (parameterized
// payload — CLASS-C(b), M1). This probe is now a THIN FIXTURE WRAPPER over it:
// emitProbeAlert hardcodes the P1c probe payload (a `classifier_out_of_vocabulary`
// alert with the literal `probe_out_of_vocabulary` label) so the harness-binding
// tests (tests/test-plugin-harness-binding.mjs, which SPAWN this CLI) keep their
// pinned `input_project_root`/`store_root`/`episode_file` stdout contract. The
// path math (canonical / resolveInput / store_root split / schema validation)
// lives ONCE in structured-alert.mjs; this file no longer duplicates it.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AlertError,
  resolveInput,
  emitStructuredAlert,
} from "./structured-alert.mjs";

// Back-compat alias — the P1c probe exported ProbeError; keep the name exported
// (now an alias of AlertError) for any external importer.
export { AlertError as ProbeError, resolveInput };

/**
 * Write the P1c PROBE alert (fixed `classifier_out_of_vocabulary` /
 * `probe_out_of_vocabulary` payload) via the real writer, then remap the result
 * to the probe's pinned stdout field names (`input_project_root`). The probe
 * never emits a REAL out-of-vocab label — it only proves the path math.
 * @param {{input:string, now:string, command?:string, scope?:string}} opts
 */
export function emitProbeAlert({ input, now, command = "", scope = "local" } = {}) {
  const r = emitStructuredAlert({
    input,
    now,
    command,
    scope,
    alert_type: "classifier_out_of_vocabulary",
    plugin_id: "claude-code",
    harness: "claude-code",
    emitted_label: "probe_out_of_vocabulary",
    emitted_event_id: null,
    events_version: null,
  });
  return {
    status: r.status,
    input_project_root: r.project_root, // F4: === episode.project_root
    store_root: r.store_root, //            F4: === episode.store_root (worktree → main)
    episode_file: r.episode_file,
    alert_valid: r.alert_valid,
  };
}

// ---------------------------------------------------------------------------
// CLI — used by tests/test-plugin-harness-binding.mjs (spawned with cwd:project
// + EPISODIC_MEMORY_PROJECT_ROOT). Prints the pinned contract as one JSON line.
// ---------------------------------------------------------------------------
// N2 (closes FU #390): realpath-both main-module detection. A plain
// `import.meta.url === pathToFileURL(argv[1])` compare FAILS when the path has a
// symlink component (macOS /var→/private/var, a symlinked $HOME) — import.meta.url
// is canonical while pathToFileURL(argv[1]) is not — so the CLI would silently
// no-op (fail-OPEN). The realpath-both idiom (same as enforce-contract.mjs:134-141)
// resolves both sides so a symlinked invocation path still runs as main.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
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
