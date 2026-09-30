import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createOfficialCodingPlanGatewayFetch,
  resolveOfficialCodingPlanGatewayUrl,
  OFFICIAL_CODING_PLAN_GATEWAY_ROUTES,
} from "../packages/adapters/src/model/official-coding-plan-gateway.ts";
import { ensureDefaultPluginMarketplaces } from "../packages/adapters/src/plugins/marketplace.ts";
import {
  prepareModelTelemetryEnv,
  createModelTelemetry,
} from "../packages/telemetry/src/bootstrap.ts";
import { startProcessProviderRegistryRuntime } from "../packages/bootstrap/src/app/process-provider-registry-runtime.ts";
import { createZCodeApp } from "../packages/bootstrap/src/app/create-app.ts";
import {
  describeZCodePlugin,
  updateZCodePluginMarketplace,
  validateZCodePlugin,
} from "../packages/bootstrap/src/plugins.ts";
import { runPrompt } from "../packages/cli/src/prompt-command.ts";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.ts";

const builtinConfigPath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

test("官方端点、URL 与 Request 不改写到厂商网关", async () => {
  const seen = [];
  const transport = createOfficialCodingPlanGatewayFetch({
    env: { ZCODE_BASE_URL: "https://vendor.invalid" },
    fetch: async (input, init) => {
      seen.push(input instanceof Request ? input.url : String(input));
      assert.equal(init?.headers?.["x-test"], "yes");
      return new Response("ok");
    },
  });
  for (const route of OFFICIAL_CODING_PLAN_GATEWAY_ROUTES) {
    const url = route.providerEndpoint + "?test=1";
    assert.deepEqual(resolveOfficialCodingPlanGatewayUrl(url), { viaGateway: false, url });
    for (const input of [url, new URL(url), new Request(url)])
      await transport(input, { headers: { "x-test": "yes" } });
  }
  assert.ok(seen.every((url) => !url.includes("vendor.invalid")));
});

test("默认不注册远程市场，显式启用可注册", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comecode-market-"));
  try {
    assert.deepEqual(ensureDefaultPluginMarketplaces(dir), []);
    await assert.rejects(stat(join(dir, "known_marketplaces.json")), { code: "ENOENT" });
    assert.ok(ensureDefaultPluginMarketplaces(dir, { enabled: true }).length > 0);
    assert.deepEqual(ensureDefaultPluginMarketplaces(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("未设置 OTLP 时不创建遥测 Owner", async () => {
  assert.deepEqual(await prepareModelTelemetryEnv({}), {});
  assert.equal(createModelTelemetry().enabled, false);
});

test("历史官方市场的远程操作关闭，本地随包详情可用", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-plugin-"));
  const marketplace = "zcode-plugins-official";
  const pluginStorageRoot = join(root, "plugins");
  const manifestRoot = join(pluginStorageRoot, "marketplaces", marketplace);
  const cachePath = join(pluginStorageRoot, "cache", marketplace, "local-plugin", "1.0.0");
  const options = {
    env: { COMECODE_DATA_BASE_DIR: root },
    skipUserConfig: true,
    workingDirectory: root,
    pluginStorageRoot,
    marketplace,
    pluginName: "local-plugin",
  };
  try {
    await assert.rejects(updateZCodePluginMarketplace(options), /远程插件市场默认关闭/u);
    await assert.rejects(describeZCodePlugin(options), /远程插件市场默认关闭/u);
    await mkdir(manifestRoot, { recursive: true });
    const manifestPath = join(manifestRoot, "marketplace.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: marketplace,
        plugins: [{ name: "local-plugin", source: "https://unexpected.example/plugin.git" }],
      }),
    );
    await assert.rejects(describeZCodePlugin(options), /远程插件市场默认关闭/u);
    await assert.rejects(validateZCodePlugin(options), /远程插件市场默认关闭/u);
    await mkdir(join(cachePath, ".zcode-plugin"), { recursive: true });
    await writeFile(
      join(cachePath, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "local-plugin", version: "1.0.0" }),
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        name: marketplace,
        plugins: [{ name: "local-plugin", source: "filesystem", cachePath }],
      }),
    );
    const description = await describeZCodePlugin(options);
    assert.equal(description.diagnostics.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("显式官方市场配置可切换到用户指定的本地来源", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-market-config-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "comecode-market-source-"));
  const pluginStorageRoot = join(root, "plugins");
  const sourcePath = join(sourceRoot, "marketplace.json");
  const configPath = join(root, "config.json");
  await writeFile(sourcePath, JSON.stringify({ name: "zcode-plugins-official", plugins: [] }));
  await writeFile(configPath, JSON.stringify({
    plugins: {
      extraKnownMarketplaces: {
        "zcode-plugins-official": { source: { source: "file", path: sourcePath } },
      },
    },
  }));
  try {
    const result = await updateZCodePluginMarketplace({
      env: { COMECODE_DATA_BASE_DIR: root },
      userConfigPath: configPath,
      workingDirectory: root,
      pluginStorageRoot,
    });
    assert.equal(result.diagnostics.some((item) => item.code === "plugin_marketplace_declaration_reserved"), false);
    assert.equal(result.marketplaces[0]?.id, "zcode-plugins-official");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(sourceRoot, { recursive: true, force: true });
  }
});

