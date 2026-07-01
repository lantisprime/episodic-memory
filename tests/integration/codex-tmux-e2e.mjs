#!/usr/bin/env node
// tests/integration/codex-tmux-e2e.mjs
//
// UNGUARDED-IN-CI integration proof for RFC-008 P6 (REQ-14; Risk R1 / openai/codex#17532):
// the project-local `.codex/hooks.json` PreToolUse hook FIRES on an INTERACTIVE codex TUI
// session (not just headless `codex exec`), and firing is gated on hook-trust. #17532 reports
// repo-local `config.toml` Stop/SessionStart not firing interactively; this proves the
// turn-scoped `hooks.json` PreToolUse path is unaffected on the installed binary.
//
// Drives the REAL `codex` binary through tmux. Requires: codex-cli >= 0.141.0, tmux >= 3.5,
// and an authenticated codex login. NOT invoked in CI (no live codex / login there). Run by hand:
//   node tests/integration/codex-tmux-e2e.mjs
//
// Asserts:
//   firingProof - trusted run: a logging-ALLOW PreToolUse hook captures a real multi-file
//                 apply_patch stdin line (hook_event_name:"PreToolUse", tool_name:"apply_patch").
//                 Allow (not deny) keeps the proof non-vacuous: the write actually proceeds.
//   trustGate   - untrusted run ("continue without trusting"): the same prompt produces NO
//                 capture line, proving hook execution is gated on hook-trust.
//
// The captured trusted-run stdin is the ground truth behind
// tests/fixtures/harness-events/codex/pre-tool-use.json (normalized with a synthesized turn_index).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STRIP = /\x1b\[[0-9;?]*[A-Za-z]/g; // drop ANSI/CSI so regex matches plain text
const CODEX = process.env.CODEX_BIN || 'codex';

const PROMPT =
  'Using a single apply_patch call, create exactly two new files with these exact one-line contents:\n' +
  '1) src/probe.mjs whose only line is: export const probe = 42;\n' +
  '2) docs/plans/note.md whose only line is: # note\n' +
  'Use one apply_patch with both Add File directives. Add no other lines. ' +
  'Do not run any shell commands. Proceed without asking for confirmation.';

// Exact expected file contents (the apply_patch write proceeds under BOTH trust modes;
// only the hook execution is trust-gated). Used as the non-vacuity positive control.
const EXPECT = {
  'src/probe.mjs': 'export const probe = 42;',
  'docs/plans/note.md': '# note',
};

