import {
  selectActiveConversationBranch,
  type MessageWithParts,
  type ReadSessionContextInput,
  type ReadSessionContextOutput,
  type ReadSessionContextReference,
  type SessionInfo,
} from "@zcode/contracts";
import { dedupeParts, formatPartForContext } from "./parts.js";
import { truncateText } from "./utils.js";
export {
  buildReferencedSessionContextReminderBody,
  extractSessionReferences,
} from "./references.js";

const DEFAULT_OUTPUT_CHAR_BUDGET = 6000;
const MAX_OUTPUT_CHAR_BUDGET = 6000;
const MAX_MESSAGE_PREVIEW_CHARS = 3000;
const RECENT_MESSAGE_COUNT = 12;

export interface SessionContextMaterial {
  allContent: string;
  allContentChars: number;
  chunks: TranscriptChunk[];
  localContent: string;
  messageCount: number;
  readableMessageCount: number;
  references: ReadSessionContextReference[];
  selectedChunks: TranscriptChunk[];
  selectedMessageCount: number;
  truncated: boolean;
}

export interface TranscriptChunk {
  index: number;
  startMessageIndex: number;
  endMessageIndex: number;
  messageCount: number;
  content: string;
  searchText: string;
  score: number;
  references: ReadSessionContextReference[];
}

interface MessageSnippet {
  index: number;
  role: "user" | "assistant";
  content: string;
  searchText: string;
  score: number;
  references: ReadSessionContextReference[];
}

export function buildSessionContextMaterial(input: {
  messages: MessageWithParts[];
  query: string;
  session: SessionInfo;
  strategy: ReadSessionContextInput["strategy"];
  outputCharBudget?: number;
}): SessionContextMaterial {
  const outputCharBudget = clampOutputCharBudget(input.outputCharBudget);
  const revert = input.session.revert;
  // 历史查询只裁剪 revert 分支，不按 compact boundary 丢弃此前仍有效的消息。
  const activeMessages = selectActiveConversationBranch(input.messages, {
    branchCutAfterMessageId: revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: revert?.createdMessageID,
    rewindKeptMessageIds: revert?.keptMessageIDs,
    rewindTargetMessageId: revert?.targetMessageID ?? revert?.messageID,
  });
  const snippets = activeMessages
    .map((message, index) => formatMessageSnippet(message, index))
    .filter((snippet): snippet is MessageSnippet => snippet !== null);
  const scoredSnippets = scoreSnippets(snippets, input.query);
  const selectedSnippets = selectSnippets(scoredSnippets, input.strategy, outputCharBudget);
  const localContent = formatSessionTranscript(input.session, selectedSnippets, {
    budgetChars: outputCharBudget,
    heading:
      input.strategy === "handoff" ? "Recent session handoff context" : "Relevant session context",
    query: input.query,
    strategy: input.strategy,
  });

  return {
    // 保留内部材料形状兼容调用方，但不再构造供辅助模型读取的完整 transcript。
    allContent: localContent,
    allContentChars: localContent.length,
    chunks: [],
    localContent,
    messageCount: activeMessages.length,
    readableMessageCount: scoredSnippets.length,
    references: selectedSnippets.flatMap((snippet) => snippet.references),
    selectedChunks: [],
    selectedMessageCount: selectedSnippets.length,
    truncated:
      selectedSnippets.length < scoredSnippets.length ||
      selectedSnippets.reduce((sum, snippet) => sum + snippet.content.length, 0) >
        outputCharBudget - sessionHeader(input.session, input.query, input.strategy).length,
  };
}

