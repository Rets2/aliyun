#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/huawei-iotda-web}"
BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-huawei-iotda-web}"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "ERROR: ${APP_DIR} is not a git repository."
  exit 1
fi

echo "[1/4] Pull latest code from ${BRANCH}..."
git -C "${APP_DIR}" fetch origin "${BRANCH}"
git -C "${APP_DIR}" checkout "${BRANCH}"
git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"

echo "[2/4] Install dependencies..."
cd "${APP_DIR}"
npm ci

echo "[3/4] Restart PM2 process..."
pm2 restart "${APP_NAME}" --update-env
pm2 save

echo "[4/4] Done. Current app status:"
pm2 status "${APP_NAME}"
