# SellerSpace MCP 查询与数据口径

## 工具调用

使用宿主实际提供的业务工具名称和 Schema。下文 `get_stores`、`query_store_performance`、`query_products`、`query_inventory`、`query_ads` 是能力名，不是要拼接的固定前缀。

- 直接业务工具：传其业务参数；不额外套 `arguments`。
- 仅在环境实际提供门面时：先取目标业务工具 Schema，再按门面定义包装执行参数。
- `discover_capabilities({adsEntity:"campaign"})` 可返回广告完整参数；字段含义不确定时使用当前可用的 `discover_fields` 或 `includeFieldMeta`。不要因为缺少某个辅助工具就误判经营查询能力不存在。
- 用 `selectFields` 精简响应时需同时设置 `includeSummary:true`，否则汇总/趋势/环比可能被省略。经营查询默认不用精确投影；库存完整分页采用下方精简字段，首屏附字段元数据，后续页不必重复。

## 时间与查询示例

`TD`=站点今天，`YD`=站点昨天，`SD`=接口的近7天预设。日报需要固定的完整日期窗口时用 `CU`；不要仅根据“SD”断言是否包含今天。以站点时区计算并记录起止日期，再核对响应的 `dataPeriod`、`dataPeriodFrom/To` 或逐日日期。

以下为参数示例，sellerId、站点和日期执行时替换为本次已确认的真实值。

报告日店铺表现（对比前日需使用前日相同形状的独立查询，或复用日期已验证的嵌套对比数据）：

```json
{"scope":{"stations":["123-US"]},"period":{"preset":"CU","from":"2026-09-13","to":"2026-09-13"},"view":{"dimension":"market","chainType":"DAILY"},"fields":["dataPeriodFrom","dataPeriodTo"]}
```

近7天店铺汇总使用同一请求形状，窗口替换为 `2026-09-07` 至 `2026-09-13`；前7天为 `2026-08-31` 至 `2026-09-06`。无需向 `query_store_performance` 传 `period.compare` 来强行指定对比期：当前适配层不将其传给后端。

近7天趋势和全范围销售额 Top5：

```json
{"scope":{"stations":["123-US"]},"period":{"preset":"CU","from":"2026-09-07","to":"2026-09-13"},"view":{"groupBy":"SKU","summary":"DAILY"},"sort":{"field":"revenue","direction":"desc"},"page":{"number":1,"size":5}}
```

单站点近7天广告（下列参数仍需与当前 campaign 契约核对）：

```json
{"entity":"campaign","params":{"sellerId":123,"marketplace":"US","dateType":"CU","fromDateStr":"2026-09-07","toDateStr":"2026-09-13","campaignStatus":"notArchived","page":1,"pageSize":5,"orderField":"cost","orderFlag":2}}
```

- `notArchived` 包含启用/暂停的未归档活动，排除归档活动。汇总也受该筛选影响，不要求它与店铺广告花费完全一致。
- 商品/广告 Top5 应由服务端排序后分页，不能在未排序的默认第一页里取“全店 Top5”。若服务端不支持该排序，注明无法确认全局排名；不要以页内排序冒充。
- 广告总览用返回的 `summary`，不要把5条活动之和当总计。若汇总缺失，显示缺失并保留活动明细。
- 多站点广告逐站点顺序查询；商品和店铺的合并查询必须具备可比较的日期和币种。跨站点合并后的趋势不能标为某一个站点的趋势。

## 当前库存查询示例

调用 `query_inventory`，不传 `period`。默认逐站点覆盖未删除的 FBA 商品，包含停售商品，不设置 `productSaleStatus` 或 `inventoryHealth` 筛选。下面是第一页，按实际 `ps` 分页继续获取；只查第一页不能生成全范围库龄统计。

```json
{
  "multiStations": ["123-US"],
  "fulfillment": "AFN",
  "del": "N",
  "groupByField": "SKU",
  "page": 1,
  "pageSize": 100,
  "orderField": "sellerSku",
  "orderFlag": 1,
  "includeSummary": true,
  "includeFieldMeta": true,
  "selectFields": [
    "id", "sellerId", "marketplace", "sellerSku", "fnSku", "fulfillment", "productStatus", "shareInventory",
    "currency", "stockValue", "supplyTotal", "supplyInstock", "supplyInbound", "supplyReserved", "supplyUnavailable",
    "salesUnits7d", "salesUnits30d", "salesVelocity", "estimateSaleDays", "estimateSaleDaysTotal", "inventoryHealth",
    "preparationDays", "purchaseQuantity", "purchaseDate", "toFBAQuantity", "toFBAQuantityDate",
    "inventoryAge0To30Days", "inventoryAge31To60Days", "inventoryAge61To90Days", "inventoryAge91To180Days",
    "inventoryAge181To270Days", "inventoryAge271To365Days", "inventoryAge365PlusDays"
  ]
}
```

- 当前库存数量、可售天数、健康状态、库龄和补货建议统一由此查询。`AFN` 是请求参数，响应的 `fulfillment` 为 `FBA`；`MFN` 对应 `FBM`。
- 请求列同时用于裁剪 `inventoryStatistics`，所以需要的汇总字段也必须选入。`stockValue/currency/shareInventory` 不是默认明细列；不用 `selectFields` 时通过 `includeFields` 追加。
- 不把 `productSyncTime` 当库存更新时间，它表示商品信息同步时间；没有明确库存同步时间时只记录查询开始、结束时间并注明同步时效未知。
- 完整分页、汇总与明细的覆盖差异、库龄分母和风险解释按 [库存与库龄分析](inventory-analysis.md) 执行。

