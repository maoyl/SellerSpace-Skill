const ENTITY_LABELS = {
  campaign: "Campaign",
  adGroup: "广告组",
  productAds: "推广商品",
  keywords: "关键词",
  targets: "商品投放",
  searchQuery: "搜索词",
};

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2 };

export function normalizeTargetAcos(value) {
  let parsed;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) throw new Error("targetAcos 不能为空。");
    parsed = normalized.endsWith("%")
      ? Number(normalized.slice(0, -1)) / 100
      : Number(normalized);
  } else {
    parsed = Number(value);
  }
  if (Number.isFinite(parsed) && parsed > 1) parsed /= 100;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10) {
    throw new Error("targetAcos 必须是正数，例如 0.3、30 或 30%。");
  }
  return round(parsed, 6);
}

export function planAuditDrilldowns({ collections, storePerformance, targetAcos }) {
  const target = normalizeTargetAcos(targetAcos);
  const account = normalizeAccount(storePerformance, collections?.campaign?.summary);
  const minClicks = computeMinClicks(account.cvr);
  const base = buildBaseAnalysis(collections, target, account, minClicks);
  const campaigns = rowsFor(collections, "campaign");
  const reasonsByCampaign = new Map();

  const addReason = (campaignId, reason) => {
    if (!campaignId) return;
    if (!reasonsByCampaign.has(campaignId)) reasonsByCampaign.set(campaignId, new Set());
    reasonsByCampaign.get(campaignId).add(reason);
  };

  for (const candidate of base.candidates) {
    addReason(candidate.entity.campaignId, `${candidate.priority} ${candidate.actionLabel}`);
  }
  for (const campaign of campaigns) {
    const metrics = metricsOf(campaign);
    const campaignId = campaign.canonical?.campaignId;
    if (metrics.orders >= 3 && metrics.acos !== null && metrics.acos <= target) {
      addReason(campaignId, "验证是否存在预算受限扩量机会");
    }
    if (
      (metrics.orders >= 2 && metrics.acos !== null && metrics.acos >= target * 1.2)
      || (metrics.orders === 0 && metrics.clicks >= minClicks)
    ) {
      addReason(campaignId, "验证低效是否持续并补充趋势证据");
    }
  }

  const campaignHistory = campaigns
    .filter((row) => reasonsByCampaign.has(row.canonical?.campaignId))
    .map((row) => ({
      id: row.canonical.campaignId,
      name: row.canonical.campaignName,
      adType: canonicalText(row.adType),
      reasons: [...reasonsByCampaign.get(row.canonical.campaignId)],
    }));

  return {
    campaignHistory,
    campaignPlacement: campaignHistory.filter(({ adType }) => adType === "SP"),
  };
}

export function compileAuditAnalysis({
  scope,
  period,
  targetAcos,
  storePerformance,
  collections,
  campaignHistories = {},
  campaignPlacements = {},
  drilldownPlan = [],
  businessCallCount = 0,
}) {
  const target = normalizeTargetAcos(targetAcos);
  const account = normalizeAccount(storePerformance, collections?.campaign?.summary);
  const minClicks = computeMinClicks(account.cvr);
  const base = buildBaseAnalysis(collections, target, account, minClicks);
  const campaigns = rowsFor(collections, "campaign");
  const campaignById = new Map(campaigns.map((row) => [row.canonical?.campaignId, row]));
  const drilldownReasons = new Map(
    asArray(drilldownPlan).map((item) => [item.id, asArray(item.reasons)]),
  );
  const constrainedByCampaign = new Map();
  const trendEvidence = [];

  for (const [campaignId, rows] of Object.entries(campaignHistories)) {
    const campaign = campaignById.get(campaignId);
    if (!campaign) continue;
    const constrainedDays = countBudgetConstrainedDays(rows);
    constrainedByCampaign.set(campaignId, constrainedDays);
    const metrics = metricsOf(campaign);
    trendEvidence.push({
      campaignId,
      campaignName: campaign.canonical?.campaignName,
      daysAnalyzed: Array.isArray(rows) ? rows.length : 0,
      constrainedDays,
      selectionReasons: drilldownReasons.get(campaignId) ?? [],
      recent: asArray(rows).slice(-7).map(compactTrendPoint),
    });

    if (
      metrics.orders >= 3
      && metrics.acos !== null
      && metrics.acos <= target
      && constrainedDays >= 2
    ) {
      base.candidates.push(candidate({
        action: "increase-budget",
        actionLabel: "建议提高预算",
        priority: "P3",
        dimension: "budget",
        entity: entityOf(campaign),
        title: `${displayName(campaign)}：建议提高预算`,
        reasons: [
          `近${period?.label ?? "本期"} ACoS ${percent(metrics.acos)}，达到目标 ${percent(target)}。`,
          `${rows.length} 个日数据点中有 ${constrainedDays} 天出现明确预算受限证据。`,
        ],
        evidence: evidenceOf(metrics, target, {
          budgetConstrainedDays: constrainedDays,
          historyDays: rows.length,
          dailyBudget: finiteOrNull(campaign.dailyBudget),
        }),
        risk: "提高预算会放大现有流量结构；调整后仍需观察 ACoS 是否继续达标。",
        confidence: "high",
        materialCost: metrics.cost,
      }));
    }
  }

  addPlacementCandidates({
    candidates: base.candidates,
    campaignPlacements,
    campaignById,
    target,
  });
  addIncreaseBidCandidates({
    candidates: base.candidates,
    collections,
    constrainedByCampaign,
    target,
  });
  addCampaignFallbackCandidates({
    candidates: base.candidates,
    campaigns,
    collections,
    campaignHistories,
    target,
    minClicks,
  });

  const recommendations = finalizeCandidates(base.candidates);
  const observations = finalizeObservations(base.observations);
  const coverage = buildCoverage(collections);
  const ratings = buildRatings({ recommendations, observations, coverage, account, target });

  return {
    ok: true,
    analysisMode: "deterministic-evidence-driven",
    scope: {
      ...scope,
      targetAcos: target,
      period,
    },
    thresholds: {
      targetAcos: target,
      minClicks,
      minimumAcosOrders: 2,
      minimumExpansionOrders: 3,
      negativeSearchTermClicks: Math.max(20, minClicks),
      spendCoverageTarget: 0.9,
    },
    accountSummary: account,
    ratings,
    recommendations,
    observations,
    dataPreview: buildDataPreview(collections, recommendations),
    trendEvidence,
    coverage,
    auditMeta: {
      businessCallCount,
      recommendationCount: recommendations.length,
      drilldownCampaignCount: Object.keys(campaignHistories).length,
      generatedAt: new Date().toISOString(),
      decisionOwner: "bundled deterministic audit engine",
      presentationRowsPerEntity: 5,
    },
  };
}

