#!/usr/bin/env bash
set -Eeuo pipefail
trap 'rc=$?; echo "JOSE install failed on line $LINENO (exit $rc)" >&2' ERR
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
/usr/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
command -v systemctl >/dev/null
install -d -m 0755 /opt/a2z-jose /etc/a2z-jose
install -m 0644 "$root"/jose/{runtime,providers}.mjs /opt/a2z-jose/
install -m 0644 "$root/deploy/systemd/a2z-jose.service" /etc/systemd/system/
if [[ ! -e /etc/a2z-jose/runtime.env ]]; then
  install -m 0600 "$root/jose/runtime.env.example" /etc/a2z-jose/runtime.env
fi
if [[ ! -e /etc/a2z-jose/config.json ]]; then
  install -m 0644 "$root/jose/config.example.json" /etc/a2z-jose/config.json
fi
systemctl daemon-reload
echo 'Set /etc/a2z-jose/runtime.env and review config.json before enabling a2z-jose.service.'
