#!/usr/bin/env node
// 宿主负责真实 MCP 调用；本脚本只校验返回值、计划下一批只读请求和计算报告。
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileAuditAnalysis, normalizeTargetAcos, planAuditDrilldowns } from "./sellerspace-audit-engine.mjs";

export const REQUIRED_OPERATIONS = ["get_stores", "query_ads", "query_store_performance", "get_metric_history"];
export const ENTITIES = ["campaign", "adGroup", "productAds", "keywords", "targets", "searchQuery"];
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const TIMEZONES = {
  US: "America/Los_Angeles", CA: "America/Vancouver", MX: "America/Mexico_City",
  BR: "America/Sao_Paulo", UK: "Europe/London", GB: "Europe/London",
  DE: "Europe/Berlin", FR: "Europe/Paris", IT: "Europe/Rome", ES: "Europe/Madrid",
  NL: "Europe/Amsterdam", SE: "Europe/Stockholm", PL: "Europe/Warsaw",
  BE: "Europe/Brussels", IE: "Europe/Dublin", TR: "Europe/Istanbul", JP: "Asia/Tokyo",
  IN: "Asia/Kolkata", AU: "Australia/Sydney", SG: "Asia/Singapore",
  AE: "Asia/Dubai", SA: "Asia/Riyadh", EG: "Africa/Cairo",
};

