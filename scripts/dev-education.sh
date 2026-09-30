#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
env_file=infra/education/.env

if [[ ! -f "$env_file" ]]; then
  cp infra/education/.env.example "$env_file"
  echo "[dev] 已创建本地 $env_file"
fi

# Compose 自行读取 --env-file，但 Turbo 的子进程需要从当前 shell 继承这些变量。
set -a
source "$env_file"
set +a

if [[ -z "${INTERNAL_AUTH_SECRET:-}" ]]; then
  INTERNAL_AUTH_SECRET="$(openssl rand -hex 32)"
  export INTERNAL_AUTH_SECRET
  printf '\nINTERNAL_AUTH_SECRET=%s\n' "$INTERNAL_AUTH_SECRET" >> "$env_file"
  echo "[dev] 已在本地 .env 生成内部服务密钥"
fi

npm run edu:infra
exec ./node_modules/.bin/turbo run dev --filter=education-agent --filter=education-api
