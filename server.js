const http = require("http");
const path = require("path");

const dotenv = require("dotenv");
const express = require("express");
const { Server } = require("socket.io");
const { v5: IotdaV5 } = require("@huaweicloud/huaweicloud-sdk-iotda");
const { BasicCredentials } = require("@huaweicloud/huaweicloud-sdk-core/auth/BasicCredentials");

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_REGION =
  String(process.env.HWCLOUD_REGION_ID || process.env.HUAWEI_IOT_REGION_ID || "cn-east-3").trim() || "cn-east-3";
const DEFAULT_SERVICE_ID =
  String(process.env.HWCLOUD_SERVICE_ID || process.env.HUAWEI_IOT_SERVICE_ID || "Rets2").trim() || "Rets2";

const TARGET_ONLINE_WAIT_MS = Number(process.env.TARGET_ONLINE_WAIT_MS || 15000);
const TARGET_ONLINE_POLL_MS = Number(process.env.TARGET_ONLINE_POLL_MS || 1500);
const STRICT_TARGET_ONLINE_CHECK =
  String(process.env.STRICT_TARGET_ONLINE_CHECK || "false").toLowerCase() === "true";
const CLOUD_DISPATCH_RETRY_ATTEMPTS = Math.max(1, Number(process.env.CLOUD_DISPATCH_RETRY_ATTEMPTS || 3));
const CLOUD_DISPATCH_RETRY_INTERVAL_MS = Number(process.env.CLOUD_DISPATCH_RETRY_INTERVAL_MS || 2000);

const PROPERTY_POLL_ON_CONNECT =
  String(process.env.PROPERTY_POLL_ON_CONNECT || "true").toLowerCase() === "true";
const PROPERTY_POLL_INTERVAL_MS = Math.max(2000, Number(process.env.PROPERTY_POLL_INTERVAL_MS || 2000));
const AUTO_CONNECT_ON_START =
  String(process.env.AUTO_CONNECT_ON_START || "false").toLowerCase() === "true";
const DEFAULT_USE_DERIVED_PREDICATE =
  String(process.env.HWCLOUD_USE_DERIVED_PREDICATE || process.env.HUAWEI_IOT_USE_DERIVED_PREDICATE || "true")
    .toLowerCase()
    .trim() !== "false";

const ENV_DEFAULTS = {
  regionId: pickFirstNonEmpty(process.env.HWCLOUD_REGION_ID, process.env.HUAWEI_IOT_REGION_ID, DEFAULT_REGION),
  endpoint: pickFirstNonEmpty(process.env.HWCLOUD_ENDPOINT, process.env.HUAWEI_IOT_ENDPOINT),
  projectId: pickFirstNonEmpty(process.env.HWCLOUD_PROJECT_ID, process.env.HUAWEI_IOT_PROJECT_ID),
  ak: pickFirstNonEmpty(process.env.HWCLOUD_AK, process.env.HUAWEI_IOT_AK),
  sk: pickFirstNonEmpty(process.env.HWCLOUD_SK, process.env.HUAWEI_IOT_SK),
  deviceId: pickFirstNonEmpty(process.env.HWCLOUD_DEVICE_ID, process.env.HUAWEI_IOT_DEVICE_ID),
  productId: pickFirstNonEmpty(process.env.HWCLOUD_PRODUCT_ID, process.env.HUAWEI_IOT_PRODUCT_ID),
  serviceId: pickFirstNonEmpty(process.env.HWCLOUD_SERVICE_ID, process.env.HUAWEI_IOT_SERVICE_ID, DEFAULT_SERVICE_ID),
  instanceId: pickFirstNonEmpty(process.env.HWCLOUD_INSTANCE_ID, process.env.HUAWEI_IOT_INSTANCE_ID) || null,
  appId: pickFirstNonEmpty(process.env.HWCLOUD_APP_ID, process.env.HUAWEI_IOT_APP_ID) || null,
  useDerivedPredicate: DEFAULT_USE_DERIVED_PREDICATE
};

const state = {
  client: null,
  connected: false,
  connecting: false,
  config: null,
  subscriptions: new Set(),
  lastError: null,
  targetDevice: {
    status: null,
    updatedAt: null
  },
  propertyState: {
    properties: [],
    updatedAt: null,
    lastError: null,
    source: null
  },
  thingModel: {
    properties: [],
    updatedAt: null,
    lastError: null,
    source: null
  }
};

