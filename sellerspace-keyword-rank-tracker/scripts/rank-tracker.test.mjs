import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RankTrackerError,
  finalizeRun,
  parseKeywordsFile,
  prepareRun,
  recordResult,
  renderReport,
  validatePreflight,
} from "./rank-tracker.mjs";

const TARGET_ASIN = "B0TARGET01";
const COMPETITOR_ASIN = "B0COMPET01";

function readyPreflight(overrides = {}) {
  return {
    mcp_ready: true,
    required_tools: [
      "discover_capabilities",
      "browser_list",
      "browser_submit_task",
      "browser_get_task",
    ],
    action_id: "amazon.search.keyword_rank",
    action_available: true,
    action_version: 5,
    browser_online: true,
    browser_id: "browser-1",
    artifact_delivery_available: true,
    artifact_schema_version: 1,
    checked_at: "2026-08-11T08:00:00.000Z",
    browser_meta: { name: "Office Mac", browser: "chrome", os: "mac", secret: "drop" },
    ...overrides,
  };
}

async function makeWorkspace(keywordText = "wireless charger\nyoga mat\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "rank-tracker-test-"));
  const keywordsFile = path.join(root, "keywords.txt");
  const outputDir = path.join(root, "output");
  await writeFile(keywordsFile, keywordText, "utf8");
  return { root, keywordsFile, outputDir };
}

function prepareInput(workspace, overrides = {}) {
  return {
    asin: TARGET_ASIN,
    marketplace: "US",
    pages: 3,
    keywords_file: workspace.keywordsFile,
    output_dir: workspace.outputDir,
    preflight: readyPreflight(),
    ...overrides,
  };
}

function completedTask(result, jobId = "job-1") {
  return {
    status: "completed",
    jobId,
    finishedAt: "2026-08-11T08:10:00.000Z",
    result,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RankTrackerError);
    assert.equal(error.code, code);
    return true;
  });
}

test("强制预检在任何文件读取或目录创建之前失败", async () => {
  const workspace = await makeWorkspace();
  const missingOutput = path.join(workspace.root, "must-not-exist");
  await expectCode(
    prepareRun({
      asin: TARGET_ASIN,
      marketplace: "US",
      pages: 3,
      keywords_file: path.join(workspace.root, "does-not-exist.txt"),
      output_dir: missingOutput,
    }),
    "PREFLIGHT_REQUIRED",
  );
  await assert.rejects(access(missingOutput));

  assert.throws(
    () => validatePreflight(readyPreflight({ required_tools: ["browser_list"] })),
    (error) => error.code === "MCP_TOOLS_MISSING",
  );
  assert.throws(
    () => validatePreflight(readyPreflight({ mcp_ready: false })),
    (error) => error.code === "MCP_NOT_READY",
  );
  assert.throws(
    () => validatePreflight(readyPreflight({ action_available: false })),
    (error) => error.code === "ACTION_UNAVAILABLE",
  );
  assert.throws(
    () => validatePreflight(readyPreflight({ action_version: 4 })),
    (error) => error.code === "ACTION_VERSION_TOO_OLD",
  );
  assert.throws(
    () => validatePreflight(readyPreflight({ browser_online: false })),
    (error) => error.code === "NO_ONLINE_BROWSER",
  );
  assert.throws(
    () => validatePreflight(readyPreflight({ artifact_delivery_available: false })),
    (error) => error.code === "ARTIFACT_DELIVERY_UNAVAILABLE",
  );
});

test("CLI 从非 TTY 单行 JSON 读取且保持 stdout 纯净", () => {
  const scriptPath = new URL("./rank-tracker.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [scriptPath.pathname, "prepare-run"], {
    input: "{}\n",
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "PREFLIGHT_REQUIRED");
});

