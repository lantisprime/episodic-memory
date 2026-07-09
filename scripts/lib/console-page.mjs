/**
 * console-page.mjs — the single self-contained HTML page em-console serves.
 *
 * Pure presentation (Principle 11): every panel is a thin form over one
 * POST /api/run command; all data shown comes back from the spawned em-*
 * script's JSON, rendered client-side. No external assets (CSP: default-src
 * 'none'), no cookies — the token rides in from ?token=, is moved to JS
 * memory, stripped from the URL, and sent as X-EM-Token on every call.
 *
 * Visual language follows the Structure Lab Console design handoff
 * (~/Developer/projects/design_handoff_structure_lab_console): calm light
 * surface, serif headlines, one dark next-action hero, accent-soft guide
 * banners ("why this page exists"), pill nav in a sticky blurred header,
 * ledger rows with soft badges, 1080px column. Long scrolling is avoided by
 * design: result regions scroll INTERNALLY (capped max-height) and episode
 * detail opens in a right-side drawer instead of stacking panels. Fonts are
 * local-stack only (Newsreader / Hanken Grotesk / IBM Plex Mono when
 * installed, system serif/sans/mono otherwise) — the CSP forbids webfonts.
 */

export function renderPage(nonce = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>em-console</title>
<style nonce="${nonce}">
:root {
  --accent: #0071e3; --accent-soft: #e8f0fd; --accent-dark: #0058b0;
  --bg: #f5f5f7; --card: #ffffff; --line: #e8e8ed; --line-2: #e2e2e7;
  --dark: #1d1d1f; --on-dark: #f5f5f7; --on-dark-muted: #c9c9ce; --on-dark-faint: #a1a1a6;
  --ink: #1d1d1f; --ink-2: #424245; --muted: #6e6e73; --faint: #86868b; --mono-label: #a1a1a6;
  --green: #248a3d; --amber: #b45309; --red: #b91c1c;
  --serif: Newsreader, 'Iowan Old Style', Georgia, 'Times New Roman', serif;
  --sans: 'Hanken Grotesk', -apple-system, 'SF Pro Text', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans); }
button { font: inherit; cursor: pointer; }

/* ---- sticky header ------------------------------------------------------ */
header {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; gap: 14px;
  padding: 13px 24px;
  background: rgba(245,245,247,.82);
  -webkit-backdrop-filter: saturate(160%) blur(16px); backdrop-filter: saturate(160%) blur(16px);
  border-bottom: 1px solid var(--line);
}
.logo { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--ink); }
.logo-mark {
  width: 29px; height: 29px; border-radius: 8px; background: var(--accent);
  display: grid; place-items: center; color: #fff; flex: none;
}
.logo-name { font: 600 17px var(--serif); letter-spacing: -.01em; }
nav.pills { display: flex; gap: 2px; margin-left: 10px; flex-wrap: wrap; }
nav.pills button {
  border: none; background: none; color: var(--ink-2);
  padding: 7px 14px; border-radius: 999px; font-size: 14px;
}
nav.pills button:hover { color: var(--ink); }
nav.pills button.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.hdr-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.mode-pill {
  border: 1px solid var(--line); background: var(--card); border-radius: 999px;
  padding: 7px 16px; font: 500 12px var(--mono); letter-spacing: .05em; color: var(--muted);
}
.mode-pill.write { color: var(--amber); border-color: #f0d9b5; background: #fdf6ec; }
#burger { display: none; border: 1px solid var(--line); background: var(--card);
  border-radius: 999px; padding: 6px 13px; font-size: 15px; }
#mobile-nav {
  display: none; position: absolute; right: 16px; top: 54px; background: var(--card);
  border: 1px solid var(--line); border-radius: 14px; padding: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,.12); min-width: 190px;
}
#mobile-nav button { display: block; width: 100%; text-align: left; border: none; background: none;
  padding: 9px 12px; border-radius: 9px; color: var(--ink-2); font-size: 15px; }
#mobile-nav button.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
@media (max-width: 720px) {
  nav.pills { display: none; }
  #burger { display: block; }
  .mode-pill { padding: 7px 10px; }
}

/* ---- main column --------------------------------------------------------- */
main { max-width: 1080px; margin: 0 auto; padding: 34px 24px 90px; }
section.view { display: none; }
section.view.active { display: block; animation: fadeUp .35s ease; }
@keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

.eyebrow { font: 500 12px var(--mono); text-transform: uppercase; letter-spacing: .08em; color: var(--mono-label); }
h1.hero { font: 500 34px/1.12 var(--serif); letter-spacing: -.02em; margin: 8px 0 22px; }
h1.view-title { font: 500 32px/1.12 var(--serif); letter-spacing: -.02em; margin: 18px 0 16px; }
h2.card-title { font: 500 18px var(--serif); margin: 0 0 6px; }

/* ---- guide banner -------------------------------------------------------- */
.guide {
  display: flex; gap: 14px; align-items: flex-start;
  background: var(--accent-soft); border-radius: 16px; padding: 18px 22px; margin-bottom: 8px;
}
.guide .glyph { font: 600 20px var(--serif); color: var(--accent); font-style: italic; line-height: 1.2; }
.guide .g-title { color: var(--accent); font-weight: 700; font-size: 14px; margin-bottom: 2px; }
.guide .g-body { color: var(--ink-2); font-size: 14px; }
.guide .g-act { margin-top: 10px; }

