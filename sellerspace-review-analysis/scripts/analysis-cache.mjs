import path from "node:path";
import { reviewUnits, acceptBatch, hash } from "./analysis-core.mjs";
import { RULES_VERSION } from "./analysis-fast.mjs";
import { readJsonIfExists, writeJson } from "./local-store.mjs";

const fingerprint = (review) => hash([RULES_VERSION, review.marketplace, review.requested_asin, review.review_id,
  review.review_asin, review.rating, review.title, review.content]);
const location = (directory, review) => path.join(directory, `${fingerprint(review)}.json`);

export async function restoreCache(run, reviews) {
  if (!run.settings.cache_dir) return { restored: 0, skipped: 0 };
  let restored = 0; let skipped = 0;
  // A cache is optional. Invalid, stale or conflicting entries never block a fresh analysis.
  for (const review of reviews) {
    const units = reviewUnits([review]);
    if (units.some((u) => Object.hasOwn(run.annotations, u.unit_id)) || run.cache_excluded?.includes(review.key)) continue;
    try {
      const entry = await readJsonIfExists(location(run.settings.cache_dir, review));
      if (!entry) continue;
      if (entry.rules_version !== RULES_VERSION || entry.fingerprint !== fingerprint(review)) { skipped++; continue; }
      const batch = { units, batch_id: "cache" };
      const accepted = acceptBatch(batch, { batch_id: "cache", topics: entry.topics, annotations: entry.annotations }, run.topics, { compact: true });
      run.topics = accepted.topics; Object.assign(run.annotations, accepted.annotations); restored++;
    } catch { skipped++; }
  }
  if (restored) {
    run.cache_reused = (run.cache_reused ?? 0) + restored;
    run.analysis_revision++; run.findings = []; run.findings_revision = null;
  }
  return { restored, skipped };
}

export async function storeCache(run, reviews) {
  if (!run.settings.cache_dir) return { written: 0, failed: 0 };
  let written = 0; let failed = 0;
  for (const review of reviews) {
    const units = reviewUnits([review]);
    if (!units.every((u) => Object.hasOwn(run.annotations, u.unit_id))) continue;
    const annotations = units.map((unit) => ({ unit_id: unit.unit_id, ...run.annotations[unit.unit_id] }));
    const used = new Set(annotations.flatMap((a) => a.observations.map((o) => o.topic_id)));
    try {
      await writeJson(location(run.settings.cache_dir, review), { rules_version: RULES_VERSION,
        fingerprint: fingerprint(review), topics: run.topics.filter((topic) => used.has(topic.id)), annotations });
      written++;
    } catch { failed++; }
  }
  return { written, failed };
}
