import { join } from "node:path";

/** 项目记忆固定文件顺序；顺序变化会影响 prompt cache 前缀。 */
export const PROJECT_MEMORY_FILES = [
  "project.md",
  "decisions.md",
  "tasks.md",
  "bugs.md",
  "memory.md",
] as const;

export type ProjectMemoryFileName = (typeof PROJECT_MEMORY_FILES)[number];

export const PROJECT_MEMORY_MAX_FILE_CHARS = 12_000;
export const PROJECT_MEMORY_MAX_TOTAL_CHARS = 48_000;

export const PROJECT_MEMORY_TEMPLATE: Readonly<Record<ProjectMemoryFileName, string>> = {
  "project.md": "# 项目说明\n\n<!-- 项目目标、技术栈、目录约定和团队约束。 -->\n",
  "decisions.md": "# 重要决策\n\n<!-- 记录已确认的架构、协议、兼容性和取舍。每条注明日期。 -->\n",
  "tasks.md": "# 持续任务\n\n<!-- 记录跨会话仍未完成的任务；已完成事项请移到历史或删除。 -->\n",
  "bugs.md": "# 已知问题\n\n<!-- 记录仍存在的问题、复现条件和规避方案。 -->\n",
  "memory.md": "# 项目记忆\n\n<!-- 记录不适合放入上面分类、但未来会话仍有价值的信息。 -->\n",
};

export function resolveWorkspaceProjectMemoryRoot(workspacePath: string): string {
  return join(workspacePath, ".ai");
}

export function rollMemoryMarkdown(content: string, maxChars = PROJECT_MEMORY_MAX_FILE_CHARS): string {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (normalized.length <= maxChars) return normalized;
  const sections = normalized.split(/\n## /u);
  const heading = sections[0] ?? "# 项目记忆\n";
  const dated = sections.slice(1).map((section) => `## ${section.trim()}`);
  const kept: string[] = [];
  let size = heading.length + "\n\n## 滚动摘要\n\n".length;
  for (let index = dated.length - 1; index >= 0; index -= 1) {
    const section = dated[index]!;
    if (size + section.length + 2 > maxChars) break;
    kept.unshift(section);
    size += section.length + 2;
  }
  const omitted = dated.length - kept.length;
  const summary = `最早 ${omitted} 条记录已滚动压缩，保留最近 ${kept.length} 条。\n`;
  return `${heading.trimEnd()}\n\n## 滚动摘要\n\n${summary}\n${kept.join("\n\n")}\n`;
}

export function projectMemoryFilePath(rootDir: string, fileName: ProjectMemoryFileName): string {
  return join(rootDir, fileName);
}

export function formatProjectMemorySnapshot(
  files: Readonly<Partial<Record<ProjectMemoryFileName, string>>>,
): { content: string; truncatedFiles: ProjectMemoryFileName[] } | undefined {
  let remaining = PROJECT_MEMORY_MAX_TOTAL_CHARS;
  const sections: string[] = [];
  const truncatedFiles: ProjectMemoryFileName[] = [];

  for (const fileName of PROJECT_MEMORY_FILES) {
    const content = files[fileName]?.trim();
    if (!content || remaining <= 0) continue;
    const limit = Math.min(PROJECT_MEMORY_MAX_FILE_CHARS, remaining);
    const clipped = content.length > limit;
    const body = clipped
      ? `${content.slice(0, limit).trimEnd()}\n\n[ComeCode：${fileName} 超出记忆加载上限，已截断。]`
      : content;
    sections.push(`## .ai/${fileName}\n\n${body}`);
    remaining -= Math.min(content.length, limit);
    if (clipped) truncatedFiles.push(fileName);
  }

  if (sections.length === 0) return undefined;
  return { content: sections.join("\n\n"), truncatedFiles };
}