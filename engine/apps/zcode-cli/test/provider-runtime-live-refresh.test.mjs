import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.ts";
import { startProcessProviderRegistryRuntime } from "../packages/bootstrap/src/app/process-provider-registry-runtime.ts";
// 与被测代码用同一解析入口（@zcode/bootstrap -> dist）：按需刷新钩子是进程级模块状态。
import { refreshCliProviderSnapshot } from "../packages/bootstrap/dist/index.js";

const entrypoint = fileURLToPath(new URL("../packages/cli/src/main.ts", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-provider-live-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataBaseDir = join(root, "user");
  const dataRoot = join(dataBaseDir, ".comecode");
  await mkdir(join(dataRoot, "v2"), { recursive: true });
  // 复用随包 Built-in 配置，避免自造 Release 结构漂移。
  const builtin = fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  );
  const prepare = (extraEnv = {}, extraOptions = {}) =>
    prepareCliProviderRuntimeEnv({
      argv: ["app-server", "--stdio"],
      env: {
        COMECODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(dataRoot, "v2", "provider_config.json"),
        ...extraEnv,
      },
      entrypoint,
      ...extraOptions,
    });
  return { root, dataBaseDir, dataRoot, builtin, prepare };
}

function unifiedConfig(models) {
  return JSON.stringify({
    provider: "shared",
    model: models[0],
    providers: [
      {
        id: "shared",
        type: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "fake-key",
        models,
      },
    ],
  });
}

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("长驻协议进程跟随统一配置重新投影，新增模型无需重启即进入 Registry", async (t) => {
  const f = await fixture(t);
  const env = await f.prepare({}, { watchUnifiedConfig: true });
  const registryRuntime = await startProcessProviderRegistryRuntime(env);
  t.after(() => registryRuntime.dispose());
  assert.equal(registryRuntime.runtime.registryService.getModel("shared", "first-model"), undefined);

  await writeFile(join(f.dataRoot, "config.json"), unifiedConfig(["first-model"]));
  assert.ok(
    await waitFor(() => registryRuntime.runtime.registryService.getModel("shared", "first-model") !== undefined),
    "首个模型应在 config.json 落盘后进入 Registry",
  );

  await writeFile(join(f.dataRoot, "config.json"), unifiedConfig(["first-model", "gpt-5.6-terra"]));
  assert.ok(
    await waitFor(() => registryRuntime.runtime.registryService.getModel("shared", "gpt-5.6-terra") !== undefined),
    "运行中新增的模型应在 config.json 落盘后进入 Registry",
  );
});

test("一次性命令不注册监听，快照保持单次投影语义", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dataRoot, "config.json"), unifiedConfig(["first-model"]));
  const env = await f.prepare();
  const registryRuntime = await startProcessProviderRegistryRuntime(env);
  t.after(() => registryRuntime.dispose());
  assert.ok(
    await waitFor(() => registryRuntime.runtime.registryService.getModel("shared", "first-model") !== undefined),
  );

  await writeFile(join(f.dataRoot, "config.json"), unifiedConfig(["first-model", "later-model"]));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(registryRuntime.runtime.registryService.getModel("shared", "later-model"), undefined);
});

test("按需刷新让刚保存的模型在同一次请求内进入 Registry（不去抖等待）", async (t) => {
  const f = await fixture(t);
  const env = await f.prepare({}, { watchUnifiedConfig: true });
  const registryRuntime = await startProcessProviderRegistryRuntime(env);
  t.after(() => registryRuntime.dispose());

  await writeFile(join(f.dataRoot, "config.json"), unifiedConfig(["first-model"]));
  // 协议请求（连接测试）路径：不等文件监听去抖，直接按需重新投影后刷新 Registry。
  await refreshCliProviderSnapshot();
  await registryRuntime.runtime.registryService.refresh("provider-connectivity");
  assert.ok(registryRuntime.runtime.registryService.getModel("shared", "first-model"));
});
