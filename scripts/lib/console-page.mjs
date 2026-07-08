/**
 * console-page.mjs — the single self-contained HTML page em-console serves.
 *
 * Pure presentation (Principle 11): every panel is a thin form over one
 * POST /api/run command; all data shown comes back from the spawned em-*
 * script's JSON, rendered client-side. No external assets (CSP: default-src
 * 'none'), no cookies — the token rides in from ?token=, is moved to JS
 * memory, stripped from the URL, and sent as X-EM-Token on every call.
 */

export function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>em-console</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #1b2733; --muted: #5d6b7a;
  --line: #dde3ea; --accent: #2563eb; --accent-ink: #ffffff;
  --ok: #15803d; --warn: #b45309; --err: #b91c1c; --chip: #eef2f7;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #10151b; --panel: #171e26; --ink: #e6edf3; --muted: #93a4b4;
    --line: #2b3641; --accent: #4f8ef7; --accent-ink: #0b1016;
    --ok: #4ade80; --warn: #fbbf24; --err: #f87171; --chip: #202a35;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 10px 18px;
  background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; letter-spacing: .3px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--chip);
  color: var(--muted); border: 1px solid var(--line); }
.badge.write { color: var(--warn); }
nav { display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto; }
nav button { background: none; border: 1px solid transparent; color: var(--muted);
  padding: 6px 12px; border-radius: 8px; cursor: pointer; font: inherit; }
nav button.active { background: var(--chip); color: var(--ink); border-color: var(--line); }
main { max-width: 1100px; margin: 0 auto; padding: 18px; }
section.tab { display: none; }
section.tab.active { display: block; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 16px; margin-bottom: 14px; }
.panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .8px;
  color: var(--muted); margin: 0 0 10px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; margin-bottom: 10px; }
label.field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
input, select, textarea { font: inherit; color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px; }
textarea { width: 100%; min-height: 110px; resize: vertical; }
button.act { background: var(--accent); color: var(--accent-ink); border: none;
  border-radius: 8px; padding: 7px 14px; cursor: pointer; font: inherit; }
button.act.secondary { background: var(--chip); color: var(--ink); border: 1px solid var(--line); }
button.act:disabled { opacity: .45; cursor: not-allowed; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: var(--bg); }
.card .k { font-size: 12px; color: var(--muted); }
.card .v { font-size: 22px; font-weight: 600; }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px; }
tr.clickable { cursor: pointer; }
tr.clickable:hover td { background: var(--chip); }
.lvl-ok { color: var(--ok); } .lvl-warn { color: var(--warn); } .lvl-error { color: var(--err); }
.chips span { display: inline-block; background: var(--chip); border: 1px solid var(--line);
  border-radius: 999px; padding: 1px 8px; font-size: 11px; margin: 1px 3px 1px 0; color: var(--muted); }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
details.raw { margin-top: 8px; }
details.raw summary { color: var(--muted); font-size: 12px; cursor: pointer; }
.note { color: var(--muted); font-size: 12px; }
.err { color: var(--err); }
#toast { position: fixed; bottom: 16px; right: 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; display: none;
  max-width: 380px; box-shadow: 0 4px 18px rgba(0,0,0,.18); }
</style>
</head>
<body>
<header>
  <h1>em-console</h1>
  <span id="mode" class="badge">…</span>
  <span id="cwd" class="badge"></span>
  <nav id="nav"></nav>
</header>
<main id="main"></main>
<div id="toast"></div>
<script>
'use strict';
// --- token bootstrap: move ?token= into memory, scrub the URL --------------
const qs = new URLSearchParams(location.search);
const TOKEN = qs.get('token') || '';
if (qs.has('token')) history.replaceState(null, '', location.pathname);

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'X-EM-Token': TOKEN, 'Content-Type': 'application/json' } }, opts));
  const body = await r.json().catch(() => ({ status: 'error', message: 'non-JSON response' }));
  return { http: r.status, body };
}
async function run(cmd, flags) { return api('/api/run', { method: 'POST', body: JSON.stringify({ cmd, flags: flags || {} }) }); }

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function el(id) { return document.getElementById(id); }
function toast(msg, isErr) {
  const t = el('toast');
  t.textContent = msg; t.style.display = 'block'; t.className = isErr ? 'err' : '';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 4000);
}
function raw(obj) { return '<details class="raw"><summary>raw JSON</summary><pre>' + esc(JSON.stringify(obj, null, 2)) + '</pre></details>'; }
function resultOrError(res, renderFn, target) {
  if (res.http !== 200 || res.body.status !== 'ok') {
    target.innerHTML = '<p class="err">' + esc(res.body.message || ('HTTP ' + res.http)) + '</p>' + raw(res.body);
    return;
  }
  target.innerHTML = renderFn(res.body.result) + raw(res.body);
}

