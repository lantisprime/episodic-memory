# Env-prefix wrapper escape discipline (review axis)

When reviewing a diff, FLAG any command invocation in code, tests, hooks, CI, or scripts that uses a leading environment-variable assignment whose name hints at gate-bypass intent.

## Suspicious name patterns

- `BYPASS_*` — `BYPASS_GATE=1`, `BYPASS_CHECK=true`
- `SKIP_*` — `SKIP_CLASSIFIER=1`, `SKIP_PREFLIGHT=true`
- `DISABLE_*` — `DISABLE_CHECK=1`, `DISABLE_HOOK=true`
- `ALLOW_*` — `ALLOW_UNSAFE=1`, `ALLOW_OVERRIDE=true`
- `OVERRIDE_*` — `OVERRIDE_PERMISSION=1`
- `UNSAFE_*` — `UNSAFE_MODE=1`
- Known internal gate prefixes for the project under review (e.g. project-specific allowlist-disable vars)

## Why this matters

The wrapping invocation looks innocuous to a permission check (the command itself is allowlisted) while the env var carries the bypass payload. Same env var read by both the classifier and the spawned helper = cross-session attack vector. Documented in episodes tagged `pr-271`.

## What's NOT this rule

Routine framework / runtime env vars on their normal commands:

- `NODE_ENV=production npm start`
- `DEBUG=1 ./run.sh`
- `CI=true pytest`
- `PYTHONPATH=. python script.py`
- `LOG_LEVEL=debug ./service`

These pass through unflagged.

## Verdict guidance

If you find a suspicious env-prefix invocation in the diff:

1. ACCEPT-with-FU — sub-3-LOC fix to remove the env-prefix and route through tool flags or config files instead
2. REJECT — if the env-prefix is load-bearing and the author justifies it, request stronger comment + test demonstrating the legitimate use, OR file as a follow-up issue requiring redesign
3. Do NOT tokenize "allowed vs. disallowed vars" — reject the form, not the var name

## Related discipline

- Stock `Safety-Check Bypass` auto-mode `hard_deny` rule (Claude Code) — env-prefix is a specific instance
- Custom user-level `Env-prefix wrapper escape` rule added 2026-05-16
- `hooks/lib/command-classifier.sh:_PREFLIGHT_WRAPPERS_RE` — local hook-tier defense, repo-scoped
