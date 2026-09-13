import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { renderDashboardHtml } from "./render-dashboard.mjs";

const SCHEMA_VERSION = 1;
const ACTION_ID = "amazon.search.keyword_rank";
const MINIMUM_ACTION_VERSION = 5;
const ARTIFACT_SCHEMA_VERSION = 1;
const MAX_KEYWORDS = 50;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 120_000;
const REQUIRED_TOOLS = [
  "discover_capabilities",
  "browser_list",
  "browser_submit_task",
  "browser_get_task",
];

const TARGET_COLUMNS = [
  "run_id",
  "collected_at",
  "marketplace",
  "target_asin",
  "keyword",
  "pages_requested",
  "pages_completed",
  "result_count",
  "blocked",
  "target_found",
  "natural_found",
  "natural_rank",
  "ad_found",
  "best_ad_position",
  "ad_types",
  "ad_occurrence_count",
  "best_overall_position",
  "status",
  "error_code",
  "error_message",
];

const RAW_COLUMNS = [
  "run_id",
  "collected_at",
  "marketplace",
  "keyword",
  "page",
  "page_mode",
  "page_url",
  "position",
  "natural_rank",
  "asin",
  "ad_type",
];

export class RankTrackerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RankTrackerError";
    this.code = code;
    this.details = details;
  }
}

export function validatePreflight(preflight) {
  if (!preflight || typeof preflight !== "object") {
    throw new RankTrackerError(
      "PREFLIGHT_REQUIRED",
      "必须先检查 sellerspace-mcp 和在线浏览器，再调用 prepare-run",
    );
  }
  const tools = Array.isArray(preflight.required_tools)
    ? new Set(preflight.required_tools.map(String))
    : new Set();
  const missingTools = REQUIRED_TOOLS.filter((name) => !tools.has(name));
  if (missingTools.length > 0) {
    throw new RankTrackerError(
      "MCP_TOOLS_MISSING",
      `sellerspace-mcp 缺少必需工具：${missingTools.join("、")}`,
      { missing_tools: missingTools },
    );
  }
  if (preflight.mcp_ready !== true) {
    throw new RankTrackerError(
      "MCP_NOT_READY",
      "sellerspace-mcp 未安装、未启用或当前无法连接",
    );
  }
  if (preflight.action_id !== ACTION_ID || preflight.action_available !== true) {
    throw new RankTrackerError(
      "ACTION_UNAVAILABLE",
      `sellerspace-mcp 未提供可用的 ${ACTION_ID} 动作`,
    );
  }
  const actionVersion = toInteger(preflight.action_version);
  if (actionVersion === null || actionVersion < MINIMUM_ACTION_VERSION) {
    throw new RankTrackerError(
      "ACTION_VERSION_TOO_OLD",
      `优麦云浏览器插件的关键词排名动作需要第 ${MINIMUM_ACTION_VERSION} 版或更高版本`,
      { action_version: actionVersion, minimum_version: MINIMUM_ACTION_VERSION },
    );
  }
  if (preflight.browser_online !== true || !nonEmptyString(preflight.browser_id)) {
    throw new RankTrackerError(
      "NO_ONLINE_BROWSER",
      "没有符合要求的在线优麦云浏览器插件",
    );
  }
  const artifactSchemaVersion = toInteger(preflight.artifact_schema_version);
  if (preflight.artifact_delivery_available !== true || artifactSchemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new RankTrackerError(
      "ARTIFACT_DELIVERY_UNAVAILABLE",
      "当前 sellerspace-mcp 或浏览器任务中心不支持所需的结果文件交付模式（artifact）",
      { artifact_schema_version: artifactSchemaVersion, required: ARTIFACT_SCHEMA_VERSION },
    );
  }
  return {
    mcp_server: "sellerspace-mcp",
    required_tools: [...REQUIRED_TOOLS],
    action_id: ACTION_ID,
    action_version: actionVersion,
    browser_id: String(preflight.browser_id).trim(),
    browser_online: true,
    artifact_delivery_available: true,
    artifact_schema_version: artifactSchemaVersion,
    checked_at: validTimestamp(preflight.checked_at) ?? new Date().toISOString(),
    browser_meta: sanitizeObject(preflight.browser_meta),
  };
}

export async function parseKeywordsFile(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw new RankTrackerError(
      "KEYWORDS_FILE_UNREADABLE",
      `无法读取关键词文件：${filePath}`,
      { cause: String(error) },
    );
  }
  content = content.replace(/^\uFEFF/, "");
  const seen = new Set();
  const keywords = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const keyword = rawLine.trim();
    if (!keyword || keyword.startsWith("#")) continue;
    const key = keyword.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
  }
  if (keywords.length === 0) {
    throw new RankTrackerError("NO_KEYWORDS", "关键词文件中没有有效关键词");
  }
  if (keywords.length > MAX_KEYWORDS) {
    throw new RankTrackerError(
      "TOO_MANY_KEYWORDS",
      `单次最多支持 ${MAX_KEYWORDS} 个去重后的关键词，当前为 ${keywords.length} 个`,
      { keyword_count: keywords.length, maximum: MAX_KEYWORDS },
    );
  }
  return keywords;
}

