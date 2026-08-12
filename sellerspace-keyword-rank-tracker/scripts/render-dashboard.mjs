const SELLERSPACE_LOGO_URL = "https://o.sellerspace.com/image/www/zh/logo.png";
const TAILWIND_CDN_URL = "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4";
const ECHARTS_CDN_URL = "https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js";
const REMIX_ICON_CDN_URL = "https://cdn.jsdelivr.net/npm/remixicon@4.6.0/fonts/remixicon.css";

export function renderDashboardHtml({
  project,
  asin,
  rows,
  targetHistoryHref,
  latestRawHref,
}) {
  const safeData = JSON.stringify(rows)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const title = `${asin} 关键词排名趋势`;
  const rawLink = latestRawHref
    ? `<a class="download-link" href="${escapeHtml(latestRawHref)}" download><i class="ri-file-list-3-line" aria-hidden="true"></i><span>本次全量 ASIN</span></a>`
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="preconnect" href="https://o.sellerspace.com" crossorigin>
  <link rel="stylesheet" href="${REMIX_ICON_CDN_URL}">
  <script src="${TAILWIND_CDN_URL}"></script>
  <script src="${ECHARTS_CDN_URL}"></script>
  <style>
    :root {
      color-scheme: light;
      --page: #f7f7fc;
      --surface: #ffffff;
      --ink: #111827;
      --muted: #667085;
      --soft: #98a2b3;
      --line: #e4e7ec;
      --line-strong: #d0d5dd;
      --brand: #776ff6;
      --brand-deep: #5b54d6;
      --brand-soft: #f0efff;
      --brand-border: #b9b5ff;
      --orange: #f26a21;
      --orange-soft: #fff4ed;
      --green: #159455;
      --green-soft: #ecfdf3;
      --red: #d92d20;
      --red-soft: #fef3f2;
      --amber: #dc6803;
      --amber-soft: #fffaeb;
      --shadow: 0 1px 2px rgba(16, 24, 40, .04), 0 10px 30px rgba(16, 24, 40, .05);
    }
    * { box-sizing: border-box; }
    html { background: var(--page); }
    body {
      margin: 0;
      background: var(--page);
      color: var(--ink);
      font: 14px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    button, input { font: inherit; }
    button { color: inherit; }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .report-shell { min-height: 100vh; padding: 22px 24px 40px; }
    .app-header {
      display: flex;
      align-items: center;
      min-height: 56px;
      margin-bottom: 18px;
      gap: 18px;
    }
    .brand-lockup { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .brand-logo { display: block; width: 132px; height: auto; object-fit: contain; }
    .brand-divider { width: 1px; height: 30px; background: #c9ced8; }
    .report-name { color: #344054; font-size: 16px; font-weight: 700; white-space: nowrap; }
    .identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .asin { color: #172034; font-size: 19px; font-weight: 750; letter-spacing: .2px; }
    .market-badge, .ranking-badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 3px 9px;
      border-radius: 7px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .market-badge, .ranking-badge { background: var(--brand-soft); color: var(--brand-deep); }
    .top-meta {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 18px;
      color: #667085;
      font-size: 12px;
      white-space: nowrap;
    }
    .download-links { display: flex; align-items: center; gap: 8px; }
    .download-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 34px;
      padding: 6px 10px;
      border: 1px solid #d7deec;
      border-radius: 8px;
      background: #fff;
      color: var(--brand-deep);
      font-weight: 700;
      text-decoration: none;
      transition: border-color .15s ease, background-color .15s ease;
    }
    .download-link:hover { border-color: var(--brand-border); background: #faf9ff; }
    .cdn-alert {
      display: none;
      margin: -4px 0 14px;
      padding: 10px 13px;
      border: 1px solid #fedf89;
      border-radius: 9px;
      background: var(--amber-soft);
      color: #93370d;
      font-size: 13px;
    }
    .cdn-alert.visible { display: block; }
    .dashboard-grid {
      display: grid;
      grid-template-columns: 286px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .sidebar {
      position: sticky;
      top: 18px;
      height: calc(100vh - 38px);
      min-height: 640px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sidebar-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 50px;
      padding: 0 16px;
      background: var(--brand-deep);
      color: #fff;
    }
    .sidebar-title { font-size: 16px; font-weight: 750; }
    .sidebar-head i { color: #d9d6ff; font-size: 19px; }
    .search-wrap { padding: 14px; border-bottom: 1px solid var(--line); }
    .search-box { position: relative; }
    .search-box i {
      position: absolute;
      top: 50%;
      left: 11px;
      color: #98a2b3;
      font-size: 17px;
      transform: translateY(-50%);
      pointer-events: none;
    }
    .search-box input {
      width: 100%;
      height: 38px;
      padding: 0 11px 0 35px;
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      outline: none;
      background: #fff;
      color: var(--ink);
    }
    .search-box input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(119, 111, 246, .14); }
    .keyword-head, .keyword-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 62px 68px 14px;
      gap: 8px;
    }
    .keyword-head {
      padding: 11px 13px 9px;
      border-bottom: 1px solid var(--line);
      color: #667085;
      font-size: 11px;
      font-weight: 750;
      letter-spacing: .02em;
    }
    .keyword-list { flex: 1; overflow: auto; }
    .keyword-item {
      position: relative;
      width: 100%;
      align-items: center;
      padding: 14px 12px;
      border: 0;
      border-bottom: 1px solid #eef0f4;
      background: #fff;
      text-align: left;
      cursor: pointer;
    }
    .keyword-item:hover { background: #fafbff; }
    .keyword-item[aria-current="true"] { background: var(--brand-soft); }
    .keyword-item[aria-current="true"]::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 3px;
      background: var(--brand);
    }
    .keyword-item .ri-arrow-right-s-line { color: #98a2b3; font-size: 16px; }
    .keyword-name { min-width: 0; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
    .rank-cell {
      display: flex;
      align-items: baseline;
      gap: 4px;
      color: #344054;
      font-variant-numeric: tabular-nums;
      font-weight: 750;
    }
    .status-cell { min-width: 0; color: #475467; font-size: 11px; }
    .status-inline { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
    .status-inline > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--soft); flex: none; }
    .status-dot.ok { background: var(--green); }
    .status-dot.not_found, .status-dot.not_executed { background: #98a2b3; }
    .status-dot.blocked { background: var(--amber); }
    .status-dot.failed { background: var(--red); }
    .sidebar-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 46px;
      padding: 0 14px;
      border-top: 1px solid var(--line);
      color: #667085;
      background: #fff;
      font-size: 12px;
    }
    .workspace { min-width: 0; display: grid; gap: 14px; }
    .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); padding: 12px 8px; }
    .summary-item { position: relative; padding: 2px 20px; border-right: 1px solid var(--line); }
    .summary-item:last-child { border-right: 0; }
    .summary-kicker { display: flex; align-items: center; gap: 8px; color: #475467; font-size: 12px; font-weight: 700; }
    .summary-icon {
      display: inline-grid;
      width: 25px;
      height: 25px;
      place-items: center;
      border-radius: 7px;
      background: #f2f4f7;
      color: #667085;
      font-size: 15px;
    }
    .summary-icon.ok { background: var(--green-soft); color: var(--green); }
    .summary-icon.not_found, .summary-icon.not_executed { background: #f2f4f7; color: #667085; }
    .summary-icon.blocked { background: var(--amber-soft); color: var(--amber); }
    .summary-icon.failed { background: var(--red-soft); color: var(--red); }
    .summary-value { margin-top: 4px; font-size: 27px; line-height: 1.1; font-weight: 780; font-variant-numeric: tabular-nums; }
    .summary-compare { margin-top: 4px; color: #98a2b3; font-size: 11px; }
    .analysis { padding: 18px 20px 15px; }
    .analysis-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 13px; }
    .analysis-title { margin: 0; font-size: 20px; line-height: 1.3; letter-spacing: -.2px; }
    .analysis-subtitle { margin-top: 3px; color: #98a2b3; font-size: 12px; }
    .latest-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 4px 9px;
      border-radius: 7px;
      background: var(--green-soft);
      color: #087443;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .metrics {
      display: grid;
      grid-template-columns: minmax(180px, .9fr) minmax(180px, .9fr) minmax(310px, 1.35fr);
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fbfcfe;
      overflow: hidden;
    }
    .rank-metric { padding: 18px 22px; border-right: 1px solid var(--line); }
    .metric-label { display: flex; align-items: center; gap: 8px; color: #475467; font-size: 12px; font-weight: 700; }
    .series-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); flex: none; }
    .series-dot.ad { background: var(--orange); }
    .metric-main { display: flex; align-items: baseline; gap: 12px; margin-top: 7px; }
    .metric-value { font-size: 48px; line-height: 1; font-weight: 760; letter-spacing: -1.5px; font-variant-numeric: tabular-nums; }
    .metric-previous { margin-top: 6px; color: #98a2b3; font-size: 12px; }
    .details { padding: 10px 20px; display: grid; align-content: center; }
    .detail-row { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
    .detail-row:last-child { border-bottom: 0; }
    .detail-label { color: #667085; font-size: 12px; font-weight: 650; }
    .detail-value { min-width: 0; color: #344054; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .chart-block { margin-top: 14px; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    .chart-toolbar { display: flex; align-items: center; gap: 18px; min-height: 48px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
    .legend { display: flex; align-items: center; gap: 18px; color: #475467; }
    .legend-item { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700; }
    .legend-line { width: 22px; height: 3px; border-radius: 2px; background: var(--brand); }
    .legend-line.ad { background: var(--orange); }
    .range-controls { margin-left: auto; display: flex; border: 1px solid #d0d5dd; border-radius: 8px; overflow: hidden; }
    .range-button { min-width: 54px; height: 31px; padding: 0 11px; border: 0; border-right: 1px solid #d0d5dd; background: #fff; color: #667085; cursor: pointer; }
    .range-button:last-child { border-right: 0; }
    .range-button:hover { background: #f8faff; }
    .range-button[aria-pressed="true"] { background: var(--brand-soft); color: var(--brand-deep); font-weight: 750; box-shadow: inset 0 0 0 1px var(--brand-border); }
    .chart-wrap { position: relative; height: 330px; background: #fff; }
    #rankChart { width: 100%; height: 100%; }
    .empty-chart { position: absolute; inset: 0; display: grid; place-items: center; color: #98a2b3; font-size: 13px; pointer-events: none; }
    .empty-chart[hidden] { display: none; }
    .history { padding-top: 16px; }
    .history-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
    .history-title { display: flex; align-items: baseline; gap: 7px; margin: 0; font-size: 15px; }
    .history-title span { color: #98a2b3; font-size: 11px; font-weight: 500; }
    .history-caption { color: #98a2b3; font-size: 11px; }
    .table-wrap { overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
    th { color: #667085; background: #fbfcfe; font-size: 11px; font-weight: 750; }
    td { color: #475467; font-size: 12px; }
    tbody tr:hover { background: #fafbff; }
    .history-note { margin-top: 9px; color: #98a2b3; font-size: 11px; }
    .delta { font-size: 12px; font-weight: 750; }
    .delta.good { color: var(--green); }
    .delta.bad { color: var(--red); }
    .delta.muted { color: #98a2b3; }
    .natural-text { color: var(--brand-deep); }
    .ad-text { color: var(--orange); }
    @media (max-width: 1120px) {
      .report-shell { padding: 18px 14px 30px; }
      .app-header { flex-wrap: wrap; gap: 12px; }
      .top-meta { width: 100%; margin-left: 0; justify-content: space-between; }
      .dashboard-grid { grid-template-columns: 246px minmax(0, 1fr); gap: 14px; }
      .summary-item { padding: 2px 11px; }
      .metrics { grid-template-columns: 1fr 1fr; }
      .rank-metric:nth-child(2) { border-right: 0; }
      .details { grid-column: 1 / -1; border-top: 1px solid var(--line); }
    }
    @media (max-width: 820px) {
      .report-shell { padding: 12px 10px 24px; }
      .app-header { align-items: flex-start; }
      .brand-lockup { width: 100%; }
      .brand-logo { width: 118px; }
      .report-name { font-size: 14px; }
      .identity { width: 100%; flex-wrap: wrap; }
      .top-meta { align-items: flex-start; flex-direction: column; gap: 9px; }
      .download-links { flex-wrap: wrap; }
      .dashboard-grid { display: block; }
      .sidebar { position: static; height: auto; min-height: 0; margin-bottom: 12px; }
      .keyword-list { max-height: 330px; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .summary-item { padding: 12px 14px; border-right: 0; border-bottom: 1px solid var(--line); }
      .summary-item:nth-child(odd) { border-right: 1px solid var(--line); }
      .summary-item:last-child { grid-column: 1 / -1; border: 0; }
      .analysis { padding: 14px 12px; }
      .analysis-heading { align-items: flex-start; flex-direction: column; }
      .metrics { display: block; }
      .rank-metric { border-right: 0; border-bottom: 1px solid var(--line); }
      .details { border-top: 0; }
      .metric-value { font-size: 42px; }
      .chart-toolbar { align-items: flex-start; flex-direction: column; gap: 9px; }
      .range-controls { margin-left: 0; }
      .chart-wrap { height: 300px; }
      .history-heading { align-items: flex-start; flex-direction: column; gap: 2px; }
    }
    @media print {
      html, body { background: #fff; }
      .report-shell { padding: 0; }
      .sidebar { position: static; height: auto; min-height: 0; }
      .search-wrap, .range-controls { display: none; }
      .dashboard-grid { grid-template-columns: 230px minmax(0, 1fr); }
      .card { box-shadow: none; }
    }
  </style>
</head>
<body>
<main class="report-shell mx-auto w-full max-w-[1800px]">
  <header class="app-header">
    <div class="brand-lockup">
      <a href="https://www.sellerspace.com/" target="_blank" rel="noreferrer" aria-label="访问优麦云官网"><img class="brand-logo" src="${SELLERSPACE_LOGO_URL}" alt="优麦云 SellerSpace"></a>
      <div class="brand-divider" aria-hidden="true"></div>
      <div class="report-name">关键词排名驾驶舱</div>
    </div>
    <div class="identity">
      <span class="asin">${escapeHtml(asin)}</span>
      <span class="market-badge">${escapeHtml(project.marketplace)}</span>
      <span class="ranking-badge"><i class="ri-arrow-up-line" aria-hidden="true"></i>排名越小越好</span>
    </div>
    <div class="top-meta">
      <span id="updatedAt"></span>
      <nav class="download-links" aria-label="报告下载">
        <a class="download-link" href="${escapeHtml(targetHistoryHref)}" download><i class="ri-download-line" aria-hidden="true"></i><span>排名历史</span></a>
        ${rawLink}
      </nav>
    </div>
  </header>
  <div class="cdn-alert" id="dependencyAlert" role="alert"><i class="ri-wifi-off-line" aria-hidden="true"></i> 图表或样式 CDN 加载失败。数据仍可查看，请联网后刷新以恢复完整图表。</div>
  <div class="dashboard-grid">
    <aside class="sidebar card" aria-label="关键词总览">
      <div class="sidebar-head"><span class="sidebar-title">关键词总览</span><i class="ri-list-check-3" aria-hidden="true"></i></div>
      <div class="search-wrap">
        <label class="search-box"><span class="sr-only">搜索关键词</span><i class="ri-search-line" aria-hidden="true"></i><input id="keywordSearch" type="search" placeholder="搜索关键词" autocomplete="off"></label>
      </div>
      <div class="keyword-head"><span>关键词</span><span>自然排名</span><span>状态</span><span></span></div>
      <div class="keyword-list" id="keywordList"></div>
      <div class="sidebar-foot"><span id="keywordCount"></span><span>点击查看趋势</span></div>
    </aside>
    <section class="workspace" aria-live="polite">
      <div class="summary card" id="summary"></div>
      <article class="analysis card">
        <div class="analysis-heading">
          <div><h1 class="analysis-title" id="selectedKeyword"></h1><div class="analysis-subtitle">目标 ASIN 在该关键词下的自然位与广告位</div></div>
          <span class="latest-chip"><i class="ri-pulse-line" aria-hidden="true"></i>最新数据</span>
        </div>
        <div class="metrics">
          <section class="rank-metric">
            <div class="metric-label"><i class="series-dot" aria-hidden="true"></i>自然排名</div>
            <div class="metric-main"><strong class="metric-value natural-text" id="naturalRank"></strong><span id="naturalDelta"></span></div>
            <div class="metric-previous" id="naturalPrevious"></div>
          </section>
          <section class="rank-metric">
            <div class="metric-label"><i class="series-dot ad" aria-hidden="true"></i>广告位置</div>
            <div class="metric-main"><strong class="metric-value ad-text" id="adRank"></strong><span id="adDelta"></span></div>
            <div class="metric-previous" id="adPrevious"></div>
          </section>
          <section class="details">
            <div class="detail-row"><span class="detail-label">广告类型</span><span class="detail-value" id="adTypes"></span></div>
            <div class="detail-row"><span class="detail-label">状态</span><span class="detail-value" id="selectedStatus"></span></div>
            <div class="detail-row"><span class="detail-label">最新采集时间</span><span class="detail-value" id="selectedTime"></span></div>
            <div class="detail-row"><span class="detail-label">关键词</span><span class="detail-value" id="selectedKeywordDetail"></span></div>
          </section>
        </div>
        <section class="chart-block" aria-labelledby="selectedKeyword">
          <div class="chart-toolbar">
            <div class="legend"><span class="legend-item"><i class="legend-line" aria-hidden="true"></i>自然排名</span><span class="legend-item"><i class="legend-line ad" aria-hidden="true"></i>广告位置</span></div>
            <div class="range-controls" aria-label="趋势时间范围"><button class="range-button" type="button" data-days="0" aria-pressed="true">全部</button><button class="range-button" type="button" data-days="14" aria-pressed="false">14 天</button><button class="range-button" type="button" data-days="7" aria-pressed="false">7 天</button></div>
          </div>
          <div class="chart-wrap"><div id="rankChart" role="img" aria-label="关键词自然排名与广告位置趋势图"></div><div class="empty-chart" id="emptyChart" hidden>该关键词暂无可绘制排名</div></div>
        </section>
        <section class="history">
          <div class="history-heading"><h2 class="history-title">最新结果 <span id="historyCount"></span></h2><span class="history-caption">空值不会连线，避免形成虚假趋势</span></div>
          <div class="table-wrap"><table><thead><tr><th>采集时间</th><th>状态</th><th>自然排名</th><th>自然变化</th><th>广告位置</th><th>广告变化</th><th>广告类型</th></tr></thead><tbody id="historyRows"></tbody></table></div>
          <div class="history-note">说明：排名越小越好；“—”表示未采集到排名。</div>
        </section>
      </article>
    </section>
  </div>
</main>
<script>
const history=${safeData};
const byKeyword=new Map();
for(const row of history){if(!byKeyword.has(row.keyword))byKeyword.set(row.keyword,[]);byKeyword.get(row.keyword).push(row)}
for(const values of byKeyword.values())values.sort((a,b)=>String(a.collected_at).localeCompare(String(b.collected_at)));
const runTimes=new Map();for(const row of history){const time=Date.parse(row.collected_at)||0;runTimes.set(row.run_id,Math.max(time,runTimes.get(row.run_id)||0))}
const sortedRuns=[...runTimes.entries()].sort((a,b)=>b[1]-a[1]);
const latestRun=sortedRuns[0]?.[0];
const previousRun=sortedRuns[1]?.[0];
const latestRows=history.filter(row=>row.run_id===latestRun);
const number=value=>value===""||value==null||!Number.isFinite(Number(value))?null:Number(value);
const rankText=value=>number(value)==null?"—":String(number(value));
const deltaFor=(values,field)=>{const latest=values.at(-1);const current=number(latest?.[field]);if(current==null)return null;for(let index=values.length-2;index>=0;index--){const previous=number(values[index][field]);if(previous!=null)return previous-current}return null};
const previousFor=(values,field)=>{for(let index=values.length-2;index>=0;index--){const value=number(values[index][field]);if(value!=null)return value}return null};
const deltaText=value=>value==null?"—":value===0?"持平":value>0?"↑ "+value:"↓ "+Math.abs(value);
const deltaClass=value=>value==null||value===0?"muted":value>0?"good":"bad";
const latestByKeyword=[...byKeyword.entries()].map(([keyword,values])=>({keyword,values,latest:values.at(-1),naturalDelta:deltaFor(values,"natural_rank"),adDelta:deltaFor(values,"best_ad_position")}));
const statusLabels={ok:"成功",not_found:"未找到",blocked:"页面阻断",failed:"失败",not_executed:"未执行"};
const statusIcons={ok:"ri-checkbox-circle-line",not_found:"ri-question-line",blocked:"ri-shield-keyhole-line",failed:"ri-error-warning-line",not_executed:"ri-time-line"};
const countStatuses=rows=>{const counts={ok:0,not_found:0,blocked:0,failed:0,not_executed:0};for(const row of rows)counts[row.status]=(counts[row.status]||0)+1;return counts};
const statusCounts=countStatuses(latestRows);
const previousCounts=countStatuses(history.filter(row=>row.run_id===previousRun));
const summaryData=["ok","not_found","blocked","failed","not_executed"];
document.getElementById("summary").replaceChildren(...summaryData.map(key=>{const item=document.createElement("div");item.className="summary-item";const kicker=document.createElement("div");kicker.className="summary-kicker";const icon=document.createElement("i");icon.className="summary-icon "+key+" "+statusIcons[key];icon.setAttribute("aria-hidden","true");const label=document.createElement("span");label.textContent=statusLabels[key];kicker.append(icon,label);const value=document.createElement("div");value.className="summary-value";value.textContent=statusCounts[key]||0;const compare=document.createElement("div");compare.className="summary-compare";const difference=(statusCounts[key]||0)-(previousCounts[key]||0);compare.textContent=previousRun?"较上次 "+(difference===0?"0":difference>0?"+"+difference:String(difference)):"首次运行";item.append(kicker,value,compare);return item}));
const latestTimestamp=Math.max(0,...latestRows.map(row=>Date.parse(row.collected_at)||0));
document.getElementById("updatedAt").textContent="最后更新："+(latestTimestamp?new Date(latestTimestamp).toLocaleString():"—");
let selectedKeyword=latestByKeyword.find(item=>number(item.latest.natural_rank)!=null&&number(item.latest.best_ad_position)!=null)?.keyword||latestByKeyword[0]?.keyword||"";
let selectedDays=0;
let chartInstance=null;
const keywordList=document.getElementById("keywordList");
const keywordSearch=document.getElementById("keywordSearch");
function statusNode(status){const wrap=document.createElement("span");wrap.className="status-inline";const dot=document.createElement("i");dot.className="status-dot "+status;dot.setAttribute("aria-hidden","true");const text=document.createElement("span");text.textContent=statusLabels[status]||status||"—";wrap.append(dot,text);return wrap}
function renderKeywordList(){const needle=keywordSearch.value.trim().toLocaleLowerCase();const visible=latestByKeyword.filter(item=>item.keyword.toLocaleLowerCase().includes(needle));keywordList.replaceChildren(...visible.map(item=>{const button=document.createElement("button");button.type="button";button.className="keyword-item";button.dataset.keyword=item.keyword;button.setAttribute("aria-current",String(item.keyword===selectedKeyword));const name=document.createElement("span");name.className="keyword-name";name.textContent=item.keyword;const rank=document.createElement("span");rank.className="rank-cell";const rankValue=document.createElement("span");rankValue.textContent=rankText(item.latest.natural_rank);rank.append(rankValue);if(item.naturalDelta!=null&&item.naturalDelta!==0){const change=document.createElement("span");change.className="delta "+deltaClass(item.naturalDelta);change.textContent=item.naturalDelta>0?"↑"+item.naturalDelta:"↓"+Math.abs(item.naturalDelta);rank.append(change)}const status=document.createElement("span");status.className="status-cell";status.append(statusNode(item.latest.status));const arrow=document.createElement("i");arrow.className="ri-arrow-right-s-line";arrow.setAttribute("aria-hidden","true");button.append(name,rank,status,arrow);button.addEventListener("click",()=>{selectedKeyword=item.keyword;renderKeywordList();renderSelected()});return button}));document.getElementById("keywordCount").textContent="共 "+visible.length+" 个关键词"}
keywordSearch.addEventListener("input",renderKeywordList);
function setDelta(id,value){const element=document.getElementById(id);element.textContent=deltaText(value);element.className="delta "+deltaClass(value)}
function filteredValues(values){if(!selectedDays||!values.length)return values;const latest=Math.max(...values.map(row=>Date.parse(row.collected_at)||0));const since=latest-selectedDays*86400000;return values.filter(row=>(Date.parse(row.collected_at)||0)>=since)}
function cell(text,className=""){const element=document.createElement("td");element.textContent=text;element.className=className;return element}
function renderSelected(){const item=latestByKeyword.find(candidate=>candidate.keyword===selectedKeyword);if(!item)return;const latest=item.latest;document.getElementById("selectedKeyword").textContent=item.keyword;document.getElementById("selectedKeywordDetail").textContent=item.keyword;document.getElementById("naturalRank").textContent=rankText(latest.natural_rank);document.getElementById("adRank").textContent=rankText(latest.best_ad_position);setDelta("naturalDelta",item.naturalDelta);setDelta("adDelta",item.adDelta);document.getElementById("naturalPrevious").textContent="上次 "+rankText(previousFor(item.values,"natural_rank"));document.getElementById("adPrevious").textContent="上次 "+rankText(previousFor(item.values,"best_ad_position"));document.getElementById("adTypes").textContent=latest.ad_types||"—";const selectedStatus=document.getElementById("selectedStatus");selectedStatus.replaceChildren(statusNode(latest.status));document.getElementById("selectedTime").textContent=latest.collected_at?new Date(latest.collected_at).toLocaleString():"—";const values=filteredValues(item.values);drawChart(values,item.keyword);renderHistory(values)}
function renderHistory(values){const recent=[...values].reverse().slice(0,8);document.getElementById("historyCount").textContent="(最近 "+recent.length+" 次采集)";const tbody=document.getElementById("historyRows");tbody.replaceChildren(...recent.map((row,index)=>{const chronologicalIndex=values.length-1-index;const priorValues=values.slice(0,chronologicalIndex+1);const naturalDelta=deltaFor(priorValues,"natural_rank");const adDelta=deltaFor(priorValues,"best_ad_position");const tr=document.createElement("tr");const status=document.createElement("td");status.append(statusNode(row.status));tr.append(cell(row.collected_at?new Date(row.collected_at).toLocaleString():"—"),status,cell(rankText(row.natural_rank),"natural-text"),cell(deltaText(naturalDelta),"delta "+deltaClass(naturalDelta)),cell(rankText(row.best_ad_position),"ad-text"),cell(deltaText(adDelta),"delta "+deltaClass(adDelta)),cell(row.ad_types||"—"));return tr}))}
function drawChart(values,keyword){const chartElement=document.getElementById("rankChart");const empty=document.getElementById("emptyChart");chartElement.setAttribute("aria-label",keyword+"自然排名与广告位置趋势图");const ranks=values.flatMap(row=>[number(row.natural_rank),number(row.best_ad_position)]).filter(value=>value!=null);empty.hidden=ranks.length>0;if(!window.echarts){document.getElementById("dependencyAlert").classList.add("visible");return}if(!chartInstance)chartInstance=window.echarts.init(chartElement,null,{renderer:"canvas"});if(!ranks.length){chartInstance.clear();return}const maxRank=Math.max(10,Math.ceil(Math.max(...ranks)/10)*10);const labels=values.map(row=>new Date(row.collected_at).toLocaleDateString());const natural=values.map(row=>number(row.natural_rank));const ads=values.map(row=>number(row.best_ad_position));chartInstance.setOption({animationDuration:450,color:["#776ff6","#f26a21"],grid:{left:46,right:28,top:34,bottom:42,containLabel:false},tooltip:{trigger:"axis",backgroundColor:"rgba(17,24,39,.96)",borderWidth:0,padding:[9,11],textStyle:{color:"#fff",fontSize:12},valueFormatter:value=>value==null?"未采集":"排名 "+value},xAxis:{type:"category",boundaryGap:false,data:labels,axisLine:{lineStyle:{color:"#d0d5dd"}},axisTick:{show:false},axisLabel:{color:"#667085",fontSize:11,hideOverlap:true,margin:14}},yAxis:{type:"value",inverse:true,min:1,max:maxRank,splitNumber:5,axisLine:{show:false},axisTick:{show:false},axisLabel:{color:"#667085",fontSize:11},splitLine:{lineStyle:{color:"#e9edf3",type:"dashed"}}},series:[{name:"自然排名",type:"line",data:natural,connectNulls:false,symbol:"circle",symbolSize:8,showSymbol:true,lineStyle:{width:3,color:"#776ff6"},itemStyle:{color:"#776ff6",borderColor:"#fff",borderWidth:2},label:{show:values.length<=10,position:"bottom",color:"#5b54d6",fontSize:11,fontWeight:700,formatter:params=>params.value==null?"":params.value},emphasis:{focus:"series"}},{name:"广告位置",type:"line",data:ads,connectNulls:false,symbol:"circle",symbolSize:8,showSymbol:true,lineStyle:{width:3,color:"#f26a21"},itemStyle:{color:"#f26a21",borderColor:"#fff",borderWidth:2},label:{show:values.length<=10,position:"top",color:"#d94f0d",fontSize:11,fontWeight:700,formatter:params=>params.value==null?"":params.value},emphasis:{focus:"series"}}]},true)}
for(const button of document.querySelectorAll(".range-button")){button.addEventListener("click",()=>{selectedDays=Number(button.dataset.days)||0;for(const candidate of document.querySelectorAll(".range-button"))candidate.setAttribute("aria-pressed",String(candidate===button));renderSelected()})}
window.addEventListener("resize",()=>chartInstance?.resize());
if(!window.echarts)document.getElementById("dependencyAlert").classList.add("visible");
renderKeywordList();
renderSelected();
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
