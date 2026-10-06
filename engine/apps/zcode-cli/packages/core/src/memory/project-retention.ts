import { Lexer, type Tokens } from "marked";
import { PROJECT_MEMORY_FILES, type ProjectMemoryFileName } from "./project-files.js";

export const PROJECT_MEMORY_STORAGE_MAX_CHARS = 24_000;
export const PROJECT_MEMORY_STORAGE_MAX_BYTES = 65_536;
export const PROJECT_MEMORY_TARGET_CHARS = 19_000;
export const PROJECT_MEMORY_SOFT_QUOTAS: Readonly<Record<ProjectMemoryFileName, number>> = {
  "project.md": 4_000,
  "decisions.md": 6_000,
  "tasks.md": 5_000,
  "bugs.md": 5_000,
  "memory.md": 4_000,
};
const PHASE_AGE_DAYS = 7;
const EARLY_AGE_DAYS = 30;
const DAY_MS = 86_400_000;
const MARKED_ENTRY =
  /^- (\d{4}-\d{2}-\d{2}) \[id=([^\]]+)\] \[status=(active|done|resolved|superseded)\] \[kind=(constraint|decision|task|bug|fact|history)\]:[ \t]?(.*)$/u;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const COMPLETE_CHECKBOX = /^\s*-\s*\[[xX]\]\s+/u;

export type ProjectMemoryStatus = "active" | "done" | "resolved" | "superseded";
export type ProjectMemoryKind = "constraint" | "decision" | "task" | "bug" | "fact" | "history";
export interface ProjectMemoryEntry {
  date: string;
  id: string;
  status: ProjectMemoryStatus;
  kind: ProjectMemoryKind;
  conclusion: string;
  details?: string[];
}
export interface ProjectMemoryUsage {
  chars: number;
  bytes: number;
  files: Readonly<Record<ProjectMemoryFileName, { chars: number; bytes: number }>>;
}
export interface ProjectMemoryChange {
  file: ProjectMemoryFileName;
  beforeChars: number;
  afterChars: number;
  reason: string;
}
export interface ProjectMemoryRetentionPlan {
  files: Record<ProjectMemoryFileName, string>;
  before: Record<ProjectMemoryFileName, string>;
  beforeUsage: ProjectMemoryUsage;
  afterUsage: ProjectMemoryUsage;
  changes: ProjectMemoryChange[];
  fits: boolean;
  needsSemanticCompaction: boolean;
}
export class ProjectMemoryCapacityError extends Error {
  readonly code = "project_memory_protected_overflow";
}

export function storageUsage(
  files: Readonly<Partial<Record<ProjectMemoryFileName, string>>>,
): ProjectMemoryUsage {
  const details = {} as Record<ProjectMemoryFileName, { chars: number; bytes: number }>;
  let chars = 0;
  let bytes = 0;
  for (const file of PROJECT_MEMORY_FILES) {
    const content = files[file] ?? "";
    const item = { chars: content.length, bytes: Buffer.byteLength(content, "utf8") };
    details[file] = item;
    chars += item.chars;
    bytes += item.bytes;
  }
  return { chars, bytes, files: details };
}

export function assertProjectMemoryStorageBudget(
  files: Readonly<Partial<Record<ProjectMemoryFileName, string>>>,
): ProjectMemoryUsage {
  const usage = storageUsage(files);
  if (
    usage.chars > PROJECT_MEMORY_STORAGE_MAX_CHARS ||
    usage.bytes > PROJECT_MEMORY_STORAGE_MAX_BYTES
  )
    throw new ProjectMemoryCapacityError(
      `Project memory storage budget exceeded: ${usage.chars}/${PROJECT_MEMORY_STORAGE_MAX_CHARS} chars, ${usage.bytes}/${PROJECT_MEMORY_STORAGE_MAX_BYTES} UTF-8 bytes`,
    );
  return usage;
}

export function formatProjectMemoryEntry(entry: ProjectMemoryEntry): string {
  return [
    `- ${entry.date} [id=${entry.id}] [status=${entry.status}] [kind=${entry.kind}]: ${entry.conclusion}`,
    ...(entry.details ?? []).map((detail) => `  ${detail}`),
  ].join("\n");
}

export function parseProjectMemoryEntry(text: string): ProjectMemoryEntry | undefined {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const match = MARKED_ENTRY.exec(lines[0] ?? "");
  const conclusion = match?.[5]?.trim();
  if (!match || !validDate(match[1]!) || !/^[A-Za-z0-9._-]{1,80}$/u.test(match[2]!) || !conclusion)
    return undefined;
  const details = lines.slice(1).filter((line) => line.trim().length > 0);
  return {
    date: match[1]!,
    id: match[2]!,
    status: match[3]! as ProjectMemoryStatus,
    kind: match[4]! as ProjectMemoryKind,
    conclusion: match[5]!,
    ...(details.length ? { details } : {}),
  };
}

