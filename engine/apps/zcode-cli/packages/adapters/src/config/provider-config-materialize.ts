import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  resolveUnifiedConfig,
  type MaterializeUnifiedConfigOptions,
  type ResolvedUnifiedConfig,
} from "./provider-config.js";

/** 将统一配置转换成现有 Personal Provider Config，Registry 和内部协议保持不变。 */
export async function materializeUnifiedConfig(
  options: MaterializeUnifiedConfigOptions,
): Promise<ResolvedUnifiedConfig> {
  const resolved = await resolveUnifiedConfig(options);
  const generated = resolved.providers.filter(
    (provider) => provider.executable && resolved.managedProviderIds.includes(provider.id),
  );
  if (resolved.diagnostics.errors.length) return resolved;
  // 有效配置必须从用户来源继承规则；读取共享派生目标会把项目 A 覆盖带入项目 B。
  const current = await readJsonObject(resolved.paths.legacyProviderFile);
  if (!resolved.hasSource) {
    // 来源不存在时不创建空 JSON，让 Registry 原有旧 CLI 配置迁移仍可执行。
    if (options.targetProviderFile !== resolved.paths.legacyProviderFile && Object.keys(current).length) {
      await mkdir(dirname(options.targetProviderFile), { recursive: true });
      await writeFile(options.targetProviderFile, `${JSON.stringify(current, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600,
      });
    }
    return resolved;
  }
  const currentConfig = isRecord(current.config) ? current.config : {};
  const oldRules =
    isRecord(currentConfig.providerConfigRules) &&
    Array.isArray(currentConfig.providerConfigRules.providerRules)
      ? currentConfig.providerConfigRules.providerRules
      : [];
  const generatedIds = new Set(generated.map((provider) => provider.id));
  const managedIds = new Set([...resolved.managedProviderIds, ...generatedIds]);
  const providerRules = oldRules.filter(
    (rule) => !isRecord(rule) || !managedIds.has(String(rule.providerId)),
  );
  for (const provider of generated) {
    const oldRule = oldRules.find((rule) => isRecord(rule) && rule.providerId === provider.id);
    const oldConfig = isRecord(oldRule) && isRecord(oldRule.config) ? oldRule.config : {};
    const firstModel = provider.modelConfigs.find((model) => model.executable)!;
    providerRules.push({
      ...(isRecord(oldRule) ? oldRule : {}),
      providerId: provider.id,
      providerName:
        provider.name ??
        (isRecord(oldRule) && typeof oldRule.providerName === "string"
          ? oldRule.providerName
          : provider.id),
      enabled: true,
      config: {
        ...oldConfig,
        group: "standard-personal",
        access: { type: "api-key", apiKey: firstModel.apiKey },
        api: { type: firstModel.apiType, baseUrl: firstModel.baseUrl },
        personalModelIds: provider.modelConfigs
          .filter((model) => model.executable)
          .map((model) => model.id),
        modelOrder: provider.modelConfigs.filter((model) => model.executable).map((model) => model.id),
        modelOverrides: Object.fromEntries(
          provider.modelConfigs
            .filter((model) => model.executable)
            .map((model) => [
              model.id,
              {
                ...(model.name ? { name: model.name } : {}),
                api: { type: model.apiType, baseUrl: model.baseUrl },
                access: { type: "api-key", apiKey: model.apiKey },
              },
            ]),
        ),
      },
    });
  }
  const modelConfigRules = isRecord(currentConfig.modelConfigRules)
    ? currentConfig.modelConfigRules
    : { providerModelRules: [], manualProviderModelRules: [] };
  // 统一配置声明的供应商由本入口托管，防止删除模型后旧规则继续生效。
  const keepRule = (rule: unknown) =>
    !isRecord(rule) ||
    !managedIds.has(String(rule.providerId)) ||
    resolved.providers.some(
      (provider) =>
        provider.id === rule.providerId && provider.models.includes(String(rule.modelId)),
    );
  const generatedModelRules = resolved.providers.filter((provider) => managedIds.has(provider.id)).flatMap((provider) =>
    provider.modelConfigs
      .filter(
        (model) =>
          model.executable || model.enabled === false,
      )
      .map((model) => ({
        providerId: provider.id,
        modelId: model.id,
        config: {
          // 显式模型开关覆盖内置目录规则，停用时保留能力叶子供重新启用恢复。
          enabled: model.enabled,
          properties: {
            ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
            ...(model.toolCalling !== undefined ? { supportsToolCall: model.toolCalling } : {}),
            ...(model.vision !== undefined ? { inputFormat: { supportsImage: model.vision } } : {}),
          },
          ...(model.reasoningLevel !== undefined || model.maxOutputTokens !== undefined
            ? {
                optionSpecs: {
                  ...(model.reasoningLevel !== undefined
                    ? { reasoningLevel: { default: model.reasoningLevel } }
                    : {}),
                  ...(model.maxOutputTokens !== undefined
                    ? { maxOutputTokens: { max: model.maxOutputTokens } }
                    : {}),
                },
              }
            : {}),
        },
      })),
  );
  const ownedManualRules = Array.isArray(modelConfigRules.manualProviderModelRules)
    ? modelConfigRules.manualProviderModelRules.filter((rule: any) =>
        generatedModelRules.some(
          (next) => next.providerId === rule.providerId && next.modelId === rule.modelId,
        ),
      )
    : [];
  // 已有手动叶子保留为显式规则；统一配置新增工具能力也走同一智能规则，避免双模式冲突。
  const smartRules = [
    ...(Array.isArray(modelConfigRules.providerModelRules)
      ? modelConfigRules.providerModelRules
      : []),
    ...ownedManualRules,
  ];
  const nextConfig = {
    ...currentConfig,
    providerConfigRules: {
      ...(isRecord(currentConfig.providerConfigRules) ? currentConfig.providerConfigRules : {}),
      providerRules,
    },
    modelConfigRules: {
      ...modelConfigRules,
      providerModelRules: mergeModelRules(smartRules, generatedModelRules, keepRule),
      manualProviderModelRules: Array.isArray(modelConfigRules.manualProviderModelRules)
        ? modelConfigRules.manualProviderModelRules.filter(
            (rule: any) => keepRule(rule) && !ownedManualRules.includes(rule),
          )
        : [],
    },
    ...(resolved.provider && resolved.model
      ? { defaultModelSelection: { providerId: resolved.provider, modelId: resolved.model } }
      : {}),
  };
  if (resolved.hasSource && (!resolved.provider || !resolved.model)) delete (nextConfig as Record<string, unknown>).defaultModelSelection;
  await mkdir(dirname(options.targetProviderFile), { recursive: true });
  await writeFile(
    options.targetProviderFile,
    `${JSON.stringify({ schemaVersion: 1, config: nextConfig }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(`${options.targetProviderFile}.comecode-managed.json`, JSON.stringify(resolved.managedProviderIds.filter((id) => resolved.providers.some((provider) => provider.id === id))), { encoding: "utf8", mode: 0o600 });
  return resolved;
}

async function readJsonObject(filePath: string): Promise<Record<string, any>> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(value) ? value : {};
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 已有同模型的显式能力保持不变，统一配置只覆盖本次明确声明的叶子。 */
function mergeModelRules(
  old: unknown,
  generated: readonly any[],
  keep: (rule: unknown) => boolean,
): any[] {
  const rules: any[] = Array.isArray(old) ? old.filter(keep) : [];
  for (const next of generated) {
    const index = rules.findIndex(
      (rule) => rule.providerId === next.providerId && rule.modelId === next.modelId,
    );
    const previous = index < 0 ? {} : rules[index].config;
    const merged = {
      ...next,
      config: {
        ...previous,
        ...next.config,
        properties: {
          ...previous.properties,
          ...next.config.properties,
          ...(next.config.properties.inputFormat
            ? {
                inputFormat: {
                  ...previous.properties?.inputFormat,
                  ...next.config.properties.inputFormat,
                },
              }
            : {}),
        },
        ...(next.config.optionSpecs
          ? {
              optionSpecs: {
                ...previous.optionSpecs,
                ...(next.config.optionSpecs.reasoningLevel
                  ? {
                      reasoningLevel: {
                        ...previous.optionSpecs?.reasoningLevel,
                        ...next.config.optionSpecs.reasoningLevel,
                      },
                    }
                  : {}),
                ...(next.config.optionSpecs.maxOutputTokens
                  ? {
                      maxOutputTokens: {
                        ...previous.optionSpecs?.maxOutputTokens,
                        ...next.config.optionSpecs.maxOutputTokens,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
    if (index < 0) rules.push(merged);
    else rules[index] = merged;
  }
  return rules;
}
