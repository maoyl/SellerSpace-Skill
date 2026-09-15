import { createHash } from "node:crypto";

export const STARS = ["all_stars", "one_star", "two_star", "three_star", "four_star", "five_star"];
export const DOMAINS = ["product", "packaging", "delivery", "support", "usage", "expectation", "value", "other"];
export const KINDS = ["pain", "praise", "motivation", "scenario", "need"];
export const SENTIMENTS = ["positive", "negative", "mixed", "neutral", "unknown"];
export const MARKETS = { US: "www.amazon.com", CA: "www.amazon.ca", MX: "www.amazon.com.mx", BR: "www.amazon.com.br", UK: "www.amazon.co.uk", DE: "www.amazon.de", FR: "www.amazon.fr", IT: "www.amazon.it", ES: "www.amazon.es", NL: "www.amazon.nl", SE: "www.amazon.se", PL: "www.amazon.pl", TR: "www.amazon.com.tr", BE: "www.amazon.com.be", JP: "www.amazon.co.jp", AU: "www.amazon.com.au", SG: "www.amazon.sg", AE: "www.amazon.ae", IN: "www.amazon.in" };

export class AnalysisError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireValue(condition, code, message) { if (!condition) throw new AnalysisError(code, message); }
export const hash = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const text = (value) => typeof value === "string" ? value : "";
const unique = (values) => [...new Set(values)];
const selected = (value, choices) => choices.includes(value);
const keyFor = (marketplace, asin, id) => `${marketplace}:${asin}:${encodeURIComponent(id)}`;

export function normalizeResult(result, params) {
  requireValue(result && result.asin === params.asin && result.marketplace === params.marketplace,
    "ARTIFACT_SCOPE_MISMATCH", "Artifact 的 ASIN 或站点与任务不符");
  requireValue(Array.isArray(result.reviews) && Array.isArray(result.slices) && typeof result.blocked === "boolean"
    && result.collectedCount === result.reviews.length, "ARTIFACT_RESULT_INVALID", "评论结果结构或数量不符");
  requireValue(result.coverage?.scope === "amazon_page_visible" && result.coverage?.crawlMode === "snapshot"
    && JSON.stringify(result.coverage.requestedStarFilters) === JSON.stringify(STARS)
    && result.requestedMax === (params.maxReviews ?? null)
    && (params.maxReviews === undefined || result.reviews.length <= params.maxReviews),
  "ARTIFACT_SCOPE_MISMATCH", "结果的采集模式、星级范围或条数预算不符");
  const reviews = new Map();
  for (const item of result.reviews) {
    requireValue(typeof item?.reviewId === "string" && item.reviewId.trim().length > 0 && item.reviewId.length <= 200,
      "ARTIFACT_RESULT_INVALID", "评论缺少有效 reviewId");
    const reviewId = item.reviewId.trim();
    const review = {
      key: keyFor(params.marketplace, params.asin, reviewId), marketplace: params.marketplace,
      requested_asin: params.asin, review_id: reviewId,
      review_asin: /^[A-Z0-9]{10}$/.test(item.reviewAsin ?? "") ? item.reviewAsin : null,
      rating: Number.isInteger(item.rating) && item.rating >= 1 && item.rating <= 5 ? item.rating : null,
      title: text(item.title), content: text(item.content), author: text(item.author),
      review_date: text(item.date), country: text(item.country),
      verified_purchase: typeof item.verifiedPurchase === "boolean" ? item.verifiedPurchase : null,
      helpful_votes: Number.isSafeInteger(item.helpfulVotes) && item.helpfulVotes >= 0 ? item.helpfulVotes : null,
      images: unique((Array.isArray(item.images) ? item.images : []).filter((url) => {
        try { return new URL(url).protocol === "https:"; } catch { return false; }
      })),
      source_slices: unique((Array.isArray(item.sourceSlices) ? item.sourceSlices : []).filter((x) => typeof x === "string")),
      source_url: `https://${MARKETS[params.marketplace]}/gp/customer-reviews/${encodeURIComponent(reviewId)}`,
    };
    const previous = reviews.get(review.key);
    if (previous) {
      review.title = previous.title.length > review.title.length ? previous.title : review.title;
      review.content = previous.content.length > review.content.length ? previous.content : review.content;
      review.images = unique([...previous.images, ...review.images]);
      review.source_slices = unique([...previous.source_slices, ...review.source_slices]);
    }
    reviews.set(review.key, review);
  }
  const reliable = !result.blocked && result.coverage.visibleSetExhausted === true
    && result.coverage.stopReason === "visible_set_exhausted" && !result.coverage.platformLimited
    && STARS.every((star) => result.slices.some((s) => s.star === star && s.sort === "recent"
      && s.filterApplied === true && s.stopReason === "visible_set_exhausted"));
  return { reviews: [...reviews.values()], coverage: result.coverage, slices: result.slices, reliable,
    blocked: result.blocked || ["captcha", "login_required"].includes(result.coverage.stopReason),
    captured_at: text(result.capturedAt), duplicates_removed: result.reviews.length - reviews.size };
}

