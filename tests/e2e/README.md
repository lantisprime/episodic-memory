# End-to-end browser tests (opt-in)

Real-browser tests for the `em-console` web UI, driven with Playwright +
headless Chromium. These are **not** part of the zero-dependency CI gate — the
substrate and its unit tests stay dependency-free (`node tests/*.mjs`). E2E is
a separate, opt-in layer that needs a browser, kept out of tree so the repo
carries no `node_modules`.

## Why a real browser

`tests/test-em-console.mjs` covers the server and, for the client, extracts the
page's `<script>` and drives the render functions in isolation. That can't prove
the *assembled DOM* behaves: that the detail drawer actually opens on a click,
that a Markdown body renders to real elements, or that hostile episode content
stays inert (fires no `alert`) in a live document. The E2E layer drives the
actual page in Chromium and asserts exactly those things.

## Setup (one time, out of tree)

```bash
npm install -g playwright
npx playwright install chromium
```

The test resolves Playwright from the global install via `createRequire`
(ESM `import` ignores `NODE_PATH`), so nothing is added to the repo.

## Run

```bash
node tests/e2e/console.e2e.mjs
```

It launches its own `em-console` servers (read-only and `--allow-write`) against
isolated `mkdtemp` fixture stores, seeds a normal and a hostile episode, drives
the DOM, and cleans up. Exit 0 = pass, 1 = failure, 2 = Playwright/Chromium not
installed.

## Coverage

- Overview renders the next-action hero, no visible raw-JSON well, token
  scrubbed from URL and absent from the DOM.
- Browse search lists ledger rows (not bracket soup).
- Clicking a row opens the drawer with a rendered Markdown chain — the
  regression guard for the "no chain found" drawer bug (drawer read the wrong
  result field).
- Escape closes the drawer.
- Hostile episode content (`<script>`, `<img onerror>`, `javascript:` link) is
  inert: no dialog fires, tags become text not elements, only the legitimate
  `https` link renders as an anchor.
- Maintenance fold preview renders a human summary with the raw JSON collapsed,
  not a visible well.
- Write forms are absent read-only, present under `--allow-write`.
- Nav collapses to a hamburger under 720px and the mobile menu switches views.
