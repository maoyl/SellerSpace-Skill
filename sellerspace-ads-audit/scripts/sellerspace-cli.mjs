#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const skillDir = resolve(scriptDir, "..");
const contractPath = resolve(skillDir, "references", "contract.json");
const setupPagePath = resolve(skillDir, "assets", "configure.html");
const DEFAULT_API_BASE_URL = "https://www.sellerspace.com";
const PROFILE_PATH = "/api/mcp/analysis/profile";
const DEFAULT_SETUP_TTL_MS = 10 * 60 * 1000;
const LEGACY_CONFIG_DIR = resolve(homedir(), ".sellerspace-operator");
const ALLOWED_OPERATION_NAMES = [
  "get_stores",
  "query_ads",
  "query_store_performance",
  "get_metric_history",
];
const DIRECT_ENDPOINTS = [
  { operation: "get_stores", method: "GET", path: "/api/mcp/analysis/stores" },
  { operation: "query_store_performance", method: "GET", path: "/api/mcp/analysis/website" },
  { operation: "query_ads", entity: "campaign", method: "POST", path: "/api/mcp/analysis/cpc/campaigns/page" },
  { operation: "query_ads", entity: "adGroup", method: "POST", path: "/api/mcp/analysis/cpc/adGroups/page" },
  { operation: "query_ads", entity: "productAds", method: "POST", path: "/api/mcp/analysis/cpc/product_ads/page" },
  { operation: "query_ads", entity: "keywords", method: "POST", path: "/api/mcp/analysis/cpc/keywords/page" },
  { operation: "query_ads", entity: "targets", method: "POST", path: "/api/mcp/analysis/cpc/targets/page" },
  { operation: "query_ads", entity: "searchQuery", method: "POST", path: "/api/mcp/analysis/cpc/keywords_query/page" },
  { operation: "get_metric_history", entity: "time", method: "GET", path: "/api/mcp/analysis/cpc/common/metric/analysis" },
  { operation: "get_metric_history", entity: "placement", method: "GET", path: "/api/mcp/analysis/cpc/common/placement" },
  { operation: "get_metric_history", entity: "hourly", method: "GET", path: "/api/mcp/analysis/cpc/campaigns/analysis/hourly-stream" },
];
const ADS_ENTITY_CONFIG = {
  campaign: {
    path: "/api/mcp/analysis/cpc/campaigns/page",
    enabledFilters: { campaignStatus: "enabled" },
  },
  adGroup: {
    path: "/api/mcp/analysis/cpc/adGroups/page",
    enabledFilters: { campaignStatus: "enabled", adGroupStatus: "enabled" },
  },
  productAds: {
    path: "/api/mcp/analysis/cpc/product_ads/page",
    enabledFilters: {
      campaignStatus: "enabled",
      adGroupStatus: "enabled",
      status: "enabled",
    },
  },
  keywords: {
    path: "/api/mcp/analysis/cpc/keywords/page",
    enabledFilters: {
      campaignStatus: "enabled",
      adGroupStatus: "enabled",
      status: "enabled",
    },
  },
  targets: {
    path: "/api/mcp/analysis/cpc/targets/page",
    enabledFilters: {
      campaignStatus: "enabled",
      adGroupStatus: "enabled",
      status: "enabled",
    },
  },
  searchQuery: {
    path: "/api/mcp/analysis/cpc/keywords_query/page",
    enabledFilters: { campaignStatus: "enabled", adGroupStatus: "enabled" },
  },
};
const DATE_TYPES = new Set(["TD", "YD", "WD", "LW", "MO", "LM", "SD", "HD", "NM", "CU"]);
const STORE_SENSITIVE_FIELDS = new Set([
  "mwsAuthToken",
  "adAuthCode",
  "adAuthScope",
  "mailBoxList",
  "apiKey",
  "accessToken",
  "refreshToken",
  "authorization",
  "password",
  "secret",
]);

class CliFailure extends Error {
  constructor(payload, exitCode = 1) {
    super(payload?.error?.message || "CLI failure");
    this.payload = payload;
    this.exitCode = exitCode;
  }
}