let propertyPollTimer = null;
let propertyPollRunning = false;
let cachedClientKey = "";
let cachedIotdaClient = null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function nowIso() {
  return new Date().toISOString();
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function parseBooleanOrFallback(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (["true", "1", "yes", "y", "on"].includes(text)) return true;
  if (["false", "0", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function readField(source, ...keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      return source[key];
    }
  }
  return undefined;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasHuaweiCredentials(config = ENV_DEFAULTS) {
  return Boolean(config.projectId) && Boolean(config.ak) && Boolean(config.sk);
}

function hasHuaweiDeviceConfig(config = ENV_DEFAULTS) {
  return Boolean(config.deviceId) && Boolean(config.productId);
}

function redactConfig(config) {
  if (!config) return null;
  return {
    provider: "huawei_iotda",
    regionId: config.regionId,
    endpoint: config.endpoint || null,
    projectId: config.projectId,
    productId: config.productId,
    deviceId: config.deviceId,
    serviceId: config.serviceId,
    productKey: config.productId,
    deviceName: config.deviceId,
    clientId: null,
    transport: "openapi_command_only",
    useDerivedPredicate: config.useDerivedPredicate !== false
  };
}

function thingModelMeta() {
  return {
    count: state.thingModel.properties.length,
    updatedAt: state.thingModel.updatedAt,
    lastError: state.thingModel.lastError,
    source: state.thingModel.source
  };
}

function propertyStateMeta() {
  return {
    count: state.propertyState.properties.length,
    updatedAt: state.propertyState.updatedAt,
    lastError: state.propertyState.lastError,
    source: state.propertyState.source
  };
}

function statusPayload() {
  return {
    connected: state.connected,
    connecting: state.connecting,
    config: redactConfig(state.config),
    subscriptions: [...state.subscriptions],
    lastError: state.lastError,
    targetDevice: state.targetDevice,
    propertyState: propertyStateMeta(),
    thingModel: thingModelMeta(),
    timestamp: nowIso()
  };
}

function emitStatus() {
  io.emit("status", statusPayload());
}

function emitThingModelEvent(trigger = "unknown") {
  io.emit("thing_model", {
    trigger,
    properties: state.thingModel.properties,
    updatedAt: state.thingModel.updatedAt,
    lastError: state.thingModel.lastError,
    source: state.thingModel.source
  });
}

function emitPropertyStateEvent(trigger = "unknown") {
  io.emit("property_state", {
    trigger,
    properties: state.propertyState.properties,
    updatedAt: state.propertyState.updatedAt,
    lastError: state.propertyState.lastError,
    source: state.propertyState.source
  });
}

function emitLog(level, message, extra = undefined) {
  const payload = { level, message, extra, timestamp: nowIso() };
  const printer = level === "error" ? console.error : console.log;
  printer(`[${payload.timestamp}] [${level}] ${message}`, extra || "");
  io.emit("log", payload);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function buildRuntimeConfig(configInput = {}) {
  return {
    regionId: pickFirstNonEmpty(configInput.regionId, ENV_DEFAULTS.regionId, DEFAULT_REGION),
    endpoint: pickFirstNonEmpty(configInput.endpoint, ENV_DEFAULTS.endpoint),
    projectId: pickFirstNonEmpty(configInput.projectId, ENV_DEFAULTS.projectId),
    ak: pickFirstNonEmpty(configInput.ak, ENV_DEFAULTS.ak),
    sk: pickFirstNonEmpty(configInput.sk, ENV_DEFAULTS.sk),
    deviceId: pickFirstNonEmpty(configInput.deviceId, ENV_DEFAULTS.deviceId),
    productId: pickFirstNonEmpty(configInput.productId, ENV_DEFAULTS.productId),
    serviceId: pickFirstNonEmpty(configInput.serviceId, ENV_DEFAULTS.serviceId, DEFAULT_SERVICE_ID),
    instanceId: pickFirstNonEmpty(configInput.instanceId, ENV_DEFAULTS.instanceId) || null,
    appId: pickFirstNonEmpty(configInput.appId, ENV_DEFAULTS.appId) || null,
    useDerivedPredicate: parseBooleanOrFallback(configInput.useDerivedPredicate, ENV_DEFAULTS.useDerivedPredicate)
  };
}

function formatHuaweiError(error) {
  const code =
    readField(error, "errorCode", "error_code", "code") ||
    readField(error?.response, "error_code", "errorCode", "code") ||
    readField(error?.response?.data, "error_code", "errorCode", "code") ||
    null;

  const requestId =
    readField(error, "requestId", "request_id") ||
    readField(error?.response, "request_id", "requestId") ||
    readField(error?.response?.headers || {}, "x-request-id") ||
    null;

  const rawMessage =
    readField(error, "errorMsg", "error_msg", "message") ||
    readField(error?.response, "error_msg", "errorMsg", "message") ||
    readField(error?.response?.data, "error_msg", "errorMsg", "message") ||
    "Huawei IoTDA request failed";

  let message = String(rawMessage);
  const merged = `${String(code || "")} ${message}`.toLowerCase();

  if (merged.includes("project") && merged.includes("not") && merged.includes("found")) {
    message = "ProjectId 不匹配或区域错误，请检查 HWCLOUD_PROJECT_ID 与 HWCLOUD_REGION_ID。";
  } else if (merged.includes("signature") || merged.includes("ak") || merged.includes("sk")) {
    message = "AK/SK 鉴权失败，请检查 HWCLOUD_AK 与 HWCLOUD_SK。";
  } else if (merged.includes("authentication failed")) {
    message =
      "Authentication failed：请检查 AK/SK 与 ProjectId 是否同一 IAM 用户与项目；标准/企业版 IoTDA 需启用 derived 签名。";
  } else if (merged.includes("device") && merged.includes("offline")) {
    message = "目标设备离线，命令未成功下发。";
  }

  return {
    code: code ? String(code) : null,
    requestId: requestId ? String(requestId) : null,
    message,
    rawMessage: String(rawMessage)
  };
}

function getIoTdaClient(config = state.config) {
  if (!config) {
    throw new Error("Config missing. Connect first.");
  }

  const cacheKey = `${config.regionId}|${config.endpoint || ""}|${config.projectId}|${config.ak}|${config.sk}|${
    config.useDerivedPredicate ? "derived" : "legacy"
  }`;
  if (cachedIotdaClient && cacheKey === cachedClientKey) {
    return cachedIotdaClient;
  }

  let credentials = new BasicCredentials()
    .withAk(config.ak)
    .withSk(config.sk)
    .withProjectId(config.projectId);
  if (config.useDerivedPredicate) {
    credentials = credentials
      .withRegionId(config.regionId)
      .withDerivedPredicate((request) => BasicCredentials.getDefaultDerivedPredicate.call(BasicCredentials, request));
  }

  const builder = IotdaV5.IoTDAClient.newBuilder().withCredential(credentials);
  if (config.endpoint) {
    builder.withEndpoint(config.endpoint);
  } else {
    const region = IotdaV5.IoTDARegion.valueOf(config.regionId);
    builder.withRegion(region);
  }
  const client = builder.build();

  cachedClientKey = cacheKey;
  cachedIotdaClient = client;
  return client;
}

function coerceBinaryValue(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value > 0 ? 1 : 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return 0;
  if (["1", "true", "on", "open", "yes"].includes(text)) return 1;
  if (["0", "false", "off", "close", "closed", "no"].includes(text)) return 0;
  const parsed = Number(text);
  if (Number.isFinite(parsed)) return parsed > 0 ? 1 : 0;
  return 0;
}

function coerceIntegerValue(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${fieldName} is required.`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} must be a number.`);
  }

  return Math.trunc(parsed);
}

function normalizeDataType(rawType, sampleValue = undefined) {
  const type = String(rawType || "").trim().toLowerCase();
  if (type) {
    if (["int", "long", "float", "double", "number", "decimal"].includes(type)) return "number";
    if (["bool", "boolean"].includes(type)) return "bool";
    if (["string", "text", "enum", "date"].includes(type)) return "text";
    if (["struct", "object", "json"].includes(type)) return "struct";
    if (type === "array") return "array";
    return type;
  }

  if (Array.isArray(sampleValue)) return "array";
  if (sampleValue && typeof sampleValue === "object") return "struct";
  if (typeof sampleValue === "number") return "number";
  if (typeof sampleValue === "boolean") return "bool";
  return "text";
}

function normalizeRwMode(method) {
  const mode = String(method || "").trim().toLowerCase();
  if (!mode) return "rw";
  if (mode.includes("rw") || (mode.includes("read") && mode.includes("write"))) return "rw";
  if (mode === "r" || mode === "ro" || mode.includes("read")) return "r";
  if (mode === "w" || mode === "wo" || mode.includes("write")) return "w";
  return mode;
}

function normalizePropertyDefinition(raw) {
  const identifier =
    pickFirstNonEmpty(readField(raw, "propertyName", "property_name", "identifier", "name")) || null;
  if (!identifier) return null;

  const dataType = normalizeDataType(readField(raw, "dataType", "data_type"), readField(raw, "defaultValue", "default_value"));

  return {
    identifier,
    name: pickFirstNonEmpty(readField(raw, "name", "propertyName", "property_name", "identifier"), identifier),
    dataType,
    rwMode: normalizeRwMode(readField(raw, "method")),
    required: Boolean(readField(raw, "required")),
    unit: pickFirstNonEmpty(readField(raw, "unit")) || "",
    description: pickFirstNonEmpty(readField(raw, "description")) || ""
  };
}

function normalizePropertyList(sourceProperties) {
  if (!Array.isArray(sourceProperties)) return [];
  return sourceProperties
    .map(normalizePropertyDefinition)
    .filter(Boolean)
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
}

function setThingModel(properties, source, trigger) {
  state.thingModel.properties = properties;
  state.thingModel.updatedAt = nowIso();
  state.thingModel.lastError = null;
  state.thingModel.source = source;

  if (Array.isArray(state.propertyState.properties) && state.propertyState.properties.length > 0) {
    state.propertyState.properties = mergePropertyStateWithThingModel(state.propertyState.properties);
    emitPropertyStateEvent("thing_model_sync");
  }

  emitThingModelEvent(trigger);
  emitStatus();
}

function setThingModelError(message, source, trigger) {
  state.thingModel.lastError = message;
  state.thingModel.source = source;
  emitThingModelEvent(trigger);
  emitStatus();
}

function setPropertyState(properties, source, trigger) {
  state.propertyState.properties = properties;
  state.propertyState.updatedAt = nowIso();
  state.propertyState.lastError = null;
  state.propertyState.source = source;
  emitPropertyStateEvent(trigger);
  emitStatus();
}

function setPropertyStateError(message, source, trigger) {
  state.propertyState.lastError = message;
  state.propertyState.source = source;
  emitPropertyStateEvent(trigger);
  emitStatus();
}
function normalizePropertyStateEntry(identifier, value, timestamp = nowIso()) {
  const model = state.thingModel.properties.find((item) => item.identifier === identifier);
  const dataType = model?.dataType || normalizeDataType("", value);
  const valueRaw = typeof value === "string" ? value : JSON.stringify(value);

  return {
    identifier,
    name: model?.name || identifier,
    dataType,
    rwMode: model?.rwMode || null,
    required: model?.required ?? false,
    unit: model?.unit || "",
    value,
    valueRaw,
    timestamp
  };
}

function mergePropertyStateWithThingModel(statusEntries) {
  const map = new Map();

  for (const entry of Array.isArray(statusEntries) ? statusEntries : []) {
    if (!entry?.identifier) continue;
    map.set(entry.identifier, entry);
  }

  for (const model of state.thingModel.properties) {
    if (!map.has(model.identifier)) {
      map.set(model.identifier, {
        identifier: model.identifier,
        name: model.name,
        dataType: model.dataType,
        rwMode: model.rwMode,
        required: model.required,
        unit: model.unit || "",
        value: null,
        valueRaw: "",
        timestamp: null
      });
    } else {
      const existing = map.get(model.identifier);
      map.set(model.identifier, {
        ...existing,
        name: existing.name || model.name,
        dataType: existing.dataType || model.dataType,
        rwMode: existing.rwMode || model.rwMode,
        required: existing.required ?? model.required ?? false,
        unit: existing.unit || model.unit || ""
      });
    }
  }

  return [...map.values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
}

function applyRequestCommon(request, config = state.config) {
  if (config?.instanceId && typeof request.withInstanceId === "function") {
    request.withInstanceId(config.instanceId);
  }
  if (config?.appId && typeof request.withAppId === "function") {
    request.withAppId(config.appId);
  }
  return request;
}

async function queryTargetDeviceStatus() {
  if (!state.config?.deviceId) {
    throw new Error("DeviceId missing. Connect first.");
  }

  const client = getIoTdaClient();
  const request = applyRequestCommon(new IotdaV5.ShowDeviceRequest().withDeviceId(state.config.deviceId));
  const response = await client.showDevice(request);

  const status = String(readField(response, "status") || "UNKNOWN").toUpperCase();
  state.targetDevice.status = status;
  state.targetDevice.updatedAt = nowIso();
  emitStatus();

  return {
    status,
    detail: {
      deviceId: pickFirstNonEmpty(readField(response, "deviceId", "device_id"), state.config.deviceId),
      productId: pickFirstNonEmpty(readField(response, "productId", "product_id"), state.config.productId)
    }
  };
}

async function waitForTargetOnline(options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : TARGET_ONLINE_WAIT_MS;
  const pollMs = Number.isFinite(Number(options.pollMs)) ? Number(options.pollMs) : TARGET_ONLINE_POLL_MS;
  const strict = options.strict === undefined ? STRICT_TARGET_ONLINE_CHECK : Boolean(options.strict);

  const startedAt = Date.now();
  let lastStatus = "UNKNOWN";
  let attempts = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const result = await queryTargetDeviceStatus();
      lastStatus = result.status;
      if (lastStatus === "ONLINE") {
        return {
          online: true,
          status: lastStatus,
          attempts,
          waitedMs: Date.now() - startedAt
        };
      }
    } catch (error) {
      emitLog("warn", "ShowDevice polling failed.", { reason: error.message });
    }

    await delay(pollMs);
  }

  if (strict) {
    throw new Error(`Target device ${state.config?.deviceId || "unknown"} is ${lastStatus} after waiting ${timeoutMs}ms.`);
  }

  return {
    online: false,
    status: lastStatus,
    attempts,
    waitedMs: Date.now() - startedAt
  };
}

async function refreshThingModelProperties(trigger = "manual") {
  if (!state.config?.productId) {
    throw new Error("ProductId missing. Connect first.");
  }

  if (!hasHuaweiCredentials(state.config)) {
    throw new Error("Huawei AK/SK/ProjectId not configured.");
  }

  try {
    const client = getIoTdaClient();
    const request = applyRequestCommon(new IotdaV5.ShowProductRequest().withProductId(state.config.productId));
    const response = await client.showProduct(request);

    const serviceCapabilities = readField(response, "serviceCapabilities", "service_capabilities");
    const services = Array.isArray(serviceCapabilities) ? serviceCapabilities : [];

    const targetService =
      services.find(
        (item) => pickFirstNonEmpty(readField(item, "serviceId", "service_id")) === state.config.serviceId
      ) || services[0];

    if (!targetService) {
      throw new Error(`No service definitions found for product ${state.config.productId}.`);
    }

    const resolvedServiceId =
      pickFirstNonEmpty(readField(targetService, "serviceId", "service_id"), state.config.serviceId, DEFAULT_SERVICE_ID) ||
      DEFAULT_SERVICE_ID;
    state.config.serviceId = resolvedServiceId;

    const properties = normalizePropertyList(readField(targetService, "properties") || []);
    if (properties.length === 0) {
      throw new Error(`Service ${resolvedServiceId} has no properties.`);
    }

    setThingModel(properties, "huawei_show_product", trigger);
    emitLog("info", "Thing model updated via Huawei ShowProduct.", {
      serviceId: resolvedServiceId,
      count: properties.length
    });

    return {
      properties,
      updatedAt: state.thingModel.updatedAt,
      lastError: null,
      source: state.thingModel.source
    };
  } catch (error) {
    const formatted = formatHuaweiError(error);
    setThingModelError(formatted.message, "failed", trigger);
    emitLog("warn", "Thing model refresh failed.", {
      trigger,
      reason: formatted.message,
      code: formatted.code,
      requestId: formatted.requestId
    });
    throw new Error(formatted.message);
  }
}

function extractShadowEntry(shadowList, serviceId) {
  const list = Array.isArray(shadowList) ? shadowList : [];
  if (!list.length) return null;

  const exact = list.find((entry) => pickFirstNonEmpty(readField(entry, "serviceId", "service_id")) === serviceId);
  return exact || list[0];
}

function extractReportedProperties(shadowEntry) {
  const reported = readField(shadowEntry, "reported") || {};
  const rawProps = readField(reported, "properties") || {};
  const eventTime = pickFirstNonEmpty(readField(reported, "eventTime", "event_time"), nowIso());
  if (!isPlainObject(rawProps)) {
    return { properties: {}, eventTime };
  }
  return {
    properties: rawProps,
    eventTime
  };
}

async function refreshDevicePropertyState(trigger = "manual") {
  if (!state.config?.deviceId) {
    throw new Error("DeviceId missing. Connect first.");
  }

  if (!hasHuaweiCredentials(state.config)) {
    throw new Error("Huawei AK/SK/ProjectId not configured.");
  }

  try {
    const client = getIoTdaClient();
    const request = applyRequestCommon(new IotdaV5.ShowDeviceShadowRequest().withDeviceId(state.config.deviceId));
    const response = await client.showDeviceShadow(request);

    const shadow = readField(response, "shadow");
    const selected = extractShadowEntry(shadow, state.config.serviceId);

    if (!selected) {
      const mergedEmpty = mergePropertyStateWithThingModel([]);
      setPropertyState(mergedEmpty, "huawei_show_device_shadow", trigger);
      return {
        properties: mergedEmpty,
        updatedAt: state.propertyState.updatedAt,
        lastError: null,
        source: state.propertyState.source
      };
    }

    const selectedServiceId = pickFirstNonEmpty(readField(selected, "serviceId", "service_id"), state.config.serviceId);
    if (selectedServiceId) {
      state.config.serviceId = selectedServiceId;
    }

    const { properties: propsObj, eventTime } = extractReportedProperties(selected);
    const statusEntries = Object.entries(propsObj).map(([identifier, value]) =>
      normalizePropertyStateEntry(identifier, value, eventTime)
    );

    const merged = mergePropertyStateWithThingModel(statusEntries);
    setPropertyState(merged, "huawei_show_device_shadow", trigger);

    return {
      properties: merged,
      updatedAt: state.propertyState.updatedAt,
      lastError: null,
      source: state.propertyState.source
    };
  } catch (error) {
    const formatted = formatHuaweiError(error);
    setPropertyStateError(formatted.message, "failed", trigger);
    if (trigger !== "poll") {
      emitLog("warn", "Property state refresh failed.", {
        trigger,
        reason: formatted.message,
        code: formatted.code,
        requestId: formatted.requestId
      });
    }
    throw new Error(formatted.message);
  }
}
function stopPropertyPolling() {
  if (propertyPollTimer) {
    clearInterval(propertyPollTimer);
    propertyPollTimer = null;
  }
  propertyPollRunning = false;
}

function startPropertyPolling() {
  if (!PROPERTY_POLL_ON_CONNECT || propertyPollTimer || !hasHuaweiCredentials(state.config) || !state.connected) {
    return;
  }

  propertyPollTimer = setInterval(async () => {
    if (propertyPollRunning || !state.connected) return;
    propertyPollRunning = true;
    try {
      await refreshDevicePropertyState("poll");
    } catch (_error) {
      // keep poll running; errors are reflected in state
    } finally {
      propertyPollRunning = false;
    }
  }, PROPERTY_POLL_INTERVAL_MS);
}

async function disconnectClient(reason = "manual") {
  stopPropertyPolling();

  state.connected = false;
  state.connecting = false;
  state.subscriptions.clear();

  emitStatus();
  emitLog("info", `Cloud command session closed (${reason}).`);
}

function validateRuntimeConfig(config) {
  const missing = [];
  if (!config.regionId && !config.endpoint) missing.push("HWCLOUD_REGION_ID or HWCLOUD_ENDPOINT");
  if (!config.projectId) missing.push("HWCLOUD_PROJECT_ID");
  if (!config.ak) missing.push("HWCLOUD_AK");
  if (!config.sk) missing.push("HWCLOUD_SK");
  if (!config.deviceId) missing.push("HWCLOUD_DEVICE_ID");
  if (!config.productId) missing.push("HWCLOUD_PRODUCT_ID");
  if (!config.serviceId) missing.push("HWCLOUD_SERVICE_ID");
  return missing;
}

async function connectClient(configInput) {
  const config = buildRuntimeConfig(configInput || {});
  const missing = validateRuntimeConfig(config);

  if (missing.length > 0) {
    throw new Error(`Missing required Huawei config: ${missing.join(", ")}`);
  }

  await disconnectClient("reconnect");

  state.config = config;
  state.lastError = null;
  state.connecting = true;
  emitStatus();

  state.connected = true;
  state.connecting = false;
  emitStatus();

  emitLog("info", "Huawei IoTDA command mode ready.", {
    regionId: config.regionId,
    endpoint: config.endpoint || null,
    deviceId: config.deviceId,
    productId: config.productId,
    serviceId: config.serviceId,
    useDerivedPredicate: config.useDerivedPredicate !== false
  });

  try {
    const online = await waitForTargetOnline({
      timeoutMs: Math.min(TARGET_ONLINE_WAIT_MS, 8000),
      pollMs: TARGET_ONLINE_POLL_MS,
      strict: false
    });
    emitLog("info", "Target device status checked.", online);
  } catch (error) {
    emitLog("warn", "Target status check failed.", { reason: error.message });
  }

  try {
    await refreshThingModelProperties("cloud_connect");
  } catch (_error) {
    // keep connected
  }

  try {
    await refreshDevicePropertyState("cloud_connect");
  } catch (_error) {
    // keep connected
  }

  startPropertyPolling();
}

function parsePayloadObject(payload) {
  if (payload === null || payload === undefined || payload === "") {
    return {};
  }

  if (typeof payload === "string") {
    const text = payload.trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw new Error("payload must be valid JSON.");
    }
  }

  if (!isPlainObject(payload)) {
    throw new Error("payload must be an object JSON.");
  }

  return payload;
}