function buildBaseAnalysis(collections, target, account, minClicks) {
  const candidates = [];
  const observations = [];

  addLeafBidCandidates(candidates, observations, collections, "keywords", target, minClicks);
  addLeafBidCandidates(candidates, observations, collections, "targets", target, minClicks);
  addPromotedProductCandidates(candidates, observations, collections, target, minClicks);
  addAutomaticAdGroupCandidates(candidates, collections, target, minClicks);
  addSearchTermCandidates(candidates, observations, collections, target, minClicks);
  addCrossContextCandidates(candidates, collections, target, minClicks);
  addRelativeSignals(observations, collections, account, minClicks);
  addStructureObservation(candidates, observations, collections);
  addCoverageObservations(observations, collections);

  return { candidates, observations };
}

function addLeafBidCandidates(candidates, observations, collections, entity, target, minClicks) {
  const collection = collections?.[entity];
  const summaryCost = metricsOf(collection?.summary).cost;
  let missingNames = 0;
  for (const row of rowsFor(collections, entity)) {
    const name = displayName(row);
    const metrics = metricsOf(row);
    if (!name) {
      if (metrics.cost > 0) missingNames += 1;
      continue;
    }
    const share = summaryCost > 0 ? metrics.cost / summaryCost : null;
    const targetMiss = metrics.orders >= 2
      && metrics.acos !== null
      && metrics.acos >= target * 1.2;
    const zeroOrderWaste = metrics.orders === 0 && metrics.clicks >= minClicks;
    if (!targetMiss && !zeroOrderWaste) continue;

    const severe = (
      targetMiss && metrics.acos >= target * 1.5 && share !== null && share >= 0.05
    ) || (zeroOrderWaste && share !== null && share >= 0.05);
    const reasons = targetMiss
      ? [
          `ACoS ${percent(metrics.acos)}，高于目标 ${percent(target)}，且已有 ${metrics.orders} 个归因订单。`,
        ]
      : [
          `${metrics.clicks} 次点击仍无归因订单，已达到样本门槛 ${minClicks} 次点击。`,
        ];
    if (share !== null && share >= 0.02) {
      reasons.push(`花费占该实体已分析花费 ${percent(share)}，具有实际影响。`);
    }
    candidates.push(candidate({
      action: "lower-bid",
      actionLabel: "建议降低竞价",
      priority: severe ? "P1" : "P2",
      dimension: zeroOrderWaste ? "conversion" : "efficiency",
      entity: entityOf(row),
      title: `${ENTITY_LABELS[entity]}「${name}」：建议降低竞价`,
      reasons,
      evidence: evidenceOf(metrics, target, {
        costShare: share,
        currentBid: finiteOrNull(row.bid ?? row.defaultBid),
        matchType: row.canonical?.keywordMatchType ?? row.canonical?.targetType ?? null,
      }),
      risk: "降低竞价可能减少曝光；应在最小实体范围调整并继续观察转化。",
      confidence: coverageConfidence(collection),
      materialCost: metrics.cost,
    }));
  }
  if (missingNames > 0) {
    observations.push(observation(
      `${entity}-missing-name`,
      `${ENTITY_LABELS[entity]}文本存在缺失`,
      `${missingNames} 个有花费的${ENTITY_LABELS[entity]}行缺少规范名称，已保留指标但未生成无法准确定位的操作建议。`,
      "data-quality",
    ));
  }
}

function addPromotedProductCandidates(candidates, observations, collections, target, minClicks) {
  const rows = rowsFor(collections, "productAds");
  const summaryCost = metricsOf(collections?.productAds?.summary).cost;
  const siblings = groupBy(rows, (row) => row.canonical?.adGroupId);
  let missingAsin = 0;
  for (const row of rows) {
    const asin = row.canonical?.asin;
    const metrics = metricsOf(row);
    if (!asin) {
      if (metrics.cost > 0) missingAsin += 1;
      continue;
    }
    const peers = siblings.get(row.canonical?.adGroupId) ?? [];
    const winner = peers.find((peer) => {
      if (peer === row) return false;
      const peerMetrics = metricsOf(peer);
      return peerMetrics.orders >= 3 && peerMetrics.acos !== null && peerMetrics.acos <= target;
    });
    const severe = (
      metrics.orders >= 2 && metrics.acos !== null && metrics.acos >= target * 1.5
    ) || (metrics.orders === 0 && metrics.clicks >= minClicks);
    if (!severe || !winner) continue;
    const share = summaryCost > 0 ? metrics.cost / summaryCost : null;
    candidates.push(candidate({
      action: "pause",
      actionLabel: "建议暂停推广商品",
      priority: share !== null && share >= 0.05 ? "P1" : "P2",
      dimension: "conversion",
      entity: entityOf(row),
      title: `推广商品 ${asin}：建议暂停`,
      reasons: [
        metrics.orders === 0
          ? `${metrics.clicks} 次点击仍无归因订单。`
          : `ACoS ${percent(metrics.acos)}，达到目标 ${percent(target)} 的 ${multiple(metrics.acos / target)}。`,
        `同一广告组内商品 ${winner.canonical?.asin ?? displayName(winner)} 已达到目标，可优先保留有效流量。`,
      ],
      evidence: evidenceOf(metrics, target, {
        costShare: share,
        siblingWinner: previewRow(winner),
      }),
      risk: "暂停前应确认库存、价格、购物车和详情页状态；这些数据不在本次广告体检范围内。",
      confidence: coverageConfidence(collections?.productAds),
      materialCost: metrics.cost,
    }));
  }
  if (missingAsin > 0) {
    observations.push(observation(
      "product-asin-missing",
      "推广商品 ASIN 存在缺失",
      `${missingAsin} 个有花费的推广商品行缺少 ASIN，未生成商品级暂停建议。`,
      "data-quality",
    ));
  }
}