let bundledContract;
try {
  bundledContract = JSON.parse(await readFile(contractPath, "utf8"));
  validateBundledContract(bundledContract);
} catch (error) {
  print({
    ok: false,
    ready: false,
    error: {
      code: "INVALID_BUNDLED_CONTRACT",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exit(2);
}

const configurationDirectory = resolveConfigurationDirectory();
const credentialsPath = resolve(configurationDirectory, "credentials.json");
const setupStatePath = resolve(configurationDirectory, "setup-session.json");
const setupAssetDefinitions = [
  ["/assets/sellerspace-logo.png", "sellerspace-logo.png", "image/png"],
  ["/assets/connection-hero.png", "connection-hero.png", "image/png"],
  ["/assets/check-circle.svg", "check-circle.svg", "image/svg+xml"],
].map(([path, file, contentType]) => ({
  path,
  file: resolve(skillDir, "assets", file),
  contentType,
}));

const command = process.argv[2] || "";
const commandArgs = process.argv.slice(3);

try {
  if (command === "__configure-server") {
    await serveConfigurationPage();
  } else if (command === "preflight") {
    await preflight();
  } else if (command === "doctor") {
    await preflight();
  } else if (command === "configure") {
    await configure();
  } else if (command === "contract") {
    print(readLocalContract());
  } else if (command === "call") {
    const operation = commandArgs[0];
    if (!operation) fail("USAGE_ERROR", "call 需要 operation 名。", 2);
    assertAllowedOperation(operation);
    const input = await readStdinJson();
    const credential = await requireCredential();
    print(await withCredentialRecovery(
      credential,
      (apiKey) => callOperation(operation, input, apiKey),
    ));
  } else if (command === "apply") {
    rejectReadOnlyOperation("apply_change_plan");
    fail("UNSUPPORTED_COMMAND", "当前 Skill 不支持 apply。", 2);
  } else {
    fail(
      "USAGE_ERROR",
      "可用命令：preflight | doctor | configure | contract | call <operation>",
      2,
    );
  }
} catch (error) {
  if (error instanceof CliFailure) {
    print(error.payload);
    process.exitCode = error.exitCode;
  } else {
    print({
      ok: false,
      ready: false,
      error: {
        code: "CLI_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    process.exitCode = 1;
  }
}

function validateBundledContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("contract.json 必须是 JSON 对象。");
  }
  for (const field of ["skill", "skillVersion", "accessMode", "transport", "baseUrl"]) {
    if (typeof contract[field] !== "string" || !contract[field].trim()) {
      throw new Error(`contract.json 缺少有效字段：${field}`);
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(contract.skillVersion)) {
    throw new Error("contract.json 的 skillVersion 必须是语义化版本。");
  }
  if (basename(skillDir) !== contract.skill) {
    throw new Error("contract.json 的 skill 必须与当前 Skill 目录一致。");
  }
  if (contract.minimumSkillVersion !== contract.skillVersion) {
    throw new Error("contract.json 的 Skill 版本字段不一致。");
  }
  if (contract.accessMode !== "read-only") {
    throw new Error("此运行时仅允许 read-only Skill 契约。");
  }
  if (contract.transport !== "direct-https") {
    throw new Error("此运行时仅允许 direct-https 契约。");
  }
  if (contract.baseUrl !== DEFAULT_API_BASE_URL) {
    throw new Error("contract.json 的 SellerSpace baseUrl 无效。");
  }
  if (!Array.isArray(contract.operations) || contract.operations.length === 0) {
    throw new Error("contract.json 必须声明至少一个 operation。");
  }
  const names = new Set();
  for (const operation of contract.operations) {
    if (!operation || typeof operation.name !== "string" || !operation.name) {
      throw new Error("contract.json 包含无效 operation。");
    }
    if (names.has(operation.name)) {
      throw new Error(`contract.json 包含重复 operation：${operation.name}`);
    }
    names.add(operation.name);
    if (contract.accessMode === "read-only") {
      if (operation.readOnly !== true || operation.destructive === true) {
        throw new Error(`只读契约包含非只读 operation：${operation.name}`);
      }
    }
  }
  if (JSON.stringify([...names]) !== JSON.stringify(ALLOWED_OPERATION_NAMES)) {
    throw new Error("contract.json 的只读 operation 集合无效。");
  }
  if (JSON.stringify(contract.endpoints) !== JSON.stringify(DIRECT_ENDPOINTS)) {
    throw new Error("contract.json 的实际接口白名单无效。");
  }
}

function resolveConfigurationDirectory() {
  const configured = process.env.SELLERSPACE_SKILL_CONFIG_DIR?.trim()
    || process.env.SELLERSPACE_OPERATOR_CONFIG_DIR?.trim();
  return resolve(configured || resolve(homedir(), ".sellerspace"));
}

async function preflight() {
  assertSupportedNodeVersion();
  const credential = await requireCredential();
  await withCredentialRecovery(credential, async (apiKey) => {
    await validateApiKey(apiKey);
  });
  print({
    ok: true,
    ready: true,
    skill: bundledContract.skill,
    skillVersion: bundledContract.skillVersion,
    accessMode: bundledContract.accessMode,
    transport: bundledContract.transport,
    apiReachable: true,
    apiKeyValid: true,
    requiredOperations: bundledContract.operations.map(({ name }) => name),
    endpointCount: bundledContract.endpoints.length,
    credentialSource: credential.source,
  });
}

function assertSupportedNodeVersion() {
  const required = bundledContract.minimumNodeVersion || "18.0.0";
  const current = process.versions.node;
  if (compareVersions(current, required) < 0) {
    fail(
      "UNSUPPORTED_NODE_VERSION",
      `需要 Node.js ${required} 或更高版本，当前为 ${current}。`,
      2,
    );
  }
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function readLocalContract() {
  return {
    ok: true,
    skill: bundledContract.skill,
    skillVersion: bundledContract.skillVersion,
    apiVersion: bundledContract.apiVersion,
    accessMode: bundledContract.accessMode,
    transport: bundledContract.transport,
    baseUrl: bundledContract.baseUrl,
    operations: bundledContract.operations.map((operation) => ({ ...operation })),
    endpoints: bundledContract.endpoints.map((endpoint) => ({ ...endpoint })),
  };
}

function assertAllowedOperation(operation) {
  const allowed = bundledContract.operations.some((item) => item.name === operation);
  if (allowed) return;
  if (bundledContract.accessMode === "read-only") {
    rejectReadOnlyOperation(operation);
  }
  fail("UNKNOWN_OPERATION", `Skill 包不包含 operation：${operation}`, 2);
}

function rejectReadOnlyOperation(operation) {
  fail(
    "READ_ONLY_SKILL",
    `当前 Skill 为只读模式，禁止执行 operation：${operation}`,
    2,
  );
}

async function configure() {
  if (commandArgs[0] === "status") {
    const credential = await readCredential();
    const state = await readLiveSetupState();
    print({
      ok: true,
      apiKeyConfigured: Boolean(credential),
      credentialSource: credential?.source ?? null,
      setup: state ? publicSetupState(state) : null,
    });
    return;
  }
  if (commandArgs.length > 0) {
    fail("USAGE_ERROR", "configure 仅支持无参数或 configure status。", 2);
  }
  const credential = await readCredential();
  if (credential) {
    print({
      ok: true,
      apiKeyConfigured: true,
      credentialSource: credential.source,
      message: "SellerSpace API Key 已配置。",
    });
    return;
  }
  print({
    ok: true,
    apiKeyConfigured: false,
    configurationRequired: true,
    setup: await ensureConfigurationServer(),
  });
}

async function callOperation(operation, input, apiKey) {
  const request = buildOperationRequest(operation, input);
  const response = await requestDirectApi(request, apiKey);
  return {
    ok: true,
    operation,
    transport: "direct-https",
    request: describeRequest(request),
    data: redactCredentials(response),
  };
}

function buildOperationRequest(operation, input) {
  assertPlainInput(input);
  switch (operation) {
    case "get_stores":
      return buildStoresRequest(input);
    case "query_ads":
      return buildAdsRequest(input);
    case "query_store_performance":
      return buildStorePerformanceRequest(input);
    case "get_metric_history":
      return buildMetricHistoryRequest(input);
    default:
      rejectReadOnlyOperation(operation);
  }
}

function buildStoresRequest(input) {
  assertAllowedKeys(input, [], "get_stores");
  return { method: "GET", path: "/api/mcp/analysis/stores", query: {} };
}

function buildStorePerformanceRequest(input) {
  assertAllowedKeys(input, [
    "storeShortNameAndMarketplaces",
    "dateType",
    "fromDateStr",
    "toDateStr",
    "currencyCode",
    "chainType",
    "dimension",
  ], "query_store_performance");
  const stations = readStringArray(
    input.storeShortNameAndMarketplaces,
    "storeShortNameAndMarketplaces",
    1,
    20,
  );
  const dateType = readEnum(input.dateType, "dateType", DATE_TYPES, "NM");
  const fromDateStr = readOptionalDate(input.fromDateStr, "fromDateStr");
  const toDateStr = readOptionalDate(input.toDateStr, "toDateStr");
  validateDateWindow(dateType, fromDateStr, toDateStr);
  const query = compactObject({
    storeShortNameAndMarketplaces: stations,
    dateType,
    fromDateStr,
    toDateStr,
    currencyCode: readOptionalString(input.currencyCode, "currencyCode", 3, 8),
    chainType: readEnum(
      input.chainType,
      "chainType",
      new Set(["HOURLY", "DAILY", "WEEKLY", "MONTHLY"]),
      "HOURLY",
    ),
    dimension: readEnum(
      input.dimension,
      "dimension",
      new Set(["market", "store"]),
      "market",
    ),
  });
  return { method: "GET", path: "/api/mcp/analysis/website", query };
}

function buildAdsRequest(input) {
  assertAllowedKeys(input, [
    "entity",
    "sellerId",
    "marketplace",
    "dateType",
    "fromDateStr",
    "toDateStr",
    "adType",
    "campaignId",
    "adGroupId",
    "page",
    "pageSize",
    "orderByField",
    "orderType",
  ], "query_ads");
  const entity = readEnum(
    input.entity,
    "entity",
    new Set(Object.keys(ADS_ENTITY_CONFIG)),
  );
  const config = ADS_ENTITY_CONFIG[entity];
  const dateType = readEnum(input.dateType, "dateType", DATE_TYPES, "NM");
  const fromDateStr = readOptionalDate(input.fromDateStr, "fromDateStr");
  const toDateStr = readOptionalDate(input.toDateStr, "toDateStr");
  validateDateWindow(dateType, fromDateStr, toDateStr);
  const body = compactObject({
    sellerId: readPositiveInteger(input.sellerId, "sellerId"),
    marketplace: readRequiredString(input.marketplace, "marketplace", 2, 16),
    dateType,
    fromDateStr,
    toDateStr,
    adType: readOptionalEnum(input.adType, "adType", new Set(["SP", "SB", "SD"])),
    campaignId: readOptionalString(input.campaignId, "campaignId", 1, 256),
    adGroupId: readOptionalString(input.adGroupId, "adGroupId", 1, 256),
    page: readInteger(input.page, "page", 1, 10_000, 1),
    pageSize: readInteger(input.pageSize, "pageSize", 1, 100, 100),
    orderByField: readEnum(
      input.orderByField,
      "orderByField",
      new Set([
        "cost",
        "impressions",
        "clicks",
        "cpcSales",
        "acos",
        "roas",
        "cpcOrder",
        "cpa",
        "cpc",
        "ctr",
        "cvr",
      ]),
      "cost",
    ),
    orderType: readInteger(input.orderType, "orderType", 1, 2, 2),
    ...(entity === "searchQuery" ? { searchKeywordsType: "query" } : {}),
    ...config.enabledFilters,
  });
  return { method: "POST", path: config.path, body };
}

function buildMetricHistoryRequest(input) {
  assertAllowedKeys(input, [
    "sellerId",
    "marketplace",
    "adDataType",
    "id",
    "dimension",
    "timeType",
    "placementBusiness",
    "dateType",
    "fromDateStr",
    "toDateStr",
  ], "get_metric_history");
  const sellerId = readPositiveInteger(input.sellerId, "sellerId");
  const marketplace = readRequiredString(input.marketplace, "marketplace", 2, 16);
  const adDataType = readEnum(
    input.adDataType,
    "adDataType",
    new Set(["campaign", "adGroup", "productAd", "keyword", "target", "searchTerm"]),
  );
  const id = readEntityId(input.id);
  const dimension = readEnum(
    input.dimension,
    "dimension",
    new Set(["time", "placement"]),
    "time",
  );
  const timeType = readEnum(
    input.timeType,
    "timeType",
    new Set(["DAILY", "WEEKLY", "WEEK", "MONTHLY", "HOURLY"]),
    "DAILY",
  );
  const fromDateStr = readRequiredDate(input.fromDateStr, "fromDateStr");
  const toDateStr = readRequiredDate(input.toDateStr, "toDateStr");
  validateDateWindow("CU", fromDateStr, toDateStr);

  if (dimension === "placement") {
    const idParameter = {
      campaign: "campaignId",
      productAd: "adId",
      keyword: "keywordId",
      target: "keywordId",
    }[adDataType];
    if (!idParameter) {
      fail(
        "INVALID_INPUT",
        "dimension=placement 仅支持 campaign/productAd/keyword/target。",
        2,
      );
    }
    return {
      method: "GET",
      path: "/api/mcp/analysis/cpc/common/placement",
      query: {
        sellerId,
        marketplace,
        placementBusiness: readEnum(
          input.placementBusiness,
          "placementBusiness",
          new Set(["Y", "N"]),
          "N",
        ),
        dateType: readEnum(input.dateType, "dateType", DATE_TYPES, "CU"),
        fromDateStr,
        toDateStr,
        [idParameter]: id,
      },
    };
  }

  if (timeType === "HOURLY") {
    const hourlyType = {
      campaign: "adCampaign",
      adGroup: "adGroup",
      productAd: "advertisement",
      keyword: "adKeyword",
      target: "adTargetType",
    }[adDataType];
    if (!hourlyType) {
      fail("INVALID_INPUT", "timeType=HOURLY 不支持 searchTerm。", 2);
    }
    return {
      method: "GET",
      path: "/api/mcp/analysis/cpc/campaigns/analysis/hourly-stream",
      query: {
        sellerId,
        marketplace,
        type: hourlyType,
        id,
        dateType: readEnum(input.dateType, "dateType", DATE_TYPES, "CU"),
        hourlySummary: "Y",
        fromDateStr,
        toDateStr,
      },
    };
  }

  return {
    method: "GET",
    path: "/api/mcp/analysis/cpc/common/metric/analysis",
    query: {
      sellerId,
      marketplace,
      adDataType,
      id,
      timeType,
      fromDateStr,
      toDateStr,
    },
  };
}

function assertPlainInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_JSON_INPUT", "stdin JSON 必须是对象。", 2);
  }
}

function assertAllowedKeys(input, allowedKeys, operation) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      fail(
        "UNSUPPORTED_INPUT_FIELD",
        `${operation} 不接受字段 ${key}；URL、HTTP 方法和状态过滤由只读客户端固定。`,
        2,
      );
    }
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
}

function readRequiredString(value, name, minimumLength, maximumLength) {
  if (typeof value !== "string") {
    fail("INVALID_INPUT", `${name} 必须是字符串。`, 2);
  }
  const normalized = value.trim();
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    fail("INVALID_INPUT", `${name} 长度必须在 ${minimumLength}-${maximumLength} 之间。`, 2);
  }
  return normalized;
}

function readOptionalString(value, name, minimumLength, maximumLength) {
  if (value === undefined) return undefined;
  return readRequiredString(value, name, minimumLength, maximumLength);
}

function readStringArray(value, name, minimumLength, maximumLength) {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
    fail("INVALID_INPUT", `${name} 必须包含 ${minimumLength}-${maximumLength} 个字符串。`, 2);
  }
  return value.map((item, index) => readRequiredString(item, `${name}[${index}]`, 3, 128));
}

function readPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_INPUT", `${name} 必须是正整数。`, 2);
  }
  return value;
}

function readInteger(value, name, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_INPUT", `${name} 必须是 ${minimum}-${maximum} 之间的整数。`, 2);
  }
  return value;
}

function readEnum(value, name, allowed, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !allowed.has(value)) {
    fail("INVALID_INPUT", `${name} 取值无效。`, 2);
  }
  return value;
}

function readOptionalEnum(value, name, allowed) {
  return value === undefined ? undefined : readEnum(value, name, allowed);
}

function readRequiredDate(value, name) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail("INVALID_INPUT", `${name} 必须是 yyyy-MM-dd。`, 2);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail("INVALID_INPUT", `${name} 不是有效日期。`, 2);
  }
  return value;
}

function readOptionalDate(value, name) {
  return value === undefined ? undefined : readRequiredDate(value, name);
}

function validateDateWindow(dateType, fromDateStr, toDateStr) {
  if (dateType === "CU" && (!fromDateStr || !toDateStr)) {
    fail("INVALID_INPUT", "dateType=CU 时必须同时提供 fromDateStr 和 toDateStr。", 2);
  }
  if ((fromDateStr && !toDateStr) || (!fromDateStr && toDateStr)) {
    fail("INVALID_INPUT", "fromDateStr 和 toDateStr 必须同时提供。", 2);
  }
  if (fromDateStr && toDateStr && fromDateStr > toDateStr) {
    fail("INVALID_INPUT", "fromDateStr 不能晚于 toDateStr。", 2);
  }
}

