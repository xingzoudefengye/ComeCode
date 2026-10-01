import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { materializeUnifiedConfig, parseUnifiedConfigJson, resolveUnifiedConfig } from "../packages/adapters/dist/config/provider-config.js";
import { createProviderConfigEditor } from "../packages/adapters/dist/config/provider-config-editor.js";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.ts";
import { testProviderConnection } from "../packages/cli/src/admin/test-connection.ts";
import { startProcessProviderRegistryRuntime } from "../packages/bootstrap/src/app/process-provider-registry-runtime.ts";
import { listRegistryBackedModels } from "../packages/bootstrap/src/app/provider-registry-selection.ts";

const definition = () => ({
  provider: "local", model: "model-a",
  providers: [{ id: "local", type: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "fixture-private-key",
    models: [{ id: "model-a", contextWindow: 96000 }, { id: "model-b", type: "anthropic" }, "legacy-model"],
  }],
});
async function fixture(t, config = definition()) {
  const root = await mkdtemp(join(tmpdir(), "comecode-model-enabled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "user");
  await mkdir(dataRoot);
  await mkdir(join(root, ".comecode"));
  await writeFile(join(root, ".comecode", "config.json"), "{}");
  const file = join(dataRoot, "config.json");
  await writeFile(file, JSON.stringify(config), "utf8");
  const targetProviderFile = join(dataRoot, "v2", "provider_config.json");
  return { cwd: root, dataRoot, env: {}, file, targetProviderFile, legacyProviderFile: targetProviderFile };
}
async function registryModels(f) {
  const builtin = fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url));
  const started = await startProcessProviderRegistryRuntime({
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: f.builtinFile ?? builtin,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: f.targetProviderFile,
  });
  try { return listRegistryBackedModels(started.runtime.registryService); }
  finally { started.dispose(); }
}

test("模型 enabled 兼容旧字符串/对象配置、JSONC，并校验字段类型", async t => {
  const f = await fixture(t);
  const resolved = await resolveUnifiedConfig(f);
  assert.ok(resolved.providers[0].modelConfigs.every(model => model.enabled && model.executable));
  const config = definition(); config.providers[0].models[0].enabled = false;
  const parsed = parseUnifiedConfigJson("// 模型开关\n" + JSON.stringify(config), "config.jsonc");
  assert.deepEqual(parsed.diagnostics.errors, []);
  assert.equal(parsed.document.providers.local.models[0].enabled, false);
  config.providers[0].models[0].enabled = "false";
  assert.ok(parseUnifiedConfigJson(JSON.stringify(config)).diagnostics.errors.length);
});

test("停用模型保留在配置中，但不进入实际 Registry 候选与默认选择", async t => {
  const config = definition(); config.providers[0].models[0].enabled = false;
  const f = await fixture(t, config);
  const resolved = await materializeUnifiedConfig(f);
  assert.equal(resolved.model, "model-b");
  assert.equal(resolved.providers[0].modelConfigs[0].enabled, false);
  assert.equal(resolved.providers[0].modelConfigs[0].executable, false);
  const runtime = JSON.parse(await readFile(f.targetProviderFile, "utf8"));
  assert.deepEqual(runtime.config.providerConfigRules.providerRules[0].config.personalModelIds, ["model-b", "legacy-model"]);
  assert.equal(runtime.config.modelConfigRules.providerModelRules.find(rule => rule.modelId === "model-a").config.enabled, false);
  const models = await registryModels(f);
  assert.deepEqual(models.filter(model => model.ref.providerId === "local").map(model => model.ref.modelId), ["model-b", "legacy-model"]);
  const editor = createProviderConfigEditor(f);
  const snapshot = await editor.read();
  assert.equal(snapshot.effective.providers[0].models.length, 3);
  assert.equal(snapshot.effective.providers[0].models[0].enabled, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-private-key/);
});

