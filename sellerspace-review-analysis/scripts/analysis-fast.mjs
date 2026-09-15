import { reviewUnits, acceptBatch, aggregate, representativeEvidence, hash, requireValue } from "./analysis-core.mjs";

export const ANALYSIS_FORMAT = "compact-v2";
export const RULES_VERSION = "review-analysis-2.0";
const segmenter = new Intl.Segmenter("und", { granularity: "sentence" });

// Keep the original field-unit IDs on disk so archived and partly analyzed v1 runs remain readable.
function groups(reviews, annotations) {
  const result = [];
  for (const review of reviews) {
    const pending = reviewUnits([review]).filter((u) => !Object.hasOwn(annotations, u.unit_id));
    let group;
    for (const unit of pending) {
      if (!group || group.characters + unit.text.length > 12000) {
        group = { review, source: [], characters: 0 }; result.push(group);
      }
      group.source.push(unit); group.characters += unit.text.length;
    }
  }
  return result;
}

function sentencesFor(source) {
  const sentences = [];
  for (const unit of source) for (const { segment, index } of segmenter.segment(unit.text)) {
    for (let start = 0; start < segment.length;) {
      let end = Math.min(segment.length, start + 600);
      if (end < segment.length && /[\uD800-\uDBFF]/.test(segment[end - 1])) end--;
      sentences.push({ id: `s${sentences.length + 1}`, unit, start: index + start, text: segment.slice(start, end) });
      start = end;
    }
  }
  return sentences;
}

export function nextFastBatch(reviews, annotations, topics) {
  const pending = groups(reviews, annotations);
  const units = []; let characters = 0; let outputTokens = 0;
  for (const group of pending) {
    const sentences = sentencesFor(group.source);
    const cost = 40 + sentences.length * 20;
    if (units.length && (units.length >= 80 || characters + group.characters > 32000 || outputTokens + cost > 8000)) break;
    units.push({ unit_id: hash(group.source.map((u) => u.unit_id)).slice(0, 24), review_key: group.review.key,
      asin: group.review.requested_asin, rating: group.review.rating,
      sentences: sentences.map((s) => [s.id, s.unit.field, s.text]) });
    characters += group.characters; outputTokens += cost;
  }
  return { format: ANALYSIS_FORMAT, done: !units.length, pending_units: pending.length,
    pending_reviews: new Set(pending.map((g) => g.review.key)).size, topics,
    estimated_output_tokens: outputTokens, batch_id: hash([ANALYSIS_FORMAT, units]), units };
}

export function acceptFastBatch(batch, payload, reviews, annotations, topics) {
  requireValue(payload?.batch_id === batch.batch_id && Array.isArray(payload.annotations)
    && payload.annotations.length === batch.units.length, "BATCH_MISMATCH", "分析批次或标注数量不符");
  const available = new Map(groups(reviews, annotations).map((g) => [hash(g.source.map((u) => u.unit_id)).slice(0, 24), g]));
  const allowed = new Set(batch.units.map((u) => u.unit_id)); const seen = new Set();
  const source = []; const expanded = [];
  for (const item of payload.annotations) {
    requireValue(item && allowed.has(item.unit_id) && !seen.has(item.unit_id) && Array.isArray(item.observations)
      && (item.uncertain === undefined || typeof item.uncertain === "boolean"), "INVALID_ANNOTATION", "每个整条评论分组必须且只能标注一次");
    seen.add(item.unit_id);
    const group = available.get(item.unit_id); const sentences = new Map(sentencesFor(group.source).map((s) => [s.id, s]));
    const entries = new Map(group.source.map((u) => [u.unit_id, { unit_id: u.unit_id,
      sentiment: u.text.trim() ? item.sentiment : "unknown", uncertain: item.uncertain ?? false, observations: [] }]));
    if (!group.source.some((u) => u.text.trim())) requireValue(item.sentiment === "unknown" && !item.observations.length,
      "EMPTY_REVIEW_INFERENCE", "空评论不能推断情绪或主题");
    for (const observation of item.observations) {
      requireValue(observation && Array.isArray(observation.sentence_ids) && observation.sentence_ids.length
        && new Set(observation.sentence_ids).size === observation.sentence_ids.length
        && observation.sentence_ids.every((id) => sentences.has(id)), "INVALID_EVIDENCE", "证据需引用当前评论中的有效句子编号");
      for (const id of observation.sentence_ids) {
        const s = sentences.get(id);
        entries.get(s.unit.unit_id).observations.push({ topic_id: observation.topic_id, polarity: observation.polarity,
          severity: observation.severity ?? "normal", quote: s.text, interpretation: "" });
      }
    }
    source.push(...group.source); expanded.push(...entries.values());
  }
  return acceptBatch({ batch_id: batch.batch_id, units: source }, { batch_id: batch.batch_id, topics: payload.topics, annotations: expanded }, topics, { compact: true });
}

