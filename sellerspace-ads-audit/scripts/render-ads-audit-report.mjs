#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const TABLE_PAGE_SIZE = 25;
const CORE_SECTION_KEYS = [
  "campaign",
  "adGroup",
  "productAds",
  "keywords",
  "targets",
  "searchQuery",
];
const CHILD_SECTION_KEYS = CORE_SECTION_KEYS.slice(1);
const ACTION_TYPES = [
  "harvest-search-term",
  "negative-search-term",
  "lower-bid",
  "pause",
  "increase-budget",
  "observe",
];
const scriptDir = dirname(fileURLToPath(import.meta.url));
const logoPath = resolve(scriptDir, "..", "assets", "sellerspace-logo.png");

class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

try {
  const outputDir = readOutputDirectory(process.argv.slice(2));
  const report = await readReport();
  validateReport(report);
  const logo = (await readFile(logoPath)).toString("base64");
  const html = renderReport(report, logo);
  const reportPath = await writeAtomicReport(outputDir, report.scope.marketplace, html);
  print({ ok: true, reportPath });
} catch (error) {
  print({
    ok: false,
    error: {
      code: error instanceof ReportError ? error.code : "REPORT_RENDER_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
}

function readOutputDirectory(args) {
  if (args.length === 0) return resolve(process.cwd(), "sellerspace-reports");
  if (args.length !== 2 || args[0] !== "--output-dir" || !args[1]) {
    throw new ReportError(
      "USAGE_ERROR",
      "用法：render-ads-audit-report.mjs [--output-dir <directory>]",
    );
  }
  return resolve(args[1]);
}

async function readReport() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) {
      throw new ReportError("REPORT_INPUT_TOO_LARGE", "报告输入不能超过 5 MiB。");
    }
  }
  if (!raw.trim()) {
    throw new ReportError("INVALID_REPORT_INPUT", "报告输入不能为空。");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ReportError("INVALID_REPORT_INPUT", "报告输入不是有效 JSON。");
  }
}

function validateReport(report) {
  requireObject(report, "report");
  if (report.schemaVersion !== 2) {
    throw new ReportError("UNSUPPORTED_REPORT_SCHEMA", "仅支持 schemaVersion=2。");
  }
  requireEnum(
    report.analysisMode,
    ["evidence-driven", "campaign-drilldown", "portfolio-sample"],
    "analysisMode",
  );
  requireDate(report.generatedAt, "generatedAt");
  requireString(report.executiveSummary, "executiveSummary");

  requireObject(report.scope, "scope");
  requireScalar(report.scope.sellerId, "scope.sellerId");
  requireString(report.scope.marketplace, "scope.marketplace");
  requireString(report.scope.storeName, "scope.storeName");
  requireString(report.scope.currency, "scope.currency");

  requireObject(report.period, "period");
  requireString(report.period.label, "period.label");
  requireString(report.period.preset, "period.preset");
  optionalString(report.period.from, "period.from");
  optionalString(report.period.to, "period.to");

  requireObject(report.baseline, "baseline");
  requireEnum(
    report.baseline.source,
    ["user-target", "campaign-summary", "store-context", "unavailable"],
    "baseline.source",
  );
  for (const key of [
    "targetAcos",
    "targetRoas",
    "accountAcos",
    "accountRoas",
    "accountCtr",
    "accountCvr",
  ]) {
    requireNullableFiniteNumber(report.baseline[key], `baseline.${key}`);
  }
  requireFiniteNumber(report.baseline.minClicks, "baseline.minClicks");

  requireArray(report.ratings, "ratings");
  for (const [index, rating] of report.ratings.entries()) {
    const path = `ratings[${index}]`;
    requireObject(rating, path);
    requireEnum(
      rating.key,
      ["traffic", "conversion", "efficiency", "budget", "structure"],
      `${path}.key`,
    );
    requireString(rating.label, `${path}.label`);
    requireEnum(rating.status, ["red", "yellow", "green", "insufficient"], `${path}.status`);
    requireString(rating.summary, `${path}.summary`);
    requireStringArray(rating.evidence, `${path}.evidence`);
  }
  const ratingKeys = new Set(report.ratings.map((rating) => rating.key));
  if (report.ratings.length !== 5 || ratingKeys.size !== 5) {
    throw new ReportError("INVALID_REPORT_INPUT", "ratings 必须恰好包含五个不同维度。");
  }

  requireArray(report.overview, "overview");
  report.overview.forEach((metric, index) => validateMetric(metric, `overview[${index}]`));

  requireArray(report.findings, "findings");
  report.findings.forEach((finding, index) => validateFinding(finding, `findings[${index}]`));

  requireArray(report.sections, "sections");
  report.sections.forEach((section, index) => validateSection(section, `sections[${index}]`));

  requireArray(report.campaignDrilldowns, "campaignDrilldowns");
  report.campaignDrilldowns.forEach((item, index) => {
    validateCampaignDrilldown(item, `campaignDrilldowns[${index}]`);
  });

  validateCoverage(report.coverage);
  requireStringArray(report.assumptions, "assumptions");
  requireStringArray(report.limitations, "limitations");
  validateModeConsistency(report);
}

function validateFinding(finding, path) {
  requireObject(finding, path);
  requireEnum(finding.priority, ["P1", "P2", "P3"], `${path}.priority`);
  requireEnum(finding.kind, ["problem", "opportunity", "observe"], `${path}.kind`);
  requireEnum(
    finding.dimension,
    ["traffic", "conversion", "efficiency", "budget", "structure"],
    `${path}.dimension`,
  );
  optionalScalar(finding.campaignId, `${path}.campaignId`);
  requireString(finding.entityType, `${path}.entityType`);
  optionalScalar(finding.entityId, `${path}.entityId`);
  requireString(finding.entityName, `${path}.entityName`);
  requireString(finding.title, `${path}.title`);
  requireArray(finding.evidence, `${path}.evidence`);
  finding.evidence.forEach((metric, index) => {
    validateMetric(metric, `${path}.evidence[${index}]`, false);
  });
  requireString(finding.reasoning, `${path}.reasoning`);
  requireString(finding.recommendation, `${path}.recommendation`);
  requireEnum(finding.confidence, ["high", "medium", "low"], `${path}.confidence`);
  if (finding.action !== undefined && finding.action !== null) {
    validateAction(finding.action, `${path}.action`);
  }
}

function validateAction(action, path) {
  requireObject(action, path);
  requireEnum(action.type, ACTION_TYPES, `${path}.type`);
  requireString(action.label, `${path}.label`);
  optionalEnum(
    action.targetLevel,
    ["campaign", "adGroup", "keyword", "target", "productAd"],
    `${path}.targetLevel`,
  );
  optionalEnum(
    action.coverageStatus,
    ["not-targeted", "targeted", "already-negative", "unknown"],
    `${path}.coverageStatus`,
  );
  if (action.existingTargets !== undefined) {
    requireArray(action.existingTargets, `${path}.existingTargets`);
    action.existingTargets.forEach((target, index) => {
      const targetPath = `${path}.existingTargets[${index}]`;
      requireObject(target, targetPath);
      requireEnum(target.level, ["campaign", "adGroup"], `${targetPath}.level`);
      requireScalar(target.id, `${targetPath}.id`);
      requireString(target.name, `${targetPath}.name`);
    });
  }
}

