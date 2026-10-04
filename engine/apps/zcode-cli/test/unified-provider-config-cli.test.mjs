import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../packages/cli/src/run.js";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.js";
import { resolveUnifiedConfig } from "../packages/adapters/dist/config/provider-config.js";
import { decodeProviderConfigFile } from "../../../packages/provider-node/dist/provider-config-file-codec.js";

function createContext(argv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const collect = (stream) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    return () => Buffer.concat(chunks).toString("utf8");
  };
  return {
    context: {
      argv,
      stdout,
      stderr,
      stdin: PassThrough.from([]),
    },
    readStdout: collect(stdout),
    readStderr: collect(stderr),
  };
}

test("真实 config 路由应用 CLI 覆盖并对 API Key 脱敏", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-cli-config-route-"));
  try {
    const project = join(root, "project");
    const dataRoot = join(root, "data");
    await mkdir(join(project, ".comecode"), { recursive: true });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(
      join(dataRoot, "config.toml"),
      [
        'model = "user-model"',
        'provider = "user-provider"',
        "[providers.user-provider]",
        'type = "openai-chat"',
        'base_url = "https://user.example/v1"',
        'api_key = "user-secret"',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(project, ".comecode", "config.toml"),
      [
        'model = "project-model"',
        'provider = "project-provider"',
        "[providers.project-provider]",
        'type = "openai-chat"',
        'base_url = "https://project.example/v1"',
        'api_key = "project-secret"',
        "",
      ].join("\n"),
      "utf8",
    );

    const io = createContext([
      "--json",
      "--model",
      "cli-model",
      "--provider",
      "project-provider",
      "config",
      "show",
    ]);
    const exitCode = await run(io.context, {
      cwd: () => project,
      env: { COMECODE_DATA_BASE_DIR: dataRoot },
    });

    assert.equal(exitCode, 0);
    const output = JSON.parse(io.readStdout());
    assert.equal(output.model, "cli-model");
    assert.equal(output.provider, "project-provider");
    assert.equal(output.providers.find((provider) => provider.id === "project-provider").apiKey, "proj...cret");
    assert.doesNotMatch(io.readStdout(), /project-secret/u);
    assert.equal(io.readStderr(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("真实 Provider runtime 入口将统一配置 materialize 为旧 JSON 协议", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-runtime-config-"));
  try {
    const project = join(root, "project");
    const dataRoot = join(root, "data");
    const personalFile = join(root, "runtime", "provider_config.json");
    const builtinFile = join(root, "builtin.json");
    await mkdir(join(project, ".comecode"), { recursive: true });
    await writeFile(
      join(project, ".comecode", "config.toml"),
      [
        'model = "runtime-model"',
        'provider = "runtime-provider"',
        "[providers.runtime-provider]",
        'type = "openai-responses"',
        'base_url = "https://runtime.example/v1"',
        'api_key_env = "RUNTIME_API_KEY"',
        "",
      ].join("\n"),
      "utf8",
    );

    const runtimeEnv = await prepareCliProviderRuntimeEnv({
      argv: ["--prompt", "hello", "--cwd", project, "--model", "cli-runtime-model"],
      env: {
        COMECODE_DATA_BASE_DIR: dataRoot,
        RUNTIME_API_KEY: "runtime-secret",
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFile,
      },
    });

    assert.equal(runtimeEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, builtinFile);
    assert.notEqual(runtimeEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, personalFile);
    await assert.rejects(readFile(personalFile), { code: "ENOENT" });
    const document = JSON.parse(await readFile(runtimeEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "utf8"));
    const decoded = decodeProviderConfigFile(document);
    const provider = decoded.providers.get("runtime-provider");
    assert.equal(provider?.api?.type, "openai-responses");
    assert.equal(provider?.api?.baseUrl, "https://runtime.example/v1");
    assert.equal(provider?.access?.apiKey, "runtime-secret");
    assert.deepEqual(provider?.personalModelIds, ["cli-runtime-model"]);
    assert.equal(decoded.defaultModelSelection?.providerId, "runtime-provider");
    assert.equal(decoded.defaultModelSelection?.modelId, "cli-runtime-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("标准 OpenAI 与 Anthropic 环境变量可生成可执行 Provider", async () => {
  const openaiRoot = await mkdtemp(join(tmpdir(), "comecode-openai-env-"));
  const anthropicRoot = await mkdtemp(join(tmpdir(), "comecode-anthropic-env-"));
  try {
    const openai = await resolveUnifiedConfig({
      dataRoot: openaiRoot,
      env: {
        OPENAI_API_KEY: "openai-secret",
        OPENAI_BASE_URL: "https://openai.example/v1",
        COMECODE_MODEL: "openai-model",
      },
    });
    const openaiProvider = openai.providers.find((provider) => provider.id === "openai");
    assert.equal(openai.model, "openai-model");
    assert.equal(openaiProvider?.baseUrl, "https://openai.example/v1");
    assert.equal(openaiProvider?.apiKey, "openai-secret");
    assert.equal(openaiProvider?.apiType, "openai-chat-completions");
    assert.equal(openaiProvider?.executable, true);

    const anthropic = await resolveUnifiedConfig({
      dataRoot: anthropicRoot,
      env: {
        ANTHROPIC_API_KEY: "anthropic-api-secret",
        ANTHROPIC_AUTH_TOKEN: "anthropic-auth-secret",
        ANTHROPIC_BASE_URL: "https://anthropic.example/v1",
        MODEL: "anthropic-model",
      },
    });
    const anthropicProvider = anthropic.providers.find((provider) => provider.id === "anthropic");
    assert.equal(anthropic.model, "anthropic-model");
    assert.equal(anthropicProvider?.baseUrl, "https://anthropic.example/v1");
    assert.equal(anthropicProvider?.apiKey, "anthropic-api-secret");
    assert.equal(anthropicProvider?.apiKeySource, "env:ANTHROPIC_API_KEY");
    assert.equal(anthropicProvider?.apiType, "anthropic-messages");
    assert.equal(anthropicProvider?.executable, true);

    const authTokenOnly = await resolveUnifiedConfig({
      dataRoot: anthropicRoot,
      env: {
        ANTHROPIC_AUTH_TOKEN: "anthropic-auth-only-secret",
        ANTHROPIC_BASE_URL: "https://anthropic.example/v1",
        MODEL: "anthropic-auth-model",
      },
    });
    const authTokenProvider = authTokenOnly.providers.find((provider) => provider.id === "anthropic");
    assert.equal(authTokenProvider?.apiKey, "anthropic-auth-only-secret");
    assert.equal(authTokenProvider?.apiKeySource, "env:ANTHROPIC_AUTH_TOKEN");
    assert.equal(authTokenProvider?.executable, true);
  } finally {
    await Promise.all([
      rm(openaiRoot, { recursive: true, force: true }),
      rm(anthropicRoot, { recursive: true, force: true }),
    ]);
  }
});

test("真实 config path 路由报告用户级和项目级配置路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-config-path-"));
  try {
    const project = join(root, "project");
    const dataBaseDir = join(root, "data");
    const projectConfig = join(project, ".comecode", "config.toml");
    const userConfig = join(dataBaseDir, ".comecode", "config.toml");
    await mkdir(join(project, ".comecode"), { recursive: true });
    await mkdir(join(dataBaseDir, ".comecode"), { recursive: true });
    await writeFile(projectConfig, 'model = "project-model"\n', "utf8");
    await writeFile(userConfig, 'model = "user-model"\n', "utf8");

    const io = createContext(["--json", "config", "path"]);
    const exitCode = await run(io.context, {
      cwd: () => project,
      env: { COMECODE_DATA_BASE_DIR: dataBaseDir },
    });

    assert.equal(exitCode, 0);
    const output = JSON.parse(io.readStdout());
    assert.equal(output.user.path, userConfig);
    assert.equal(output.user.exists, true);
    assert.equal(output.project.path, projectConfig);
    assert.equal(output.project.exists, true);
    assert.equal(output.legacyProvider.exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config check 对配置错误返回非零退出码", async () => {
  const cases = [
    {
      name: "missing-key",
      content: [
        'model = "check-model"',
        'provider = "check-provider"',
        "[providers.check-provider]",
        'type = "openai-chat"',
        'base_url = "https://check.example/v1"',
      ].join("\n"),
      expected: /缺少 api_key/u,
    },
    {
      name: "invalid-url",
      content: [
        'model = "check-model"',
        'provider = "check-provider"',
        "[providers.check-provider]",
        'type = "openai-chat"',
        'base_url = "not-a-url"',
        'api_key = "check-secret"',
      ].join("\n"),
      expected: /base_url 不是有效 URL/u,
    },
    {
      name: "unknown-type",
      content: [
        'model = "check-model"',
        'provider = "check-provider"',
        "[providers.check-provider]",
        'type = "unknown-provider"',
        'base_url = "https://check.example/v1"',
        'api_key = "check-secret"',
      ].join("\n"),
      expected: /未知 type/u,
    },
  ];

  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `comecode-config-check-${item.name}-`));
    try {
      await mkdir(join(root, ".comecode"), { recursive: true });
      await writeFile(join(root, ".comecode", "config.toml"), item.content, "utf8");
      const io = createContext(["--json", "config", "check"]);
      const exitCode = await run(io.context, { cwd: () => root, env: {} });
      const output = JSON.parse(io.readStdout());
      assert.equal(exitCode, 1, item.name);
      assert.equal(output.ok, false, item.name);
      assert.match(output.errors.join("\n"), item.expected, item.name);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
