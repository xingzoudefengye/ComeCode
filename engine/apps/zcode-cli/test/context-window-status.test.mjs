import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { EventReducer } from "../packages/contracts/src/events/event-reducer.ts";
import { initialSessionProjection } from "../packages/contracts/src/events/event-reducer-helpers.ts";
import { applyModelCacheAndBudgetEvent } from "../packages/tui/src/app-turn-complete.ts";
import { InputActiveStatus } from "../packages/tui/src/app-input-status.tsx";
import { getZCodeCopy } from "../packages/i18n/src/index.ts";

const event = (payload) => ({ type: "model_complete", sessionId: "test", timestamp: new Date(), payload });
const mainPayload = {
  querySource: "main_turn",
  contextWindow: 1_000_000,
  compactThreshold: 600_000,
  usage: { inputTokens: 16_200, outputTokens: 100, totalTokens: 16_300 },
  content: "ok", stopReason: "stop",
};

test("主请求窗口同时更新会话投影与 TUI，回合 projection 不再回退至 200K", () => {
  const reducer = new EventReducer();
  const projection = reducer.apply({ ...initialSessionProjection, contextWindow: 200_000 }, event(mainPayload));
  assert.equal(projection.contextUsed, 16_300);
  assert.equal(projection.contextWindow, 1_000_000);
  let context = { contextUsed: 16_200, contextWindow: 200_000 };
  const setContext = (update) => { context = update(context); };
  applyModelCacheAndBudgetEvent(mainPayload, () => {}, setContext);
  assert.equal(context.contextWindow, 1_000_000);
  assert.equal(context.compactThreshold, 600_000);
  // useTuiApplyResult 会合并权威回合 projection，模拟该合并验证窗口不回退。
  context = { ...context, contextWindow: projection.contextWindow, contextUsed: projection.contextUsed };
  assert.equal(context.contextWindow, 1_000_000);
});

test("旧主请求窗口可更新；辅助请求和非法/缺失窗口不覆盖主状态", () => {
  const reducer = new EventReducer();
  let context = { contextWindow: 512_000, compactThreshold: 307_200 };
  const setContext = (update) => { context = update(context); };
  const projection = { ...initialSessionProjection, contextWindow: 512_000 };
  for (const querySource of ["title", "compact", "subagent", "tool_internal", "goal_completion_verification"]) {
    const payload = { ...mainPayload, querySource, contextWindow: 32_000, compactThreshold: 19_200 };
    assert.equal(reducer.apply(projection, event(payload)).contextWindow, 512_000);
    applyModelCacheAndBudgetEvent(payload, () => {}, setContext);
    assert.equal(context.contextWindow, 512_000);
    assert.equal(context.compactThreshold, 307_200);
  }
  for (const contextWindow of [undefined, 0, -1, NaN, Infinity]) {
    const payload = { ...mainPayload, contextWindow, compactThreshold: undefined };
    assert.equal(reducer.apply(projection, event(payload)).contextWindow, 512_000);
    applyModelCacheAndBudgetEvent(payload, () => {}, setContext);
    assert.equal(context.contextWindow, 512_000);
  }
  const legacyPayload = { ...mainPayload, querySource: undefined, contextWindow: 128_000, compactThreshold: 76_800 };
  assert.equal(reducer.apply(projection, event(legacyPayload)).contextWindow, 128_000);
  applyModelCacheAndBudgetEvent(legacyPayload, () => {}, setContext);
  assert.equal(context.contextWindow, 128_000);
  const internalPayload = { ...legacyPayload, stopReason: "tool_internal", contextWindow: 32_000 };
  assert.equal(reducer.apply(projection, event(internalPayload)).contextWindow, 512_000);
  applyModelCacheAndBudgetEvent(internalPayload, () => {}, setContext);
  assert.equal(context.contextWindow, 128_000);
});

test("原生状态栏显示 16.2K/1M（2%）和 Compact 600K，明确模型窗口不改为默认", async () => {
  const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
  const React = require("react");
  const { testRender } = await import(pathToFileURL(require.resolve("@mbears/opentui-react/test-utils")));
  const copy = getZCodeCopy("en-US").tui;
  for (const [contextWindow, compactThreshold, expected] of [
    [1_000_000, 600_000, /16\.2K\/1M \(2%\).*Compact 600K/u],
    [512_000, 307_200, /16\.2K\/512K \(3%\).*Compact 307\.2K/u],
    [128_000, 76_800, /16\.2K\/128K \(13%\).*Compact 76\.8K/u],
  ]) {
    let context = { contextUsed: 16_200, contextWindow: 200_000 };
    applyModelCacheAndBudgetEvent({ ...mainPayload, contextWindow, compactThreshold }, () => {}, (update) => { context = update(context); });
    let view;
    await React.act(async () => {
      view = await testRender(React.createElement(InputActiveStatus, { active: false, contentWidth: 120, copy, model: "my-api/deepseek-flash", contextUsage: context }), { width: 120, height: 1 });
      await view.flush();
    });
    try { assert.match(view.captureCharFrame(), expected); }
    finally { await React.act(async () => view.renderer.destroy()); }
  }
});

