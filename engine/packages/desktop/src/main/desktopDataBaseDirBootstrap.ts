import { homedir } from "node:os";
import { readDataBaseDirFromSettingFile } from "@zcode/shared/node";
import { setDataBaseDir } from "@zcode/services/node";

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const dataBaseDir =
    process.env.COMECODE_DATA_BASE_DIR?.trim() ||
    process.env.ZCODE_DATA_BASE_DIR?.trim() ||
    // 与 Web/CLI 共用同一份引导读取：三端必须解析到同一个数据根，否则各写各的 config.json。
    readDataBaseDirFromSettingFile(homedir());
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
