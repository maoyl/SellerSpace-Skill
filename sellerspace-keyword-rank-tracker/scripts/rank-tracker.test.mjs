import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, access, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  RankTrackerError,
  finalizeRun,
  parseKeywordsFile,
  prepareRun,
  recordResult as recordResultImpl,
  recordSubmission,
  resumeRun,
  downloadBrowserArtifact,
  renderReport,
  validatePreflight,
} from "./rank-tracker.mjs";

const TARGET_ASIN = "B0TARGET01";
const COMPETITOR_ASIN = "B0COMPET01";
const temporaryRoots = [];
const artifactFixtures = new Map();
after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function artifactTask(result, jobId = "job-1", finishedAt = "2026-08-11T08:10:00.000Z") {
  const bytes = Buffer.from(JSON.stringify(result));
  const id = String(artifactFixtures.size);
  const downloadUrl = `https://rank-fixture.test/${id}`;
  artifactFixtures.set(downloadUrl, bytes);
  return {
    status: "completed", jobId, finishedAt,
    artifact: {
      schemaVersion: 1, id, downloadUrl,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uncompressedSizeBytes: bytes.length,
    },
  };
}

async function recordResult(input, options = {}) {
  return await recordResultImpl(input, {
    fetch: async (url, init) => artifactFixtures.has(String(url))
      ? new Response(artifactFixtures.get(String(url)))
      : await fetch(url, init),
    ...options,
  });
}

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
    browser_meta: { name: "办公室电脑", browser: "chrome", os: "mac", secret: "drop" },
    ...overrides,
  };
}

async function makeWorkspace(keywordText = "wireless charger\nyoga mat\n") {
  const root = await mkdtemp(path.join(os.tmpdir(), "rank-tracker-test-"));
  temporaryRoots.push(root);
  const keywordsFile = path.join(root, "keywords.txt");
  const outputDir = path.join(root, "output");
  await writeFile(keywordsFile, keywordText, "utf8");
  return { root, keywordsFile, outputDir };
}

function prepareInput(workspace, overrides = {}) {
  return {
    asin: TARGET_ASIN,
    marketplace: "US",
    pages: 1,
    keywords_file: workspace.keywordsFile,
    output_dir: workspace.outputDir,
    preflight: readyPreflight(),
    ...overrides,
  };
}

function completedTask(result, jobId = "job-1", keyword = "wireless charger") {
  return artifactTask({ keyword, marketplace: "US", ...result }, jobId);
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

test("命令行从非终端标准输入读取单行 JSON，且标准输出不混入其他内容", () => {
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

test("关键词解析处理 BOM、注释、空行和大小写重复，并限制 50 个", async () => {
  const workspace = await makeWorkspace("\uFEFF# 注释\n Yoga Mat \n\nyoga mat\nWIRELESS Charger\nwireless charger\n");
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

test("自然排名与广告位置分开归档，保留失败记录且结束操作幂等", async () => {
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
      { job_id: "job-2", status: "failed", error: { code: "TIMEOUT", message: "首次请求超时" } },
      { job_id: "job-3", status: "failed", error: { code: "TIMEOUT", message: "第二次请求超时" } },
    ],
    task: {
      status: "failed",
      jobId: "job-3",
      error: { code: "TIMEOUT", message: "第二次请求超时" },
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
  assert.match(report, /color:\s*\["#776ff6",\s*"#f26a21"\]/);
  assert.match(report, /id="keywordList"/);
  assert.match(report, /id="keywordSearch"/);
  assert.match(report, /id="rankChart"/);
  assert.match(report, /window\.echarts\.init/);
  assert.match(report, /connectNulls:\s*false/);
  assert.match(report, /inverse:\s*true/);
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

test("全量结果文件由脚本下载校验，签名网址不写入运行清单", async () => {
  const workspace = await makeWorkspace("artifact keyword\n");
  const prepared = await prepareRun(prepareInput(workspace), {
    runId: "artifact-run",
    now: new Date("2026-08-11T08:00:00.000Z"),
  });
  const browserResult = {
    keyword: "artifact keyword",
    marketplace: "US",
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

test("结果文件下载安全检查失败时直接记录关键词失败，不重新提交浏览器任务", async () => {
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

test("未找到、页面阻断与未执行任务保持空排名，并将运行标记为未完成", async () => {
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
    }, "job-one", "one"),
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
    }] }, "job-two", "two"),
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
    }] }, "competitor-job", "<script>alert(1)</script>"),
  });
  await finalizeRun({ output_dir: workspace.outputDir, run_id: prepared.run_id });

  const competitor = await renderReport({ output_dir: workspace.outputDir, asin: COMPETITOR_ASIN });
  const html = await readFile(competitor.report_path, "utf8");
  assert.match(html, new RegExp(COMPETITOR_ASIN));
  assert.match(competitor.report_path, /reports\/B0COMPET01\.html$/);
  const downloadHref = html.match(/href="([^"]+)" download><i class="ri-download-line/)[1];
  assert.equal(path.resolve(path.dirname(competitor.report_path), downloadHref), competitor.history_path);
  const downloaded = await readCsv(competitor.history_path);
  assert.ok(downloaded.every((row) => row.target_asin === COMPETITOR_ASIN));
  assert.equal(downloaded[0].natural_rank, "2");
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);

  await expectCode(
    renderReport({ output_dir: workspace.outputDir, asin: "B0UNKNOWN1" }),
    "ASIN_NOT_OBSERVED",
  );
});

