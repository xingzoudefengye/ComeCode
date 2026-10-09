import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 引导开关文件固定落在真实 HOME 下，不随 dataBaseDir 本身漂移；否则自定义目录后
 * 就再也读不到这份开关。桌面早期 bootstrap 与 Web/CLI 共用同一份读取逻辑，
 * 保证三端解析到同一个数据根，而不是各写各的 config.json。
 */
export function resolveDataBaseDirSettingFilePath(homeDir: string = homedir()): string {
  return join(homeDir, ".comecode", "v2", "setting.json");
}

function extractDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// setting.json 是设备级引导状态，进程内读取一次即可；命中缓存避免热路径反复读盘。
const dataBaseDirCache = new Map<string, string | null>();

export function readDataBaseDirFromSettingFile(homeDir: string = homedir()): string | null {
  const settingsFile = resolveDataBaseDirSettingFilePath(homeDir);
  const cached = dataBaseDirCache.get(settingsFile);
  if (cached !== undefined) {
    return cached;
  }

  let result: string | null = null;
  if (existsSync(settingsFile)) {
    try {
      result = extractDataBaseDir(JSON.parse(readFileSync(settingsFile, "utf-8")));
    } catch {
      // 引导文件损坏时回退默认目录；修复动作由设置页负责，读取方不放大失败。
      result = null;
    }
  }
  dataBaseDirCache.set(settingsFile, result);
  return result;
}

/** 仅供测试：清除进程内缓存，让下一次读取重新落盘。 */
export function resetDataBaseDirBootstrapCacheForTest(): void {
  dataBaseDirCache.clear();
}
