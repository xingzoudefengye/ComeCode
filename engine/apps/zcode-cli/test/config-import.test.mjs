import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { importProviderConfig, ProviderConfigImportError } from "../packages/adapters/dist/config/provider-config-import.js";
import { run } from "../packages/cli/src/run.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataRoot = join(root, "data");
  await mkdir(home, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  return { root, home, dataRoot, env: { USERPROFILE: home, COMECODE_DATA_BASE_DIR: dataRoot } };
}

function context(argv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const collect = (stream) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    return () => Buffer.concat(chunks).toString("utf8");
  };
  return { context: { argv, stdout, stderr, stdin: PassThrough.from([]) }, readStdout: collect(stdout), readStderr: collect(stderr) };
}

test("导入 Codex 配置映射协议、地址、环境变量和模型，且不泄露认证内容", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".codex"), { recursive: true });
  const secret = "codex-oauth-secret-not-output";
  await writeFile(join(f.home, ".codex", "config.toml"), [
    'model = "codex-model"',
    'model_provider = "custom"',
    "[model_providers.custom]",
    'name = "团队 Codex"',
    'base_url = "https://codex.example/v1"',
    'env_key = "CODEX_API_KEY"',
    'wire_api = "responses"',
    "[projects.\'C:\\work\']",
    'trust_level = "trusted"',
    "",
  ].join("\n"));
  await writeFile(join(f.home, ".codex", "auth.json"), JSON.stringify({ access_token: secret }));
  const result = await importProviderConfig("codex", { homeDir: f.home, dataRoot: f.dataRoot, env: { ...f.env } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.addedProviders, ["custom"]);
  assert.deepEqual(result.addedModels, ["custom/codex-model"]);
  assert.doesNotMatch(JSON.stringify(result), /codex-oauth-secret-not-output/u);
  const saved = JSON.parse(await readFile(join(f.dataRoot, "config.json"), "utf8"));
  assert.equal(saved.provider, "custom");
  assert.equal(saved.model, "codex-model");
  assert.equal(saved.providers[0].type, "openai-responses");
  assert.equal(saved.providers[0].baseUrl, "https://codex.example/v1");
  assert.equal(saved.providers[0].apiKeyEnv, "CODEX_API_KEY");
});

test("导入 Claude Code 配置并保留已有 Provider/模型", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".claude"), { recursive: true });
  const secret = "anthropic-private-key-not-output";
  await writeFile(join(f.home, ".claude", "settings.json"), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: "https://anthropic.example/v1",
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_MODEL: "claude-sonnet-custom",
  }}));
  await writeFile(join(f.dataRoot, "config.json"), JSON.stringify({
    provider: "existing",
    model: "existing-model",
    providers: [{ id: "existing", type: "openai-chat", baseUrl: "https://existing.example/v1", apiKey: "existing-key", models: ["existing-model"] }],
  }));
  const result = await importProviderConfig("claude", { homeDir: f.home, dataRoot: f.dataRoot, env: { ...f.env } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.addedProviders, ["claude"]);
  assert.doesNotMatch(JSON.stringify(result), /anthropic-private-key-not-output/u);
  assert.ok(result.backupPath);
  const saved = JSON.parse(await readFile(join(f.dataRoot, "config.json"), "utf8"));
  assert.deepEqual(saved.providers.map((provider) => provider.id), ["existing", "claude"]);
  assert.equal(saved.providers[1].type, "anthropic");
  assert.equal(saved.providers[1].apiKey, secret);
  assert.equal(saved.providers[1].models[0].id, "claude-sonnet-custom");
});

test("重复导入幂等，不创建新配置备份", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".codex"), { recursive: true });
  await writeFile(join(f.home, ".codex", "config.toml"), 'model = "same-model"\nmodel_provider = "same"\n[model_providers.same]\nbase_url = "https://same.example/v1"\nenv_key = "SAME_KEY"\nwire_api = "chat"\n');
  const first = await importProviderConfig("codex", { homeDir: f.home, dataRoot: f.dataRoot, env: { ...f.env } });
  const before = await readFile(join(f.dataRoot, "config.json"), "utf8");
  const second = await importProviderConfig("codex", { homeDir: f.home, dataRoot: f.dataRoot, env: { ...f.env } });
  const after = await readFile(join(f.dataRoot, "config.json"), "utf8");
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.backupPath, undefined);
  assert.equal(before, after);
});

test("缺少源配置时给出中文错误，不创建空配置", async (t) => {
  const f = await fixture(t);
  await assert.rejects(importProviderConfig("claude", { homeDir: f.home, dataRoot: f.dataRoot, env: { ...f.env } }), (error) => {
    assert.ok(error instanceof ProviderConfigImportError);
    assert.match(error.message, /未找到 Claude Code 配置/u);
    return true;
  });
  assert.deepEqual(await readdir(f.dataRoot), []);
});


test("导入已有 TOML 时生成 JSON 并备份原配置", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".codex"), { recursive: true });
  await writeFile(join(f.home, ".codex", "config.toml"), 'model = "toml-model"\nmodel_provider = "toml"\n[model_providers.toml]\nbase_url = "https://toml.example/v1"\nenv_key = "TOML_KEY"\nwire_api = "chat"\n');
  await writeFile(join(f.dataRoot, "config.toml"), 'model = "existing"\nprovider = "existing"\n[providers.existing]\ntype = "openai-chat"\nbase_url = "https://existing.example/v1"\napi_key_env = "EXISTING_KEY"\nmodels = ["existing-model"]\n');
  const result = await importProviderConfig("codex", { homeDir: f.home, dataRoot: f.dataRoot, env: { ...f.env } });
  assert.equal(result.changed, true);
  assert.ok(result.backupPath?.endsWith(".bak"));
  assert.equal(await stat(join(f.dataRoot, "config.json")).then(() => true), true);
  assert.equal(await stat(join(f.dataRoot, "config.toml")).then(() => false).catch(() => false), false);
  const saved = JSON.parse(await readFile(join(f.dataRoot, "config.json"), "utf8"));
  assert.deepEqual(saved.providers.map((provider) => provider.id), ["existing", "toml"]);
});

test("CLI 支持 import 子命令和 --import 兼容写法", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, ".codex"), { recursive: true });
  await writeFile(join(f.home, ".codex", "config.toml"), 'model = "cli-model"\nmodel_provider = "cli"\n[model_providers.cli]\nbase_url = "https://cli.example/v1"\nenv_key = "CLI_KEY"\nwire_api = "chat"\n');
  for (const argv of [["import", "codex"], ["--import", "codex"]]) {
    const io = context(["--json", ...argv]);
    const code = await run(io.context, { cwd: () => f.root, env: f.env });
    assert.equal(code, 0);
    const output = JSON.parse(io.readStdout());
    assert.equal(output.source, "codex");
    assert.doesNotMatch(io.readStdout(), /CLI_KEY/u);
  }
});
