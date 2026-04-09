# Huawei IoTDA Web Console

这是一个基于 Node.js + Socket.IO 的物联网控制台，通信链路已固定为**华为云 IoTDA OpenAPI 命令通道**。

当前实现只走以下华为云接口：
- `CreateCommand`：下发设备命令
- `ShowProduct`：同步产品物模型（属性 + 命令定义）
- `ShowDeviceShadow`：读取设备影子上报状态
- `ShowDevice`：查询设备在线状态

## 1. 本地启动

```bash
npm install
npm run start
```

访问：`http://localhost:3000`

## 2. 环境变量

复制 `.env.example` 为 `.env`，并至少填写：

- `HWCLOUD_REGION_ID`
- `HWCLOUD_PROJECT_ID`
- `HWCLOUD_AK`
- `HWCLOUD_SK`
- `HWCLOUD_DEVICE_ID`
- `HWCLOUD_PRODUCT_ID`
- `HWCLOUD_SERVICE_ID`

可选配置：
- `HWCLOUD_ENDPOINT`（专属实例推荐配置）
- `HWCLOUD_INSTANCE_ID`
- `HWCLOUD_APP_ID`

运行策略配置：
- `TARGET_ONLINE_WAIT_MS`
- `TARGET_ONLINE_POLL_MS`
- `STRICT_TARGET_ONLINE_CHECK`
- `CLOUD_DISPATCH_RETRY_ATTEMPTS`
- `CLOUD_DISPATCH_RETRY_INTERVAL_MS`
- `PROPERTY_POLL_ON_CONNECT`
- `PROPERTY_POLL_INTERVAL_MS`
- `AUTO_CONNECT_ON_START`

## 3. 命令同步与格式

命令不再硬编码，页面和后端都会从 `ShowProduct` 同步 `service_capabilities[].commands`。

发布校验为严格模式：
- `command_name` 必须在云端已同步命令中
- `paras` 必须是对象
- 必填参数不能缺失
- 未定义参数会被拒绝

命令请求格式示例：

```json
{
  "service_id": "Rets2",
  "command_name": "turn_light",
  "paras": {
    "Light_Status": 1
  }
}
```

## 4. HTTP API

- `GET /api/status`
- `POST /api/connect`
- `POST /api/disconnect`
- `GET /api/model/properties`
- `POST /api/model/refresh`
- `GET /api/device/properties`
- `POST /api/device/properties/refresh`
- `POST /api/publish`

说明：
- `POST /api/subscribe` 与 `POST /api/unsubscribe` 在华为命令通道中固定返回禁用提示。
- `GET /api/model/properties` 返回 `properties` 与 `commands` 两类模型数据。
- 本项目当前不包含“规则引擎规则”可视化/管理（规则层为下一阶段）。

## 5. Socket 事件

- `status`
- `thing_model`（包含 `properties` 与 `commands`）
- `property_state`
- `published`
- `log`

## 6. ECS 部署（Ubuntu + Nginx + PM2）

### 方式 A：服务器通过 Git 拉取部署（推荐）

首次部署：

```bash
bash deploy/ecs/bootstrap-ubuntu.sh
```

默认配置：
- PM2 进程名：`huawei-iotda-web`
- 安装目录：`/opt/huawei-iotda-web`
- Nginx 配置：`deploy/ecs/nginx.huawei-iotda-web.conf`

### 日常发布

```bash
bash deploy/ecs/deploy.sh
```

### 回滚

```bash
bash deploy/ecs/rollback.sh <commit-sha-or-tag>
```

### 方式 B：从本地直接上传到阿里云 ECS 部署

适合你现在这种“本地开发完成后直接上传 ECS”的场景。

在本机（Windows PowerShell）执行：

```powershell
.\deploy\ecs\upload-and-deploy.ps1 `
  -Host <你的ECS公网IP> `
  -User <你的ECS登录用户, 如 ubuntu 或 root> `
  -KeyPath <你的SSH私钥路径>
```

脚本会自动完成：
- 本地打包（排除 `.git/.env/node_modules`）
- `scp` 上传到 ECS
- 服务器安装 Node.js/PM2/Nginx（若缺失）
- 解压部署、`npm ci`、配置 Nginx、PM2 启动

部署后请在 ECS 上补全环境变量：

```bash
cd /opt/huawei-iotda-web
cp -n .env.example .env
vim .env
pm2 restart huawei-iotda-web --update-env
```

## 7. 常见问题

1. `ProjectId` 不匹配
- 检查 `HWCLOUD_PROJECT_ID` 与 `HWCLOUD_REGION_ID` 是否来自同一个区域项目。

2. AK/SK 鉴权失败
- 检查 `HWCLOUD_AK`、`HWCLOUD_SK` 是否有效，并确认 IAM 权限覆盖 IoTDA 所需操作。

3. 设备离线
- `ShowDevice` 返回 `OFFLINE` 时，命令可能重试后失败。

4. 物模型为空
- 检查产品下 `service_id`（默认 `Rets2`）是否已定义属性。
