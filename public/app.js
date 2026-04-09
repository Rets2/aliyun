const socket = io();

const statusPill = document.getElementById("statusPill");
const envModeHint = document.getElementById("envModeHint");
const modelMeta = document.getElementById("modelMeta");
const modelPropertyList = document.getElementById("modelPropertyList");
const propertyStateMeta = document.getElementById("propertyStateMeta");
const propertyVisualGrid = document.getElementById("propertyVisualGrid");
const quickPropertyInput = document.getElementById("quickProperty");
const quickValueInput = document.getElementById("quickValue");
const publishTopicInput = document.getElementById("publishTopic");
const publishPayloadInput = document.getElementById("publishPayload");
const publishQosInput = document.getElementById("publishQos");
const publishRetainInput = document.getElementById("publishRetain");
const subTopicInput = document.getElementById("subTopic");
const subQosInput = document.getElementById("subQos");
const subList = document.getElementById("subList");
const logList = document.getElementById("logList");
const subscriptionPanel = document.getElementById("subscriptionPanel");
const debugModeHint = document.getElementById("debugModeHint");
const connectionValue = document.getElementById("connectionValue");
const modelCountValue = document.getElementById("modelCountValue");
const stateCountValue = document.getElementById("stateCountValue");

const soilChartCanvas = document.getElementById("soilChartCanvas");
const soilChartEmpty = document.getElementById("soilChartEmpty");
const soilCurrentValue = document.getElementById("soilCurrentValue");
const soilMinValue = document.getElementById("soilMinValue");
const soilMaxValue = document.getElementById("soilMaxValue");
const miniSoilCanvas = document.getElementById("miniSoilCanvas");
const miniStateCanvas = document.getElementById("miniStateCanvas");
const miniPublishCanvas = document.getElementById("miniPublishCanvas");
const miniSoilValue = document.getElementById("miniSoilValue");
const miniStateValue = document.getElementById("miniStateValue");
const miniPublishValue = document.getElementById("miniPublishValue");

const connectWithEnvBtn = document.getElementById("connectWithEnvBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const refreshModelBtn = document.getElementById("refreshModelBtn");
const refreshStateBtn = document.getElementById("refreshStateBtn");
const applyPropertyBtn = document.getElementById("applyPropertyBtn");
const publishForm = document.getElementById("publishForm");
const subForm = document.getElementById("subForm");
const unsubBtn = document.getElementById("unsubBtn");

let currentConfig = null;
let thingModelProperties = [];
let currentPropertyState = [];
let resolvedSoilIdentifier = "";
let soilUnit = "";
let chartResizeTimer = null;

const MAX_LINES = 260;
const SOIL_HISTORY_LIMIT = 90;
const MINI_HISTORY_LIMIT = 60;
const soilHistory = [];
const stateCountHistory = [];
const publishCountHistory = [];
let publishCount = 0;

function fmtTime(ts) {
  const t = ts ? new Date(ts) : new Date();
  if (Number.isNaN(t.getTime())) return "-";
  return t.toLocaleString("zh-CN", { hour12: false });
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function pushLine(container, text, className = "", timestamp = Date.now()) {
  if (!container) return;
  const line = document.createElement("div");
  line.className = `line ${className}`.trim();

  const timeNode = document.createElement("time");
  timeNode.textContent = `[${fmtTime(timestamp)}]`;

  line.appendChild(timeNode);
  line.appendChild(document.createTextNode(String(text || "")));
  container.prepend(line);

  while (container.children.length > MAX_LINES) {
    container.removeChild(container.lastChild);
  }
}

function parseJsonText(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return text;
  if (!(text.startsWith("{") || text.startsWith("["))) return value;

  try {
    return JSON.parse(text);
  } catch (_error) {
    return value;
  }
}

function parseSmartValue(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (!Number.isNaN(Number(raw))) return Number(raw);

  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw);
    } catch (_error) {
      return raw;
    }
  }

  return raw;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: "GET",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  let data = null;

  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = { ok: response.ok, message: await response.text() };
  }

  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `Request failed: ${path}`);
  }

  return data;
}

function fillDefaultTopic() {
  const deviceId = currentConfig?.deviceId || currentConfig?.deviceName || "";
  if (!deviceId || !publishTopicInput) return;
  if (!publishTopicInput.value.trim()) {
    publishTopicInput.value = `$oc/devices/${deviceId}/sys/commands`;
  }
}