class AuditError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new AuditError(code, message); }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT", label + " 必须是对象。");
  return value;
}
function numberOrNull(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 只接受宿主的结构化结果或 MCP 文本内容；不递归猜测业务对象。
export function readMcpResult(result) {
  object(result, "MCP 结果");
  if (result.isError === true) fail("MCP_QUERY_FAILED", "MCP 调用失败；请检查连接、权限或限流提示，当前体检已停止。");
  let payload = result.structuredContent;
  if (payload === undefined && Array.isArray(result.content)) {
    const texts = result.content.filter((item) => item.type === "text");
    if (texts.length !== 1) fail("INVALID_MCP_RESULT", "MCP 结果没有唯一的 JSON 文本内容。");
    try { payload = JSON.parse(texts[0].text); }
    catch { fail("INVALID_MCP_RESULT", "MCP 返回了非 JSON 内容。"); }
  }
  if (payload === undefined) payload = result;
  object(payload, "MCP 数据");
  if (payload.success === false || payload.ok === false || payload.error) {
    fail("MCP_QUERY_FAILED", "优麦云查询失败，不能继续生成体检报告。");
  }
  if (payload.data?.success === false || payload.data?.ok === false || payload.data?.error) {
    fail("MCP_QUERY_FAILED", "优麦云业务接口返回失败，不能使用部分结果。");
  }
  return payload;
}

export function validateMcpTools(tools) {
  if (!tools || typeof tools !== "object") fail("MCP_DEPENDENCY_MISSING", "未发现可用的优麦云 MCP，请先在当前宿主安装或启用后重新运行。");
  for (const operation of REQUIRED_OPERATIONS) {
    if (typeof tools[operation] !== "string" || !tools[operation].trim()) {
      fail("MCP_DEPENDENCY_MISSING", "缺少优麦云 MCP 能力：" + operation + "。体检未执行。");
    }
  }
  if (new Set(REQUIRED_OPERATIONS.map((operation) => tools[operation])).size !== REQUIRED_OPERATIONS.length) {
    fail("INVALID_MCP_BINDINGS", "不同查询能力必须映射到各自实际可调用的 MCP 工具。");
  }
  // 工具名由宿主发现；不对服务名、命名空间、中文名或英文前缀做匹配。
  return tools;
}

function stationFromStores(storesResult, scope) {
  const result = readMcpResult(storesResult);
  if (!Array.isArray(result.data)) fail("INVALID_STORES_RESULT", "店铺结果缺少 data 数组。");
  if (!Number.isSafeInteger(scope.sellerId) || scope.sellerId <= 0 || typeof scope.marketplace !== "string") {
    fail("STATION_REQUIRED", "请选择一个确切的店铺和站点。");
  }
  const matches = result.data.flatMap((store) => {
    if (String(store.sellerId) !== String(scope.sellerId)) return [];
    const markets = store.authMarkets ?? store.authMarketDtos;
    if (!Array.isArray(markets)) return [];
    return markets.filter((market) => market.marketplace === scope.marketplace)
      .map((market) => ({
        sellerId: scope.sellerId,
        marketplace: market.marketplace,
        station: String(scope.sellerId) + "-" + market.marketplace,
        storeName: store.storeName ?? store.storeShortName ?? null,
        timezone: market.timezone || TIMEZONES[market.marketplace],
      }));
  });
  if (matches.length !== 1) fail("STATION_REQUIRED", "所选站点没有唯一匹配本次 MCP 返回的店铺列表。");
  return matches[0];
}

function dateString(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value + "T00:00:00Z"))
    || new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value) {
    fail("INVALID_PERIOD", label + " 必须是有效的 yyyy-MM-dd 日期。");
  }
  return value;
}
function addDays(day, count) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function resolvePeriod(input, station) {
  const request = input.period ?? {};
  const dateType = request.dateType ?? "NM";
  const startedAt = new Date(input.startedAt);
  if (!input.startedAt || !Number.isFinite(startedAt.getTime())) fail("INVALID_PERIOD", "startedAt 必须记录本次体检开始时间，后续批次保持不变。");
  const timezone = station.timezone;
  let parts;
  try {
    if (!timezone) throw new Error();
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(startedAt);
  } catch { fail("TIMEZONE_REQUIRED", "无法确定所选站点时区，请先补齐店铺站点信息。"); }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = values.year + "-" + values.month + "-" + values.day;
  let from = today;
  let to = today;
  const weekStart = addDays(today, 1 - (new Date(today + "T00:00:00Z").getUTCDay() || 7));
  const labels = { TD: "今天", YD: "昨天", WD: "本周", LW: "上周", MO: "本月", LM: "上月", SD: "近 7 天", HD: "近 15 天", NM: "近 30 天" };
  switch (dateType) {
    case "CU": from = dateString(request.from, "起始日期"); to = dateString(request.to, "结束日期"); break;
    case "TD": break;
    case "YD": from = to = addDays(today, -1); break;
    case "WD": from = weekStart; break;
    case "LW": to = addDays(weekStart, -1); from = addDays(to, -6); break;
    case "MO": from = today.slice(0, 8) + "01"; break;
    case "LM": to = addDays(today.slice(0, 8) + "01", -1); from = to.slice(0, 8) + "01"; break;
    case "SD": from = addDays(today, -6); break;
    case "HD": from = addDays(today, -14); break;
    case "NM": from = addDays(today, -29); break;
    default: fail("INVALID_PERIOD", "不支持的日期范围。");
  }
  if (from > to) fail("INVALID_PERIOD", "起始日期不能晚于结束日期。");
  return { dateType, from, to, timezone, label: labels[dateType] ?? from + " 至 " + to };
}

