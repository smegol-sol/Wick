#!/usr/bin/env bash
# Failure drills (docs/OPS.md §7, docs/THREAT-MODEL.md): each one breaks something, waits,
# checks that the engine did the safe thing, and puts it back. Run on the host from this
# directory with the stack up and the vault sealed:
#   ./drill.sh rpc-cut | db-stop | restart | all
set -euo pipefail
cd "$(dirname "$0")"
source <(grep -E '^(DASHBOARD_TOKEN|TAILSCALE_IP|SOLANA_RPC_URL)=' .env)
BASE="http://${TAILSCALE_IP}"
AUTH="Authorization: Bearer ${DASHBOARD_TOKEN}"
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILED=1; }
FAILED=0

healthz() { curl -s --max-time 5 "${BASE}/healthz" || echo '{}'; }
field() { healthz | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('$1'))"; }
restarts() { docker inspect --format '{{.RestartCount}}' "$(docker compose ps -q engine)" 2>/dev/null || echo "?"; }
metric() { curl -s --max-time 5 -H "$AUTH" "${BASE}/metrics" | grep -E "^$1" | head -1 | awk '{print $NF}'; }

drill_rpc_cut() {
  echo "== RPC cut: block the RPC host for 90 s; expect a self-halt on 'source rpc-primary stale' (reads continue on the fallbacks), no crash"
  host=$(python3 -c "from urllib.parse import urlparse; print(urlparse('${SOLANA_RPC_URL}').hostname)")
  ips=$(getent ahostsv4 "$host" | awk '{print $1}' | sort -u)
  # The engine is a container: its traffic is forwarded, not sent by the host, so a ufw
  # "deny out" never sees it. Docker's DOCKER-USER chain is the one place a rule holds.
  for ip in $ips; do sudo iptables -I DOCKER-USER -d "$ip" -j REJECT; done
  echo "   blocked $host ($(echo $ips | wc -w) addresses) in DOCKER-USER"
  sleep 90
  if [ "$(field selfHalt)" = "True" ] && healthz | grep -q "source rpc-primary stale"; then pass "self-halt on rpc-primary stale"; else fail "no self-halt: $(healthz)"; fi
  [ "$(field slotLag)" = "None" ] && pass "slot lag unknown while the primary is cut" || fail "slot lag still read: $(field slotLag)"
  [ "$(docker compose ps --format '{{.Name}} {{.Status}}' | grep engine | grep -c Up)" = "1" ] && pass "engine still up" || fail "engine not up"
  for ip in $ips; do sudo iptables -D DOCKER-USER -d "$ip" -j REJECT; done
  sleep 45
  [ "$(field selfHalt)" = "False" ] && pass "self-halt cleared after the RPC returned" || fail "still halted: $(healthz)"
}

drill_db_stop() {
  echo "== Postgres stopped for 60 s; expect dbOk=false, a self-halt, DbErrors, the engine process alive, and writes resuming"
  before=$(metric 'wick_db_errors_total' || echo 0)
  restarts_before=$(restarts)
  docker compose stop db >/dev/null
  sleep 60
  [ "$(restarts)" = "$restarts_before" ] && pass "engine did not restart (process survived the lost connection)" || fail "engine restarted $restarts_before -> $(restarts): the process died with the database"
  [ "$(field dbOk)" = "False" ] && pass "dbOk=false on /healthz" || fail "dbOk not false: $(healthz)"
  [ "$(field selfHalt)" = "True" ] && pass "self-halt while the database is down" || fail "no self-halt"
  docker compose start db >/dev/null
  sleep 45
  [ "$(field dbOk)" = "True" ] && pass "dbOk=true again" || fail "dbOk not back: $(healthz)"
  after=$(metric 'wick_db_errors_total' || echo 0)
  echo "   db errors before ${before:-0}, after ${after:-0} (errors are expected while it was down)"
  docker compose logs --since 3m engine | grep -q '"msg":"self-halt cleared"' && pass "self-halt cleared logged" || fail "no 'self-halt cleared' line"
}

drill_restart() {
  echo "== Unattended restart: reboot the host; run './drill.sh restart-check' after logging back in"
  echo "   expected: every service Up, migrations a no-op, the vault sealed, entries halted until unseal"
  sudo reboot
}

drill_restart_check() {
  echo "== After the reboot"
  up=$(docker compose ps --format '{{.Status}}' | grep -c Up)
  total=$(docker compose ps --format '{{.Name}}' | wc -l)
  [ "$up" = "$total" ] && pass "all $total services up" || fail "$up of $total services up"
  docker compose logs engine | grep -q '"msg":"vault sealed"' && pass "vault sealed at boot" || fail "no 'vault sealed' line"
  docker compose logs engine | grep -q '"msg":"migrations applied"' && fail "migrations ran again (should be a no-op)" || pass "migrations a no-op"
  [ "$(curl -s --max-time 5 -H "$AUTH" "${BASE}/api/state" | python3 -c "import json,sys; print(json.load(sys.stdin)['vault'])")" = "sealed" ] && pass "API says sealed" || fail "API does not say sealed"
}

case "${1:-}" in
  rpc-cut) drill_rpc_cut ;;
  db-stop) drill_db_stop ;;
  restart) drill_restart ;;
  restart-check) drill_restart_check ;;
  all) drill_rpc_cut; drill_db_stop; echo "now run: ./drill.sh restart" ;;
  *) echo "usage: $0 rpc-cut | db-stop | restart | restart-check | all"; exit 2 ;;
esac
exit $FAILED