test("缺失页数或浏览器选择不一致时不准备运行，单关键词最多两次尝试", async () => {
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
      { job_id: "1", status: "failed", error: { code: "BROWSER_OFFLINE", message: "浏览器离线" } },
      { job_id: "2", status: "completed" },
    ],
    task: completedTask({ blocked: false, pages: [] }, "2"),
  }), "RETRY_NOT_ALLOWED");
});

test("结果文件校验结构、任务身份、页数和排名，异常不会记成未找到", async () => {
  const workspace = await makeWorkspace("one\n");
  const prepared = await prepareRun(prepareInput(workspace), { runId: "validation-run" });
  const valid = {
    keyword: "one", marketplace: "US", blocked: false,
    pages: [{ page: 1, mode: "fetch", asins: [{ asin: TARGET_ASIN, rank: 3, naturalRank: 2 }] }],
  };
  const invalid = [
    [{}, "ARTIFACT_RESULT_INVALID"],
    [null, "ARTIFACT_RESULT_INVALID"],
    [{ ...valid, keyword: "different" }, "ARTIFACT_IDENTITY_MISMATCH"],
    [{ ...valid, marketplace: "JP" }, "ARTIFACT_IDENTITY_MISMATCH"],
    [{ ...valid, pages: [] }, "ARTIFACT_RESULT_INVALID"],
    [{ ...valid, pages: [{ page: 2, mode: "fetch", asins: [] }] }, "ARTIFACT_RESULT_INVALID"],
    [{ ...valid, pages: [{ page: 1, mode: "fetch" }] }, "ARTIFACT_RESULT_INVALID"],
    ...[0, -1, true, "1", 1.2].map((rank) => [
      { ...valid, pages: [{ page: 1, mode: "fetch", asins: [{ asin: TARGET_ASIN, rank: 1, naturalRank: rank }] }] },
      "ARTIFACT_RESULT_INVALID",
    ]),
  ];
  for (const [payload, code] of invalid) {
    const result = await recordResult({ output_dir: workspace.outputDir, run_id: prepared.run_id, keyword_index: 0, task: artifactTask(payload) });
    assert.equal(result.status, "failed");
    const manifest = JSON.parse(await readFile(path.join(workspace.outputDir, "runs", `${prepared.run_id}.json`)));
    assert.equal(manifest.keywords[0].error.code, code);
  }
  const result = await recordResult({ output_dir: workspace.outputDir, run_id: prepared.run_id, keyword_index: 0, task: artifactTask(valid) });
  assert.equal(result.status, "completed");
  const manifest = JSON.parse(await readFile(path.join(workspace.outputDir, "runs", `${prepared.run_id}.json`)));
  assert.equal(manifest.keywords[0].error, undefined);
});