function renderQuickCommandOptions() {
  if (!quickPropertyInput) return;
  quickPropertyInput.innerHTML = "";

  const options = [
    { value: "", text: "选择命令" },
    { value: "turn_light", text: "turn_light (Light_Status)" },
    { value: "turn_relay", text: "turn_relay (Relay_Status)" },
    { value: "blink_light", text: "blink_light (blink_count/on_ms/off_ms)" },
    { value: "blink_relay", text: "blink_relay (blink_count/on_ms/off_ms)" }
  ];

  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.text;
    quickPropertyInput.appendChild(option);
  }

  applyQuickInputHint();
}

function fillDefaultCommandPayload() {
  if (!publishPayloadInput) return;
  if (String(publishPayloadInput.value || "").trim()) return;
  publishPayloadInput.value = JSON.stringify(
    {
      service_id: "Rets2",
      command_name: "turn_light",
      paras: {
        Light_Status: 1
      }
    },
    null,
    2
  );
}

function syncPayloadServiceId() {
  if (!publishPayloadInput) return;
  const serviceId = String(currentConfig?.serviceId || "").trim();
  if (!serviceId) return;

  const parsed = parseJsonText(publishPayloadInput.value || "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  if (parsed.service_id === serviceId) return;

  parsed.service_id = serviceId;
  publishPayloadInput.value = JSON.stringify(parsed, null, 2);
}

function applyQuickInputHint() {
  if (!quickPropertyInput || !quickValueInput) return;
  const commandName = String(quickPropertyInput.value || "").trim();

  if (commandName === "blink_light" || commandName === "blink_relay") {
    quickValueInput.placeholder = '{"blink_count":3,"on_ms":200,"off_ms":200}';
    return;
  }

  quickValueInput.placeholder = "0 或 1";
}

function parseBlinkQuickInput(valueText, commandName) {
  const text = String(valueText || "").trim();
  if (!text) {
    throw new Error(`${commandName} 请输入参数：{"blink_count":3,"on_ms":200,"off_ms":200}`);
  }

  let source = null;
  const parsed = parseJsonText(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    source = parsed;
  } else {
    const nums = text
      .split(/[\s,]+/)
      .map((item) => Number(item))
      .filter(Number.isFinite);
    if (nums.length >= 3) {
      source = {
        blink_count: nums[0],
        on_ms: nums[1],
        off_ms: nums[2]
      };
    }
  }

  if (!source) {
    throw new Error(`${commandName} 参数格式错误，请输入 JSON 或 3 个数字。`);
  }

  const blinkCount = Math.trunc(Number(source.blink_count));
  const onMs = Math.trunc(Number(source.on_ms));
  const offMs = Math.trunc(Number(source.off_ms));

  if (!Number.isFinite(blinkCount) || !Number.isFinite(onMs) || !Number.isFinite(offMs)) {
    throw new Error(`${commandName} 参数必须是数字。`);
  }
  if (blinkCount <= 0 || onMs <= 0 || offMs <= 0) {
    throw new Error(`${commandName} 参数必须大于 0。`);
  }

  return {
    blink_count: blinkCount,
    on_ms: onMs,
    off_ms: offMs
  };
}

function renderSubscriptions(topics) {
  if (!subList) return;
  subList.innerHTML = "";
  for (const topic of topics || []) {
    const item = document.createElement("li");
    item.textContent = topic;
    subList.appendChild(item);
  }
}

function shortSource(source, updatedAt, error) {
  const s = source || "-";
  const t = updatedAt ? fmtTime(updatedAt) : "-";
  return error ? `${s} · ${t} · ${error}` : `${s} · ${t}`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "--";
  if (typeof value === "number") {
    if (Math.abs(value) >= 100 || Number.isInteger(value)) return String(value);
    return value.toFixed(2).replace(/\.00$/, "");
  }
  if (typeof value === "object") return safeJson(value);
  return String(value);
}

function formatJsonPretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function normalizePropertyDataType(rawType) {
  const type = String(rawType || "").toLowerCase();
  if (["int", "float", "double", "long", "number", "decimal"].includes(type)) return "number";
  if (["bool", "boolean"].includes(type)) return "bool";
  if (["struct", "object"].includes(type)) return "struct";
  if (["array"].includes(type)) return "array";
  if (["text", "string", "date", "enum"].includes(type)) return "text";
  return "default";
}

function propertyTypeIconSvg(type) {
  const icons = {
    number:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.25 1.75a.75.75 0 0 1 1.5 0v2h1.5v-2a.75.75 0 0 1 1.5 0v2h1.5a.75.75 0 0 1 0 1.5h-1.5v2h1.5a.75.75 0 0 1 0 1.5h-1.5v2a.75.75 0 0 1-1.5 0v-2h-1.5v2a.75.75 0 0 1-1.5 0v-2h-1.5a.75.75 0 0 1 0-1.5h1.5v-2h-1.5a.75.75 0 0 1 0-1.5h1.5zM7.75 7.25h1.5v-2h-1.5z"></path></svg>',
    bool:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13A6.5 6.5 0 0 0 8 1.5zm2.78 4.22a.75.75 0 0 1 0 1.06L7.53 10.03a.75.75 0 0 1-1.06 0L5.22 8.78a.75.75 0 0 1 1.06-1.06L7 8.44l2.72-2.72a.75.75 0 0 1 1.06 0z"></path></svg>',
    text:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.75 2.5a.75.75 0 0 0 0 1.5H7.25v8a.75.75 0 0 0 1.5 0V4h3.5a.75.75 0 0 0 0-1.5z"></path></svg>',
    struct:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2.75 2A1.75 1.75 0 0 0 1 3.75v8.5C1 13.216 1.784 14 2.75 14h10.5A1.75 1.75 0 0 0 15 12.25v-8.5A1.75 1.75 0 0 0 13.25 2zm0 1.5h10.5a.25.25 0 0 1 .25.25v2.5H2.5v-2.5a.25.25 0 0 1 .25-.25zm-.25 4.25h11v4.5a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25z"></path></svg>',
    array:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.25 2a.75.75 0 0 1 0 1.5H3.5v9h.75a.75.75 0 0 1 0 1.5H3A1 1 0 0 1 2 13V3a1 1 0 0 1 1-1zm7.5 0a.75.75 0 0 1 0 1.5h.75v9h-.75a.75.75 0 0 1 0 1.5H13a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1zM6 5.75A.75.75 0 0 1 6.75 5h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 6 5.75zm0 2.5A.75.75 0 0 1 6.75 7.5h2.5a.75.75 0 0 1 0 1.5h-2.5A.75.75 0 0 1 6 8.25z"></path></svg>',
    default:
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13A6.5 6.5 0 0 0 8 1.5zm.75 3.25a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 .22.53l2 2a.75.75 0 1 0 1.06-1.06L8.75 7.94z"></path></svg>'
  };
  return icons[type] || icons.default;
}

function buildPropertyDisplayModel(item) {
  const displayName = String(item?.name || item?.identifier || "unknown");
  const identifier = String(item?.identifier || "-");
  const dataType = String(item?.dataType || "unknown");
  const normalizedType = normalizePropertyDataType(dataType);
  const unit = item?.unit ? String(item.unit) : "";
  const badges = [dataType];
  if (unit) badges.push(unit);

  let detailJson = "";
  let displayValueSummary = "--";
  const value = item?.value;

  if (Array.isArray(value)) {
    displayValueSummary = `数组(${value.length})`;
    detailJson = formatJsonPretty(value);
  } else if (value && typeof value === "object") {
    const fieldCount = Object.keys(value).length;
    displayValueSummary = `对象(${fieldCount})`;
    detailJson = formatJsonPretty(value);
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      displayValueSummary = "--";
    } else if (text.length > 48) {
      displayValueSummary = `${text.slice(0, 48)}…`;
      detailJson = text;
    } else {
      displayValueSummary = text;
    }
  } else {
    displayValueSummary = formatValue(value);
  }

  if (!detailJson && unit && displayValueSummary !== "--") {
    displayValueSummary = `${displayValueSummary} ${unit}`;
  }

  if (!detailJson && normalizedType === "struct" && typeof item?.valueRaw === "string" && item.valueRaw.trim()) {
    displayValueSummary = `对象`;
    detailJson = item.valueRaw;
  }
  if (!detailJson && normalizedType === "array" && typeof item?.valueRaw === "string" && item.valueRaw.trim()) {
    displayValueSummary = `数组`;
    detailJson = item.valueRaw;
  }

  return {
    displayName,
    identifier,
    dataType,
    iconType: normalizedType,
    displayValueSummary,
    detailJson,
    badges
  };
}