function readEntityId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  fail("INVALID_INPUT", "id 必须是非空字符串或安全整数；长 ID 请使用字符串。", 2);
}

async function requestDirectApi(request, apiKey) {
  const apiUrl = buildApiUrl(request.path, request.query);
  const controller = new AbortController();
  const timeoutMs = readTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(apiUrl, {
      method: request.method,
      headers: {
        "Accept": "application/json",
        ...(request.method === "POST" ? { "Content-Type": "application/json" } : {}),
        "X-API-Key": apiKey,
        "User-Agent": `${bundledContract.skill}/${bundledContract.skillVersion}`,
      },
      ...(request.method === "POST" ? { body: JSON.stringify(request.body ?? {}) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail("REQUEST_TIMEOUT", `SellerSpace 请求超过 ${timeoutMs}ms。`, 1);
    }
    fail("NETWORK_ERROR", "无法连接 SellerSpace 数据接口。", 1);
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let payload;
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    fail("INVALID_RESPONSE", `SellerSpace 数据接口返回非 JSON（HTTP ${response.status}）。`, 1);
  }
  if (!response.ok || payload?.success === false) {
    const authenticationFailure = response.status === 401
      || response.status === 403
      || isAuthenticationPayload(payload);
    const rateLimited = response.status === 429;
    const retryAfterMs = readRetryAfterMs(response, payload);
    throw new CliFailure({
      ok: false,
      ready: false,
      error: {
        code: authenticationFailure
          ? "AUTHENTICATION_REQUIRED"
          : rateLimited
            ? "RATE_LIMITED"
            : "API_ERROR",
        message: readApiErrorMessage(payload) || `HTTP ${response.status}`,
      },
      ...(retryAfterMs ? { meta: { retryAfterMs } } : {}),
    }, authenticationFailure ? 3 : 1);
  }
  return payload;
}

function readApiErrorMessage(payload) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.errorCode === "string") return payload.errorCode;
  return "";
}

