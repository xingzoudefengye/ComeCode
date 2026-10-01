import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveUnifiedConfig } from "../packages/adapters/dist/config/provider-config.js";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.ts";

const entrypoint = fileURLToPath(new URL("../packages/cli/src/main.ts", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-zero-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, ".comecode");
  await mkdir(dataRoot, { recursive: true });
  // 临时目录可能位于用户主目录下，空项目边界阻止向上读取真实用户配置。
  await writeFile(join(dataRoot, "config.toml"), "# isolated test project\n", "utf8");
  return { root, dataRoot };
}

const credentials = {
  OPENAI_API_KEY: "test-openai-secret",
  ANTHROPIC_API_KEY: "test-anthropic-secret",
  GEMINI_API_KEY: "test-gemini-secret",
};

for (const [key, provider, model] of [
  ["OPENAI_API_KEY", "openai", "gpt-4.1-mini"],
  ["ANTHROPIC_API_KEY", "anthropic", "claude-sonnet-4-5"],
  ["ANTHROPIC_AUTH_TOKEN", "anthropic", "claude-sonnet-4-5"],
  ["GEMINI_API_KEY", "gemini", "gemini-2.5-flash"],
]) {
  test(`仅 ${key} 使用固定默认模型`, async (t) => {
    const { root, dataRoot } = await fixture(t);
    const result = await resolveUnifiedConfig({ cwd: root, dataRoot, env: { [key]: "test-secret" } });
    assert.equal(result.provider, provider);
    assert.equal(result.model, model);
    assert.deepEqual(result.diagnostics.errors, []);
    assert.equal(result.providers[0].executable, provider !== "gemini");
  });
}

test("多凭据按顺序选择，环境和 CLI 覆盖仍有最高优先级", async (t) => {
  const { root, dataRoot } = await fixture(t);
  const options = { cwd: root, dataRoot };
  const automatic = await resolveUnifiedConfig({ ...options, env: credentials });
  assert.equal(automatic.provider, "openai");
  assert.equal(automatic.model, "gpt-4.1-mini");
  assert.deepEqual(automatic.diagnostics.errors, []);
  const token = await resolveUnifiedConfig({ ...options, env: { ANTHROPIC_AUTH_TOKEN: "token", GEMINI_API_KEY: "gemini" } });
  assert.equal(token.provider, "anthropic");
  const explicit = await resolveUnifiedConfig({ ...options, env: { ...credentials, COMECODE_PROVIDER: "anthropic", COMECODE_MODEL: "env-model", MODEL: "old-model" } });
  assert.equal(explicit.provider, "anthropic");
  assert.equal(explicit.model, "env-model");
  assert.ok(explicit.providers.find((p) => p.id === "anthropic").models.includes("env-model"));
  const cli = await resolveUnifiedConfig({ ...options, env: { ...credentials, COMECODE_PROVIDER: "gemini", COMECODE_MODEL: "env-model" }, cliOverrides: { provider: "openai", model: "cli-model" } });
  assert.equal(cli.provider, "openai");
  assert.equal(cli.model, "cli-model");
  assert.ok(cli.providers.find((p) => p.id === "openai").models.includes("cli-model"));
});

test("空白 key 与只有 URL 不参加自动选择，MODEL 可覆盖默认", async (t) => {
  const { root, dataRoot } = await fixture(t);
  const result = await resolveUnifiedConfig({ cwd: root, dataRoot, env: { OPENAI_API_KEY: " ", OPENAI_BASE_URL: "https://model.example/v1", ANTHROPIC_AUTH_TOKEN: "token", COMECODE_MODEL: " ", MODEL: "custom-model" } });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "custom-model");
  const onlyUrl = await resolveUnifiedConfig({ cwd: root, dataRoot, env: { OPENAI_BASE_URL: "https://model.example/v1" } });
  assert.equal(onlyUrl.providers.find((p) => p.id === "openai").executable, false);
});

test("TOML 选择保持稳定，COMECODE_PROVIDER 显式覆盖 TOML", async (t) => {
  const { root, dataRoot } = await fixture(t);
  await writeFile(join(dataRoot, "config.toml"), 'provider = "local"\nmodel = "local-model"\n[providers.local]\ntype = "openai-chat"\napi_key = "local-key"\n', "utf8");
  const result = await resolveUnifiedConfig({ cwd: root, dataRoot, env: credentials });
  assert.equal(result.provider, "local");
  assert.equal(result.model, "local-model");
  const explicit = await resolveUnifiedConfig({ cwd: root, dataRoot, env: { ...credentials, COMECODE_PROVIDER: "anthropic" } });
  assert.equal(explicit.provider, "anthropic");
  assert.equal(explicit.model, "local-model");
});

