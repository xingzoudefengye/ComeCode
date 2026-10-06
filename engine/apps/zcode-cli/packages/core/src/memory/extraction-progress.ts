import type { MessageId, SessionId, SessionStorePort } from "@zcode/contracts";

export interface MemoryExtractionProgress {
  cursor?: MessageId;
  pending?: MessageId;
  retryAfter?: number;
}

export interface MemoryExtractionProgressStore {
  load(): Promise<MemoryExtractionProgress | undefined>;
  save(progress: MemoryExtractionProgress): Promise<void>;
}

const ENTRY_TYPE = "runtime/memory_extraction";

export function createMemoryExtractionProgressStore(
  store: SessionStorePort | undefined,
  sessionId: SessionId,
  scope: string,
): MemoryExtractionProgressStore | undefined {
  if (!store?.sessionEntries || !store.saveSessionEntry) return undefined;
  const id = `${sessionId}:memory-extraction`;
  return {
    async load() {
      const entries = await store.sessionEntries!({ sessionID: sessionId, type: ENTRY_TYPE });
      const data = entries.find((entry) => entry.id === id && entry.sessionID === sessionId)?.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
      const value = data as Record<string, unknown>;
      if (value.version !== 1 || value.scope !== scope) return undefined;
      if (value.cursor !== undefined && typeof value.cursor !== "string") return undefined;
      if (value.pending !== undefined && typeof value.pending !== "string") return undefined;
      return {
        cursor: value.cursor as MessageId | undefined,
        pending: value.pending as MessageId | undefined,
        retryAfter:
          typeof value.retryAfter === "number" && Number.isFinite(value.retryAfter)
            ? value.retryAfter
            : undefined,
      };
    },
    async save(progress) {
      const now = Date.now();
      await store.saveSessionEntry!({
        id,
        sessionID: sessionId,
        type: ENTRY_TYPE,
        touchSession: false,
        time: { created: now, updated: now },
        data: { version: 1, scope, ...progress },
      });
    },
  };
}
