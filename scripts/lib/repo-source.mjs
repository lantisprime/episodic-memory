/**
 * repo-source.mjs — Node mirror of plugins/claude-code/hooks/lib/repo-source.sh.
 * Rule 14 single source: carve-out dirs from patterns/repo-source-carveouts.json,
 * read with the same resolution order as the bash script (NEW-R3-1; RFC-008 P7
 * increment-review BLOCKER 2 — self-relative FIRST so a per-project deployed
 * closure trusts its own co-deployed carveouts over an ambient global file, which
 * a divergent/poison global would otherwise shadow, defeating Principle 12):
 *   1. <this-script>/../../patterns/repo-source-carveouts.json (self-relative deployed / in-repo canonical)
 *   2. $HOME/.episodic-memory/patterns/repo-source-carveouts.json (legacy global fallback)
 *   3. Inline 5-dir fallback literals (deploy-lag safety; never fail-open)
 *
 * Exact-segment matching: <root>/<dir> or <root>/<dir>/* only.
 * NEVER substring — .github/ and .gitignore must NOT be carved.
 *
 * Zero external dependencies. Node.js stdlib only.
 *
 * Exports:
 *   isRepoSource(repoRoot, targetPath) → {isRepoSource:bool, carveout:string|null}
 *   toolTargetsRepoSource(repoRoot, tool, path, label) → "GATED"|"ALLOW"
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Carve-out loader (NEW-R3-1 resolution order)
// ---------------------------------------------------------------------------
const INLINE_CARVEOUT_DIRS = [".episodic-memory", ".checkpoints", ".review-store", ".git", "docs/plans"];

function loadCarveouts() {
  const candidates = [
    path.join(__dirname, "..", "..", "patterns", "repo-source-carveouts.json"),
    path.join(os.homedir(), ".episodic-memory", "patterns", "repo-source-carveouts.json"),
  ];
  for (const jsonPath of candidates) {
    try {
      const raw = fs.readFileSync(jsonPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.exact_segment_dirs) && parsed.exact_segment_dirs.length > 0) {
        return { dirs: parsed.exact_segment_dirs, gitCheckIgnore: !!parsed.git_check_ignore, source: jsonPath };
      }
    } catch {
      // try next
    }
  }
  return { dirs: INLINE_CARVEOUT_DIRS, gitCheckIgnore: true, source: "inline-fallback" };
}

// Lazy-load once per process.
let _carveouts = null;
function getCarveouts() {
  if (!_carveouts) _carveouts = loadCarveouts();
  return _carveouts;
}

// ---------------------------------------------------------------------------
// Canonicalization (mirrors _canonicalize_possibly_nonexistent in bash).
// Uses fs.realpathSync when the path exists; otherwise walks up to the
// nearest existing ancestor, canonicalizes that, and reappends the tail.
// Handles /var → /private/var on macOS.
// ---------------------------------------------------------------------------
function canonicalizePossiblyNonexistent(p) {
  // Make absolute if relative
  if (!path.isAbsolute(p)) p = path.join(process.cwd(), p);
  try {
    return fs.realpathSync(p);
  } catch {
    // Path does not exist: walk up to first existing ancestor
    let cur = p;
    let tail = "";
    while (cur !== path.dirname(cur)) {
      try {
        const realCur = fs.realpathSync(cur);
        return path.join(realCur, tail);
      } catch {
        tail = path.basename(cur) + (tail ? path.sep + tail : "");
        cur = path.dirname(cur);
      }
    }
    // Reached filesystem root without resolving; return as-is
    return p;
  }
}

// ---------------------------------------------------------------------------
// isRepoSource — mirrors _path_is_repo_source (bash §12.1 contract)
// Returns {isRepoSource:bool, carveout:string|null}
// Fail-closed: empty/whitespace path → {isRepoSource:true, carveout:null}
// ---------------------------------------------------------------------------
export function isRepoSource(repoRoot, targetPath) {
  // Empty/whitespace → fail-closed (gated), mirrors bash `[ -n "$file_path" ] || return 0`
  if (!targetPath || !targetPath.trim()) {
    return { isRepoSource: true, carveout: null };
  }

  const repoCanon = canonicalizePossiblyNonexistent(repoRoot);
  const fpCanon = canonicalizePossiblyNonexistent(targetPath);

  // Check if under repo root (raw-prefix or canonical)
  let inRepo = false;
  // Raw check (catches symlink-OUT author intent), BUT skip for .. traversals
  if (!/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(targetPath)) {
    if (targetPath === repoRoot || targetPath.startsWith(repoRoot + "/") || targetPath.startsWith(repoRoot + path.sep)) {
      inRepo = true;
    }
  }
  // Canonical check
  if (!inRepo) {
    if (fpCanon === repoCanon || fpCanon.startsWith(repoCanon + "/") || fpCanon.startsWith(repoCanon + path.sep)) {
      inRepo = true;
    }
  }

  if (!inRepo) {
    return { isRepoSource: false, carveout: "outside-repo" };
  }

  // Carve-out check — exact-segment matching
  const carveouts = getCarveouts();
  for (const dir of carveouts.dirs) {
    const dirPath = repoCanon + "/" + dir;
    if (fpCanon === dirPath || fpCanon.startsWith(dirPath + "/")) {
      return { isRepoSource: false, carveout: dir };
    }
  }

  // git check-ignore
  if (carveouts.gitCheckIgnore) {
    try {
      execFileSync("git", ["-C", repoCanon, "check-ignore", "-q", "--", fpCanon], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      // exit 0 means ignored
      return { isRepoSource: false, carveout: "gitignore" };
    } catch {
      // exit 1 = not ignored; other errors = treat as not ignored
    }
  }

  return { isRepoSource: true, carveout: null };
}

// ---------------------------------------------------------------------------
// toolTargetsRepoSource — mirrors _tool_targets_repo_source_shared (bash §12.2)
// Returns "GATED" | "ALLOW"
// ---------------------------------------------------------------------------
export function toolTargetsRepoSource(repoRoot, tool, targetPath, label) {
  if (tool === "Bash" || tool === "bash") {
    switch (label) {
      case "read_only":
      case "nonsrc_write":
        return "ALLOW";
      case "shared_write":
      case "unsafe_complex":
      case "push_or_pr_create":
        if (targetPath) {
          return isRepoSource(repoRoot, targetPath).isRepoSource ? "GATED" : "ALLOW";
        }
        return "GATED";
      default:
        return "GATED";
    }
  }
  // Non-bash tools (write/edit): always check path
  return isRepoSource(repoRoot, targetPath).isRepoSource ? "GATED" : "ALLOW";
}
