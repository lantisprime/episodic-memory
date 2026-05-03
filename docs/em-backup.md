# em-backup — Mirror personal episodic-memory state to a private GitHub repo

`scripts/em-backup.mjs` — opt-in, config-driven backup script. Mirrors your global and per-project `.episodic-memory/` stores (and any other source you list) to a private GitHub repo, with regex-based PII / secret redaction applied to the staged copy. Source files on disk are never modified.

## Why

Episodes accumulate on local disk and have no built-in durability. If your disk dies, the corpus dies with it. `em-backup` provides a low-effort backup path: a single private repo, opt-in via config, runs manually or on a timer.

## Threat model

- **Backup repo is private**, but treat the bar as: *if it's ever made public by mistake, no live secrets or real PII should leak.*
- All text content goes through a redaction pipeline before reaching the staged copy. Source files on disk are untouched.
- Binary files (detected by content probe, not extension) are **skipped** with manifest entries — never byte-copied raw to avoid `.pem` / `.key` / `.sqlite` leaks.
- Redaction is **regex-based**. Strong against common token formats but won't catch every novel/custom credential shape. For higher assurance, add `gitleaks` or `trufflehog` as an external pre-push step.

## Setup

1. **Copy the example config:**
   ```bash
   mkdir -p ~/.config/em-backup
   cp examples/em-backup.config.example.json ~/.config/em-backup/config.json
   ```
2. **Edit it:** fill in `repo_owner`, `repo_name`, and your `sources` list. The script refuses `--init` / `--sync` without `repo_owner`, `repo_name`, and at least one source.
3. **Verify:**
   ```bash
   node scripts/em-backup.mjs --show-config   # echoes the resolved config
   node scripts/em-backup.mjs --self-test     # 35 redaction unit tests
   node scripts/em-backup.mjs --audit         # scan sources, no writes
   ```
4. **First push:**
   ```bash
   node scripts/em-backup.mjs --init          # creates private repo via gh + first push
   ```
5. **Recurring sync (manual):**
   ```bash
   node scripts/em-backup.mjs --sync
   ```

## Config schema

```json
{
  "repo_owner": "your-github-username",
  "repo_name": "episodic-memory-backup",
  "backup_dir": "~/.local/share/episodic-memory-backup",
  "sources": [
    { "src": "~/.episodic-memory", "dest": "global", "label": "global" }
  ],
  "extra_allowlist_emails": [],
  "extra_allowlist_domains": [],
  "extra_redact_strings": ["your-username", "Real Name"]
}
```

| Field | Required | Description |
|---|---|---|
| `repo_owner` | yes | GitHub user/org for the backup repo |
| `repo_name` | yes | Repo name (will be created as private on first `--init`) |
| `backup_dir` | no | Local clone path. Default `~/.local/share/episodic-memory-backup`. Tilde expansion supported. |
| `sources` | yes (≥1) | Array of `{ src, dest, label }`. `src` = absolute or `~/`-prefixed source dir; `dest` = subdir under backup repo root; `label` = display name. Dest must NOT escape backup_dir (`..`, absolute paths rejected at config-load). |
| `extra_allowlist_emails` | no | Emails NOT to redact (e.g. published team addresses). Lowercased. |
| `extra_allowlist_domains` | no | Domains NOT to redact (e.g. your company domain). Lowercased. |
| `extra_redact_strings` | no | Literal strings to additionally redact (e.g. your username, real name, company name). Replaces with `[REDACTED]`. Applied BEFORE built-in patterns. Catches narrative usage that path/email regex misses (e.g. username inside markdown code-fence). |

Config is searched in this order: `$EM_BACKUP_CONFIG`, then `~/.config/em-backup/config.json`. First match wins.

### Why `extra_redact_strings` exists

The built-in `home_path` regex catches `/Users/<name>` in path context but misses bare username strings in narrative text (e.g. `` `charltond.ho` was not redacted `` inside a markdown code-fence). Synthetic test fixtures don't exercise narrative usage; first real `--init` against a real corpus surfaced one such leak. `extra_redact_strings` is the user-supplied complement: list anything you don't want to leak as a literal string, regardless of context.

Add your username, real name, project codename, company name, etc. The script applies these BEFORE built-in patterns so they can't be partially eaten by generic regex. Sort-longest-first means `["Foo", "Foo Bar"]` redacts `"Foo Bar"` correctly.

### Artifact-wide redaction policy

`extra_redact_strings` is treated as an **artifact-wide policy**, not just content. The same redaction is applied to:

| Surface | Behavior |
|---|---|
| File contents | Replaced with `[REDACTED]` (along with built-in patterns) |
| Backup pathnames under `BACKUP_DIR/<dest>/` | Path segments containing the literal are rewritten (e.g. source `src/SecretCodename/note.md` → backup `<dest>/[REDACTED]/note.md`) |
| `.skipped-files.json` manifest entries | Paths run through the redaction (also redacts `/Users/<name>` → `/Users/USER`) |
| `--audit` JSON `file:` and `src:` fields | Same treatment |
| `--show-config` output | `extra_redact_strings` field is masked (shown as count) so terminal output / shared review evidence doesn't leak the list itself |

Pruning uses a source-driven model: it computes the expected backup paths from the source side (applying the same redaction transformation), then deletes anything in backup that isn't in the expected set. This keeps prune correct when redacted segment names diverge from source segment names.

The only raw strings that ever leave the script are the actual filesystem operations on `BACKUP_DIR` itself (Node fs API calls — not in any output stream that an attacker or reviewer could see).

## What gets redacted

| Pattern | Replacement | Example |
|---|---|---|
| GitHub tokens (`gh[oprsu]_...`) | `[GITHUB_TOKEN]` | `gho_AbC...` → `[GITHUB_TOKEN]` |
| OpenAI/Anthropic `sk-` keys | `[SK_KEY]` | `sk-ant-api03-...` → `[SK_KEY]` |
| Stripe live/test | `[STRIPE_KEY]` | `sk_live_...` → `[STRIPE_KEY]` |
| AWS access key id | `[AWS_AKID]` | `AKIA...` → `[AWS_AKID]` |
| Slack tokens | `[SLACK_TOKEN]` | `xoxb-...` → `[SLACK_TOKEN]` |
| Google OAuth | `[GOOGLE_OAUTH]` | `ya29....` → `[GOOGLE_OAUTH]` |
| JWTs | `[JWT]` | `eyJ...` → `[JWT]` |
| `key=`/`token=`/`password=` values | `[REDACTED_SECRET]` | `password="..."` → `password="[REDACTED_SECRET]"` |
| Home paths | `/Users/USER` or `/home/USER` | `/Users/alice/proj` → `/Users/USER/proj` |
| Generic emails (with allowlist) | `[EMAIL]` | `bob@somecorp.io` → `[EMAIL]` |
| Phone numbers (E.164) | `[PHONE]` | `+1 415 555 0123` → `[PHONE]` |

Email allowlist (built-in, additive via config):
- RFC 2606 reserved (`@example.com/.org/.net`)
- GitHub no-reply (`@users.noreply.github.com`, `git@github.com`)
- Vendor commit-author constants: `noreply@anthropic.com`, `copilot@github.com`, `cursor@cursor.sh`, `codex@openai.com`, `windsurf@codeium.com`, `noreply@continue.dev`
- Project sample: `juan.delacruz@acme.com`

## What gets skipped

- Files >1MB (manifested in `.skipped-files.json`)
- Symlinks (manifested; never followed for security)
- Files detected as binary by content probe (NUL byte or >30% non-printable in head 4KB)
- Anything under `/.git/`, `/node_modules/`, `/.claude/worktrees/`, or matching `*.tmp`/`*.log`/`*.swp`

The `.skipped-files.json` manifest is written to the backup repo root on every `--sync` so you have visibility into what didn't make it.

## Operational modes

| Flag | Behavior | Side effects |
|---|---|---|
| `--self-test` | Inline unit tests covering 11 redaction patterns, binary detection, audit-no-leak regression, dest-escape rejection, and remote+branch validation. Count grows as new regressions land — run the command for the current number. | None |
| `--show-config` | Print resolved config | None |
| `--audit [--sample N]` | Scan sources, report file count + redaction counts + N redacted-snippet samples | None |
| `--init` | Create private GitHub repo via `gh repo create --private`, init local clone, first sync, first push | Creates private GitHub repo + local clone dir + `.skipped-files.json` |
| `--sync` | Rsync sources → redact → commit changed files → push (retries unpushed local commits from prior failed pushes) | Commits + pushes to backup repo |

## Recommended rollout (fail-closed staging)

1. Self-test passes
2. `--audit` reviewed (samples scrutinized for false negatives)
3. Manual `--init` once, with eyes on output
4. Manual `--sync` for a few iterations, confirming `.skipped-files.json` content + commit history
5. Optional: launchd/cron timer for daily `--sync` once stable

Daily unattended push is *not* recommended until: redaction blocklist proven on real corpus, secret scanner (gitleaks) added as preflight, lock file for concurrent-run prevention.

## Related issues

- [#133](https://github.com/lantisprime/episodic-memory/issues/133) — deferred review findings (concurrency lock, count attribution, etc.)
- [#118](https://github.com/lantisprime/episodic-memory/issues/118) — em-review-request wrapper (separate concern, surfaced by the artifact-missing pattern this script's review process exposed)