function isAuthenticationPayload(payload) {
  const code = String(payload?.errorCode ?? payload?.error?.code ?? "");
  return code === "MCP.Auth.Invalid"
    || code === "MCP_AUTH_INVALID"
    || code === "AUTHENTICATION_REQUIRED";
}

function readRetryAfterMs(response, payload) {
  if (Number.isFinite(payload?.retryAfterMs) && payload.retryAfterMs > 0) {
    return Math.floor(payload.retryAfterMs);
  }
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : undefined;
}

function buildApiUrl(path, query = {}) {
  const baseUrl = normalizeApiBaseUrl(
    process.env.SELLERSPACE_API_BASE_URL?.trim()
      || bundledContract.baseUrl
      || DEFAULT_API_BASE_URL,
  );
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null && item !== "") {
        url.searchParams.append(key, String(item));
      }
    }
  }
  return url;
}

function describeRequest(request) {
  return {
    method: request.method,
    path: request.path,
    ...(request.query ? { query: request.query } : {}),
    ...(request.body ? { body: request.body } : {}),
  };
}

function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== "object") return value;
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    const exactMatch = [...STORE_SENSITIVE_FIELDS]
      .some((sensitive) => sensitive.toLowerCase() === key.toLowerCase());
    if (exactMatch || /(?:token|password|secret|authorization)$/i.test(key)) continue;
    redacted[key] = redactCredentials(item);
  }
  return redacted;
}

