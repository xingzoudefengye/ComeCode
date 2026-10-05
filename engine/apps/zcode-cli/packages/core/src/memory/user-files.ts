import { join } from "node:path";
import { sanitizeChronicleText } from "../compact/chronicle.js";

export const USER_MEMORY_FILES = ["profile.md", "preferences.md"] as const;
export type UserMemoryFileName = (typeof USER_MEMORY_FILES)[number];
export const USER_MEMORY_MAX_FILE_CHARS = 2_000;
export const USER_MEMORY_MAX_TOTAL_CHARS = 4_000;
export const USER_MEMORY_TEMPLATE: Readonly<Record<UserMemoryFileName, string>> = {
  "profile.md": "# 用户记忆\n",
  "preferences.md": "# 用户偏好\n",
};

export function resolveUserMemoryRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "memories", "user");
}
export function userMemoryFilePath(rootDir: string, fileName: UserMemoryFileName): string {
  return join(rootDir, fileName);
}

/** 标题和截断提示也计入预算；用户记忆载入时再次脱敏，旧 history.md 不参与读取。 */
export function formatUserMemorySnapshot(
  files: Readonly<Partial<Record<UserMemoryFileName, string>>>,
  maxChars = USER_MEMORY_MAX_TOTAL_CHARS,
): { content: string; truncatedFiles: UserMemoryFileName[] } | undefined {
  let remaining = Math.max(0, Math.min(USER_MEMORY_MAX_TOTAL_CHARS, Math.floor(maxChars) || 0));
  const sections: string[] = [];
  const truncatedFiles: UserMemoryFileName[] = [];
  for (const fileName of USER_MEMORY_FILES) {
    const raw = files[fileName]?.replace(/<!--[^]*?-->/gu, "").trim();
    if (!raw) continue;
    const header = `## user-memory/${fileName}\n\n`;
    const limit = Math.min(USER_MEMORY_MAX_FILE_CHARS, remaining - header.length - 2);
    if (limit <= 0) break;
    const text = raw
      .split(/\r?\n/u)
      .map((line) => sanitizeChronicleText(line, 300))
      .filter(Boolean)
      .join("\n");
    const clipped = text.length > limit;
    sections.push(`${header}${text.slice(0, limit)}`);
    remaining -= sections.at(-1)!.length + 2;
    if (clipped) truncatedFiles.push(fileName);
  }
  if (!sections.length) return undefined;
  return { content: sections.join("\n\n"), truncatedFiles };
}