function validateSection(section, path) {
  requireObject(section, path);
  requireString(section.key, `${path}.key`);
  requireString(section.title, `${path}.title`);
  requireString(section.summary, `${path}.summary`);
  requireNonNegativeInteger(section.sampledCount, `${path}.sampledCount`);
  requireNonNegativeInteger(section.totalCount, `${path}.totalCount`);
  if (section.sampledCount > section.totalCount) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path}.sampledCount 不能大于 totalCount。`);
  }
  requireArray(section.columns, `${path}.columns`);
  section.columns.forEach((column, index) => {
    const columnPath = `${path}.columns[${index}]`;
    requireObject(column, columnPath);
    requireString(column.key, `${columnPath}.key`);
    requireString(column.label, `${columnPath}.label`);
    requireEnum(
      column.format,
      ["currency", "count", "ratio", "percent", "number", "string"],
      `${columnPath}.format`,
    );
    optionalString(column.currency, `${columnPath}.currency`);
  });
  requireArray(section.rows, `${path}.rows`);
  if (section.rows.length !== section.sampledCount) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path}.sampledCount 必须等于 rows 行数。`);
  }
  section.rows.forEach((row, index) => requireObject(row, `${path}.rows[${index}]`));
}

function validateCampaignDrilldown(drilldown, path) {
  requireObject(drilldown, path);
  requireScalar(drilldown.campaignId, `${path}.campaignId`);
  requireString(drilldown.campaignName, `${path}.campaignName`);
  requireString(drilldown.adType, `${path}.adType`);
  requireEnum(drilldown.status, ["enabled"], `${path}.status`);
  requireEnum(
    drilldown.healthStatus,
    ["red", "yellow", "green", "insufficient"],
    `${path}.healthStatus`,
  );
  requireString(drilldown.summary, `${path}.summary`);
  requireArray(drilldown.metrics, `${path}.metrics`);
  drilldown.metrics.forEach((metric, index) => {
    validateMetric(metric, `${path}.metrics[${index}]`);
  });
  requireArray(drilldown.trend, `${path}.trend`);
  drilldown.trend.forEach((point, index) => {
    const pointPath = `${path}.trend[${index}]`;
    requireObject(point, pointPath);
    requireString(point.date, `${pointPath}.date`);
    requireNullableFiniteNumber(point.cost, `${pointPath}.cost`);
    requireNullableFiniteNumber(point.sales, `${pointPath}.sales`);
    requireNullableFiniteNumber(point.acos, `${pointPath}.acos`);
  });
  requireArray(drilldown.placements, `${path}.placements`);
  drilldown.placements.forEach((placement, index) => {
    const placementPath = `${path}.placements[${index}]`;
    requireObject(placement, placementPath);
    requireString(placement.name, `${placementPath}.name`);
    requireNullableFiniteNumber(placement.cost, `${placementPath}.cost`);
    requireNullableFiniteNumber(placement.sales, `${placementPath}.sales`);
    requireNullableFiniteNumber(placement.share, `${placementPath}.share`);
  });
  requireArray(drilldown.sections, `${path}.sections`);
  drilldown.sections.forEach((section, index) => {
    validateSection(section, `${path}.sections[${index}]`);
  });
  requireExactSectionKeys(drilldown.sections, CHILD_SECTION_KEYS, `${path}.sections`);
}

function validateCoverage(coverage) {
  requireObject(coverage, "coverage");
  requireStringArray(coverage.operations, "coverage.operations");
  requireStringArray(coverage.entitySections, "coverage.entitySections");
  requireScalarArray(coverage.historyCampaignIds, "coverage.historyCampaignIds");
  requireScalarArray(coverage.placementCampaignIds, "coverage.placementCampaignIds");
  requireNonNegativeInteger(coverage.enabledCampaignCount, "coverage.enabledCampaignCount");
  requireScalarArray(coverage.fullyDrilledCampaignIds, "coverage.fullyDrilledCampaignIds");
  requireNonNegativeInteger(coverage.businessCallCount, "coverage.businessCallCount");

  if (coverage.entities !== undefined) {
    requireArray(coverage.entities, "coverage.entities");
    coverage.entities.forEach((entity, index) => {
      const path = `coverage.entities[${index}]`;
      requireObject(entity, path);
      requireEnum(entity.key, CORE_SECTION_KEYS, `${path}.key`);
      requireNonNegativeInteger(entity.queriedCount, `${path}.queriedCount`);
      requireNonNegativeInteger(entity.totalCount, `${path}.totalCount`);
      if (entity.queriedCount > entity.totalCount) {
        throw new ReportError("INVALID_REPORT_INPUT", `${path}.queriedCount 不能大于 totalCount。`);
      }
      requireEnum(entity.status, ["complete", "target-reached", "unknown"], `${path}.status`);
      requireNullableFiniteNumber(entity.spendCoverage, `${path}.spendCoverage`);
      if (entity.status === "unknown" && entity.spendCoverage !== null) {
        throw new ReportError("INVALID_REPORT_INPUT", `${path}.unknown 必须使用 null spendCoverage。`);
      }
      if (entity.status !== "unknown") {
        requireRatio(entity.spendCoverage, `${path}.spendCoverage`);
      }
      if (entity.status === "target-reached" && entity.spendCoverage < 0.9) {
        throw new ReportError("INVALID_REPORT_INPUT", `${path}.target-reached 覆盖率不能低于 90%。`);
      }
    });
  }

  if (coverage.selectedCampaigns !== undefined) {
    requireArray(coverage.selectedCampaigns, "coverage.selectedCampaigns");
    coverage.selectedCampaigns.forEach((campaign, index) => {
      const path = `coverage.selectedCampaigns[${index}]`;
      requireObject(campaign, path);
      requireScalar(campaign.campaignId, `${path}.campaignId`);
      requireString(campaign.campaignName, `${path}.campaignName`);
      requireStringArray(campaign.reasons, `${path}.reasons`);
      if (campaign.reasons.length === 0) {
        throw new ReportError("INVALID_REPORT_INPUT", `${path}.reasons 不能为空。`);
      }
      requireBoolean(campaign.historyQueried, `${path}.historyQueried`);
      requireBoolean(campaign.placementQueried, `${path}.placementQueried`);
    });
  }
}

