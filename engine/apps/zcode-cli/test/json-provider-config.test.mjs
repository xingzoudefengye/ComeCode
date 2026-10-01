import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseUnifiedConfigJson,
  resolveUnifiedConfig,
  resolveUnifiedConfigPaths,
  materializeUnifiedConfig,
  toPublicUnifiedConfig,
} from "../packages/adapters/dist/config/provider-config.js";
import { decodeProviderConfigFile } from "../../../packages/provider-node/dist/provider-config-file-codec.js";
import { runProviderConfigSetup } from "../packages/cli/src/provider-config-setup.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-json-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "user");
  await mkdir(dataRoot);
  await mkdir(join(root, ".comecode"));
  await writeFile(join(root, ".comecode", "config.json"), "{}");
  return {
    root,
    dataRoot,
    cwd: root,
    env: {},
    targetProviderFile: join(dataRoot, "v2", "provider_config.json"),
  };
}
const definition = () => ({
  provider: "my-api",
  model: "second",
  providers: [
    {
      id: "my-api",
      name: "模型服务",
      type: "openai-chat",
      baseUrl: "https://example.test/v1",
      apiKey: "shared-private-secret",
      contextWindow: 512000,
      maxOutputTokens: 64000,
      toolCalling: true,
      vision: false,
      models: [
        "first",
        { id: "second", name: "第二模型", vision: true },
        {
          id: "vendor/third",
          type: "anthropic",
          baseUrl: "https://example.test/anthropic",
          apiKeyEnv: "OTHER_KEY",
          contextWindow: 128000,
        },
      ],
    },
  ],
});

test("JSON 多模型字段与 JSONC 注释/尾逗号解析，保留 URL 与字符串符号", () => {
  assert.deepEqual(parseUnifiedConfigJson(JSON.stringify(definition())).diagnostics.errors, []);
  const parsed = parseUnifiedConfigJson(
    '// 中文注释\n{"providers":[{"id":"api","baseUrl":"https://example.test/a//b/*c*/", "models":["a",],},], /* 注释 */}',
    "config.jsonc",
  );
  assert.deepEqual(parsed.diagnostics.errors, []);
  assert.equal(parsed.document.providers.api.baseUrl, "https://example.test/a//b/*c*/");
  for (const input of [
    '{"apiKey":"sensitive-secret",',
    '{"providers":[{"id":"a","contextWindow":0}]}',
    '{"providers":[{"id":"a","vision":"false"}]}',
    '{"providers":[{"id":"a","type":"unknown"}]}',
    '{"providers":[{"id":"a","typo":true}]}',
    '{"providers":[{"id":"a"},{"id":"a"}]}',
    '{"providers":[{"id":"a","models":["x",{"id":"x"}]}]}',
  ]) {
    const errors = parseUnifiedConfigJson(input).diagnostics.errors.join("\n");
    assert.ok(errors.length, input);
    assert.doesNotMatch(errors, /sensitive-secret/u);
  }
  assert.ok(parseUnifiedConfigJson("{ /* 不闭合", "config.jsonc").diagnostics.errors.length);
  assert.ok(parseUnifiedConfigJson("{ // 注释\n}", "config.json").diagnostics.errors.length);
});

