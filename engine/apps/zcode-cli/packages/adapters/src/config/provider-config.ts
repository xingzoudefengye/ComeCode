import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse, resolve, dirname, join } from "node:path";
import { resolveComeCodeDataRoot } from "./comecode-env.js";
import { DEFAULT_ENVIRONMENT_MODELS, hasStandardEnvironment, standardEnvironmentDocument } from "./provider-environment.js";

/* oxlint-disable eslint(max-lines) -- 统一配置的解析、合并和兼容 materialize 必须在同一边界维护。 */
export type UnifiedProviderType = "openai-chat" | "openai-responses" | "anthropic" | "gemini";
export type UnifiedProviderApiType =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

export interface UnifiedProviderDefinition {
  readonly type?: UnifiedProviderType;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly models?: readonly string[];
}

export interface UnifiedConfigDocument {
  readonly model?: string;
  readonly provider?: string;
  readonly providers: Readonly<Record<string, UnifiedProviderDefinition>>;
}

export interface UnifiedConfigPaths {
  readonly user: string;
  readonly project?: string;
  readonly projectCandidates: readonly string[];
  readonly legacyProviderFile: string;
}

export interface UnifiedConfigDiagnostics {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface ResolvedUnifiedProvider {
  readonly id: string;
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
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dataRoot?: string;
  readonly legacyProviderFile?: string;
  readonly cliOverrides?: { readonly model?: string; readonly provider?: string };
}

export interface MaterializeUnifiedConfigOptions extends UnifiedConfigLoadOptions {
  readonly targetProviderFile: string;
}

export const CONFIG_FILE_NAME = "config.toml";

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
    projectCandidates.push(join(current, ".comecode", CONFIG_FILE_NAME));
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const project = projectCandidates.find((candidate) => existsSync(candidate));
  return Object.freeze({
    user: join(userRoot, CONFIG_FILE_NAME),
    ...(project ? { project } : {}),
    projectCandidates: Object.freeze(projectCandidates),
    legacyProviderFile: options.legacyProviderFile ?? join(userRoot, "v2", "provider_config.json"),
  });
}

