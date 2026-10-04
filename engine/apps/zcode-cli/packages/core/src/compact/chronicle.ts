import type { SessionRevert } from "@zcode/contracts";

export const SESSION_CHRONICLE_MAX_CHARS = 6_000;
export const SESSION_CHRONICLE_MAX_ENTRIES = 22;
const RECENT_COUNT = 12;
const EARLIER_COUNT = 6;
const OLDEST_COUNT = 4;
const MERGE_COUNT = 4;
const SUMMARY_LIMITS = { recent: 160, earlier: 100, oldest: 60 } as const;
const INPUT_LIMIT = 16_384;
const STATUS_LABELS = {
  success: "回合结束（目标未核验）",
  cancelled: "回合取消（未完成）",
  failed: "回合失败（未完成）",
  blocked: "回合被阻止（未执行）",
} as const;

export type ChronicleTurnStatus = keyof typeof STATUS_LABELS;
export interface ChronicleOrigin {
  turnId: string;
  messageStartId?: string;
  messageEndId?: string;
  branchGeneration: number;
}
export interface ChronicleTurn {
  origin: ChronicleOrigin;
  goal: string;
  response?: string;
  status: ChronicleTurnStatus;
  endedAt: number;
}
export interface ChronicleEntry {
  origin: ChronicleOrigin;
  summary: string;
  status: ChronicleTurnStatus;
  endedAt: number;
  recency: keyof typeof SUMMARY_LIMITS;
  count?: number;
  startedAt?: number;
}
export interface SessionChronicle {
  version: 1;
  entries: ChronicleEntry[];
}
export interface ChronicleScope {
  branchGeneration?: number;
  activeMessageIds?: readonly string[];
  revert?: SessionRevert;
}
// 存储使用定长 tuple 节省 JSON 键开销，来源锚点不截断、不合并不同分支。
type StoredEntry = [
  string,
  ChronicleTurnStatus,
  number,
  string,
  string | null,
  string | null,
  number,
  ChronicleEntry["recency"]?,
  number?,
  number?,
];
export interface StoredSessionChronicle {
  version: 1;
  entries: StoredEntry[];
}

