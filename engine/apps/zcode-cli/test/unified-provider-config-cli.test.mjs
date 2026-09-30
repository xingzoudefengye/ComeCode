import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../packages/cli/src/run.js";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.js";
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
    assert.equal(runtimeEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, personalFile);
    const document = JSON.parse(await readFile(personalFile, "utf8"));
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
