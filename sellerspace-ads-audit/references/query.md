# 查询与运行契约

## 依赖与参数适配

由宿主先验证优麦云 MCP 的业务能力，再把逻辑角色绑定到当前实际工具名。工具名可任意命名；下列角色是本地记录键，不是对安装名称的要求。

- `get_stores`：返回店铺 `sellerId`、名称及授权站点 `marketplace`，站点数组当前为 `authMarkets`，兼容 `authMarketDtos`。
- `query_ads`：当前参数为 `{entity, params}`，六类实体为 `campaign/adGroup/productAds/keywords/targets/searchQuery`。除广告组外，排序参数是 `orderField: "cost"`、`orderFlag: 2`；广告组使用 `orderByField: "cost"`、`orderType: 2`。按实体 schema 分别校验，不能统一猜测。
- `query_store_performance`：当前支持 `scope.stations`、`period` 和 `view`。
- `get_metric_history`：接受 `sellerId/marketplace/adDataType/id/dimension/timeType/fromDateStr/toDateStr`；日趋势和广告位共用此工具。

首次调用前，通过该服务的能力发现工具或宿主暴露的 schema 核对这些结构。支持 `discover_capabilities` 时，可按 `adsEntity` 查询各实体的 `paramsSchema`；不要求这个发现工具的安装名或前缀固定。若实际契约不兼容，停止并说明缺少的能力或版本差异，不能猜参数或改走 HTTP。不要依赖宿主未公开的桥接接口。

本地脚本仅检查数据和绑定是否齐全，不能通过 JSON 中的声明证明工具在线；宿主必须先发现并成功调用真实店铺工具。禁止手工伪造依赖、响应、行数或补造指标。

## 本次数据文件

新建一个独立 JSON 文件；下方工具名是占位说明，使用实际发现结果替换。店铺响应使用本次真实调用结果，不能照抄示例数据。

```json
{
  "schemaVersion": 1,
  "startedAt": "2026-09-13T06:00:00.000Z",
  "mcpTools": {
    "get_stores": "实际店铺工具名",
    "query_ads": "实际广告工具名",
    "query_store_performance": "实际站点表现工具名",
    "get_metric_history": "实际历史工具名"
  },
  "storesResult": {
    "structuredContent": {
      "success": true,
      "data": [
        {
          "sellerId": 123,
          "storeName": "示例店铺",
          "authMarkets": [
            {"marketplace": "US", "timezone": "America/Los_Angeles"}
          ]
        }
      ]
    }
  },
  "scope": {"sellerId": 123, "marketplace": "US"},
  "targetAcos": "30%",
  "period": {"dateType": "NM"},
  "responses": []
}
```

- `startedAt` 在整个体检期间保持不变；时区优先使用店铺返回值，缺失时只使用脚本中已知站点映射，未知站点停止。
- 日期默认近 30 天；自定义使用 `{"dateType":"CU","from":"2026-08-01","to":"2026-08-31"}`。
- 不要预先把目标重复换算。保留用户原始 `targetAcos` 输入，尤其是 `150%`。
- 可选顶层 `adType` 为 `SP/SB/SD`，不填即查询全部。
- 站点标识由真实店铺结果计算；不接收另一个手写的站点字符串。
- 文件只保存当前体检的只读结果。使用宿主提供的文件写入工具或结构化序列化，将 JSON 原样落盘；不要把业务名称拼成可执行 shell 代码。数据超过脚本内存输入上限时停止并说明，不能截断成部分报告。

## 请求与结果的循环

运行 `node <技能目录>/scripts/sellerspace-cli.mjs audit <数据文件>`。也可省略文件路径，改从 stdin 传入 JSON。

返回 `complete=false` 时，`requests` 中每项包含 `requestId`、`tool` 和 `arguments`。通过宿主原生工具调用执行它，成功后在 `responses` 加入：

```json
{
  "requestId": "原请求的 requestId",
  "tool": "原请求的 tool",
  "arguments": {"保留": "原请求的完整参数"},
  "result": {"保留": "宿主实际返回的完整 MCP 结果"}
}
```

不要修改已有成功记录；失败重试成功后只保存成功结果，不伪造成功。每轮请求全部处理后重新运行脚本。核心字段缺失、失败响应或范围错配均不能静默跳过。

接收的结果可为宿主的 `structuredContent`、单个 JSON 文本 `content`，或宿主已解包的同一个 JSON 对象。脚本只识别明确结构：

- 广告列表：MCP 业务对象 `data.data.summary`、`data.data.list.items` 及分页元数据。
- 站点表现：`data.data.summary`。不使用 `salesData` 明细或 `chainSummary` 环比替代当前汇总。
- 日趋势/广告位：`data.list`。
- MCP `isError=true`、业务 `success=false/ok=false` 或错误对象：停止，不回显可能包含凭据的原始错误内容。

完整成功后返回 `complete=true` 和报告内容；此前的计划只是中间步骤。

## 查询顺序与范围

1. 先完整分页查询启用广告活动；没有活动时结束，不查询经营汇总、子实体、趋势或广告位。
2. 有活动时查询当前站点经营汇总，以及五类子实体。每页最多 100 行，按花费降序；其他实体达到至少 90% 花费覆盖或末页后停止。
3. 根据引擎输出的证据计划查询活动日趋势、SP 活动广告位，以及暂停候选所需的推广商品日趋势。
4. 最后编译诊断结果。缺少任何已计划查询时不会返回最终报告。

所有查询使用体检开始时、站点当地日历计算出的同一明确起止日，以 `CU` 传入，避免跨午夜改变范围。原始日期预设仍在报告中保留。经营总览不按广告状态和类型过滤，必须与启用广告汇总分开标注。

状态过滤由本地计划固定：
- 活动：`campaignStatus=enabled`。
- 广告组：再加 `adGroupStatus=enabled`。
- 推广商品、关键词、投放：再加 `status=enabled`。
- 搜索词：只筛活动与广告组启用状态，并固定 `searchKeywordsType=query`。

日趋势显式取回 `overBudgetTime/overBudgetTimeMinute/campaignBudget`，否则 MCP 的默认精简结果无法支持历史预算结论。

## 身份与覆盖

每行原始字段保留，并补充本地 `canonical` 身份：
- 活动、广告组、商品广告、关键词、投放分别使用 `campaignId/adGroupId/adId/keywordId/targetId`。
- 关键词名称使用 `keywordsText`，兼容 `keywordText`；匹配类型使用返回的 `keywordsMatchType/matchType/matchTypeStr`。
- 搜索词名称只能来自 `query`，不能用来源关键词替代。历史标识只使用 MCP 返回的 `id`，不自行拼接。
- 搜索词来源关键词/投放标识，可从返回字段或已核对的复合 `id` 中读取。缺失标识保留为空；不得猜造。
- 搜索词是 ASIN 还是文字，只用返回的 `queryIsAsin`，缺失时不生成类型相关的提词或否定建议。

去重保留实体标识及活动、广告组位置。花费覆盖按唯一行花费与汇总花费计算，缺失汇总为未知。末页只有唯一行数等于后端总数才算完整；总数变动、分页重复或停滞都停止。达到 90% 花费覆盖不代表每个活动的子项都已查全，不能据此断言某个活动没有有效子项。
