import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeUnifiedConfig } from "@zcode/adapters/config";
import { PERSONAL_PROVIDER_CONFIG_FILE_NAME } from "@zcode/provider-node";

/** Host 的 Registry 投影不写入全局来源，项目覆盖由 CLI 子进程按 cwd 解析。 */
export function createSharedProviderSnapshot(options: {
  dataRoot: string;
  env: Readonly<Record<string, string | undefined>>;
}) {
  const directory = join(tmpdir(), `comecode-host-provider-${randomUUID()}`);
  const filePath = join(directory, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  let preparing: Promise<void> | undefined;
  return {
    get filePath(): string {
      return filePath;
    },
    prepare(): Promise<void> {
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
    },
    async dispose(): Promise<void> {
      await preparing?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