// Text is never discarded: even very long comments are analyzed as bounded, stable segments.
export function reviewUnits(reviews) {
  const units = [];
  for (const review of reviews) {
    for (const field of ["title", "content"]) {
      const value = review[field];
      for (let start = 0; start < value.length;) {
        let end = Math.min(value.length, start + 8000);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
        const body = value.slice(start, end);
        units.push({ unit_id: hash([review.key, field, start, body]).slice(0, 24), review_key: review.key,
          asin: review.requested_asin, rating: review.rating, field, start, text: body });
        start = end;
      }
    }
    if (!review.title && !review.content) units.push({ unit_id: hash([review.key, "empty"]).slice(0, 24),
      review_key: review.key, asin: review.requested_asin, rating: review.rating, field: "content", start: 0, text: "" });
  }
  return units;
}

export function nextBatch(reviews, annotations, topics) {
  const pending = reviewUnits(reviews).filter((unit) => !Object.hasOwn(annotations, unit.unit_id));
  const units = []; let characters = 0;
  for (const unit of pending) {
    if (units.length >= 30 || (units.length && characters + unit.text.length > 16000)) break;
    units.push(unit); characters += unit.text.length;
  }
  return { done: !units.length, pending_units: pending.length, topics,
    batch_id: hash(units.map((u) => u.unit_id)), units };
}

function validateTopic(topic) {
  requireValue(topic && /^[a-z][a-z0-9_-]{0,63}$/.test(topic.id) && text(topic.label).trim()
    && selected(topic.kind, KINDS) && selected(topic.domain, DOMAINS), "INVALID_TOPIC", "主题需有稳定 id、中文 label、kind 和 domain");
  return { id: topic.id, label: topic.label.trim(), kind: topic.kind, domain: topic.domain };
}

export function acceptBatch(batch, payload, existingTopics) {
  requireValue(payload.batch_id === batch.batch_id && Array.isArray(payload.annotations)
    && payload.annotations.length === batch.units.length, "BATCH_MISMATCH", "分析批次或标注数量不符");
  requireValue(payload.topics === undefined || Array.isArray(payload.topics), "INVALID_TOPIC", "topics 必须为数组");
  const topics = new Map(existingTopics.map((topic) => [topic.id, topic]));
  for (const raw of payload.topics ?? []) {
    const topic = validateTopic(raw); const previous = topics.get(topic.id);
    requireValue(!previous || JSON.stringify(previous) === JSON.stringify(topic), "TOPIC_CONFLICT", "已存在的主题不能改义，请合并主题或使用新 id");
    topics.set(topic.id, topic);
  }
  const units = new Map(batch.units.map((unit) => [unit.unit_id, unit]));
  const annotations = {};
  for (const item of payload.annotations) {
    const unit = units.get(item.unit_id);
    requireValue(unit && !Object.hasOwn(annotations, item.unit_id) && selected(item.sentiment, SENTIMENTS)
      && Array.isArray(item.observations), "INVALID_ANNOTATION", "每个分段必须且只能标注一次，情绪和观察结构必须有效");
    requireValue(unit.text.trim() || (item.sentiment === "unknown" && !item.observations.length),
      "EMPTY_REVIEW_INFERENCE", "空评论不能推断情绪或主题");
    const observations = item.observations.map((observation) => {
      requireValue(topics.has(observation.topic_id) && selected(observation.polarity, SENTIMENTS.filter((x) => x !== "unknown"))
        && selected(observation.severity, ["normal", "functional", "safety"]), "INVALID_OBSERVATION", "观察需引用有效主题、情绪和严重程度");
      requireValue(text(observation.quote).trim() && unit.text.includes(observation.quote)
        && observation.quote.length <= 1200, "INVALID_EVIDENCE", "证据必须是本分段连续原文，且不超过 1200 字符");
      requireValue(text(observation.interpretation).trim(), "INVALID_EVIDENCE", "每条证据需要中文解释");
      return { topic_id: observation.topic_id, polarity: observation.polarity, severity: observation.severity,
        field: unit.field, quote: observation.quote, interpretation: observation.interpretation };
    });
    annotations[item.unit_id] = { review_key: unit.review_key, sentiment: item.sentiment, observations };
  }
  return { topics: [...topics.values()], annotations };
}

