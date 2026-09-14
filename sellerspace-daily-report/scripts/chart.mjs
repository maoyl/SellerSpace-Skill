#!/usr/bin/env node
/**
 * SellerSpace 日报趋势图（纯 Node，无第三方依赖）。
 * node chart.mjs <input.json> <output.svg> [<output.png>]
 *
 * {
 *   "title": "近7天经营趋势",
 *   "subtitle": "店铺 · US · 09-07 至 09-13",
 *   "currency": "USD",
 *   "labels": ["09-07", "09-08", "09-09"],
 *   "series": [
 *     {"name":"销售额","color":"#3370ff","format":"currency","data":[120,null,80]},
 *     {"name":"广告花费","color":"#ff7d00","format":"currency","data":[20,15,18]},
 *     {"name":"订单数","color":"#00b578","format":"int","data":[10,8,7]}
 *   ],
 *   "footer": "数据来源：优麦云（SellerSpace）"
 * }
 *
 * format: currency=金额（必须指定 currency）/ int=计数 / percent=比例小数 / number=数值。
 * 各 format 分面，避免金额与订单共用坐标轴；不同币种分别调用。
 * null/空字符串表示缺失，断线且不绘制数据点；有限十进制数值字符串可转换。
 * SVG 可跨平台生成；可选 PNG 用 macOS qlmanage，超时30秒，失败保留 SVG。
 * 退出码：2=输入无效或 SVG 写入失败；1=PNG 转换失败；0=成功。
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 1000;
const LEFT = 170;
const RIGHT = 945;
const COLORS = ["#3370ff", "#ff7d00", "#00b578", "#9254de"];
const FORMATS = new Set(["currency", "int", "percent", "number"]);
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function esc(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function numeric(value, location) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = typeof value === "string" && DECIMAL.test(value.trim()) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new Error(`${location} 必须为有限数值或 null`);
  }
  return number;
}

function niceStep(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const base = value / magnitude;
  return (base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10) * magnitude;
}

function scale(series, format) {
  let min = 0, max = 0;
  for (const item of series) for (const value of item.data) {
    if (value !== null) { min = Math.min(min, value); max = Math.max(max, value); }
  }
  const step = Math.max(format === "int" ? 1 : 0, niceStep((max - min || 1) / 5));
  const low = Math.floor(min / step) * step;
  const high = Math.ceil(max / step) * step;
  const upper = high > low ? high : low + step;
  if (![low, upper, step, upper - low].every(Number.isFinite) || step <= 0 || upper <= low) {
    throw new Error("数据范围过大或过小，无法绘图，请使用逐日表");
  }
  return { min: low, max: upper, step };
}

function formatted(value, format, money) {
  if (format === "currency") return money.format(value);
  if (format === "percent") return `${(value * 100).toFixed(2)}%`;
  return value.toLocaleString("en-US", { maximumFractionDigits: format === "int" ? 0 : 6 });
}

export function renderChart(cfg) {
  if (!cfg || !Array.isArray(cfg.labels) || !cfg.labels.length || !Array.isArray(cfg.series) || !cfg.series.length) {
    throw new Error("labels / series 必须为非空数组");
  }
  const labels = cfg.labels.map((label) => {
    if (typeof label !== "string" || !label.trim()) throw new Error("labels 必须为非空日期字符串");
    return label.trim();
  });
  if (new Set(labels).size !== labels.length) throw new Error("labels 存在重复日期，请先按站点和币种分组");
  const series = cfg.series.map((item, index) => {
    if (!item || typeof item.name !== "string" || !item.name.trim()) throw new Error("series 缺少 name");
    const format = item.format ?? "number";
    if (!FORMATS.has(format)) throw new Error(`不支持的 format: ${format}`);
    if (!Array.isArray(item.data) || item.data.length !== labels.length) throw new Error(`${item.name} 的数据长度必须与 labels 一致`);
    const color = item.color ?? COLORS[index % COLORS.length];
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`${item.name} 的 color 必须为六位十六进制颜色`);
    const data = item.data.map((value, i) => numeric(value, `${item.name}[${i}]`));
    if (format === "int" && data.some((value) => value !== null && !Number.isSafeInteger(value))) {
      throw new Error(`${item.name} 的计数必须为安全整数`);
    }
    return { name: item.name, format, color, data };
  });
  let money;
  if (series.some((item) => item.format === "currency")) {
    if (typeof cfg.currency !== "string" || !/^[A-Z]{3}$/.test(cfg.currency)) {
      throw new Error("金额序列必须提供响应中的三位币种代码 currency，如 USD/EUR");
    }
    money = new Intl.NumberFormat("en-US", { style: "currency", currency: cfg.currency, currencyDisplay: "code", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const groups = new Map();
  for (const item of series) {
    if (!groups.has(item.format)) groups.set(item.format, []);
    groups.get(item.format).push(item);
  }
  const parts = [];
  const text = (x, y, value, size = 19, anchor = "start", color = "#4e5969") =>
    `<text x="${x}" y="${y}" font-size="${size}" text-anchor="${anchor}" fill="${color}">${esc(value)}</text>`;
  parts.push(text(WIDTH / 2, 55, cfg.title || "经营趋势", 30, "middle", "#1f2329"));
  parts.push(text(WIDTH / 2, 93, cfg.subtitle || "", 19, "middle", "#646a73"));
  const x = (index) => labels.length === 1 ? (LEFT + RIGHT) / 2 : LEFT + (RIGHT - LEFT) * index / (labels.length - 1);
  let panelTop = 135;
  for (const [format, items] of groups) {
    const top = panelTop + 45 + items.length * 28;
    const bottom = top + 240;
    const range = scale(items, format);
    const y = (value) => bottom - (value - range.min) / (range.max - range.min) * (bottom - top);
    const unit = { currency: `金额（${cfg.currency}）`, int: "数量（笔/件）", percent: "比例（%）", number: "数值" }[format];
    parts.push(`<g data-panel="${format}">`, text(LEFT, panelTop, unit, 22, "start", "#1f2329"));
    items.forEach((item, index) => {
      const legendY = panelTop + 28 + index * 28;
      parts.push(`<rect x="${LEFT}" y="${legendY - 14}" width="16" height="16" rx="3" fill="${item.color}"/>`, text(LEFT + 26, legendY, item.name));
    });
    const tickCount = Math.round((range.max - range.min) / range.step);
    for (let i = 0; i <= tickCount; i++) {
      const value = range.min + i * range.step;
      const yy = y(value);
      parts.push(`<line x1="${LEFT}" y1="${yy}" x2="${RIGHT}" y2="${yy}" stroke="${Math.abs(value) < range.step * 1e-8 ? "#9aa4b2" : "#e8eaed"}"/>`);
      parts.push(text(LEFT - 14, yy + 6, formatted(value, format, money), 16, "end", "#646a73"));
    }
    parts.push(`<line x1="${LEFT}" y1="${top}" x2="${LEFT}" y2="${bottom}" stroke="#9aa4b2"/>`);
    const labelStep = Math.max(1, Math.ceil(labels.length / 8));
    labels.forEach((label, index) => {
      if (index % labelStep === 0 || index === labels.length - 1) parts.push(text(x(index), bottom + 30, label, 17, "middle"));
    });
    if (items.every((item) => item.data.every((value) => value === null))) {
      parts.push(text((LEFT + RIGHT) / 2, (top + bottom) / 2, "暂无有效数据", 22, "middle", "#646a73"));
    }
    for (const item of items) {
      let segment = [];
      const flush = () => {
        if (segment.length > 1) parts.push(`<polyline points="${segment.join(" ")}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linejoin="round"/>`);
        segment = [];
      };
      item.data.forEach((value, index) => {
        if (value === null) { flush(); return; }
        segment.push(`${x(index)},${y(value)}`);
      });
      flush();
      item.data.forEach((value, index) => {
        if (value === null) return;
        parts.push(`<circle cx="${x(index)}" cy="${y(value)}" r="5" fill="#ffffff" stroke="${item.color}" stroke-width="3"><title>${esc(`${labels[index]} ${item.name}: ${formatted(value, format, money)}`)}</title></circle>`);
      });
    }
    parts.push("</g>");
    panelTop = bottom + 85;
  }
  parts.push(text(WIDTH / 2, panelTop - 5, "空值保留断点；各图纵轴独立", 17, "middle", "#646a73"));
  parts.push(text(WIDTH / 2, panelTop + 28, cfg.footer || "数据来源：优麦云（SellerSpace）", 17, "middle", "#646a73"));
  const height = panelTop + 55;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="PingFang SC, Microsoft YaHei, sans-serif" role="img"><title>${esc(cfg.title || "经营趋势")}</title><rect width="${WIDTH}" height="${height}" fill="#ffffff"/>\n${parts.join("\n")}\n</svg>`;
}

function convertPng(svgPath, pngPath) {
  mkdirSync(path.dirname(pngPath), { recursive: true });
  // 独立临时目录避免把上次留下的 PNG 当成本次转换结果。
  const temporary = mkdtempSync(path.join(path.dirname(pngPath), ".chart-png-"));
  try {
    const result = spawnSync("qlmanage", ["-t", "-s", "2000", "-o", temporary, svgPath], { encoding: "utf8", timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout || "qlmanage 不可用");
    const generated = path.join(temporary, `${path.basename(svgPath)}.png`);
    if (!existsSync(generated)) throw new Error("qlmanage 未产出 PNG");
    renameSync(generated, pngPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const [input, svg, png] = process.argv.slice(2);
  if (!input || !svg) throw new Error("用法: node chart.mjs <input.json> <output.svg> [<output.png>]");
  const svgPath = path.resolve(svg);
  const pngPath = png ? path.resolve(png) : undefined;
  if (svgPath === path.resolve(input) || (pngPath && [svgPath, path.resolve(input)].includes(pngPath))) {
    throw new Error("输入、SVG 和 PNG 路径必须不同");
  }
  const rendered = renderChart(JSON.parse(readFileSync(input, "utf8")));
  mkdirSync(path.dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, rendered, "utf8");
  console.log("SVG written:", svgPath);
  if (pngPath) {
    try {
      convertPng(svgPath, pngPath);
      console.log("PNG written:", pngPath);
    } catch (error) {
      console.error(`chart.mjs: PNG 转换失败：${error.message}。本次仅交付 SVG 和逐日表，勿引用旧 PNG。`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`chart.mjs: ${error.message}`); process.exitCode = 2; }
}