function detectCommandNameByParams(params) {
  if (!isPlainObject(params)) return "";
  const hasLight = Object.prototype.hasOwnProperty.call(params, "Light_Status");
  const hasRelay = Object.prototype.hasOwnProperty.call(params, "Relay_Status");

  if (hasLight && hasRelay) {
    throw new Error("params cannot contain both Light_Status and Relay_Status in one command.");
  }
  if (hasLight) return "turn_light";
  if (hasRelay) return "turn_relay";
  return "";
}

function normalizeCommandPayload(payload) {
  const body = parsePayloadObject(payload);
  const warnings = [];

  const serviceId = pickFirstNonEmpty(
    readField(body, "service_id", "serviceId"),
    state.config?.serviceId,
    DEFAULT_SERVICE_ID
  );

  let commandName = pickFirstNonEmpty(readField(body, "command_name", "commandName"));
  let paras = isPlainObject(readField(body, "paras")) ? { ...readField(body, "paras") } : {};

  const method = String(readField(body, "method") || "").trim();
  const params = isPlainObject(readField(body, "params")) ? { ...readField(body, "params") } : {};

  if (!commandName) {
    if (method === "thing.service.property.set" || Object.keys(params).length > 0) {
      commandName = detectCommandNameByParams(params);
      if (commandName) {
        warnings.push("Legacy property payload detected and auto-converted to Huawei command payload.");
        paras = { ...params };
      }
    }
  }

  if (!commandName) {
    throw new Error("Missing command_name. Supported commands: turn_light, turn_relay, blink_light, blink_relay.");
  }

  commandName = String(commandName).trim();

  if (commandName === "turn_light") {
    const rawValue = paras.Light_Status;
    if (rawValue === undefined) {
      throw new Error("turn_light requires paras.Light_Status.");
    }

    return {
      normalizedPayload: {
        service_id: serviceId,
        command_name: "turn_light",
        paras: {
          Light_Status: coerceBinaryValue(rawValue)
        }
      },
      warnings
    };
  }

  if (commandName === "turn_relay") {
    const rawValue = paras.Relay_Status;
    if (rawValue === undefined) {
      throw new Error("turn_relay requires paras.Relay_Status.");
    }

    return {
      normalizedPayload: {
        service_id: serviceId,
        command_name: "turn_relay",
        paras: {
          Relay_Status: coerceBinaryValue(rawValue)
        }
      },
      warnings
    };
  }

  if (commandName === "blink_light") {
    const blinkCount = coerceIntegerValue(paras.blink_count, "blink_light paras.blink_count");
    const onMs = coerceIntegerValue(paras.on_ms, "blink_light paras.on_ms");
    const offMs = coerceIntegerValue(paras.off_ms, "blink_light paras.off_ms");

    if (blinkCount <= 0) throw new Error("blink_light paras.blink_count must be > 0.");
    if (onMs <= 0) throw new Error("blink_light paras.on_ms must be > 0.");
    if (offMs <= 0) throw new Error("blink_light paras.off_ms must be > 0.");

    return {
      normalizedPayload: {
        service_id: serviceId,
        command_name: "blink_light",
        paras: {
          blink_count: blinkCount,
          on_ms: onMs,
          off_ms: offMs
        }
      },
      warnings
    };
  }

  if (commandName === "blink_relay") {
    const blinkCount = coerceIntegerValue(paras.blink_count, "blink_relay paras.blink_count");
    const onMs = coerceIntegerValue(paras.on_ms, "blink_relay paras.on_ms");
    const offMs = coerceIntegerValue(paras.off_ms, "blink_relay paras.off_ms");

    if (blinkCount <= 0) throw new Error("blink_relay paras.blink_count must be > 0.");
    if (onMs <= 0) throw new Error("blink_relay paras.on_ms must be > 0.");
    if (offMs <= 0) throw new Error("blink_relay paras.off_ms must be > 0.");

    return {
      normalizedPayload: {
        service_id: serviceId,
        command_name: "blink_relay",
        paras: {
          blink_count: blinkCount,
          on_ms: onMs,
          off_ms: offMs
        }
      },
      warnings
    };
  }

  throw new Error(
    `Unsupported command_name: ${commandName}. Allowed: turn_light, turn_relay, blink_light, blink_relay.`
  );
}

