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

## Bot simulation and analysis

The repository includes a deterministic, server-independent simulation harness for quickly testing bot combat behavior.

- Run aggregate scenarios: `npm run bot:sim`
- Run simulation tests only: `npx vitest run tests/simulation/bot-scenarios.test.ts`
- Generate visual analysis from the newest trace: `npm run bot:analyze`

Current built-in scenarios include:

- Duel Open Field
- Skirmish 3v3
- Pressure 1v2
- Wall Blocked Duel (solid wall between teams, useful for LOS/pathing regressions)

To capture fresh traces before analysis, enable tracing for one run per scenario:

```powershell
$env:BOT_SIM_TRACE='1'
$env:BOT_SIM_TRACE_RUNS='1'
$env:BOT_SIM_TRACE_EVERY_STEPS='2'
npm run bot:sim
Remove-Item Env:BOT_SIM_TRACE
Remove-Item Env:BOT_SIM_TRACE_RUNS
Remove-Item Env:BOT_SIM_TRACE_EVERY_STEPS
npm run bot:analyze
```

Generated files are written to `tests/simulation/output`.

## Run online (production)

The project can run on the public internet with HTTPS and WebSocket support.

### Option 1: Docker + Nginx (recommended)

1. Copy `.env.example` to `.env`.
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
2. Set env vars (`PORT`, optional `EMPTY_LOBBY_GRACE_MS`, optional `RECONNECT_GRACE_MS`, optional `REDIS_URL`).
3. Run with PM2:
	- `npx pm2 start ecosystem.config.cjs`
4. Put Nginx/Caddy in front for HTTPS.

### Option 3: Render (fastest hosted setup)

Render can deploy directly from this repository using `render.yaml`.

1. Push latest code to GitHub.
2. In Render, click `New +` -> `Blueprint`.
3. Connect your GitHub repo and select this project.
4. Optionally set `EMPTY_LOBBY_GRACE_MS`, `RECONNECT_GRACE_MS`, and `REDIS_URL` in environment variables.
5. Deploy.

Render provides HTTPS automatically and assigns a public URL.

Useful notes for Render:

- Free plan instances can sleep when idle.
- The first player after idle may wait for cold start.
- WebSockets (Socket.IO) are supported on Render web services.

### Option 4: Oracle Cloud Always Free VM (recommended for always-on free hosting)

This path gives you an always-on Linux VM with full control and no sleep mode.

1. Create an Oracle Cloud VM (Ubuntu 24.04 recommended).
2. Reserve a public IP and attach it to the VM.
3. In Oracle Cloud networking, allow inbound TCP ports `22`, `80`, and `443`.
4. SSH to the VM and install Docker + Compose plugin:
	- `sudo apt update`
	- `sudo apt install -y ca-certificates curl gnupg`
	- `sudo install -m 0755 -d /etc/apt/keyrings`
	- `curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg`
	- `sudo chmod a+r /etc/apt/keyrings/docker.gpg`
	- `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null`
	- `sudo apt update`
	- `sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
	- `sudo usermod -aG docker $USER`
	- Reconnect SSH so group membership refreshes.
5. Install Git and clone this repository:
	- `sudo apt install -y git`
	- `git clone https://github.com/BeranLu/TankArena.git`
	- `cd TankArena`
6. Configure application environment:
	- `cp .env.example .env`
	- Edit `.env` and tune `EMPTY_LOBBY_GRACE_MS`, `RECONNECT_GRACE_MS`, and optional `REDIS_URL` if needed.
7. Configure TLS certificates (required by current Nginx config):
	- Put certificate chain at `certs/fullchain.pem`.
	- Put private key at `certs/privkey.pem`.
8. Start the stack:
	- `docker compose up -d --build`
9. Check service health:
	- `docker compose ps`
	- `docker compose logs -f app`
	- `docker compose logs -f nginx`

After DNS points to the VM IP and certificates are valid, players can join over HTTPS/WSS.

## Notes

- Lobby creator becomes admin automatically. Admin can transfer ownership or kick players from the Admin Console.
- Lobbies can be created as public or password-protected.
- Empty non-main lobbies are auto-removed after `EMPTY_LOBBY_GRACE_MS`.
- Recent disconnects can rejoin with preserved identity within `RECONNECT_GRACE_MS`.
- Set `REDIS_URL` to enable the Socket.IO Redis adapter for multi-instance deployments.
- Set `VITE_SUPPORT_URL` (for example your Buy Me a Coffee page) to show a "Support the project" section in the lobby preparation screen.
- Late joiners are added as observers while a match is running.
- The current implementation is a playable foundation. Capture the flag and protect the king are wired as supported game modes and can be expanded next.

## License

This project is available for non-commercial use.

Commercial use requires prior written approval from the copyright holder.

See `LICENSE` for full terms.
