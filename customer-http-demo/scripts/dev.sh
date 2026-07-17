#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d venv ]; then
  echo "[customer-http-demo] venv not found, run 'npm run setup' first" >&2
  exit 1
fi

source venv/bin/activate
# exec 替换掉当前 shell 进程，保证 Ctrl+C / SIGTERM 能直接传给 uvicorn，
# 不会留下一个孤儿的 bash 包着它。
exec uvicorn main:app --host 127.0.0.1 --port 8123