function emptyCollection() {
  return { summary: null, rows: [], coverage: { fetchedCount: 0, totalCount: 0, spendCoverage: null, status: "not-applicable", fetchedPages: 0 } };
}
function stable(value) {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

// 每轮重新验证完整调用记录，返回下一批请求；没有网络、凭据或后台服务。
export function nextAuditStep(input) {
  object(input, "体检输入");
  const tools = validateMcpTools(input.mcpTools);
  if (input.schemaVersion !== 1) fail("INVALID_INPUT", "仅支持 schemaVersion=1。");
  const scope = stationFromStores(input.storesResult, object(input.scope, "scope"));
  scope.adType = input.adType ?? "all";
  normalizeTargetAcos(input.targetAcos);
  const period = resolvePeriod(input, scope);
  if (input.adType !== undefined && !["SP", "SB", "SD"].includes(input.adType)) fail("INVALID_INPUT", "adType 仅支持 SP、SB、SD，省略表示全部。");
  if (!Array.isArray(input.responses)) fail("INVALID_INPUT", "responses 必须是本次 MCP 调用记录数组。");
  const records = new Map();
  for (const response of input.responses) {
    object(response, "调用记录");
    if (typeof response.requestId !== "string" || records.has(response.requestId)) fail("INVALID_INPUT", "调用记录缺少 requestId 或有重复结果。");
    readMcpResult(response.result);
    records.set(response.requestId, response);
  }
  const requested = new Set();
  const pending = [];
  const take = (requestId, operation, args) => {
    requested.add(requestId);
    const request = { requestId, tool: tools[operation], arguments: args };
    const record = records.get(requestId);
    if (!record) { pending.push(request); return null; }
    if (record.tool !== request.tool || stable(record.arguments) !== stable(args)) {
      fail("REQUEST_MISMATCH", "MCP 调用记录与当前站点、日期或查询计划不一致：" + requestId);
    }
    return readMcpResult(record.result);
  };
  const finishStage = () => {
    for (const id of records.keys()) {
      if (!requested.has(id)) fail("UNEXPECTED_RESPONSE", "存在未计划或来自其他体检的调用记录：" + id);
    }
    return { ok: true, complete: false, scope, period, requests: pending };
  };
  const common = {
    sellerId: scope.sellerId, marketplace: scope.marketplace,
    // 固定站点日历窗口，避免跨午夜或分批调用导致口径漂移。
    dateType: "CU", fromDateStr: period.from, toDateStr: period.to,
    ...(input.adType ? { adType: input.adType } : {}),
    campaignStatus: "enabled", pageSize: 100,
  };
  const collect = (entity) => {
    const rows = [];
    const seen = new Set();
    let summary = null;
    let totalCount;
    let fetchedCost = 0;
    let page = 1;
    while (true) {
      const params = {
        ...common, page,
        ...(entity === "adGroup" ? { orderByField: "cost", orderType: 2 } : { orderField: "cost", orderFlag: 2 }),
        ...(entity !== "campaign" ? { adGroupStatus: "enabled" } : {}),
        ...(["productAds", "keywords", "targets"].includes(entity) ? { status: "enabled" } : {}),
        ...(entity === "searchQuery" ? { searchKeywordsType: "query" } : {}),
      };
      const result = take("ads:" + entity + ":" + page, "query_ads", { entity, params });
      if (!result) return null;
      if (result.tool !== "query_ads" || result.entity !== entity) fail("INVALID_MCP_RESULT", "广告 MCP 结果实体与请求不符。");
      const data = object(result.data?.data, "广告结果 data.data");
      const pagination = object(data.list, "广告结果 data.data.list");
      if (!Array.isArray(pagination.items) || pagination.items.length > 100
        || !Number.isSafeInteger(pagination.totalCount) || pagination.totalCount < 0
        || !Number.isSafeInteger(pagination.pageCount) || pagination.pageCount < 0
        || pagination.currentPage !== page || page > Math.max(1, pagination.pageCount)) {
        fail("INVALID_PAGINATION", "广告结果分页结构无效或页码未前进。");
      }
      if (totalCount !== undefined && totalCount !== pagination.totalCount) fail("UNSTABLE_PAGINATION", "分页期间总行数发生变化，请重新获取本次数据。");
      totalCount = pagination.totalCount;
      if (page === 1) summary = data.summary ?? null;
      let addedCost = 0;
      let addedRows = 0;
      for (const raw of pagination.items) {
        validateRowScope(raw, scope, entity, input.adType);
        const row = normalizeAdsRow(entity, raw);
        // 复合搜索词标识可能跨位置重复；去重必须保留活动与广告组范围。
        const key = stable([row.canonical.campaignId, row.canonical.adGroupId, row.canonical.entityId ?? raw.queryTextId ?? row.canonical.entityName]);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
        addedRows += 1;
        const cost = numberOrNull(row.cost);
        if (cost !== null && cost > 0) addedCost += cost;
      }
      fetchedCost += addedCost;
      const summaryCost = numberOrNull(summary?.cost);
      const coverage = summaryCost !== null && summaryCost > 0 ? Math.min(1, fetchedCost / summaryCost) : null;
      const finalPage = page >= pagination.pageCount;
      let status;
      if (finalPage) {
        if (rows.length !== totalCount) fail("INCOMPLETE_PAGINATION", "末页去重后的行数与总行数不一致，不能声称完整覆盖。");
        status = "complete";
      } else if (entity !== "campaign" && coverage !== null && coverage >= 0.9) status = "target-reached";
      else if (addedRows === 0) {
        fail("INCOMPLETE_PAGINATION", "分页没有取得新数据，已停止体检。");
      }
      if (status) return { summary, rows, coverage: { fetchedCount: rows.length, totalCount, spendCoverage: coverage, status, fetchedPages: page } };
      page += 1;
    }
  };
  const collections = Object.fromEntries(ENTITIES.map((entity) => [entity, emptyCollection()]));
  collections.campaign = collect("campaign");
  if (!collections.campaign) return finishStage();
  let storePerformance = {};
  const campaignHistories = {};
  const campaignPlacements = {};
  const productHistories = {};
  let drilldowns = { campaignHistory: [], campaignPlacement: [], productHistory: [] };
  if (collections.campaign.rows.length > 0) {
    const storeResult = take("store-performance", "query_store_performance", {
      scope: { stations: [scope.station] },
      period: { preset: "CU", from: period.from, to: period.to },
      view: { dimension: "market", chainType: "DAILY" },
    });
    if (storeResult) {
      if (storeResult.tool !== "query_store_performance") fail("INVALID_MCP_RESULT", "站点表现 MCP 结果类型不符。");
      const data = object(storeResult.data?.data, "站点表现 data.data");
      storePerformance = { summary: object(data.summary, "站点表现 summary") };
    }
    for (const entity of ENTITIES.slice(1)) collections[entity] = collect(entity);
    if (pending.length) return finishStage();
    const campaignIds = new Set(collections.campaign.rows.map((row) => row.canonical.entityId));
    for (const entity of ENTITIES.slice(1)) {
      for (const row of collections[entity].rows) {
        if (row.canonical.campaignId && !campaignIds.has(row.canonical.campaignId)) {
          fail("SCOPE_MISMATCH", "子实体属于本次启用活动范围之外，不能混用数据。");
        }
      }
    }
    drilldowns = planAuditDrilldowns({ collections, storePerformance, targetAcos: input.targetAcos });
    const history = (entity, id, dimension, output) => {
      const requestId = "history:" + entity + ":" + id + ":" + dimension;
      const result = take(requestId, "get_metric_history", {
        sellerId: scope.sellerId, marketplace: scope.marketplace,
        adDataType: entity, id, dimension, timeType: "DAILY",
        dateType: "CU", fromDateStr: period.from, toDateStr: period.to,
        ...(dimension === "time" && entity === "campaign"
          ? { includeFields: ["overBudgetTime", "overBudgetTimeMinute", "campaignBudget"] } : {}),
      });
      if (!result) return;
      const list = result.data?.list;
      if (!Array.isArray(list)) fail("INVALID_MCP_RESULT", "指标历史结果缺少 data.list 数组。");
      if (dimension === "time") {
        const days = new Set();
        for (const row of list) {
          const day = dateString(row.datePoint, "历史日期");
          if (day < period.from || day > period.to || days.has(day)) fail("INVALID_HISTORY", "历史日期超出窗口或存在重复日。");
          days.add(day);
        }
        output[id] = [...list].sort((a, b) => a.datePoint.localeCompare(b.datePoint));
      } else output[id] = list;
    };
    for (const item of drilldowns.campaignHistory) history("campaign", item.id, "time", campaignHistories);
    for (const item of drilldowns.campaignPlacement) history("campaign", item.id, "placement", campaignPlacements);
    for (const item of drilldowns.productHistory) history("productAd", item.id, "time", productHistories);
  }
  if (pending.length) return finishStage();
  finishStage();
  const report = compileAuditAnalysis({
    scope, period, targetAcos: input.targetAcos, storePerformance, collections,
    campaignHistories, campaignPlacements, productHistories,
    drilldownPlan: drilldowns.campaignHistory, businessCallCount: input.responses.length + 1,
  });
  // 经营概览包含全部广告状态；当前启用广告的汇总另列，不能混称同一口径。
  report.enabledAdsSummary = collections.campaign.summary;
  report.auditMeta.dataSource = "宿主调用的优麦云 MCP";
  report.auditMeta.startedAt = input.startedAt;
  return { ...report, complete: true };
}

function validateRowScope(row, scope, entity, adType) {
  object(row, "广告行");
  if ((row.sellerId != null && String(row.sellerId) !== String(scope.sellerId))
    || (row.marketplace != null && row.marketplace !== scope.marketplace)
    || (adType && row.adType != null && row.adType !== adType)) fail("SCOPE_MISMATCH", "广告行的店铺、站点或广告类型与本次范围不一致。");
  for (const field of ["campaignStatus", ...(entity !== "campaign" ? ["adGroupStatus"] : []),
    ...(["productAds", "keywords", "targets"].includes(entity) ? ["status"] : [])]) {
    if (row[field] != null && row[field] !== "enabled") fail("SCOPE_MISMATCH", "广告结果包含非启用状态的数据。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== "audit" || process.argv.length > 4) fail("USAGE_ERROR", "用法：node sellerspace-cli.mjs audit [本次MCP数据.json]；省略文件时从 stdin 读取。");
    let raw = "";
    if (process.argv[3]) raw = await readFile(resolve(process.argv[3]), "utf8");
    else {
      for await (const chunk of process.stdin) {
        raw += chunk;
        if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) fail("INPUT_TOO_LARGE", "本次数据超过 64 MiB，请缩小明确的审计范围。");
      }
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) fail("INPUT_TOO_LARGE", "本次数据超过 64 MiB，请缩小明确的审计范围。");
    let input;
    try { input = JSON.parse(raw); } catch { fail("INVALID_INPUT", "体检输入不是有效的 JSON。"); }
    process.stdout.write(JSON.stringify(nextAuditStep(input)) + "\n");
  } catch (error) {
    const code = error instanceof AuditError ? error.code : "AUDIT_FAILED";
    const message = error instanceof AuditError ? error.message
      : error instanceof Error && /targetAcos|ACoS/.test(error.message) ? error.message : "本地数据校验或诊断失败，体检已停止。";
    process.stdout.write(JSON.stringify({ ok: false, complete: false, error: { code, message } }) + "\n");
    process.exitCode = 1;
  }
}

export function normalizeAdsRow(entity, row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail("INVALID_RESPONSE", "优麦云广告接口的 data.list.items 包含无效行。", 1);
  }

  const campaignId = canonicalString(row.campaignId);
  const campaignName = canonicalString(row.campaignName);
  const adGroupId = canonicalString(row.adGroupId);
  const adGroupName = canonicalString(row.adGroupName);
  let canonical;

  switch (entity) {
    case "campaign": {
      const entityId = campaignId;
      canonical = {
        entity,
        entityId,
        entityName: campaignName,
        campaignId,
        campaignName,
        adGroupId: null,
        adGroupName: null,
        historyAdDataType: "campaign",
        historyId: entityId,
      };
      break;
    }
    case "adGroup": {
      const entityId = canonicalString(row.adGroupId);
      canonical = {
        entity,
        entityId,
        entityName: adGroupName,
        campaignId,
        campaignName,
        adGroupId,
        adGroupName,
        historyAdDataType: "adGroup",
        historyId: entityId,
      };
      break;
    }
    case "productAds": {
      const entityId = canonicalString(row.adId);
      canonical = {
        entity,
        entityId,
        entityName: firstCanonicalString(row.productTitle, row.asin, row.sellerSku),
        campaignId,
        campaignName,
        adGroupId,
        adGroupName,
        asin: canonicalString(row.asin),
        sellerSku: canonicalString(row.sellerSku),
        historyAdDataType: "productAd",
        historyId: entityId,
      };
      break;
    }
    case "keywords": {
      const entityId = canonicalString(row.keywordId);
      const keywordText = firstCanonicalString(row.keywordsText, row.keywordText);
      const keywordMatchType = firstCanonicalString(
        row.keywordsMatchType,
        row.matchType,
        row.matchTypeStr,
      );
      canonical = {
        entity,
        entityId,
        entityName: keywordText,
        campaignId,
        campaignName,
        adGroupId,
        adGroupName,
        keywordText,
        keywordMatchType,
        historyAdDataType: "keyword",
        historyId: entityId,
      };
      break;
    }
    case "targets": {
      const entityId = canonicalString(row.targetId);
      const targetExpression = firstCanonicalString(
        row.targetExpression,
        row.resolvedExpression,
        row.targetValue,
      );
      const targetType = firstCanonicalString(
        row.originalTargetType,
        row.targetType,
        row.expressionType,
      );
      canonical = {
        entity,
        entityId,
        entityName: targetExpression,
        campaignId,
        campaignName,
        adGroupId,
        adGroupName,
        targetExpression,
        targetType,
        historyAdDataType: "target",
        historyId: entityId,
      };
      break;
    }
    case "searchQuery": {
      const searchTermText = canonicalString(row.query);
      const historyId = canonicalString(row.id);
      const segments = historyId?.split("_".repeat(12)) ?? [];
      const source = segments.length >= 3 && segments.slice(0, -2).join("_".repeat(12)) === searchTermText;
      const keywordId = canonicalString(row.keywordId) ?? (source && segments.at(-2) !== "null" ? segments.at(-2) : null);
      const targetId = canonicalString(row.targetId) ?? (source && segments.at(-1) !== "null" ? segments.at(-1) : null);
      canonical = {
        entity,
        entityId: historyId,
        entityName: searchTermText,
        campaignId,
        campaignName,
        adGroupId,
        adGroupName,
        searchTermText,
        queryIsAsin: normalizeQueryIsAsin(row, searchTermText),
        sourceKeywordId: keywordId,
        sourceKeywordText: firstCanonicalString(row.keywordsText, row.keywordText),
        sourceKeywordMatchType: firstCanonicalString(
          row.keywordsMatchType,
          row.matchType,
          row.matchTypeStr,
        ),
        sourceTargetId: targetId,
        sourceTargetExpression: firstCanonicalString(
          row.targetExpression,
          row.resolvedExpression,
          row.targetValue,
        ),
        historyAdDataType: "searchTerm",
        historyId,
      };
      break;
    }
    default:
      fail("INVALID_RESPONSE", `优麦云广告接口的实体类型 ${String(entity)} 无法映射。`, 1);
  }

  return { ...row, canonical };
}

function canonicalString(value) {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function firstCanonicalString(...values) {
  for (const value of values) {
    const normalized = canonicalString(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function normalizeQueryIsAsin(row, searchTermText) {
  if (typeof row.queryIsAsin === "boolean") return row.queryIsAsin ? "Y" : "N";
  const explicit = canonicalString(row.queryIsAsin)?.toUpperCase();
  if (explicit === "Y" || explicit === "N") return explicit;
  return null;
}