test("同目录 JSON > JSONC > TOML，项目最近目录优先且覆盖用户同名模型字段", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify(definition()));
  await writeFile(join(f.dataRoot, "config.toml"), 'model = "ignored"');
  await writeFile(join(f.dataRoot, "config.jsonc"), "{}");
  const projectFile = join(f.root, ".comecode", "config.json");
  await writeFile(
    projectFile,
    JSON.stringify({
      providers: [{ id: "my-api", models: [{ id: "second", contextWindow: 32000 }] }],
    }),
  );
  const resolved = await resolveUnifiedConfig(f);
  assert.equal(resolved.paths.user, join(f.dataRoot, "config.json"));
  assert.equal(resolved.paths.project, projectFile);
  assert.match(resolved.diagnostics.warnings.join("\n"), /忽略同目录/u);
  const model = resolved.providers[0].modelConfigs[0];
  assert.equal(model.id, "second");
  assert.equal(model.name, "第二模型");
  assert.equal(model.contextWindow, 32000);
  assert.equal(model.vision, true);
  assert.equal(model.maxOutputTokens, 64000);
  assert.equal(model.apiKey, "shared-private-secret");
  assert.deepEqual(resolved.providers[0].models, ["second"]);
  const child = join(f.root, "child");
  await mkdir(join(child, ".comecode"), { recursive: true });
  await writeFile(join(child, ".comecode", "config.toml"), "# nearest\n");
  assert.equal(
    resolveUnifiedConfigPaths({ ...f, cwd: child }).project,
    join(child, ".comecode", "config.toml"),
  );
  const override = await resolveUnifiedConfig({
    ...f,
    env: { COMECODE_MODEL: "env-model", MODEL: "ignored" },
    cliOverrides: { model: "cli-model" },
  });
  assert.equal(override.model, "cli-model");
  assert.ok(override.providers[0].models.includes("cli-model"));
});

test("同供应商模型级协议/密钥/能力生效，旧 codec 兼容，show 全层脱敏", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify(definition()));
  const resolved = await materializeUnifiedConfig({
    ...f,
    env: { OTHER_KEY: "other-private-secret" },
  });
  assert.deepEqual(resolved.diagnostics.errors, []);
  const model = resolved.providers[0].modelConfigs[2];
  assert.equal(model.apiType, "anthropic-messages");
  assert.equal(model.apiKey, "other-private-secret");
  const update = decodeProviderConfigFile(JSON.parse(await readFile(f.targetProviderFile, "utf8")));
  assert.equal(
    update.providers.get("my-api").modelOverrides["vendor/third"].api.type,
    "anthropic-messages",
  );
  assert.equal(update.models.getExact("my-api", "second").properties.contextWindow, 512000);
  assert.equal(
    update.models.getExact("my-api", "second").properties.inputFormat.supportsImage,
    true,
  );
  assert.equal(update.models.getExact("my-api", "second").optionSpecs.maxOutputTokens.max, 64000);
  assert.equal(update.defaultModelSelection.modelId, "second");
  const publicText = JSON.stringify(toPublicUnifiedConfig(resolved));
  assert.doesNotMatch(publicText, /shared-private-secret|other-private-secret/u);
  assert.match(publicText, /第二模型/u);
  const stored = JSON.parse(await readFile(f.targetProviderFile, "utf8"));
  stored.config.modelConfigRules.providerModelRules.find(
    (rule) => rule.modelId === "first",
  ).config.properties.contextWindow = 96000;
  await writeFile(f.targetProviderFile, JSON.stringify(stored));
  const next = definition();
  delete next.providers[0].contextWindow;
  next.providers[0].models = ["first"];
  next.model = "first";
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify(next));
  await materializeUnifiedConfig({ ...f, legacyProviderFile: f.targetProviderFile });
  const after = decodeProviderConfigFile(JSON.parse(await readFile(f.targetProviderFile, "utf8")));
  assert.equal(after.models.getExact("my-api", "first").properties.contextWindow, 96000);
  assert.equal(after.models.getExact("my-api", "second"), undefined);
});

