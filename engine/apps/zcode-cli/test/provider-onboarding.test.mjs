import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerSetupResponse } from "../packages/cli/src/provider-setup.ts";
import { runProviderConfigSetup } from "../packages/cli/src/provider-config-setup.ts";
import { runConfigCommand } from "../packages/cli/src/config-command.ts";
import { runTuiCommand } from "../packages/cli/src/tui-command.ts";
import { materializeUnifiedConfig, parseUnifiedConfigToml, resolveUnifiedConfig } from "../packages/adapters/dist/config/provider-config.js";
import { decodeProviderConfigFile } from "../../../packages/provider-node/dist/provider-config-file-codec.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-onboarding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let stdout = "";
  let stderr = "";
  return {
    root, env: { COMECODE_DATA_BASE_DIR: root },
    ctx: { stdin: { isTTY: true }, stderr: { isTTY: true, write: (s) => { stderr += s; } }, stdout: { write: (s) => { stdout += s; } } },
    readStdout: () => stdout, readStderr: () => stderr,
  };
}

function scriptedAsk(answers, prompts) {
  return async (prompt, secret) => {
    prompts.push({ prompt, secret });
    assert.ok(answers.length, "向导不能无限提问");
    return answers.shift();
  };
}

test("向导填写即可生成带注释配置，解析、脱敏、旧 Registry codec 与 check 均通过", async (t) => {
  const f = await fixture(t);
  const prompts = [];
  const answers = ["1", "bad-url", "https://model.example/v1", "test-model", "private-test-key", "y"];
  assert.equal(await runProviderConfigSetup(f.ctx, f.env, f.root, scriptedAsk(answers, prompts)), 0);
  assert.equal(prompts.find((p) => p.prompt.startsWith("4.")).secret, true);
  assert.doesNotMatch(f.readStderr(), /private-test-key/u);
  assert.match(f.readStderr(), /地址不正确/u);
  const path = join(f.root, ".comecode", "config.toml");
  const parsed = parseUnifiedConfigToml(await readFile(path, "utf8"));
  assert.deepEqual(parsed.diagnostics.errors, []);
  assert.equal(parsed.document.model, "test-model");
  const target = join(f.root, ".comecode", "v2", "provider_config.json");
  await materializeUnifiedConfig({ cwd: f.root, env: f.env, targetProviderFile: target });
  const decoded = decodeProviderConfigFile(JSON.parse(await readFile(target, "utf8")));
  assert.equal(decoded.providers.get("my-api").api.baseUrl, "https://model.example/v1");
  assert.equal(decoded.defaultModelSelection.modelId, "test-model");
  assert.equal(await runConfigCommand(f.ctx, { json: true }, { env: f.env, cwd: () => f.root }, ["check"]), 0);
  assert.equal(JSON.parse(f.readStdout()).ok, true);
});

test("全注释模板不阻断零配置；空模板 check 明确失败", async (t) => {
  const f = await fixture(t);
  providerSetupResponse("zh-CN", f.env, f.root);
  const resolved = await resolveUnifiedConfig({ cwd: f.root, env: { ...f.env, OPENAI_API_KEY: "test-key" } });
  assert.equal(resolved.provider, "openai");
  assert.equal(resolved.model, "gpt-4.1-mini");
  assert.equal(await runConfigCommand(f.ctx, { json: true }, { env: f.env, cwd: () => f.root }, ["check"]), 1);
  const output = JSON.parse(f.readStdout());
  assert.equal(output.ok, false);
  assert.match(output.errors.join("\n"), /config setup/u);
});

test("向导取消不写盘，覆盖需确认且保留备份", async (t) => {
  const f = await fixture(t);
  const path = join(f.root, ".comecode", "config.toml");
  const initial = 'model = "original"\n';
  await mkdir(join(f.root, ".comecode"));
  await writeFile(path, initial, "utf8");
  const answers = ["3", "", "claude-model", "private-key", "n"];
  assert.equal(await runProviderConfigSetup(f.ctx, f.env, f.root, scriptedAsk(answers, [])), 0);
  assert.equal(await readFile(path, "utf8"), initial);
  assert.equal(await runProviderConfigSetup(f.ctx, f.env, f.root, scriptedAsk(["3", "", "claude-model", "private-key", "y"], [])), 0);
  const backups = (await readdir(join(f.root, ".comecode"))).filter((file) => file.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(f.root, ".comecode", backups[0]), "utf8"), initial);
  assert.match(await readFile(path, "utf8"), /type = "anthropic"/u);
  assert.doesNotMatch(f.readStderr(), /private-key/u);
});

