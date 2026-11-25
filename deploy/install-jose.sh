#!/usr/bin/env bash
set -Eeuo pipefail
trap 'rc=$?; echo "JOSE install failed on line $LINENO (exit $rc)" >&2' ERR
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
node_binary="${JOSE_NODE_BINARY:-/usr/bin/node}"
[[ "$node_binary" = /* && -x "$node_binary" ]] || { echo 'Set JOSE_NODE_BINARY to an absolute Node 22+ executable path.' >&2; exit 1; }
"$node_binary" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
command -v systemctl >/dev/null
install -d -m 0755 /opt/a2z-jose/jose /opt/a2z-jose/netlify/functions/lib /etc/a2z-jose
ln -sfn "$node_binary" /opt/a2z-jose/node
install -m 0644 "$root"/jose/{runtime,providers}.mjs /opt/a2z-jose/jose/
install -m 0644 "$root"/netlify/functions/lib/{jose-relay,jarvis-store}.mjs /opt/a2z-jose/netlify/functions/lib/
install -m 0644 "$root/deploy/systemd/a2z-jose.service" /etc/systemd/system/
if [[ ! -e /etc/a2z-jose/runtime.env ]]; then
  install -m 0600 "$root/jose/runtime.env.example" /etc/a2z-jose/runtime.env
fi
if [[ ! -e /etc/a2z-jose/config.json ]]; then
  install -m 0644 "$root/jose/config.example.json" /etc/a2z-jose/config.json
fi
systemctl daemon-reload
echo 'Set /etc/a2z-jose/runtime.env and review config.json before enabling a2z-jose.service.'