test("毫秒时间戳与带时区的字符串统一归档为 UTC", async () => {
  const workspace = await makeWorkspace("one\n");
  const prepared = await prepareRun(prepareInput(workspace));
  const expected = "2026-09-13T23:59:00.000Z";
  for (const time of [Date.parse(expected), "2026-09-14T07:59:00+08:00"]) {
    const task = completedTask({ blocked: false, pages: [{ page: 1, mode: "fetch", asins: [] }] }, "time-job", "one");
    task.finishedAt = time;
    await recordResult({ output_dir: workspace.outputDir, run_id: prepared.run_id, keyword_index: 0, task });
    const manifest = JSON.parse(await readFile(path.join(workspace.outputDir, "runs", `${prepared.run_id}.json`)));
    assert.equal(manifest.keywords[0].recorded_at, expected);
  }
});

test("只接受结果文件交付，缺失引用或内嵌结果明确归档为失败", async () => {
  const workspace = await makeWorkspace("one\n");
  const prepared = await prepareRun(prepareInput(workspace));
  for (const task of [{ status: "completed", jobId: "missing" }, { status: "completed", jobId: "inline", result: {} }]) {
    const result = await recordResult({ output_dir: workspace.outputDir, run_id: prepared.run_id, keyword_index: 0, task });
    assert.equal(result.status, "failed");
  }
});

