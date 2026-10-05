import { resolveUnifiedConfig, extractCliWorkingDirectory, extractProviderCliOverrides, } from "@zcode/adapters/config";
import { loadCliDotenv } from "./env.js";
import { runProviderConfigSetup } from "./provider-config-setup.js";
import { isTuiInvocation } from "./tui-stderr.js";
/** 渲染前完成首次输入，避免 readline 与 TUI 同时接管终端。 */
export async function ensureFirstProviderSetup(ctx, env, setup = runProviderConfigSetup) {
    if (!isTuiInvocation(ctx.argv) || !ctx.stdin.isTTY || !ctx.stderr.isTTY)
        return 0;
    const cwd = extractCliWorkingDirectory(ctx.argv);
    // 首次判断也读取同一 .env，不能把已有环境凭据误判成未配置。
    const dotenv = loadCliDotenv({ cwd, env });
    if (dotenv.error) {
        ctx.stderr.write("无法读取环境配置，请检查 .env。\n");
        return 1;
    }
    const config = await resolveUnifiedConfig({
        cwd,
        env,
        cliOverrides: extractProviderCliOverrides(ctx.argv),
    });
    if (config.providers.some((provider) => provider.executable) || config.diagnostics.errors.length)
        return 0;
    const status = await setup(ctx, env, cwd, undefined, true);
    if (status !== 0)
        return status;
    // 项目空配置可继承用户新设置；非空/冲突项目不能静默回退其他模型。
    const saved = await resolveUnifiedConfig({
        cwd,
        env,
        cliOverrides: extractProviderCliOverrides(ctx.argv),
    });
    if (saved.diagnostics.errors.length || !saved.providers.some((provider) => provider.executable)) {
        ctx.stderr.write("模型配置未生效，请运行 comecode config check。\n");
        return 1;
    }
    return 0;
}
