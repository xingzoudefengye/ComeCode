import type { Logger, SessionId, SessionStorePort } from "@zcode/contracts";
import {
  appendChronicleTurn,
  filterSessionChronicle,
  parseSessionChronicle,
  serializeSessionChronicle,
  type ChronicleScope,
  type ChronicleTurn,
  type SessionChronicle,
} from "../../compact/chronicle.js";

export const SESSION_CHRONICLE_ENTRY_TYPE = "runtime/session_chronicle";
const pendingWrites = new WeakMap<SessionStorePort, Map<SessionId, Promise<unknown>>>();
function entryId(sessionId: SessionId): string {
  return `${sessionId}:chronicle`;
}

/** 仅读取固定 entry；缺失/损坏/旧宿主返回空，IO 失败向调用边界传播。 */
export async function loadSessionChronicle(input: {
  sessionStore?: SessionStorePort;
  sessionId: SessionId;
  scope?: ChronicleScope;
}): Promise<SessionChronicle> {
  const entries = await input.sessionStore?.sessionEntries?.({
    sessionID: input.sessionId,
    type: SESSION_CHRONICLE_ENTRY_TYPE,
  });
  const entry = entries?.find(
    (item) =>
      item.id === entryId(input.sessionId) &&
      item.sessionID === input.sessionId &&
      item.type === SESSION_CHRONICLE_ENTRY_TYPE,
  );
  return filterSessionChronicle(parseSessionChronicle(entry?.data), input.scope);
}

/** 同 store/session 的读改写串行；只存一个覆盖更新的 id，不读取消息/文件/模型。 */
export async function appendSessionChronicle(input: {
  sessionStore?: SessionStorePort;
  sessionId: SessionId;
  turn: ChronicleTurn;
  now?: number;
}): Promise<SessionChronicle | null> {
  const store = input.sessionStore;
  if (!store?.sessionEntries || !store.saveSessionEntry) return null;
  let sessions = pendingWrites.get(store);
  if (!sessions) {
    sessions = new Map();
    pendingWrites.set(store, sessions);
  }
  const previous = sessions.get(input.sessionId);
  const write = (previous ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const current = await loadSessionChronicle(input);
      const next = appendChronicleTurn(current, input.turn);
      const now = input.now ?? input.turn.endedAt;
      await store.saveSessionEntry!({
        id: entryId(input.sessionId),
        sessionID: input.sessionId,
        type: SESSION_CHRONICLE_ENTRY_TYPE,
        touchSession: false,
        time: { created: now, updated: now },
        data: serializeSessionChronicle(next),
      });
      return next;
    });
  sessions.set(input.sessionId, write);
  try {
    return await write;
  } finally {
    if (sessions.get(input.sessionId) === write) sessions.delete(input.sessionId);
  }
}

/** 史书是派生历史；失败只能警告，不覆盖原 turn 结果，也不打印原始异常。 */
export async function persistTurnChronicle(input: {
  sessionStore?: SessionStorePort;
  sessionId: SessionId;
  sessionPersisted: boolean;
  turn: ChronicleTurn;
  logger?: Logger;
}): Promise<void> {
  if (!input.sessionPersisted) return;
  try {
    await appendSessionChronicle(input);
  } catch {
    input.logger?.warn("本地会话史书保存失败；回合结果未改变", {
      event: "session.chronicle.persistence_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}
