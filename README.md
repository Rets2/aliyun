# Alibaba Cloud IoT Web Console (Non-TLS)

当前版本默认采用 OpenAPI 命令模式，避免网页和真实设备抢占同一 MQTT 会话。

- Broker: `mqtt://<productKey>.iot-as-mqtt.<region>.aliyuncs.com:1883`
- clientId mode: `securemode=3,signmethod=hmacsha256`

## 本地运行

```bash
npm install
npm run start
```

浏览器打开 `http://localhost:3000`。

## 阿里云 ECS 部署（Ubuntu + Nginx + PM2）

### 1) ECS 准备

- ECS 系统：Ubuntu 22.04/20.04
- 安全组入站放行：`22`、`80`
- 调试时可临时放行 `3000`，稳定后关闭

### 2) 服务器一键引导

在 ECS 上执行：

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/Rets2/aliyun.git /opt/aliyun-iot-web
cd /opt/aliyun-iot-web
chmod +x deploy/ecs/*.sh
./deploy/ecs/bootstrap-ubuntu.sh
```

### 3) 填写环境变量

编辑 `/opt/aliyun-iot-web/.env`，至少填写：

- `ALIYUN_PRODUCT_KEY`
- `ALIYUN_DEVICE_NAME`
- `ALIYUN_DEVICE_SECRET`
- `ALIYUN_REGION_ID`
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ALIYUN_IOT_INSTANCE_ID`（企业实例建议填写）

推荐固定值：

- `ENABLE_LOCAL_MQTT=false`
- `ALLOW_CLOUD_ROUTE_MQTT_FALLBACK=false`
- `PROPERTY_POLL_ON_CONNECT=true`
- `PROPERTY_POLL_INTERVAL_MS=2000`
- `AUTO_CONNECT_ON_START=true`

变量更新后执行：

```bash
cd /opt/aliyun-iot-web
pm2 restart aliyun-iot-web --update-env
```

### 4) 验证上线

- 页面：`http://<ECS公网IP>`
- 状态接口：`http://<ECS公网IP>/api/status`

如果接口返回 `ok: true`，说明服务已经可用。

### 5) 发布与回滚

发布新代码：

```bash
cd /opt/aliyun-iot-web
./deploy/ecs/deploy.sh
```

回滚到指定提交：

```bash
cd /opt/aliyun-iot-web
./deploy/ecs/rollback.sh <commit-sha-or-tag>
```

### 6) 日志巡检

```bash
pm2 status
pm2 logs aliyun-iot-web
sudo journalctl -u nginx -n 200 --no-pager
```

## 环境变量说明（`.env`）

复制 `.env.example` 为 `.env`，然后填写业务参数。

关键变量：

- `ALIYUN_PRODUCT_KEY`
- `ALIYUN_DEVICE_NAME`
- `ALIYUN_DEVICE_SECRET`
- `ALIYUN_REGION_ID`
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ALIYUN_IOT_INSTANCE_ID`

稳定性建议：

- `ENABLE_LOCAL_MQTT=false`
- `ALLOW_CLOUD_ROUTE_MQTT_FALLBACK=false`
- `TARGET_ONLINE_WAIT_MS=15000`
- `TARGET_ONLINE_POLL_MS=1500`
- `STRICT_TARGET_ONLINE_CHECK=false`
- `CLOUD_DISPATCH_RETRY_ATTEMPTS=3`
- `CLOUD_DISPATCH_RETRY_INTERVAL_MS=2000`
- `PROPERTY_POLL_ON_CONNECT=true`
- `PROPERTY_POLL_INTERVAL_MS=2000`
- `AUTO_CONNECT_ON_START=true`

## 接口与事件（保持不变）

HTTP:

- `GET /api/status`
- `GET /api/model/properties`
- `POST /api/model/refresh`
- `GET /api/device/properties`
- `POST /api/device/properties/refresh`
- `POST /api/publish`

Socket.IO:

- `status`
- `thing_model`
- `property_state`
- `published`
- `log`

## 常见错误

- `iot.Sre.IotInstanceNotFound`
  - `ALIYUN_IOT_INSTANCE_ID` 与 `ALIYUN_REGION_ID` 不匹配
- `iot.prod.NotExistedProduct`
  - AK/SK 无该产品权限，或地域填错
- `Target device ... OFFLINE`
  - 目标设备未在线，或设备端 MQTT 会话异常
