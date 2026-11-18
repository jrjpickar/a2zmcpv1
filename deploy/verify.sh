#!/usr/bin/env bash
# Deployment checks with evidence for the e2-micro VM (IPv6 only egress through NAT64). Run from the repo folder, before and after "sudo reboot":
#   deploy/verify.sh
# Includes a DNS failover test: it blocks the nat64.net resolvers for a few seconds, checks that names with IPv6 records
# still resolve through the Cloudflare backup, then removes the block and confirms nat64.net is back.
# Exit code 0 only when every check passes.
set -Euo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "NOTE: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc), continuing" >&2' ERR
cd "$(dirname "$0")/.."
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
command -v docker >/dev/null || echo "NOTE: Docker is not installed. Run deploy/bootstrap-vm.sh first. Docker, swap, ufw and timer checks will fail."
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf 'PASS  %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL  %s\n' "$1"; }
show() { printf '$ %s\n' "$*"; }

echo "== Host"
show uptime -s; uptime -s
show uname -m; uname -m

echo; echo "== Came back on their own after boot"
s=$($DOCKER inspect -f '{{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}} started={{.State.StartedAt}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} log={{.HostConfig.LogConfig.Type}} {{.HostConfig.LogConfig.Config}}' a2z-mcp 2>&1)
show docker inspect a2z-mcp; echo "$s"
[[ "$s" == running\ restart=unless-stopped* && "$s" == *health=healthy* ]] && ok "a2z-mcp running, healthy, restart=unless-stopped" || bad "a2z-mcp: $s"
[[ "$s" == *max-file:3* && "$s" == *max-size:10m* ]] && ok "log rotation 10m x 3" || bad "log rotation not set"
for u in docker unattended-upgrades a2z-healthcheck.timer; do
  e=$(systemctl is-enabled "$u" 2>/dev/null); a=$(systemctl is-active "$u" 2>/dev/null)
  echo "$u: enabled=$e active=$a"
  [ "$e" = enabled ] && [ "$a" = active ] && ok "$u enabled and active" || bad "$u enabled=$e active=$a"
done

echo; echo "== /health and Healthchecks.io"
code=$(curl -sS -o /tmp/a2z-health -w '%{http_code}' http://127.0.0.1:8080/health); echo "local GET /health -> $code $(cat /tmp/a2z-health)"
[ "$code" = 200 ] && ok "/health 200" || bad "/health $code"
case "$(grep -E '^HC_PING_URL=' .env | cut -d= -f2-)" in
  https://hc-ping.com/?*) ok "HC_PING_URL set in .env (value hidden)";;
  *) bad "HC_PING_URL missing or not https://hc-ping.com/...";;
esac
show systemctl list-timers a2z-healthcheck.timer; systemctl list-timers a2z-healthcheck.timer --no-pager | sed -n '1,2p'
sudo systemctl start a2z-healthcheck.service
r=$(systemctl show a2z-healthcheck.service -p Result --value)
show journalctl -u a2z-healthcheck -n 3; sudo journalctl -u a2z-healthcheck.service -n 3 --no-pager -o short-iso | grep -v '^--'
journal=$(sudo journalctl -u a2z-healthcheck.service -n 20 --no-pager -o cat)
last=$(grep -E '^health HTTP' <<<"$journal" | tail -n 1)
[ "$r" = success ] && [[ "$last" == "health HTTP 200, success ping sent" ]] && ok "health check ran and pinged Healthchecks.io" || bad "health check: result=$r last='$last'"

