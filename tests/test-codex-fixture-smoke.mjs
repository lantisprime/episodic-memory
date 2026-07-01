/**
 * test-codex-fixture-smoke.mjs — CI-guardable smoke (RFC-008 P6 S5, REQ-17): no
 * codex binary required. Validates the recorded fixture shape + the runbook §9
 * agent-invocation manifest (codex-native shape, node command_shapes, return_codes).
 * Run: node tests/test-codex-fixture-smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = fs.realpathSync(path.join(__dirname, ".."));
let pass = 0, fail = 0; const failures = [];
function assert(c, n, d = "") { if (c) pass++; else { fail++; failures.push(`${n}${d ? " — " + d : ""}`); } }

// (a) fixture: parses, integer turn_index, apply_patch present.
const fxPath = path.join(REPO, "tests", "fixtures", "harness-events", "codex", "pre-tool-use.json");
let fx = null;
try { fx = JSON.parse(fs.readFileSync(fxPath, "utf8")); } catch (e) { fail++; failures.push(`fixture parse: ${e.message}`); }
assert(fx && Number.isInteger(fx.turn_index), "fixture: turn_index is an integer", fx ? String(fx.turn_index) : "no fixture");
// Strong, non-self-satisfying assertions (review F5): a bare /apply_patch/ substring
// match is met by the fixture's own _note text, so it survives a tool_name regression.
// Assert the structural fields + both Add File directives in the patch body instead.
assert(fx && fx.hook_event_name === "PreToolUse", "fixture: hook_event_name === PreToolUse", fx ? String(fx.hook_event_name) : "no fixture");
assert(fx && fx.tool_name === "apply_patch", "fixture: tool_name === apply_patch (exact, not substring)", fx ? String(fx.tool_name) : "no fixture");
assert(fx && fx.tool_input && typeof fx.tool_input.command === "string"
  && /^\*\*\* Add File: src\/probe\.mjs$/m.test(fx.tool_input.command)
  && /^\*\*\* Add File: docs\/plans\/note\.md$/m.test(fx.tool_input.command),
  "fixture: apply_patch command carries BOTH Add File directives",
  fx && fx.tool_input ? String(fx.tool_input.command).slice(0, 200) : "no tool_input");

// (b) runbook §9 agent-invocation manifest block (SMOKE_RUNBOOK override = §A.9 red-then-green break).
const rbPath = process.env.SMOKE_RUNBOOK || path.join(REPO, "plugins", "codex", "runbooks", "enforcement.md");
const rb = fs.readFileSync(rbPath, "utf8");
const m = rb.match(/##\s*🤖 Agent invocation manifest\s*\n+```json\n([\s\S]*?)\n```/);
assert(!!m, "runbook: sentinel-anchored agent-manifest json block present");
let am = null;
if (m) { try { am = JSON.parse(m[1]); } catch (e) { fail++; failures.push(`runbook §9 parse: ${e.message}`); } }
assert(am && am.expected_outputs && am.expected_outputs.shape === "codex-native",
  "runbook: expected_outputs.shape === codex-native", am ? JSON.stringify(am.expected_outputs) : "no block");
assert(am && Array.isArray(am.command_shapes) && am.command_shapes.length >= 1
  && Array.isArray(am.command_shapes[0]) && am.command_shapes[0][0] === "node",
  "runbook: command_shapes[0] is a node argv", am ? JSON.stringify(am.command_shapes) : "no block");
assert(am && am.return_codes && Object.prototype.hasOwnProperty.call(am.return_codes, "2"),
  "runbook: return_codes closed map includes \"2\"", am ? JSON.stringify(am.return_codes) : "no block");

console.log(`\ntest-codex-fixture-smoke: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.error("\nFAILURES:"); for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
console.log("✓ codex fixture + runbook §9 smoke passed");
