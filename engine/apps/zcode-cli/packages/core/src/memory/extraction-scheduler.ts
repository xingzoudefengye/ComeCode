import type { MessageId } from "@zcode/contracts";
import { evaluateMemoryExtraction } from "./extraction-policy.js";
import type {
  MemoryExtractionScheduler,
  MemoryExtractionSnapshot,
  MemoryExtractionExecutionStatus,
  MemoryExtractionExecutionInput,
  MemoryExtractionScheduleOptions,
} from "./extraction.js";
import {
  MEMORY_EXTRACTION_BATCH_CHARS,
  MEMORY_EXTRACTION_BATCH_MESSAGES,
  selectMemoryExtractionBatch,
} from "./extraction-batch.js";
import type {
  MemoryExtractionProgress,
  MemoryExtractionProgressStore,
} from "./extraction-progress.js";

const RETRY_DELAY_MS = 60_000;

export function createMemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
>(
  execute: (
    input: Omit<MemoryExtractionExecutionInput, "snapshot"> & { snapshot: TSnapshot },
  ) => Promise<MemoryExtractionExecutionStatus>,
  options: {
    batch?: boolean;
    progressStore?: MemoryExtractionProgressStore;
    onError?: (error: unknown) => void;
  } = {},
): MemoryExtractionScheduler<TSnapshot> {
  let progress: MemoryExtractionProgress = {};
  let loaded = false;
  let persisted = false;
  let latestPending: Work<TSnapshot> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const controller = new AbortController();

  async function save() {
    await options.progressStore?.save(progress);
    persisted = true;
  }

  async function processSnapshot(work: Work<TSnapshot>) {
    const snapshot = await work.snapshot;
    if (!loaded) {
      const stored = await options.progressStore?.load();
      progress = stored ?? {};
      persisted = stored !== undefined;
      loaded = true;
    }
    if (
      options.batch &&
      [progress.cursor, progress.pending].some(
        (id) => id && !snapshot.durableMessages.some((message) => message.info.id === id),
      )
    ) {
      // 回退移除进度边界后，不能把游标缺失当成首次提取而重发全部历史。
      progress = { cursor: snapshot.boundaryMessageId };
      await save();
      return;
    }
    if (work.options.resumeOnly && (!persisted || !progress.pending)) {
      if (!persisted) progress.cursor = snapshot.boundaryMessageId;
      return;
    }
    const batch = options.batch
      ? selectMemoryExtractionBatch(snapshot.durableMessages, progress.cursor)
      : {
          messages: snapshot.durableMessages,
          userCount: Infinity,
          evidenceCount: Infinity,
          chars: Infinity,
        };
    const boundary = batch.messages.at(-1)?.info.id;
    if (!boundary) return;
    // pending 先落盘；关闭后仍完成这次本地写入，但不能再启动模型。
    progress = { ...progress, pending: snapshot.boundaryMessageId };
    await save();
    if (shuttingDown) return;
    const selected = { ...snapshot, durableMessages: batch.messages, boundaryMessageId: boundary };
    const decision = evaluateMemoryExtraction(
      selected,
      options.batch ? undefined : progress.cursor,
    );
    if (decision.decision === "skip") {
      progress = {
        cursor: boundary,
        pending: boundary === progress.pending ? undefined : progress.pending,
      };
      await save();
      return;
    }
    const force = work.options.force || work.options.resumeOnly;
    if (
      !force &&
      options.batch &&
      batch.evidenceCount === 0 &&
      batch.userCount < MEMORY_EXTRACTION_BATCH_MESSAGES &&
      batch.chars < MEMORY_EXTRACTION_BATCH_CHARS
    )
      return;
    if (!work.options.force && (progress.retryAfter ?? 0) > Date.now()) return;
    let status: MemoryExtractionExecutionStatus;
    try {
      const cursorIndex = progress.cursor
        ? selected.durableMessages.findIndex((message) => message.info.id === progress.cursor)
        : -1;
      status = await execute({
        abortSignal: controller.signal,
        messageCount: decision.messageCount,
        snapshot: {
          ...selected,
          durableMessages: options.batch
            ? batch.messages
            : selected.durableMessages.slice(cursorIndex + 1),
        },
      });
    } catch (error) {
      options.onError?.(error);
      status = "error";
    }
    if (!shuttingDown && (status === "success" || status === "no-op")) {
      progress = {
        cursor: boundary,
        pending: boundary === progress.pending ? undefined : progress.pending,
      };
    } else if (status === "error") {
      progress = { ...progress, retryAfter: Date.now() + RETRY_DELAY_MS };
    }
    await save();
  }

  async function run(first: Work<TSnapshot>) {
    try {
      let current: Work<TSnapshot> | undefined = first;
      while (current) {
        try {
          await processSnapshot(current);
        } catch (error) {
          options.onError?.(error);
        }
        current = latestPending;
        latestPending = undefined;
      }
    } finally {
      running = undefined;
    }
  }

  return {
    async drain() {
      while (running) await running;
    },
    getCursor: () => progress.cursor as MessageId | undefined,
    hasPendingWork: () =>
      running !== undefined || latestPending !== undefined || progress.pending !== undefined,
    schedule(snapshot, scheduleOptions = {}) {
      if (shuttingDown) return;
      // acquisition 的错误立即被处理，避免合并覆盖的 Promise 变为未处理拒绝。
      const acquisition = Promise.resolve(snapshot).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const work: Work<TSnapshot> = {
        snapshot: acquisition.then((result) => {
          if ("error" in result) throw result.error;
          return result.value;
        }),
        options: scheduleOptions,
      };
      void work.snapshot.catch(() => {});
      if (running) {
        work.options = {
          ...scheduleOptions,
          force: scheduleOptions.force || latestPending?.options.force,
        };
        latestPending = work;
      } else {
        running = run(work);
      }
    },
    shutdown() {
      shuttingDown = true;
      controller.abort();
    },
  };
}

interface Work<TSnapshot> {
  snapshot: Promise<TSnapshot>;
  options: MemoryExtractionScheduleOptions;
}
