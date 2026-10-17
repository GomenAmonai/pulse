#!/bin/sh
# One image, two roles: ROLE=api (default) or ROLE=worker.
set -e

if [ "${ROLE:-api}" = "worker" ]; then
  exec python -m app.worker
fi

alembic upgrade head
if [ "${SEED_DEMO:-0}" = "1" ]; then
  python -m app.seed
fi
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'
