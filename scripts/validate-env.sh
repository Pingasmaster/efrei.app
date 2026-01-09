#!/bin/sh

# Validate required environment variables before containers start.
errors=0

error() {
  # Print to stderr and increment the error counter.
  echo "ENV ERROR: $1" >&2
  errors=$((errors + 1))
}

require_value() {
  # Ensure a variable exists and is not empty.
  var="$1"
  value=$(printenv "$var" 2>/dev/null || true)
  if [ -z "$value" ]; then
    error "$var is required and cannot be empty"
  fi
}

require_not_default() {
  # Ensure the variable is set and not equal to a known insecure default.
  var="$1"
  forbidden="$2"
  value=$(printenv "$var" 2>/dev/null || true)
  if [ -z "$value" ]; then
    error "$var is required and cannot be empty"
    return
  fi
  if [ "$value" = "$forbidden" ]; then
    error "$var must be changed from the default value"
  fi
}

require_port() {
  # Validate a numeric TCP port between 1 and 65535.
  var="$1"
  value=$(printenv "$var" 2>/dev/null || true)
  if [ -z "$value" ]; then
    error "$var is required and cannot be empty"
    return
  fi
  case "$value" in
    *[!0-9]* )
      error "$var must be an integer"
      return
      ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    error "$var must be between 1 and 65535"
  fi
}

require_int() {
  # Validate a positive integer (used for intervals).
  var="$1"
  value=$(printenv "$var" 2>/dev/null || true)
  if [ -z "$value" ]; then
    error "$var is required and cannot be empty"
    return
  fi
  case "$value" in
    *[!0-9]* )
      error "$var must be an integer"
      return
      ;;
  esac
  if [ "$value" -lt 1 ]; then
    error "$var must be greater than 0"
  fi
}

require_url() {
  # Validate an HTTP(S) URL string.
  var="$1"
  value=$(printenv "$var" 2>/dev/null || true)
  if [ -z "$value" ]; then
    error "$var is required and cannot be empty"
    return
  fi
  case "$value" in
    http://*|https://*)
      ;;
    *)
      error "$var must start with http:// or https://"
      ;;
  esac
}

# Host-facing ports.
require_port FRONTEND_PORT
require_port GATEWAY_PORT
require_port API_PORT

# Gateway and auth configuration.
require_not_default JWT_SECRET "change-me"
require_not_default JWT_SECRET "dev-secret"
require_url BUSINESS_API_URL

# Database settings.
require_value DB_HOST
require_port DB_PORT
require_value DB_NAME
require_value DB_USER
require_not_default DB_PASSWORD "change-me"
require_not_default MYSQL_ROOT_PASSWORD "change-me-root"

# Redis cache settings.
require_value REDIS_HOST
require_port REDIS_PORT

# Odds streaming settings.
require_value ODDS_CHANNEL
require_int ODDS_INTERVAL_MS

if [ "$errors" -ne 0 ]; then
  # Provide a single summary line when validation fails.
  echo "Fix the variables above in .env and re-run docker compose." >&2
  exit 1
fi

# Success message for the env-check container.
echo "ENV OK: all required variables are set."
