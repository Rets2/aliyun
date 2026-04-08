const crypto = require("crypto");
const http = require("http");
const path = require("path");

const dotenv = require("dotenv");
const express = require("express");
const mqtt = require("mqtt");
const POPCore = require("@alicloud/pop-core");
const { Server } = require("socket.io");

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_REGION = process.env.ALIYUN_REGION_ID || "cn-shanghai";

const ENV_TRIPLET = {
  productKey: String(process.env.ALIYUN_PRODUCT_KEY || "").trim(),
  deviceName: String(process.env.ALIYUN_DEVICE_NAME || "").trim(),
  deviceSecret: String(process.env.ALIYUN_DEVICE_SECRET || "").trim()
};

const HAS_ENV_TRIPLET =
  Boolean(ENV_TRIPLET.productKey) &&
  Boolean(ENV_TRIPLET.deviceName) &&
  Boolean(ENV_TRIPLET.deviceSecret);

const AUTO_CONNECT_ON_START =
  String(process.env.AUTO_CONNECT_ON_START || "false") === "true";

const OPENAPI_CONFIG = {
  accessKeyId: String(process.env.ALIYUN_ACCESS_KEY_ID || "").trim(),
  accessKeySecret: String(process.env.ALIYUN_ACCESS_KEY_SECRET || "").trim(),
  iotInstanceId: String(process.env.ALIYUN_IOT_INSTANCE_ID || "").trim() || null
};

const ENABLE_LOCAL_MQTT =
  String(process.env.ENABLE_LOCAL_MQTT || "false").toLowerCase() === "true";

const ALLOW_CLOUD_ROUTE_MQTT_FALLBACK =
  String(process.env.ALLOW_CLOUD_ROUTE_MQTT_FALLBACK || "false").toLowerCase() === "true";

const CALLBACK_COMPATIBLE_IDENTIFIERS = new Set(["identify_check", "Light_Status", "Door_Status"]);
const TARGET_ONLINE_WAIT_MS = Number(process.env.TARGET_ONLINE_WAIT_MS || 15000);
const TARGET_ONLINE_POLL_MS = Number(process.env.TARGET_ONLINE_POLL_MS || 1500);
const STRICT_TARGET_ONLINE_CHECK =
  String(process.env.STRICT_TARGET_ONLINE_CHECK || "false").toLowerCase() === "true";
const CLOUD_DISPATCH_RETRY_ATTEMPTS = Number(process.env.CLOUD_DISPATCH_RETRY_ATTEMPTS || 3);
const CLOUD_DISPATCH_RETRY_INTERVAL_MS = Number(process.env.CLOUD_DISPATCH_RETRY_INTERVAL_MS || 2000);
const PROPERTY_POLL_INTERVAL_MS = Math.max(2000, Number(process.env.PROPERTY_POLL_INTERVAL_MS || 2000));
const PROPERTY_POLL_ON_CONNECT =
  String(process.env.PROPERTY_POLL_ON_CONNECT || "true").toLowerCase() === "true";

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

function redactConfig(config) {
  if (!config) return null;
  return {
    productKey: config.productKey,
    deviceName: config.deviceName,
    regionId: config.regionId,
    clientId: config.clientId,
    transport: ENABLE_LOCAL_MQTT ? "mqtt://:1883 (non-TLS)" : "openapi_command_only"
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
  const payload = {
    level,
    message,
    extra,
    timestamp: nowIso()
  };
  const printer = level === "error" ? console.error : console.log;
  printer(`[${payload.timestamp}] [${level}] ${message}`, extra || "");
  io.emit("log", payload);
}

function classifyMqttError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  const merged = `${code} ${message}`;

  if (merged.includes("unacceptable protocol version") || merged.includes("connack")) {
    return {
      kind: "protocol_or_auth",
      hint: "Check securemode/signmethod, triplet, and region."
    };
  }

  if (
    merged.includes("not authorized") ||
    merged.includes("username or password is malformed") ||
    merged.includes("identifier rejected")
  ) {
    return {
      kind: "auth",
      hint: "Check ProductKey, DeviceName, and DeviceSecret."
    };
  }

  if (["econnrefused", "econnreset", "etimedout", "enotfound"].some((key) => merged.includes(key))) {
    return {
      kind: "network",
      hint: "Check region endpoint, firewall, and port 1883 reachability."
    };
  }

  return {
    kind: "unknown",
    hint: "Check MQTT TCP non-TLS access policy."
  };
}

function formatOpenApiError(error) {
  const rawCandidates = [
    error?.data?.Message,
    error?.data?.message,
    error?.message,
    error?.msg,
    error?.Code,
    error?.code
  ];
  let rawMessage =
    rawCandidates.find((item) => typeof item === "string" && item.trim() && item.trim() !== "undefined") ||
    "OpenAPI request failed";

  const code = error?.data?.Code || error?.code || error?.Code || null;
  const requestId = error?.data?.RequestId || error?.requestId || null;

  if (typeof rawMessage === "string" && rawMessage.trim().startsWith("undefined")) {
    rawMessage = code || "OpenAPI request failed";
  }

  let message = rawMessage;
  if (code === "iot.Sre.IotInstanceNotFound") {
    message = "IotInstanceId is invalid or mismatched with region. Check ALIYUN_IOT_INSTANCE_ID.";
  } else if (code === "iot.prod.NotExistedProduct") {
    message = "ProductKey not found under current account/region/instance. Check product region and AK/SK scope.";
  } else if (code === "iot.messagebroker.OFFLINE") {
    message = "Target device is offline from cloud perspective.";
  }

  return {
    message,
    rawMessage,
    code,
    requestId
  };
}

function makeOpenApiClient(regionId) {
  const endpoint = `https://iot.${regionId}.aliyuncs.com`;
  return new POPCore({
    accessKeyId: OPENAPI_CONFIG.accessKeyId,
    accessKeySecret: OPENAPI_CONFIG.accessKeySecret,
    endpoint,
    apiVersion: "2018-01-20"
  });
}

function hasOpenApiCredentials() {
  return Boolean(OPENAPI_CONFIG.accessKeyId) && Boolean(OPENAPI_CONFIG.accessKeySecret);
}

function canRetryWithoutInstance(errorCode) {
  const code = String(errorCode || "");
  return ["iot.Sre.IotInstanceNotFound", "iot.auth.IotInstanceNotFound", "iot.auth.InvalidIotInstanceId"].includes(
    code
  );
}

