#!/usr/bin/env bash
# Watchdog Sidour backend (Oracle) :
# - sonde /health avec timeout strict
# - mesure load / CPU uvicorn
# - restart forcé (SIGKILL) si bloqué ou surcharge + latence
# - anti-flapping + statut JSON consultable
set -u

SERVICE="${SERVICE:-sidour-backend}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/health}"
LOG="${LOG:-/var/log/sidour-backend-watchdog.log}"
STATUS_JSON="${STATUS_JSON:-/var/lib/sidour/watchdog-status.json}"
STATE_FILE="${STATE_FILE:-/var/lib/sidour/watchdog-state}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"
MAX_TIME="${MAX_TIME:-5}"
SLOW_HEALTH_SEC="${SLOW_HEALTH_SEC:-2}"
LOAD_MULT="${LOAD_MULT:-4}"
MAX_RESTARTS_WINDOW="${MAX_RESTARTS_WINDOW:-3}"
WINDOW_SEC="${WINDOW_SEC:-1800}"
SCRIPT_DEADLINE_SEC="${SCRIPT_DEADLINE_SEC:-45}"
POST_START_WAIT_SEC="${POST_START_WAIT_SEC:-4}"

mkdir -p "$(dirname "$STATUS_JSON")" "$(dirname "$STATE_FILE")" 2>/dev/null || true
touch "$LOG" 2>/dev/null || true

STARTED_AT=$(date +%s)

log() {
  echo "$(date -Is) $*" | tee -a "$LOG" >/dev/null
  echo "$(date -Is) $*"
}

deadline_exceeded() {
  local now
  now=$(date +%s)
  [[ $((now - STARTED_AT)) -ge "$SCRIPT_DEADLINE_SEC" ]]
}

nproc_count() {
  nproc 2>/dev/null || echo 1
}

read_load1() {
  # /proc/loadavg : "1.23 0.45 ..."
  awk '{print $1}' /proc/loadavg 2>/dev/null || echo "0"
}

mem_available_mb() {
  awk '/MemAvailable:/ {printf "%.0f", $2/1024; exit}' /proc/meminfo 2>/dev/null || echo "0"
}

uvicorn_pid() {
  systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || echo "0"
}

uvicorn_cpu_mem() {
  local pid="$1"
  if [[ -z "$pid" || "$pid" == "0" ]] || ! [[ -r "/proc/$pid/stat" ]]; then
    echo "0 0"
    return
  fi
  # ps: cpu% and rss (KB)
  ps -p "$pid" -o pcpu= -o rss= 2>/dev/null | awk '{printf "%.1f %.0f", $1+0, ($2+0)/1024}' || echo "0 0"
}

write_status() {
  local state="$1"
  local reason="$2"
  local load1="$3"
  local cpu="$4"
  local rss_mb="$5"
  local health_ms="$6"
  local health_code="$7"
  local last_restart_at="${8:-}"
  local now_iso
  now_iso=$(date -Is)
  local ncpu
  ncpu=$(nproc_count)
  local mem_mb
  mem_mb=$(mem_available_mb)
  local active
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    active="true"
  else
    active="false"
  fi

  # Escape reason for JSON (minimal)
  local reason_json
  reason_json=$(printf '%s' "$reason" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "${reason//\"/\\\"}")

  local tmp_json
  tmp_json=$(mktemp)
  cat >"$tmp_json" <<EOF
{
  "state": "$state",
  "reason": $reason_json,
  "last_check": "$now_iso",
  "last_restart_at": $(if [[ -n "$last_restart_at" ]]; then printf '"%s"' "$last_restart_at"; else echo null; fi),
  "load1": $load1,
  "nproc": $ncpu,
  "load_threshold": $(awk -v n="$ncpu" -v m="$LOAD_MULT" 'BEGIN{printf "%.2f", n*m}'),
  "uvicorn_cpu": $cpu,
  "uvicorn_rss_mb": $rss_mb,
  "mem_available_mb": $mem_mb,
  "health_ms": $health_ms,
  "health_code": $health_code,
  "service_active": $active,
  "service": "$SERVICE"
}
EOF
  mv "$tmp_json" "$STATUS_JSON"
}

