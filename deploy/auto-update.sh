#!/usr/bin/env bash
# Keeps the VM on the same commit as the published Netlify deploy. Run by a2z-auto-update.timer at 11 AM and 3 PM Pacific.
# The VM has no stable public address (Quick Tunnel names change), so it polls Netlify instead of receiving a webhook.
#   1. Read /version.json from the live Netlify site (written at build time by scripts/write-version.mjs). Exit if its
#      commit is the running one or the last failed one. A rollback in Netlify (publish an older deploy) is followed too.
#   2. Download that exact commit from GitHub and build it as a2z-mcp:candidate while the old container keeps serving.
#   3. Swap files and image, restart, wait for /health. On failure restore the old files and image and record the
#      commit as failed so it is not retried until a newer deploy is published.
# Settings: $A2Z_REPO/.autoupdate.env (mode 600, never passed to the container):
#   NETLIFY_SITE_URL (https://<site>.netlify.app), GITHUB_REPO (owner/name), GITHUB_TOKEN, optional HC_DEPLOY_PING_URL
# Run once by hand: sudo A2Z_REPO=/home/ubuntu/a2z-mcp /usr/local/bin/a2z-auto-update
set -Eeuo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "ERROR: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc)" >&2' ERR

REPO="${A2Z_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
CONF="$REPO/.autoupdate.env"
STATE="$REPO/.deploy-state"
TRIES="${A2Z_HEALTH_TRIES:-45}"
PAUSE="${A2Z_HEALTH_SLEEP:-2}"
INSTALL_PATH="${A2Z_INSTALL_PATH-/usr/local/bin/a2z-auto-update}"
# Never shipped from the repo and never deleted or overwritten here.
KEEP=(.env .autoupdate.env .deploy-state .git node_modules data .a2z-jarvis-local)

[ -f "$CONF" ] || { echo "Missing $CONF. Run deploy/setup-auto-update.sh first."; exit 1; }
set -a; # shellcheck disable=SC1090
. "$CONF"; set +a
for name in NETLIFY_SITE_URL GITHUB_REPO GITHUB_TOKEN; do
  [ -n "${!name:-}" ] || { echo "$name is empty in $CONF"; exit 1; }
