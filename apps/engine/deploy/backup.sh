#!/bin/sh
# Nightly pg_dump into the backups volume, prune old ones, ping the backup
# dead-man check. Runs inside the timescaledb image so pg_dump matches.
set -eu
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
while :; do
  now=$(date -u +%Y%m%dT%H%M%SZ)
  out="/backups/wick-$now.dump"
  if pg_dump -h db -U wick -d wick -Fc -Z 6 -f "$out"; then
    echo "backup ok $out $(du -h "$out" | cut -f1)"
    find /backups -name 'wick-*.dump' -mtime +"$KEEP_DAYS" -delete
    if [ -n "${HEALTHCHECK_BACKUP_URL:-}" ]; then
      wget -qO- --post-data "ok $out" "$HEALTHCHECK_BACKUP_URL" >/dev/null 2>&1 || true
    fi
  else
    echo "backup FAILED"
    if [ -n "${HEALTHCHECK_BACKUP_URL:-}" ]; then
      wget -qO- --post-data "failed" "$HEALTHCHECK_BACKUP_URL/fail" >/dev/null 2>&1 || true
    fi
  fi
  # Restore drill: pg_restore -h db -U wick -d wick_restore -c /backups/<file>
  sleep 86400
done
