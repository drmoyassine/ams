#!/usr/bin/env bash
# End-to-end smoke test against the running Compose stack (M0): health, auth, a protected route, the worker.
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
EMAIL="${ADMIN_EMAIL:?ADMIN_EMAIL must match the seeded admin}"
PASSWORD="${ADMIN_PASSWORD:?ADMIN_PASSWORD must match the seeded admin}"
JAR="$(mktemp)"

echo "waiting for $BASE/healthz"
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "$BASE/healthz" | grep -q '"ok":true'

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ "$(code "$BASE/api/programs")" = "401" ] || { echo "expected 401 without a session"; exit 1; }

curl -fsS -c "$JAR" -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/sign-in/email" >/dev/null
[ "$(code -b "$JAR" "$BASE/api/programs")" = "200" ] || { echo "expected 200 with a session"; exit 1; }

curl -fsS "$BASE/openapi.json" | grep -q '/api/programs'
curl -fsS "$BASE/" | grep -qi '<div id="root">'

if command -v docker >/dev/null && docker compose ps worker >/dev/null 2>&1; then
  docker compose logs worker | grep -q 'worker started' || { echo "worker did not start"; exit 1; }
fi
echo "smoke test passed"
