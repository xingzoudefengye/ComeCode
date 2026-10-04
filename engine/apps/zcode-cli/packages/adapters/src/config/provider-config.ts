import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parse, resolve, dirname, join } from "node:path";
import { resolveComeCodeDataRoot } from "./comecode-env.js";
import { parseUnifiedConfigToml } from "./provider-config-toml.js";
import { parseUnifiedConfigJson } from "./provider-config-json.js";
export { materializeUnifiedConfig } from "./provider-config-materialize.js";
export { parseUnifiedConfigToml } from "./provider-config-toml.js";
export { parseUnifiedConfigJson } from "./provider-config-json.js";
import { DEFAULT_ENVIRONMENT_MODELS, hasStandardEnvironment, standardEnvironmentDocument } from "./provider-environment.js";

export type UnifiedProviderType = "openai-chat" | "openai-responses" | "anthropic" | "gemini";
export type UnifiedProviderApiType =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface UnifiedModelDefinition {
  readonly id: string;
  readonly name?: string;
  readonly type?: UnifiedProviderType;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly toolCalling?: boolean;
  readonly vision?: boolean;
  /** 该模型默认的思考强度档位（如 low / high / max）。 */
  readonly reasoningLevel?: string;
  /** false 表示保留配置但不参与默认选择和 Registry 候选。 */
  readonly enabled?: boolean;
}

export interface UnifiedProviderDefinition extends Omit<UnifiedModelDefinition, "id" | "enabled"> {
  readonly models?: readonly (string | UnifiedModelDefinition)[];
}

export interface UnifiedConfigDocument {
  readonly model?: string;
  readonly provider?: string;
  readonly providers: Readonly<Record<string, UnifiedProviderDefinition>>;
  /** JSON 显式供应商列表是成员集合，删除后不从派生旧 JSON 复活。 */
  readonly ownsProviderMembership?: boolean;
}

export interface UnifiedConfigPaths {
  readonly user: string;
  readonly userCandidates: readonly string[];
  readonly project?: string;
  readonly projectCandidates: readonly string[];
  readonly legacyProviderFile: string;
}