async function openApiRequestWithInstanceFallback(action, baseParamsBuilder, requestOptions = { method: "POST" }) {
  if (!hasOpenApiCredentials()) {
    throw new Error("OpenAPI credentials are not configured.");
  }

  const client = makeOpenApiClient(state.config?.regionId || DEFAULT_REGION);
  const attempts = [];
  if (OPENAPI_CONFIG.iotInstanceId) {
    attempts.push({ iotInstanceId: OPENAPI_CONFIG.iotInstanceId, label: "with_instance" });
  }
  attempts.push({ iotInstanceId: null, label: "without_instance" });

  let lastError = null;

  for (const attempt of attempts) {
    const params = baseParamsBuilder();
    if (attempt.iotInstanceId) {
      params.IotInstanceId = attempt.iotInstanceId;
    }

    try {
      const response = await client.request(action, params, requestOptions);
      return { response, attempt: attempt.label };
    } catch (error) {
      const formatted = formatOpenApiError(error);
      lastError = formatted;
      emitLog("info", `${action} failed, retry strategy ongoing.`, {
        attempt: attempt.label,
        reason: formatted.message,
        code: formatted.code,
        requestId: formatted.requestId
      });

      if (attempt.label === "with_instance" && !canRetryWithoutInstance(formatted.code)) {
        const err = new Error(formatted.message || `${action} failed.`);
        err.code = formatted.code || null;
        err.requestId = formatted.requestId || null;
        err.rawMessage = formatted.rawMessage || null;
        throw err;
      }
    }
  }

  const err = new Error(lastError?.message || `${action} failed.`);
  if (lastError?.code) err.code = lastError.code;
  if (lastError?.requestId) err.requestId = lastError.requestId;
  if (lastError?.rawMessage) err.rawMessage = lastError.rawMessage;
  throw err;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalMqttUsingSameDevice(productKey, deviceName) {
  if (!state.connected || !state.client || !state.config) return false;
  return state.config.productKey === productKey && state.config.deviceName === deviceName;
}

async function releaseLocalSessionIfSameDevice(productKey, deviceName) {
  if (!isLocalMqttUsingSameDevice(productKey, deviceName)) {
    return false;
  }

  emitLog("warn", "Local MQTT session is using the target device. Disconnecting local session before command dispatch.", {
    productKey,
    deviceName
  });
  await disconnectClient("avoid_device_session_conflict");
  await delay(1200);
  return true;
}

async function queryTargetDeviceStatus(productKey, deviceName) {
  const { response } = await openApiRequestWithInstanceFallback("GetDeviceStatus", () => ({
    ProductKey: productKey,
    DeviceName: deviceName
  }));

  const status = String(response?.Data?.Status || "UNKNOWN").toUpperCase();
  state.targetDevice.status = status;
  state.targetDevice.updatedAt = nowIso();
  emitStatus();
  return {
    status,
    detail: response?.Data || null
  };
}

async function waitForTargetOnline(productKey, deviceName, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : TARGET_ONLINE_WAIT_MS;
  const pollMs = Number.isFinite(Number(options.pollMs)) ? Number(options.pollMs) : TARGET_ONLINE_POLL_MS;
  const strict = options.strict === undefined ? STRICT_TARGET_ONLINE_CHECK : Boolean(options.strict);
  const releasedLocalSession = Boolean(options.releasedLocalSession);
  const initialDelayMs = releasedLocalSession ? Math.min(4000, Math.max(1000, pollMs * 2)) : 0;

  const startedAt = Date.now();
  let lastStatus = "UNKNOWN";
  let attempts = 0;
  let consecutiveOnline = 0;

  if (initialDelayMs > 0) {
    await delay(initialDelayMs);
  }

  while (Date.now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      const statusInfo = await queryTargetDeviceStatus(productKey, deviceName);
      lastStatus = statusInfo.status;
      if (lastStatus === "ONLINE") {
        consecutiveOnline += 1;
        const requiredConsecutiveOnline = releasedLocalSession ? 2 : 1;
        if (consecutiveOnline >= requiredConsecutiveOnline) {
          return {
            online: true,
            status: lastStatus,
            attempts,
            waitedMs: Date.now() - startedAt
          };
        }
      } else {
        consecutiveOnline = 0;
      }
    } catch (error) {
      consecutiveOnline = 0;
      emitLog("warn", "GetDeviceStatus polling failed.", {
        productKey,
        deviceName,
        reason: error.message
      });
    }

    await delay(pollMs);
  }

  if (strict) {
    throw new Error(`Target device ${productKey}/${deviceName} is ${lastStatus} after waiting ${timeoutMs}ms.`);
  }

  return {
    online: false,
    status: lastStatus,
    attempts,
    waitedMs: Date.now() - startedAt
  };
}

function isOfflineDispatchError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return code === "iot.messagebroker.OFFLINE" || (message.includes("target device") && message.includes("offline"));
}

async function requestWithOfflineRetry(actionName, runner, context = {}) {
  const attemptsLimit = Math.max(1, Number.isFinite(CLOUD_DISPATCH_RETRY_ATTEMPTS) ? CLOUD_DISPATCH_RETRY_ATTEMPTS : 1);
  let lastError = null;

  for (let i = 1; i <= attemptsLimit; i += 1) {
    try {
      const result = await runner();
      return { result, attempts: i };
    } catch (error) {
      lastError = error;
      if (!(isOfflineDispatchError(error) && i < attemptsLimit)) {
        throw error;
      }

      emitLog("warn", `${actionName} returned OFFLINE, retrying...`, {
        attempt: i,
        nextAttemptInMs: CLOUD_DISPATCH_RETRY_INTERVAL_MS,
        ...context
      });
      await delay(CLOUD_DISPATCH_RETRY_INTERVAL_MS);
    }
  }

  throw lastError || new Error(`${actionName} failed.`);
}

function normalizeTopicInput(rawTopic, config = state.config) {
  let topic = String(rawTopic || "").trim();
  if (!topic) return "";

  if (topic.startsWith("sys/")) {
    topic = `/${topic}`;
  }

  if (topic.startsWith("/user/") && config?.productKey && config?.deviceName) {
    return `/${config.productKey}/${config.deviceName}${topic}`;
  }

  if (topic.startsWith("/")) {
    return topic;
  }

  if (!config?.productKey || !config?.deviceName) {
    return topic;
  }

  if (topic.startsWith("user/")) {
    return `/${config.productKey}/${config.deviceName}/${topic}`;
  }

  if (!topic.includes("/")) {
    return `/${config.productKey}/${config.deviceName}/user/${topic}`;
  }

  return topic;
}

function isSystemTopic(topic) {
  return String(topic || "").startsWith("/sys/");
}

function parseTopicRoute(topic) {
  const propertySetMatch = topic.match(
    /^\/sys\/([^/]+)\/([^/]+)\/thing\/service\/property\/set$/
  );
  if (propertySetMatch) {
    return {
      type: "property_set",
      productKey: propertySetMatch[1],
      deviceName: propertySetMatch[2]
    };
  }

  const serviceMatch = topic.match(/^\/sys\/([^/]+)\/([^/]+)\/thing\/service\/([^/]+)$/);
  if (serviceMatch) {
    return {
      type: "service_invoke",
      productKey: serviceMatch[1],
      deviceName: serviceMatch[2],
      identifier: serviceMatch[3]
    };
  }

  const customMatch = topic.match(/^\/([^/]+)\/([^/]+)\/user\/(.+)$/);
  if (customMatch) {
    return {
      type: "custom_pub",
      productKey: customMatch[1],
      deviceName: customMatch[2]
    };
  }

  return { type: "mqtt_raw" };
}