/* ---- cards, tiles, hero --------------------------------------------------- */
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
.hero-card {
  background: var(--dark); color: var(--on-dark); border-radius: 20px; padding: 26px 28px;
  display: flex; align-items: center; gap: 22px; flex-wrap: wrap;
  box-shadow: 0 12px 40px rgba(0,0,0,.12); margin-bottom: 10px;
}
.hero-card .txt { flex: 1; min-width: 260px; }
.hero-card .eyebrow { color: var(--on-dark-faint); }
.hero-card .h-title { font: 500 24px/1.2 var(--serif); margin: 6px 0; }
.hero-card .h-detail { color: var(--on-dark-muted); font-size: 14px; }
.hero-note { text-align: center; color: var(--faint); font-size: 13px; margin: 0 0 22px; }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px; }
.tile { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
.tile .v { font: 500 27px var(--mono); }
.tile .v.good { color: var(--green); }
.tile .v.warn { color: var(--amber); }
.tile .v.bad { color: var(--red); }
.tile .k { color: var(--faint); font-size: 13px; margin-top: 4px; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 960px) { .tiles, .grid-2 { grid-template-columns: 1fr; } }

/* ---- buttons, inputs, chips ----------------------------------------------- */
.btn {
  background: var(--accent); color: #fff; border: none; border-radius: 12px;
  padding: 11px 22px; font-weight: 600; font-size: 14px;
}
.btn:hover { background: var(--accent-dark); }
.btn.secondary { background: var(--card); color: var(--ink); border: 1px solid var(--line-2); }
.btn.secondary:hover { background: var(--bg); }
.btn.sm { padding: 8px 16px; border-radius: 10px; font-size: 13px; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
label.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
input, select, textarea {
  font: 14px var(--sans); color: var(--ink); background: var(--card);
  border: 1px solid var(--line-2); border-radius: 11px; padding: 9px 12px;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
textarea { width: 100%; min-height: 96px; resize: vertical; }
.mono { font-family: var(--mono); }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
.chips span {
  display: inline-block; background: var(--bg); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 10px; font: 12px var(--mono); margin: 2px 4px 2px 0; color: var(--muted);
}

/* ---- ledger rows ----------------------------------------------------------- */
.ledger { background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
.scroll-area { max-height: 46vh; overflow-y: auto; }
.lrow {
  display: flex; gap: 18px; align-items: center; padding: 14px 20px;
  border-bottom: 1px solid var(--line); cursor: pointer;
}
.lrow:last-child { border-bottom: none; }
.lrow:hover { background: #fafafc; }
.lrow .lid { min-width: 200px; flex: none; }
.lrow .lid .id { font: 600 13px var(--mono); word-break: break-all; }
.lrow .lid .dt { font: 12px var(--mono); color: var(--faint); margin-top: 2px; }
.lrow .lsum { flex: 1; font-size: 14px; color: var(--ink-2); }
.badge {
  flex: none; border-radius: 999px; padding: 3px 11px; font: 600 12px var(--mono);
  background: var(--accent-soft); color: var(--accent-dark);
}
.badge.lesson { background: #e6f4ea; color: var(--green); }
.badge.violation, .badge.error { background: #fdebeb; color: var(--red); }
.badge.temporary, .badge.warn { background: #fdf3e0; color: var(--amber); }
.badge.neutral { background: var(--bg); color: var(--muted); }
.empty { padding: 26px 20px; color: var(--faint); font-size: 14px; }
@media (max-width: 720px) { .lrow { flex-wrap: wrap; } .lrow .lid { min-width: 0; } }

/* ---- output wells / raw JSON ------------------------------------------------ */
pre {
  background: var(--bg); border: 1px solid var(--line); border-radius: 11px;
  padding: 12px 14px; font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word;
  max-height: 34vh; overflow-y: auto; margin: 10px 0 0;
}
details.raw { margin-top: 10px; }
details.raw summary { color: var(--faint); font-size: 12px; cursor: pointer; }
.out { margin-top: 12px; }
.err-line { color: var(--red); font-size: 14px; margin: 10px 0 0; }
.note { color: var(--faint); font-size: 13px; }

/* ---- doctor table ------------------------------------------------------------ */
table.checks { border-collapse: collapse; width: 100%; font-size: 13px; }
table.checks td, table.checks th { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
table.checks th { color: var(--faint); font-weight: 500; font-size: 12px; }
.lvl-ok { color: var(--green); } .lvl-warn { color: var(--amber); } .lvl-error, .lvl-issues { color: var(--red); }

/* ---- detail drawer ------------------------------------------------------------ */
#overlay { position: fixed; inset: 0; background: rgba(0,0,0,.25); z-index: 60; display: none; }
#drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 94vw); z-index: 70;
  background: var(--card); border-left: 1px solid var(--line);
  box-shadow: -18px 0 48px rgba(0,0,0,.14);
  transform: translateX(102%); transition: transform .28s ease;
  display: flex; flex-direction: column;
}
#drawer.open { transform: none; }
#drawer .d-head {
  display: flex; align-items: center; gap: 12px; padding: 16px 20px;
  border-bottom: 1px solid var(--line); flex: none;
}
#drawer .d-head .t { font: 500 18px var(--serif); flex: 1; }
#drawer .d-body { overflow-y: auto; padding: 16px 20px; }
.d-ep { border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin-bottom: 12px; }
.d-ep .id { font: 600 12px var(--mono); word-break: break-all; }
.d-ep .sum { font-size: 14px; color: var(--ink-2); margin: 6px 0; }
.x-btn { border: 1px solid var(--line); background: var(--card); border-radius: 999px;
  width: 30px; height: 30px; font-size: 14px; color: var(--muted); }

/* ---- humanized output ------------------------------------------------------------ */
.count-line { font-size: 15px; color: var(--ink-2); margin: 12px 0 0; }
.count-line .n { font: 600 17px var(--mono); color: var(--ink); }
table.kv { border-collapse: collapse; width: 100%; font-size: 13px; margin-top: 10px; }
table.kv td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
table.kv td.k { color: var(--muted); font: 12px var(--mono); white-space: nowrap; width: 1%; padding-right: 18px; }
table.kv tr:last-child td { border-bottom: none; }
.sub-card { border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin-top: 10px; }
.sub-card .id { font: 600 12px var(--mono); word-break: break-all; cursor: pointer; color: var(--accent-dark); }
.stat-line { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 10px; }
.stat-line .s { min-width: 90px; }
.stat-line .s .v { font: 500 20px var(--mono); }
.stat-line .s .k { color: var(--faint); font-size: 12px; }
details.more { margin-top: 8px; }
details.more summary { color: var(--accent-dark); font-size: 13px; cursor: pointer; }
.idlist { margin: 8px 0 0; padding: 0; list-style: none; }
.idlist li { font: 12px var(--mono); color: var(--muted); padding: 3px 0; word-break: break-all; }

/* ---- mini markdown ----------------------------------------------------------------- */
.md { font-size: 14px; color: var(--ink-2); line-height: 1.6; }
.md h1, .md h2, .md h3 { font: 500 17px var(--serif); color: var(--ink); margin: 14px 0 6px; }
.md h1 { font-size: 19px; } .md h3 { font-size: 15px; }
.md p { margin: 8px 0; }
.md ul, .md ol { margin: 8px 0; padding-left: 22px; }
.md li { margin: 3px 0; }
.md code { font: 12px var(--mono); background: var(--bg); border: 1px solid var(--line);
  border-radius: 5px; padding: 1px 5px; }
.md pre { margin: 10px 0; }
.md pre code { background: none; border: none; padding: 0; }
.md hr { border: none; border-top: 1px solid var(--line); margin: 14px 0; }
.md table { border-collapse: collapse; font-size: 13px; margin: 10px 0; display: block; overflow-x: auto; }
.md th, .md td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; }
.md th { color: var(--muted); font-weight: 600; background: var(--bg); }
.md a { color: var(--accent-dark); }
.md strong { color: var(--ink); }

/* ---- toast --------------------------------------------------------------------- */
#toast {
  position: fixed; bottom: 18px; right: 18px; z-index: 90; display: none;
  background: var(--dark); color: var(--on-dark); border-radius: 12px; padding: 12px 18px;
  font-size: 14px; box-shadow: 0 12px 32px rgba(0,0,0,.24); max-width: 380px;
}

/* ---- utility classes (folded from former inline style= attrs, #494) --------
   Appended last so a single-class utility wins ties over earlier single-class
   rules (e.g. .fs-12 over .note's font-size). Each reproduces one former
   inline declaration verbatim to preserve rendered appearance exactly. */
.m-4-0-0 { margin: 4px 0 0; }
.m-8-0-0 { margin: 8px 0 0; }
.m-6-0-0 { margin: 6px 0 0; }
.m-4-0-2 { margin: 4px 0 2px; }
.m-6-0-2 { margin: 6px 0 2px; }
.m-8-2-0 { margin: 8px 2px 0; }
.m-0-0-12 { margin: 0 0 12px; }
.m-0 { margin: 0; }
.mt-4 { margin-top: 4px; }
.mt-6 { margin-top: 6px; }
.mt-8 { margin-top: 8px; }
.mt-10 { margin-top: 10px; }
.mb-8 { margin-bottom: 8px; }
.mb-12 { margin-bottom: 12px; }
.fs-12 { font-size: 12px; }
.fs-12-wb { font-size: 12px; word-break: break-all; }
.fs-13-b { font-size: 13px; font-weight: 600; }
.fs-13-b-wb { font-size: 13px; font-weight: 600; word-break: break-all; }
.sc-30 { max-height: 30vh; overflow-y: auto; }
.sc-22 { max-height: 22vh; overflow-y: auto; }
.flex-1 { flex: 1; }
.w-100 { width: 100%; }
</style>
</head>
<body>
<header>
  <a class="logo" href="#" id="logo-home">
    <span class="logo-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1 8h2l2-5 3 10 2.5-7 1.5 2h3" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span class="logo-name">Memory Console</span>
  </a>
  <nav class="pills" id="nav"></nav>
  <div class="hdr-right">
    <span class="mode-pill" id="mode">…</span>
    <button id="burger" aria-label="menu">☰</button>
  </div>
  <div id="mobile-nav"></div>
</header>
<main id="main"></main>
<div id="overlay"></div>
<aside id="drawer" aria-label="episode detail">
  <div class="d-head"><span class="t" id="d-title">Episode</span><button class="x-btn" id="d-close">✕</button></div>
  <div class="d-body" id="d-body"></div>
</aside>
<div id="toast"></div>
<script nonce="${nonce}">
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
function toast(msg) {
  const t = el('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 3600);
}
function raw(obj) { return '<details class="raw"><summary>raw JSON</summary><pre>' + esc(JSON.stringify(obj, null, 2)) + '</pre></details>'; }
function resultOrError(res, renderFn, target) {
  if (res.http !== 200 || res.body.status !== 'ok') {
    target.innerHTML = '<p class="err-line">' + esc(res.body.message || ('HTTP ' + res.http)) + '</p>' + raw(res.body);
    return null;
  }
  target.innerHTML = renderFn(res.body.result) + raw(res.body);
  return res.body.result;
}
function catBadge(category) {
  const c = String(category || '');
  const cls = c === 'lesson' ? 'lesson' : c === 'violation' ? 'violation' : c === 'temporary' ? 'temporary' : '';
  return '<span class="badge ' + cls + '">' + esc(c || '—') + '</span>';
}

// --- mini markdown (escape-first: the WHOLE source is HTML-escaped before any
// transform runs, so user < > are entities by construction and only this
// renderer emits tags; hrefs are scheme-allowlisted to http/https) -----------
function miniMd(src) {
  const escaped = esc(src);
  // Extract fenced code blocks first so no other transform fires inside them.
  const fences = [];
  let text = escaped.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, (m, code) => {
    fences.push('<pre><code>' + code + '</code></pre>');
    return '\\u0000F' + (fences.length - 1) + '\\u0000';
  });
  const inline = (s) => s
    .replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const lines = text.split('\\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let tableBuf = [];
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map(l => l.replace(/^\\||\\|$/g, '').split('|').map(c => c.trim()));
    tableBuf = [];
    const isSep = rows.length > 1 && rows[1].every(c => /^:?-{2,}:?$/.test(c));
    let html = '<table>';
    rows.forEach((cells, i) => {
      if (isSep && i === 1) return;
      const tag = isSep && i === 0 ? 'th' : 'td';
      html += '<tr>' + cells.map(c => '<' + tag + '>' + inline(c) + '</' + tag + '>').join('') + '</tr>';
    });
    out.push(html + '</table>');
  };
  for (const lineRaw of lines) {
    const line = lineRaw;
    const fence = line.match(/^\\u0000F(\\d+)\\u0000$/);
    if (fence) { closeList(); flushTable(); out.push(fences[+fence[1]]); continue; }
    if (/^\\s*\\|.*\\|\\s*$/.test(line)) { closeList(); tableBuf.push(line.trim()); continue; }
    flushTable();
    const h = line.match(/^(#{1,3})\\s+(.*)$/);
    if (h) { closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
    if (/^\\s*(---+|\\*\\*\\*+)\\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const ul = line.match(/^\\s*[-*]\\s+(.*)$/);
    const ol = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>');
      continue;
    }
    closeList();
    if (line.trim() === '') continue;
    out.push('<p>' + inline(line) + '</p>');
  }
  closeList(); flushTable();
  return '<div class="md">' + out.join('') + '</div>';
}

// --- generic JSON humanizer (fallback for shapes without a typed renderer) ---
function autoRender(v, depth = 0) {
  if (v === null || v === undefined) return '<span class="note">—</span>';
  if (typeof v !== 'object') return esc(String(v));
  if (depth > 3) return '<span class="note">…</span>';
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="note">none</span>';
    if (v.every(x => typeof x !== 'object' || x === null)) {
      return '<p class="chips m-4-0-0">' + v.slice(0, 60).map(x => '<span>' + esc(String(x)) + '</span>').join('') +
        (v.length > 60 ? '<span>+' + (v.length - 60) + ' more</span>' : '') + '</p>';
    }
    return v.slice(0, 30).map(x => '<div class="sub-card">' + autoRender(x, depth + 1) + '</div>').join('') +
      (v.length > 30 ? '<p class="note">+' + (v.length - 30) + ' more — see raw JSON</p>' : '');
  }
  const entries = Object.entries(v);
  if (!entries.length) return '<span class="note">empty</span>';
  // Same cap discipline as the array branches: a huge object (transcript-derived
  // draft payloads) must not fan out unbounded table rows.
  const shown = entries.slice(0, 40);
  return '<table class="kv">' + shown.map(([k, val]) =>
    '<tr><td class="k">' + esc(k) + '</td><td>' + autoRender(val, depth + 1) + '</td></tr>').join('') + '</table>' +
    (entries.length > 40 ? '<p class="note">+' + (entries.length - 40) + ' more keys — see raw JSON</p>' : '');
}

// --- typed renderers: known command shapes -> calm human output --------------
function countLine(n, noun, tail) {
  return '<p class="count-line"><span class="n">' + esc(String(n)) + '</span> ' + esc(noun + (tail ? ' ' + tail : '')) + '</p>';
}
function epId(id) { return '<span class="id" data-ep-id="' + esc(id) + '" title="open revision chain">' + esc(id) + '</span>'; }
function idList(ids, label) {
  if (!ids || !ids.length) return '';
  return '<details class="more"><summary>' + esc(label + ' (' + ids.length + ')') + '</summary><ul class="idlist">' +
    ids.map(i => '<li>' + epId(i) + '</li>').join('') + '</ul></details>';
}
function renderDoctorReport(r) {
  const sum = r.summary || {};
  const bad = (r.checks || []).filter(c => c.level !== 'ok');
  let html = '<div class="stat-line">' +
    '<div class="s"><div class="v lvl-' + esc(r.status) + '">' + esc(r.status) + '</div><div class="k">verdict</div></div>' +
    '<div class="s"><div class="v lvl-ok">' + esc(sum.ok ?? '—') + '</div><div class="k">ok</div></div>' +
    '<div class="s"><div class="v lvl-warn">' + esc(sum.warn ?? '—') + '</div><div class="k">warn</div></div>' +
    '<div class="s"><div class="v lvl-error">' + esc(sum.error ?? '—') + '</div><div class="k">error</div></div></div>';
  if (bad.length) {
    html += '<div class="sc-30"><table class="checks"><tr><th>level</th><th>check</th><th>message</th></tr>' +
      bad.map(c => '<tr><td class="lvl-' + esc(c.level) + '">' + esc(c.level) + '</td><td class="mono fs-12">' + esc(c.id) + (c.scope && c.scope !== '-' ? ':' + esc(c.scope) : '') + '</td><td>' + esc(c.message) + '</td></tr>').join('') + '</table></div>';
  } else {
    html += '<p class="note mt-8">Every check passes.</p>';
  }
  return html;
}
function renderStatsReport(r) {
  return (r.scopes || []).map(s => {
    const ep = s.episodes || {};
    const cats = Object.entries(s.by_category || {}).sort((a, b) => b[1] - a[1]);
    return '<div class="sub-card"><div class="mono fs-13-b">' + esc(s.scope || '') + '</div>' +
      (s.dir ? '<div class="note fs-12-wb">' + esc(s.dir) + '</div>' : '') +
      '<div class="stat-line">' +
      '<div class="s"><div class="v">' + esc(ep.active ?? '—') + '</div><div class="k">active</div></div>' +
      '<div class="s"><div class="v">' + esc(ep.superseded ?? '—') + '</div><div class="k">superseded</div></div>' +
      '<div class="s"><div class="v">' + esc(ep.pinned ?? '—') + '</div><div class="k">pinned</div></div>' +
      '<div class="s"><div class="v">' + esc(s.prunable_estimate ?? '—') + '</div><div class="k">prunable est.</div></div>' +
      '</div>' +
      (cats.length ? '<p class="chips m-8-0-0">' + cats.map(([k, c]) => '<span>' + esc(k) + ' ' + esc(c) + '</span>').join('') + '</p>' : '') +
      '</div>';
  }).join('') || '<p class="note">no scopes reported</p>';
}
function renderFold(r) {
  const chains = r.chains || [];
  const verb = r.dry_run ? 'would fold' : 'folded';
  let html = countLine(r.folded_total ?? 0, 'revision' + ((r.folded_total ?? 0) === 1 ? '' : 's'), verb + ' across ' + chains.length + ' chain' + (chains.length === 1 ? '' : 's') + (r.scope ? ' in the ' + r.scope + ' store' : ''));
  if (r.dry_run && chains.length) html += '<p class="note mt-4">This is a preview — nothing was written. Terminals are always kept.</p>';
  html += chains.slice(0, 12).map(c =>
    '<div class="sub-card"><div class="note fs-12">chain of ' + esc(c.chain_length) + ' · keeps terminal</div>' +
    '<div class="m-4-0-2">' + epId(c.terminal) + '</div>' +
    idList(c.folded, (r.dry_run ? 'members that would fold' : 'folded members')) + '</div>').join('');
  if (chains.length > 12) html += '<p class="note">+' + (chains.length - 12) + ' more chains — see raw JSON</p>';
  return html;
}
function renderPrune(r) {
  const results = r.results || [];
  return results.map(s =>
    '<div class="sub-card"><div class="mono fs-13-b">' + esc(s.scope || '') + '</div>' +
    '<div class="stat-line">' +
    '<div class="s"><div class="v">' + esc(s.prunable ?? s.archived ?? 0) + '</div><div class="k">' + (r.dry_run === false || s.archived !== undefined ? 'archived' : 'prunable') + '</div></div>' +
    '<div class="s"><div class="v">' + esc(s.remaining ?? '—') + '</div><div class="k">remaining</div></div>' +
    '<div class="s"><div class="v">' + esc(s.protected ?? 0) + '</div><div class="k">protected</div></div>' +
    '</div>' +
    idList((s.episodes || []).map(e => typeof e === 'string' ? e : e.id).filter(Boolean), 'episodes affected') +
    idList(s.protected_episodes || [], 'protected (never archived)') +
    '</div>').join('') || '<p class="note">nothing to report</p>';
}
function renderRebuild(r) {
  return (r.rebuilt || []).map(s => {
    const drift = s.category_drift || {};
    const unknown = Object.keys(drift.unknown || {}).length;
    const deprecated = Object.keys(drift.deprecated || {}).length;
    return '<div class="sub-card"><div class="mono fs-13-b">' + esc(s.scope || '') + '</div>' +
      countLine(s.count ?? 0, 'episode' + ((s.count ?? 0) === 1 ? '' : 's'), 'reindexed') +
      (unknown || deprecated ? '<p class="note">category drift: ' + unknown + ' unknown · ' + deprecated + ' deprecated</p>'
        : '<p class="note">no category drift</p>') + '</div>';
  }).join('') || '<p class="note">nothing rebuilt</p>';
}
function renderDrafts(r) {
  const drafts = r.drafts || [];
  if (!drafts.length) return '<div class="ledger"><p class="empty">No pending drafts — sessions with auto-capture enabled will queue candidates here.</p></div>';
  return countLine(drafts.length, 'draft' + (drafts.length === 1 ? '' : 's'), 'waiting for review') +
    drafts.map(d =>
      '<div class="sub-card"><div class="mono fs-13-b-wb">' + esc(d.id || '') + '</div>' +
      '<div class="note fs-12">' + esc(d.project || '') + (d.session_id ? ' · session ' + esc(String(d.session_id).slice(0, 12)) : '') + (d.ts ? ' · ' + esc(d.ts) : '') + '</div>' +
      '<div class="stat-line">' +
      '<div class="s"><div class="v lvl-warn">' + esc(d.pending ?? 0) + '</div><div class="k">pending</div></div>' +
      '<div class="s"><div class="v lvl-ok">' + esc(d.accepted ?? 0) + '</div><div class="k">accepted</div></div>' +
      '<div class="s"><div class="v">' + esc(d.rejected ?? 0) + '</div><div class="k">rejected</div></div>' +
      '</div>' +
      ((d.summaries || []).length ? '<ul class="idlist">' + d.summaries.map(s => '<li>' + esc(s) + '</li>').join('') + '</ul>' : '') +
      (d.id ? '<p class="note mt-8">Review: <span class="mono">em capture review --draft ' + esc(d.id) + '</span></p>' : '') +
      '</div>').join('');
}
function renderRecall(r) {
  let extras = '';
  if (r.pending_drafts > 0) extras += '<p class="count-line"><span class="n">' + esc(r.pending_drafts) + '</span> capture draft(s) pending — see the Drafts tab.</p>';
  for (const w of r.preflight_warnings || []) {
    extras += '<p class="note mt-6"><span class="lvl-warn">warning</span> ' + esc(typeof w === 'string' ? w : (w.message || JSON.stringify(w))) + '</p>';
  }
  if (r.prune_suggestion) extras += '<p class="note mt-6">prune suggestion: ' + esc(typeof r.prune_suggestion === 'string' ? r.prune_suggestion : JSON.stringify(r.prune_suggestion)) + '</p>';
  return renderEpisodes(r) + extras;
}
const HUMANIZE = {
  doctor: renderDoctorReport,
  'doctor-fix': renderDoctorReport,
  stats: renderStatsReport,
  'fold-preview': renderFold,
  'fold-apply': renderFold,
  'prune-preview': renderPrune,
  'prune-apply': renderPrune,
  'rebuild-index': renderRebuild,
  'capture-list': renderDrafts,
};
function humanize(cmd, result) {
  if (!result || typeof result !== 'object') return autoRender(result);
  const typed = HUMANIZE[cmd];
  try { return typed ? typed(result) : autoRender(result); } catch { return autoRender(result); }
}

// --- shell -------------------------------------------------------------------
let META = { allow_write: false, categories: [], cwd: '' };
const TABS = [
  ['overview', 'Overview'], ['browse', 'Browse'], ['recall', 'Recall'],
  ['drafts', 'Drafts'], ['maintenance', 'Maintenance'], ['new', 'New episode'],
];
function show(tabId) {
  document.querySelectorAll('section.view').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tabId));
  document.querySelectorAll('nav.pills button, #mobile-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  el('mobile-nav').style.display = 'none';
  el('burger').textContent = '☰';
}
function buildShell() {
  const btns = TABS.map(([id, label]) => '<button data-tab="' + id + '">' + label + '</button>').join('');
  el('nav').innerHTML = btns;
  el('mobile-nav').innerHTML = btns;
  document.querySelectorAll('nav.pills button, #mobile-nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
  el('burger').onclick = () => {
    const m = el('mobile-nav');
    const open = m.style.display === 'block';
    m.style.display = open ? 'none' : 'block';
    el('burger').textContent = open ? '☰' : '✕';
  };
  el('logo-home').onclick = (e) => { e.preventDefault(); show('overview'); };
  el('main').innerHTML = TABS.map(([id]) => '<section class="view" id="tab-' + id + '"></section>').join('');
}
function guide(title, body, actHtml) {
  return '<div class="guide"><span class="glyph">ƒ</span><div>' +
    '<div class="g-title">' + esc(title) + '</div>' +
    '<div class="g-body">' + esc(body) + '</div>' +
    (actHtml ? '<div class="g-act">' + actHtml + '</div>' : '') +
    '</div></div>';
}

// --- drawer --------------------------------------------------------------------
function openDrawer(title) {
  el('d-title').textContent = title;
  el('d-body').innerHTML = '<p class="note">loading…</p>';
  el('overlay').style.display = 'block';
  el('drawer').classList.add('open');
}
function closeDrawer() { el('overlay').style.display = 'none'; el('drawer').classList.remove('open'); }
el('overlay').onclick = closeDrawer;
el('d-close').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
async function showEpisode(id) {
  openDrawer('Revision chain');
  const res = await run('history', { history: id });
  if (res.http !== 200 || res.body.status !== 'ok') {
    el('d-body').innerHTML = '<p class="err-line">' + esc(res.body.message || 'failed') + '</p>' + raw(res.body);
    return;
  }
  // em-search --history returns the members under result.chain (oldest first).
  const eps = res.body.result.chain || res.body.result.episodes || [];
  el('d-title').textContent = 'Revision chain · ' + eps.length + ' member' + (eps.length === 1 ? '' : 's');
  el('d-body').innerHTML = (eps.length ? eps.map(e =>
    '<div class="d-ep">' +
    '<div class="id">' + esc(e.id) + '</div>' +
    '<div class="m-6-0-2">' + catBadge(e.category) + (e.status ? ' <span class="badge neutral">' + esc(e.status) + '</span>' : '') + '</div>' +
    '<div class="sum">' + esc(e.summary) + '</div>' +
    (e.tags && e.tags.length ? '<p class="chips m-6-0-0">' + e.tags.map(t => '<span>' + esc(t) + '</span>').join('') + '</p>' : '') +
    (e.body ? miniMd(e.body) : '') +
    '</div>').join('') : '<p class="empty">no chain found</p>') + raw(res.body);
}
document.addEventListener('click', (ev) => {
  const row = ev.target.closest && ev.target.closest('[data-ep-id]');
  if (row) showEpisode(row.dataset.epId);
});

// --- shared episode ledger renderer ----------------------------------------------
function renderEpisodes(r) {
  const eps = r.episodes || [];
  if (!eps.length) return '<div class="ledger"><p class="empty">No episodes matched.</p></div>';
  return '<div class="ledger"><div class="scroll-area">' + eps.map(e =>
    '<div class="lrow" data-ep-id="' + esc(e.id) + '">' +
    '<div class="lid"><div class="id">' + esc(String(e.id).slice(0, 22)) + '…</div><div class="dt">' + esc(e.date || '') + (e.project ? ' · ' + esc(e.project) : '') + '</div></div>' +
    '<div class="lsum">' + esc(e.summary) + '</div>' +
    catBadge(e.category) +
    '</div>').join('') + '</div></div>' +
    '<p class="note m-8-2-0">' + eps.length + ' shown — tap a row for its full revision chain.</p>';
}

// --- overview ----------------------------------------------------------------------
function fmtDate() {
  const d = new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
}
function buildOverview() {
  el('tab-overview').innerHTML =
    '<div class="eyebrow">' + esc(fmtDate()) + '</div>' +
    '<h1 class="hero" id="ov-greeting">Reading your memory…</h1>' +
    '<div id="ov-hero"></div>' +
    '<p class="hero-note">When you\\u2019re unsure what to do, come back here — this card always shows the single next step.</p>' +
    '<div class="tiles" id="ov-tiles"></div>' +
    '<div class="grid-2">' +
    '<div class="card"><h2 class="card-title">What memory holds</h2><div id="ov-cats" class="note">…</div></div>' +
    '<div class="card"><h2 class="card-title">Health</h2><div id="ov-doctor" class="note">…</div></div>' +
    '</div>';
  refreshOverview();
}
async function refreshOverview() {
  const [statsRes, doctorRes, draftsRes] = await Promise.all([
    run('stats', { scope: 'all' }), run('doctor', { scope: 'all' }), run('capture-list', {}),
  ]);
  const stats = statsRes.body.status === 'ok' ? statsRes.body.result : null;
  const doctor = doctorRes.body.status === 'ok' ? doctorRes.body.result : null;
  const draftsRaw = draftsRes.body.status === 'ok' ? draftsRes.body.result : null;
  const drafts = draftsRaw && Array.isArray(draftsRaw.drafts)
    ? draftsRaw.drafts.filter(d => (d.pending || 0) > 0).length : 0;

  const scopes = (stats && stats.scopes) || [];
  const totalActive = scopes.reduce((n, s) => n + ((s.episodes && s.episodes.active) || 0), 0);
  const supersededTotal = scopes.reduce((n, s) => n + ((s.episodes && s.episodes.superseded) || 0), 0);
  const sum = (doctor && doctor.summary) || {};
  const bad = (doctor && doctor.checks || []).filter(c => c.level !== 'ok');

  // The single next action, derived transparently from what the scripts said:
  // errors -> fix; drafts -> review; superseded pile -> fold; else calm.
  let hero;
  if (sum.error > 0) {
    hero = { eyebrow: 'RIGHT NOW, YOUR MEMORY NEEDS ONE THING', title: 'Repair the store',
      detail: sum.error + ' health check(s) failing. Doctor can fix most of this automatically.',
      cta: 'Review & fix →', tab: 'maintenance' };
  } else if (drafts > 0) {
    hero = { eyebrow: 'RIGHT NOW, YOUR MEMORY NEEDS ONE THING', title: 'Review ' + drafts + ' captured draft' + (drafts > 1 ? 's' : ''),
      detail: 'Sessions drafted candidate episodes that are waiting on your confirmation. Nothing is stored until you accept.',
      cta: 'Review drafts →', tab: 'drafts' };
  } else if (supersededTotal >= 20) {
    hero = { eyebrow: 'RIGHT NOW, YOUR MEMORY NEEDS ONE THING', title: 'Fold ' + supersededTotal + ' superseded revisions',
      detail: 'Long revision chains are cluttering search. Folding archives the old members — reversible, terminals untouched.',
      cta: 'Preview the fold →', tab: 'maintenance' };
  } else {
    hero = { eyebrow: 'NOTHING IS WAITING ON YOU', title: 'Everything is calm',
      detail: 'Stores are healthy and nothing needs review. Browse what memory knows, or store something worth remembering.',
      cta: 'Browse memory →', tab: 'browse' };
  }
  el('ov-greeting').textContent =
    sum.error > 0 ? 'One thing needs your attention. The rest is calm.'
    : drafts > 0 ? 'A few drafts are waiting for you. Everything else is calm.'
    : 'Your memory is healthy. ' + totalActive.toLocaleString() + ' episodes and counting.';
  el('ov-hero').innerHTML =
    '<div class="hero-card"><div class="txt">' +
    '<div class="eyebrow">' + esc(hero.eyebrow) + '</div>' +
    '<div class="h-title">' + esc(hero.title) + '</div>' +
    '<div class="h-detail">' + esc(hero.detail) + '</div>' +
    '</div><button class="btn" id="ov-cta">' + esc(hero.cta) + '</button></div>';
  el('ov-cta').onclick = () => show(hero.tab);

  const local = scopes.find(s => s.scope === 'local');
  const global = scopes.find(s => s.scope === 'global');
  const dStatus = doctor ? doctor.status : '?';
  el('ov-tiles').innerHTML =
    '<div class="tile"><div class="v">' + esc(local && local.episodes ? local.episodes.active : '—') + '</div><div class="k">active episodes in this project</div></div>' +
    '<div class="tile"><div class="v">' + esc(global && global.episodes ? global.episodes.active : '—') + '</div><div class="k">active episodes shared globally</div></div>' +
    '<div class="tile"><div class="v ' + (dStatus === 'ok' ? 'good' : sum.error > 0 ? 'bad' : 'warn') + '">' + esc(dStatus) + '</div><div class="k">doctor verdict (' + esc(sum.ok ?? '—') + ' ok · ' + esc(sum.warn ?? '—') + ' warn · ' + esc(sum.error ?? '—') + ' error)</div></div>';

  const cats = {};
  for (const s of scopes) for (const [k, v] of Object.entries(s.by_category || {})) cats[k] = (cats[k] || 0) + v;
  const catList = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  el('ov-cats').innerHTML = catList.length
    ? '<p class="chips m-4-0-0">' + catList.map(([k, v]) => '<span>' + esc(k) + ' ' + esc(v) + '</span>').join('') + '</p>'
    : 'nothing stored yet';
  el('ov-doctor').innerHTML = bad.length
    ? '<div class="sc-22"><table class="checks"><tr><th>level</th><th>check</th><th>message</th></tr>' +
      bad.map(c => '<tr><td class="lvl-' + esc(c.level) + '">' + esc(c.level) + '</td><td class="mono fs-12">' + esc(c.id) + '</td><td>' + esc(c.message) + '</td></tr>').join('') + '</table></div>'
    : '<span class="lvl-ok">All ' + esc(sum.ok ?? '') + ' checks pass.</span>';
}

// --- browse -----------------------------------------------------------------------
function buildBrowse() {
  el('tab-browse').innerHTML =
    guide('Why this page exists', 'Everything your assistant remembered, searchable. Tap any row for its full revision chain — detail opens beside the list, so you never lose your place.') +
    '<h1 class="view-title">Browse</h1>' +
    '<div class="card mb-12"><div class="row">' +
    '<label class="field">query<input id="q-query" size="22"></label>' +
    '<label class="field">tag<input id="q-tag" size="12"></label>' +
    '<label class="field">category<input id="q-cat" size="11" list="cats"></label>' +
    '<label class="field">project<input id="q-proj" size="12"></label>' +
    '<label class="field">scope<select id="q-scope"><option>all</option><option>local</option><option>global</option></select></label>' +
    '<label class="field">limit<input id="q-limit" size="4" value="20"></label>' +
    '<button class="btn sm" id="q-run">Search</button>' +
    '<button class="btn sm secondary" id="q-list">List recent</button>' +
    '</div><datalist id="cats">' + META.categories.map(c => '<option>' + esc(c) + '</option>').join('') + '</datalist></div>' +
    '<div id="q-out"><div class="ledger"><p class="empty">Search, or list the most recent episodes.</p></div></div>';
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
}

// --- recall -----------------------------------------------------------------------
function buildRecall() {
  el('tab-recall').innerHTML =
    guide('Why this page exists', 'A preview of exactly what your assistant is told at session start — the episodes recall would surface for a project right now.') +
    '<h1 class="view-title">Recall</h1>' +
    '<div class="card mb-12"><div class="row">' +
    '<label class="field">project<input id="rc-proj" size="18"></label>' +
    '<label class="field">task type<select id="rc-task"><option value="">(default)</option><option>implementation</option><option>push</option><option>rule</option><option>general</option></select></label>' +
    '<button class="btn sm" id="rc-run">Preview recall</button>' +
    '</div></div><div id="rc-out"></div>';
  el('rc-run').onclick = async () => {
    const flags = {};
    if (el('rc-proj').value.trim()) flags.project = el('rc-proj').value.trim();
    if (el('rc-task').value) flags['task-type'] = el('rc-task').value;
    resultOrError(await run('recall', flags), renderRecall, el('rc-out'));
  };
}

// --- drafts ------------------------------------------------------------------------
function buildDrafts() {
  el('tab-drafts').innerHTML =
    guide('Why this page exists', 'Sessions can draft candidate episodes automatically, but nothing is stored without your confirmation. Confirm or discard from the CLI: em capture review --draft <id>.') +
    '<h1 class="view-title">Drafts</h1>' +
    '<div class="row mb-12"><button class="btn sm secondary" id="cp-run">Refresh</button></div>' +
    '<div id="cp-out"></div>';
  el('cp-run').onclick = async () => {
    resultOrError(await run('capture-list', {}), r => humanize('capture-list', r), el('cp-out'));
  };
  el('cp-run').click();
}

// --- maintenance --------------------------------------------------------------------
function writeBtn(id, label) {
  return META.allow_write
    ? '<button class="btn sm" id="' + id + '">' + label + '</button>'
    : '<button class="btn sm" disabled title="relaunch with --allow-write">' + label + '</button>';
}
function buildMaintenance() {
  const ro = META.allow_write ? '' :
    '<p class="note m-0-0-12">Read-only launch — previews work; fix/apply buttons need a relaunch with <span class="mono">--allow-write</span>.</p>';
  el('tab-maintenance').innerHTML =
    guide('Why this page exists', 'Store hygiene without memorizing flags. Every destructive-looking action previews first; nothing applies without the preview in front of you.') +
    '<h1 class="view-title">Maintenance</h1>' + ro +
    '<div class="grid-2">' +
    '<div class="card"><h2 class="card-title">Index & health</h2>' +
    '<p class="note">Regenerate the derived indexes, or let doctor repair what it can.</p>' +
    '<div class="row mt-10">' + writeBtn('m-rebuild', 'Rebuild index') + writeBtn('m-fix', 'Doctor --fix') + '</div>' +
    '<div class="out" id="m-idx-out"></div></div>' +
    '<div class="card"><h2 class="card-title">Fold superseded chains</h2>' +
    '<p class="note">Archive old revision-chain members. Reversible; terminals untouched.</p>' +
    '<div class="row mt-10">' +
    '<label class="field">scope<select id="m-fold-scope"><option>local</option><option>global</option></select></label>' +
    '<button class="btn sm secondary" id="m-fold-dry">Preview</button>' + writeBtn('m-fold-apply', 'Apply fold') +
    '</div><div class="out" id="m-fold-out"></div></div>' +
    '<div class="card"><h2 class="card-title">Prune stale episodes</h2>' +
    '<p class="note">Archive low-relevance episodes past their useful life. Protected classes are never touched.</p>' +
    '<div class="row mt-10">' +
    '<label class="field">scope<select id="m-prune-scope"><option>local</option><option>global</option><option>all</option></select></label>' +
    '<button class="btn sm secondary" id="m-prune-dry">Preview</button>' + writeBtn('m-prune-apply', 'Apply prune') +
    '</div><div class="out" id="m-prune-out"></div></div>' +
    '<div class="card"><h2 class="card-title">All projects</h2>' +
    '<p class="note">One view across every registered project store.</p>' +
    '<div class="row mt-10">' +
    '<button class="btn sm secondary" id="m-ap-stats">Stats</button>' +
    '<button class="btn sm secondary" id="m-ap-doctor">Doctor</button>' +
    '</div><div class="out" id="m-ap-out"></div></div>' +
    '</div>';
  const wire = (id, cmd, flagsFn, out) => {
    const b = el(id); if (!b || b.disabled) return;
    b.onclick = async () => resultOrError(await run(cmd, flagsFn()), r => humanize(cmd, r), el(out));
  };
  wire('m-rebuild', 'rebuild-index', () => ({ scope: 'all' }), 'm-idx-out');
  wire('m-fix', 'doctor-fix', () => ({ scope: 'all' }), 'm-idx-out');
  wire('m-fold-dry', 'fold-preview', () => ({ scope: el('m-fold-scope').value }), 'm-fold-out');
  wire('m-fold-apply', 'fold-apply', () => ({ scope: el('m-fold-scope').value }), 'm-fold-out');
  wire('m-prune-dry', 'prune-preview', () => ({ scope: el('m-prune-scope').value }), 'm-prune-out');
  wire('m-prune-apply', 'prune-apply', () => ({ scope: el('m-prune-scope').value }), 'm-prune-out');
  wire('m-ap-stats', 'stats', () => ({ scope: 'all', 'all-projects': true }), 'm-ap-out');
  wire('m-ap-doctor', 'doctor', () => ({ scope: 'all', 'all-projects': true }), 'm-ap-out');
}

// --- new episode ----------------------------------------------------------------------
function buildNew() {
  if (!META.allow_write) {
    el('tab-new').innerHTML =
      guide('Why this page exists', 'Store a decision, lesson, or discovery by hand — or correct one via a revision chain. This launch is read-only.') +
      '<h1 class="view-title">New episode</h1>' +
      '<div class="card"><p class="note m-0">Relaunch the console with <span class="mono">--allow-write</span> to store or revise episodes here.</p></div>';
    return;
  }
  const catOpts = META.categories.map(c => '<option>' + esc(c) + '</option>').join('');
  el('tab-new').innerHTML =
    guide('Why this page exists', 'Store a decision, lesson, or discovery by hand — or correct a past one. Corrections never edit history; they add a new revision to the chain.') +
    '<h1 class="view-title">New episode</h1>' +
    '<div class="grid-2"><div class="card"><h2 class="card-title">Store</h2>' +
    '<div class="row mb-8">' +
    '<label class="field">project<input id="n-proj" size="13"></label>' +
    '<label class="field">category<select id="n-cat">' + catOpts + '</select></label>' +
    '<label class="field">scope<select id="n-scope"><option>global</option><option>local</option></select></label>' +
    '<label class="field"><span>pin</span><input type="checkbox" id="n-pin"></label></div>' +
    '<div class="row mb-8"><label class="field flex-1">summary<input id="n-sum" class="w-100"></label></div>' +
    '<div class="row mb-8"><label class="field flex-1">tags (comma-sep)<input id="n-tags" class="w-100"></label></div>' +
    '<label class="field">body<textarea id="n-body"></textarea></label>' +
    '<div class="row mt-10"><button class="btn sm" id="n-store">Store episode</button></div>' +
    '<div class="out" id="n-out"></div></div>' +
    '<div class="card"><h2 class="card-title">Revise</h2>' +
    '<div class="row mb-8"><label class="field flex-1">original id<input id="v-orig" class="mono w-100"></label></div>' +
    '<div class="row mb-8"><label class="field">project<input id="v-proj" size="13"></label></div>' +
    '<div class="row mb-8"><label class="field flex-1">summary<input id="v-sum" class="w-100"></label></div>' +
    '<label class="field">body<textarea id="v-body"></textarea></label>' +
    '<div class="row mt-10"><button class="btn sm" id="v-run">Add revision</button></div>' +
    '<div class="out" id="v-out"></div></div></div>';
  el('n-store').onclick = async () => {
    const flags = { project: el('n-proj').value.trim(), category: el('n-cat').value, summary: el('n-sum').value.trim(), body: el('n-body').value, scope: el('n-scope').value };
    if (el('n-tags').value.trim()) flags.tags = el('n-tags').value.trim();
    if (el('n-pin').checked) flags.pin = true;
    const res = await run('store', flags);
    const ok = resultOrError(res, r => '<p class="note">stored: <span class="mono">' + esc(r.id || '') + '</span></p>', el('n-out'));
    if (ok) toast('Episode stored.');
  };
  el('v-run').onclick = async () => {
    const flags = { original: el('v-orig').value.trim(), project: el('v-proj').value.trim(), summary: el('v-sum').value.trim(), body: el('v-body').value };
    const res = await run('revise', flags);
    const ok = resultOrError(res, r => '<p class="note">revised: <span class="mono">' + esc(r.id || '') + '</span></p>', el('v-out'));
    if (ok) toast('Revision added.');
  };
}

// --- boot ---------------------------------------------------------------------------
(async function boot() {
  buildShell();
  const meta = await api('/api/meta');
  if (meta.http !== 200) {
    el('main').innerHTML = '<div class="card"><p class="err-line">' + esc(meta.body.message || 'auth failed') + '</p><p class="note">Relaunch em-console and open the freshly printed URL.</p></div>';
    return;
  }
  META = meta.body;
  el('mode').textContent = META.allow_write ? 'WRITE ENABLED' : 'READ-ONLY';
  el('mode').classList.toggle('write', META.allow_write);
  buildOverview(); buildBrowse(); buildRecall(); buildDrafts(); buildMaintenance(); buildNew();
  show('overview');
})();
</script>
</body>
</html>
`
}
