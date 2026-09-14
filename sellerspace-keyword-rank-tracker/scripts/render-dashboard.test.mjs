import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { renderDashboardHtml } from "./render-dashboard.mjs";

// 执行交付 HTML 中的脚本，记录真实的 DOM 更新、事件和图表参数。
function openDashboard(rows, { online = true } = {}) {
  class Element {
    children = [];
    dataset = {};
    attributes = {};
    listeners = {};
    classes = new Set();
    classList = { add: (name) => this.classes.add(name) };
    value = "";
    textContent = "";
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(event, callback) { this.listeners[event] = callback; }
    dispatch(event) { this.listeners[event]?.(); }
  }
  const html = renderDashboardHtml({
    project: { marketplace: "US" }, asin: "B0TARGET01", rows,
    targetHistoryHref: "target-rank-history.csv", latestRawHref: "all.csv",
  });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const ranges = [0, 14, 7].map((days) => {
    const button = new Element();
    button.dataset.days = String(days);
    return button;
  });
  const chart = {
    option: null,
    setOption(option) { this.option = option; },
    clear() { this.option = null; },
    resize() {},
  };
  const document = {
    getElementById: (id) => { assert.ok(elements.has(id), `missing element ${id}`); return elements.get(id); },
    createElement: () => new Element(),
    querySelectorAll: () => ranges,
  };
  const window = { addEventListener() {}, ...(online ? { echarts: { init: () => chart } } : {}) };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document, window }, { timeout: 1000 });
  return { elements, chart, ranges };
}

function observation(keyword, date, naturalRank, overrides = {}) {
  return {
    run_id: date, collected_at: `${date}T08:00:00.000Z`, keyword,
    natural_rank: naturalRank, best_ad_position: "", ad_types: "",
    status: naturalRank === "" ? "failed" : "ok", ...overrides,
  };
}

test("大小写和 NFKC 变体显示为同一关键词，筛选日期不改变变化值口径", () => {
  const { elements, chart, ranges } = openDashboard([
    observation("Yoga Mat", "2026-09-01", 10),
    observation("Ｙｏｇａ Ｍａｔ", "2026-09-11", ""),
    observation("yoga mat", "2026-09-14", 4),
    observation("other keyword", "2026-09-14", 20),
  ]);
  assert.equal(elements.get("keywordList").children.length, 2);
  assert.equal(elements.get("naturalDelta").textContent, "↑ 6");
  assert.deepEqual(Array.from(chart.option.series[0].data), [10, null, 4]);
  assert.equal(chart.option.series[0].connectNulls, false);
  assert.equal(chart.option.yAxis.inverse, true);
  ranges[2].dispatch("click");
  assert.deepEqual(Array.from(chart.option.series[0].data), [null, 4]);
  assert.equal(elements.get("historyRows").children[0].children[3].textContent, "↑ 6");
  elements.get("keywordList").children[1].dispatch("click");
  assert.equal(elements.get("selectedKeyword").textContent, "other keyword");
  assert.equal(elements.get("naturalRank").textContent, "20");
  const search = elements.get("keywordSearch");
  search.value = "yoga";
  search.dispatch("input");
  assert.equal(elements.get("keywordList").children.length, 1);
});

test("CDN 不可用时仍显示历史表，关键词作为文本展示", () => {
  const keyword = "</script><script>throw new Error('injected')</script>";
  const { elements } = openDashboard([observation(keyword, "2026-09-14", 3)], { online: false });
  assert.equal(elements.get("selectedKeyword").textContent, keyword);
  assert.equal(elements.get("historyRows").children.length, 1);
  assert.equal(elements.get("historyRows").children[0].children[2].textContent, "3");
  assert.ok(elements.get("dependencyAlert").classes.has("visible"));
});