function validateModeConsistency(report) {
  const topLevelKeys = report.sections.map((section) => section.key);
  if (new Set(topLevelKeys).size !== topLevelKeys.length) {
    throw new ReportError("INVALID_REPORT_INPUT", "sections 包含重复 key。");
  }
  const drilldownIds = report.campaignDrilldowns.map((item) => String(item.campaignId));
  if (new Set(drilldownIds).size !== drilldownIds.length) {
    throw new ReportError("INVALID_REPORT_INPUT", "campaignDrilldowns 包含重复 campaignId。");
  }

  if (report.analysisMode === "campaign-drilldown") {
    requireExactSectionKeys(report.sections, ["campaign"], "sections");
    if (report.campaignDrilldowns.length !== report.coverage.enabledCampaignCount) {
      throw new ReportError("INCOMPLETE_REPORT_INPUT", "legacy 逐活动报告必须覆盖每个启用 Campaign。");
    }
    requireSameIdSet(report.coverage.fullyDrilledCampaignIds, drilldownIds, "完整下钻范围不一致。");
    requireSameIdSet(report.coverage.historyCampaignIds, drilldownIds, "趋势范围不一致。");
    const spIds = report.campaignDrilldowns
      .filter((item) => item.adType.toUpperCase() === "SP")
      .map((item) => String(item.campaignId));
    requireSameIdSet(report.coverage.placementCampaignIds, spIds, "SP 广告位范围不一致。");
    return;
  }

  requireExactSectionKeys(report.sections, CORE_SECTION_KEYS, "sections");
  if (report.analysisMode === "portfolio-sample") {
    if (report.campaignDrilldowns.length !== 0 || report.coverage.fullyDrilledCampaignIds.length !== 0) {
      throw new ReportError("INVALID_REPORT_INPUT", "legacy 组合报告不得声明逐活动完整下钻。");
    }
    return;
  }

  if (!Array.isArray(report.coverage.entities)) {
    throw new ReportError("INCOMPLETE_REPORT_INPUT", "evidence-driven 必须提供实体覆盖明细。");
  }
  requireExactCoverageKeys(report.coverage.entities);
  const campaignCoverage = report.coverage.entities.find((item) => item.key === "campaign");
  if (campaignCoverage.status !== "complete"
    || campaignCoverage.queriedCount !== report.coverage.enabledCampaignCount
    || campaignCoverage.totalCount !== report.coverage.enabledCampaignCount) {
    throw new ReportError("INCOMPLETE_REPORT_INPUT", "启用 Campaign 必须完整分页覆盖。");
  }
  if (!Array.isArray(report.coverage.selectedCampaigns)) {
    throw new ReportError("INCOMPLETE_REPORT_INPUT", "evidence-driven 必须提供下钻选择原因。");
  }
  const selectedIds = report.coverage.selectedCampaigns.map((item) => String(item.campaignId));
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new ReportError("INVALID_REPORT_INPUT", "selectedCampaigns 包含重复 campaignId。");
  }
  requireSameIdSet(selectedIds, drilldownIds, "下钻 Campaign 与选择范围不一致。");
  requireSameIdSet(report.coverage.fullyDrilledCampaignIds, drilldownIds, "完整下钻范围不一致。");
  requireSameIdSet(report.coverage.historyCampaignIds, drilldownIds, "每个证据命中 Campaign 都必须查询趋势。");
  const placementSet = new Set(report.coverage.placementCampaignIds.map(String));
  const selectedSet = new Set(selectedIds);
  if ([...placementSet].some((id) => !selectedSet.has(id))) {
    throw new ReportError("INVALID_REPORT_INPUT", "广告位查询只能属于证据命中的 Campaign。");
  }
  for (const campaign of report.coverage.selectedCampaigns) {
    const id = String(campaign.campaignId);
    if (!campaign.historyQueried) {
      throw new ReportError("INCOMPLETE_REPORT_INPUT", "证据命中的 Campaign 必须完成趋势查询。");
    }
    if (campaign.placementQueried !== placementSet.has(id)) {
      throw new ReportError("INVALID_REPORT_INPUT", "placementQueried 与广告位覆盖 ID 不一致。");
    }
  }
}

function requireExactSectionKeys(sections, expected, path) {
  const actual = sections.map((section) => section.key);
  if (new Set(actual).size !== actual.length
    || actual.length !== expected.length
    || expected.some((key) => !actual.includes(key))) {
    throw new ReportError("INCOMPLETE_REPORT_INPUT", `${path} 必须恰好包含：${expected.join("、")}。`);
  }
}

function requireExactCoverageKeys(entities) {
  const actual = entities.map((entity) => entity.key);
  if (new Set(actual).size !== CORE_SECTION_KEYS.length
    || actual.length !== CORE_SECTION_KEYS.length
    || CORE_SECTION_KEYS.some((key) => !actual.includes(key))) {
    throw new ReportError("INCOMPLETE_REPORT_INPUT", "coverage.entities 必须包含六类核心实体。");
  }
}

function requireSameIdSet(actualValues, expectedValues, message) {
  const actual = new Set(actualValues.map(String));
  const expected = new Set(expectedValues.map(String));
  if (actual.size !== expected.size || [...expected].some((value) => !actual.has(value))) {
    throw new ReportError("INCOMPLETE_REPORT_INPUT", message);
  }
}

function validateMetric(metric, path, requireKey = true) {
  requireObject(metric, path);
  if (requireKey) requireString(metric.key, `${path}.key`);
  requireString(metric.label, `${path}.label`);
  requireEnum(
    metric.format,
    ["currency", "count", "ratio", "percent", "number", "string"],
    `${path}.format`,
  );
  optionalString(metric.currency, `${path}.currency`);
  if (metric.value !== null && metric.value !== undefined) {
    if (metric.format === "string") requireScalar(metric.value, `${path}.value`);
    else requireFiniteNumber(metric.value, `${path}.value`);
  }
}

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是对象。`);
  }
}

function requireArray(value, path) {
  if (!Array.isArray(value)) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是数组。`);
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是非空字符串。`);
  }
}

function optionalString(value, path) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是字符串。`);
  }
}

function requireFiniteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是有限数字。`);
  }
}

function requireNullableFiniteNumber(value, path) {
  if (value !== null) requireFiniteNumber(value, path);
}

function requireRatio(value, path) {
  requireFiniteNumber(value, path);
  if (value < 0 || value > 1) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是 0 到 1 的比例。`);
  }
}

function requireNonNegativeInteger(value, path) {
  requireFiniteNumber(value, path);
  if (!Number.isInteger(value) || value < 0) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是非负整数。`);
  }
}

function requireScalar(value, path) {
  if (!["string", "number"].includes(typeof value)
    || (typeof value === "number" && !Number.isFinite(value))) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是字符串或有限数字。`);
  }
}

function optionalScalar(value, path) {
  if (value !== undefined && value !== null) requireScalar(value, path);
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是布尔值。`);
  }
}

function requireStringArray(value, path) {
  requireArray(value, path);
  value.forEach((item, index) => requireString(item, `${path}[${index}]`));
}

function requireScalarArray(value, path) {
  requireArray(value, path);
  value.forEach((item, index) => requireScalar(item, `${path}[${index}]`));
}

function requireEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是：${allowed.join("、")}。`);
  }
}

function optionalEnum(value, allowed, path) {
  if (value !== undefined && value !== null) requireEnum(value, allowed, path);
}

