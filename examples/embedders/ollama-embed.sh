#!/bin/sh
# ollama-embed.sh — em-embed/em-semantic `cmd` provider adapter for Ollama.
#
# Protocol (lib/embeddings.mjs): reads {"id","text"} JSONL on stdin, writes
# {"id","vector"} JSONL on stdout. One HTTP call per line via Ollama's
# /api/embeddings endpoint.
#
# Usage:
#   node em-embed.mjs --scope all --cmd "sh <clone>/examples/embedders/ollama-embed.sh" --model ollama-nomic
#   node em-semantic.mjs --query "..." --cmd "sh <clone>/examples/embedders/ollama-embed.sh" --model ollama-nomic
#
# Config (env):
#   OLLAMA_URL    default http://localhost:11434
#   OLLAMA_MODEL  default nomic-embed-text   (pull first: `ollama pull nomic-embed-text`)
#
# Requires: python3 (stdlib only — no pip installs, no jq).
# NOTE: the python code goes through -c, NOT a heredoc — a heredoc would
# replace stdin and silently swallow the piped JSONL.
set -eu

: "${OLLAMA_URL:=http://localhost:11434}"
: "${OLLAMA_MODEL:=nomic-embed-text}"

export OLLAMA_URL OLLAMA_MODEL

exec python3 -c "
import json, os, sys, urllib.request

url = os.environ[\"OLLAMA_URL\"].rstrip(\"/\") + \"/api/embeddings\"
model = os.environ[\"OLLAMA_MODEL\"]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    row = json.loads(line)
    payload = json.dumps({\"model\": model, \"prompt\": row[\"text\"]}).encode()
    req = urllib.request.Request(url, data=payload, headers={\"Content-Type\": \"application/json\"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.load(resp)
    vector = out.get(\"embedding\")
    if not isinstance(vector, list):
        print(\"ollama-embed: no embedding in response for \" + row[\"id\"], file=sys.stderr)
        sys.exit(1)
    sys.stdout.write(json.dumps({\"id\": row[\"id\"], \"vector\": vector}) + \"\n\")
    sys.stdout.flush()
"