export async function prepareRun(input, options = {}) {
  const preflight = validatePreflight(input?.preflight);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const config = await resolveRunConfig(input ?? {}, cwd);
  if (config.browser_id && config.browser_id !== preflight.browser_id) {
    throw new RankTrackerError(
      "BROWSER_SELECTION_MISMATCH",
      `输入指定的 browser_id 与预检选中的在线浏览器不一致`,
      { configured: config.browser_id, preflight: preflight.browser_id },
    );
  }
  const keywords = await parseKeywordsFile(config.keywords_file);
  const projectPath = path.join(config.output_dir, "project.json");
  const existingProject = await readJsonIfExists(projectPath);
  if (existingProject) validateProjectIdentity(existingProject, config);

  const now = options.now instanceof Date ? options.now : new Date();
  const runId = options.runId ?? createRunId(now);
  const month = now.toISOString().slice(0, 7);
  const keywordHash = createHash("sha256")
    .update(keywords.join("\n"), "utf8")
    .digest("hex");
  const relativeOutputs = {
    target_history: "target-rank-history.csv",
    all_asins: path.posix.join("all-asins", month, `${runId}.csv`),
    report: "report.html",
    manifest: path.posix.join("runs", `${runId}.json`),
  };

  await mkdir(path.join(config.output_dir, "runs", ".staging", runId), { recursive: true });
  await mkdir(path.join(config.output_dir, "all-asins", month), { recursive: true });

  if (!existingProject) {
    await writeJsonAtomic(projectPath, {
      schema_version: SCHEMA_VERSION,
      asin: config.asin,
      marketplace: config.marketplace,
      created_at: now.toISOString(),
    });
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    status: "running",
    started_at: now.toISOString(),
    input: {
      asin: config.asin,
      marketplace: config.marketplace,
      pages: config.pages,
      keywords_file: config.keywords_file,
      keyword_count: keywords.length,
      keyword_sha256: keywordHash,
    },
    preflight,
    browser: {
      browser_id: preflight.browser_id,
      ...preflight.browser_meta,
    },
    keywords: keywords.map((keyword, index) => ({
      index,
      keyword,
      status: "pending",
      attempts: [],
    })),
    outputs: relativeOutputs,
  };
  await writeJsonAtomic(path.join(config.output_dir, relativeOutputs.manifest), manifest);

  return {
    ok: true,
    run_id: runId,
    output_dir: config.output_dir,
    browser_id: preflight.browser_id,
    action: ACTION_ID,
    tasks: keywords.map((keyword, keywordIndex) => ({
      keyword_index: keywordIndex,
      keyword,
      result_delivery: {
        mode: "artifact",
        targetAsin: config.asin,
      },
      params: {
        keyword,
        marketplace: config.marketplace,
        pages: config.pages,
        mode: "auto",
        screenshot: false,
        upload: true,
      },
    })),
    outputs: relativeOutputs,
  };
}

