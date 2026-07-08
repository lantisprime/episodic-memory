---
url: https://github.com/showdownjs/showdown/wiki/Markdown's-XSS-Vulnerability-(and-how-to-mitigate-it), https://medium.com/javascript-security/avoiding-xss-via-markdown-in-react-91665479900, https://medium.com/design-bootcamp/json-demystified-a-field-guide-for-designers-1a93a3f27fae
fetched: 2026-07-08
summary: Patterns for turning CLI JSON + Markdown bodies into human-friendly HTML in a zero-dep page
---

# JSON / Markdown -> human-friendly HTML (for em-console typed renderers)

## JSON -> UI (design guidance)
- Humans never want brackets: objects render as key-value tables/tiles, arrays of
  objects as rows, arrays of scalars as chips, statuses as colored badges, counts as
  one-line summaries ("1 chain - 50 members fold").
- Map KNOWN schemas to typed renderers per command; keep a GENERIC fallback
  (recursive key-value table, depth-capped, row-capped) for unknown shapes; keep the
  raw JSON reachable behind a collapsed disclosure as the escape hatch.
- Data-driven layouts must tolerate missing keys/varying lengths (tolerant readers,
  `??`-style fallbacks) so schema drift degrades to the generic renderer, not a crash.

## Markdown -> HTML safely with zero deps (episode bodies)
- The standard failure: md libs pass raw HTML + javascript: URLs through
  ([showdown wiki](https://github.com/showdownjs/showdown/wiki/Markdown's-XSS-Vulnerability-(and-how-to-mitigate-it)),
  markdown-to-jsx CVE-2024-21535). Sanitize OUTPUT, or if raw HTML support is not
  needed, ESCAPE-FIRST is the simple correct path.
- Escape-first recipe (what em-console uses): HTML-escape the ENTIRE source string
  (& < > " '), then run markdown transforms over the escaped text; only the renderer
  itself emits tags. Tag injection is impossible by construction because user < >
  are already entities before any transform runs.
- Residual rules: link hrefs must be scheme-allowlisted (http/https only — blocks
  javascript:/data: URI class); rel="noopener noreferrer" + target=_blank on
  external links; fenced code blocks are extracted FIRST and re-inserted verbatim
  (escaped) so list/heading transforms never fire inside code.

Applied in scripts/lib/console-page.mjs (PR after #483): miniMd() + HUMANIZE typed
renderer registry + autoRender() generic fallback.
