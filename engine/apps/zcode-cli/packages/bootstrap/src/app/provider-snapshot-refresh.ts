/**
 * CLI 启动边界投影出的 Personal Provider 运行时快照。
 *
 * Provider Registry 只读取投影文件，桌面/Web/CLI 新增模型只写统一 config.json；协议请求若
 * 只刷新 Registry，会读到尚未重新投影的旧快照（"模型不存在"）。启动边界注册重新投影函数，
 * 协议层就能在需要配置确定性的请求前主动刷新。
 */
type CliProviderSnapshotRefresher = () => Promise<void>;

let refresher: CliProviderSnapshotRefresher | null = null;

export function setCliProviderSnapshotRefresher(next: CliProviderSnapshotRefresher | null): void {
  refresher = next;
}

/** 按需重新投影本进程的运行时快照；未注册（一次性命令）时不做任何事。 */
export async function refreshCliProviderSnapshot(): Promise<void> {
  await refresher?.();
}