function addAutomaticAdGroupCandidates(candidates, collections, target, minClicks) {
  const keywords = rowsFor(collections, "keywords");
  const targets = rowsFor(collections, "targets");
  const existingLocations = new Set(candidates.map((item) => locationKey(item.entity)));
  const summaryCost = metricsOf(collections?.adGroup?.summary).cost;
  for (const row of rowsFor(collections, "adGroup")) {
    const metrics = metricsOf(row);
    const location = locationKey(entityOf(row));
    if (existingLocations.has(location)) continue;
    const children = [...keywords, ...targets].filter(
      (child) => child.canonical?.adGroupId === row.canonical?.adGroupId && metricsOf(child).cost > 0,
    );
    const auto = children.some((child) => {
      const type = String(
        child.canonical?.keywordMatchType
        ?? child.canonical?.targetType
        ?? child.originalTargetType
        ?? "",
      ).toLowerCase();
      return type.includes("auto") || type.includes("close") || type.includes("loose")
        || type.includes("substitute") || type.includes("complement");
    });
    const sampledChildren = children.filter((child) => {
      const childMetrics = metricsOf(child);
      return childMetrics.orders >= 2 || childMetrics.clicks >= minClicks;
    });
    const allPoor = sampledChildren.length > 0 && sampledChildren.every((child) => {
      const childMetrics = metricsOf(child);
      return (childMetrics.orders >= 2 && childMetrics.acos !== null && childMetrics.acos >= target * 1.2)
        || (childMetrics.orders === 0 && childMetrics.clicks >= minClicks);
    });
    if (!auto || !allPoor || metrics.orders < 2 || metrics.acos === null || metrics.acos < target * 1.2) {
      continue;
    }
    const share = summaryCost > 0 ? metrics.cost / summaryCost : null;
    candidates.push(candidate({
      action: "lower-bid",
      actionLabel: "建议降低广告组默认竞价",
      priority: metrics.acos >= target * 1.5 && share !== null && share >= 0.05 ? "P1" : "P2",
      dimension: "efficiency",
      entity: entityOf(row),
      title: `广告组「${displayName(row)}」：建议降低默认竞价`,
      reasons: [
        `广告组 ACoS ${percent(metrics.acos)}，高于目标 ${percent(target)}。`,
        `${sampledChildren.length} 个达到样本门槛的自动投放子项表现方向一致，适合在广告组层面控制流量成本。`,
      ],
      evidence: evidenceOf(metrics, target, {
        costShare: share,
        sampledChildCount: sampledChildren.length,
        currentDefaultBid: finiteOrNull(row.defaultBid ?? row.bid),
      }),
      risk: "广告组默认竞价会影响多类自动流量；若子项表现分化，应改为处理具体搜索词或投放目标。",
      confidence: coverageConfidence(collections?.adGroup),
      materialCost: metrics.cost,
    }));
  }
}

function addSearchTermCandidates(candidates, observations, collections, target, minClicks) {
  const negativeGate = Math.max(20, minClicks);
  const summaryCost = metricsOf(collections?.searchQuery?.summary).cost;
  let missingTerms = 0;
  let missingPositiveState = 0;
  let missingNegativeState = 0;
  for (const row of rowsFor(collections, "searchQuery")) {
    const term = row.canonical?.searchTermText;
    const metrics = metricsOf(row);
    if (!term) {
      if (metrics.cost > 0) missingTerms += 1;
      continue;
    }
    const campaignId = row.canonical?.campaignId;
    const adGroupId = row.canonical?.adGroupId;
    const positiveCampaigns = idList(row.positiveCampaignIdList);
    const positiveAdGroups = idList(row.positiveAdGroupIdList);
    const negativeCampaigns = idList(row.negativeCampaignIdList);
    const negativeAdGroups = idList(row.negativeAdGroupIdList);
    const positiveStateKnown = isIdListValue(row.positiveCampaignIdList)
      && isIdListValue(row.positiveAdGroupIdList);
    const negativeStateKnown = isIdListValue(row.negativeCampaignIdList)
      && isIdListValue(row.negativeAdGroupIdList);
    const targetedAnywhere = positiveCampaigns.length > 0 || positiveAdGroups.length > 0;
    const negativeAtSource = negativeCampaigns.includes(campaignId) || negativeAdGroups.includes(adGroupId);

    if (metrics.orders >= 3 && metrics.acos !== null && metrics.acos <= target) {
      if (!positiveStateKnown) {
        missingPositiveState += 1;
      } else if (!targetedAnywhere) {
        const product = row.canonical?.queryIsAsin === "Y";
        candidates.push(candidate({
          action: "harvest-search-term",
          actionLabel: product ? "建议提取为精准商品投放" : "建议提取为精准关键词",
          priority: "P3",
          dimension: "structure",
          entity: entityOf(row),
          title: `搜索词「${term}」：${product ? "建议单独商品投放" : "建议单独精准投放"}`,
          reasons: [
            `${metrics.orders} 个归因订单，ACoS ${percent(metrics.acos)}，达到目标 ${percent(target)}。`,
            "返回的正向 Campaign 和广告组列表均未显示该搜索词已被单独投放。",
          ],
          evidence: evidenceOf(metrics, target, {
            queryIsAsin: row.canonical?.queryIsAsin,
            positiveCampaignIds: positiveCampaigns,
            positiveAdGroupIds: positiveAdGroups,
          }),
          risk: "新建精准投放时应同时规划原发现来源的流量隔离，避免重复竞价。",
          confidence: coverageConfidence(collections?.searchQuery),
          materialCost: metrics.cost,
          normalizedObject: normalizedSearchTerm(row),
        }));
      } else {
        observations.push(observation(
          `search-targeted-${normalizedSearchTerm(row)}-${campaignId}-${adGroupId}`,
          `搜索词「${term}」表现达标且已投放`,
          `ACoS ${percent(metrics.acos)}；已投放位置已记录，不建议重复创建。`,
          "already-targeted",
        ));
      }
    }

    if (metrics.orders === 0 && metrics.clicks >= negativeGate && !negativeStateKnown) {
      missingNegativeState += 1;
    } else if (metrics.orders === 0 && metrics.clicks >= negativeGate && !negativeAtSource) {
      const share = summaryCost > 0 ? metrics.cost / summaryCost : null;
      candidates.push(candidate({
        action: "negative-search-term",
        actionLabel: row.canonical?.queryIsAsin === "Y"
          ? "建议在来源位置加入否定精准商品投放"
          : "建议在来源位置加入否定精准关键词",
        priority: share !== null && share >= 0.05 ? "P1" : "P2",
        dimension: "conversion",
        entity: entityOf(row),
        title: `搜索词「${term}」：建议在来源广告组否定精准`,
        reasons: [
          `${metrics.clicks} 次点击仍无归因订单，超过否定候选门槛 ${negativeGate} 次点击。`,
          "来源 Campaign/广告组的否定列表未显示该搜索词已被否定。",
        ],
        evidence: evidenceOf(metrics, target, {
          costShare: share,
          negativeCampaignIds: negativeCampaigns,
          negativeAdGroupIds: negativeAdGroups,
          queryIsAsin: row.canonical?.queryIsAsin,
        }),
        risk: "默认只建议否定精准；否定词组可能误伤包含该短语的转化搜索词。",
        confidence: coverageConfidence(collections?.searchQuery),
        materialCost: metrics.cost,
        normalizedObject: normalizedSearchTerm(row),
      }));
    }
  }
  if (missingTerms > 0) {
    observations.push(observation(
      "search-term-text-missing",
      "搜索词文本未完整同步",
      `${missingTerms} 个有花费的搜索词行缺少 canonical.searchTermText；这些行只参与汇总，不生成提词或否词建议。`,
      "data-quality",
    ));
  }
  if (missingPositiveState > 0) {
    observations.push(observation(
      "search-positive-state-missing",
      "搜索词正向投放位置状态缺失",
      `${missingPositiveState} 个达标搜索词缺少完整 positiveCampaignIdList/positiveAdGroupIdList，未生成可能重复的提词建议。`,
      "data-quality",
    ));
  }
  if (missingNegativeState > 0) {
    observations.push(observation(
      "search-negative-state-missing",
      "搜索词否定位置状态缺失",
      `${missingNegativeState} 个止损候选缺少完整 negativeCampaignIdList/negativeAdGroupIdList，未生成可能重复的否定建议。`,
      "data-quality",
    ));
  }
}

