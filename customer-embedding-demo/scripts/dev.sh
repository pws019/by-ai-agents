#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d venv ]; then
  echo "[customer-embedding-demo] venv not found, run 'npm run setup --workspace=customer-embedding-demo' first" >&2
  exit 1
fi

source venv/bin/activate
exec uvicorn main:app --host 127.0.0.1 --port "${EMBEDDING_PORT:-8080}"

