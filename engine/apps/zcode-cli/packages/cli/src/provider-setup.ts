// Modified by ComeCode：首次使用提供可直接操作的中文配置步骤，不暴露内部 JSON 字段。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveUnifiedConfigPaths } from "@zcode/adapters/config";
import type { CliEnv } from "./env.js";

export const PROVIDER_CONFIG_EXAMPLE = `# 将下面三个值换成服务商提供的信息，保留双引号。
model = "填写模型名称"
provider = "my-api"

[providers.my-api]
type = "openai-chat" # NewAPI、DeepSeek 等 OpenAI 兼容接口使用此项
base_url = "https://你的接口地址/v1" # 复制服务商给的 API 地址，不是网页地址
api_key = "填写你的 API Key" # 密钥不要发给别人，也不要提交到 Git
# 如果服务商要求 Responses：type = "openai-responses"
# 如果是 Anthropic/Claude 接口：type = "anthropic"，地址使用服务商给的地址`;

// 全注释模板不构成有效配置，用户未填写前环境变量零配置仍可使用。
export const PROVIDER_CONFIG_TEMPLATE = `# ComeCode 模型配置：推荐先执行 comecode config setup，按提示填写。
# 手动配置：去掉下面配置行开头的 #，填写模型名称、接口地址、API Key。
# 保存后运行 comecode config check，再重启 comecode。
# 注意：此文件含密钥时不要分享或提交到 Git。
${PROVIDER_CONFIG_EXAMPLE.split("\n").map((line) => `# ${line}`).join("\n")}
`;

export function providerSetupResponse(_locale?: string, env: CliEnv = process.env, cwd?: string): string {
  const paths = resolveUnifiedConfigPaths({ env, cwd });
  const status = ensureProviderConfigTemplate(paths.user);
  const editor = process.platform === "win32"
    ? `notepad "${paths.project ?? paths.user}"`
    : `用文本编辑器打开：${paths.project ?? paths.user}`;
  return [
    "还没有可用模型，先完成一次配置（不需要厂商账号登录）",
    "",
    "最简单的方法：配置向导",
    "1. 退出当前界面：按两次 Ctrl+C，按提示确认退出。",
    "2. 在终端运行：comecode config setup",
    "3. 按提示填写接口地址、模型名称和 API Key，然后保存。",
    "4. 运行 comecode config check；检查通过后再运行 comecode。",
    "",
    "这三个信息从哪里来？打开你购买/使用的模型服务商或 NewAPI 的控制台：",
    "- 接口地址：复制 API 地址（通常以 /v1 结尾，不是控制台网页地址）。",
    "- API Key：在“密钥 / API Keys / 令牌”页面创建或复制。",
    "- 模型名称：从服务商的模型列表复制，不能随便起名字。",
    "没有这些信息时，ComeCode 不能调用模型；先向你的服务商获取。",
    "",
    "也可以手动填写配置文件",
    `用户配置：${paths.user}`,
    status,
    ...(paths.project ? [`注意：项目配置 ${paths.project} 优先于用户配置。请检查该文件，避免它覆盖新设置。`] : []),
    `打开文件：${editor}`,
    "复制下面示例，把三个占位值替换成你自己的信息，保存：",
    PROVIDER_CONFIG_EXAMPLE,
    "保存后退出并重启 ComeCode。/model 只查看已加载模型，不会重新读取 TOML。",
    "不要把含密钥的配置文件发给别人。",
  ].join("\n");
}

/** 首屏保持简短，避免长示例把向导命令挤出终端可视区域。 */
export function providerSetupStartupResponse(env: CliEnv, cwd: string): string {
  const paths = resolveUnifiedConfigPaths({ env, cwd });
  const status = ensureProviderConfigTemplate(paths.user);
  return [
    "欢迎使用 ComeCode：先配置一个模型",
    "目前还没有可用模型，不是你的输入有问题。",
    "准备三项信息：接口地址、模型名称、API Key（从模型服务商/NewAPI 控制台取得）。",
    "",
    "按两次 Ctrl+C，确认退出后，在终端运行：",
    "comecode config setup",
    "按中文向导填写并保存 → comecode config check → comecode。",
    `配置文件：${paths.user}`,
    status,
    ...(paths.project ? [`项目配置优先：${paths.project}，请同时检查。`] : []),
    "想手动配置？输入任意文字后回车，即可查看带中文注释的完整示例。",
  ].join("\n");
}

/** 首次使用只创建带注释的模板，已有文件一律保留；失败必须显示真实原因。 */
function ensureProviderConfigTemplate(filePath: string): string {
  try {
    if (existsSync(filePath)) return "配置文件已存在；保留原内容，未覆盖。";
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, PROVIDER_CONFIG_TEMPLATE, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return "已创建带中文注释的配置模板。";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && existsSync(filePath)) return "配置文件已存在；未覆盖。";
    return `无法创建模板（${(error as NodeJS.ErrnoException).code ?? "文件写入失败"}）。请手动创建文件并使用下面示例。`;
  }
}
