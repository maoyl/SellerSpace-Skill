#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_SECTION_ROWS = 50;
const MAX_DRILLDOWNS = 3;
const MAX_TREND_POINTS = 60;
const MAX_PLACEMENTS = 5;
const CORE_SECTION_KEYS = [
  "campaign",
  "adGroup",
  "productAds",
  "keywords",
  "targets",
  "searchQuery",
];
const CHILD_SECTION_KEYS = CORE_SECTION_KEYS.slice(1);
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
  requireEnum(report.analysisMode, ["campaign-drilldown", "portfolio-sample"], "analysisMode");
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
  if (report.overview.length > 6) {
    throw new ReportError("REPORT_SECTION_TOO_LARGE", "overview 不能超过 6 个指标。");
  }
  for (const [index, metric] of report.overview.entries()) {
    validateMetric(metric, `overview[${index}]`);
  }

  requireArray(report.findings, "findings");
  for (const [index, finding] of report.findings.entries()) {
    validateFinding(finding, `findings[${index}]`);
  }

  requireArray(report.sections, "sections");
  for (const [index, section] of report.sections.entries()) {
    validateSection(section, `sections[${index}]`);
  }

  requireArray(report.campaignDrilldowns, "campaignDrilldowns");
  if (report.campaignDrilldowns.length > MAX_DRILLDOWNS) {
    throw new ReportError("REPORT_SECTION_TOO_LARGE", "campaignDrilldowns 不能超过 3 个活动。");
  }
  for (const [index, drilldown] of report.campaignDrilldowns.entries()) {
    validateCampaignDrilldown(drilldown, `campaignDrilldowns[${index}]`);
  }

  requireObject(report.coverage, "coverage");
  requireStringArray(report.coverage.operations, "coverage.operations");
  requireStringArray(report.coverage.entitySections, "coverage.entitySections");
  requireScalarArray(report.coverage.historyCampaignIds, "coverage.historyCampaignIds");
  requireScalarArray(report.coverage.placementCampaignIds, "coverage.placementCampaignIds");
  requireNonNegativeInteger(report.coverage.enabledCampaignCount, "coverage.enabledCampaignCount");
  requireScalarArray(report.coverage.fullyDrilledCampaignIds, "coverage.fullyDrilledCampaignIds");
  requireNonNegativeInteger(report.coverage.businessCallCount, "coverage.businessCallCount");
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
  optionalString(finding.campaignId, `${path}.campaignId`);
  requireString(finding.entityType, `${path}.entityType`);
  optionalString(finding.entityId, `${path}.entityId`);
  requireString(finding.entityName, `${path}.entityName`);
  requireString(finding.title, `${path}.title`);
  requireArray(finding.evidence, `${path}.evidence`);
  for (const [metricIndex, metric] of finding.evidence.entries()) {
    validateMetric(metric, `${path}.evidence[${metricIndex}]`, false);
  }
  requireString(finding.reasoning, `${path}.reasoning`);
  requireString(finding.recommendation, `${path}.recommendation`);
  requireEnum(finding.confidence, ["high", "medium", "low"], `${path}.confidence`);
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
  for (const [columnIndex, column] of section.columns.entries()) {
    const columnPath = `${path}.columns[${columnIndex}]`;
    requireObject(column, columnPath);
    requireString(column.key, `${columnPath}.key`);
    requireString(column.label, `${columnPath}.label`);
    requireEnum(
      column.format,
      ["currency", "count", "ratio", "percent", "number", "string"],
      `${columnPath}.format`,
    );
    optionalString(column.currency, `${columnPath}.currency`);
  }
  requireArray(section.rows, `${path}.rows`);
  if (section.rows.length > MAX_SECTION_ROWS) {
    throw new ReportError("REPORT_SECTION_TOO_LARGE", `${path}.rows 不能超过 50 行。`);
  }
  if (section.rows.length !== section.sampledCount) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path}.sampledCount 必须等于 rows 行数。`);
  }
  for (const [rowIndex, row] of section.rows.entries()) {
    requireObject(row, `${path}.rows[${rowIndex}]`);
  }
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
  if (drilldown.metrics.length > 4) {
    throw new ReportError("REPORT_SECTION_TOO_LARGE", `${path}.metrics 不能超过 4 个指标。`);
  }
  for (const [index, metric] of drilldown.metrics.entries()) {
    validateMetric(metric, `${path}.metrics[${index}]`);
  }
  requireArray(drilldown.trend, `${path}.trend`);
  if (drilldown.trend.length > MAX_TREND_POINTS) {
    throw new ReportError("REPORT_SECTION_TOO_LARGE", `${path}.trend 不能超过 60 个点。`);
  }
  for (const [index, point] of drilldown.trend.entries()) {
    const pointPath = `${path}.trend[${index}]`;
    requireObject(point, pointPath);
    requireString(point.date, `${pointPath}.date`);
    requireNullableFiniteNumber(point.cost, `${pointPath}.cost`);
    requireNullableFiniteNumber(point.sales, `${pointPath}.sales`);
    requireNullableFiniteNumber(point.acos, `${pointPath}.acos`);
  }
  requireArray(drilldown.placements, `${path}.placements`);
  if (drilldown.placements.length > MAX_PLACEMENTS) {
    throw new ReportError("REPORT_SECTION_TOO_LARGE", `${path}.placements 不能超过 5 个广告位。`);
  }
  for (const [index, placement] of drilldown.placements.entries()) {
    const placementPath = `${path}.placements[${index}]`;
    requireObject(placement, placementPath);
    requireString(placement.name, `${placementPath}.name`);
    requireNullableFiniteNumber(placement.cost, `${placementPath}.cost`);
    requireNullableFiniteNumber(placement.sales, `${placementPath}.sales`);
    requireNullableFiniteNumber(placement.share, `${placementPath}.share`);
  }
  requireArray(drilldown.sections, `${path}.sections`);
  for (const [index, section] of drilldown.sections.entries()) {
    validateSection(section, `${path}.sections[${index}]`);
  }
  requireExactSectionKeys(drilldown.sections, CHILD_SECTION_KEYS, `${path}.sections`);
}

function validateModeConsistency(report) {
  const enabledCount = report.coverage.enabledCampaignCount;
  const topLevelKeys = report.sections.map((section) => section.key);
  const drilldownIds = report.campaignDrilldowns.map((item) => String(item.campaignId));
  const uniqueDrilldownIds = new Set(drilldownIds);
  if (uniqueDrilldownIds.size !== drilldownIds.length) {
    throw new ReportError("INVALID_REPORT_INPUT", "campaignDrilldowns 包含重复 campaignId。");
  }

  if (report.analysisMode === "campaign-drilldown") {
    if (enabledCount > MAX_DRILLDOWNS) {
      throw new ReportError("INVALID_REPORT_INPUT", "campaign-drilldown 仅适用于 0 到 3 个启用活动。");
    }
    requireExactSectionKeys(report.sections, ["campaign"], "sections");
    if (report.campaignDrilldowns.length !== enabledCount) {
      throw new ReportError("INCOMPLETE_REPORT_INPUT", "每个启用活动都必须有一个 campaignDrilldowns 条目。");
    }
    requireSameIdSet(
      report.coverage.fullyDrilledCampaignIds,
      drilldownIds,
      "fullyDrilledCampaignIds 必须与逐活动下钻范围一致。",
    );
    requireSameIdSet(
      report.coverage.historyCampaignIds,
      drilldownIds,
      "campaign-drilldown 必须查询每个启用活动的历史趋势。",
    );
    const spCampaignIds = report.campaignDrilldowns
      .filter((item) => item.adType.toUpperCase() === "SP")
      .map((item) => String(item.campaignId));
    requireSameIdSet(
      report.coverage.placementCampaignIds,
      spCampaignIds,
      "campaign-drilldown 必须查询每个 SP 活动的广告位数据。",
    );
    if (report.coverage.businessCallCount > 24) {
      throw new ReportError("INVALID_REPORT_INPUT", "campaign-drilldown 业务调用不能超过 24 次。");
    }
  } else {
    if (enabledCount <= MAX_DRILLDOWNS) {
      throw new ReportError("INVALID_REPORT_INPUT", "portfolio-sample 仅适用于超过 3 个启用活动。");
    }
    requireExactSectionKeys(report.sections, CORE_SECTION_KEYS, "sections");
    if (report.campaignDrilldowns.length !== 0
      || report.coverage.fullyDrilledCampaignIds.length !== 0) {
      throw new ReportError("INVALID_REPORT_INPUT", "portfolio-sample 不得声明逐活动完整下钻。");
    }
    if (report.coverage.businessCallCount > 13) {
      throw new ReportError("INVALID_REPORT_INPUT", "portfolio-sample 业务调用不能超过 13 次。");
    }
  }

  if (new Set(topLevelKeys).size !== topLevelKeys.length) {
    throw new ReportError("INVALID_REPORT_INPUT", "sections 包含重复 key。");
  }
}

function requireExactSectionKeys(sections, expected, path) {
  const actual = sections.map((section) => section.key);
  if (new Set(actual).size !== actual.length
    || actual.length !== expected.length
    || expected.some((key) => !actual.includes(key))) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path} 必须恰好包含：${expected.join("、")}。`,
    );
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

