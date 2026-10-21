#!/bin/bash
# Whether an effort change made by the plugin restarts the prompt cache, with the
# real plugin loaded in Claude Code and a stand-in for Jev (scripts/fake-jev.mjs),
# on your own login. Needs `claude`, `node`, `openssl` and `python3`.
#
#   scripts/probe-plugin-effort.sh claude-haiku-5-5 haiku
#   scripts/probe-plugin-effort.sh claude-sonnet-5-5 sonnet
#
# One session, seven calls, the effort changing between some of them. The route
# line says which effort the plugin sent; `read` and `written` are the prompt
# cache. An effort change that restarts the cache reads ~0 and writes the whole
# prompt (as the call after the first resume sometimes does whatever the effort).
set -u
model=${1:-claude-haiku-5-5}
tier=${2:-haiku}
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
server=""
trap '[ -n "$server" ] && kill "$server" 2>/dev/null; rm -rf "$dir"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/key.pem" -out "$dir/cert.pem" -days 2 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null || { echo "openssl failed"; exit 1; }
node "$root/scripts/fake-jev.mjs" "$dir" >"$dir/server.out" 2>&1 &
server=$!
sleep 1
export TYPESAFE_API_KEY=fake TYPESAFE_BASE_URL=https://localhost:8443 JEV_ROUTER_ALLOW_CUSTOM_BASE=1 \
  JEV_ROUTER_PROVIDER=typesafe NODE_EXTRA_CA_CERTS="$dir/cert.pem" JEV_ROUTER_CATALOG=0 \
  JEV_ROUTER_MODEL_SYNC=0 JEV_ROUTER_CEILING=max NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
unset JEV_ROUTER_STICKY
cd "$dir" || exit 1
id=$(python3 -c "import uuid;print(uuid.uuid4())")
python3 - >prompt.txt <<PY
import random, string
n = ''.join(random.choices(string.ascii_lowercase, k=8))
print(f"[[t=$tier]][[e=1]] Run {n}. Read this and then reply with one word. Do not use any tools.\n")
for i in range(1, 161):
    print(f"Paragraph {i}. The migration plan keeps each step small, reversible and checked against the row counts before the next one starts.")
PY
step() { # label prompt [claude args…]
  local label=$1 prompt=$2
  shift 2
  timeout 150 claude -p "$prompt" --plugin-dir "$root" --model "$model" --tools "" "$@" --output-format json 2>/dev/null |
    python3 -c "
import sys, json, re
try:
    d = json.loads(sys.stdin.read())
except Exception:
    print('$label'.ljust(24), 'no result'); sys.exit()
m = re.search(r'([a-z0-9-]+) ✓ (\w+)', d.get('result') or '')
route = (m.group(1) + ' ' + m.group(2)) if m else 'NO ROUTE LINE (plugin not loaded?)'
for u in (d['usage'].get('iterations') or [d['usage']]):
    print('$label'.ljust(24), route.ljust(22), 'read', str(u.get('cache_read_input_tokens')).rjust(6), 'written', str(u.get('cache_creation_input_tokens')).rjust(6))
"
  sleep 3
}
echo "Model $model through the plugin"
step "1 write (e=1)" "$(cat prompt.txt)" --session-id "$id"
step "2 resume (e=1)" "[[t=$tier]][[e=1]] Go." --resume "$id"
step "3 control (e=1)" "[[t=$tier]][[e=1]] Go." --resume "$id"
step "4 e=1 -> e=3" "[[t=$tier]][[e=3]] Go." --resume "$id"
step "5 control (e=3)" "[[t=$tier]][[e=3]] Go." --resume "$id"
step "6 e=3 -> e=0" "[[t=$tier]][[e=0]] Go." --resume "$id"
step "7 e=0 -> e=4" "[[t=$tier]][[e=4]] Go." --resume "$id"