function parsePayloadObject(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "object") return payload;
  if (typeof payload !== "string") return null;
  const text = payload.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function extractPropertyItems(payload) {
  const obj = parsePayloadObject(payload);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};

  let source = null;
  if (obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)) {
    source = obj.params;
  } else {
    source = {};
    for (const [key, value] of Object.entries(obj)) {
      if (["id", "version", "method", "sys"].includes(key)) continue;
      source[key] = value;
    }
  }

  const items = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, "value")
    ) {
      items[key] = value.value;
    } else {
      items[key] = value;
    }
  }
  return items;
}

function extractServiceArgs(payload) {
  const obj = parsePayloadObject(payload);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};

  if (obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)) {
    return obj.params;
  }
  if (obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)) {
    return obj.args;
  }
  if (obj.Args && typeof obj.Args === "object" && !Array.isArray(obj.Args)) {
    return obj.Args;
  }
  return {};
}

function buildAlinkEnvelope(existingObj, method, params) {
  const envelope = {
    id: String(existingObj?.id || Date.now()),
    version: String(existingObj?.version || "1.0"),
    params: params && typeof params === "object" && !Array.isArray(params) ? params : {},
    method
  };

  if (existingObj?.sys && typeof existingObj.sys === "object" && !Array.isArray(existingObj.sys)) {
    envelope.sys = existingObj.sys;
  }

  return envelope;
}

function coerceValueByThingDataType(identifier, value) {
  const hasThingModel = state.thingModel.properties.length > 0;
  const property = state.thingModel.properties.find((item) => item.identifier === identifier);
  if (!property) {
    if (hasThingModel) {
      throw new Error(`Property ${identifier} is not in current thing model.`);
    }
    return value;
  }

  if (property.rwMode && !String(property.rwMode).toLowerCase().includes("w")) {
    throw new Error(`Property ${identifier} is read-only and cannot be set.`);
  }

  const type = String(property?.dataType || "").toLowerCase();
  if (!type) return value;

  if (type === "bool" || type === "boolean") {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value === 1 || value === 0) return value;
    if (typeof value === "string") {
      const text = value.trim().toLowerCase();
      if (text === "true" || text === "1") return 1;
      if (text === "false" || text === "0") return 0;
    }
    throw new Error(`Property ${identifier} expects bool (0/1 or true/false).`);
  }

  if (["int", "float", "double", "long"].includes(type)) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    throw new Error(`Property ${identifier} expects numeric type ${type}.`);
  }

  if (type === "text" || type === "date") {
    if (typeof value === "string") return value;
    return String(value);
  }

  if (type === "struct") {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    throw new Error(`Property ${identifier} expects object type struct.`);
  }

  if (type === "array") {
    if (Array.isArray(value)) return value;
    throw new Error(`Property ${identifier} expects array.`);
  }

  return value;
}

function coercePropertyItemsByThingModel(items) {
  const normalized = {};
  for (const [key, value] of Object.entries(items || {})) {
    normalized[key] = coerceValueByThingDataType(key, value);
  }
  return normalized;
}

function validateCallbackCompatibleItems(items) {
  const warnings = [];
  for (const key of Object.keys(items || {})) {
    if (!CALLBACK_COMPATIBLE_IDENTIFIERS.has(key)) {
      throw new Error(
        `Property ${key} is not handled by current device callback. Supported keys: identify_check, Light_Status, Door_Status.`
      );
    }
    if (key === "identify_check") {
      warnings.push("identify_check is handled as warning in device callback and does not drive actuator state.");
    }
  }
  return warnings;
}

function normalizePropertySetPayload(payload) {
  const obj = parsePayloadObject(payload);
  const rawItems = extractPropertyItems(payload);
  const items = coercePropertyItemsByThingModel(rawItems);
  if (!items || Object.keys(items).length === 0) {
    throw new Error(
      "Invalid property-set payload. Use {\"id\":\"1\",\"version\":\"1.0\",\"params\":{\"PropertyIdentifier\":value},\"method\":\"thing.service.property.set\"}."
    );
  }

  const callbackWarnings = validateCallbackCompatibleItems(items);

  return {
    items,
    envelope: buildAlinkEnvelope(obj, "thing.service.property.set", items),
    callbackWarnings
  };
}

function normalizeServiceInvokePayload(payload, identifier) {
  const obj = parsePayloadObject(payload);
  const args = extractServiceArgs(payload);
  return {
    args,
    envelope: buildAlinkEnvelope(obj, `thing.service.${identifier}`, args)
  };
}

