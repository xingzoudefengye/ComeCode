import { existsSync } from "node:fs";
import { createConfig, ConfigEditError } from "@zcode/adapters/config";
import { acquireSessionWriterLease, createSqliteSessionStore } from "@zcode/adapters/storage";
import { getSessionDbPath, projectSessionTranscript } from "@zcode/bootstrap";
import type { SessionId } from "@zcode/contracts";

const PAGE_LIMIT = 100;
const HISTORY_LIMIT = 50;
const TEXT_LIMIT = 4000;

export function createAdminSessions(options: { env?: NodeJS.ProcessEnv; sessionDbPath?: string }) {
  let dbPath = options.sessionDbPath;
  const databasePath = () => dbPath ??= getSessionDbPath(createConfig({ env: options.env }));
  // 延迟打开同一份存储；配置管理不需要额外创建数据库。
  let store: ReturnType<typeof createSqliteSessionStore> | undefined;
  const storage = () => {
    if (!existsSync(databasePath())) return undefined;
    return store ??= createSqliteSessionStore({ dbPath: databasePath(), readOnly: true });
  };
  const find = async (id: SessionId) => {
    const session = await storage()?.getSession(id);
    if (!session) throw new ConfigEditError(404, "会话不存在");
    return session;
  };
  return {
    close: () => store?.close(),
    async list(url: URL) {
      const limit = integer(url.searchParams.get("limit"), 25, PAGE_LIMIT);
      const offset = integer(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);
      const search = url.searchParams.get("search") ?? "";
      if (search.length > 200) throw new ConfigEditError(400, "搜索文本过长");
      const archived = url.searchParams.get("archived");
      if (archived !== null && archived !== "true" && archived !== "false") throw new ConfigEditError(400, "归档参数无效");
      const rows = await storage()?.listSessions({ roots: true, archived: archived === "true", search, offset, limit: limit + 1 }) ?? [];
      return { sessions: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit };
    },
    async detail(id: SessionId, url: URL) {
      const session = await find(id);
      const offset = integer(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);
      const rows = await storage()!.messages({ sessionID: id, offset, limit: HISTORY_LIMIT + 1 });
      // 管理页只展示正文；工具/思考记录留在原始历史，不投影为空助手卡片。
      const messages = projectSessionTranscript(rows.slice(0, HISTORY_LIMIT))
        .filter((message) => message.content.trim().length > 0).map((message) => ({
        role: message.role,
        content: message.content.slice(0, TEXT_LIMIT),
        truncated: message.content.length > TEXT_LIMIT,
      }));
      return { session, messages, hasMore: rows.length > HISTORY_LIMIT, nextOffset: offset + HISTORY_LIMIT, resumeCommand: formatSessionResumeCommand(id, session.directory) };
    },
    async update(id: SessionId, body: unknown) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ConfigEditError(400, "会话修改格式无效");
      const input = body as Record<string, unknown>;
      if (Object.keys(input).some((key) => !["expectedUpdated", "title", "archived"].includes(key)) ||
        !Number.isSafeInteger(input.expectedUpdated) ||
        (input.title === undefined && input.archived === undefined) ||
        (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || Array.from(input.title.trim()).length > 30)) ||
        (input.archived !== undefined && typeof input.archived !== "boolean")) throw new ConfigEditError(400, "会话修改参数无效");
      await find(id);
      let release: () => Promise<void>;
      try { release = await acquireSessionWriterLease({ dbPath: databasePath(), sessionId: id }); }
      catch (error) {
        if ((error as { code?: string }).code === "COMECODE_SESSION_WRITER_BUSY") throw new ConfigEditError(409, "会话正在由 CLI 或桌面使用，请先关闭后修改");
        throw error;
      }
      try {
        const current = await find(id);
        if (current.time.updated !== input.expectedUpdated) throw new ConfigEditError(409, "会话已更新，请重新加载详情");
        const writer = createSqliteSessionStore({ dbPath: databasePath() });
        try { return await writer.updateSession({ id,
          timeUpdated: Math.max(Date.now(), current.time.updated + 1),
          ...(typeof input.title === "string" ? { title: input.title.trim(), titleSource: "custom" as const } : {}),
          ...(typeof input.archived === "boolean" ? { timeArchived: input.archived ? Date.now() : null } : {}),
        }); } finally { writer.close(); }
      } finally { await release(); }
    },
  };
}
export function formatSessionResumeCommand(id: string, directory: string, platform = process.platform): string {
  // JSON 字符串转义不是 shell 引用，尤其会把 PowerShell 路径的反斜杠重复一遍。
  const quote = (value: string) => "'" + value.replaceAll("'", platform === "win32" ? "''" : "'\"'\"'") + "'";
  return `comecode --resume ${quote(id)} --cwd ${quote(directory)}`;
}
function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new ConfigEditError(400, "分页参数无效");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max || (max === PAGE_LIMIT && parsed === 0)) throw new ConfigEditError(400, "分页参数超出范围");
  return parsed;
}
