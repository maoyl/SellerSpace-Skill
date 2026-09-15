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
  "analysis_format": "compact-v2",
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
- `analysis_format` 默认 `compact-v2`；`legacy-v1` 保留旧流程。新格式可选 `cache_dir` 路径，默认 `~/.cache/sellerspace-review-analysis/v2`，`false` 关闭；配置文件内的相对路径以配置目录为基准。缓存仅保存在本机，不调用额外模型服务。

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

## 轻量标注契约（compact-v2）

`next-analysis-batch` 仅在全部采集任务已结束或中断后使用。返回 `format`、`batch_id`、`units`、`topics`、`pending_units`、`pending_reviews`、`estimated_output_tokens`、`done`；完成时 next_action=next-insight-batch。

每个 unit 是一条评论的标题与正文，超长才分组：`{unit_id,review_key,asin,rating,sentences:[["s1","title","原文标题"],["s2","content","正文句子"]]}`。句子编号只在当前 unit 内有效，长句会拆成不超过 600 字符的连续片段，相关否定与条件需一起引用。动态限制最多 80 组、32000 原文字符及 8000 估算输出 token；这些是上限，长评会缩小批次，不能固定要求每批 80 条。空评论也保留一个分组。读取批次时保留完整工具输出；若宿主截断，应调整输出额度并重读同一批，不能提交缺项。

`record-analysis` 输入：

```json
{
  "output_dir": "/run",
  "analysis": {
    "batch_id": "next-analysis-batch 返回值",
    "topics": [{"id":"installation_instructions","label":"安装说明清晰度","kind":"pain","domain":"usage"}],
    "annotations": [{
      "unit_id": "本批真实 unit_id",
      "sentiment": "negative",
      "uncertain": false,
      "observations": [{
        "topic_id":"installation_instructions",
        "polarity":"negative",
        "severity":"normal",
        "sentence_ids":["s2"]
      }]
    }]
  }
}
```

- 必须恰好覆盖本批全部 unit_id，不能遗漏、重复或跨批；旧批的完全相同重放幂等。
- topics 可以为空数组；新主题 id 为小写字母开头，含小写字母、数字、下划线或短横线，最长 64 字符。已有 id 的含义不能变化。
- sentiment 使用 positive/negative/mixed/neutral/unknown；polarity 不接受 unknown。severity 为 normal/functional/safety。
- severity 省略时为 normal；uncertain 可省略，默认 false。歧义或无法确定含义时设 true；没有成立的主题可留 observations=[]，不确定项仍会复核。
- sentence_ids 必须是当前 unit 中非空、无重复的有效编号；脚本从对应句子恢复 quote。第一轮不提交 quote 或 interpretation，不重复输出长引用、翻译和解释。
- observations 允许为空；空评论必须 unknown 且无观察。脚本合并完整评论后才计入主题统计，未完成的超长评论不提前计数。
- 每批提交后自动写 draft.html、analysis-draft.json，返回 draft_path；草稿写入失败返回 draft_error，标注已保存，不必重标注，可稍后 render-report({draft:true}) 重建。

`merge-topics` 输入 `mappings:[{from:"旧主题 id",to:"保留主题 id"}]`，只能合并同 kind/domain。先收齐批次，再统一同义主题；合并会使旧 findings 失效。

## 重点证据复核

完成全部轻量标注和主题归并后，循环 `next-insight-batch` / `record-insights`。前者返回 `{batch_id,done,pending_evidence,total_evidence,reviewed_evidence,units}`；每批最多 48 项、16000 上下文字符。unit 含 evidence_id、review_key、topic_id、polarity、severity、uncertain、quote、context。

队列包含各主题各 ASIN 的代表性正反证据、全部 functional/safety、不确定项及混合意见。context 提供标题和正文摘录；需要超出摘录的条件时读取对应原始评论。无主题的不确定项 topic_id=null；按原文解释歧义，不自行补主题。

