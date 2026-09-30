import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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

test("缺少 Provider 的 TUI 只提示配置，不进入登录状态", async () => {
  const handler = createCommandCenter({
    hasSelectableModels: async () => false,
    getMode: () => "build",
    getLocale: () => "zh-CN",
  });
  const result = await handler("你好", {});
  assert.equal(result.loginRequired, false);
  assert.match(result.response, /provider_config\.json/u);
  assert.doesNotMatch(result.response, /\/login/u);
  assert.equal((await readTuiSessionMetadata({ listModels: async () => [] })).loginRequired, false);
});

test("没有可用模型时所有操作统一进入 Provider 配置引导", async () => {
  const handler = createCommandCenter({
    hasSelectableModels: async () => false,
    getLocale: () => "en-US",
    getMode: () => "yolo",
  });
  for (const input of ["/model", "/help", "/mode edit", "你好"]) {
    const result = await handler(input, {});
    assert.match(result.response, /provider_config\.json/u, input);
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

test("显式旧登录命令只返回配置引导", async () => {
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
      env: {},
      loginZCodeCli: async () => {
        throw new Error("不应调用 OAuth");
      },
    },
    false,
  );
  assert.equal(status, 1);
  assert.match(output, /provider_config\.json/u);
  const handler = createCommandCenter({});
  assert.match((await handler("/login", {})).response, /provider_config\.json/u);
});

test("Provider 配置路径使用 OSC 8 文件链接", () => {
  const output = providerSetupResponse("en-US", {
    COMECODE_PERSONAL_PROVIDER_CONFIG_FILE: "C:\\Users\\ruogu\\.comecode\\v2\\provider_config.json",
  });
  assert.match(
    output,
    /\u001b\]8;;file:\/\/\/C:\/Users\/ruogu\/\.comecode\/v2\/provider_config\.json\u0007C:\\Users\\ruogu\\\.comecode\\v2\\provider_config\.json\u001b\]8;;\u0007/u,
  );
});

test("首次 Provider 引导会创建可打开的空配置文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-provider-"));
  const path = join(root, "v2", "provider_config.json");
  providerSetupResponse("zh-CN", { COMECODE_PERSONAL_PROVIDER_CONFIG_FILE: path });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
});