test("完整会话仅请求用户配置的模型白名单主机", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-runtime-"));
  const dataRoot = join(root, ".comecode");
  const legacyPath = join(dataRoot, "cli", "config.json");
  await mkdir(join(dataRoot, "cli"), { recursive: true });
  await writeFile(
    legacyPath,
    JSON.stringify({
      provider: {
        example: {
          source: "custom",
          kind: "openai-compatible",
          options: { apiKey: "test-only-key", baseURL: "https://model.example/v1" },
          models: { "test-model": { contextWindow: 32000 } },
        },
      },
      model: { main: "example/test-model" },
    }),
  );
  const previousFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requested.push(url);
    assert.equal(url.hostname, "model.example", `非白名单请求：${url}`);
    const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;
    return new Response(
      frame({
        id: "test",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "ComeCode smoke ok" },
            finish_reason: null,
          },
        ],
      }) +
        frame({
          id: "test",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }) +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  let runtime;
  let app;
  try {
    const env = { COMECODE_DATA_BASE_DIR: root };
    Object.assign(
      env,
      await prepareCliProviderRuntimeEnv({
        argv: ["-p", "Reply with ComeCode smoke ok"],
        env,
        entrypoint: fileURLToPath(new URL("../packages/cli/src/main.ts", import.meta.url)),
      }),
    );
    assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, builtinConfigPath);
    assert.equal(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, join(dataRoot, "v2", "provider_config.json"));
    runtime = await startProcessProviderRegistryRuntime(env, {
      standalone: { legacyCliUserConfigFilePath: legacyPath },
    });
    const provider = runtime.runtime.registryService
      .getView()
      .providers.find((item) => item.providerId === "example");
    assert.equal(
      provider?.models.some((model) => model.modelId === "test-model"),
      true,
    );
    assert.deepEqual(runtime.configuredDefaultModelSelection, {
      providerId: "example",
      modelId: "test-model",
    });
    app = await createZCodeApp({
      env,
      providerRegistry: runtime.runtime.registryService,
      configuredDefaultModelSelection: runtime.configuredDefaultModelSelection,
      runtimeConfig: {
        workingDirectory: root,
        dynamicWorkflowEnabled: false,
        memory: { extractionEnabled: false },
        modelStreaming: "on",
      },
    });
    const result = await app.submitPrompt("Reply with ComeCode smoke ok");
    assert.equal(result.response, "ComeCode smoke ok");
    assert.ok(requested.length > 0);
    assert.deepEqual([...new Set(requested.map((url) => url.hostname))], ["model.example"]);
    await assert.rejects(stat(join(root, ".zcode")), { code: "ENOENT" });
  } finally {
    await app?.close();
    runtime?.dispose();
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("全新无 Provider 的无头启动返回配置引导，不启动账号或模型请求", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-no-provider-"));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("不应访问网络");
  };
  let stderr = "";
  try {
    const status = await runPrompt(
      {
        stderr: {
          write: (value) => {
            stderr += value;
          },
        },
        stdout: { write() {} },
      },
      "你好",
      [],
      { locale: "zh-CN" },
      {
        env: {
          COMECODE_DATA_BASE_DIR: root,
          COMECODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfigPath,
          COMECODE_PERSONAL_PROVIDER_CONFIG_FILE: join(
            root,
            ".comecode",
            "v2",
            "provider_config.json",
          ),
        },
        cwd: () => root,
        createZCodeApp,
        startProcessProviderRegistryRuntime,
      },
      "test",
    );
    assert.equal(status, 1);
    assert.match(stderr, /provider_config\.json/u);
    assert.doesNotMatch(stderr, /\/login/u);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