function assertFilesWritten(dir, label) {
  for (const [rel, content] of Object.entries(EXPECT)) {
    const p = path.join(dir, rel);
    assert(fs.existsSync(p), `${label}: expected the apply_patch to write ${rel} (write must proceed; only the hook is trust-gated). dir=${dir}`);
    const got = fs.readFileSync(p, 'utf8').trim();
    assert(got === content, `${label}: ${rel} content mismatch.\n expected: ${JSON.stringify(content)}\n got:      ${JSON.stringify(got)}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Synchronous sleep (this is a manual driver; coarse timing is fine and keeps the flow linear).
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function have(bin, arg) {
  try { execFileSync(bin, [arg], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Build an isolated mock project: git repo + a logging-allow PreToolUse hook + empty capture log.
function makeMock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'probe@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'probe']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# mock codex project\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed']);

  const captureLog = path.join(dir, 'capture.log');
  fs.writeFileSync(captureLog, '');

  const hookScript = path.join(dir, 'capture-hook.mjs');
  fs.writeFileSync(hookScript, [
    "import fs from 'node:fs';",
    `const LOG = ${JSON.stringify(captureLog)};`,
    "let d='';",
    "process.stdin.on('data',(c)=>{d+=c;});",
    "process.stdin.on('end',()=>{try{fs.appendFileSync(LOG,d+'\\n');}catch{}process.exit(0);});",
    "process.stdin.on('error',()=>process.exit(0));",
    '',
  ].join('\n'));

  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.codex', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: '.*',
        hooks: [{ type: 'command', command: `node ${hookScript}`, statusMessage: 'capturing', timeout: 30 }],
      }],
    },
  }, null, 2));

  return { dir, captureLog };
}

function tmuxFactory(sock) {
  return (...args) => execFileSync('tmux', ['-L', sock, ...args], { encoding: 'utf8' });
}

function capture(t, win, lines = 200) {
  return t('capture-pane', '-p', '-e', '-J', '-t', win, '-S', `-${lines}`).replace(STRIP, '');
}

function startCodex(t, win, mock) {
  const conf = path.join(os.tmpdir(), `csiu-${process.pid}.conf`);
  fs.writeFileSync(conf, 'set -g extended-keys-format csi-u\nset -g extended-keys on\n');
  t('-f', conf, 'new-session', '-d', '-s', 'codex', '-x', '200', '-y', '50', '-c', mock);
  fs.rmSync(conf, { force: true });
  t('send-keys', '-t', win, CODEX, 'Enter');
}

function waitFor(t, win, re, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = capture(t, win);
    if (re.test(last)) return last;
    sleepMs(1000);
  }
  throw new Error(`waitFor timeout (${label}) for ${re}\n--- pane ---\n${last}`);
}

function waitIdle(t, win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let pane = '';
  while (Date.now() < deadline) {
    pane = capture(t, win);
    if (!/esc to interrupt|esc to cancel|Working|Thinking/i.test(pane)) return pane;
    sleepMs(2000);
  }
  return pane;
}

function pastePrompt(t, win, text) {
  const pf = path.join(os.tmpdir(), `codex-prompt-${process.pid}.txt`);
  fs.writeFileSync(pf, text);
  t('load-buffer', pf);
  t('paste-buffer', '-t', win);
  sleepMs(800);
  t('send-keys', '-t', win, 'Enter');
  fs.rmSync(pf, { force: true });
}

// One full interactive drive. trust: 'all' (Trust all and continue) | 'none' (Continue without trusting).
function driveOnce(trust) {
  const { dir, captureLog } = makeMock();
  const sock = `codex-e2e-${process.pid}-${trust}`;
  const win = 'codex:0';
  const t = tmuxFactory(sock);
  try {
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server yet */ }
    startCodex(t, win, dir);
    waitFor(t, win, /trust the contents of this directory/i, 30000, 'dir-trust');
    t('send-keys', '-t', win, 'Enter');                       // option 1: Yes, continue
    waitFor(t, win, /Hooks need review|hook is new or changed/i, 30000, 'hook-trust');
    if (trust === 'all') t('send-keys', '-t', win, '2', 'Enter'); // Trust all and continue
    else t('send-keys', '-t', win, '3', 'Enter');                 // Continue without trusting
    waitFor(t, win, /gpt-5\.5\s+(high|medium|low|default|minimal)/i, 45000, 'model-ready');
    sleepMs(3000);
    pastePrompt(t, win, PROMPT);
    sleepMs(2000);
    waitIdle(t, win, 120000);
    sleepMs(2500); // let the hook process flush its append
  } finally {
    try { t('kill-server'); } catch { /* already gone */ }
  }
  return { dir, log: fs.readFileSync(captureLog, 'utf8') };
}

function preToolUseLines(log) {
  return log.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((o) => o && o.hook_event_name === 'PreToolUse');
}

function testFiringProof() {
  const { dir, log } = driveOnce('all');
  const hits = preToolUseLines(log).filter((o) => o.tool_name === 'apply_patch');
  assert(hits.length > 0,
    `firingProof: expected >=1 PreToolUse/apply_patch capture line on a TRUSTED interactive session.\nlog:\n${log}`);
  // Non-vacuous: ONE captured apply_patch event must carry BOTH Add File directives (a single
  // multi-file call) — not two separate single-file calls whose directives only coincide when
  // joined. Avoids both the filter tautology and the join false-positive.
  const multiFile = hits.some((h) => {
    const c = typeof h.tool_input?.command === 'string' ? h.tool_input.command : '';
    return /^\*\*\* Add File: src\/probe\.mjs$/m.test(c) && /^\*\*\* Add File: docs\/plans\/note\.md$/m.test(c);
  });
  assert(multiFile,
    `firingProof: at least one captured apply_patch event must contain BOTH Add File directives (single multi-file call).\nhits:\n${JSON.stringify(hits.map((h) => h.tool_input?.command), null, 2)}`);
  // And the allow-hook must have let the write proceed.
  assertFilesWritten(dir, 'firingProof');
}

function testTrustGate() {
  const { dir, log } = driveOnce('none');
  // Positive control first: the write MUST have proceeded (else an empty log is vacuous —
  // it would mean "nothing happened", not "the hook was trust-gated").
  assertFilesWritten(dir, 'trustGate');
  assert(preToolUseLines(log).length === 0,
    `trustGate: an UNTRUSTED session wrote the files but must NOT fire the hook (no PreToolUse capture lines).\nlog:\n${log}`);
}

// enforcementProof (RFC-008 P6 S4, REQ-15) — UNGUARDED-IN-CI (real codex + tmux). Drives the
// DEPLOYED per-project adapter (post REAL install), a discriminating pair. Uses the harness's
// actual helpers (have/tmuxFactory/capture/startCodex/waitFor/waitIdle/pastePrompt/sleepMs/assert).

// A capture-hook-free mock: enforcement comes from the REAL install below, not makeMock's
// logging hook. Mirrors makeMock's git seed but writes NO .codex/hooks.json.
function bareMock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-enforce-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'probe@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'probe']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# mock codex project\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'seed']);
  return dir;
}

// Two SEQUENTIAL single-file apply_patch calls: a MIXED patch touching a repo-source path is
// denied WHOLESALE, so the ALLOW half is only observable via a SEPARATE docs-only patch.
const ENFORCE_PROMPT =
  'Make two SEPARATE apply_patch calls, in this order, and run no shell commands:\n' +
  '1) First call: one apply_patch that adds ONLY docs/plans/note.md whose single line is: # note\n' +
  '2) Second call: one apply_patch that adds ONLY src/probe.mjs whose single line is: export const probe = 42;\n' +
  'Proceed without asking for confirmation. If a call is blocked, continue to the next.';

function testEnforcementProof() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(here, '..', '..');
  const INSTALL = path.join(REPO, 'install.mjs');
  const dir = bareMock();
  // Install the REAL per-project enforcement (writes .codex/hooks.json + closure).
  const ins = execFileSync(process.execPath,
    [INSTALL, '--tool', 'codex', '--project', dir, '--install-enforcement'], { encoding: 'utf8' });
  assert(/\/hooks/.test(ins), `enforcementProof: install must print the /hooks trust instruction.\n${ins}`);
  const sock = `codex-enforce-${process.pid}`;
  const win = 'codex:0';
  const t = tmuxFactory(sock);
  try {
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* no server yet */ }
    startCodex(t, win, dir);
    waitFor(t, win, /trust the contents of this directory/i, 30000, 'dir-trust');
    t('send-keys', '-t', win, 'Enter');                       // option 1: Yes, continue
    waitFor(t, win, /Hooks need review|hook is new or changed/i, 30000, 'hook-trust');
    t('send-keys', '-t', win, '2', 'Enter');                  // Trust all and continue
    waitFor(t, win, /gpt-5\.5\s+(high|medium|low|default|minimal)/i, 45000, 'model-ready');
    sleepMs(3000);
    pastePrompt(t, win, ENFORCE_PROMPT);
    sleepMs(2000);
    waitIdle(t, win, 240000);
    sleepMs(2500);                                            // let the deny FULLY render
    const pane = capture(t, win, 400);                        // capture AFTER the settle
    const deniedSrc = /src\/probe\.mjs/.test(pane) && /deny|denied|blocked|not permitted|permission/i.test(pane);
    const allowedDocs = fs.existsSync(path.join(dir, 'docs', 'plans', 'note.md'));
    const blockedSrc = !fs.existsSync(path.join(dir, 'src', 'probe.mjs'));
    fs.writeFileSync(path.join(os.tmpdir(), `enforcementProof-${process.pid}.pane`), pane);
    assert(deniedSrc && allowedDocs && blockedSrc,
      `enforcementProof: expected repo-source src/probe.mjs DENIED and docs/plans/note.md ALLOWED.\n` +
      `deniedSrc=${deniedSrc} allowedDocs=${allowedDocs} blockedSrc=${blockedSrc}\n--- pane ---\n${pane}`);
  } finally {
    try { t('kill-server'); } catch { /* already gone */ }
  }
}

function main() {
  if (!have(CODEX, '--version') || !have('tmux', '-V')) {
    console.log('SKIP - codex and/or tmux not available; this is a manual live-codex proof.');
    process.exit(0);
  }
  const tests = [['firingProof', testFiringProof], ['trustGate', testTrustGate], ['enforcementProof', testEnforcementProof]];
  let pass = 0;
  for (const [name, fn] of tests) {
    try { fn(); console.log(`ok - ${name}`); pass++; }
    catch (e) { console.error(`not ok - ${name}\n${e.message}`); }
  }
  console.log(`\n${pass}/${tests.length} pass`);
  process.exit(pass === tests.length ? 0 : 1);
}

main();