export async function recordResult(input, options = {}) {
  const outputDir = requiredAbsolutePath(input?.output_dir, "output_dir", options.cwd);
  const runId = requiredSafeRunId(input?.run_id);
  const manifestPath = path.join(outputDir, "runs", `${runId}.json`);
  const manifest = await readRequiredJson(manifestPath, "RUN_NOT_FOUND", "找不到指定的运行记录");
  if (manifest.status !== "running") {
    throw new RankTrackerError("RUN_FINALIZED", `运行 ${runId} 已结束，不能继续写入结果`);
  }
  const keywordIndex = toInteger(input?.keyword_index);
  if (keywordIndex === null || !manifest.keywords?.[keywordIndex]) {
    throw new RankTrackerError("INVALID_KEYWORD_INDEX", "keyword_index 不属于本次运行");
  }
  const task = input?.task;
  if (!task || !["completed", "failed"].includes(task.status)) {
    throw new RankTrackerError(
      "INVALID_TASK_RESULT",
      "任务状态 task.status 必须为 completed（已完成）或 failed（失败）",
    );
  }
  const attempts = normalizeAttempts(input?.attempts, task);
  const keywordState = manifest.keywords[keywordIndex];
  const recordedAt = validTimestamp(task.finishedAt ?? task.finished_at)
    ?? (options.now instanceof Date ? options.now : new Date()).toISOString();
  let stage;
  if (task.status === "completed") {
    try {
      const loaded = await loadCompletedBrowserResult(task, options);
      const normalized = normalizeBrowserResult(
        loaded.result,
        keywordState.keyword,
        manifest.input.marketplace,
      );
      stage = {
        schema_version: SCHEMA_VERSION,
        run_id: runId,
        keyword_index: keywordIndex,
        keyword: keywordState.keyword,
        status: normalized.blocked ? "blocked" : "completed",
        recorded_at: recordedAt,
        job_id: nonEmptyString(task.jobId ?? task.job_id)
          ? String(task.jobId ?? task.job_id)
          : attempts.at(-1)?.job_id ?? "",
        attempts,
        ...(loaded.source_artifact ? { source_artifact: loaded.source_artifact } : {}),
        ...normalized,
      };
    } catch (error) {
      if (!(error instanceof RankTrackerError) || !String(error.code).startsWith("ARTIFACT_")) throw error;
      stage = failedStage({
        runId,
        keywordIndex,
        keyword: keywordState.keyword,
        recordedAt,
        jobId: nonEmptyString(task.jobId ?? task.job_id)
          ? String(task.jobId ?? task.job_id)
          : attempts.at(-1)?.job_id ?? "",
        attempts,
        error: { code: error.code, message: error.message },
        sourceArtifact: sanitizeArtifactReference(task.artifact),
      });
    }
  } else {
    stage = failedStage({
      runId,
      keywordIndex,
      keyword: keywordState.keyword,
      recordedAt,
      jobId: nonEmptyString(task.jobId ?? task.job_id)
        ? String(task.jobId ?? task.job_id)
        : attempts.at(-1)?.job_id ?? "",
      attempts,
      error: normalizeError(task.error),
    });
  }

  const stagePath = stageResultPath(outputDir, runId, keywordIndex);
  await writeJsonAtomic(stagePath, stage);
  manifest.keywords[keywordIndex] = {
    ...keywordState,
    status: stage.status,
    recorded_at: stage.recorded_at,
    job_id: stage.job_id,
    attempts,
    ...(stage.error ? { error: stage.error } : {}),
    ...(stage.source_artifact ? { source_artifact: stage.source_artifact } : {}),
    ...(stage.status === "completed" || stage.status === "blocked"
      ? {
          blocked: stage.blocked,
          pages_completed: stage.pages_completed,
          result_count: stage.rows.length,
        }
      : {}),
  };
  await writeJsonAtomic(manifestPath, manifest);

  return {
    ok: true,
    run_id: runId,
    keyword_index: keywordIndex,
    keyword: keywordState.keyword,
    status: stage.status,
    result_count: stage.rows.length,
  };
}

