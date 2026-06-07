// test-plugin-harness-binding.mjs — RFC-008 R0c P1c C4 (F31/F36/F61).
// Exercises the structured-alert probe's project-root → store-root resolution
// with the pinned output contract, across 4 axes. Each axis spawns the probe as
// a REAL subprocess (cwd:projectRoot + EPISODIC_MEMORY_PROJECT_ROOT, per the P1
// binding contract) and asserts ALL THREE:
//   (1) the exit signal,
//   (2) the alert file EXISTS under the reported `store_root`,
//   (3) the alert is ABSENT under `input_project_root`/caller-cwd whenever
//       convergence targets a different root (worktree) or a stale env was
//       overridden.
// Uses os.tmpdir() + real `git init`/`git worktree add` (cross-platform: no
// GNU-only flags, no shell). Run: node tests/test-plugin-harness-binding.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateInstance } from "../scripts/lib/json-instance-validate.mjs";

const REPO = fs.realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const PROBE = join(REPO, "scripts", "lib", "structured-alert-probe.mjs");
const SCHEMA = JSON.parse(fs.readFileSync(join(REPO, "schemas", "runtime", "structured-alert.schema.json"), "utf8"));
const NOW = "2026-06-07T12:00:00Z"; // injected — deterministic, no Date.now()

let pass = 0, fail = 0;
const failures = [];
const assert = (c, n, d) => (c ? pass++ : (fail++, failures.push(`${n}${d ? " — " + d : ""}`)));

// Deterministic git identity so `git commit` works without touching global config.
const GIT_ENV = {
  GIT_AUTHOR_NAME: "P1c Test",
  GIT_AUTHOR_EMAIL: "juan.delacruz@acme.com",
  GIT_COMMITTER_NAME: "P1c Test",
  GIT_COMMITTER_EMAIL: "juan.delacruz@acme.com",
};

const tmp = (slug) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `p1c-${slug}-`)));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "ignore"] });

function initRepoWithCommit(dir) {
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
}

// Spawn the probe. envRoot===null deletes the inherited var entirely.
function runProbe({ project, envRoot, cwd }) {
  const env = { ...process.env };
  delete env.EPISODIC_MEMORY_PROJECT_ROOT;
  if (envRoot != null) env.EPISODIC_MEMORY_PROJECT_ROOT = envRoot;
  const args = [PROBE];
  if (project != null) args.push("--project", project);
  args.push("--now", NOW);
  let stdout = "", code = 0;
  try {
    stdout = execFileSync("node", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status == null ? 1 : e.status;
    stdout = (e.stdout || "").toString();
  }
  const trimmed = stdout.trim();
  return { code, out: trimmed ? JSON.parse(trimmed) : null };
}

const hasStore = (root) => fs.existsSync(path.join(root, ".episodic-memory"));

// ── Axis 1 — inherited-env override: --project wins over a stale env var ──────
{
  const real = tmp("env-real");
  const stale = tmp("env-stale");
  initRepoWithCommit(real);
  const { code, out } = runProbe({ project: real, envRoot: stale, cwd: real });
  assert(code === 0, "axis1 exit 0", String(code));
  assert(out && out.input_project_root === real, "axis1 input_project_root == --project (wins over env)", out && out.input_project_root);
  assert(out && out.store_root === real, "axis1 store_root == repo root", out && out.store_root);
  assert(out && fs.existsSync(out.episode_file), "axis1 alert EXISTS at reported episode_file");
  assert(out && out.episode_file.startsWith(real + path.sep), "axis1 episode_file under store_root");
  assert(!hasStore(stale), "axis1 alert ABSENT under the stale env root (override honored)");
}

// ── Axis 2 — non-git cwd: discovery fails closed, nothing written ─────────────
{
  const nogit = tmp("nogit");
  const { code, out } = runProbe({ project: null, envRoot: null, cwd: nogit });
  assert(code === 2, "axis2 exit 2 (discovery fail-closed)", String(code));
  assert(out && out.status === "error", "axis2 status error", out && out.status);
  assert(out && /git work tree|discovery/i.test(out.message || ""), "axis2 message names the discovery failure", out && out.message);
  assert(!hasStore(nogit), "axis2 NO alert written under the non-git cwd");
}

// ── Axis 3 — plain git repo: on-disk location == reported store_root ──────────
{
  const repo = tmp("plain");
  initRepoWithCommit(repo);
  const { code, out } = runProbe({ project: repo, envRoot: repo, cwd: repo });
  assert(code === 0, "axis3 exit 0", String(code));
  assert(out && out.input_project_root === repo && out.store_root === repo, "axis3 input_project_root == store_root (no worktree)", out && `${out.input_project_root} / ${out.store_root}`);
  assert(out && fs.existsSync(out.episode_file), "axis3 alert EXISTS under store_root");
  // the written episode re-reads + re-validates against the schema (defensive).
  let valid = false, episode = null;
  try { episode = JSON.parse(fs.readFileSync(out.episode_file, "utf8")); valid = validateInstance(episode, SCHEMA).valid; } catch {}
  assert(valid, "axis3 written episode is schema-valid on re-read");
  assert(episode && episode.project_root === out.input_project_root && episode.store_root === out.store_root, "axis3 episode fields match the stdout contract (never conflated)");
}

// ── Axis 4 — linked worktree: store_root converges to main, input stays /W ────
{
  const main = tmp("wt-main");
  initRepoWithCommit(main);
  const linked = path.join(path.dirname(main), path.basename(main) + "-wt");
  git(main, "worktree", "add", "-q", linked, "HEAD");
  const W = fs.realpathSync(linked);
  const { code, out } = runProbe({ project: W, envRoot: W, cwd: W });
  assert(code === 0, "axis4 exit 0", String(code));
  assert(out && out.input_project_root === W, "axis4 input_project_root == worktree path /W", out && out.input_project_root);
  assert(out && out.store_root === main, "axis4 store_root CONVERGES to main checkout /M (F61)", out && out.store_root);
  assert(out && out.store_root !== out.input_project_root, "axis4 the two fields are distinct (not conflated)");
  assert(out && fs.existsSync(out.episode_file) && out.episode_file.startsWith(main + path.sep), "axis4 alert EXISTS under main /M");
  assert(!hasStore(W), "axis4 alert ABSENT under input_project_root/caller-cwd /W");
}

console.log(`\ntest-plugin-harness-binding: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("✓ F31/F36/F61 project-root→store-root binding contract verified across 4 axes");
