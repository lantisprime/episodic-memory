// path-contain.mjs — caller-injected-path containment under a canonical root
// (RFC-008 P2a, extracted verbatim from validate-plugin-registry.mjs so the
// P2b contract validator imports the SAME predicate instead of hand-rolling a
// second one). Callers own the UsageError -> exit-2 boundary (N-7): these
// helpers throw, they never exit.

import fs from "node:fs";
import path from "node:path";

export class UsageError extends Error {
  constructor(message) { super(message); this.name = "UsageError"; }
}

export function contained(abs, baseReal) {
  return abs === baseReal || abs.startsWith(baseReal + path.sep);
}

/**
 * Resolve an INJECTED file path (e.g. --manifest / --index) and realpath-contain
 * it under the project root (F7/F29). An injected path is caller-controlled, so
 * it must not let the validator read outside the project: lexical escape
 * (../, absolute) OR symlink escape -> UsageError (exit 2 at the caller's
 * boundary). A not-yet-existing path keeps its lexically-contained abs (the
 * reader surfaces ENOENT). `root` MUST already be canonical (realpathSync'd).
 */
export function resolveContained(root, p, label) {
  const absLex = path.resolve(root, p);
  // realpath FIRST for an existing path (canonicalizes e.g. macOS /var ->
  // /private/var so an absolute in-project path is not falsely rejected by a
  // lexical compare against the already-canonical root); lexical fallback only
  // for a not-yet-existing path (the reader then surfaces ENOENT).
  let real;
  try { real = fs.realpathSync(absLex); }
  catch {
    if (!contained(absLex, root)) throw new UsageError(`--${label} ${JSON.stringify(p)} escapes --project authority`);
    return absLex;
  }
  if (!contained(real, root)) throw new UsageError(`--${label} ${JSON.stringify(p)} resolves outside --project authority`);
  return real;
}