test("非法 JSON 不写运行时配置，空 JSONC 不阻断环境零配置，Gemini 不执行", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dataRoot, "config.json"), '{"apiKey":"do-not-leak",');
  await mkdir(join(f.dataRoot, "v2"));
  const previous =
    '{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[]},"modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}';
  await writeFile(f.targetProviderFile, previous);
  const result = await materializeUnifiedConfig(f);
  assert.ok(result.diagnostics.errors.length);
  assert.equal(await readFile(f.targetProviderFile, "utf8"), previous);
  await rm(join(f.dataRoot, "config.json"));
  await writeFile(join(f.dataRoot, "config.jsonc"), "// 模板\n{}");
  const envConfig = await resolveUnifiedConfig({ ...f, env: { OPENAI_API_KEY: "fake-test-key" } });
  assert.equal(envConfig.provider, "openai");
  assert.equal(envConfig.providers[0].executable, true);
  const gemini = definition();
  gemini.providers[0].models.push({ id: "gemini-model", type: "gemini" });
  gemini.model = "gemini-model";
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify(gemini));
  const config = await materializeUnifiedConfig({ ...f, env: { OTHER_KEY: "other-test-key" } });
  assert.equal(config.providers[0].modelConfigs.at(-1).executable, false);
  const stored = decodeProviderConfigFile(JSON.parse(await readFile(f.targetProviderFile, "utf8")));
  assert.ok(!stored.providers.get("my-api").personalModelIds.includes("gemini-model"));
});

test("简单向导不覆盖已有多模型 JSON/JSONC/TOML", async (t) => {
  const f = await fixture(t);
  const env = { COMECODE_DATA_BASE_DIR: f.root };
  for (const name of ["config.json", "config.jsonc", "config.toml"]) {
    const file = join(f.root, ".comecode", name);
    const content = name.endsWith("toml")
      ? 'provider = "api"\n[providers.api]\nmodels = ["a", "b"]\n'
      : JSON.stringify(definition());
    await writeFile(file, content);
    let stderr = "";
    const ctx = {
      stdin: { isTTY: true },
      stderr: {
        isTTY: true,
        write: (text) => {
          stderr += text;
        },
      },
      stdout: { write() {} },
    };
    assert.equal(
      await runProviderConfigSetup(ctx, env, f.root, () => {
        throw new Error("已有配置不能询问覆盖");
      }),
      1,
    );
    assert.equal(await readFile(file, "utf8"), content);
    assert.match(stderr, /未修改/u);
    await rm(file);
  }
});

