const socket = io();

const statusPill = document.getElementById("statusPill");
const envModeHint = document.getElementById("envModeHint");
const modelMeta = document.getElementById("modelMeta");
const modelPropertyList = document.getElementById("modelPropertyList");
const propertyStateMeta = document.getElementById("propertyStateMeta");
const propertyVisualGrid = document.getElementById("propertyVisualGrid");
const quickPropertyInput = document.getElementById("quickProperty");
const quickCommandHint = document.getElementById("quickCommandHint");
const quickParamForm = document.getElementById("quickParamForm");
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
const targetStatusValue = document.getElementById("targetStatusValue");

const soilChartCanvas = document.getElementById("soilChartCanvas");
const soilChartEmpty = document.getElementById("soilChartEmpty");
const soilCurrentValue = document.getElementById("soilCurrentValue");
const soilMinValue = document.getElementById("soilMinValue");
const soilMaxValue = document.getElementById("soilMaxValue");
const airTempChartCanvas = document.getElementById("airTempChartCanvas");
const airTempChartEmpty = document.getElementById("airTempChartEmpty");
const airTempCurrentValue = document.getElementById("airTempCurrentValue");
const airTempMinValue = document.getElementById("airTempMinValue");
const airTempMaxValue = document.getElementById("airTempMaxValue");
const airHumidityChartCanvas = document.getElementById("airHumidityChartCanvas");
const airHumidityChartEmpty = document.getElementById("airHumidityChartEmpty");
const airHumidityCurrentValue = document.getElementById("airHumidityCurrentValue");
const airHumidityMinValue = document.getElementById("airHumidityMinValue");
const airHumidityMaxValue = document.getElementById("airHumidityMaxValue");

