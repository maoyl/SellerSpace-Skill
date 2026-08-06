#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const skillDir = resolve(scriptDir, "..");
const contractPath = resolve(skillDir, "references", "contract.json");
const setupPagePath = resolve(skillDir, "assets", "configure.html");
const DEFAULT_MCP_URL = "https://www.sellerspace.com/mcp/";
const DEFAULT_API_KEY_VALIDATION_URL =
  "https://www.sellerspace.com/api/mcp/analysis/profile";
const DEFAULT_SETUP_TTL_MS = 10 * 60 * 1000;
const LEGACY_CONFIG_DIR = resolve(homedir(), ".sellerspace-operator");

class CliFailure extends Error {
  constructor(payload, exitCode = 1) {
    super(payload?.error?.message || "CLI failure");
    this.payload = payload;
    this.exitCode = exitCode;
  }
}

let bundledContract;
try {
  bundledContract = JSON.parse(await readFile(contractPath, "utf8"));
  validateBundledContract(bundledContract);
} catch (error) {
  print({
    ok: false,
    ready: false,
    error: {
      code: "INVALID_BUNDLED_CONTRACT",
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exit(2);
}

const configurationDirectory = resolveConfigurationDirectory();
const credentialsPath = resolve(configurationDirectory, "credentials.json");
const setupStatePath = resolve(configurationDirectory, "setup-session.json");
const setupAssetDefinitions = [
  ["/assets/sellerspace-logo.png", "sellerspace-logo.png", "image/png"],
  ["/assets/connection-hero.png", "connection-hero.png", "image/png"],
  ["/assets/check-circle.svg", "check-circle.svg", "image/svg+xml"],
].map(([path, file, contentType]) => ({
  path,
  file: resolve(skillDir, "assets", file),
  contentType,
}));

const command = process.argv[2] || "";
const commandArgs = process.argv.slice(3);

try {
  if (command === "__configure-server") {
    await serveConfigurationPage();
  } else if (command === "preflight") {
    await preflight();
  } else if (command === "doctor") {
    await preflight();
  } else if (command === "configure") {
    await configure();
  } else if (command === "contract") {
    print(readLocalContract());
  } else if (command === "call") {
    const operation = commandArgs[0];
    if (!operation) fail("USAGE_ERROR", "call 需要 operation 名。", 2);
    assertAllowedOperation(operation);
    const input = await readStdinJson();
    const credential = await requireCredential();
    print(await withCredentialRecovery(
      credential,
      (apiKey) => callOperation(operation, input, apiKey),
    ));
  } else if (command === "apply") {
    rejectReadOnlyOperation("apply_change_plan");
    fail("UNSUPPORTED_COMMAND", "当前 Skill 不支持 apply。", 2);
  } else {
    fail(
      "USAGE_ERROR",
      "可用命令：preflight | doctor | configure | contract | call <operation>",
      2,
    );
  }
} catch (error) {
  if (error instanceof CliFailure) {
    print(error.payload);
    process.exitCode = error.exitCode;
  } else {
    print({
      ok: false,
      ready: false,
      error: {
        code: "CLI_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    process.exitCode = 1;
  }
}

function validateBundledContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("contract.json 必须是 JSON 对象。");
  }
  for (const field of ["skill", "skillVersion", "contractHash", "accessMode"]) {
    if (typeof contract[field] !== "string" || !contract[field].trim()) {
      throw new Error(`contract.json 缺少有效字段：${field}`);
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(contract.skillVersion)) {
    throw new Error("contract.json 的 skillVersion 必须是语义化版本。");
  }
  if (basename(skillDir) !== contract.skill) {
    throw new Error("contract.json 的 skill 必须与当前 Skill 目录一致。");
  }
  if (contract.minimumSkillVersion !== contract.skillVersion) {
    throw new Error("contract.json 的 Skill 版本字段不一致。");
  }
  if (!/^[a-f0-9]{64}$/.test(contract.contractHash)) {
    throw new Error("contract.json 的 contractHash 无效。");
  }
  if (contract.accessMode !== "read-only") {
    throw new Error("此运行时仅允许 read-only Skill 契约。");
  }
  if (!Array.isArray(contract.operations) || contract.operations.length === 0) {
    throw new Error("contract.json 必须声明至少一个 operation。");
  }
  const names = new Set();
  for (const operation of contract.operations) {
    if (!operation || typeof operation.name !== "string" || !operation.name) {
      throw new Error("contract.json 包含无效 operation。");
    }
    if (names.has(operation.name)) {
      throw new Error(`contract.json 包含重复 operation：${operation.name}`);
    }
    names.add(operation.name);
    if (contract.accessMode === "read-only") {
      if (operation.readOnly !== true || operation.destructive === true) {
        throw new Error(`只读契约包含非只读 operation：${operation.name}`);
      }
    }
  }
}

function resolveConfigurationDirectory() {
  const configured = process.env.SELLERSPACE_SKILL_CONFIG_DIR?.trim()
    || process.env.SELLERSPACE_OPERATOR_CONFIG_DIR?.trim();
  return resolve(configured || resolve(homedir(), ".sellerspace"));
}

async function preflight() {
  assertSupportedNodeVersion();
  const credential = await requireCredential();
  await withCredentialRecovery(credential, async (apiKey) => {
    await validateApiKey(apiKey);
    await requestMcp("ping", {}, apiKey);
    const result = await requestMcp("tools/list", {}, apiKey);
    validateLiveContract(result);
  });
  print({
    ok: true,
    ready: true,
    skill: bundledContract.skill,
    skillVersion: bundledContract.skillVersion,
    accessMode: bundledContract.accessMode,
    mcpReachable: true,
    apiKeyValid: true,
    requiredOperations: bundledContract.operations.map(({ name }) => name),
    contractHash: bundledContract.contractHash,
    credentialSource: credential.source,
  });
}

function assertSupportedNodeVersion() {
  const required = bundledContract.minimumNodeVersion || "18.0.0";
  const current = process.versions.node;
  if (compareVersions(current, required) < 0) {
    fail(
      "UNSUPPORTED_NODE_VERSION",
      `需要 Node.js ${required} 或更高版本，当前为 ${current}。`,
      2,
    );
  }
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateLiveContract(result) {
  if (!Array.isArray(result?.tools)) {
    fail("INVALID_TOOLS_LIST", "MCP tools/list 响应缺少 tools 数组。", 1);
  }
  const liveTools = new Map(
    result.tools
      .filter((tool) => tool && typeof tool.name === "string")
      .map((tool) => [tool.name, tool]),
  );
  for (const operation of bundledContract.operations) {
    const live = liveTools.get(operation.name);
    if (!live) {
      fail(
        "REQUIRED_OPERATION_UNAVAILABLE",
        `SellerSpace MCP 缺少必需 operation：${operation.name}`,
        1,
      );
    }
    if (!live.inputSchema || typeof live.inputSchema !== "object" || Array.isArray(live.inputSchema)) {
      fail(
        "MCP_CONTRACT_INCOMPATIBLE",
        `SellerSpace MCP operation 缺少有效 inputSchema：${operation.name}`,
        1,
      );
    }
    if (bundledContract.accessMode === "read-only") {
      const annotations = live.annotations;
      if (
        !annotations
        || annotations.readOnlyHint !== true
        || annotations.destructiveHint === true
      ) {
        fail(
          "READ_ONLY_CONTRACT_VIOLATION",
          `SellerSpace MCP operation 未满足只读注解要求：${operation.name}`,
          1,
        );
      }
    }
  }
}

function readLocalContract() {
  return {
    ok: true,
    skill: bundledContract.skill,
    skillVersion: bundledContract.skillVersion,
    apiVersion: bundledContract.apiVersion,
    accessMode: bundledContract.accessMode,
    contractHash: bundledContract.contractHash,
    operations: bundledContract.operations.map((operation) => ({ ...operation })),
  };
}

function assertAllowedOperation(operation) {
  const allowed = bundledContract.operations.some((item) => item.name === operation);
  if (allowed) return;
  if (bundledContract.accessMode === "read-only") {
    rejectReadOnlyOperation(operation);
  }
  fail("UNKNOWN_OPERATION", `Skill 包不包含 operation：${operation}`, 2);
}

function rejectReadOnlyOperation(operation) {
  fail(
    "READ_ONLY_SKILL",
    `当前 Skill 为只读模式，禁止执行 operation：${operation}`,
    2,
  );
}

async function configure() {
  if (commandArgs[0] === "status") {
    const credential = await readCredential();
    const state = await readLiveSetupState();
    print({
      ok: true,
      apiKeyConfigured: Boolean(credential),
      credentialSource: credential?.source ?? null,
      setup: state ? publicSetupState(state) : null,
    });
    return;
  }
  if (commandArgs.length > 0) {
    fail("USAGE_ERROR", "configure 仅支持无参数或 configure status。", 2);
  }
  const credential = await readCredential();
  if (credential) {
    print({
      ok: true,
      apiKeyConfigured: true,
      credentialSource: credential.source,
      message: "SellerSpace API Key 已配置。",
    });
    return;
  }
  print({
    ok: true,
    apiKeyConfigured: false,
    configurationRequired: true,
    setup: await ensureConfigurationServer(),
  });
}

async function callOperation(operation, input, apiKey) {
  const response = await requestMcp("tools/call", {
    name: operation,
    arguments: input,
  }, apiKey);
  return normalizeMcpToolResult(operation, response);
}

async function requestMcp(method, params, apiKey) {
  const mcpUrl = normalizeMcpUrl(
    process.env.SELLERSPACE_MCP_URL?.trim() || DEFAULT_MCP_URL,
  );
  const controller = new AbortController();
  const timeoutMs = readTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "User-Agent": `${bundledContract.skill}/${bundledContract.skillVersion}`,
        "X-SellerSpace-Contract-Hash": bundledContract.contractHash,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail("REQUEST_TIMEOUT", `SellerSpace 请求超过 ${timeoutMs}ms。`, 1);
    }
    fail("NETWORK_ERROR", "无法连接 SellerSpace MCP。", 1);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let payload;
  try {
    payload = parseMcpHttpPayload(text, response.headers.get("content-type") || "");
  } catch {
    fail("INVALID_RESPONSE", `SellerSpace MCP 返回无效响应（HTTP ${response.status}）。`, 1);
  }
  if (!response.ok) {
    throw new CliFailure({
      ok: false,
      ready: false,
      error: {
        code: response.status === 401 || response.status === 403
          ? "AUTHENTICATION_REQUIRED"
          : "HTTP_ERROR",
        message: readMcpErrorMessage(payload) || `HTTP ${response.status}`,
      },
    }, response.status === 401 || response.status === 403 ? 3 : 1);
  }
  if (payload?.error) {
    throw new CliFailure({
      ok: false,
      ready: false,
      error: {
        code: "MCP_ERROR",
        message: readMcpErrorMessage(payload) || "SellerSpace MCP 调用失败。",
      },
    }, 1);
  }
  if (!payload || typeof payload !== "object" || !("result" in payload)) {
    fail("INVALID_RESPONSE", "SellerSpace MCP 响应缺少 result。", 1);
  }
  return payload.result;
}

function normalizeMcpToolResult(operation, result) {
  const data = readMcpToolData(result);
  const whatsNew = data.__whatsNew ?? null;
  delete data.__whatsNew;
  if (result?.isError) {
    throw new CliFailure({
      ok: false,
      operation,
      contractHash: bundledContract.contractHash,
      error: {
        code: typeof data.errorCode === "string" ? data.errorCode : "TOOL_ERROR",
        message: typeof data.message === "string"
          ? data.message
          : typeof data.error === "string"
            ? data.error
            : "SellerSpace operation 执行失败。",
      },
      meta: {
        whatsNew,
        ...(typeof data.retryAfterMs === "number"
          ? { retryAfterMs: data.retryAfterMs }
          : {}),
      },
    }, 1);
  }
  return {
    ok: true,
    operation,
    contractHash: bundledContract.contractHash,
    data,
    meta: { whatsNew },
  };
}

function readMcpToolData(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object"
    && !Array.isArray(result.structuredContent)) {
    return { ...result.structuredContent };
  }
  if (Array.isArray(result?.content)) {
    for (let index = result.content.length - 1; index >= 0; index -= 1) {
      const item = result.content[index];
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed = JSON.parse(item.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { ...parsed };
        }
      } catch {
        // 普通文本不是 JSON，继续查找。
      }
    }
    return { content: result.content };
  }
  return {};
}

function parseMcpHttpPayload(text, contentType) {
  if (!text.trim()) return {};
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    messages.push(JSON.parse(data));
  }
  if (messages.length === 0) {
    throw new Error("SSE response does not contain a data event");
  }
  return messages.at(-1);
}

function readMcpErrorMessage(payload) {
  if (typeof payload?.error === "string") return payload.error;
  if (typeof payload?.error?.message === "string") return payload.error.message;
  if (typeof payload?.message === "string") return payload.message;
  return "";
}

async function validateApiKey(apiKey) {
  const validationUrl = normalizeHttpsUrl(
    process.env.SELLERSPACE_API_KEY_VALIDATION_URL?.trim()
      || DEFAULT_API_KEY_VALIDATION_URL,
    "SELLERSPACE_API_KEY_VALIDATION_URL",
  );
  const controller = new AbortController();
  const timeoutMs = readTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(validationUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "X-API-Key": apiKey,
        "User-Agent": `${bundledContract.skill}/${bundledContract.skillVersion}`,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail("REQUEST_TIMEOUT", `SellerSpace Key 验证超过 ${timeoutMs}ms。`, 1);
    }
    fail("NETWORK_ERROR", "无法连接 SellerSpace Key 验证接口。", 1);
  } finally {
    clearTimeout(timeout);
  }
  let payload;
  try {
    const text = await response.text();
    payload = text ? JSON.parse(text) : {};
  } catch {
    fail("INVALID_RESPONSE", `SellerSpace Key 验证接口返回非 JSON（HTTP ${response.status}）。`, 1);
  }
  if (!response.ok) {
    throw new CliFailure(
      payload && typeof payload === "object"
        ? payload
        : { ok: false, error: { code: "HTTP_ERROR", message: `HTTP ${response.status}` } },
      response.status === 401 || response.status === 403 ? 3 : 1,
    );
  }
  const profile = payload?.data && typeof payload.data === "object"
    ? payload.data
    : payload;
  const accountId = profile?.rawUserId ?? profile?.userId;
  if (accountId === undefined || accountId === null || accountId === "") {
    fail("INVALID_RESPONSE", "SellerSpace 账号验证响应缺少用户标识。", 1);
  }
}

async function readCredential() {
  const selected = await readCredentialFile(credentialsPath, "local");
  if (selected) return selected;

  const defaultConfigurationDirectory = resolve(homedir(), ".sellerspace");
  if (
    configurationDirectory === defaultConfigurationDirectory
    && LEGACY_CONFIG_DIR !== configurationDirectory
  ) {
    const legacy = await readCredentialFile(
      resolve(LEGACY_CONFIG_DIR, "credentials.json"),
      "legacy-local-read-only",
    );
    if (legacy) return legacy;
  }

  const environmentKey = process.env.SELLERSPACE_API_KEY?.trim();
  return environmentKey
    ? { apiKey: environmentKey, source: "environment" }
    : null;
}

async function readCredentialFile(path, source) {
  try {
    const stored = JSON.parse(await readFile(path, "utf8"));
    const apiKey = typeof stored.apiKey === "string" ? stored.apiKey.trim() : "";
    return apiKey ? { apiKey, source } : null;
  } catch {
    return null;
  }
}

async function requireCredential() {
  const credential = await readCredential();
  if (credential) return credential;
  const setup = await ensureConfigurationServer();
  throw new CliFailure({
    ok: false,
    ready: false,
    configurationRequired: true,
    setup,
    error: {
      code: "CONFIGURATION_REQUIRED",
      message: "请打开 setup.url，在本机配置 SellerSpace API Key 后重试。",
    },
  }, 2);
}

async function withCredentialRecovery(credential, callback) {
  try {
    return await callback(credential.apiKey);
  } catch (error) {
    if (!isAuthenticationFailure(error)) throw error;
    if (credential.source === "local") await rm(credentialsPath, { force: true });
    const setup = await ensureConfigurationServer();
    throw new CliFailure({
      ok: false,
      ready: false,
      apiKeyConfigured: false,
      credentialSource: credential.source,
      credentialExpired: true,
      configurationRequired: true,
      setup,
      error: {
        code: "CONFIGURATION_REQUIRED",
        message: "SellerSpace API Key 无效或已失效，请打开 setup.url 重新配置。",
      },
    }, 2);
  }
}

function isAuthenticationFailure(error) {
  if (!(error instanceof CliFailure)) return false;
  if (error.exitCode === 3) return true;
  const code = String(error.payload?.error?.code ?? error.payload?.errorCode ?? "");
  return code === "AUTHENTICATION_REQUIRED"
    || code === "MCP.Auth.Invalid"
    || code === "MCP_AUTH_INVALID";
}

async function writeCredential(apiKey) {
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await chmod(configurationDirectory, 0o700).catch(() => {});
  const temporaryPath = `${credentialsPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    version: 1,
    apiKey,
    updatedAt: new Date().toISOString(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600).catch(() => {});
  await rename(temporaryPath, credentialsPath);
  await chmod(credentialsPath, 0o600).catch(() => {});
}

async function ensureConfigurationServer() {
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await chmod(configurationDirectory, 0o700).catch(() => {});
  const existing = await readLiveSetupState();
  if (existing) return publicSetupState(existing);
  await rm(setupStatePath, { force: true });

  const startedAt = Date.now();
  const childEnvironment = { ...process.env };
  delete childEnvironment.SELLERSPACE_API_KEY;
  const child = spawn(process.execPath, [scriptPath, "__configure-server"], {
    detached: true,
    env: childEnvironment,
    stdio: "ignore",
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(50);
    const state = await readSetupState();
    if (state && state.startedAt >= startedAt && state.expiresAt > Date.now()
      && await isSetupServerAlive(state)) {
      return publicSetupState(state);
    }
  }
  fail("LOCAL_CONFIGURATION_FAILED", "无法启动 SellerSpace 本地配置页面。", 1);
}

async function serveConfigurationPage() {
  await mkdir(configurationDirectory, { recursive: true, mode: 0o700 });
  await chmod(configurationDirectory, 0o700).catch(() => {});
  const html = await readFile(setupPagePath, "utf8");
  const setupAssets = new Map(await Promise.all(
    setupAssetDefinitions.map(async (asset) => [
      asset.path,
      { body: await readFile(asset.file), contentType: asset.contentType },
    ]),
  ));
  const token = randomBytes(24).toString("hex");
  const setupPath = `/setup/${token}`;
  const ttlMs = readSetupTtlMs();
  let expectedHost = "";
  let closeTimer;

  const server = createServer((request, response) => {
    void handleConfigurationRequest({
      request,
      response,
      server,
      html,
      setupAssets,
      setupPath,
      expectedHost,
    }).catch(() => sendJsonResponse(response, 500, {
      ok: false,
      message: "本地配置服务发生错误，请重新打开配置页面。",
    }));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Local configuration server did not expose a TCP port");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  const startedAt = Date.now();
  const state = {
    version: 1,
    skill: bundledContract.skill,
    skillVersion: bundledContract.skillVersion,
    pid: process.pid,
    startedAt,
    expiresAt: startedAt + ttlMs,
    url: `http://${expectedHost}${setupPath}`,
    statusUrl: `http://${expectedHost}${setupPath}/status`,
  };
  await writePrivateJson(setupStatePath, state);

  const closeServer = () => {
    if (closeTimer) clearTimeout(closeTimer);
    server.close();
  };
  closeTimer = setTimeout(closeServer, ttlMs);
  closeTimer.unref();
  server.once("close", () => void removeSetupStateForCurrentProcess());
  process.once("SIGTERM", closeServer);
  process.once("SIGINT", closeServer);
  await new Promise((resolveClose) => server.once("close", resolveClose));
}