test("构建产物默认窗口和压缩阈值与源码一致", async () => {
  const { initialSessionProjection: compiledProjection } = await import("../packages/contracts/dist/events/event-reducer-helpers.js");
  const { DEFAULT_COMPACT_CONTEXT_WINDOW, getAutoCompactThreshold } = await import("../packages/core/dist/compact/policy.js");
  assert.equal(compiledProjection.contextWindow, 512_000);
  assert.equal(DEFAULT_COMPACT_CONTEXT_WINDOW, 512_000);
  assert.equal(getAutoCompactThreshold(), 384_000);
});

test("CLI 构建前更新过期 contracts/core，不依赖旧 dist", async (t) => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { rebuildCliRuntimeDependencies } = await import("../packages/cli/scripts/build.mjs");
  const rootDirectory = await mkdtemp(join(tmpdir(), "comecode-build-window-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  for (const name of ["contracts", "core"]) {
    const root = join(rootDirectory, "packages", name);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", rootDir: "src", outDir: "dist", types: [] }, include: ["src/**/*.ts"] }), "utf8");
    await writeFile(join(root, "src", "index.ts"), "export const contextWindow = 512000;\n", "utf8");
    await writeFile(join(root, "dist", "index.js"), "export const contextWindow = 200000;\n", "utf8");
  }
  await rebuildCliRuntimeDependencies({ rootDirectory });
  for (const name of ["contracts", "core"]) {
    const compiled = await readFile(join(rootDirectory, "packages", name, "dist", "index.js"), "utf8");
    assert.match(compiled, /contextWindow = 512000/u);
    assert.doesNotMatch(compiled, /200000/u);
  }
});

test("Registry 未知模型用 512K，deepseek-flash 保留 1M，显式模型 32K 不覆盖", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { startProcessProviderRegistryRuntime } = await import("../packages/bootstrap/src/app/process-provider-registry-runtime.ts");
  const root = await mkdtemp(join(tmpdir(), "comecode-registry-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const personalFile = join(root, "provider_config.json");
  await writeFile(personalFile, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: "test", config: {
      group: "standard-personal", access: { type: "api-key", apiKey: "fake-key" },
      api: { type: "openai-chat-completions", baseUrl: "https://model.example/v1" },
      personalModelIds: ["unknown-model", "deepseek-flash", "small-model"],
    } }] },
    modelConfigRules: { providerModelRules: [{ providerId: "test", modelId: "small-model", config: { properties: { contextWindow: 32_000 } } }], manualProviderModelRules: [] },
  } }), "utf8");
  const runtime = await startProcessProviderRegistryRuntime({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url)),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFile,
  });
  try {
    const models = runtime.runtime.registryService.getView().providers.find((p) => p.providerId === "test").models;
    assert.equal(models.find((m) => m.modelId === "unknown-model").config.properties.contextWindow, 512_000);
    assert.equal(models.find((m) => m.modelId === "deepseek-flash").config.properties.contextWindow, 1_000_000);
    assert.equal(models.find((m) => m.modelId === "small-model").config.properties.contextWindow, 32_000);
  } finally { runtime.dispose(); }
});

test("新 CLI bundle 完整对话的窗口与模型目录一致，不再返回旧 200K projection", { timeout: 45000 }, async (t) => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "comecode-bundle-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".comecode"), { recursive: true });
  await writeFile(join(root, ".comecode", "config.toml"), "# isolated test project\n", "utf8");
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body.model);
    const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame({ id: "window", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Window smoke ok" }, finish_reason: null }] }) +
      frame({ id: "window", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 16200, completion_tokens: 3, total_tokens: 16203 } }) + "data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(COMECODE_|ZCODE_|OPENAI_|ANTHROPIC_|GEMINI_|OTEL_)/u.test(key) || key === "MODEL") delete env[key];
  }
  env.COMECODE_DATA_BASE_DIR = root;
  const bundle = fileURLToPath(new URL("../packages/cli/dist/zcode.cjs", import.meta.url));
  for (const [model, window] of [["unknown-model", 512_000], ["deepseek-flash", 1_000_000]]) {
    // 只注册本次模型，窗口验收不依赖多个模型的初始化档位选择。
    const caseRoot = join(root, model);
    await mkdir(join(caseRoot, ".comecode"), { recursive: true });
    await writeFile(join(caseRoot, ".comecode", "config.toml"), [
      `model = ${JSON.stringify(model)}`, 'provider = "local"', '[providers.local]',
      'type = "openai-chat"', `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'api_key = "fake-test-key"', '',
    ].join("\n"), "utf8");
    const child = spawn(process.execPath, [bundle, "--cwd", caseRoot, "--output-format", "stream-json", "-p", "Reply Window smoke ok"], { cwd: caseRoot, env: { ...env, COMECODE_DATA_BASE_DIR: caseRoot }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("bundle 窗口验收超时")); }, 20000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (value) => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, stderr);
    const rows = stdout.trim().split("\n").map((line) => JSON.parse(line));
    const result = rows.find((row) => row.type === "result");
    assert.equal(requests.at(-1), model, `实际请求没有选择 ${model}`);
    assert.equal(result.response, "Window smoke ok");
    assert.equal(result.projection.contextWindow, window, model);
    assert.equal(result.projection.contextUsed, 16_203);
  }
  assert.deepEqual([...new Set(requests)], ["unknown-model", "deepseek-flash"]);
});