test("SKILL 把 MCP、Action、在线浏览器和多设备选择设为不可跳过的前置条件", async () => {
  const skillPath = new URL("../SKILL.md", import.meta.url);
  const skill = await readFile(skillPath, "utf8");
  const preflightIndex = skill.indexOf("## Start with the mandatory MCP and browser preflight");
  const prepareIndex = skill.indexOf("## Prepare one run");
  assert.ok(preflightIndex >= 0 && prepareIndex > preflightIndex);
  for (const required of [
    "discover_capabilities",
    "browser_list",
    "browser_submit_task",
    "browser_get_task",
    "online=true",
    "available=true",
    "version>=5",
    "taskDelivery.modes",
    "artifactSchemaVersion=1",
    "When multiple browsers qualify",
    "Do not create an empty project",
    "Never fall back",
  ]) {
    assert.match(skill, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("关键词解析处理 BOM、注释、空行和大小写重复，并限制 50 个", async () => {
  const workspace = await makeWorkspace("\uFEFF# comment\n Yoga Mat \n\nyoga mat\nWIRELESS Charger\nwireless charger\n");
  assert.deepEqual(await parseKeywordsFile(workspace.keywordsFile), ["Yoga Mat", "WIRELESS Charger"]);

  const tooMany = Array.from({ length: 51 }, (_, index) => `keyword-${index}`).join("\n");
  await writeFile(workspace.keywordsFile, tooMany, "utf8");
  await expectCode(parseKeywordsFile(workspace.keywordsFile), "TOO_MANY_KEYWORDS");
});

test("JSON 配置路径相对配置目录，显式值优先，并校验项目身份", async () => {
  const workspace = await makeWorkspace("one\ntwo\n");
  const configPath = path.join(workspace.root, "job.json");
  await writeFile(configPath, JSON.stringify({
    asin: "INVALID",
    marketplace: "us",
    pages: 2,
    keywords_file: "./keywords.txt",
    output_dir: "./configured-output",
  }), "utf8");

  const prepared = await prepareRun({
    config_path: configPath,
    asin: TARGET_ASIN,
    pages: 4,
    preflight: readyPreflight(),
  }, { runId: "config-run", now: new Date("2026-08-11T08:00:00.000Z") });
  assert.equal(prepared.output_dir, path.join(workspace.root, "configured-output"));
  assert.equal(prepared.tasks.length, 2);
  assert.equal(prepared.tasks[0].params.pages, 4);
  assert.equal(prepared.tasks[0].params.mode, "auto");
  assert.equal(prepared.tasks[0].params.screenshot, false);
  assert.deepEqual(prepared.tasks[0].result_delivery, {
    mode: "artifact",
    targetAsin: TARGET_ASIN,
  });

  await expectCode(prepareRun({
    ...prepareInput(workspace),
    output_dir: prepared.output_dir,
    asin: COMPETITOR_ASIN,
  }, { runId: "mismatch-run" }), "PROJECT_IDENTITY_MISMATCH");
});

test("自然排名与广告位置分开归档，失败记录保留且 finalize 幂等", async () => {
  const workspace = await makeWorkspace();
  const prepared = await prepareRun(prepareInput(workspace), {
    runId: "ranking-run",
    now: new Date("2026-08-11T08:00:00.000Z"),
  });
  await recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 0,
    attempts: [{ job_id: "job-1", status: "completed" }],
    task: completedTask({
      blocked: false,
      pages: [{
        page: 1,
        mode: "fetch",
        url: "https://www.amazon.com/s?k=wireless%20charger",
        asins: [
          { asin: COMPETITOR_ASIN, rank: 1, naturalRank: 1, adType: "" },
          { asin: TARGET_ASIN, rank: 2, adType: "SP" },
          { asin: TARGET_ASIN, rank: 10, naturalRank: 8, adType: "" },
          { asin: TARGET_ASIN, rank: 15, adType: "SB" },
        ],
      }],
    }),
  });
  await recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 1,
    attempts: [
      { job_id: "job-2", status: "failed", error: { code: "TIMEOUT", message: "first" } },
      { job_id: "job-3", status: "failed", error: { code: "TIMEOUT", message: "second" } },
    ],
    task: {
      status: "failed",
      jobId: "job-3",
      error: { code: "TIMEOUT", message: "second" },
    },
  });

  const finalized = await finalizeRun({ output_dir: workspace.outputDir, run_id: prepared.run_id }, {
    now: new Date("2026-08-11T08:20:00.000Z"),
  });
  assert.equal(finalized.status, "completed_with_issues");
  assert.equal(finalized.summary.ok, 1);
  assert.equal(finalized.summary.failed, 1);
  assert.equal(finalized.summary.raw_row_count, 4);

  const history = await readCsv(path.join(workspace.outputDir, "target-rank-history.csv"));
  assert.equal(history.length, 2);
  assert.equal(history[0].natural_rank, "8");
  assert.equal(history[0].best_ad_position, "2");
  assert.equal(history[0].ad_types, "SB | SP");
  assert.equal(history[0].ad_occurrence_count, "2");
  assert.equal(history[1].status, "failed");
  assert.equal(history[1].natural_rank, "");

  const raw = await readCsv(path.join(workspace.outputDir, finalized.outputs.all_asins));
  assert.equal(raw.length, 4);
  assert.equal(raw.filter((row) => row.asin === TARGET_ASIN).length, 3);

  const report = await readFile(path.join(workspace.outputDir, "report.html"), "utf8");
  assert.match(report, /关键词排名驾驶舱/);
  assert.match(report, /https:\/\/o\.sellerspace\.com\/image\/www\/zh\/logo\.png/);
  assert.match(report, /https:\/\/cdn\.jsdelivr\.net\/npm\/@tailwindcss\/browser@4/);
  assert.match(report, /https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@5\.6\.0\/dist\/echarts\.min\.js/);
  assert.match(report, /https:\/\/cdn\.jsdelivr\.net\/npm\/remixicon@4\.6\.0/);
  assert.match(report, /--brand: #776ff6/);
  assert.match(report, /color:\["#776ff6","#f26a21"\]/);
  assert.match(report, /id="keywordList"/);
  assert.match(report, /id="keywordSearch"/);
  assert.match(report, /id="rankChart"/);
  assert.match(report, /window\.echarts\.init/);
  assert.match(report, /connectNulls:false/);
  assert.match(report, /inverse:true/);
  assert.match(report, /id="dependencyAlert"/);
  assert.match(report, /data-days="7"/);
  assert.match(report, /最新结果/);
  assert.match(report, /自然排名/);
  assert.match(report, /广告位置/);
  assert.doesNotMatch(report, /id="cards"/);
  assert.doesNotMatch(report, /<svg/i);

  const again = await finalizeRun({ output_dir: workspace.outputDir, run_id: prepared.run_id });
  assert.equal(again.idempotent, true);
  assert.equal((await readCsv(path.join(workspace.outputDir, "target-rank-history.csv"))).length, 2);
});

test("Artifact 全量结果由脚本下载校验，签名 URL 不写入运行清单", async () => {
  const workspace = await makeWorkspace("artifact keyword\n");
  const prepared = await prepareRun(prepareInput(workspace), {
    runId: "artifact-run",
    now: new Date("2026-08-11T08:00:00.000Z"),
  });
  const browserResult = {
    blocked: false,
    pages: [{
      page: 1,
      mode: "fetch",
      url: "https://www.amazon.com/s?k=artifact",
      asins: [
        { asin: TARGET_ASIN, rank: 7, naturalRank: 6, adType: "" },
        { asin: COMPETITOR_ASIN, rank: 8, adType: "SP" },
      ],
    }],
  };
  const encoded = JSON.stringify(browserResult);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(encoded);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const signedUrl = `http://127.0.0.1:${address.port}/artifact?signature=secret`;
  try {
    const recorded = await recordResult({
      output_dir: workspace.outputDir,
      run_id: prepared.run_id,
      keyword_index: 0,
      attempts: [{ job_id: "artifact-job", status: "completed" }],
      task: {
        status: "completed",
        jobId: "artifact-job",
        artifact: {
          schemaVersion: 1,
          id: "2026-08/test-artifact",
          downloadUrl: signedUrl,
          sha256: createHash("sha256").update(encoded).digest("hex"),
          uncompressedSizeBytes: Buffer.byteLength(encoded),
          sizeBytes: Buffer.byteLength(encoded),
          format: "json",
          contentType: "application/json",
          contentEncoding: "gzip",
        },
      },
    });
    assert.equal(recorded.status, "completed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const manifestText = await readFile(path.join(workspace.outputDir, "runs", "artifact-run.json"), "utf8");
  assert.doesNotMatch(manifestText, /signature=secret/);
  assert.match(manifestText, /test-artifact/);
  const finalized = await finalizeRun({ output_dir: workspace.outputDir, run_id: prepared.run_id });
  assert.equal(finalized.summary.raw_row_count, 2);
  const history = await readCsv(path.join(workspace.outputDir, "target-rank-history.csv"));
  assert.equal(history[0].natural_rank, "6");
});

test("Artifact 下载安全失败直接记录关键词失败，不重新提交浏览器任务", async () => {
  const workspace = await makeWorkspace("unsafe artifact\n");
  const prepared = await prepareRun(prepareInput(workspace), { runId: "unsafe-artifact-run" });
  const recorded = await recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 0,
    attempts: [{ job_id: "artifact-job", status: "completed" }],
    task: {
      status: "completed",
      jobId: "artifact-job",
      artifact: {
        schemaVersion: 1,
        id: "2026-08/unsafe",
        downloadUrl: "http://example.com/private",
        sha256: "a".repeat(64),
        uncompressedSizeBytes: 10,
      },
    },
  });
  assert.equal(recorded.status, "failed");
  const manifest = JSON.parse(await readFile(path.join(workspace.outputDir, "runs", "unsafe-artifact-run.json"), "utf8"));
  assert.equal(manifest.keywords[0].attempts[0].status, "completed");
  assert.equal(manifest.keywords[0].error.code, "ARTIFACT_URL_UNSAFE");
});

test("not_found、blocked 与未执行任务保持空排名并生成 incomplete run", async () => {
  const workspace = await makeWorkspace("one\ntwo\nthree\n");
  const prepared = await prepareRun(prepareInput(workspace), {
    runId: "partial-run",
    now: new Date("2026-08-12T08:00:00.000Z"),
  });
  await recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 0,
    task: completedTask({
      blocked: false,
      pages: [{ page: 1, mode: "fetch", url: "https://example.test", asins: [
        { asin: COMPETITOR_ASIN, rank: 1, naturalRank: 1, adType: "" },
      ] }],
    }, "job-one"),
  });
  await recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 1,
    task: completedTask({ blocked: true, pages: [{
      page: 1,
      mode: "tab",
      url: "https://example.test/blocked",
      asins: [{ asin: TARGET_ASIN, rank: 1, naturalRank: 1, adType: "" }],
    }] }, "job-two"),
  });
  const finalized = await finalizeRun({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    interrupted: true,
  });
  assert.equal(finalized.status, "incomplete");
  const rows = await readCsv(path.join(workspace.outputDir, "target-rank-history.csv"));
  assert.deepEqual(rows.map((row) => row.status), ["not_found", "blocked", "not_executed"]);
  assert.ok(rows.every((row) => row.natural_rank === "" && row.best_ad_position === ""));
});

