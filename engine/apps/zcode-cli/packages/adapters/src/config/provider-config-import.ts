import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveComeCodeDataRoot } from "./comecode-env.js";
import { parseUnifiedConfigJson } from "./provider-config-json.js";
import { parseUnifiedConfigToml } from "./provider-config-toml.js";
import type {
  UnifiedConfigDocument,
  UnifiedProviderDefinition,
  UnifiedProviderType,
} from "./provider-config.js";

export type ProviderConfigImportSource = "codex" | "claude";

export interface ProviderConfigImportOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly dataRoot?: string;
}

export interface ProviderConfigImportResult {
  readonly source: ProviderConfigImportSource;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly addedProviders: readonly string[];
  readonly addedModels: readonly string[];
  readonly skippedProviders: readonly string[];
  readonly skippedModels: readonly string[];
  readonly warnings: readonly string[];
  readonly backupPath?: string;
  readonly changed: boolean;
}

export class ProviderConfigImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigImportError";
  }
}

/** 导入只负责本地文件转换，密钥永远不进入导入摘要，也不会触发远端请求。 */
export async function importProviderConfig(
  source: ProviderConfigImportSource,
  options: ProviderConfigImportOptions = {},
): Promise<ProviderConfigImportResult> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir
    ?? options.env?.USERPROFILE
    ?? options.env?.HOME
    ?? process.env.USERPROFILE
    ?? process.env.HOME
    ?? "";
  if (!homeDir) throw new ProviderConfigImportError("无法确定用户目录");
  const sourcePath = source === "codex"
    ? join(homeDir, ".codex", "config.toml")
    : join(homeDir, ".claude", "settings.json");
  const sourceText = await readRequired(sourcePath, source === "codex" ? "Codex" : "Claude Code");
  const imported = source === "codex"
    ? parseCodexConfig(sourceText, sourcePath, env, await exists(join(homeDir, ".codex", "auth.json")))
    : parseClaudeConfig(sourceText, sourcePath);
  const dataRoot = options.dataRoot ?? resolveComeCodeDataRoot(env);
  const targetPath = join(dataRoot, "config.json");
  const existing = await readExistingConfig(dataRoot);
  const merged = mergeImportedDocument(existing.document, imported.document);
  const changed = JSON.stringify(serializeDocument(existing.document)) !== JSON.stringify(serializeDocument(merged));
  if (!changed) {
    return {
      source,
      sourcePath,
      targetPath,
      addedProviders: [],
      addedModels: [],
      skippedProviders: imported.providerIds,
      skippedModels: imported.modelKeys,
      warnings: [...imported.warnings, ...existing.warnings],
      changed: false,
    };
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  let backupPath: string | undefined;
  let originalPath: string | undefined;
  try {
    // Windows 不能直接用 rename 覆盖已有文件，先把旧配置原子移到备份路径。
    originalPath = existing.sourcePath;
    backupPath = originalPath ? await moveExistingTarget(originalPath) : undefined;
    await writeFile(temporary, `${JSON.stringify(serializeDocument(merged), null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, targetPath);
  } catch (error) {
    if (backupPath && originalPath && !(await exists(originalPath))) await rename(backupPath, originalPath).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    source,
    sourcePath,
    targetPath,
    addedProviders: imported.providerIds.filter((id) => !Object.hasOwn(existing.document.providers, id)),
    addedModels: imported.modelKeys.filter((key) => !existingModelKeys(existing.document).has(key)),
    skippedProviders: imported.providerIds.filter((id) => Object.hasOwn(existing.document.providers, id)),
    skippedModels: imported.modelKeys.filter((key) => existingModelKeys(existing.document).has(key)),
    warnings: [...imported.warnings, ...existing.warnings],
    ...(backupPath ? { backupPath } : {}),
    changed: true,
  };
}

interface ImportedDocument {
  readonly document: UnifiedConfigDocument;
  readonly providerIds: readonly string[];
  readonly modelKeys: readonly string[];
  readonly warnings: readonly string[];
}

async function readRequired(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProviderConfigImportError(`未找到 ${label} 配置：${path}`);
    throw new ProviderConfigImportError(`无法读取 ${label} 配置：${path}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function moveExistingTarget(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  const backup = `${path}.${randomUUID()}.bak`;
  await rename(path, backup);
  return backup;
}

async function readExistingConfig(dataRoot: string): Promise<{ document: UnifiedConfigDocument; warnings: string[]; sourcePath?: string }> {
  const candidates = ["config.json", "config.jsonc", "config.toml"];
  const warnings: string[] = [];
  for (const name of candidates) {
    const path = join(dataRoot, name);
    if (!(await exists(path))) continue;
    let text: string;
    try { text = await readFile(path, "utf8"); } catch { throw new ProviderConfigImportError(`无法读取现有 ComeCode 配置：${path}`); }
    const parsed = name.endsWith(".toml") ? parseUnifiedConfigToml(text, path) : parseUnifiedConfigJson(text, path);
    if (parsed.diagnostics.errors.length) throw new ProviderConfigImportError(`现有 ComeCode 配置有错误，请先修复：${parsed.diagnostics.errors.join("；")}`);
    warnings.push(...parsed.diagnostics.warnings);
    return { document: parsed.document, warnings, sourcePath: path };
  }
  return { document: { providers: {} }, warnings };
}

function parseCodexConfig(text: string, path: string, env: Readonly<Record<string, string | undefined>>, hasAuthFile: boolean): ImportedDocument {
  const values = new Map<string, string>();
  const providers = new Map<string, Map<string, string>>();
  let section: string | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const sectionMatch = /^\[model_providers\.(.+)\]$/u.exec(line);
    if (sectionMatch) { section = unquote(sectionMatch[1] ?? ""); providers.set(section, providers.get(section) ?? new Map()); continue; }
    if (line.startsWith("[")) { section = undefined; continue; }
    if (!line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    const value = parseString(line.slice(index + 1).trim());
    if (value === undefined) continue;
    const target = section ? providers.get(section) : values;
    target?.set(key, value);
  }
  const model = values.get("model")?.trim();
  const providerId = values.get("model_provider")?.trim() || [...providers.keys()][0] || "codex";
  const config = providers.get(providerId) ?? new Map<string, string>();
  if (!model) throw new ProviderConfigImportError(`Codex 配置未设置 model：${path}`);
  const wireApi = config.get("wire_api")?.toLowerCase();
  const type: UnifiedProviderType = wireApi === "responses" ? "openai-responses" : "openai-chat";
  const warnings: string[] = [];
  if (wireApi && wireApi !== "responses" && wireApi !== "chat") warnings.push(`Codex wire_api “${wireApi}” 已按 Chat Completions 导入`);
  if (hasAuthFile && !config.get("env_key") && !env.OPENAI_API_KEY) warnings.push("检测到 Codex auth.json；OAuth 认证不会迁移，请配置 API Key 或环境变量");
  const apiKeyEnv = config.get("env_key") || (env.OPENAI_API_KEY ? "OPENAI_API_KEY" : undefined);
  const definition: UnifiedProviderDefinition = {
    name: config.get("name") || `Codex · ${providerId}`,
    type,
    ...(config.get("base_url") ? { baseUrl: config.get("base_url") } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    models: [{ id: model }],
  };
  return imported(providerId, model, { provider: providerId, model, providers: { [providerId]: definition } }, warnings);
}

function parseClaudeConfig(text: string, path: string): ImportedDocument {
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new ProviderConfigImportError(`Claude Code 配置 JSON 格式错误：${path}`); }
  const env = isRecord(input) && isRecord(input.env) ? input.env : undefined;
  if (!env) throw new ProviderConfigImportError(`Claude Code 配置缺少 env 对象：${path}`);
  const model = stringValue(env.ANTHROPIC_MODEL)
    || stringValue(env.ANTHROPIC_DEFAULT_SONNET_MODEL)
    || stringValue(env.ANTHROPIC_DEFAULT_OPUS_MODEL)
    || stringValue(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  if (!model) throw new ProviderConfigImportError(`Claude Code 配置未设置 ANTHROPIC_MODEL：${path}`);
  const apiKey = stringValue(env.ANTHROPIC_API_KEY) || stringValue(env.ANTHROPIC_AUTH_TOKEN);
  const definition: UnifiedProviderDefinition = {
    name: "Claude Code",
    type: "anthropic",
    ...(stringValue(env.ANTHROPIC_BASE_URL) ? { baseUrl: stringValue(env.ANTHROPIC_BASE_URL) } : {}),
    ...(apiKey ? { apiKey } : {}),
    models: [{ id: model }],
  };
  const warnings = apiKey ? [] : ["Claude Code 配置没有 API Key 或 Auth Token，请补充密钥后再使用"];
  return imported("claude", model, { provider: "claude", model, providers: { claude: definition } }, warnings);
}

function imported(providerId: string, model: string, document: UnifiedConfigDocument, warnings: readonly string[]): ImportedDocument {
  return { document, providerIds: [providerId], modelKeys: [`${providerId}/${model}`], warnings };
}

function mergeImportedDocument(current: UnifiedConfigDocument, incoming: UnifiedConfigDocument): UnifiedConfigDocument {
  const providers: Record<string, UnifiedProviderDefinition> = { ...current.providers };
  for (const [id, next] of Object.entries(incoming.providers)) {
    const previous = providers[id];
    if (!previous) { providers[id] = next; continue; }
    const models = [...(previous.models ?? [])];
    for (const model of next.models ?? []) {
      const modelId = typeof model === "string" ? model : model.id;
      if (!models.some((item) => (typeof item === "string" ? item : item.id) === modelId)) models.push(model);
    }
    providers[id] = { ...previous, models };
  }
  return {
    ...(current.provider ? { provider: current.provider } : incoming.provider ? { provider: incoming.provider } : {}),
    ...(current.model ? { model: current.model } : incoming.model ? { model: incoming.model } : {}),
    providers,
    ownsProviderMembership: true,
  };
}

function existingModelKeys(document: UnifiedConfigDocument): Set<string> {
  const keys = new Set<string>();
  for (const [provider, definition] of Object.entries(document.providers)) for (const model of definition.models ?? []) keys.add(`${provider}/${typeof model === "string" ? model : model.id}`);
  return keys;
}

function serializeDocument(document: UnifiedConfigDocument): Record<string, unknown> {
  return {
    ...(document.provider ? { provider: document.provider } : {}),
    ...(document.model ? { model: document.model } : {}),
    providers: Object.entries(document.providers).map(([id, definition]) => ({ id, ...definition })),
  };
}

function stripComment(line: string): string {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && line[index - 1] !== "\\") quoted = !quoted;
    if (line[index] === "#" && !quoted) return line.slice(0, index);
  }
  return line;
}

function parseString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return undefined;
  try { return JSON.parse(trimmed) as string; } catch { return undefined; }
}

function unquote(value: string): string { return parseString(value.trim()) ?? value.trim(); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
