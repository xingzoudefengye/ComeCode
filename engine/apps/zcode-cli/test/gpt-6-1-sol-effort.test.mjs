import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText, streamText } from "ai";
import { materializeUnifiedConfig } from "../packages/adapters/src/config/provider-config-materialize.ts";
import { createProviderConfigEditor } from "../packages/adapters/src/config/provider-config-editor.ts";
import { AiSdkModelExecution } from "../packages/adapters/src/model/model-execution.ts";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
} from "../packages/adapters/src/model/runner-options.ts";
import { startProcessProviderRegistryRuntime } from "../packages/bootstrap/src/app/process-provider-registry-runtime.ts";
import { listRegistryBackedModels } from "../packages/bootstrap/src/app/provider-registry-selection.ts";

const levels = ["low", "medium", "high", "xhigh", "max"];
const modelId = "gpt-6.1-sol";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "comecode-gpt61-effort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "user");
  await mkdir(dataRoot);
  await mkdir(join(root, ".comecode"));
  await writeFile(join(root, ".comecode", "config.json"), "{}");
  const file = join(dataRoot, "config.json");
  await writeFile(
    file,
    JSON.stringify({
      provider: "fixture",
      model: modelId,
      providers: [
        {
          id: "fixture",
          type: "openai-responses",
          baseUrl: "https://effort.example/v1",
          apiKey: "fixture-not-real",
          models: [{ id: modelId, contextWindow: 128000, ...overrides }],
        },
      ],
    }),
  );
  const targetProviderFile = join(dataRoot, "v2", "provider_config.json");
  return {
    cwd: root,
    dataRoot,
    env: {},
    file,
    targetProviderFile,
    legacyProviderFile: targetProviderFile,
  };
}

async function registry(t, f) {
  await materializeUnifiedConfig(f);
  const started = await startProcessProviderRegistryRuntime({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: f.targetProviderFile,
  });
  t.after(() => started.dispose());
  const service = started.runtime.registryService;
  return {
    service,
    provider: service.getProvider("fixture"),
    model: service.getModel("fixture", modelId),
  };
}

test("GPT-6.1 Sol 只声明五档，保留窗口和原默认策略，不匹配无连字符别名", async (t) => {
  const f = await fixture(t);
  const { service, model } = await registry(t, f);
  assert.deepEqual(model.config.optionSpecs.reasoningLevel.values, levels);
  assert.equal(model.config.properties.contextWindow, 128000);
  const option = listRegistryBackedModels(service).find(
    (item) => item.ref.providerId === "fixture",
  );
  assert.deepEqual(
    option.reasoning.levels.map((item) => item.value),
    levels,
  );
  assert.equal(option.reasoning.defaultLevel, "high");
  for (const reasoningLevel of ["none", "minimal", "disabled", "enabled"]) {
    assert.equal(
      service.validateSelection({ providerId: "fixture", modelId, options: { reasoningLevel } })
        .code,
      "reasoning-level-not-supported",
    );
  }
  const builtin = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  const rule = builtin.config.modelConfigRules.modelRules.find((item) =>
    item.modelMatch.includes("gpt-6\\.1-sol"),
  );
  const pattern = new RegExp(`^(?:${rule.modelMatch})$`);
  assert.equal(pattern.test(modelId), true);
  assert.equal(pattern.test("gpt6.1-sol"), false);
});

test("管理配置 medium 与输出上限同时保存，物化及 Registry 默认不丢失", async (t) => {
  const f = await fixture(t, { reasoningLevel: "medium", maxOutputTokens: 64000 });
  const editor = createProviderConfigEditor(f);
  const before = await editor.read();
  await editor.save({ revision: before.revision, config: before.config });
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.providers[0].models[0].reasoningLevel, "medium");
  assert.equal(saved.providers[0].models[0].maxOutputTokens, 64000);
  const { service, model } = await registry(t, f);
  assert.equal(model.config.optionSpecs.reasoningLevel.default, "medium");
  assert.equal(model.config.optionSpecs.maxOutputTokens.max, 64000);
  const option = listRegistryBackedModels(service).find(
    (item) => item.ref.providerId === "fixture",
  );
  assert.equal(option.reasoning.defaultLevel, "medium");
});

test("五档经真实 Registry 映射进入 Responses 最终请求，stream/generate 原样透传", async (t) => {
  const f = await fixture(t, { reasoningLevel: "medium", maxOutputTokens: 64000 });
  const { service, provider, model } = await registry(t, f);
  const captured = [];
  const execution = new AiSdkModelExecution(
    { env: {} },
    {
      transport: async (url, init) => {
        assert.equal(String(url), "https://effort.example/v1/responses");
        captured.push(JSON.parse(init.body));
        return new Response(
          JSON.stringify({ error: { message: "local capture", type: "invalid_request_error" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        );
      },
    },
  );
  const binding = execution.bindModel({
    providerId: "fixture",
    modelId,
    providerConfig: provider.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: model.config.optionSpecs,
  });
  for (const reasoningLevel of levels) {
    const selection = {
      providerId: "fixture",
      modelId,
      options: { reasoningLevel, maxOutputTokens: 64000 },
    };
    assert.equal(service.validateSelection(selection).ok, true);
    for (const streaming of [false, true]) {
      const resolved = {
        ...binding.resolveRequest({ options: selection.options }),
        properties: model.config.properties,
      };
      const input = {
        resolved,
        includeModelIO: false,
        statusContext: { sessionId: "fixture-session" },
        request: { messages: [{ role: "user", content: "hello" }], tools: [] },
      };
      const count = captured.length;
      if (streaming) {
        const result = streamText({ ...createStreamTextOptions(input), onError: () => {} });
        const errors = [];
        for await (const part of result.fullStream)
          if (part.type === "error") errors.push(part.error);
        assert.equal(errors.length, 1);
      } else {
        await assert.rejects(generateText(createGenerateTextOptions(input)));
      }
      assert.equal(captured.length, count + 1);
      const body = captured.at(-1);
      assert.equal(body.model, modelId);
      assert.equal(body.reasoning.effort, reasoningLevel);
      assert.equal(body.max_output_tokens, 64000);
      assert.equal(body.stream === true, streaming);
      assert.equal(body.thinking, undefined);
      assert.equal(body.enable_thinking, undefined);
      assert.equal(body.reasoning_effort, undefined);
    }
  }
});
