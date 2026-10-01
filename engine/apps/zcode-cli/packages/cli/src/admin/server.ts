import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createProviderConfigEditor, ConfigEditError, resolveUnifiedConfig, type UnifiedConfigLoadOptions } from "@zcode/adapters/config";
import { ADMIN_HTML, ADMIN_SCRIPT, ADMIN_STYLE } from "./assets.js";
import { testProviderConnection } from "./test-connection.js";
const BODY_LIMIT = 256 * 1024;
export interface AdminServerOptions extends UnifiedConfigLoadOptions { readonly port?: number; }

/** HTTP 只做本地安全边界与命令转发，配置事实仍归 adapters 的统一解析器。 */
export async function startAdminServer(options: AdminServerOptions = {}) {
  const editor = createProviderConfigEditor(options);
  const token = randomBytes(32).toString("hex");
  let origin = "";
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(request.url ?? "/", origin);
      if (request.headers.host !== new URL(origin).host || (request.headers.origin !== undefined && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") throw new ConfigEditError(403, "只允许本机同源访问");
      if (url.pathname.startsWith("/api/")) {
        const incoming = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${token}`);
        if (incoming.length !== expected.length || !timingSafeEqual(incoming, expected)) throw new ConfigEditError(401, "管理页面授权已失效，请从终端重新打开链接");
        if (request.method === "GET" && url.pathname === "/api/config") return json(response, 200, await editor.read());
        if (request.method === "PUT" && url.pathname === "/api/config") return json(response, 200, await editor.save(await readBody(request)));
        if (request.method === "POST" && url.pathname === "/api/test") return json(response, 200, await testProviderConnection(await readBody(request), await resolveUnifiedConfig(options)));
        throw new ConfigEditError(404, "接口不存在");
      }
      if (request.method !== "GET") throw new ConfigEditError(405, "不支持此请求方法");
      const asset = url.pathname === "/" ? ["text/html", ADMIN_HTML] : url.pathname === "/app.js" ? ["text/javascript", ADMIN_SCRIPT] : url.pathname === "/style.css" ? ["text/css", ADMIN_STYLE] : undefined;
      if (!asset) throw new ConfigEditError(404, "页面不存在");
      response.writeHead(200, { "Content-Type": `${asset[0]}; charset=utf-8` }); response.end(asset[1]);
    } catch (error) {
      json(response, error instanceof ConfigEditError ? error.status : 500, { error: error instanceof ConfigEditError ? error.message : "操作失败，请检查文件权限或重试" });
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("后台监听地址无效");
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { origin, url: `${origin}/#token=${token}`, close: () => closing ??= new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new ConfigEditError(415, "请使用 JSON 请求");
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); throw new ConfigEditError(413, "配置过大"); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > BODY_LIMIT) throw new ConfigEditError(413, "配置过大"); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ConfigEditError(400, "JSON 请求格式不正确"); }
}
