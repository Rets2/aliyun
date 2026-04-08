# Alibaba Cloud IoT Web Console (Non-TLS)

当前版本默认使用 **OpenAPI 命令模式**（不占用设备 MQTT 会话），可选开启本地 MQTT。

- Broker: `mqtt://<productKey>.iot-as-mqtt.<region>.aliyuncs.com:1883`
- clientId mode: `securemode=3,signmethod=hmacsha256`

## 快速启动

```bash
npm install
npm run start
```

浏览器打开 `http://localhost:3000`。

## Render 上云（公网访问）

本项目可直接部署到 Render Web Service（适配当前 `Node + Socket.IO` 常驻服务）。

1. 将代码推送到 Git 仓库（GitHub/GitLab）。
2. 在 Render 中选择 `New +` -> `Blueprint`，选择该仓库。
3. 使用仓库内 `render.yaml` 自动创建服务。
4. 等待构建完成后访问：
   - `https://<your-service>.onrender.com`

构建与启动命令：

- Build: `npm ci`
- Start: `npm run start`

### Render 环境变量配置（必填）

请在 Render Dashboard 中逐项填写敏感配置（不要提交 `.env` 到仓库）：

- `ALIYUN_PRODUCT_KEY`
- `ALIYUN_DEVICE_NAME`
- `ALIYUN_DEVICE_SECRET`
- `ALIYUN_REGION_ID`
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ALIYUN_IOT_INSTANCE_ID`（企业实例建议填写）

默认推荐值（已在 `render.yaml` 固化）：

- `ENABLE_LOCAL_MQTT=false`
- `ALLOW_CLOUD_ROUTE_MQTT_FALLBACK=false`
- `PROPERTY_POLL_ON_CONNECT=true`
- `PROPERTY_POLL_INTERVAL_MS=2000`
- `AUTO_CONNECT_ON_START=true`

### 回滚与排查

- 回滚：Render 服务页 `Deploys` 选择历史成功版本点击 `Rollback`。
- 日志：服务页 `Logs` 检查启动、OpenAPI、下发与状态轮询日志。
- 常见错误：
  - `iot.Sre.IotInstanceNotFound`：`ALIYUN_IOT_INSTANCE_ID` 与地域不匹配
  - `iot.prod.NotExistedProduct`：AK/SK 对应账号无该产品权限或地域不匹配
  - `Target device ... OFFLINE`：设备当前未在线，检查设备端 MQTT 会话

## 环境变量（本地开发）

复制 `.env.example` 为 `.env`，最少配置：

- `ALIYUN_PRODUCT_KEY`
- `ALIYUN_DEVICE_NAME`
- `ALIYUN_DEVICE_SECRET`
- `ALIYUN_REGION_ID`

物模型与云端指令路由依赖 OpenAPI：

- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ALIYUN_IOT_INSTANCE_ID`（企业实例建议填写）

可选：

- `ENABLE_LOCAL_MQTT=false`
  - 默认 `false`。
  - 真实设备联调建议保持关闭，避免网页与硬件抢占同一设备会话。
- `ALLOW_CLOUD_ROUTE_MQTT_FALLBACK=false`
  - 默认 `false`。
  - 建议保持关闭，避免 `/sys/...` 指令在 OpenAPI 失败后回落 raw MQTT，造成“发布成功但设备无响应”的假象。
- `AUTO_CONNECT_ON_START=true`
  - 云端部署建议 `true`，服务启动后自动进入“可展示/可下发”状态。
  - 本地联调可按需改为 `false`。
- `TARGET_ONLINE_WAIT_MS=15000`
- `TARGET_ONLINE_POLL_MS=1500`
- `STRICT_TARGET_ONLINE_CHECK=false`
  - 默认非严格模式：即使预检查仍显示离线，也会尝试一次云端下发，减少状态同步延迟导致的误判。
- `CLOUD_DISPATCH_RETRY_ATTEMPTS=3`
- `CLOUD_DISPATCH_RETRY_INTERVAL_MS=2000`
  - 当云端返回 `OFFLINE` 时短时重试，覆盖设备端自动重连窗口。
- `PROPERTY_POLL_ON_CONNECT=true`
- `PROPERTY_POLL_INTERVAL_MS=2000`
  - 连接后自动轮询设备属性状态，并推送到前端状态面板。

## 页面功能

- 连接状态与日志
- 物模型属性自动同步（连接后自动拉取 + 手动刷新）
- 设备当前状态监控（实时轮询 + 手动刷新）
- Topic 订阅
- Topic 发布（含属性快捷填充）
- 页面默认不自动连接 MQTT（避免误占设备会话）
- 连接按钮在默认模式下不会建立本地 MQTT 设备会话，而是进入“云端命令就绪”状态
- 当 `ENABLE_LOCAL_MQTT=false` 时，订阅面板会禁用

## 状态接口

- `GET /api/device/properties`
  - 返回当前缓存的设备属性状态。
- `POST /api/device/properties/refresh`
  - 手动触发一次状态刷新（OpenAPI `QueryDevicePropertyStatus`）。

## Topic 发布路由与 JSON 规范

后端会按 Topic 自动路由：

1. `/sys/{pk}/{dn}/thing/service/property/set`
- 路由到 OpenAPI `SetDeviceProperty`
- 推荐 payload：

```json
{
  "id": "1",
  "version": "1.0",
  "params": {
    "PowerSwitch": 1
  },
  "method": "thing.service.property.set"
}
```

2. `/sys/{pk}/{dn}/thing/service/{serviceIdentifier}`
- 路由到 OpenAPI `InvokeThingService`
- 推荐 payload：

```json
{
  "id": "1",
  "version": "1.0",
  "params": {
    "Speed": 2
  },
  "method": "thing.service.<serviceIdentifier>"
}
```

3. `/{pk}/{dn}/user/...`
- 路由到 OpenAPI `Pub`（自动 Base64 编码）

4. 其他 Topic
- 使用 MQTT raw publish

## 本次关键改动

- 发布前自动标准化 Topic 输入：
  - `sys/...` 自动补 `/`
  - `user/...` 自动补成 `/{pk}/{dn}/user/...`
- `property/set` 与 `service` payload 自动补齐 `id/version/method/params`
- 默认订阅增加回复 Topic（例如 `property/set_reply`），便于观察设备应答
- 根据设备 callback 约束重写下发：
  - 仅允许 callback 可处理的属性键：`identify_check`、`Light_Status`、`Door_Status`
  - 对物模型只读属性直接拦截，避免无效下发
  - 按物模型类型自动转换（如 `bool` -> `0/1`）

## 常见问题

1. 连接在线但设备无响应
- 检查发布路由是否为 `set_device_property` / `invoke_thing_service`
- 检查 payload 中 `params` 键名是否为物模型 `identifier`
- 检查设备端是否订阅/处理对应系统 Topic
- 注意：同一设备三要素通常只允许一个 MQTT 会话。若本控制台以相同三要素连接，可能会挤掉真实设备连接。
  - 现已实现：系统命令下发前会自动释放本地同设备 MQTT 会话，并轮询等待设备回线后再下发。

2. 物模型刷新失败
- `iot.Sre.IotInstanceNotFound`：`ALIYUN_IOT_INSTANCE_ID` 与地域不匹配
- `iot.prod.NotExistedProduct`：AK/SK 无该产品权限，或地域/实例不匹配
