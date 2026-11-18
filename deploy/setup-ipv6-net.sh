#!/usr/bin/env bash
# IPv6 only egress for the GCP VM (no public IPv4). Points DNS at the public nat64.net DNS64 resolvers so IPv4 only
# hosts such as github.com get synthesized IPv6 addresses routed through their NAT64 gateways. Persists across reboot.
# Cloudflare IPv6 DNS is the backup: hosts that publish IPv6 addresses (Cloudflare, Ubuntu mirrors, Google) keep
# resolving if nat64.net is down. IPv4 only hosts such as GitHub, and supabase.com, fail until it is back.
# Google internal names (metadata.google.internal and *.internal) stay on the metadata server on the interface, so the
# guest agent and OS Login keep working. Needs no downloads.
# Safe to rerun, including on a VM where these fixes were applied by hand: files are rewritten only when their content
# differs, old names are removed, and services restart only when something changed.  Usage: deploy/setup-ipv6-net.sh
set -Eeuo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "ERROR: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc)" >&2' ERR
NAT64_DNS="2a01:4f9:c010:3f02::1 2a00:1098:2c::1 2a01:4f8:c2c:123f::1"
BACKUP_DNS="2606:4700:4700::1111 2606:4700:4700::1001"
changed=0
# Writes stdin to a root owned file only when the content differs. Sets changed=1 when it writes.
put() {
  local target="$1" body
  body=$(cat)
  if [ -f "$target" ] && [ "$(sudo cat "$target")" = "$body" ]; then echo "unchanged: $target"; return 0; fi
  sudo install -d "$(dirname "$target")"
  printf '%s\n' "$body" | sudo tee "$target" >/dev/null
  echo "wrote: $target"; changed=1
}
drop() { if [ -e "$1" ]; then sudo rm -f "$1"; echo "removed old: $1"; changed=1; fi; }

# Rule for these scripts: run the command into a variable first, then filter it. A filter that exits early
# (awk exit, head, grep -q) in a pipe can SIGPIPE the producer, which pipefail and set -e turn into a silent exit.
dev_of() { awk '{for (i = 1; i <= NF; i++) if ($i == "dev") {print $(i + 1); exit}}' <<<"$1"; }
routes=$(ip -6 route show default)
IFACE=$(dev_of "$routes")
[ -n "$IFACE" ] || { routes=$(ip route show default); IFACE=$(dev_of "$routes"); }
[ -n "$IFACE" ] || { echo "No default route found."; exit 1; }
echo "Interface: $IFACE"
addrs=$(ip -6 addr show dev "$IFACE" scope global)
grep -q inet6 <<<"$addrs" || { echo "No global IPv6 address on $IFACE."; exit 1; }

# 1. Global resolvers for every domain. Named zz- so it loads after Google's gce-resolved.conf, and the empty DNS=
#    first clears the 169.254.169.254 entry that file adds. nat64.net first. resolved moves to the next server only
#    when the current one fails, so Cloudflare answers only while nat64.net does not. FallbackDNS alone would never
#    be used here, because resolved reads it only when no DNS server is configured. The a2z-healthcheck timer moves
#    back to nat64.net after an outage.
drop /etc/systemd/resolved.conf.d/10-a2z-nat64.conf
put /etc/systemd/resolved.conf.d/zz-a2z-nat64.conf <<CONF
[Resolve]
DNS=
DNS=$NAT64_DNS $BACKUP_DNS
FallbackDNS=$BACKUP_DNS
Domains=~.
DNSSEC=no
CONF

# 2. The interface keeps only Google internal names (~internal) on the metadata server and is never the default
#    DNS route. The drop-in attaches to the .network file netplan generates. Empty DNS= and Domains= first clear any
#    values from netplan or from earlier hand edits.
status=$(networkctl status "$IFACE" 2>/dev/null || true)
NETFILE=$(awk -F': ' '/Network File/ {print $2; exit}' <<<"$status")
NETFILE="${NETFILE##*/}"
[ -n "$NETFILE" ] || NETFILE="10-netplan-$IFACE.network"
echo "Network file: $NETFILE"
drop "/etc/systemd/network/$NETFILE.d/10-a2z-nat64.conf"
put "/etc/systemd/network/$NETFILE.d/zz-a2z-nat64.conf" <<'CONF'
[Network]
DNS=
DNS=169.254.169.254
Domains=
Domains=~internal
DNSDefaultRoute=false

[DHCPv4]
UseDNS=no
UseDomains=no

[DHCPv6]
UseDNS=no

[IPv6AcceptRA]
UseDNS=no
CONF
hosts=$(cat /etc/hosts)
grep -q 'metadata.google.internal' <<<"$hosts" || { echo '169.254.169.254 metadata.google.internal metadata' | sudo tee -a /etc/hosts >/dev/null; echo "added metadata.google.internal to /etc/hosts"; }

# 3. /etc/resolv.conf must use the systemd-resolved stub.
if [ "$(readlink -f /etc/resolv.conf)" != /run/systemd/resolve/stub-resolv.conf ]; then
  sudo ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf; echo "linked /etc/resolv.conf to the resolved stub"; changed=1
fi

# networkctl reload picks up the drop-in, reconfigure applies it to the interface without restarting networking.
apply_link() { sudo networkctl reload; sudo networkctl reconfigure "$IFACE"; sleep 2; }
# resolvectl default-route prints "Link 2 (ens4): no". Ubuntu 24.04 resolvectl status has no "Default Route" line,
# it shows "Protocols: -DefaultRoute" instead, so check this command, not the status text.
not_default_route() { local out; out=$(resolvectl default-route "$IFACE" 2>&1 || true); echo "resolvectl default-route $IFACE -> $out"; grep -q ': no$' <<<"$out"; }
if [ "$changed" = 1 ]; then
  apply_link
  sudo systemctl restart systemd-resolved
  sleep 3
else
  echo "Nothing changed. Services were not restarted."
fi

echo "== resolvectl"
resolvectl dns
resolvectl domain
link=$(resolvectl status "$IFACE")
grep -E 'Protocols|DNS Servers|DNS Domain' <<<"$link" || true
if ! not_default_route; then
  # Files were already correct (for example fixed by hand) but not applied to the link yet.
  echo "Applying the drop-in to $IFACE with networkctl reload and reconfigure."
  apply_link
  sudo systemctl restart systemd-resolved; sleep 3
  not_default_route || { echo "$IFACE is still a default DNS route."; exit 1; }
fi
echo "== github.com resolves to (synthesized) IPv6"
answer=$(resolvectl query --type=AAAA github.com)
sed -n '1,3p' <<<"$answer"
getent hosts metadata.google.internal
echo "== Checks"
curl -6 -sS -o /dev/null -w 'curl -6 https://github.com -> HTTP %{http_code} via %{remote_ip}\n' --max-time 20 https://github.com
git ls-remote https://github.com/git/git HEAD
echo "IPv6 egress through NAT64 works."