// --- tabs -------------------------------------------------------------------
let META = { allow_write: false, categories: [], cwd: '' };
const TABS = [
  ['dashboard', 'Dashboard'], ['browse', 'Browse'], ['recall', 'Recall'],
  ['drafts', 'Drafts'], ['maintenance', 'Maintenance'], ['new', 'New episode'],
];
function show(tabId) {
  document.querySelectorAll('section.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tabId));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
}

function buildShell() {
  el('nav').innerHTML = TABS.map(([id, label]) =>
    '<button data-tab="' + id + '">' + label + '</button>').join('');
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
  el('main').innerHTML = TABS.map(([id]) => '<section class="tab" id="tab-' + id + '"></section>').join('');
}

// --- dashboard ---------------------------------------------------------------
function buildDashboard() {
  el('tab-dashboard').innerHTML =
    '<div class="panel"><h2>Store analytics</h2>' +
    '<div class="row"><label class="field">scope<select id="st-scope"><option>all</option><option>local</option><option>global</option></select></label>' +
    '<label class="field"><span>all projects</span><input type="checkbox" id="st-all"></label>' +
    '<button class="act" id="st-run">Refresh stats</button></div><div id="st-out"></div></div>' +
    '<div class="panel"><h2>Health</h2>' +
    '<div class="row"><button class="act" id="dr-run">Run doctor</button></div><div id="dr-out"></div></div>';
  el('st-run').onclick = async () => {
    const flags = { scope: el('st-scope').value };
    if (el('st-all').checked) flags['all-projects'] = true;
    resultOrError(await run('stats', flags), renderStats, el('st-out'));
  };
  el('dr-run').onclick = async () => {
    resultOrError(await run('doctor', { scope: 'all' }), renderDoctor, el('dr-out'));
  };
}
function renderStats(r) {
  if (!r.scopes) return '<p class="note">no scopes in output</p>';
  return r.scopes.map(s => {
    const cats = (s.categories || []).slice ? s.categories : Object.entries(s.categories || {}).map(([key, count]) => ({ key, count }));
    return '<div class="panel"><h2>' + esc(s.scope || s.label || '') + (s.dir ? ' <span class="note">' + esc(s.dir) + '</span>' : '') + '</h2>' +
      '<div class="cards">' +
      '<div class="card"><div class="k">active</div><div class="v">' + esc(s.active ?? s.total ?? '–') + '</div></div>' +
      '<div class="card"><div class="k">superseded</div><div class="v">' + esc(s.superseded ?? '–') + '</div></div>' +
      '<div class="card"><div class="k">pinned</div><div class="v">' + esc(s.pinned ?? '–') + '</div></div>' +
      '<div class="card"><div class="k">prunable est.</div><div class="v">' + esc(s.prunable_estimate ?? s.prunable ?? '–') + '</div></div>' +
      '</div>' +
      (cats && cats.length ? '<p class="chips">' + cats.map(c => '<span>' + esc(c.key || c.category) + ' ' + esc(c.count) + '</span>').join('') + '</p>' : '') +
      '</div>';
  }).join('');
}
function renderDoctor(r) {
  const sum = r.summary || {};
  let html = '<div class="cards">' +
    '<div class="card"><div class="k">status</div><div class="v lvl-' + esc(r.status) + '">' + esc(r.status) + '</div></div>' +
    '<div class="card"><div class="k">ok</div><div class="v lvl-ok">' + esc(sum.ok ?? '–') + '</div></div>' +
    '<div class="card"><div class="k">warn</div><div class="v lvl-warn">' + esc(sum.warn ?? '–') + '</div></div>' +
    '<div class="card"><div class="k">error</div><div class="v lvl-error">' + esc(sum.error ?? '–') + '</div></div></div>';
  const bad = (r.checks || []).filter(c => c.level !== 'ok');
  if (bad.length) {
    html += '<div class="tablewrap"><table><tr><th>level</th><th>check</th><th>scope</th><th>message</th></tr>' +
      bad.map(c => '<tr><td class="lvl-' + esc(c.level) + '">' + esc(c.level) + '</td><td>' + esc(c.id) + '</td><td>' + esc(c.scope) + '</td><td>' + esc(c.message) + '</td></tr>').join('') +
      '</table></div>';
  } else { html += '<p class="note">all checks ok</p>'; }
  return html;
}

// --- browse -------------------------------------------------------------------
function buildBrowse() {
  el('tab-browse').innerHTML =
    '<div class="panel"><h2>Search episodes</h2>' +
    '<div class="row">' +
    '<label class="field">query<input id="q-query" size="24"></label>' +
    '<label class="field">tag<input id="q-tag" size="14"></label>' +
    '<label class="field">category<input id="q-cat" size="12" list="cats"></label>' +
    '<label class="field">project<input id="q-proj" size="14"></label>' +
    '<label class="field">scope<select id="q-scope"><option>all</option><option>local</option><option>global</option></select></label>' +
    '<label class="field">limit<input id="q-limit" size="4" value="20"></label>' +
    '<button class="act" id="q-run">Search</button>' +
    '<button class="act secondary" id="q-list">List recent</button>' +
    '</div><datalist id="cats">' + META.categories.map(c => '<option>' + esc(c) + '</option>').join('') + '</datalist>' +
    '<div id="q-out"></div></div>' +
    '<div class="panel"><h2>Episode history</h2><p class="note">click a row above, or enter an id</p>' +
    '<div class="row"><label class="field">episode id<input id="h-id" size="52"></label>' +
    '<button class="act" id="h-run">Load chain</button></div><div id="h-out"></div></div>';
  el('q-run').onclick = async () => {
    const flags = { scope: el('q-scope').value };
    for (const [fid, name] of [['q-query','query'],['q-tag','tag'],['q-cat','category'],['q-proj','project'],['q-limit','limit']]) {
      const v = el(fid).value.trim(); if (v) flags[name] = v;
    }
    resultOrError(await run('search', flags), renderEpisodes, el('q-out'));
  };
  el('q-list').onclick = async () => {
    const flags = { scope: el('q-scope').value };
    const lim = el('q-limit').value.trim(); if (lim) flags.limit = lim;
    const proj = el('q-proj').value.trim(); if (proj) flags.project = proj;
    resultOrError(await run('list', flags), renderEpisodes, el('q-out'));
  };
  el('h-run').onclick = async () => {
    const id = el('h-id').value.trim(); if (!id) return toast('enter an episode id', true);
    resultOrError(await run('history', { history: id }), renderHistory, el('h-out'));
  };
}
function renderEpisodes(r) {
  const eps = r.episodes || [];
  if (!eps.length) return '<p class="note">no episodes</p>';
  return '<div class="tablewrap"><table><tr><th>date</th><th>category</th><th>project</th><th>summary</th><th>src</th></tr>' +
    eps.map(e => '<tr class="clickable" data-id="' + esc(e.id) + '"><td>' + esc(e.date) + '</td><td>' + esc(e.category) + '</td><td>' + esc(e.project) + '</td><td>' + esc(e.summary) + '</td><td>' + esc(e.source || '') + '</td></tr>').join('') +
    '</table></div><p class="note">' + eps.length + ' shown</p>';
}
function renderHistory(r) {
  const eps = r.episodes || r.history || [];
  if (!eps.length) return '<p class="note">no chain found</p>';
  return eps.map(e =>
    '<div class="panel"><h2>' + esc(e.id) + (e.status ? ' <span class="badge">' + esc(e.status) + '</span>' : '') + '</h2>' +
    '<p>' + esc(e.summary) + '</p>' +
    (e.tags && e.tags.length ? '<p class="chips">' + e.tags.map(t => '<span>' + esc(t) + '</span>').join('') + '</p>' : '') +
    (e.body ? '<pre>' + esc(e.body) + '</pre>' : '') + '</div>').join('');
}
document.addEventListener('click', (ev) => {
  const tr = ev.target.closest && ev.target.closest('tr.clickable');
  if (tr && tr.dataset.id) {
    el('h-id').value = tr.dataset.id;
    el('h-run').click();
  }
});

// --- recall -------------------------------------------------------------------
function buildRecall() {
  el('tab-recall').innerHTML =
    '<div class="panel"><h2>Session-start recall preview</h2>' +
    '<div class="row"><label class="field">project<input id="rc-proj" size="18"></label>' +
    '<label class="field">task type<select id="rc-task"><option value="">(default)</option><option>implementation</option><option>push</option><option>rule</option><option>general</option></select></label>' +
    '<button class="act" id="rc-run">Recall</button></div><div id="rc-out"></div></div>';
  el('rc-run').onclick = async () => {
    const flags = {};
    if (el('rc-proj').value.trim()) flags.project = el('rc-proj').value.trim();
    if (el('rc-task').value) flags['task-type'] = el('rc-task').value;
    resultOrError(await run('recall', flags), renderEpisodes, el('rc-out'));
  };
}

// --- drafts -------------------------------------------------------------------
function buildDrafts() {
  el('tab-drafts').innerHTML =
    '<div class="panel"><h2>Pending capture drafts</h2>' +
    '<p class="note">confirm or discard via the CLI: em capture review --draft &lt;id&gt;</p>' +
    '<div class="row"><button class="act" id="cp-run">Refresh</button></div><div id="cp-out"></div></div>';
  el('cp-run').onclick = async () => {
    resultOrError(await run('capture-list', {}), r => '<pre>' + esc(JSON.stringify(r, null, 2)) + '</pre>', el('cp-out'));
  };
}

// --- maintenance ----------------------------------------------------------------
function writeGate(btnHtml) {
  return META.allow_write ? btnHtml
    : btnHtml.replace('<button class="act"', '<button class="act" disabled title="relaunch with --allow-write"');
}
function buildMaintenance() {
  const ro = META.allow_write ? '' : '<p class="note">read-only launch — apply/fix buttons need <code>--allow-write</code></p>';
  el('tab-maintenance').innerHTML = ro +
    '<div class="panel"><h2>Index</h2><div class="row">' +
    writeGate('<button class="act" id="m-rebuild">Rebuild index (scope all)</button>') +
    writeGate('<button class="act" id="m-fix">Doctor --fix (scope all)</button>') +
    '</div><div id="m-idx-out"></div></div>' +
    '<div class="panel"><h2>Fold superseded chains</h2><div class="row">' +
    '<label class="field">scope<select id="m-fold-scope"><option>local</option><option>global</option></select></label>' +
    '<button class="act secondary" id="m-fold-dry">Preview (dry-run)</button>' +
    writeGate('<button class="act" id="m-fold-apply">Apply fold</button>') +
    '</div><div id="m-fold-out"></div></div>' +
    '<div class="panel"><h2>Prune stale episodes</h2><div class="row">' +
    '<label class="field">scope<select id="m-prune-scope"><option>local</option><option>global</option><option>all</option></select></label>' +
    '<button class="act secondary" id="m-prune-dry">Preview (dry-run)</button>' +
    writeGate('<button class="act" id="m-prune-apply">Apply prune</button>') +
    '</div><div id="m-prune-out"></div></div>';
  const jsonR = r => '<pre>' + esc(JSON.stringify(r, null, 2)) + '</pre>';
  const wire = (id, cmd, flagsFn, out) => {
    const b = el(id); if (!b) return;
    b.onclick = async () => resultOrError(await run(cmd, flagsFn()), jsonR, el(out));
  };
  wire('m-rebuild', 'rebuild-index', () => ({ scope: 'all' }), 'm-idx-out');
  wire('m-fix', 'doctor-fix', () => ({ scope: 'all' }), 'm-idx-out');
  wire('m-fold-dry', 'fold-preview', () => ({ scope: el('m-fold-scope').value }), 'm-fold-out');
  wire('m-fold-apply', 'fold-apply', () => ({ scope: el('m-fold-scope').value }), 'm-fold-out');
  wire('m-prune-dry', 'prune-preview', () => ({ scope: el('m-prune-scope').value }), 'm-prune-out');
  wire('m-prune-apply', 'prune-apply', () => ({ scope: el('m-prune-scope').value }), 'm-prune-out');
}

// --- new episode -----------------------------------------------------------------
function buildNew() {
  if (!META.allow_write) {
    el('tab-new').innerHTML = '<div class="panel"><h2>New episode</h2><p class="note">read-only launch — relaunch with <code>--allow-write</code> to store or revise episodes.</p></div>';
    return;
  }
  const catOpts = META.categories.map(c => '<option>' + esc(c) + '</option>').join('');
  el('tab-new').innerHTML =
    '<div class="panel"><h2>Store episode</h2>' +
    '<div class="row"><label class="field">project<input id="n-proj" size="16"></label>' +
    '<label class="field">category<select id="n-cat">' + catOpts + '</select></label>' +
    '<label class="field">scope<select id="n-scope"><option>global</option><option>local</option></select></label>' +
    '<label class="field">tags (comma-sep)<input id="n-tags" size="26"></label>' +
    '<label class="field"><span>pin</span><input type="checkbox" id="n-pin"></label></div>' +
    '<div class="row"><label class="field" style="flex:1">summary<input id="n-sum" style="width:100%"></label></div>' +
    '<label class="field">body<textarea id="n-body"></textarea></label>' +
    '<div class="row"><button class="act" id="n-store">Store</button></div><div id="n-out"></div></div>' +
    '<div class="panel"><h2>Revise episode</h2>' +
    '<div class="row"><label class="field">original id<input id="v-orig" size="52"></label>' +
    '<label class="field">project<input id="v-proj" size="16"></label></div>' +
    '<div class="row"><label class="field" style="flex:1">summary<input id="v-sum" style="width:100%"></label></div>' +
    '<label class="field">body<textarea id="v-body"></textarea></label>' +
    '<div class="row"><button class="act" id="v-run">Revise</button></div><div id="v-out"></div></div>';
  el('n-store').onclick = async () => {
    const flags = { project: el('n-proj').value.trim(), category: el('n-cat').value, summary: el('n-sum').value.trim(), body: el('n-body').value, scope: el('n-scope').value };
    if (el('n-tags').value.trim()) flags.tags = el('n-tags').value.trim();
    if (el('n-pin').checked) flags.pin = true;
    const res = await run('store', flags);
    resultOrError(res, r => '<p>stored: <code>' + esc(r.id || '') + '</code></p>', el('n-out'));
    if (res.http === 200 && res.body.status === 'ok') toast('episode stored');
  };
  el('v-run').onclick = async () => {
    const flags = { original: el('v-orig').value.trim(), project: el('v-proj').value.trim(), summary: el('v-sum').value.trim(), body: el('v-body').value };
    const res = await run('revise', flags);
    resultOrError(res, r => '<p>revised: <code>' + esc(r.id || '') + '</code></p>', el('v-out'));
  };
}

// --- boot ------------------------------------------------------------------------
(async function boot() {
  buildShell();
  const meta = await api('/api/meta');
  if (meta.http !== 200) {
    el('main').innerHTML = '<div class="panel"><p class="err">' + esc(meta.body.message || 'auth failed') + '</p></div>';
    return;
  }
  META = meta.body;
  el('mode').textContent = META.allow_write ? 'WRITE ENABLED' : 'READ-ONLY';
  el('mode').classList.toggle('write', META.allow_write);
  el('cwd').textContent = META.cwd;
  buildDashboard(); buildBrowse(); buildRecall(); buildDrafts(); buildMaintenance(); buildNew();
  show('dashboard');
  el('st-run').click();
  el('dr-run').click();
})();
</script>
</body>
</html>
`
}
