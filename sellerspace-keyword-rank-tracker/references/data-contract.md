# 关键词排名追踪数据约定

## 目录

- 输入与预检
- 命令与运行状态
- 结果文件校验
- 输出目录和字段

## 输入与预检

所有命令从非终端标准输入读取第一条非空的单行 JSON，输出一个紧凑 JSON 对象；失败时向标准错误输出 `{ok:false,error:{code,message}}` 并使用非零退出码。使用 Node.js 22 及以上版本。

`prepare-run` 输入示例（组装后通过单行 JSON 传入）：

```json
{
  "config_path": "/absolute/job.json",
  "asin": "B0XXXXXXXX",
  "marketplace": "US",
  "pages": 3,
  "keywords_file": "./keywords.txt",
  "output_dir": "./rank-data/B0XXXXXXXX-US",
  "browser_id": "selected-browser-id",
  "preflight": {
    "mcp_ready": true,
    "required_tools": ["discover_capabilities", "browser_list", "browser_submit_task", "browser_get_task"],
    "action_id": "amazon.search.keyword_rank",
    "action_available": true,
    "action_version": 5,
    "browser_online": true,
    "browser_id": "selected-browser-id",
    "artifact_delivery_available": true,
    "artifact_schema_version": 1,
    "checked_at": "2026-09-14T08:00:00.000Z",
    "browser_meta": {"name":"办公室电脑","browser":"chrome","os":"mac"}
  }
}
```

`config_path` 可省略，直接提供的参数覆盖配置中的同名值。配置文件内的相对路径以该文件所在目录为基准，直接提供的相对路径以工作目录为基准。

合并后必须有：10 位字母数字 `asin`、非空 `marketplace`、1–10 整数 `pages`、`keywords_file`、`output_dir`。ASIN 和站点转大写，不补默认值。可选 `browser_id` 必须与预检一致。

关键词文件必须为有效 UTF-8；去 BOM、去行首尾空白，忽略空行及 `#` 注释。按 NFKC 及不区分大小写去重，保留首次写法，数量须为 1–50。

预检凭据来自当前真实工具结果：四个工具齐全、MCP 可用、指定动作可用且版本至少 5、所选浏览器在线、支持 artifact schema 1。可选 `checked_at` 支持 ISO 字符串或毫秒数值；`browser_meta` 仅保留 name/browser/version/os/profile。新建和恢复在读取项目文件前校验凭据；`render-report` 不需要凭据。

## 命令与运行状态

### 准备：`prepare-run`

输入见上文。输出包含 `run_id`、`output_dir`、`browser_id`、`action`、`outputs` 和有序的 `tasks`。每项包含：

- `keyword_index`、`keyword`、`next_action` 和 `attempts`。
- `params={keyword,marketplace,pages,mode:"auto",screenshot:false,upload:true}`。
- `result_delivery={mode:"artifact",targetAsin:<项目 ASIN>}`。

创建 `running` 清单，关键词初始为 `pending`。已有目录必须属于相同 ASIN 和站点；已有 `run_id` 不得覆盖。

### 记录提交：`record-submission`

```json
{"output_dir":"/absolute/project","run_id":"run-id","keyword_index":0,"task":{"status":"running","jobId":"job-1","createdAt":1789372800000}}
```

保存 `job_id`、`submitted_at` 和尝试记录，关键词变成 `submitted`。重复保存同一标识是幂等的；有在途任务时拒绝记录另一提交。首次失败为 TIMEOUT/ACTION_FAILED 时才允许记录第二次提交，且必须使用新的 jobId。调用此命令前智能体也必须遵守串行提交约束；本地命令不能撤销已提交的远端任务。

### 记录结果：`record-result`

```json
{
  "output_dir":"/absolute/project",
  "run_id":"run-id",
  "keyword_index":0,
  "task":{
    "status":"completed",
    "jobId":"job-1",
    "finishedAt":1789373400000,
    "summary":{"resultCount":96,"target":{"asin":"B0XXXXXXXX","naturalRank":18}},
    "artifact":{
      "schemaVersion":1,
      "id":"2026-09/artifact-id",
      "downloadUrl":"https://hub.example/artifacts/download?...",
      "sha256":"64 位小写十六进制字符",
      "uncompressedSizeBytes":12345
    }
  }
}
```

`task.status` 须为 `completed` 或 `failed`；失败携带 `error:{code,message}`。已记录提交时，结果 jobId 必须一致，脚本自动保留此前尝试；无需重新组装 `attempts`。

兼容未使用 `record-submission` 的既有调用，可显式提供最多两条 `attempts`。最后一条须与任务状态及 jobId 匹配，第二次尝试的前置失败只能是 TIMEOUT/ACTION_FAILED。明确提交失败可没有 jobId，禁止编造标识。

