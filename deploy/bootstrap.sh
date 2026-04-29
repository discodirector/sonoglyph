#!/usr/bin/env bash
# Sonoglyph VPS bootstrap — runs on the server, idempotent.
#
# Installs Node 20, Caddy, clones the repo, builds the frontend, drops
# config files, and starts everything. Run as root.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/discodirector/sonoglyph/main/deploy/bootstrap.sh | bash
# or:
#   ssh root@sonoglyph.xyz 'bash -s' < deploy/bootstrap.sh

set -euo pipefail

REPO_URL="https://github.com/discodirector/sonoglyph.git"
INSTALL_DIR="/srv/sonoglyph"
WEB_ROOT="/var/www/sonoglyph"

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

# -----------------------------------------------------------------------------
log "apt update + base packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https git ufw

# -----------------------------------------------------------------------------
log "Node.js 20.x"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

# -----------------------------------------------------------------------------
log "Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi
caddy version

# -----------------------------------------------------------------------------
log "Clone / pull repo into ${INSTALL_DIR}"
if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  git clone "${REPO_URL}" "${INSTALL_DIR}"
else
  git -C "${INSTALL_DIR}" fetch origin
  git -C "${INSTALL_DIR}" reset --hard origin/main
fi

# -----------------------------------------------------------------------------
log ".env"
if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  cat >"${INSTALL_DIR}/.env" <<'EOF'
# Edit this with `nano /srv/sonoglyph/.env` and `systemctl restart sonoglyph-bridge`.
KIMI_API_KEY=
KIMI_BASE_URL=https://api.moonshot.ai/v1
KIMI_MODEL=kimi-k2.6
EOF
  echo "  -> created /srv/sonoglyph/.env (fill in KIMI_API_KEY then restart)"
fi

# -----------------------------------------------------------------------------
log "proxy deps"
cd "${INSTALL_DIR}/proxy"
npm ci --omit=dev || npm install --omit=dev

# -----------------------------------------------------------------------------
log "frontend build"
cd "${INSTALL_DIR}/web"
# Vite needs devDeps to build, but we don't keep them on the runtime path.
npm ci || npm install
VITE_BRIDGE_WS=wss://sonoglyph.xyz/ws npm run build
mkdir -p "${WEB_ROOT}"
rm -rf "${WEB_ROOT:?}"/*
cp -r dist/* "${WEB_ROOT}/"
chown -R caddy:caddy "${WEB_ROOT}" 2>/dev/null || true

# -----------------------------------------------------------------------------
log "systemd unit"
cp "${INSTALL_DIR}/deploy/sonoglyph-bridge.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable sonoglyph-bridge
systemctl restart sonoglyph-bridge

# -----------------------------------------------------------------------------
log "Caddy config"
cp "${INSTALL_DIR}/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

# -----------------------------------------------------------------------------
log "firewall (allow 22, 80, 443)"
ufw --force enable >/dev/null 2>&1 || true
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null

# -----------------------------------------------------------------------------
log "status check"
sleep 2
systemctl --no-pager --lines=5 status sonoglyph-bridge || true
echo
curl -fsS http://127.0.0.1:8787/health && echo
echo
log "Done. Open https://sonoglyph.xyz/ in a browser."
