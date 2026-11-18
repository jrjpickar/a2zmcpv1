#!/usr/bin/env bash
# One command redeploy on the VM: pull code, rebuild, restart, wait for health.  Usage: ./deploy.sh
# Runs only when you call it. Nothing pulls images or code on a schedule.
set -Eeuo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "ERROR: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc)" >&2' ERR
cd "$(dirname "$0")"
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
[ -f .env ] || { echo "Missing .env. Run deploy/bootstrap-vm.sh first."; exit 1; }
if [ -d .git ]; then git pull --ff-only; else echo "No git checkout here. Sync with deploy/push.sh from your computer, then rerun."; fi
$DOCKER compose build --pull
$DOCKER compose up -d --remove-orphans
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "Healthy after $((i * 2))s"; $DOCKER compose ps; $DOCKER image prune -f >/dev/null; $DOCKER builder prune -f >/dev/null; exit 0
  fi
  sleep 2
done
echo "Not healthy after 90s. Recent logs:"; $DOCKER compose logs --tail 40 a2z-mcp; exit 1