function evidenceEntries(annotations, reviews) {
  const source = new Map(reviewUnits(reviews).map((u) => [u.unit_id, u]));
  return Object.entries(annotations).flatMap(([unit_id, annotation]) => {
    const entries = annotation.observations.map((observation, index) => ({
      evidence_id: hash([unit_id, index, observation.topic_id, observation.quote, observation.polarity]).slice(0, 24),
      unit_id, index, review_key: annotation.review_key, uncertain: annotation.uncertain === true, ...observation,
    }));
    if (annotation.uncertain && !entries.length) entries.push({ evidence_id: hash([unit_id, "uncertain"]).slice(0, 24),
      unit_id, index: null, review_key: annotation.review_key, uncertain: true, field: source.get(unit_id)?.field,
      quote: source.get(unit_id)?.text.slice(0, 600) ?? "", topic_id: null, polarity: "unknown", severity: "normal",
      interpretation: annotation.assessment ?? "" });
    return entries;
  });
}

export function nextInsightBatch(reviews, topics, annotations, tasks = []) {
  const stats = aggregate(reviews, topics, annotations, tasks);
  requireValue(stats.analysis_complete, "ANALYSIS_INCOMPLETE", "全部评论轻量标注完成后再复核重点证据");
  const entries = evidenceEntries(annotations, reviews);
  const key = (e) => JSON.stringify([e.review_key, e.topic_id, e.field, e.quote, e.polarity]);
  const selected = new Set(stats.topics.flatMap((topic) => stats.by_asin.flatMap(({ asin }) =>
    representativeEvidence(topic.evidence, reviews[0]?.marketplace, asin))).map(key));
  const required = entries.filter((e) => selected.has(key(e)) || e.severity !== "normal" || e.uncertain
    || stats.review_analysis[e.review_key]?.sentiment === "mixed");
  const pending = required.filter((e) => !e.interpretation?.trim());
  const units = []; let characters = 0;
  const source = new Map(reviewUnits(reviews).map((u) => [u.unit_id, u]));
  const reviewMap = new Map(reviews.map((review) => [review.key, review]));
  for (const item of pending) {
    const field = source.get(item.unit_id)?.text ?? "";
    const position = field.indexOf(item.quote);
    const nearby = field.slice(Math.max(0, position - 160), Math.min(field.length, position + item.quote.length + 160));
    const review = reviewMap.get(item.review_key);
    const title = item.field === "title" ? nearby : Array.from(review.title).slice(0, 240).join("");
    const body = item.field === "title" ? Array.from(review.content).slice(0, 320).join("") : nearby;
    const context = `标题摘录：${title}\n正文摘录：${body}`;
    if (units.length && (units.length >= 48 || characters + context.length > 16000)) break;
    units.push({ evidence_id: item.evidence_id, review_key: item.review_key, topic_id: item.topic_id,
      polarity: item.polarity, severity: item.severity, uncertain: item.uncertain, quote: item.quote, context });
    characters += context.length;
  }
  return { done: !units.length, batch_id: hash(["insights-v2", units]), pending_evidence: pending.length,
    total_evidence: required.length, reviewed_evidence: required.length - pending.length, units };
}

export function acceptInsights(batch, payload, annotations, reviews) {
  requireValue(payload?.batch_id === batch.batch_id && Array.isArray(payload.insights) && payload.insights.length === batch.units.length,
    "BATCH_MISMATCH", "重点证据批次或解释数量不符");
  const allowed = new Set(batch.units.map((u) => u.evidence_id)); const seen = new Set();
  const entries = new Map(evidenceEntries(annotations, reviews).map((e) => [e.evidence_id, e]));
  const updated = structuredClone(annotations);
  for (const item of payload.insights) {
    requireValue(item && allowed.has(item.evidence_id) && !seen.has(item.evidence_id)
      && typeof item.interpretation === "string" && item.interpretation.trim() && item.interpretation.length <= 1200,
      "INVALID_INSIGHT", "每条重点证据需要唯一有效编号和简短中文解释");
    seen.add(item.evidence_id); const entry = entries.get(item.evidence_id);
    if (entry.index === null) updated[entry.unit_id].assessment = item.interpretation.trim();
    else updated[entry.unit_id].observations[entry.index].interpretation = item.interpretation.trim();
  }
  return updated;
}