async function handleConfigurationRequest({
  request,
  response,
  server,
  html,
  setupAssets,
  setupPath,
  expectedHost,
}) {
  if (request.headers.host !== expectedHost) {
    sendJsonResponse(response, 403, { ok: false, message: "请求来源无效。" });
    return;
  }
  const requestUrl = new URL(request.url || "/", `http://${expectedHost}`);
  const setupAsset = setupAssets.get(requestUrl.pathname);
  if (request.method === "GET" && setupAsset) {
    sendAssetResponse(response, setupAsset);
    return;
  }
  if (request.method === "GET"
    && (requestUrl.pathname === setupPath || requestUrl.pathname === `${setupPath}/`)) {
    sendHtmlResponse(response, html);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === `${setupPath}/status`) {
    sendJsonResponse(response, 200, {
      ok: true,
      apiKeyConfigured: Boolean(await readCredential()),
    });
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === `${setupPath}/save`) {
    if (String(request.headers.origin || "") !== `http://${expectedHost}`) {
      sendJsonResponse(response, 403, { ok: false, message: "请求来源无效。" });
      return;
    }
    const input = await readRequestJson(request, 16 * 1024);
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey || apiKey.length > 4096) {
      sendJsonResponse(response, 400, { ok: false, message: "请输入有效的 API Key。" });
      return;
    }
    try {
      await validateApiKey(apiKey);
    } catch (error) {
      const authenticationFailure = error instanceof CliFailure && error.exitCode === 3;
      sendJsonResponse(response, authenticationFailure ? 401 : 502, {
        ok: false,
        message: authenticationFailure
          ? "API Key 无效或已失效，请检查后重试。"
          : "暂时无法验证 API Key，请检查网络后重试。",
      });
      return;
    }
    await writeCredential(apiKey);
    sendJsonResponse(response, 200, {
      ok: true,
      message: "SellerSpace 已连接，可以返回 AI 助手继续使用。",
    });
    setTimeout(() => server.close(), 1500).unref();
    return;
  }
  sendJsonResponse(response, 404, { ok: false, message: "页面不存在。" });
}

