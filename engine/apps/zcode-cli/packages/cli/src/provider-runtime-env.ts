import { existsSync, realpathSync } from "node:fs";
import {
  extractCliWorkingDirectory,
  extractProviderCliOverrides,
  materializeUnifiedConfig,
  normalizeComeCodeEnv,
  resolveComeCodeDataRoot,
} from "@zcode/adapters/config";
import { dirname, join, resolve } from "node:path";
import {
  materializeZCodeBuiltinProviderConfig,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import type { CliEnv } from "./env.js";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";

export const SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY = "zcode-provider/zcode-builtin.json";

export function createCliProviderRefreshReporter(
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
) {
  return {
    onBuiltinRefreshError(error: unknown) {
      stderr.write(
        `ZCode Built-in 刷新失败: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    },
    onBuiltinRefreshResult(event: ZCodeBuiltinRefreshEvent) {
      // TTL 检查不是生产事件；成功更新才默认留痕，不能输出 CDN URL 查询参数或内容。
      if (event.result === "updated" || process.env.NODE_ENV !== "production") {
        stderr.write(
          `ZCode Built-in ${event.result}${event.reason ? ` (${event.reason})` : ""}${event.revision === undefined ? "" : ` revision=${event.revision} source=CDN`}\n`,
        );
      }
    },
  };
}

type SeaProviderConfigAssets = Pick<typeof import("node:sea"), "getAsset" | "isSea">;

interface PrepareCliProviderRuntimeEnvOptions {
  readonly argv: readonly string[];
  readonly env: CliEnv;
  readonly dataBaseDir?: string;
  readonly entrypoint?: string;
  readonly sea?: SeaProviderConfigAssets;
  readonly appVersion?: string;
  readonly platform?: string;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}

/** 为运行 Core 或写入模型选择的 CLI Entry 定位同一 Environment 的 Provider Config。 */
export async function prepareCliProviderRuntimeEnv(
  options: PrepareCliProviderRuntimeEnvOptions,
): Promise<Record<string, string>> {
  if (!requiresProviderRuntime(options.argv)) return {};

  const env = normalizeComeCodeEnv(options.env);
  const explicitZCodeBuiltin = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const explicitPersonal = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const dataBaseDir = resolveComeCodeDataRoot(env, options.dataBaseDir);
  const personalFilePath =
    explicitPersonal ?? join(dataBaseDir, "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 统一配置只在 CLI 边界 materialize，旧 Provider Registry 继续读取 JSON。
  const config = await materializeUnifiedConfig({
    cwd: extractCliWorkingDirectory(options.argv),
    dataRoot: dataBaseDir,
    env,
    targetProviderFile: personalFilePath,
    legacyProviderFile: personalFilePath,
    cliOverrides: extractProviderCliOverrides(options.argv),
  });
  if (config.hasSource && config.diagnostics.errors.length) throw new Error(config.diagnostics.errors.join("；"));
  const selected = config.providers.find((provider) => provider.id === config.provider);
  const explicitSelection = extractProviderCliOverrides(options.argv).provider?.trim() || env.COMECODE_PROVIDER?.trim();
  const selectedModel = selected?.modelConfigs.find((model) => model.id === config.model);
  if (selectedModel?.type === "gemini" || (config.provider && config.model && !selectedModel?.executable) || (explicitSelection && !selected?.executable)) {
    // 显式选择失败时不能让 Registry 静默回退到其他可用模型。
    throw new Error(selectedModel?.enabled === false
      ? "所选模型已停用，请在模型管理页启用或选择其他模型"
      : selectedModel?.type === "gemini"
        ? "Gemini 仅支持识别和检查，当前版本暂不执行"
        : config.diagnostics.errors.join("；") || "所选 Provider 不可执行，请检查模型和密钥配置");
  }
  const environmentSelection = env.COMECODE_PROVIDER?.trim() ||
    selected?.apiKeySource?.match(/^env:(OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|GEMINI_API_KEY)$/u);
  if (environmentSelection && selected?.executable && config.model) {
    // JSON 字符串转义控制字符；只说明选择，不输出 key 或 endpoint。
    options.stderr?.write(`ComeCode Provider: ${JSON.stringify(config.provider)} / ${JSON.stringify(config.model)}（环境配置，CLI 参数优先）\n`);
  }
  if (explicitZCodeBuiltin && explicitPersonal) {
    return {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitZCodeBuiltin,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: explicitPersonal,
    };
  }

  const zcodeBuiltinFilePath =
    explicitZCodeBuiltin ??
    (await resolveBundledZCodeBuiltinProviderConfig({
      dataBaseDir,
      entrypoint: options.entrypoint ?? process.argv[1],
      sea: options.sea ?? getSeaProviderConfigAssets(),
    }));
  // Modified by ComeCode：随包目录是唯一默认来源，不读取 CDN 活跃缓存。
  return {
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
    [ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
  };
}

function requiresProviderRuntime(argv: readonly string[]): boolean {
  try {
    // 复用真实路由解析，避免把 --json/--cwd 的参数误识别成模型命令。
    const parsed = parseGlobalArgs(extractDisallowedToolsArgs(argv).args);
    if (parsed.values.help || parsed.values.version || parsed.values.import !== undefined) return false;
    if (parsed.values.prompt !== undefined || parsed.values.target !== undefined) return true;
    return ["tui", "app-server", "agent-server"].includes(parsed.positionals[0] ?? "tui");
  } catch {
    // 参数错误交给 run 统一报告；此前不应产生配置写盘副作用。
    return false;
  }
}

async function resolveBundledZCodeBuiltinProviderConfig(input: {
  readonly dataBaseDir: string;
  readonly entrypoint: string | undefined;
  readonly sea: SeaProviderConfigAssets | undefined;
}): Promise<string> {
  if (input.sea?.isSea()) {
    const content = input.sea.getAsset(SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY, "utf8");
    return materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: join(input.dataBaseDir, "v2"),
      content,
    });
  }

  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) throw new Error("无法定位 CLI ZCode Built-in Provider Config：缺少入口路径");
  // 全局 bin 可以是软链接，随包配置必须相对真实入口定位。
  const entryDirectory = dirname(realpathSync(resolve(entrypoint)));
  const candidates = [
    join(entryDirectory, "provider", "zcode-builtin.json"),
    resolve(entryDirectory, "../../../../../config/provider/zcode-builtin.json"),
  ];
  const candidate = candidates.find((filePath) => existsSync(filePath));
  if (candidate) return candidate;
  throw new Error(`无法定位 CLI ZCode Built-in Provider Config：${candidates.join(", ")}`);
}

function getSeaProviderConfigAssets(): SeaProviderConfigAssets | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => typeof import("node:sea"))
    | undefined;
  return getBuiltinModule?.("node:sea");
}