```json
{
  "output_dir":"/run",
  "analysis":{
    "batch_id":"next-insight-batch 返回值",
    "insights":[{"evidence_id":"本批真实证据 ID","interpretation":"简短中文解释，保留原文条件与否定关系"}]
  }
}
```

必须恰好覆盖本批全部 evidence_id，解释非空且最多 1200 字符。相同已提交批次重放幂等；脚本恢复并保存原文，普通证据保留空 interpretation。每批复核后更新草稿。

发现标签错误时执行 `reopen-reviews`，输入 `review_keys:["本次有效 review_key"]`。只清除这些评论的标注并排除旧缓存恢复，然后重新标注、归并、复核；旧 findings 失效。无主题不确定项的解释存入 annotation.assessment；它不产生主题次数或凭空支持建议。

`done=true` 后进入 `analysis-summary`：返回每个 ASIN 已标注数、主题频次与正反反馈数量。每主题、每 ASIN 最多 3 条不同评论的代表性证据，每条最多 2 个相反方向片段；完整证据保留本地。

## 缓存、旧运行与恢复

- compact-v2 首次 next-analysis-batch 自动尝试复用本地缓存。缓存指纹包含规则版本 `review-analysis-2.0`、站点、请求 ASIN、reviewId、评论变体、评分、标题和正文；任何一项变化都会失效。只复用完整评论，损坏或主题冲突的缓存跳过，继续新分析。
- record-analysis、record-insights、merge-topics 会更新已完成评论的缓存。缓存复用数由脚本返回；同一运行仍重新计算重点队列并走到 done=true。缓存加速重复分析，首次提速来自整条打包和精简输出，不能承诺固定耗时。
- 旧运行不会自动迁移：legacy-v1 的 next-analysis-batch 仍为最多 30 个分段、16000 字符，unit 含 field/start/text，单段最多 8000 字符；record-analysis 仍逐段提交 quote（连续逐字原文，最多 1200 字符）及非空 interpretation，不提交 sentence_ids。完成后直接 analysis-summary，无重点复核阶段。
- 未归档旧运行如需加速，在没有待提交旧批时调用 `optimize-run`（可传 cache_dir）；保留已分析数据，切换 compact-v2 并使旧结论失效，再 next-analysis-batch 继续。已领取旧批要先提交，不把旧 payload 提交给新格式。
- `status-run` 返回 analysis_format、cache_reused、draft_path；采集终态后还返回 collected_reviews、analyzed_reviews、pending_reviews、pending_insights。旧 analyzed_units 是底层分段数，不能当评论条数；标注未完时 pending_insights=null。归档运行只用 render-report 离线重建，不迁移或重开评论。

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

`finalize-run` 要求所有评论标注完成、compact-v2 的重点证据复核完成、findings 与当前分析版本匹配，输出 report_path、csv_path、analysis_path。先写输出，最后写 finalized_at，失败可重复执行恢复。`render-report` 根据已归档文件离线重建；未归档时必须 `draft:true`，输出 draft.html 和 analysis-draft.json，不能冒充最终报告。

报告 `analysis_progress` 含 format、cache_reused、label_complete、insights_complete、reviewed_evidence、total_evidence。复核计数以本次运行的重点证据为单位，不是评论条数；只有轻量标注结束后重点队列才确定。未复核普通证据只展示主题和原文。

```text
output_dir/
├── run.json                # 参数、任务、主题字典、逐段标注、结论与版本
├── raw/<ASIN>.json         # 原始 Artifact 结果及去掉签名 URL 的来源元数据
├── reviews.csv             # 去重后的完整评论；UTF-8 BOM，防公式注入
├── analysis.json           # 完整分析、证据、统计、覆盖与建议
├── analysis-draft.json     # 分批更新的当前分析进度
├── draft.html              # 分批更新的离线草稿，不能当作最终结果
└── report.html             # 单文件离线交互报告
```

短暂文件和锁由脚本管理。同目录命令互斥；已退出 PID 的残留锁可自动恢复，活动进程的锁不会被抢占。跨主机共享目录不受支持。不手动编辑 run/raw 来修改事实或解除状态。
