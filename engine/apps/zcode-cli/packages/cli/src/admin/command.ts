import { openUrlInBrowser } from "@zcode/adapters";
import type { RunContext } from "@zcode/shared-types";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "../arguments.js";
import { loadCliDotenv, type CliEnv } from "../env.js";
import type { RunDependencies } from "../cli-types.js";
import { startAdminServer } from "./server.js";

function options(ctx: RunContext) {
  const parsed = parseGlobalArgs(extractDisallowedToolsArgs(ctx.argv).args);
  // --web-port 是管理页早期的参数名，保留为 --port 的兼容别名。
  const value = parsed.values.port ?? parsed.values["web-port"];
  if (value !== undefined && (!/^\d+$/u.test(value) || Number(value) > 65535)) throw new Error("--port 必须为 0–65535 的整数");
  return { ...parsed.values, port: value === undefined ? undefined : Number(value) };
}
async function open(ctx: RunContext, env: CliEnv, cwd: string, autoOpen: boolean) {
  const flags = options(ctx);
  const dotenv = loadCliDotenv({ cwd, env });
  if (dotenv.error) throw new Error("无法读取环境配置，请检查 .env");
  const server = await startAdminServer({ cwd, env, port: flags.port });
  ctx.stderr.write(`ComeCode 管理后台：${server.url}\n`);
  if (autoOpen && !flags["no-browser"]) {
    const result = await openUrlInBrowser(server.url);
    if (!result.opened) ctx.stderr.write("无法自动打开浏览器，请复制上方链接。\n");
  }
  return server;
}
/** 独立管理命令不创建 Agent，会话结束前只持有本地监听；网页对话不由这里提供。 */
export async function runAdminCommand(ctx: RunContext, deps: RunDependencies, args: readonly string[]) {
  const desktop = args.length === 1 && args[0] === "desktop-stdio";
  if (args.length && !desktop) { ctx.stderr.write("用法：comecode admin [--port <port>] [--no-browser]\n"); return 1; }
  let server: Awaited<ReturnType<typeof startAdminServer>> | undefined;
  try {
    if (desktop) {
      // 管理进程只通过私有 stdio 返回授权地址，不写入终端日志或启动 Agent。
      server = await startAdminServer({ env: deps.env ?? process.env, includeProject: false, port: 0 });
      ctx.stdout.write(`${JSON.stringify({ type: "comecode-admin-ready", url: server.url })}\n`);
      await new Promise<void>((resolve) => {
        const close = () => { process.off("SIGINT", close); process.off("SIGTERM", close); process.stdin.off("end", close); resolve(); };
        process.once("SIGINT", close); process.once("SIGTERM", close);
        process.stdin.once("end", close); process.stdin.resume();
      });
    } else {
      server = await open(ctx, deps.env ?? process.env, (deps.cwd ?? process.cwd)(), true);
      ctx.stderr.write("按 Ctrl+C 关闭管理页面。\n");
      await new Promise<void>((resolve) => {
        const close = () => { process.off("SIGINT", close); process.off("SIGTERM", close); resolve(); };
        process.once("SIGINT", close); process.once("SIGTERM", close);
      });
    }
    return 0;
  } catch (error) { ctx.stderr.write(`${(error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "端口已被占用，请使用 --port 选择其他端口" : (error as Error).message}\n`); return 1; }
  finally { await server?.close(); }
}