function addCrossContextCandidates(candidates, collections, target, minClicks) {
  const summaryCost = metricsOf(collections?.searchQuery?.summary).cost;
  const grouped = groupBy(
    rowsFor(collections, "searchQuery").filter((row) => row.canonical?.searchTermText),
    normalizedSearchTerm,
  );
  for (const [normalized, rows] of grouped) {
    const winner = rows.find((row) => {
      const metrics = metricsOf(row);
      return metrics.orders >= 3 && metrics.acos !== null && metrics.acos <= target;
    });
    const loser = rows.find((row) => {
      if (winner && locationKey(entityOf(row)) === locationKey(entityOf(winner))) return false;
      const metrics = metricsOf(row);
      return (metrics.orders >= 2 && metrics.acos !== null && metrics.acos >= target * 1.2)
        || (metrics.orders === 0 && metrics.clicks >= Math.max(20, minClicks));
    });
    if (!winner || !loser) continue;
    if (
      !isIdListValue(loser.negativeCampaignIdList)
      || !isIdListValue(loser.negativeAdGroupIdList)
    ) continue;
    const loserAlreadyNegative = idList(loser.negativeCampaignIdList)
      .includes(loser.canonical?.campaignId)
      || idList(loser.negativeAdGroupIdList).includes(loser.canonical?.adGroupId);
    if (loserAlreadyNegative) continue;
    const term = winner.canonical.searchTermText;
    const loserMetrics = metricsOf(loser);
    const loserShare = summaryCost > 0 ? loserMetrics.cost / summaryCost : null;
    const severe = (
      (loserMetrics.orders === 0 && loserMetrics.clicks >= Math.max(20, minClicks))
      || (loserMetrics.orders >= 2 && loserMetrics.acos !== null && loserMetrics.acos >= target * 1.5)
    ) && loserShare !== null && loserShare >= 0.05;
    candidates.push(candidate({
      action: "isolate-search-term",
      actionLabel: "建议保留赢家并隔离输家流量",
      priority: severe ? "P1" : "P2",
      dimension: "structure",
      entity: entityOf(loser),
      title: `搜索词「${term}」：建议按投放位置拆分处理`,
      reasons: [
        `在「${locationLabel(winner)}」中 ACoS ${percent(metricsOf(winner).acos)}，达到目标。`,
        `在「${locationLabel(loser)}」中 ${loserReason(metricsOf(loser), target)}。`,
      ],
      evidence: {
        targetAcos: target,
        loserCostShare: loserShare,
        comparisonEvidence: {
          winner: previewRow(winner),
          loser: previewRow(loser),
        },
      },
      risk: "只在输家来源的最小安全范围隔离，不能在仍包含赢家流量的 Campaign 层级全局否定。",
      confidence: coverageConfidence(collections?.searchQuery),
      materialCost: metricsOf(loser).cost,
      normalizedObject: normalized,
    }));
  }
}

function addRelativeSignals(observations, collections, account, minClicks) {
  const campaignSummaryCost = metricsOf(collections?.campaign?.summary).cost;
  for (const row of rowsFor(collections, "campaign")) {
    const metrics = metricsOf(row);
    const share = campaignSummaryCost > 0 ? metrics.cost / campaignSummaryCost : null;
    if (
      account.ctr !== null
      && account.ctr > 0
      && metrics.impressions >= 1000
      && metrics.ctr !== null
      && metrics.ctr < account.ctr * 0.7
      && (share === null || share >= 0.02)
    ) {
      observations.push(observation(
        `traffic-${row.canonical?.campaignId}`,
        `${displayName(row)}：点击率明显低于账户上下文`,
        `CTR ${percent(metrics.ctr)}，账户 CTR ${percent(account.ctr)}；该信号只用于提示下钻，不直接触发降价或暂停。`,
        "traffic",
      ));
    }
    if (
      account.cvr !== null
      && account.cvr > 0
      && metrics.clicks >= minClicks
      && metrics.cvr !== null
      && metrics.cvr < account.cvr * 0.7
      && (share === null || share >= 0.02)
    ) {
      observations.push(observation(
        `conversion-${row.canonical?.campaignId}`,
        `${displayName(row)}：转化率明显低于账户上下文`,
        `CVR ${percent(metrics.cvr)}，账户 CVR ${percent(account.cvr)}；最终操作仍需服从目标 ACoS 和实体证据。`,
        "conversion",
      ));
    }
  }
}

