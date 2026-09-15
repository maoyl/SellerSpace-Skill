// Canonical source: scripts/templates/sellerspace-review-source.mjs. Bundled for standalone installation.
import { createHash } from "node:crypto";
export const ACTION_ID = "amazon.product.reviews";
const MINIMUM_ACTION_VERSION = 4;
const ARTIFACT_SCHEMA_VERSION = 1;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 120_000;
const V4_FIELDS = ["crawlMode", "starFilters", "includeHelpful", "knownReviewIds", "knownReviewStreak"];
const REQUIRED_TOOLS = [
  "discover_capabilities",
  "browser_list",
  "browser_submit_task",
  "browser_get_task",
];

export class ReviewSourceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ReviewSourceError";
    this.code = code;
    this.details = details;
  }
}
export function validatePreflight(preflight) {
  if (!preflight || typeof preflight !== "object") {
    throw new ReviewSourceError("PREFLIGHT_REQUIRED", "必须先检查 sellerspace-mcp 和在线浏览器");
  }
  const tools = new Set(Array.isArray(preflight.required_tools) ? preflight.required_tools.map(String) : []);
  const missingTools = REQUIRED_TOOLS.filter((name) => !tools.has(name));
  if (missingTools.length) {
    throw new ReviewSourceError("MCP_TOOLS_MISSING", `sellerspace-mcp 缺少必需工具：${missingTools.join("、")}`, { missing_tools: missingTools });
  }
  if (preflight.mcp_ready !== true) {
    throw new ReviewSourceError("MCP_NOT_READY", "sellerspace-mcp 未安装、未启用或当前无法连接");
  }
  if (preflight.action_id !== ACTION_ID || preflight.action_available !== true) {
    throw new ReviewSourceError("ACTION_UNAVAILABLE", `sellerspace-mcp 未提供可用的 ${ACTION_ID} Action`);
  }
  if (preflight.action_read_only !== true || !Array.isArray(preflight.action_input_fields)
    || V4_FIELDS.some((field) => !preflight.action_input_fields.includes(field))) {
    throw new ReviewSourceError("ACTION_CONTRACT_MISMATCH", "预检必须确认只读 Action 和全部 v4 输入字段");
  }
  const actionVersion = integer(preflight.action_version);
  if (actionVersion === null || actionVersion < MINIMUM_ACTION_VERSION) {
    throw new ReviewSourceError(
      "ACTION_VERSION_TOO_OLD",
      `SellerSpace 浏览器插件的评论 Action 需要 v${MINIMUM_ACTION_VERSION} 或更高版本，不会降级为 v3 快照抓取`,
      { action_version: actionVersion, minimum_version: MINIMUM_ACTION_VERSION },
    );
  }
  if (preflight.browser_online !== true || !nonEmpty(preflight.browser_id)) {
    throw new ReviewSourceError("NO_ONLINE_BROWSER", "没有符合要求的在线 SellerSpace 浏览器插件");
  }
  const artifactVersion = integer(preflight.artifact_schema_version);
  if (preflight.artifact_delivery_available !== true || artifactVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new ReviewSourceError("ARTIFACT_DELIVERY_UNAVAILABLE", "Browser Hub 不支持所需的 Artifact schema v1", { artifact_schema_version: artifactVersion });
  }
  return {
    mcp_server: "sellerspace-mcp",
    required_tools: [...REQUIRED_TOOLS],
    action_id: ACTION_ID,
    action_version: actionVersion,
    action_read_only: true,
    action_input_fields: [...V4_FIELDS],
    browser_id: String(preflight.browser_id).trim(),
    browser_online: true,
    artifact_delivery_available: true,
    artifact_schema_version: artifactVersion,
    checked_at: validTimestamp(preflight.checked_at) ?? new Date().toISOString(),
    browser_meta: sanitizeObject(preflight.browser_meta),
  };
}