async function retryCloudDispatch(actionName, runner) {
  let lastError = null;
  for (let i = 1; i <= CLOUD_DISPATCH_RETRY_ATTEMPTS; i += 1) {
    try {
      const result = await runner();
      return { result, attempts: i };
    } catch (error) {
      lastError = error;
      if (i >= CLOUD_DISPATCH_RETRY_ATTEMPTS) break;
      await delay(CLOUD_DISPATCH_RETRY_INTERVAL_MS);
      emitLog("warn", `${actionName} failed, retrying...`, {
        attempt: i,
        nextAttemptInMs: CLOUD_DISPATCH_RETRY_INTERVAL_MS,
        reason: error.message
      });
    }
  }
  throw lastError || new Error(`${actionName} failed.`);
}

async function dispatchHuaweiCommand({ topic, payload }) {
  const { normalizedPayload, warnings } = normalizeCommandPayload(payload);

  const targetOnlineWait = await waitForTargetOnline({
    timeoutMs: TARGET_ONLINE_WAIT_MS,
    pollMs: TARGET_ONLINE_POLL_MS,
    strict: STRICT_TARGET_ONLINE_CHECK
  });

  const client = getIoTdaClient();

  const body = new IotdaV5.DeviceCommandRequest()
    .withServiceId(normalizedPayload.service_id)
    .withCommandName(normalizedPayload.command_name)
    .withParas(normalizedPayload.paras);

  const request = applyRequestCommon(
    new IotdaV5.CreateCommandRequest().withDeviceId(state.config.deviceId).withBody(body)
  );

  const dispatch = await retryCloudDispatch("CreateCommand", () => client.createCommand(request));
  const response = dispatch.result;

  const responseErrorCode = pickFirstNonEmpty(readField(response, "errorCode", "error_code"));
  if (responseErrorCode && responseErrorCode !== "0") {
    throw new Error(`CreateCommand failed with error_code=${responseErrorCode}`);
  }

  const commandTopic = topic || `$oc/devices/${state.config.deviceId}/sys/commands`;

  return {
    topic: commandTopic,
    route: "huawei_create_command",
    warnings,
    normalizedPayload,
    responseData: {
      commandId: readField(response, "commandId", "command_id") || null,
      response: readField(response, "response") || null,
      errorCode: responseErrorCode || null,
      errorMsg: readField(response, "errorMsg", "error_msg") || null
    },
    targetStatus: targetOnlineWait.status,
    targetOnlineWait,
    retryAttempts: dispatch.attempts
  };
}