test(
  "真实 bundle 同供应商不同协议：默认第二模型、CLI 切换、窗口与凭据均正确",
  { timeout: 90000 },
  async (t) => {
    const { createServer } = await import("node:http");
    const { spawn } = await import("node:child_process");
    const f = await fixture(t);
    const requests = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        url: request.url,
        model: body.model,
        auth: request.headers.authorization,
        key: request.headers["x-api-key"],
        body,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
      if (request.url.endsWith("/messages")) {
        const event = (value) => `event: ${value.type}\n${frame(value)}`;
        response.end(
          event({
            type: "message_start",
            message: {
              id: "msg-test",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              usage: { input_tokens: 16000, output_tokens: 0 },
            },
          }) +
            event({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            }) +
            event({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "JSON model ok" },
            }) +
            event({ type: "content_block_stop", index: 0 }) +
            event({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 3 },
            }) +
            event({ type: "message_stop" }),
        );
      } else if (request.url.endsWith("/responses")) {
        const item = {
          id: "msg",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "JSON model ok", annotations: [] }],
        };
        response.end(
          frame({
            type: "response.created",
            response: {
              id: "resp",
              created_at: 1,
              model: body.model,
              output: [],
              status: "in_progress",
            },
          }) +
            frame({
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            }) +
            frame({
              type: "response.content_part.added",
              item_id: "msg",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }) +
            frame({
              type: "response.output_text.delta",
              item_id: "msg",
              output_index: 0,
              content_index: 0,
              delta: "JSON model ok",
            }) +
            frame({ type: "response.output_item.done", output_index: 0, item }) +
            frame({
              type: "response.completed",
              response: {
                id: "resp",
                created_at: 1,
                model: body.model,
                status: "completed",
                output: [item],
                usage: { input_tokens: 16000, output_tokens: 3, total_tokens: 16003 },
              },
            }),
        );
      } else
        response.end(
          frame({
            id: "chat",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "JSON model ok" },
                finish_reason: null,
              },
            ],
          }) +
            frame({
              id: "chat",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 16000, completion_tokens: 3, total_tokens: 16003 },
            }) +
            "data: [DONE]\n\n",
        );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const doc = definition();
    doc.providers[0].baseUrl = `${base}/chat/v1`;
    doc.providers[0].models[2].baseUrl = `${base}/anthropic/v1`;
    doc.providers[0].models.push({
      id: "responses-model",
      type: "openai-responses",
      baseUrl: `${base}/responses/v1`,
      contextWindow: 64000,
    });
    await writeFile(join(f.root, ".comecode", "config.json"), JSON.stringify(doc));
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/^(COMECODE_|ZCODE_|OPENAI_|ANTHROPIC_|GEMINI_|OTEL_)/u.test(key) || key === "MODEL")
        delete env[key];
    env.COMECODE_DATA_BASE_DIR = f.root;
    env.OTHER_KEY = "other-private-secret";
    const bundle = fileURLToPath(new URL("../packages/cli/dist/zcode.cjs", import.meta.url));
    for (const [model, window, extra, endpoint, key] of [
      ["second", 512000, [], "/chat/v1/chat/completions", "shared-private-secret"],
      [
        "vendor/third",
        128000,
        ["--provider", "my-api", "--model", "vendor/third"],
        "/anthropic/v1/messages",
        "other-private-secret",
      ],
      [
        "responses-model",
        64000,
        ["--model", "responses-model"],
        "/responses/v1/responses",
        "shared-private-secret",
      ],
    ]) {
      const child = spawn(
        process.execPath,
        [
          bundle,
          "--cwd",
          f.root,
          ...extra,
          "--output-format",
          "stream-json",
          "-p",
          "Reply JSON model ok",
        ],
        { cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("bundle 验收超时"));
        }, 20000);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
      assert.equal(code, 0, stderr);
      const result = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((row) => row.type === "result");
      assert.equal(result.response, "JSON model ok");
      assert.equal(result.projection.contextWindow, window, model);
      const actual = requests.at(-1);
      assert.equal(actual.model, model);
      assert.equal(actual.url, endpoint);
      assert.ok(actual.auth === `Bearer ${key}` || actual.key === key);
      assert.doesNotMatch(stdout + stderr, /shared-private-secret|other-private-secret/u);
    }
  },
);

test("供应商修改地址与密钥后不被旧运行时模型覆盖，非托管供应商保持原样", async (t) => {
  const f = await fixture(t);
  const doc = definition();
  doc.providers[0].models = ["first", "second"];
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify(doc));
  await materializeUnifiedConfig(f);
  const original = JSON.parse(await readFile(f.targetProviderFile, "utf8"));
  const unrelated = {
    providerId: "other-api",
    config: {
      group: "standard-personal",
      api: { type: "openai-chat-completions", baseUrl: "https://other.example/v1" },
      access: { type: "api-key", apiKey: "other-key" },
      personalModelIds: ["other-model"],
    },
  };
  original.config.providerConfigRules.providerRules.push(unrelated);
  original.config.modelConfigRules.providerModelRules.push({
    providerId: "other-api",
    modelId: "other-model",
    config: { properties: { contextWindow: 96000 } },
  });
  await writeFile(f.targetProviderFile, JSON.stringify(original));
  doc.providers[0].baseUrl = "https://changed.example/v1";
  doc.providers[0].apiKey = "changed-private-secret";
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify(doc));
  const resolved = await materializeUnifiedConfig({
    ...f,
    legacyProviderFile: f.targetProviderFile,
  });
  for (const model of resolved.providers.find((provider) => provider.id === "my-api")
    .modelConfigs) {
    assert.equal(model.baseUrl, doc.providers[0].baseUrl);
    assert.equal(model.apiKey, doc.providers[0].apiKey);
  }
  const updated = JSON.parse(await readFile(f.targetProviderFile, "utf8"));
  assert.deepEqual(
    updated.config.providerConfigRules.providerRules.find(
      (rule) => rule.providerId === "other-api",
    ),
    unrelated,
  );
  assert.equal(
    updated.config.modelConfigRules.providerModelRules.find(
      (rule) => rule.providerId === "other-api",
    ).config.properties.contextWindow,
    96000,
  );
});

