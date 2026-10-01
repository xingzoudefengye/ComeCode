import { openUrlInBrowser } from "@zcode/adapters";
import { extractCliWorkingDirectory } from "@zcode/adapters/config";
import type { RunContext } from "@zcode/shared-types";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "../arguments.js";
import { loadCliDotenv, type CliEnv } from "../env.js";
import type { RunDependencies } from "../cli-types.js";
import { startAdminServer } from "./server.js";

function options(ctx: RunContext) {
  const parsed = parseGlobalArgs(extractDisallowedToolsArgs(ctx.argv).args);
  const value = parsed.values["web-port"];
  if (value !== undefined && (!/^\d+$/u.test(value) || Number(value) > 65535)) throw new Error("--web-port 必须为 0–65535 的整数");
  if (parsed.values.web && parsed.values["no-web"]) throw new Error("--web 与 --no-web 不能同时使用");
  return { ...parsed.values, port: value === undefined ? undefined : Number(value) };
}
async function open(ctx: RunContext, env: CliEnv, cwd: string, autoOpen: boolean) {
  const flags = options(ctx);
  const dotenv = loadCliDotenv({ cwd, env });
  if (dotenv.error) throw new Error("无法读取环境配置，请检查 .env");
  const server = await startAdminServer({ cwd, env, port: flags.port });
  ctx.stderr.write(`ComeCode 模型管理：${server.url}\n保存后重启 ComeCode 生效。\n`);
  if (autoOpen && !flags["no-browser"]) {
    const result = await openUrlInBrowser(server.url);
    if (!result.opened) ctx.stderr.write("无法自动打开浏览器，请复制上方链接。\n");
  }
  return server;
}
export async function prepareTuiAdmin(ctx: RunContext, env: CliEnv) {
  const flags = options(ctx);
  if (!flags.web || flags["no-web"]) return undefined;
  return open(ctx, env, extractCliWorkingDirectory(ctx.argv), true);
}
/** 独立管理命令不创建 Agent，会话结束前只持有本地监听。 */
export async function runAdminCommand(ctx: RunContext, deps: RunDependencies, args: readonly string[]) {
  if (args.length) { ctx.stderr.write("用法：comecode admin [--web-port <port>] [--no-browser]\n"); return 1; }
  let server: Awaited<ReturnType<typeof startAdminServer>> | undefined;
  try {
    if (options(ctx)["no-web"]) throw new Error("admin 命令不能与 --no-web 同时使用");
    server = await open(ctx, deps.env ?? process.env, (deps.cwd ?? process.cwd)(), true);
    ctx.stderr.write("按 Ctrl+C 关闭管理页面。\n");
    await new Promise<void>((resolve) => {
      const close = () => { process.off("SIGINT", close); process.off("SIGTERM", close); resolve(); };
      process.once("SIGINT", close); process.once("SIGTERM", close);
    });
    return 0;
  } catch (error) { ctx.stderr.write(`${(error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "端口已被占用，请使用 --web-port 选择其他端口" : (error as Error).message}\n`); return 1; }
  finally { await server?.close(); }
}
