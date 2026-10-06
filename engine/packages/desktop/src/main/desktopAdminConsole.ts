import { spawn, type ChildProcess } from "node:child_process";
import { app, BrowserWindow } from "electron";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/node";

const READY_LIMIT = 8192;
const START_TIMEOUT_MS = 15000;
let adminWindow: BrowserWindow | undefined;
let opening: Promise<void> | undefined;

export function validateAdminReadyUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("管理进程返回无效地址");
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search ||
      !/^#token=[a-f0-9]{64}$/.test(url.hash)) throw new Error("管理进程返回非受控地址");
  return url.href;
}

function waitForReady(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timeout);
      child.off("error", failed);
      child.off("exit", exited);
      child.stdout?.off("data", data);
      if (error) reject(error);
      else resolve(url!);
    };
    const failed = () => finish(new Error("无法启动本地管理进程"));
    const exited = () => finish(new Error("本地管理进程在就绪前退出，请重新构建 CLI"));
    const data = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > READY_LIMIT) return finish(new Error("管理进程就绪消息超出限制"));
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end));
        if (message.type !== "comecode-admin-ready") throw new Error("无效消息");
        finish(undefined, validateAdminReadyUrl(message.url));
      } catch { finish(new Error("管理进程返回无效就绪消息")); }
    };
    const timeout = setTimeout(() => finish(new Error("管理进程启动超时")), START_TIMEOUT_MS);
    child.once("error", failed);
    child.once("exit", exited);
    child.stdout?.on("data", data);
  });
}

/** Main 只持有管理窗口/进程；网页没有桌面 preload 或会话运行时权限。 */
export function openDesktopAdminConsole(): Promise<void> {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.show(); adminWindow.focus();
    return Promise.resolve();
  }
  return opening ??= (async () => {
    const home = app.getPath("home");
    const command = resolveDefaultZCodeAgentCommand({ workspacePath: home, workspaceKey: home });
    if (!command?.supportsStorageStartup) throw new Error("当前 CLI 不支持共享管理控制台，请使用 comecode admin");
    const args = command.args ?? [];
    const entryEnd = args.indexOf("app-server");
    if (entryEnd < 0) throw new Error("当前 CLI 启动命令不支持管理控制台");
    const child = spawn(command.command, [...args.slice(0, entryEnd), "admin", "desktop-stdio", "--no-browser"], {
      cwd: app.getPath("home"), env: { ...process.env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    // 不记录子进程输出：其中可能出现凭据或授权链接。
    child.stderr?.resume();
    const stop = () => { child.stdin?.end(); if (child.exitCode === null) child.kill(); };
    app.once("before-quit", stop);
    try {
      const url = await waitForReady(child);
      const origin = new URL(url).origin;
      const win = new BrowserWindow({ width: 1180, height: 800, title: "ComeCode 管理控制台", show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      });
      adminWindow = win;
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const guard = (event: { preventDefault(): void }, target: string) => {
        try { if (new URL(target).origin === origin) return; } catch { /* 无效地址同样拒绝。 */ }
        event.preventDefault();
      };
      win.webContents.on("will-navigate", guard);
      win.webContents.on("will-redirect", guard);
      win.webContents.on("will-attach-webview", (event) => event.preventDefault());
      win.once("closed", () => { adminWindow = undefined; app.off("before-quit", stop); stop(); });
      child.once("exit", () => { if (!win.isDestroyed()) win.close(); });
      await win.loadURL(url);
      if (!win.isDestroyed()) win.show();
    } catch (error) {
      if (adminWindow && !adminWindow.isDestroyed()) adminWindow.close();
      app.off("before-quit", stop); stop(); throw error;
    }
  })().finally(() => { opening = undefined; });
}
