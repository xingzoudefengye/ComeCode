import { Lexer, type Tokens } from "marked";
import {
  PROJECT_MEMORY_FILES,
  type ProjectMemoryFileName,
} from "./project-files.js";
import {
  parseProjectMemoryEntry,
  storageUsage,
  PROJECT_MEMORY_STORAGE_MAX_BYTES,
  PROJECT_MEMORY_STORAGE_MAX_CHARS,
  type ProjectMemoryRetentionPlan,
} from "./project-retention.js";

export interface ProjectMemoryForgetSelector {
  file?: ProjectMemoryFileName;
  id?: string;
  date?: string;
  query?: string;
}

export interface ProjectMemoryForgetPreview {
  plan: ProjectMemoryRetentionPlan;
  matchedCount: number;
  matchedFiles: readonly ProjectMemoryFileName[];
  preservedUnknownContent: boolean;
}

/**
 * Builds a deletion-only plan. Unstructured Markdown is deliberately retained.
 */
export function planProjectMemoryForget(
  input: Readonly<Partial<Record<ProjectMemoryFileName, string>>>,
  selector: ProjectMemoryForgetSelector,
): ProjectMemoryForgetPreview {
  assertSelector(selector);
  const before = Object.fromEntries(
    PROJECT_MEMORY_FILES.map((file) => [file, input[file] ?? ""]),
  ) as Record<ProjectMemoryFileName, string>;
  const files = { ...before };
  const matchedFiles = new Set<ProjectMemoryFileName>();
  let matchedCount = 0;
  let preservedUnknownContent = false;

  for (const file of PROJECT_MEMORY_FILES) {
    if (selector.file && selector.file !== file) continue;
    const result = forgetFromMarkdown(file, before[file], selector);
    files[file] = result.content;
    matchedCount += result.matchedCount;
    if (result.matchedCount > 0) matchedFiles.add(file);
    preservedUnknownContent ||= result.preservedUnknownContent;
  }

  const beforeUsage = storageUsage(before);
  const afterUsage = storageUsage(files);
  const plan: ProjectMemoryRetentionPlan = {
    before,
    files,
    beforeUsage,
    afterUsage,
    changes: PROJECT_MEMORY_FILES.filter((file) => before[file] !== files[file]).map((file) => ({
      file,
      beforeChars: before[file].length,
      afterChars: files[file].length,
      reason: "explicit user memory forget",
    })),
    fits:
      afterUsage.chars <= PROJECT_MEMORY_STORAGE_MAX_CHARS &&
      afterUsage.bytes <= PROJECT_MEMORY_STORAGE_MAX_BYTES,
    needsSemanticCompaction: false,
  };
  return {
    plan,
    matchedCount,
    matchedFiles: [...matchedFiles],
    preservedUnknownContent,
  };
}

function forgetFromMarkdown(
  file: ProjectMemoryFileName,
  content: string,
  selector: ProjectMemoryForgetSelector,
): { content: string; matchedCount: number; preservedUnknownContent: boolean } {
  let matchedCount = 0;
  let preservedUnknownContent = false;
  const output: string[] = [];
  for (const token of Lexer.lex(content.replace(/\r\n/gu, "\n"))) {
    if (token.type !== "list") {
      output.push(token.raw);
      if (token.type === "paragraph" || token.type === "heading" || token.type === "blockquote") {
        preservedUnknownContent ||= token.raw.trim().length > 0;
      }
      continue;
    }
    const list = token as Tokens.List;
    let cursor = 0;
    let rebuilt = "";
    for (const item of list.items) {
      const index = token.raw.indexOf(item.raw, cursor);
      if (index < cursor) {
        rebuilt += token.raw.slice(cursor);
        cursor = token.raw.length;
        break;
      }
      rebuilt += token.raw.slice(cursor, index);
      cursor = index + item.raw.length;
      const entry = parseProjectMemoryEntry(item.raw);
      if (!entry) {
        rebuilt += item.raw;
        if (item.raw.trim()) preservedUnknownContent = true;
        continue;
      }
      if (matches(entry, selector)) {
        matchedCount += 1;
      } else {
        rebuilt += item.raw;
      }
    }
    rebuilt += token.raw.slice(cursor);
    output.push(rebuilt);
  }
  return {
    content: output.join(""),
    matchedCount,
    preservedUnknownContent,
  };
}

function matches(
  entry: NonNullable<ReturnType<typeof parseProjectMemoryEntry>>,
  selector: ProjectMemoryForgetSelector,
): boolean {
  if (selector.id !== undefined && entry.id !== selector.id) return false;
  if (selector.date !== undefined && entry.date !== selector.date) return false;
  if (
    selector.query !== undefined &&
    !`${entry.id} ${entry.date} ${entry.status} ${entry.kind} ${entry.conclusion} ${entry.details?.join(" ") ?? ""}`
      .toLocaleLowerCase()
      .includes(selector.query.toLocaleLowerCase())
  )
    return false;
  return true;
}

function assertSelector(selector: ProjectMemoryForgetSelector): void {
  if (selector.id === undefined && selector.date === undefined && selector.query === undefined)
    throw new Error("Memory forget requires --id, --date or --query");
  if (selector.id !== undefined && !/^[A-Za-z0-9._-]{1,80}$/u.test(selector.id))
    throw new Error("Memory forget id must use letters, numbers, dot, underscore or hyphen");
  if (selector.date !== undefined && !isValidDate(selector.date))
    throw new Error("Memory forget date must use a valid YYYY-MM-DD date");
  if (selector.query !== undefined && selector.query.trim().length === 0)
    throw new Error("Memory forget query must not be empty");
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}