test("无模型 TUI 首屏即给配置卡片，普通 sendInput 也不发起模型请求", async (t) => {
  const f = await fixture(t);
  let sent = 0;
  let startup;
  const status = await runTuiCommand(f.ctx, { noColor: true, locale: "zh-CN" }, {
    env: f.env, cwd: () => f.root, skipUserConfig: true,
    loadDotenv: () => ({ keys: [], loaded: false }),
    listCustomCommands: async () => ({ commands: [] }),
    resolveWorkspaceGitBranch: async () => undefined,
    startProcessProviderRegistryRuntime: async () => ({ runtime: { registryService: {} }, dispose() {} }),
    createZCodeApp: () => ({ sessionId: "test", getLocale: () => "en-US", listModels: async () => [], runtime: {}, close() {}, sendInput() { sent++; throw new Error("不应发起请求"); } }),
    runTui: async (options) => {
      startup = await options.loadStartupOptions();
      assert.match(startup.initialResult.response, /comecode config setup/u);
      assert.match(startup.initialResult.response, /先配置一个模型/u);
      const result = await options.sendInput("你好", {});
      assert.equal(result.kind, "command_result");
      assert.match(result.result.response, /config setup/u);
      return 0;
    },
  }, "test");
  assert.equal(status, 0, f.readStderr());
  assert.equal(startup.initialResult.loginRequired, false);
  assert.equal(sent, 0);
});

test("真实终端输入密钥不回显，Ctrl+C 取消不修改配置", async (t) => {
  const { PassThrough } = await import("node:stream");
  const f = await fixture(t);
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  t.after(() => stdin.destroy());
  const answers = ["1", "https://model.example/v1", "test-model", "do-not-echo-this-secret", "y"];
  let output = "";
  const ctx = {
    stdin, stdout: f.ctx.stdout,
    stderr: { isTTY: true, columns: 100, write: (chunk) => {
      const text = chunk.toString();
      output += text;
      if (/^[1-4]\. |^保存配置/u.test(text)) {
        const answer = answers.shift();
        setImmediate(() => stdin.write(`${text.startsWith("保存配置") ? "\u001b[A" : ""}${answer}\r`));
      }
    } },
  };
  assert.equal(await runProviderConfigSetup(ctx, f.env, f.root), 0);
  assert.doesNotMatch(output, /do-not-echo-this-secret/u);
  assert.match(await readFile(join(f.root, ".comecode", "config.toml"), "utf8"), /do-not-echo-this-secret/u);

  const cancelled = await fixture(t);
  const cancelInput = new PassThrough();
  cancelInput.isTTY = true;
  cancelInput.setRawMode = () => {};
  t.after(() => cancelInput.destroy());
  const cancelCtx = { ...cancelled.ctx, stdin: cancelInput, stderr: { isTTY: true, write: (chunk) => {
    if (chunk.toString().startsWith("1.")) setImmediate(() => cancelInput.write("\u0003"));
  } } };
  assert.equal(await runProviderConfigSetup(cancelCtx, cancelled.env, cancelled.root), 1);
  await assert.rejects(readFile(join(cancelled.root, ".comecode", "config.toml")), { code: "ENOENT" });
});

test("真实 TUI 渲染首屏卡片时配置向导命令可见且无 OSC 控制字符", async (t) => {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
  const React = require("react");
  const { testRender } = await import(pathToFileURL(require.resolve("@mbears/opentui-react/test-utils")));
  const { ContentPane } = await import("../packages/tui/src/app-transcript-components.tsx");
  const { appendAgentResult } = await import("../packages/tui/src/app-submit.ts");
  const { getZCodeCopy } = await import("../packages/i18n/src/index.ts");
  const { providerSetupStartupResponse } = await import("../packages/cli/src/provider-setup.ts");
  const f = await fixture(t);
  let view;
  await React.act(async () => {
    view = await testRender(React.createElement(ContentPane, {
      copy: getZCodeCopy("zh-CN").tui,
      messages: appendAgentResult([], { response: providerSetupStartupResponse(f.env, f.root), responseFormat: "plain" }),
      terminalWidth: 90,
    }), { width: 90, height: 22 });
    await view.flush();
  });
  try {
    const frame = view.captureCharFrame();
    assert.match(frame, /comecode config setup/u);
    assert.match(frame, /接口地址/u);
    assert.equal(frame.includes("\u001b"), false);
  } finally {
    await React.act(async () => view.renderer.destroy());
  }
});