async function validateApiKey(apiKey) {
  const payload = await requestDirectApi({ method: "GET", path: PROFILE_PATH, query: {} }, apiKey);
  const profile = payload?.data && typeof payload.data === "object"
    ? payload.data
    : payload;
  const accountId = profile?.rawUserId ?? profile?.userId;
  if (accountId === undefined || accountId === null || accountId === "") {
    fail("INVALID_RESPONSE", "SellerSpace 账号验证响应缺少用户标识。", 1);
  }
}

async function readCredential() {
  const selected = await readCredentialFile(credentialsPath, "local");
  if (selected) return selected;

  const defaultConfigurationDirectory = resolve(homedir(), ".sellerspace");
  if (
    configurationDirectory === defaultConfigurationDirectory
    && LEGACY_CONFIG_DIR !== configurationDirectory
  ) {
    const legacy = await readCredentialFile(
      resolve(LEGACY_CONFIG_DIR, "credentials.json"),
      "legacy-local-read-only",
    );
    if (legacy) return legacy;
  }

  const environmentKey = process.env.SELLERSPACE_API_KEY?.trim();
  return environmentKey
    ? { apiKey: environmentKey, source: "environment" }
    : null;
}

async function readCredentialFile(path, source) {
  try {
    const stored = JSON.parse(await readFile(path, "utf8"));
    const apiKey = typeof stored.apiKey === "string" ? stored.apiKey.trim() : "";
    return apiKey ? { apiKey, source } : null;
  } catch {
    return null;
  }
}

async function requireCredential() {
  const credential = await readCredential();
  if (credential) return credential;
  const setup = await ensureConfigurationServer();
  throw new CliFailure({
    ok: false,
    ready: false,
    configurationRequired: true,
    setup,
    error: {
      code: "CONFIGURATION_REQUIRED",
      message: "请打开 setup.url，在本机配置 SellerSpace API Key 后重试。",
    },
  }, 2);
}

async function withCredentialRecovery(credential, callback) {
  try {
    return await callback(credential.apiKey);
  } catch (error) {
    if (!isAuthenticationFailure(error)) throw error;
    if (credential.source === "local") await rm(credentialsPath, { force: true });
    const setup = await ensureConfigurationServer();
    throw new CliFailure({
      ok: false,
      ready: false,
      apiKeyConfigured: false,
      credentialSource: credential.source,
      credentialExpired: true,
      configurationRequired: true,
      setup,
      error: {
        code: "CONFIGURATION_REQUIRED",
        message: "SellerSpace API Key 无效或已失效，请打开 setup.url 重新配置。",
      },
    }, 2);
  }
}

