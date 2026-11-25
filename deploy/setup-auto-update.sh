#!/usr/bin/env bash
# Run once on the VM from the repo folder: sudo deploy/setup-auto-update.sh
# Writes .autoupdate.env (mode 600, root only, never given to the container), installs the 11 AM and 3 PM Pacific timer and runs it once.
# Safe to rerun: keeps an existing .autoupdate.env unless you pass --reset.
set -Eeuo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "ERROR: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc)" >&2' ERR
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
cd "$(dirname "$0")/.."
REPO=$(pwd)
CONF="$REPO/.autoupdate.env"
[ -f docker-compose.yml ] && [ -f .env ] || { echo "Run deploy/bootstrap-vm.sh first."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required."; exit 1; }

if [ ! -f "$CONF" ] || [ "${1:-}" = "--reset" ]; then
  ask() { local v; read -rp "$1: " v; printf '%s' "$v"; }
  ask_secret() { local v; read -rsp "$1 (hidden): " v; echo >&2; printf '%s' "$v"; }
  SITE=$(ask "NETLIFY_SITE_URL, the A2Z MCP production URL, for example https://a2zmcp.netlify.app")
  GREPO=$(ask "GITHUB_REPO as owner/name")
  GTOKEN=$(ask_secret "GITHUB_TOKEN (fine-grained, this repo only, Contents: Read-only)")
  HCD=$(ask_secret "HC_DEPLOY_PING_URL, a separate Healthchecks.io check, blank to skip")
  for v in "$SITE" "$GREPO" "$GTOKEN" "$HCD"; do case "$v" in *$'\n'*|*' '*) echo "Values cannot contain spaces or newlines."; exit 1;; esac; done
  [[ "$SITE" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo "NETLIFY_SITE_URL must be https://host with no path."; exit 1; }
  [[ "$GREPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "GITHUB_REPO must be owner/name."; exit 1; }
  ( umask 077
    printf 'NETLIFY_SITE_URL=%s\nGITHUB_REPO=%s\nGITHUB_TOKEN=%s\nHC_DEPLOY_PING_URL=%s\n' "$SITE" "$GREPO" "$GTOKEN" "$HCD" > "$CONF" )
  chown root:root "$CONF"; chmod 600 "$CONF"
  unset GTOKEN HCD
  echo "$CONF written (mode 600, root only). No values were printed."
fi

# Check both tokens before installing anything.
set -a; . "$CONF"; set +a
python3 -c 'import json, sys; json.load(sys.stdin)["commit"]' < <(curl -fsS -m 20 "$NETLIFY_SITE_URL/version.json") \
  || { echo "$NETLIFY_SITE_URL/version.json is missing. Deploy this commit to Netlify first."; exit 1; }
curl -fsS -m 20 -o /dev/null -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$GITHUB_REPO" \
  || { echo "GitHub rejected the repo or token."; exit 1; }
echo "Netlify version.json and GitHub access verified."

mkdir -p .deploy-state
install -m 755 deploy/auto-update.sh /usr/local/bin/a2z-auto-update
sed "s|@REPO@|$REPO|" deploy/systemd/a2z-auto-update.service > /etc/systemd/system/a2z-auto-update.service
install -m 644 deploy/systemd/a2z-auto-update.timer /etc/systemd/system/a2z-auto-update.timer
systemctl daemon-reload
systemctl enable --now a2z-auto-update.timer
echo "Running the first check now (a first update builds the image, a few minutes on this VM)."
systemctl start a2z-auto-update.service || true
journalctl -u a2z-auto-update.service -n 20 --no-pager -o cat
systemctl list-timers a2z-auto-update.timer --no-pager