export interface UnifiedConfigDiagnostics {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ResolvedUnifiedModel extends UnifiedModelDefinition {
  readonly enabled: boolean;
  readonly apiType?: UnifiedProviderApiType;
  readonly apiKeySource?: string;
  readonly executable: boolean;
}

export interface ResolvedUnifiedProvider {
  readonly id: string;
  readonly name?: string;
  readonly modelConfigs: readonly ResolvedUnifiedModel[];
  readonly type?: UnifiedProviderType;
  readonly apiType?: UnifiedProviderApiType;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeySource?: string;
  readonly models: readonly string[];
  readonly executable: boolean;
}

export interface ResolvedUnifiedConfig {
  readonly paths: UnifiedConfigPaths;
  readonly model?: string;
  readonly provider?: string;
  readonly providers: readonly ResolvedUnifiedProvider[];
  readonly diagnostics: UnifiedConfigDiagnostics;
  readonly hasSource: boolean;
  readonly managedProviderIds: readonly string[];
  readonly legacyDefault?: { readonly providerId: string; readonly modelId: string };
}

export interface UnifiedConfigLoadOptions {
  readonly includeProject?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dataRoot?: string;
  readonly legacyProviderFile?: string;
  /** 编辑预览复用有效配置规则，不创建临时用户文件。 */
  readonly userDocument?: UnifiedConfigDocument;
  readonly cliOverrides?: { readonly model?: string; readonly provider?: string };
}

export interface MaterializeUnifiedConfigOptions extends UnifiedConfigLoadOptions {
  readonly targetProviderFile: string;
}

export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_FILE_NAMES = [CONFIG_FILE_NAME, "config.jsonc", "config.toml"] as const;

const TYPE_TO_API: Readonly<Record<UnifiedProviderType, UnifiedProviderApiType | undefined>> = {
  "openai-chat": "openai-chat-completions",
  "openai-responses": "openai-responses",
  anthropic: "anthropic-messages",
  gemini: undefined,
};

const DEFAULT_BASE_URL: Readonly<Record<UnifiedProviderType, string>> = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

export function resolveUnifiedConfigPaths(options: {
  readonly includeProject?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dataRoot?: string;
  readonly legacyProviderFile?: string;
} = {}): UnifiedConfigPaths {
  const env = options.env ?? process.env;
  const userRoot = options.dataRoot ?? resolveComeCodeDataRoot(env);
  let current = resolve(options.cwd ?? process.cwd());
  const root = parse(current).root;
  const projectCandidates: string[] = [];
  while (true) {
    projectCandidates.push(...CONFIG_FILE_NAMES.map((name) => join(current, ".comecode", name)));
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const userCandidates = CONFIG_FILE_NAMES.map((name) => join(userRoot, name));
  const project = options.includeProject === false ? undefined : projectCandidates.find((candidate) => existsSync(candidate));
  return Object.freeze({
    user: userCandidates.find((candidate) => existsSync(candidate)) ?? join(userRoot, CONFIG_FILE_NAME),
    userCandidates: Object.freeze(userCandidates),
    ...(project ? { project } : {}),
    projectCandidates: Object.freeze(projectCandidates),
    legacyProviderFile: options.legacyProviderFile ?? join(userRoot, "v2", "provider_config.json"),
  });
}

export async function resolveUnifiedConfig(options: UnifiedConfigLoadOptions = {}): Promise<ResolvedUnifiedConfig> {
  const env = options.env ?? process.env;
  const paths = resolveUnifiedConfigPaths(options);
  const diagnostics = { errors: [] as string[], warnings: [] as string[] };
  const legacy = await readLegacyProviderFile(paths.legacyProviderFile, diagnostics);
  let document: UnifiedConfigDocument = { providers: {} };
  let hasFileSource = false;
  for (const filePath of [paths.user, paths.project].filter((path): path is string => Boolean(path))) {
    if (filePath === paths.user && options.userDocument) {
      document = mergeDocuments(document, options.userDocument);
      hasFileSource ||= Boolean(document.model || document.provider || Object.keys(document.providers).length || document.ownsProviderMembership);
      continue;
    }
    if (!existsSync(filePath)) continue;
    const candidates = filePath === paths.user ? paths.userCandidates : paths.projectCandidates.filter((candidate) => dirname(candidate) === dirname(filePath));
    const ignored = candidates.filter((candidate) => candidate !== filePath && existsSync(candidate));
    if (ignored.length) diagnostics.warnings.push(`使用 ${filePath}；忽略同目录配置：${ignored.join("、")}`);
    const fileDocument = await readUnifiedFile(filePath, diagnostics);
    // 全注释的新手模板不阻断标准环境变量的零配置选择。
    hasFileSource ||= fileDocument.model !== undefined || fileDocument.provider !== undefined ||
      Object.keys(fileDocument.providers).length > 0 || fileDocument.ownsProviderMembership === true || diagnostics.errors.length > 0;
    document = mergeDocuments(document, fileDocument);
  }
  document = mergeDocuments(document, standardEnvironmentDocument(env, !hasFileSource));
  document = mergeDocuments(document, {
    providers: {},
    ...(options.cliOverrides?.model?.trim() ? { model: options.cliOverrides.model.trim() } : {}),
    ...(options.cliOverrides?.provider?.trim() ? { provider: options.cliOverrides.provider.trim() } : {}),
  });
  const hasSource = hasFileSource || hasStandardEnvironment(env) || Boolean(options.cliOverrides?.model?.trim() || options.cliOverrides?.provider?.trim());
  const selectedProvider = document.provider ?? inferProviderId(document) ?? (document.ownsProviderMembership ? undefined : legacy.defaultModelSelection?.providerId);
  // 环境探测选中的 Provider 使用自己的默认模型，不能继承旧 JSON 中另一家的模型。
  const environmentModel = !hasFileSource && selectedProvider
    ? DEFAULT_ENVIRONMENT_MODELS[document.providers[selectedProvider]?.type ?? ""]
    : undefined;
  const firstModel = selectedProvider ? document.providers[selectedProvider]?.models?.[0] : undefined;
  const selectedModel = document.model ?? environmentModel ?? (typeof firstModel === "string" ? firstModel : firstModel?.id) ?? legacy.defaultModelSelection?.modelId;
  let previouslyManaged: string[] = [];
  try { const ids: unknown = JSON.parse(await readFile(`${paths.legacyProviderFile}.comecode-managed.json`, "utf8")); if (Array.isArray(ids)) previouslyManaged = ids.filter((id): id is string => typeof id === "string"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.errors.push("统一配置托管记录无法读取，请检查配置文件"); }
  const retiredIds = document.ownsProviderMembership ? previouslyManaged.filter((id) => !(id in document.providers)) : [];
  const entries = new Map<string, UnifiedProviderDefinition>(Object.entries(legacy.providers).filter(([id]) => !retiredIds.includes(id)));
  for (const [id, definition] of Object.entries(document.providers)) {
    const legacyDefinition = entries.get(id);
    // materialize 的旧模型连接是派生值，不能反压本次用户修改的供应商地址/凭据。
    const inherited = legacyDefinition ? { ...legacyDefinition, models: legacyDefinition.models?.map((model) => typeof model === "string" ? model : model.id) } : undefined;
    entries.set(id, mergeProviderDefinition(inherited, definition));
  }
  if (selectedProvider && !entries.has(selectedProvider)) diagnostics.errors.push(`Provider 不存在: ${selectedProvider}`);
  const providers = [...entries.entries()].map(([id, definition]) => resolveProvider(id, definition, selectedProvider, selectedModel, env, diagnostics));
  let activeProvider = selectedProvider;
  let activeModel = selectedModel;
  const selected = providers.find((provider) => provider.id === selectedProvider)?.modelConfigs.find((model) => model.id === selectedModel);
  const explicitModel = options.cliOverrides?.model?.trim() || env.COMECODE_MODEL?.trim() || env.MODEL?.trim();
  // 只替换停用的默认项；显式选择需报错，Gemini/缺失凭据仍沿用原检查语义。
  if (selected?.enabled === false && !explicitModel) {
    const fallback = providers.find((provider) => provider.id === selectedProvider)?.modelConfigs.find((model) => model.executable);
    const other = fallback ? undefined : providers.find((provider) => provider.executable);
    activeProvider = fallback ? selectedProvider : other?.id;
    activeModel = fallback?.id ?? other?.modelConfigs.find((model) => model.executable)?.id;
  }
  const managedProviderIds = Object.freeze([...Object.keys(document.providers), ...retiredIds, ...(hasSource && selectedProvider ? [selectedProvider] : [])]);
  return Object.freeze({
    paths,
    ...(activeModel ? { model: activeModel } : {}),
    ...(activeProvider ? { provider: activeProvider } : {}),
    providers: Object.freeze(providers),
    managedProviderIds,
    diagnostics: Object.freeze({ errors: Object.freeze(diagnostics.errors), warnings: Object.freeze(diagnostics.warnings) }),
    hasSource,
    ...(legacy.defaultModelSelection ? { legacyDefault: legacy.defaultModelSelection } : {}),
  });
}

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.length <= 8 ? "***" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function toPublicUnifiedConfig(config: ResolvedUnifiedConfig) {
  return {
    paths: config.paths,
    model: config.model,
    provider: config.provider,
    hasSource: config.hasSource,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      type: provider.type,
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      apiKey: maskSecret(provider.apiKey),
      apiKeySource: provider.apiKeySource,
      models: provider.modelConfigs.map((model) => ({ ...model, apiKey: maskSecret(model.apiKey) })),
      executable: provider.executable,
    })),
    diagnostics: config.diagnostics,
  };
}