function requireDate(value, path) {
  requireString(value, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是有效日期时间。`);
  }
}

function renderReport(report, logo) {
  const title = `${report.scope.marketplace} 亚马逊广告体检报告`;
  const actionGroups = groupFindings(report.findings);
  const orderedSections = CORE_SECTION_KEYS
    .map((key) => report.sections.find((section) => section.key === key))
    .filter(Boolean);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--ink:#172038;--ink-soft:#3c465f;--muted:#6f7789;--line:#e4e7ee;--line-strong:#d4d9e4;--paper:#fff;--canvas:#f6f7fa;--violet:#6257d9;--violet-dark:#4d43b8;--violet-soft:#f0effc;--teal:#0f8f87;--teal-soft:#e9f8f6;--red:#c94752;--red-soft:#fdf0f1;--amber:#a96716;--amber-soft:#fff5e6;--green:#257b67;--green-soft:#edf8f3;--gray:#7d8699;--gray-soft:#f1f3f6}
    *{box-sizing:border-box}html{background:var(--canvas);scroll-behavior:smooth}body{margin:0;color:var(--ink);font:14px/1.58 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}button,summary{font:inherit}button{color:inherit}button:focus-visible,summary:focus-visible{outline:3px solid rgba(98,87,217,.35);outline-offset:2px}
    main{max-width:1420px;margin:0 auto;padding:20px}.sheet{overflow:hidden;background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 16px 46px rgba(28,34,56,.07)}
    .masthead{padding:22px 28px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:flex;align-items:center;gap:24px;min-width:0}.brand img{width:176px;max-height:48px;object-fit:contain;object-position:left center}.report-heading{padding-left:24px;border-left:1px solid var(--line);min-width:0}.report-heading h1{margin:0;font-size:25px;line-height:1.2;letter-spacing:-.02em}.meta{margin-top:7px;display:flex;flex-wrap:wrap;gap:5px 16px;color:var(--muted);font-size:12px}.scope-pill{border:1px solid #d6d2f4;background:var(--violet-soft);color:var(--violet-dark);padding:8px 12px;border-radius:999px;font-weight:750;white-space:nowrap}
    .intro{padding:24px 28px 0}.lede{margin:0;color:var(--ink-soft);font-size:15px}.lede strong{color:var(--ink);margin-right:5px}.health-line{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:18px}.health-item{padding:13px 14px;border:1px solid var(--line);border-radius:10px;min-width:0}.health-label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--gray);flex:0 0 auto}.status-red .status-dot{background:var(--red)}.status-yellow .status-dot{background:var(--amber)}.status-green .status-dot{background:var(--green)}.health-item strong{display:block;margin-top:5px;font-size:15px}.health-item p{margin:3px 0 0;color:var(--muted);font-size:12px}
    .number-band{display:grid;grid-template-columns:140px repeat(auto-fit,minmax(130px,1fr));margin:18px 28px 0;background:#f7f6fd;border:1px solid #e9e7f8;border-radius:10px;overflow:hidden}.band-label{display:flex;align-items:center;padding:14px 16px;font-size:16px;font-weight:800;border-right:1px solid #e1def4}.number-cell{padding:12px 14px;text-align:center;border-right:1px solid #e1def4}.number-cell:last-child{border-right:0}.number-cell span{display:block;color:var(--ink-soft);font-size:12px}.number-cell strong{display:block;margin-top:2px;color:var(--violet-dark);font-size:19px}
    .report-section{padding:28px;border-top:1px solid var(--line)}.section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px}.section-title h2{margin:0;font-size:21px;letter-spacing:-.01em}.section-title p{margin:3px 0 0;color:var(--muted);font-size:13px}.mode-note{color:var(--teal)!important;font-weight:700;text-align:right}
    .tab-list{display:flex;gap:8px;margin-bottom:16px;padding-bottom:2px;overflow-x:auto;scrollbar-width:thin}.tab-button{flex:0 0 auto;border:1px solid var(--line-strong);background:#fff;padding:9px 13px;border-radius:9px;cursor:pointer;font-weight:700;color:var(--ink-soft)}.tab-button:hover{border-color:#bdb7ea;color:var(--violet-dark)}.tab-button[aria-selected="true"]{border-color:var(--violet);background:var(--violet);color:#fff;box-shadow:0 4px 12px rgba(98,87,217,.2)}.tab-count{margin-left:6px;opacity:.75;font-variant-numeric:tabular-nums}.tab-panel{min-width:0}.tab-panel[hidden]{display:none}
    .action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.action-card{padding:16px;border:1px solid var(--line);border-radius:12px;background:#fff}.action-card:only-child{grid-column:1/-1;max-width:900px}.action-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.priority,.action-label{display:inline-flex;align-items:center;border-radius:999px;font-size:12px;font-weight:800}.priority{padding:3px 8px;background:var(--gray-soft);color:var(--gray)}.priority-p1{background:var(--red-soft);color:var(--red)}.priority-p2{background:var(--amber-soft);color:var(--amber)}.priority-p3{background:var(--green-soft);color:var(--green)}.action-label{color:var(--violet-dark)}.action-card h3{margin:10px 0 2px;font-size:16px}.entity{margin:0 0 9px;color:var(--muted);font-size:12px}.evidence{display:flex;flex-wrap:wrap;gap:6px}.evidence span{padding:4px 7px;border-radius:6px;background:var(--gray-soft);color:var(--ink-soft);font-size:12px}.action-copy{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.action-copy div{padding-top:10px;border-top:1px solid var(--line)}.action-copy strong{display:block;margin-bottom:3px;font-size:12px}.action-copy p{margin:0;color:var(--ink-soft);font-size:13px}.target-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.target-chip{padding:4px 7px;border:1px solid #d8d4f2;border-radius:6px;background:var(--violet-soft);color:var(--violet-dark);font-size:12px}.empty-state{padding:24px;border:1px dashed var(--line-strong);border-radius:10px;color:var(--muted);text-align:center}
    .coverage-layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:22px}.coverage-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.coverage-card{padding:13px;border:1px solid var(--line);border-radius:10px}.coverage-card span{display:block;color:var(--muted);font-size:12px}.coverage-card strong{display:block;margin-top:3px;font-size:16px}.coverage-card small{display:block;margin-top:2px;color:var(--teal);font-size:12px}.coverage-summary{display:grid;grid-template-columns:1fr auto;gap:7px 14px;margin:0}.coverage-summary dt{color:var(--muted)}.coverage-summary dd{margin:0;text-align:right;font-weight:750}.selection-list{margin-top:14px;border-top:1px solid var(--line)}.selection-item{padding:11px 0;border-bottom:1px solid var(--line)}.selection-item strong{display:block}.selection-item p{margin:3px 0 0;color:var(--muted);font-size:12px}.note-list{margin:14px 0 0;padding-left:18px;color:var(--muted);font-size:12px}.note-list li+li{margin-top:4px}
    .data-panel-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:10px}.data-panel-head h3{margin:0;font-size:17px}.data-panel-head p{margin:3px 0 0;color:var(--muted);font-size:12px}.coverage-badge{flex:0 0 auto;padding:5px 8px;border-radius:7px;background:var(--teal-soft);color:var(--teal);font-size:12px;font-weight:750}.coverage-badge.unknown{background:var(--amber-soft);color:var(--amber)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:9px}table{width:100%;border-collapse:collapse;min-width:720px}th,td{text-align:left;padding:10px 11px;border-bottom:1px solid var(--line);vertical-align:top;font-size:12px}th{position:sticky;top:0;z-index:1;color:var(--muted);font-size:11px;font-weight:750;letter-spacing:.02em;background:#fafafd}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfbfe}.table-pager{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:10px}.pager-button{border:1px solid var(--line-strong);background:#fff;border-radius:7px;padding:6px 10px;cursor:pointer}.pager-button:disabled{cursor:not-allowed;opacity:.45}.pager-status{color:var(--muted);font-size:12px}
    .dossiers{border-top:1px solid var(--line-strong)}.dossier{border-bottom:1px solid var(--line-strong)}.dossier>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:14px;padding:14px 2px}.dossier>summary::-webkit-details-marker{display:none}.campaign-index{font:750 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.campaign-title{min-width:190px;flex:1}.campaign-title small{display:block;color:var(--muted);font-size:11px;letter-spacing:.03em}.campaign-title strong{display:block;margin-top:2px;font-size:15px}.campaign-summary{flex:1.4;color:var(--ink-soft);font-size:12px}.disclosure{color:var(--violet);font-size:12px;font-weight:750}.disclosure::after{content:"展开"}.dossier[open] .disclosure::after{content:"收起"}.dossier-body{padding:0 0 18px 34px}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px}.metric-card{padding:10px;border-radius:8px;background:var(--gray-soft)}.metric-card span{display:block;color:var(--muted);font-size:11px}.metric-card strong{display:block;margin-top:2px;font-size:15px}.evidence-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.evidence-panel{min-width:0;padding:13px;border:1px solid var(--line);border-radius:10px}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.panel-head h3{margin:0;font-size:14px}.legend{display:flex;gap:9px;color:var(--muted);font-size:11px}.legend span{display:flex;align-items:center;gap:4px}.legend i{width:11px;height:3px;background:var(--violet)}.legend span+span i{background:var(--teal)}.trend-image{display:block;width:100%;height:150px;object-fit:contain}.placement-layout{display:grid;grid-template-columns:112px 1fr;align-items:center;gap:12px}.placement-image{display:block;width:110px;height:110px}.placement-list{list-style:none;margin:0;padding:0}.placement-list li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px}.placement-list li:last-child{border-bottom:0}.placement-list span{color:var(--muted)}.campaign-finding{padding:9px 0;border-top:1px solid var(--line)}.campaign-finding:first-of-type{border-top:0}.campaign-finding strong{display:block;font-size:13px}.campaign-finding p{margin:3px 0 0;color:var(--ink-soft);font-size:12px}.entity-details{margin-top:12px}.all-entities>summary,.entity-details details>summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:12px;padding:10px 0;font-weight:750}.all-entities>summary::-webkit-details-marker,.entity-details details>summary::-webkit-details-marker{display:none}.entity-details details{border-top:1px solid var(--line)}.entity-details summary span{color:var(--muted);font-weight:500;font-size:12px}.section-summary{margin:0 0 8px;color:var(--muted);font-size:12px}.footer{padding:14px 28px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:11px}
    @media(max-width:980px){.health-line{grid-template-columns:repeat(2,1fr)}.action-grid{grid-template-columns:1fr}.coverage-layout{grid-template-columns:1fr}.coverage-cards{grid-template-columns:repeat(2,1fr)}.evidence-grid{grid-template-columns:1fr}.campaign-summary{display:none}}
    @media(max-width:640px){main{padding:0}.sheet{border:0;border-radius:0;box-shadow:none}.masthead{padding:16px;align-items:flex-start}.brand{gap:12px}.brand img{width:108px}.report-heading{padding-left:12px}.report-heading h1{font-size:18px}.meta{font-size:10px}.scope-pill{font-size:10px;padding:6px 8px}.intro,.report-section{padding-left:16px;padding-right:16px}.health-line{grid-template-columns:1fr}.number-band{margin-left:16px;margin-right:16px;grid-template-columns:1fr 1fr}.band-label{grid-column:1/-1;border-right:0;border-bottom:1px solid #e1def4}.number-cell{border-bottom:1px solid #e1def4}.section-title{align-items:flex-start}.mode-note{max-width:45%}.action-copy{grid-template-columns:1fr}.coverage-cards{grid-template-columns:1fr 1fr}.dossier>summary{min-height:48px}.campaign-title{min-width:0}.dossier-body{padding-left:0}.metric-grid{grid-template-columns:repeat(2,1fr)}.placement-layout{grid-template-columns:90px 1fr}.placement-image{width:88px;height:88px}.footer{padding:14px 16px;display:block}.footer span{display:block;margin-top:3px}}
    @media print{html,body{background:#fff}main{max-width:none;padding:0}.sheet{border:0;box-shadow:none}.tab-list,.table-pager,.disclosure{display:none!important}.tab-panel[hidden]{display:block!important}.tab-panel{margin-bottom:20px}.dossier,.action-card,.coverage-card{break-inside:avoid}.dossier:not([open])>.dossier-body,.entity-details details:not([open])>*:not(summary){display:block}.table-wrap{overflow:visible}table{min-width:0}.paged-row{display:table-row!important}.footer{display:none}}
  </style>
</head>
<body>
<main>
  <article class="sheet">
    <header class="masthead">
      <div class="brand"><img alt="SellerSpace 优麦云" src="data:image/png;base64,${logo}"><div class="report-heading"><h1>${escapeHtml(title)}</h1><div class="meta"><span>${escapeHtml(report.scope.storeName)}</span><span>Seller ID ${escapeHtml(String(report.scope.sellerId))}</span><span>${escapeHtml(report.period.label)} · ${escapeHtml(report.period.preset)}</span><span>${escapeHtml(formatDate(report.generatedAt))}</span></div></div></div>
      <span class="scope-pill">仅启用中广告 · 只读</span>
    </header>
    <section class="intro">
      <p class="lede"><strong>执行摘要：</strong>${escapeHtml(report.executiveSummary)}</p>
      <div class="health-line">${renderRatings(report.ratings)}</div>
    </section>
    <section class="number-band"><div class="band-label">数字摘要</div>${renderOverview(report.overview, report.scope.currency)}</section>
    <section class="report-section action-section">
      <div class="section-title"><div><h2>优先行动</h2><p>先看要做什么，再查看支持证据</p></div><p class="mode-note">建议仅供决策 · 未执行修改</p></div>
      ${renderActionTabs(actionGroups, report.scope.currency)}
    </section>
    <section class="report-section coverage-section">
      <div class="section-title"><div><h2>查询覆盖</h2><p>覆盖范围和下钻选择都可追溯</p></div><p class="mode-note">${escapeHtml(modeCoverageLabel(report))}</p></div>
      ${renderCoverage(report)}
    </section>
    <section class="report-section data-section">
      <div class="section-title"><div><h2>数据明细</h2><p>六类实体通过 Tab 切换，每页显示 ${TABLE_PAGE_SIZE} 行</p></div><p class="mode-note">按花费降序</p></div>
      ${renderDataTabs(orderedSections, report)}
    </section>
    <section class="report-section drilldown-section">
      <div class="section-title"><div><h2>证据下钻</h2><p>仅展示达到诊断门槛并完成补充查询的 Campaign</p></div><p class="mode-note">${escapeHtml(String(report.campaignDrilldowns.length))} 个 Campaign</p></div>
      ${renderCampaignDossiers(report)}
    </section>
    <footer class="footer"><span>由 SellerSpace 实际只读接口数据生成</span><span>未执行任何广告修改 · 业务查询次数仅作记录</span></footer>
  </article>
</main>
<script>
(() => {
  for (const root of document.querySelectorAll('[data-tabs]')) {
    const tabs = [...root.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
    const activate = (index, moveFocus) => {
      tabs.forEach((tab, tabIndex) => {
        const active = tabIndex === index;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[tabIndex].hidden = !active;
      });
      if (moveFocus) tabs[index].focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(index, false));
      tab.addEventListener('keydown', (event) => {
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        activate(next, true);
      });
    });
    if (tabs.length) activate(0, false);
  }

  for (const root of document.querySelectorAll('[data-paged-table]')) {
    const rows = [...root.querySelectorAll('.paged-row')];
    const previous = root.querySelector('[data-page-prev]');
    const next = root.querySelector('[data-page-next]');
    const status = root.querySelector('[data-page-status]');
    const size = Number(root.dataset.pageSize) || ${TABLE_PAGE_SIZE};
    const pageCount = Math.max(1, Math.ceil(rows.length / size));
    let page = 0;
    const render = () => {
      rows.forEach((row, index) => { row.hidden = index < page * size || index >= (page + 1) * size; });
      previous.disabled = page === 0;
      next.disabled = page >= pageCount - 1;
      status.textContent = rows.length ? '第 ' + (page + 1) + ' / ' + pageCount + ' 页 · 共 ' + rows.length + ' 行' : '无数据';
    };
    previous.addEventListener('click', () => { if (page > 0) { page -= 1; render(); } });
    next.addEventListener('click', () => { if (page < pageCount - 1) { page += 1; render(); } });
    render();
  }
})();
</script>
</body>
</html>`;
}

function renderRatings(ratings) {
  return ratings.map((rating) => `
    <div class="health-item status-${escapeAttribute(rating.status)}">
      <span class="health-label"><i class="status-dot"></i>${escapeHtml(rating.label)}</span>
      <strong>${escapeHtml(statusLabel(rating.status))}</strong>
      <p>${escapeHtml(rating.summary)}</p>
    </div>`).join("");
}

function renderOverview(metrics, defaultCurrency) {
  if (metrics.length === 0) {
    return '<div class="number-cell"><span>广告大盘</span><strong>—</strong></div>';
  }
  return metrics.map((metric) => `
    <div class="number-cell"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}</strong></div>`).join("");
}

function groupFindings(findings) {
  const groups = { search: [], stop: [], budget: [], observe: [] };
  for (const finding of findings) {
    const type = finding.action?.type;
    if (type === "harvest-search-term") groups.search.push(finding);
    else if (["negative-search-term", "lower-bid", "pause"].includes(type)) groups.stop.push(finding);
    else if (type === "increase-budget") groups.budget.push(finding);
    else if (!type && finding.kind === "opportunity" && finding.entityType === "searchQuery") groups.search.push(finding);
    else if (!type && finding.kind === "opportunity" && finding.dimension === "budget") groups.budget.push(finding);
    else if (!type && finding.kind === "problem") groups.stop.push(finding);
    else groups.observe.push(finding);
  }
  return groups;
}

function renderActionTabs(groups, defaultCurrency) {
  const tabs = [
    ["search", "搜索词机会", groups.search],
    ["stop", "止损与否定", groups.stop],
    ["budget", "活动预算", groups.budget],
    ["observe", "持续观察", groups.observe],
  ];
  return renderTabs("actions", "优化建议分类", tabs.map(([key, label, findings]) => ({
    key,
    label,
    count: findings.length,
    content: renderActionCards(findings, defaultCurrency),
  })));
}

function renderActionCards(findings, defaultCurrency) {
  if (findings.length === 0) return '<div class="empty-state">本期没有达到该类行动门槛的对象。</div>';
  return `<div class="action-grid">${findings.map((finding) => renderActionCard(finding, defaultCurrency)).join("")}</div>`;
}

function renderActionCard(finding, defaultCurrency) {
  const actionLabel = finding.action?.label || finding.recommendation;
  const targets = finding.action?.existingTargets || [];
  return `<article class="action-card">
    <div class="action-top"><span class="priority priority-${escapeAttribute(finding.priority.toLowerCase())}">${escapeHtml(finding.priority)}</span><span class="action-label">${escapeHtml(actionLabel)}</span></div>
    <h3>${escapeHtml(finding.title)}</h3>
    <p class="entity">${escapeHtml(finding.entityName)} · ${escapeHtml(finding.entityType)} · ${escapeHtml(confidenceLabel(finding.confidence))}</p>
    <div class="evidence">${finding.evidence.map((metric) => `<span>${escapeHtml(metric.label)} ${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}</span>`).join("")}</div>
    <div class="action-copy"><div><strong>为什么</strong><p>${escapeHtml(finding.reasoning)}</p></div><div><strong>建议动作</strong><p>${escapeHtml(finding.recommendation)}</p></div></div>
    ${targets.length ? `<div class="target-list" aria-label="当前投放位置">${targets.map((target) => `<span class="target-chip">${escapeHtml(targetLevelLabel(target.level))} · ${escapeHtml(target.name || String(target.id))}</span>`).join("")}</div>` : ""}
  </article>`;
}

function renderCoverage(report) {
  const entities = report.coverage.entities || [];
  const selected = report.coverage.selectedCampaigns || [];
  const cards = entities.length
    ? `<div class="coverage-cards">${CORE_SECTION_KEYS.map((key) => entities.find((item) => item.key === key)).filter(Boolean).map(renderCoverageCard).join("")}</div>`
    : `<dl class="coverage-summary">
        <dt>分析模式</dt><dd>${escapeHtml(modeLabel(report.analysisMode))}</dd>
        <dt>启用 Campaign</dt><dd>${escapeHtml(String(report.coverage.enabledCampaignCount))}</dd>
        <dt>完整下钻</dt><dd>${escapeHtml(String(report.coverage.fullyDrilledCampaignIds.length))}</dd>
        <dt>趋势覆盖</dt><dd>${escapeHtml(String(report.coverage.historyCampaignIds.length))}</dd>
        <dt>广告位覆盖</dt><dd>${escapeHtml(String(report.coverage.placementCampaignIds.length))}</dd>
      </dl>`;
  const selections = selected.length
    ? `<div class="selection-list">${selected.map((campaign) => `<div class="selection-item"><strong>${escapeHtml(campaign.campaignName)}</strong><p>${escapeHtml(campaign.reasons.join("；"))} · 日趋势已查${campaign.placementQueried ? " · 广告位已查" : ""}</p></div>`).join("")}</div>`
    : '<p class="empty-state">本期没有 Campaign 达到证据下钻门槛。</p>';
  return `<div class="coverage-layout"><div>${cards}${selections}</div><aside><dl class="coverage-summary"><dt>分析模式</dt><dd>${escapeHtml(modeLabel(report.analysisMode))}</dd><dt>启用 Campaign</dt><dd>${escapeHtml(String(report.coverage.enabledCampaignCount))}</dd><dt>证据下钻</dt><dd>${escapeHtml(String(report.campaignDrilldowns.length))}</dd><dt>日趋势</dt><dd>${escapeHtml(String(report.coverage.historyCampaignIds.length))}</dd><dt>广告位</dt><dd>${escapeHtml(String(report.coverage.placementCampaignIds.length))}</dd><dt>业务查询</dt><dd>${escapeHtml(String(report.coverage.businessCallCount))} 次</dd></dl>${renderMethodNotes(report)}</aside></div>`;
}

function renderCoverageCard(entity) {
  const coverage = entity.spendCoverage === null ? "覆盖度未知" : `花费覆盖 ${formatValue(entity.spendCoverage, "ratio")}`;
  const detail = entity.status === "unknown" ? coverage : `${coverage} · ${coverageStatusLabel(entity.status)}`;
  return `<article class="coverage-card"><span>${escapeHtml(sectionLabel(entity.key))}</span><strong>${escapeHtml(String(entity.queriedCount))} / ${escapeHtml(String(entity.totalCount))}</strong><small>${escapeHtml(detail)}</small></article>`;
}

function renderMethodNotes(report) {
  const notes = [
    ...report.assumptions.map((item) => `假设：${item}`),
    ...report.limitations.map((item) => `限制：${item}`),
  ];
  if (notes.length === 0) return "";
  return `<ul class="note-list">${notes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderDataTabs(sections, report) {
  const coverageByKey = new Map((report.coverage.entities || []).map((item) => [item.key, item]));
  return renderTabs("data", "广告实体数据", sections.map((section, index) => ({
    key: `${escapeAttribute(section.key)}-${index}`,
    label: sectionLabel(section.key, section.title),
    count: section.sampledCount,
    content: renderDataPanel(section, coverageByKey.get(section.key), report.scope.currency, `top-${index}`),
  })));
}

function renderDataPanel(section, coverage, defaultCurrency, tableId) {
  const coverageText = coverage
    ? coverage.spendCoverage === null
      ? "覆盖度未知"
      : `花费覆盖 ${formatValue(coverage.spendCoverage, "ratio")}`
    : `展示 ${section.sampledCount} / ${section.totalCount}`;
  const unknownClass = coverage?.status === "unknown" ? " unknown" : "";
  return `<div class="data-panel-head"><div><h3>${escapeHtml(section.title)}</h3><p>${escapeHtml(section.summary)}</p></div><span class="coverage-badge${unknownClass}">${escapeHtml(coverageText)} · ${escapeHtml(String(section.sampledCount))}/${escapeHtml(String(section.totalCount))}</span></div>${renderSectionTable(section, defaultCurrency, tableId)}`;
}

function renderTabs(prefix, label, tabs) {
  if (tabs.length === 0) return '<div class="empty-state">没有可展示的数据。</div>';
  const buttons = tabs.map((tab, index) => `<button type="button" class="tab-button" role="tab" id="${prefix}-tab-${escapeAttribute(tab.key)}" aria-controls="${prefix}-panel-${escapeAttribute(tab.key)}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(tab.label)}<span class="tab-count">${escapeHtml(String(tab.count))}</span></button>`).join("");
  const panels = tabs.map((tab, index) => `<section class="tab-panel" role="tabpanel" id="${prefix}-panel-${escapeAttribute(tab.key)}" aria-labelledby="${prefix}-tab-${escapeAttribute(tab.key)}"${index === 0 ? "" : " hidden"}>${tab.content}</section>`).join("");
  return `<div data-tabs><div class="tab-list" role="tablist" aria-label="${escapeHtml(label)}">${buttons}</div>${panels}</div>`;
}

function renderCampaignDossiers(report) {
  if (report.campaignDrilldowns.length === 0) {
    return '<div class="empty-state">本期没有 Campaign 达到证据下钻门槛。</div>';
  }
  const selectedMap = new Map((report.coverage.selectedCampaigns || []).map((item) => [String(item.campaignId), item]));
  return `<div class="dossiers">${report.campaignDrilldowns.map((drilldown, index) => renderCampaignDossier(drilldown, index, report.findings, report.scope.currency, selectedMap.get(String(drilldown.campaignId)))).join("")}</div>`;
}

function renderCampaignDossier(drilldown, index, findings, defaultCurrency, selection) {
  const campaignId = String(drilldown.campaignId);
  const campaignFindings = findings.filter((finding) => String(finding.campaignId ?? "") === campaignId);
  const trendImage = renderTrendPng(drilldown.trend);
  const placementImage = renderPlacementPng(drilldown.placements);
  const summary = selection?.reasons?.length ? selection.reasons.join("；") : drilldown.summary;
  return `<details class="dossier"${index === 0 ? " open" : ""}>
    <summary><span class="campaign-index">${String(index + 1).padStart(2, "0")}</span><span class="campaign-title"><small>${escapeHtml(drilldown.adType)} · ENABLED · ${escapeHtml(statusLabel(drilldown.healthStatus))}</small><strong>${escapeHtml(drilldown.campaignName)}</strong></span><span class="campaign-summary">${escapeHtml(summary)}</span><span class="disclosure" aria-hidden="true"></span></summary>
    <div class="dossier-body">
      <div class="metric-grid">${drilldown.metrics.map((metric) => `<div class="metric-card"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}</strong></div>`).join("")}</div>
      <div class="evidence-grid">
        <section class="evidence-panel"><div class="panel-head"><h3>近 30 天趋势</h3><span class="legend"><span><i></i>花费</span><span><i></i>销售额</span></span></div>${trendImage ? `<img class="trend-image" alt="活动花费与销售额趋势" src="data:image/png;base64,${trendImage}">` : '<p class="empty-state">成功返回空趋势。</p>'}</section>
        <section class="evidence-panel"><div class="panel-head"><h3>广告位表现</h3></div>${renderPlacementView(drilldown.placements, placementImage, defaultCurrency)}</section>
        <section class="evidence-panel"><div class="panel-head"><h3>活动结论</h3></div><p>${escapeHtml(drilldown.summary)}</p>${renderCampaignFindings(campaignFindings)}</section>
        <section class="evidence-panel"><div class="panel-head"><h3>层级覆盖</h3></div><div class="coverage-cards">${drilldown.sections.map((section) => `<article class="coverage-card"><span>${escapeHtml(section.title)}</span><strong>${escapeHtml(String(section.sampledCount))} / ${escapeHtml(String(section.totalCount))}</strong><small>${escapeHtml(section.summary)}</small></article>`).join("")}</div></section>
      </div>
      <div class="entity-details"><details class="all-entities"><summary>查看该 Campaign 的五类实体明细<span>已获取数据全部可翻页查看</span></summary>${drilldown.sections.map((section, sectionIndex) => renderNestedSection(section, defaultCurrency, `drill-${index}-${sectionIndex}`)).join("")}</details></div>
    </div>
  </details>`;
}

