# efrei.app

## Architecture (Docker-only workflow)
This project is designed to run **exclusively** via Docker Compose (no local `npm start`, no local `python app.py`). The stack is split into at least four tiers that communicate on a private Docker network.

**Tiers / Containers**
1. **Frontend (Tier 1)**: Nginx serving the static files from `www/`.
2. **API Gateway / Auth (Tier 2)**: Express gateway that handles auth endpoints and proxies `/api/*` to the business API.
3. **Business API (Tier 3)**: Express service with stub endpoints for your future logic.
4. **Database (Tier 4)**: MySQL with persistent volume.
5. **Cache (Bonus)**: Redis for DB caching.

**Network**: All services are attached to the internal Docker network `internal`.

**Build system**: Compose uses BuildKit/buildx under the hood. You build/run with `docker compose` instead of `docker build -t`.

## Run
```bash
docker compose up --build
```

- Frontend: http://localhost:8080
- Gateway: http://localhost:3000
- Business API (internal): http://api:4000

## Service Worker (Offline)
A minimal service worker is added in `www/sw.js` and registered in `www/index.html` to cache the static files for offline use.

## Files of interest
- `docker-compose.yml`
- `frontend/Containerfile`
- `frontend/nginx.conf`
- `gateway/Containerfile`, `gateway/index.js`
- `api/Containerfile`, `api/index.js`
- `www/sw.js`

## Notes
- Update secrets in `docker-compose.yml` (`JWT_SECRET`, MySQL credentials) before production.
- Add your real business logic in the `api` service and wire database/cache access as needed.
