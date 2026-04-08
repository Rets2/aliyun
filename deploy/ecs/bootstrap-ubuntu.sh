#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-aliyun-iot-web}"
APP_DIR="${APP_DIR:-/opt/${APP_NAME}}"
REPO_URL="${REPO_URL:-https://github.com/Rets2/aliyun.git}"
BRANCH="${BRANCH:-main}"
SITE_CONF_NAME="${SITE_CONF_NAME:-aliyun-iot-web.conf}"

echo "[1/8] Install system packages..."
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git nginx

if ! command -v node >/dev/null 2>&1; then
  echo "[2/8] Install Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[2/8] Node.js already installed: $(node -v)"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[3/8] Install PM2..."
  sudo npm install -g pm2
else
  echo "[3/8] PM2 already installed: $(pm2 -v)"
fi

echo "[4/8] Prepare application directory..."
sudo mkdir -p "${APP_DIR}"
sudo chown -R "${USER}:${USER}" "${APP_DIR}"

if [[ -d "${APP_DIR}/.git" ]]; then
  echo "[5/8] Update source code..."
  git -C "${APP_DIR}" fetch origin "${BRANCH}"
  git -C "${APP_DIR}" checkout "${BRANCH}"
  git -C "${APP_DIR}" pull --ff-only origin "${BRANCH}"
else
  echo "[5/8] Clone source code..."
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

echo "[6/8] Install Node dependencies..."
cd "${APP_DIR}"
npm ci

if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo "Created ${APP_DIR}/.env from .env.example. Please fill in real values."
fi

echo "[7/8] Configure Nginx reverse proxy..."
sudo cp "${APP_DIR}/deploy/ecs/nginx.aliyun-iot-web.conf" "/etc/nginx/sites-available/${SITE_CONF_NAME}"
sudo ln -sfn "/etc/nginx/sites-available/${SITE_CONF_NAME}" "/etc/nginx/sites-enabled/${SITE_CONF_NAME}"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx

echo "[8/8] Start app with PM2..."
if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  pm2 restart "${APP_NAME}" --update-env
else
  pm2 start ecosystem.config.cjs --only "${APP_NAME}" --update-env
fi
pm2 save
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u "${USER}" --hp "${HOME}" || true

echo ""
echo "Bootstrap complete."
echo "Next steps:"
echo "1) Edit ${APP_DIR}/.env and fill all ALIYUN_* variables."
echo "2) Restart app: pm2 restart aliyun-iot-web --update-env"
echo "3) Open: http://<your-ecs-public-ip>"