/** 仅解析 M2.1 所需的 TOML 子集，避免把复杂 TOML 依赖引入 CLI。 */
export function parseUnifiedConfigToml(text: string, filePath = CONFIG_FILE_NAME): {
  readonly document: UnifiedConfigDocument;
  readonly diagnostics: UnifiedConfigDiagnostics;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  let model: string | undefined;
  let provider: string | undefined;
  let section: string | undefined;
  const providers: Record<string, UnifiedProviderDefinition> = {};

  const assign = (key: string, value: unknown, line: number): void => {
    if (!section && key === "model") {
      if (typeof value !== "string") errors.push(`${filePath}:${line}: model 必须是字符串`);
      else model = value;
      return;
    }
    if (!section && key === "provider") {
      if (typeof value !== "string") errors.push(`${filePath}:${line}: provider 必须是字符串`);
      else provider = value;
      return;
    }
    if (!section) {
      warnings.push(`${filePath}:${line}: 忽略未知配置字段 ${key}`);
      return;
    }
    const current = providers[section] ?? {};
    if (!["type", "base_url", "api_key_env", "api_key", "models"].includes(key)) {
      warnings.push(`${filePath}:${line}: 忽略未知 Provider 字段 ${key}`);
      return;
    }
    if (["type", "base_url", "api_key_env", "api_key"].includes(key) && typeof value !== "string") {
      errors.push(`${filePath}:${line}: ${key} 必须是字符串`);
      return;
    }
    if (key === "models" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      errors.push(`${filePath}:${line}: models 必须是字符串数组`);
      return;
    }
    providers[section] = {
      ...current,
      ...(key === "type" ? { type: value as UnifiedProviderType } : {}),
      ...(key === "base_url" ? { baseUrl: value as string } : {}),
      ...(key === "api_key_env" ? { apiKeyEnv: value as string } : {}),
      ...(key === "api_key" ? { apiKey: value as string } : {}),
      ...(key === "models" ? { models: value as string[] } : {}),
    };
  };

  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = /^\[providers\.([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      const providerId = parseTomlKey(sectionMatch[1] ?? "");
      if (!providerId) {
        errors.push(`${filePath}:${lineNumber}: Provider ID 无效`);
        section = undefined;
      } else {
        section = providerId;
        providers[providerId] ??= {};
      }
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      errors.push(`${filePath}:${lineNumber}: 只支持 [providers.<id>] 表`);
      section = undefined;
      continue;
    }
    const separator = findEquals(line);
    if (separator < 0) {
      errors.push(`${filePath}:${lineNumber}: 缺少键值分隔符 =`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) {
      errors.push(`${filePath}:${lineNumber}: 无效配置键 ${key}`);
      continue;
    }
    try {
      assign(key, parseTomlValue(line.slice(separator + 1).trim()), lineNumber);
    } catch (error) {
      errors.push(`${filePath}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    document: Object.freeze({ model, provider, providers: Object.freeze(providers) }),
    diagnostics: Object.freeze({ errors: Object.freeze(errors), warnings: Object.freeze(warnings) }),
  };
}

export async function resolveUnifiedConfig(options: UnifiedConfigLoadOptions = {}): Promise<ResolvedUnifiedConfig> {
  const env = options.env ?? process.env;
  const paths = resolveUnifiedConfigPaths(options);
  const diagnostics = { errors: [] as string[], warnings: [] as string[] };
  const legacy = await readLegacyProviderFile(paths.legacyProviderFile, diagnostics);
  let document: UnifiedConfigDocument = { providers: {} };
  let hasFileSource = false;
  for (const filePath of [paths.user, paths.project].filter((path): path is string => Boolean(path))) {
    if (!existsSync(filePath)) continue;
    hasFileSource = true;
    document = mergeDocuments(document, await readTomlFile(filePath, diagnostics));
  }
  document = mergeDocuments(document, standardEnvironmentDocument(env, !hasFileSource));
  document = mergeDocuments(document, {
    providers: {},
    ...(options.cliOverrides?.model?.trim() ? { model: options.cliOverrides.model.trim() } : {}),
    ...(options.cliOverrides?.provider?.trim() ? { provider: options.cliOverrides.provider.trim() } : {}),
  });
  const hasSource = hasFileSource || hasStandardEnvironment(env) || Boolean(options.cliOverrides?.model?.trim() || options.cliOverrides?.provider?.trim());
  const selectedProvider = document.provider ?? legacy.defaultModelSelection?.providerId ?? inferProviderId(document);
  // 环境探测选中的 Provider 使用自己的默认模型，不能继承旧 JSON 中另一家的模型。
  const environmentModel = !hasFileSource && selectedProvider
    ? DEFAULT_ENVIRONMENT_MODELS[document.providers[selectedProvider]?.type ?? ""]
    : undefined;
  const selectedModel = document.model ?? environmentModel ?? legacy.defaultModelSelection?.modelId;
  const entries = new Map<string, UnifiedProviderDefinition>(Object.entries(legacy.providers));
  for (const [id, definition] of Object.entries(document.providers)) {
    entries.set(id, mergeProviderDefinition(entries.get(id), definition));
  }
  if (selectedProvider && !entries.has(selectedProvider)) diagnostics.errors.push(`Provider 不存在: ${selectedProvider}`);
  const providers = [...entries.entries()].map(([id, definition]) => resolveProvider(id, definition, selectedProvider, selectedModel, env, diagnostics));
  const managedProviderIds = Object.freeze(Object.keys(document.providers));
  return Object.freeze({
    paths,
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(selectedProvider ? { provider: selectedProvider } : {}),
    providers: Object.freeze(providers),
    managedProviderIds,
    diagnostics: Object.freeze({ errors: Object.freeze(diagnostics.errors), warnings: Object.freeze(diagnostics.warnings) }),
    hasSource,
    ...(legacy.defaultModelSelection ? { legacyDefault: legacy.defaultModelSelection } : {}),
  });
}

/** 将统一配置转换成现有 Personal Provider Config，Registry 和内部协议保持不变。 */
export async function materializeUnifiedConfig(options: MaterializeUnifiedConfigOptions): Promise<ResolvedUnifiedConfig> {
  const resolved = await resolveUnifiedConfig(options);
  const generated = resolved.providers.filter((provider) => provider.executable && provider.apiType);
  if (!resolved.hasSource) return resolved;
  const current = await readJsonObject(options.targetProviderFile);
  const currentConfig = isRecord(current.config) ? current.config : {};
  const oldRules = isRecord(currentConfig.providerConfigRules) && Array.isArray(currentConfig.providerConfigRules.providerRules)
    ? currentConfig.providerConfigRules.providerRules : [];
  const generatedIds = new Set(generated.map((provider) => provider.id));
  const managedIds = new Set([...resolved.managedProviderIds, ...generatedIds]);
  const providerRules = oldRules.filter((rule) => !isRecord(rule) || !managedIds.has(String(rule.providerId)));
  for (const provider of generated) {
    const oldRule = oldRules.find((rule) => isRecord(rule) && rule.providerId === provider.id);
    const oldConfig = isRecord(oldRule) && isRecord(oldRule.config) ? oldRule.config : {};
    providerRules.push({
      ...(isRecord(oldRule) ? oldRule : {}),
      providerId: provider.id,
      providerName: isRecord(oldRule) && typeof oldRule.providerName === "string" ? oldRule.providerName : provider.id,
      enabled: true,
      config: {
        ...oldConfig,
        group: "standard-personal",
        access: { type: "api-key", apiKey: provider.apiKey },
        api: { type: provider.apiType, baseUrl: provider.baseUrl },
        personalModelIds: provider.models,
        modelOrder: provider.models,
      },
    });
  }
  const modelConfigRules = isRecord(currentConfig.modelConfigRules) ? currentConfig.modelConfigRules : { providerModelRules: [], manualProviderModelRules: [] };
  const nextConfig = {
    ...currentConfig,
    providerConfigRules: { ...(isRecord(currentConfig.providerConfigRules) ? currentConfig.providerConfigRules : {}), providerRules },
    modelConfigRules,
    ...(resolved.provider && resolved.model ? { defaultModelSelection: { providerId: resolved.provider, modelId: resolved.model } } : {}),
  };
  await mkdir(dirname(options.targetProviderFile), { recursive: true });
  await writeFile(options.targetProviderFile, `${JSON.stringify({ schemaVersion: 1, config: nextConfig }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return resolved;
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
      type: provider.type,
      apiType: provider.apiType,
      baseUrl: provider.baseUrl,
      apiKey: maskSecret(provider.apiKey),
      apiKeySource: provider.apiKeySource,
      models: provider.models,
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

async function readTomlFile(filePath: string, diagnostics: { errors: string[]; warnings: string[] }): Promise<UnifiedConfigDocument> {
  try {
    const parsed = parseUnifiedConfigToml(await readFile(filePath, "utf8"), filePath);
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
        ...(Array.isArray(rule.config.personalModelIds) ? { models: rule.config.personalModelIds.filter((value): value is string => typeof value === "string") } : {}),
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
  const type = definition.type;
  const apiType = type ? TYPE_TO_API[type] : undefined;
  const apiKeyFromEnv = definition.apiKeyEnv?.trim() ? env[definition.apiKeyEnv.trim()]?.trim() : undefined;
  const apiKey = definition.apiKey?.trim() || apiKeyFromEnv;
  const baseUrl = definition.baseUrl?.trim() || (type ? DEFAULT_BASE_URL[type] : undefined);
  // CLI/环境显式选中的模型必须准入，不能被低优先级 models 列表挡住。
  const models = uniqueStrings([
    ...(definition.models ?? []),
    ...(id === selectedProvider && selectedModel ? [selectedModel] : []),
  ]);
  if (!type) diagnostics.errors.push(`Provider ${id}: 缺少 type`);
  else if (!(type in TYPE_TO_API)) diagnostics.errors.push(`Provider ${id}: 未知 type ${type}`);
  if (baseUrl) { try { new URL(baseUrl); } catch { diagnostics.errors.push(`Provider ${id}: base_url 不是有效 URL`); } }
  else diagnostics.errors.push(`Provider ${id}: 缺少 base_url`);
  if (!apiKey) diagnostics.errors.push(`Provider ${id}: 缺少 api_key 或 api_key_env 对应的环境变量`);
  if (models.length === 0) diagnostics.warnings.push(`Provider ${id}: 没有模型，需设置 model 或 models`);
  if (type === "gemini") diagnostics.warnings.push(`Provider ${id}: Gemini 仅支持识别和检查，当前版本暂不执行`);
  return Object.freeze({ id, ...(type ? { type } : {}), ...(apiType ? { apiType } : {}), ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}), ...(definition.apiKey ? { apiKeySource: "config.api_key" } : definition.apiKeyEnv ? { apiKeySource: `env:${definition.apiKeyEnv}` } : {}), models: Object.freeze(models), executable: Boolean(type && apiType && baseUrl && apiKey && models.length > 0) });
}

function inferProviderId(document: UnifiedConfigDocument): string | undefined {
  const ids = Object.keys(document.providers);
  return ids.length === 1 ? ids[0] : undefined;
}

function uniqueStrings(values: readonly string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }

function stripTomlComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && quoted) { escaped = !escaped; continue; }
    if (char === '"' && !escaped) quoted = !quoted;
    if (char === "#" && !quoted) return line.slice(0, index);
    escaped = false;
  }
  return line;
}

function findEquals(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) { if (line[index] === '"') quoted = !quoted; if (line[index] === "=" && !quoted) return index; }
  return -1;
}

function parseTomlValue(value: string): string | boolean | number | string[] {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => { const parsed = parseTomlValue(item.trim()); if (typeof parsed !== "string") throw new Error("数组目前只支持字符串元素"); return parsed; });
  }
  throw new Error(`不支持的 TOML 值 ${value}`);
}

function parseTomlKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) { try { return JSON.parse(trimmed) as string; } catch { return undefined; } }
  return /^[A-Za-z0-9._:-]+$/u.test(trimmed) ? trimmed : undefined;
}

async function readJsonObject(filePath: string): Promise<Record<string, any>> {
  try { const value = JSON.parse(await readFile(filePath, "utf8")) as unknown; return isRecord(value) ? value : {}; } catch (error) { if (isRecord(error) && error.code === "ENOENT") return {}; throw error; }
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