test("真实 HTTP 下载覆盖 gzip、响应体超时、断流和重定向", async () => {
  const bytes = Buffer.from(JSON.stringify({ keyword: "one", marketplace: "US", blocked: false, pages: [{ page: 1, mode: "fetch", asins: [] }] }));
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/gzip" });
      return response.end();
    }
    if (request.url === "/gzip") {
      response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      return response.end(gzipSync(bytes));
    }
    response.writeHead(200, { "content-type": "application/json", "content-length": bytes.length });
    response.write("{");
    if (request.url === "/broken") setTimeout(() => response.destroy(), 10);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const reference = {
    schemaVersion: 1, id: "http-test", sha256: createHash("sha256").update(bytes).digest("hex"),
    uncompressedSizeBytes: bytes.length,
  };
  try {
    const result = await downloadBrowserArtifact({ ...reference, downloadUrl: `${baseUrl}/gzip` });
    assert.equal(result.result.keyword, "one");
    const workspace = await makeWorkspace("one\n");
    const prepared = await prepareRun(prepareInput(workspace));
    for (const route of ["stall", "broken", "redirect"]) {
      const result = await recordResult({ output_dir: workspace.outputDir, run_id: prepared.run_id, keyword_index: 0,
        task: { status: "completed", jobId: route, artifact: { ...reference, downloadUrl: `${baseUrl}/${route}` } },
      }, { downloadTimeoutMs: 100 });
      assert.equal(result.status, "failed");
      const manifest = JSON.parse(await readFile(path.join(workspace.outputDir, "runs", `${prepared.run_id}.json`)));
      assert.equal(manifest.keywords[0].error.code, "ARTIFACT_DOWNLOAD_FAILED");
    }
    await expectCode(downloadBrowserArtifact({ ...reference, sha256: "a".repeat(64), downloadUrl: `${baseUrl}/gzip` }), "ARTIFACT_CHECKSUM_MISMATCH");
    await expectCode(downloadBrowserArtifact({ ...reference, uncompressedSizeBytes: bytes.length + 1, downloadUrl: `${baseUrl}/gzip` }), "ARTIFACT_SIZE_MISMATCH");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("恢复使用已保存任务和关键词快照，重试不丢失首次失败", async () => {
  const workspace = await makeWorkspace("one\ntwo\n");
  const prepared = await prepareRun(prepareInput(workspace));
  const run = { output_dir: workspace.outputDir, run_id: prepared.run_id };
  const first = { ...run, keyword_index: 0 };
  await recordSubmission({ ...first, task: { status: "running", jobId: "original" } });
  assert.equal((await recordSubmission({ ...first, task: { status: "running", jobId: "original" } })).idempotent, true);
  await expectCode(recordSubmission({ ...run, keyword_index: 1, task: { status: "running", jobId: "parallel" } }), "TASK_IN_FLIGHT");
  await writeFile(workspace.keywordsFile, "changed\n");
  const resumed = await resumeRun({ ...run, preflight: readyPreflight() });
  assert.deepEqual(resumed.tasks.map((task) => [task.keyword, task.next_action]), [["one", "poll"], ["two", "submit"]]);
  assert.equal(resumed.tasks[0].job_id, "original");
  await expectCode(recordResult({ ...first, task: completedTask({ blocked: false, pages: [] }, "different") }), "JOB_ID_MISMATCH");
  await recordResult({ ...first, task: { status: "failed", jobId: "original", error: { code: "TIMEOUT", message: "首次超时" } } });
  assert.equal((await resumeRun({ ...run, preflight: readyPreflight() })).tasks[0].next_action, "submit");
  await recordSubmission({ ...first, task: { status: "running", jobId: "retry" } });
  const duringRetry = await resumeRun({ ...run, preflight: readyPreflight() });
  assert.equal(duringRetry.tasks[0].job_id, "retry");
  const manifestPath = path.join(workspace.outputDir, "runs", `${prepared.run_id}.json`);
  const beforeResult = await readFile(manifestPath);
  await recordResult({ ...first, task: completedTask({ blocked: false, pages: [{ page: 1, mode: "fetch", asins: [] }] }, "retry", "one") });
  // 模拟结果文件落盘后、清单写入前中断。
  await writeFile(manifestPath, beforeResult);
  const afterCrash = await resumeRun({ ...run, preflight: readyPreflight() });
  assert.deepEqual(afterCrash.tasks.map((task) => task.keyword), ["two"]);
  const recovered = JSON.parse(await readFile(manifestPath));
  assert.deepEqual(recovered.keywords[0].attempts.map((item) => item.status), ["failed", "completed"]);
  await recordResult({ ...first, task: completedTask({ blocked: false, pages: [{ page: 1, mode: "fetch", asins: [] }] }, "retry", "one") });
  const replayed = JSON.parse(await readFile(manifestPath));
  assert.equal(replayed.keywords[0].attempts.length, 2);
  const finalized = await finalizeRun({ ...run, interrupted: true });
  assert.equal(finalized.status, "incomplete");
  await expectCode(resumeRun({ ...run, preflight: readyPreflight() }), "RUN_FINALIZED");
});

test("重试未归档时结束运行，不使用首次失败的旧暂存结果", async () => {
  const workspace = await makeWorkspace("one\n");
  const prepared = await prepareRun(prepareInput(workspace));
  const run = { output_dir: workspace.outputDir, run_id: prepared.run_id };
  const keyword = { ...run, keyword_index: 0 };
  await recordSubmission({ ...keyword, task: { status: "running", jobId: "first" } });
  await recordResult({ ...keyword, task: { status: "failed", jobId: "first", error: { code: "TIMEOUT" } } });
  await recordSubmission({ ...keyword, task: { status: "running", jobId: "second" } });
  const finalized = await finalizeRun(run);
  assert.equal(finalized.status, "incomplete");
  const history = await readCsv(path.join(workspace.outputDir, "target-rank-history.csv"));
  assert.equal(history[0].error_code, "RESULT_NOT_RECORDED");
});

test("重试提交被拒绝时保留首次超时，无任务标识的超时不自动重试", async () => {
  const workspace = await makeWorkspace("one\ntwo\n");
  const prepared = await prepareRun(prepareInput(workspace));
  const run = { output_dir: workspace.outputDir, run_id: prepared.run_id };
  await recordSubmission({ ...run, keyword_index: 0, task: { status: "running", jobId: "first" } });
  await recordResult({ ...run, keyword_index: 0, task: { status: "failed", jobId: "first", error: { code: "TIMEOUT" } } });
  await recordResult({ ...run, keyword_index: 0, task: { status: "failed", error: { code: "BROWSER_OFFLINE" } } });
  await recordResult({ ...run, keyword_index: 1, task: { status: "failed", error: { code: "TIMEOUT" } } });
  const resumed = await resumeRun({ ...run, preflight: readyPreflight() });
  assert.equal(resumed.tasks.length, 0);
  const manifest = JSON.parse(await readFile(path.join(workspace.outputDir, "runs", `${prepared.run_id}.json`)));
  assert.deepEqual(manifest.keywords[0].attempts.map((item) => item.error.code), ["TIMEOUT", "BROWSER_OFFLINE"]);
});

test("完整空页记为未找到，阻断允许提前停止，缺失归档阻止竞品报告", async () => {
  const workspace = await makeWorkspace("one\ntwo\n");
  const prepared = await prepareRun(prepareInput(workspace, { pages: 2 }));
  const run = { output_dir: workspace.outputDir, run_id: prepared.run_id };
  await recordResult({ ...run, keyword_index: 0,
    task: completedTask({ blocked: false, pageCount: 2, pages: [1, 2].map((page) => ({ page, mode: "fetch", asins: [] })) }, "empty", "one"),
  });
  await recordResult({ ...run, keyword_index: 1,
    task: completedTask({ blocked: false, pageCount: 2, pages: [{ page: 1, mode: "tab", blocked: true, asins: [] }] }, "blocked", "two"),
  });
  const finalized = await finalizeRun(run);
  assert.equal(finalized.summary.not_found, 1);
  assert.equal(finalized.summary.blocked, 1);
  await rm(path.join(workspace.outputDir, finalized.outputs.all_asins));
  await expectCode(renderReport({ output_dir: workspace.outputDir, asin: COMPETITOR_ASIN }), "ARCHIVE_UNREADABLE");
});

test("旧 CSV 自动派生关键词标识，重建报告保留原始历史文件", async () => {
  const workspace = await makeWorkspace("Yoga Mat\n");
  for (const [index, keyword] of ["Yoga Mat", "yoga mat"].entries()) {
    await writeFile(workspace.keywordsFile, keyword);
    const prepared = await prepareRun(prepareInput(workspace), { runId: `case-${index}` });
    await recordResult({ output_dir: workspace.outputDir, run_id: prepared.run_id, keyword_index: 0,
      task: completedTask({ blocked: false, pages: [{ page: 1, mode: "fetch", asins: [] }] }, `job-${index}`, keyword),
    });
    await finalizeRun({ output_dir: workspace.outputDir, run_id: prepared.run_id });
  }
  const csvPath = path.join(workspace.outputDir, "target-rank-history.csv");
  const csv = await readFile(csvPath, "utf8");
  const columns = csv.replace(/^\uFEFF/, "").split("\r\n")[0].split(",");
  const keyIndex = columns.indexOf("keyword_key");
  const legacy = csv.split("\r\n").map((line) => line.split(",").filter((_, i) => i !== keyIndex).join(",")).join("\r\n");
  await writeFile(csvPath, legacy);
  const report = await renderReport({ output_dir: workspace.outputDir });
  const html = await readFile(report.report_path, "utf8");
  const embedded = JSON.parse(html.match(/const history\s*=\s*([^\n]+);/)[1]);
  assert.deepEqual(embedded.map((row) => row.keyword_key), ["yoga mat", "yoga mat"]);
  assert.equal(await readFile(csvPath, "utf8"), legacy);
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