export function extractCliWorkingDirectory(argv: readonly string[], fallback = process.cwd()): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--cwd=")) return resolve(arg.slice("--cwd=".length));
    if (arg === "--cwd" && argv[index + 1]) return resolve(argv[index + 1]!);
  }
  return resolve(fallback);
}

export function extractProviderCliOverrides(argv: readonly string[]): { model?: string; provider?: string } {
  const result: { model?: string; provider?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    for (const key of ["model", "provider"] as const) {
      if (arg.startsWith(`--${key}=`)) result[key] = arg.slice(key.length + 3);
      else if (arg === `--${key}` && argv[index + 1] !== undefined) result[key] = argv[++index];
    }
  }
  return result;
}

async function readUnifiedFile(filePath: string, diagnostics: { errors: string[]; warnings: string[] }): Promise<UnifiedConfigDocument> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = filePath.endsWith(".toml") ? parseUnifiedConfigToml(text, filePath) : parseUnifiedConfigJson(text, filePath);
    diagnostics.errors.push(...parsed.diagnostics.errors);
    diagnostics.warnings.push(...parsed.diagnostics.warnings);
    return parsed.document;
  } catch (error) {
    diagnostics.errors.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return { providers: {} };
  }
}

async function readLegacyProviderFile(filePath: string, diagnostics: { errors: string[]; warnings: string[] }) {
  const empty = { providers: {} as Record<string, UnifiedProviderDefinition>, defaultModelSelection: undefined as { providerId: string; modelId: string } | undefined };
  if (!existsSync(filePath)) return empty;
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.config)) return empty;
    const rules = isRecord(parsed.config.providerConfigRules) && Array.isArray(parsed.config.providerConfigRules.providerRules) ? parsed.config.providerConfigRules.providerRules : [];
    for (const rule of rules) {
      if (!isRecord(rule) || typeof rule.providerId !== "string" || !isRecord(rule.config)) continue;
      const api = isRecord(rule.config.api) ? rule.config.api : {};
      const access = isRecord(rule.config.access) ? rule.config.access : {};
      const apiType = typeof api.type === "string" ? api.type : undefined;
      const type = apiType === "anthropic-messages" ? "anthropic" : apiType === "openai-responses" ? "openai-responses" : apiType === "openai-chat-completions" ? "openai-chat" : undefined;
      empty.providers[rule.providerId] = {
        ...(type ? { type } : {}),
        ...(typeof api.baseUrl === "string" ? { baseUrl: api.baseUrl } : {}),
        ...(typeof access.apiKey === "string" ? { apiKey: access.apiKey } : {}),
        ...(Array.isArray(rule.config.personalModelIds) ? { models: rule.config.personalModelIds.filter((value): value is string => typeof value === "string").map((id) => {
          const override = rule.config.modelOverrides?.[id];
          if (!isRecord(override)) return id;
          const modelApi = isRecord(override.api) ? override.api : {};
          const modelType = modelApi.type === "anthropic-messages" ? "anthropic" : modelApi.type === "openai-responses" ? "openai-responses" : modelApi.type === "openai-chat-completions" ? "openai-chat" : undefined;
          return { id, ...(typeof override.name === "string" ? { name: override.name } : {}), ...(modelType ? { type: modelType as UnifiedProviderType } : {}), ...(typeof modelApi.baseUrl === "string" ? { baseUrl: modelApi.baseUrl } : {}), ...(typeof override.access?.apiKey === "string" ? { apiKey: override.access.apiKey } : {}) };
        }) } : {}),
      };
    }
    const selection = parsed.config.defaultModelSelection;
    if (isRecord(selection) && typeof selection.providerId === "string" && typeof selection.modelId === "string") empty.defaultModelSelection = { providerId: selection.providerId, modelId: selection.modelId };
    return empty;
  } catch {
    diagnostics.warnings.push(`${filePath}: 现有 provider_config.json 无法读取，将按空配置继续`);
    return empty;
  }
}

