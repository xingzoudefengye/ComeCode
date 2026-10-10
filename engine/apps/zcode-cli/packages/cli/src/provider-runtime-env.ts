import { existsSync, realpathSync, rmSync, watch, type FSWatcher } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/** 统一配置文件名（含编辑器写盘用的 config.json.<uuid>.tmp/.bak 中间态）。 */
const UNIFIED_CONFIG_FILE_PATTERN = /^config\.(json|jsonc|toml)(\..+)?$/i;
const SNAPSHOT_RELOAD_DEBOUNCE_MS = 250;

const runtimeDirectories = new Set<string>();
process.once("exit", () => {
  // 退出阶段无法等待异步 IO，清除含凭据快照；异常中断不以复用旧快照恢复。
  for (const directory of runtimeDirectories) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* 退出清理不能掩盖原退出码。 */ }
  }
});

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
  /** 长驻协议进程跟随统一配置重新投影运行时快照；一次性命令保持单次快照语义。 */
  readonly watchUnifiedConfig?: boolean;
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
  const legacyFilePath =
    explicitPersonal ?? join(dataBaseDir, "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 每次启动独立快照，避免项目覆盖写回全局来源或并发 Registry 读到另一启动的配置。
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "comecode-provider-runtime-"));
  runtimeDirectories.add(runtimeDirectory);
  const personalFilePath = join(runtimeDirectory, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 统一配置只在 CLI 边界 materialize，旧 Provider Registry 继续读取 JSON。
  const materializeSnapshot = () =>
    materializeUnifiedConfig({
      cwd: extractCliWorkingDirectory(options.argv),
      dataRoot: dataBaseDir,
      env,
      targetProviderFile: personalFilePath,
      legacyProviderFile: legacyFilePath,
      cliOverrides: extractProviderCliOverrides(options.argv),
    });
  const config = await materializeSnapshot();
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
  // app-server/agent-server 是长驻进程：快照只在启动时投影一次，Registry 轮询又只盯快照
  // 文件，导致运行中新增/停用模型永远进不了 Agent Registry，必须重启才生效。
  if (options.watchUnifiedConfig) {
    const snapshotRuntime = watchCliProviderRuntimeSnapshot({
      dataRoot: dataBaseDir,
      rematerialize: materializeSnapshot,
      ...(options.stderr ? { stderr: options.stderr } : {}),
    });
    // 协议请求（连接测试等）不能只依赖文件监听的去抖窗口：注册按需重新投影，
    // 让刚保存的模型在同一次请求内就能进入 Registry。
    const { setCliProviderSnapshotRefresher } = await import("@zcode/bootstrap");
    setCliProviderSnapshotRefresher(() => snapshotRuntime.refresh());
  }
  if (explicitZCodeBuiltin && explicitPersonal) {
    return {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitZCodeBuiltin,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
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

export interface CliProviderSnapshotRuntime {
  readonly refresh: () => Promise<void>;
  readonly dispose: () => void;
}

/**
 * 长驻协议进程的运行时快照跟随统一配置重新投影。
 *
 * Registry 的 Personal 轮询只看得到投影出来的快照文件；桌面/Web/CLI 新增模型只写统一
 * config.json，因此必须在来源变更时重新投影同一份快照文件，运行中的 Agent 才能在没有
 * 重启的情况下解析到新模型。
 */
export function watchCliProviderRuntimeSnapshot(options: {
  readonly dataRoot: string;
  readonly rematerialize: () => Promise<unknown>;
  readonly stderr?: Pick<NodeJS.WriteStream, "write">;
}): CliProviderSnapshotRuntime {
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // 串行化投影：文件事件与按需刷新可能交错，旧一轮结果不能覆盖新配置。
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (): Promise<void> => {
    queue = queue.then(async () => {
      if (disposed) return;
      try {
        await options.rematerialize();
      } catch (error) {
        // 投影失败保留上一份快照；下一次文件变更或按需刷新仍会重试，不能中断 Agent。
        options.stderr?.write(
          `Provider 运行时快照重新投影失败: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
    return queue;
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void enqueue();
    }, SNAPSHOT_RELOAD_DEBOUNCE_MS);
    timer.unref?.();
  };

  try {
    watcher = watch(options.dataRoot, { persistent: false }, (_event, filename) => {
      // 部分平台不提供 filename；无法判定时保守重新投影，投影本身是幂等的。
      const name = typeof filename === "string" ? filename : "";
      if (!name || UNIFIED_CONFIG_FILE_PATTERN.test(name)) schedule();
    });
    watcher.on("error", () => {
      // 监听不可用不阻塞运行；重新启动进程仍会读到最新配置。
      watcher = undefined;
    });
  } catch {
    watcher = undefined;
  }

  return {
    /** 取消防抖并立即投影，供需要配置确定性的协议请求等待。 */
    async refresh(): Promise<void> {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await enqueue();
    },
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher?.close();
    },
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
