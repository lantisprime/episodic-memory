#!/bin/sh
# claude-rerank.sh — em-semantic re-ranker driven by the `claude` CLI.
#
# Uses your existing Claude Code login (OAuth token) — no separate API key.
# Anthropic has no embeddings API, so Claude cannot be the VECTOR provider;
# instead this adapter gives you Claude-powered semantics where it counts:
# vectors retrieve the candidate window cheaply, Claude re-orders it by true
# semantic relevance to the query.
#
# Protocol (em-semantic --rerank-cmd / embed-config.json rerank_cmd):
#   stdin  JSON {query, candidates:[{id, summary, similarity}]}
#   stdout JSON {"order":[ids most-relevant-first]}
#
# Config (env):
#   CLAUDE_BIN            default `claude`
#   CLAUDE_RERANK_MODEL   optional --model override (default: CLI default)
#
# Requires: the claude CLI on PATH (logged in), python3 (stdlib only).
# The python wrapper goes through -c, NOT a heredoc — a heredoc would replace
# stdin and swallow the piped JSON.
set -eu

: "${CLAUDE_BIN:=claude}"
export CLAUDE_BIN
export CLAUDE_RERANK_MODEL="${CLAUDE_RERANK_MODEL:-}"

exec python3 -c "
import json, os, re, subprocess, sys

payload = json.load(sys.stdin)
query = payload[\"query\"]
candidates = payload[\"candidates\"]
ids = [c[\"id\"] for c in candidates]

lines = []
for c in candidates:
    lines.append(\"- id: \" + c[\"id\"] + \"\n  summary: \" + c[\"summary\"])

prompt = (
    \"You are a search re-ranker for an episodic memory store used by coding agents. \"
    \"Order the candidate episodes below from most to least relevant to the query. \"
    \"Judge by meaning, not word overlap. Output ONLY a JSON object of the exact shape \"
    '{\"order\": [\"<id>\", ...]} containing every candidate id exactly once. No prose.'
    \"\n\nQuery: \" + query + \"\n\nCandidates:\n\" + \"\n\".join(lines)
)

cmd = [os.environ[\"CLAUDE_BIN\"], \"-p\", prompt]
model = os.environ.get(\"CLAUDE_RERANK_MODEL\")
if model:
    cmd += [\"--model\", model]

r = subprocess.run(cmd, capture_output=True, text=True, timeout=110)
if r.returncode != 0:
    print(\"claude-rerank: claude exited \" + str(r.returncode) + \": \" + r.stderr[:300], file=sys.stderr)
    sys.exit(1)

# Defensive parse: take the first JSON object in the output.
m = re.search(r\"\{[\s\S]*\}\", r.stdout)
if not m:
    print(\"claude-rerank: no JSON object in claude output: \" + r.stdout[:300], file=sys.stderr)
    sys.exit(1)
out = json.loads(m.group(0))
order = [i for i in out.get(\"order\", []) if i in set(ids)]
if not order:
    print(\"claude-rerank: empty/unusable order from claude\", file=sys.stderr)
    sys.exit(1)
print(json.dumps({\"order\": order}))
"
