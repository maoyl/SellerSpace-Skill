import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ACTION_ID, validatePreflight, downloadBrowserArtifact } from "./review-source.mjs";
import { AnalysisError, requireValue, STARS, MARKETS, normalizeResult, nextBatch, acceptBatch, mergeTopics, aggregate, representativeEvidence, validateFindings, hash, csv } from "./analysis-core.mjs";
import { withProjectLock, readJsonIfExists, writeJson, writeAtomic } from "./local-store.mjs";
import { renderReportHtml } from "./render-report.mjs";

const timestamp = (options) => (options.now instanceof Date ? options.now : new Date()).toISOString();
const terminal = (task) => ["completed", "failed", "skipped"].includes(task.status);
const fatal = (code) => /LOGIN|CAPTCHA|BLOCKED|OFFLINE|AUTH|UNAUTHORIZED|SUBMISSION_UNKNOWN|TASK_NOT_FOUND|POLL_TIMEOUT|TRANSPORT/i.test(code ?? "");
const requiredOutput = (input) => { requireValue(typeof input.output_dir === "string" && input.output_dir.trim(), "MISSING_OUTPUT", "必须指定 output_dir"); return path.resolve(input.output_dir); };
const safeError = (error) => ({ code: String(error?.code ?? "ACTION_FAILED").slice(0, 150), message: String(error?.message ?? "操作失败").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 1000) });

function taskParams(run, task) {
  return { asin: task.asin, marketplace: run.marketplace, crawlMode: "snapshot", starFilters: [...STARS],
    includeHelpful: false, timeoutMs: Math.max(30000, run.settings.timeout_ms - task.spent_ms), closeTab: true,
    ...(run.settings.max_reviews === null ? {} : { maxReviews: run.settings.max_reviews }) };
}

export async function prepareRun(input, options = {}) {
  // A real MCP receipt is required before touching inputs or creating a project.
  const receipt = validatePreflight(input.preflight);
  const rawConfig = input.config_path ? JSON.parse(await readFile(path.resolve(input.config_path), "utf8")) : {};
  const config = { ...rawConfig, ...input };
  const base = input.config_path ? path.dirname(path.resolve(input.config_path)) : process.cwd();
  for (const field of ["asins_file", "output_dir"]) if (config[field]) config[field] = path.resolve(Object.hasOwn(input, field) ? process.cwd() : base, config[field]);
  requireValue(!config.browser_id || config.browser_id === receipt.browser_id, "BROWSER_SELECTION_MISMATCH", "指定浏览器与预检不符");
  requireValue(Object.hasOwn(MARKETS, config.marketplace), "INVALID_MARKETPLACE", "marketplace 必须为插件支持的站点 code");
  requireValue([config.asin, config.asins, config.asins_file].filter((v) => v != null).length === 1,
    "INVALID_ASINS", "asin、asins、asins_file 必须三选一");
  let values = config.asins_file ? (await readFile(config.asins_file, "utf8")).replace(/^\uFEFF/, "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"))
    : config.asin ? [config.asin] : config.asins;
  requireValue(Array.isArray(values) && values.every((v) => typeof v === "string" && /^[A-Z0-9]{10}$/i.test(v.trim())), "INVALID_ASIN", "ASIN 必须为 10 位字母或数字");
  values = [...new Set(values.map((v) => v.trim().toUpperCase()))];
  requireValue(values.length >= 1 && values.length <= 10, "INVALID_ASIN_COUNT", "一次支持 1–10 个 ASIN");
  const timeout = config.timeout_ms ?? 600000;
  const max = config.max_reviews ?? null;
  requireValue(Number.isInteger(timeout) && timeout >= 30000 && timeout <= 600000, "INVALID_BUDGET", "每个 ASIN 的 timeout_ms 必须为 30000–600000");
  requireValue(max === null || Number.isSafeInteger(max) && max > 0, "INVALID_BUDGET", "max_reviews 省略或为 null 表示不限；其他值必须为正整数");
  const output = requiredOutput(config);
  return withProjectLock(output, async () => {
    requireValue(!await readJsonIfExists(path.join(output, "run.json")), "RUN_EXISTS", "目录已有运行；请恢复该运行或使用新目录");
    const run = { schema_version: 1, run_id: randomUUID(), created_at: timestamp(options), marketplace: config.marketplace,
      settings: { timeout_ms: timeout, max_reviews: max }, preflight: receipt, stopped: false, interrupted: false,
      tasks: values.map((asin, index) => ({ index, asin, status: "pending", attempts: [], spent_ms: 0 })),
      topics: [], annotations: {}, recorded_batches: {}, findings: [], analysis_revision: 0, findings_revision: null };
    await writeJson(path.join(output, "run.json"), run);
    return { ok: true, output_dir: output, run_id: run.run_id, browser_id: receipt.browser_id,
      asin_count: values.length, per_asin_timeout_ms: timeout, total_collection_budget_ms: values.length * timeout };
  }, true);
}