function toFiniteNumber(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;

  const m = text.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const parsed = Number(m[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function pushSeries(series, value, limit = MINI_HISTORY_LIMIT) {
  if (!Array.isArray(series) || !Number.isFinite(value)) return;
  series.push(value);
  while (series.length > limit) {
    series.shift();
  }
}

function drawMiniSparkline(canvas, values, options = {}) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(120, Math.floor(rect.width || 120));
  const height = Math.max(40, Math.floor(rect.height || 40));
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite);
  if (!points.length) return;

  const padding = { left: 4, right: 4, top: 6, bottom: 6 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  let minVal = Math.min(...points);
  let maxVal = Math.max(...points);

  if (minVal === maxVal) {
    minVal -= 1;
    maxVal += 1;
  }

  const stroke = options.stroke || "#1f2328";
  const fill = options.fill || "rgba(31, 35, 40, 0.12)";
  const point = options.point || stroke;

  const toX = (index) =>
    points.length === 1
      ? padding.left + chartW / 2
      : padding.left + (index / (points.length - 1)) * chartW;
  const toY = (value) => padding.top + ((maxVal - value) / (maxVal - minVal)) * chartH;

  if (points.length > 1) {
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 1) {
      const x = toX(i);
      const y = toY(points[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(toX(points.length - 1), padding.top + chartH);
    ctx.lineTo(toX(0), padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.beginPath();
  for (let i = 0; i < points.length; i += 1) {
    const x = toX(i);
    const y = toY(points[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  const lx = toX(points.length - 1);
  const ly = toY(points[points.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = point;
  ctx.fill();
}

function setSoilEmptyVisible(visible) {
  if (!soilChartEmpty) return;
  soilChartEmpty.hidden = !visible;
  soilChartEmpty.classList.toggle("is-hidden", !visible);
}

function refreshMiniCharts() {
  const soilValues = soilHistory.map((item) => item.value);
  drawMiniSparkline(miniSoilCanvas, soilValues, {
    stroke: "#1a7f37",
    fill: "rgba(26, 127, 55, 0.15)",
    point: "#1a7f37"
  });
  drawMiniSparkline(miniStateCanvas, stateCountHistory, {
    stroke: "#0969da",
    fill: "rgba(9, 105, 218, 0.15)",
    point: "#0969da"
  });
  drawMiniSparkline(miniPublishCanvas, publishCountHistory, {
    stroke: "#8250df",
    fill: "rgba(130, 80, 223, 0.15)",
    point: "#8250df"
  });

  if (miniSoilValue) {
    const last = soilValues.length ? soilValues[soilValues.length - 1] : null;
    miniSoilValue.textContent = last === null ? "--" : formatValue(last);
  }
  if (miniStateValue) {
    const last = stateCountHistory.length ? stateCountHistory[stateCountHistory.length - 1] : null;
    miniStateValue.textContent = last === null ? "--" : formatValue(last);
  }
  if (miniPublishValue) {
    const last = publishCountHistory.length ? publishCountHistory[publishCountHistory.length - 1] : publishCount;
    miniPublishValue.textContent = formatValue(last ?? 0);
  }
}

function recordPublishPoint() {
  publishCount += 1;
  pushSeries(publishCountHistory, publishCount);
  refreshMiniCharts();
}

function scoreSoilCandidate(item) {
  const merged = `${item?.identifier || ""} ${item?.name || ""}`.toLowerCase();
  const mergedRaw = `${item?.identifier || ""}${item?.name || ""}`;
  let score = 0;

  if (/(soil[_\s-]*(moist|humid)|(moist|humid).*soil)/.test(merged)) score += 140;
  if (/土壤.*湿|湿度.*土壤/.test(mergedRaw)) score += 140;
  if (/soil/.test(merged)) score += 34;
  if (/moist/.test(merged)) score += 30;
  if (/humid/.test(merged)) score += 22;

  if (["soil_moisture", "soil_humidity", "soilhumidity", "soilmoisture"].includes(merged.replace(/\s+/g, ""))) {
    score += 160;
  }

  const n = toFiniteNumber(item?.value);
  if (n !== null) score += 12;
  return score;
}

function resolveSoilItem(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;

  if (resolvedSoilIdentifier) {
    const fixed = list.find((item) => item.identifier === resolvedSoilIdentifier);
    if (fixed) return fixed;
  }

  const sorted = [...list]
    .map((item) => ({ item, score: scoreSoilCandidate(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!sorted.length) return null;

  resolvedSoilIdentifier = sorted[0].item.identifier;
  return sorted[0].item;
}

function drawSoilChart() {
  if (!soilChartCanvas) return;

  const rect = soilChartCanvas.getBoundingClientRect();
  const width = Math.max(220, Math.floor(rect.width || 220));
  const height = Math.max(180, Math.floor(rect.height || 180));
  const dpr = window.devicePixelRatio || 1;

  soilChartCanvas.width = Math.floor(width * dpr);
  soilChartCanvas.height = Math.floor(height * dpr);

  const ctx = soilChartCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const hasData = soilHistory.length >= 1;
  setSoilEmptyVisible(!hasData);
  if (!hasData) return;

  const padding = { left: 36, right: 14, top: 14, bottom: 22 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const values = soilHistory.map((item) => item.value);
  let minVal = Math.min(...values);
  let maxVal = Math.max(...values);
  if (minVal === maxVal) {
    minVal -= 1;
    maxVal += 1;
  }

  const pad = Math.max((maxVal - minVal) * 0.12, 1);
  minVal -= pad;
  maxVal += pad;

  const toX = (index) =>
    soilHistory.length === 1
      ? padding.left + chartW / 2
      : padding.left + (index / (soilHistory.length - 1)) * chartW;
  const toY = (value) => padding.top + ((maxVal - value) / (maxVal - minVal)) * chartH;

  ctx.strokeStyle = "#eaeef2";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartW, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#8b949e";
  ctx.font = '11px "Segoe UI"';
  ctx.fillText(formatValue(maxVal), 3, padding.top + 4);
  ctx.fillText(formatValue(minVal), 3, padding.top + chartH);

  if (soilHistory.length > 1) {
    ctx.beginPath();
    for (let i = 0; i < soilHistory.length; i += 1) {
      const x = toX(i);
      const y = toY(soilHistory[i].value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
    gradient.addColorStop(0, "rgba(26, 127, 55, 0.22)");
    gradient.addColorStop(1, "rgba(26, 127, 55, 0.02)");

    ctx.lineTo(toX(soilHistory.length - 1), padding.top + chartH);
    ctx.lineTo(toX(0), padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  ctx.beginPath();
  for (let i = 0; i < soilHistory.length; i += 1) {
    const x = toX(i);
    const y = toY(soilHistory[i].value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.strokeStyle = "#1a7f37";
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  const lastIndex = soilHistory.length - 1;
  const lx = toX(lastIndex);
  const ly = toY(soilHistory[lastIndex].value);
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#1a7f37";
  ctx.fill();
}

function updateSoilKpis() {
  if (!soilCurrentValue || !soilMinValue || !soilMaxValue) return;

  if (!soilHistory.length) {
    soilCurrentValue.textContent = "--";
    soilMinValue.textContent = "--";
    soilMaxValue.textContent = "--";
    return;
  }

  const values = soilHistory.map((item) => item.value);
  const current = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const suffix = soilUnit ? ` ${soilUnit}` : "";

  soilCurrentValue.textContent = `${formatValue(current)}${suffix}`;
  soilMinValue.textContent = `${formatValue(min)}${suffix}`;
  soilMaxValue.textContent = `${formatValue(max)}${suffix}`;
}

function pushSoilHistory(item) {
  if (!item) return;
  const num = toFiniteNumber(item.value);
  if (num === null) return;

  const ts = item?.timestamp ? new Date(item.timestamp).getTime() : Date.now();
  const timestamp = Number.isFinite(ts) ? ts : Date.now();

  const last = soilHistory[soilHistory.length - 1];
  if (last && Math.abs(last.ts - timestamp) < 300) {
    last.value = num;
  } else {
    soilHistory.push({ ts: timestamp, value: num });
  }

  while (soilHistory.length > SOIL_HISTORY_LIMIT) {
    soilHistory.shift();
  }

  soilUnit = item?.unit || soilUnit || "";
  updateSoilKpis();
  drawSoilChart();
  refreshMiniCharts();
}

function renderThingModel(modelData) {
  thingModelProperties = Array.isArray(modelData?.properties) ? modelData.properties : [];
  if (modelPropertyList) modelPropertyList.innerHTML = "";
  if (modelCountValue) modelCountValue.textContent = String(thingModelProperties.length);
  if (modelMeta) modelMeta.textContent = shortSource(modelData?.source, modelData?.updatedAt, modelData?.lastError);

  if (modelPropertyList) {
    if (!thingModelProperties.length) {
      const empty = document.createElement("div");
      empty.className = "property-empty";
      empty.textContent = modelData?.lastError || "暂无属性";
      modelPropertyList.appendChild(empty);
    } else {
      for (const p of thingModelProperties) {
        const item = document.createElement("div");
        item.className = "model-item";
        const modeText = p?.rwMode ? ` · ${p.rwMode}` : "";
        item.innerHTML = `<div class="title">${p?.name || p?.identifier || "unknown"}</div>
          <div class="desc">${p?.identifier || "-"} · ${p?.dataType || "unknown"}${modeText}</div>`;
        modelPropertyList.appendChild(item);
      }
    }
  }

}

function renderPropertyState(data) {
  currentPropertyState = Array.isArray(data?.properties) ? data.properties : [];
  pushSeries(stateCountHistory, currentPropertyState.length);

  if (stateCountValue) stateCountValue.textContent = String(currentPropertyState.length);
  if (propertyStateMeta) {
    propertyStateMeta.textContent = shortSource(data?.source, data?.updatedAt, data?.lastError);
  }

  if (propertyVisualGrid) {
    propertyVisualGrid.innerHTML = "";
    if (!currentPropertyState.length) {
      const empty = document.createElement("div");
      empty.className = "property-empty";
      empty.textContent = data?.lastError || "暂无状态";
      propertyVisualGrid.appendChild(empty);
    } else {
      for (const item of currentPropertyState) {
        const vm = buildPropertyDisplayModel(item);
        const card = document.createElement("article");
        card.className = `property-card is-${vm.iconType}`;

        const head = document.createElement("div");
        head.className = "property-card-head";

        const icon = document.createElement("span");
        icon.className = "property-type-icon";
        icon.innerHTML = propertyTypeIconSvg(vm.iconType);

        const titleWrap = document.createElement("div");
        titleWrap.className = "property-title-wrap";

        const nameNode = document.createElement("div");
        nameNode.className = "property-name";
        nameNode.textContent = vm.displayName;
        nameNode.title = vm.displayName;

        const idNode = document.createElement("div");
        idNode.className = "property-id";
        idNode.textContent = vm.identifier;
        idNode.title = vm.identifier;

        titleWrap.appendChild(nameNode);
        titleWrap.appendChild(idNode);

        head.appendChild(icon);
        head.appendChild(titleWrap);

        const mainValue = document.createElement("div");
        mainValue.className = "property-main-value";
        mainValue.textContent = vm.displayValueSummary;
        mainValue.title = vm.displayValueSummary;

        const badgeRow = document.createElement("div");
        badgeRow.className = "property-badges";
        for (const label of vm.badges) {
          const badge = document.createElement("span");
          badge.className = "property-badge";
          badge.textContent = label;
          badgeRow.appendChild(badge);
        }

        card.appendChild(head);
        card.appendChild(mainValue);
        card.appendChild(badgeRow);

        if (vm.detailJson) {
          const detail = document.createElement("details");
          detail.className = "property-detail";
          const summary = document.createElement("summary");
          summary.textContent = "详情";
          const pre = document.createElement("pre");
          pre.className = "detail-code";
          pre.textContent = vm.detailJson;
          detail.appendChild(summary);
          detail.appendChild(pre);
          card.appendChild(detail);
        }

        propertyVisualGrid.appendChild(card);
      }
    }
  }

  const soilItem = resolveSoilItem(currentPropertyState);
  if (soilItem) {
    pushSoilHistory(soilItem);
  } else {
    refreshMiniCharts();
  }
}

function updateStatus(data) {
  if (data?.config) currentConfig = data.config;

  const transport = data?.config?.transport || data?.defaults?.transport || "";
  const commandOnly = transport === "openapi_command_only";
  const subscribeEnabled = false;

  if (statusPill && connectionValue) {
    if (data?.connecting) {
      statusPill.className = "status-pill status-connecting";
      statusPill.textContent = "连接中";
      connectionValue.textContent = "连接中";
    } else if (data?.connected) {
      statusPill.className = "status-pill status-online";
      statusPill.textContent = commandOnly ? "在线(命令)" : "在线";
      connectionValue.textContent = commandOnly ? "华为命令通道" : "非命令通道";
    } else {
      statusPill.className = "status-pill status-offline";
      statusPill.textContent = "离线";
      connectionValue.textContent = "离线";
    }
  }

  if (envModeHint) {
    if (data?.connected && data?.config) {
      const product = data.config.productId || data.config.productKey || "-";
      const device = data.config.deviceId || data.config.deviceName || "-";
      envModeHint.textContent = `${product}/${device}`;
    } else if (data?.defaults?.hasEnvTriplet) {
      envModeHint.textContent = ".env 已就绪";
    } else {
      envModeHint.textContent = "未配置设备";
    }

    if (data?.targetDevice?.status) {
      envModeHint.textContent = `${envModeHint.textContent} · ${data.targetDevice.status}`;
    }
  }

  if (subTopicInput && subQosInput && subForm && unsubBtn) {
    subTopicInput.disabled = !subscribeEnabled;
    subQosInput.disabled = !subscribeEnabled;
    const subBtn = subForm.querySelector('button[type="submit"]');
    if (subBtn) subBtn.disabled = !subscribeEnabled;
    unsubBtn.disabled = !subscribeEnabled;

    if (!subscribeEnabled) {
      if (subscriptionPanel) subscriptionPanel.hidden = true;
      if (debugModeHint) debugModeHint.textContent = "命令模式下已隐藏订阅面板";
      subTopicInput.placeholder = "订阅已禁用";
    } else {
      if (subscriptionPanel) subscriptionPanel.hidden = false;
      if (debugModeHint) debugModeHint.textContent = "";
      subTopicInput.placeholder = "完整 Topic 或 user/xxx";
    }
  }

  if (data?.thingModel) {
    if (modelMeta) modelMeta.textContent = shortSource(data.thingModel.source, data.thingModel.updatedAt, data.thingModel.lastError);
    if (modelCountValue) modelCountValue.textContent = String(data.thingModel.count ?? thingModelProperties.length);
  }

  if (data?.propertyState) {
    if (propertyStateMeta) {
      propertyStateMeta.textContent = shortSource(
        data.propertyState.source,
        data.propertyState.updatedAt,
        data.propertyState.lastError
      );
    }
    if (stateCountValue) {
      stateCountValue.textContent = String(data.propertyState.count ?? currentPropertyState.length);
    }
  }

  renderSubscriptions(data?.subscriptions || []);
  fillDefaultTopic();
  syncPayloadServiceId();
}

function applyPropertyToPayload() {
  const commandName = String(quickPropertyInput?.value || "").trim();
  if (!commandName) {
    pushLine(logList, "请先选择命令", "warn");
    return;
  }

  let payloadObj = {
    service_id: "Rets2",
    command_name: commandName,
    paras: {}
  };

  const parsed = parseJsonText(publishPayloadInput?.value || "");
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    payloadObj = {
      ...payloadObj,
      ...parsed,
      paras:
        parsed.paras && typeof parsed.paras === "object" && !Array.isArray(parsed.paras)
          ? parsed.paras
          : {}
    };
  }

  const valueText = String(quickValueInput?.value || "").trim();
  let normalizedParas = {};

  if (commandName === "turn_light" || commandName === "turn_relay") {
    if (!valueText) {
      pushLine(logList, "turn_light / turn_relay 请输入 0 或 1", "warn");
      return;
    }
    const normalizedValue = Number(parseSmartValue(valueText)) > 0 ? 1 : 0;
    const paramKey = commandName === "turn_light" ? "Light_Status" : "Relay_Status";
    normalizedParas = { [paramKey]: normalizedValue };
  } else if (commandName === "blink_light" || commandName === "blink_relay") {
    try {
      normalizedParas = parseBlinkQuickInput(valueText, commandName);
    } catch (error) {
      pushLine(logList, error.message, "warn");
      return;
    }
  } else {
    pushLine(logList, `暂不支持命令: ${commandName}`, "warn");
    return;
  }

  payloadObj.command_name = commandName;
  payloadObj.paras = normalizedParas;
  if (publishPayloadInput) {
    publishPayloadInput.value = JSON.stringify(payloadObj, null, 2);
  }
}

async function connectByEnv() {
  const result = await api("/api/connect", { method: "POST", body: "{}" });
  pushLine(logList, result.message, "success");
}

async function loadThingModelProperties() {
  const result = await api("/api/model/properties");
  renderThingModel(result);
}

async function loadDevicePropertyState() {
  const result = await api("/api/device/properties");
  renderPropertyState(result);
}

if (connectWithEnvBtn) {
  connectWithEnvBtn.addEventListener("click", async () => {
    try {
      await connectByEnv();
    } catch (error) {
      pushLine(logList, error.message, "error");
    }
  });
}

if (disconnectBtn) {
  disconnectBtn.addEventListener("click", async () => {
    try {
      const result = await api("/api/disconnect", { method: "POST", body: "{}" });
      pushLine(logList, result.message, "warn");
    } catch (error) {
      pushLine(logList, error.message, "error");
    }
  });
}

if (refreshModelBtn) {
  refreshModelBtn.addEventListener("click", async () => {
    try {
      const result = await api("/api/model/refresh", { method: "POST", body: "{}" });
      renderThingModel(result);
    } catch (error) {
      pushLine(logList, `模型刷新失败: ${error.message}`, "error");
    }
  });
}

if (refreshStateBtn) {
  refreshStateBtn.addEventListener("click", async () => {
    try {
      const result = await api("/api/device/properties/refresh", { method: "POST", body: "{}" });
      renderPropertyState(result);
    } catch (error) {
      pushLine(logList, `状态刷新失败: ${error.message}`, "error");
    }
  });
}

if (applyPropertyBtn) {
  applyPropertyBtn.addEventListener("click", applyPropertyToPayload);
}

if (quickPropertyInput) {
  quickPropertyInput.addEventListener("change", applyQuickInputHint);
}

if (publishForm) {
  publishForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    fillDefaultTopic();

    const topic = String(publishTopicInput?.value || "").trim();
    const qos = Number(publishQosInput?.value || 0);
    const retain = Boolean(publishRetainInput?.checked);
    const payload = parseJsonText(publishPayloadInput?.value || "");

    try {
      const result = await api("/api/publish", {
        method: "POST",
        body: JSON.stringify({ topic, payload, qos, retain })
      });

      if (result.normalizedPayload && publishPayloadInput) {
        publishPayloadInput.value = JSON.stringify(result.normalizedPayload, null, 2);
      }

      const route = result.route || "huawei_create_command";
      pushLine(logList, `发布成功 [${route}]`, "success");
      if (Array.isArray(result.warnings)) {
        for (const warning of result.warnings) {
          pushLine(logList, warning, "warn");
        }
      }
    } catch (error) {
      pushLine(logList, error.message, "error");
    }
  });
}

if (subForm) {
  subForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const topic = String(subTopicInput?.value || "").trim();
    const qos = Number(subQosInput?.value || 0);
    if (!topic) return;

    try {
      const result = await api("/api/subscribe", {
        method: "POST",
        body: JSON.stringify({ topic, qos })
      });
      if (result.topic && subTopicInput) {
        subTopicInput.value = result.topic;
      }
    } catch (error) {
      pushLine(logList, error.message, "error");
    }
  });
}

if (unsubBtn) {
  unsubBtn.addEventListener("click", async () => {
    const topic = String(subTopicInput?.value || "").trim();
    if (!topic) return;

    try {
      const result = await api("/api/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ topic })
      });
      if (result.topic && subTopicInput) {
        subTopicInput.value = result.topic;
      }
    } catch (error) {
      pushLine(logList, error.message, "error");
    }
  });
}

socket.on("status", (data) => updateStatus(data));
socket.on("thing_model", (event) => renderThingModel(event));
socket.on("property_state", (event) => renderPropertyState(event));

socket.on("subscribed", (event) => {
  pushLine(logList, `已订阅 ${event.topic}`, "success", event.timestamp);
});

socket.on("log", (event) => {
  const extra = event.extra ? ` ${safeJson(event.extra)}` : "";
  const css = event.level === "error" ? "error" : event.level === "warn" ? "warn" : "";
  pushLine(logList, `[${event.level}] ${event.message}${extra}`, css, event.timestamp);
});

socket.on("published", (event) => {
  recordPublishPoint();
  pushLine(logList, `已发布 ${event.topic} [${event.route || "huawei_create_command"}]`, "success", event.timestamp);
});

window.addEventListener("resize", () => {
  if (chartResizeTimer) clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    drawSoilChart();
    refreshMiniCharts();
  }, 120);
});

async function init() {
  try {
    publishCount = 0;
    publishCountHistory.length = 0;
    stateCountHistory.length = 0;
    pushSeries(publishCountHistory, 0);
    pushSeries(stateCountHistory, 0);

    setSoilEmptyVisible(true);
    drawSoilChart();
    updateSoilKpis();
    refreshMiniCharts();
    renderQuickCommandOptions();
    fillDefaultCommandPayload();

    const status = await api("/api/status");
    updateStatus(status);

    await loadThingModelProperties();
    await loadDevicePropertyState();
  } catch (error) {
    pushLine(logList, error.message, "error");
  }
}

init();