test("模型显示名、能力与输出上限在实际 Registry 与模型工厂生效", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify(definition()));
  await materializeUnifiedConfig({ ...f, env: { OTHER_KEY: "other-key" } });
  const { startProcessProviderRegistryRuntime } =
    await import("../packages/bootstrap/src/app/process-provider-registry-runtime.ts");
  const { listRegistryBackedModels } =
    await import("../packages/bootstrap/src/app/provider-registry-selection.ts");
  const { ApiProviderModelRuntime } =
    await import("../packages/bootstrap/src/app/provider-registry-model-runtime.ts");
  const builtin = fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  );
  const started = await startProcessProviderRegistryRuntime({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: f.targetProviderFile,
  });
  t.after(() => started.dispose());
  const registry = started.runtime.registryService;
  const models = listRegistryBackedModels(registry);
  const model = models.find((item) => item.ref.modelId === "second");
  assert.equal(model.label, "第二模型");
  assert.equal(model.contextWindow, 512000);
  assert.equal(model.maxOutputTokens, 64000);
  assert.equal(model.properties.inputFormat.supportsImage, true);
  assert.equal(registry.getModel("my-api", "first").config.properties.supportsToolCall, true);
  let input;
  const runtime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: {
      createModel: (value) => {
        input = value;
        return {};
      },
    },
  });
  runtime.start();
  runtime.modelFactory({
    selection: {
      providerId: "my-api",
      modelId: "vendor/third",
      options: {
        reasoningLevel: registry.getModel("my-api", "vendor/third").config.optionSpecs
          .reasoningLevel.values[0],
      },
    },
  });
  assert.equal(input.providerConfig.api.type, "anthropic-messages");
  assert.equal(input.providerConfig.access.apiKey, "other-key");
  assert.equal(input.modelConfig.properties.contextWindow, 128000);
  assert.match(input.modelConfig.optionSpecs.maxOutputTokens.map, /max_tokens/u);
  runtime.dispose();
});

test("config show 输出模型精细字段并脱敏，选中 Gemini 的 check/runtime 拒绝回退", async (t) => {
  const f = await fixture(t);
  const { runConfigCommand } = await import("../packages/cli/src/config-command.ts");
  const { prepareCliProviderRuntimeEnv } =
    await import("../packages/cli/src/provider-runtime-env.ts");
  const doc = definition();
  doc.providers[0].models.push({ id: "gemini-model", type: "gemini" });
  doc.model = "gemini-model";
  await writeFile(join(f.root, ".comecode", "config.json"), JSON.stringify(doc));
  const env = {
    COMECODE_DATA_BASE_DIR: join(f.root, "isolated"),
    OTHER_KEY: "other-private-secret",
  };
  let stdout = "";
  const ctx = {
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: { write() {} },
  };
  assert.equal(
    await runConfigCommand(ctx, { json: true }, { env, cwd: () => f.root }, ["show"]),
    0,
  );
  const publicConfig = JSON.parse(stdout);
  assert.equal(publicConfig.providers[0].models[1].contextWindow, 512000);
  assert.doesNotMatch(stdout, /shared-private-secret|other-private-secret/u);
  stdout = "";
  assert.equal(
    await runConfigCommand(ctx, { json: true }, { env, cwd: () => f.root }, ["check"]),
    1,
  );
  assert.equal(JSON.parse(stdout).ok, false);
  await assert.rejects(
    prepareCliProviderRuntimeEnv({ argv: ["--cwd", f.root, "-p", "hello"], env }),
    /Gemini/u,
  );
});
