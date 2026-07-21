#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
INFRA_ENV_FILE="${INFRA_ENV_FILE:-deploy/production/infra.env}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-true}"
ENABLE_BACKUPS="${ENABLE_BACKUPS:-false}"

docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" build api worker migrate
docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" up -d postgres redis

if [ "${RUN_MIGRATIONS}" = "true" ]; then
  docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" run --rm migrate
fi

docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" up -d api worker nginx cloudflared

if [ "${ENABLE_BACKUPS}" = "true" ]; then
  docker compose --profile ops --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" build postgres-backup
  docker compose --profile ops --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" up -d postgres-backup
fi

docker compose --env-file "${INFRA_ENV_FILE}" -f "${COMPOSE_FILE}" ps
