export type ForkCommitFaultStage =
  | "afterChild"
  | "afterMessages"
  | "afterGoal"
  | "afterEntries"
  | "afterInput"
  | "afterCommandFact"
  | "beforeCommit";

export interface SqliteSessionStoreOptions {
  dbPath?: string;
  /** 只读查询不创建目录/数据库，也不运行迁移；写入由 SQLite 拒绝。 */
  readOnly?: boolean;
  /** 仅供事务原子性测试；生产调用不得设置。 */
  forkCommitFaultAt?: ForkCommitFaultStage;
  /** 仅供启动锁等待边界测试；生产调用使用默认值。 */
  startupLockTimeoutMs?: number;
}

export interface SessionStoreDebugCounts {
  sessions: number;
  messages: number;
  parts: number;
  todos: number;
  targets: number;
  sessionEntries: number;
  permissions: number;
  localSettings: number;
  schemaMigrations: number;
  inputHistory: number;
  modelUsage: number;
  toolUsage: number;
  turnUsage: number;
}
