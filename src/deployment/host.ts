import { Project } from './config';
import { quote } from './remote';

/** Ubuntu only. Printed by default; execution requires --execute --yes and a matching host target. */
export function hostSetupScript(p: Project): string {
  const user = p.host!.ssh.split('@')[0];
  return `set -eu
sudo -n bash -se <<'GROMA_SETUP'
set -eu
. /etc/os-release
[ "$ID" = ubuntu ] && { [ "$VERSION_ID" = 22.04 ] || [ "$VERSION_ID" = 24.04 ]; } || { echo 'Supported hosts: Ubuntu 22.04 / 24.04 LTS' >&2; exit 1; }
command -v apt-get >/dev/null
# Never replace an existing Docker installation or an unrelated Caddy configuration.
if [ -f /etc/caddy/Caddyfile ] && ! grep -Fxq '# Managed by GROMa' /etc/caddy/Caddyfile; then
  echo 'Existing Caddy configuration: add the GROMa import manually; refusing to overwrite.' >&2
  exit 1
fi
if ! command -v caddy >/dev/null && ss -H -ltn | awk '$4 ~ /:(80|443)$/ {found=1} END {exit !found}'; then
  echo 'Port 80 or 443 is occupied; prepare the reverse proxy manually.' >&2; exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https ufw
install -m 0755 -d /etc/apt/keyrings
if ! command -v docker >/dev/null; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
[ "$(docker version --format '{{.Server.Version}}' | cut -d. -f1)" -ge 28 ] || { echo 'Docker Engine 28+ required; upgrade existing Docker manually.' >&2; exit 1; }
docker compose config --help | grep -q -- --lock-image-digests || { echo 'Compose must support image digest locking' >&2; exit 1; }
docker compose up --help | grep -q -- --wait-timeout || { echo 'Existing Docker requires a Compose upgrade; refusing automatic replacement.' >&2; exit 1; }
if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
getent group groma >/dev/null || groupadd --system groma
usermod -aG docker,groma ${quote(user)}
install -d -m 2770 -o root -g groma /opt/groma
install -d -m 0755 /etc/caddy/groma
if [ ! -f /etc/caddy/Caddyfile ] || ! grep -Fxq '# Managed by GROMa' /etc/caddy/Caddyfile; then
  # The package default is replaced only when this setup installed Caddy.
  printf '# Managed by GROMa\nimport /etc/caddy/groma/*.caddy\n' > /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now docker caddy
systemctl reload caddy
# Preserve existing firewall rules and explicitly allow this SSH connection's port first.
ufw allow ${p.host!.port ?? 22}/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
GROMA_SETUP
printf 'Host prepared. Reconnect SSH for new group membership. Configure passwordless sudo for deployment operations before deploying.\n'
`;
}
