import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_ENVIRONMENT_MODELS } from "./provider-environment.js";
import {
  parseUnifiedConfigJson, parseUnifiedConfigToml, resolveUnifiedConfig,
  resolveUnifiedConfigPaths, toPublicUnifiedConfig,
  type UnifiedConfigDocument, type UnifiedConfigLoadOptions, type UnifiedProviderDefinition,
} from "./provider-config.js";

const saveSchema = z.object({
  revision: z.string().min(1), migrate: z.boolean().optional(), config: z.unknown(),
}).strict();
export class ConfigEditError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** 编辑写入单一排队；有效配置仍由统一解析器拥有，不修改运行中 Registry。 */
export function createProviderConfigEditor(options: UnifiedConfigLoadOptions) {
  let queue = Promise.resolve();
  const read = async () => {
    const snapshot = await readSnapshot(options);
    const resolved = await resolveUnifiedConfig(options);
    return {
      defaultModels: Object.fromEntries(Object.entries(DEFAULT_ENVIRONMENT_MODELS).filter(([type]) => type !== "gemini")),
      revision: snapshot.revision, source: snapshot.source, target: snapshot.target,
      requiresMigration: snapshot.source !== snapshot.target && snapshot.exists,
      config: publicDocument(snapshot.document),
      effective: toPublicUnifiedConfig(resolved),
      errors: snapshot.errors,
      restartRequired: true,
    };
  };
  const save = (input: unknown) => {
    const operation = queue.then(async () => {
      const parsed = saveSchema.safeParse(input);
      if (!parsed.success) throw new ConfigEditError(400, "保存数据格式不正确");
      const snapshot = await readSnapshot(options);
      if (parsed.data.revision !== snapshot.revision) throw new ConfigEditError(409, "配置已被修改，请重新加载再保存");
      if (snapshot.errors.length) throw new ConfigEditError(422, "原配置有错误，请先修复；未覆盖原文件");
      if (snapshot.exists && snapshot.source !== snapshot.target && !parsed.data.migrate) throw new ConfigEditError(409, "保存将生成 JSON，原文件会保留并备份；请确认迁移");
      const document = restoreSecrets(parsed.data.config, snapshot.document);
      const preview = await resolveUnifiedConfig({ ...options, userDocument: document });
      if (preview.diagnostics.errors.length) throw new ConfigEditError(422, preview.diagnostics.errors.join("；"));
      if (document.provider && document.model && !preview.providers.find((provider) => provider.id === document.provider)?.modelConfigs.some((model) => model.id === document.model && model.executable)) throw new ConfigEditError(422, "默认模型不可执行，请选择三种支持协议中的模型");
      const content = `${JSON.stringify(serializeDocument(document), null, 2)}\n`;
      await mkdir(dirname(snapshot.target), { recursive: true });
      let backup: string | undefined;
      if (snapshot.exists) {
        backup = `${snapshot.source}.${randomUUID()}.bak`;
        await writeFile(backup, snapshot.original, { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      // 写临时文件再替换；落盘前再次检查，避免测试/备份期间外部编辑被覆盖。
      const temporary = `${snapshot.target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if ((await readSnapshot(options)).revision !== snapshot.revision) throw new ConfigEditError(409, "配置已被修改，请重新加载再保存");
        await rename(temporary, snapshot.target);
      } finally { await rm(temporary, { force: true }); }
      return { ...(await read()), backup, saved: true };
    });
    queue = operation.then(() => {}, () => {});
    return operation;
  };
  return { read, save };
}

async function readSnapshot(options: UnifiedConfigLoadOptions) {
  const paths = resolveUnifiedConfigPaths(options);
  const files: (string | null)[] = [];
  for (const file of paths.userCandidates) {
    try { files.push(await readFile(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigEditError(500, "无法读取用户配置"); files.push(null); }
  }
  const index = files.findIndex((value) => value !== null);
  const source = index >= 0 ? paths.userCandidates[index]! : paths.user;
  const original = index >= 0 ? files[index]! : "";
  const parsed = !original ? { document: { providers: {} }, diagnostics: { errors: [] } }
    : source.endsWith(".toml") ? parseUnifiedConfigToml(original, source) : parseUnifiedConfigJson(original, source);
  // TOML 未知字段也不能在网页迁移时静默丢失。
  const errors = [...parsed.diagnostics.errors, ...("warnings" in parsed.diagnostics ? parsed.diagnostics.warnings as string[] : [])];
  return { document: parsed.document as UnifiedConfigDocument, errors, source, target: join(dirname(paths.user), "config.json"), original, exists: index >= 0, revision: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

function serializeDocument(document: UnifiedConfigDocument) {
  return { ...(document.provider ? { provider: document.provider } : {}), ...(document.model ? { model: document.model } : {}), providers: Object.entries(document.providers).map(([id, provider]) => ({ id, ...provider })) };
}
function publicDocument(document: UnifiedConfigDocument) {
  const hide = (definition: Record<string, unknown>) => {
    const { apiKey, ...rest } = definition;
    return { ...rest, hasApiKey: typeof apiKey === "string" && Boolean(apiKey) };
  };
  return { ...serializeDocument(document), providers: Object.entries(document.providers).map(([id, provider]) => ({
    id, ...hide(provider as unknown as Record<string, unknown>),
    models: provider.models?.map((model) => typeof model === "string" ? { id: model, hasApiKey: false } : hide(model as unknown as Record<string, unknown>)) ?? [],
  })) };
}
function restoreSecrets(input: unknown, current: UnifiedConfigDocument): UnifiedConfigDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigEditError(400, "配置必须是对象");
  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.providers)) throw new ConfigEditError(400, "providers 必须是数组");
  const restore = (value: unknown, previous: UnifiedProviderDefinition | undefined) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigEditError(400, "供应商和模型必须是对象");
    const { hasApiKey: _hasApiKey, clearApiKey, ...definition } = value as Record<string, unknown>;
    if (definition.apiKey === "" || definition.apiKey === undefined) {
      delete definition.apiKey;
      if (clearApiKey !== true && !definition.apiKeyEnv && previous?.apiKey) definition.apiKey = previous.apiKey;
    }
    if (clearApiKey === true) delete definition.apiKey;
    return definition;
  };
  const providers = raw.providers.map((value) => {
    const id = value && typeof value === "object" ? (value as Record<string, unknown>).id : undefined;
    const previous = typeof id === "string" ? current.providers[id] : undefined;
    const provider = restore(value, previous);
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) throw new ConfigEditError(400, "models 必须是数组");
      provider.models = provider.models.map((model) => {
        if (typeof model === "string") return model;
        const modelId = model && typeof model === "object" ? (model as Record<string, unknown>).id : undefined;
        const old = previous?.models?.find((entry) => (typeof entry === "string" ? entry : entry.id) === modelId);
        return restore(model, typeof old === "object" ? old : undefined);
      });
    }
    return provider;
  });
  const parsed = parseUnifiedConfigJson(JSON.stringify({ ...raw, providers }), "网页配置");
  if (parsed.diagnostics.errors.length) throw new ConfigEditError(422, parsed.diagnostics.errors.join("；"));
  return parsed.document;
}
