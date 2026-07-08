# Plan: em-console (local web UI) + em-manage (day-2 wizard)

Status: implemented same-session under operator full-autonomy grant (2026-07-08).
Workplan v166 item 1. Presentation layer per CAPABILITIES.md "Adjacent layers".

## 1. Problem

The substrate is CLI-JSON only. Two gaps:
- No at-a-glance view of what memory holds (stats, health, browse, history chains,
  pending capture drafts) without composing multiple CLI invocations.
- No guided day-2 maintenance path (hygiene, backup, routines) for users who did
  not memorize the script surface. install-wizard.mjs covers setup only and ships
  nowhere (repo-dev).

## 2. Principle grounding (governing-artifact consult)

- **P11 (portable core contract)** — both surfaces spawn the sibling `em-*` scripts
  and present their JSON verbatim. Zero decision logic server/wizard-side: they
  validate request SHAPE, never interpret episode semantics.
- **P6 (tokens/bounded background work)** — em-console is user-started, prints its
  URL+cost model on startup, idle-times-out by default (30 min), burns zero tokens
  (no LLM calls) and zero work when idle (no polling loops server-side; UI is
  request-driven).
- **P1 (memory is the substrate)** — no new data layer. The console holds no state
  beyond the in-memory session token; everything read/written goes through the
  existing scripts.
- **P3/P10 (consent/reversibility)** — write operations require the explicit
  `--allow-write` launch flag; default launch is read-only. Destructive-looking
  maintenance (fold, prune) is dry-run-first in both surfaces.
- **P9 (core never imports adapters)** — both scripts import only node stdlib +
  sibling scripts via spawn. Nothing in core references them.
- **P12** — both are substrate-tier presentation (no hooks, no gates, no markers);
  they match the `em-*` substrate allowlist in install-manifest.mjs and ship to
  `~/.episodic-memory/scripts/` automatically.
- **CAPABILITIES.md** — "Presentation — skill wrappers, wizards, terminal and web
  consoles... they spawn the same CLI contract and present its JSON; they never
  decide." This plan implements exactly that sentence.

## 3. em-console.mjs — design

`node em-console.mjs [--port N] [--host 127.0.0.1] [--allow-write] [--idle-timeout SECS] [--token T]`

- **Startup contract**: prints exactly one JSON object to stdout
  (`{status:'ok', script, url, host, port, allow_write, idle_timeout_seconds, pid}`)
  then serves. Shutdown/idle notices go to stderr so stdout stays one parseable
  object (matches the scripts-print-JSON convention and the help gauntlet).
- **--help contract**: standalone `--help`/`-h` anywhere in argv short-circuits to
  `{script,status,usage}` exit 0 before any side effect.
- **Bind policy**: loopback only. Non-loopback `--host` values are refused with
  exit 2 (`status:'error'`). No override flag — remote exposure is out of scope.
- **Auth**: per-launch token (`crypto.randomBytes(24)`, base64url) unless `--token`
  provided (tests). First page load carries `?token=`; the page strips it from the
  URL and holds it in JS memory; every API call sends `X-EM-Token`. All routes
  except the token-carrying page load 401 without it. Comparison is
  `crypto.timingSafeEqual` over sha256 digests (length-independent).
- **API**: single `POST /api/run` `{cmd, flags}` against a closed declarative
  registry: `cmd -> {script, fixedArgs, write, flagSpec}`. flagSpec types:
  string (length-capped, NUL-rejected, leading-dash-rejected), int (bounded),
  bool, enum, id (episode-id regex). Unknown cmd/flag/value shape -> 400.
  `write:true` cmds -> 403 when the server was launched without `--allow-write`
  (fail-closed). Children are spawned argv-array (no shell) with the launch cwd,
  60s timeout, output parsed as JSON and returned verbatim under `result`.
- **Commands v1**: read = stats, doctor, search (always `--no-track`), list,
  recall, history, graph, semantic, capture-list, fold-preview, prune-preview;
  write = store, revise, pin, feedback, move, doctor-fix, rebuild-index,
  fold-apply, prune-apply.
- **UI**: one self-contained inline HTML page (scripts/lib/console-page.mjs, no
  external assets, dark/light aware). Tabs: Dashboard (stats + doctor),
  Browse (search/list filters -> table -> episode history view), Recall,
  Drafts (capture list), Maintenance (hygiene ops, dry-run first), New episode
  (write mode only). Read-only launches render write controls disabled with the
  enabling command shown.
- **Idle lifetime**: default 1800s without a request -> graceful close, stderr
  notice, exit 0. `--idle-timeout 0` disables. Timer is unref'd; activity
  timestamp updates per request.

## 4. em-manage.mjs — design

Interactive day-2 maintenance wizard (menu loop), scriptable via piped stdin using
the buffered line-reader pattern proven in install-wizard.mjs (EOF -> defaults,
never hangs). Menu:

1. status — doctor + stats (scope all; optional --all-projects view)
2. hygiene — rebuild-index / consolidate fold (dry-run, then confirmed --apply) /
   prune (dry-run, then confirmed --apply) / doctor --fix
3. backup — config status; init/sync via em-backup
4. capture — pending drafts list; spawns `em-capture review` on request
5. routines — list; sync
6. console — launches em-console (stdio inherit)
q. quit