async function readRequestJson(request, limit) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw, "utf8") > limit) {
      throw new Error("Request body is too large");
    }
  }
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

async function readLiveSetupState() {
  const state = await readSetupState();
  if (!state || state.expiresAt <= Date.now()) return null;
  return await isSetupServerAlive(state) ? state : null;
}

async function readSetupState() {
  try {
    const state = JSON.parse(await readFile(setupStatePath, "utf8"));
    if (typeof state.startedAt !== "number" || typeof state.expiresAt !== "number"
      || typeof state.url !== "string" || typeof state.statusUrl !== "string"
      || state.skill !== bundledContract.skill
      || state.skillVersion !== bundledContract.skillVersion) {
      return null;
    }
    const url = new URL(state.url);
    const statusUrl = new URL(state.statusUrl);
    if (url.protocol !== "http:" || statusUrl.protocol !== "http:"
      || url.hostname !== "127.0.0.1" || statusUrl.hostname !== "127.0.0.1") {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function isSetupServerAlive(state) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300);
  try {
    const response = await fetch(state.statusUrl, {
      headers: { "Accept": "application/json" },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function publicSetupState(state) {
  return {
    action: "OPEN_LOCAL_CONFIGURATION",
    display: "local-browser-or-preview",
    localOnly: true,
    url: state.url,
    expiresAt: new Date(state.expiresAt).toISOString(),
  };
}

async function removeSetupStateForCurrentProcess() {
  const state = await readSetupState();
  if (state?.pid === process.pid) await rm(setupStatePath, { force: true });
}

async function writePrivateJson(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600).catch(() => {});
  await rename(temporaryPath, path);
  await chmod(path, 0o600).catch(() => {});
}

function sendHtmlResponse(response, html) {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; "
      + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

function sendAssetResponse(response, asset) {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": asset.contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(asset.body);
}

function sendJsonResponse(response, status, payload) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("INVALID_JSON_INPUT", "stdin JSON 必须是对象。", 2);
    }
    return parsed;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    fail("INVALID_JSON_INPUT", "stdin 不是有效 JSON。", 2);
  }
}

function normalizeMcpUrl(value) {
  const url = normalizeHttpsUrl(value, "SELLERSPACE_MCP_URL");
  if (url.pathname.endsWith("/mcp")) url.pathname += "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeHttpsUrl(value, settingName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("INVALID_BASE_URL", `${settingName} 不是有效 URL。`, 2);
  }
  const insecureLocalhost = process.env.SELLERSPACE_ALLOW_INSECURE_LOCALHOST === "1"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !insecureLocalhost) {
    fail("INVALID_BASE_URL", `${settingName} 必须使用 HTTPS。`, 2);
  }
  return url;
}

function readTimeoutMs() {
  const value = Number(process.env.SELLERSPACE_SKILL_TIMEOUT_MS || 60_000);
  return Number.isFinite(value) && value >= 1_000 && value <= 180_000
    ? value
    : 60_000;
}

function readSetupTtlMs() {
  const value = Number(process.env.SELLERSPACE_SETUP_TTL_MS || DEFAULT_SETUP_TTL_MS);
  return Number.isFinite(value) && value >= 5_000 && value <= 30 * 60 * 1000
    ? value
    : DEFAULT_SETUP_TTL_MS;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function fail(code, message, exitCode) {
  throw new CliFailure({
    ok: false,
    ready: false,
    error: { code, message },
  }, exitCode);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
