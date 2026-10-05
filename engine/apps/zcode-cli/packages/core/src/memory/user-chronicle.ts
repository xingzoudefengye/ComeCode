import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  boundSessionChronicle,
  formatSessionChronicle,
  sanitizeChronicleText,
  summarizeChronicleTurn,
  type ChronicleEntry,
  type ChronicleTurn,
} from "../compact/chronicle.js";
import {
  readBoundedTextFile,
  withShortFileTransaction,
  writeTransactionTextFile,
} from "./file-transaction.js";

export const USER_CHRONICLE_MAX_CHARS = 6_000;
const MAX_FILE_BYTES = USER_CHRONICLE_MAX_CHARS * 4;
const MAX_INPUT_CHARS = 16_384;
const MAX_KEY_CHARS = 4_096;
const MAX_ENTRIES = 22;
const DAY_MS = 86_400_000;
const EARLIER_AGE_MS = 7 * DAY_MS;
const OLDEST_AGE_MS = 30 * DAY_MS;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const SUMMARY_LIMIT = { recent: 160, earlier: 100, oldest: 60 } as const;
const STATUSES = new Set(["success", "failed", "cancelled", "blocked"]);
export interface UserChronicleEntry extends ChronicleEntry {
  source: string;
}
export interface UserMemoryChronicle {
  version: 1;
  entries: UserChronicleEntry[];
}
interface AppendInput {
  /** resolveUserMemoryRoot(cliStorageRoot)，不是项目目录。 */
  root: string;
  turn: ChronicleTurn;
  projectKey: string;
  sessionId: string;
  now?: number;
}
const empty = (): UserMemoryChronicle => ({ version: 1, entries: [] });
function timestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIMESTAMP
  );
}
function validateKey(value: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_KEY_CHARS ||
    /\p{Cc}/u.test(value)
  )
    throw new Error("Invalid user chronicle identity");
}
function hash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}
function safeText(text: string, limit: number): string {
  return sanitizeChronicleText(
    text
      .slice(0, MAX_INPUT_CHARS)
      .replace(/`[^`]*(?:`|$)/gu, "[代码省略]")
      .replace(
        /(?:^|\n)[^\n]*(?:\b(?:const|let|var|function|class|import|return)\b|=>|[{};=])[^\n]*/gu,
        "[代码省略]",
      )
      .replace(
        /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\b[\w.-]+\.(?:com|org|net|io|dev|invalid|local)(?::\d+)?\b|\b(?:[a-f\d]{0,4}:){2,}[a-f\d:]+\b/giu,
        "[地址省略]",
      ),
    limit,
  );
}
export function createUserChronicleEntry(
  input: Pick<AppendInput, "turn" | "projectKey" | "sessionId">,
): UserChronicleEntry {
  validateKey(input.projectKey);
  validateKey(input.sessionId);
  const turn = input.turn;
  validateKey(turn.origin.turnId);
  if (
    !Number.isSafeInteger(turn.origin.branchGeneration) ||
    turn.origin.branchGeneration < 0 ||
    !timestamp(turn.endedAt) ||
    !STATUSES.has(turn.status) ||
    typeof turn.goal !== "string" ||
    turn.goal.length > MAX_INPUT_CHARS ||
    (turn.response !== undefined &&
      (typeof turn.response !== "string" || turn.response.length > MAX_INPUT_CHARS))
  )
    throw new Error("Invalid user chronicle turn");
  return {
    origin: {
      turnId: hash([input.sessionId, turn.origin.turnId, turn.origin.branchGeneration]),
      branchGeneration: 0,
    },
    source: `project-${hash([input.projectKey])}`,
    summary: summarizeChronicleTurn({
      goal: safeText(turn.goal, 72),
      response: safeText(turn.response ?? "", 64),
      status: turn.status,
    }),
    status: turn.status,
    endedAt: turn.endedAt,
    startedAt: turn.endedAt,
    count: 1,
    recency: "recent",
  };
}

/** 复用会话史书分层算法；来源混合时只保留回合范围，不产生全局项目事实。 */
export function boundUserMemoryChronicle(
  value: UserMemoryChronicle,
  now = Date.now(),
): UserMemoryChronicle {
  if (!timestamp(now)) throw new Error("Invalid user chronicle clock");
  const entries = value.entries
    .map((entry) => {
      const age = now - entry.endedAt;
      const recency =
        age >= OLDEST_AGE_MS || entry.recency === "oldest"
          ? "oldest"
          : age >= EARLIER_AGE_MS || entry.recency === "earlier"
            ? "earlier"
            : "recent";
      return { ...entry, origin: { ...entry.origin }, recency } as UserChronicleEntry;
    })
    .sort((a, b) => a.endedAt - b.endedAt);
  const bounded = boundSessionChronicle({
    version: 1,
    entries: entries.map((entry) => ({
      ...entry,
      origin: {
        ...entry.origin,
        messageStartId: entry.origin.turnId,
        messageEndId: entry.origin.turnId,
      },
    })),
  });
  const result: UserMemoryChronicle = {
    version: 1,
    entries: bounded.entries.map((entry) => {
      const start = entries.findIndex((item) => item.origin.turnId === entry.origin.messageStartId);
      const end = entries.findIndex((item) => item.origin.turnId === entry.origin.messageEndId);
      const sources = new Set(
        entries.slice(Math.max(0, start), end + 1).map((item) => item.source),
      );
      const source = sources.size === 1 ? [...sources][0]! : "mixed";
      return {
        ...entry,
        origin: { turnId: entry.origin.turnId, branchGeneration: 0 },
        source,
        summary:
          source === "mixed"
            ? "来源混合：多个项目的历史回合；目标完成未经核验，项目细节已省略。"
            : safeText(entry.summary, SUMMARY_LIMIT[entry.recency]),
      };
    }),
  };
  const size = () => JSON.stringify(result).length;
  for (const layer of ["oldest", "earlier", "recent"] as const) {
    for (const entry of result.entries.filter((item) => item.recency === layer)) {
      if (size() <= USER_CHRONICLE_MAX_CHARS) break;
      entry.summary = entry.summary.slice(
        0,
        Math.max(32, entry.summary.length - (size() - USER_CHRONICLE_MAX_CHARS)),
      );
    }
  }
  while (size() > USER_CHRONICLE_MAX_CHARS) result.entries.shift();
  return result;
}

function parseStored(raw: string): UserMemoryChronicle {
  if (raw.length > USER_CHRONICLE_MAX_CHARS || raw.includes("\ufffd"))
    throw new Error("Invalid user chronicle file");
  const value = JSON.parse(raw) as UserMemoryChronicle;
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES ||
    Object.keys(value).some((key) => !["version", "entries"].includes(key))
  )
    throw new Error("Invalid user chronicle schema");
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !entry.origin ||
      !/^[a-f\d]{32}$/u.test(entry.origin.turnId) ||
      entry.origin.branchGeneration !== 0 ||
      Object.keys(entry.origin).some((key) => !["turnId", "branchGeneration"].includes(key)) ||
      Object.keys(entry).some(
        (key) =>
          ![
            "origin",
            "source",
            "summary",
            "status",
            "endedAt",
            "startedAt",
            "count",
            "recency",
          ].includes(key),
      ) ||
      typeof entry.source !== "string" ||
      !/^(?:project-[a-f\d]{32}|mixed)$/u.test(entry.source) ||
      !STATUSES.has(entry.status) ||
      !timestamp(entry.endedAt) ||
      !timestamp(entry.startedAt) ||
      entry.startedAt > entry.endedAt ||
      !Number.isSafeInteger(entry.count) ||
      entry.count! < 1 ||
      !Object.hasOwn(SUMMARY_LIMIT, entry.recency) ||
      typeof entry.summary !== "string" ||
      entry.summary.length > SUMMARY_LIMIT[entry.recency] ||
      seen.has(entry.origin.turnId)
    )
      throw new Error("Invalid user chronicle entry");
    seen.add(entry.origin.turnId);
  }
  return value;
}

export async function loadUserMemoryChronicle(input: {
  root: string;
  now?: number;
}): Promise<UserMemoryChronicle> {
  validateKey(input.root);
  try {
    const raw = await readBoundedTextFile(join(input.root, "chronicle.json"), MAX_FILE_BYTES);
    return raw === null ? empty() : boundUserMemoryChronicle(parseStored(raw), input.now);
  } catch {
    // 只读失败可降级为空；追加仍严格拒绝覆盖原文件。
    return empty();
  }
}
export async function appendUserMemoryChronicle(input: AppendInput): Promise<UserMemoryChronicle> {
  validateKey(input.root);
  const entry = createUserChronicleEntry(input);
  const now = input.now ?? Date.now();
  if (!timestamp(now)) throw new Error("Invalid user chronicle clock");
  const file = join(input.root, "chronicle.json");
  return withShortFileTransaction(file, async () => {
    const raw = await readBoundedTextFile(file, MAX_FILE_BYTES);
    const current = raw === null ? empty() : parseStored(raw);
    const next = boundUserMemoryChronicle(
      {
        version: 1,
        entries: [
          ...current.entries.filter((item) => item.origin.turnId !== entry.origin.turnId),
          entry,
        ],
      },
      now,
    );
    await writeTransactionTextFile(file, JSON.stringify(next));
    return next;
  });
}
export function formatUserMemoryChronicle(
  value: UserMemoryChronicle,
  options: { query?: string; maxChars?: number; now?: number } = {},
): string {
  const bounded = boundUserMemoryChronicle(value, options.now);
  return formatSessionChronicle(
    {
      version: 1,
      entries: bounded.entries.map((entry) => ({
        ...entry,
        summary: `[${entry.source === "mixed" ? "来源混合" : entry.source}] ${entry.summary}`,
      })),
    },
    options,
  );
}