test("全部停用清空旧默认；重新启用保留密钥和旧显式模型能力", async t => {
  const f = await fixture(t);
  await materializeUnifiedConfig(f);
  const old = JSON.parse(await readFile(f.targetProviderFile, "utf8"));
  old.config.modelConfigRules.providerModelRules.find(rule => rule.modelId === "model-b").config.properties.contextWindow = 128000;
  await writeFile(f.targetProviderFile, JSON.stringify(old));
  const editor = createProviderConfigEditor(f);
  const before = await editor.read();
  for (const model of before.config.providers[0].models) model.enabled = false;
  const after = await editor.save({ revision: before.revision, config: before.config });
  assert.equal(after.config.provider, undefined);
  assert.equal(after.config.model, undefined);
  const resolved = await materializeUnifiedConfig(f);
  assert.equal(resolved.model, undefined);
  assert.ok(resolved.providers[0].modelConfigs.every(model => !model.executable));
  assert.deepEqual((await registryModels(f)).filter(model => model.ref.providerId === "local"), []);
  const disabled = JSON.parse(await readFile(f.targetProviderFile, "utf8"));
  assert.equal(disabled.config.defaultModelSelection, undefined);
  assert.equal(disabled.config.modelConfigRules.providerModelRules.find(rule => rule.modelId === "model-b").config.properties.contextWindow, 128000);
  after.config.providers[0].models[1].enabled = true;
  const enabled = await editor.save({ revision: after.revision, config: after.config });
  await materializeUnifiedConfig(f);
  const models = await registryModels(f);
  assert.equal(models.filter(model => model.ref.providerId === "local").length, 1);
  assert.equal(models.find(model => model.ref.modelId === "model-b").contextWindow, 128000);
  const saved = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(saved.providers[0].apiKey, "fixture-private-key");
  assert.equal(saved.providers[0].models[0].contextWindow, 96000);
  assert.equal(enabled.effective.model, "model-b");
});

test("CLI/标准环境变量显式选择停用模型时拒绝执行，不静默换模型", async t => {
  const config = definition(); config.providers[0].models[0].enabled = false;
  const f = await fixture(t, config);
  await writeFile(join(f.cwd, ".comecode", "config.json"), JSON.stringify(config));
  for (const overrides of [{ cliOverrides: { model: "model-a" } }, { env: { COMECODE_MODEL: "model-a" } }, { env: { MODEL: "model-a" } }]) {
    const resolved = await resolveUnifiedConfig({ ...f, ...overrides });
    assert.equal(resolved.model, "model-a");
    assert.equal(resolved.providers[0].modelConfigs[0].executable, false);
    const argv = ["--cwd", f.cwd, "-p", "hello", ...(overrides.cliOverrides ? ["--model", "model-a"] : [])];
    await assert.rejects(prepareCliProviderRuntimeEnv({ argv, env: { COMECODE_DATA_BASE_DIR: f.dataRoot, ...overrides.env } }), /已停用/);
  }
  let requested = false;
  await assert.rejects(testProviderConnection({ provider: "local", model: "model-a", confirm: true }, await resolveUnifiedConfig(f), async () => { requested = true; return new Response(); }), { status: 422 });
  assert.equal(requested, false);
});

test("项目模型 enabled 覆盖用户配置，停用项缺少环境密钥不影响可用模型", async t => {
  const config = definition();
  config.providers[0].models[1] = { id: "model-b", enabled: false, apiKeyEnv: "MISSING_FIXTURE_KEY" };
  const f = await fixture(t, config);
  const resolved = await resolveUnifiedConfig(f);
  assert.deepEqual(resolved.diagnostics.errors, []);
  assert.equal(resolved.providers[0].modelConfigs[1].executable, false);
  await writeFile(join(f.cwd, ".comecode", "config.json"), JSON.stringify({ providers: [{ id: "local", models: [{ id: "model-a", enabled: false }, { id: "model-b", enabled: true }] }] }));
  const overridden = await resolveUnifiedConfig({ ...f, env: { MISSING_FIXTURE_KEY: "fixture-env-key" } });
  assert.equal(overridden.providers[0].modelConfigs[0].enabled, false);
  assert.equal(overridden.providers[0].modelConfigs[1].enabled, true);
  assert.equal(overridden.model, "model-b");
});

test("停用模型覆盖同名内置目录候选，不会被旧内置规则复活", async t => {
  const config = definition(), f = await fixture(t, config);
  const builtin = JSON.parse(await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"));
  builtin.config.providerConfigRules.providerRules.push({ providerId: "local", providerName: "测试模型服务", enabled: true,
    config: { group: "zai-family", api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" }, access: { type: "api-key", apiKey: "fixture-builtin-key" }, builtinModelIds: ["model-a"] },
  });
  f.builtinFile = join(f.cwd, "builtin.json");
  await writeFile(f.builtinFile, JSON.stringify(builtin));
  await materializeUnifiedConfig(f);
  assert.ok((await registryModels(f)).some(model => model.ref.providerId === "local" && model.ref.modelId === "model-a"));
  config.providers[0].models[0].enabled = false;
  await writeFile(f.file, JSON.stringify(config));
  await materializeUnifiedConfig(f);
  assert.ok(!(await registryModels(f)).some(model => model.ref.providerId === "local" && model.ref.modelId === "model-a"));
});
