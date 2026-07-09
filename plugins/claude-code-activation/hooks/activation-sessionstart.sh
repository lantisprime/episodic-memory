#!/usr/bin/env bash
# RFC-009 P2 activation adapter — SessionStart hook. ADVISORY-ONLY skeleton (P2-S2).
# Full matcher/inject logic lands in P2-S5. Contract: drain stdin, emit nothing,
# exit 0 on every path. NEVER emit a decision/block/permissionDecision field.
cat >/dev/null 2>&1 || true
exit 0
