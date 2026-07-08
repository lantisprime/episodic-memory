#!/usr/bin/env node
/**
 * console.e2e.mjs — real-browser end-to-end test for the em-console web UI.
 *
 * OPT-IN / not part of the zero-dep CI gate. The substrate + its unit tests
 * stay zero-dependency (`node tests/*.mjs`); this file needs Playwright +
 * Chromium, installed OUT of tree so the repo keeps no node_modules:
 *
 *     npm install -g playwright
 *     npx playwright install chromium
 *     node tests/e2e/console.e2e.mjs
 *
 * It resolves Playwright from the global root via createRequire (ESM `import`
 * ignores NODE_PATH), launches the REAL em-console server against isolated
 * fixture stores (mkdtemp HOME + non-git cwd), and drives the actual DOM in
 * headless Chromium — the coverage the extracted-script unit tests can't give:
 * the drawer really opens, markdown really renders, hostile episode content
 * really stays inert (no dialog fires), and no raw-JSON well is visible in the
 * default views.
 *
 * Exit 0 = all passed; exit 1 = a failure (details on stderr); exit 2 = setup
 * problem (Playwright/Chromium missing).
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync, execSync } from 'child_process'
import { createRequire } from 'module'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const CONSOLE = path.join(REPO, 'scripts', 'em-console.mjs')
const TOKEN = 'e2e-playwright-token'

// --- resolve Playwright from the global install ----------------------------
let chromium
try {
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
  chromium = createRequire(root + '/')('playwright').chromium
} catch (e) {
  console.error('SETUP: Playwright not resolvable. Install it out of tree:')
  console.error('  npm install -g playwright && npx playwright install chromium')
  console.error('  (underlying: ' + e.message + ')')
  process.exit(2)
}

let passed = 0
let failed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok ${name}`) }
  catch (e) { failed++; failures.push({ name, error: e.message }); console.log(`  FAIL ${name}: ${e.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed') }

// --- fixture store + server -------------------------------------------------
function makeSandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-console-e2e-')))
  const home = path.join(root, 'home')
  const cwd = path.join(root, 'cwd')
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd, { recursive: true })
  return { root, home, cwd, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}
function emStore(sandbox, args) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'em-store.mjs'), ...args],
    { cwd: sandbox.cwd, env: { ...process.env, HOME: sandbox.home }, encoding: 'utf8' })
  const j = JSON.parse(r.stdout.trim())
  assert(j.status === 'ok', 'seed store failed: ' + r.stdout)
  return j
}
function startServer(sandbox, extra = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CONSOLE, '--port', '0', '--token', TOKEN, ...extra],
      { cwd: sandbox.cwd, env: { ...process.env, HOME: sandbox.home } })
    let out = ''
    const t = setTimeout(() => { proc.kill(); reject(new Error('server startup timeout: ' + out)) }, 10000)
    proc.stdout.on('data', (c) => {
      out += c
      try { const s = JSON.parse(out.trim()); clearTimeout(t); resolve({ proc, url: `http://127.0.0.1:${s.port}` }) } catch {}
    })
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited early ' + code + ': ' + out)) })
  })
}

// ---------------------------------------------------------------------------
const browser = await chromium.launch()
const s = makeSandbox()

// A normal episode with a markdown body + a table (renders in the drawer).
const normal = emStore(s, ['--project', 'e2e-fixture', '--category', 'lesson', '--scope', 'local',
  '--tags', 'e2e,demo', '--summary', 'e2e markdown body episode',
  '--body', '# Heading\n\n**bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |'])

// A HOSTILE episode: if any sink is unescaped, these fire a dialog in the real DOM.
const hostile = emStore(s, ['--project', 'e2e-fixture', '--category', 'lesson', '--scope', 'local',
  '--tags', 'evil-tag', '--summary', 'hostile <img src=x onerror=alert(1)> summary',
  '--body', '# t <script>alert(2)</script>\n[x](javascript:alert(3)) [ok](https://example.com)\n<img src=y onerror=alert(4)>'])

const roServer = await startServer(s)
const rwServer = await startServer(s, ['--allow-write'])

try {
  // Any dialog (alert/confirm/prompt) firing means an XSS sink executed.
  let dialogFired = null
  async function newPage(server) {
    const page = await browser.newPage()
    page.on('dialog', async (d) => { dialogFired = d.message(); await d.dismiss() })
    page.on('pageerror', () => {}) // page JS errors surface via assertions, not here
    await page.goto(`${server.url}/?token=${TOKEN}`, { waitUntil: 'networkidle' })
    return page
  }

  await test('overview renders the next-action hero, not raw JSON', async () => {
    const page = await newPage(roServer)
    await page.waitForSelector('.hero-card', { timeout: 8000 })
    const heroText = await page.textContent('.hero-card')
    assert(heroText && heroText.length > 10, 'hero card empty')
    // No visible raw-JSON well on the landing view.
    const openPre = await page.$$('main pre:visible')
    assert(openPre.length === 0, 'a raw <pre> is visible on overview: ' + openPre.length)
    // The token must not be anywhere in the rendered DOM.
    const html = await page.content()
    assert(!html.includes(TOKEN), 'token leaked into the DOM')
    // URL was scrubbed of ?token=.
    assert(!page.url().includes('token='), 'token still in the URL bar')
    await page.close()
  })

  await test('Browse: search lists episodes as ledger rows (no bracket soup)', async () => {
    const page = await newPage(roServer)
    await page.click('nav.pills button[data-tab="browse"]')
    await page.click('#q-list')
    await page.waitForSelector('.lrow', { timeout: 8000 })
    const rows = await page.$$('.lrow')
    assert(rows.length >= 2, 'expected >=2 ledger rows, got ' + rows.length)
    const firstText = await page.textContent('.lrow')
    assert(!/^\s*\{/.test(firstText), 'ledger row looks like raw JSON')
    await page.close()
  })

  await test('clicking a row opens the drawer with a RENDERED markdown chain (regression: "no chain found")', async () => {
    const page = await newPage(roServer)
    await page.click('nav.pills button[data-tab="browse"]')
    await page.click('#q-list')
    await page.waitForSelector('.lrow', { timeout: 8000 })
    // Click the normal episode's row specifically.
    await page.click(`.lrow[data-ep-id="${normal.id}"]`)
    // openDrawer() adds .open and shows "loading…" BEFORE the async history
    // fetch renders — wait for an actual rendered member, not just the drawer.
    await page.waitForSelector('#d-body .d-ep', { timeout: 8000 })
    const drawerBody = await page.textContent('#d-body')
    assert(!/no chain found/i.test(drawerBody), 'drawer shows "no chain found" — chain field regression')
    // The markdown body rendered to real elements, not a <pre> dump.
    assert(await page.$('#d-body .md h1'), 'markdown heading not rendered in drawer')
    assert(await page.$('#d-body .md table'), 'markdown table not rendered in drawer')
    assert(await page.$('#d-body .md strong'), 'markdown bold not rendered in drawer')
    const title = await page.textContent('#d-title')
    assert(/member/.test(title), 'drawer title missing member count: ' + title)
    await page.close()
  })

  await test('Escape closes the drawer', async () => {
    const page = await newPage(roServer)
    await page.click('nav.pills button[data-tab="browse"]')
    await page.click('#q-list')
    await page.waitForSelector('.lrow', { timeout: 8000 })
    await page.click('.lrow')
    await page.waitForSelector('#d-body .d-ep', { timeout: 8000 })
    await page.keyboard.press('Escape')
    await page.waitForSelector('#drawer:not(.open)', { timeout: 4000 })
    await page.close()
  })

  await test('hostile episode content is inert in the real DOM (no dialog, escaped in drawer)', async () => {
    dialogFired = null
    const page = await newPage(roServer)
    await page.click('nav.pills button[data-tab="browse"]')
    await page.fill('#q-query', 'hostile')
    await page.click('#q-run')
    await page.waitForSelector('.lrow', { timeout: 8000 })
    await page.click(`.lrow[data-ep-id="${hostile.id}"]`)
    await page.waitForSelector('#d-body .d-ep', { timeout: 8000 })
    // Give any injected handler a beat to fire.
    await page.waitForTimeout(400)
    assert(dialogFired === null, 'XSS dialog fired: ' + dialogFired)
    // The <img> and <script> must be TEXT, not elements, inside the drawer.
    assert(!(await page.$('#d-body img')), 'hostile <img> became a real element')
    assert(!(await page.$('#d-body script')), 'hostile <script> became a real element')
    // The legitimate https link IS rendered as an anchor.
    const href = await page.getAttribute('#d-body .md a', 'href')
    assert(href === 'https://example.com', 'legit https link missing/rewritten: ' + href)
    await page.close()
  })

  await test('Maintenance: fold preview renders a human summary, not a JSON well', async () => {
    const page = await newPage(roServer)
    await page.click('nav.pills button[data-tab="maintenance"]')
    await page.waitForSelector('#m-fold-dry', { timeout: 8000 })
    await page.click('#m-fold-dry')
    await page.waitForSelector('#m-fold-out .count-line, #m-fold-out .note', { timeout: 8000 })
    // A human summary line is visible…
    assert(await page.isVisible('#m-fold-out .count-line, #m-fold-out .note'), 'no human summary rendered for fold')
    // …and the raw JSON, while present, is COLLAPSED (its <pre> is not visible).
    const preVisible = await page.isVisible('#m-fold-out details.raw pre').catch(() => false)
    assert(!preVisible, 'raw JSON well is visible instead of collapsed')
    const rawOpen = await page.$('#m-fold-out details.raw[open]')
    assert(!rawOpen, 'raw JSON disclosure defaulted open')
    await page.close()
  })

  await test('write forms disabled on the read-only server, enabled on --allow-write', async () => {
    const ro = await newPage(roServer)
    await ro.click('nav.pills button[data-tab="new"]')
    await ro.waitForTimeout(200)
    assert(!(await ro.$('#n-store')), 'read-only server exposed a store button')
    await ro.close()

    const rw = await newPage(rwServer)
    const modeText = await rw.textContent('#mode')
    assert(/WRITE/.test(modeText), 'write server not flagged WRITE: ' + modeText)
    await rw.click('nav.pills button[data-tab="new"]')
    await rw.waitForSelector('#n-store', { timeout: 8000 })
    assert(await rw.$('#n-store'), 'write server missing the store button')
    await rw.close()
  })

  await test('responsive: nav collapses to a hamburger under 720px', async () => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 480, height: 900 })
    await page.goto(`${roServer.url}/?token=${TOKEN}`, { waitUntil: 'networkidle' })
    const burgerVisible = await page.isVisible('#burger')
    const pillsVisible = await page.isVisible('nav.pills')
    assert(burgerVisible, 'hamburger not visible on narrow viewport')
    assert(!pillsVisible, 'pill nav still visible on narrow viewport')
    await page.click('#burger')
    await page.waitForSelector('#mobile-nav', { state: 'visible', timeout: 4000 })
    await page.click('#mobile-nav button[data-tab="maintenance"]')
    await page.waitForSelector('#tab-maintenance.active', { timeout: 4000 })
    await page.close()
  })
} finally {
  roServer.proc.kill()
  rwServer.proc.kill()
  await browser.close()
  s.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) { for (const f of failures) console.log(`  - ${f.name}: ${f.error}`); process.exit(1) }
