#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const TABLE_PAGE_SIZE = 25;
const TAILWIND_CDN = "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4";
const ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js";
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
  "isolate-search-term",
  "negative-search-term",
  "increase-bid",
  "lower-bid",
  "pause",
  "increase-budget",
  "reduce-budget",
  "reallocate-budget",
  "increase-placement-bid",
  "lower-placement-bid",
  "adjust-placement",
  "review-structure",
  "observe",
];
const ACTION_GROUPS = [
  {
    key: "stop",
    label: "立即止损",
    description: "先处理明确浪费",
    types: [
      "negative-search-term",
      "lower-bid",
      "pause",
      "reduce-budget",
      "lower-placement-bid",
      "adjust-placement",
    ],
  },
  {
    key: "scale",
    label: "扩量机会",
    description: "有证据再扩大投入",
    types: [
      "increase-budget",
      "increase-bid",
      "increase-placement-bid",
      "harvest-search-term",
    ],
  },
  {
    key: "structure",
    label: "结构整理",
    description: "改善可控性与复盘",
    types: ["isolate-search-term", "reallocate-budget", "review-structure", "observe"],
  },
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
  report.findings.forEach((finding, index) => validateFinding(
    finding,
    `findings[${index}]`,
    report.analysisMode,
    report.baseline,
  ));

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

function validateFinding(finding, path, analysisMode, baseline) {
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
  if (finding.reasonBullets !== undefined) {
    requireStringArray(finding.reasonBullets, `${path}.reasonBullets`);
  }
  if (finding.caveats !== undefined) {
    requireStringArray(finding.caveats, `${path}.caveats`);
  }
  requireString(finding.recommendation, `${path}.recommendation`);
  requireEnum(finding.confidence, ["high", "medium", "low"], `${path}.confidence`);
  if (finding.action !== undefined && finding.action !== null) {
    validateAction(finding.action, `${path}.action`);
  }
  if (finding.dailyEvidence !== undefined) {
    validateDailyEvidence(finding.dailyEvidence, `${path}.dailyEvidence`);
  }
  if (finding.trendEvidence !== undefined) {
    validateTrendEvidence(finding.trendEvidence, `${path}.trendEvidence`);
  }
  if (finding.comparisonEvidence !== undefined) {
    validateComparisonEvidence(finding.comparisonEvidence, `${path}.comparisonEvidence`);
  }
  if (finding.placementEvidence !== undefined) {
    validatePlacementEvidence(finding.placementEvidence, `${path}.placementEvidence`);
  }
  if (analysisMode !== "evidence-driven") return;
  if (!finding.action) {
    throw new ReportError("INCOMPLETE_REPORT_INPUT", `${path}.action 是证据驱动报告的必填项。`);
  }
  if (!Array.isArray(finding.reasonBullets) || finding.reasonBullets.length < 1) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path}.reasonBullets 至少需要一条可核验原因。`,
    );
  }
  const hasBusinessTarget = baseline.source === "user-target"
    && (baseline.targetAcos !== null || baseline.targetRoas !== null);
  if (["increase-budget", "increase-bid", "increase-placement-bid"].includes(
    finding.action.type,
  ) && !hasBusinessTarget) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path} 缺少用户目标，不能生成扩量建议。`,
    );
  }
  if (finding.action.type === "isolate-search-term") {
    requireComparisonRoles(finding.comparisonEvidence, ["winner", "loser"], path);
  }
  if (finding.action.type === "reallocate-budget") {
    requireComparisonRoles(finding.comparisonEvidence, ["donor", "receiver"], path);
  }
  if (["increase-placement-bid", "lower-placement-bid"].includes(finding.action.type)
    && !finding.placementEvidence?.placements?.length) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path}.placementEvidence 是广告位竞价方向的必填证据。`,
    );
  }
  if (finding.action.type !== "increase-budget") return;
  if (!finding.dailyEvidence) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path}.dailyEvidence 是提高预算建议的必填证据。`,
    );
  }
  if (finding.dailyEvidence.constrainedDays < 2
    || !["reported-over-budget", "historical-budget"].includes(finding.dailyEvidence.basis)
    || finding.dailyEvidence.points.length === 0) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path}.dailyEvidence 必须证明至少两个实际预算受限日。`,
    );
  }
}

function validateTrendEvidence(trendEvidence, path) {
  requireObject(trendEvidence, path);
  requireString(trendEvidence.title, `${path}.title`);
  requireEnum(
    trendEvidence.entityType,
    ["campaign", "adGroup", "productAd", "keyword", "target", "searchTerm"],
    `${path}.entityType`,
  );
  requireScalar(trendEvidence.entityId, `${path}.entityId`);
  requireNonNegativeInteger(trendEvidence.observedDays, `${path}.observedDays`);
  requireArray(trendEvidence.points, `${path}.points`);
  trendEvidence.points.forEach((point, index) => {
    const pointPath = `${path}.points[${index}]`;
    requireObject(point, pointPath);
    requireString(point.date, `${pointPath}.date`);
    for (const field of ["cost", "sales", "orders", "clicks", "acos"]) {
      requireNullableFiniteNumber(point[field], `${pointPath}.${field}`);
    }
  });
  if (trendEvidence.observedDays !== trendEvidence.points.length) {
    throw new ReportError(
      "INVALID_REPORT_INPUT",
      `${path}.observedDays 必须等于 points 行数。`,
    );
  }
}

function validateComparisonEvidence(comparisonEvidence, path) {
  requireObject(comparisonEvidence, path);
  requireString(comparisonEvidence.key, `${path}.key`);
  requireEnum(
    comparisonEvidence.subjectType,
    ["searchTerm", "asin", "keyword", "target", "campaign"],
    `${path}.subjectType`,
  );
  requireArray(comparisonEvidence.contexts, `${path}.contexts`);
  comparisonEvidence.contexts.forEach((context, index) => {
    const contextPath = `${path}.contexts[${index}]`;
    requireObject(context, contextPath);
    requireEnum(
      context.role,
      ["winner", "loser", "donor", "receiver", "reference"],
      `${contextPath}.role`,
    );
    requireScalar(context.campaignId, `${contextPath}.campaignId`);
    requireString(context.campaignName, `${contextPath}.campaignName`);
    optionalScalar(context.adGroupId, `${contextPath}.adGroupId`);
    optionalString(context.adGroupName, `${contextPath}.adGroupName`);
    optionalScalar(context.entityId, `${contextPath}.entityId`);
    requireString(context.entityType, `${contextPath}.entityType`);
    requireArray(context.metrics, `${contextPath}.metrics`);
    context.metrics.forEach((metric, metricIndex) => {
      validateMetric(metric, `${contextPath}.metrics[${metricIndex}]`, false);
    });
  });
}

function validatePlacementEvidence(placementEvidence, path) {
  requireObject(placementEvidence, path);
  requireEnum(
    placementEvidence.entityType,
    ["campaign", "productAd", "keyword", "target"],
    `${path}.entityType`,
  );
  requireScalar(placementEvidence.entityId, `${path}.entityId`);
  requireArray(placementEvidence.placements, `${path}.placements`);
  placementEvidence.placements.forEach((placement, index) => {
    const placementPath = `${path}.placements[${index}]`;
    requireObject(placement, placementPath);
    requireString(placement.name, `${placementPath}.name`);
    for (const field of [
      "cost",
      "sales",
      "orders",
      "clicks",
      "impressions",
      "acos",
      "share",
    ]) {
      requireNullableFiniteNumber(placement[field], `${placementPath}.${field}`);
    }
  });
}

function requireComparisonRoles(comparisonEvidence, roles, path) {
  if (!comparisonEvidence) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path}.comparisonEvidence 是该跨位置建议的必填证据。`,
    );
  }
  const present = new Set(comparisonEvidence.contexts.map((context) => context.role));
  if (roles.some((role) => !present.has(role))) {
    throw new ReportError(
      "INCOMPLETE_REPORT_INPUT",
      `${path}.comparisonEvidence 必须包含：${roles.join("、")}。`,
    );
  }
}