function isAuthenticationFailure(error) {
  if (!(error instanceof CliFailure)) return false;
  if (error.exitCode === 3) return true;
  const code = String(error.payload?.error?.code ?? error.payload?.errorCode ?? "");
  return code === "AUTHENTICATION_REQUIRED"
    || code === "MCP.Auth.Invalid"
    || code === "MCP_AUTH_INVALID";
}

async function writeCredential(apiKey) {
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await chmod(configurationDirectory, 0o700).catch(() => {});
  const temporaryPath = `${credentialsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    version: 1,
    apiKey,
    updatedAt: new Date().toISOString(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600).catch(() => {});
  await rename(temporaryPath, credentialsPath);
  await chmod(credentialsPath, 0o600).catch(() => {});
}

async function ensureConfigurationServer() {
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await chmod(configurationDirectory, 0o700).catch(() => {});
  const existing = await readLiveSetupState();
  if (existing) return publicSetupState(existing);
  await rm(setupStatePath, { force: true });

  const startedAt = Date.now();
  const childEnvironment = { ...process.env };
  delete childEnvironment.SELLERSPACE_API_KEY;
  const child = spawn(process.execPath, [scriptPath, "__configure-server"], {
    detached: true,
    env: childEnvironment,
    stdio: "ignore",
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(50);
    const state = await readSetupState();
    if (state && state.startedAt >= startedAt && state.expiresAt > Date.now()
      && await isSetupServerAlive(state)) {
      return publicSetupState(state);
    }
  }
  fail("LOCAL_CONFIGURATION_FAILED", "无法启动 SellerSpace 本地配置页面。", 1);
}

async function serveConfigurationPage() {
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await chmod(configurationDirectory, 0o700).catch(() => {});
  const html = await readFile(setupPagePath, "utf8");
  const setupAssets = new Map(await Promise.all(
    setupAssetDefinitions.map(async (asset) => [
      asset.path,
      { body: await readFile(asset.file), contentType: asset.contentType },
    ]),
  ));
  const token = randomBytes(24).toString("hex");
  const setupPath = `/setup/${token}`;
  const ttlMs = readSetupTtlMs();
  let expectedHost = "";
  let closeTimer;

  const server = createServer((request, response) => {
    void handleConfigurationRequest({
      request,
      response,
      server,
      html,
      setupAssets,
      setupPath,
      expectedHost,
    }).catch(() => sendJsonResponse(response, 500, {
      ok: false,
      message: "本地配置服务发生错误，请重新打开配置页面。",
    }));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local configuration server did not expose a TCP port");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const startedAt = Date.now();
  const state = {
    version: 1,
    skill: bundledContract.skill,
    skillVersion: bundledContract.skillVersion,
    pid: process.pid,
    startedAt,
    expiresAt: startedAt + ttlMs,
    url: `http://${expectedHost}${setupPath}`,
    statusUrl: `http://${expectedHost}${setupPath}/status`,
  };
  await writePrivateJson(setupStatePath, state);

  const closeServer = () => {
    if (closeTimer) clearTimeout(closeTimer);
    server.close();
  };
  closeTimer = setTimeout(closeServer, ttlMs);
  closeTimer.unref();
  server.once("close", () => void removeSetupStateForCurrentProcess());
  process.once("SIGTERM", closeServer);
  process.once("SIGINT", closeServer);
  await new Promise((resolveClose) => server.once("close", resolveClose));
}

async function handleConfigurationRequest({
  request,
  response,
  server,
  html,
  setupAssets,
  setupPath,
  expectedHost,
}) {
  if (request.headers.host !== expectedHost) {
    sendJsonResponse(response, 403, { ok: false, message: "请求来源无效。" });
    return;
  }
  const requestUrl = new URL(request.url || "/", `http://${expectedHost}`);
  const setupAsset = setupAssets.get(requestUrl.pathname);
  if (request.method === "GET" && setupAsset) {
    sendAssetResponse(response, setupAsset);
    return;
  }
  if (request.method === "GET"
    && (requestUrl.pathname === setupPath || requestUrl.pathname === `${setupPath}/`)) {
    sendHtmlResponse(response, html);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === `${setupPath}/status`) {
    sendJsonResponse(response, 200, {
      ok: true,
      apiKeyConfigured: Boolean(await readCredential()),
    });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === `${setupPath}/save`) {
    if (String(request.headers.origin || "") !== `http://${expectedHost}`) {
      sendJsonResponse(response, 403, { ok: false, message: "请求来源无效。" });
      return;
    }
    const input = await readRequestJson(request, 16 * 1024);
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey || apiKey.length > 4096) {
      sendJsonResponse(response, 400, { ok: false, message: "请输入有效的 API Key。" });
      return;
    }
    try {
      await validateApiKey(apiKey);
    } catch (error) {
      const authenticationFailure = error instanceof CliFailure && error.exitCode === 3;
      sendJsonResponse(response, authenticationFailure ? 401 : 502, {
        ok: false,
        message: authenticationFailure
          ? "API Key 无效或已失效，请检查后重试。"
          : "暂时无法验证 API Key，请检查网络后重试。",
      });
      return;
    }
    await writeCredential(apiKey);
    sendJsonResponse(response, 200, {
      ok: true,
      message: "SellerSpace 已连接，可以返回 AI 助手继续使用。",
    });
    setTimeout(() => server.close(), 1500).unref();
    return;
  }
  sendJsonResponse(response, 404, { ok: false, message: "页面不存在。" });
}

