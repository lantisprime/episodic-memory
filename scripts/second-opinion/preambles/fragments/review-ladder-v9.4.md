# Review ladder (mandatory — apply in order before verdict)

## 1. Memory / prior-art pass

Search local + global episodic memory for same-class failure modes BEFORE reviewing:

```
node scripts/em-search.mjs --tag <work-area> --category lesson --scope all --limit 5 --no-track --no-score
node scripts/em-search.mjs --tag <work-area> --category violation --scope all --limit 5 --no-track --no-score
node scripts/em-search.mjs --tag worktree --category lesson --scope all --limit 5 --no-track --no-score
node scripts/em-search.mjs --tag cwd-binding --scope all --limit 5 --no-track --no-score
```

Cite top hits in the "Prior lessons applied" output section.

## 2. Detailed code review (every cwd-sensitive surface)

For every new file / flag / subprocess call / cwd-sensitive API / marker / lock /
persisted field / evidence episode / state transition / local-or-global store
write — state the AUTHORITY ROOT for each: caller cwd, git root, explicit
--project, HOME/global store, or installed runtime.

## 3. Negative-scenario matrix (mandatory axes for any cwd-sensitive surface)

When a script accepts --project, --scope local, OR shells out to em-store /
em-search / em-revise / git / other cwd-sensitive CLIs, REQUIRE coverage of:

- cwd != --project
- linked worktree cwd vs main repo target
- nested cwd inside target
- non-git cwd, --project given
- subprocess inherits wrong cwd
- HOME/config points elsewhere
- evidence emission succeeds but lands in wrong store
- final JSON says target while artifact is written elsewhere

## 4. Implementation checklist

- Every subprocess that acts on a target project MUST pass cwd: projectRoot
  OR an explicit root flag the callee accepts. Do NOT rely on the callee
  defaulting from process.cwd().
- If final JSON reports project_root, ALL side-effect artifacts must be
  under that same root.
- Bare catch{} in fail-closed paths is P1 by default.

## 5. Verification expectations

- Run at least one temp-dir repro where caller cwd != --project. Assert
  files on disk under target, NOT cwd. Counter-only verification is
  insufficient.
- For evidence-emission helpers: verify BOTH success counter AND actual
  artifact location. Use ls / find on target and caller paths.

## 6. Toolkit v9.4 disciplines (load before verdict)

- #18 invariant-first review (Locally Verifiable column required; "NO" → BLOCKER)
- #17 implementer second-order review (decision-logic fan-out vs negative-test fan-out — both checked independently per branch × per axis)
- #15 cluster findings by class
- #16 three-state verdict {ACCEPT, HOLD, REJECT, ACCEPT-with-FU}
- #19 spec-cycle stop condition (3+ rounds non-decreasing + contract-cross-reference → ACCEPT-with-FU)
- #20 project-root binding audit (when any cwd-sensitive trigger fires)

## 7. Closeout requirements (in verdict section)

- List the negative scenarios actually executed.
- If a relevant same-class memory lesson exists but was NOT tested, say WHY.
- Do NOT mark "evidence emission verified" unless BOTH emission accounting
  AND artifact location were checked on disk.
