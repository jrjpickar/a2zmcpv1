#!/usr/bin/env bash
# Run on your own computer to copy this repo to the VM over IAP (the VM has no public IPv4).
# Usage: deploy/push.sh [instance] [zone] [remote_dir]     defaults: a2z-mcp us-west1-b a2z-mcp
# Connects as ubuntu@<instance> with --ssh-key-file ~/.ssh/a2z-gcp (override with A2Z_SSH_KEY).
# Keeps the VM's .env. Needs the gcloud CLI signed in to the project.
set -Eeuo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "ERROR: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc)" >&2' ERR
INSTANCE="${1:-a2z-mcp}"; ZONE="${2:-us-west1-b}"; DIR="${3:-a2z-mcp}"
KEY="${A2Z_SSH_KEY:-$HOME/.ssh/a2z-gcp}"
[ -f "$KEY" ] || { echo "SSH key not found: $KEY"; exit 1; }
cd "$(dirname "$0")/.."
# macOS tar adds ._* AppleDouble files for any file with extended attributes (for example quarantine on unzipped downloads).
# Node then loads netlify/functions/._*.mjs and crashes. Stop tar from making them and skip any that exist.
export COPYFILE_DISABLE=1
tar czf - --exclude=node_modules --exclude=.git --exclude=./.env --exclude=.a2z-jarvis-local --exclude=data --exclude='._*' --exclude=.DS_Store . \
  | gcloud compute ssh "ubuntu@$INSTANCE" --zone "$ZONE" --tunnel-through-iap --ssh-key-file "$KEY" \
      --command "mkdir -p '$DIR' && tar xzf - -C '$DIR' && find '$DIR' -name '._*' -type f -delete && echo 'Synced to ~/$DIR'"
