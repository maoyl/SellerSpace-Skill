# SellerSpace 广告体检诊断规则

## Contents

- [Query plan](#query-plan)
- [Baselines and samples](#baselines-and-samples)
- [Priorities](#priorities)
- [Ratings](#ratings)
- [Recommendations](#recommendations)

## Query plan

Use `period={preset:'NM'}` when the user omits a period. Keep one `sellerId + marketplace` per audit.

Query station context with `query_store_performance` and select station identity plus `orders`, `units`, `revenue`, `cpcCost`, `adCpcSales`, `adAcos`, `acoTs`, and `roas`.

For every `query_ads` call, set `includeSummary=true`, `sort={field:'cost',direction:'desc'}`, and `page={number:1,size:50}`. Select identity fields plus the common metrics `impressions`, `clicks`, `cost`, `ctr`, `cpcOrder`, `cpcSales`, `acos`, `cpc`, `cvr`, `cpa`, and `roas`.

Apply these entity-specific fields and status filters. The audit scope is enabled inventory only; never use `notArchived` for the campaign audit:

- `campaign`: include `campaignId`, `campaignName`, `adType`, `campaignStatus`, `dailyBudget`, `costBudgetPercent`, `suggestedBudget`, `placementTop`, `placementDetail`, `placementOther`, and `placementBusiness`; use `status=enabled`.
- `adGroup`: include `adGroupId`, `adGroupName`, `campaignId`, `campaignName`, `adType`, `adGroupStatus`, `defaultBid`, and `bid`; use `status=enabled` and `campaignStatus=enabled`.
- `productAds`: include `asin`, `sellerSku`, `productTitle`, `campaignId`, `campaignName`, `adGroupId`, `adGroupName`, `adType`, `status`, `bid`, `suggestedBid`, and `defaultBid`; use `status=enabled`, `campaignStatus=enabled`, and `adGroupStatus=enabled`.
- `keywords`: include `keywordId`, `keywordsText`, `matchType`, parent identities, statuses, `bid`, and `suggestedBid`; use the full enabled chain.
- `targets`: include `targetId`, `targetExpression`, `targetValue`, parent identities, statuses, `bid`, `suggestedBid`, and `defaultBid`; use the full enabled chain.
- `searchQuery`: include `query`, `queryText`, `queryIsAsin`, parent identities, `positiveCampaignIdList`, `positiveAdGroupIdList`, `negativeCampaignIdList`, `negativeAdGroupIdList`, `searchTermImpressionRank`, and `searchTermImpressionShare`; use `campaignStatus=enabled` and `adGroupStatus=enabled`.

Choose exactly one query mode after the enabled campaign query succeeds:

- `campaign-drilldown`: enabled campaign `totalCount` is 0 to 3. For each returned campaign, query all five child entities with `criteria.campaignId=<campaignId>` and the status filters above. Query DAILY history for each campaign and placement history for each SP campaign. The hard limit is 24 business MCP calls per station. Do not run duplicate portfolio-wide child queries.
- `portfolio-sample`: enabled campaign `totalCount` is greater than 3. Query each child entity once across the station, then query DAILY history for at most three selected campaigns and placement history for at most two selected SP campaigns. The hard limit is 13 business MCP calls per station.

If the enabled campaign count is zero, produce an empty enabled-scope report without child, history, or placement calls. In campaign-drilldown mode, “fully drilled” means every enabled campaign received the planned calls. It does not override the 50-row sample cap within a child entity.

`costBudgetPercent`, ACoS, CTR, and CVR use ratio scale (`0.3 = 30%`). Placement adjustments and `searchTermImpressionShare` use percent scale (`30 = 30%`). Do not mix these scales. `costBudgetPercent` is today's budget consumption ratio even when the performance period is 30 days.

Keep the returned total count and the 50-row sample count for every entity. The summary represents the filtered dataset; the displayed detail remains a cost-ranked sample.

## Baselines and samples

Choose the efficiency baseline in this order:

1. User-supplied target ACoS or ROAS.
2. Campaign summary for the selected station and period.
3. Station context ad metrics.
4. Data-insufficient when no valid baseline exists.

Normalize a user ACoS written as `30%` or `30` to `0.30`; preserve a ratio already written as `0.30`. Do not normalize ROAS as a percentage.

Compute the conversion sample threshold as:

```text
minClicks = clamp(ceil(2 / max(accountCVR, 0.02)), 10, 50)
```

Use `minClicks=20` if account CVR is missing or zero.

Apply these sample gates:

- CTR: at least 1,000 impressions.
- ACoS: at least 2 ad-attributed orders and positive ad-attributed sales.
- Conversion or zero-order waste: clicks at least `minClicks`.
- Rows below the gate may be reported as “continue observing” but never as a severe problem.

## Priorities

Assign P1 when either condition holds:

- Zero orders, clicks at least `minClicks`, and row cost is at least 5% of the corresponding entity summary cost.
- A target exists, orders are at least 2, ACoS is at least 1.5 times target, and cost share is at least 5%.

Assign P2 when any condition holds and no P1 condition holds:

- A target exists, orders are at least 2, and ACoS is at least 1.2 times target.
- No target exists, orders are at least 2, ACoS is at least 1.5 times the account baseline, and cost share is at least 2%.
- Impressions are at least 1,000, CTR is below 70% of account CTR, and cost share is at least 2%.
- Clicks are at least `minClicks`, CVR is below 70% of account CVR, and cost share is at least 2%.

Assign P3 opportunity when any condition holds:

- Orders are at least 3 and ACoS is at or below target; without a target, ACoS is at or below 80% of account baseline.
- A campaign's `costBudgetPercent` is at least 0.8 and its efficiency meets the preceding opportunity rule.
- SellerSpace returns a valid `suggestedBudget` or `suggestedBid` for a sufficiently sampled efficient entity.
- A sufficiently sampled efficient search term is not present in the current campaign or ad group positive ID lists.
- A P1/P2 zero-order search term is not present in the applicable negative ID lists; describe it only as a negative candidate.

When calculating cost share, require a positive summary cost. If it is unavailable, do not assign a spend-share-based priority.

## Ratings

Rate these five dimensions:

- Traffic: impressions, clicks, CTR, search-term impression share.
- Conversion: orders, CVR, CPA, sufficiently sampled clicks without orders.
- Efficiency: spend, ad-attributed sales, ACoS, ROAS.
- Budget: daily budget, today's budget consumption, suggested budget, and inefficient-spend concentration.
- Structure: distribution across campaigns/ad groups/keywords/targets and search-term positive/negative coverage.

For each dimension:

- Red: at least one P1 finding belongs to the dimension.
- Yellow: no P1, but at least one P2 finding belongs to the dimension.
- Green: no P1/P2 and the required data is complete.
- Data-insufficient: required baseline, summary, or section data is missing.

Never create a numeric total score. Concentration alone is evidence, not a problem, unless the concentrated entity is also inefficient or risky.

## Recommendations

Every finding must contain the entity type, entity name and ID when available, evidence, sample size, reasoning, priority, confidence, and a recommendation direction.

Use directions such as reviewing relevance or listing conversion, considering a lower bid or tighter budget, considering pausing or negating, considering more budget for an efficient constrained campaign, or considering harvesting a high-quality search term.

Never say an action was applied. Never calculate a concrete bid, budget, or placement adjustment. Quote a concrete value only from `suggestedBid` or `suggestedBudget`, label it “SellerSpace 后端建议值”, and preserve station currency.
