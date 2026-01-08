# efrei.app

## Architecture (Docker-only workflow)
This project is designed to run **exclusively** via Docker Compose. The stack is split into at least four tiers that communicate on a private Docker network and are serve on the final https://efrei.app website.

**Tiers / Containers**
1. **Frontend (Tier 1)**: Nginx serving the static files from `www/`.
2. **API Gateway / Auth (Tier 2)**: Express gateway that handles auth endpoints and proxies `/api/*` to the business API.
3. **Business API (Tier 3)**: Express service with stub endpoints for your future logic.
4. **Database (Tier 4)**: MySQL with persistent volume.
5. **Cache (Bonus)**: Redis for DB caching.
6. **Odds Worker (Bonus)**: Publishes live odds to Redis for realtime streaming.

**Network**: All services are attached to the internal Docker network `internal`.

## Run
```bash
docker compose up --build
```

- Frontend: http://localhost:8080
- Gateway: http://localhost:3000
- Business API (internal): http://api:4000

## Environment validation
The stack refuses to start if any required `.env` variable is missing or invalid. A dedicated `env-check` service runs first and prints clear errors for missing/incorrect values.

## Teardown
Run `./scripts/teardown.sh` to stop and remove all containers, networks, and volumes for this project. It prompts for confirmation before deleting.

## External reverse proxy (efrei.app)
An example nginx vhost is provided at `deploy/nginx-efrei.app.conf` for hosting the stack behind a non-Docker reverse proxy on `efrei.app`.

## Realtime Odds (WebSocket)
- Worker publishes odds to Redis (`ODDS_CHANNEL`).
- API subscribes and broadcasts via WebSocket at `/ws/odds`.
- Frontend connects through the gateway: `ws://localhost:3000/ws/odds`.