function ensureConnected(res) {
  if (!state.connected || !state.config) {
    res.status(400).json({
      ok: false,
      message: "Huawei command channel is not connected. Call /api/connect first."
    });
    return false;
  }
  return true;
}
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    ...statusPayload(),
    defaults: {
      regionId: DEFAULT_REGION,
      hasEnvTriplet: hasHuaweiDeviceConfig(ENV_DEFAULTS),
      autoConnectOnStart: AUTO_CONNECT_ON_START,
      hasOpenApiCredentials: hasHuaweiCredentials(ENV_DEFAULTS),
      transport: "openapi_command_only",
      strictTargetOnlineCheck: STRICT_TARGET_ONLINE_CHECK,
      targetOnlineWaitMs: TARGET_ONLINE_WAIT_MS,
      targetOnlinePollMs: TARGET_ONLINE_POLL_MS,
      cloudDispatchRetryAttempts: CLOUD_DISPATCH_RETRY_ATTEMPTS,
      cloudDispatchRetryIntervalMs: CLOUD_DISPATCH_RETRY_INTERVAL_MS,
      propertyPollOnConnect: PROPERTY_POLL_ON_CONNECT,
      propertyPollIntervalMs: PROPERTY_POLL_INTERVAL_MS,
      useDerivedPredicate: DEFAULT_USE_DERIVED_PREDICATE,
      provider: "huawei_iotda"
    }
  });
});

