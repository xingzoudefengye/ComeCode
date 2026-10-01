import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatCliHelp } from "../packages/cli/src/help.ts";
import { createCommandCenter } from "../packages/cli/src/command-center/create.ts";
import { listSlashCommandSuggestions } from "../packages/cli/src/command-center/slash-commands.ts";
import { readTuiSessionMetadata } from "../packages/cli/src/tui-prompt-handler-queries.ts";
import { runLoginCommand } from "../packages/cli/src/login-command.ts";
import { providerSetupResponse } from "../packages/cli/src/provider-setup.ts";

test("中英文帮助和 TUI 建议隐藏登录", () => {
  for (const locale of ["zh-CN", "en-US"])
    assert.doesNotMatch(formatCliHelp("test", locale), /(?:\/login|\blogin \[|--no-browser)/u);
  assert.ok(listSlashCommandSuggestions().every((entry) => entry.name !== "login"));
});

test("缺少 Provider 的 TUI 只提示配置，不进入登录状态", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-guide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handler = createCommandCenter({
    hasSelectableModels: async () => false,
    getProviderSetupResponse: () => providerSetupResponse("zh-CN", { COMECODE_DATA_BASE_DIR: root }, root),
    getMode: () => "build",
    getLocale: () => "zh-CN",
  });
  const result = await handler("你好", {});
  assert.equal(result.loginRequired, false);
  assert.match(result.response, /comecode config setup/u);
  assert.doesNotMatch(result.response, /\/login/u);
  assert.equal((await readTuiSessionMetadata({ listModels: async () => [] })).loginRequired, false);
});

test("没有可用模型时所有操作统一进入 Provider 配置引导", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-guide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handler = createCommandCenter({
    hasSelectableModels: async () => false,
    getProviderSetupResponse: () => providerSetupResponse("zh-CN", { COMECODE_DATA_BASE_DIR: root }, root),
    getLocale: () => "en-US",
    getMode: () => "yolo",
  });
  for (const input of ["/model", "/help", "/mode edit", "你好"]) {
    const result = await handler(input, {});
    assert.match(result.response, /comecode config setup/u, input);
    assert.doesNotMatch(result.response, /No selectable models|Current model/u, input);
  }
});

test("已配置模型直接提交，无需厂商登录", async () => {
  let submissions = 0;
  const app = {
    sessionId: "test",
    submitPrompt: async () => {
      submissions++;
      return { response: "ok" };
    },
  };
  const handler = createCommandCenter({
    hasSelectableModels: async () => true,
    getApp: async () => app,
  });
  assert.equal((await handler("你好", {})).response, "ok");
  assert.equal(submissions, 1);
});

test("显式旧登录命令只返回配置引导", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-guide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let output = "";
  const status = await runLoginCommand(
    {
      stderr: {
        write: (value) => {
          output += value;
        },
      },
    },
    {},
    {
      env: { COMECODE_DATA_BASE_DIR: root },
      loginZCodeCli: async () => {
        throw new Error("不应调用 OAuth");
      },
    },
    false,
  );
  assert.equal(status, 1);
  assert.match(output, /comecode config setup/u);
  const handler = createCommandCenter({ getProviderSetupResponse: () => providerSetupResponse("zh-CN", { COMECODE_DATA_BASE_DIR: root }, root) });
  assert.match((await handler("/login", {})).response, /comecode config setup/u);
});

test("中文配置步骤没有终端控制字符或内部 JSON 字段", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-guide-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = providerSetupResponse("en-US", { COMECODE_DATA_BASE_DIR: root }, root);
  assert.match(output, /尚未配置模型/u);
  assert.match(output, /comecode config setup/u);
  assert.match(output, /接口地址/u);
  assert.match(output, /API Key/u);
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes("\u0007"), false);
  assert.doesNotMatch(output, /access\.apiKey|provider_config\.json|Configure an API/u);
});

test("首次引导不创建文件、不展示路径，已有配置不覆盖", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { COMECODE_DATA_BASE_DIR: root };
  const output = providerSetupResponse("zh-CN", env, root);
  assert.doesNotMatch(output, /config\.(json|jsonc|toml)|文件|保存位置/u);
  const path = join(root, ".comecode", "config.json");
  await assert.rejects(readFile(path), { code: "ENOENT" });
  await mkdir(join(root, ".comecode"));
  const content = '{"model":"keep-me"}\n';
  await writeFile(path, content, "utf8");
  providerSetupResponse("zh-CN", env, root);
  assert.equal(await readFile(path, "utf8"), content);
});
