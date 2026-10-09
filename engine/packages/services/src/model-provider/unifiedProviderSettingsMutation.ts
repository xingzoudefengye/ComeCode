import { randomUUID } from "node:crypto";
import {
  createProviderConfigEditor,
  materializeUnifiedConfig,
  type UnifiedConfigLoadOptions,
} from "@zcode/adapters/config";
import {
  type ModelConfig,
  ProviderConfig,
  ProviderMutationStaleError,
  type ProviderSettingsMutationTarget,
} from "@zcode/provider";
import type { ProviderConfigRule } from "@zcode/provider";
import { getZCodeDataRootDir } from "../paths.js";

type UnifiedModel = Record<string, unknown> & { id: string };
type UnifiedProvider = Record<string, unknown> & { id: string; models?: Array<string | UnifiedModel> };
type UnifiedDocument = {
  provider?: string;
  model?: string;
  providers: UnifiedProvider[];
};

const apiTypeMap: Record<string, string> = {
  "openai-chat-completions": "openai-chat",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic",
};

/** 将桌面设置 mutation 统一落到 config.json，再生成 Registry 兼容投影。 */
export function createUnifiedProviderSettingsMutationTarget(options: {
  readonly targetProviderFile: string;
  readonly unifiedConfigDataRoot?: string;
  readonly load?: UnifiedConfigLoadOptions;
}): ProviderSettingsMutationTarget {
  const load: UnifiedConfigLoadOptions = {
    includeProject: false,
    dataRoot: options.unifiedConfigDataRoot ?? getZCodeDataRootDir(),
    env: process.env,
    ...options.load,
  };
  const targetProviderFile = options.targetProviderFile;
  const editor = createProviderConfigEditor(load);

  const mutate = async (change: (document: UnifiedDocument) => UnifiedDocument): Promise<void> => {
    const snapshot = await editor.read();
    const input = structuredClone(snapshot.config) as UnifiedDocument;
    const document = change(input);
    // 幂等无变更（例如删除目标已不存在）不重写配置，避免无意义落盘与投影。
    if (document === input) return;
    await editor.save({ revision: snapshot.revision, config: document, migrate: true });
    await materializeUnifiedConfig({ ...load, targetProviderFile });
  };

  const updateProvider = (
    document: UnifiedDocument,
    providerId: string,
    change: (provider: UnifiedProvider) => UnifiedProvider,
    options: { allowMissing?: boolean } = {},
  ) => {
    const index = document.providers.findIndex((provider) => provider.id === providerId);
    if (index < 0) {
      // 删除类操作里目标已不存在就是期望终态：按幂等处理，其余操作说明 UI 快照过期。
      if (options.allowMissing) return document;
      throw new ProviderMutationStaleError(
        providerId,
        document.providers.map((provider) => provider.id),
      );
    }
    const providers = [...document.providers];
    providers[index] = change(providers[index]!);
    return { ...document, providers };
  };

  const updateModel = (
    document: UnifiedDocument,
    providerId: string,
    modelId: string,
    change: (model: UnifiedModel) => UnifiedModel,
  ) => updateProvider(document, providerId, (provider) => ({
    ...provider,
    models: (provider.models ?? []).map((model) => {
      const current = typeof model === "string" ? { id: model } : model;
      return current.id === modelId ? change(current) : current;
    }),
  }));

  const providerFromConfig = (providerId: string, config: ProviderConfig, metadata?: Pick<ProviderConfigRule, "providerName" | "templateId" | "enabled">): UnifiedProvider => {
    const data = config.toJSON();
    const api = data.api;
    const access = data.access;
    const models = [...(data.personalModelIds ?? [])].map((id) => {
      const override = data.modelOverrides?.[id];
      return { id, ...(override?.api?.type ? { type: apiTypeMap[override.api.type] ?? override.api.type } : {}), ...(override?.api?.baseUrl ? { baseUrl: override.api.baseUrl } : {}), ...(override?.name ? { name: override.name } : {}) };
    });
    return {
      id: providerId,
      ...(metadata?.providerName ? { name: metadata.providerName } : {}),
      ...(metadata?.enabled === false ? { enabled: false } : {}),
      ...(api?.type ? { type: apiTypeMap[api.type] ?? api.type } : {}),
      ...(api?.baseUrl ? { baseUrl: api.baseUrl } : {}),
      ...(access?.type === "api-key" && access.apiKey ? { apiKey: access.apiKey } : {}),
      models,
    };
  };

  const modelConfigFields = (config: ModelConfig): Record<string, unknown> => {
    const data = config.toJSON();
    return {
      ...(data.enabled === false ? { enabled: false } : {}),
      ...(data.properties?.contextWindow !== undefined ? { contextWindow: data.properties.contextWindow } : {}),
      ...(data.properties?.supportsToolCall !== undefined ? { toolCalling: data.properties.supportsToolCall } : {}),
      ...(data.properties?.inputFormat?.supportsImage !== undefined ? { vision: data.properties.inputFormat.supportsImage } : {}),
      ...(data.optionSpecs?.reasoningLevel?.default !== undefined ? { reasoningLevel: data.optionSpecs.reasoningLevel.default } : {}),
      ...(data.optionSpecs?.maxOutputTokens?.max !== undefined ? { maxOutputTokens: data.optionSpecs.maxOutputTokens.max } : {}),
    };
  };

  return {
    createPersonalProvider: async (input) => {
      const providerId = `personal-${randomUUID()}`;
      await mutate((document) => ({
        ...document,
        providers: [...document.providers, providerFromConfig(providerId, input?.initialConfig ?? new ProviderConfig(), { providerName: input?.providerName })],
      }));
      return { providerId };
    },
    savePersonalProviderOverlay: async (providerId, config, _membership, metadata) => {
      await mutate((document) => updateProvider(document, providerId, (provider) => ({
        ...provider,
        ...providerFromConfig(providerId, config, metadata),
        models: provider.models,
      })));
    },
    deletePersonalProvider: async (providerId) => mutate((document) => {
      const providers = document.providers.filter((provider) => provider.id !== providerId);
      // 已不存在即期望终态，幂等返回避免把重复删除报成失败。
      if (providers.length === document.providers.length) return document;
      const next = { ...document, providers };
      if (next.provider === providerId) {
        const first = providers.find((provider) => provider.models?.length);
        return { ...next, ...(first ? { provider: first.id, model: typeof first.models![0] === "string" ? first.models![0] : first.models![0]!.id } : { provider: undefined, model: undefined }) };
      }
      return next;
    }),
    reorderPersonalProviders: async (providerIds) => mutate((document) => {
      const order = new Map(providerIds.map((id, index) => [id, index]));
      return { ...document, providers: [...document.providers].sort((a, b) => (order.get(a.id) ?? document.providers.length) - (order.get(b.id) ?? document.providers.length)) };
    }),
    reorderPersonalModels: async (providerId, modelIds) => mutate((document) => updateProvider(document, providerId, (provider) => {
      const models = provider.models ?? [];
      const order = new Map(modelIds.map((id, index) => [id, index]));
      return { ...provider, models: [...models].sort((a, b) => (order.get(typeof a === "string" ? a : a.id) ?? models.length) - (order.get(typeof b === "string" ? b : b.id) ?? models.length)) };
    })),
    addPersonalModel: async (providerId, modelId, config) => mutate((document) => updateProvider(document, providerId, (provider) => ({ ...provider, models: [...(provider.models ?? []), { id: modelId, ...modelConfigFields(config) }] }))),
    renamePersonalModel: async (providerId, currentModelId, nextModelId) => mutate((document) => updateProvider(document, providerId, (provider) => ({ ...provider, models: (provider.models ?? []).map((model) => (typeof model === "string" ? model : model.id) === currentModelId ? { ...(typeof model === "string" ? {} : model), id: nextModelId } : model) }))),
    deletePersonalModel: async (providerId, modelId) => mutate((document) => {
      const next = updateProvider(document, providerId, (provider) => ({ ...provider, models: (provider.models ?? []).filter((model) => (typeof model === "string" ? model : model.id) !== modelId) }), { allowMissing: true });
      if (next === document) return document;
      return next.model === modelId ? { ...next, model: undefined } : next;
    }),
    setPersonalModelEnabled: async (providerId, modelId, enabled) => mutate((document) => updateModel(document, providerId, modelId, (model) => ({ ...model, ...(enabled ? { enabled: undefined } : { enabled: false }) }))),
    savePersonalModelDraft: async (providerId, originalModelId, nextModelId, config) => mutate((document) => updateProvider(document, providerId, (provider) => ({ ...provider, models: (provider.models ?? []).map((model) => (typeof model === "string" ? model : model.id) === originalModelId ? { ...(typeof model === "string" ? {} : model), id: nextModelId, ...modelConfigFields(config) } : model) }))),
    refresh: async () => { throw new Error("统一配置 mutation target 不负责刷新 Registry"); },
    refreshSources: async () => { throw new Error("统一配置 mutation target 不负责刷新来源"); },
  };
}
