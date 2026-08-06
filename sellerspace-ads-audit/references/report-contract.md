# Ads Audit Report Contract

## Contents

- [Renderer](#renderer)
- [Input](#input)
- [Actions](#actions)
- [Coverage](#coverage)
- [Analysis modes](#analysis-modes)
- [Formatting](#formatting)
- [Output](#output)

## Renderer

Run the renderer only after every planned direct API call for the station has succeeded:

```text
node <skill-dir>/scripts/render-ads-audit-report.mjs --output-dir <directory>
```

Pass one JSON object through stdin. Maximum input is 5 MiB. Never include credentials, headers, raw authorization errors, or private configuration paths.

## Input

Use `schemaVersion=2`. New reports use `analysisMode=evidence-driven`; the renderer also accepts the two legacy modes for existing reports.

```json
{
  "schemaVersion": 2,
  "analysisMode": "evidence-driven",
  "generatedAt": "2026-08-05T12:00:00.000Z",
  "executiveSummary": "一句话总结当前风险、机会与覆盖范围。",
  "scope": {
    "sellerId": 123,
    "marketplace": "US",
    "storeName": "Example Store",
    "currency": "USD"
  },
  "period": {
    "label": "近30天",
    "preset": "NM",
    "from": "2026-07-07",
    "to": "2026-08-05"
  },
  "baseline": {
    "source": "user-target | campaign-summary | store-context | unavailable",
    "targetAcos": 0.3,
    "targetRoas": null,
    "accountAcos": 0.35,
    "accountRoas": 2.86,
    "accountCtr": 0.004,
    "accountCvr": 0.1,
    "minClicks": 20
  },
  "ratings": [
    {
      "key": "traffic",
      "label": "流量",
      "status": "red | yellow | green | insufficient",
      "summary": "简短结论",
      "evidence": ["证据一"]
    }
  ],
  "overview": [
    {
      "key": "adSpend",
      "label": "广告花费",
      "value": 120.5,
      "format": "currency | count | ratio | percent | number | string",
      "currency": "USD"
    }
  ],
  "findings": [],
  "sections": [],
  "campaignDrilldowns": [],
  "coverage": {},
  "assumptions": ["账户整体指标仅用于寻找相对异常，不作为达标线。"],
  "limitations": []
}
```

`baseline` is retained as the schema field name for compatibility. Only `source=user-target` with a non-null `targetAcos` or `targetRoas` is a business judgment line. `campaign-summary` and `store-context` are relative account context only and cannot mark efficiency/budget green or trigger `increase-budget`.

Every `sections` entry uses:

```json
{
  "key": "campaign",
  "title": "广告活动",
  "summary": "启用 Campaign 已完整分页；按花费降序展示。",
  "sampledCount": 3,
  "totalCount": 3,
  "columns": [
    {"key": "campaignName", "label": "活动", "format": "string"},
    {"key": "cost", "label": "花费", "format": "currency", "currency": "USD"}
  ],
  "rows": [
    {"campaignName": "Example", "cost": 120.5}
  ]
}
```

`sampledCount` is retained for schema compatibility and must equal `rows.length`; in evidence-driven reports it means fetched unique rows, not a fixed Top-N sample.

Every `campaignDrilldowns` entry uses:

```json
{
  "campaignId": "123",
  "campaignName": "Example Campaign",
  "adType": "SP",
  "status": "enabled",
  "healthStatus": "red | yellow | green | insufficient",
  "summary": "该活动的核心判断。",
  "metrics": [
    {"key": "cost", "label": "花费", "value": 120.5, "format": "currency", "currency": "USD"}
  ],
  "trend": [
    {"date": "2026-08-05", "cost": 12.5, "sales": 35, "acos": 0.357, "orders": 2, "budget": 10, "budgetUtilization": 1.25, "overBudget": true}
  ],
  "placements": [
    {"name": "搜索结果顶部", "cost": 75, "sales": 210, "share": 0.6}
  ],
  "sections": []
}
```

`campaignDrilldowns[].sections` contains the five campaign-filtered child sections: `adGroup`, `productAds`, `keywords`, `targets`, and `searchQuery`. A finding from a child entity includes `campaignId` when available.

## Actions

Every new finding includes structured `action` so the renderer never classifies recommendations by parsing prose:

```json
{
  "priority": "P3",
  "kind": "opportunity",
  "dimension": "structure",
  "campaignId": "123",
  "entityType": "searchQuery",
  "entityId": "query-1",
  "entityName": "wireless socks",
  "title": "高效搜索词尚未单独投放",
  "evidence": [
    {"label": "订单", "value": 5, "format": "count"},
    {"label": "ACoS", "value": 0.18, "format": "ratio"}
  ],
  "reasoning": "样本和效率达到机会门槛，正向投放列表为空。",
  "reasonBullets": [
    "近 30 天获得 5 个广告归因订单，达到观察门槛。",
    "正向 Campaign 与广告组列表均未发现该搜索词。"
  ],
  "caveats": ["未提供业务目标时，只建议单独投放验证，不宣称可盈利扩量。"],
  "recommendation": "建议提取为精准关键词单独投放。",
  "confidence": "high",
  "action": {
    "type": "harvest-search-term | negative-search-term | lower-bid | pause | increase-budget | adjust-placement | review-structure | observe",
    "label": "建议提取为精准关键词",
    "targetLevel": "campaign | adGroup | keyword | target | productAd",
    "coverageStatus": "not-targeted | targeted | already-negative | unknown",
    "existingTargets": [
      {"level": "campaign | adGroup", "id": "456", "name": "Resolved name"}
    ]
  }
}
```

`reasonBullets` is required for evidence-driven reports and must contain at least one concrete reason. Add further reasons only when they are distinct and supported by evidence; never pad the list to reach a fixed count. `caveats` is optional. `action.targetLevel`, `action.coverageStatus`, and `action.existingTargets` are optional. `action` itself is optional only for legacy reports. Recommendation text gives a direction and never contains a calculated bid, budget, percentage, or placement adjustment.

An `increase-budget` finding additionally requires explicit user-target evidence and `dailyEvidence`:

```json
{
  "title": "日花费 vs 预算",
  "observedDays": 30,
  "constrainedDays": 2,
  "basis": "reported-over-budget | historical-budget | current-budget-reference | unavailable",
  "points": [
    {
      "date": "2026-08-05",
      "cost": 12.5,
      "budget": 10,
      "orders": 2,
      "acos": 0.24,
      "overBudget": true
    }
  ]
}
```

For every `dailyEvidence`, `observedDays` must equal `points.length`, and `constrainedDays` must equal the number of points with `overBudget=true`. For `increase-budget`, `basis` must be `reported-over-budget` or `historical-budget`, `constrainedDays` must be at least two, and `points` must be non-empty. A current budget comparison may be displayed as context but cannot create an expansion recommendation.

## Coverage

New evidence-driven reports use:

```json
{
  "operations": ["get_stores", "query_store_performance", "query_ads"],
  "entitySections": ["campaign", "adGroup", "productAds", "keywords", "targets", "searchQuery"],
  "historyCampaignIds": ["123"],
  "placementCampaignIds": ["123"],
  "enabledCampaignCount": 26,
  "fullyDrilledCampaignIds": ["123"],
  "businessCallCount": 37,
  "entities": [
    {
      "key": "campaign",
      "queriedCount": 26,
      "totalCount": 26,
      "spendCoverage": 1,
      "status": "complete | target-reached | unknown"
    }
  ],
  "selectedCampaigns": [
    {
      "campaignId": "123",
      "campaignName": "Example Campaign",
      "reasons": ["P1 高花费无订单"],
      "historyQueried": true,
      "placementQueried": true
    }
  ]
}
```

- `spendCoverage` uses ratio scale and may be `null` only when `status=unknown`.
- `campaign` must be `complete` and include every enabled Campaign.
- Each child entity is `target-reached` at 90% or greater, `complete` when all pages were fetched, or `unknown` when positive summary cost is unavailable.
- For every core entity, the matching top-level section must satisfy `rows.length = sampledCount = coverage.queriedCount` and `section.totalCount = coverage.totalCount`. A mismatch is `INCOMPLETE_REPORT_INPUT`; do not render a contradictory report.
- `businessCallCount` is informational and has no maximum.

## Analysis modes

- `evidence-driven`: top-level `sections` contains all six core entity sections. `campaignDrilldowns`, `fullyDrilledCampaignIds`, and `selectedCampaigns` describe the same evidence-selected Campaign set. DAILY history is required for every selected Campaign. Placement IDs are a subset of selected SP Campaigns where placement evidence was relevant.
- `campaign-drilldown`: accepted for legacy reports. Top-level `sections` contains `campaign`; drilldowns may contain any number of enabled Campaigns. No old three-Campaign or 24-call cap is enforced.
- `portfolio-sample`: accepted for legacy reports. Top-level `sections` contains all six core sections. No old Campaign-count threshold or 13-call cap is enforced.

Require all top-level keys except optional `period.from`, `period.to`, nullable target/account values, optional finding IDs, and optional legacy finding/coverage extensions. Reject unknown schema versions, invalid enums, missing arrays, non-finite numbers, duplicate section keys, duplicate drilldown IDs, non-enabled drilldowns, mismatched evidence-driven selection IDs, inconsistent section/coverage counts, or invalid coverage ratios. Do not impose a business-call, Campaign, trend, placement, metric, or section-row count limit.

## Formatting

- `currency`: format with `Intl.NumberFormat` and the station currency; preserve the numeric value.
- `count`: group integer-like values; do not manufacture decimals.
- `ratio`: display `0.3` as `30%`.
- `percent`: display `30` as `30%`.
- `number`: use a compact locale-aware number.
- `string`: escape and display text.
- `null` or missing display values: show `—`.

Treat every string as untrusted and HTML-escape it. Do not create links from returned business text. The renderer embeds the SellerSpace logo, report data, critical fallback styles, and interaction code. It loads only Tailwind Browser `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4` and ECharts `https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js`. If either CDN is unavailable, the recommendation text, reason bullets, evidence metrics, coverage, and raw tables remain readable; charts show a text fallback. This is a single-file online-enhanced report, not a fully offline report.

The report uses two independent accessible tab groups:

- Action rail grouped as 立即止损、扩量机会、结构整理. Every action panel leads with the direction and then lists “给出这个建议的原因”, metrics, daily/placement support when available, and risks/caveats.
- Bottom tabs: 账户概览、Campaign、广告组、推广商品、关键词、商品投放、搜索词、查询完整性.

Each data table sorts by `cost` descending when that column exists and shows 25 rows per client-side page without dropping embedded rows. Tabs support click, Left/Right, Up/Down on the vertical action rail, Home/End, focus state, ARIA relationships, responsive horizontal scrolling, and print expansion of all panels.

## Output

Default directory is `<current-working-directory>/sellerspace-reports`. Create a new atomic file named `ads-audit-<marketplace>-<UTC timestamp>.html`; never overwrite an existing file.

Write JSON only to stdout:

```json
{"ok":true,"reportPath":"/absolute/path/to/report.html"}
```

On failure, remove any temporary file and return a structured JSON error without exposing the input payload.