function renderCampaignFindings(findings) {
  if (findings.length === 0) return '<p class="empty-state">没有达到门槛的 Campaign 级判断。</p>';
  return findings.map((finding) => `<div class="campaign-finding"><strong>${escapeHtml(finding.priority)} · ${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.recommendation)}</p></div>`).join("");
}

function renderPlacementView(placements, image, defaultCurrency) {
  if (placements.length === 0 || !image) return '<p class="empty-state">该活动没有可用广告位数据。</p>';
  return `<div class="placement-layout"><img class="placement-image" alt="广告位花费份额" src="data:image/png;base64,${image}"><ul class="placement-list">${placements.map((placement) => `<li><span>${escapeHtml(placement.name)}</span><strong>${escapeHtml(formatValue(placement.share, "ratio", defaultCurrency))} · ${escapeHtml(formatValue(placement.cost, "currency", defaultCurrency))}</strong></li>`).join("")}</ul></div>`;
}

function renderNestedSection(section, defaultCurrency, tableId) {
  return `<details><summary>${escapeHtml(section.title)}<span>${escapeHtml(String(section.sampledCount))} / ${escapeHtml(String(section.totalCount))}</span></summary><p class="section-summary">${escapeHtml(section.summary)}</p>${renderSectionTable(section, defaultCurrency, tableId)}</details>`;
}