app.get("/api/model/properties", (req, res) => {
  res.json({
    ok: true,
    properties: state.thingModel.properties,
    updatedAt: state.thingModel.updatedAt,
    lastError: state.thingModel.lastError,
    source: state.thingModel.source
  });
});

app.get("/api/device/properties", (req, res) => {
  res.json({
    ok: true,
    properties: state.propertyState.properties,
    updatedAt: state.propertyState.updatedAt,
    lastError: state.propertyState.lastError,
    source: state.propertyState.source
  });
});

app.post("/api/model/refresh", async (req, res) => {
  if (!ensureConnected(res)) return;

  try {
    const result = await refreshThingModelProperties("manual_refresh");
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
      properties: state.thingModel.properties,
      updatedAt: state.thingModel.updatedAt,
      lastError: state.thingModel.lastError,
      source: state.thingModel.source
    });
  }
});

app.post("/api/device/properties/refresh", async (req, res) => {
  if (!ensureConnected(res)) return;

  try {
    const result = await refreshDevicePropertyState("manual_refresh");
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message,
      properties: state.propertyState.properties,
      updatedAt: state.propertyState.updatedAt,
      lastError: state.propertyState.lastError,
      source: state.propertyState.source
    });
  }
});

app.post("/api/connect", async (req, res) => {
  try {
    await connectClient(req.body || {});
    res.json({
      ok: true,
      message: "Huawei IoTDA command mode ready."
    });
  } catch (error) {
    state.lastError = error.message;
    emitStatus();
    emitLog("error", "Connect request failed.", { reason: error.message });
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post("/api/disconnect", async (req, res) => {
  await disconnectClient("api");
  res.json({ ok: true, message: "Disconnected." });
});

app.post("/api/subscribe", async (req, res) => {
  res.status(400).json({
    ok: false,
    message: "Subscription is disabled in Huawei API command mode."
  });
});

app.post("/api/unsubscribe", async (req, res) => {
  res.status(400).json({
    ok: false,
    message: "Unsubscribe is disabled in Huawei API command mode."
  });
});

app.post("/api/publish", async (req, res) => {
  if (!ensureConnected(res)) return;

  const topic = String(req.body?.topic || "").trim();
  const payload = req.body?.payload;

  try {
    const result = await dispatchHuaweiCommand({ topic, payload });

    io.emit("published", {
      topic: result.topic,
      payload: JSON.stringify(result.normalizedPayload),
      route: result.route,
      timestamp: nowIso()
    });

    emitLog("info", `Command dispatched: ${result.normalizedPayload.command_name}`, {
      topic: result.topic,
      route: result.route,
      retryAttempts: result.retryAttempts,
      targetStatus: result.targetStatus
    });

    res.json({
      ok: true,
      message: "Command published.",
      topic: result.topic,
      route: result.route,
      warnings: result.warnings,
      normalizedPayload: result.normalizedPayload,
      responseData: result.responseData,
      targetStatus: result.targetStatus,
      targetOnlineWait: result.targetOnlineWait,
      retryAttempts: result.retryAttempts
    });
  } catch (error) {
    const formatted = formatHuaweiError(error);
    emitLog("error", `Cloud command failed: ${topic || "(default command route)"}`, {
      reason: formatted.message,
      code: formatted.code,
      requestId: formatted.requestId
    });

    res.status(400).json({
      ok: false,
      message: formatted.message,
      code: formatted.code,
      requestId: formatted.requestId
    });
  }
});

io.on("connection", (socket) => {
  socket.emit("status", statusPayload());
  socket.emit("thing_model", {
    trigger: "init",
    properties: state.thingModel.properties,
    updatedAt: state.thingModel.updatedAt,
    lastError: state.thingModel.lastError,
    source: state.thingModel.source
  });
  socket.emit("property_state", {
    trigger: "init",
    properties: state.propertyState.properties,
    updatedAt: state.propertyState.updatedAt,
    lastError: state.propertyState.lastError,
    source: state.propertyState.source
  });
});

server.listen(PORT, () => {
  emitLog("info", `Server started at http://0.0.0.0:${PORT}`);

  if (AUTO_CONNECT_ON_START && hasHuaweiDeviceConfig(ENV_DEFAULTS) && hasHuaweiCredentials(ENV_DEFAULTS)) {
    setTimeout(async () => {
      try {
        await connectClient({});
        emitLog("info", "AUTO_CONNECT_ON_START succeeded.");
      } catch (error) {
        state.lastError = error.message;
        emitStatus();
        emitLog("error", "AUTO_CONNECT_ON_START failed.", { reason: error.message });
      }
    }, 600);
  }
});