function addStructureObservation(candidates, observations, collections) {
  const campaigns = rowsFor(collections, "campaign");
  const zeroSpend = campaigns.filter((row) => metricsOf(row).cost <= 0);
  if (zeroSpend.length === 0) return;
  observations.push(observation(
    "enabled-zero-spend-campaigns",
    `${zeroSpend.length} 个启用 Campaign 本期零花费`,
    "这可能来自新建、无流量、投放资格或历史测试结构；在没有创建日期和投放资格证据前不直接建议暂停。",
    "structure",
  ));
  if (zeroSpend.length >= 3 && zeroSpend.length / Math.max(1, campaigns.length) >= 0.5) {
    candidates.push(candidate({
      action: "review-structure",
      actionLabel: "建议整理零花费 Campaign 结构",
      priority: "P3",
      dimension: "structure",
      entity: {
        type: "account",
        id: null,
        name: "启用 Campaign 结构",
        campaignId: null,
        campaignName: null,
        adGroupId: null,
        adGroupName: null,
      },
      title: "启用 Campaign：建议检查零花费结构",
      reasons: [
        `${campaigns.length} 个启用 Campaign 中有 ${zeroSpend.length} 个本期零花费，占 ${percent(zeroSpend.length / campaigns.length)}。`,
      ],
      evidence: {
        enabledCampaigns: campaigns.length,
        zeroSpendCampaigns: zeroSpend.length,
        examples: zeroSpend.slice(0, 5).map(displayName),
      },
      risk: "零花费不等于无价值；需先区分新建、季节性、资格异常和测试活动。",
      confidence: "medium",
      materialCost: 0,
    }));
  }
}

function addCoverageObservations(observations, collections) {
  for (const [entity, collection] of Object.entries(collections ?? {})) {
    if (!ENTITY_LABELS[entity]) continue;
    if (collection?.coverage?.status === "unknown") {
      observations.push(observation(
        `coverage-${entity}-unknown`,
        `${ENTITY_LABELS[entity]}花费覆盖度未知`,
        `已分析 ${collection.coverage.fetchedCount ?? 0} 行，但接口汇总花费缺失或为零。`,
        "coverage",
      ));
    } else if (
      Number.isFinite(collection?.coverage?.spendCoverage)
      && collection.coverage.spendCoverage < 0.9
      && collection.coverage.status !== "complete"
    ) {
      observations.push(observation(
        `coverage-${entity}-partial`,
        `${ENTITY_LABELS[entity]}未达到 90% 花费覆盖`,
        `实际花费覆盖 ${percent(collection.coverage.spendCoverage)}，建议只把现有结论用于已覆盖对象。`,
        "coverage",
      ));
    }
  }
}

function addPlacementCandidates({ candidates, campaignPlacements, campaignById, target }) {
  for (const [campaignId, rows] of Object.entries(campaignPlacements)) {
    const campaign = campaignById.get(campaignId);
    if (!campaign || !Array.isArray(rows)) continue;
    const winner = rows.find((row) => {
      const metrics = metricsOf(row);
      return metrics.orders >= 2 && metrics.acos !== null && metrics.acos <= target;
    });
    const loser = rows.find((row) => {
      const metrics = metricsOf(row);
      return metrics.orders >= 2 && metrics.acos !== null && metrics.acos >= target * 1.2;
    });
    if (!winner || !loser || winner.placement === loser.placement) continue;
    const metrics = metricsOf(loser);
    const placementCost = rows.reduce((sum, row) => sum + metricsOf(row).cost, 0);
    const share = placementCost > 0 ? metrics.cost / placementCost : null;
    candidates.push(candidate({
      action: "lower-placement-bid",
      actionLabel: "建议降低该广告位加价方向",
      priority: metrics.acos >= target * 1.5 && share !== null && share >= 0.05 ? "P1" : "P2",
      dimension: "efficiency",
      entity: {
        ...entityOf(campaign),
        placement: canonicalText(loser.placement),
      },
      title: `${displayName(campaign)} 的${placementLabel(loser.placement)}：建议降低加价方向`,
      reasons: [
        `${placementLabel(loser.placement)} ACoS ${percent(metrics.acos)}，高于目标 ${percent(target)}。`,
        `${placementLabel(winner.placement)} ACoS ${percent(metricsOf(winner).acos)} 已达到目标，广告位表现存在明确分化。`,
      ],
      evidence: {
        targetAcos: target,
        costShare: share,
        loser: previewMetricRow(loser),
        winner: previewMetricRow(winner),
      },
      risk: "调整广告位会改变流量分布；如果各广告位都低效，应先修正投放和商品问题。",
      confidence: "high",
      materialCost: metrics.cost,
    }));
  }
}

function addIncreaseBidCandidates({ candidates, collections, constrainedByCampaign, target }) {
  const existingLower = new Set(
    candidates
      .filter((item) => item.action === "lower-bid" || item.action === "pause")
      .map((item) => item.entity.id),
  );
  const keywords = new Map(rowsFor(collections, "keywords").map((row) => [row.canonical?.entityId, row]));
  const targets = new Map(rowsFor(collections, "targets").map((row) => [row.canonical?.entityId, row]));
  const emitted = new Set();
  for (const searchRow of rowsFor(collections, "searchQuery")) {
    const searchMetrics = metricsOf(searchRow);
    if (searchMetrics.orders < 3 || searchMetrics.acos === null || searchMetrics.acos > target) continue;
    const impressionShare = firstFinite(
      searchRow.searchTermImpressionShare,
      searchRow.keywordTargetExtend?.searchTermImpressionShare,
    );
    const impressionRank = firstFinite(
      searchRow.searchTermImpressionRank,
      searchRow.keywordTargetExtend?.searchTermImpressionRank,
    );
    const hasHeadroom = impressionShare !== null
      && impressionShare < 100
      && impressionRank !== null
      && impressionRank > 1;
    if (!hasHeadroom) continue;

    const sourceId = searchRow.canonical?.sourceKeywordId ?? searchRow.canonical?.sourceTargetId;
    const source = keywords.get(sourceId) ?? targets.get(sourceId);
    if (!source || emitted.has(sourceId) || existingLower.has(sourceId)) continue;
    const sourceMetrics = metricsOf(source);
    if (sourceMetrics.orders < 3 || sourceMetrics.acos === null || sourceMetrics.acos > target) continue;
    if ((constrainedByCampaign.get(source.canonical?.campaignId) ?? 0) >= 2) continue;
    emitted.add(sourceId);
    candidates.push(candidate({
      action: "increase-bid",
      actionLabel: "建议提高竞价方向",
      priority: "P3",
      dimension: "traffic",
      entity: entityOf(source),
      title: `${ENTITY_LABELS[source.canonical?.entity]}「${displayName(source)}」：建议提高竞价方向`,
      reasons: [
        `实体 ACoS ${percent(sourceMetrics.acos)}，达到目标 ${percent(target)}，且有 ${sourceMetrics.orders} 个归因订单。`,
        `关联搜索词「${searchRow.canonical?.searchTermText}」仍有展示空间（份额 ${percentValue(impressionShare)}，排名 ${integerValue(impressionRank)}）。`,
      ],
      evidence: evidenceOf(sourceMetrics, target, {
        searchTerm: searchRow.canonical?.searchTermText,
        searchTermImpressionShare: impressionShare,
        searchTermImpressionRank: impressionRank,
      }),
      risk: "提高竞价可能推高 CPC；若 Campaign 后续出现预算受限，应优先处理预算而不是继续抬价。",
      confidence: coverageConfidence(
        source.canonical?.entity === "keywords" ? collections?.keywords : collections?.targets,
      ),
      materialCost: sourceMetrics.cost,
    }));
  }
}

