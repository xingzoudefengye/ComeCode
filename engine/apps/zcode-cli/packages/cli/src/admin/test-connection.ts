import { z } from "zod";
import { ConfigEditError, type ResolvedUnifiedConfig } from "@zcode/adapters/config";
const inputSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), confirm: z.literal(true) }).strict();

type ApiType = "anthropic-messages" | "openai-responses" | "openai-chat-completions";

/** 测试地址必须与真实 SDK 一致；Anthropic SDK 会为根地址补上 /v1。 */
function normalizeTestBaseUrl(baseUrl: string, apiType: ApiType): string {
  const base = baseUrl.replace(/\/+$/u, "");
  if (apiType !== "anthropic-messages") return base;
  try {
    const url = new URL(base);
    const pathname = url.pathname.replace(/\/+$/u, "");
    if (!pathname.toLowerCase().endsWith("/v1")) url.pathname = `${pathname}/v1`;
    return url.toString().replace(/\/$/u, "");
  } catch {
    return base.toLowerCase().endsWith("/v1") ? base : `${base}/v1`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function isValidProtocolResponse(apiType: ApiType, body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (apiType === "anthropic-messages") return body.type === "message" && Array.isArray(body.content);
  if (apiType === "openai-responses") return typeof body.id === "string" && (Array.isArray(body.output) || typeof body.output_text === "string");
  return Array.isArray(body.choices);
}

function protocolResponseFailure(apiType: ApiType): string {
  const protocol = apiType === "anthropic-messages" ? "Anthropic Messages" : apiType === "openai-responses" ? "Responses" : "Chat Completions（兼容）";
  return `连接失败：服务返回的不是有效的 ${protocol} 响应，请检查协议和接口地址（兼容接口通常需要填写 /v1）`;
}

/** 只测试统一解析后的有效连接；不给网页任意 URL 代理能力，不回传服务商响应正文。 */
export async function testProviderConnection(input: unknown, config: ResolvedUnifiedConfig, request: typeof fetch = fetch, timeoutMs = 15000) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ConfigEditError(400, "测试连接需明确确认，并选择已保存模型");
  const model = config.providers.find((provider) => provider.id === parsed.data.provider)?.modelConfigs.find((candidate) => candidate.id === parsed.data.model);
  if (!model?.executable || !model.baseUrl || !model.apiKey || !model.apiType) throw new ConfigEditError(422, "所选模型不可执行，请先保存有效配置");
  const base = normalizeTestBaseUrl(model.baseUrl, model.apiType);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let suffix: string; let body: unknown;
  if (model.apiType === "anthropic-messages") {
    suffix = "/messages"; headers["x-api-key"] = model.apiKey; headers["anthropic-version"] = "2023-06-01";
    body = { model: model.id, max_tokens: 16, messages: [{ role: "user", content: "Reply OK" }] };
  } else if (model.apiType === "openai-responses") {
    suffix = "/responses"; headers.Authorization = `Bearer ${model.apiKey}`;
    body = { model: model.id, max_output_tokens: 16, input: "Reply OK" };
  } else {
    suffix = "/chat/completions"; headers.Authorization = `Bearer ${model.apiKey}`;
    body = { model: model.id, max_completion_tokens: 16, messages: [{ role: "user", content: "Reply OK" }] };
  }
  try {
    const response = await request(`${base}${suffix}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    const responseText = await response.text();
    if (!response.ok) return { ok: false, status: response.status, message: `连接失败（HTTP ${response.status}），请检查协议、地址、模型和密钥` };
    if (!isValidProtocolResponse(model.apiType, parseJson(responseText))) return { ok: false, status: response.status, message: protocolResponseFailure(model.apiType) };
    return { ok: true, status: response.status, message: "连接成功，服务商已返回有效的模型响应" };
  } catch { return { ok: false, message: "连接失败或超时，请检查接口地址、网络和凭据" }; }
}