done
[[ "$GITHUB_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "GITHUB_REPO must be owner/name"; exit 1; }
[[ "$NETLIFY_SITE_URL" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo "NETLIFY_SITE_URL must be https://host with no path"; exit 1; }

mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { echo "Another update is running."; exit 0; }
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

ping_hc() { # $1: "" for success or "/fail", $2: message
  [ -n "${HC_DEPLOY_PING_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 2 --data-raw "$2" "$HC_DEPLOY_PING_URL$1" >/dev/null || true
}

live=$(curl -fsS -m 20 -H 'Cache-Control: no-cache' "$NETLIFY_SITE_URL/version.json?t=$(date +%s)")
parsed=$(python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("commit") or "-", d.get("deployId") or "-")' <<<"$live")
read -r SHA DEPLOY_ID <<<"$parsed"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The live Netlify deploy ($DEPLOY_ID) has no commit (manual or CLI deploy). Nothing to follow."
  exit 0
fi
current=$(cat "$STATE/deployed" 2>/dev/null || true)
[ "$SHA" = "$current" ] && exit 0
if [ "$SHA" = "$(cat "$STATE/failed" 2>/dev/null || true)" ]; then
  echo "Commit ${SHA:0:7} failed before. Waiting for a newer published deploy."
  exit 0
fi
echo "Netlify published ${SHA:0:7} (deploy $DEPLOY_ID). VM runs ${current:0:7}. Updating."

WORK=$(mktemp -d)
swapped=0; done_ok=0; built=0
excludes=(); for item in "${KEEP[@]}"; do excludes+=(--exclude="./$item"); done

restore() {
  echo "Restoring ${current:0:7}."
  if [ -f "$STATE/new.manifest" ]; then
    while IFS= read -r file; do rm -f -- "$REPO/$file"; done < "$STATE/new.manifest"
  fi
  tar xzf "$STATE/previous.tgz" -C "$REPO" --no-same-owner
  if $DOCKER image inspect a2z-mcp:previous >/dev/null 2>&1; then
    $DOCKER image tag a2z-mcp:previous a2z-mcp:latest
    (cd "$REPO" && $DOCKER compose up -d --no-build --remove-orphans) || true
  fi
}
finish() {
  rc=$?
  if [ "$swapped" = 1 ] && [ "$done_ok" = 0 ]; then
    restore || echo "Restore failed. Run ./deploy.sh by hand." >&2
    echo "$SHA" > "$STATE/failed"
    ping_hc /fail "A2Z MCP update to ${SHA:0:7} failed and was rolled back."
  elif [ "$done_ok" = 0 ] && [ "$rc" != 0 ] && [ "$built" = 1 ]; then
    # The commit itself is bad (wrong tree or build error). Download or network errors are retried next run.
    echo "$SHA" > "$STATE/failed"
    ping_hc /fail "A2Z MCP update to ${SHA:0:7} failed to build. Nothing changed."
  fi
  rm -rf "$WORK"
}
trap finish EXIT

# 2. Download and build the exact commit. The live container keeps serving.
curl -fsSL -m 180 -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GITHUB_REPO/tarball/$SHA" -o "$WORK/src.tgz"
mkdir "$WORK/src"
tar xzf "$WORK/src.tgz" -C "$WORK/src" --strip-components=1 --no-same-owner
built=1
for item in "${KEEP[@]}"; do rm -rf -- "${WORK:?}/src/$item"; done
[ -f "$WORK/src/Dockerfile" ] && [ -f "$WORK/src/docker-compose.yml" ] && [ -f "$WORK/src/server/index.mjs" ] \
  || { echo "Commit ${SHA:0:7} is not an A2Z MCP tree."; exit 1; }
$DOCKER build --pull -t a2z-mcp:candidate "$WORK/src"

# 3. Swap. Files that left the repo since the last update are removed; files never shipped by a deploy are kept.
(cd "$WORK/src" && find . -type f -printf '%P\n' | LC_ALL=C sort) > "$STATE/new.manifest"
tar czf "$STATE/previous.tgz" -C "$REPO" "${excludes[@]}" .
if $DOCKER image inspect a2z-mcp:latest >/dev/null 2>&1; then $DOCKER image tag a2z-mcp:latest a2z-mcp:previous; fi
swapped=1
if [ -f "$STATE/manifest" ]; then
  LC_ALL=C comm -23 "$STATE/manifest" "$STATE/new.manifest" > "$WORK/removed"
  while IFS= read -r file; do rm -f -- "$REPO/$file"; done < "$WORK/removed"
fi
tar cf - -C "$WORK/src" . | tar xf - -C "$REPO" --no-same-owner
if [ -n "${SUDO_UID:-}" ] || [ "$(id -u)" = 0 ]; then chown -R --reference="$REPO" "$REPO" 2>/dev/null || true; fi
$DOCKER image tag a2z-mcp:candidate a2z-mcp:latest
(cd "$REPO" && $DOCKER compose up -d --no-build --remove-orphans)

want=$($DOCKER image inspect -f '{{.Id}}' a2z-mcp:candidate)
for _ in $(seq 1 "$TRIES"); do
  running=$($DOCKER inspect -f '{{.Image}}' a2z-mcp 2>/dev/null || true)
  if [ "$running" = "$want" ] && curl -fsS -m 5 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    done_ok=1
    break
  fi
  sleep "$PAUSE"
done
if [ "$done_ok" != 1 ]; then
  echo "Not healthy on ${SHA:0:7}. Recent logs:"; $DOCKER compose -f "$REPO/docker-compose.yml" logs --tail 40 a2z-mcp || true
  exit 1
fi

mv "$STATE/new.manifest" "$STATE/manifest"
echo "$SHA" > "$STATE/deployed"
rm -f "$STATE/failed"
$DOCKER image prune -f >/dev/null || true
if [ -n "$INSTALL_PATH" ] && [ -f "$REPO/deploy/auto-update.sh" ]; then install -m 755 "$REPO/deploy/auto-update.sh" "$INSTALL_PATH" || true; fi
echo "Healthy on ${SHA:0:7}."
ping_hc "" "A2Z MCP updated to ${SHA:0:7} (Netlify deploy $DEPLOY_ID)."
