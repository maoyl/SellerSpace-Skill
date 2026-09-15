import { safeJson } from "./analysis-core.mjs";

// No network, fonts, chart libraries, or remote images are required by the report.
export function renderReportHtml(report) {
  const { annotations, topics, ...data } = report;
  data.review_assessments = {};
  for (const annotation of Object.values(annotations ?? {})) {
    if (!annotation.assessment?.trim() || !annotation.review_key) continue;
    const values = data.review_assessments[annotation.review_key] ??= [];
    if (!values.includes(annotation.assessment)) values.push(annotation.assessment);
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SellerSpace · 评论分析</title><style>
:root{color-scheme:light;--ink:#202038;--muted:#707088;--line:#e7e7f0;--purple:#776ff6;--soft:#eeedff;--red:#b94d64;--green:#24846f}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f6f6fb;color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}button,input,select{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer;border:1px solid var(--line);border-radius:8px;background:white;padding:7px 12px;color:var(--ink)}button:hover{border-color:var(--purple);color:#5148ca}button:disabled{opacity:.4;cursor:default}a{color:#5a51cb;text-decoration:none}a:hover{text-decoration:underline}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #ada8ff;outline-offset:3px}
header{background:#fff;border-bottom:1px solid var(--line);padding:19px 34px;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-size:19px;font-weight:750;letter-spacing:-.4px}.brand span{color:var(--purple)}.eyebrow{font-size:11px;font-weight:700;letter-spacing:2px;color:var(--muted)}.shell{display:grid;grid-template-columns:190px minmax(0,1fr);max-width:1500px;margin:auto}aside{padding:32px 22px;position:sticky;top:0;height:100vh}nav a{display:block;padding:10px 12px;border-radius:8px;color:var(--muted);margin-bottom:5px}nav a:hover{background:var(--soft);color:#5148ca;text-decoration:none}.nav-note{font-size:12px;color:var(--muted);padding:20px 12px}main{padding:32px 38px 80px;min-width:0}.intro{display:flex;justify-content:space-between;gap:20px;align-items:end}h1{font-size:34px;line-height:1.3;letter-spacing:-1px;margin:10px 0}h2{font-size:23px;line-height:1.4;margin:0}h3{font-size:16px;margin:0 0 9px}p{margin:7px 0}.muted{color:var(--muted)}.small{font-size:12px}.kicker{color:var(--purple);font-size:12px;font-weight:700;letter-spacing:1.5px}section{scroll-margin-top:20px;margin-top:34px}.section-head{display:flex;justify-content:space-between;gap:15px;align-items:end;margin-bottom:15px}.grid{display:grid;gap:15px}.stats{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:25px}.card{background:white;border:1px solid var(--line);border-radius:14px;padding:21px}.stat-number{font-size:32px;font-weight:700;letter-spacing:-1px}.stat-label{font-size:12px;color:var(--muted)}.notice{background:#fff8e9;border:1px solid #f1dfb7;border-left:4px solid #d4a557;border-radius:9px;padding:13px 16px;margin-top:18px;font-size:13px;color:#70562c}.notice.draft{background:#fff0f2;color:#9a3c52;border-color:#e5b5c2}.two{grid-template-columns:repeat(2,minmax(0,1fr))}.three{grid-template-columns:repeat(3,minmax(0,1fr))}.tag{display:inline-block;padding:3px 8px;font-size:11px;border-radius:5px;background:var(--soft);color:#554cc3;margin:0 4px 4px 0}.tag.bad{color:var(--red);background:#fbeef2}.tag.good{color:var(--green);background:#e9f6f1}.topic{display:block;text-align:left;width:100%;border:0;border-bottom:1px solid #f0f0f6;border-radius:0;padding:13px 0}.topic:last-child{border:0}.topic-head{display:flex;justify-content:space-between;gap:14px;align-items:start}.track{height:7px;background:#f0eff8;border-radius:8px;margin-top:9px;overflow:hidden}.fill{height:100%;background:var(--purple);border-radius:8px}.fill.pain{background:#c56b7f}.fill.praise{background:#46a18a}.empty{padding:25px 0;color:var(--muted);font-size:14px}.evidence-button{font-size:12px;margin-top:12px}.finding{display:flex;flex-direction:column;align-items:start}.finding .body{flex:1}.priority{font-weight:700;font-size:12px;color:#635acd;letter-spacing:.8px}.coverage{margin-top:15px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f9f9fd;font-weight:600;white-space:nowrap}td:first-child{min-width:150px}.matrix td:not(:first-child){min-width:110px}.matrix button{border:0;background:var(--soft);min-width:80px;font-size:12px}.filters{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}.filters input{flex:1;min-width:180px}.filters input,.filters select{border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);padding:9px 12px;max-width:100%}.review{border-top:1px solid var(--line);padding:20px 0}.review:first-child{border-top:0}.review-top{display:flex;justify-content:space-between;gap:20px}.review h3{margin:10px 0 4px}.review .body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}.review summary{color:#5c53c8;cursor:pointer;font-size:12px;margin:8px 0}.interpretation{background:#f7f7fd;padding:10px 14px;margin:8px 0;border-radius:8px;font-size:13px}.quote{border-left:2px solid #c0bafc;margin-top:6px;padding-left:10px;white-space:pre-wrap;color:var(--muted)}.pager{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding-top:16px;gap:15px}.method{font-size:13px;color:var(--muted)}.method li{margin:9px 0}footer{margin-top:30px;font-size:12px;color:var(--muted)}.scope-select{max-width:250px;padding:9px;border-radius:8px;border:1px solid var(--line);background:#fff}
@media(max-width:1000px){aside{display:none}.shell{display:block}main{padding:24px}.stats{grid-template-columns:repeat(2,1fr)}.three{grid-template-columns:1fr}}@media(max-width:650px){header{padding:16px}.brand{white-space:nowrap;font-size:16px}header .eyebrow{display:none}main{padding:18px}.intro,.section-head{display:block}h1{font-size:28px}.two{grid-template-columns:1fr}.scope-select{margin-top:10px}.card{padding:16px}.review-top{display:block}.stat-number{font-size:26px}}
@media print{body{background:white;font-size:11px}header{padding:0 0 10px}aside,.filters,.pager,button,.scope-select{display:none!important}.shell{display:block}main{padding:16px 0}section{margin-top:22px}.card{break-inside:avoid;border-radius:0;padding:12px}.grid{gap:10px}.stats{grid-template-columns:repeat(4,1fr)}.scroll{overflow:visible}.review .body{max-height:none;overflow:visible}.track{print-color-adjust:exact}.notice{print-color-adjust:exact}h1{font-size:26px}.matrix td,.matrix th{padding:6px}.matrix button{display:inline!important}a{color:inherit}.quote{white-space:normal}}
</style></head><body>
<header><div class="brand"><span>SellerSpace</span> · 评论分析</div><div><span class="eyebrow">VOICE OF CUSTOMER</span> <button id="print">打印 / PDF</button></div></header>
<div class="shell"><aside><nav aria-label="报告导航"><a href="#overview">01　核心结论</a><a href="#themes">02　好评与痛点</a><a href="#contexts">03　动机与需求</a><a href="#comparison">04　ASIN 对比</a><a href="#actions">05　行动建议</a><a href="#evidence">06　评论证据</a><a href="#method">07　分析口径</a></nav><div class="nav-note">从用户原话出发。<br>采集与分析进度分别展示。</div></aside>
<main><div class="intro"><div><div class="kicker">REVIEW ANALYSIS</div><h1>把用户反馈，变成下一步行动</h1><p class="muted small" id="meta"></p></div><label>分析范围 <select id="scope" class="scope-select" aria-label="分析范围"></select></label></div>
<div id="banner"></div><div id="stats" class="grid stats"></div><div id="analysis-progress" class="card coverage" aria-live="polite"></div>
<section id="overview"><div class="section-head"><h2>核心结论</h2><span class="muted small">观察、解释与建议均可核对</span></div><div id="summary" class="grid two"></div><details class="card coverage"><summary>查看采集覆盖与星级分布</summary><div id="coverage" class="scroll"></div></details></section>
<section id="themes"><div class="section-head"><h2>用户满意什么，又被什么困扰</h2><span class="muted small">点击主题查看原始评论</span></div><div class="grid two"><div class="card"><h3>好评卖点</h3><div id="praise"></div></div><div class="card"><h3>差评痛点</h3><div id="pain"></div></div></div></section>
<section id="contexts"><div class="section-head"><h2>购买动机、使用场景与未满足需求</h2></div><div class="grid three"><div class="card"><h3>为什么买</h3><div id="motivation"></div></div><div class="card"><h3>在哪里、如何使用</h3><div id="scenario"></div></div><div class="card"><h3>还希望获得什么</h3><div id="need"></div></div></div></section>
<section id="comparison"><div class="section-head"><h2>多个 ASIN 的共性与差异</h2><span class="muted small">比较已观察到的反馈，不评定商品优劣</span></div><div id="overlap"></div><div class="card scroll" id="matrix"></div><div id="comparison-findings" class="grid two" style="margin-top:15px"></div></section>
<section id="actions"><div class="section-head"><h2>产品与运营行动清单</h2><span class="muted small">按优先级展示，实施前核验产品事实</span></div><div id="findings" class="grid two"></div></section>
<section id="evidence"><div class="section-head"><h2>回到原始评论</h2><span class="muted small" id="evidence-count"></span></div><div class="card"><div class="filters"><select id="star" aria-label="星级筛选"><option value="">全部星级</option><option value="1">1 星</option><option value="2">2 星</option><option value="3">3 星</option><option value="4">4 星</option><option value="5">5 星</option><option value="unknown">未知星级</option></select><select id="topic" aria-label="主题筛选"></select><input id="search" type="search" placeholder="搜索标题、正文、ASIN 或评论 ID" aria-label="搜索评论"><button id="clear">清除证据筛选</button></div><p id="evidence-focus" class="muted small"></p><div id="reviews"></div><div class="pager"><button id="previous">上一页</button><span class="muted small" id="page-info"></span><button id="next">下一页</button></div></div></section>
<section id="method"><div class="section-head"><h2>这些结论应该怎样使用</h2></div><div class="card method"><ul><li>数据来自 Amazon 页面实际可见的评论，包含星级筛选和 recent 排序。样本占比不是商品真实差评率、故障率或市场占有率。</li><li>主题计数按评论去重，同一评论可涉及多个主题；混合意见可同时计入正面和负面，比例之和不要求等于 100%。</li><li>全范围主题次数按站点和 reviewId 去重；各 ASIN 内分别计数。共享评论可能来自变体，不能视为独立竞品证据。</li><li>星级分布使用采集到的评论，主题与文本情绪只使用完成整条标注的评论；草稿中的标注完成不代表重点复核和最终结论已完成。未知值保留未知，不填成零或负面。</li><li>购买动机、人群和场景仅依据评论明确表述。建议是待核验的行动方向；未采集 Listing，不能据此认定当前页面存在遗漏。</li><li>每个 ASIN 独立拥有采集预算。下载、分析和报告生成时间另计；采集不完整和未执行的 ASIN 会单独标明。</li><li>报告不推算销量或转化率收益，不将个别评论当作普遍事实，不输出质量变化趋势。主题和重点解释由 AI 辅助理解，普通证据仅保留主题与原文；重要结论请点击证据复核。</li><li>报告核心内容完全离线可用；Amazon 原文链接需要联网。打印保留主要结论与当前评论证据页，完整原始评论保存在 reviews.csv 和 raw 目录。</li></ul></div></section>
<footer id="footer"></footer></main></div>
<script type="application/json" id="report-data">${safeJson(data)}</script><script>(${reportClient.toString()})();</script></body></html>`;
}

// All user text enters HTML through esc(); no content is used as code or markup.
export function reportClient() {
  const data = JSON.parse(document.getElementById("report-data").textContent);
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const number = (n) => Number(n).toLocaleString("zh-CN");
  const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : "—";
  const empty = (message = "本次样本没有足够证据，不生成结论。") => `<div class="empty">${esc(message)}</div>`;
  const domainLabels = { product: "产品本身", packaging: "包装", delivery: "配送", support: "售后", usage: "使用方式", expectation: "预期落差", value: "价值感知", other: "其他" };
  const sectionLabels = { summary: "核心结论", product: "产品改进", listing: "Listing 表达", image: "图片演示", faq: "FAQ / 使用说明", comparison: "ASIN 对比" };
  const kindLabels = { pain: "痛点", praise: "卖点", motivation: "动机", scenario: "场景", need: "需求" };
  const stops = { target_reached: "达到条数目标", visible_set_exhausted: "可见集合已耗尽", platform_limited: "平台限制", time_budget_reached: "达到时间预算", page_load_timeout: "页面加载超时", captcha: "需要验证码", login_required: "需要登录", page_unsupported: "页面不支持", filter_not_applied: "筛选未生效", slice_quota_reached: "达到切片配额" };
  const sentiments = { positive: "正面", negative: "负面", mixed: "褒贬混合", neutral: "中性", unknown: "未知" };
  const progress = data.analysis_progress;
  const compact = progress?.format === "compact-v2";
  const topicKeySets = new Map(data.stats.topics.map((t) => [t.id, new Set(t.review_keys)]));
  const evidenceMap = new Map();
  for (const topic of data.stats.topics) for (const e of topic.evidence) {
    if (!evidenceMap.has(e.review_key)) evidenceMap.set(e.review_key, []);
    evidenceMap.get(e.review_key).push({ ...e, label: topic.label });
  }
  let scope = ""; let page = 0; let focusKeys = null; let focusTitle = "";
  const pageSize = 50;
  el("scope").innerHTML = '<option value="">全部 ASIN</option>' + data.stats.by_asin.map((r) => `<option value="${esc(r.asin)}">${esc(r.asin)}</option>`).join("");
  el("topic").innerHTML = '<option value="">全部主题</option>' + data.stats.topics.map((t) => `<option value="${esc(t.id)}">${esc(kindLabels[t.kind])} · ${esc(t.label)}</option>`).join("");
  el("meta").textContent = `${data.marketplace} 站点 · ${data.stats.by_asin.length} 个 ASIN · 生成于 ${data.generated_at.replace("T", " ").replace(/(?:\.\d+)?Z$/, " UTC")}`;
  el("footer").textContent = `SellerSpace 评论分析 · ${data.run_id} · 独立采集预算：每个 ASIN ${data.settings.timeout_ms / 60000} 分钟`;
  const currentRows = () => scope ? data.reviews.filter((r) => r.requested_asin === scope) : data.reviews;
  function topicStats(t) {
    if (scope) return t.by_asin[scope] ?? { count: 0, denominator: 0 };
    return { count: t.count, positive: t.positive, negative: t.negative, denominator: data.stats.unique_analyzed_count };
  }
  function topicPanels() {
    for (const kind of ["praise", "pain", "motivation", "scenario", "need"]) {
      const metric = kind === "pain" ? "negative" : kind === "praise" ? "positive" : "count";
      const label = kind === "pain" ? "负面反馈" : kind === "praise" ? "正面反馈" : "主题提及";
      const list = data.stats.topics.filter((t) => t.kind === kind && topicStats(t)[metric]).sort((a, b) => topicStats(b)[metric] - topicStats(a)[metric]);
      el(kind).innerHTML = list.length ? list.map((t) => {
        const s = topicStats(t);
        return `<button class="topic" data-topic="${esc(t.id)}"><div class="topic-head"><span><strong>${esc(t.label)}</strong><br><span class="small muted">${esc(domainLabels[t.domain])} · ${label}</span></span><span class="small">${number(s[metric])} / ${number(s.denominator)}<br><span class="muted">${pct(s[metric], s.denominator)}</span></span></div><div class="track"><div class="fill ${kind}" style="width:${s.denominator ? Math.min(100, 100 * s[metric] / s.denominator) : 0}%"></div></div><div class="small muted">全部提及 ${s.count} · 正面 ${s.positive ?? 0} · 负面 ${s.negative ?? 0}</div></button>`;
      }).join("") : empty();
    }
  }
  function findingCard(f, index) {
    const evidence = new Set(f.evidence_keys);
    const count = new Set(data.reviews.filter((r) => evidence.has(r.key)).map((r) => `${r.marketplace}:${r.review_id}`)).size;
    return `<article class="card finding"><div><span class="priority">${esc(f.priority)}</span> <span class="tag">${esc(sectionLabels[f.section])}</span></div><h3>${esc(f.title)}</h3><div class="body"><p>${esc(f.recommendation)}</p><p class="small muted">验证方式：${esc(f.validation)}</p>${f.caveat ? `<p class="small muted">待核验：${esc(f.caveat)}</p>` : ""}<p class="small muted">${f.asins.map(esc).join(" · ")}</p></div><button class="evidence-button" data-finding="${index}">查看 ${count} 条所引证据 →</button></article>`;
  }
  function renderOverview() {
    const rows = currentRows();
    const selected = scope ? data.stats.by_asin.filter((r) => r.asin === scope) : data.stats.by_asin;
    const analyzed = selected.reduce((sum, r) => sum + r.analyzed, 0);
    const tasks = scope ? data.tasks.filter((t) => t.asin === scope) : data.tasks;
    const gaps = tasks.filter((t) => !t.reliable).length;
    el("stats").innerHTML = [["采集评论记录", rows.length], [compact ? "完成轻量标注的记录" : "完成分析的记录", analyzed], ["已识别主题", data.stats.topics.filter((t) => topicStats(t).count).length], ["存在覆盖缺口的 ASIN", gaps]].map(([label, value]) => `<div class="card"><div class="stat-label">${label}</div><div class="stat-number">${number(value)}</div></div>`).join("");
    const globalAnalyzed = data.stats.analyzed_count;
    const globalCollected = data.stats.collected_count;
    const reviewStage = !progress?.label_complete ? "等待全量标注完成" : `${number(progress.reviewed_evidence)} / ${number(progress.total_evidence)} 项 · ${progress.insights_complete ? "已完成" : "进行中"}`;
    el("analysis-progress").innerHTML = compact
      ? `<h3>分析进度 <span class="small muted">本次运行 · 不随 ASIN 筛选变化</span></h3><div class="grid three"><div><strong>全量轻量标注</strong><p>${number(globalAnalyzed)} / ${number(globalCollected)} 条记录 · ${progress.label_complete ? "已完成" : "进行中"}</p></div><div><strong>重点证据复核</strong><p>${reviewStage}</p></div><div><strong>缓存复用</strong><p>${number(progress.cache_reused ?? 0)} 条记录</p></div></div><p class="small muted">普通证据保留主题与原文；重点证据附中文解释。缓存复用已有标注，不代表跳过本次重点复核。</p>`
      : `<h3>分析进度</h3><p>已完成 ${number(globalAnalyzed)} / ${number(globalCollected)} 条评论记录的分段分析。</p>`;
    el("banner").innerHTML = (data.example ? '<div class="notice draft"><strong>示例报告 · 模拟数据</strong> · 所有评论和建议仅用于展示交互，不可用于经营判断。</div>' : "")
      + (data.draft ? `<div class="notice draft"><strong>分析草稿</strong> · 尚未发布最终报告；采集数量包含未分析记录，主题统计只包括完成整条${compact ? "轻量标注" : "分段分析"}的评论。${compact ? "轻量标注、重点复核和最终结论为不同阶段。" : ""}</div>` : "")
      + (gaps || data.interrupted ? `<div class="notice">本次为部分可见样本，${gaps} 个 ASIN 存在采集覆盖缺口${data.interrupted ? "，运行曾中断" : ""}。主题占比仅描述本次样本，不代表商品真实差评率。</div>` : '<div class="notice">本次已耗尽请求切片的可见评论；这不代表取得 Amazon 全部历史评论。主题占比仅描述本次样本。</div>');
    const currentFindings = data.findings.map((f, i) => ({ f, i })).filter(({ f }) => !scope || f.asins.includes(scope));
    for (const [id, predicate] of [["summary", (f) => f.section === "summary"], ["findings", (f) => !["summary", "comparison"].includes(f.section)], ["comparison-findings", (f) => f.section === "comparison"]]) {
      const items = currentFindings.filter(({ f }) => predicate(f)).sort((a, b) => a.f.priority.localeCompare(b.f.priority));
      el(id).innerHTML = items.length ? items.map(({ f, i }) => findingCard(f, i)).join("") : empty(data.draft ? "结论尚未生成；当前可查看已标注主题和原始证据。" : undefined);
    }
    el("coverage").innerHTML = '<table><thead><tr><th>ASIN</th><th>评论数</th><th>1 / 2 / 3 / 4 / 5 / 未知星</th><th>采集状态</th><th>实际切片</th></tr></thead><tbody>' + tasks.map((t) => {
      const r = data.stats.by_asin.find((v) => v.asin === t.asin);
      return `<tr><td>${esc(t.asin)}</td><td>${r?.collected ?? 0}</td><td>${[1, 2, 3, 4, 5, "unknown"].map((s) => r?.stars[s] ?? 0).join(" / ")}</td><td>${esc(t.status === "completed" ? stops[t.coverage?.stopReason] ?? t.coverage?.stopReason : t.status === "skipped" ? "未执行 / 中断" : "失败")}<br><span class="small muted">${esc(t.error?.message ?? "")}</span></td><td class="small">${(t.slices ?? []).map((s) => `${esc(s.star)}：${esc(stops[s.stopReason] ?? s.stopReason)}${s.filterApplied ? "" : "（筛选未生效）"}`).join("<br>") || "未取得切片"}</td></tr>`;
    }).join("") + "</tbody></table>";
    topicPanels();
  }
  function renderComparison() {
    const asins = data.stats.by_asin;
    el("overlap").innerHTML = data.stats.shared_reviews.length ? `<div class="notice" style="margin:0 0 15px">${data.stats.shared_reviews.length} 条 reviewId 被多个 ASIN 共享，可能来自变体。跨 ASIN 汇总已去重；这些样本不能作为彼此独立的竞品证据。</div>` : "";
    if (asins.length < 2) { el("matrix").innerHTML = empty("本次只有一个 ASIN，无需横向比较。"); return; }
    if (!data.stats.topics.length) { el("matrix").innerHTML = empty(); return; }
    el("matrix").innerHTML = '<table class="matrix"><thead><tr><th>反馈主题</th>' + asins.map((r) => `<th>${esc(r.asin)}<br><span class="small muted">已分析 ${r.analyzed} 条</span></th>`).join("") + "</tr></thead><tbody>" + data.stats.topics.map((t) => `<tr><td><span class="tag">${esc(kindLabels[t.kind])}</span>${esc(t.label)}</td>${asins.map((r) => { const s = t.by_asin[r.asin]; return `<td>${s.count ? `<button data-topic="${esc(t.id)}" data-asin="${esc(r.asin)}">${s.count} / ${s.denominator}<br>${pct(s.count, s.denominator)}</button>` : `<span class="small muted">${s.denominator ? "样本未发现" : "无已分析样本"}</span>`}</td>`; }).join("")}</tr>`).join("") + "</tbody></table>";
  }
  function filteredReviews() {
    const term = el("search").value.trim().toLowerCase(); const star = el("star").value; const topic = el("topic").value;
    return currentRows().filter((r) => (!focusKeys || focusKeys.has(r.key)) && (!star || String(r.rating ?? "unknown") === star)
      && (!topic || topicKeySets.get(topic)?.has(r.key))
      && (!term || `${r.title}\n${r.content}\n${r.review_id}\n${r.requested_asin}`.toLowerCase().includes(term)));
  }
  function renderReviews() {
    const rows = filteredReviews(); const pages = Math.max(1, Math.ceil(rows.length / pageSize)); page = Math.min(page, pages - 1);
    el("evidence-count").textContent = `符合筛选 ${number(rows.length)} 条 · 每页最多 ${pageSize} 条`;
    el("evidence-focus").textContent = focusKeys ? `当前仅查看「${focusTitle}」引用的评论；上方结论基于${data.draft ? "当前已分析" : "完整分析"}样本。` : "下方筛选只影响证据列表，不重新生成上方结论。";
    el("reviews").innerHTML = rows.slice(page * pageSize, (page + 1) * pageSize).map((r) => {
      const analysis = data.stats.review_analysis[r.key];
      const evidence = (evidenceMap.get(r.key) ?? []).filter((e) => !el("topic").value || e.topic_id === el("topic").value);
      let url = ""; try { if (new URL(r.source_url).protocol === "https:") url = r.source_url; } catch { /* omit malformed source */ }
      const interpretation = evidence.map((e) => `<div class="interpretation"><strong>${esc(e.label)}</strong>${e.interpretation?.trim() ? `${compact ? ' <span class="tag">重点复核</span>' : ""}<p>${esc(e.interpretation)}</p>` : ""}<div class="quote">${esc(e.quote)}</div></div>`).join("");
      const assessment = (data.review_assessments?.[r.key] ?? []).map((text) => `<div class="interpretation"><strong>不确定项复核</strong><p>${esc(text)}</p></div>`).join("");
      return `<article class="review"><div class="review-top"><div><span class="tag">${esc(r.requested_asin)}</span><span class="tag ${r.rating && r.rating <= 3 ? "bad" : ""}">${r.rating ?? "未知"} 星</span><span class="tag">${analysis ? esc(sentiments[analysis.sentiment]) : compact ? "未完成轻量标注" : "未完成分析"}</span>${r.verified_purchase === true ? '<span class="tag good">认证购买</span>' : ""}</div>${url ? `<a class="small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Amazon 原文 ↗</a>` : ""}</div><h3>${esc(r.title || "无标题")}</h3><p class="small muted">${esc(r.review_id)} · ${esc(r.review_date || "日期未知")}${r.review_asin ? ` · 评论变体 ${esc(r.review_asin)}` : ""}</p><p class="body">${esc(r.content.slice(0, 600) || "无正文")}</p>${r.content.length > 600 ? `<details><summary>展开完整正文（${number(r.content.length)} 字符）</summary><div class="body">${esc(r.content)}</div></details>` : ""}${interpretation}${assessment}</article>`;
    }).join("") || empty("没有符合当前筛选的评论。");
    el("page-info").textContent = `第 ${page + 1} / ${pages} 页`;
    el("previous").disabled = page === 0; el("next").disabled = page + 1 >= pages;
  }
  function resetEvidence() { page = 0; focusKeys = null; focusTitle = ""; el("search").value = ""; el("star").value = ""; el("topic").value = ""; }
  el("scope").addEventListener("change", () => { scope = el("scope").value; resetEvidence(); renderOverview(); renderReviews(); });
  for (const id of ["star", "topic"]) el(id).addEventListener("change", () => { page = 0; renderReviews(); });
  let searchTimer;
  el("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 0; renderReviews(); }, 150); });
  el("clear").addEventListener("click", () => { resetEvidence(); renderReviews(); });
  el("previous").addEventListener("click", () => { if (page > 0) page--; renderReviews(); });
  el("next").addEventListener("click", () => { page++; renderReviews(); });
  el("print").addEventListener("click", () => window.print());
  document.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-topic], [data-finding]"); if (!target) return;
    resetEvidence();
    if (target.dataset.topic) {
      if (target.dataset.asin) { scope = target.dataset.asin; el("scope").value = scope; renderOverview(); }
      el("topic").value = target.dataset.topic;
    } else {
      const finding = data.findings[Number(target.dataset.finding)];
      if (scope && finding.asins.length > 1) { scope = ""; el("scope").value = ""; renderOverview(); }
      focusKeys = new Set(finding.evidence_keys); focusTitle = finding.title;
    }
    renderReviews(); el("evidence").scrollIntoView({ block: "start" });
  });
  renderOverview(); renderComparison(); renderReviews();
}