export async function downloadBrowserArtifact(artifact, options = {}) {
  const reference = validateArtifactReference(artifact);
  let url;
  try { url = new URL(reference.downloadUrl); } catch { throw new ReviewSourceError("ARTIFACT_REFERENCE_INVALID", "Artifact downloadUrl 格式无效"); }
  const localHttp = options.allowLocalHttp === true && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new ReviewSourceError("ARTIFACT_URL_UNSAFE", "Artifact 地址必须使用 HTTPS；仅本机测试允许 HTTP loopback");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new ReviewSourceError("ARTIFACT_DOWNLOAD_FAILED", "当前 Node 环境不支持下载 Artifact");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? ARTIFACT_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new ReviewSourceError("ARTIFACT_DOWNLOAD_FAILED", `Artifact 下载失败（HTTP ${response.status}）`);
    // Node fetch decodes Content-Encoding: gzip. Limit/hash the decoded bytes.
    const bytes = await readResponseBytes(response, MAX_ARTIFACT_BYTES);
    if (bytes.byteLength !== reference.uncompressedSizeBytes) throw new ReviewSourceError("ARTIFACT_SIZE_MISMATCH", "Artifact 解压后大小与元数据不一致");
    if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new ReviewSourceError("ARTIFACT_CHECKSUM_MISMATCH", "Artifact SHA-256 校验失败");
    let result;
    try { result = JSON.parse(bytes.toString("utf8")); } catch { throw new ReviewSourceError("ARTIFACT_INVALID_JSON", "Artifact 内容不是有效 JSON"); }
    return { result, source_artifact: { ...sanitizeArtifactReference(reference), downloaded_at: new Date().toISOString() } };
  } catch (error) {
    if (error instanceof ReviewSourceError) throw error;
    throw new ReviewSourceError("ARTIFACT_DOWNLOAD_FAILED", controller.signal.aborted ? "Artifact 下载超时" : "Artifact 下载中断或网络请求失败");
  } finally { clearTimeout(timer); }
}

function validateArtifactReference(value) {
  if (!value || typeof value !== "object") throw new ReviewSourceError("ARTIFACT_REFERENCE_INVALID", "缺少有效 Artifact 引用");
  const schemaVersion = integer(value.schemaVersion);
  const size = integer(value.uncompressedSizeBytes);
  if (schemaVersion !== ARTIFACT_SCHEMA_VERSION) throw new ReviewSourceError("ARTIFACT_SCHEMA_UNSUPPORTED", `不支持 Artifact schemaVersion=${schemaVersion}`);
  if (!nonEmpty(value.id) || !nonEmpty(value.downloadUrl) || !/^[0-9a-f]{64}$/i.test(String(value.sha256 ?? ""))) throw new ReviewSourceError("ARTIFACT_REFERENCE_INVALID", "Artifact 引用缺少 id、downloadUrl 或有效 SHA-256");
  if (size === null || size < 0 || size > MAX_ARTIFACT_BYTES) throw new ReviewSourceError("ARTIFACT_TOO_LARGE", `Artifact 解压后大小必须在 0-${MAX_ARTIFACT_BYTES} bytes`);
  if (value.contentEncoding && value.contentEncoding !== "gzip" && value.contentEncoding !== "identity") throw new ReviewSourceError("ARTIFACT_ENCODING_UNSUPPORTED", "Artifact 仅支持 gzip 或 identity 编码");
  return { ...value, schemaVersion, uncompressedSizeBytes: size, id: String(value.id), downloadUrl: String(value.downloadUrl), sha256: String(value.sha256).toLowerCase() };
}

function sanitizeArtifactReference(value) {
  const safe = {};
  for (const key of ["schemaVersion", "id", "format", "contentType", "contentEncoding", "sha256", "sizeBytes", "uncompressedSizeBytes", "createdAt", "retentionExpiresAt", "downloadExpiresAt"]) {
    if (value?.[key] !== undefined && value[key] !== null) safe[key] = value[key];
  }
  return safe;
}

async function readResponseBytes(response, maximum) {
  if (!response.body) throw new ReviewSourceError("ARTIFACT_DOWNLOAD_FAILED", "Artifact 响应没有内容");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ReviewSourceError("ARTIFACT_TOO_LARGE", `Artifact 解压后超过 ${maximum} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}
function integer(value) { if (value === null || value === undefined || value === "" || typeof value === "boolean") return null; const number = Number(value); return Number.isSafeInteger(number) ? number : null; }
function nonNegativeInteger(value) { const number = integer(value); return number !== null && number >= 0 ? number : null; }
function nonEmpty(value) { return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null && String(value).trim().length > 0; }
function validTimestamp(value) { if (!nonEmpty(value)) return null; const time = typeof value === "number" ? value : Date.parse(String(value)); return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null; }
function sanitizeObject(value) { if (!value || typeof value !== "object" || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value).filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))); }
