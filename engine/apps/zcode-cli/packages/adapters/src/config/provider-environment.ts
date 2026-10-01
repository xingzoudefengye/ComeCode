import type { UnifiedConfigDocument, UnifiedProviderDefinition } from "./provider-config.js";

export const DEFAULT_ENVIRONMENT_MODELS: Readonly<Record<string, string>> = {
  "openai-chat": "gpt-4.1-mini",
  "openai-responses": "gpt-4.1-mini",
  anthropic: "claude-sonnet-4-5",
  gemini: "gemini-2.5-flash",
};

type Environment = Readonly<Record<string, string | undefined>>;

/** 环境探测顺序只在没有 TOML 时生效，显式 Provider 选择始终优先。 */
export function standardEnvironmentDocument(env: Environment, zeroConfig: boolean): UnifiedConfigDocument {
  const providers: Record<string, UnifiedProviderDefinition> = {};
  const credentialProviders: string[] = [];
  if (env.OPENAI_API_KEY?.trim() || env.OPENAI_BASE_URL?.trim()) {
    providers.openai = {
      type: "openai-chat",
      ...(env.OPENAI_BASE_URL?.trim() ? { baseUrl: env.OPENAI_BASE_URL.trim() } : {}),
      ...(env.OPENAI_API_KEY?.trim() ? { apiKeyEnv: "OPENAI_API_KEY" } : {}),
    };
    if (env.OPENAI_API_KEY?.trim()) credentialProviders.push("openai");
  }
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (anthropicKey || env.ANTHROPIC_BASE_URL?.trim()) {
    providers.anthropic = {
      type: "anthropic",
      ...(env.ANTHROPIC_BASE_URL?.trim() ? { baseUrl: env.ANTHROPIC_BASE_URL.trim() } : {}),
      ...(anthropicKey ? { apiKeyEnv: env.ANTHROPIC_API_KEY?.trim() ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN" } : {}),
    };
    if (anthropicKey) credentialProviders.push("anthropic");
  }
  if (env.GEMINI_API_KEY?.trim()) {
    providers.gemini = { type: "gemini", apiKeyEnv: "GEMINI_API_KEY" };
    credentialProviders.push("gemini");
  }
  if (zeroConfig) {
    for (const id of credentialProviders) {
      const definition = providers[id]!;
      providers[id] = { ...definition, models: [DEFAULT_ENVIRONMENT_MODELS[definition.type!]!] };
    }
  }
  const provider = env.COMECODE_PROVIDER?.trim() || (zeroConfig ? credentialProviders[0] : undefined);
  const model = env.COMECODE_MODEL?.trim() || env.MODEL?.trim();
  return { providers, ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

export function hasStandardEnvironment(env: Environment): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim() || env.OPENAI_BASE_URL?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_BASE_URL?.trim() ||
    env.GEMINI_API_KEY?.trim() || env.COMECODE_PROVIDER?.trim() || env.COMECODE_MODEL?.trim() || env.MODEL?.trim());
}