count_recent_restarts() {
  local now cutoff count=0 ts
  now=$(date +%s)
  cutoff=$((now - WINDOW_SEC))
  if [[ ! -f "$STATE_FILE" ]]; then
    echo 0
    return
  fi
  while read -r ts; do
    [[ -z "$ts" ]] && continue
    if [[ "$ts" =~ ^[0-9]+$ ]] && [[ "$ts" -ge "$cutoff" ]]; then
      count=$((count + 1))
    fi
  done <"$STATE_FILE"
  echo "$count"
}

record_restart() {
  local now
  now=$(date +%s)
  local cutoff=$((now - WINDOW_SEC))
  local tmp
  tmp=$(mktemp)
  if [[ -f "$STATE_FILE" ]]; then
    while read -r ts; do
      [[ -z "$ts" ]] && continue
      if [[ "$ts" =~ ^[0-9]+$ ]] && [[ "$ts" -ge "$cutoff" ]]; then
        echo "$ts" >>"$tmp"
      fi
    done <"$STATE_FILE"
  fi
  echo "$now" >>"$tmp"
  mv "$tmp" "$STATE_FILE"
}

probe_health() {
  # Sets globals: HEALTH_CODE HEALTH_MS
  local start end out code
  start=$(date +%s%3N 2>/dev/null || date +%s)
  out=$(curl -sS -o /dev/null -w "%{http_code}" \
    --connect-timeout "$CONNECT_TIMEOUT" \
    --max-time "$MAX_TIME" \
    "$HEALTH_URL" 2>/dev/null) || out="000"
  end=$(date +%s%3N 2>/dev/null || date +%s)
  code="$out"
  if [[ ! "$code" =~ ^[0-9]+$ ]]; then
    code="000"
  fi
  HEALTH_CODE="$code"
  # Prefer ms; fallback seconds*1000
  if [[ "$start" == *[^0-9]* || "$end" == *[^0-9]* ]]; then
    HEALTH_MS=$((MAX_TIME * 1000))
  else
    HEALTH_MS=$((end - start))
    # if date +%s only (seconds), scale
    if [[ ${#start} -le 10 ]]; then
      HEALTH_MS=$((HEALTH_MS * 1000))
    fi
  fi
}

force_restart() {
  local reason="$1"
  local recent
  recent=$(count_recent_restarts)
  if [[ "$recent" -ge "$MAX_RESTARTS_WINDOW" ]]; then
    log "ECHEC_COOLDOWN: $recent restarts in ${WINDOW_SEC}s — skip ($reason)"
    write_status "down" "cooldown:$reason" "$LOAD1" "$CPU" "$RSS_MB" "$HEALTH_MS" "$HEALTH_CODE" "${LAST_RESTART_ISO:-}"
    return 1
  fi

  log "RESTART: $reason"
  write_status "restarting" "$reason" "$LOAD1" "$CPU" "$RSS_MB" "$HEALTH_MS" "$HEALTH_CODE" "${LAST_RESTART_ISO:-}"

  # Kill hung workers first — plain restart can hang 90s+
  sudo systemctl kill -s SIGKILL "$SERVICE" 2>/dev/null || true
  sleep 1
  sudo systemctl reset-failed "$SERVICE" 2>/dev/null || true
  sudo systemctl start "$SERVICE" 2>/dev/null || sudo systemctl restart "$SERVICE" 2>/dev/null || true

  record_restart
  LAST_RESTART_ISO=$(date -Is)

  sleep "$POST_START_WAIT_SEC"
  probe_health
  local pid
  pid=$(uvicorn_pid)
  read -r CPU RSS_MB <<<"$(uvicorn_cpu_mem "$pid")"
  LOAD1=$(read_load1)

  if systemctl is-active --quiet "$SERVICE" 2>/dev/null && [[ "$HEALTH_CODE" == "200" ]]; then
    log "OK apres restart ($reason) health=${HEALTH_MS}ms"
    write_status "ok" "restarted:$reason" "$LOAD1" "$CPU" "$RSS_MB" "$HEALTH_MS" "$HEALTH_CODE" "$LAST_RESTART_ISO"
    return 0
  fi

  log "ECHEC: toujours down apres restart ($reason) code=$HEALTH_CODE"
  write_status "down" "restart_failed:$reason" "$LOAD1" "$CPU" "$RSS_MB" "$HEALTH_MS" "$HEALTH_CODE" "$LAST_RESTART_ISO"
  sudo journalctl -u "$SERVICE" -n 30 --no-pager >>"$LOG" 2>&1 || true
  return 1
}

# ---- main ----
LOAD1=$(read_load1)
NCPU=$(nproc_count)
LOAD_THRESHOLD=$(awk -v n="$NCPU" -v m="$LOAD_MULT" 'BEGIN{printf "%.2f", n*m}')
PID=$(uvicorn_pid)
read -r CPU RSS_MB <<<"$(uvicorn_cpu_mem "$PID")"
LAST_RESTART_ISO=""
if [[ -f "$STATE_FILE" ]]; then
  last_ts=$(tail -n 1 "$STATE_FILE" 2>/dev/null || true)
  if [[ "$last_ts" =~ ^[0-9]+$ ]]; then
    LAST_RESTART_ISO=$(date -Is -d "@$last_ts" 2>/dev/null || true)
  fi
fi

SERVICE_ACTIVE=0
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  SERVICE_ACTIVE=1
fi

probe_health

if deadline_exceeded; then
  log "ECHEC: deadline script avant decision"
  write_status "degraded" "deadline" "$LOAD1" "$CPU" "$RSS_MB" "$HEALTH_MS" "$HEALTH_CODE" "${LAST_RESTART_ISO:-}"
  exit 1
fi

NEED_RESTART=0
REASON=""

if [[ "$SERVICE_ACTIVE" -ne 1 ]]; then
  NEED_RESTART=1
  REASON="service_inactive"
elif [[ "$HEALTH_CODE" != "200" ]]; then
  NEED_RESTART=1
  REASON="health_fail:$HEALTH_CODE"
else
  # surcharge + latence
  OVERLOADED=$(awk -v l="$LOAD1" -v t="$LOAD_THRESHOLD" 'BEGIN{print (l+0 > t+0) ? 1 : 0}')
  SLOW_MS=$((SLOW_HEALTH_SEC * 1000))
  if [[ "$OVERLOADED" == "1" && "$HEALTH_MS" -ge "$SLOW_MS" ]]; then
    NEED_RESTART=1
    REASON="overload_slow:load=${LOAD1}>${LOAD_THRESHOLD},health_ms=${HEALTH_MS}"
  fi
fi

if [[ "$NEED_RESTART" -eq 1 ]]; then
  log "ALERTE: $REASON load1=$LOAD1 cpu=$CPU% rss=${RSS_MB}MB health=${HEALTH_MS}ms code=$HEALTH_CODE"
  force_restart "$REASON"
  exit $?
fi

# Healthy — maybe note mild overload without restart
OVERLOADED=$(awk -v l="$LOAD1" -v t="$LOAD_THRESHOLD" 'BEGIN{print (l+0 > t+0) ? 1 : 0}')
if [[ "$OVERLOADED" == "1" ]]; then
  log "DEGRADED: load1=$LOAD1>${LOAD_THRESHOLD} but health ok (${HEALTH_MS}ms)"
  write_status "degraded" "high_load" "$LOAD1" "$CPU" "$RSS_MB" "$HEALTH_MS" "$HEALTH_CODE" "${LAST_RESTART_ISO:-}"
  exit 0
fi

log "OK health=${HEALTH_MS}ms load1=$LOAD1 cpu=$CPU%"
write_status "ok" "healthy" "$LOAD1" "$CPU" "$RSS_MB" "$HEALTH_MS" "$HEALTH_CODE" "${LAST_RESTART_ISO:-}"
exit 0
