import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { ensureFirstProviderSetup } from "../packages/cli/src/first-provider-setup.ts";
import { runProviderConfigSetup } from "../packages/cli/src/provider-config-setup.ts";
import { runTuiCommand } from "../packages/cli/src/tui-command.ts";
import { prepareCliProviderRuntimeEnv } from "../packages/cli/src/provider-runtime-env.ts";
import { startProcessProviderRegistryRuntime } from "../packages/bootstrap/src/app/process-provider-registry-runtime.ts";
import { listRegistryBackedModels } from "../packages/bootstrap/src/app/provider-registry-selection.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-first-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".comecode"));
  await writeFile(join(root, ".comecode", "config.json"), "{}");
  await writeFile(join(root, ".env"), "");
  const env = { COMECODE_DATA_BASE_DIR: join(root, "data") };
  let stderr = "";
  const ctx = {
    argv: ["--cwd", root],
    stdin: { isTTY: true },
    stdout: { isTTY: true, write() {} },
    stderr: {
      isTTY: true,
      write: (text) => {
        stderr += text;
      },
    },
  };
  return { root, env, ctx, output: () => stderr };
}

test("首次保存后同进程进入 TUI，首屏使用刚配置的模型而不是配置提示", async (t) => {
  const f = await fixture(t);
  const answers = ["", "https://example.test/v1", "first-model", "fake-first-key"];
  const setup = (ctx, env, cwd, _, startup) =>
    runProviderConfigSetup(ctx, env, cwd, async () => answers.shift(), startup);
  assert.equal(await ensureFirstProviderSetup(f.ctx, f.env, setup), 0);
  const paths = await prepareCliProviderRuntimeEnv({
    argv: f.ctx.argv,
    env: f.env,
    entrypoint: fileURLToPath(new URL("../packages/cli/dist/zcode.cjs", import.meta.url)),
  });
  const registry = await startProcessProviderRegistryRuntime(paths);
  t.after(() => registry.dispose());
  const models = listRegistryBackedModels(registry.runtime.registryService);
  let ready = false;
  const status = await runTuiCommand(
    f.ctx,
    { locale: "zh-CN", noColor: true },
    {
      env: { ...f.env, ...paths },
      cwd: () => f.root,
      skipUserConfig: true,
      loadDotenv: () => ({ keys: [], loaded: false }),
      listCustomCommands: async () => ({ commands: [] }),
      resolveWorkspaceGitBranch: async () => undefined,
      startProcessProviderRegistryRuntime: async () => registry,
      createZCodeApp: () => ({
        sessionId: "configured-session",
        listModels: async () => models,
        getModel: () => "my-api/first-model",
        getLocale: () => "zh-CN",
        runtime: {},
        close() {},
      }),
      runTui: async (options) => {
        const startup = await options.loadStartupOptions();
        assert.equal(startup.initialResult, undefined);
        assert.equal(startup.initialModel, "my-api/first-model");
        assert.ok(startup.modelOptions.some((model) => model.ref.modelId === "first-model"));
        ready = true;
        return 0;
      },
    },
    "test",
  );
  assert.equal(status, 0, f.output());
  assert.equal(ready, true);
  assert.doesNotMatch(f.output(), /保存位置|config\.(json|toml|jsonc)|退出|fake-first-key/u);
});

test("首次真实 readline 密钥隐藏、无需保存确认；Ctrl+C 不写 JSON", async (t) => {
  const f = await fixture(t);
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  t.after(() => input.destroy());
  const answers = ["", "", "first-model", "hidden-first-secret"];
  const answered = new Set();
  let output = "";
  const ctx = {
    ...f.ctx,
    stdin: input,
    stderr: {
      isTTY: true,
      columns: 160,
      write: (text) => {
        output += text;
        const step = /^[1-4]\. /u.exec(text)?.[0];
        if (step && !answered.has(step)) {
          answered.add(step);
          setImmediate(() => input.write(`${answers.shift()}\r`));
        }
      },
    },
  };
  assert.equal(await ensureFirstProviderSetup(ctx, f.env), 0);
  assert.equal(answers.length, 0);
  assert.doesNotMatch(output, /hidden-first-secret|保存配置|保存位置|config\.(json|jsonc|toml)/u);
  const config = JSON.parse(
    await readFile(join(f.env.COMECODE_DATA_BASE_DIR, ".comecode", "config.json"), "utf8"),
  );
  assert.equal(config.providers[0].apiKey, "hidden-first-secret");
  const cancelled = await fixture(t);
  const cancelInput = new PassThrough();
  cancelInput.isTTY = true;
  cancelInput.setRawMode = () => {};
  t.after(() => cancelInput.destroy());
  const cancelCtx = {
    ...cancelled.ctx,
    stdin: cancelInput,
    stderr: {
      isTTY: true,
      write: (text) => {
        if (text.startsWith("1.")) setImmediate(() => cancelInput.write("\u0003"));
      },
    },
  };
  assert.equal(await ensureFirstProviderSetup(cancelCtx, cancelled.env), 1);
  await assert.rejects(
    readFile(join(cancelled.env.COMECODE_DATA_BASE_DIR, ".comecode", "config.json")),
    { code: "ENOENT" },
  );
});

test(".env 已有凭据不提问；空 TOML 模板首次填写保存 JSON 并保留原文件", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".env"), "OPENAI_API_KEY=fake-env-key\n");
  assert.equal(
    await ensureFirstProviderSetup(f.ctx, f.env, () => {
      throw new Error("已有凭据不提问");
    }),
    0,
  );
  await writeFile(join(f.root, ".env"), "");
  delete f.env.OPENAI_API_KEY;
  const data = join(f.env.COMECODE_DATA_BASE_DIR, ".comecode");
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "config.toml"), "# 旧模板保留\n");
  const answers = ["", "", "first-model", "fake-test-key"];
  assert.equal(
    await ensureFirstProviderSetup(f.ctx, f.env, (ctx, env, cwd, _, startup) =>
      runProviderConfigSetup(ctx, env, cwd, async () => answers.shift(), startup),
    ),
    0,
  );
  assert.equal(await readFile(join(data, "config.toml"), "utf8"), "# 旧模板保留\n");
  assert.equal(JSON.parse(await readFile(join(data, "config.json"), "utf8")).model, "first-model");
});

test("help、协议、headless、非交互与已有模型不运行首次输入", async (t) => {
  const f = await fixture(t);
  const noAsk = () => {
    throw new Error("不应提问");
  };
  for (const argv of [["--help"], ["-p", "hello"], ["app-server"], ["config", "show"]])
    assert.equal(await ensureFirstProviderSetup({ ...f.ctx, argv }, f.env, noAsk), 0);
  assert.equal(
    await ensureFirstProviderSetup({ ...f.ctx, stdin: { isTTY: false } }, f.env, noAsk),
    0,
  );
  const answers = ["", "", "first-model", "fake-test-key"];
  assert.equal(
    await ensureFirstProviderSetup(f.ctx, f.env, (ctx, env, cwd, _, startup) =>
      runProviderConfigSetup(ctx, env, cwd, async () => answers.shift(), startup),
    ),
    0,
  );
  assert.equal(await ensureFirstProviderSetup(f.ctx, f.env, noAsk), 0);
});
