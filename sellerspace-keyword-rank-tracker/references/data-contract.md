# 关键词排名追踪数据约定

## 目录

- 输入约定
- 预检凭据
- 脚本命令
- 输出目录结构
- CSV 字段定义
- 状态与排名口径

## 输入约定

`prepare-run` 通过标准输入接收一个 JSON 对象。可以传入 `config_path`、直接提供的字段，或同时传入两者；直接提供的字段覆盖配置文件中的同名值。

```json
{
  "config_path": "/absolute/or/relative/job.json",
  "asin": "B0XXXXXXXX",
  "marketplace": "US",
  "pages": 3,
  "keywords_file": "./keywords.txt",
  "output_dir": "./rank-data/B0XXXXXXXX-US",
  "browser_id": "optional-browser-id",
  "preflight": {}
}
```

合并输入后必须具备以下字段：

- `asin`：10 位字母或数字，统一转为大写。
- `marketplace`：站点，不得为空，统一转为大写。
- `pages`：抓取页数，必须是 1–10 的整数，无默认值。
- `keywords_file`：UTF-8 文本文件，每行一个关键词。
- `output_dir`：明确指定的数据项目目录。

`job.json` 中的相对路径以配置文件所在目录为基准；直接提供的相对路径以当前工作目录为基准。`browser_id` 可选，但提供时必须与预检选中的浏览器一致。

关键词读取器去除 UTF-8 字节顺序标记和每行首尾空白，忽略空行与 `#` 注释，按 NFKC 规范化及不区分大小写的方式去重，保留首次出现的写法。最终必须有 1–50 个关键词。

## 预检凭据

`prepare-run` 要求 `preflight` 满足：

- `mcp_ready=true`。
- `required_tools` 包含全部四个优麦云工具。
- `action_id=amazon.search.keyword_rank`。
- `action_available=true` 且 `action_version>=5`；第 5 版支持本技能使用的接口优先自动模式（`auto`）。
- `browser_online=true` 且 `browser_id` 非空。
- `artifact_delivery_available=true` 且 `artifact_schema_version=1`，均从实时的 `browser_list.taskDelivery` 响应中取得。
- 可选提供 `checked_at` 和经过字段筛选的 `browser_meta`。

本技能必须根据实时工具结果生成凭据。凭据缺失或无效时，必须在读取配置、关键词文件或创建 `output_dir` 之前失败。

## 脚本命令

所有命令读取非终端标准输入中的第一条非空、单行紧凑 JSON，并输出一个紧凑 JSON 对象。使用不回显输入的管道或会话；不得发送格式化的多行 JSON，也不得使用会回显大量浏览器结果的伪终端。

### 准备运行：`prepare-run`

输入：用户直接提供的参数、配置文件参数，以及 `preflight`。

输出包含 `run_id`、`output_dir`、`browser_id`、`action`、`outputs` 和有序的 `tasks` 数组。每个任务包含 `keyword_index`、`keyword`、原样使用的动作参数 `params`（含 `mode=auto`、`screenshot=false`、`upload=true`），以及 `result_delivery={"mode":"artifact","targetAsin":"<项目 ASIN>"}`。

自动模式下，第 5 版及以上插件优先请求接口，仅当请求被阻断、失败或返回不可用页面时才回退到后台标签页。每页实际采用的 `fetch` 或 `tab` 模式保存在 `page_mode` 中。

### 记录结果：`record-result`

```json
{
  "output_dir": "/absolute/project",
  "run_id": "run-id",
  "keyword_index": 0,
  "attempts": [
    { "job_id": "job-1", "status": "failed", "error": { "code": "TIMEOUT", "message": "首次请求超时" } },
    { "job_id": "job-2", "status": "completed" }
  ],
  "task": {
    "status": "completed",
    "jobId": "job-2",
    "finishedAt": "2026-08-11T08:10:00.000Z",
    "summary": {
      "resultCount": 96,
      "target": { "asin": "B0XXXXXXXX", "naturalRank": 18 }
    },
    "artifact": {
      "schemaVersion": 1,
      "id": "2026-08/artifact-id",
      "downloadUrl": "https://hub.example/artifacts/download?...",
      "sha256": "64 位小写十六进制字符",
      "uncompressedSizeBytes": 12345
    }
  }
}
```