function normalizeMqttRawPayload(topic, payload) {
  const route = parseTopicRoute(topic);

  if (route.type === "property_set") {
    const normalized = normalizePropertySetPayload(payload);
    return JSON.stringify(normalized.envelope);
  }

  if (route.type === "service_invoke") {
    const normalized = normalizeServiceInvokePayload(payload, route.identifier);
    return JSON.stringify(normalized.envelope);
  }

  if (payload === undefined || payload === null) return "";
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

function normalizeProperty(property) {
  const identifier = property?.identifier || property?.Identifier || null;
  const name = property?.name || property?.Name || identifier || "unknown";
  const dataTypeRaw = property?.dataType || property?.DataType || null;
  const dataTypeValue =
    typeof dataTypeRaw === "string"
      ? dataTypeRaw
      : dataTypeRaw?.type || dataTypeRaw?.Type || "unknown";
  const dataType = String(dataTypeValue || "unknown").toLowerCase();

  const rwFlag = String(property?.rwFlag || "").toUpperCase();
  const rwModeFromFlag =
    rwFlag === "READ_WRITE" ? "rw" : rwFlag === "READ_ONLY" ? "r" : rwFlag === "WRITE_ONLY" ? "w" : null;
  const rwModeRaw =
    property?.accessMode ||
    property?.AccessMode ||
    property?.rwMode ||
    property?.RwMode ||
    property?.mode ||
    property?.Mode ||
    rwModeFromFlag ||
    null;
  const rwMode = rwModeRaw ? String(rwModeRaw).toLowerCase() : null;
  const required = Boolean(property?.required || property?.Required || false);
  if (!identifier) return null;
  return { identifier, name, dataType, rwMode, required };
}

function normalizePropertyList(sourceProperties) {
  return (Array.isArray(sourceProperties) ? sourceProperties : [])
    .map(normalizeProperty)
    .filter(Boolean)
    .sort((a, b) => a.identifier.localeCompare(b.identifier));
}

function parsePropertyStateValue(dataType, rawValue) {
  if (rawValue === undefined || rawValue === null) return null;
  const type = String(dataType || "").toLowerCase();
  const text = String(rawValue);

  if (type === "bool" || type === "boolean") {
    if (text === "1" || text.toLowerCase() === "true") return 1;
    if (text === "0" || text.toLowerCase() === "false") return 0;
  }

  if (["int", "float", "double", "long"].includes(type)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }

  if (type === "struct" || type === "array") {
    try {
      return JSON.parse(text);
    } catch (_error) {
      return text;
    }
  }

  return text;
}

function normalizePropertyStateEntry(entry) {
  const identifier = String(entry?.Identifier || entry?.identifier || "").trim();
  if (!identifier) return null;

  const dataType = String(entry?.DataType || entry?.dataType || "unknown").toLowerCase();
  const valueRaw = entry?.Value === undefined || entry?.Value === null ? null : String(entry.Value);
  const value = parsePropertyStateValue(dataType, valueRaw);
  const timeMs = Number(entry?.Time || entry?.time || 0);
  const timestamp = Number.isFinite(timeMs) && timeMs > 0 ? new Date(timeMs).toISOString() : null;

  return {
    identifier,
    name: String(entry?.Name || entry?.name || identifier),
    dataType,
    unit: entry?.Unit || entry?.unit || "",
    value,
    valueRaw,
    timestamp
  };
}

function mergePropertyStateWithThingModel(statusEntries) {
  const byIdentifier = new Map((Array.isArray(statusEntries) ? statusEntries : []).map((item) => [item.identifier, item]));
  const modelProps = Array.isArray(state.thingModel.properties) ? state.thingModel.properties : [];
  const merged = [];

  for (const p of modelProps) {
    const found = byIdentifier.get(p.identifier) || null;
    merged.push({
      identifier: p.identifier,
      name: p.name,
      dataType: p.dataType,
      rwMode: p.rwMode || null,
      required: Boolean(p.required),
      unit: found?.unit || "",
      value: found?.value ?? null,
      valueRaw: found?.valueRaw ?? null,
      timestamp: found?.timestamp || null
    });
    byIdentifier.delete(p.identifier);
  }

  for (const extra of byIdentifier.values()) {
    merged.push({
      identifier: extra.identifier,
      name: extra.name,
      dataType: extra.dataType,
      rwMode: null,
      required: false,
      unit: extra.unit || "",
      value: extra.value ?? null,
      valueRaw: extra.valueRaw ?? null,
      timestamp: extra.timestamp || null
    });
  }

  return merged.sort((a, b) => a.identifier.localeCompare(b.identifier));
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

function upsertPropertyStateByParams(params, trigger = "mqtt_report") {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const mergedMap = new Map(
    (Array.isArray(state.propertyState.properties) ? state.propertyState.properties : []).map((item) => [item.identifier, item])
  );
  const now = nowIso();

  for (const [identifier, value] of Object.entries(params)) {
    const existing = mergedMap.get(identifier);
    const model = state.thingModel.properties.find((item) => item.identifier === identifier);
    const dataType = model?.dataType || existing?.dataType || typeof value;
    mergedMap.set(identifier, {
      identifier,
      name: model?.name || existing?.name || identifier,
      dataType,
      rwMode: model?.rwMode || existing?.rwMode || null,
      required: model?.required ?? existing?.required ?? false,
      unit: existing?.unit || "",
      value,
      valueRaw: typeof value === "string" ? value : JSON.stringify(value),
      timestamp: now
    });
  }

  const merged = [...mergedMap.values()].sort((a, b) => a.identifier.localeCompare(b.identifier));
  setPropertyState(merged, "mqtt_report", trigger);
}

async function refreshPropertyStateByOpenApi(trigger = "manual") {
  if (!state.config?.productKey || !state.config?.deviceName) {
    throw new Error("Device is not configured. Connect first.");
  }

  if (!hasOpenApiCredentials()) {
    throw new Error("OpenAPI credentials are not configured.");
  }

  const { response } = await openApiRequestWithInstanceFallback("QueryDevicePropertyStatus", () => ({
    ProductKey: state.config.productKey,
    DeviceName: state.config.deviceName
  }));

  const rawList = response?.Data?.List?.PropertyStatusInfo;
  let list = [];
  if (Array.isArray(rawList)) list = rawList;
  else if (rawList && typeof rawList === "object") list = [rawList];

  const normalized = list.map(normalizePropertyStateEntry).filter(Boolean);
  const merged = mergePropertyStateWithThingModel(normalized);
  setPropertyState(merged, "openapi_query_property_status", trigger);

  return {
    properties: merged,
    updatedAt: state.propertyState.updatedAt,
    lastError: null,
    source: state.propertyState.source
  };
}

async function refreshDevicePropertyState(trigger = "manual") {
  try {
    return await refreshPropertyStateByOpenApi(trigger);
  } catch (error) {
    const reason = error.message || "Property state refresh failed.";
    setPropertyStateError(reason, "failed", trigger);
    if (trigger !== "poll") {
      emitLog("warn", "Property state refresh failed.", { trigger, reason });
    }
    throw error;
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
  if (!PROPERTY_POLL_ON_CONNECT || propertyPollTimer || !hasOpenApiCredentials()) {
    return;
  }

  propertyPollTimer = setInterval(async () => {
    if (propertyPollRunning || !state.config?.productKey) return;
    propertyPollRunning = true;
    try {
      await refreshDevicePropertyState("poll");
    } catch (_error) {
      // Polling errors are reflected in state.propertyState.lastError.
    } finally {
      propertyPollRunning = false;
    }
  }, PROPERTY_POLL_INTERVAL_MS);
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

function parseMaybeJson(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }
  if (value && typeof value === "object") return value;
  return null;
}

function extractThingModelProperties(payload) {
  const queue = [payload];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const parsed = parseMaybeJson(current);
    if (!parsed || typeof parsed !== "object") continue;
    if (visited.has(parsed)) continue;
    visited.add(parsed);

    if (Array.isArray(parsed.properties)) {
      const normalized = normalizePropertyList(parsed.properties);
      if (normalized.length > 0) return normalized;
    }

    if (parsed.data !== undefined) queue.push(parsed.data);
    if (parsed.params !== undefined) queue.push(parsed.params);
    if (parsed.profile !== undefined) queue.push(parsed.profile);
    if (parsed.schema !== undefined) queue.push(parsed.schema);
    if (parsed.tsl !== undefined) queue.push(parsed.tsl);
    if (parsed.thingModelJson !== undefined) queue.push(parsed.thingModelJson);
    if (parsed.ThingModelJson !== undefined) queue.push(parsed.ThingModelJson);
  }

  return [];
}

function buildMqttConfig(config) {
  const timestamp = String(Date.now());
  const baseClientId = config.clientId || `${config.deviceName}_web_${Math.floor(Math.random() * 100000)}`;
  const mqttClientId = `${baseClientId}|securemode=3,signmethod=hmacsha256,timestamp=${timestamp}|`;
  const signContent = `clientId${baseClientId}deviceName${config.deviceName}productKey${config.productKey}timestamp${timestamp}`;
  const password = crypto.createHmac("sha256", config.deviceSecret).update(signContent).digest("hex");
  const username = `${config.deviceName}&${config.productKey}`;
  const host = `${config.productKey}.iot-as-mqtt.${config.regionId}.aliyuncs.com`;
  const url = `mqtt://${host}:1883`;

  return {
    url,
    options: {
      clientId: mqttClientId,
      username,
      password,
      keepalive: 60,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 30_000
    },
    debug: {
      host,
      port: 1883,
      protocol: "mqtt",
      baseClientId
    }
  };
}

function defaultTopics(config) {
  const pk = config.productKey;
  const dn = config.deviceName;
  return [
    `/sys/${pk}/${dn}/thing/service/property/set`,
    `/sys/${pk}/${dn}/thing/service/property/set_reply`,
    `/sys/${pk}/${dn}/thing/service/property/get`,
    `/sys/${pk}/${dn}/thing/service/property/get_reply`,
    `/sys/${pk}/${dn}/thing/event/property/post`,
    `/sys/${pk}/${dn}/thing/event/property/post_reply`,
    `/sys/${pk}/${dn}/thing/event/+/post_reply`,
    `/sys/${pk}/${dn}/thing/downlink/reply/message`,
    `/sys/${pk}/${dn}/thing/dsltemplate/get_reply`
  ];
}

function disconnectClient(reason = "manual") {
  return new Promise((resolve) => {
    stopPropertyPolling();

    const client = state.client;
    if (!client) {
      state.connected = false;
      state.connecting = false;
      state.subscriptions.clear();
      emitStatus();
      resolve();
      return;
    }

    state.client = null;
    state.connected = false;
    state.connecting = false;
    state.subscriptions.clear();
    emitStatus();
    emitLog("info", `MQTT disconnected (${reason}).`);

    client.removeAllListeners();
    client.end(true, {}, () => resolve());
  });
}

function subscribeTopic(topic, qos = 0) {
  return new Promise((resolve, reject) => {
    if (!state.client || !state.connected) {
      reject(new Error("MQTT client is not connected."));
      return;
    }

    state.client.subscribe(topic, { qos }, (err, granted) => {
      if (err) {
        reject(err);
        return;
      }
      state.subscriptions.add(topic);
      io.emit("subscribed", { topic, granted, timestamp: nowIso() });
      emitStatus();
      resolve(granted);
    });
  });
}

async function autoSubscribeDefaultTopics() {
  if (!state.config) return;
  const topics = [...new Set(defaultTopics(state.config))];
  for (const topic of topics) {
    try {
      await subscribeTopic(topic, 0);
      emitLog("info", `Subscribed: ${topic}`);
    } catch (error) {
      emitLog("warn", `Subscribe failed: ${topic}`, { reason: error.message });
    }
  }
}

async function refreshThingModelByOpenApi(trigger) {
  if (!OPENAPI_CONFIG.accessKeyId || !OPENAPI_CONFIG.accessKeySecret) {
    throw new Error("OpenAPI credentials are not configured.");
  }
  if (!state.config?.productKey) {
    throw new Error("Device is not configured. Connect first.");
  }

  const client = makeOpenApiClient(state.config.regionId || DEFAULT_REGION);
  const attempts = [];
  if (OPENAPI_CONFIG.iotInstanceId) {
    attempts.push({ iotInstanceId: OPENAPI_CONFIG.iotInstanceId, label: "with_instance" });
  }
  attempts.push({ iotInstanceId: null, label: "without_instance" });

  let lastFormattedError = null;

  for (const attempt of attempts) {
    const params = { ProductKey: state.config.productKey };
    if (attempt.iotInstanceId) params.IotInstanceId = attempt.iotInstanceId;

    try {
      const response = await client.request("QueryThingModel", params, { method: "POST" });
      const thingModelJson = response?.Data?.ThingModelJson;
      if (!thingModelJson || typeof thingModelJson !== "string") {
        throw new Error("ThingModelJson missing in QueryThingModel response.");
      }

      const parsed = JSON.parse(thingModelJson);
      const normalized = normalizePropertyList(parsed?.properties);
      if (normalized.length === 0) {
        throw new Error("ThingModel has no properties.");
      }

      setThingModel(normalized, "openapi", trigger);
      emitLog("info", "Thing model properties updated via OpenAPI.", {
        count: normalized.length,
        attempt: attempt.label
      });
      return {
        properties: normalized,
        updatedAt: state.thingModel.updatedAt,
        lastError: null,
        source: "openapi"
      };
    } catch (error) {
      lastFormattedError = formatOpenApiError(error);
      emitLog("info", "OpenAPI thing model fetch failed.", {
        attempt: attempt.label,
        reason: lastFormattedError.message,
        code: lastFormattedError.code,
        requestId: lastFormattedError.requestId
      });
    }
  }

  throw new Error(lastFormattedError?.message || "OpenAPI thing model fetch failed.");
}

async function refreshThingModelByMqttDsl(trigger) {
  if (!state.client || !state.connected || !state.config) {
    throw new Error("MQTT not connected, cannot query dsltemplate.");
  }

  const pk = state.config.productKey;
  const dn = state.config.deviceName;
  const requestTopic = `/sys/${pk}/${dn}/thing/dsltemplate/get`;
  const replyTopic = `/sys/${pk}/${dn}/thing/dsltemplate/get_reply`;
  const requestId = `dsl_${Date.now()}`;

  await subscribeTopic(replyTopic, 0).catch(() => {});

  const requestPayload = {
    id: requestId,
    version: "1.0",
    params: {},
    method: "thing.dsltemplate.get"
  };

  const timeoutMs = 12_000;

  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      state.client.removeListener("message", onMessage);
      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      done(new Error("MQTT dsltemplate query timeout."));
    }, timeoutMs);

    const onMessage = (topic, payloadBuffer) => {
      if (topic !== replyTopic) return;

      let messageObj = null;
      try {
        messageObj = JSON.parse(payloadBuffer.toString("utf8"));
      } catch (_error) {
        return;
      }

      const messageId = String(messageObj?.id || "");
      if (messageId && messageId !== requestId) return;

      const code = String(messageObj?.code ?? "");
      if (code && code !== "200" && code !== "0") {
        const reason = messageObj?.message || messageObj?.desc || `MQTT dsltemplate error: ${code}`;
        done(new Error(reason));
        return;
      }

      const normalized = extractThingModelProperties(messageObj);
      if (!normalized.length) {
        done(new Error("No properties found in MQTT dsltemplate reply."));
        return;
      }

      setThingModel(normalized, "mqtt_dsltemplate", trigger);
      emitLog("info", "Thing model properties updated via MQTT dsltemplate.", {
        count: normalized.length
      });
      done(null, {
        properties: normalized,
        updatedAt: state.thingModel.updatedAt,
        lastError: null,
        source: "mqtt_dsltemplate"
      });
    };

    state.client.on("message", onMessage);
    state.client.publish(requestTopic, JSON.stringify(requestPayload), { qos: 0 }, (error) => {
      if (error) {
        done(new Error(`Publish dsltemplate/get failed: ${error.message}`));
      }
    });
  });
}

