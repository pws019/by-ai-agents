#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON_BIN="${PYTHON_BIN:-python3.11}"

if [ ! -d venv ]; then
  echo "[customer-http-demo] creating venv with $PYTHON_BIN"
  "$PYTHON_BIN" -m venv venv
fi

source venv/bin/activate
pip install -q -U pip
pip install -q -r requirements.txt
echo "[customer-http-demo] setup done"
