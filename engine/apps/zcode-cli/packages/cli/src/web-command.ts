import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openUrlInBrowser } from "@zcode/adapters";
import type { RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

/**
 * `comecode --web` 启动的是上游网页对话工作台（@zcode/web 静态产物 + @zcode/server HTTP/WebSocket
 * 服务），而不是 CLI 内嵌的管理页——管理页统一由 `comecode admin` 提供。Agent 仍由 CLI 自身以
 * `app-server --stdio` 子进程承担，网页只是同一 Runtime/SessionStore 的另一个客户端。
 */
export interface WebCommandOptions {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly tokenEnabled?: boolean;
  readonly open?: boolean;
  readonly workspace?: string;
}

interface WebRuntime {
  readonly serverEntry: string;
  readonly staticRoot: string;
  readonly agentEntry: string;
}

const WEB_RUNTIME_MISSING_ERROR =
  "未找到网页对话运行时（需要 web 与 server 资源）。请先构建：pnpm --filter \"@zcode/cli...\" build && pnpm --filter \"@zcode/server...\" build && pnpm --filter @zcode/web build，或重新安装 comecode。";

const SHUTDOWN_GRACE_MS = 1500;

async function fileExists(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(
    () => true,
    () => false,
  );
}

/** 安装包入口是 .cjs 构建产物；tsx 直接跑 src/main.ts 时不能把它当 Agent 入口。 */
async function resolveSelfEntry(): Promise<string | undefined> {
  const entry = process.argv[1];
  if (!entry || !/\.(?:cjs|mjs|js)$/u.test(entry)) return undefined;
  return (await fileExists(entry)) ? resolve(entry) : undefined;
}

/**
 * 从入口目录及其上级查找运行时资源，兼容两种布局：
 * 安装包 `<root>/{web,server,agent}`，以及 monorepo `engine/packages/{web/dist,server/dist}`。
 */
async function candidateRoots(): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (directory: string | undefined): void => {
    if (!directory) return;
    const normalized = resolve(directory);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    roots.push(normalized);
  };

  const entry = process.argv[1];
  if (entry) {
    push(dirname(entry));
    const real = await realpath(entry).catch(() => undefined);
    if (real) push(dirname(real));
  }
  for (const root of [...roots]) {
    let current = root;
    for (let depth = 0; depth < 6; depth += 1) {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
      push(current);
    }
  }
  push(process.cwd());
  return roots;
}

export async function resolveWebRuntime(): Promise<WebRuntime | undefined> {
  for (const root of await candidateRoots()) {
    const packagedWeb = join(root, "web");
    const packagedServer = join(root, "server", "entry-http.js");
    if ((await fileExists(join(packagedWeb, "index.html"))) && (await fileExists(packagedServer))) {
      const stagedAgent = join(root, "agent", "zcode.cjs");
      const agentEntry = (await fileExists(stagedAgent)) ? stagedAgent : await resolveSelfEntry();
      // 缺 Agent 入口时继续找下一个候选根，避免返回一个必然启动失败的三元组。
      if (agentEntry) {
        return { agentEntry, serverEntry: packagedServer, staticRoot: packagedWeb };
      }
    }

    const monorepoWeb = join(root, "packages", "web", "dist");
    const monorepoServer = join(root, "packages", "server", "dist", "entry-http.js");
    const monorepoAgent = join(root, "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs");
    if (
      (await fileExists(join(monorepoWeb, "index.html"))) &&
      (await fileExists(monorepoServer)) &&
      (await fileExists(monorepoAgent))
    ) {
      return { agentEntry: monorepoAgent, serverEntry: monorepoServer, staticRoot: monorepoWeb };
    }
  }
  return undefined;
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function createToken(): string {
  return randomBytes(24).toString("base64url");
}

/** 借 net 监听 0 号端口拿空闲端口，避免与用户已有服务冲突。 */
function pickPort(host: string): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? rejectPort(error) : resolvePort(port)));
    });
  });
}

function formatUrl(host: string, port: number, token: string): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const base = `http://${displayHost}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

function networkUrls(port: number, token: string): string[] {
  const urls: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      const base = `http://${entry.address}:${port}/`;
      urls.push(token ? `${base}?token=${encodeURIComponent(token)}` : base);
    }
  }
  return urls;
}

export async function runWebCommand(
  ctx: RunContext,
  deps: RunDependencies,
  options: WebCommandOptions = {},
): Promise<number> {
  const runtime = await resolveWebRuntime();
  if (!runtime) {
    ctx.stderr.write(`${WEB_RUNTIME_MISSING_ERROR}\n`);
    return 1;
  }

  const workspace = resolve(options.workspace ?? deps.cwd?.() ?? process.cwd());
  const host = options.host ?? "127.0.0.1";
  // 监听非本机地址时默认启用访问令牌；本机默认不启用，与发行包 runner 的既有策略一致。
  const protect = options.tokenEnabled ?? !isLocalHost(host);
  const token = protect ? (options.token ?? createToken()) : "";

  let port: number;
  try {
    port = options.port && options.port > 0 ? options.port : await pickPort(host);
  } catch (error) {
    ctx.stderr.write(`无法分配端口：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const child = spawn(process.execPath, [runtime.serverEntry], {
    cwd: workspace,
    env: {
      ...process.env,
      PORT: String(port),
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([runtime.agentEntry, "app-server", "--stdio"]),
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_SERVER_HOST: host,
      ZCODE_SERVER_WORKSPACE: workspace,
      ZCODE_WEB_STATIC_ROOT: runtime.staticRoot,
      // 显式关闭令牌时必须清空继承值，否则旧的 ZCODE_SERVER_AUTH_TOKEN 仍会开启后端鉴权。
      ZCODE_SERVER_AUTH_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const localUrl = formatUrl(host, port, token);
  const forward = (stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream): void => {
    stream?.pipe(target);
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  ctx.stderr.write("\nComeCode 网页对话已启动\n");
  ctx.stderr.write(`本地: ${localUrl}\n`);
  if (host === "0.0.0.0" || host === "::") {
    for (const url of networkUrls(port, token)) ctx.stderr.write(`网络: ${url}\n`);
  }
  ctx.stderr.write("按 Ctrl+C 停止。\n\n");

  if (options.open ?? isLocalHost(host)) {
    setTimeout(() => {
      void openUrlInBrowser(localUrl).then((result) => {
        if (!result.opened) ctx.stderr.write("无法自动打开浏览器，请复制上方链接。\n");
      });
    }, 500).unref();
  }

  return await waitForWebServer(child);
}

function waitForWebServer(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise<number>((resolveExit) => {
    let shuttingDown = false;
    let forceKill: NodeJS.Timeout | undefined;

    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_GRACE_MS);
      forceKill.unref();
    };

    const cleanup = (): void => {
      if (forceKill) clearTimeout(forceKill);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    child.once("error", () => {
      cleanup();
      resolveExit(1);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveExit(shuttingDown || signal ? 0 : (code ?? 0));
    });
  });
}
