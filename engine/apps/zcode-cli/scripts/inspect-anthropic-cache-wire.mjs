import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { AiSdkModelExecution } from "../packages/adapters/src/model/model-execution.ts";
import { createGenerateTextOptions } from "../packages/adapters/src/model/runner-options.ts";
import { buildProviderRequestMessages } from "../packages/core/src/runtime/helpers/provider-request-messages.ts";

const config = JSON.parse(await readFile(join(homedir(), ".comecode", "config.json"), "utf8"));
const provider = config.providers.find((item) => item.id === config.provider);
const configuredModel = provider?.models.find((item) => (typeof item === "string" ? item : item.id) === config.model);
if (!provider || !configuredModel) throw new Error("Configured default model is missing.");
const model = typeof configuredModel === "string" ? { id: configuredModel } : configuredModel;
const apiType = model.type ?? provider.type;
const protocol = { "openai-chat": "openai-chat-completions", "openai-responses": "openai-responses", anthropic: "anthropic-messages" }[apiType];
const endpoint = model.baseUrl ?? provider.baseUrl;
const apiKey = model.apiKey ?? provider.apiKey;
if (!protocol || !endpoint || !apiKey) throw new Error("Active model is not configured for a supported protocol.");
let requestBody;
let requestHeaders;
const execution = new AiSdkModelExecution({ env: {} }, {
  transport: async (url, init) => {
    requestBody = JSON.parse(init.body);
    requestHeaders = Object.fromEntries(new Headers(init.headers).entries());
    throw new Error("WIRE_ONLY");
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
try {
  await generateText({
    ...createGenerateTextOptions({
      includeModelIO: false,
      request: { messages: buildProviderRequestMessages({ entries, applyCacheControl: true }).messages },
      resolved,
      statusContext: { sessionId: "cache-wire-inspect" },
    }),
    maxOutputTokens: 128,
    abortSignal: AbortSignal.timeout(5_000),
  });
} catch (error) {
  if (error.message !== "WIRE_ONLY") throw error;
}
const stripSecrets = (value) => {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /key|authorization/i.test(key) ? "<redacted>" : stripSecrets(child)]));
  return value;
};
const count = (value) => Array.isArray(value) ? value.reduce((sum, child) => sum + count(child), 0) : value && typeof value === "object" ? Object.entries(value).reduce((sum, [key, child]) => sum + (key === "cache_control" ? 1 : count(child)), 0) : 0;
console.log(JSON.stringify({ provider: provider.id, model: model.id, endpoint: new URL(endpoint).origin, headers: stripSecrets(requestHeaders), cacheControlBreakpoints: count(requestBody), body: stripSecrets(requestBody) }, null, 2));
