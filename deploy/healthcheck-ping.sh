#!/usr/bin/env bash
# Installed as /usr/local/bin/a2z-healthcheck. Run every 5 minutes by a2z-healthcheck.timer.
# Checks the local /health. HTTP 200 pings HC_PING_URL. Anything else pings HC_PING_URL/fail.
# HC_PING_URL comes from the repo .env (EnvironmentFile in the unit) and is never printed.
set -Euo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "NOTE: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc), continuing" >&2' ERR
# DNS: if the Global Current DNS Server is not a nat64.net resolver (for example the Cloudflare backup after an outage,
# or 169.254.169.254), restart resolved so it starts again from nat64.net. If nat64.net is still down, it moves to
# the backup again within seconds.
NAT64_DNS="2a01:4f9:c010:3f02::1 2a00:1098:2c::1 2a01:4f8:c2c:123f::1"
resolver=$(resolvectl status 2>/dev/null || true)
current=$(awk '/^Global/ {g = 1} g && /Current DNS Server:/ {print $NF; exit}' <<<"$resolver")
if [ -n "$current" ] && [[ " $NAT64_DNS " != *" $current "* ]]; then
  systemctl restart systemd-resolved && echo "DNS was on $current, not nat64.net. Restarted resolved."
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8080/health || true)   # 000 when down
case "${HC_PING_URL:-}" in
  https://hc-ping.com/?*) ;;
  "") echo "health HTTP $code. HC_PING_URL is not set in .env, so nothing was sent."; exit 0;;
  *) echo "health HTTP $code. HC_PING_URL must start with https://hc-ping.com/"; exit 1;;
esac
URL="${HC_PING_URL%/}"
if [ "$code" = 200 ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$URL" && echo "health HTTP 200, success ping sent" || { echo "health HTTP 200, success ping failed"; exit 1; }
else
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "local /health returned HTTP $code" "$URL/fail" && echo "health HTTP $code, fail ping sent" || { echo "health HTTP $code, fail ping failed"; exit 1; }
fi