export function formatReadSessionContextModelContent(output: ReadSessionContextOutput): string {
  if (output.status === "not_found") return `Session ${output.sessionId} was not found.`;
  if (output.status === "failed") {
    return [
      `ReadSessionContext failed for ${output.sessionId}.`,
      output.error ? `Error: ${output.error}` : undefined,
      output.content,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `ReadSessionContext returned ${output.source} context for ${output.sessionId}.`,
    output.title ? `Title: ${output.title}` : undefined,
    output.truncated ? "The returned context is truncated." : undefined,
    "",
    output.content,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatLocalSessionNotFound(input: {
  query: string;
  sessionId: string;
  strategy: ReadSessionContextInput["strategy"];
}): ReadSessionContextOutput {
  return {
    status: "not_found",
    sessionId: input.sessionId,
    strategy: input.strategy,
    query: input.query,
    source: "none",
    content: `No persisted session was found for ${input.sessionId}.`,
    messageCount: 0,
    selectedMessageCount: 0,
    truncated: false,
  };
}

export function outputCharBudgetFromMaxTokens(maxTokens: number | undefined): number {
  // 以一字符一 token 的保守预算涵盖中文，不能用四字符估算突破用户的小预算。
  return clampOutputCharBudget(maxTokens);
}

function formatMessageSnippet(message: MessageWithParts, index: number): MessageSnippet | null {
  if (message.info.role === "user" && message.info.visibility === "model-only") return null;
  const partTexts: string[] = [];
  let remaining = MAX_MESSAGE_PREVIEW_CHARS;
  for (const part of dedupeParts(message.parts)) {
    if (remaining <= 0) break;
    const text = formatPartForContext(part);
    if (!text?.trim()) continue;
    const preview = truncateText(text, remaining);
    partTexts.push(preview);
    remaining -= preview.length;
  }
  if (partTexts.length === 0) return null;
  const body = partTexts.join("\n\n");
  const role = message.info.role;
  const content = [`[${index + 1}] ${role} ${message.info.id}`, body].join("\n");
  return {
    index,
    role,
    content,
    searchText: `${role}\n${body}`.toLowerCase(),
    score: 0,
    references: [{ messageId: message.info.id, index, role }],
  };
}

function scoreSnippets(snippets: MessageSnippet[], query: string): MessageSnippet[] {
  const normalizedQuery = query.trim().toLowerCase();
  const terms = new Set<string>();
  for (const match of normalizedQuery.match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? []) {
    if (match.length < 2) continue;
    terms.add(match);
    if (/^[\p{Script=Han}]+$/u.test(match) && match.length > 2) {
      for (let index = 0; index < match.length - 1; index++) {
        terms.add(match.slice(index, index + 2));
      }
    }
  }
  return snippets.map((snippet) => ({
    ...snippet,
    score:
      (snippet.searchText.includes(normalizedQuery) ? 20 : 0) +
      [...terms].reduce((sum, term) => sum + (snippet.searchText.includes(term) ? 4 : 0), 0),
  }));
}

function selectSnippets(
  snippets: MessageSnippet[],
  strategy: ReadSessionContextInput["strategy"],
  budgetChars: number,
): MessageSnippet[] {
  const positives = snippets.filter((snippet) => snippet.score > 0);
  const ranked =
    strategy === "relevant" && positives.length > 0
      ? [...positives].sort((a, b) => b.score - a.score || b.index - a.index)
      : snippets.slice(-RECENT_MESSAGE_COUNT).reverse();
  const selected: MessageSnippet[] = [];
  let usedChars = 0;
  for (const snippet of ranked) {
    if (selected.length > 0 && usedChars + snippet.content.length > budgetChars) continue;
    selected.push(snippet);
    usedChars += snippet.content.length;
    if (usedChars >= budgetChars) break;
  }
  // 相关性优先，避免较早的弱匹配先占满输出而截掉真正命中的记录。
  return strategy === "handoff" ? selected.reverse() : selected;
}

function sessionHeader(
  session: SessionInfo,
  query: string,
  strategy: ReadSessionContextInput["strategy"],
): string {
  return [
    `Session: ${session.title} (${session.id})`,
    `Directory: ${session.directory}`,
    session.path ? `Path: ${session.path}` : undefined,
    `Strategy: ${strategy}`,
    `Query: ${query}`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatSessionTranscript(
  session: SessionInfo,
  snippets: MessageSnippet[],
  options: {
    budgetChars: number;
    heading: string;
    query: string;
    strategy: ReadSessionContextInput["strategy"];
  },
): string {
  const header = `# ${options.heading}\n${sessionHeader(session, options.query, options.strategy)}`;
  const body =
    snippets.length === 0
      ? "No readable transcript content was found in the target session."
      : snippets.map((snippet) => snippet.content).join("\n\n---\n\n");
  return truncateText(`${header}${body}`, options.budgetChars);
}

function clampOutputCharBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_OUTPUT_CHAR_BUDGET;
  return Math.max(1, Math.min(MAX_OUTPUT_CHAR_BUDGET, Math.floor(value)));
}