export function compactProjectMemoryFile(
  file: ProjectMemoryFileName,
  content: string,
  options: { now?: Date | string; pressure?: number } = {},
): { content: string; changed: boolean; needsSemanticCompaction: boolean } {
  const pressure = Math.max(0, options.pressure ?? 1);
  const plan = planProjectMemoryRetention(
    Object.fromEntries(PROJECT_MEMORY_FILES.map((name) => [name, name === file ? content : ""])),
    {
      now: options.now,
      targetChars: Math.max(1, Math.floor(PROJECT_MEMORY_SOFT_QUOTAS[file] / pressure)),
    },
  );
  const compacted = plan.files[file];
  return {
    content: compacted,
    changed: compacted !== content,
    needsSemanticCompaction: plan.needsSemanticCompaction,
  };
}

export function planProjectMemoryRetention(
  input: Readonly<Partial<Record<ProjectMemoryFileName, string>>>,
  options: { now?: Date | string; targetChars?: number } = {},
): ProjectMemoryRetentionPlan {
  const before = Object.fromEntries(
    PROJECT_MEMORY_FILES.map((file) => [file, input[file] ?? ""]),
  ) as Record<ProjectMemoryFileName, string>;
  const allUnits = PROJECT_MEMORY_FILES.flatMap((file) => parseUnits(file, before[file]));
  const winners = new Map<string, Unit>();
  for (const unit of allUnits) {
    if (!unit.entry) continue;
    const previous = winners.get(unit.entry.id);
    if (
      previous &&
      previous.entry!.date === unit.entry.date &&
      previous.raw.trim() !== unit.raw.trim()
    )
      throw new Error(`Ambiguous project memory id/date: ${unit.entry.id} ${unit.entry.date}`);
    if (!previous || unit.entry.date > previous.entry!.date) winners.set(unit.entry.id, unit);
  }
  const now = normalizeNow(options.now);
  const selected = new Set<Unit>();
  const seen = new Set<string>();
  for (const unit of allUnits) {
    const key = `${unit.file}:${unit.raw.trim()}`;
    if (seen.has(key) && unit.entry) continue;
    seen.add(key);
    if (!unit.entry) {
      if (!isCompletedLegacy(unit.raw)) selected.add(unit);
      continue;
    }
    if (winners.get(unit.entry.id) !== unit || unit.entry.status === "superseded") continue;
    const raw = ageDetails(unit.raw, unit.entry, now);
    selected.add({ ...unit, raw });
  }
  let output = renderUnits(selected);
  const target = Math.min(
    PROJECT_MEMORY_STORAGE_MAX_CHARS,
    Math.max(0, options.targetChars ?? PROJECT_MEMORY_TARGET_CHARS),
  );
  let usage = storageUsage(output);
  if (overLimit(usage, target)) {
    const compactable = [...selected]
      .filter((unit) => unit.entry && !isProtected(unit.entry) && hasNestedDetails(unit.raw))
      .sort((a, b) => removalScore(a, usage) - removalScore(b, usage));
    for (const unit of compactable) {
      if (!overLimit(usage, target)) break;
      selected.delete(unit);
      selected.add({ ...unit, raw: headline(unit.raw) });
      output = renderUnits(selected);
      usage = storageUsage(output);
    }
  }
  const removable = [...selected]
    .filter((unit) => unit.entry && !isProtected(unit.entry))
    .sort((a, b) => removalScore(a, usage) - removalScore(b, usage));
  for (const unit of removable) {
    if (!overLimit(usage, target)) break;
    selected.delete(unit);
    output = renderUnits(selected);
    usage = storageUsage(output);
  }
  const protectedUsage = storageUsage(
    renderUnits(new Set([...selected].filter((unit) => unit.entry && isProtected(unit.entry)))),
  );
  if (
    protectedUsage.chars > PROJECT_MEMORY_STORAGE_MAX_CHARS ||
    protectedUsage.bytes > PROJECT_MEMORY_STORAGE_MAX_BYTES
  )
    throw new ProjectMemoryCapacityError(
      "Protected project memory entries exceed the hard storage budget",
    );
  const beforeUsage = storageUsage(before);
  const afterUsage = storageUsage(output);
  const changes = PROJECT_MEMORY_FILES.filter((file) => before[file] !== output[file]).map(
    (file) => ({
      file,
      beforeChars: before[file].length,
      afterChars: output[file].length,
      reason: "dedupe, aging, completed cleanup, or bounded retention",
    }),
  );
  return {
    files: output,
    before,
    beforeUsage,
    afterUsage,
    changes,
    fits:
      afterUsage.chars <= PROJECT_MEMORY_STORAGE_MAX_CHARS &&
      afterUsage.bytes <= PROJECT_MEMORY_STORAGE_MAX_BYTES,
    needsSemanticCompaction: overLimit(afterUsage, target),
  };
}

