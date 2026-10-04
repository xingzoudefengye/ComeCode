import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnifiedConfigJson, parseUnifiedConfigToml, resolveUnifiedConfig, materializeUnifiedConfig } from "../packages/adapters/dist/config/provider-config.js";
import { createProviderConfigEditor } from "../packages/adapters/dist/config/provider-config-editor.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-provider-enabled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "user");
  await mkdir(dataRoot);
  const options = { dataRoot, cwd: root, env: {}, includeProject: false, targetProviderFile: join(root, "runtime.json") };
  const doc = { provider: "one", model: "active", providers: [
    { id: "one", type: "openai-chat", apiKey: "fake-provider-key", models: [
      { id: "active", enabled: true, apiKey: "fake-model-key", contextWindow: 32000, vision: true, reasoningLevel: "high" },
      { id: "inactive", enabled: false, toolCalling: false },
    ] },
    { id: "two", type: "anthropic", apiKey: "fake-fallback-key", models: ["fallback"] },
  ] };
  const source = join(dataRoot, "config.json");
  await writeFile(source, JSON.stringify(doc));
  return { ...options, source, doc };
}

test("provider enabled JSON/JSONC/TOML 布尔校验与缺失兼容", async t => {
  for (const enabled of [false, true]) {
    const parsed = parseUnifiedConfigJson(JSON.stringify({ providers: [{ id: "p", enabled }] }));
    assert.deepEqual(parsed.diagnostics.errors, []);
    assert.equal(parsed.document.providers.p.enabled, enabled);
  }
  for (const enabled of [null, 0, "false", {}, []]) assert.ok(parseUnifiedConfigJson(JSON.stringify({ providers: [{ id: "p", enabled }] })).diagnostics.errors.length);
  assert.equal(parseUnifiedConfigJson('{"providers":[{"id":"p","enabled":false,}],}', "config.jsonc").document.providers.p.enabled, false);
  assert.equal(parseUnifiedConfigToml('[providers.p]\nenabled = false\n').document.providers.p.enabled, false);
  assert.ok(parseUnifiedConfigToml('[providers.p]\nenabled = "false"\n').diagnostics.errors.length);
  const f = await fixture(t);
  assert.equal((await resolveUnifiedConfig(f)).providers[0].enabled, true);
});

test("provider 独立启停保留模型开关、Key 和能力并恢复 runtime 候选", async t => {
  const f = await fixture(t), editor = createProviderConfigEditor(f);
  const before = await editor.read();
  before.config.providers[0].enabled = false;
  const original = await readFile(f.source, "utf8");
  const preview = await editor.preview({ revision: before.revision, config: before.config });
  assert.equal(await readFile(f.source, "utf8"), original);
  assert.equal(preview.resolved.provider, "two");
  assert.equal(preview.resolved.providers[0].modelConfigs[0].enabled, true);
  assert.equal(preview.resolved.providers[0].modelConfigs[0].executable, false);
  const saved = await editor.save({ revision: before.revision, config: before.config });
  assert.doesNotMatch(JSON.stringify(saved), /fake-provider-key|fake-model-key/);
  const disabledSource = await readFile(f.source, "utf8");
  const persisted = JSON.parse(disabledSource);
  assert.equal(persisted.provider, "two");
  assert.equal(persisted.providers[0].models[0].apiKey, "fake-model-key");
  assert.equal(persisted.providers[0].models[0].enabled, true);
  await materializeUnifiedConfig(f);
  const runtime = JSON.parse(await readFile(f.targetProviderFile, "utf8")).config;
  assert.deepEqual(runtime.providerConfigRules.providerRules.map(p => p.providerId), ["two"]);
  const rule = runtime.modelConfigRules.providerModelRules.find(r => r.providerId === "one" && r.modelId === "active");
  assert.equal(rule.config.enabled, false);
  assert.equal(rule.config.properties.contextWindow, 32000);
  assert.equal(rule.config.optionSpecs.reasoningLevel.default, "high");
  assert.equal(await readFile(f.source, "utf8"), disabledSource);
  saved.config.providers[0].enabled = true;
  await editor.save({ revision: saved.revision, config: saved.config });
  const resolved = await materializeUnifiedConfig(f);
  assert.equal(resolved.providers[0].modelConfigs[0].executable, true);
  assert.equal(resolved.providers[0].modelConfigs[1].executable, false);
  assert.equal(resolved.providers[0].modelConfigs[0].vision, true);
  const restored = JSON.parse(await readFile(f.targetProviderFile, "utf8")).config;
  assert.deepEqual(restored.providerConfigRules.providerRules.find(p => p.providerId === "one").config.personalModelIds, ["active"]);
});

test("显式停用拒绝、无候选清默认、空供应商合法保存且类型校验不放宽", async t => {
  const f = await fixture(t);
  f.doc.providers[0].enabled = false;
  f.doc.providers[1].enabled = false;
  await writeFile(f.source, JSON.stringify(f.doc));
  const implicit = await resolveUnifiedConfig(f);
  assert.equal(implicit.provider, undefined);
  assert.equal(implicit.model, undefined);
  for (const extra of [{ cliOverrides: { provider: "one" } }, { cliOverrides: { model: "active" } }, { env: { COMECODE_PROVIDER: "one" } }, { env: { MODEL: "active" } }]) {
    const resolved = await materializeUnifiedConfig({ ...f, ...extra });
    assert.ok(resolved.diagnostics.errors.some(e => e.includes("显式选择")));
  }
  const editor = createProviderConfigEditor(f), before = await editor.read();
  const saved = await editor.save({ revision: before.revision, config: before.config });
  assert.equal(saved.config.provider, undefined);
  saved.config.providers.push({ id: "empty", models: [] });
  const after = await editor.save({ revision: saved.revision, config: saved.config });
  assert.equal(after.effective.providers.find(p => p.id === "empty").executable, false);
  assert.deepEqual(after.effective.diagnostics.errors, []);
  after.config.providers[0].enabled = "false";
  await assert.rejects(editor.save({ revision: after.revision, config: after.config }), { status: 422 });
});

test("停用未就绪供应商与空默认回退不复活 legacy 执行规则", async t => {
  const f = await fixture(t);
  await mkdir(join(f.dataRoot, "v2"));
  const legacy = JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: "one", enabled: true, config: { api: { type: "openai-chat-completions" }, access: { apiKey: "fake-old-key" }, personalModelIds: ["active"] } }] },
    modelConfigRules: { manualProviderModelRules: [{ providerId: "one", modelId: "active", config: { enabled: true, properties: { contextWindow: 64000 } } }] },
  } });
  await writeFile(join(f.dataRoot, "v2", "provider_config.json"), legacy);
  f.doc.providers[0] = { id: "one", enabled: false, models: [{ id: "active", enabled: true }] };
  await writeFile(f.source, JSON.stringify(f.doc));
  assert.deepEqual((await materializeUnifiedConfig(f)).diagnostics.errors, []);
  const runtime = JSON.parse(await readFile(f.targetProviderFile, "utf8")).config;
  assert.ok(!runtime.providerConfigRules.providerRules.some(p => p.providerId === "one"));
  assert.equal(runtime.modelConfigRules.providerModelRules.find(r => r.providerId === "one").config.enabled, false);
  assert.equal(await readFile(join(f.dataRoot, "v2", "provider_config.json"), "utf8"), legacy);
  f.doc.providers[0] = { id: "one", models: [] };
  await writeFile(f.source, JSON.stringify(f.doc));
  const resolved = await resolveUnifiedConfig(f);
  assert.equal(resolved.provider, "two");
  assert.deepEqual(resolved.providers[0].modelConfigs, []);
});