async function readRequestJson(request, limit) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > limit) {
      throw new Error("Request body is too large");
    }
  }
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

async function readLiveSetupState() {
  const state = await readSetupState();
  if (!state || state.expiresAt <= Date.now()) return null;
  return await isSetupServerAlive(state) ? state : null;
}

async function readSetupState() {
  try {
    const state = JSON.parse(await readFile(setupStatePath, "utf8"));
    if (typeof state.startedAt !== "number" || typeof state.expiresAt !== "number"
      || typeof state.url !== "string" || typeof state.statusUrl !== "string"
      || state.skill !== bundledContract.skill
      || state.skillVersion !== bundledContract.skillVersion) {
      return null;
    }
    const url = new URL(state.url);
    const statusUrl = new URL(state.statusUrl);
    if (url.protocol !== "http:" || statusUrl.protocol !== "http:"
      || url.hostname !== "127.0.0.1" || statusUrl.hostname !== "127.0.0.1") {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function isSetupServerAlive(state) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300);
  try {
    const response = await fetch(state.statusUrl, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function publicSetupState(state) {
  return {
    action: "OPEN_LOCAL_CONFIGURATION",
    display: "local-browser-or-preview",
    localOnly: true,
    url: state.url,
    expiresAt: new Date(state.expiresAt).toISOString(),
  };
}

async function removeSetupStateForCurrentProcess() {
  const state = await readSetupState();
  if (state?.pid === process.pid) await rm(setupStatePath, { force: true });
}

async function writePrivateJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600).catch(() => {});
  await rename(temporaryPath, path);
  await chmod(path, 0o600).catch(() => {});
}

function sendHtmlResponse(response, html) {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; "
      + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

function sendAssetResponse(response, asset) {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": asset.contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(asset.body);
}

function sendJsonResponse(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("INVALID_JSON_INPUT", "stdin JSON 必须是对象。", 2);
    }
    return parsed;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    fail("INVALID_JSON_INPUT", "stdin 不是有效 JSON。", 2);
  }
}

function normalizeApiBaseUrl(value) {
  const url = normalizeHttpsUrl(value, "SELLERSPACE_API_BASE_URL");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  const isTestLocalhost = process.env.NODE_ENV === "test"
    && process.env.SELLERSPACE_ALLOW_INSECURE_LOCALHOST === "1"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.origin !== new URL(DEFAULT_API_BASE_URL).origin && !isTestLocalhost) {
    fail("INVALID_BASE_URL", "SELLERSPACE_API_BASE_URL 必须是官方 SellerSpace API。", 2);
  }
  return url.origin;
}

function normalizeHttpsUrl(value, settingName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_BASE_URL", `${settingName} 不是有效 URL。`, 2);
  }
  const insecureLocalhost = process.env.NODE_ENV === "test"
    && process.env.SELLERSPACE_ALLOW_INSECURE_LOCALHOST === "1"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !insecureLocalhost) {
    fail("INVALID_BASE_URL", `${settingName} 必须使用 HTTPS。`, 2);
  }
  return url;
}

function readTimeoutMs() {
  const value = Number(process.env.SELLERSPACE_SKILL_TIMEOUT_MS || 60_000);
  return Number.isFinite(value) && value >= 1_000 && value <= 180_000
    ? value
    : 60_000;
}

function readSetupTtlMs() {
  const value = Number(process.env.SELLERSPACE_SETUP_TTL_MS || DEFAULT_SETUP_TTL_MS);
  return Number.isFinite(value) && value >= 5_000 && value <= 30 * 60 * 1000
    ? value
    : DEFAULT_SETUP_TTL_MS;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function fail(code, message, exitCode) {
  throw new CliFailure({
    ok: false,
    ready: false,
    error: { code, message },
  }, exitCode);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
