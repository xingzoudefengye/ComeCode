import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.ts";
import { resolveUnifiedConfig } from "../packages/adapters/dist/config/provider-config.js";

const entrypoint = fileURLToPath(new URL("../packages/cli/src/main.ts", import.meta.url));
const personalEnv = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-config-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataBaseDir = join(root, "user");
  const dataRoot = join(dataBaseDir, ".comecode");
  const a = join(root, "a");
  const b = join(root, "b");
  for (const cwd of [root, a, b]) {
    await mkdir(join(cwd, ".comecode"), { recursive: true });
    await writeFile(join(cwd, ".comecode", "config.toml"), "# isolated project boundary\n");
  }
  await mkdir(join(dataRoot, "v2"), { recursive: true });
  const legacy = join(dataRoot, "v2", "provider_config.json");
  const builtin = join(root, "builtin.json");
  await writeFile(builtin, JSON.stringify({ schemaVersion: 1, config: {} }));
  const prepare = (cwd, extraEnv = {}, args = []) => prepareCliProviderRuntimeEnv({
    argv: ["-p", "hi", "--cwd", cwd, ...args],
    env: { COMECODE_DATA_BASE_DIR: dataBaseDir, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ...extraEnv },
    entrypoint,
  });
  return { root, dataRoot, a, b, legacy, prepare };
}

function legacyDocument(baseUrl) {
  return JSON.stringify({ schemaVersion: 1, config: {
    defaultModelSelection: { providerId: "shared", modelId: "global-model" },
    providerConfigRules: { providerRules: [{ providerId: "shared", config: {
      group: "standard-personal", api: { type: "openai-chat-completions", baseUrl },
      access: { type: "api-key", apiKey: "fake-global-key" }, personalModelIds: ["global-model"],
    } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [{
      providerId: "shared", modelId: "global-model", config: { properties: { contextWindow: 32000 } },
    }] },
  } });
}

async function document(env) {
  return JSON.parse(await readFile(env[personalEnv], "utf8"));
}

test("项目 A 覆盖不污染 legacy、项目 B、全局或并发启动快照（本地 mock）", async (t) => {
  const f = await fixture(t);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, key: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const original = legacyDocument(`${baseUrl}/global`);
  await writeFile(f.legacy, original);
  await writeFile(join(f.a, ".comecode", "config.toml"), `provider = "shared"\nmodel = "a-model"\n[providers.shared]\nbase_url = "${baseUrl}/a"\napi_key = "fake-a-key"\n`);
  const a = await f.prepare(f.a);
  const b = await f.prepare(f.b);
  const global = await resolveUnifiedConfig({ cwd: f.root, dataRoot: f.dataRoot, env: {} });
  assert.equal(global.model, "global-model");
  assert.equal(global.providers[0].apiKey, "fake-global-key");
  assert.equal(await readFile(f.legacy, "utf8"), original);
  assert.notEqual(a[personalEnv], b[personalEnv]);
  const compatibility = (await document(b)).config.modelConfigRules.manualProviderModelRules;
  assert.equal(compatibility[0].config.properties.contextWindow, 32000);
  await assert.rejects(readFile(`${f.legacy}.comecode-managed.json`), { code: "ENOENT" });
  for (const [env, model, path, key] of [[a, "a-model", "/a", "fake-a-key"], [b, "global-model", "/global", "fake-global-key"]]) {
    const config = (await document(env)).config;
    const provider = config.providerConfigRules.providerRules[0].config;
    assert.equal(config.defaultModelSelection.modelId, model);
    const response = await fetch(`${provider.api.baseUrl}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${provider.access.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.defaultModelSelection.modelId }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(requests.at(-1), { path: `${path}/chat/completions`, key: `Bearer ${key}`, body: { model } });
  }
  const before = await readFile(a[personalEnv], "utf8");
  const simultaneous = await Promise.all([f.prepare(f.a), f.prepare(f.a), f.prepare(f.b)]);
  assert.equal(new Set(simultaneous.map((env) => env[personalEnv])).size, 3);
  assert.equal(await readFile(a[personalEnv], "utf8"), before);
  assert.equal(await readFile(f.legacy, "utf8"), original);
});

test("统一全局配置配一次供多个项目使用，CLI/环境覆盖与失败不写回来源", async (t) => {
  const f = await fixture(t);
  const source = JSON.stringify({ provider: "shared", model: "global-model", providers: [
    { id: "shared", type: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fake-global-key", models: ["global-model"] },
  ] });
  await writeFile(join(f.dataRoot, "config.json"), source);
  const a = await f.prepare(f.a, { COMECODE_MODEL: "env-model" }, ["--model", "cli-model"]);
  const b = await f.prepare(f.b);
  assert.equal((await document(a)).config.defaultModelSelection.modelId, "cli-model");
  assert.equal((await document(b)).config.defaultModelSelection.modelId, "global-model");
  await writeFile(join(f.a, ".comecode", "config.toml"), '[providers.shared]\napi_key_env = "MISSING_TEST_KEY"\n');
  await assert.rejects(f.prepare(f.a), /缺少 api_key/u);
  assert.equal((await document(b)).config.defaultModelSelection.modelId, "global-model");
  assert.equal(await readFile(join(f.dataRoot, "config.json"), "utf8"), source);
  await assert.rejects(readFile(f.legacy), { code: "ENOENT" });
});

test("显式 legacy 路径只作输入且非模型命令不产生快照", async (t) => {
  const f = await fixture(t);
  const explicit = join(f.root, "explicit.json");
  const original = legacyDocument("http://127.0.0.1:1/v1");
  await writeFile(explicit, original);
  const env = await f.prepare(f.b, { [personalEnv]: explicit }, ["--model", "override-model"]);
  assert.notEqual(env[personalEnv], explicit);
  assert.equal((await document(env)).config.defaultModelSelection.modelId, "override-model");
  assert.equal(await readFile(explicit, "utf8"), original);
  assert.deepEqual(await prepareCliProviderRuntimeEnv({ argv: ["--help"], env: { COMECODE_DATA_BASE_DIR: f.dataRoot }, entrypoint }), {});
});
