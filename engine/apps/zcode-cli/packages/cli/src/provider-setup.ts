// Modified by ComeCode：首次使用提供可直接操作的中文配置步骤，不暴露内部 JSON 字段。
import type { CliEnv } from "./env.js";

/** 无交互输入时给出唯一可操作的入口，不要求用户了解文件格式。 */
export function providerSetupResponse(_locale?: string, _env: CliEnv = process.env, _cwd?: string): string {
  return ["尚未配置模型", "在交互终端运行 comecode，按提示填写接口地址、模型名称和 API Key。", "也可以运行 comecode config setup。"].join("\n");
}

export function providerSetupStartupResponse(env: CliEnv, cwd: string): string {
  return providerSetupResponse("zh-CN", env, cwd);
}