async function load(output) {
  const run = await readJsonIfExists(path.join(output, "run.json"));
  requireValue(run?.schema_version === 1, "RUN_NOT_FOUND", "缺少兼容的 run.json");
  // Recover a downloaded result even if the process died before updating run.json.
  for (const task of run.tasks.filter((t) => !terminal(t))) {
    const saved = await readJsonIfExists(path.join(output, "raw", `${task.asin}.json`));
    if (saved && saved.job_id === task.attempts.at(-1)?.job_id) applyCompleted(run, task, saved);
  }
  return run;
}

function applyCompleted(run, task, saved) {
  const result = normalizeResult(saved.result, task.attempts.at(-1).params);
  task.status = "completed"; task.coverage = result.coverage; task.slices = result.slices; task.reliable = result.reliable;
  task.collected_count = result.reviews.length; task.captured_at = result.captured_at;
  task.duplicates_removed = result.duplicates_removed;
  task.attempts.at(-1).status = "completed";
  delete task.attempts.at(-1).error;
  delete task.error;
  if (Number.isFinite(saved.result.elapsedMs) && saved.result.elapsedMs >= 0)
    task.spent_ms = Math.min(run.settings.timeout_ms, task.spent_ms + saved.result.elapsedMs);
  task.artifact = saved.source_artifact;
  if (result.blocked) { run.stopped = true; run.stop_reason = result.coverage.stopReason || "BLOCKED"; }
}

async function allReviews(output, run) {
  const rows = [];
  for (const task of run.tasks.filter((t) => t.status === "completed")) {
    const saved = await readJsonIfExists(path.join(output, "raw", `${task.asin}.json`));
    requireValue(saved, "RAW_RESULT_MISSING", "已完成任务缺少原始文件");
    rows.push(...normalizeResult(saved.result, task.attempts.at(-1).params).reviews);
  }
  return rows;
}

function progress(run) {
  return { ok: true, run_id: run.run_id, browser_id: run.preflight.browser_id, stopped: run.stopped,
    stop_reason: run.stop_reason ?? null, interrupted: run.interrupted, finalized_at: run.finalized_at ?? null,
    tasks: run.tasks.map(({ index, asin, status, claim_id, attempts, spent_ms, collected_count, error }) =>
      ({ index, asin, status, claim_id, job_id: attempts.at(-1)?.job_id ?? null, attempts: attempts.map(({ params, ...rest }) => rest), spent_ms, collected_count, error })),
    analyzed_units: Object.keys(run.annotations).length, topic_count: run.topics.length, analysis_revision: run.analysis_revision };
}

