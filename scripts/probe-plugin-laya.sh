#!/bin/bash
# The real plugin against a stand-in that answers like a Laya server
# (scripts/fake-jev.mjs with FAKE_STYLE=laya), in Claude Code on your own login.
#
#   scripts/probe-plugin-laya.sh
#
# Two calls in one session on Sonnet 5.5. The first asks for sonnet. The second
# asks for haiku with `confidence` 0.99 (Laya's own, not Jev's scale) and
# `x_jev_confidence` 0.5. The router must read the 0.5: against its 75% bar the
# switch is held (the price check is off so only the confidence can hold it), and the
# route line says `Laya 50%`. Reading `confidence`
# instead would have moved the model to haiku.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
server=""
trap '[ -n "$server" ] && kill "$server" 2>/dev/null; rm -rf "$dir"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/key.pem" -out "$dir/cert.pem" -days 2 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null || { echo "openssl failed"; exit 1; }
FAKE_STYLE=laya node "$root/scripts/fake-jev.mjs" "$dir" >"$dir/server.out" 2>&1 &
server=$!
sleep 1
export LAYA_BASE_URL=https://localhost:8443 NODE_EXTRA_CA_CERTS="$dir/cert.pem" JEV_ROUTER_CATALOG=0 \
  JEV_ROUTER_MODEL_SYNC=0 JEV_ROUTER_PRICE_CHECK=0 JEV_ROUTER_CEILING=max NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1
unset TYPESAFE_API_KEY AI_GATEWAY_API_KEY JEV_ROUTER_PROVIDER JEV_ROUTER_STICKY LAYA_API_KEY
cd "$dir" || exit 1
id=$(python3 -c "import uuid;print(uuid.uuid4())")
step() { # label prompt [claude args…]
  local label=$1 prompt=$2
  shift 2
  timeout 150 claude -p "$prompt" --plugin-dir "$root" --model claude-sonnet-5-5 --tools "" "$@" --output-format json 2>/dev/null |
    python3 -c "
import sys, json, re
try:
    d = json.loads(sys.stdin.read())
except Exception:
    print('$label'.ljust(18), 'no result'); sys.exit()
res = d.get('result') or ''
print('$label'.ljust(18), 'model:', ', '.join(d['modelUsage']))
for line in res.strip().splitlines():
    if line.strip() and not line.startswith('\`\`\`'):
        print('                   ', line.strip())
"
}
step "1 sonnet" "[[t=sonnet]][[e=1]] Reply with one word." --session-id "$id"
step "2 haiku, 50% sure" "[[t=haiku]][[e=1]][[x=0.5]] Reply with one word." --resume "$id"
echo
echo "What the stand-in was asked:"
cut -c1-110 "$dir/jev.log"
