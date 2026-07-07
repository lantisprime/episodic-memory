#!/bin/sh
# openai-embed.sh — em-embed/em-semantic `cmd` provider adapter for the
# OpenAI embeddings API (or any API-compatible endpoint).
#
# Protocol (lib/embeddings.mjs): reads {"id","text"} JSONL on stdin, writes
# {"id","vector"} JSONL on stdout. Batches all inputs into ONE API call
# (the endpoint accepts an input array), so bulk em-embed runs are cheap.
#
# Usage:
#   export OPENAI_API_KEY=sk-...
#   node em-embed.mjs --scope all --cmd "sh <clone>/examples/embedders/openai-embed.sh" --model openai-3-small
#   node em-semantic.mjs --query "..." --cmd "sh <clone>/examples/embedders/openai-embed.sh" --model openai-3-small
#
# Config (env):
#   OPENAI_API_KEY   required
#   OPENAI_EMBED_URL default https://api.openai.com/v1/embeddings
#   OPENAI_MODEL     default text-embedding-3-small
#
# Requires: python3 (stdlib only — no pip installs).
# NOTE: the python code goes through -c, NOT a heredoc — a heredoc would
# replace stdin and silently swallow the piped JSONL.
set -eu

: "${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
: "${OPENAI_EMBED_URL:=https://api.openai.com/v1/embeddings}"
: "${OPENAI_MODEL:=text-embedding-3-small}"

export OPENAI_API_KEY OPENAI_EMBED_URL OPENAI_MODEL

exec python3 -c "
import json, os, sys, urllib.request

rows = [json.loads(l) for l in sys.stdin if l.strip()]
if not rows:
    sys.exit(0)

payload = json.dumps({
    \"model\": os.environ[\"OPENAI_MODEL\"],
    \"input\": [r[\"text\"][:32000] for r in rows],
}).encode()
req = urllib.request.Request(
    os.environ[\"OPENAI_EMBED_URL\"],
    data=payload,
    headers={
        \"Content-Type\": \"application/json\",
        \"Authorization\": \"Bearer \" + os.environ[\"OPENAI_API_KEY\"],
    },
)
with urllib.request.urlopen(req, timeout=300) as resp:
    out = json.load(resp)

data = out.get(\"data\")
if not isinstance(data, list) or len(data) != len(rows):
    print(\"openai-embed: unexpected response shape or count\", file=sys.stderr)
    sys.exit(1)

by_index = {d[\"index\"]: d[\"embedding\"] for d in data}
for i, row in enumerate(rows):
    sys.stdout.write(json.dumps({\"id\": row[\"id\"], \"vector\": by_index[i]}) + \"\n\")
"
