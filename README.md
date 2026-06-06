# Tank Arena

Local-network multiplayer tank arena starter built with Express, Socket.IO, React, and Vite.

## What is included

- Lobby before matches start
- Observer mode for players who join during an active match
- Admin console for selecting game mode and map
- Basic real-time tank movement, firing, health, and scoring
- Game mode scaffolding for deathmatch, capture the flag, and protect the king

## Run locally

1. Install dependencies.
2. Run `npm run dev`.
3. Open the client in a browser.
4. Share the server IP on your local network so other players can connect.

The server listens on port `3001` and the Vite client listens on port `5173` in development.

## Run online (production)

The project can run on the public internet with HTTPS and WebSocket support.

### Option 1: Docker + Nginx (recommended)

1. Copy `.env.example` to `.env` and set `ADMIN_PASSWORD`.
2. Provide TLS cert files at:
	- `certs/fullchain.pem`
	- `certs/privkey.pem`
3. Build and run:
	- `docker compose up -d --build`
4. Open ports `80` and `443` on your server firewall.
5. Point your domain DNS to the server IP.

The Nginx config is in `deploy/nginx/nginx.conf` and proxies both HTTP and WebSocket traffic to the app container.

### Option 2: PM2 without Docker

1. Install dependencies and build:
	- `npm install`
	- `npm run build`
2. Set env vars (`PORT`, `ADMIN_PASSWORD`).
3. Run with PM2:
	- `npx pm2 start ecosystem.config.cjs`
4. Put Nginx/Caddy in front for HTTPS.

## Notes

- If `ADMIN_PASSWORD` is set, claiming admin requires that password in the Admin Console.
- Late joiners are added as observers while a match is running.
- The current implementation is a playable foundation. Capture the flag and protect the king are wired as supported game modes and can be expanded next.
