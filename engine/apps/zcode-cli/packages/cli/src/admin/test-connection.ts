import { z } from "zod";
import { ConfigEditError, type ResolvedUnifiedConfig } from "@zcode/adapters/config";
const inputSchema = z.object({ provider: z.string().min(1), model: z.string().min(1), confirm: z.literal(true) }).strict();

/** 只测试已保存的有效连接；不给网页任意 URL 代理能力，不回传服务商响应正文。 */
export async function testProviderConnection(input: unknown, config: ResolvedUnifiedConfig, request: typeof fetch = fetch, timeoutMs = 15000) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ConfigEditError(400, "测试连接需明确确认，并选择已保存模型");
  const model = config.providers.find((provider) => provider.id === parsed.data.provider)?.modelConfigs.find((candidate) => candidate.id === parsed.data.model);
  if (!model?.executable || !model.baseUrl || !model.apiKey || !model.apiType) throw new ConfigEditError(422, "所选模型不可执行，请先保存有效配置");
  const base = model.baseUrl.replace(/\/+$/u, "");
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
    await response.body?.cancel();
    return { ok: response.ok, status: response.status, message: response.ok ? "连接成功，服务商接受了测试请求" : `连接失败（HTTP ${response.status}），请检查地址、模型和密钥` };
  } catch { return { ok: false, message: "连接失败或超时，请检查接口地址、网络和凭据" }; }
}
