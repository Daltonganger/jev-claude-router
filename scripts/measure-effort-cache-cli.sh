#!/bin/bash
# Whether changing effort restarts the prompt cache in Claude Code itself, for
# one model, on your own login (a Pro or Max subscription is enough, no API key).
# It runs `claude -p` in one session with a different --effort between calls and
# prints, per request, the cache tokens read and written.
#
#   scripts/measure-effort-cache-cli.sh                      # claude-haiku-5-5
#   scripts/measure-effort-cache-cli.sh claude-sonnet-5-5
#
# Read it like this: an effort change "keeps the cache" when that call reads
# about as much as the call before wrote or read, and writes little. A call that
# reads 0 and writes the whole prompt has restarted it. The call right after the
# first resume sometimes misses whatever the effort (seen on both models), so
# the controls repeat an effort before changing it. A few small requests.
set -u
model=${1:-claude-haiku-5-5}
dir=$(mktemp -d)
cd "$dir" || exit 1
id=$(python3 -c "import uuid;print(uuid.uuid4())")
python3 - >prompt.txt <<'PY'
import random, string
n = ''.join(random.choices(string.ascii_lowercase, k=8))
print(f"Run {n}. Read this and then reply with one word. Do not use any tools.\n")
for i in range(1, 161):
    print(f"Paragraph {i}. The migration plan keeps each step small, reversible and checked against the row counts before the next one starts.")
PY
step() { # label effort prompt [claude args…]
  local label=$1 effort=$2 prompt=$3
  shift 3
  timeout 150 claude -p "$prompt" --model "$model" --effort "$effort" --tools "" "$@" --output-format json 2>/dev/null |
    python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
except Exception:
    print('$label'.ljust(28), 'no result'); sys.exit()
for u in (d['usage'].get('iterations') or [d['usage']]):
    print('$label'.ljust(28), 'effort=$effort'.ljust(14), 'read', str(u.get('cache_read_input_tokens')).rjust(6), 'written', str(u.get('cache_creation_input_tokens')).rjust(6))
"
  sleep 3
}
echo "Model $model"
step "1 write" low "$(cat prompt.txt)" --session-id "$id"
step "2 low (resume)" low "Go." --resume "$id"
step "3 low (control)" low "Go." --resume "$id"
step "4 low -> high" high "Go." --resume "$id"
step "5 high (control)" high "Go." --resume "$id"
step "6 high -> low" low "Go." --resume "$id"
rm -rf "$dir"