function renderSectionTable(section, defaultCurrency, tableId) {
  const safeId = escapeAttribute(tableId);
  const header = section.columns.map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join("");
  const body = section.rows.length === 0
    ? `<tr><td colspan="${section.columns.length || 1}" class="empty-state">成功返回空列表</td></tr>`
    : section.rows.map((row) => `<tr class="paged-row">${section.columns.map((column) => `<td>${escapeHtml(formatValue(row[column.key], column.format, column.currency || defaultCurrency))}</td>`).join("")}</tr>`).join("");
  return `<div data-paged-table data-page-size="${TABLE_PAGE_SIZE}" id="table-${safeId}"><div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div><div class="table-pager"><button type="button" class="pager-button" data-page-prev aria-label="上一页">上一页</button><span class="pager-status" data-page-status aria-live="polite"></span><button type="button" class="pager-button" data-page-next aria-label="下一页">下一页</button></div></div>`;
}

function renderTrendPng(points) {
  const usable = points.filter((point) => Number.isFinite(point.cost) || Number.isFinite(point.sales));
  if (usable.length === 0) return null;
  const width = 680;
  const height = 220;
  const padding = { left: 26, right: 16, top: 16, bottom: 24 };
  const raster = createRaster(width, height, [255, 255, 255, 255]);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  for (let index = 0; index <= 4; index += 1) {
    const y = Math.round(padding.top + (plotHeight * index) / 4);
    drawLine(raster, width, height, padding.left, y, width - padding.right, y, [229, 231, 238, 255], 1);
  }
  const maximum = Math.max(1, ...usable.flatMap((point) => [Number(point.cost) || 0, Number(point.sales) || 0]));
  const xFor = (index) => usable.length === 1
    ? Math.round(padding.left + plotWidth / 2)
    : Math.round(padding.left + (plotWidth * index) / (usable.length - 1));
  const yFor = (value) => Math.round(padding.top + plotHeight - ((Number(value) || 0) / maximum) * plotHeight);
  drawSeries(raster, width, height, usable.map((point, index) => [xFor(index), yFor(point.cost)]), [98, 87, 217, 255]);
  drawSeries(raster, width, height, usable.map((point, index) => [xFor(index), yFor(point.sales)]), [15, 143, 135, 255]);
  return encodePng(width, height, raster).toString("base64");
}

