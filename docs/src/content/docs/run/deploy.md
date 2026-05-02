---
title: Deploy
description: How sonoglyph.xyz is deployed to a Hetzner VPS — Caddy, systemd bridge, web build, and the redeploy.sh script.
---

Sonoglyph is deployed to a single Hetzner VPS at `sonoglyph.xyz`.
One host, three pieces: a static frontend, a Node bridge as a systemd
unit, and Caddy fronting both.

## Topology

```
                ┌──────────────────────────────┐
   :443 ─▶ Caddy │ sonoglyph.xyz                 │
                │   /ws*    → 127.0.0.1:8787    │  ← bridge
                │   /mcp*   → 127.0.0.1:8787    │
                │   /pin*   → 127.0.0.1:8787    │
                │   /mint   → 127.0.0.1:8787    │
                │   /health → 127.0.0.1:8787    │
                │   else    → /srv/sonoglyph/web/dist (static)
                └──────────────────────────────┘
```

Caddy auto-obtains and renews TLS for `sonoglyph.xyz` and
`www.sonoglyph.xyz`. The `Caddyfile` lives at `deploy/Caddyfile` in
the repo and is synced into `/etc/caddy/Caddyfile` by the redeploy
script when it changes.

## First-time bootstrap

Once per host, on a fresh Ubuntu/Debian VPS:

```bash
# As root, clone the repo into /srv/sonoglyph then:
cd /srv/sonoglyph
bash deploy/bootstrap.sh
```

`bootstrap.sh` installs Node, installs Caddy, copies the Caddyfile,
installs the `sonoglyph-bridge.service` systemd unit, and runs the
first build. After that, all subsequent updates go through
`redeploy.sh`.

## Subsequent deploys

```bash
# Locally
git push

# On the VPS
ssh root@sonoglyph.xyz "cd /srv/sonoglyph && git pull && bash deploy/redeploy.sh"
```

`redeploy.sh` does, in order:

1. **Web rebuild.** `cd web && npm run build`. Caddy serves
   `/srv/sonoglyph/web/dist` directly, so the Vite build *is* the
   deploy — no rsync to `/var/www`.
2. **Bridge restart.** `systemctl restart sonoglyph-bridge.service`.
   The proxy runs `tsx src/index.ts`, which reads sources fresh on
   each start, so a service restart picks up any `proxy/src/*.ts`
   changes without an explicit build step.
3. **Caddyfile sync.** If `deploy/Caddyfile` differs from
   `/etc/caddy/Caddyfile`, copy and `systemctl reload caddy`
   (graceful, no dropped connections).
4. **Health check.** `curl https://sonoglyph.xyz/health` — confirms
   TLS, Caddy, and the bridge are reachable end-to-end.
5. **Bundle verification.** Compares the bundle hash in
   `web/dist/index.html` against what `https://sonoglyph.xyz/`
   actually serves. Catches the case where Caddy's static cache or
   a stale browser is serving an old bundle.

The full script is in `deploy/redeploy.sh`. It's idempotent — re-running
is cheap and safe.

## Why a single script

The earlier workflow had a build step and a manual rsync to
`/var/www/sonoglyph`. Easy to forget. The frontend would silently stay
on the old bundle while the bridge ran new code, and the only signal
was someone noticing weird behaviour. Pointing Caddy directly at the
build output and folding everything into one script eliminates that
gap.

## Environment

Bridge env lives at `/etc/sonoglyph/bridge.env`, owned root, mode 600.
The systemd unit reads it via `EnvironmentFile=`. Same variable names
as `.env.example` in the repo:

- `KIMI_API_KEY`
- `PINATA_JWT`
- `MONAD_RPC_URL`
- `SONOGLYPH_CONTRACT_ADDRESS`
- `MINT_PRIVATE_KEY`

Web has no production env — it talks to the bridge via same-origin
HTTP/WS, so there's no `VITE_API_URL` to set.

## Docs deployment

This site (`docs.sonoglyph.xyz`) deploys the same way: a static build
served by Caddy on a subdomain. See the corresponding section in
`deploy/Caddyfile` for the subdomain block.
