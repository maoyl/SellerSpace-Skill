# SellerSpace Ads Audit Recommendation Playbook

## Contents

- [Decision order](#decision-order)
- [Evidence gates](#evidence-gates)
- [Cross-context comparison](#cross-context-comparison)
- [Entity action matrix](#entity-action-matrix)
- [Action precedence](#action-precedence)
- [Research basis](#research-basis)

## Decision order

The bundled deterministic audit engine applies this order before returning `recommendations`. The agent presents and explains those candidates; it does not recreate the decision tree or add unsupported actions.

For every candidate recommendation:

1. Name the exact entity and scope: Campaign, ad group, promoted product, keyword, product target, search term, or placement.
2. Verify the sample gate and the applicable business objective before deciding whether performance is good or bad.
3. Compare the entity with its own child rows and with the same normalized search term, ASIN, keyword, or target in other Campaign/ad-group contexts.
4. Choose the smallest controllable layer that explains the problem. Do not pause a Campaign because one child keyword is poor.
5. State one concrete direction, the evidence that triggered it, the intended destination or scope, and any execution dependency.
6. Put non-actionable uncertainty in the observation/data-gap area, not in the primary action rail. Do not create a fixed number of recommendations and do not use “持续观察” to fill space.

Recommendations remain directional. Never calculate or prescribe a bid, budget, placement percentage, or adjustment ratio.

## Evidence gates

- Use `minClicks` from the diagnosis rules for conversion judgments.
- Require at least `max(20, minClicks)` clicks before recommending a new negative target for a search term. Amazon recommends evaluating a keyword after at least 20 clicks before making it negative.
- Require at least two attributed orders and positive attributed sales before judging ACoS/ROAS.
- Require at least three attributed orders, an explicit user target, and efficiency that meets that target before recommending expansion.
- Require repeated evidence before pausing an enabled entity: either zero orders after the applicable click gate, or the same severe target miss in at least two non-overlapping time buckets when entity DAILY history is available.
- Treat account averages, CTR/CVR ratios, impression rank/share, suggested bids, and suggested budgets as diagnostic context. None of them can independently create an action.
- Do not create an action merely because a metric barely crosses a relative threshold. A relative P2 signal only selects a drilldown; the final action still requires a business-target miss, zero-order waste, clear irrelevance, a material cross-context winner/loser split, or direct budget-constraint evidence.
- When signals conflict, prefer the more specific commercial result. For example, a Campaign with CVR below account context but ACoS within the user's target is not a bid-cut candidate solely because of CVR.

## Cross-context comparison

Build a comparison index before finalizing actions:

- Normalize text search terms with trim, case folding, and whitespace folding. Normalize ASIN search terms to uppercase.
- Group `searchQuery` rows by normalized `canonical.searchTermText` and `canonical.queryIsAsin`; retain canonical Campaign/ad-group identity, advertised ASIN/SKU, `canonical.sourceKeywordText`, `canonical.sourceKeywordMatchType`, originating target, clicks, orders, sales, cost, ACoS/ROAS, and positive/negative coverage IDs. Never group or label a search term with its source keyword text.
- Group promoted products by `canonical.asin`, keywords by normalized `canonical.keywordText + canonical.keywordMatchType`, and product targets by normalized `canonical.targetExpression + canonical.targetType`.
- Do not assume duplicates are harmful. Recommend routing/isolation only when the same object has materially different outcomes or when the user has intentionally different goals.

When the same search term performs well in context A and poorly in context B:

1. Keep A and identify its actual limiter. If A meets the explicit target and repeatedly runs out of budget, recommend increasing A's budget. If A is not budget constrained but has limited visibility and a controllable keyword/target bid, recommend increasing that bid.
2. Treat B at its smallest controllable source. For an existing exact keyword or product target, recommend lowering its bid first and pausing only for severe persistent failure. For an auto, broad, phrase, or category source, recommend a negative exact search term/ASIN in B's ad group or Campaign.
3. If the winner is not isolated, recommend creating an exact keyword or exact product target in the winner destination and adding a negative exact target only in the losing/discovery source.
4. Never add a Campaign-wide negative when the term still performs well in another ad group inside that Campaign. Use the narrowest safe negative scope.
5. Emit `comparisonEvidence` with at least one `winner` and one `loser`; show both locations and metrics in the report.

## Entity action matrix

### Campaign

- `increase-budget`: use only when the Campaign meets an explicit target and DAILY evidence shows at least two actual budget-constrained days. State how many days were constrained and whether constrained days still produced orders/sales.
- `reduce-budget`: use when the Campaign is not converting or persistently misses the explicit target after leaf-level targeting/bid issues have been identified. Do not use “out of budget” as a reason to increase an inefficient Campaign.
- `reallocate-budget`: require both a donor Campaign with weak/non-spending performance and a receiver Campaign that meets the target and is actually constrained. Name both Campaigns.
- `pause`: use only when the Campaign remains severely inefficient across at least two time buckets and no meaningful child entity is healthy. Otherwise recommend fixing or isolating the bad children.
- `review-structure`: split Campaigns that mix materially different goals, products, targeting strategies, or margin/ACoS objectives.

### Ad group

- In automatic targeting, recommend increasing or lowering the ad-group/default bid only when the ad group's search terms broadly point in the same direction.
- In manual targeting, prefer keyword/target bid actions over changing the whole ad group.
- Pause an ad group only when its sampled child keywords/targets/products are consistently severe and it contains no material winner.
- Recommend splitting the ad group when products with different goals or performance share the same targets and bids.

### Promoted product

- Recommend pausing a promoted product when that ASIN has sufficient clicks and severe conversion/efficiency failure while sibling products under the same traffic source perform materially better.
- If every promoted product in the ad group is weak, diagnose the shared targeting, offer, or detail-page risk instead of blaming one product.
- Recommend isolating a materially dominant ASIN into its own ad group/Campaign when it needs a different goal, budget, or targeting strategy.
- Treat listing quality, price, inventory, and Featured Offer as unverified caveats unless those datasets were actually queried.

### Keyword

- `increase-bid`: require an explicit target, sufficient orders, efficiency within target, no Campaign budget constraint, and evidence that visibility is limited. Name the keyword, match type, Campaign, and ad group.
- `lower-bid`: use for a relevant keyword with sufficient evidence that misses the explicit target, or for a zero-order keyword after the click gate. State ACoS/ROAS, clicks/orders, current bid when available, and source context.
- `pause`: reserve for severe persistent failure. If a broad/phrase keyword contains both good and bad search terms, keep the keyword and optimize its search terms instead.
- If a high-performing search term comes through broad/phrase, recommend exact harvesting and source isolation instead of simply raising the broad keyword bid.

### Product/category target

- Apply the same bid rules as keywords to an existing product/category target.
- For a specific ASIN target that is relevant but too expensive, lower its bid first; pause it only after severe persistent failure.
- For a bad ASIN discovered through auto/category traffic, recommend a negative exact product target in that source rather than calling it a negative keyword.
- Harvest a converting ASIN into an exact product target when it is not already controlled separately.

### Search term

- `harvest-search-term`: label the term with `canonical.searchTermText`; for a term meeting the opportunity gate, create an exact keyword, or an exact product target when `canonical.queryIsAsin=Y`. Include the intended Campaign/ad-group destination.
- `negative-search-term`: for a zero-order or clearly irrelevant term after the negative click gate, recommend negative exact at the narrowest source scope. Use negative phrase only when the same irrelevant phrase appears across multiple bad queries and no converting query containing that phrase would be blocked.
- `isolate-search-term`: use the cross-context workflow when the same term has a winner and loser. Do not recommend a duplicate exact target without also stating how traffic should be controlled in the source.
- If the term is already positively targeted and performs consistently, do not recommend creating it again; choose bid, budget, or placement direction at the actual target location.

### Placement

- `increase-placement-bid`: require an explicit target, sufficient placement-level orders/sales, efficiency within target, and evidence that the placement has room to capture more visibility. Do not use placement share alone.
- `lower-placement-bid`: use when a placement has sufficient evidence and materially misses the target, while other placements or the Campaign still contain healthy traffic.
- Query placement rows at the exact controllable level: Campaign, promoted product, keyword, or product target. Do not use Campaign placement rows to justify a leaf-entity placement action.
- If every placement is poor, fix targeting/product/bids or reduce the Campaign budget instead of shifting spend between equally weak placements.

## Action precedence

Apply these priorities when several actions could describe the same evidence:

1. Efficient and budget constrained: increase Campaign budget before increasing bids; a higher bid may only exhaust the same budget earlier.
2. Inefficient leaf entity: lower/pause the keyword or target before reducing the whole Campaign budget.
3. Mixed broad/auto traffic: harvest winners and negate losers before pausing the source keyword, ad group, or Campaign.
4. Same term winner/loser: isolate traffic at the losing source before making any account-wide change.
5. Entire ad group/Campaign weak: optimize children first; pause or reallocate only after confirming there is no material winner.
6. Data below the action gate: keep it out of the primary action rail and explain the missing evidence in the observation/data-gap area.

## Research basis

Use these sources as principles, not as permission to invent fixed percentages:

- Amazon Ads, Sponsored Products targeting guide: https://advertising.amazon.com/library/guides/targeting-with-sponsored-products
- Amazon Ads, Sponsored Products budget best practices: https://advertising.amazon.com/en-ca/library/guides/sponsored-products-budget-best-practices
- Amazon Ads, dynamic bidding guide: https://advertising.amazon.com/library/guides/dynamic-bidding-sponsored-products
- Amazon Ads, keyword strategy: https://advertising.amazon.com/blog/how-to-start-and-improve-your-keyword-strategy/
- Amazon Ads, ad groups: https://advertising.amazon.com/help/GKPA6T8WW3AYKV4Q
- Amazon Ads, ACoS optimization guide: https://m.media-amazon.com/images/G/01/AmazonMarketingServices/USLandingPagesImproveACoS._V514885723_.pdf
- Industry implementation reference for cross-context duplicate handling: https://www.adbadger.com/blog/manage-duplicate-search-terms-on-amazon/

Amazon's own guidance supports increasing budgets for converting out-of-budget Campaigns, reallocating budget away from weak Campaigns, raising bids on targets that meet goals, lowering bids on targets that miss goals, pausing persistent high-click/low-sale entities, exact harvesting, negative targeting, and placement-specific optimization. The cross-context workflow above is a conservative synthesis of those controls and the available SellerSpace evidence.
