# SellerSpace Ads Audit Direct API Contract

The bundled CLI calls the SellerSpace read-only analysis APIs directly with `X-API-Key`. It never sends JSON-RPC `tools/call` requests to MCP. Business response payloads are preserved; credential-like fields are recursively removed.

## Actual endpoints

- `get_stores`: `GET /api/mcp/analysis/stores`
- `query_store_performance`: `GET /api/mcp/analysis/website`
- `query_ads` (campaign): `POST /api/mcp/analysis/cpc/campaigns/page`
- `query_ads` (adGroup): `POST /api/mcp/analysis/cpc/adGroups/page`
- `query_ads` (productAds): `POST /api/mcp/analysis/cpc/product_ads/page`
- `query_ads` (keywords): `POST /api/mcp/analysis/cpc/keywords/page`
- `query_ads` (targets): `POST /api/mcp/analysis/cpc/targets/page`
- `query_ads` (searchQuery): `POST /api/mcp/analysis/cpc/keywords_query/page`
- `get_metric_history` (time): `GET /api/mcp/analysis/cpc/common/metric/analysis`
- `get_metric_history` (placement): `GET /api/mcp/analysis/cpc/common/placement`
- `get_metric_history` (hourly): `GET /api/mcp/analysis/cpc/campaigns/analysis/hourly-stream`

Only these compiled-in endpoints are allowed. Callers cannot supply a URL, path, HTTP method, or status filter.

## get_stores

Input: `{}`. The direct `GET` response is returned without business-field projection. Credential-like fields such as authorization tokens are recursively removed.

## query_store_performance

Required input: `storeShortNameAndMarketplaces` (for example `["9614-US"]`). Optional: `dateType`, `fromDateStr`, `toDateStr`, `currencyCode`, `chainType`, `dimension`.

Defaults: `dateType=NM`, `chainType=HOURLY`, `dimension=market`. `dateType=CU` requires both date strings.

## query_ads

Required input: `entity`, `sellerId`, `marketplace`. Supported entities: `campaign`, `adGroup`, `productAds`, `keywords`, `targets`, `searchQuery`.

Optional input: `dateType`, `fromDateStr`, `toDateStr`, `adType`, `campaignId`, `adGroupId`, `page`, `pageSize`, `orderByField`, `orderType`.

The CLI always sends exact enabled-state filters and rejects caller-supplied status fields:

- `campaign`: `campaignStatus=enabled`.
- `adGroup`: `campaignStatus=enabled`, `adGroupStatus=enabled`.
- `productAds`, `keywords`, `targets`: `campaignStatus=enabled`, `adGroupStatus=enabled`, `status=enabled`.
- `searchQuery`: `campaignStatus=enabled`, `adGroupStatus=enabled` (search terms have no leaf state).

Defaults: `dateType=NM`, `page=1`, `pageSize=50`, `orderByField=cost`, `orderType=2`. Page size cannot exceed 50.

## get_metric_history

Required input: `sellerId`, `marketplace`, `adDataType`, `id`, `fromDateStr`, `toDateStr`. Optional: `dimension`, `timeType`, `placementBusiness`, `dateType`.

- Normal time history calls `common/metric/analysis`.
- `timeType=HOURLY` calls `campaigns/analysis/hourly-stream` and maps the entity to the backend `type` exactly.
- `dimension=placement` calls `common/placement` and maps the entity ID to `campaignId`, `adId`, or `keywordId` exactly.

## Audit rules

- Default audit period is `dateType=NM` (rolling 30 days), never `LM`.
- Core entity detail is page 1, page size 50, cost descending.
- With 0 to 3 enabled campaigns, drill into every campaign; with more than 3, use portfolio sampling.
- The Skill never calls write, export, browser, or MCP JSON-RPC operations.
