import {
  MutableAccountProviderConfigSource,
  parseAccountProviderConfigMap,
  type AccountProviderConfigSnapshot,
  type AccountProviderStates,
} from "@zcode/provider";
import { isBuiltinModelProviderId } from "@zcode/shared";
import {
  NodeModelSelectionConfigRepository,
  NodeProviderRegistryRuntime,
  resolveNodeProviderRuntimePaths,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import { getDefaultConfigPath, normalizeComeCodeEnv } from "@zcode/adapters/config";
import { readLegacyCliPersonalProviderConfig } from "./legacy-cli-personal-provider-config-importer.js";

export interface ProcessProviderRegistryRuntimeOptions {
  /** 独立 Prompt CLI / TUI 只导入旧的个人 Provider 配置；不启动厂商账号流程。 */
  readonly standalone?: {
    readonly credentialStore?: SharedZCodeCredentialStore;
    readonly legacyCliUserConfigFilePath?: string;
    readonly onAccountInitializationError?: (error: unknown) => void;
    readonly request?: typeof fetch;
    readonly onBuiltinRefreshError?: (error: unknown) => void;
    readonly onBuiltinRefreshResult?: (event: ZCodeBuiltinRefreshEvent) => void;
  };
}

export async function startProcessProviderRegistryRuntime(
  inputEnv: Readonly<Record<string, string | undefined>>,
  options: ProcessProviderRegistryRuntimeOptions = {},
) {
  const env = normalizeComeCodeEnv(inputEnv);
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) throw new Error("缺少进程 Provider Registry 的本地 Built-in / Personal Config 路径");
  const accountSource = new MutableAccountProviderConfigSource();
  const bundledFile = env[ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]?.trim();
  // Modified by ComeCode：独立 CLI 不读取账号凭据；宿主仍可通过显式信封同步 Account Overlay。
  // 不传 zcodeBuiltinRemote / activeFilePath，旧 CDN 缓存也不能覆盖随包目录。
  const runtime = new NodeProviderRegistryRuntime({
    ...paths,
    ...(bundledFile ? { zcodeBuiltinFilePath: bundledFile } : {}),
    accountSource,
    ...(options.standalone
      ? {
          importLegacy: () =>
            readLegacyCliPersonalProviderConfig({
              filePath:
                options.standalone?.legacyCliUserConfigFilePath ?? getDefaultConfigPath(env),
            }),
        }
      : {}),
  });
  const modelSelectionConfigRepository = new NodeModelSelectionConfigRepository({
    personalRepository: runtime.personalRepository,
  });
  try {
    await runtime.start();
    const configuredDefaultModelSelection = await modelSelectionConfigRepository.read();
    return Object.freeze({
      accountSource,
      async syncAccountProviderConfig(next: AccountProviderConfigSnapshot): Promise<boolean> {
        if (options.standalone) throw new Error("Standalone Account 不接收 Host 覆盖");
        const changed = accountSource.replace(next, "host-account-config");
        await runtime.registryService.refresh("host-account-config");
        return changed;
      },
      dispose() {
        modelSelectionConfigRepository.dispose();
        runtime.dispose();
      },
      providerRuntimeHeadersPort: undefined,
      runtime,
      snapshot: runtime.registryService.getSnapshot()!,
      modelSelectionConfigRepository,
      configuredDefaultModelSelection,
    });
  } catch (error) {
    modelSelectionConfigRepository.dispose();
    runtime.dispose();
    throw error;
  }
}

/** 把协议信封解析为进程 Registry 使用的第三层 Account Config Overlay。 */
export function parseProcessAccountProviderConfigSnapshot(input: {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: unknown;
  readonly states?: AccountProviderStates;
}): AccountProviderConfigSnapshot {
  const revision = input.revision.trim();
  if (!revision) throw new Error("Account Config revision 不能为空");
  const basedOnZCodeBuiltinRevision = input.basedOnZCodeBuiltinRevision.trim();
  if (!basedOnZCodeBuiltinRevision) {
    throw new Error("Account Config Built-in revision 不能为空");
  }
  const providers = parseAccountProviderConfigMap(input.providers);
  for (const [providerId, provider] of providers.entries()) {
    // 仅约束托管 Worker 的普通账号信封；独立 CLI、API 和闲时不需要 current。
    if (
      isBuiltinModelProviderId(providerId) &&
      provider.access?.type === "zhipu-account" &&
      provider.access.entitled &&
      typeof input.states?.[providerId]?.current !== "boolean"
    ) {
      throw new Error(`Account State 缺少 current: ${providerId}`);
    }
  }
  return Object.freeze({
    revision,
    basedOnZCodeBuiltinRevision,
    providers,
    // 与 Overlay 属于同一快照；不能只更新 revision 却丢掉当前连接事实。
    ...(input.states ? { states: input.states } : {}),
  });
}