function mergeProviderDefinition(
  current: UnifiedProviderDefinition | undefined,
  next: UnifiedProviderDefinition,
): UnifiedProviderDefinition {
  const merged = { ...current, ...next };
  // 项目模型成员显式声明，已有同名模型仅继承未覆盖字段。
  if (next.models) merged.models = next.models.map((model) => {
    const id = typeof model === "string" ? model : model.id;
    const previous = current?.models?.find((item) => (typeof item === "string" ? item : item.id) === id);
    return typeof model === "string" ? (previous ?? model) : mergeProviderDefinition(typeof previous === "object" ? previous : undefined, model) as UnifiedModelDefinition;
  });
  // api_key 与 api_key_env 是互斥来源；高优先级声明其一时清除另一项。
  if (next.apiKeyEnv !== undefined) delete merged.apiKey;
  if (next.apiKey !== undefined) delete merged.apiKeyEnv;
  return merged;
}

function mergeDocuments(base: UnifiedConfigDocument, next: UnifiedConfigDocument): UnifiedConfigDocument {
  const providers: Record<string, UnifiedProviderDefinition> = { ...base.providers };
  for (const [id, definition] of Object.entries(next.providers)) {
    providers[id] = mergeProviderDefinition(providers[id], definition);
  }
  return {
    providers,
    ownsProviderMembership: next.ownsProviderMembership ?? base.ownsProviderMembership,
    ...(next.model !== undefined
      ? { model: next.model }
      : base.model !== undefined
        ? { model: base.model }
        : {}),
    ...(next.provider !== undefined
      ? { provider: next.provider }
      : base.provider !== undefined
        ? { provider: base.provider }
        : {}),
  };
}

