import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { resolveUnifiedConfigPaths } from "@zcode/adapters/config";
import type { RunContext } from "@zcode/shared-types";
import type { CliEnv } from "./env.js";
import { providerSetupResponse } from "./provider-setup.js";

type Ask = (prompt: string, secret?: boolean) => Promise<string>;

/** 中文向导仅持有本次输入；保存后统一配置解析器仍是配置唯一所有者。 */
export async function runProviderConfigSetup(
  ctx: RunContext,
  env: CliEnv,
  cwd: string,
  askOverride?: Ask,
): Promise<number> {
  if (!ctx.stdin.isTTY || !ctx.stderr.isTTY) {
    ctx.stderr.write(`配置向导需要交互终端，请直接在终端运行 comecode config setup。\n${providerSetupResponse("zh-CN", env, cwd)}\n`);
    return 1;
  }
  const paths = resolveUnifiedConfigPaths({ env, cwd });
  let close = () => {};
  const ask = askOverride ?? (() => {
    let hidden = false;
    const controller = new AbortController();
    // 密钥输入由 readline 编辑，但输出被抑制，避免进入终端、滚屏和日志。
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!hidden) ctx.stderr.write(chunk);
        done();
      },
    });
    Object.assign(output, { isTTY: true, columns: ctx.stderr.columns });
    const reader = createInterface({ input: ctx.stdin, output, terminal: true, historySize: 0 });
    reader.on("SIGINT", () => controller.abort());
    reader.on("close", () => controller.abort());
    close = () => { reader.close(); output.end(); };
    return async (prompt: string, secret = false) => {
      ctx.stderr.write(prompt);
      hidden = secret;
      try {
        const answer = await reader.question("", { signal: controller.signal });
        if (secret) ctx.stderr.write("\n");
        return answer.trim();
      } finally {
        hidden = false;
      }
    };
  })();
  try {
    ctx.stderr.write("ComeCode 模型配置向导\n准备好服务商给的：接口地址、模型名称、API Key。Ctrl+C 可取消。\n");
    if (paths.project) ctx.stderr.write(`注意：项目配置 ${paths.project} 会优先覆盖用户设置；保存后请检查它。\n`);
    ctx.stderr.write(`保存位置：${paths.user}\n`);
    const typeChoice = await ask("1. 服务类型：1=OpenAI 兼容/NewAPI/DeepSeek（默认），2=OpenAI Responses，3=Anthropic/Claude：");
    const type = ({ "": "openai-chat", "1": "openai-chat", "2": "openai-responses", "3": "anthropic" } as Record<string, string>)[typeChoice];
    if (!type) throw new Error("服务类型无效，请选择 1、2 或 3，再运行向导。");
    const defaultUrl = type === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
    let baseUrl: string;
    while (true) {
      baseUrl = (await ask(`2. 接口地址（回车使用 ${defaultUrl}；第三方网关请填写自己的地址）：`)) || defaultUrl;
      try {
        const parsed = new URL(baseUrl);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        break;
      } catch {
        ctx.stderr.write("地址不正确，请填写以 https:// 或 http:// 开头的 API 地址，不要包含密钥。\n");
      }
    }
    let model = "";
    while (!model) model = await ask("3. 模型名称（从服务商模型列表复制，例如 deepseek-chat）：");
    let apiKey = "";
    while (!apiKey) apiKey = await ask("4. API Key（输入不显示，粘贴后按回车）：", true);
    const content = [
      "# ComeCode 模型配置，由配置向导生成。此文件含密钥，请勿分享或提交到 Git。",
      `model = ${JSON.stringify(model)} # 服务商模型列表中的名称`,
      'provider = "my-api"',
      "", "[providers.my-api]",
      `type = ${JSON.stringify(type)} # 请求协议`,
      `base_url = ${JSON.stringify(baseUrl)} # API 接口地址`,
      `api_key = ${JSON.stringify(apiKey)} # 私密凭据`, "",
    ].join("\n");
    let existing: string | undefined;
    try { existing = await readFile(paths.user, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ctx.stderr.write(`将保存模型 ${JSON.stringify(model)}，密钥不会显示。\n`);
    const confirmation = await ask(existing === undefined
      ? "保存配置？[y/N] "
      : "配置文件已存在。备份原文件后替换？[y/N] ");
    if (confirmation.toLowerCase() !== "y") {
      ctx.stderr.write("已取消，未修改配置。\n");
      return 0;
    }
    await mkdir(dirname(paths.user), { recursive: true });
    if (existing !== undefined) {
      const backup = `${paths.user}.${randomUUID()}.bak`;
      await copyFile(paths.user, backup, constants.COPYFILE_EXCL);
      ctx.stderr.write(`原配置已备份：${backup}\n`);
    }
    await writeFile(paths.user, content, { encoding: "utf8", mode: 0o600, flag: existing === undefined ? "wx" : "w" });
    ctx.stderr.write(`配置已保存：${paths.user}\n下一步：运行 comecode config check，检查通过后运行 comecode。\n${paths.project ? "注意：项目配置仍优先，检查不通过时也要检查项目文件。\n" : ""}`);
    return 0;
  } catch (error) {
    const message = (error as Error).name === "AbortError" ? "已取消配置向导。" : `配置未保存：${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
    ctx.stderr.write(`${message}\n`);
    return 1;
  } finally {
    close();
  }
}
