import { rm } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeUnifiedConfig } from "@zcode/adapters/config";
import { PERSONAL_PROVIDER_CONFIG_FILE_NAME } from "@zcode/provider-node";

/** 统一配置文件名（含编辑器写盘用的 config.json.<uuid>.tmp/.bak 中间态）。 */
const UNIFIED_CONFIG_FILE_PATTERN = /^config\.(json|jsonc|toml)(\..+)?$/i;
const RELOAD_DEBOUNCE_MS = 250;

/** Host 的 Registry 投影不写入全局来源，项目覆盖由 CLI 子进程按 cwd 解析。 */
export function createSharedProviderSnapshot(options: {
  dataRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  /** 默认监听统一 config.json：Web/CLI 修改后自动重新投影，运行中的桌面无需重启。 */
  watch?: boolean;
}) {
  const directory = join(tmpdir(), `comecode-host-provider-${randomUUID()}`);
  const filePath = join(directory, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  let preparing: Promise<void> | undefined;
  let watcher: FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const prepare = (): Promise<void> => {
    // 只合并并发中的投影；成功/失败后都失效，下一次准备重新读取全局配置。
    return (preparing ??= (async () => {
      const config = await materializeUnifiedConfig({
        dataRoot: options.dataRoot,
        // Host 只读取全局配置，不能把当前进程 cwd 当作项目覆盖。
        includeProject: false,
        cwd: directory,
        env: options.env,
        targetProviderFile: filePath,
        legacyProviderFile: join(options.dataRoot, "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME),
      });
      if (config.diagnostics.errors.length) {
        throw new Error("ComeCode 全局模型配置无效，请使用 comecode config check 检查配置");
      }
    })().finally(() => { preparing = undefined; }));
  };

  const scheduleReload = (): void => {
    if (disposed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void (async () => {
        // 外部变更若落在上一次投影进行中，必须等它结束后再读，否则会 dedupe 到旧快照。
        await preparing?.catch(() => undefined);
        await prepare();
      })().catch(() => {
        // 投影失败保持上一份快照；下一次文件变更或启动时仍会重试。
      });
    }, RELOAD_DEBOUNCE_MS);
    debounce.unref?.();
  };

  const startWatching = (): void => {
    try {
      watcher = watch(options.dataRoot, { persistent: false }, (_event, filename) => {
        // 部分平台不提供 filename；无法判定时保守重新投影，投影本身是幂等的。
        const name = typeof filename === "string" ? filename : "";
        if (!name || UNIFIED_CONFIG_FILE_PATTERN.test(name)) scheduleReload();
      });
      watcher.on("error", () => {
        // 监听不可用时不阻塞运行；下次 prepare 仍会读到最新配置。
      });
    } catch {
      watcher = undefined;
    }
  };

  if (options.watch !== false) startWatching();

  return {
    get filePath(): string {
      return filePath;
    },
    prepare,
    async dispose(): Promise<void> {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      watcher?.close();
      await preparing?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