export async function finalizeRun(input, options = {}) {
  const outputDir = requiredAbsolutePath(input?.output_dir, "output_dir", options.cwd);
  const runId = requiredSafeRunId(input?.run_id);
  const manifestPath = path.join(outputDir, "runs", `${runId}.json`);
  const manifest = await readRequiredJson(manifestPath, "RUN_NOT_FOUND", "找不到指定的运行记录");

  if (manifest.finalized_at) {
    const report = await renderReport({ output_dir: outputDir, asin: manifest.input.asin });
    return {
      ok: true,
      idempotent: true,
      run_id: runId,
      status: manifest.status,
      summary: manifest.summary,
      outputs: { ...manifest.outputs, report: relativeFrom(outputDir, report.report_path) },
    };
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const stageResults = new Map();
  for (const keyword of manifest.keywords) {
    const stage = await readJsonIfExists(stageResultPath(outputDir, runId, keyword.index));
    if (stage) stageResults.set(keyword.index, stage);
  }

  const targetRows = [];
  const rawRows = [];
  for (const keyword of manifest.keywords) {
    const stage = stageResults.get(keyword.index);
    if (stage) {
      targetRows.push(targetRowFromStage(manifest, keyword, stage));
      if (stage.status === "completed" || stage.status === "blocked") {
        for (const row of stage.rows) {
          rawRows.push({
            run_id: runId,
            collected_at: stage.recorded_at,
            marketplace: manifest.input.marketplace,
            keyword: keyword.keyword,
            ...row,
          });
        }
      }
    } else {
      targetRows.push(targetRowNotExecuted(manifest, keyword, now.toISOString()));
    }
  }

  const targetHistoryPath = path.join(outputDir, manifest.outputs.target_history);
  const existingTargetRows = await readCsvIfExists(targetHistoryPath);
  const existingKeys = new Set(
    existingTargetRows.map((row) => `${row.run_id}\u0000${row.keyword}`),
  );
  const mergedTargetRows = [...existingTargetRows];
  for (const row of targetRows) {
    const key = `${row.run_id}\u0000${row.keyword}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      mergedTargetRows.push(row);
    }
  }
  await writeCsvAtomic(targetHistoryPath, TARGET_COLUMNS, mergedTargetRows);

  const rawPath = path.join(outputDir, manifest.outputs.all_asins);
  await writeCsvAtomic(rawPath, RAW_COLUMNS, rawRows);

  const counts = countStatuses(targetRows);
  const hasPending = counts.not_executed > 0;
  const hasIssues = counts.failed > 0 || counts.blocked > 0;
  manifest.status = hasPending || input?.interrupted === true
    ? "incomplete"
    : hasIssues
      ? "completed_with_issues"
      : "completed";
  manifest.finished_at = now.toISOString();
  manifest.finalized_at = now.toISOString();
  manifest.summary = {
    keyword_count: manifest.keywords.length,
    raw_row_count: rawRows.length,
    ...counts,
  };
  await writeJsonAtomic(manifestPath, manifest);

  const report = await renderReport({ output_dir: outputDir, asin: manifest.input.asin });
  await rm(path.join(outputDir, "runs", ".staging", runId), {
    recursive: true,
    force: true,
  });

  return {
    ok: true,
    idempotent: false,
    run_id: runId,
    status: manifest.status,
    summary: manifest.summary,
    outputs: {
      ...manifest.outputs,
      report: relativeFrom(outputDir, report.report_path),
    },
  };
}

export async function renderReport(input, options = {}) {
  const outputDir = requiredAbsolutePath(input?.output_dir, "output_dir", options.cwd);
  const projectPath = path.join(outputDir, "project.json");
  const project = await readRequiredJson(
    projectPath,
    "PROJECT_NOT_FOUND",
    "输出目录中没有关键词排名追踪项目文件 project.json",
  );
  const asin = normalizeAsin(input?.asin ?? project.asin);
  let rows;
  if (asin === project.asin) {
    rows = (await readCsvIfExists(path.join(outputDir, "target-rank-history.csv")))
      .filter((row) => normalizeAsinLoose(row.target_asin) === asin);
  } else {
    rows = await buildObservedAsinHistory(outputDir, project, asin);
    if (!rows.some((row) => row.target_found === true || row.target_found === "true")) {
      throw new RankTrackerError(
        "ASIN_NOT_OBSERVED",
        `全量历史中没有找到 ASIN ${asin}，无法生成趋势报告`,
      );
    }
  }
  if (rows.length === 0) {
    throw new RankTrackerError("NO_HISTORY", `ASIN ${asin} 暂无可生成报告的历史数据`);
  }
  rows.sort(compareCollectedAt);

  const latestRunId = rows.at(-1)?.run_id ?? "";
  const latestManifest = latestRunId
    ? await readJsonIfExists(path.join(outputDir, "runs", `${latestRunId}.json`))
    : null;
  const isTarget = asin === project.asin;
  const reportPath = isTarget
    ? path.join(outputDir, "report.html")
    : path.join(outputDir, "reports", `${asin}.html`);
  const prefix = isTarget ? "" : "../";
  const latestRaw = latestManifest?.outputs?.all_asins
    ? `${prefix}${latestManifest.outputs.all_asins}`
    : null;
  const html = renderDashboardHtml({
    project,
    asin,
    rows,
    targetHistoryHref: `${prefix}target-rank-history.csv`,
    latestRawHref: latestRaw,
  });
  await writeTextAtomic(reportPath, html);
  return {
    ok: true,
    asin,
    observation_count: rows.length,
    report_path: reportPath,
  };
}

async function resolveRunConfig(input, cwd) {
  let fileConfig = {};
  let configDir = cwd;
  if (nonEmptyString(input.config_path)) {
    const configPath = resolveFrom(cwd, input.config_path);
    fileConfig = await readRequiredJson(
      configPath,
      "CONFIG_UNREADABLE",
      `无法读取配置文件：${configPath}`,
    );
    configDir = path.dirname(configPath);
  }
  const valueFor = (name) => Object.hasOwn(input, name) && input[name] !== undefined
    ? { value: input[name], base: cwd }
    : { value: fileConfig[name], base: configDir };

  const asin = normalizeAsin(valueFor("asin").value);
  const marketplaceRaw = valueFor("marketplace").value;
  if (!nonEmptyString(marketplaceRaw)) {
    throw new RankTrackerError("MISSING_MARKETPLACE", "必须明确提供站点 marketplace");
  }
  const marketplace = String(marketplaceRaw).trim().toUpperCase();
  const pages = toInteger(valueFor("pages").value);
  if (pages === null || pages < 1 || pages > 10) {
    throw new RankTrackerError("INVALID_PAGES", "必须明确提供抓取页数 pages，且为 1–10 的整数");
  }
  const keywordSource = valueFor("keywords_file");
  if (!nonEmptyString(keywordSource.value)) {
    throw new RankTrackerError("MISSING_KEYWORDS_FILE", "必须明确提供关键词文件 keywords_file");
  }
  const outputSource = valueFor("output_dir");
  if (!nonEmptyString(outputSource.value)) {
    throw new RankTrackerError("MISSING_OUTPUT_DIR", "必须明确提供输出目录 output_dir");
  }
  const browserSource = valueFor("browser_id");
  return {
    asin,
    marketplace,
    pages,
    keywords_file: resolveFrom(keywordSource.base, keywordSource.value),
    output_dir: resolveFrom(outputSource.base, outputSource.value),
    browser_id: nonEmptyString(browserSource.value)
      ? String(browserSource.value).trim()
      : null,
  };
}

function validateProjectIdentity(project, config) {
  if (project.schema_version !== SCHEMA_VERSION) {
    throw new RankTrackerError(
      "PROJECT_SCHEMA_MISMATCH",
      `不支持的项目结构版本 schema_version：${project.schema_version}`,
    );
  }
  if (project.asin !== config.asin || project.marketplace !== config.marketplace) {
    throw new RankTrackerError(
      "PROJECT_IDENTITY_MISMATCH",
      "输出目录 output_dir 已属于另一个 ASIN 或站点 marketplace，拒绝混写历史数据",
      {
        existing: { asin: project.asin, marketplace: project.marketplace },
        requested: { asin: config.asin, marketplace: config.marketplace },
      },
    );
  }
}

function normalizeAttempts(value, task) {
  const attempts = Array.isArray(value) && value.length > 0
    ? value
    : [{
        job_id: task.jobId ?? task.job_id ?? "",
        status: task.status,
        error: task.error,
      }];
  if (attempts.length > 2) {
    throw new RankTrackerError(
      "TOO_MANY_ATTEMPTS",
      "单个关键词最多允许首次执行加一次重试",
    );
  }
  const normalized = attempts.map((attempt) => {
    const error = normalizeError(attempt?.error);
    return {
      job_id: nonEmptyString(attempt?.job_id ?? attempt?.jobId)
        ? String(attempt.job_id ?? attempt.jobId)
        : "",
      status: nonEmptyString(attempt?.status) ? String(attempt.status) : "unknown",
      ...(error.code || error.message ? { error } : {}),
    };
  });
  if (normalized.length === 2) {
    const first = normalized[0];
    if (first.status !== "failed" || !["TIMEOUT", "ACTION_FAILED"].includes(first.error?.code)) {
      throw new RankTrackerError(
        "RETRY_NOT_ALLOWED",
        "只有首次出现超时（TIMEOUT）或动作失败（ACTION_FAILED）才允许第二次尝试",
      );
    }
  }
  if (normalized.at(-1)?.status !== task.status) {
    throw new RankTrackerError(
      "ATTEMPT_STATUS_MISMATCH",
      "最后一次尝试的状态必须与 task.status 一致",
    );
  }
  return normalized;
}

function failedStage({
  runId,
  keywordIndex,
  keyword,
  recordedAt,
  jobId,
  attempts,
  error,
  sourceArtifact,
}) {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    keyword_index: keywordIndex,
    keyword,
    status: "failed",
    recorded_at: recordedAt,
    job_id: jobId,
    attempts,
    error,
    ...(sourceArtifact ? { source_artifact: sourceArtifact } : {}),
    blocked: false,
    pages_completed: 0,
    rows: [],
  };
}

async function loadCompletedBrowserResult(task, options) {
  if (task.artifact !== undefined && task.result !== undefined) {
    throw new RankTrackerError(
      "ARTIFACT_RESPONSE_CONFLICT",
      "已完成任务不能同时携带全量 result 和结果文件引用",
    );
  }
  if (task.artifact !== undefined) {
    return await downloadBrowserArtifact(task.artifact, options);
  }
  if (task.result !== undefined) {
    return { result: task.result, source_artifact: null };
  }
  throw new RankTrackerError("INVALID_BROWSER_RESULT", "已完成任务缺少 result 或结果文件引用");
}

export async function downloadBrowserArtifact(artifact, options = {}) {
  const reference = validateArtifactReference(artifact);
  let url;
  try {
    url = new URL(reference.downloadUrl);
  } catch {
    throw new RankTrackerError("ARTIFACT_REFERENCE_INVALID", "结果文件下载地址 downloadUrl 格式无效");
  }
  const localHttp = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new RankTrackerError(
      "ARTIFACT_URL_UNSAFE",
      "结果文件下载地址必须使用 HTTPS；仅本机测试允许 HTTP 回环地址",
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RankTrackerError("ARTIFACT_DOWNLOAD_FAILED", "当前 Node.js 环境不支持下载结果文件");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARTIFACT_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    const reason = error?.name === "AbortError" ? "下载超时" : "网络请求失败";
    throw new RankTrackerError("ARTIFACT_DOWNLOAD_FAILED", `结果文件${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new RankTrackerError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `结果文件下载失败（HTTP ${response.status}）`,
    );
  }

  const bytes = await readResponseBytes(response, MAX_ARTIFACT_BYTES);
  if (reference.uncompressedSizeBytes !== bytes.byteLength) {
    throw new RankTrackerError(
      "ARTIFACT_SIZE_MISMATCH",
      "结果文件解压后大小与引用元数据不一致",
      { expected: reference.uncompressedSizeBytes, actual: bytes.byteLength },
    );
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== reference.sha256) {
    throw new RankTrackerError(
      "ARTIFACT_CHECKSUM_MISMATCH",
      "结果文件 SHA-256 校验失败",
    );
  }
  let result;
  try {
    result = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new RankTrackerError("ARTIFACT_INVALID_JSON", "结果文件内容不是有效 JSON");
  }
  return {
    result,
    source_artifact: {
      ...sanitizeArtifactReference(reference),
      downloaded_at: new Date().toISOString(),
    },
  };
}

function validateArtifactReference(value) {
  if (!value || typeof value !== "object") {
    throw new RankTrackerError("ARTIFACT_REFERENCE_INVALID", "缺少有效的结果文件引用");
  }
  const schemaVersion = toInteger(value.schemaVersion);
  const uncompressedSizeBytes = toInteger(value.uncompressedSizeBytes);
  if (schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new RankTrackerError(
      "ARTIFACT_SCHEMA_UNSUPPORTED",
      `不支持的结果文件结构版本 schemaVersion=${schemaVersion}`,
    );
  }
  if (!nonEmptyString(value.id) || !nonEmptyString(value.downloadUrl)) {
    throw new RankTrackerError("ARTIFACT_REFERENCE_INVALID", "结果文件引用缺少 id 或 downloadUrl");
  }
  if (!/^[0-9a-f]{64}$/i.test(String(value.sha256 ?? ""))) {
    throw new RankTrackerError("ARTIFACT_REFERENCE_INVALID", "结果文件引用缺少有效 SHA-256");
  }
  if (uncompressedSizeBytes === null || uncompressedSizeBytes < 0 || uncompressedSizeBytes > MAX_ARTIFACT_BYTES) {
    throw new RankTrackerError(
      "ARTIFACT_TOO_LARGE",
      `结果文件解压后大小必须在 0–${MAX_ARTIFACT_BYTES} 字节范围内`,
    );
  }
  return {
    ...value,
    schemaVersion,
    id: String(value.id),
    downloadUrl: String(value.downloadUrl),
    sha256: String(value.sha256).toLowerCase(),
    uncompressedSizeBytes,
  };
}

function sanitizeArtifactReference(value) {
  if (!value || typeof value !== "object") return null;
  const safe = {};
  for (const key of [
    "schemaVersion",
    "id",
    "format",
    "contentType",
    "contentEncoding",
    "sha256",
    "sizeBytes",
    "uncompressedSizeBytes",
    "createdAt",
    "retentionExpiresAt",
    "downloadExpiresAt",
  ]) {
    if (value[key] !== undefined && value[key] !== null) safe[key] = value[key];
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

async function readResponseBytes(response, maximumBytes) {
  if (!response.body) {
    throw new RankTrackerError("ARTIFACT_DOWNLOAD_FAILED", "结果文件响应没有内容");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RankTrackerError(
          "ARTIFACT_TOO_LARGE",
          `结果文件解压后超过 ${maximumBytes} 字节限制`,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function normalizeBrowserResult(result, keyword, marketplace) {
  if (!result || typeof result !== "object") {
    throw new RankTrackerError("INVALID_BROWSER_RESULT", "已完成任务缺少结果对象 result");
  }
  const pages = Array.isArray(result.pages) ? result.pages : [];
  const rows = [];
  pages.forEach((pageResult, pageIndex) => {
    const pageNumber = toInteger(pageResult?.page) ?? pageIndex + 1;
    const pageMode = nonEmptyString(pageResult?.mode) ? String(pageResult.mode) : "";
    const pageUrl = nonEmptyString(pageResult?.url) ? String(pageResult.url) : "";
    const items = Array.isArray(pageResult?.asins) ? pageResult.asins : [];
    for (const item of items) {
      const asin = normalizeAsinLoose(item?.asin);
      if (!asin) continue;
      rows.push({
        page: pageNumber,
        page_mode: pageMode,
        page_url: pageUrl,
        position: toInteger(item?.rank),
        natural_rank: toInteger(item?.naturalRank),
        asin,
        ad_type: nonEmptyString(item?.adType) ? String(item.adType).trim() : "",
      });
    }
  });
  return {
    keyword,
    marketplace,
    blocked: result.blocked === true,
    requested_mode: nonEmptyString(result.requestedMode)
      ? String(result.requestedMode)
      : "auto",
    pages_completed: pages.length,
    rows,
  };
}

function targetRowFromStage(manifest, keywordState, stage) {
  if (stage.status === "failed") {
    return baseTargetRow(manifest, keywordState, stage.recorded_at, {
      status: "failed",
      error_code: stage.error?.code ?? "",
      error_message: stage.error?.message ?? "",
    });
  }
  if (stage.blocked === true || stage.status === "blocked") {
    return baseTargetRow(manifest, keywordState, stage.recorded_at, {
      pages_completed: stage.pages_completed,
      result_count: stage.rows.length,
      blocked: true,
      status: "blocked",
    });
  }
  const matches = stage.rows.filter((row) => row.asin === manifest.input.asin);
  const naturalRanks = matches
    .map((row) => toInteger(row.natural_rank))
    .filter((rank) => rank !== null);
  const adRows = matches.filter(
    (row) => toInteger(row.natural_rank) === null && nonEmptyString(row.ad_type),
  );
  const adPositions = adRows
    .map((row) => toInteger(row.position))
    .filter((rank) => rank !== null);
  const overallPositions = matches
    .map((row) => toInteger(row.position))
    .filter((rank) => rank !== null);
  const adTypes = [...new Set(adRows.map((row) => row.ad_type).filter(Boolean))].sort();
  return baseTargetRow(manifest, keywordState, stage.recorded_at, {
    pages_completed: stage.pages_completed,
    result_count: stage.rows.length,
    blocked: false,
    target_found: matches.length > 0,
    natural_found: naturalRanks.length > 0,
    natural_rank: minOrBlank(naturalRanks),
    ad_found: adRows.length > 0,
    best_ad_position: minOrBlank(adPositions),
    ad_types: adTypes.join(" | "),
    ad_occurrence_count: adRows.length,
    best_overall_position: minOrBlank(overallPositions),
    status: matches.length > 0 ? "ok" : "not_found",
  });
}

function targetRowNotExecuted(manifest, keywordState, collectedAt) {
  return baseTargetRow(manifest, keywordState, collectedAt, {
    status: "not_executed",
  });
}

function baseTargetRow(manifest, keywordState, collectedAt, overrides = {}) {
  return {
    run_id: manifest.run_id,
    collected_at: collectedAt,
    marketplace: manifest.input.marketplace,
    target_asin: manifest.input.asin,
    keyword: keywordState.keyword,
    pages_requested: manifest.input.pages,
    pages_completed: 0,
    result_count: 0,
    blocked: false,
    target_found: false,
    natural_found: false,
    natural_rank: "",
    ad_found: false,
    best_ad_position: "",
    ad_types: "",
    ad_occurrence_count: 0,
    best_overall_position: "",
    status: "not_executed",
    error_code: "",
    error_message: "",
    ...overrides,
  };
}

async function buildObservedAsinHistory(outputDir, project, asin) {
  const runsDir = path.join(outputDir, "runs");
  let entries = [];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const manifest = await readJsonIfExists(path.join(runsDir, entry.name));
    if (manifest?.finalized_at && manifest?.outputs?.all_asins) manifests.push(manifest);
  }
  manifests.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const history = [];
  for (const manifest of manifests) {
    const rawRows = await readCsvIfExists(path.join(outputDir, manifest.outputs.all_asins));
    const allByKeyword = new Map();
    const matchedByKeyword = new Map();
    for (const row of rawRows) {
      const keyword = row.keyword;
      if (!allByKeyword.has(keyword)) allByKeyword.set(keyword, []);
      allByKeyword.get(keyword).push(row);
      if (normalizeAsinLoose(row.asin) === asin) {
        if (!matchedByKeyword.has(keyword)) matchedByKeyword.set(keyword, []);
        matchedByKeyword.get(keyword).push(row);
      }
    }
    for (const keywordState of manifest.keywords ?? []) {
      const matches = matchedByKeyword.get(keywordState.keyword) ?? [];
      const keywordRows = allByKeyword.get(keywordState.keyword) ?? [];
      const naturalRanks = matches
        .map((row) => toInteger(row.natural_rank))
        .filter((rank) => rank !== null);
      const adRows = matches.filter(
        (row) => toInteger(row.natural_rank) === null && nonEmptyString(row.ad_type),
      );
      const adPositions = adRows
        .map((row) => toInteger(row.position))
        .filter((rank) => rank !== null);
      const overallPositions = matches
        .map((row) => toInteger(row.position))
        .filter((rank) => rank !== null);
      const pagesCompleted = toInteger(keywordState.pages_completed) ?? keywordRows.reduce(
        (max, row) => Math.max(max, toInteger(row.page) ?? 0),
        0,
      );
      const sourceStatus = keywordState.status;
      const status = sourceStatus === "failed"
        ? "failed"
        : sourceStatus === "blocked"
          ? "blocked"
          : sourceStatus === "pending"
            ? "not_executed"
            : matches.length > 0
              ? "ok"
              : "not_found";
      const blocked = status === "blocked";
      history.push({
        run_id: manifest.run_id,
        collected_at: keywordState.recorded_at ?? manifest.finished_at ?? manifest.started_at,
        marketplace: project.marketplace,
        target_asin: asin,
        keyword: keywordState.keyword,
        pages_requested: manifest.input.pages,
        pages_completed: pagesCompleted,
        result_count: toInteger(keywordState.result_count) ?? keywordRows.length,
        blocked,
        target_found: blocked ? false : matches.length > 0,
        natural_found: blocked ? false : naturalRanks.length > 0,
        natural_rank: blocked ? "" : minOrBlank(naturalRanks),
        ad_found: blocked ? false : adRows.length > 0,
        best_ad_position: blocked ? "" : minOrBlank(adPositions),
        ad_types: blocked ? "" : [...new Set(adRows.map((row) => row.ad_type).filter(Boolean))].sort().join(" | "),
        ad_occurrence_count: blocked ? 0 : adRows.length,
        best_overall_position: blocked ? "" : minOrBlank(overallPositions),
        status,
        error_code: keywordState.error?.code ?? "",
        error_message: keywordState.error?.message ?? "",
      });
    }
  }
  return history;
}

function countStatuses(rows) {
  const counts = { ok: 0, not_found: 0, blocked: 0, failed: 0, not_executed: 0 };
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

function normalizeAsin(value) {
  const asin = nonEmptyString(value) ? String(value).trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new RankTrackerError("INVALID_ASIN", "ASIN 必须为 10 位字母数字");
  }
  return asin;
}

function normalizeAsinLoose(value) {
  const asin = nonEmptyString(value) ? String(value).trim().toUpperCase() : "";
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : "";
}

function normalizeError(value) {
  if (!value || typeof value !== "object") return { code: "", message: "" };
  return {
    code: nonEmptyString(value.code) ? String(value.code) : "",
    message: nonEmptyString(value.message) ? String(value.message) : "",
  };
}

function sanitizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe = {};
  for (const key of ["name", "browser", "version", "os", "profile"]) {
    if (nonEmptyString(value[key])) safe[key] = String(value[key]);
  }
  return safe;
}

function requiredAbsolutePath(value, name, cwd = process.cwd()) {
  if (!nonEmptyString(value)) {
    throw new RankTrackerError(`MISSING_${name.toUpperCase()}`, `必须提供 ${name}`);
  }
  return resolveFrom(path.resolve(cwd ?? process.cwd()), value);
}

function requiredSafeRunId(value) {
  if (!nonEmptyString(value) || !/^[A-Za-z0-9_-]+$/.test(String(value))) {
    throw new RankTrackerError("INVALID_RUN_ID", "run_id 格式无效");
  }
  return String(value);
}

function stageResultPath(outputDir, runId, index) {
  return path.join(
    outputDir,
    "runs",
    ".staging",
    runId,
    `${String(index).padStart(3, "0")}.json`,
  );
}

function createRunId(now) {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function resolveFrom(base, value) {
  return path.resolve(base, String(value));
}

function relativeFrom(base, target) {
  return path.relative(base, target).split(path.sep).join("/");
}

function minOrBlank(values) {
  return values.length > 0 ? Math.min(...values) : "";
}

function toInteger(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && Number.isFinite(number) ? number : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value)) ? String(value) : null;
}

function compareCollectedAt(a, b) {
  return String(a.collected_at).localeCompare(String(b.collected_at));
}

async function readRequiredJson(filePath, code, message) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new RankTrackerError(code, message, { path: filePath, cause: String(error) });
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new RankTrackerError(
      "INVALID_JSON_FILE",
      `JSON 文件无法读取或格式无效：${filePath}`,
      { cause: String(error) },
    );
  }
}

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeCsvAtomic(filePath, columns, rows) {
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  await writeTextAtomic(filePath, `\uFEFF${lines.join("\r\n")}\r\n`);
}

function csvCell(value) {
  const text = value === null || value === undefined
    ? ""
    : String(value).replace(/[\r\n]+/g, " ");
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readCsvIfExists(filePath) {
  try {
    await access(filePath);
  } catch {
    return [];
  }
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  const rows = [];
  for await (const lineValue of lines) {
    const line = headers ? lineValue : lineValue.replace(/^\uFEFF/, "");
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    if (!line) continue;
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ""; });
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

async function readCliInput() {
  if (process.stdin.isTTY) {
    throw new RankTrackerError(
      "TTY_STDIN_FORBIDDEN",
      "请通过非终端标准输入发送单行紧凑 JSON，避免浏览器结果被终端回显",
    );
  }
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    input.close();
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new RankTrackerError(
        "INVALID_STDIN_JSON",
        "标准输入的第一条非空内容必须是单行有效 JSON",
        { cause: String(error) },
      );
    }
  }
  return {};
}

export async function executeCommand(command, input, options = {}) {
  if (command === "prepare-run") return await prepareRun(input, options);
  if (command === "record-result") return await recordResult(input, options);
  if (command === "finalize-run") return await finalizeRun(input, options);
  if (command === "render-report") return await renderReport(input, options);
  throw new RankTrackerError(
    "UNKNOWN_COMMAND",
    "命令必须为 prepare-run、record-result、finalize-run 或 render-report",
  );
}

async function main() {
  try {
    const command = process.argv[2];
    const input = await readCliInput();
    const result = await executeCommand(command, input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const payload = error instanceof RankTrackerError
      ? { ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
      : { ok: false, error: { code: "UNEXPECTED_ERROR", message: String(error) } };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) await main();