test("可从全量 ASIN 历史生成竞品报告，并拒绝从未出现的 ASIN", async () => {
  const workspace = await makeWorkspace("<script>alert(1)</script>\n");
  const prepared = await prepareRun(prepareInput(workspace), {
    runId: "competitor-run",
    now: new Date("2026-08-13T08:00:00.000Z"),
  });
  await recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 0,
    task: completedTask({ blocked: false, pages: [{
      page: 1,
      mode: "fetch",
      url: "https://example.test/?q=<script>alert(1)</script>",
      asins: [{ asin: COMPETITOR_ASIN, rank: 3, naturalRank: 2, adType: "" }],
    }] }),
  });
  await finalizeRun({ output_dir: workspace.outputDir, run_id: prepared.run_id });

  const competitor = await renderReport({ output_dir: workspace.outputDir, asin: COMPETITOR_ASIN });
  const html = await readFile(competitor.report_path, "utf8");
  assert.match(html, new RegExp(COMPETITOR_ASIN));
  assert.match(competitor.report_path, /reports\/B0COMPET01\.html$/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);

  await expectCode(
    renderReport({ output_dir: workspace.outputDir, asin: "B0UNKNOWN1" }),
    "ASIN_NOT_OBSERVED",
  );
});

test("缺失页数或浏览器选择不一致时不准备 run，单关键词最多两次尝试", async () => {
  const workspace = await makeWorkspace("one\n");
  await expectCode(
    prepareRun(prepareInput(workspace, { pages: undefined })),
    "INVALID_PAGES",
  );
  await expectCode(
    prepareRun(prepareInput(workspace, { browser_id: "different-browser" })),
    "BROWSER_SELECTION_MISMATCH",
  );

  const prepared = await prepareRun(prepareInput(workspace), { runId: "attempt-run" });
  await expectCode(recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 0,
    attempts: [
      { job_id: "1", status: "failed" },
      { job_id: "2", status: "failed" },
      { job_id: "3", status: "completed" },
    ],
    task: completedTask({ blocked: false, pages: [] }, "3"),
  }), "TOO_MANY_ATTEMPTS");

  await expectCode(recordResult({
    output_dir: workspace.outputDir,
    run_id: prepared.run_id,
    keyword_index: 0,
    attempts: [
      { job_id: "1", status: "failed", error: { code: "BROWSER_OFFLINE", message: "offline" } },
      { job_id: "2", status: "completed" },
    ],
    task: completedTask({ blocked: false, pages: [] }, "2"),
  }), "RETRY_NOT_ALLOWED");
});

async function readCsv(filePath) {
  const text = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "").trimEnd();
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() ?? "");
  return lines.filter(Boolean).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
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
      } else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      values.push(value);
      value = "";
    } else value += character;
  }
  values.push(value);
  return values;
}