function renderPlacementPng(placements) {
  const values = placements.map((placement) => Math.max(0, Number(placement.share) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const width = 180;
  const height = 180;
  const raster = createRaster(width, height, [255, 255, 255, 0]);
  const colors = [
    [98, 87, 217, 255],
    [15, 143, 135, 255],
    [201, 71, 82, 255],
    [169, 103, 22, 255],
    [125, 134, 153, 255],
  ];
  const cumulative = [];
  values.reduce((sum, value) => {
    const next = sum + value / total;
    cumulative.push(next);
    return next;
  }, 0);
  const centerX = width / 2;
  const centerY = height / 2;
  const outer = 72;
  const inner = 43;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < inner || distance > outer) continue;
      const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
      const ratio = angle / (Math.PI * 2);
      const colorIndex = cumulative.findIndex((limit) => ratio <= limit);
      setPixel(raster, width, height, x, y, colors[Math.max(0, colorIndex)]);
    }
  }
  return encodePng(width, height, raster).toString("base64");
}

function createRaster(width, height, color) {
  const raster = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < raster.length; offset += 4) {
    raster[offset] = color[0];
    raster[offset + 1] = color[1];
    raster[offset + 2] = color[2];
    raster[offset + 3] = color[3];
  }
  return raster;
}

function drawSeries(raster, width, height, points, color) {
  for (let index = 1; index < points.length; index += 1) {
    drawLine(raster, width, height, points[index - 1][0], points[index - 1][1], points[index][0], points[index][1], color, 3);
  }
  for (const [x, y] of points) drawCircle(raster, width, height, x, y, 3, color);
}