function requireNonNegativeInteger(value, path) {
  requireFiniteNumber(value, path);
  if (!Number.isInteger(value) || value < 0) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是非负整数。`);
  }
}

function requireScalar(value, path) {
  if (!['string', 'number'].includes(typeof value)
    || (typeof value === "number" && !Number.isFinite(value))) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是字符串或有限数字。`);
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
    throw new ReportError(
      "INVALID_REPORT_INPUT",
      `${path} 必须是：${allowed.join("、")}。`,
    );
  }
}

function requireDate(value, path) {
  requireString(value, path);
  if (Number.isNaN(Date.parse(value))) {
    throw new ReportError("INVALID_REPORT_INPUT", `${path} 必须是有效日期时间。`);
  }
}

function renderReport(report, logo) {
  const title = `${report.scope.marketplace} 亚马逊广告体检报告`;
  const campaignSection = report.sections.find((section) => section.key === "campaign");
  const problems = report.findings.filter((finding) => finding.kind !== "opportunity");
  const opportunities = report.findings.filter((finding) => finding.kind === "opportunity");
  const portfolioSections = report.analysisMode === "portfolio-sample"
    ? report.sections.filter((section) => section.key !== "campaign")
    : [];

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--ink:#172038;--ink-soft:#35405c;--muted:#72798b;--line:#e5e7ee;--line-strong:#d7dbea;--paper:#fff;--canvas:#f7f7fa;--violet:#6257d9;--violet-soft:#f0effc;--teal:#0f9f95;--teal-soft:#e9f8f6;--red:#d65059;--red-soft:#fdf0f1;--amber:#bf7b20;--amber-soft:#fff6e8;--green:#25866f;--green-soft:#edf8f3;--gray:#8790a4;--gray-soft:#f1f3f6}
    *{box-sizing:border-box}html{background:var(--canvas)}body{margin:0;color:var(--ink);font:14px/1.58 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}button,summary{font:inherit}summary:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
    main{max-width:1440px;margin:0 auto;padding:12px 14px 36px}.sheet{background:var(--paper);border:1px solid var(--line);box-shadow:0 10px 30px rgba(28,34,56,.05)}
    .masthead{min-height:70px;padding:12px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{display:flex;align-items:center;gap:22px;min-width:0}.brand img{width:182px;max-height:48px;object-fit:contain;object-position:left center}.report-heading{padding-left:22px;border-left:1px solid var(--line);min-width:0}.report-heading h1{margin:0;font-size:24px;line-height:1.18;letter-spacing:-.02em}.meta{margin-top:5px;display:flex;flex-wrap:wrap;gap:3px 15px;color:var(--muted);font-size:11px}.scope-pill{border:1px solid #d7d4f4;background:var(--violet-soft);color:#4940a5;padding:7px 11px;border-radius:7px;font-weight:700;white-space:nowrap}
    .intro{padding:15px 24px 0}.lede{max-width:none;margin:0;color:var(--ink-soft);font-size:13px}.lede strong{color:var(--ink);margin-right:6px}.health-line{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));margin-top:13px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.health-item{padding:8px 12px;border-right:1px solid var(--line);min-width:0}.health-item:last-child{border-right:0}.health-label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--gray);flex:0 0 auto}.status-red .status-dot{background:var(--red)}.status-yellow .status-dot{background:var(--amber)}.status-green .status-dot{background:var(--green)}.health-item strong{display:inline-block;margin:3px 8px 0 0;font-size:14px}.health-item p{display:inline;margin:0;color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .number-band{display:grid;grid-template-columns:130px repeat(auto-fit,minmax(130px,1fr));margin:15px 24px 0;background:#f6f5fd;border:1px solid #ebe9fa;border-radius:6px}.band-label{display:flex;align-items:center;padding:11px 15px;font-size:16px;font-weight:800;border-right:1px solid #e2dff5}.number-cell{padding:9px 14px;text-align:center;border-right:1px solid #e2dff5}.number-cell:last-child{border-right:0}.number-cell span{display:block;color:var(--ink-soft);font-size:10px}.number-cell strong{display:block;margin-top:1px;color:var(--violet);font-size:18px;letter-spacing:-.01em}
    .editorial{display:grid;grid-template-columns:minmax(0,2.15fr) minmax(280px,1fr);gap:30px;padding:20px 24px 22px}.section-title{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:8px}.section-title h2{margin:0;font-size:18px;letter-spacing:-.01em}.section-title p{margin:0;color:var(--muted);font-size:10px}.decision-list{border-top:1px solid var(--line-strong)}.decision-row{display:grid;grid-template-columns:48px minmax(0,1fr);gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}.priority{font-size:12px;font-weight:900;color:var(--violet);letter-spacing:.06em}.priority-p1{color:var(--red)}.priority-p2{color:var(--amber)}.decision-row h3{margin:0;font-size:14px}.entity{margin:1px 0 5px;color:var(--muted);font-size:10px}.evidence{display:flex;flex-wrap:wrap;gap:3px 10px;color:var(--ink-soft);font-size:10px}.evidence span{border-bottom:1px solid var(--line-strong)}.decision-copy{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin-top:5px}.decision-copy p{margin:0;color:var(--muted);font-size:10px;line-height:1.45}.decision-copy strong{color:var(--ink-soft)}
    .aside-section{padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--line)}.aside-section:last-child{border-bottom:0;margin-bottom:0}.aside-section h2{margin:0 0 7px;font-size:14px}.aside-section h3{margin:8px 0 3px;font-size:11px}.opportunity{padding:6px 0;border-top:1px solid var(--line)}.opportunity:first-of-type{border-top:0;padding-top:0}.opportunity strong{display:block;font-size:11px}.opportunity p{margin:2px 0 0;color:var(--muted);font-size:10px}.coverage-list{display:grid;grid-template-columns:1fr auto 1fr auto;gap:3px 10px;margin:0;font-size:10px}.coverage-list dt{color:var(--muted)}.coverage-list dd{margin:0;font-weight:700;text-align:right}.note-list{margin:0;padding-left:15px;color:var(--muted);font-size:10px}.note-list li+li{margin-top:2px}.empty{color:var(--muted);margin:8px 0}
    .panorama{padding:10px 24px 14px;border-top:1px solid var(--line)}.panorama>.section-title{margin-bottom:4px}.mode-note{color:var(--teal);font-weight:700}.table-wrap{overflow-x:auto;border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong)}table{width:100%;border-collapse:collapse;min-width:680px}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top;font-size:10px}th{color:var(--muted);font-size:9px;font-weight:700;letter-spacing:.03em;background:#fafafd}tbody tr:last-child td{border-bottom:0}
    .dossiers{border-top:1px solid var(--line-strong)}.campaign-table-head{display:grid;grid-template-columns:32px minmax(180px,1.4fr) repeat(4,minmax(72px,.6fr)) minmax(150px,1.1fr) 34px;gap:9px;padding:5px 2px;color:var(--muted);font-size:9px;background:#fafafd;border-bottom:1px solid var(--line)}.dossier{border-bottom:1px solid var(--line-strong)}.dossier>summary{cursor:pointer;list-style:none;display:grid;grid-template-columns:32px minmax(180px,1.4fr) repeat(4,minmax(72px,.6fr)) minmax(150px,1.1fr) 34px;gap:9px;align-items:center;padding:5px 2px}.dossier>summary::-webkit-details-marker{display:none}.campaign-index{font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}.campaign-title small{display:block;color:var(--muted);font-size:8px;letter-spacing:.04em}.campaign-title strong{display:block;margin-top:1px;font-size:10px}.row-metric small{display:none}.row-metric strong{font-size:9px}.campaign-summary{color:var(--muted);font-size:8px;line-height:1.3}.disclosure{color:var(--violet);font-size:9px;font-weight:700}.disclosure::after{content:"展开"}.dossier[open] .disclosure::after{content:"收起"}.dossier-body{padding:5px 7px 7px 41px;background:#fbfbfe}.evidence-grid{display:grid;grid-template-columns:minmax(150px,.85fr) minmax(260px,1.6fr) minmax(200px,1.05fr) minmax(190px,1.05fr);gap:8px}.evidence-panel{min-width:0;padding-right:7px;border-right:1px solid var(--line)}.evidence-panel:last-child{padding-right:0;border-right:0}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:7px;margin-bottom:2px}.panel-head h3{margin:0;font-size:9px}.legend{display:flex;gap:7px;color:var(--muted);font-size:7px}.legend span{display:flex;align-items:center;gap:3px}.legend i{width:8px;height:2px;background:var(--violet)}.legend span+span i{background:var(--teal)}.trend-image{display:block;width:100%;height:78px;object-fit:contain}.placement-layout{display:grid;grid-template-columns:62px 1fr;align-items:center;gap:5px}.placement-image{display:block;width:60px;height:60px}.placement-list{list-style:none;margin:0;padding:0}.placement-list li{display:grid;grid-template-columns:1fr auto;gap:4px;padding:2px 0;border-bottom:1px solid var(--line);font-size:7px}.placement-list li:last-child{border-bottom:0}.placement-list span{color:var(--muted)}
    .entity-coverage{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.entity-count{padding:3px 4px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.entity-count span{display:block;color:var(--muted);font-size:7px}.entity-count strong{font-size:8px}.campaign-findings h3{margin:0 0 3px;font-size:9px}.campaign-finding{padding:3px 0;border-top:1px solid var(--line)}.campaign-finding strong{display:block;font-size:8px}.campaign-finding p{margin:1px 0 0;color:var(--muted);font-size:7px;line-height:1.3}.entity-details{margin-top:4px;border-top:1px solid var(--line)}.entity-details details{border-bottom:1px solid var(--line)}.entity-details summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:8px;font-weight:700}.entity-details summary::-webkit-details-marker{display:none}.entity-details summary span{color:var(--muted);font-weight:500;font-size:7px}.entity-details .table-wrap{margin-bottom:7px}.section-summary{margin:0 0 4px;color:var(--muted);font-size:7px}
    .portfolio-entities{margin-top:18px}.portfolio-section{padding-top:15px;margin-top:15px;border-top:1px solid var(--line-strong)}.portfolio-section:first-child{margin-top:0}.footer{padding:9px 24px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;color:var(--muted);font-size:9px}
    @media(max-width:900px){.brand img{width:150px}.report-heading h1{font-size:20px}.health-line{grid-template-columns:repeat(2,1fr)}.health-item{border-bottom:1px solid var(--line)}.number-band{grid-template-columns:repeat(2,1fr)}.band-label{grid-column:1/-1;border-right:0;border-bottom:1px solid #e2dff5}.number-cell{border-bottom:1px solid #e2dff5}.editorial{grid-template-columns:1fr}.campaign-table-head{display:none}.dossier>summary{grid-template-columns:32px minmax(170px,1fr) repeat(2,minmax(70px,.5fr)) 34px}.dossier>summary .row-metric:nth-of-type(n+5),.campaign-summary{display:none}.dossier-body{padding-left:41px}.evidence-grid{grid-template-columns:1fr 1fr}.evidence-panel{border-right:0}.entity-coverage{grid-template-columns:repeat(2,1fr)}}
    @media(max-width:560px){main{padding:0}.sheet{border:0;box-shadow:none}.masthead{padding:11px 15px;align-items:flex-start}.brand{gap:10px}.brand img{width:112px}.report-heading{padding-left:10px}.report-heading h1{font-size:16px}.meta{font-size:9px}.scope-pill{font-size:9px;padding:5px 7px}.intro,.editorial,.panorama{padding-left:15px;padding-right:15px}.health-line{grid-template-columns:1fr}.health-item{border-right:0}.number-band{margin-left:15px;margin-right:15px;grid-template-columns:1fr 1fr}.number-cell{padding:8px}.number-cell strong{font-size:16px}.decision-copy{grid-template-columns:1fr}.coverage-list{grid-template-columns:1fr auto}.dossier>summary{grid-template-columns:28px 1fr auto;min-height:44px;padding:8px 0}.dossier>summary .row-metric,.campaign-summary{display:none}.campaign-title small{font-size:9px}.campaign-title strong{font-size:12px}.disclosure{font-size:11px}.dossier-body{padding-left:0}.evidence-grid{grid-template-columns:1fr}.evidence-panel{padding:8px 0;border-right:0;border-bottom:1px solid var(--line)}.panel-head h3{font-size:11px}.placement-layout{grid-template-columns:80px 1fr}.placement-list li,.campaign-finding p,.entity-count span{font-size:9px}.entity-count strong,.campaign-finding strong{font-size:10px}.entity-coverage{grid-template-columns:1fr 1fr}.entity-details summary{min-height:44px;align-items:center;font-size:10px}.footer{padding:12px 15px;display:block}.footer span{display:block;margin-top:3px}}
    @media print{html,body{background:#fff}main{max-width:none;padding:0}.sheet{border:0;box-shadow:none}.scope-pill{border-color:#bbb}.dossier,.portfolio-section,.decision-row{break-inside:avoid}.dossier:not([open])>.dossier-body,.entity-details details:not([open])>*:not(summary){display:block}.disclosure{display:none}.table-wrap{overflow:visible}table{min-width:0}.footer{display:none}}
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
    <section class="editorial">
      <div>
        <div class="section-title"><h2>本期判断</h2><p>按证据门槛排序</p></div>
        <div class="decision-list">${renderDecisionRows(problems, report.scope.currency)}</div>
      </div>
      <aside>
        <section class="aside-section"><h2>增长机会</h2>${renderOpportunities(opportunities, report.scope.currency)}</section>
        <section class="aside-section"><h2>覆盖与限制</h2>${renderCoverage(report)}<h3>口径与限制</h3>${renderMethodNotes(report)}</section>
      </aside>
    </section>
    <section class="panorama">
      <div class="section-title"><div><h2>活动全景</h2><p>${escapeHtml(campaignSection.summary)}</p></div><p class="mode-note">${escapeHtml(modeCoverageLabel(report))}</p></div>
      ${report.analysisMode === "campaign-drilldown"
        ? renderCampaignDossiers(report)
        : `${renderSectionTable(campaignSection, report.scope.currency)}${renderPortfolioSections(portfolioSections, report.scope.currency)}`}
    </section>
    <footer class="footer"><span>由 SellerSpace MCP 只读数据生成</span><span>未执行任何广告修改 · 明细样本按花费降序</span></footer>
  </article>
</main>
</body>
</html>`;
}

function renderRatings(ratings) {
  return ratings.map((rating) => `
    <div class="health-item status-${escapeAttribute(rating.status)}">
      <span class="health-label"><i class="status-dot"></i>${escapeHtml(rating.label)}</span>
      <strong>${escapeHtml(statusLabel(rating.status))}</strong>
      <p title="${escapeHtml(rating.summary)}">${escapeHtml(rating.summary)}</p>
    </div>`).join("");
}

function renderOverview(metrics, defaultCurrency) {
  if (metrics.length === 0) {
    return '<div class="number-cell"><span>广告大盘</span><strong>—</strong></div>';
  }
  return metrics.slice(0, 6).map((metric) => `
    <div class="number-cell"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}</strong></div>`).join("");
}

function renderDecisionRows(findings, defaultCurrency) {
  if (findings.length === 0) return '<p class="empty">未发现达到证据门槛的问题。</p>';
  return findings.map((finding) => renderDecisionRow(finding, defaultCurrency)).join("");
}

function renderDecisionRow(finding, defaultCurrency) {
  return `
    <article class="decision-row">
      <div class="priority priority-${escapeAttribute(finding.priority.toLowerCase())}">${escapeHtml(finding.priority)}</div>
      <div>
        <h3>${escapeHtml(finding.title)}</h3>
        <p class="entity">${escapeHtml(finding.entityName)} · ${escapeHtml(finding.entityType)} · ${escapeHtml(confidenceLabel(finding.confidence))}</p>
        <div class="evidence">${finding.evidence.map((metric) => `<span>${escapeHtml(metric.label)} ${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}</span>`).join("")}</div>
        <div class="decision-copy"><p><strong>判断：</strong>${escapeHtml(finding.reasoning)}</p><p><strong>建议：</strong>${escapeHtml(finding.recommendation)}</p></div>
      </div>
    </article>`;
}

function renderOpportunities(findings, defaultCurrency) {
  if (findings.length === 0) return '<p class="empty">本期未发现达到门槛的扩量机会。</p>';
  return findings.map((finding) => `
    <article class="opportunity">
      <strong>${escapeHtml(finding.title)}</strong>
      <p>${escapeHtml(finding.entityName)} · ${finding.evidence.map((metric) => `${escapeHtml(metric.label)} ${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}`).join(" · ")}</p>
      <p>${escapeHtml(finding.recommendation)}</p>
    </article>`).join("");
}

function renderCoverage(report) {
  return `<dl class="coverage-list">
    <dt>查询模式</dt><dd>${escapeHtml(modeLabel(report.analysisMode))}</dd>
    <dt>启用活动</dt><dd>${escapeHtml(String(report.coverage.enabledCampaignCount))}</dd>
    <dt>完整下钻</dt><dd>${escapeHtml(String(report.coverage.fullyDrilledCampaignIds.length))}</dd>
    <dt>趋势覆盖</dt><dd>${escapeHtml(String(report.coverage.historyCampaignIds.length))}</dd>
    <dt>广告位覆盖</dt><dd>${escapeHtml(String(report.coverage.placementCampaignIds.length))}</dd>
    <dt>业务查询</dt><dd>${escapeHtml(String(report.coverage.businessCallCount))} 次</dd>
  </dl>`;
}

function renderMethodNotes(report) {
  const notes = [
    ...report.assumptions.map((item) => `假设：${item}`),
    ...report.limitations.map((item) => `限制：${item}`),
  ];
  return renderList(notes, "note-list");
}

function renderCampaignDossiers(report) {
  if (report.campaignDrilldowns.length === 0) {
    return '<div class="dossiers"><p class="empty">当前没有启用中的广告活动，无需继续下钻。</p></div>';
  }
  const headerMetrics = Array.from(
    { length: 4 },
    (_, index) => report.campaignDrilldowns[0].metrics[index] || { label: "指标" },
  );
  return `<div class="dossiers"><div class="campaign-table-head"><span>#</span><span>活动（状态）</span>${headerMetrics.map((metric) => `<span>${escapeHtml(metric.label)}</span>`).join("")}<span>诊断摘要</span><span></span></div>${report.campaignDrilldowns.map((drilldown, index) => renderCampaignDossier(
    drilldown,
    index,
    report.findings,
    report.scope.currency,
  )).join("")}</div>`;
}

function renderCampaignDossier(drilldown, index, findings, defaultCurrency) {
  const campaignId = String(drilldown.campaignId);
  const campaignFindings = findings.filter((finding) => String(finding.campaignId || "") === campaignId);
  const trendImage = renderTrendPng(drilldown.trend);
  const placementImage = renderPlacementPng(drilldown.placements);
  return `
    <details class="dossier"${index === 0 ? " open" : ""}>
      <summary>
        <span class="campaign-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="campaign-title"><small>${escapeHtml(drilldown.adType)} · ENABLED · ${escapeHtml(statusLabel(drilldown.healthStatus))}</small><strong>${escapeHtml(drilldown.campaignName)}</strong></span>
        ${renderCampaignRowMetrics(drilldown.metrics, defaultCurrency)}
        <span class="campaign-summary">${escapeHtml(drilldown.summary)}</span>
        <span class="disclosure" aria-hidden="true"></span>
      </summary>
      <div class="dossier-body">
        <div class="evidence-grid">
          <section class="evidence-panel">
            <div class="panel-head"><h3>层级覆盖</h3></div>
            <div class="entity-coverage">${drilldown.sections.map((section) => `<div class="entity-count"><span>${escapeHtml(section.title)}</span><strong>${escapeHtml(String(section.sampledCount))} / ${escapeHtml(String(section.totalCount))}</strong></div>`).join("")}</div>
          </section>
          <section class="evidence-panel">
            <div class="panel-head"><h3>近期待势</h3><span class="legend"><span><i></i>花费</span><span><i></i>销售额</span></span></div>
            ${trendImage ? `<img class="trend-image" alt="活动花费与销售额趋势" src="data:image/png;base64,${trendImage}">` : '<p class="empty">成功返回空趋势。</p>'}
          </section>
          <section class="evidence-panel">
            <div class="panel-head"><h3>广告位分布</h3></div>
            ${renderPlacementView(drilldown.placements, placementImage, defaultCurrency)}
          </section>
          <section class="evidence-panel campaign-findings">
            <div class="panel-head"><h3>活动结论</h3></div>
            <p class="campaign-summary">${escapeHtml(drilldown.summary)}</p>
            ${renderCampaignFindings(campaignFindings)}
          </section>
        </div>
        <div class="entity-details"><details class="all-entities"><summary>查看 5 类实体明细<span>每类最多 Top 50</span></summary><div class="entity-stack">${drilldown.sections.map((section) => renderNestedSection(section, defaultCurrency)).join("")}</div></details></div>
      </div>
    </details>`;
}

function renderCampaignRowMetrics(metrics, defaultCurrency) {
  return Array.from({ length: 4 }, (_, index) => {
    const metric = metrics[index];
    if (!metric) return '<span class="row-metric"><small>指标</small><strong>—</strong></span>';
    return `<span class="row-metric"><small>${escapeHtml(metric.label)}</small><strong>${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}</strong></span>`;
  }).join("");
}

function renderCampaignFindings(findings) {
  if (findings.length === 0) return '<p class="empty">未发现达到门槛的活动级判断。</p>';
  return findings.slice(0, 1).map((finding) => `<div class="campaign-finding"><strong>${escapeHtml(finding.priority)} · ${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.recommendation)}</p></div>`).join("");
}

function renderPlacementView(placements, image, defaultCurrency) {
  if (placements.length === 0 || !image) return '<p class="empty">该广告类型没有可用广告位数据。</p>';
  return `<div class="placement-layout">
    <img class="placement-image" alt="广告位花费份额" src="data:image/png;base64,${image}">
    <ul class="placement-list">${placements.map((placement) => `<li><span>${escapeHtml(placement.name)}</span><strong>${escapeHtml(formatValue(placement.share, "ratio", defaultCurrency))} · ${escapeHtml(formatValue(placement.cost, "currency", defaultCurrency))}</strong></li>`).join("")}</ul>
  </div>`;
}

function renderNestedSection(section, defaultCurrency) {
  return `<details>
    <summary>${escapeHtml(section.title)}<span>展示 ${escapeHtml(String(section.sampledCount))} / ${escapeHtml(String(section.totalCount))}</span></summary>
    <p class="section-summary">${escapeHtml(section.summary)}</p>
    ${renderSectionTable(section, defaultCurrency)}
  </details>`;
}

function renderPortfolioSections(sections, defaultCurrency) {
  return `<div class="portfolio-entities">${sections.map((section) => `
    <section class="portfolio-section">
      <div class="section-title"><div><h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.summary)}</p></div><p>展示 ${escapeHtml(String(section.sampledCount))} / ${escapeHtml(String(section.totalCount))}</p></div>
      ${renderSectionTable(section, defaultCurrency)}
    </section>`).join("")}</div>`;
}

function renderSectionTable(section, defaultCurrency) {
  const header = section.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("");
  const body = section.rows.length === 0
    ? `<tr><td colspan="${section.columns.length || 1}" class="empty">成功返回空列表</td></tr>`
    : section.rows.map((row) => `<tr>${section.columns.map((column) => `<td>${escapeHtml(formatValue(row[column.key], column.format, column.currency || defaultCurrency))}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderList(items, className = "note-list") {
  if (items.length === 0) return '<p class="empty">—</p>';
  return `<ul class="${escapeAttribute(className)}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderTrendPng(points) {
  const usable = points.filter((point) => Number.isFinite(point.cost) || Number.isFinite(point.sales));
  if (usable.length === 0) return null;
  const width = 560;
  const height = 170;
  const padding = { left: 22, right: 14, top: 14, bottom: 20 };
  const raster = createRaster(width, height, [255, 255, 255, 255]);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  for (let index = 0; index <= 4; index += 1) {
    const y = Math.round(padding.top + (plotHeight * index) / 4);
    drawLine(raster, width, height, padding.left, y, width - padding.right, y, [229, 231, 238, 255], 1);
  }
  const maximum = Math.max(
    1,
    ...usable.flatMap((point) => [Number(point.cost) || 0, Number(point.sales) || 0]),
  );
  const xFor = (index) => usable.length === 1
    ? Math.round(padding.left + plotWidth / 2)
    : Math.round(padding.left + (plotWidth * index) / (usable.length - 1));
  const yFor = (value) => Math.round(padding.top + plotHeight - ((Number(value) || 0) / maximum) * plotHeight);
  drawSeries(raster, width, height, usable.map((point, index) => [xFor(index), yFor(point.cost)]), [98, 87, 217, 255]);
  drawSeries(raster, width, height, usable.map((point, index) => [xFor(index), yFor(point.sales)]), [15, 159, 149, 255]);
  return encodePng(width, height, raster).toString("base64");
}

function renderPlacementPng(placements) {
  const values = placements.map((placement) => Math.max(0, Number(placement.share) || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const width = 160;
  const height = 160;
  const raster = createRaster(width, height, [255, 255, 255, 0]);
  const colors = [
    [98, 87, 217, 255],
    [15, 159, 149, 255],
    [213, 80, 89, 255],
    [191, 123, 32, 255],
    [135, 144, 164, 255],
  ];
  const cumulative = [];
  values.reduce((sum, value) => {
    const next = sum + value / total;
    cumulative.push(next);
    return next;
  }, 0);
  const centerX = width / 2;
  const centerY = height / 2;
  const outer = 64;
  const inner = 38;
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
    drawLine(
      raster,
      width,
      height,
      points[index - 1][0],
      points[index - 1][1],
      points[index][0],
      points[index][1],
      color,
      3,
    );
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
  return mode === "campaign-drilldown" ? "逐活动下钻" : "组合采样";
}

function modeCoverageLabel(report) {
  if (report.analysisMode === "campaign-drilldown") {
    return `${report.coverage.fullyDrilledCampaignIds.length} / ${report.coverage.enabledCampaignCount} 个启用活动已完整下钻`;
  }
  return `${report.coverage.enabledCampaignCount} 个启用活动 · Top 50 组合采样`;
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