function validateDailyEvidence(dailyEvidence, path) {
  requireObject(dailyEvidence, path);
  requireString(dailyEvidence.title, `${path}.title`);
  requireNonNegativeInteger(dailyEvidence.observedDays, `${path}.observedDays`);
  requireNonNegativeInteger(dailyEvidence.constrainedDays, `${path}.constrainedDays`);
  if (dailyEvidence.constrainedDays > dailyEvidence.observedDays) {
    throw new ReportError(
      "INVALID_REPORT_INPUT",
      `${path}.constrainedDays 不能大于 observedDays。`,
    );
  }
  requireEnum(
    dailyEvidence.basis,
    ["reported-over-budget", "historical-budget", "current-budget-reference", "unavailable"],
    `${path}.basis`,
  );
  requireArray(dailyEvidence.points, `${path}.points`);
  dailyEvidence.points.forEach((point, index) => {
    const pointPath = `${path}.points[${index}]`;
    requireObject(point, pointPath);
    requireString(point.date, `${pointPath}.date`);
    for (const field of ["cost", "budget", "orders", "acos"]) {
      requireNullableFiniteNumber(point[field], `${pointPath}.${field}`);
    }
    requireBoolean(point.overBudget, `${pointPath}.overBudget`);
  });
  if (dailyEvidence.observedDays !== dailyEvidence.points.length) {
    throw new ReportError(
      "INVALID_REPORT_INPUT",
      `${path}.observedDays 必须等于 points 行数。`,
    );
  }
  const markedConstrainedDays = dailyEvidence.points.filter((point) => point.overBudget).length;
  if (dailyEvidence.constrainedDays !== markedConstrainedDays) {
    throw new ReportError(
      "INVALID_REPORT_INPUT",
      `${path}.constrainedDays 必须等于 points 中 overBudget=true 的天数。`,
    );
  }
}

