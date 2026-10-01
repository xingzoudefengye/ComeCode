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
      assert.match(startup.initialResult.response, /尚未配置模型/u);
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
  const answeredPrompts = new Set();
  let output = "";
  const ctx = {
    stdin, stdout: f.ctx.stdout,
    stderr: { isTTY: true, columns: 100, write: (chunk) => {
      const text = chunk.toString();
      output += text;
      const step = /^(?:[1-4]\. |保存配置)/u.exec(text)?.[0];
      if (step && !answeredPrompts.has(step)) {
        answeredPrompts.add(step);
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


test("公开引导只保留操作步骤，不包含个人接入方式或解释性旁白", async (t) => {
  const f = await fixture(t);
  const { providerSetupStartupResponse, PROVIDER_CONFIG_TEMPLATE } = await import("../packages/cli/src/provider-setup.ts");
  for (const text of [providerSetupStartupResponse(f.env, f.root), providerSetupResponse("zh-CN", f.env, f.root), PROVIDER_CONFIG_TEMPLATE]) {
    assert.doesNotMatch(text, /NewAPI|你的newapi|购买\/使用|网关|模型客户端|不提供模型|不是你的输入/u);
  }
  const startup = providerSetupStartupResponse(f.env, f.root);
  assert.match(startup, /需要填写：接口地址、模型名称、API Key/u);
  assert.match(startup, /comecode config setup/u);
  await runProviderConfigSetup(f.ctx, f.env, f.root, scriptedAsk(["1", "", "my-model", "test-key", "n"], []));
  assert.doesNotMatch(f.readStderr(), /NewAPI|DeepSeek|不需要自建网关|不提供模型/u);
  assert.match(f.readStderr(), /需要填写：接口地址、模型名称、API Key/u);
});


test("readline 刷新后提问仍在终端画面中，等待输入而不是空白行", { timeout: 5000 }, async (t) => {
  const previousTerm = process.env.TERM;
  // 工具环境的 TERM=dumb 不触发 readline 清屏；显式覆盖才能复现用户终端。
  process.env.TERM = "xterm-256color";
  t.after(() => { if (previousTerm === undefined) delete process.env.TERM; else process.env.TERM = previousTerm; });
  const { PassThrough } = await import("node:stream");
  const f = await fixture(t);
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  t.after(() => stdin.destroy());
  const lines = [""];
  let row = 0;
  let column = 0;
  let rawOutput = "";
  // 模拟 readline 使用的清屏/光标命令；输出过提示不代表提示仍在屏幕上。
  const render = (chunk) => {
    const text = chunk.toString();
    rawOutput += text;
    // oxlint-disable-next-line eslint(no-control-regex) -- 终端模拟必须识别真实 ESC 光标命令。
    const tokens = text.match(/\u001b\[[0-9;]*[A-Za-z]|[^\u001b]/gu) ?? [];
    for (const token of tokens) {
      // oxlint-disable-next-line eslint(no-control-regex) -- 这里只解析 readline 输出的 ANSI 控制序列。
      const sequence = /^\u001b\[([0-9;]*)([A-Za-z])$/u.exec(token);
      if (sequence) {
        const amount = Number(sequence[1]) || 1;
        switch (sequence[2]) {
          case "G": column = amount - 1; break;
          case "A": row = Math.max(0, row - amount); break;
          case "B": row += amount; break;
          case "C": column += amount; break;
          case "D": column = Math.max(0, column - amount); break;
          case "J": lines[row] = (lines[row] ?? "").slice(0, column); lines.length = row + 1; break;
          case "K": lines[row] = (lines[row] ?? "").slice(0, column); break;
        }
      } else if (token === "\r") column = 0;
      else if (token === "\n") { row++; column = 0; }
      else {
        const current = [...(lines[row] ?? "")];
        while (current.length < column) current.push(" ");
        current[column++] = token;
        lines[row] = current.join("");
      }
    }
  };
  // 大宽度避免此小型屏幕模型模拟自动换行；实际窗口另用 PTY 冒烟验收。
  const ctx = { ...f.ctx, stdin, stderr: { isTTY: true, columns: 500, write: render } };
  const finished = runProviderConfigSetup(ctx, f.env, f.root);
  let closed = false;
  finished.finally(() => { closed = true; });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    await flush();
    assert.equal(closed, false);
    assert.match(lines.join("\n"), /1\. 服务类型：/u);
    stdin.write("1\r");
    await flush();
    assert.match(lines.join("\n"), /2\. 接口地址/u);
    stdin.write("https://model.example/v1\r");
    await flush();
    assert.match(lines.join("\n"), /3\. 模型名称/u);
    stdin.write("model-test\r");
    await flush();
    assert.match(lines.join("\n"), /4\. API Key/u);
    stdin.write("screen-private-key\r");
    await flush();
    assert.match(lines.join("\n"), /保存配置/u);
    assert.doesNotMatch(rawOutput, /screen-private-key/u);
    stdin.write("n\r");
    assert.equal(await finished, 0);
  } finally {
    if (!closed) { stdin.write("\u0003"); await finished; }
  }
});
