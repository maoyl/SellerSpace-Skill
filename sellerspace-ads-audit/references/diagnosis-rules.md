# SellerSpace 广告体检诊断规则

## Contents

- [Query plan](#query-plan)
- [Business targets and relative context](#business-targets-and-relative-context)
- [Priorities](#priorities)
- [Ratings](#ratings)
- [Recommendations](#recommendations)

## Query plan

The bundled `sellerspace-audit-engine.mjs` is the executable implementation of these rules. The normal Skill workflow invokes it through `sellerspace-cli.mjs audit`; agents must not reimplement this plan through a long sequence of manual calls. This reference explains decisions and supports review when a user questions a recommendation.

After preflight, call `get_stores` only to list valid store + marketplace combinations. Require the user to explicitly select exactly one returned combination and provide its target ACoS before any performance, ads, history, or placement query. A station already named exactly in the request counts as selected; otherwise show the returned options and stop for confirmation. Never auto-select the first, last-used, partially matched, or sole returned station.

Use `dateType=NM` when the user omits a period. Keep one explicitly selected `sellerId + marketplace` per audit.

Query station context with `query_store_performance`. Read station identity plus `orders`, `units`, `revenue`, `cpcCost`, `adCpcSales`, `adAcos`, `acoTs`, and `roas` from the unprojected backend response when present.

For every `query_ads` call, use `orderByField=cost`, `orderType=2`, and `pageSize=100`. The direct client normalizes the actual backend envelope without changing business values: read aggregate metrics from `data.summary`, rows from `data.page.items`, and pagination from `data.page.totalCount`, `data.page.currentPage`, and `data.page.pageCount`. Treat any other row path as invalid instead of guessing.

Use each row's CLI-owned `canonical` object for identity and text. The exact mappings are:

- Keyword: `canonical.keywordText` comes from raw `keywordsText` (legacy fallback `keywordText`); `canonical.keywordMatchType` comes from `keywordsMatchType` (fallback `matchType`, then `matchTypeStr`).
- Search term: `canonical.searchTermText` comes only from raw `query`. `canonical.sourceKeywordText` is the originating keyword and is not the search term. `canonical.queryIsAsin` is the normalized `Y/N` classification.
- Target: `canonical.targetExpression` and `canonical.targetType`; promoted product: `canonical.asin` and `canonical.sellerSku`.
- Entity/history identity: use `canonical.entityId`, `canonical.historyAdDataType`, and `canonical.historyId`. A null canonical ID cannot be guessed and cannot trigger a history request or an ID-dependent action.

All raw SellerSpace fields remain on the row for metric evidence. Never use a raw alias to override a non-null canonical value.

The audit scope is enabled inventory only. The direct client owns these exact backend status filters, rejects caller overrides, and never uses `notArchived`:

- `campaign`: `campaignStatus=enabled`.
- `adGroup`: `campaignStatus=enabled` and `adGroupStatus=enabled`.
- `productAds`, `keywords`, and `targets`: `campaignStatus=enabled`, `adGroupStatus=enabled`, and `status=enabled`.
- `searchQuery`: `campaignStatus=enabled` and `adGroupStatus=enabled`; search terms have no leaf status.

Use the corresponding metric and evidence fields when present: campaign budget/placement fields; ad group default bid; product metrics; keyword metrics; target metrics; and search-query positive/negative lists plus impression rank/share. Identity and labels still come only from `canonical`.

Use one `evidence-driven` query mode after the enabled Campaign query succeeds:

1. Fetch every Campaign page so all enabled Campaigns have basic metrics.
2. Query the five child entities across the station. Start at page 1 and continue until fetched unique rows cover at least 90% of the entity summary cost or the final page is reached.
3. Compute `spendCoverage = min(1, sum(unique fetched row cost) / summary cost)`. Deduplicate with `canonical.entityId`; when it is null, use `canonical.campaignId + canonical.adGroupId + canonical.entityName` only for coverage deduplication. Such a fallback key does not authorize history queries or ID-dependent actions.
4. When summary cost is missing, non-finite, or not positive, keep the first maximum-size page, set `spendCoverage=null` and `coverageStatus=unknown`, and do not claim complete evidence.
5. Stop pagination when a page adds no unique rows or no positive covered cost. Preserve the actual coverage and disclose that the 90% target was not reached.
6. Build the cross-context indexes defined in [recommendation-playbook.md](recommendation-playbook.md), then select each Campaign connected to a sufficiently sampled P1/P2 problem, an entity bid/pause candidate, a cross-context split, a P3 search-term harvesting/isolation opportunity, or a P3 efficient-but-budget-constrained opportunity. Do not rank down to a fixed number.
7. Reuse the station-level child rows for Campaign/ad-group joins instead of repeating the same five child queries per Campaign. Because the rows are already sorted by spend and satisfy the recorded coverage policy, this removes duplicate network calls without changing the analyzed evidence set.
8. Query DAILY history for every selected Campaign. Query Campaign placement history for each selected SP Campaign so a placement action can be emitted only when placement rows show a qualified winner/loser split. Do not guess IDs or treat Campaign history as leaf-entity history. A leaf action that requires persistence must remain a lower-risk direction unless direct leaf evidence exists.

If the enabled Campaign count is zero, produce an empty enabled-scope report without child, history, or placement calls. Business call count is informational and has no maximum.

`costBudgetPercent`, ACoS, CTR, and CVR use ratio scale (`0.3 = 30%`). Placement adjustments and `searchTermImpressionShare` use percent scale (`30 = 30%`). Do not mix these scales. `costBudgetPercent` is today's budget consumption ratio even when the performance period is 30 days.

Keep the returned total count, fetched unique row count, spend coverage, and coverage status for every entity. Campaign coverage is complete only after every Campaign page succeeds. Child coverage is `target-reached` at 90% or greater, `complete` when the final page succeeds, and `unknown` when a positive summary cost is unavailable.

## Business targets and relative context

Every new audit requires a user-supplied target ACoS before `query_store_performance`, `query_ads`, or `get_metric_history`. `preflight` and `get_stores` may run first only to authenticate and present valid station choices. Target ROAS, break-even lines, account averages, Campaign summaries, Amazon suggestions, and historical ACoS do not satisfy this requirement and must not be converted into a target by the agent. If target ACoS is missing, ask the user and stop.

The explicit target ACoS is the only threshold that can prove efficiency is acceptable, mark efficiency or budget green, or trigger an expansion action. Campaign summaries and station/account metrics are relative context only: use them to find outliers, never as a pass line and never as evidence that an entity is profitable or “good”. Renderer support for reports without a target exists only for old saved artifacts; never intentionally create a new no-target audit.

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
- Rows below the gate may be listed as a data note but never as a primary action or severe problem.

## Priorities

Assign P1 when either condition holds:

- Zero orders, clicks at least `minClicks`, and row cost is at least 5% of the corresponding entity summary cost.
- A target exists, orders are at least 2, ACoS is at least 1.5 times target, and cost share is at least 5%.

Assign P2 when any condition holds and no P1 condition holds:

- A target exists, orders are at least 2, and ACoS is at least 1.2 times target.
- Zero orders and clicks are at least `minClicks`, but the row does not meet the P1 material-spend condition. This can trigger a leaf bid-control direction; a new negative search term still requires at least `max(20, minClicks)` clicks.
- Impressions are at least 1,000, CTR is below 70% of account CTR, and cost share is at least 2%.
- Clicks are at least `minClicks`, CVR is below 70% of account CVR, and cost share is at least 2%.

Relative CTR/CVR P2 rules are drilldown signals only. They do not independently justify lowering a bid, pausing an entity, reducing a budget, or placing a generic “持续观察” card in the primary action rail. Final actions must pass [recommendation-playbook.md](recommendation-playbook.md).

Assign P3 opportunity when any condition holds:

- Orders are at least 3 and ACoS is at or below an explicit user target.
- A Campaign meets the explicit user target and has repeated, directly reported daily budget-constraint evidence.
- A sufficiently sampled search term is not present in the current Campaign or ad-group positive ID lists and meets the explicit target ACoS.
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
- Green: no P1/P2, the required data is complete, and any efficiency/budget judgment has an explicit business target.
- Data-insufficient: the required summary or section data is missing. For legacy saved reports without a user target, efficiency and budget remain data-insufficient unless negative evidence makes them yellow or red; a new audit must already have a target ACoS.

Never create a numeric total score. Concentration alone is evidence, not a problem, unless the concentrated entity is also inefficient or risky.

## Recommendations

Every deterministic recommendation must contain the entity type, entity name and ID when available, Campaign/ad-group location when applicable, evidence, sample size, priority, confidence, recommendation direction, structured `action`, and at least one `reasons` entry that explains why the direction is recommended. Include additional reasons only when they add distinct, evidence-backed support; never invent or split reasons merely to increase the count. Add `risk` whenever coverage, target, inventory, promotion, or daily evidence limits the conclusion. Apply [recommendation-playbook.md](recommendation-playbook.md) before emitting an action.

Use these action rules:

- `harvest-search-term`: read the term from `canonical.searchTermText`, resolve `positiveCampaignIdList` and `positiveAdGroupIdList`, and require efficiency within the explicit target ACoS. If neither list shows the term as targeted, recommend an exact keyword when `canonical.queryIsAsin` is not `Y`, or an exact product target when it is `Y`. If it is already targeted, list the resolved Campaign/ad-group locations and use `observe` instead of recommending a duplicate.
- `negative-search-term`: require a P1/P2 zero-order search term with at least `max(20, minClicks)` clicks and confirm that the applicable negative Campaign/ad-group lists do not already contain it. Recommend negative exact at the narrowest safe source scope; use negative phrase only for a repeated irrelevant phrase that does not occur in any converting query. Do not claim it was negated.
- `isolate-search-term`: require cross-context evidence with at least one qualified winner and one qualified loser. Name the exact destination and the losing source. Never use a Campaign-wide negative when the term still performs well in another ad group within that Campaign.
- `increase-bid`: require an explicit business target, sufficient orders, efficiency within target, no Campaign budget constraint, and visibility headroom. Apply only to a controllable keyword, target, or automatic ad-group/default bid.
- `lower-bid`: use for an existing inefficient keyword or target with sufficient P1/P2 evidence. A keyword or target has a bid, not a budget.
- `pause`: use only for severe persistent failure. Pause a Campaign or ad group only when no material child winner exists; otherwise act at the leaf level.
- `increase-budget`: require an explicit user ACoS/ROAS or break-even target, sufficient Campaign efficiency against that target, and DAILY evidence with at least two actual budget-constrained days. Count a constrained day only when the daily API reports `overBudgetTime`, a positive `overBudgetTimeMinute`, or an applicable historical `campaignBudget`; current `dailyBudget` alone is only “按当前预算回看” and cannot prove historical shortage. Recommend “提高预算” without an amount. Never use `costBudgetPercent`, current daily budget, or a suggested budget as the sole trigger.
- `reduce-budget`: use for a persistently weak Campaign only after identifying leaf-level causes; never use it as a substitute for fixing one bad keyword or target.
- `reallocate-budget`: require a named weak/non-spending donor and a named efficient, actually constrained receiver.
- `increase-placement-bid` or `lower-placement-bid`: require sufficient placement evidence and an explicit target. Placement share alone is not a trigger. Keep legacy `adjust-placement` only for old reports.
- `review-structure`: use for enabled zero-spend Campaign cleanup, excessive fragmentation, or other clear structure-maintenance directions that do not require a bid/budget mutation.
- `observe`: use below the sample gate or when evidence conflicts. Keep it in the observation/data-gap area, not the primary action rail.

Never say an action was applied. Never calculate or recommend a concrete bid, budget, percentage, or placement adjustment. Returned suggested values may appear only as clearly sourced raw evidence, not as the recommendation value.