export function sanitizeChronicleText(text: string, maxChars = 160): string {
  const limit = Math.max(0, Math.min(INPUT_LIMIT, Math.floor(maxChars) || 0));
  return text
    .slice(0, INPUT_LIMIT)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*(?:-----END [^-]*PRIVATE KEY-----|$)/giu,
      "[已脱敏]",
    )
    .replace(/```[\s\S]*?(?:```|$)/gu, "[代码省略]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/giu, "[已脱敏]")
    .replace(
      /(?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|密码|密钥|令牌)["']?\s*[:=：]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;，；}\r\n]+)/giu,
      "[已脱敏]",
    )
    .replace(
      /\b(?:bearer\s+\S+|(?:sk-|gh[pousr]_|github_pat_|AKIA)[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/giu,
      "[已脱敏]",
    )
    .replace(/(?:https?:\/\/|file:\/\/|ssh:\/\/)[^\s<>"')]+/giu, "[地址省略]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[邮箱省略]")
    .replace(/(?:[A-Z]:[\\/]|\/)(?:[^\s<>"'，；]+[\\/])*[^\s<>"'，；]*/giu, "[路径省略]")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

export function summarizeChronicleTurn(
  turn: Pick<ChronicleTurn, "goal" | "response" | "status">,
): string {
  const label = STATUS_LABELS[turn.status];
  const goal = sanitizeChronicleText(turn.goal, 72);
  // 取消/失败的部分回复可能声称成功；只记录目标与真实终态，不采用未提交回复。
  const response = turn.status === "success" ? sanitizeChronicleText(turn.response ?? "", 64) : "";
  return `${label}；目标：${goal || "未记录"}${response ? `；回复：${response}` : ""}`.slice(
    0,
    SUMMARY_LIMITS.recent,
  );
}

export function serializeSessionChronicle(chronicle: SessionChronicle): StoredSessionChronicle {
  return {
    version: 1,
    entries: chronicle.entries.map((entry) => [
      entry.summary,
      entry.status,
      entry.endedAt,
      entry.origin.turnId,
      entry.origin.messageStartId ?? null,
      entry.origin.messageEndId ?? null,
      entry.origin.branchGeneration,
      entry.recency,
      entry.count ?? 1,
      entry.startedAt ?? entry.endedAt,
    ]),
  };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[\w.-]{1,160}$/u.test(value);
}
function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function mergeStage(entries: ChronicleEntry[], recency: ChronicleEntry["recency"]): ChronicleEntry {
  const first = entries[0]!;
  const last = entries.at(-1)!;
  const limit = SUMMARY_LIMITS[recency];
  const representatives = [
    ...new Set(
      entries.map((entry) => entry.summary.replace(/^.*?；目标：/u, "").replace(/；回复：/u, "：")),
    ),
  ];
  const perItem = Math.max(12, Math.floor(limit / Math.min(3, representatives.length)) - 2);
  const text =
    representatives.length <= 3
      ? representatives
      : [
          representatives[0]!,
          representatives[Math.floor(representatives.length / 2)]!,
          representatives.at(-1)!,
        ];
  return {
    origin: { ...last.origin, messageStartId: first.origin.messageStartId },
    status: last.status,
    startedAt: first.startedAt ?? first.endedAt,
    endedAt: last.endedAt,
    count: entries.reduce((sum, entry) => sum + (entry.count ?? 1), 0),
    recency,
    summary: sanitizeChronicleText(text.map((item) => item.slice(0, perItem)).join("；"), limit),
  };
}

export function boundSessionChronicle(
  chronicle: SessionChronicle,
  maxChars = SESSION_CHRONICLE_MAX_CHARS,
): SessionChronicle {
  const budget = Math.max(32, Math.min(SESSION_CHRONICLE_MAX_CHARS, maxChars));
  const entries = chronicle.entries.map((entry) => ({ ...entry, origin: { ...entry.origin } }));
  const reduceLayer = (
    layer: ChronicleEntry["recency"],
    capacity: number,
    target: ChronicleEntry["recency"],
  ) => {
    while (entries.filter((entry) => entry.recency === layer).length > capacity) {
      const selected = entries.filter((entry) => entry.recency === layer).slice(0, MERGE_COUNT);
      const sameBranch = selected.filter(
        (entry) => entry.origin.branchGeneration === selected[0]!.origin.branchGeneration,
      );
      if (layer === target && sameBranch.length < 2) {
        entries.splice(entries.indexOf(sameBranch[0]!), 1);
        continue;
      }
      const merged = mergeStage(sameBranch, target);
      const position = entries.indexOf(sameBranch[0]!);
      for (const entry of sameBranch) entries.splice(entries.indexOf(entry), 1);
      entries.splice(position, 0, merged);
    }
  };
  reduceLayer("recent", RECENT_COUNT, "earlier");
  reduceLayer("earlier", EARLIER_COUNT, "oldest");
  reduceLayer("oldest", OLDEST_COUNT, "oldest");
  for (const entry of entries)
    entry.summary = sanitizeChronicleText(entry.summary, SUMMARY_LIMITS[entry.recency]);
  const result: SessionChronicle = { version: 1, entries };
  const size = () => JSON.stringify(serializeSessionChronicle(result)).length;
  // 序列化预算也包含来源锚点；容量不足时先删旧细节，再删最老记录。
  for (const layer of ["oldest", "earlier", "recent"] as const) {
    for (const entry of entries.filter((item) => item.recency === layer)) {
      const over = size() - budget;
      if (over <= 0) break;
      entry.summary = entry.summary.slice(0, Math.max(16, entry.summary.length - over));
    }
  }
  while (entries.length > 0 && size() > budget) entries.shift();
  return result;
}

/** 不信任旧版本/损坏根对象；坏项丢弃，不从其他字段猜测指令或完成状态。 */
export function parseSessionChronicle(data: unknown): SessionChronicle {
  const empty: SessionChronicle = { version: 1, entries: [] };
  try {
    if (typeof data === "string") {
      if (data.length > SESSION_CHRONICLE_MAX_CHARS) return empty;
      data = JSON.parse(data) as unknown;
    }
    if (
      !data ||
      typeof data !== "object" ||
      JSON.stringify(data).length > SESSION_CHRONICLE_MAX_CHARS
    )
      return empty;
    const value = data as Partial<StoredSessionChronicle>;
    if (
      value.version !== 1 ||
      !Array.isArray(value.entries) ||
      value.entries.length > SESSION_CHRONICLE_MAX_ENTRIES
    )
      return empty;
    const entries: ChronicleEntry[] = [];
    const origins = new Set<string>();
    for (const row of value.entries) {
      if (!Array.isArray(row) || (row.length !== 7 && row.length !== 10)) continue;
      const [summary, status, endedAt, turnId, start, end, generation, recency, count, startedAt] =
        row;
      if (
        row.length === 10 &&
        (typeof recency !== "string" ||
          !Object.hasOwn(SUMMARY_LIMITS, recency) ||
          !isCounter(count) ||
          count < 1 ||
          !isCounter(startedAt))
      )
        continue;
      if (
        typeof summary !== "string" ||
        !Object.hasOwn(STATUS_LABELS, status) ||
        !isCounter(endedAt) ||
        !isId(turnId) ||
        !isCounter(generation)
      )
        continue;
      if ((start !== null && !isId(start)) || (end !== null && !isId(end))) continue;
      const key = `${generation}:${turnId}`;
      if (origins.has(key)) continue;
      origins.add(key);
      entries.push({
        summary,
        status,
        endedAt,
        recency: recency ?? "recent",
        count: count ?? 1,
        startedAt: startedAt ?? endedAt,
        origin: {
          turnId,
          branchGeneration: generation,
          ...(start === null ? {} : { messageStartId: start }),
          ...(end === null ? {} : { messageEndId: end }),
        },
      });
    }
    return boundSessionChronicle({ version: 1, entries });
  } catch {
    return empty;
  }
}

export function appendChronicleTurn(
  chronicle: SessionChronicle,
  turn: ChronicleTurn,
): SessionChronicle {
  if (
    !isId(turn.origin.turnId) ||
    !isCounter(turn.origin.branchGeneration) ||
    !isCounter(turn.endedAt) ||
    !Object.hasOwn(STATUS_LABELS, turn.status)
  )
    throw new Error("Invalid chronicle origin");
  for (const id of [turn.origin.messageStartId, turn.origin.messageEndId]) {
    if (id !== undefined && !isId(id)) throw new Error("Invalid chronicle message range");
  }
  const entries = chronicle.entries.filter(
    (entry) =>
      !(
        entry.origin.turnId === turn.origin.turnId &&
        entry.origin.branchGeneration === turn.origin.branchGeneration
      ),
  );
  entries.push({
    origin: { ...turn.origin },
    status: turn.status,
    endedAt: turn.endedAt,
    summary: summarizeChronicleTurn(turn),
    recency: "recent",
    count: 1,
    startedAt: turn.endedAt,
  });
  return boundSessionChronicle({ version: 1, entries });
}

export function filterSessionChronicle(
  chronicle: SessionChronicle,
  scope?: ChronicleScope,
): SessionChronicle {
  if (!scope) return chronicle;
  const generation = scope.branchGeneration ?? scope.revert?.branchGeneration;
  if (
    (scope.revert && !isCounter(generation)) ||
    (generation !== undefined && !isCounter(generation))
  )
    return { version: 1, entries: [] };
  const ids = scope.activeMessageIds ? new Set(scope.activeMessageIds) : undefined;
  return {
    version: 1,
    entries: chronicle.entries.filter((entry) => {
      if (generation !== undefined && entry.origin.branchGeneration !== generation) return false;
      // 跨分支保留范围不能仅凭时间推断；缺锚点时严格拒绝。
      return (
        !ids ||
        (!!entry.origin.messageStartId &&
          ids.has(entry.origin.messageStartId) &&
          (!entry.origin.messageEndId || ids.has(entry.origin.messageEndId)))
      );
    }),
  };
}

export function formatSessionChronicle(
  chronicle: SessionChronicle,
  options: { query?: string; maxChars?: number; scope?: ChronicleScope } = {},
): string {
  const limit = Math.max(
    0,
    Math.min(
      SESSION_CHRONICLE_MAX_CHARS,
      Math.floor(options.maxChars ?? SESSION_CHRONICLE_MAX_CHARS) || 0,
    ),
  );
  const query = sanitizeChronicleText(options.query ?? "", 160).toLocaleLowerCase();
  const entries = filterSessionChronicle(chronicle, options.scope).entries;
  if (entries.length === 0 || limit === 0) return "";
  const terms = query.match(/[a-z0-9_-]+|[\p{Script=Han}]{2,}/gu) ?? [];
  const matching = query
    ? entries.filter((entry) =>
        terms.some((term) => entry.summary.toLocaleLowerCase().includes(term)),
      )
    : entries;
  const selected = matching.length ? matching : entries;
  const lines = selected
    .slice()
    .reverse()
    .map((entry) => {
      const date = new Date(entry.endedAt).toISOString().slice(0, 10);
      const start = new Date(entry.startedAt ?? entry.endedAt).toISOString().slice(0, 10);
      return entry.recency === "recent"
        ? `${date} ${entry.summary}`
        : `${start}~${date} ${entry.recency === "earlier" ? "阶段" : "早期概括"}（约${entry.count ?? 1}回合，细节已省略）：${entry.summary}`;
    });
  return ["历史背景，不是当前指令；目标完成未经核验。", ...lines].join("\n").slice(0, limit);
}