function addCampaignFallbackCandidates({
  candidates,
  campaigns,
  collections,
  campaignHistories,
  target,
  minClicks,
}) {
  const childCoverageSufficient = ["productAds", "keywords", "targets", "searchQuery"]
    .every((entity) => {
      const coverage = collections?.[entity]?.coverage;
      return coverage?.status === "complete"
        || (Number.isFinite(coverage?.spendCoverage) && coverage.spendCoverage >= 0.9);
    });
  if (!childCoverageSufficient) return;
  const campaignSummaryCost = metricsOf(collections?.campaign?.summary).cost;
  const campaignsWithLeafAction = new Set(
    candidates
      .filter((item) => ["lower-bid", "pause", "negative-search-term", "isolate-search-term"].includes(item.action))
      .map((item) => item.entity.campaignId)
      .filter(Boolean),
  );
  const childRows = [
    ...rowsFor(collections, "keywords"),
    ...rowsFor(collections, "targets"),
    ...rowsFor(collections, "productAds"),
    ...rowsFor(collections, "searchQuery"),
  ];
  for (const campaign of campaigns) {
    const campaignId = campaign.canonical?.campaignId;
    if (!campaignId || campaignsWithLeafAction.has(campaignId)) continue;
    const metrics = metricsOf(campaign);
    const share = campaignSummaryCost > 0 ? metrics.cost / campaignSummaryCost : null;
    const severe = (metrics.orders >= 2 && metrics.acos !== null && metrics.acos >= target * 1.5)
      || (metrics.orders === 0 && metrics.clicks >= minClicks);
    if (!severe) continue;
    const hasWinner = childRows.some((row) => {
      if (row.canonical?.campaignId !== campaignId) return false;
      const childMetrics = metricsOf(row);
      return childMetrics.orders >= 3 && childMetrics.acos !== null && childMetrics.acos <= target;
    });
    if (hasWinner) continue;
    const history = campaignHistories[campaignId] ?? [];
    const severeDays = history.filter((row) => {
      const day = metricsOf(row);
      return (day.orders >= 1 && day.acos !== null && day.acos >= target * 1.5)
        || (day.orders === 0 && day.clicks > 0);
    }).length;
    if (history.length > 0 && severeDays < 2) continue;
    candidates.push(candidate({
      action: "reduce-budget",
      actionLabel: "建议降低预算并排查投放结构",
      priority: share !== null && share >= 0.05 ? "P1" : "P2",
      dimension: "efficiency",
      entity: entityOf(campaign),
      title: `${displayName(campaign)}：建议降低预算并排查投放结构`,
      reasons: [
        metrics.orders === 0
          ? `${metrics.clicks} 次点击仍无归因订单。`
          : `Campaign ACoS ${percent(metrics.acos)}，达到目标 ${percent(target)} 的 ${multiple(metrics.acos / target)}。`,
        history.length > 0
          ? `${history.length} 个日数据点中有 ${severeDays} 天持续出现严重低效。`
          : "已分析的子实体中没有达到目标的明确赢家，也没有更小粒度的安全操作对象。",
      ],
      evidence: evidenceOf(metrics, target, {
        costShare: share,
        historyDays: history.length,
        severeDays,
      }),
      risk: "预算调整不能替代关键词、搜索词或商品问题修复；若数据覆盖不足，应先补齐子实体证据。",
      confidence: history.length > 0 ? "high" : "medium",
      materialCost: metrics.cost,
    }));
  }
}