async function refreshThingModelProperties(trigger = "manual") {
  if (!state.config?.productKey) {
    throw new Error("Device is not configured. Connect first.");
  }

  let openApiError = null;
  try {
    return await refreshThingModelByOpenApi(trigger);
  } catch (error) {
    openApiError = error;
  }

  if (state.connected) {
    try {
      emitLog("info", "OpenAPI failed, trying MQTT dsltemplate fallback...", {
        reason: openApiError?.message || "unknown"
      });
      return await refreshThingModelByMqttDsl(trigger);
    } catch (mqttError) {
      const combined = `OpenAPI: ${openApiError?.message || "unknown"} | MQTT: ${mqttError.message}`;
      setThingModelError(combined, "failed", trigger);
      emitLog("warn", "Thing model refresh failed.", {
        trigger,
        reason: combined
      });
      throw new Error(combined);
    }
  }

  const reason = openApiError?.message || "Thing model refresh failed.";
  setThingModelError(reason, "failed", trigger);
  emitLog("warn", "Thing model refresh failed.", { trigger, reason });
  throw new Error(reason);
}

async function sendCloudCommandByTopic({ topic, payload, qos = 0 }) {
  const route = parseTopicRoute(topic);

  let localSessionReleased = false;
  let targetStatus = null;
  let targetOnlineWait = null;

  async function prepareTargetDevice() {
    if (!route.productKey || !route.deviceName) return;
    localSessionReleased = await releaseLocalSessionIfSameDevice(route.productKey, route.deviceName);

    try {
      const waitResult = await waitForTargetOnline(route.productKey, route.deviceName, {
        timeoutMs: TARGET_ONLINE_WAIT_MS,
        pollMs: TARGET_ONLINE_POLL_MS,
        strict: false,
        releasedLocalSession: localSessionReleased
      });
      targetStatus = waitResult.status;
      targetOnlineWait = waitResult;

      if (!waitResult.online) {
        const level = STRICT_TARGET_ONLINE_CHECK ? "error" : "warn";
        emitLog(level, "Target device is still offline before dispatch.", {
          productKey: route.productKey,
          deviceName: route.deviceName,
          status: targetStatus,
          waitedMs: waitResult.waitedMs,
          attempts: waitResult.attempts
        });

        if (STRICT_TARGET_ONLINE_CHECK) {
          throw new Error(`Target device ${route.productKey}/${route.deviceName} is ${targetStatus}.`);
        }
      }
    } catch (error) {
      if (STRICT_TARGET_ONLINE_CHECK && String(error.message || "").includes("Target device")) {
        throw error;
      }
      emitLog("warn", "GetDeviceStatus failed before command dispatch. Continue dispatch with best effort.", {
        topic,
        reason: error.message
      });
    }
  }

  if (route.type === "property_set") {
    await prepareTargetDevice();
    const normalized = normalizePropertySetPayload(payload);
    const normalizedQos = Number.isFinite(Number(qos)) && (Number(qos) === 0 || Number(qos) === 1) ? Number(qos) : 1;

    const dispatch = await requestWithOfflineRetry(
      "SetDeviceProperty",
      () =>
        openApiRequestWithInstanceFallback("SetDeviceProperty", () => ({
          ProductKey: route.productKey,
          DeviceName: route.deviceName,
          Items: JSON.stringify(normalized.items),
          Qos: normalizedQos
        })),
      {
        productKey: route.productKey,
        deviceName: route.deviceName
      }
    );
    const { response } = dispatch.result;

    return {
      route: "set_device_property",
      requestData: normalized.items,
      normalizedPayload: normalized.envelope,
      warnings: normalized.callbackWarnings || [],
      localSessionReleased,
      targetStatus,
      targetOnlineWait,
      qos: normalizedQos,
      retryAttempts: dispatch.attempts,
      responseData: response?.Data || null
    };
  }

  if (route.type === "service_invoke") {
    await prepareTargetDevice();
    const normalized = normalizeServiceInvokePayload(payload, route.identifier);
    const dispatch = await requestWithOfflineRetry(
      "InvokeThingService",
      () =>
        openApiRequestWithInstanceFallback("InvokeThingService", () => ({
          ProductKey: route.productKey,
          DeviceName: route.deviceName,
          Identifier: route.identifier,
          Args: JSON.stringify(normalized.args)
        })),
      {
        productKey: route.productKey,
        deviceName: route.deviceName,
        identifier: route.identifier
      }
    );
    const { response } = dispatch.result;

    return {
      route: "invoke_thing_service",
      requestData: { identifier: route.identifier, args: normalized.args },
      normalizedPayload: normalized.envelope,
      localSessionReleased,
      targetStatus,
      targetOnlineWait,
      retryAttempts: dispatch.attempts,
      responseData: response?.Data || null
    };
  }

  if (route.type === "custom_pub") {
    await prepareTargetDevice();
    let textPayload = payload;
    if (textPayload === undefined || textPayload === null) textPayload = "";
    if (typeof textPayload !== "string") textPayload = JSON.stringify(textPayload);

    const { response } = await openApiRequestWithInstanceFallback("Pub", () => ({
      ProductKey: route.productKey,
      TopicFullName: topic,
      MessageContent: Buffer.from(textPayload, "utf8").toString("base64"),
      Qos: Number.isFinite(Number(qos)) ? Number(qos) : 0
    }));

    return {
      route: "pub_custom_topic",
      requestData: { topic, qos: Number.isFinite(Number(qos)) ? Number(qos) : 0 },
      localSessionReleased,
      targetStatus,
      targetOnlineWait,
      responseData: response?.Data || null
    };
  }

  return null;
}