interface Unit {
  file: ProjectMemoryFileName;
  raw: string;
  entry?: ProjectMemoryEntry;
  order: number;
}
function parseUnits(file: ProjectMemoryFileName, content: string): Unit[] {
  const result: Unit[] = [];
  for (const token of Lexer.lex(content.replace(/\r\n/gu, "\n"))) {
    if (token.type !== "list") {
      result.push({ file, raw: token.raw, order: result.length });
      continue;
    }
    for (const item of token.items) {
      const raw = item.raw;
      if (item.task && item.checked) continue;
      result.push({ file, raw, entry: parseProjectMemoryEntry(raw), order: result.length });
    }
  }
  return result;
}
function renderUnits(units: Set<Unit>): Record<ProjectMemoryFileName, string> {
  const result = {} as Record<ProjectMemoryFileName, string>;
  for (const file of PROJECT_MEMORY_FILES)
    result[file] = [...units]
      .filter((unit) => unit.file === file)
      .sort((a, b) => a.order - b.order)
      .map((unit) => unit.raw)
      .reduce((text, raw) => text + (text && !text.endsWith("\n") ? "\n" : "") + raw, "");
  return result;
}
function ageDetails(raw: string, entry: ProjectMemoryEntry, now: Date): string {
  if (isProtected(entry)) return raw;
  const age = (now.getTime() - dateTime(entry.date)) / DAY_MS;
  if (age < PHASE_AGE_DAYS) return raw;
  const detailUnits = nestedDetailUnits(raw);
  const dated = detailUnits.filter((unit) => {
    const date = detailDate(unit);
    return date && (now.getTime() - dateTime(date)) / DAY_MS < EARLY_AGE_DAYS;
  });
  const retained = age >= EARLY_AGE_DAYS ? dated : detailUnits.slice(-2);
  return retained.length ? `${headline(raw)}\n${retained.join("\n")}` : headline(raw);
}
function nestedDetailUnits(raw: string): string[] {
  const body = raw.split("\n").slice(1).join("\n");
  const indent = body.match(/^ +(?=\S)/mu)?.[0].length;
  if (!indent) return [];
  const dedented = body
    .split("\n")
    .map((line) => line.slice(Math.min(indent, line.match(/^ */u)![0].length)))
    .join("\n");
  const units: string[] = [];
  for (const token of Lexer.lex(dedented)) {
    if (token.type === "space") continue;
    const parts =
      token.type === "list" ? token.items.map((item: Tokens.ListItem) => item.raw) : [token.raw];
    for (const part of parts)
      units.push(
        part
          .trimEnd()
          .split("\n")
          .map((line: string) => " ".repeat(indent) + line)
          .join("\n"),
      );
  }
  return units;
}
function detailDate(line: string): string | undefined {
  const match = /(?:^|\s)(\d{4}-\d{2}-\d{2})(?:\s|:)/u.exec(line);
  return match && validDate(match[1]!) ? match[1] : undefined;
}
function isProtected(entry: ProjectMemoryEntry): boolean {
  return (
    (entry.kind === "constraint" && entry.status === "active") ||
    (entry.kind === "decision" && entry.status === "active") ||
    (entry.kind === "task" && entry.status === "active") ||
    (entry.kind === "bug" && entry.status === "active")
  );
}
function removalScore(unit: Unit, usage: ProjectMemoryUsage): number {
  const entry = unit.entry!;
  const overQuota = usage.files[unit.file].chars > PROJECT_MEMORY_SOFT_QUOTAS[unit.file] ? -30 : 0;
  const status =
    entry.status === "done" || entry.status === "resolved" ? 0 : entry.kind === "history" ? 2 : 5;
  return overQuota + status + dateTime(entry.date) / 1e12;
}
function headline(raw: string): string {
  return raw.split("\n", 1)[0]!;
}
function hasNestedDetails(raw: string): boolean {
  return raw.includes("\n");
}
function isCompletedLegacy(raw: string): boolean {
  return COMPLETE_CHECKBOX.test(raw.trim());
}
function overLimit(usage: ProjectMemoryUsage, targetChars: number): boolean {
  return (
    usage.chars > targetChars ||
    usage.chars > PROJECT_MEMORY_STORAGE_MAX_CHARS ||
    usage.bytes > PROJECT_MEMORY_STORAGE_MAX_BYTES
  );
}
function validDate(value: string): boolean {
  const match = DATE_ONLY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}
function dateTime(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}
function normalizeNow(value?: Date | string): Date {
  const result = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(result.getTime())) throw new Error("Invalid retention now");
  return result;
}
