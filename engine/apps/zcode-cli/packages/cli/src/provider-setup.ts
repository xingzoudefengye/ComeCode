// Modified by ComeCode：模型配置是 CLI 的入口条件，不依赖厂商账号。
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveComeCodeDataRoot } from "@zcode/adapters/config";
import type { CliEnv } from "./env.js";

export function providerSetupResponse(locale?: string, env: CliEnv = process.env): string {
  const path =
    env.COMECODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ||
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ||
    join(resolveComeCodeDataRoot(env), "v2", "provider_config.json");
  const linkedPath = terminalFileLink(path);
  return locale === "zh-CN"
    ? `请在 ${linkedPath} 配置 API Key Provider（access.apiKey、api.baseUrl、模型列表和默认模型）。配置后重启 ComeCode，或用 /model 查看已加载模型。`
    : `Configure an API Key Provider in ${linkedPath} (access.apiKey, api.baseUrl, model list and default model). Restart ComeCode after editing, or use /model to view loaded models.`;
}

/** 使用终端标准 OSC 8，让 Windows Terminal/VS Code Terminal 支持 Ctrl+单击打开文件。 */
function terminalFileLink(filePath: string): string {
  const target = fileUrlForPath(filePath);
  return `\u001b]8;;${target}\u0007${filePath}\u001b]8;;\u0007`;
}

function fileUrlForPath(filePath: string): string {
  if (/^[A-Za-z]:[\\/]/u.test(filePath)) {
    const normalized = filePath.replaceAll("\\", "/");
    return `file:///${encodeURI(normalized)}`;
  }
  return pathToFileURL(filePath).toString();
}
