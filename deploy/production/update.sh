#!/usr/bin/env bash
# One-command update for the server: pull latest code from GitHub, rebuild,
# run database migrations, restart, and check health.
#
#   cd /opt/LNDRY/app && bash deploy/production/update.sh
#
# Optional: BRANCH=main (default), SKIP_SMOKE=true
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

BRANCH="${BRANCH:-main}"

echo "==> Fetching ${BRANCH} from GitHub"
git fetch --prune origin
git checkout "${BRANCH}"
git pull --ff-only origin "${BRANCH}"
echo "    now at $(git log -1 --format='%h %s')"

echo "==> Build, migrate, restart"
RUN_MIGRATIONS=true bash deploy/production/deploy.sh

if [ "${SKIP_SMOKE:-false}" != "true" ]; then
  echo "==> Health check"
  bash deploy/production/smoke-test.sh
fi

echo "==> Done"
