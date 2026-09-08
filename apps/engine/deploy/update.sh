#!/usr/bin/env bash
# Update the host to the current main (docs/OPS.md §3): pull, build the console, stamp the
# commit, rebuild the engine, wait for /healthz. Run on the host from this directory:
#   ./update.sh            # main
#   ./update.sh <ref>      # a branch or commit, for a hotfix under test
# Nothing here touches .env beyond WICK_COMMIT, and nothing unseals: the engine comes back sealed.
set -euo pipefail
cd "$(dirname "$0")"
REPO=$(git rev-parse --show-toplevel)
REF="${1:-main}"
source <(grep -E '^TAILSCALE_IP=' .env)
BASE="http://${TAILSCALE_IP}"

before=$(git -C "$REPO" rev-parse --short HEAD)
git -C "$REPO" fetch -q origin "$REF"
git -C "$REPO" checkout -q "$REF" 2>/dev/null || true
git -C "$REPO" pull -q --ff-only origin "$REF" 2>/dev/null || git -C "$REPO" reset -q --hard FETCH_HEAD
after=$(git -C "$REPO" rev-parse --short HEAD)
echo "== ${before} -> ${after} (${REF})"
if [ "$before" = "$after" ]; then echo "   already there; rebuilding anyway"; fi
git -C "$REPO" log --oneline "${before}..${after}" 2>/dev/null | sed 's/^/   /' || true

echo "== console"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$REPO":/repo -w /repo node:22-bookworm \
  sh -c "npm ci --no-audit --no-fund >/dev/null 2>&1 && npm run build -w @wick/console 2>&1 | tail -2"

if grep -q '^WICK_COMMIT=' .env; then sed -i "s/^WICK_COMMIT=.*/WICK_COMMIT=${after}/" .env; else echo "WICK_COMMIT=${after}" >> .env; fi

echo "== engine"
docker compose up -d --build --quiet-pull engine prometheus 2>&1 | grep -E 'Started|Running|Error|error' || true

echo "== waiting for /healthz"
for i in $(seq 1 30); do
  body=$(curl -s --max-time 3 "${BASE}/healthz" || true)
  if [ -n "$body" ]; then
    echo "$body" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   version', d.get('version'), '· selfHalt', d.get('selfHalt'), '· dbOk', d.get('dbOk')); print('   sources', d.get('sourceAges'))"
    break
  fi
  sleep 3
  [ "$i" = 30 ] && echo "   no answer after 90 s: docker compose logs --since 3m engine"
done
docker compose logs --since 3m engine 2>/dev/null | grep -E '"msg":"(migrations applied|telegram bot polling|self-halt|self-halt cleared)"' | sed 's/^/   /' | tail -6
echo "== done: ${after}"
