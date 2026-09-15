# 数据与命令契约

## 运行边界与输入

Node.js 22+，无 npm 运行依赖。命令只负责本地文件和真实 Artifact 下载；MCP 调用与 AI 理解由宿主完成。CLI 不接受 inline 评论或测试 fetch 注入。

每条命令：`node <skill-dir>/scripts/review-analysis.mjs <command>`，stdin 单个 JSON；通用输入 `output_dir` 和可选的 `run_id`。示例中的 ASIN、浏览器、jobId、receipt 均为占位，不能当作真实调用结果。

prepare-run 参数：

```json
{
  "marketplace": "US",
  "asins": ["B000000001", "B000000002"],
  "output_dir": "/absolute/review-analysis-us-YYYYMMDD-HHmmss",
  "timeout_ms": 600000,
  "max_reviews": null,
  "preflight": {
    "mcp_ready": true,
    "required_tools": ["discover_capabilities", "browser_list", "browser_submit_task", "browser_get_task"],
    "action_id": "amazon.product.reviews",
    "action_available": true,
    "action_version": 4,
    "action_read_only": true,
    "action_input_fields": ["crawlMode", "starFilters", "includeHelpful", "knownReviewIds", "knownReviewStreak"],
    "browser_online": true,
    "browser_id": "真实在线设备 ID",
    "artifact_delivery_available": true,
    "artifact_schema_version": 1,
    "checked_at": "本次工具检查的 ISO 时间",
    "browser_meta": { "name": "实际设备名称" }
  }
}
```

- `asin`、`asins` 数组、`asins_file` 三选一，统一大写并去重，1–10 个。文件 UTF-8 每行一个，忽略空行、BOM 和以 # 开始的注释。
- `marketplace` 必填，支持与评论 Action 相同的 19 个站点 code。
- `timeout_ms` 默认 600000，范围 30000–600000，**每个 ASIN 单独计算**。`max_reviews` 省略或 null 表示不限，其他值为正安全整数；MCP 请求不限时省略 maxReviews，不传 null。
- 可选 `config_path` 读取 JSON，显式值覆盖配置；切换输入方式时把旧字段显式设为 null。配置相对路径以配置目录为基准，显式路径以当前目录为基准。
- 可选 browser_id 必须与 receipt 一致。预检先于配置与 ASIN 文件读取。已有 run.json 的目录不能用于新采集。

## 采集命令

`prepare-run` 返回 run_id、browser_id、每个 ASIN 的预算及总采集预算；它不提交 MCP 任务。

`next-task` 三种返回：

- `{task:{index,asin,claim_id,browser_id,action,params,result_delivery}}`：本轮新领取；原样提交。
- `{waiting:true,job_id,poll_deadline,index}`：查询原 job_id，不再次提交。
- `{done:true,next_action:"next-analysis-batch"}` 或 `{stopped:true,...}`：开始分析或先中断归档。

领取状态会持久化。waiting 且 job_id=null 表示提交结果未知，只能从原响应找回 jobId 并 record-submission，或中断，不能盲目重发。

`record-submission`：

```json
{"output_dir":"/run","index":0,"claim_id":"本轮领取值","job_id":"真实返回的 jobId"}
```

保存后返回 poll_deadline。重复登记同一 jobId 幂等。所有任务串行，同一 ASIN 重试的参数由 next-task 按剩余预算生成，不手动添加另一份 10 分钟。

`record-result`：

```json
{
  "output_dir": "/run",
  "index": 0,
  "task": {
    "status": "completed",
    "jobId": "真实任务 ID",
    "artifact": {
      "schemaVersion": 1,
      "id": "真实 Artifact ID",
      "downloadUrl": "真实短期 HTTPS 地址",
      "sha256": "真实 SHA-256",
      "uncompressedSizeBytes": 12345
    }
  }
}
```

task 失败时用 `{status:"failed",jobId,error:{code,message}}`。提交前明确失败没有 jobId，额外传本轮 claim_id；不能伪造 jobId。提交响应不确定时 error.code=SUBMISSION_UNKNOWN。工具异常缺少 task.status 时也归一化成此结构。脚本输出 ok=false 但已归档终态时按 retry_queued / should_stop 决定下一步，不把它当作需要重复采集的本地崩溃。

Artifact 仅 HTTPS、禁止重定向，解压后最大 64 MiB，SHA-256 和大小针对解压后 JSON；下载及响应体读取超时 120 秒。签名地址不入磁盘，原始结果落入 raw。结果必须匹配 ASIN、站点、snapshot、请求星级及 requestedMax。下载失败不重新提交浏览器任务。临时下载错误返回 download_retry_allowed=true 时，在任何评论开始标注之前可用同一已完成 jobId 再次 record-result，仅允许再下载一次；校验失败不重试。终态幂等重放会准确返回原任务成功或失败状态，不把失败伪装成成功。

