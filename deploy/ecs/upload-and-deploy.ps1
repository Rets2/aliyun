param(
  [Parameter(Mandatory = $true)]
  [string]$Host,

  [Parameter(Mandatory = $true)]
  [string]$User,

  [Parameter(Mandatory = $true)]
  [string]$KeyPath,

  [int]$Port = 22,
  [string]$RemoteDir = "/opt/huawei-iotda-web",
  [string]$AppName = "huawei-iotda-web"
)

$ErrorActionPreference = "Stop"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

Require-Command "tar"
Require-Command "scp"
Require-Command "ssh"

if (-not (Test-Path -LiteralPath $KeyPath)) {
  throw "SSH key not found: $KeyPath"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$archiveName = "huawei-iotda-web-$timestamp.tar.gz"
$archivePath = Join-Path $env:TEMP $archiveName
$remoteArchive = "/tmp/$archiveName"

Write-Host "[1/5] Build release package: $archivePath"
Push-Location $repoRoot
try {
  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }

  tar `
    --exclude=".git" `
    --exclude=".env" `
    --exclude="node_modules" `
    --exclude="aliyun-iot-web.tar.gz" `
    -czf $archivePath .
}
finally {
  Pop-Location
}

Write-Host "[2/5] Upload package to ECS: $User@${Host}:$remoteArchive"
scp -i $KeyPath -P $Port $archivePath "$User@${Host}:$remoteArchive"

$remoteScript = @'
set -euo pipefail

APP_DIR="__REMOTE_DIR__"
APP_NAME="__APP_NAME__"
ARCHIVE="__REMOTE_ARCHIVE__"

echo "[remote 1/6] Install runtime packages"
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg nginx

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

echo "[remote 2/6] Extract project to \$APP_DIR"
sudo mkdir -p "\$APP_DIR"
sudo chown -R "\$USER:\$USER" "\$APP_DIR"
tar -xzf "\$ARCHIVE" -C "\$APP_DIR"

echo "[remote 3/6] Install dependencies"
cd "\$APP_DIR"
npm ci

if [[ ! -f ".env" ]]; then
  cp .env.example .env
  echo "Created \$APP_DIR/.env . Please edit HWCLOUD_* variables."
fi

echo "[remote 4/6] Configure Nginx"
sudo cp deploy/ecs/nginx.huawei-iotda-web.conf /etc/nginx/sites-available/huawei-iotda-web.conf
sudo ln -sfn /etc/nginx/sites-available/huawei-iotda-web.conf /etc/nginx/sites-enabled/huawei-iotda-web.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl reload nginx

echo "[remote 5/6] Start app with PM2"
if pm2 describe "\$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "\$APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --only "\$APP_NAME" --update-env
fi
pm2 save

echo "[remote 6/6] Cleanup"
rm -f "\$ARCHIVE"

echo "Deploy finished."
echo "Next: edit \$APP_DIR/.env then run: pm2 restart \$APP_NAME --update-env"
'@

$remoteScript = $remoteScript.Replace("__REMOTE_DIR__", $RemoteDir)
$remoteScript = $remoteScript.Replace("__APP_NAME__", $AppName)
$remoteScript = $remoteScript.Replace("__REMOTE_ARCHIVE__", $remoteArchive)

Write-Host "[3/5] Run remote deploy script"
ssh -i $KeyPath -p $Port "$User@$Host" $remoteScript

Write-Host "[4/5] Clean local package"
Remove-Item -LiteralPath $archivePath -Force

Write-Host "[5/5] Done"
Write-Host "ECS URL: http://$Host"
