#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/huawei-iotda-web}"
APP_NAME="${APP_NAME:-huawei-iotda-web}"
TARGET_COMMIT="${1:-}"

if [[ -z "${TARGET_COMMIT}" ]]; then
  echo "Usage: ./deploy/ecs/rollback.sh <commit-sha-or-tag>"
  exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "ERROR: ${APP_DIR} is not a git repository."
  exit 1
fi

echo "[1/4] Reset working tree to ${TARGET_COMMIT}..."
git -C "${APP_DIR}" fetch --all --tags
git -C "${APP_DIR}" reset --hard "${TARGET_COMMIT}"

echo "[2/4] Reinstall dependencies..."
cd "${APP_DIR}"
npm ci

echo "[3/4] Restart PM2 process..."
pm2 restart "${APP_NAME}" --update-env
pm2 save

echo "[4/4] Rollback completed."
pm2 status "${APP_NAME}"
