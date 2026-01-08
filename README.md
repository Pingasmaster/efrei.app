# efrei.app

## Architecture (Docker-only workflow)
This project is designed to run **exclusively** via Docker Compose. The stack is split into at least four tiers that communicate on a private Docker network and are serve on the final https://efrei.app website.

**Tiers / Containers**
1. **Frontend (Tier 1)**: Nginx serving the static files from `www/`.
2. **API Gateway / Auth (Tier 2)**: Express gateway that handles auth endpoints and proxies `/api/*` to the business API.
3. **Business API (Tier 3)**: Express service with stub endpoints for your future logic.
4. **Database (Tier 4)**: MySQL with persistent volume.
5. **Cache (Bonus)**: Redis for DB caching.

**Network**: All services are attached to the internal Docker network `internal`.

## Run
```bash
docker compose up --build
```

- Frontend: http://localhost:8080
- Gateway: http://localhost:3000
- Business API (internal): http://api:4000
