import { Lexer, type Tokens } from "marked";
import { estimateTokens } from "../context/utils.js";
import { PROJECT_MEMORY_FILES, type ProjectMemoryFileName } from "./project-files.js";

export function formatProjectMemoryContextSnapshot(
  files: Readonly<Partial<Record<ProjectMemoryFileName, string>>>,
): string | undefined {
  return (
    PROJECT_MEMORY_FILES.filter((fileName) => files[fileName]?.trim())
      .map((fileName) => `## .ai/${fileName}\n\n${files[fileName]!.trim()}`)
      .join("\n\n") || undefined
  );
}

export interface MemoryContextSnapshot {
  projectRoot?: string;
  projectContent?: string;
  userRoot?: string;
  userContent?: string;
}

const PROJECT_FILES = ["project.md", "tasks.md", "bugs.md", "decisions.md", "memory.md"];
const USER_FILES = ["profile.md", "preferences.md"];
const PROJECT_WEIGHTS = [3, 2, 2, 2, 1];
const SOURCE_HEADER = /^## (?:\.ai\/|user-memory\/)([^\n]+)\s*$/gmu;

export function memorySnapshotFiles(content: string | undefined): Map<string, string> {
  const files = new Map<string, string>();
  if (!content) return files;
  const matches = [...content.matchAll(SOURCE_HEADER)];
  if (!matches.length) return new Map([["memory.md", content]]);
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const start = match.index! + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    files.set(match[1]!, content.slice(start, end).trim());
  }
  return files;
}

export function selectMemoryContextSnapshot(
  content: string | undefined,
  options: { kind: "project" | "user"; maxTokens: number; maxChars?: number },
): string | undefined {
  if (!content?.trim() || options.maxTokens <= 0) return undefined;
  const maxChars = options.maxChars ?? 12_000;
  const files = memorySnapshotFiles(content);
  const order = options.kind === "user" ? USER_FILES : PROJECT_FILES;
  const names = [
    ...order.filter((name) => files.has(name)),
    ...[...files.keys()].filter((name) => !order.includes(name)),
  ];
  const seen = new Set<string>();
  const sections: string[] = [];
  let tokens = options.maxTokens;
  let chars = maxChars;
  let weight = names.reduce((sum, name) => sum + fileWeight(name, options.kind), 0);
  for (const name of names) {
    const header = `## ${options.kind === "user" ? "user-memory" : ".ai"}/${name}\n\n`;
    const share = Math.floor((tokens * fileWeight(name, options.kind)) / weight);
    weight -= fileWeight(name, options.kind);
    const units = markdownUnits(files.get(name)!);
    if (name === "decisions.md" || name === "bugs.md" || name === "memory.md") {
      units.sort((a, b) => dateKey(b).localeCompare(dateKey(a)));
    }
    const selected: string[] = [];
    const localSeen = new Set<string>();
    let omitted = false;
    for (const unit of units) {
      const key = unit.replace(/\s+/gu, " ").trim();
      if (!key || seen.has(key) || localSeen.has(key)) continue;
      const candidate = header + [...selected, unit].join("\n\n");
      if (estimateTokens(candidate) > share || candidate.length > chars) {
        omitted = true;
        continue;
      }
      selected.push(unit);
      localSeen.add(key);
    }
    const notice = "[More entries remain in this file; read only when needed.]";
    if (omitted) {
      const candidate = header + [...selected, notice].join("\n\n");
      if (estimateTokens(candidate) <= share && candidate.length <= chars) selected.push(notice);
    }
    if (!selected.length) continue;
    const section = header + selected.join("\n\n");
    sections.push(section);
    for (const key of localSeen) seen.add(key);
    tokens -= estimateTokens(section) + 1;
    chars -= section.length + 2;
  }
  return sections.length ? sections.join("\n\n") : undefined;
}

function fileWeight(name: string, kind: "project" | "user"): number {
  return kind === "user" ? 1 : (PROJECT_WEIGHTS[PROJECT_FILES.indexOf(name)] ?? 1);
}

function dateKey(text: string): string {
  return text.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0] ?? "";
}

function markdownUnits(content: string): string[] {
  const units: string[] = [];
  let heading = "";
  for (const token of Lexer.lex(content.replace(/\r\n/gu, "\n"))) {
    if (token.type === "heading") {
      heading = token.raw.trim();
      continue;
    }
    if (token.type === "space" || token.type === "html" || token.type === "def") continue;
    const parts =
      token.type === "list"
        ? token.items
            .filter((item: Tokens.ListItem) => !(item.task && item.checked))
            .map((item: Tokens.ListItem) => item.raw.trim())
        : [token.raw.trim()];
    for (const part of parts) {
      if (part)
        units.push(
          part.startsWith("[More entries remain in this file;")
            ? part
            : [heading, part].filter(Boolean).join("\n\n"),
        );
    }
  }
  return units;
}
