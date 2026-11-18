#!/usr/bin/env bash
# One time setup on the Google Cloud e2-micro VM (Ubuntu 24.04, x86_64, 1 GB RAM, no public IPv4, public IPv6).
# Connect with: gcloud compute ssh ubuntu@a2z-mcp --zone us-west1-b --tunnel-through-iap --ssh-key-file ~/.ssh/a2z-gcp
# Run from the repo folder:  deploy/bootstrap-vm.sh
# Sets DNS64/NAT64 first (deploy/setup-ipv6-net.sh) so IPv4 only hosts work. Then updates the system and turns on unattended upgrades, adds 2 GB swap (swappiness 10), installs Docker and git,
# sets SSH to key only, enables ufw with OpenSSH only, asks for GROQ_API_KEY, SUPABASE_URL, SUPABASE_KEY and HC_PING_URL
# without echoing them, starts the stack, and installs the 5 minute Healthchecks.io timer. Safe to rerun.
set -Eeuo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "ERROR: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc)" >&2' ERR
cd "$(dirname "$0")/.."
[ $# -eq 0 ] || { echo "Usage: deploy/bootstrap-vm.sh (no options)"; exit 1; }
REPO="$(pwd)"
step() { printf '\n== %s\n' "$1"; }
export DEBIAN_FRONTEND=noninteractive
APT=(sudo -E apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

step "Network: DNS64/NAT64 for IPv6 only egress"
deploy/setup-ipv6-net.sh

step "Swap (2 GB, swappiness 10)"
swaps=$(swapon --show=NAME --noheadings)
if ! grep -qx /swapfile <<<"$swaps"; then
  [ -f /swapfile ] || { sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; }
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-a2z-swap.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/99-a2z-swap.conf
swapon --show; cat /proc/sys/vm/swappiness

step "System update, unattended upgrades, packages"
"${APT[@]}" update
"${APT[@]}" upgrade
"${APT[@]}" install ca-certificates curl gnupg git ufw rsync openssl python3 unattended-upgrades >/dev/null
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
sudo systemctl enable --now unattended-upgrades
systemctl is-active unattended-upgrades

step "Docker (log rotation 10m x 3)"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  "${APT[@]}" update
  "${APT[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
sudo install -d /etc/docker
# IPv6 for containers (the VM has no IPv4 egress), NAT64 resolvers for container DNS, and log rotation.
sudo python3 - <<'PY'
import json, os
path = '/etc/docker/daemon.json'
conf = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) else {}
conf.update({
  'ipv6': True, 'ip6tables': True, 'fixed-cidr-v6': 'fd00:a2a2:0:1::/64',
  'dns': ['2a01:4f9:c010:3f02::1', '2a00:1098:2c::1', '2a01:4f8:c2c:123f::1', '2606:4700:4700::1111', '2606:4700:4700::1001'],
  'log-driver': 'json-file', 'log-opts': {'max-size': '10m', 'max-file': '3'},
})
json.dump(conf, open(path, 'w'), indent=2)
PY
cat /etc/docker/daemon.json
sudo systemctl enable docker containerd
sudo systemctl restart docker
sudo usermod -aG docker "$USER"
sudo docker version --format 'Docker {{.Server.Version}} on {{.Server.Arch}}'

step "SSH: key only"
keys_ok=0
[ -s "$HOME/.ssh/authorized_keys" ] && keys_ok=1
sshd_conf=$(sudo sshd -T)
grep -qi '^authorizedkeyscommand .*google' <<<"$sshd_conf" && keys_ok=1   # OS Login supplies keys
[ "$keys_ok" = 1 ] || { echo "No SSH key found for this user. Not disabling passwords, to avoid a lockout."; exit 1; }
sudo tee /etc/ssh/sshd_config.d/00-a2z-hardening.conf >/dev/null <<'CONF'
# Key only. Loads before other drop-ins, and sshd keeps the first value it reads.
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PermitEmptyPasswords no
CONF
sudo sshd -t
sudo systemctl reload ssh || sudo systemctl restart ssh
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin) '