export function mergeTopics(topics, annotations, mappings) {
  requireValue(Array.isArray(mappings), "INVALID_TOPIC_MERGE", "mappings 必须为数组");
  const remaining = new Map(topics.map((t) => [t.id, t]));
  const updated = structuredClone(annotations);
  for (const { from, to } of mappings) {
    const source = remaining.get(from); const target = remaining.get(to);
    requireValue(source && target && from !== to && source.kind === target.kind && source.domain === target.domain,
      "INVALID_TOPIC_MERGE", "仅合并同 kind/domain 的现有主题，不允许自引用");
    for (const annotation of Object.values(updated)) for (const item of annotation.observations) if (item.topic_id === from) item.topic_id = to;
    remaining.delete(from);
  }
  return { topics: [...remaining.values()], annotations: updated };
}

function combineSentiments(values) {
  if (values.includes("mixed") || (values.includes("positive") && values.includes("negative"))) return "mixed";
  return ["negative", "positive", "neutral", "unknown"].find((x) => values.includes(x)) ?? "unknown";
}

export function aggregate(reviews, topics, annotations, tasks = []) {
  const byKey = new Map();
  for (const unit of reviewUnits(reviews)) {
    if (!byKey.has(unit.review_key)) byKey.set(unit.review_key, []);
    byKey.get(unit.review_key).push(annotations[unit.unit_id] ?? null);
  }
  const analyzed = reviews.filter((review) => byKey.get(review.key)?.every(Boolean));
  const topicMap = new Map(topics.map((topic) => [topic.id, { ...topic, review_keys: [], evidence: [], by_asin: {} }]));
  const reviewAnalysis = {};
  for (const review of analyzed) {
    const values = byKey.get(review.key);
    const observations = values.flatMap((value) => value.observations);
    reviewAnalysis[review.key] = { sentiment: combineSentiments(values.map((value) => value.sentiment)),
      topic_ids: unique(observations.map((o) => o.topic_id)) };
    for (const observation of observations) {
      const topic = topicMap.get(observation.topic_id);
      if (!topic) continue;
      topic.review_keys.push(review.key);
      topic.evidence.push({ review_key: review.key, ...observation });
    }
  }
  const asins = unique([...tasks.map((task) => task.asin), ...reviews.map((r) => r.requested_asin)]);
  const reviewMap = new Map(reviews.map((r) => [r.key, r]));
  for (const topic of topicMap.values()) {
    topic.review_keys = unique(topic.review_keys);
    topic.count = unique(topic.review_keys.map((key) => `${reviewMap.get(key).marketplace}:${reviewMap.get(key).review_id}`)).length;
    topic.evidence = topic.evidence.filter((e, i, all) => all.findIndex((x) => x.review_key === e.review_key && x.field === e.field && x.quote === e.quote && x.polarity === e.polarity) === i);
    for (const polarity of ["positive", "negative"]) topic[polarity] = unique(topic.evidence.filter((e) => [polarity, "mixed"].includes(e.polarity))
      .map((e) => `${reviewMap.get(e.review_key).marketplace}:${reviewMap.get(e.review_key).review_id}`)).length;
    for (const asin of asins) {
      const keys = topic.review_keys.filter((key) => reviewMap.get(key).requested_asin === asin);
      const denominator = analyzed.filter((r) => r.requested_asin === asin).length;
      const evidence = topic.evidence.filter((e) => keys.includes(e.review_key));
      topic.by_asin[asin] = { count: keys.length, denominator, share: denominator ? keys.length / denominator : null,
        positive: unique(evidence.filter((e) => ["positive", "mixed"].includes(e.polarity)).map((e) => e.review_key)).length,
        negative: unique(evidence.filter((e) => ["negative", "mixed"].includes(e.polarity)).map((e) => e.review_key)).length };
    }
  }
  const shared = new Map();
  for (const review of reviews) {
    const id = `${review.marketplace}:${review.review_id}`;
    if (!shared.has(id)) shared.set(id, []);
    shared.get(id).push(review.requested_asin);
  }
  return {
    collected_count: reviews.length, unique_review_count: shared.size, analyzed_count: analyzed.length,
    unique_analyzed_count: unique(analyzed.map((r) => `${r.marketplace}:${r.review_id}`)).length,
    analysis_complete: analyzed.length === reviews.length,
    shared_reviews: [...shared].filter(([, values]) => unique(values).length > 1).map(([id, values]) => ({ id, asins: unique(values) })),
    by_asin: asins.map((asin) => {
      const rows = reviews.filter((r) => r.requested_asin === asin);
      return { asin, collected: rows.length, analyzed: analyzed.filter((r) => r.requested_asin === asin).length,
        stars: Object.fromEntries([1, 2, 3, 4, 5, "unknown"].map((rating) => [rating, rows.filter((r) => (r.rating ?? "unknown") === rating).length])) };
    }),
    topics: [...topicMap.values()].filter((t) => t.count).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)), review_analysis: reviewAnalysis,
  };
}

