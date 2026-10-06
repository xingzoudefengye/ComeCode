import { dirname, join } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemRevision,
} from "@zcode/contracts";
import { withShortFileTransaction } from "./file-transaction.js";
import { PROJECT_MEMORY_FILES, type ProjectMemoryFileName } from "./project-files.js";
import {
  planProjectMemoryRetention,
  PROJECT_MEMORY_STORAGE_MAX_BYTES,
  PROJECT_MEMORY_STORAGE_MAX_CHARS,
  storageUsage,
  type ProjectMemoryRetentionPlan,
  type ProjectMemoryUsage,
} from "./project-retention.js";
import { resolveAllowedMemoryAgentPath } from "./memory-agent-loop.js";

import {
  MAX_MIGRATION_FILE_BYTES,
  isJournal,
  validateJournalEntries,
  type JournalEntry,
  type RetentionJournal,
} from "./project-retention-journal.js";

const MAX_JOURNAL_BYTES = 512 * 1024;
const JOURNAL_NAME = ".local/retention-plan.json";
const BACKUP_NAME = ".local/retention-backup.json";
type MemorySnapshot = { content: string; revision?: FileSystemRevision };

export interface ProjectMemoryTransactionOptions {
  now?: Date | string;
  targetChars?: number;
  signal?: AbortSignal;
}
export interface ProjectMemoryTransactionPreview {
  plan: ProjectMemoryRetentionPlan;
  snapshots: Readonly<Record<ProjectMemoryFileName, MemorySnapshot>>;
}

/** rootDir 是实际的 .ai 根；锁固定为 .ai/.project-memory，避免绕过普通写入门。 */
export async function previewProjectMemoryRetention(
  port: FileSystemPort,
  rootDir: string,
  options: ProjectMemoryTransactionOptions = {},
): Promise<ProjectMemoryTransactionPreview> {
  const snapshots = await readMemoryFiles(port, rootDir, options.signal);
  return {
    plan: planProjectMemoryRetention(
      Object.fromEntries(PROJECT_MEMORY_FILES.map((file) => [file, snapshots[file]!.content])),
      options,
    ),
    snapshots,
  };
}

export async function applyProjectMemoryRetention(
  port: FileSystemPort,
  rootDir: string,
  preview: ProjectMemoryTransactionPreview,
  options: ProjectMemoryTransactionOptions = {},
): Promise<ProjectMemoryUsage> {
  if (!preview.plan.fits)
    throw new Error("Cannot apply project memory retention plan that does not fit");
  return withShortFileTransaction(join(rootDir, ".project-memory"), async () => {
    options.signal?.throwIfAborted();
    // 未恢复的 journal 是未完成事务，不能被新的 preview 覆盖。
    if (await readJournal(port, rootDir, options.signal))
      throw new Error("Project memory retention recovery is pending");
    const current = await readMemoryFiles(port, rootDir, options.signal);
    assertPreviewMatches(preview, current);
    const entries = makeEntries(preview.plan, preview.snapshots);
    if (entries.length === 0) return usageOf(current);
    const ordered = await preflightEntries(port, rootDir, entries, current, options.signal);
    await writeBackup(port, rootDir, entries, options.signal);
    await persistPlan(port, rootDir, entries, current, options.signal);
    await applyEntries(port, rootDir, entries, options.signal, ordered);
    await removeSafe(port, rootDir, JOURNAL_NAME, options.signal);
    return usageAfter(current, entries);
  });
}

export async function resumeProjectMemoryRetention(
  port: FileSystemPort,
  rootDir: string,
  options: Pick<ProjectMemoryTransactionOptions, "signal"> = {},
): Promise<ProjectMemoryUsage | undefined> {
  return withShortFileTransaction(join(rootDir, ".project-memory"), async () => {
    options.signal?.throwIfAborted();
    const journal = await readJournal(port, rootDir, options.signal);
    if (!journal) return undefined;
    const current = await readMemoryFiles(port, rootDir, options.signal);
    for (const file of PROJECT_MEMORY_FILES) {
      const text = current[file].content;
      if (text !== journal.before[file] && text !== journal.after[file])
        throw new Error(`Project memory external conflict: ${file}`);
    }
    const ordered = await preflightEntries(port, rootDir, journal.entries, current, options.signal);
    // 备份丢失或上次备份失败时，在任何记忆文件变更前补齐恢复副本。
    await writeBackup(port, rootDir, journal.entries, options.signal);
    await applyEntries(port, rootDir, journal.entries, options.signal, ordered);
    await removeSafe(port, rootDir, JOURNAL_NAME, options.signal);
    return usageOf(await readMemoryFiles(port, rootDir, options.signal));
  });
}