function finalizeCandidates(candidates) {
  const isolationTerms = new Set(
    candidates.filter((item) => item.action === "isolate-search-term").map((item) => item.normalizedObject),
  );
  const filtered = candidates.filter((item) => !(
    isolationTerms.has(item.normalizedObject)
    && ["harvest-search-term", "negative-search-term"].includes(item.action)
  ));
  const byKey = new Map();
  for (const item of filtered) {
    const key = [
      item.action,
      item.entity.type,
      item.entity.id,
      item.entity.campaignId,
      item.entity.adGroupId,
      item.entity.placement,
      item.normalizedObject,
    ].join("|");
    const current = byKey.get(key);
    if (!current || compareCandidates(item, current) < 0) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort(compareCandidates)
    .map(({ materialCost: _materialCost, normalizedObject: _normalizedObject, ...item }, index) => ({
      id: `action-${String(index + 1).padStart(3, "0")}`,
      ...item,
    }));
}

function compareCandidates(left, right) {
  const priority = (PRIORITY_ORDER[left.priority] ?? 9) - (PRIORITY_ORDER[right.priority] ?? 9);
  if (priority !== 0) return priority;
  return (right.materialCost ?? 0) - (left.materialCost ?? 0);
}

function candidate(value) {
  return {
    ...value,
    reasons: value.reasons.filter(Boolean),
    evidence: value.evidence ?? {},
    source: "deterministic-rule",
  };
}

function observation(code, title, detail, dimension) {
  return { code, title, detail, dimension };
}

function finalizeObservations(observations) {
  return [...new Map(observations.map((item) => [item.code, item])).values()];
}

function buildCoverage(collections) {
  return Object.fromEntries(Object.entries(ENTITY_LABELS).map(([entity, label]) => {
    const coverage = collections?.[entity]?.coverage ?? {};
    return [entity, {
      label,
      fetchedCount: coverage.fetchedCount ?? rowsFor(collections, entity).length,
      totalCount: coverage.totalCount ?? null,
      spendCoverage: finiteOrNull(coverage.spendCoverage),
      status: coverage.status ?? "unknown",
      fetchedPages: coverage.fetchedPages ?? null,
    }];
  }));
}

function buildDataPreview(collections, recommendations) {
  const relevantIds = new Set(recommendations.map((item) => item.entity.id).filter(Boolean));
  return Object.fromEntries(Object.entries(ENTITY_LABELS).map(([entity, label]) => {
    const collection = collections?.[entity];
    const rows = [...rowsFor(collections, entity)].sort((a, b) => metricsOf(b).cost - metricsOf(a).cost);
    const relevant = rows.filter((row) => relevantIds.has(row.canonical?.entityId));
    const selected = uniqueBy([...relevant, ...rows], rowIdentity).slice(0, 5);
    return [entity, {
      label,
      analyzedCount: collection?.coverage?.fetchedCount ?? rows.length,
      totalCount: collection?.coverage?.totalCount ?? rows.length,
      spendCoverage: finiteOrNull(collection?.coverage?.spendCoverage),
      rows: selected.map(previewRow),
    }];
  }));
}

function buildRatings({ recommendations, observations, coverage, account, target }) {
  const requiredCoverage = {
    traffic: ["campaign"],
    conversion: ["campaign", "adGroup"],
    efficiency: ["campaign"],
    budget: ["campaign"],
    structure: Object.keys(ENTITY_LABELS),
  };
  const ratingFor = (dimension) => {
    const actions = recommendations.filter((item) => item.dimension === dimension);
    if (actions.some((item) => item.priority === "P1")) return "red";
    if (actions.some((item) => item.priority === "P2" || item.priority === "P3")) return "yellow";
    if (observations.some((item) => item.dimension === dimension)) return "yellow";
    const incomplete = requiredCoverage[dimension]
      .some((entity) => coverage[entity]?.status === "unknown");
    if (incomplete) return "data-insufficient";
    return "green";
  };
  return {
    traffic: ratingFor("traffic"),
    conversion: ratingFor("conversion"),
    efficiency: account.acos === null
      ? "data-insufficient"
      : account.acos >= target * 1.5
        ? "red"
        : account.acos > target
          ? "yellow"
          : ratingFor("efficiency"),
    budget: ratingFor("budget"),
    structure: ratingFor("structure"),
  };
}

function normalizeAccount(storePerformance, fallbackSummary) {
  const objects = collectObjects(storePerformance);
  let best = fallbackSummary && typeof fallbackSummary === "object" ? fallbackSummary : {};
  let bestScore = metricObjectScore(best);
  for (const object of objects) {
    const score = metricObjectScore(object);
    if (score > bestScore) {
      best = object;
      bestScore = score;
    }
  }
  const cost = firstFinite(best.cpcCost, best.adSpend, best.cost, fallbackSummary?.cost);
  const sales = firstFinite(best.adCpcSales, best.cpcSales, best.adSales, fallbackSummary?.cpcSales);
  const clicks = firstFinite(best.adClicks, best.clicks, fallbackSummary?.clicks);
  const orders = firstFinite(best.adCpcOrders, best.cpcOrder, best.adOrders, fallbackSummary?.cpcOrder);
  const impressions = firstFinite(best.adImpressions, best.impressions, fallbackSummary?.impressions);
  return {
    currency: canonicalText(best.currencyCode ?? best.currency),
    revenue: firstFinite(best.revenue, best.sales),
    orders: firstFinite(best.orders, best.productOrders),
    adSpend: cost,
    adSales: sales,
    adOrders: orders,
    impressions,
    clicks,
    ctr: ratioOrDerived(firstFinite(best.adClickRate, best.ctr), clicks, impressions),
    cvr: ratioOrDerived(firstFinite(best.adCpcOrdersCvr, best.cvr), orders, clicks),
    cpc: ratioOrDerived(firstFinite(best.cpc), cost, clicks),
    acos: ratioOrDerived(firstFinite(best.adAcos, best.acos), cost, sales),
    roas: ratioOrDerived(firstFinite(best.roas), sales, cost),
    tacos: firstFinite(best.acoTs, best.tacos),
    profit: firstFinite(best.profit),
    margin: firstFinite(best.margin),
  };
}

function collectObjects(value, depth = 0, output = []) {
  if (depth > 8 || value === null || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, depth + 1, output);
    return output;
  }
  output.push(value);
  for (const item of Object.values(value)) collectObjects(item, depth + 1, output);
  return output;
}

function metricObjectScore(value) {
  const keys = ["cpcCost", "adCpcSales", "adAcos", "adClicks", "cpcSales", "cost", "clicks"];
  return keys.reduce((score, key) => score + (finiteOrNull(value?.[key]) !== null ? 1 : 0), 0);
}

function computeMinClicks(accountCvr) {
  if (!Number.isFinite(accountCvr) || accountCvr <= 0) return 20;
  return Math.min(50, Math.max(10, Math.ceil(2 / Math.max(accountCvr, 0.02))));
}

function metricsOf(row) {
  const cost = firstFinite(row?.cost, row?.cpcCost) ?? 0;
  const sales = firstFinite(row?.cpcSales, row?.adCpcSales) ?? 0;
  const orders = firstFinite(row?.cpcOrder, row?.adCpcOrders, row?.adOrders) ?? 0;
  const clicks = firstFinite(row?.clicks, row?.adClicks) ?? 0;
  const impressions = firstFinite(row?.impressions, row?.adImpressions) ?? 0;
  return {
    cost,
    sales,
    orders,
    clicks,
    impressions,
    acos: ratioOrDerived(firstFinite(row?.acos, row?.adAcos), cost, sales),
    roas: ratioOrDerived(firstFinite(row?.roas), sales, cost),
    cvr: ratioOrDerived(firstFinite(row?.cvr, row?.adCpcOrdersCvr), orders, clicks),
    ctr: ratioOrDerived(firstFinite(row?.ctr, row?.adClickRate), clicks, impressions),
    cpc: ratioOrDerived(firstFinite(row?.cpc), cost, clicks),
  };
}

