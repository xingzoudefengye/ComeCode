import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { AiSdkModelExecution } from "../packages/adapters/src/model/model-execution.ts";
import { createGenerateTextOptions } from "../packages/adapters/src/model/runner-options.ts";
import { normalizeUsage } from "../packages/adapters/src/model/runner-normalization.ts";
import { buildProviderRequestMessages } from "../packages/core/src/runtime/helpers/provider-request-messages.ts";

const MAX_REQUESTS = 4;
const MAX_INPUT_BYTES = 32_000;
const MAX_OUTPUT_TOKENS = 128;
if (!process.argv.includes("--authorize-paid")) {
  throw new Error("Explicit --authorize-paid is required; this script sends up to four paid requests.");
}
const config = JSON.parse(await readFile(join(homedir(), ".comecode", "config.json"), "utf8"));
const provider = config.providers.find((item) => item.id === config.provider);
const configuredModel = provider?.models.find((item) => (typeof item === "string" ? item : item.id) === config.model);
if (!provider || !configuredModel) throw new Error("Configured default model is missing.");
const model = typeof configuredModel === "string" ? { id: configuredModel } : configuredModel;
const apiType = model.type ?? provider.type;
const protocol = { "openai-chat": "openai-chat-completions", "openai-responses": "openai-responses", anthropic: "anthropic-messages" }[apiType];
if (!protocol) throw new Error("Unsupported protocol; no requests sent.");
const endpoint = model.baseUrl ?? provider.baseUrl;
const apiKey = model.apiKey ?? provider.apiKey;
if (!apiKey) throw new Error("Explicit config credential is missing; no requests sent.");
const origin = new URL(endpoint).origin;
let sent = 0;
let previousConversation;
let prefixStable = true;
const execution = new AiSdkModelExecution({ env: {} }, {
  transport: async (url, init) => {
    if (sent >= MAX_REQUESTS || new URL(String(url)).origin !== origin) throw new Error("Request budget or destination guard failed.");
    const body = JSON.parse(init.body);
    const field = protocol === "openai-responses" ? "max_output_tokens" : "max_tokens";
    body[field] = MAX_OUTPUT_TOKENS;
    const conversation = body.input ?? body.messages;
    const input = JSON.stringify({ system: body.system, messages: conversation, tools: body.tools });
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES || /[^\x00-\x7f]/u.test(input)) {
      throw new Error("ASCII input byte budget exceeded; request not sent.");
    }
    const withoutMarkers = (value) => {
      if (Array.isArray(value)) return value.map(withoutMarkers);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== "cache_control").map(([key, child]) => [key, withoutMarkers(child)]));
      return value;
    };
    const projected = withoutMarkers(conversation);
    if (previousConversation && JSON.stringify(projected.slice(0, previousConversation.length)) !== JSON.stringify(previousConversation)) prefixStable = false;
    previousConversation = projected;
    sent += 1;
    return fetch(url, { ...init, body: JSON.stringify(body), redirect: "error" });
  },
});
const { resolved: base } = execution.bindModel({
  providerId: provider.id,
  modelId: model.id,
  providerConfig: { api: { type: protocol, baseUrl: endpoint }, access: { type: "api-key", apiKey } },
  supportsJsonSchemaOutput: false,
  optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
});
const resolved = { ...base, properties: {} };
const entries = [
  { message: { role: "system", content: "You are validating a fictional project ledger. Reply only OK. Do not call tools.", cacheControl: { type: "ephemeral" } } },
  { message: { role: "user", content: Array.from({ length: 300 }, (_, index) => `Record ${index}: module fixture_${index}, owner team_${index % 13}, status verified, dependency fixture_${Math.max(0, index - 1)}.\n`).join("") } },
];
const measurements = [];
for (let index = 0; index < MAX_REQUESTS; index += 1) {
  if (index > 0) entries.push({ message: { role: "user", content: `Validate increment ${index}. Reply only OK.` } });
  try {
    const result = await generateText({
      ...createGenerateTextOptions({
        includeModelIO: false,
        request: { messages: buildProviderRequestMessages({ entries, applyCacheControl: true }).messages },
        resolved,
        statusContext: { sessionId: "cache-acceptance-bounded" },
      }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(90_000),
    });
    const usage = normalizeUsage(result.usage);
    const ratio = Number.isFinite(usage.inputTokens) && usage.inputTokens > 0 && Number.isFinite(usage.cacheReadTokens)
      ? usage.cacheReadTokens / usage.inputTokens : null;
    measurements.push({ request: index + 1, phase: index === 0 ? "cold" : "warm", inputTokens: usage.inputTokens ?? null,
      cacheReadTokens: usage.cacheReadTokens ?? null, cacheWriteTokens: usage.cacheWriteTokens ?? null,
      outputTokens: usage.outputTokens ?? null, hitRate: ratio });
    entries.push({ message: { role: "assistant", content: result.text || "" } });
  } catch (error) {
    measurements.push({ request: index + 1, error: error.name, statusCode: error.statusCode ?? null });
    break;
  }
}
const warm = measurements.filter((item) => item.phase === "warm");
const known = measurements.filter((item) => Number.isFinite(item.inputTokens) && Number.isFinite(item.cacheReadTokens));
const rate = (rows) => rows.length && rows.every((row) => Number.isFinite(row.inputTokens) && Number.isFinite(row.cacheReadTokens))
  ? rows.reduce((sum, row) => sum + row.cacheReadTokens, 0) / rows.reduce((sum, row) => sum + row.inputTokens, 0) : null;
console.log(JSON.stringify({ provider: provider.id, model: model.id, protocol, sent, limits: { requests: MAX_REQUESTS, inputBytes: MAX_INPUT_BYTES, outputTokens: MAX_OUTPUT_TOKENS },
  prefixStable, measurements, warmWeightedHitRate: rate(warm), cumulativeHitRate: known.length === measurements.length ? rate(known) : null,
  warmSampleMeets95: warm.length === MAX_REQUESTS - 1 && warm.every((row) => row.hitRate >= 0.95),
  cost: "unknown", scope: "fixed fictional ledger via ComeCode factory/options; not a full runtime or all-model guarantee" }, null, 2));
