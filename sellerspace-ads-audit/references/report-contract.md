# Ads Audit Report Contract

## Contents

- [Renderer](#renderer)
- [Input](#input)
- [Query modes](#query-modes)
- [Formatting](#formatting)
- [Output](#output)

## Renderer

Run the renderer only after every planned direct API call for the station has succeeded:

```text
node <skill-dir>/scripts/render-ads-audit-report.mjs --output-dir <directory>
```

Pass one JSON object through stdin. Maximum input is 5 MiB. Never include credentials, headers, raw authorization errors, or private configuration paths.

## Input

Use `schemaVersion=2`. The shared top-level shape is:

```json
{
  "schemaVersion": 2,
  "analysisMode": "campaign-drilldown | portfolio-sample",
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
  "findings": [
    {
      "priority": "P1 | P2 | P3",
      "kind": "problem | opportunity | observe",
      "dimension": "traffic | conversion | efficiency | budget | structure",
      "campaignId": "123",
      "entityType": "campaign",
      "entityId": "123",
      "entityName": "Campaign name",
      "title": "高花费无订单",
      "evidence": [
        {"label": "点击", "value": 42, "format": "count"}
      ],
      "reasoning": "判断依据",
      "recommendation": "建议方向",
      "confidence": "high | medium | low"
    }
  ],
  "sections": [],
  "campaignDrilldowns": [],
  "coverage": {
    "operations": ["get_stores", "query_store_performance", "query_ads"],
    "entitySections": ["campaign", "adGroup", "productAds", "keywords", "targets", "searchQuery"],
    "historyCampaignIds": ["123"],
    "placementCampaignIds": ["123"],
    "enabledCampaignCount": 1,
    "fullyDrilledCampaignIds": ["123"],
    "businessCallCount": 10
  },
  "assumptions": ["未提供目标 ACoS，使用站点相对基准。"],
  "limitations": ["单个实体板块明细为按花费排序的 Top 50。"]
}
```

Every `sections` entry uses:

```json
{
  "key": "campaign",
  "title": "广告活动",
  "summary": "板块结论",
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

`campaignDrilldowns[].sections` contains the five campaign-filtered child sections: `adGroup`, `productAds`, `keywords`, `targets`, and `searchQuery`. A finding from a child entity should include `campaignId` so the report can display it inside the correct campaign dossier.

## Query modes

- `campaign-drilldown`: use when `enabledCampaignCount` is 0 to 3. Top-level `sections` must include `campaign`; `campaignDrilldowns` must contain exactly one entry per enabled campaign; each non-empty entry must contain all five child sections. `fullyDrilledCampaignIds` must match those campaign IDs. Maximum business calls: 24.
- `portfolio-sample`: use when `enabledCampaignCount` is greater than 3. Top-level `sections` must contain all six core entity sections. `campaignDrilldowns` and `fullyDrilledCampaignIds` must be empty. Maximum business calls: 13.

“Fully drilled” means every enabled campaign received every planned query. A child section with `totalCount > sampledCount` remains a Top 50 sample and must be disclosed as such.

Require all top-level keys except optional `period.from`, `period.to`, nullable baseline values, optional finding `campaignId`/`entityId`, and optional metric currency. Reject unknown schema versions, invalid enums, missing arrays, non-finite numbers, duplicate drilldown campaign IDs, non-enabled campaign drilldowns, more than 6 overview metrics, more than 4 metrics in one campaign drilldown, more than 3 drilldowns, more than 60 trend points, more than 5 placements, or more than 50 rows in any section.

## Formatting

- `currency`: format with `Intl.NumberFormat` and the station currency; preserve the numeric value.
- `count`: group integer-like values; do not manufacture decimals.
- `ratio`: display `0.3` as `30%`.
- `percent`: display `30` as `30%`.
- `number`: use a compact locale-aware number.
- `string`: escape and display text.
- `null` or missing display values: show `—`.

Treat every string as untrusted and HTML-escape it. Do not create links from returned business text. The renderer embeds the SellerSpace logo and generated data charts as local data URIs; it must not load any remote dependency.

## Output

Default directory is `<current-working-directory>/sellerspace-reports`. Create a new atomic file named `ads-audit-<marketplace>-<UTC timestamp>.html`; never overwrite an existing file.

Write JSON only to stdout:

```json
{"ok":true,"reportPath":"/absolute/path/to/report.html"}
```

On failure, remove any temporary file and return a structured JSON error without exposing the input payload.
