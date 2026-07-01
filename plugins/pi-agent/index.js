/**
 * index.js — Pi extension entry point (RFC-008 P7).
 *
 * Pi auto-discovers `.pi/extensions/<name>/index.js`. In the DEPLOYED tree
 * (install.mjs S5) the full adapter is copied to `<pluginDir>/index.js`; in the
 * REPO the adapter lives at `capabilities/enforcement.js` (the manifest
 * `classifier.override_path` + the unit tests reference that path), so this file
 * re-exports it as the canonical `index.js` entry. Both expose the same
 * `default` factory + `handler`; the conformance gauntlet
 * (`scripts/test-plugin.mjs`, in-process-decision dispatch) loads this entry.
 */
export { default, handler, extractBashTargets } from "./capabilities/enforcement.js";