// At most three distinct reviews per ASIN; a long comment cannot crowd out contrary feedback.
export function representativeEvidence(evidence, marketplace, asin) {
  const severity = { safety: 3, functional: 2, normal: 1 };
  const rows = evidence.filter((e) => e.review_key.startsWith(`${marketplace}:${asin}:`))
    .sort((a, b) => severity[b.severity] - severity[a.severity]);
  const keys = [];
  for (const polarity of ["negative", "positive"]) {
    const candidate = rows.find((e) => !keys.includes(e.review_key) && [polarity, "mixed"].includes(e.polarity));
    if (candidate) keys.push(candidate.review_key);
  }
  for (const row of rows) if (keys.length < 3 && !keys.includes(row.review_key)) keys.push(row.review_key);
  return keys.flatMap((key) => {
    const matching = rows.filter((row) => row.review_key === key);
    const chosen = [];
    for (const polarity of ["negative", "positive"]) {
      const row = matching.find((e) => [polarity, "mixed"].includes(e.polarity));
      if (row && !chosen.includes(row)) chosen.push(row);
    }
    return chosen.length ? chosen : matching.slice(0, 1);
  });
}

export function validateFindings(findings, stats, reviews) {
  requireValue(Array.isArray(findings), "INVALID_FINDINGS", "findings 必须为数组");
  const topicMap = new Map(stats.topics.map((topic) => [topic.id, topic]));
  const reviewMap = new Map(reviews.map((review) => [review.key, review]));
  const ids = new Set();
  return findings.map((finding) => {
    requireValue(/^[a-z][a-z0-9_-]{0,63}$/.test(finding.id) && !ids.has(finding.id)
      && ["summary", "product", "listing", "image", "faq", "comparison"].includes(finding.section)
      && ["P1", "P2", "P3"].includes(finding.priority) && text(finding.title).trim()
      && text(finding.recommendation).trim() && text(finding.validation).trim(), "INVALID_FINDING", "结论需有唯一 id、section、优先级、标题、建议和验证方法");
    ids.add(finding.id);
    requireValue(Array.isArray(finding.topic_ids) && finding.topic_ids.length && finding.topic_ids.every((id) => topicMap.has(id)),
      "INVALID_FINDING_TOPIC", "结论必须引用已有证据的主题");
    requireValue(Array.isArray(finding.asins) && finding.asins.length && finding.asins.every((asin) => stats.by_asin.some((r) => r.asin === asin)),
      "INVALID_FINDING_SCOPE", "结论需明确适用 ASIN");
    requireValue(Array.isArray(finding.evidence_keys) && finding.evidence_keys.length && finding.evidence_keys.every((key) =>
      reviewMap.has(key) && finding.asins.includes(reviewMap.get(key).requested_asin)
      && finding.topic_ids.some((id) => topicMap.get(id).review_keys.includes(key))),
    "INVALID_FINDING_EVIDENCE", "结论的证据必须来自对应 ASIN 和主题");
    requireValue(finding.asins.every((asin) => finding.evidence_keys.some((key) => reviewMap.get(key).requested_asin === asin)),
      "INVALID_FINDING_SCOPE", "每个被比较的 ASIN 都需要证据，不能用未发现冒充缺陷不存在");
    return { id: finding.id, section: finding.section, priority: finding.priority, title: finding.title,
      recommendation: finding.recommendation, validation: finding.validation,
      caveat: text(finding.caveat), asins: unique(finding.asins), topic_ids: unique(finding.topic_ids), evidence_keys: unique(finding.evidence_keys) };
  });
}

export function safeJson(value) { return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"); }
export function csv(reviews) {
  const columns = ["marketplace", "requested_asin", "review_id", "review_asin", "rating", "title", "content", "author", "review_date", "country", "verified_purchase", "helpful_votes", "images", "source_slices", "source_url"];
  const cell = (value) => {
    let str = value == null ? "" : Array.isArray(value) ? JSON.stringify(value) : String(value);
    if (/^[\s\uFEFF]*[=+@-]/u.test(str)) str = `'${str}`;
    return `"${str.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [columns, ...reviews.map((review) => columns.map((column) => review[column]))].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