`task.status` 必须是 `completed` 或 `failed`，失败任务携带 `error`。最多接受两次浏览器尝试。已完成任务的结果文件下载时禁止重定向，解压后不得超过 64 MiB，须核对 `uncompressedSizeBytes` 和 SHA-256，再按 JSON 解析。仅接受 HTTPS 地址，本地测试可使用 HTTP 回环地址。

带签名的下载网址不得写入运行清单；仅保留经过筛选的结果文件元数据，供后续核查。本次运行尚未结束时，再次记录同一关键词会替换其暂存结果。

脚本仍接受直接内嵌的 `task.result`，用于兼容已有的确定性单元测试，但本技能不得请求或使用这种交付方式。结果文件接收与校验失败时，`record-result` 将关键词标记为 `failed`，保存 `ARTIFACT_*` 错误码，并继续本次运行，不重新提交浏览器任务。

### 结束运行：`finalize-run`

```json
{
  "output_dir": "/absolute/project",
  "run_id": "run-id",
  "interrupted": false
}
```

`interrupted=true` 或仍有待执行关键词时，本次运行标记为 `incomplete`。否则，只要存在失败或页面阻断，就标记为 `completed_with_issues`；其余情况标记为 `completed`。重复结束同一次运行具备幂等性，并会重新生成报告。

### 重建报告：`render-report`

```json
{
  "output_dir": "/absolute/project",
  "asin": "B0OPTIONAL1"
}
```

省略 `asin` 时，重建配置中目标 ASIN 的报告。指定其他 ASIN 时，该 ASIN 必须至少在归档的全量结果中出现过一次。

## 输出目录结构

```text
output_dir/
├── project.json
├── target-rank-history.csv
├── report.html
├── all-asins/YYYY-MM/<run_id>.csv
├── reports/<other_asin>.html
└── runs/<run_id>.json
```

- `project.json`：固定该输出目录对应的 ASIN 与站点，防止不同项目混写。
- `target-rank-history.csv`：目标 ASIN 在各次运行、各个关键词下的排名历史。
- `report.html`：目标 ASIN 的交互式趋势报告。
- `all-asins/YYYY-MM/<run_id>.csv`：本次搜索返回的全部 ASIN 出现记录，按月归档。
- `reports/<other_asin>.html`：从全量历史重建的其他 ASIN 报告。
- `runs/<run_id>.json`：运行清单，保存输入快照、浏览器元数据、任务标识、尝试记录、关键词状态、计数和相对输出路径。

临时结果位于 `runs/.staging/` 下，仅在成功完成结束操作后清理。

## CSV 字段定义

两类 CSV 均使用 UTF-8 字节顺序标记、CRLF 换行、RFC 风格的引号转义，以及原子替换写入。

`target-rank-history.csv` 按 `run_id + keyword` 每组保存一行：

```text
run_id,collected_at,marketplace,target_asin,keyword,pages_requested,
pages_completed,result_count,blocked,target_found,natural_found,natural_rank,
ad_found,best_ad_position,ad_types,ad_occurrence_count,best_overall_position,
status,error_code,error_message
```

`all-asins/YYYY-MM/<run_id>.csv` 保留返回结果中的每次出现记录：

```text
run_id,collected_at,marketplace,keyword,page,page_mode,page_url,
position,natural_rank,asin,ad_type
```

## 状态与排名口径

- `ok`：该 ASIN 出现在任意位置。
- `not_found`：搜索完成且未被阻断，但未找到该 ASIN。
- `blocked`：浏览器结果报告 `blocked=true`。
- `failed`：任务最终失败，或结果文件接收与校验失败。
- `not_executed`：本次运行结束前尚未执行该关键词。

自然排名取该 ASIN 所有数值型 `naturalRank` 的最小值。广告位置取没有 `naturalRank` 且 `adType` 非空的记录中最小的 `rank`。`best_overall_position` 取目标 ASIN 所有出现记录中最小的 `rank`。缺失排名保持为空。

HTML 报告内嵌本地交互所需的全部已转义排名历史，并通过 HTTPS 内容分发网络加载优麦云官方标志、Tailwind CSS、Remix Icon 和 ECharts。完整显示样式及交互图表需要联网；外部依赖加载失败时，内嵌表格与数据仍应可读，并显示明确的依赖加载警告。

报告将每项指标与同一关键词上一次有数值的观测进行比较。差值为正表示排名改善，因为排名数字越小越好。缺失、失败、页面阻断和未执行的数据点在图表上保持断开；ECharts 使用 `connectNulls=false` 和反向排名轴，使第 1 名位于顶部。