完成时间支持毫秒数值和日期字符串，统一存为 UTC ISO；缺失或无效才使用本地记录时间。同一运行结束前可重新记录结果，替换该关键词的暂存数据及错误信息。内嵌 `task.result` 一律拒绝。

### 恢复：`resume-run`

输入 `{output_dir,run_id,preflight}`。要求运行仍为 `running` 且浏览器与原运行一致；不重读关键词源文件。脚本修复“暂存结果已写入、清单尚未更新”的中断，再返回剩余任务：

- `submitted` 返回 `next_action="poll"` 和原 `job_id`。
- `pending` 或仅首次浏览器 TIMEOUT/ACTION_FAILED 返回 `next_action="submit"`。
- 已归档成功、阻断或最终失败不再返回。

恢复后的参数来自原运行快照。尝试记录不会被暂存的首次失败覆盖正在执行的第二次任务。已结束的运行不能恢复或追加结果。

### 结束：`finalize-run`

输入 `{output_dir,run_id,interrupted:false}`。存在未执行关键词、尚未归档的在途任务，或 `interrupted=true` 时，状态为 `incomplete`；否则存在失败或阻断为 `completed_with_issues`，其余为 `completed`。

已提交但没有最终结果的关键词记录为 `failed/RESULT_NOT_RECORDED`，从未提交的关键词记录为 `not_executed`。本地结束不代表取消了远端任务。

重复结束不重复追加历史；成功生成报告后清理暂存。报告生成失败可再次执行结束操作。结束后不改写该运行的全量 ASIN CSV。

### 重建报告：`render-report`

输入 `{output_dir,asin?}`。省略 ASIN 时重建目标报告；其他 ASIN 须在有效全量历史中出现过。返回 `report_path`、`history_path` 和 `observation_count`。

竞品生成自己的 CSV；全量归档缺失或不可读时明确失败，不生成虚假的“未找到”。仅重建目标报告不修改旧历史 CSV。图表和表格按 `keyword_key` 分组，日期筛选不改变与上次有效观测的比较口径。

## 结果文件校验

只接受 HTTPS 地址；本机测试允许 HTTP 回环地址。禁止重定向，120 秒超时覆盖响应头和完整响应体，解压后最大 64 MiB；校验大小和 SHA-256 后按 UTF-8 JSON 解析。下载网址不写入清单，仅保存筛选后的元数据。

结果对象要求：

- `keyword`、`marketplace` 与当前任务一致，`blocked` 为布尔值，`pages` 为数组。
- 非阻断结果须完成请求页数；阻断允许提前结束。存在 `pageCount` 时必须等于请求页数。
- 每页具有从 1 连续递增的 `page`、`mode="fetch"|"tab"`、`asins` 数组。页面级 `blocked=true` 也会使本关键词按阻断归档。
- 每次出现包含有效的 10 位 ASIN 和正整数 `rank`；提供的 `naturalRank` 必须为正整数或 null，`adType` 为字符串或空值。

结构、身份、文件下载、大小、校验和或 JSON 校验失败均保存为 `failed/ARTIFACT_*`，不重试浏览器任务。正常完成且未找到目标、页面阻断、失败和未执行记录的排名均留空。

## 输出目录和字段

```text
output_dir/
├── project.json
├── target-rank-history.csv
├── report.html
├── all-asins/YYYY-MM/<run_id>.csv
├── reports/<other_asin>.html
├── reports/<other_asin>-rank-history.csv
└── runs/<run_id>.json
```

`project.json` 固定 ASIN/站点。运行清单保存输入快照、浏览器、任务和尝试记录、关键词状态、统计及输出路径。暂存数据位于 `runs/.staging/<run_id>/`。同一输出目录只允许一个写入流程，原子文件替换不提供跨进程事务。

CSV 使用 UTF-8 BOM、CRLF、引号转义和原子替换。目标和竞品排名历史每个 `run_id + keyword_key` 保存一行：

```text
run_id,collected_at,marketplace,target_asin,keyword,keyword_key,pages_requested,
pages_completed,result_count,blocked,target_found,natural_found,natural_rank,
ad_found,best_ad_position,ad_types,ad_occurrence_count,best_overall_position,
status,error_code,error_message
```

`keyword_key` 为关键词的 NFKC/小写规范化值，兼容没有该列的旧文件；展示保留原始 `keyword`。全量 ASIN CSV 保留每次出现：

```text
run_id,collected_at,marketplace,keyword,page,page_mode,page_url,
position,natural_rank,asin,ad_type
```

自然排名取该 ASIN 的最小 naturalRank；广告位置取没有自然排名且 adType 非空的记录中最小 rank；总体位置取所有出现记录的最小 rank。状态为 ok/not_found/blocked/failed/not_executed。HTML 内嵌经过转义的历史数据，图表使用反向排名轴和 `connectNulls=false`。