const connectWithEnvBtn = document.getElementById("connectWithEnvBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const refreshModelBtn = document.getElementById("refreshModelBtn");
const refreshStateBtn = document.getElementById("refreshStateBtn");
const applyPropertyBtn = document.getElementById("applyPropertyBtn");
const publishForm = document.getElementById("publishForm");
const publishBtn = document.getElementById("publishBtn");
const subForm = document.getElementById("subForm");
const unsubBtn = document.getElementById("unsubBtn");

let currentConfig = null;
let thingModelProperties = [];
let thingModelCommands = [];
let currentPropertyState = [];
let resolvedSoilIdentifier = "";
let resolvedAirTempIdentifier = "";
let resolvedAirHumidityIdentifier = "";
let soilUnit = "";
let airTempUnit = "";
let airHumidityUnit = "";
let chartResizeTimer = null;

const MAX_LINES = 260;
const SOIL_HISTORY_LIMIT = 90;
const soilHistory = [];
const airTempHistory = [];
const airHumidityHistory = [];

function fmtTime(ts) {
  const t = ts ? new Date(ts) : new Date();
  if (Number.isNaN(t.getTime())) return "-";
  return t.toLocaleString("zh-CN", { hour12: false });
}

function fmtAxisTime(ts) {
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return "--:--";
  return t.toLocaleTimeString("zh-CN", { hour12: false });
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

function normalizeCommandParamType(rawType) {
  const type = String(rawType || "").trim().toLowerCase();
  if (["int", "long", "float", "double", "number", "decimal"].includes(type)) return "number";
  if (["bool", "boolean"].includes(type)) return "bool";
  if (["struct", "object", "json"].includes(type)) return "struct";
  if (type === "array") return "array";
  return "text";
}

function setCommandHint(text) {
  if (!quickCommandHint) return;
  quickCommandHint.textContent = text;
}

function getCommandDefinition(commandName) {
  return thingModelCommands.find((item) => item?.command_name === commandName) || null;
}

function formatCommandOptionText(command) {
  const name = command?.command_name || "";
  if (!name) return "(unknown)";
  const paramNames = Array.isArray(command?.paras)
    ? command.paras.map((item) => item?.para_name).filter(Boolean).join("/")
    : "";
  return paramNames ? `${name} (${paramNames})` : `${name} (无参数)`;
}

function setPublishAvailability(enabled) {
  if (quickPropertyInput) quickPropertyInput.disabled = !enabled;
  if (applyPropertyBtn) applyPropertyBtn.disabled = !enabled;
  if (publishBtn) publishBtn.disabled = !enabled;
}

function readPayloadParasForCommand(commandName) {
  const parsed = parseJsonText(publishPayloadInput?.value || "");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  if (String(parsed.command_name || "") !== commandName) return {};
  return parsed.paras && typeof parsed.paras === "object" && !Array.isArray(parsed.paras) ? parsed.paras : {};
}

function createCommandParamField(parameter, existingParas) {
  const wrapper = document.createElement("div");
  wrapper.className = "command-param-item";

  const title = document.createElement("div");
  title.className = "command-param-title";

  const nameNode = document.createElement("span");
  nameNode.className = "command-param-name";
  nameNode.textContent = parameter.para_name;
  title.appendChild(nameNode);

  const typeNode = document.createElement("span");
  typeNode.className = "command-param-type";
  typeNode.textContent = parameter.data_type || "text";
  title.appendChild(typeNode);

  if (parameter.required) {
    const required = document.createElement("span");
    required.className = "command-param-required";
    required.textContent = "必填";
    title.appendChild(required);
  }

  wrapper.appendChild(title);

  const inputType = normalizeCommandParamType(parameter.data_type);
  const enumList = Array.isArray(parameter.enum_list) ? parameter.enum_list : [];
  const existingValue = Object.prototype.hasOwnProperty.call(existingParas, parameter.para_name)
    ? existingParas[parameter.para_name]
    : undefined;

  let control = null;
  if (enumList.length > 0) {
    const select = document.createElement("select");
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = parameter.required ? "请选择" : "(可选)";
    select.appendChild(emptyOption);
    for (const optionValue of enumList) {
      const option = document.createElement("option");
      option.value = String(optionValue);
      option.textContent = String(optionValue);
      select.appendChild(option);
    }
    if (existingValue !== undefined && existingValue !== null) {
      select.value = String(existingValue);
    } else if (parameter.required && enumList.length > 0) {
      select.value = String(enumList[0]);
    }
    control = select;
  } else if (inputType === "bool") {
    const select = document.createElement("select");
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = parameter.required ? "请选择" : "(可选)";
    select.appendChild(emptyOption);

    const falseOption = document.createElement("option");
    falseOption.value = "false";
    falseOption.textContent = "false";
    select.appendChild(falseOption);

    const trueOption = document.createElement("option");
    trueOption.value = "true";
    trueOption.textContent = "true";
    select.appendChild(trueOption);

    if (existingValue !== undefined && existingValue !== null) {
      select.value = String(Boolean(existingValue));
    } else if (parameter.required) {
      select.value = "false";
    }
    control = select;
  } else if (inputType === "number") {
    const input = document.createElement("input");
    input.type = "number";
    if (parameter.min !== null && parameter.min !== undefined) input.min = String(parameter.min);
    if (parameter.max !== null && parameter.max !== undefined) input.max = String(parameter.max);
    if (parameter.step !== null && parameter.step !== undefined) {
      input.step = String(parameter.step);
    } else {
      input.step = "any";
    }
    if (existingValue !== undefined && existingValue !== null) {
      input.value = String(existingValue);
    } else if (parameter.required) {
      input.value = String(parameter.min !== null && parameter.min !== undefined ? parameter.min : 0);
    }
    control = input;
  } else if (inputType === "struct" || inputType === "array") {
    const textarea = document.createElement("textarea");
    textarea.rows = 2;
    textarea.placeholder = inputType === "struct" ? '{"key":"value"}' : "[1,2,3]";
    if (existingValue !== undefined && existingValue !== null) {
      textarea.value = formatJsonPretty(existingValue);
    } else if (parameter.required) {
      textarea.value = inputType === "struct" ? "{}" : "[]";
    }
    control = textarea;
  } else {
    const input = document.createElement("input");
    input.type = "text";
    if (existingValue !== undefined && existingValue !== null) {
      input.value = String(existingValue);
    }
    control = input;
  }

  control.setAttribute("data-command-param", "1");
  control.setAttribute("data-param-name", parameter.para_name);
  control.setAttribute("data-param-type", inputType);
  control.setAttribute("data-required", parameter.required ? "1" : "0");
  wrapper.appendChild(control);

  const descParts = [];
  if (parameter.unit) descParts.push(`单位: ${parameter.unit}`);
  if (parameter.description) descParts.push(parameter.description);
  if (descParts.length > 0) {
    const desc = document.createElement("div");
    desc.className = "command-param-desc";
    desc.textContent = descParts.join(" · ");
    wrapper.appendChild(desc);
  }

  return wrapper;
}

function renderCommandParamForm(commandName) {
  if (!quickParamForm) return;
  quickParamForm.innerHTML = "";

  if (!thingModelCommands.length) {
    setPublishAvailability(false);
    setCommandHint("未同步到可用命令，请先连接并同步模型。");
    const empty = document.createElement("div");
    empty.className = "command-param-empty";
    empty.textContent = "当前没有可用命令。";
    quickParamForm.appendChild(empty);
    return;
  }

  setPublishAvailability(true);
  const command = getCommandDefinition(commandName);
  if (!command) {
    setCommandHint("请选择命令。");
    const empty = document.createElement("div");
    empty.className = "command-param-empty";
    empty.textContent = "选择命令后可填写参数。";
    quickParamForm.appendChild(empty);
    return;
  }

  const params = Array.isArray(command.paras) ? command.paras : [];
  const existingParas = readPayloadParasForCommand(command.command_name);
  setCommandHint(command.description || `参数数量: ${params.length}`);

  if (!params.length) {
    const empty = document.createElement("div");
    empty.className = "command-param-empty";
    empty.textContent = "该命令无参数，点击“填充”即可生成 payload。";
    quickParamForm.appendChild(empty);
    return;
  }

  for (const parameter of params) {
    quickParamForm.appendChild(createCommandParamField(parameter, existingParas));
  }
}

function renderQuickCommandOptions() {
  if (!quickPropertyInput) return;
  const previousValue = String(quickPropertyInput.value || "").trim();
  quickPropertyInput.innerHTML = "";

  if (!thingModelCommands.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "请先同步模型";
    quickPropertyInput.appendChild(option);
    quickPropertyInput.value = "";
    renderCommandParamForm("");
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "选择命令";
  quickPropertyInput.appendChild(placeholder);

  for (const command of thingModelCommands) {
    const option = document.createElement("option");
    option.value = command.command_name;
    option.textContent = formatCommandOptionText(command);
    quickPropertyInput.appendChild(option);
  }

  const nextValue = getCommandDefinition(previousValue) ? previousValue : thingModelCommands[0].command_name;
  quickPropertyInput.value = nextValue;
  renderCommandParamForm(nextValue);
}

function fillDefaultCommandPayload() {
  if (!publishPayloadInput) return;
  const existingText = String(publishPayloadInput.value || "").trim();
  if (existingText) {
    const existing = parseJsonText(existingText);
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      const existingCommand = String(existing.command_name || "").trim();
      if (existingCommand) return;
    } else {
      return;
    }
  }

  const firstCommand = thingModelCommands[0];
  const commandName = firstCommand?.command_name || "";
  const serviceId = String(currentConfig?.serviceId || "Rets2").trim() || "Rets2";

  const paras = {};
  for (const parameter of Array.isArray(firstCommand?.paras) ? firstCommand.paras : []) {
    if (!parameter.required) continue;
    const enumList = Array.isArray(parameter.enum_list) ? parameter.enum_list : [];
    const type = normalizeCommandParamType(parameter.data_type);
    if (enumList.length > 0) {
      paras[parameter.para_name] = enumList[0];
    } else if (type === "number") {
      paras[parameter.para_name] = parameter.min !== null && parameter.min !== undefined ? parameter.min : 0;
    } else if (type === "bool") {
      paras[parameter.para_name] = false;
    } else if (type === "array") {
      paras[parameter.para_name] = [];
    } else if (type === "struct") {
      paras[parameter.para_name] = {};
    } else {
      paras[parameter.para_name] = "";
    }
  }

  publishPayloadInput.value = JSON.stringify(
    {
      service_id: serviceId,
      command_name: commandName,
      paras
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

function parseCommandFieldValue(rawValue, parameter, commandName) {
  const dataType = normalizeCommandParamType(parameter.data_type);
  const fieldLabel = `${commandName}.${parameter.para_name}`;
  let parsedValue = rawValue;

  if (dataType === "number") {
    const num = Number(rawValue);
    if (!Number.isFinite(num)) throw new Error(`${fieldLabel} 需要数字。`);
    parsedValue = num;
  } else if (dataType === "bool") {
    const text = String(rawValue).trim().toLowerCase();
    if (text === "true" || text === "1") {
      parsedValue = true;
    } else if (text === "false" || text === "0") {
      parsedValue = false;
    } else {
      throw new Error(`${fieldLabel} 需要布尔值。`);
    }
  } else if (dataType === "struct" || dataType === "array") {
    try {
      parsedValue = JSON.parse(String(rawValue));
    } catch (_error) {
      throw new Error(`${fieldLabel} 需要合法 JSON。`);
    }
    if (dataType === "struct" && (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue))) {
      throw new Error(`${fieldLabel} 需要对象。`);
    }
    if (dataType === "array" && !Array.isArray(parsedValue)) {
      throw new Error(`${fieldLabel} 需要数组。`);
    }
  } else {
    parsedValue = String(rawValue);
  }

  const enumList = Array.isArray(parameter.enum_list) ? parameter.enum_list : [];
  if (enumList.length > 0 && !enumList.some((item) => String(item) === String(parsedValue))) {
    throw new Error(`${fieldLabel} 取值必须为: ${enumList.join(", ")}`);
  }

  return parsedValue;
}

function collectCommandParams(commandDefinition) {
  const collected = {};
  const fields = quickParamForm ? quickParamForm.querySelectorAll("[data-command-param='1']") : [];
  const fieldMap = new Map();
  for (const field of fields) {
    fieldMap.set(field.getAttribute("data-param-name"), field);
  }

  const params = Array.isArray(commandDefinition?.paras) ? commandDefinition.paras : [];
  for (const parameter of params) {
    const field = fieldMap.get(parameter.para_name);
    const rawValue = field ? String(field.value ?? "").trim() : "";
    if (!rawValue) {
      if (parameter.required) {
        throw new Error(`${commandDefinition.command_name} 缺少必填参数: ${parameter.para_name}`);
      }
      continue;
    }
    collected[parameter.para_name] = parseCommandFieldValue(rawValue, parameter, commandDefinition.command_name);
  }

  return collected;
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

function setSoilEmptyVisible(visible) {
  if (!soilChartEmpty) return;
  soilChartEmpty.hidden = !visible;
  soilChartEmpty.classList.toggle("is-hidden", !visible);
}

function setAirTempEmptyVisible(visible) {
  if (!airTempChartEmpty) return;
  airTempChartEmpty.hidden = !visible;
  airTempChartEmpty.classList.toggle("is-hidden", !visible);
}

function setAirHumidityEmptyVisible(visible) {
  if (!airHumidityChartEmpty) return;
  airHumidityChartEmpty.hidden = !visible;
  airHumidityChartEmpty.classList.toggle("is-hidden", !visible);
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

function scoreAirTempCandidate(item) {
  const merged = `${item?.identifier || ""} ${item?.name || ""}`.toLowerCase();
  const mergedRaw = `${item?.identifier || ""}${item?.name || ""}`;
  let score = 0;

  if (/(air[_\s-]*(temp|temperature)|(temp|temperature).*air)/.test(merged)) score += 160;
  if (/空气.*温|温度.*空气/.test(mergedRaw)) score += 160;
  if (["airtemperature", "air_temp", "temperature", "airtemperaturevalue"].includes(merged.replace(/\s+/g, ""))) {
    score += 180;
  }
  if (/temp|temperature/.test(merged)) score += 30;
  if (/soil|humid/.test(merged)) score -= 35;

  const n = toFiniteNumber(item?.value);
  if (n !== null) score += 12;
  return score;
}

function resolveAirTempItem(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;

  if (resolvedAirTempIdentifier) {
    const fixed = list.find((item) => item.identifier === resolvedAirTempIdentifier);
    if (fixed) return fixed;
  }

  const sorted = [...list]
    .map((item) => ({ item, score: scoreAirTempCandidate(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!sorted.length) return null;
  resolvedAirTempIdentifier = sorted[0].item.identifier;
  return sorted[0].item;
}

function scoreAirHumidityCandidate(item) {
  const merged = `${item?.identifier || ""} ${item?.name || ""}`.toLowerCase();
  const mergedRaw = `${item?.identifier || ""}${item?.name || ""}`;
  let score = 0;

  if (/(air[_\s-]*(humid|humidity)|(humid|humidity).*air)/.test(merged)) score += 160;
  if (/空气.*湿|湿度.*空气/.test(mergedRaw)) score += 160;
  if (["airhumidity", "air_humidity", "humidity", "airhumid"].includes(merged.replace(/\s+/g, ""))) {
    score += 180;
  }
  if (/humid|humidity/.test(merged)) score += 28;
  if (/soil/.test(merged)) score -= 80;
  if (/temp|temperature/.test(merged)) score -= 25;

  const n = toFiniteNumber(item?.value);
  if (n !== null) score += 12;
  return score;
}

function resolveAirHumidityItem(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;

  if (resolvedAirHumidityIdentifier) {
    const fixed = list.find((item) => item.identifier === resolvedAirHumidityIdentifier);
    if (fixed) return fixed;
  }

  const sorted = [...list]
    .map((item) => ({ item, score: scoreAirHumidityCandidate(item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!sorted.length) return null;
  resolvedAirHumidityIdentifier = sorted[0].item.identifier;
  return sorted[0].item;
}

function drawMetricChart(canvas, history, color, fillTop, fillBottom, setEmptyVisible) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const width = Math.max(220, Math.floor(rect.width || 220));
  const height = Math.max(180, Math.floor(rect.height || 180));
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const hasData = history.length >= 1;
  setEmptyVisible(!hasData);
  if (!hasData) return;

  const padding = { left: 36, right: 14, top: 14, bottom: 34 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const values = history.map((item) => item.value);
  let minVal = Math.min(...values);
  let maxVal = Math.max(...values);
  if (minVal === maxVal) {
    minVal -= 1;
    maxVal += 1;
  }

  const pad = Math.max((maxVal - minVal) * 0.12, 1);
  minVal -= pad;
  maxVal += pad;

  const toX = (index) => (history.length === 1 ? padding.left + chartW / 2 : padding.left + (index / (history.length - 1)) * chartW);
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

  if (history.length > 1) {
    ctx.beginPath();
    for (let i = 0; i < history.length; i += 1) {
      const x = toX(i);
      const y = toY(history[i].value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
    gradient.addColorStop(0, fillTop);
    gradient.addColorStop(1, fillBottom);

    ctx.lineTo(toX(history.length - 1), padding.top + chartH);
    ctx.lineTo(toX(0), padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
  }

  ctx.beginPath();
  for (let i = 0; i < history.length; i += 1) {
    const x = toX(i);
    const y = toY(history[i].value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  const lastIndex = history.length - 1;
  const lx = toX(lastIndex);
  const ly = toY(history[lastIndex].value);
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  const start = history[0];
  const mid = history[Math.floor(lastIndex / 2)];
  const end = history[lastIndex];
  const axisY = padding.top + chartH + 14;

  ctx.fillStyle = "#8b949e";
  ctx.font = '10px "Segoe UI"';
  ctx.textBaseline = "middle";

  ctx.textAlign = "left";
  ctx.fillText(fmtAxisTime(start?.ts), padding.left, axisY);

  ctx.textAlign = "center";
  if (lastIndex >= 2) {
    ctx.fillText(fmtAxisTime(mid?.ts), padding.left + chartW / 2, axisY);
  }

  ctx.textAlign = "right";
  ctx.fillText(fmtAxisTime(end?.ts), padding.left + chartW, axisY);
}

function drawSoilChart() {
  drawMetricChart(
    soilChartCanvas,
    soilHistory,
    "#1a7f37",
    "rgba(26, 127, 55, 0.22)",
    "rgba(26, 127, 55, 0.02)",
    setSoilEmptyVisible
  );
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
}

function drawAirTempChart() {
  drawMetricChart(
    airTempChartCanvas,
    airTempHistory,
    "#d97706",
    "rgba(217, 119, 6, 0.22)",
    "rgba(217, 119, 6, 0.02)",
    setAirTempEmptyVisible
  );
}

function updateAirTempKpis() {
  if (!airTempCurrentValue || !airTempMinValue || !airTempMaxValue) return;

  if (!airTempHistory.length) {
    airTempCurrentValue.textContent = "--";
    airTempMinValue.textContent = "--";
    airTempMaxValue.textContent = "--";
    return;
  }

  const values = airTempHistory.map((item) => item.value);
  const current = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const suffix = airTempUnit ? ` ${airTempUnit}` : "";

  airTempCurrentValue.textContent = `${formatValue(current)}${suffix}`;
  airTempMinValue.textContent = `${formatValue(min)}${suffix}`;
  airTempMaxValue.textContent = `${formatValue(max)}${suffix}`;
}

function pushAirTempHistory(item) {
  if (!item) return;
  const num = toFiniteNumber(item.value);
  if (num === null) return;

  const ts = item?.timestamp ? new Date(item.timestamp).getTime() : Date.now();
  const timestamp = Number.isFinite(ts) ? ts : Date.now();

  const last = airTempHistory[airTempHistory.length - 1];
  if (last && Math.abs(last.ts - timestamp) < 300) {
    last.value = num;
  } else {
    airTempHistory.push({ ts: timestamp, value: num });
  }

  while (airTempHistory.length > SOIL_HISTORY_LIMIT) {
    airTempHistory.shift();
  }

  airTempUnit = item?.unit || airTempUnit || "";
  updateAirTempKpis();
  drawAirTempChart();
}

function drawAirHumidityChart() {
  drawMetricChart(
    airHumidityChartCanvas,
    airHumidityHistory,
    "#0e7490",
    "rgba(14, 116, 144, 0.22)",
    "rgba(14, 116, 144, 0.02)",
    setAirHumidityEmptyVisible
  );
}

function updateAirHumidityKpis() {
  if (!airHumidityCurrentValue || !airHumidityMinValue || !airHumidityMaxValue) return;

  if (!airHumidityHistory.length) {
    airHumidityCurrentValue.textContent = "--";
    airHumidityMinValue.textContent = "--";
    airHumidityMaxValue.textContent = "--";
    return;
  }

  const values = airHumidityHistory.map((item) => item.value);
  const current = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const suffix = airHumidityUnit ? ` ${airHumidityUnit}` : "";

  airHumidityCurrentValue.textContent = `${formatValue(current)}${suffix}`;
  airHumidityMinValue.textContent = `${formatValue(min)}${suffix}`;
  airHumidityMaxValue.textContent = `${formatValue(max)}${suffix}`;
}

function pushAirHumidityHistory(item) {
  if (!item) return;
  const num = toFiniteNumber(item.value);
  if (num === null) return;

  const ts = item?.timestamp ? new Date(item.timestamp).getTime() : Date.now();
  const timestamp = Number.isFinite(ts) ? ts : Date.now();

  const last = airHumidityHistory[airHumidityHistory.length - 1];
  if (last && Math.abs(last.ts - timestamp) < 300) {
    last.value = num;
  } else {
    airHumidityHistory.push({ ts: timestamp, value: num });
  }

  while (airHumidityHistory.length > SOIL_HISTORY_LIMIT) {
    airHumidityHistory.shift();
  }

  airHumidityUnit = item?.unit || airHumidityUnit || "";
  updateAirHumidityKpis();
  drawAirHumidityChart();
}

function renderThingModel(modelData) {
  thingModelProperties = Array.isArray(modelData?.properties) ? modelData.properties : [];
  thingModelCommands = Array.isArray(modelData?.commands) ? modelData.commands : [];
  if (modelPropertyList) modelPropertyList.innerHTML = "";
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
  renderQuickCommandOptions();
  fillDefaultCommandPayload();
  syncPayloadServiceId();
}

function renderPropertyState(data) {
  currentPropertyState = Array.isArray(data?.properties) ? data.properties : [];
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
  if (soilItem) pushSoilHistory(soilItem);

  const airTempItem = resolveAirTempItem(currentPropertyState);
  if (airTempItem) pushAirTempHistory(airTempItem);

  const airHumidityItem = resolveAirHumidityItem(currentPropertyState);
  if (airHumidityItem) pushAirHumidityHistory(airHumidityItem);
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

  if (targetStatusValue) {
    const targetStatus = String(data?.targetDevice?.status || "UNKNOWN").toUpperCase();
    targetStatusValue.textContent = targetStatus;
    targetStatusValue.classList.remove("status-online-text", "status-offline-text", "status-unknown-text");
    if (targetStatus === "ONLINE") {
      targetStatusValue.classList.add("status-online-text");
    } else if (targetStatus === "OFFLINE") {
      targetStatusValue.classList.add("status-offline-text");
    } else {
      targetStatusValue.classList.add("status-unknown-text");
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
  }

  if (data?.propertyState) {
    if (propertyStateMeta) {
      propertyStateMeta.textContent = shortSource(
        data.propertyState.source,
        data.propertyState.updatedAt,
        data.propertyState.lastError
      );
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

  const commandDefinition = getCommandDefinition(commandName);
  if (!commandDefinition) {
    pushLine(logList, `命令未同步: ${commandName}，请先同步模型`, "warn");
    return;
  }

  let payloadObj = {
    service_id: String(currentConfig?.serviceId || "Rets2").trim() || "Rets2",
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

  let normalizedParas = {};
  try {
    normalizedParas = collectCommandParams(commandDefinition);
  } catch (error) {
    pushLine(logList, error.message, "warn");
    return;
  }

  payloadObj.service_id = String(currentConfig?.serviceId || payloadObj.service_id || "Rets2").trim() || "Rets2";
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
  quickPropertyInput.addEventListener("change", () => {
    const commandName = String(quickPropertyInput.value || "").trim();
    renderCommandParamForm(commandName);
  });
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
  pushLine(logList, `已发布 ${event.topic} [${event.route || "huawei_create_command"}]`, "success", event.timestamp);
});

window.addEventListener("resize", () => {
  if (chartResizeTimer) clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    drawSoilChart();
    drawAirTempChart();
    drawAirHumidityChart();
  }, 120);
});

async function init() {
  try {
    setSoilEmptyVisible(true);
    setAirTempEmptyVisible(true);
    setAirHumidityEmptyVisible(true);
    drawSoilChart();
    drawAirTempChart();
    drawAirHumidityChart();
    updateSoilKpis();
    updateAirTempKpis();
    updateAirHumidityKpis();
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