echo; echo "== Network: DNS64/NAT64 on the host"
show resolvectl dns; resolvectl dns
show resolvectl domain; resolvectl domain
dns_now=$(resolvectl dns)
grep -q '2a01:4f9:c010:3f02::1' <<<"$dns_now" && ok "NAT64 resolvers active in systemd-resolved" || bad "NAT64 resolvers not active"
[ -f /etc/systemd/resolved.conf.d/zz-a2z-nat64.conf ] && ok "resolver config persisted (zz-a2z-nat64.conf)" || bad "resolver config missing"
[ ! -e /etc/systemd/resolved.conf.d/10-a2z-nat64.conf ] && ok "old 10-a2z-nat64.conf removed" || bad "old 10-a2z-nat64.conf still present"
iface_status=$(resolvectl status ens4 2>&1 || true)
grep -E 'Protocols|DNS Servers|DNS Domain' <<<"$iface_status" || true
# Ubuntu 24.04 shows "Protocols: -DefaultRoute" in status. resolvectl default-route prints "Link 2 (ens4): no".
show resolvectl default-route ens4; default_route=$(resolvectl default-route ens4 2>&1 || true); echo "$default_route"
grep -q ': no$' <<<"$default_route" && ok "ens4 is not a default DNS route (DNSDefaultRoute=false)" || bad "ens4 is still a default DNS route"
grep -q '~internal' <<<"$iface_status" && ok "ens4 keeps ~internal on the metadata server" || bad "ens4 lost ~internal"
global_status=$(resolvectl status 2>&1 || true)
current=$(awk '/^Global/ {g = 1} g && /Current DNS Server:/ {print $NF; exit}' <<<"$global_status")
echo "Global Current DNS Server: ${current:-none}"
[[ " 2a01:4f9:c010:3f02::1 2a00:1098:2c::1 2a01:4f8:c2c:123f::1 " == *" $current "* && -n "$current" ]] && ok "Global current DNS server is nat64.net" || bad "Global current DNS server is ${current:-none}, not nat64.net"
show curl -6 https://github.com
out=$(curl -6 -sS -o /dev/null -w 'HTTP %{http_code} via %{remote_ip}' --max-time 20 https://github.com 2>&1); echo "$out"
[[ "$out" == HTTP\ 2* || "$out" == HTTP\ 3* ]] && ok "curl -6 https://github.com" || bad "curl -6 github: $out"
show git ls-remote https://github.com/git/git HEAD
out=$(timeout 30 git ls-remote https://github.com/git/git HEAD 2>&1); echo "$out"
[[ "$out" =~ ^[0-9a-f]{40}[[:space:]]HEAD ]] && ok "git ls-remote over NAT64" || bad "git ls-remote failed"
getent hosts metadata.google.internal >/dev/null && ok "metadata.google.internal still resolves" || bad "metadata.google.internal does not resolve"

echo; echo "== DNS failover: nat64.net blocked, Cloudflare backup answers"
NAT64=(2a01:4f9:c010:3f02::1 2a00:1098:2c::1 2a01:4f8:c2c:123f::1)
unblock() { for ip in "${NAT64[@]}"; do for p in udp tcp; do sudo ip6tables -D OUTPUT -d "$ip" -p "$p" --dport 53 -j REJECT 2>/dev/null; done; done; }
trap 'unblock; sudo systemctl restart systemd-resolved' EXIT
for ip in "${NAT64[@]}"; do for p in udp tcp; do sudo ip6tables -I OUTPUT -d "$ip" -p "$p" --dport 53 -j REJECT; done; done
sudo resolvectl flush-caches
resolved=0
# Names that publish IPv6 (AAAA) records. supabase.com has none, so it can never answer AAAA through Cloudflare.
for name in cloudflare.com archive.ubuntu.com www.google.com; do
  if out=$(resolvectl query --cache=no --type=AAAA "$name" 2>&1); then resolved=$((resolved + 1)); echo "blocked: ${out%%$'\n'*}"; else echo "blocked: $name FAILED: ${out%%$'\n'*}"; fi
done
current_dns() { local st; st=$(resolvectl status 2>&1 || true); awk -v tag="$1" '/^Global/ {g = 1} g && /Current DNS Server:/ {print tag ": " $0; exit}' <<<"$st"; }
current_dns blocked
unblock
sudo systemctl restart systemd-resolved; sleep 2
trap - EXIT
[ "$resolved" = 3 ] && ok "names with IPv6 records resolve with nat64.net blocked" || bad "only $resolved of 3 names resolved with nat64.net blocked"
rules=$(sudo ip6tables -S OUTPUT)
grep -q -- '--dport 53 -j REJECT' <<<"$rules" && bad "temporary DNS block still present" || ok "temporary DNS block removed"
out=$(resolvectl query --cache=no --type=AAAA github.com 2>&1); out="${out%%$'\n'*}"; echo "restored: $out"
current_dns restored
# systemd 255 prints "github.com IN AAAA <address> -- link: ens4".
[[ "$out" =~ ^github\.com[:[:space:]].*AAAA ]] && ok "nat64.net back in use (github.com resolves to IPv6 again)" || bad "github.com does not resolve after restore"

echo; echo "== Network: from inside the container (IPv6)"
show docker exec a2z-mcp node reachability check
$DOCKER exec a2z-mcp node --input-type=module -e '
const env = process.env;
const targets = [
  ["GitHub", "https://github.com", {}],
  ["Groq API", "https://api.groq.com/openai/v1/models", env.GROQ_API_KEY ? { authorization: "Bearer " + env.GROQ_API_KEY } : {}],
  ["Supabase", env.SUPABASE_URL ? env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" : "", env.SUPABASE_KEY ? { apikey: env.SUPABASE_KEY, authorization: "Bearer " + env.SUPABASE_KEY } : {}],
];
let failed = 0;
for (const [name, url, headers] of targets) {
  if (!url) { console.log(name + ": SKIP (SUPABASE_URL not set)"); continue; }
  const started = Date.now();
  try {
    const r = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
    await r.body?.cancel();
    console.log(name + ": reachable, HTTP " + r.status + " in " + (Date.now() - started) + " ms");
  } catch (e) {
    failed++;
    console.log(name + ": UNREACHABLE " + (e.cause?.code || e.message));
  }
}
process.exit(failed ? 1 : 0);
' && ok "GitHub, Groq API and Supabase reachable from the container" || bad "a host is unreachable from the container"
show docker inspect a2z-mcp networks
$DOCKER inspect -f '{{range .NetworkSettings.Networks}}IPv4 {{.IPAddress}}  IPv6 {{.GlobalIPv6Address}}{{end}}' a2z-mcp

echo; echo "== Memory"
show free -m; free -m
swap=$(free -m | awk '/^Swap:/ {print $2}')
[ "${swap:-0}" -ge 1900 ] && ok "swap ${swap} MB active" || bad "swap ${swap:-0} MB"
show cat /proc/sys/vm/swappiness; cat /proc/sys/vm/swappiness
[ "$(cat /proc/sys/vm/swappiness)" = 10 ] && ok "swappiness 10" || bad "swappiness $(cat /proc/sys/vm/swappiness)"
grep -q '^/swapfile ' /etc/fstab && ok "swap in /etc/fstab" || bad "swap missing from /etc/fstab"
show docker stats --no-stream; $DOCKER stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.CPUPerc}}'
usage=$($DOCKER stats --no-stream --format '{{.MemUsage}}' a2z-mcp 2>/dev/null || true)
used=""; limit=""
[[ "$usage" == */* ]] && read -r used limit < <(python3 -c '
import re,sys
u={"B":1,"KiB":1024,"MiB":1024**2,"GiB":1024**3,"kB":1e3,"MB":1e6,"GB":1e9}
a,b=[x.strip() for x in sys.stdin.read().split("/")]
f=lambda s: float(re.match(r"[\d.]+",s).group())*u[re.search(r"[A-Za-z]+",s).group()]
print(int(f(a)/2**20), int(f(b)/2**20))' <<<"$usage")
echo "a2z-mcp uses ${used} MiB of a ${limit} MiB limit"
[[ "$limit" =~ ^[0-9]+$ && "$used" =~ ^[0-9]+$ ]] && [ "$limit" -le 600 ] && [ "$used" -lt "$limit" ] && ok "container memory ${used} MiB under the ${limit} MiB limit" || bad "container memory ${used}/${limit} MiB"

echo; echo "== Exposure and SSH"
show ss -tlnp; sudo ss -tlnp | awk 'NR == 1 || /:(22|8080) /'
listening=$(sudo ss -tln)
grep -qE '(0\.0\.0\.0|\[::\]|\*):8080 ' <<<"$listening" && bad "8080 is exposed" || ok "8080 bound to loopback only"
show ufw status verbose; sudo ufw status verbose | sed -n '1,10p'
fw=$(sudo ufw status)
grep -q 'Status: active' <<<"$fw" && ok "ufw active" || bad "ufw inactive"
sshd=$(sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication) '); echo "$sshd"
grep -qi '^passwordauthentication no' <<<"$sshd" && grep -qi '^pubkeyauthentication yes' <<<"$sshd" && ok "SSH key only" || bad "SSH password login not disabled"

echo; echo "Result: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