async function connectClient(configInput) {
  const config = {
    productKey: pickFirstNonEmpty(configInput.productKey, process.env.ALIYUN_PRODUCT_KEY),
    deviceName: pickFirstNonEmpty(configInput.deviceName, process.env.ALIYUN_DEVICE_NAME),
    deviceSecret: pickFirstNonEmpty(configInput.deviceSecret, process.env.ALIYUN_DEVICE_SECRET),
    regionId: pickFirstNonEmpty(configInput.regionId, process.env.ALIYUN_REGION_ID, DEFAULT_REGION),
    clientId: pickFirstNonEmpty(configInput.clientId, process.env.ALIYUN_CLIENT_ID) || null
  };

  if (!config.productKey || !config.deviceName || !config.deviceSecret || !config.regionId) {
    throw new Error("Missing device triplet or region. Configure .env first.");
  }

  await disconnectClient("reconnect");

  state.config = config;
  state.lastError = null;
  state.connecting = true;
  emitStatus();

  if (!ENABLE_LOCAL_MQTT) {
    state.client = null;
    state.subscriptions.clear();
    state.connected = true;
    state.connecting = false;
    emitStatus();
    emitLog("info", "Cloud command mode connected. Local MQTT is disabled to avoid device session conflicts.");

    try {
      const statusInfo = await waitForTargetOnline(config.productKey, config.deviceName, {
        timeoutMs: Math.min(TARGET_ONLINE_WAIT_MS, 8000),
        pollMs: TARGET_ONLINE_POLL_MS,
        strict: false
      });
      emitLog("info", "Target device status checked in cloud command mode.", {
        status: statusInfo.status,
        waitedMs: statusInfo.waitedMs,
        attempts: statusInfo.attempts
      });
    } catch (error) {
      emitLog("warn", "Target status check failed in cloud command mode.", { reason: error.message });
    }

    try {
      await refreshThingModelProperties("cloud_connect");
    } catch (_error) {
      // Keep command mode online when model refresh fails.
    }

    try {
      await refreshDevicePropertyState("cloud_connect");
    } catch (_error) {
      // Keep command mode online when property-state refresh fails.
    }

    startPropertyPolling();

    return;
  }

  const { url, options, debug } = buildMqttConfig(config);
  emitLog("info", "Connecting to Alibaba Cloud IoT MQTT over TCP (non-TLS)...", {
    host: debug.host,
    port: debug.port,
    protocol: debug.protocol,
    clientId: debug.baseClientId,
    securemode: 3,
    signmethod: "hmacsha256"
  });

  const client = mqtt.connect(url, options);
  state.client = client;

  let lastErrorSignature = "";
  let lastErrorTimestamp = 0;

  client.on("connect", async () => {
    if (state.client !== client) return;
    state.connected = true;
    state.connecting = false;
    state.lastError = null;
    emitStatus();
    emitLog("info", "MQTT connected.");

    await autoSubscribeDefaultTopics();

    try {
      await refreshThingModelProperties("mqtt_connect");
    } catch (_error) {
      // Keep MQTT connection alive when model refresh fails.
    }

    try {
      await refreshDevicePropertyState("mqtt_connect");
    } catch (_error) {
      // Keep MQTT connection alive when property-state refresh fails.
    }

    startPropertyPolling();
  });

  client.on("reconnect", () => {
    if (state.client !== client) return;
    state.connected = false;
    state.connecting = true;
    emitStatus();
    emitLog("warn", "MQTT reconnecting...");
  });

  client.on("offline", () => {
    if (state.client !== client) return;
    state.connected = false;
    emitStatus();
    emitLog("warn", "MQTT offline.");
  });

  client.on("close", () => {
    if (state.client !== client) return;
    state.connected = false;
    emitStatus();
    emitLog("warn", "MQTT connection closed.");
  });

  client.on("error", (error) => {
    if (state.client !== client) return;
    state.lastError = error.message;
    const classification = classifyMqttError(error);

    const signature = `${classification.kind}|${error.code || ""}|${error.message || ""}`;
    const now = Date.now();
    const duplicated = signature === lastErrorSignature && now - lastErrorTimestamp < 1200;
    lastErrorSignature = signature;
    lastErrorTimestamp = now;
    if (duplicated) return;

    emitStatus();
    emitLog("error", "MQTT error.", {
      reason: error.message,
      code: error.code || null,
      category: classification.kind,
      hint: classification.hint
    });
  });

  client.on("message", (topic, payloadBuffer, packet) => {
    if (state.client !== client) return;
    const textPayload = payloadBuffer.toString("utf8");
    let jsonPayload = null;
    try {
      jsonPayload = JSON.parse(textPayload);
    } catch (_ignored) {
      jsonPayload = null;
    }

    io.emit("mqtt_message", {
      topic,
      payload: textPayload,
      jsonPayload,
      qos: packet?.qos ?? 0,
      retain: Boolean(packet?.retain),
      timestamp: nowIso()
    });

    if (jsonPayload?.method === "thing.event.property.post" && jsonPayload?.params) {
      upsertPropertyStateByParams(jsonPayload.params, "mqtt_report");
    }
  });
}

