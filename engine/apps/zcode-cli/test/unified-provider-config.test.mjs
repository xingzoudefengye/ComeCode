import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  materializeUnifiedConfig,
  parseUnifiedConfigToml,
  resolveUnifiedConfig,
  toPublicUnifiedConfig,
} from "../packages/adapters/dist/config/provider-config.js";
import { decodeProviderConfigFile } from "../../../packages/provider-node/dist/provider-config-file-codec.js";

test("解析统一 Provider TOML 并映射 API type", () => {
  const parsed = parseUnifiedConfigToml(`
model = "deepseek-v4.1"
provider = "newapi"

[providers.newapi]
type = "openai-chat"
base_url = "https://example.test/v1"
api_key_env = "NEWAPI_API_KEY"
`);
  assert.deepEqual(parsed.diagnostics.errors, []);
  assert.equal(parsed.document.model, "deepseek-v4.1");
  assert.equal(parsed.document.providers.newapi?.type, "openai-chat");
  assert.equal(parsed.document.providers.newapi?.apiKeyEnv, "NEWAPI_API_KEY");
});

test("用户、项目、标准环境变量和 CLI 按优先级合并", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-config-"));
  const project = join(root, "project");
  const userData = join(root, "user");
  await mkdir(join(project, ".comecode"), { recursive: true });
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, "config.toml"), `model = "user-model"\nprovider = "newapi"\n[providers.newapi]\ntype = "openai-chat"\nbase_url = "https://user.test/v1"\napi_key_env = "NEWAPI_API_KEY"\n`, "utf8");
  await writeFile(join(project, ".comecode", "config.toml"), `model = "project-model"\n[providers.newapi]\nbase_url = "https://project.test/v1"\n`, "utf8");
  const resolved = await resolveUnifiedConfig({
    cwd: project,
    dataRoot: userData,
    env: { NEWAPI_API_KEY: "secret-key", OPENAI_API_KEY: "openai-secret", COMECODE_MODEL: "env-model", MODEL: "legacy-model" },
    cliOverrides: { model: "cli-model", provider: "newapi" },
  });
  assert.equal(resolved.model, "cli-model");
  assert.equal(resolved.provider, "newapi");
  assert.equal(resolved.providers[0]?.baseUrl, "https://project.test/v1");
  assert.equal(resolved.providers[0]?.apiKey, "secret-key");
  assert.equal(resolved.providers[0]?.apiType, "openai-chat-completions");
});

test("高优先级 api_key_env 不会被旧 provider_config.json 的明文 key 反压", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-key-priority-"));
  const legacy = join(root, "legacy.json");
  await writeFile(legacy, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{ providerId: "local", config: { access: { type: "api-key", apiKey: "old-secret" }, api: { type: "openai-chat-completions", baseUrl: "https://old.test/v1" }, personalModelIds: ["old-model"] } }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }), "utf8");
  await writeFile(join(root, "config.toml"), `provider = "local"
model = "new-model"
[providers.local]
type = "openai-chat"
api_key_env = "NEW_KEY"
`, "utf8");
  const resolved = await resolveUnifiedConfig({ dataRoot: root, legacyProviderFile: legacy, env: { NEW_KEY: "new-secret" } });
  assert.equal(resolved.providers.find((provider) => provider.id === "local")?.apiKey, "new-secret");
});

test("COMECODE_MODEL 优先于 MODEL，Gemini 只检查不执行，show 脱敏", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-env-"));
  await writeFile(join(root, "config.toml"), `provider = "gemini"\n[providers.gemini]\ntype = "gemini"\napi_key_env = "GEMINI_API_KEY"\n`, "utf8");
  const resolved = await resolveUnifiedConfig({
    dataRoot: root,
    env: { GEMINI_API_KEY: "gemini-secret", COMECODE_MODEL: "come-model", MODEL: "legacy-model" },
  });
  assert.equal(resolved.model, "come-model");
  assert.equal(resolved.providers[0]?.executable, false);
  assert.match(resolved.diagnostics.warnings.join("\n"), /Gemini/);
  const publicConfig = toPublicUnifiedConfig(resolved);
  assert.equal(publicConfig.providers[0]?.apiKey, "gemi...cret");
  assert.doesNotMatch(JSON.stringify(publicConfig), /gemini-secret/u);
});

test("统一配置缺少密钥时不会静默沿用旧 Provider 密钥", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-invalid-override-"));
  const target = join(root, "v2", "provider_config.json");
  await mkdir(join(root, "v2"), { recursive: true });
  await writeFile(target, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{ providerId: "local", config: { access: { type: "api-key", apiKey: "old-secret" }, api: { type: "openai-chat-completions", baseUrl: "https://old.test/v1" }, personalModelIds: ["old-model"] } }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }), "utf8");
  await writeFile(join(root, "config.toml"), `provider = "local"
model = "new-model"
[providers.local]
type = "openai-chat"
api_key_env = "MISSING_KEY"
`, "utf8");
  const resolved = await materializeUnifiedConfig({ dataRoot: root, cwd: root, targetProviderFile: target, env: {} });
  assert.equal(resolved.providers.find((provider) => provider.id === "local")?.executable, false);
  const document = JSON.parse(await readFile(target, "utf8"));
  const update = decodeProviderConfigFile(document);
  assert.equal(update.providers.get("local")?.access?.apiKey, "old-secret");
  assert.ok(resolved.diagnostics.errors.length);
});

test("materialize 生成旧 Provider Config 兼容格式且不强行写入 contextWindow", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-materialize-"));
  // 隔离祖先目录里的真实配置，验收只使用本测试的凭据与模型。
  await mkdir(join(root, ".comecode"), { recursive: true });
  await writeFile(join(root, ".comecode", "config.toml"), "# isolated test project\n", "utf8");
  const user = join(root, "config.toml");
  const target = join(root, "v2", "provider_config.json");
  await writeFile(user, `model = "model-a"\nprovider = "local"\n[providers.local]\ntype = "openai-responses"\nbase_url = "https://local.test/v1"\napi_key = "plain-secret"\n`, "utf8");
  await materializeUnifiedConfig({ cwd: root, dataRoot: root, targetProviderFile: target });
  const document = JSON.parse(await readFile(target, "utf8"));
  const update = decodeProviderConfigFile(document);
  const provider = update.providers.get("local");
  assert.equal(provider?.api?.type, "openai-responses");
  assert.deepEqual(provider?.personalModelIds, ["model-a"]);
  assert.equal(update.defaultModelSelection?.providerId, "local");
  assert.equal(update.defaultModelSelection?.modelId, "model-a");
  assert.equal(update.models.getExact("local", "model-a")?.properties?.contextWindow, undefined);
});
