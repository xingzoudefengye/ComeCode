// Modified by ComeCode：在配置边界兼容新前缀，内部继续使用 ZCODE_*。
import { readDataBaseDirFromSettingFile } from "@zcode/shared/node";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;
const COMECODE_PREFIX = "COMECODE_";
const LEGACY_PREFIX = "ZCODE_";
const DATA_DIRECTORY = ".comecode";

export function normalizeComeCodeEnv(env: Env): Record<string, string | undefined> {
  const normalized = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(COMECODE_PREFIX) && value !== undefined) {
      normalized[`${LEGACY_PREFIX}${key.slice(COMECODE_PREFIX.length)}`] = value;
    }
  }
  return normalized;
}

export function resolveComeCodeDataRoot(env: Env = process.env, baseDir?: string): string {
  const base =
    baseDir?.trim() ||
    env.COMECODE_DATA_BASE_DIR?.trim() ||
    env.ZCODE_DATA_BASE_DIR?.trim() ||
    readConfiguredBootstrapDataBaseDir(env) ||
    homedir();
  return join(expandUserPath(base), DATA_DIRECTORY);
}

/**
 * env 未指定数据目录时回退 setting.json 的 dataBaseDir，与桌面早期 bootstrap 一致。
 * 只有指向真实用户环境的 env 才读盘；显式构造的隔离 env（测试）保持纯函数语义。
 */
function readConfiguredBootstrapDataBaseDir(env: Env): string | null {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home && env !== process.env) {
    return null;
  }
  return readDataBaseDirFromSettingFile(home || homedir());
}

export function resolveComeCodeStorageRoot(env: Env = process.env): string {
  const storage = (env.COMECODE_STORAGE_DIR ?? env.ZCODE_STORAGE_DIR)?.trim();
  return storage ? expandUserPath(storage) : resolveComeCodeDataRoot(env);
}

function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return resolve(value);
}
