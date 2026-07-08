#!/bin/sh
# claude-capture.sh — em-capture cmd-mode capturer driven by the `claude` CLI.
#
# Uses your existing Claude Code login (OAuth token) — no separate API key.
# Reads the session's message chunks and asks Claude to draft candidate
# episodes (decisions, lessons, discoveries, milestones) worth remembering.
#
# Protocol (em-capture extract --mode cmd --cmd / capture-config.json cmd):
#   stdin  JSON {session_id, project, max, chunks:[{role, text}]}
#   stdout JSON {"candidates":[{category, summary, body, tags,
#                               confidence, evidence_excerpt}]}
#
# Config (env):
#   CLAUDE_BIN             default `claude`
#   CLAUDE_CAPTURE_MODEL   optional --model override (default: CLI default)
#
# Requires: the claude CLI on PATH (logged in), python3 (stdlib only).
# The python wrapper goes through -c, NOT a heredoc — a heredoc would replace
# stdin and swallow the piped JSON.
set -eu

: "${CLAUDE_BIN:=claude}"
export CLAUDE_BIN
export CLAUDE_CAPTURE_MODEL="${CLAUDE_CAPTURE_MODEL:-}"

exec python3 -c "
import json, os, re, subprocess, sys

payload = json.load(sys.stdin)
chunks = payload[\"chunks\"]
max_candidates = int(payload.get(\"max\", 5))
project = payload.get(\"project\", \"unknown\")

lines = []
for c in chunks[-120:]:
    text = c[\"text\"][:1500]
    lines.append(c[\"role\"] + \": \" + text)

prompt = (
    \"You draft episodic-memory candidates from an AI coding session transcript for project '\" + project + \"'. \"
    \"Extract at most \" + str(max_candidates) + \" episodes genuinely worth remembering across sessions: \"
    \"decisions made (category decision), lessons learned (lesson), discoveries/root causes (discovery), \"
    \"merged PRs or shipped milestones (milestone). Skip routine chatter. \"
    'Output ONLY a JSON object of the exact shape {\"candidates\": [{\"category\": \"...\", \"summary\": \"...\", '
    '\"body\": \"...\", \"tags\": [\"...\"], \"confidence\": 0.0, \"evidence_excerpt\": \"...\"}]}. No prose.'
    \"\n\nTranscript:\n\" + \"\n\".join(lines)
)

cmd = [os.environ[\"CLAUDE_BIN\"], \"-p\", prompt]
model = os.environ.get(\"CLAUDE_CAPTURE_MODEL\")
if model:
    cmd += [\"--model\", model]

r = subprocess.run(cmd, capture_output=True, text=True, timeout=110)
if r.returncode != 0:
    print(\"claude-capture: claude exited \" + str(r.returncode) + \": \" + r.stderr[:300], file=sys.stderr)
    sys.exit(1)

m = re.search(r\"\{[\s\S]*\}\", r.stdout)
if not m:
    print(\"claude-capture: no JSON object in claude output: \" + r.stdout[:300], file=sys.stderr)
    sys.exit(1)
out = json.loads(m.group(0))
candidates = out.get(\"candidates\")
if not isinstance(candidates, list):
    print(\"claude-capture: no candidates[] in claude output\", file=sys.stderr)
    sys.exit(1)
print(json.dumps({\"candidates\": candidates[:max_candidates]}))
"
