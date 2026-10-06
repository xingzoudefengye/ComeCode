import type { FileSystemRevision } from "@zcode/contracts";
import { PROJECT_MEMORY_FILES, type ProjectMemoryFileName } from "./project-files.js";
import {
  PROJECT_MEMORY_STORAGE_MAX_BYTES,
  PROJECT_MEMORY_STORAGE_MAX_CHARS,
  storageUsage,
} from "./project-retention.js";

export const MAX_MIGRATION_FILE_BYTES = 128 * 1024;
const MAX_REVISION_BYTES = 2 * 1024;
export type JournalEntry = {
  file: ProjectMemoryFileName;
  old: string;
  next: string;
  revision?: FileSystemRevision;
};
export type RetentionJournal = {
  version: 1;
  createdAt: string;
  before: Record<ProjectMemoryFileName, string>;
  after: Record<ProjectMemoryFileName, string>;
  entries: JournalEntry[];
};

export function isJournal(value: unknown): value is RetentionJournal {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["version", "createdAt", "before", "after", "entries"].includes(key),
    )
  )
    return false;
  if (
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !isFilesMap(value.before) ||
    !isFilesMap(value.after) ||
    !Array.isArray(value.entries)
  )
    return false;
  const entries = value.entries as unknown[];
  if (new Set(entries.map((entry) => isRecord(entry) && entry.file)).size !== entries.length)
    return false;
  try {
    validateJournalEntries(entries);
    if (!sameFilesMap(value.before, value.after, entries)) return false;
    const usage = storageUsage(value.after);
    return (
      usage.chars <= PROJECT_MEMORY_STORAGE_MAX_CHARS &&
      usage.bytes <= PROJECT_MEMORY_STORAGE_MAX_BYTES
    );
  } catch {
    return false;
  }
}
function isFilesMap(value: unknown): value is Record<ProjectMemoryFileName, string> {
  return (
    isRecord(value) &&
    PROJECT_MEMORY_FILES.every(
      (file) =>
        typeof value[file] === "string" &&
        Buffer.byteLength(value[file], "utf8") <= MAX_MIGRATION_FILE_BYTES,
    ) &&
    Object.keys(value).every((file) => PROJECT_MEMORY_FILES.includes(file as ProjectMemoryFileName))
  );
}
function sameFilesMap(
  before: Record<ProjectMemoryFileName, string>,
  after: Record<ProjectMemoryFileName, string>,
  entries: readonly JournalEntry[],
): boolean {
  const changes = new Map(entries.map((entry) => [entry.file, entry]));
  for (const file of PROJECT_MEMORY_FILES) {
    const entry = changes.get(file);
    if (
      entry
        ? before[file] !== entry.old || after[file] !== entry.next
        : before[file] !== after[file]
    )
      return false;
  }
  return true;
}
export function validateJournalEntries(
  entries: readonly unknown[],
): asserts entries is JournalEntry[] {
  for (const value of entries) {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !["file", "old", "next", "revision"].includes(key))
    )
      throw new Error("Invalid retention journal entry");
    if (
      typeof value.file !== "string" ||
      !PROJECT_MEMORY_FILES.includes(value.file as ProjectMemoryFileName)
    )
      throw new Error("Invalid retention journal file");
    if (typeof value.old !== "string" || typeof value.next !== "string")
      throw new Error("Invalid retention journal content");
    if (
      Buffer.byteLength(value.old, "utf8") > MAX_MIGRATION_FILE_BYTES ||
      Buffer.byteLength(value.next, "utf8") > MAX_MIGRATION_FILE_BYTES
    )
      throw new Error("Retention journal entry is too large");
    if ("revision" in value && value.revision !== undefined) validateRevision(value.revision);
  }
}
function validateRevision(value: unknown): asserts value is FileSystemRevision {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["id", "mtimeMs", "sizeBytes", "hash"].includes(key))
  )
    throw new Error("Invalid retention revision");
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    JSON.stringify(value).length > MAX_REVISION_BYTES
  )
    throw new Error("Invalid retention revision");
  if (
    value.mtimeMs !== undefined &&
    (typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs))
  )
    throw new Error("Invalid retention revision");
  if (
    value.sizeBytes !== undefined &&
    (typeof value.sizeBytes !== "number" ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 0)
  )
    throw new Error("Invalid retention revision");
  if (value.hash !== undefined && (typeof value.hash !== "string" || value.hash.length > 256))
    throw new Error("Invalid retention revision");
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