function drawLine(raster, width, height, x0, y0, x1, y1, color, thickness) {
  let currentX = x0;
  let currentY = y0;
  const deltaX = Math.abs(x1 - x0);
  const stepX = x0 < x1 ? 1 : -1;
  const deltaY = -Math.abs(y1 - y0);
  const stepY = y0 < y1 ? 1 : -1;
  let error = deltaX + deltaY;
  while (true) {
    drawCircle(raster, width, height, currentX, currentY, Math.max(0, thickness - 1), color);
    if (currentX === x1 && currentY === y1) break;
    const doubled = 2 * error;
    if (doubled >= deltaY) {
      error += deltaY;
      currentX += stepX;
    }
    if (doubled <= deltaX) {
      error += deltaX;
      currentY += stepY;
    }
  }
}

function drawCircle(raster, width, height, centerX, centerY, radius, color) {
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) {
        setPixel(raster, width, height, x, y, color);
      }
    }
  }
}

function setPixel(raster, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  raster[offset] = color[0];
  raster[offset + 1] = color[1];
  raster[offset + 2] = color[2];
  raster[offset + 3] = color[3];
}

function encodePng(width, height, raster) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const targetOffset = y * (width * 4 + 1);
    scanlines[targetOffset] = 0;
    raster.copy(scanlines, targetOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatValue(value, format, currency) {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "string") return String(value);
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (format === "currency") {
    try {
      return new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: 2,
      }).format(number);
    } catch {
      return `${number.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} ${currency || ""}`.trim();
    }
  }
  if (format === "count") {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(number);
  }
  if (format === "ratio") {
    return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(number);
  }
  if (format === "percent") {
    return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number)}%`;
  }
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number);
}

function statusLabel(status) {
  return ({ red: "高风险", yellow: "需关注", green: "健康", insufficient: "数据不足" })[status];
}

function confidenceLabel(confidence) {
  return ({ high: "高置信", medium: "中置信", low: "低置信" })[confidence];
}

function modeLabel(mode) {
  return ({
    "evidence-driven": "证据驱动",
    "campaign-drilldown": "逐活动下钻（兼容模式）",
    "portfolio-sample": "组合采样（兼容模式）",
  })[mode];
}

function modeCoverageLabel(report) {
  if (report.analysisMode === "evidence-driven") {
    const known = (report.coverage.entities || []).filter((item) => item.spendCoverage !== null);
    const childKnown = known.filter((item) => item.key !== "campaign");
    const minimum = childKnown.length ? Math.min(...childKnown.map((item) => item.spendCoverage)) : null;
    const coverage = minimum === null ? "部分实体覆盖度未知" : `核心实体最低花费覆盖 ${formatValue(minimum, "ratio")}`;
    return `${coverage} · 证据命中 ${report.campaignDrilldowns.length} 个 Campaign`;
  }
  if (report.analysisMode === "campaign-drilldown") {
    return `${report.coverage.fullyDrilledCampaignIds.length} / ${report.coverage.enabledCampaignCount} 个启用 Campaign 已下钻`;
  }
  return `${report.coverage.enabledCampaignCount} 个启用 Campaign · 兼容旧报告`;
}

function sectionLabel(key, fallback) {
  return ({
    campaign: "Campaign",
    adGroup: "广告组",
    productAds: "推广商品",
    keywords: "关键词",
    targets: "商品投放",
    searchQuery: "搜索词",
  })[key] || fallback || key;
}

function coverageStatusLabel(status) {
  return ({ complete: "完整分页", "target-reached": "达到目标", unknown: "覆盖度未知" })[status];
}

function targetLevelLabel(level) {
  return ({ campaign: "Campaign", adGroup: "广告组" })[level] || level;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, "");
}

async function writeAtomicReport(outputDir, marketplace, html) {
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const safeMarketplace = String(marketplace).toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "unknown";
  const base = `ads-audit-${safeMarketplace}-${timestamp}`;
  const temporaryPath = resolve(outputDir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, html, { encoding: "utf8", mode: 0o600 });
  try {
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const reportPath = resolve(outputDir, `${base}${suffix === 0 ? "" : `-${suffix + 1}`}.html`);
      try {
        await link(temporaryPath, reportPath);
        return reportPath;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new ReportError("REPORT_WRITE_FAILED", "无法创建唯一报告文件名。");
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