export async function command(name, input, options = {}) {
  if (name === "prepare-run") return prepareRun(input, options);
  // Rebuilding/analyzing previously collected files is offline; resume collection checks live receipt.
  const receipt = name === "resume-run" ? validatePreflight(input.preflight) : null;
  const output = requiredOutput(input);
  if (name === "status-run") return progress(await load(output));
  return withProjectLock(output, async () => {
    const run = await load(output);
    if (input.run_id) requireValue(input.run_id === run.run_id, "RUN_MISMATCH", "run_id 与目录不符");
    const save = () => writeJson(path.join(output, "run.json"), run);
    const mutable = () => requireValue(!run.finalized_at, "RUN_FINALIZED", "本次报告已归档；新采集请使用新目录，重建请 render-report");
    if (name === "resume-run") {
      mutable();
      requireValue(receipt.browser_id === run.preflight.browser_id, "BROWSER_SELECTION_MISMATCH", "恢复必须使用原浏览器");
      run.preflight = receipt;
      const unknown = run.tasks.find((t) => t.status === "claimed");
      requireValue(!unknown, "SUBMISSION_UNKNOWN", "有已领取但无 jobId 的任务；先从原工具响应找回并登记，否则 finish-collection 中断，不能重复提交");
      run.stopped = false; delete run.stop_reason;
      await save(); return progress(run);
    }
    if (name === "next-task") {
      mutable();
      if (run.stopped) return { stopped: true, reason: run.stop_reason, next_action: "finish-collection" };
      const task = run.tasks.find((t) => !terminal(t));
      if (!task) { await save(); return { done: true, next_action: "next-analysis-batch" }; }
      if (task.status === "running") return { waiting: true, job_id: task.attempts.at(-1).job_id,
        poll_deadline: task.attempts.at(-1).poll_deadline, index: task.index };
      if (task.status === "claimed") return { waiting: true, job_id: null, index: task.index, error: "SUBMISSION_UNKNOWN" };
      requireValue(run.settings.timeout_ms - task.spent_ms >= 30000, "BUDGET_EXHAUSTED", "该 ASIN 的剩余预算不足");
      task.status = "claimed"; task.claim_id = randomUUID(); task.claimed_at = timestamp(options);
      task.pending_params = taskParams(run, task);
      await save();
      return { task: { index: task.index, asin: task.asin, claim_id: task.claim_id, browser_id: run.preflight.browser_id,
        action: ACTION_ID, params: task.pending_params, result_delivery: { mode: "artifact", targetAsin: task.asin } } };
    }
    if (name === "record-submission") {
      mutable(); const task = run.tasks[input.index];
      requireValue(task && typeof input.job_id === "string" && input.job_id.trim(), "INVALID_SUBMISSION", "缺少任务或 job_id");
      if (task.attempts.some((a) => a.job_id === input.job_id)) return { ok: true, idempotent: true };
      requireValue(task.status === "claimed" && input.claim_id === task.claim_id && task.attempts.length < 2,
        "INVALID_CLAIM", "领取标记或尝试次数不符");
      const submitted = timestamp(options);
      task.attempts.push({ job_id: input.job_id, status: "running", submitted_at: submitted,
        poll_deadline: new Date(Date.parse(submitted) + task.pending_params.timeoutMs + 60000).toISOString(), params: task.pending_params });
      task.status = "running"; delete task.pending_params;
      await save(); return { ok: true, poll_deadline: task.attempts.at(-1).poll_deadline };
    }
    if (name === "record-result") {
      mutable(); const task = run.tasks[input.index];
      requireValue(task, "INVALID_TASK", "任务 index 无效");
      const last = task.attempts.at(-1); const outcome = input.task;
      const retryDownload = task.status === "failed" && task.error?.code === "ARTIFACT_DOWNLOAD_FAILED"
        && last?.browser_status === "completed" && last.job_id === outcome?.jobId && outcome?.status === "completed"
        && (task.download_attempts ?? 0) < 2;
      if (terminal(task) && last?.job_id && last.job_id === outcome?.jobId && !retryDownload)
        return { ok: task.status === "completed", status: task.status, error: task.error ?? null, idempotent: true };
      if (retryDownload) requireValue(!Object.keys(run.annotations).length, "ANALYSIS_ALREADY_STARTED", "分析开始后不能改变样本；重试下载应在标注之前完成");
      const beforeSubmit = task.status === "claimed" && !outcome?.jobId && input.claim_id === task.claim_id;
      requireValue(outcome && (beforeSubmit || retryDownload || task.status === "running" && last?.job_id === outcome.jobId)
        && ["completed", "failed"].includes(outcome.status), "TASK_RESULT_MISMATCH", "仅记录当前已提交任务的终态；提交失败需要原 claim_id");
      if (!beforeSubmit && last) last.browser_status = outcome.status;
      let failure = outcome.status === "failed" ? safeError(outcome.error) : null;
      if (!failure) {
        try {
          requireValue(!beforeSubmit && outcome.artifact && outcome.result === undefined, "ARTIFACT_REQUIRED", "成功任务必须有真实 Artifact，生产不接受 inline 数据");
          task.download_attempts = (task.download_attempts ?? 0) + 1;
          const saved = await downloadBrowserArtifact(outcome.artifact, options.downloadOptions ?? {});
          normalizeResult(saved.result, last.params);
          const staged = { job_id: last.job_id, ...saved };
          await writeJson(path.join(output, "raw", `${task.asin}.json`), staged);
          applyCompleted(run, task, staged);
          delete task.error;
        } catch (error) { failure = safeError(error); }
      }
      if (failure) {
        task.error = failure;
        if (!beforeSubmit && last) {
          last.status = "failed"; last.error = failure;
          if (outcome.status === "failed") {
            const spent = Math.max(0, Date.parse(timestamp(options)) - Date.parse(last.submitted_at));
            task.spent_ms = Math.min(run.settings.timeout_ms, task.spent_ms + spent);
          }
        }
        const canRetry = !beforeSubmit && outcome.status === "failed" && ["TIMEOUT", "ACTION_FAILED"].includes(failure.code)
          && task.attempts.length < 2 && run.settings.timeout_ms - task.spent_ms >= 30000;
        task.status = canRetry ? "pending" : "failed";
        if (fatal(failure.code)) { run.stopped = true; run.stop_reason = failure.code; }
      }
      delete task.pending_params;
      await save(); return { ok: !failure, status: task.status, error: failure, retry_queued: task.status === "pending", should_stop: run.stopped,
        download_retry_allowed: failure?.code === "ARTIFACT_DOWNLOAD_FAILED" && (task.download_attempts ?? 0) < 2 };
    }
    if (name === "finish-collection") {
      mutable();
      if (run.tasks.some((t) => !terminal(t))) requireValue(input.interrupted === true, "COLLECTION_PENDING", "还有未结束的采集；主动中断时传 interrupted=true");
      run.interrupted ||= input.interrupted === true;
      for (const task of run.tasks.filter((t) => !terminal(t))) {
        task.error = { code: task.status === "pending" ? "NOT_EXECUTED" : "SUBMISSION_UNKNOWN", message: "本轮已停止；已提交的浏览器任务不代表已被取消" };
        task.status = "skipped";
      }
      await save(); return { ok: true, next_action: "next-analysis-batch" };
    }
    requireValue(run.tasks.every(terminal), "COLLECTION_PENDING", "先结束采集再分析，避免数据范围在分析期间变化");
    const reviews = await allReviews(output, run);
    if (name === "next-analysis-batch") {
      mutable();
      return nextBatch(reviews, run.annotations, run.topics);
    }
    if (name === "record-analysis") {
      mutable();
      const payload = input.analysis;
      requireValue(payload && typeof payload === "object" && !Array.isArray(payload), "INVALID_ANALYSIS", "需要 analysis 对象");
      const digest = hash(payload);
      if (run.recorded_batches?.[payload.batch_id] === digest) return { ok: true, idempotent: true };
      const batch = nextBatch(reviews, run.annotations, run.topics);
      requireValue(!batch.done, "ANALYSIS_ALREADY_COMPLETE", "没有待分析分段");
      const accepted = acceptBatch(batch, payload, run.topics);
      run.topics = accepted.topics; Object.assign(run.annotations, accepted.annotations);
      run.analysis_revision++; run.findings = []; run.findings_revision = null;
      run.recorded_batches ??= {}; run.recorded_batches[batch.batch_id] = digest;
      await save(); return { ok: true, ...aggregate(reviews, run.topics, run.annotations, run.tasks).by_asin.reduce((acc, s) => ({ analyzed: acc.analyzed + s.analyzed, collected: acc.collected + s.collected }), { analyzed: 0, collected: 0 }) };
    }
    if (name === "merge-topics") {
      mutable();
      const merged = mergeTopics(run.topics, run.annotations, input.mappings);
      run.topics = merged.topics; run.annotations = merged.annotations;
      run.analysis_revision++; run.findings = []; run.findings_revision = null;
      await save(); return { ok: true, topics: run.topics };
    }
    const stats = aggregate(reviews, run.topics, run.annotations, run.tasks);
    if (name === "analysis-summary") {
      // Full evidence stays on disk; bounded per-topic samples are enough to plan findings.
      return { ...stats, review_analysis: undefined, topics: stats.topics.map(({ evidence, review_keys, ...topic }) => ({ ...topic,
        evidence: run.tasks.flatMap((task) => representativeEvidence(evidence, run.marketplace, task.asin)) })) };
    }
    if (name === "record-findings") {
      mutable(); requireValue(stats.analysis_complete, "ANALYSIS_INCOMPLETE", "全部评论分析完成后再生成最终结论");
      run.findings = validateFindings(input.findings, stats, reviews);
      run.findings_revision = run.analysis_revision;
      await save(); return { ok: true, findings_count: run.findings.length };
    }
    if (name === "finalize-run" || name === "render-report") {
      if (name === "finalize-run") {
        requireValue(stats.analysis_complete, "ANALYSIS_INCOMPLETE", "分析未完成，不能将部分标注发布为最终报告");
        requireValue(!stats.analyzed_count || run.findings_revision === run.analysis_revision, "FINDINGS_REQUIRED", "请先完成主题归并并 record-findings；确无建议可传空数组");
      }
      if (name === "render-report") requireValue(run.finalized_at || input.draft === true, "RUN_NOT_FINALIZED", "未归档运行仅允许 draft=true 预览");
      const report = { schema_version: 1, run_id: run.run_id, created_at: run.created_at, marketplace: run.marketplace,
        settings: run.settings, interrupted: run.interrupted, draft: !run.finalized_at && name === "render-report",
        generated_at: timestamp(options), tasks: run.tasks.map(({ asin, status, coverage, slices, reliable, error, captured_at }) =>
          ({ asin, status, coverage, slices, reliable, error, captured_at })),
        reviews, stats, annotations: run.annotations, topics: run.topics, findings: run.findings };
      // Finalized marker is written last. Repeating finalize regenerates the same logical data.
      const prefix = report.draft ? "draft" : "report";
      await writeJson(path.join(output, report.draft ? "analysis-draft.json" : "analysis.json"), report);
      await writeAtomic(path.join(output, "reviews.csv"), csv(reviews));
      await writeAtomic(path.join(output, `${prefix}.html`), renderReportHtml(report));
      if (name === "finalize-run") { run.finalized_at ??= timestamp(options); await save(); }
      return { ok: true, draft: report.draft, collected: stats.collected_count, analyzed: stats.analyzed_count,
        report_path: path.join(output, `${prefix}.html`), csv_path: path.join(output, "reviews.csv"),
        analysis_path: path.join(output, report.draft ? "analysis-draft.json" : "analysis.json") };
    }
    throw new AnalysisError("UNKNOWN_COMMAND", `未知命令：${name}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    requireValue(Number(process.versions.node.split(".")[0]) >= 22, "NODE_VERSION", "需要 Node.js 22+");
    let buffer = "";
    for await (const chunk of process.stdin) { buffer += chunk; requireValue(buffer.length <= 8 * 1024 * 1024, "INPUT_TOO_LARGE", "单次命令 JSON 过大，请按批次提交"); }
    const result = await command(process.argv[2], JSON.parse(buffer || "{}"));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: safeError(error) }) + "\n");
    process.exitCode = 1;
  }
}