function evidenceOf(metrics, targetAcos, extra = {}) {
  return {
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    orders: metrics.orders,
    cost: metrics.cost,
    sales: metrics.sales,
    acos: metrics.acos,
    roas: metrics.roas,
    cvr: metrics.cvr,
    targetAcos,
    ...extra,
  };
}

function entityOf(row) {
  const canonical = row?.canonical ?? {};
  return {
    type: canonical.entity ?? null,
    id: canonical.entityId ?? null,
    name: displayName(row),
    campaignId: canonical.campaignId ?? null,
    campaignName: canonical.campaignName ?? null,
    adGroupId: canonical.adGroupId ?? null,
    adGroupName: canonical.adGroupName ?? null,
    ...(canonical.keywordMatchType ? { matchType: canonical.keywordMatchType } : {}),
    ...(canonical.targetType ? { targetType: canonical.targetType } : {}),
    ...(canonical.asin ? { asin: canonical.asin } : {}),
    ...(canonical.queryIsAsin ? { queryIsAsin: canonical.queryIsAsin } : {}),
  };
}

function previewRow(row) {
  const metrics = metricsOf(row);
  return {
    entityId: row?.canonical?.entityId ?? null,
    name: displayName(row),
    campaignName: row?.canonical?.campaignName ?? null,
    adGroupName: row?.canonical?.adGroupName ?? null,
    adType: canonicalText(row?.adType),
    matchType: row?.canonical?.keywordMatchType ?? row?.canonical?.targetType ?? null,
    asin: row?.canonical?.asin ?? null,
    impressions: metrics.impressions,
    clicks: metrics.clicks,
    orders: metrics.orders,
    cost: metrics.cost,
    sales: metrics.sales,
    acos: metrics.acos,
    roas: metrics.roas,
    bid: finiteOrNull(row?.bid ?? row?.defaultBid),
    dailyBudget: finiteOrNull(row?.dailyBudget),
  };
}

function previewMetricRow(row) {
  return {
    placement: canonicalText(row?.placement),
    ...metricsOf(row),
  };
}

function compactTrendPoint(row) {
  const metrics = metricsOf(row);
  return {
    date: canonicalText(row?.datePoint),
    cost: metrics.cost,
    sales: metrics.sales,
    orders: metrics.orders,
    acos: metrics.acos,
    budgetConstrained: isBudgetConstrainedDay(row),
  };
}

function countBudgetConstrainedDays(rows) {
  return asArray(rows).filter(isBudgetConstrainedDay).length;
}

function isBudgetConstrainedDay(row) {
  const explicit = row?.overBudgetTime;
  if (
    explicit !== null
    && explicit !== undefined
    && explicit !== ""
    && explicit !== 0
    && explicit !== "0"
    && explicit !== false
  ) return true;
  const minutes = finiteOrNull(row?.overBudgetTimeMinute);
  if (minutes !== null && minutes > 0) return true;
  const budget = finiteOrNull(row?.campaignBudget);
  const cost = finiteOrNull(row?.cost);
  return budget !== null && budget > 0 && cost !== null && cost >= budget;
}

function rowsFor(collections, entity) {
  return asArray(collections?.[entity]?.rows);
}

function coverageConfidence(collection) {
  const status = collection?.coverage?.status;
  const coverage = finiteOrNull(collection?.coverage?.spendCoverage);
  if (status === "complete" || (coverage !== null && coverage >= 0.9)) return "high";
  return "medium";
}

function displayName(row) {
  return canonicalText(row?.canonical?.entityName);
}

function rowIdentity(row) {
  return row?.canonical?.entityId
    ?? [row?.canonical?.campaignId, row?.canonical?.adGroupId, displayName(row)].join("|");
}

function locationKey(entity) {
  return [entity?.campaignId, entity?.adGroupId].join("|");
}

function locationLabel(row) {
  return [row?.canonical?.campaignName, row?.canonical?.adGroupName].filter(Boolean).join(" / ") || "未知位置";
}

function normalizedSearchTerm(row) {
  const value = String(row?.canonical?.searchTermText ?? "").trim();
  return row?.canonical?.queryIsAsin === "Y"
    ? value.toUpperCase()
    : value.toLocaleLowerCase().replace(/\s+/g, " ");
}

function loserReason(metrics, target) {
  if (metrics.orders === 0) return `${metrics.clicks} 次点击无订单`;
  return `ACoS ${percent(metrics.acos)}，高于目标 ${percent(target)}`;
}

function placementLabel(value) {
  return {
    placementTop: "搜索结果顶部",
    placementDetail: "商品页面",
    placementOther: "搜索结果其他位置",
    placementOffAmazon: "站外",
    placementBusiness: "Amazon Business",
  }[value] ?? canonicalText(value) ?? "未知广告位";
}

function groupBy(rows, keyOf) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined || key === "") continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function uniqueBy(rows, keyOf) {
  const output = [];
  const seen = new Set();
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function idList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Fall through to comma-separated values.
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isIdListValue(value) {
  if (Array.isArray(value)) return true;
  if (typeof value !== "string") return false;
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}

function ratioOrDerived(explicit, numerator, denominator) {
  if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
    return round(numerator / denominator, 6);
  }
  if (Number.isFinite(numerator) && numerator > 0 && denominator === 0) return null;
  return finiteOrNull(explicit);
}

function firstFinite(...values) {
  for (const value of values) {
    const finite = finiteOrNull(value);
    if (finite !== null) return finite;
  }
  return null;
}

function finiteOrNull(value) {
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalText(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function percent(value) {
  return value === null || !Number.isFinite(value) ? "未知" : `${round(value * 100, 2)}%`;
}

function percentValue(value) {
  return value === null || !Number.isFinite(value) ? "未知" : `${round(value, 2)}%`;
}

function integerValue(value) {
  return value === null || !Number.isFinite(value) ? "未知" : String(Math.round(value));
}

function multiple(value) {
  return Number.isFinite(value) ? `${round(value, 2)} 倍` : "未知倍数";
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