All actions spawn sibling scripts and render their JSON as terse human output;
raw JSON available via each action's `[j]` toggle. Interactive prose surface:
the `em.mjs` "only non-JSON output surface" comment is amended to "non-interactive
commands emit JSON; interactive surfaces (help, em-manage) print prose".

## 5. Out of scope (v1)

- Remote/binding beyond loopback; TLS; multi-user.
- Store switching across registered stores in the console UI (per-store pages);
  `--all-projects` toggles on stats/doctor cover the aggregate view.
- Charts in the dashboard (tables/badges only).
- em-capture confirm/discard via web UI (drafts are listed read-only; confirm
  stays in `em-capture review`).
- readonly-commands manifest entries (server + wizard are not one-shot readers).

## 6. Tests

- tests/test-em-console.mjs — spawns the server on an ephemeral port against an
  isolated HOME+cwd fixture store: startup JSON shape; 401 unauth + wrong token;
  page served with token; /api/run stats/search happy path; unknown cmd 400;
  bad flag value 400; write cmd 403 without --allow-write (fail-closed negative);
  write cmd works with --allow-write (store -> search roundtrip); non-loopback
  host refused exit 2; leading-dash flag value rejected 400.
- tests/test-em-manage.mjs — piped-stdin flows on a fixture store: status flow;
  hygiene rebuild-index; fold dry-run with declined apply (store untouched);
  EOF starvation exits cleanly; --help contract.
- Both scripts join tests/test-em-help-flags.mjs SUBSTRATE list.
- Both suites registered in .github/workflows/plan-marker-validate.yml.

## 7. Docs

EM_SCRIPTS_GUIDE.md full entries + intent-routing rows; README Scripts Reference;
USER_MANUAL scenario (launch console read-only, browse, maintenance via wizard);
em.mjs DESCRIPTIONS entries.

## 8. Review dispositions

negative-scenario-reviewer on the implementation diff (runtime probes on
isolated fixture stores; verdict ACCEPT, no P1):

| # | Finding | Sev | Disposition |
|---|---|---|---|
| F1 | Prototype-key flag names ride the allowlist (plain-object lookup as membership; `__proto__`/`valueOf`/`hasOwnProperty` resolve truthy) | P2 | FIXED — `Object.hasOwn` guard in buildArgs; regression test sends 5 prototype keys, expects 400 each. Same invariant class as #469. |
| F2 | `str` kind accepted raw CR/LF/TAB in short token fields (tag/project/reason) | P3 | FIXED — control-byte reject split by kind: `multiline` (summary/body/query) keeps tab/LF/CR, plain `str` rejects all control bytes. Regression: newline-in-tag 400, multiline query 200. |
| F3 | em-manage option 6 (console launch) blocks up to the 1800s idle window under piped stdin (no Ctrl-C path) | P2 | FIXED — non-TTY stdin refuses with the direct command printed; regression feeds `6` and asserts refusal + exit 0. |
| F4 | Idle shutdown checked on a fixed 30s tick regardless of `--idle-timeout` | P3 | FIXED — interval = min(30s, idleTimeoutMs). |
| F5 | Registry `write:false` classification had no conformance test tying it to actual non-mutation | P3 | FIXED — byte-stability sweep: every read command runs against a seeded sandbox and the full tree sha256 must be identical before/after; the case list is pinned to the registry so a new read command fails the sweep until added. |
| F6 | CSP `script-src 'unsafe-inline'` means esc() is the only XSS layer (all sinks verified escaped) | P3 | PARTIAL — added `object-src 'none'; base-uri 'none'; form-action 'none'`. Script nonce deferred: single-page inline app, all sinks audited + hostile-payload probed by the reviewer. |

codex (gpt-5.5, cmux interactive) round 1 on the same diff post-F1-F6
(runtime probes incl. 80-way concurrency and a live TOCTOU injection; verdict
HOLD, 3xP2 + 1xP3):

| # | Finding | Sev | Disposition |
|---|---|---|---|
| R1-1 | Child CLI failures wrapped as top-level `status:"ok"` (invalid category store probed: wrapper ok, child error buried) | P2 | FIXED WITH MODIFICATION — wrapper relays `status:'error'` + message ONLY when the child self-declares `status:'error'`; exit code alone does not flip it, because em-doctor exits 1 with `status:'issues'` on an unhealthy store and that report must stay renderable (probed both polarities; both regression-tested). |
| R1-2 | No concurrency bound on /api/run child fan-out (80 parallel calls -> 75 simultaneous children x 32MB maxBuffer) | P2 | FIXED — in-process semaphore: 4 running children max, 32 queued max, 429 beyond; 50-way burst regression asserts only 200/429 and post-burst responsiveness. |
| R1-3 | em-manage dry-run consent TOCTOU: store mutated between preview and `y` applies unpreviewed state | P2 | FIXED — apply re-runs the dry-run; on any JSON difference it prints the refreshed preview and re-asks (loop until stable or declined). Regression drives a live wizard, injects a second chain mid-prompt, asserts re-confirmation fires and declined apply leaves bytes untouched. |
| R1-4 | Query-string token accepted on every route, not just the bootstrap page | P3 | FIXED — `?token=` authorizes GET / only; /api/* requires the X-EM-Token header. Regression: query token on /api/meta and /api/run -> 401, page load -> 200. |
