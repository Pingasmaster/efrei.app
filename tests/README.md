# Tests

## Prerequisites
- Start the stack: `docker compose up --build`
- Ensure admin bootstrap is configured so the integration tests can resolve bets:
  - Set `ADMIN_BOOTSTRAP_EMAIL` in `.env` to match `TEST_ADMIN_EMAIL`

## Install test dependencies
```bash
cd tests
npm install
```

## Contract tests (OpenAPI)
```bash
cd tests
npm run test:contract
```

## Integration tests (points + bet settlement)
```bash
cd tests
TEST_ADMIN_EMAIL=admin@efrei.fr TEST_ADMIN_PASSWORD=change-me npm run test:integration
```

### Optional overrides
- `API_URL` (default: `http://localhost:4000`)
- `GATEWAY_URL` (default: `http://localhost:3000`)