function resolveProvider(id: string, definition: UnifiedProviderDefinition, selectedProvider: string | undefined, selectedModel: string | undefined, env: Readonly<Record<string, string | undefined>>, diagnostics: { errors: string[]; warnings: string[] }): ResolvedUnifiedProvider {
  const definitions = [...(definition.models ?? [])];
  if (id === selectedProvider && selectedModel && !definitions.some((model) => (typeof model === "string" ? model : model.id) === selectedModel)) definitions.push(selectedModel);
  const resolveConnection = (input: UnifiedProviderDefinition, label: string, enabled = true) => {
    const previousErrorCount = diagnostics.errors.length;
    const type = input.type;
    const apiType = type ? TYPE_TO_API[type] : undefined;
    const apiKey = input.apiKey?.trim() || (input.apiKeyEnv ? env[input.apiKeyEnv]?.trim() : undefined);
    const baseUrl = input.baseUrl?.trim() || (type ? DEFAULT_BASE_URL[type] : undefined);
    // 停用模型可以保留尚未就绪的凭据，不阻断其他启用模型的启动与保存。
    if (enabled) {
      if (!type || !(type in TYPE_TO_API)) diagnostics.errors.push(`${label}: 缺少或未知 type`);
      if (!baseUrl) diagnostics.errors.push(`${label}: 缺少 base_url / baseUrl`);
      else { try { const url = new URL(baseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(); } catch { diagnostics.errors.push(`${label}: base_url 不是有效 URL / baseUrl 必须是 HTTP URL（禁止内嵌凭据）`); } }
      if (!apiKey) diagnostics.errors.push(`${label}: 缺少 api_key / apiKey 或 api_key_env / apiKeyEnv 对应的环境变量`);
      if (type === "gemini") diagnostics.warnings.push(`${label}: Gemini 仅支持识别和检查，当前版本暂不执行`);
    }
    return { type, apiType, baseUrl, apiKey, apiKeySource: input.apiKey ? "config.api_key" : input.apiKeyEnv ? `env:${input.apiKeyEnv}` : undefined, executable: Boolean(apiType && baseUrl && apiKey && diagnostics.errors.length === previousErrorCount) };
  };
  const modelConfigs = definitions.map((item): ResolvedUnifiedModel => {
    const model = typeof item === "string" ? { id: item } : item;
    const effective = mergeProviderDefinition(definition, model);
    const enabled = model.enabled !== false;
    const connection = resolveConnection(effective, `Provider ${id} 模型 ${model.id}`, enabled);
    return Object.freeze({ id: model.id, name: model.name, enabled, contextWindow: effective.contextWindow, maxOutputTokens: effective.maxOutputTokens, toolCalling: effective.toolCalling, vision: effective.vision, reasoningLevel: effective.reasoningLevel, ...connection, executable: enabled && connection.executable });
  });
  const connection = modelConfigs.length ? { type: definition.type, apiType: definition.type ? TYPE_TO_API[definition.type] : undefined, baseUrl: definition.baseUrl ?? (definition.type ? DEFAULT_BASE_URL[definition.type] : undefined), apiKey: definition.apiKey || (definition.apiKeyEnv ? env[definition.apiKeyEnv]?.trim() : undefined), apiKeySource: definition.apiKey ? "config.api_key" : definition.apiKeyEnv ? `env:${definition.apiKeyEnv}` : undefined } : resolveConnection(definition, `Provider ${id}`);
  if (!modelConfigs.length) diagnostics.warnings.push(`Provider ${id}: 没有模型，需设置 model 或 models`);
  return Object.freeze({ id, name: definition.name, ...connection, models: Object.freeze(modelConfigs.map((model) => model.id)), modelConfigs: Object.freeze(modelConfigs), executable: modelConfigs.some((model) => model.executable) });
}

function inferProviderId(document: UnifiedConfigDocument): string | undefined {
  const ids = Object.keys(document.providers);
  return ids.length === 1 ? ids[0] : undefined;
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