async function readMemoryFiles(
  port: FileSystemPort,
  rootDir: string,
  signal?: AbortSignal,
): Promise<Record<ProjectMemoryFileName, MemorySnapshot>> {
  const result = {} as Record<ProjectMemoryFileName, MemorySnapshot>;
  for (const file of PROJECT_MEMORY_FILES) {
    signal?.throwIfAborted();
    const path = await safePath(rootDir, file);
    try {
      const read = await port.readTextFile(
        { path, maxBytes: MAX_MIGRATION_FILE_BYTES },
        { signal },
      );
      if (read.truncated)
        throw new Error(`Project memory file exceeded ${MAX_MIGRATION_FILE_BYTES} bytes`);
      result[file] = { content: normalizeText(read.content), revision: read.revision };
    } catch (error) {
      if (!isFileSystemPortError(error) || error.code !== "not_found") throw error;
      result[file] = { content: "" };
    }
  }
  return result;
}
function makeEntries(
  plan: ProjectMemoryRetentionPlan,
  snapshots: Readonly<Record<ProjectMemoryFileName, MemorySnapshot>>,
): JournalEntry[] {
  return PROJECT_MEMORY_FILES.filter((file) => plan.files[file] !== snapshots[file]!.content).map(
    (file) => ({
      file,
      old: snapshots[file]!.content,
      next: normalizeText(plan.files[file]),
      revision: snapshots[file]!.revision,
    }),
  );
}
function usageOf(
  snapshots: Readonly<Record<ProjectMemoryFileName, MemorySnapshot>>,
): ProjectMemoryUsage {
  return storageUsage(
    Object.fromEntries(PROJECT_MEMORY_FILES.map((file) => [file, snapshots[file]!.content])),
  );
}
function usageAfter(
  current: Readonly<Record<ProjectMemoryFileName, MemorySnapshot>>,
  entries: readonly JournalEntry[],
): ProjectMemoryUsage {
  const files = Object.fromEntries(
    PROJECT_MEMORY_FILES.map((file) => [file, current[file]!.content]),
  );
  for (const entry of entries) files[entry.file] = entry.next;
  return storageUsage(files);
}
function assertPreviewMatches(
  preview: ProjectMemoryTransactionPreview,
  current: Readonly<Record<ProjectMemoryFileName, MemorySnapshot>>,
): void {
  for (const file of PROJECT_MEMORY_FILES) {
    const expected = preview.snapshots[file]!;
    const actual = current[file]!;
    if (actual.content !== expected.content || !sameRevision(actual.revision, expected.revision))
      throw new Error(`Project memory external conflict: ${file}`);
  }
}
async function preflightEntries(
  _port: FileSystemPort,
  rootDir: string,
  entries: readonly JournalEntry[],
  current: Readonly<Record<ProjectMemoryFileName, MemorySnapshot>>,
  signal?: AbortSignal,
): Promise<JournalEntry[]> {
  validateJournalEntries(entries);
  const finalFiles = Object.fromEntries(
    PROJECT_MEMORY_FILES.map((file) => [file, current[file]!.content]),
  );
  for (const entry of entries) {
    const actual = current[entry.file]!;
    if (actual.content !== entry.old && actual.content !== entry.next)
      throw new Error(`Project memory external conflict: ${entry.file}`);
    if (actual.content === entry.old && !sameRevision(actual.revision, entry.revision))
      throw new Error(`Project memory external conflict: ${entry.file}`);
    finalFiles[entry.file] = entry.next;
    await safePath(rootDir, entry.file);
  }
  const finalUsage = storageUsage(finalFiles);
  if (
    finalUsage.chars > PROJECT_MEMORY_STORAGE_MAX_CHARS ||
    finalUsage.bytes > PROJECT_MEMORY_STORAGE_MAX_BYTES
  )
    throw new Error(
      `Project memory transaction exceeds hard budget: ${finalUsage.chars} chars, ${finalUsage.bytes} bytes`,
    );
  signal?.throwIfAborted();
  return [...entries].sort((left, right) => {
    const leftDelta = byteDelta(current[left.file]!.content, left.next);
    const rightDelta = byteDelta(current[right.file]!.content, right.next);
    return leftDelta - rightDelta || left.file.localeCompare(right.file);
  });
}
async function applyEntries(
  port: FileSystemPort,
  rootDir: string,
  entries: readonly JournalEntry[],
  signal: AbortSignal | undefined,
  ordered: readonly JournalEntry[],
): Promise<void> {
  // 先读取并校验全部目标版本，再开始任何写入；CAS 继续防护无锁外部编辑器竞态。
  let usage = await usageOf(await readMemoryFiles(port, rootDir, signal));
  const verified = new Map<ProjectMemoryFileName, MemorySnapshot>();
  for (const entry of ordered) {
    const snapshot = await readOne(port, await safePath(rootDir, entry.file), signal);
    if (
      snapshot.content !== entry.next &&
      (snapshot.content !== entry.old || !sameRevision(snapshot.revision, entry.revision))
    )
      throw new Error(`Project memory external conflict: ${entry.file}`);
    verified.set(entry.file, snapshot);
  }
  for (const entry of ordered) {
    signal?.throwIfAborted();
    const snapshot = verified.get(entry.file)!;
    if (snapshot.content === entry.next) continue;
    const nextUsage = {
      chars: usage.chars + entry.next.length - snapshot.content.length,
      bytes:
        usage.bytes +
        Buffer.byteLength(entry.next, "utf8") -
        Buffer.byteLength(snapshot.content, "utf8"),
    };
    if (
      (nextUsage.chars > PROJECT_MEMORY_STORAGE_MAX_CHARS ||
        nextUsage.bytes > PROJECT_MEMORY_STORAGE_MAX_BYTES) &&
      !(
        nextUsage.chars <= usage.chars &&
        nextUsage.bytes <= usage.bytes &&
        (nextUsage.chars < usage.chars || nextUsage.bytes < usage.bytes)
      )
    )
      throw new Error("Project memory intermediate write exceeds hard budget");
    await port.writeTextFile(
      {
        path: await safePath(rootDir, entry.file),
        content: entry.next,
        lineEndings: "LF",
        createParents: true,
        atomic: true,
        expectedRevision: snapshot.revision,
      },
      { signal },
    );
    usage = { ...usage, ...nextUsage };
  }
}
async function readOne(
  port: FileSystemPort,
  path: string,
  signal?: AbortSignal,
): Promise<MemorySnapshot> {
  try {
    const read = await port.readTextFile({ path, maxBytes: MAX_MIGRATION_FILE_BYTES }, { signal });
    if (read.truncated) throw new Error("Project memory file is too large to resume safely");
    return { content: normalizeText(read.content), revision: read.revision };
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return { content: "" };
    throw error;
  }
}
async function readJournal(
  port: FileSystemPort,
  rootDir: string,
  signal?: AbortSignal,
): Promise<RetentionJournal | undefined> {
  const path = await safePath(rootDir, JOURNAL_NAME);
  try {
    const read = await port.readTextFile({ path, maxBytes: MAX_JOURNAL_BYTES }, { signal });
    if (read.truncated) throw new Error("Retention journal is too large");
    const value: unknown = JSON.parse(read.content);
    if (!isJournal(value)) throw new Error("Invalid retention journal");
    return value;
  } catch (error) {
    if (isFileSystemPortError(error) && error.code === "not_found") return undefined;
    throw error;
  }
}
async function persistPlan(
  port: FileSystemPort,
  rootDir: string,
  entries: JournalEntry[],
  current: Readonly<Record<ProjectMemoryFileName, MemorySnapshot>>,
  signal?: AbortSignal,
): Promise<void> {
  const before = Object.fromEntries(
    PROJECT_MEMORY_FILES.map((file) => [file, current[file]!.content]),
  ) as Record<ProjectMemoryFileName, string>;
  const after = { ...before };
  for (const entry of entries) after[entry.file] = entry.next;
  await writeJson(
    port,
    rootDir,
    JOURNAL_NAME,
    { version: 1, createdAt: new Date().toISOString(), before, after, entries },
    signal,
  );
}
async function writeBackup(
  port: FileSystemPort,
  rootDir: string,
  entries: JournalEntry[],
  signal?: AbortSignal,
): Promise<void> {
  await writeJson(port, rootDir, BACKUP_NAME, { version: 1, entries }, signal);
}
async function writeJson(
  port: FileSystemPort,
  rootDir: string,
  relativePath: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content, "utf8") > MAX_JOURNAL_BYTES)
    throw new Error("Retention journal exceeds 512 KiB");
  const path = await safePath(rootDir, relativePath);
  await port.writeTextFile(
    { path, content, lineEndings: "LF", createParents: true, atomic: true },
    { signal },
  );
}
async function removeSafe(
  port: FileSystemPort,
  rootDir: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<void> {
  await port.removeFile(
    { path: await safePath(rootDir, relativePath), missingOk: true },
    { signal },
  );
}
async function safePath(rootDir: string, relativePath: string): Promise<string> {
  const path = join(rootDir, relativePath);
  const safe = await resolveAllowedMemoryAgentPath({
    allowedRoots: [{ rootDir, files: [relativePath], kind: "project" }],
    workingDirectory: dirname(rootDir),
    workspaceRoot: dirname(rootDir),
    toolCall: { id: "retention", name: "Read", input: { file_path: path } },
  });
  if (!safe) throw new Error(`Unsafe project memory path: ${relativePath}`);
  return safe;
}
function normalizeText(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}
function byteDelta(oldValue: string, nextValue: string): number {
  return Buffer.byteLength(nextValue, "utf8") - Buffer.byteLength(oldValue, "utf8");
}
function sameRevision(left?: FileSystemRevision, right?: FileSystemRevision): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