function ensureConnected(res) {
  if (!state.client || !state.connected) {
    res.status(400).json({
      ok: false,
      message: "MQTT is not connected. Connect first."
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
      hasEnvTriplet: HAS_ENV_TRIPLET,
      autoConnectOnStart: AUTO_CONNECT_ON_START,
      hasOpenApiCredentials:
        Boolean(OPENAPI_CONFIG.accessKeyId) && Boolean(OPENAPI_CONFIG.accessKeySecret),
      transport: ENABLE_LOCAL_MQTT ? "mqtt_tcp_non_tls_1883" : "openapi_command_only",
      enableLocalMqtt: ENABLE_LOCAL_MQTT,
      allowCloudRouteMqttFallback: ALLOW_CLOUD_ROUTE_MQTT_FALLBACK,
      strictTargetOnlineCheck: STRICT_TARGET_ONLINE_CHECK,
      targetOnlineWaitMs: TARGET_ONLINE_WAIT_MS,
      targetOnlinePollMs: TARGET_ONLINE_POLL_MS,
      cloudDispatchRetryAttempts: CLOUD_DISPATCH_RETRY_ATTEMPTS,
      cloudDispatchRetryIntervalMs: CLOUD_DISPATCH_RETRY_INTERVAL_MS,
      propertyPollOnConnect: PROPERTY_POLL_ON_CONNECT,
      propertyPollIntervalMs: PROPERTY_POLL_INTERVAL_MS
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

app.post("/api/device/properties/refresh", async (req, res) => {
  try {
    const result = await refreshDevicePropertyState("manual_refresh");
    res.json({
      ok: true,
      ...result
    });
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

app.post("/api/model/refresh", async (req, res) => {
  try {
    const result = await refreshThingModelProperties("manual_refresh");
    res.json({
      ok: true,
      ...result
    });
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

app.post("/api/connect", async (req, res) => {
  try {
    await connectClient(req.body || {});
    res.json({
      ok: true,
      message: ENABLE_LOCAL_MQTT
        ? "MQTT connect request accepted. Check status in a few seconds."
        : "Cloud command mode is ready. Local MQTT is disabled."
    });
  } catch (error) {
    state.lastError = error.message;
    emitStatus();
    emitLog("error", "Connect request failed.", { reason: error.message });
    res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});

app.post("/api/disconnect", async (req, res) => {
  await disconnectClient("api");
  res.json({
    ok: true,
    message: "Disconnected."
  });
});

app.post("/api/subscribe", async (req, res) => {
  if (!ENABLE_LOCAL_MQTT) {
    res.status(400).json({
      ok: false,
      message: "Local MQTT subscribe is disabled in openapi_command_only mode."
    });
    return;
  }
  if (!ensureConnected(res)) return;

  const rawTopic = String(req.body?.topic || "").trim();
  const topic = normalizeTopicInput(rawTopic);
  const qos = Number(req.body?.qos ?? 0);
  if (!topic) {
    res.status(400).json({ ok: false, message: "topic is required." });
    return;
  }

  try {
    const granted = await subscribeTopic(topic, Number.isFinite(qos) ? qos : 0);
    emitLog("info", `Subscribed: ${topic}`);
    res.json({ ok: true, topic, rawTopic, granted });
  } catch (error) {
    emitLog("error", `Subscribe failed: ${topic}`, { reason: error.message });
    const hint = isSystemTopic(topic)
      ? "Check whether this system topic is subscribable with current device permissions."
      : null;
    res.status(500).json({ ok: false, message: error.message, topic, rawTopic, hint });
  }
});

app.post("/api/unsubscribe", async (req, res) => {
  if (!ENABLE_LOCAL_MQTT) {
    res.status(400).json({
      ok: false,
      message: "Local MQTT unsubscribe is disabled in openapi_command_only mode."
    });
    return;
  }
  if (!ensureConnected(res)) return;

  const rawTopic = String(req.body?.topic || "").trim();
  const topic = normalizeTopicInput(rawTopic);
  if (!topic) {
    res.status(400).json({ ok: false, message: "topic is required." });
    return;
  }

  state.client.unsubscribe(topic, (error) => {
    if (error) {
      emitLog("error", `Unsubscribe failed: ${topic}`, { reason: error.message });
      res.status(500).json({ ok: false, message: error.message });
      return;
    }
    state.subscriptions.delete(topic);
    emitStatus();
    emitLog("info", `Unsubscribed: ${topic}`);
    res.json({ ok: true, topic, rawTopic });
  });
});

app.post("/api/publish", async (req, res) => {
  const rawTopic = String(req.body?.topic || "").trim();
  const topic = normalizeTopicInput(rawTopic);
  const qos = Number(req.body?.qos ?? 0);
  const retain = Boolean(req.body?.retain);
  if (!topic) {
    res.status(400).json({ ok: false, message: "topic is required." });
    return;
  }

  const payload = req.body?.payload;
  const topicRoute = parseTopicRoute(topic);

  try {
    const cloudResult = await sendCloudCommandByTopic({ topic, payload, qos });
    if (cloudResult) {
      emitLog("info", `Cloud command dispatched: ${topic}`, {
        route: cloudResult.route,
        warnings: cloudResult.warnings || [],
        targetStatus: cloudResult.targetStatus || null,
        localSessionReleased: Boolean(cloudResult.localSessionReleased),
        qos: cloudResult.qos ?? null,
        targetOnlineWait: cloudResult.targetOnlineWait || null,
        retryAttempts: cloudResult.retryAttempts || 1
      });
      io.emit("published", {
        topic,
        payload: JSON.stringify(cloudResult.normalizedPayload ?? payload ?? ""),
        qos: Number.isFinite(qos) ? qos : 0,
        retain,
        route: cloudResult.route,
        timestamp: nowIso()
      });
      res.json({
        ok: true,
        topic,
        rawTopic,
        route: cloudResult.route,
        responseData: cloudResult.responseData || null,
        normalizedPayload: cloudResult.normalizedPayload || null,
        warnings: cloudResult.warnings || [],
        targetStatus: cloudResult.targetStatus || null,
        localSessionReleased: Boolean(cloudResult.localSessionReleased),
        qos: cloudResult.qos ?? null,
        targetOnlineWait: cloudResult.targetOnlineWait || null,
        retryAttempts: cloudResult.retryAttempts || 1
      });
      return;
    }
  } catch (error) {
    const canFallback =
      ALLOW_CLOUD_ROUTE_MQTT_FALLBACK &&
      topicRoute.type !== "property_set" &&
      topicRoute.type !== "service_invoke" &&
      state.client &&
      state.connected;

    if (!canFallback) {
      const isStatusOffline = String(error.message || "").includes("Target device");
      const isBrokerOffline = String(error.code || "") === "iot.messagebroker.OFFLINE";
      const offlineHint =
        isStatusOffline || isBrokerOffline
          ? " Ensure physical device keeps MQTT session online. If this page used the same triplet, wait for device auto-reconnect and retry."
          : "";
      const reasonSuffix = isSystemTopic(topic)
        ? " System topic command requires valid OpenAPI dispatch and will not fallback to raw MQTT."
        : "";
      emitLog("error", `Cloud command failed: ${topic}`, {
        reason: error.message,
        code: error.code || null,
        requestId: error.requestId || null
      });
      res.status(400).json({ ok: false, message: `${error.message}${offlineHint}${reasonSuffix}` });
      return;
    }

    emitLog("warn", "Cloud command failed. Falling back to MQTT raw publish.", {
      topic,
      reason: error.message
    });
  }

  if (!ensureConnected(res)) return;

  const textPayload = normalizeMqttRawPayload(topic, payload);

  const rawRouteName = topicRoute.type === "mqtt_raw" ? "mqtt_raw" : "mqtt_raw_fallback";

  state.client.publish(
    topic,
    textPayload,
    { qos: Number.isFinite(qos) ? qos : 0, retain },
    (error) => {
      if (error) {
        emitLog("error", `Publish failed: ${topic}`, { reason: error.message });
        res.status(500).json({ ok: false, message: error.message });
        return;
      }
      emitLog("info", `Published via MQTT raw route: ${topic}`, {
        qos: Number.isFinite(qos) ? qos : 0,
        retain,
        route: rawRouteName
      });
      io.emit("published", {
        topic,
        payload: textPayload,
        qos,
        retain,
        route: rawRouteName,
        timestamp: nowIso()
      });
      res.json({ ok: true, topic, rawTopic, route: rawRouteName });
    }
  );
});

io.on("connection", (socket) => {
  socket.emit("status", statusPayload());
  socket.emit("thing_model", {
    trigger: "socket_init",
    properties: state.thingModel.properties,
    updatedAt: state.thingModel.updatedAt,
    lastError: state.thingModel.lastError,
    source: state.thingModel.source
  });
  socket.emit("property_state", {
    trigger: "socket_init",
    properties: state.propertyState.properties,
    updatedAt: state.propertyState.updatedAt,
    lastError: state.propertyState.lastError,
    source: state.propertyState.source
  });
  emitLog("info", `Web client connected: ${socket.id}`);

  socket.on("disconnect", () => {
    emitLog("info", `Web client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, async () => {
  emitLog("info", `Web console running at http://localhost:${PORT}`);
  emitLog("info", "Transport mode fixed to mqtt://<host>:1883 (non-TLS).");

  if (AUTO_CONNECT_ON_START) {
    const envConfig = {
      productKey: ENV_TRIPLET.productKey,
      deviceName: ENV_TRIPLET.deviceName,
      deviceSecret: ENV_TRIPLET.deviceSecret,
      regionId: process.env.ALIYUN_REGION_ID || DEFAULT_REGION,
      clientId: process.env.ALIYUN_CLIENT_ID || null
    };

    if (envConfig.productKey && envConfig.deviceName && envConfig.deviceSecret) {
      try {
        await connectClient(envConfig);
      } catch (error) {
        emitLog("error", "Auto connect failed.", { reason: error.message });
      }
    } else {
      emitLog("warn", "AUTO_CONNECT_ON_START=true but env triplet is incomplete.");
    }
  }
});

