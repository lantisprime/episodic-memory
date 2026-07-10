# Codex activation quick reference

- Install: `node install.mjs --tool codex --project <path> --install-activation`
- Trust: run `/hooks` in Codex and trust the three activation hooks
- Uninstall: `node install.mjs --tool codex --project <path> --uninstall-activation`
- Scope: project-local `.codex/`; local episodes are never removed
- Behavior: advisory context only; always exits zero; never blocks
