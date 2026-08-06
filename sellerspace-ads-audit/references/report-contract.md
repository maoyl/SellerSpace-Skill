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
  "assumptions": ["未提供目标 ACoS，使用站点相对基准。"],
  "limitations": []
}
```

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
    {"date": "2026-08-05", "cost": 12.5, "sales": 35, "acos": 0.357}
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
  "recommendation": "建议提取为精准关键词单独投放。",
  "confidence": "high",
  "action": {
    "type": "harvest-search-term | negative-search-term | lower-bid | pause | increase-budget | observe",
    "label": "建议提取为精准关键词",
    "targetLevel": "campaign | adGroup | keyword | target | productAd",
    "coverageStatus": "not-targeted | targeted | already-negative | unknown",
    "existingTargets": [
      {"level": "campaign | adGroup", "id": "456", "name": "Resolved name"}
    ]
  }
}
```

`action.targetLevel`, `action.coverageStatus`, and `action.existingTargets` are optional. `action` itself is optional only for legacy reports. Recommendation text gives a direction and never contains a calculated bid, budget, percentage, or placement adjustment.

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
- `businessCallCount` is informational and has no maximum.

## Analysis modes

- `evidence-driven`: top-level `sections` contains all six core entity sections. `campaignDrilldowns`, `fullyDrilledCampaignIds`, and `selectedCampaigns` describe the same evidence-selected Campaign set. DAILY history is required for every selected Campaign. Placement IDs are a subset of selected SP Campaigns where placement evidence was relevant.
- `campaign-drilldown`: accepted for legacy reports. Top-level `sections` contains `campaign`; drilldowns may contain any number of enabled Campaigns. No old three-Campaign or 24-call cap is enforced.
- `portfolio-sample`: accepted for legacy reports. Top-level `sections` contains all six core sections. No old Campaign-count threshold or 13-call cap is enforced.

Require all top-level keys except optional `period.from`, `period.to`, nullable baseline values, optional finding IDs/action, and optional legacy coverage extensions. Reject unknown schema versions, invalid enums, missing arrays, non-finite numbers, duplicate section keys, duplicate drilldown IDs, non-enabled drilldowns, mismatched evidence-driven selection IDs, or invalid coverage ratios. Do not impose a business-call, Campaign, trend, placement, metric, or section-row count limit.

## Formatting

- `currency`: format with `Intl.NumberFormat` and the station currency; preserve the numeric value.
- `count`: group integer-like values; do not manufacture decimals.
- `ratio`: display `0.3` as `30%`.
- `percent`: display `30` as `30%`.
- `number`: use a compact locale-aware number.
- `string`: escape and display text.
- `null` or missing display values: show `—`.

Treat every string as untrusted and HTML-escape it. Do not create links from returned business text. The renderer embeds the SellerSpace logo, generated data charts, styles, and interaction code locally; it must not load any remote dependency.

The report uses two independent accessible tab groups:

- Action tabs: 搜索词机会、止损与否定、活动预算、持续观察.
- Data tabs: Campaign、广告组、推广商品、关键词、商品投放、搜索词.

Each data table shows 25 rows per client-side page without dropping embedded rows. Tabs support click, Left/Right, Home/End, focus state, ARIA relationships, responsive horizontal scrolling, and print expansion of all panels.

## Output

Default directory is `<current-working-directory>/sellerspace-reports`. Create a new atomic file named `ads-audit-<marketplace>-<UTC timestamp>.html`; never overwrite an existing file.

Write JSON only to stdout:

```json
{"ok":true,"reportPath":"/absolute/path/to/report.html"}
```

On failure, remove any temporary file and return a structured JSON error without exposing the input payload.