test("环境零配置不沿用其他 Provider 的旧模型，无环境来源不修改旧 JSON", async (t) => {
  const { root, dataRoot } = await fixture(t);
  const target = join(dataRoot, "v2", "provider_config.json");
  await mkdir(join(dataRoot, "v2"), { recursive: true });
  const original = JSON.stringify({ schemaVersion: 1, config: { defaultModelSelection: { providerId: "local", modelId: "legacy-model" }, providerConfigRules: { providerRules: [{ providerId: "local", config: { group: "standard-personal", api: { type: "openai-chat-completions", baseUrl: "https://legacy.example/v1" }, access: { type: "api-key", apiKey: "legacy-key" }, personalModelIds: ["legacy-model"] } }] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } });
  await writeFile(target, original, "utf8");
  const env = { COMECODE_DATA_BASE_DIR: root };
  await prepareCliProviderRuntimeEnv({ argv: ["-p", "hi", "--cwd", root], env, entrypoint });
  assert.equal(await readFile(target, "utf8"), original);
  const result = await resolveUnifiedConfig({ cwd: root, dataRoot, env: credentials });
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-4.1-mini");
});

test("启动提示只写 stderr，不含凭据；显式未知 Provider 和 Gemini 拒绝执行", async (t) => {
  const { root } = await fixture(t);
  let output = "";
  const stderr = { write: (value) => { output += value; } };
  await prepareCliProviderRuntimeEnv({ argv: ["-p", "hi", "--cwd", root], env: { ...credentials, COMECODE_DATA_BASE_DIR: root }, entrypoint, stderr });
  assert.match(output, /openai.*gpt-4\.1-mini/u);
  assert.doesNotMatch(output, /test-.*secret/u);
  for (const provider of ["missing", "gemini"]) {
    await assert.rejects(prepareCliProviderRuntimeEnv({ argv: ["-p", "hi", "--cwd", root], env: { ...credentials, COMECODE_DATA_BASE_DIR: root, COMECODE_PROVIDER: provider }, entrypoint, stderr }), provider === "gemini" ? /Gemini.*暂不执行/u : /Provider 不存在/u);
  }
});

test("config/help/version/logout 不 materialize 且不输出启动说明", async (t) => {
  const { root } = await fixture(t);
  let output = "";
  for (const argv of [["--json", "config", "show"], ["config", "check"], ["--help"], ["--version"], ["logout"]]) {
    assert.deepEqual(await prepareCliProviderRuntimeEnv({ argv, env: { ...credentials, COMECODE_DATA_BASE_DIR: root }, entrypoint, stderr: { write: (value) => { output += value; } } }), {});
  }
  assert.equal(output, "");
  await assert.rejects(readFile(join(root, ".comecode", "v2", "provider_config.json")), { code: "ENOENT" });
});

test("真实 CLI 仅环境变量启动，HTTP 请求模型与鉴权正确且 JSON stdout 无提示", { timeout: 45000 }, async (t) => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { root } = await fixture(t);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(frame({ id: "zero", object: "chat.completion.chunk", created: 1, model: "gpt-4.1-mini", choices: [{ index: 0, delta: { role: "assistant", content: "Zero config works" }, finish_reason: null }] }) +
      frame({ id: "zero", object: "chat.completion.chunk", created: 1, model: "gpt-4.1-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + "data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env };
  // 隔离用户机上的模型、遥测与路径变量，只有测试凭据和本地 mock endpoint 能生效。
  for (const key of Object.keys(env)) {
    if (/^(COMECODE_|ZCODE_|OPENAI_|ANTHROPIC_|GEMINI_|OTEL_)/u.test(key) || key === "MODEL") delete env[key];
  }
  Object.assign(env, {
    COMECODE_DATA_BASE_DIR: root,
    OPENAI_API_KEY: "subprocess-test-secret",
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const loader = new URL("./typescript-loader.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", loader, entrypoint, "--cwd", root, "--json", "-p", "Reply with Zero config works"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI 超时：${stderr}`)); }, 30000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, stderr);
  assert.equal(JSON.parse(stdout).response, "Zero config works");
  assert.match(stderr, /ComeCode Provider: "openai" \/ "gpt-4\.1-mini"/u);
  assert.doesNotMatch(stderr, /subprocess-test-secret/u);
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(request.path, "/v1/chat/completions");
    assert.equal(request.body.model, "gpt-4.1-mini");
    assert.equal(request.authorization, "Bearer subprocess-test-secret");
  }
});

test("启动说明转义模型控制字符且 CLI model 优先于环境 model", async (t) => {
  const { root } = await fixture(t);
  let output = "";
  await prepareCliProviderRuntimeEnv({
    argv: ["-p", "hi", "--cwd", root, "--model", "cli-model\u001b[31m\ninjected"],
    env: { OPENAI_API_KEY: "test-secret", COMECODE_DATA_BASE_DIR: root, COMECODE_MODEL: "env-model" },
    entrypoint,
    stderr: { write: (value) => { output += value; } },
  });
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.split("\n").length, 2);
  assert.match(output, /cli-model\\u001b\[31m\\ninjected/u);
  assert.doesNotMatch(output, /env-model|test-secret/u);
});
