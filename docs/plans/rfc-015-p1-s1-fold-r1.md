# RFC-015-P1-S1 — review round 1 fold contract (GLM-5.2 HOLD-8 at frozen 627bcc6)

Orchestrator dispositions: F1-F5 ACCEPT, F6 ACCEPT-WITH-MOD, F7-F8 ACCEPT. Every fix is a
bounded repo-src edit inside the frozen spec's §20 writable set; B-1 untouched (no gates,
warn-only audit, refusals stay input-validation on explicit write commands).

## F1 (P1) em-doctor --all-projects TDZ crash

`collectDeclarationTerminalSet` (em-doctor.mjs:646) references module-level
`const registeredStores` (:797) before its evaluation when called from the per-store scan
(:791-792). FIX: make the registered-stores resolution available BEFORE the per-store scan —
hoist `const registeredStores = allProjects ? resolveRegisteredStores() : []` (and its
`registeredByDir` map if needed) above the scan block, keeping the existing post-scan
consumers working unchanged. ADD test leg to t7: run em-doctor with `--all-projects` on the
fixture; assert exit is not a crash (valid JSON on stdout, no ReferenceError on stderr) and
the four playbook check ids still behave (both polarities not required for this leg; crash
absence + valid JSON is the assertion).

## F2 (P1) doctor false-positive on global-marker-declared-locally; parity with build

`collectDeclarationTerminalSet(dataDir)` reads the SCANNED store's playbooks.json and the
health check resolves declared ids against the scanned store's index only. FIX per R5
(RFC:99-100): (a) declaration set under default scope = the CWD-LOCAL project's
playbooks.json (LOCAL_DIR), never the scanned store's; under --all-projects = union across
registered projects; (b) resolve declared ids and marker terminals against the UNION of
local + global index rows (matching buildPlaybookSection's cross-store resolution), so a
global episode declared locally is neither "unregistered" nor "unresolvable";
(c) playbook-global-file check unchanged. Keep messages accurate about the declaration-set
limitation. ADD t7 leg: fixture with a GLOBAL-store marker episode declared in the local
playbooks.json → all four checks silent (this is the v15 canonical layout); and the
inverse (global marker NOT declared) → playbook-unregistered fires once.

## F3 (P2) empty-trigger write-time advisory missing (REQ-12); t16 weakened

No trigger info reaches the registration/advisory path. FIX: thread the episode's effective
trigger set (the just-written index row's triggers field, already in hand in both CLIs) into
registerPlaybook/buildPlaybookAdvisory params; when mode==='on_demand' and the effective
trigger set is empty, append to the advisory note: ' (build will exclude this entry as
empty_triggers: the episode has no effective triggers)' and set `empty_triggers: true` on
the advisory object. STRENGTHEN t16: assert the advisory note contains 'empty_triggers'
AND the advisory carries empty_triggers:true, in addition to the existing build-half assert.

## F4 (P2) em-revise scope refusal fires POST-write + F7 stored_id asymmetry

em-revise.mjs:618 checks dataDir === GLOBAL_DIR inside the write try-block, after the
revision landed. FIX: hoist the scope determination pre-write — the effective target store
is known before the write (scope flag + original's store dir for inherit); refuse with the
same `playbooks-scope` error BEFORE acquiring/writing, exit 1, no revision written. Where a
post-store refusal branch legitimately remains (registerPlaybook failure), keep stored_id;
the pre-write scope refusal has no stored_id by definition (nothing stored) — that resolves
F7's asymmetry in the correct direction. ADD test leg: em-revise --register-playbook on a
global original (default inherit) → exit 1, code playbooks-scope, AND the global store
episode count is unchanged (no revision landed).

## F5 (P2) advisory cannot resolve GLOBAL-store marker episodes

buildPlaybookAdvisory always reads the LOCAL index; global episodes resolve to "deferred".
FIX: pass the episode's OWN store dir (the dataDir it was just written to) as the index
source for terminal resolution, while keeping project_store + the declaration source pinned
to the CWD-LOCAL playbooks.json (B-3, t9(b) unchanged). A global marker declared in the
local playbooks.json then reports registered:true. ADD test leg (extend t9): global-store
marker whose chain is declared locally → advisory registered:true, project_store still the
local store path.

## F6 (NIT, WITH-MOD) t2 golden

Replace the key-set assert with a full-stdout golden: capture the flagless run's stdout,
assert it deep-equals JSON with EXACTLY the four keys and the observed values (id/file are
run-generated — assert by reconstructing the expected object from the parsed values and
comparing the re-serialized string to the raw captured line; that pins key ORDER and absence
of extra keys, the EC5 intent) .

## F8 (NIT) cosmetics

Add trailing newline to scripts/lib/playbook-registration.mjs; fix the mis-indented closing
brace at em-revise.mjs:660.

## Verify (all must be green before reporting)

1. node tests/test-rfc-015-registration.mjs → all legs (now 15 + the new/extended ones)
2. node tests/test-em-doctor.mjs
3. node tests/test-trigger-index-playbooks.mjs
4. node scripts/em-doctor.mjs --all-projects → valid JSON, exit 0 or 1 by health, NO crash
5. node tests/test-ci-suite-registration.mjs

Hard rules unchanged (frozen spec §20): writable set only, no git mutations, isolated
fixture stores only.
