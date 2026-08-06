# SellerSpace Ads Audit MCP Contracts

## Contents

- [get_stores](#get-stores)
- [discover_fields](#discover-fields)
- [query_ads](#query-ads)
- [query_store_performance](#query-store-performance)
- [get_metric_history](#get-metric-history)
- [Query DSL guidance](#query-dsl-guidance)

This reference contains only the operations allowed by the read-only ads audit Skill. Load the matching `tool-<operation>.json` before composing a call.

## get_stores

发现当前账号可用的 sellerId、marketplace 和授权状态。

Exact contract: [tool-get_stores.json](tool-get_stores.json).

- Default: refresh=false，优先读取最长约 2 小时的店铺缓存。
- Default: 未传筛选条件时返回当前账号的全部可见店铺。
- Default: marketplace 使用站点 code（如 US、DE），marketplaceId 默认不返回且不能代替 marketplace。
- Constraint: 敏感字段不会通过 selectFields 返回。
- Constraint: 多店铺任务必须先确认范围，再按店铺顺序执行。

## discover_fields

按业务上下文查字段名、中文含义、单位、比例刻度和可用场景。

Exact contract: [tool-discover_fields.json](tool-discover_fields.json).

- Default: 未限定 domain/entity 时会跨上下文搜索。
- Default: 同名业务词可能命中多个口径，应结合 domain/entity 选择。
- Constraint: 广告销售额、商品总销售额和站点销售额不是同一口径。

## query_ads

通过一个 DSL 查询 9 类广告实体，并控制筛选、字段投影、排序和分页。

Exact contract: [tool-query_ads.json](tool-query_ads.json).

- Default: 公共入口未指定 period 时统一使用 SD（近 7 天）。
- Default: page.number=1、page.size=20，单页最大 100；默认按 impressions 降序。
- Default: 默认排除归档数据；selectFields 精确投影时，summary 默认不返回，除非 includeSummary=true。
- Default: includeFieldMeta 默认 false。
- Constraint: 每次只查询一个 sellerId + marketplace。
- Constraint: 否定关键词和商品否定没有曝光、点击、花费等投放指标。
- Constraint: 词频分析不要从 searchQuery 明细自行统计；使用 entity=searchTermFrequency。

## query_store_performance

查询站点或店铺维度的销售、订单、退款、广告与费用汇总。

Exact contract: [tool-query_store_performance.json](tool-query_store_performance.json).

- Default: period=SD、view.dimension=market、view.chainType=HOURLY。
- Default: selectFields 生效时默认不返回聚合数据，除非 includeSummary=true。
- Default: includeFieldMeta 默认 false。
- Constraint: scope.stations 必须至少包含一个站点。
- Constraint: 变化率字段与原始金额/数量字段的单位不同。

## get_metric_history

将单个广告实体按时间、24 小时或广告位拆分。

Exact contract: [tool-get_metric_history.json](tool-get_metric_history.json).

- Default: dimension=time、timeType=DAILY、placementBusiness=N。
- Default: fromDateStr 和 toDateStr 始终必传。
- Constraint: HOURLY 不支持 searchTerm。
- Constraint: placement 只支持 campaign、productAd、keyword、target。

## Query DSL guidance

# SellerSpace Query DSL

- 静态工具只保留业务入口，不再把所有后端字段平铺到 manifest。
- 广告查询固定使用 `entity + scope + period + criteria + filters + fields + sort + page`。
- 商品与店铺查询固定使用 `scope + period + criteria + view + fields + sort + page`。
- `fields/includeFields` 是在默认字段基础上追加；`selectFields` 是精确投影。用于写操作前置查询、只定位对象时，优先传 `selectFields`，例如只取 `campaignId/campaignName`。
- 传 `selectFields` 时默认省略 summary/series/chainSummary/chainRate 等聚合数据；需要聚合数据时显式传 `includeSummary=true`。
- 字段含义按上下文区分；拿不准字段名或口径时先调用 `discover_fields`。例如广告销售额是 `ads.campaign.cpcSales`，商品/站点总销售额通常是 `revenue`。
- 时间范围优先把用户原话放到 `period.text`，例如“近30天”“上月”；服务端会自动规范化为 `period.preset`。
- 严格区分自然月与滚动天数：`LM`=上月（上一自然月），`NM`=近30天（滚动30天）。用户说“近30天/最近30天/过去30天”必须用 `NM`，只有说“上月/上个月”才用 `LM`。
- 字段字典、枚举和边界说明请改查 `sellerspace://schema/*` 与 `sellerspace://enum/*`。

Ads audit overrides:

- Default audit period is `period.preset=NM` (rolling 30 days), never `LM`.
- Audit only the enabled hierarchy: campaigns use `status=enabled`; child entities use their full enabled parent/entity chain.
- Core entity detail uses page 1, page size 50, `cost desc`, and `includeSummary=true`.
- With 0 to 3 enabled campaigns, drill into every campaign; with more than 3, use portfolio sampling.
- The Skill never calls write, export, or browser operations.