function validateAction(action, path) {
  requireObject(action, path);
  requireEnum(action.type, ACTION_TYPES, `${path}.type`);
  requireString(action.label, `${path}.label`);
  optionalEnum(
    action.targetLevel,
    ["campaign", "adGroup", "keyword", "target", "productAd", "searchTerm", "placement"],
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
    for (const field of ["orders", "budget", "budgetUtilization"]) {
      if (point[field] !== undefined) {
        requireNullableFiniteNumber(point[field], `${pointPath}.${field}`);
      }
    }
    if (point.overBudget !== undefined) requireBoolean(point.overBudget, `${pointPath}.overBudget`);
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

  if (coverage.historyEntities !== undefined) {
    requireArray(coverage.historyEntities, "coverage.historyEntities");
    coverage.historyEntities.forEach((entity, index) => {
      const path = `coverage.historyEntities[${index}]`;
      requireObject(entity, path);
      requireEnum(
        entity.entityType,
        ["adGroup", "productAd", "keyword", "target", "searchTerm"],
        `${path}.entityType`,
      );
      requireScalar(entity.entityId, `${path}.entityId`);
      requireScalar(entity.campaignId, `${path}.campaignId`);
      requireString(entity.reason, `${path}.reason`);
    });
  }

  if (coverage.placementEntities !== undefined) {
    requireArray(coverage.placementEntities, "coverage.placementEntities");
    coverage.placementEntities.forEach((entity, index) => {
      const path = `coverage.placementEntities[${index}]`;
      requireObject(entity, path);
      requireEnum(
        entity.entityType,
        ["productAd", "keyword", "target"],
        `${path}.entityType`,
      );
      requireScalar(entity.entityId, `${path}.entityId`);
      requireScalar(entity.campaignId, `${path}.campaignId`);
      requireString(entity.reason, `${path}.reason`);
    });
  }

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
      if (entity.status !== "unknown") requireRatio(entity.spendCoverage, `${path}.spendCoverage`);
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
  const coverageByKey = new Map(report.coverage.entities.map((item) => [item.key, item]));
  for (const section of report.sections) {
    const entity = coverageByKey.get(section.key);
    if (!entity
      || section.sampledCount !== entity.queriedCount
      || section.totalCount !== entity.totalCount) {
      throw new ReportError(
        "INCOMPLETE_REPORT_INPUT",
        `${section.key} 的报告行数与查询覆盖记录不一致。`,
      );
    }
  }
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
  const hasBusinessTarget = report.baseline.source === "user-target"
    && (report.baseline.targetAcos !== null || report.baseline.targetRoas !== null);
  if (!hasBusinessTarget) {
    for (const key of ["efficiency", "budget"]) {
      const rating = report.ratings.find((item) => item.key === key);
      if (rating?.status === "green") {
        throw new ReportError(
          "INCOMPLETE_REPORT_INPUT",
          `未提供业务目标时，${key} 不能标记为健康。`,
        );
      }
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
  const primaryFindings = report.analysisMode === "evidence-driven"
    ? report.findings.filter((finding) => actionType(finding) !== "observe")
    : report.findings;
  const orderedFindings = orderFindings(primaryFindings);
  const chartSpecs = buildChartSpecs(orderedFindings, report);
  const bottomTabs = buildBottomTabs(report);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(title)}</title>
  <script src="${TAILWIND_CDN}"></script>
  <script src="${ECHARTS_CDN}"></script>
  <style>
    :root{--ink:#172033;--muted:#687083;--line:#e4e5e8;--paper:#fff;--canvas:#f4f2ee;--lime:#d9f16f;--teal:#178b82;--red:#c84b52;--amber:#a76a16;--violet:#6558d9}
    *{box-sizing:border-box}html{background:var(--canvas);scroll-behavior:smooth}body{margin:0;color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}button{font:inherit;color:inherit}button:focus-visible{outline:3px solid rgba(101,88,217,.32);outline-offset:2px}.app{max-width:1480px;margin:0 auto;padding:20px}.sheet{overflow:hidden;border:1px solid #deddd9;border-radius:18px;background:#fff;box-shadow:0 18px 56px rgba(32,35,46,.08)}
    .action-shell{display:grid;grid-template-columns:285px minmax(0,1fr);min-height:560px}.action-rail{border-right:1px solid var(--line);background:#faf9f6;padding:18px 16px}.action-group+.action-group{margin-top:18px}.action-group-title{padding:0 10px 7px;color:#8b8d96;font-size:11px;font-weight:800;letter-spacing:.12em}.action-tab{display:block;width:100%;border:0;border-radius:10px;background:transparent;padding:9px 12px;text-align:left;cursor:pointer}.action-tab:hover{background:#f0efeb}.action-tab[aria-selected="true"]{background:#172033;color:#fff;box-shadow:0 8px 20px rgba(23,32,51,.16)}.action-tab strong{display:block;font-size:13px}.action-tab span{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.68}.action-panel[hidden],.bottom-panel[hidden],.chart-fallback[hidden]{display:none}.action-panel{padding:24px 30px}.action-detail{display:grid;grid-template-columns:minmax(0,.92fr) minmax(420px,1.08fr);gap:24px}.reason-row{display:grid;grid-template-columns:30px 1fr;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}.reason-index{display:grid;width:28px;height:28px;place-items:center;border-radius:50%;background:#edf8d0;color:#536315;font-size:12px;font-weight:850}.chart{height:230px;width:100%}.chart-fallback{display:grid;height:230px;place-items:center;padding:24px;color:var(--muted);text-align:center}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.metric-tile{padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff}.metric-tile span{display:block;color:var(--muted);font-size:11px}.metric-tile strong{display:block;margin-top:3px;font-size:15px}.bottom-tab-list{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--line);background:#fafafa;padding:0 20px}.bottom-tab{flex:0 0 auto;border:0;border-bottom:3px solid transparent;background:transparent;padding:14px 13px 11px;color:var(--muted);font-weight:750;cursor:pointer}.bottom-tab[aria-selected="true"]{border-color:var(--ink);color:var(--ink)}.bottom-panel{padding:24px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:11px}table{width:100%;min-width:780px;border-collapse:collapse}th,td{border-bottom:1px solid var(--line);padding:11px 12px;text-align:left;vertical-align:top;font-size:12px}th{position:sticky;top:0;z-index:1;background:#f8f8f7;color:var(--muted);font-size:11px;letter-spacing:.03em}tbody tr:hover{background:#fbfbf8}.table-pager{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:11px}.pager-button{border:1px solid #d7d8dc;border-radius:8px;background:#fff;padding:7px 11px;cursor:pointer}.pager-button:disabled{opacity:.38;cursor:not-allowed}.coverage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.coverage-card{padding:14px;border:1px solid var(--line);border-radius:11px}.coverage-card span{display:block;color:var(--muted);font-size:11px}.coverage-card strong{display:block;margin-top:4px;font-size:18px}.coverage-card small{display:block;margin-top:3px;color:var(--teal)}.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:#8d93a0}.status-red .status-dot{background:var(--red)}.status-yellow .status-dot{background:var(--amber)}.status-green .status-dot{background:var(--teal)}
    @media(max-width:1050px){.action-detail{grid-template-columns:1fr}.action-shell{grid-template-columns:240px minmax(0,1fr)}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:760px){.app{padding:0}.sheet{border:0;border-radius:0;box-shadow:none}.action-shell{display:block;min-height:0}.action-rail{border-right:0;border-bottom:1px solid var(--line);padding:14px 12px;overflow-x:auto;white-space:nowrap}.action-group{display:inline-block;min-width:235px;vertical-align:top}.action-group+.action-group{margin:0 0 0 12px}.action-group-title{white-space:normal}.action-tab{white-space:normal}.action-panel{padding:20px 16px}.action-detail{display:block}.action-detail>div+aside{margin-top:20px}.metric-grid,.coverage-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.chart,.chart-fallback{height:250px}.bottom-panel{padding:18px 14px}}
    @media print{html,body{background:#fff}.app{max-width:none;padding:0}.sheet{border:0;box-shadow:none}.action-rail,.bottom-tab-list,.table-pager{display:none!important}.action-shell{display:block}.action-panel[hidden],.bottom-panel[hidden]{display:block!important}.action-panel{break-inside:avoid;border-bottom:1px solid var(--line)}.chart{height:260px}.paged-row{display:table-row!important}.table-wrap{overflow:visible}table{min-width:0}.bottom-panel{break-before:page}}
  </style>
</head>
<body>
<main class="app">
  <article class="sheet">
    <header class="flex flex-col gap-5 border-b border-[#e4e5e8] px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div class="flex min-w-0 items-center gap-5">
        <img class="h-9 w-auto shrink-0" alt="SellerSpace 优麦云" src="data:image/png;base64,${logo}">
        <div class="min-w-0 border-l border-[#e4e5e8] pl-5">
          <h1 class="m-0 truncate text-[22px] font-extrabold tracking-[-0.02em]">${escapeHtml(title)}</h1>
          <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#687083]">
            <span>${escapeHtml(report.scope.storeName)}</span>
            <span>Seller ID ${escapeHtml(String(report.scope.sellerId))}</span>
            <span>${escapeHtml(report.period.label)} · ${escapeHtml(report.period.preset)}</span>
            <span>${escapeHtml(formatDate(report.generatedAt))}</span>
          </div>
        </div>
      </div>
      <span class="self-start rounded-full bg-[#172033] px-3 py-1.5 text-xs font-bold text-white lg:self-auto">只读 · 仅启用中广告</span>
    </header>
    <section class="border-b border-[#e4e5e8] px-6 py-5">
      <div class="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-start">
        <div><p class="m-0 text-xs font-extrabold uppercase tracking-[0.14em] text-[#8b8d96]">诊断结论</p><p class="mt-2 max-w-5xl text-[15px] text-[#353e51]">${escapeHtml(report.executiveSummary)}</p></div>
        <div class="rounded-xl bg-[#f4f2ee] px-4 py-3 text-xs text-[#687083]">${escapeHtml(modeCoverageLabel(report))}</div>
      </div>
      ${renderTargetNotice(report)}
    </section>
    ${renderActionWorkspace(report, orderedFindings)}
    <section class="border-t border-[#e4e5e8]" data-tabs data-orientation="horizontal">
      ${renderBottomTabs(bottomTabs)}
    </section>
    <footer class="flex flex-col gap-1 border-t border-[#e4e5e8] px-6 py-4 text-[11px] text-[#7d8493] sm:flex-row sm:justify-between"><span>由 SellerSpace 实际只读接口数据生成</span><span>Tailwind CSS 与 ECharts 通过 jsDelivr 加载；断网时文字证据与原始数据仍可查看</span></footer>
  </article>
</main>
<script>
(() => {
  const chartSpecs = ${safeJson(chartSpecs)};
  const charts = new Map();
  const initChart = (element) => {
    if (!element || charts.has(element.id)) return;
    const spec = chartSpecs.find((item) => item.id === element.id);
    if (!spec || !spec.dates.length || !window.echarts) return;
    const chart = window.echarts.init(element, null, { renderer: 'canvas' });
    const budgetSeries = spec.hasBudget ? [{
      name: '日预算', type: 'line', data: spec.budgets, showSymbol: false,
      lineStyle: { color: '#8b8d96', type: 'dashed', width: 1.5 },
      itemStyle: { color: '#8b8d96' }
    }] : [];
    const secondarySeries = !spec.hasBudget && spec.hasSales ? [{
      name: '销售额', type: 'line', data: spec.sales, showSymbol: false,
      smooth: 0.2, lineStyle: { color: '#178b82', width: 2 }, itemStyle: { color: '#178b82' }
    }] : [];
    chart.setOption({
      animation: false,
      color: ['#6558d9', '#178b82', '#c84b52'],
      tooltip: { trigger: 'axis', valueFormatter: (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
      legend: { top: 0, right: 0, textStyle: { color: '#687083', fontSize: 11 } },
      grid: { left: 46, right: 18, top: 38, bottom: 32 },
      xAxis: { type: 'category', boundaryGap: false, data: spec.dates, axisLine: { lineStyle: { color: '#dfe1e6' } }, axisLabel: { color: '#7d8493', hideOverlap: true } },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: '#eceef1' } }, axisLabel: { color: '#7d8493' } },
      series: [
        { name: '花费', type: 'line', data: spec.costs, showSymbol: false, smooth: 0.2, lineStyle: { color: '#6558d9', width: 2.5 }, areaStyle: { color: 'rgba(101,88,217,.08)' }, itemStyle: { color: '#6558d9' } },
        ...budgetSeries,
        ...secondarySeries,
        { name: '预算受限日', type: 'scatter', data: spec.constrained, symbolSize: 8, itemStyle: { color: '#c84b52' }, tooltip: { valueFormatter: (value) => value == null ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) } }
      ]
    });
    charts.set(element.id, chart);
    const fallback = element.parentElement.querySelector('[data-chart-fallback]');
    if (fallback) fallback.hidden = true;
  };
  const initChartsWithin = (root) => root.querySelectorAll('[data-chart]').forEach(initChart);

  document.querySelectorAll('[data-tabs]').forEach((root) => {
    const tabs = [...root.querySelectorAll(':scope > [role="tablist"] [role="tab"]')];
    if (!tabs.length) return;
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute('aria-controls')));
    const orientation = root.dataset.orientation || 'horizontal';
    const activate = (index, moveFocus) => {
      tabs.forEach((tab, tabIndex) => {
        const active = index === tabIndex;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[tabIndex].hidden = !active;
      });
      initChartsWithin(panels[index]);
      charts.forEach((chart) => chart.resize());
      if (moveFocus) tabs[index].focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(index, false));
      tab.addEventListener('keydown', (event) => {
        let next = index;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else if (event.key === 'ArrowRight' || (orientation === 'vertical' && event.key === 'ArrowDown')) next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft' || (orientation === 'vertical' && event.key === 'ArrowUp')) next = (index - 1 + tabs.length) % tabs.length;
        else return;
        event.preventDefault();
        activate(next, true);
      });
    });
    activate(0, false);
  });

  document.querySelectorAll('[data-paged-table]').forEach((root) => {
    const rows = [...root.querySelectorAll('.paged-row')];
    const previous = root.querySelector('[data-page-prev]');
    const next = root.querySelector('[data-page-next]');
    const status = root.querySelector('[data-page-status]');
    const size = Number(root.dataset.pageSize) || ${TABLE_PAGE_SIZE};
    const pageCount = Math.max(1, Math.ceil(rows.length / size));
    let page = 0;
    const render = () => {
      rows.forEach((row, index) => row.hidden = index < page * size || index >= (page + 1) * size);
      previous.disabled = page === 0;
      next.disabled = page >= pageCount - 1;
      status.textContent = rows.length ? '第 ' + (page + 1) + ' / ' + pageCount + ' 页 · 共 ' + rows.length + ' 行' : '0 行';
    };
    previous.addEventListener('click', () => { if (page > 0) { page -= 1; render(); } });
    next.addEventListener('click', () => { if (page < pageCount - 1) { page += 1; render(); } });
    render();
  });

  window.addEventListener('resize', () => charts.forEach((chart) => chart.resize()));
  window.addEventListener('beforeprint', () => {
    document.querySelectorAll('[data-chart]').forEach(initChart);
    charts.forEach((chart) => chart.resize());
  });
  if (!window.echarts) {
    document.querySelectorAll('[data-chart-fallback]').forEach((item) => item.hidden = false);
  }
})();
</script>
</body>
</html>`;
}

function renderTargetNotice(report) {
  const hasTarget = report.baseline.source === "user-target"
    && (report.baseline.targetAcos !== null || report.baseline.targetRoas !== null);
  if (!hasTarget) {
    return `<div class="mt-4 rounded-xl border border-[#ecd9ad] bg-[#fff8e7] px-4 py-3 text-sm text-[#78521c]"><strong>判断边界：</strong>未提供目标 ACoS / ROAS 或盈亏线；账户整体数据只用于寻找异常，不用于判断达标或触发扩量。</div>`;
  }
  const targets = [
    report.baseline.targetAcos === null ? null : `目标 ACoS ${formatValue(report.baseline.targetAcos, "ratio")}`,
    report.baseline.targetRoas === null ? null : `目标 ROAS ${formatValue(report.baseline.targetRoas, "number")}`,
  ].filter(Boolean).join(" · ");
  const context = [
    report.baseline.accountAcos === null ? null : `账户整体 ACoS ${formatValue(report.baseline.accountAcos, "ratio")}`,
    report.baseline.accountRoas === null ? null : `账户整体 ROAS ${formatValue(report.baseline.accountRoas, "number")}`,
  ].filter(Boolean).join(" · ");
  return `<div class="mt-4 grid gap-2 rounded-xl border border-[#d8e8a0] bg-[#f5fbdc] px-4 py-3 text-sm text-[#425012] sm:grid-cols-[1fr_auto]"><span><strong>业务目标：</strong>${escapeHtml(targets)}</span>${context ? `<span class="text-[#6e7851]">${escapeHtml(context)}（仅作相对参考）</span>` : ""}</div>`;
}

function renderActionWorkspace(report, findings) {
  if (findings.length === 0) {
    return `<section class="px-6 py-12 text-center"><h2 class="text-xl font-extrabold">本期没有达到行动门槛的建议</h2><p class="mt-2 text-sm text-[#687083]">请先查看查询完整性；数据不足不等于广告表现良好。</p></section>`;
  }
  const buttons = [];
  let actionIndex = 0;
  const groups = ACTION_GROUPS.map((group) => {
    const items = findings.filter((finding) => group.types.includes(actionType(finding)));
    if (!items.length) return "";
    const itemButtons = items.map((finding) => {
      const index = actionIndex;
      actionIndex += 1;
      return `<button type="button" class="action-tab" role="tab" id="action-tab-${index}" aria-controls="action-panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}"><strong>${escapeHtml(finding.action?.label || finding.recommendation)}</strong><span>${escapeHtml(finding.entityName)} · ${escapeHtml(finding.priority)}</span></button>`;
    }).join("");
    return `<div class="action-group"><div class="action-group-title">${escapeHtml(group.label)} · ${escapeHtml(String(items.length))}</div>${itemButtons}</div>`;
  }).join("");
  const panels = findings.map((finding, index) => renderActionPanel(
    finding,
    index,
    report,
    index !== 0,
  )).join("");
  return `<section class="action-shell" data-tabs data-orientation="vertical"><aside class="action-rail" role="tablist" aria-label="行动建议">${groups}</aside><div>${panels}</div></section>`;
}

function renderActionPanel(finding, index, report, hidden) {
  const drilldown = report.campaignDrilldowns.find((item) => (
    String(item.campaignId) === String(finding.campaignId ?? "")
  ));
  const reasons = finding.reasonBullets?.length
    ? finding.reasonBullets
    : [finding.reasoning, "该建议来自当前可用的实体与 Campaign 证据。"];
  const caveats = finding.caveats?.length
    ? finding.caveats
    : defaultCaveats(finding, report);
  const dailySummary = renderDailySummary(finding, drilldown);
  const trendPoints = resolveFindingTrendPoints(finding, drilldown);
  const trendTitle = finding.dailyEvidence?.title
    || finding.trendEvidence?.title
    || (isCampaignLevelFinding(finding) ? "Campaign 日趋势" : "实体日趋势证据");
  const trendFallback = trendPoints.length
    ? "图表组件未加载，建议原因、指标和下方原始数据仍可查看。"
    : "未获取该实体的日趋势；本建议只使用左侧已核验数据，不以 Campaign 趋势代替。";
  const placements = renderPlacementEvidence(finding, drilldown, report.scope.currency);
  return `<article class="action-panel" role="tabpanel" id="action-panel-${index}" aria-labelledby="action-tab-${index}"${hidden ? " hidden" : ""}>
    <div class="mb-6 flex flex-col gap-4 border-b border-[#e4e5e8] pb-5 sm:flex-row sm:items-start sm:justify-between">
      <div><div class="flex items-center gap-2"><span class="rounded-full bg-[#172033] px-2.5 py-1 text-[11px] font-extrabold text-white">${escapeHtml(finding.priority)}</span><span class="text-xs font-bold text-[#687083]">${escapeHtml(confidenceLabel(finding.confidence))}</span></div><h2 class="mt-3 text-[30px] font-black tracking-[-0.035em]">${escapeHtml(finding.action?.label || finding.recommendation)}</h2><p class="mt-1 text-sm text-[#687083]">${escapeHtml(finding.entityType)} · ${escapeHtml(finding.entityName)}</p></div>
      <div class="max-w-lg rounded-xl bg-[#f4f2ee] px-4 py-3 text-sm text-[#353e51]"><strong class="block text-xs text-[#687083]">建议方向</strong><span class="mt-1 block">${escapeHtml(finding.recommendation)}</span></div>
    </div>
    <div class="action-detail">
      <div>
        <h3 class="m-0 text-lg font-extrabold">给出这个建议的原因</h3>
        <div class="mt-2">${reasons.map((reason, reasonIndex) => `<div class="reason-row"><span class="reason-index">${reasonIndex + 1}</span><p class="m-0 pt-1 text-sm text-[#353e51]">${escapeHtml(reason)}</p></div>`).join("")}</div>
        <div class="mt-5 rounded-xl border-l-4 border-[#d9f16f] bg-[#f7fbe9] px-4 py-3"><strong class="block text-sm">判断说明</strong><p class="mt-1 text-sm text-[#536036]">${escapeHtml(finding.reasoning)}</p></div>
        ${renderExistingTargets(finding)}
        ${renderComparisonEvidence(finding, report.scope.currency)}
        <div class="mt-6"><h3 class="m-0 text-base font-extrabold">风险与观察</h3><ul class="mt-2 list-disc space-y-1.5 pl-5 text-sm text-[#687083]">${caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>
      </div>
      <aside>
        <section class="rounded-xl border border-[#e4e5e8] p-4"><div class="flex flex-wrap items-start justify-between gap-2"><div><h3 class="m-0 text-base font-extrabold">${escapeHtml(trendTitle)}</h3><p class="mt-1 text-xs text-[#687083]">${escapeHtml(dailySummary)}</p></div><span class="rounded-full bg-[#f4f2ee] px-2.5 py-1 text-[11px] font-bold text-[#687083]">只读证据</span></div><div id="action-chart-${index}" class="chart mt-3" data-chart aria-label="${escapeHtml(finding.entityName)} 日趋势图"${trendPoints.length ? "" : " hidden"}></div><p class="chart-fallback" data-chart-fallback${trendPoints.length ? " hidden" : ""}>${escapeHtml(trendFallback)}</p></section>
        <div class="metric-grid mt-3">${renderEvidenceMetrics(finding.evidence, report.scope.currency)}</div>
        ${placements}
      </aside>
    </div>
  </article>`;
}

function renderEvidenceMetrics(metrics, defaultCurrency) {
  if (!metrics.length) return `<div class="metric-tile"><span>证据</span><strong>数据不足</strong></div>`;
  return metrics.slice(0, 8).map((metric) => `<div class="metric-tile"><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(formatValue(metric.value, metric.format, metric.currency || defaultCurrency))}</strong></div>`).join("");
}

function renderExistingTargets(finding) {
  const targets = finding.action?.existingTargets || [];
  if (!targets.length) return "";
  return `<div class="mt-5"><h3 class="m-0 text-sm font-extrabold">现有投放位置</h3><div class="mt-2 flex flex-wrap gap-2">${targets.map((target) => `<span class="rounded-lg border border-[#ddd9f3] bg-[#f4f1ff] px-2.5 py-1.5 text-xs text-[#554bb2]">${escapeHtml(targetLevelLabel(target.level))} · ${escapeHtml(target.name)}</span>`).join("")}</div></div>`;
}

function renderComparisonEvidence(finding, defaultCurrency) {
  const comparison = finding.comparisonEvidence;
  if (!comparison?.contexts?.length) return "";
  const contexts = comparison.contexts.map((context) => {
    const location = [context.campaignName, context.adGroupName].filter(Boolean).join(" · ");
    const metrics = context.metrics.map((metric) => (
      `${metric.label} ${formatValue(metric.value, metric.format, metric.currency || defaultCurrency)}`
    )).join(" · ");
    return `<article class="rounded-lg border border-[#e4e5e8] bg-white px-3 py-3"><div class="flex flex-wrap items-center justify-between gap-2"><strong class="text-sm">${escapeHtml(location)}</strong><span class="rounded-full bg-[#f4f2ee] px-2 py-0.5 text-[11px] font-bold text-[#687083]">${escapeHtml(comparisonRoleLabel(context.role))}</span></div><p class="mt-1 text-xs text-[#687083]">${escapeHtml(metrics)}</p></article>`;
  }).join("");
  const title = comparison.subjectType === "campaign"
    ? "预算重分配依据"
    : "同一对象跨投放位置对比";
  return `<div class="mt-5 rounded-xl border border-[#ddd9f3] bg-[#faf9ff] p-4"><h3 class="m-0 text-sm font-extrabold">${escapeHtml(title)}</h3><p class="mt-1 text-xs text-[#687083]">${escapeHtml(comparison.key)} · ${escapeHtml(comparisonSubjectLabel(comparison.subjectType))}</p><div class="mt-3 grid gap-2 lg:grid-cols-2">${contexts}</div></div>`;
}

function renderPlacementEvidence(finding, drilldown, defaultCurrency) {
  const exactEvidence = finding.placementEvidence;
  const placements = exactEvidence?.placements?.length
    ? exactEvidence.placements
    : (isCampaignLevelFinding(finding) ? drilldown?.placements || [] : []);
  if (!placements.length) return "";
  const scopeLabel = exactEvidence
    ? entityTypeLabel(exactEvidence.entityType).replace("日趋势", "")
    : "Campaign";
  const rows = placements.map((placement) => {
    const metrics = [
      ["花费", placement.cost, "currency"],
      ["销售额", placement.sales, "currency"],
      ["订单", placement.orders, "count"],
      ["ACoS", placement.acos, "ratio"],
      ["花费占比", placement.share, "ratio"],
    ].filter(([, value]) => value !== null && value !== undefined)
      .map(([label, value, format]) => (
        `${label} ${formatValue(value, format, defaultCurrency)}`
      )).join(" · ");
    return `<div class="border-b border-[#e4e5e8] px-3 py-2 last:border-b-0"><strong class="text-xs">${escapeHtml(placement.name)}</strong><p class="mt-0.5 text-xs text-[#687083]">${escapeHtml(metrics || "数据不足")}</p></div>`;
  }).join("");
  return `<div class="mt-5"><h4 class="m-0 text-sm font-extrabold">广告位证据 · ${escapeHtml(scopeLabel)}</h4><div class="mt-2 overflow-hidden rounded-lg border border-[#e4e5e8]">${rows}</div></div>`;
}

function defaultCaveats(finding, report) {
  const caveats = [];
  if (finding.action?.coverageStatus === "unknown") {
    caveats.push("投放或否定覆盖关系不完整，执行前需要复核当前结构。");
  }
  if (finding.action?.type === "increase-budget") {
    caveats.push("提高预算后继续观察效率、库存和利润目标，不以建议预算作为唯一依据。");
  } else if (["increase-bid", "increase-placement-bid"].includes(finding.action?.type)) {
    caveats.push("扩量前确认 Campaign 当前没有预算约束；调整后只观察该单一变化带来的影响。");
  } else if (["isolate-search-term", "negative-search-term"].includes(finding.action?.type)) {
    caveats.push("执行否定前复核范围，避免阻断同一 Campaign 内仍然有效的流量。");
  } else {
    caveats.push("建议先在对应层级复核近期促销、库存与搜索意图，再决定是否执行。");
  }
  if (report.limitations.length) caveats.push(report.limitations[0]);
  return caveats;
}

function renderDailySummary(finding, drilldown) {
  if (finding.dailyEvidence) {
    const basis = dailyBasisLabel(finding.dailyEvidence.basis);
    return `观察 ${finding.dailyEvidence.observedDays} 天 · 实际预算受限 ${finding.dailyEvidence.constrainedDays} 天 · ${basis}`;
  }
  if (finding.trendEvidence) {
    return `${entityTypeLabel(finding.trendEvidence.entityType)} · 已获取 ${finding.trendEvidence.observedDays} 个日数据点`;
  }
  if (isCampaignLevelFinding(finding) && drilldown?.trend?.length) {
    return `Campaign · 已获取 ${drilldown.trend.length} 个日数据点`;
  }
  return "没有该实体的日趋势；不会用 Campaign 趋势代替";
}

function isCampaignLevelFinding(finding) {
  return finding.entityType === "campaign" || finding.action?.targetLevel === "campaign";
}

function resolveFindingTrendPoints(finding, drilldown) {
  if (finding.dailyEvidence?.points) return finding.dailyEvidence.points;
  if (finding.trendEvidence?.points) return finding.trendEvidence.points;
  if (isCampaignLevelFinding(finding)) return drilldown?.trend || [];
  return [];
}

function buildChartSpecs(findings, report) {
  return findings.map((finding, index) => {
    const drilldown = report.campaignDrilldowns.find((item) => (
      String(item.campaignId) === String(finding.campaignId ?? "")
    ));
    const points = resolveFindingTrendPoints(finding, drilldown);
    const normalized = points.map((point) => ({
      date: point.date,
      cost: finiteOrNull(point.cost),
      budget: finiteOrNull(point.budget),
      sales: finiteOrNull(point.sales),
      overBudget: point.overBudget === true,
    }));
    const hasBudget = normalized.some((point) => point.budget !== null);
    const hasSales = normalized.some((point) => point.sales !== null);
    return {
      id: `action-chart-${index}`,
      dates: normalized.map((point) => point.date.slice(5)),
      costs: normalized.map((point) => point.cost),
      budgets: normalized.map((point) => point.budget),
      sales: normalized.map((point) => point.sales),
      constrained: normalized.map((point, pointIndex) => (
        point.overBudget ? [pointIndex, point.cost] : null
      )).filter(Boolean),
      hasBudget,
      hasSales,
    };
  });
}

function buildBottomTabs(report) {
  const tabs = [{
    key: "overview",
    label: "账户概览",
    count: report.overview.length,
    content: renderAccountOverview(report),
  }];
  const coverageByKey = new Map((report.coverage.entities || []).map((item) => [item.key, item]));
  for (const key of CORE_SECTION_KEYS) {
    const section = report.sections.find((item) => item.key === key);
    if (!section) continue;
    tabs.push({
      key,
      label: sectionLabel(key, section.title),
      count: section.sampledCount,
      content: renderDataPanel(section, coverageByKey.get(key), report.scope.currency, `top-${key}`),
    });
  }
  tabs.push({
    key: "coverage",
    label: "查询完整性",
    count: report.coverage.entities?.length || 0,
    content: renderCoverage(report),
  });
  return tabs;
}

function renderBottomTabs(tabs) {
  const buttons = tabs.map((tab, index) => `<button type="button" class="bottom-tab" role="tab" id="bottom-tab-${escapeAttribute(tab.key)}" aria-controls="bottom-panel-${escapeAttribute(tab.key)}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(tab.label)} <span class="opacity-50">${escapeHtml(String(tab.count))}</span></button>`).join("");
  const panels = tabs.map((tab, index) => `<section class="bottom-panel" role="tabpanel" id="bottom-panel-${escapeAttribute(tab.key)}" aria-labelledby="bottom-tab-${escapeAttribute(tab.key)}"${index === 0 ? "" : " hidden"}>${tab.content}</section>`).join("");
  return `<div class="bottom-tab-list" role="tablist" aria-label="报告数据与完整性">${buttons}</div>${panels}`;
}

function renderAccountOverview(report) {
  const observations = report.analysisMode === "evidence-driven"
    ? report.findings.filter((finding) => actionType(finding) === "observe")
    : [];
  const observationSection = observations.length
    ? `<section class="mt-6 rounded-xl bg-[#f4f2ee] p-4"><h3 class="m-0 text-sm font-extrabold">观察与数据缺口（不作为操作建议）</h3><div class="mt-3 grid gap-2 md:grid-cols-2">${observations.map((finding) => `<article class="rounded-lg bg-white px-3 py-3"><strong class="text-sm">${escapeHtml(finding.entityName)}：${escapeHtml(finding.title)}</strong><p class="mt-1 text-xs text-[#687083]">${escapeHtml(finding.reasonBullets?.[0] || finding.reasoning)}</p></article>`).join("")}</div></section>`
    : "";
  return `<div><div class="mb-5"><h2 class="m-0 text-xl font-extrabold">账户概览</h2><p class="mt-1 text-sm text-[#687083]">账户整体用于描述当前范围；是否达标只看明确业务目标。</p></div><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">${report.overview.map((metric) => `<article class="rounded-xl border border-[#e4e5e8] p-4"><span class="text-xs text-[#687083]">${escapeHtml(metric.label)}</span><strong class="mt-2 block text-xl font-black">${escapeHtml(formatValue(metric.value, metric.format, metric.currency || report.scope.currency))}</strong></article>`).join("")}</div><div class="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">${report.ratings.map((rating) => `<article class="status-${escapeAttribute(rating.status)} rounded-xl border border-[#e4e5e8] p-4"><div class="text-xs font-bold text-[#687083]"><span class="status-dot"></span>${escapeHtml(rating.label)}</div><strong class="mt-2 block">${escapeHtml(rating.summary)}</strong><p class="mt-1 text-xs text-[#687083]">${escapeHtml(rating.evidence.join("；"))}</p></article>`).join("")}</div>${observationSection}</div>`;
}

function renderDataPanel(section, coverage, defaultCurrency, tableId) {
  const coverageText = coverage
    ? coverage.spendCoverage === null
      ? "覆盖度未知"
      : `花费覆盖 ${formatValue(coverage.spendCoverage, "ratio")}`
    : `展示 ${section.sampledCount} / ${section.totalCount}`;
  return `<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><h2 class="m-0 text-xl font-extrabold">${escapeHtml(section.title)}</h2><p class="mt-1 text-sm text-[#687083]">${escapeHtml(section.summary)}</p></div><span class="self-start rounded-lg bg-[#eff8f3] px-3 py-1.5 text-xs font-bold text-[#247763] sm:self-auto">${escapeHtml(coverageText)} · ${escapeHtml(String(section.sampledCount))}/${escapeHtml(String(section.totalCount))}</span></div>${renderSectionTable(section, defaultCurrency, tableId)}`;
}

function renderSectionTable(section, defaultCurrency, tableId) {
  const safeId = escapeAttribute(tableId);
  const header = section.columns.map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join("");
  const rows = [...section.rows];
  if (section.columns.some((column) => column.key === "cost")) {
    rows.sort((left, right) => (Number(right.cost) || 0) - (Number(left.cost) || 0));
  }
  const body = rows.length === 0
    ? `<tr><td colspan="${section.columns.length || 1}" class="py-10 text-center text-[#687083]">接口成功返回空列表</td></tr>`
    : rows.map((row) => `<tr class="paged-row">${section.columns.map((column) => `<td>${escapeHtml(formatValue(row[column.key], column.format, column.currency || defaultCurrency))}</td>`).join("")}</tr>`).join("");
  return `<div data-paged-table data-page-size="${TABLE_PAGE_SIZE}" id="table-${safeId}"><div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div><div class="table-pager"><button type="button" class="pager-button" data-page-prev aria-label="上一页">上一页</button><span class="text-xs text-[#687083]" data-page-status aria-live="polite"></span><button type="button" class="pager-button" data-page-next aria-label="下一页">下一页</button></div></div>`;
}

function renderCoverage(report) {
  const entities = report.coverage.entities || [];
  const cards = entities.length
    ? `<div class="coverage-grid">${entities.map(renderCoverageCard).join("")}</div>`
    : `<div class="rounded-xl border border-[#e4e5e8] p-4 text-sm text-[#687083]">${escapeHtml(modeCoverageLabel(report))}</div>`;
  const selections = report.coverage.selectedCampaigns?.length
    ? `<div class="mt-6"><h3 class="m-0 text-base font-extrabold">为什么下钻这些 Campaign</h3><div class="mt-3 grid gap-3 lg:grid-cols-2">${report.coverage.selectedCampaigns.map((campaign) => `<article class="rounded-xl border border-[#e4e5e8] p-4"><strong>${escapeHtml(campaign.campaignName)}</strong><p class="mt-1 text-sm text-[#687083]">${escapeHtml(campaign.reasons.join("；"))}</p><div class="mt-2 text-xs text-[#178b82]">日趋势已查${campaign.placementQueried ? " · 广告位已查" : ""}</div></article>`).join("")}</div></div>`
    : "";
  const entityHistories = report.coverage.historyEntities?.length
    ? `<div class="mt-6"><h3 class="m-0 text-base font-extrabold">为什么查询这些实体的日趋势</h3><div class="mt-3 grid gap-3 lg:grid-cols-2">${report.coverage.historyEntities.map((entity) => `<article class="rounded-xl border border-[#e4e5e8] p-4"><strong>${escapeHtml(entityTypeLabel(entity.entityType))} · ${escapeHtml(String(entity.entityId))}</strong><p class="mt-1 text-sm text-[#687083]">${escapeHtml(entity.reason)}</p></article>`).join("")}</div></div>`
    : "";
  const entityPlacements = report.coverage.placementEntities?.length
    ? `<div class="mt-6"><h3 class="m-0 text-base font-extrabold">为什么查询这些实体的广告位</h3><div class="mt-3 grid gap-3 lg:grid-cols-2">${report.coverage.placementEntities.map((entity) => `<article class="rounded-xl border border-[#e4e5e8] p-4"><strong>${escapeHtml(entityTypeLabel(entity.entityType).replace("日趋势", ""))} · ${escapeHtml(String(entity.entityId))}</strong><p class="mt-1 text-sm text-[#687083]">${escapeHtml(entity.reason)}</p></article>`).join("")}</div></div>`
    : "";
  const notes = [
    ...report.assumptions.map((item) => `假设：${item}`),
    ...report.limitations.map((item) => `限制：${item}`),
  ];
  return `<div><div class="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 class="m-0 text-xl font-extrabold">查询完整性</h2><p class="mt-1 text-sm text-[#687083]">行数、后端总数、花费覆盖和下钻原因必须互相一致。</p></div><span class="text-xs font-bold text-[#687083]">业务查询 ${escapeHtml(String(report.coverage.businessCallCount))} 次，仅作记录</span></div>${cards}${selections}${entityHistories}${entityPlacements}${notes.length ? `<div class="mt-6 rounded-xl bg-[#f4f2ee] p-4"><h3 class="m-0 text-sm font-extrabold">假设与限制</h3><ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-[#687083]">${notes.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}</div>`;
}

function renderCoverageCard(entity) {
  const coverage = entity.spendCoverage === null
    ? "覆盖度未知"
    : `花费覆盖 ${formatValue(entity.spendCoverage, "ratio")}`;
  return `<article class="coverage-card"><span>${escapeHtml(sectionLabel(entity.key))}</span><strong>${escapeHtml(String(entity.queriedCount))} / ${escapeHtml(String(entity.totalCount))}</strong><small>${escapeHtml(coverage)} · ${escapeHtml(coverageStatusLabel(entity.status))}</small></article>`;
}

function orderFindings(findings) {
  const priorityRank = { P1: 0, P2: 1, P3: 2 };
  const groupRank = new Map();
  ACTION_GROUPS.forEach((group, groupIndex) => {
    group.types.forEach((type) => groupRank.set(type, groupIndex));
  });
  return [...findings].sort((left, right) => (
    (groupRank.get(actionType(left)) ?? 99) - (groupRank.get(actionType(right)) ?? 99)
      || (priorityRank[left.priority] ?? 99) - (priorityRank[right.priority] ?? 99)
  ));
}

function actionType(finding) {
  return finding.action?.type || "observe";
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
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

function confidenceLabel(confidence) {
  return ({ high: "高置信", medium: "中置信", low: "低置信" })[confidence];
}

function modeCoverageLabel(report) {
  if (report.analysisMode === "evidence-driven") {
    const known = (report.coverage.entities || []).filter((item) => (
      item.key !== "campaign" && item.spendCoverage !== null
    ));
    const minimum = known.length ? Math.min(...known.map((item) => item.spendCoverage)) : null;
    const coverage = minimum === null
      ? "部分实体覆盖度未知"
      : `核心实体最低花费覆盖 ${formatValue(minimum, "ratio")}`;
    return `${coverage} · 证据下钻 ${report.campaignDrilldowns.length} 个 Campaign`;
  }
  if (report.analysisMode === "campaign-drilldown") {
    return `逐活动下钻（兼容模式） · ${report.coverage.businessCallCount} 次查询`;
  }
  return `组合采样（兼容模式） · ${report.coverage.businessCallCount} 次查询`;
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
  return ({ complete: "完整分页", "target-reached": "达到覆盖目标", unknown: "覆盖度未知" })[status];
}

function targetLevelLabel(level) {
  return ({ campaign: "Campaign", adGroup: "广告组" })[level] || level;
}

function entityTypeLabel(entityType) {
  return ({
    campaign: "Campaign 日趋势",
    adGroup: "广告组日趋势",
    productAd: "推广商品日趋势",
    keyword: "关键词日趋势",
    target: "商品投放日趋势",
    searchTerm: "搜索词日趋势",
  })[entityType] || "实体日趋势";
}

function comparisonRoleLabel(role) {
  return ({
    winner: "表现较好位置",
    loser: "表现较差位置",
    donor: "预算调出方",
    receiver: "预算承接方",
    reference: "对照位置",
  })[role] || role;
}

function comparisonSubjectLabel(subjectType) {
  return ({
    searchTerm: "搜索词",
    asin: "ASIN",
    keyword: "关键词",
    target: "商品投放",
    campaign: "Campaign",
  })[subjectType] || subjectType;
}

function dailyBasisLabel(basis) {
  return ({
    "reported-over-budget": "按接口报告的超预算时点",
    "historical-budget": "按逐日历史预算",
    "current-budget-reference": "仅按当前预算回看",
    unavailable: "预算证据不可用",
  })[basis];
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
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

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