step "Firewall (OpenSSH only)"
sudo ufw default deny incoming >/dev/null
sudo ufw default allow outgoing >/dev/null
sudo ufw allow OpenSSH >/dev/null
sudo ufw --force enable >/dev/null
sudo ufw status verbose | sed -n '1,12p'

step ".env"
if [ -f .env ]; then
  echo "Keeping the existing .env"
else
  ask_secret() { local v; read -rsp "$1: " v; echo >&2; printf '%s' "$v"; }
  GROQ=$(ask_secret "GROQ_API_KEY (hidden)")
  read -rp "SUPABASE_URL (blank to keep JARVIS memory on the Docker volume): " SB_URL
  SB_KEY=""; [ -n "$SB_URL" ] && SB_KEY=$(ask_secret "SUPABASE_KEY, service role key (hidden)")
  HC=$(ask_secret "HC_PING_URL from Healthchecks.io, https://hc-ping.com/... (hidden, blank to add later)")
  for v in "$GROQ" "$SB_URL" "$SB_KEY" "$HC"; do case "$v" in *$'\n'*|*' '*) echo "Values cannot contain spaces or newlines."; exit 1;; esac; done
  ( umask 077
    printf 'MCP_AUTH_TOKEN=%s\nMCP_URL_TOKEN=off\nGROQ_API_KEY=%s\nSUPABASE_URL=%s\nSUPABASE_KEY=%s\nDASHBOARD_KEY=%s\nHC_PING_URL=%s\nDATA_MODE=\n' \
      "$(openssl rand -hex 32)" "$GROQ" "$SB_URL" "$SB_KEY" "$(openssl rand -hex 24)" "$HC" > .env
    { echo; echo '# Optional source settings (see README Configuration)'; grep -E '^# [A-Z_]+=' .env.example; } >> .env )
  chmod 600 .env
  unset GROQ SB_KEY HC
  echo ".env written (mode 600). No values were printed."
fi
if ! grep -q '^HC_PING_URL=' .env; then
  read -rsp "HC_PING_URL from Healthchecks.io (hidden, blank to add later): " HC; echo
  printf 'HC_PING_URL=%s\n' "$HC" >> .env; unset HC
fi
case "$(grep -E '^HC_PING_URL=' .env | cut -d= -f2-)" in
  https://hc-ping.com/?*) echo "HC_PING_URL is set (not shown)";;
  "") echo "HC_PING_URL is empty. Add it to .env later. The timer reports nothing until then.";;
  *) echo "HC_PING_URL must start with https://hc-ping.com/"; exit 1;;
esac
if git check-ignore -q .env 2>/dev/null || grep -qx '.env' .gitignore; then echo ".env is gitignored"; else echo "WARNING: .env is not gitignored"; fi

step "Start the stack"
sudo docker compose up -d --build
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS http://127.0.0.1:8080/health; echo
sudo docker builder prune -f >/dev/null
sudo docker compose ps

step "Healthchecks.io timer (every 5 minutes)"
sudo install -m 755 deploy/healthcheck-ping.sh /usr/local/bin/a2z-healthcheck
sed "s|@REPO@|$REPO|" deploy/systemd/a2z-healthcheck.service | sudo tee /etc/systemd/system/a2z-healthcheck.service >/dev/null
sudo install -m 644 deploy/systemd/a2z-healthcheck.timer /etc/systemd/system/a2z-healthcheck.timer
sudo systemctl daemon-reload
sudo systemctl enable --now a2z-healthcheck.timer
sudo systemctl start a2z-healthcheck.service
journalctl -u a2z-healthcheck.service -n 1 --no-pager -o cat

step "Done"
echo "Next: deploy/verify.sh   then   sudo reboot, reconnect, and run it again."
