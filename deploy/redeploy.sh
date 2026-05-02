#!/usr/bin/env bash
# deploy/redeploy.sh — full Sonoglyph redeploy on the VPS.
#
# Run as root from /srv/sonoglyph after `git pull`. Idempotent —
# re-running is cheap and safe.
#
# What it does:
#   1. Web rebuild via `npm run build`. Caddy serves /srv/sonoglyph/web/dist
#      directly, so the build IS the deploy — no rsync to /var/www.
#   2. Docs rebuild (Astro Starlight) via `npm run build`. Caddy serves
#      /srv/sonoglyph/docs/dist on docs.sonoglyph.xyz. Skipped silently
#      if the docs/ folder doesn't exist (older checkouts).
#   3. Bridge restart via systemd. The proxy runs `tsx src/index.ts`,
#      which reads sources fresh on each start, so a service restart
#      picks up any proxy/src/*.ts changes.
#   4. Caddyfile sync if it drifted from the version in the repo, plus
#      `caddy reload` (graceful, no dropped connections).
#   5. Health check against the public domain — confirms TLS, Caddy,
#      and the bridge process are all reachable end-to-end.
#
# Why a single script: the previous workflow had a build step and a
# manual rsync to /var/www/sonoglyph that was easy to forget — the
# frontend would silently stay on the old bundle while the bridge ran
# new code. Eliminating that gap is the whole point.

set -euo pipefail

REPO=/srv/sonoglyph
CADDY_SRC=$REPO/deploy/Caddyfile
CADDY_DST=/etc/caddy/Caddyfile

cd "$REPO"

echo "[deploy] building web..."
( cd web && npm run build )

if [ -d docs ]; then
  echo "[deploy] building docs..."
  # First-time deploys won't have docs/node_modules yet; install if missing.
  # We don't have a lockfile yet (the scaffold was created with --no-install)
  # so `npm install` it is — once a package-lock.json is committed, switch
  # to `npm ci` for reproducible installs.
  ( cd docs && [ -d node_modules ] || npm install ) \
    && ( cd docs && npm run build )
else
  echo "[deploy] no docs/ folder — skipping docs build"
fi

echo "[deploy] restarting bridge..."
systemctl restart sonoglyph-bridge.service

if ! cmp -s "$CADDY_SRC" "$CADDY_DST"; then
  echo "[deploy] Caddyfile changed — syncing + reloading caddy..."
  cp "$CADDY_SRC" "$CADDY_DST"
  systemctl reload caddy
else
  echo "[deploy] Caddyfile unchanged — skipping caddy reload"
fi

echo "[deploy] verifying health..."
sleep 2
if curl -sf https://sonoglyph.xyz/health > /dev/null; then
  echo "[deploy] health: ok"
else
  echo "[deploy] health: FAIL"
  exit 1
fi

BUNDLE=$(grep -oE 'index-[A-Za-z0-9_-]+\.js' "$REPO/web/dist/index.html" | head -1)
SERVED=$(curl -sf "https://sonoglyph.xyz/?$(date +%s)" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
if [[ "$BUNDLE" == "$SERVED" ]]; then
  echo "[deploy] frontend bundle: $BUNDLE (live)"
else
  echo "[deploy] frontend bundle MISMATCH: dist=$BUNDLE  served=$SERVED"
  exit 1
fi

echo "[deploy] done"