## 拆解响应包装

先检查 MCP 的 `isError`，再读取 `structuredContent`；没有结构化内容时解析 `content` 中的 JSON 文本块，跳过非 JSON 的提示文字。解析后还要检查包装层的业务失败标记，例如 `success:false` 或错误码；失败不能被当作空报表。

当前公开业务工具常见结构如下（`payload` 指解析后的工具 JSON）：

```text
payload = { tool, request, data: { success, data: 业务数据 } }
业务数据 = payload.data.data
```

旧版或门面可能直接返回 `{success,data:业务数据}`、`{tool,data:业务数据}` 或业务数据本身。只沿已识别的外层包装拆解，通过目标结构（`summary/salesData`、`summary/pg`、`summary/list`、`ps/inventoryStatistics`）确认到达业务层后停止；不要递归删除所有名为 `data` 的字段或静默吞掉未知结构。

后文统一称拆解后的业务层为 `body`：

- **店铺**：当前 `body.summary`；对应对比数据 `body.summary.chainSummary`、`body.summary.chainRate`。多站点明细是 `body.salesData[]`，每行自己的环比在 `row.chainSummary/chainRate`。不能拿总汇总的环比填站点行。嵌套对比缺失时从独立的前日/前7天查询结果取 `body.summary` 或对应站点行。
- **商品**：全查询范围趋势 `body.summary.dateDims[]`；商品页 `body.pg.items[]`；分页信息在 `body.pg.currentPage/pageCount/totalCount`。不要取商品行内的 `dateDims` 当全店趋势。`summary` 缺失不代表第一页就是全部商品。
- **广告**：筛选范围汇总 `body.summary`；活动页 `body.list.items[]`。
- **库存**：明细 `body.ps.items[]`，分页 `body.ps.currentPage/pageCount/pageSize/totalCount`，筛选范围汇总 `body.inventoryStatistics`。它不是 `summary` 或 `pg`；库龄和健康状态计数不能假定在汇总中存在。
- **店铺发现**：常见 `{success:true,data:[店铺...]}`，授权站点数组为 `authMarkets`，实际字段以返回为准；`marketplace/code` 是 US/DE 等站点代码，`timezone` 是站点时区。

## 字段与展示单位

以下路径相对于上节的 `body`；空值/缺字段/空字符串显示“—”，真实数值0不能丢失。数值字符串仅在能完整解析为有限十进制数时转换，不能用 `parseFloat` 接受带百分号或货币符号的文本；无法确认单位或非有限数值应注明不可用。

- 店铺：订单 `orders`、销量 `units`、销售额 `revenue`、广告花费 `cpcCost`、广告销售额 `adCpcSales`、ACoS `adAcos`、ROAS `roas`、利润 `profit`、利润率 `margin`、退款件数 `unitsRefund`、流量 `sessions`。
- 商品/逐日：日期 `dailyStr`、订单 `productOrders`、销量 `units`、销售额 `revenue`、广告花费 `adCost`、广告销售额 `adCpcSales`、利润 `profit`、ACoS `adAcos`；商品身份为 `sellerSku/productTitle`，排名 `bsr`。不要把商品订单字段改用店铺的 `orders`。
- 广告：花费 `cost`、广告销售额 `cpcSales`、广告订单 `cpcOrder`、曝光 `impressions`、点击 `clicks`、ACoS `acos`、ROAS `roas`、CPC `cpc`、CTR `ctr`、CVR `cvr`。**广告 cost 是广告花费，店铺/商品 cost 是总成本**，不能互换。
- 金额（含 CPC）：按对应响应的币种保留2位小数，用 `USD 31.96`、`EUR 31.96` 等明确币种表达；不能默认美元。币种缺失时注明“币种未返回”，不猜符号、不换算。
- 百分比：仅 ACoS、CTR、CVR、利润率等比例字段的小数值乘100，保留2位；单位以当前字段元数据为准。**CPC 是金额、ROAS 是倍数**（如 `3.25×`），两者不乘100。
- 订单、销量、曝光、点击等为计数；BSR 是排名；`unitsRefund` 是退款件数，不是退款订单数。

## 环比与合并

- 只有当前/对比值均有效、日期窗口已确认且上一周期值大于0时，才能展示 `(当前 ÷ 上期 − 1) × 100%`。若单位、币种或覆盖范围不同，显示“—”。
- 当前接口的 `chainRate.*Rate` 是当前÷上期的**比值**，需减1后再转百分比，不是已算好的增长率；缺少有效上期或未确认窗口时不能单凭比值输出环比。可优先用两期原始指标计算，并用返回比值核对。
- 当前利润为负、上期为正时仍可计算负增长；上期为零/负数时显示“—”，可描述“由亏转盈”等事实。
- ACoS、利润率等比例指标优先展示两期差值的**百分点**（如30%至25%为 −5.00 个百分点），列标题写“变化”，避免与销售额增长率混淆。
- 不对多个站点的 ACoS/ROAS/CTR 做算术平均。合并时仅在同币种、同时间及同归因口径下由加总分子分母重算，分母为0显示“—”；否则分站点展示。
- 时间、站点、币种、归档过滤等口径不同的汇总不强行对平；记录数据同步时效和缺项。利润依赖后台成本配置，空利润不能解释为零利润。