`status-run` 返回已持久化进度，不显示评论全文。`resume-run` 额外传新的真实 preflight，必须原浏览器；已经归档的运行不能重开。

`finish-collection`：正常完成时无额外字段；还有未执行或未知任务且要停止时传 `interrupted:true`。剩余任务标记 skipped，不声称远端任务被取消；本次已取得的数据仍进入分析。

## 分批标注契约

`next-analysis-batch` 仅在全部采集任务已结束或中断后使用，返回 `batch_id`、`units`、`topics`、`pending_units`、`done`。每个 unit 含 unit_id、review_key、asin、rating、field、start、text。最多 30 个 unit、16000 正文字符，单段最多 8000 字符。空评论也有一个空分段。

`record-analysis` 输入：

```json
{
  "output_dir": "/run",
  "analysis": {
    "batch_id": "next-analysis-batch 返回值",
    "topics": [{"id":"installation_instructions","label":"安装说明清晰度","kind":"pain","domain":"usage"}],
    "annotations": [{
      "unit_id": "实际分段 ID",
      "sentiment": "negative",
      "observations": [{
        "topic_id":"installation_instructions",
        "polarity":"negative",
        "severity":"normal",
        "quote":"本分段中真实存在的连续原文",
        "interpretation":"中文解释，保留原文的条件与否定关系"
      }]
    }]
  }
}
```

- 必须恰好覆盖本批全部 unit_id，不能遗漏、重复或跨批；旧批的完全相同重放幂等。
- topics 可以为空数组；新主题 id 为小写字母开头，含小写字母、数字、下划线或短横线，最长 64 字符。已有 id 的含义不能变化。
- sentiment 使用 positive/negative/mixed/neutral/unknown；polarity 不接受 unknown。severity 为 normal/functional/safety。
- observations 允许为空，空评论必须 unknown 且无观察。quote 必须逐字包含于当前分段，最多 1200 字符；interpretation 必须非空。
- analysis-core 负责合并评论分段与去重，没分析完全部分段的评论不进入主题统计。

`merge-topics` 输入 `mappings:[{from:"旧主题 id",to:"保留主题 id"}]`，只能合并同 kind/domain。先收齐批次，再统一同义主题；合并会使旧 findings 失效。

`analysis-summary` 返回每个 ASIN 的已分析数、主题频次与正反反馈数量。每个主题、每个 ASIN 选最多 3 条不同评论，优先覆盖严重、负面及正面反馈；每条评论最多返回 2 个相反方向的证据片段，避免长评论占满摘要。完整证据和标注仍保留本地。

## 结论与归档

`record-findings` 输入 `findings` 数组：

```json
{
  "output_dir":"/run",
  "findings":[{
    "id":"clarify_installation",
    "section":"faq",
    "priority":"P2",
    "title":"用步骤说明降低安装理解成本",
    "recommendation":"核验安装步骤后，补充相应的操作说明方向。",
    "validation":"由首次使用者按说明完成安装，记录仍不清楚的步骤。",
    "caveat":"仅为评论支持的建议，未检查当前 Listing。",
    "asins":["B000000001"],
    "topic_ids":["installation_instructions"],
    "evidence_keys":["analysis-summary 中真实存在的 review_key"]
  }]
}
```

section 为 summary/product/listing/image/faq/comparison；priority 为 P1/P2/P3。每项所引证据必须属于对应 ASIN 和主题；每个被比较 ASIN 都要有证据。空样本或没有证据支持建议时允许空数组。自由文本不填自算条数和比例。

`finalize-run` 要求所有评论分段完成、findings 与当前分析版本匹配，输出 report_path、csv_path、analysis_path。先写输出，最后写 finalized_at，失败可重复执行恢复。`render-report` 根据已归档文件离线重建；未归档时必须 `draft:true`，输出 draft.html 和 analysis-draft.json，不能冒充最终报告。

```text
output_dir/
├── run.json                # 参数、任务、主题字典、逐段标注、结论与版本
├── raw/<ASIN>.json         # 原始 Artifact 结果及去掉签名 URL 的来源元数据
├── reviews.csv             # 去重后的完整评论；UTF-8 BOM，防公式注入
├── analysis.json           # 完整分析、证据、统计、覆盖与建议
└── report.html             # 单文件离线交互报告
```

短暂文件和锁由脚本管理。同目录命令互斥；已退出 PID 的残留锁可自动恢复，活动进程的锁不会被抢占。跨主机共享目录不受支持。不手动编辑 run/raw 来修改事实或解除状态。
