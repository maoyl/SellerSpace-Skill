# SellerSpace 广告体检诊断规则

## Contents

- [Query plan](#query-plan)
- [Baselines and samples](#baselines-and-samples)
- [Priorities](#priorities)
- [Ratings](#ratings)
- [Recommendations](#recommendations)

## Query plan

Use `dateType=NM` when the user omits a period. Keep one `sellerId + marketplace` per audit.

Query station context with `query_store_performance`. Read station identity plus `orders`, `units`, `revenue`, `cpcCost`, `adCpcSales`, `adAcos`, `acoTs`, and `roas` from the unprojected backend response when present.

For every `query_ads` call, use `orderByField=cost`, `orderType=2`, and `pageSize=100`. The direct client returns the backend response without business-field projection; read the relevant identity and metric fields from it when present.

The audit scope is enabled inventory only. The direct client owns these exact backend status filters, rejects caller overrides, and never uses `notArchived`:

- `campaign`: `campaignStatus=enabled`.
- `adGroup`: `campaignStatus=enabled` and `adGroupStatus=enabled`.
- `productAds`, `keywords`, and `targets`: `campaignStatus=enabled`, `adGroupStatus=enabled`, and `status=enabled`.
- `searchQuery`: `campaignStatus=enabled` and `adGroupStatus=enabled`; search terms have no leaf status.

Use the corresponding backend identity and evidence fields when present: campaign budget/placement fields; ad group default bid; product ASIN/SKU; keyword text/match type; target expression/value; and search-query positive/negative lists plus impression rank/share.

Use one `evidence-driven` query mode after the enabled Campaign query succeeds:

1. Fetch every Campaign page so all enabled Campaigns have basic metrics.
2. Query the five child entities across the station. Start at page 1 and continue until fetched unique rows cover at least 90% of the entity summary cost or the final page is reached.
3. Compute `spendCoverage = min(1, sum(unique fetched row cost) / summary cost)`. Deduplicate with the backend entity ID; when an ID is absent, use the stable parent IDs plus entity text/expression.
4. When summary cost is missing, non-finite, or not positive, keep the first maximum-size page, set `spendCoverage=null` and `coverageStatus=unknown`, and do not claim complete evidence.
5. Stop pagination when a page adds no unique rows or no positive covered cost. Preserve the actual coverage and disclose that the 90% target was not reached.
6. Select each Campaign connected to a sufficiently sampled P1/P2 problem, a P3 search-term harvesting opportunity, or a P3 efficient-but-budget-constrained opportunity. Do not rank down to a fixed number.
7. For each selected Campaign, apply the same 90% rule to all five campaign-filtered child entities and query DAILY history. Query placement history for each selected SP Campaign only when placement can explain a traffic, conversion, efficiency, or budget finding.

If the enabled Campaign count is zero, produce an empty enabled-scope report without child, history, or placement calls. Business call count is informational and has no maximum.

`costBudgetPercent`, ACoS, CTR, and CVR use ratio scale (`0.3 = 30%`). Placement adjustments and `searchTermImpressionShare` use percent scale (`30 = 30%`). Do not mix these scales. `costBudgetPercent` is today's budget consumption ratio even when the performance period is 30 days.

Keep the returned total count, fetched unique row count, spend coverage, and coverage status for every entity. Campaign coverage is complete only after every Campaign page succeeds. Child coverage is `target-reached` at 90% or greater, `complete` when the final page succeeds, and `unknown` when a positive summary cost is unavailable.

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
- A sufficiently sampled efficient search term is not present in the current campaign or ad group positive ID lists.
- A P1/P2 zero-order search term is not present in the applicable negative ID lists; describe it only as a negative candidate.

A returned `suggestedBudget` or `suggestedBid` is supporting evidence only. It never creates P3 or an action by itself.

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

Every finding must contain the entity type, entity name and ID when available, evidence, sample size, reasoning, priority, confidence, recommendation direction, and structured `action`.

Use these action rules:

- `harvest-search-term`: require the P3 efficiency gate. Resolve `positiveCampaignIdList` and `positiveAdGroupIdList`. If neither shows the term as targeted, recommend an exact keyword when `queryIsAsin` is not `Y`, or an exact product target when it is `Y`. If it is already targeted, list the resolved Campaign/ad-group locations and use `observe` instead of recommending a duplicate.
- `negative-search-term`: require a P1/P2 zero-order search term and confirm that the applicable negative Campaign/ad-group lists do not already contain it. Recommend only “加入否定候选”; do not claim it was negated.
- `lower-bid`: use for an existing inefficient keyword or target with sufficient P1/P2 evidence. A keyword or target has a bid, not a budget.
- `pause`: use only for a severe, sufficiently sampled existing keyword or target when lowering the bid is unlikely to address the repeated zero-order or extreme-efficiency problem.
- `increase-budget`: require a sufficiently sampled efficient Campaign and `costBudgetPercent >= 0.8`. Recommend “提高预算” without an amount. Never use a suggested budget as the sole trigger.
- `observe`: use below the sample gate, for already-targeted efficient search terms, or when coverage/baseline is insufficient for a directional action.

Never say an action was applied. Never calculate or recommend a concrete bid, budget, percentage, or placement adjustment. Returned suggested values may appear only as clearly sourced raw evidence, not as the recommendation value.
