const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by <work_guide> and <summary> blocks.

`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — " +
  "an <analysis> block followed by <work_guide> and <summary> blocks. Tool calls will be rejected and you will fail the task.";

const BASE_COMPACT_PROMPT = `Create a compact continuation state for the conversation. The next model must continue the current work without repeating completed work.

This is NOT a chronological transcript and NOT a full explanation of everything that happened. Keep it concise and practical. The next request will receive stable context, this result, and the latest user input as if starting a fresh session.

Reason inside <analysis> tags. The final output MUST contain both blocks below, in this order:

<work_guide>
A short, executable work guide. Include only:
- Every user goal, with a status: in_progress, completed, paused, or blocked.
- The goal or goals to work on next.
- Completed work and concrete evidence; completed work is a hard "do not repeat" list.
- The next 1–3 concrete actions.
- Important verified facts, files, commands, constraints, and known risks.
- Explicit things not to do.
Do not revive an old goal just because it appears in history. If a goal is completed, label it completed and never put it in next actions. Keep this guide under 1,200 Chinese characters when possible.
</work_guide>

<summary>
A concise technical summary of only the historical context needed to execute the work guide. Preserve exact paths, identifiers, errors, decisions, and validation results when needed. Omit narration, repeated explanations, and old raw tool output. Keep this summary under 6,000 Chinese characters when possible.
</summary>

Rules:
- The newest explicit user request and latest verified repository/runtime state outrank old discussion.
- Never treat an old plan, request, or error as current unless the guide or latest messages say it is still pending.
- Do not claim work is complete without evidence.
- Do not include secrets, API keys, OAuth tokens, or other credentials.
- The <work_guide> generated in THIS compaction replaces every previous work guide. Do not copy, merge, or continue any older work guide.

When useful, preserve exact technical details under these compact categories: user intent, verified changes, files and code areas, errors and fixes, pending work, and the immediate next step.`;

export interface CompactResult {
  guide: string;
  summary: string;
}

const MAX_WORK_GUIDE_CHARS = 4_000;
const MAX_COMPACT_SUMMARY_CHARS = 16_000;

export function buildCompactPrompt(customInstructions: string | undefined): string {
  const customInstructionBlock = customInstructions?.trim()
    ? `\n\nAdditional Instructions:\n${customInstructions}`
    : "";

  return `${NO_TOOLS_PREAMBLE}${BASE_COMPACT_PROMPT}${customInstructionBlock}${NO_TOOLS_TRAILER}`;
}

export function parseCompactResult(text: string | undefined): CompactResult {
  const cleaned = stripAnalysis(text?.trim() ?? "");
  if (!cleaned) return { guide: "", summary: "" };

  const guideMatch = cleaned.match(/<work_guide>\s*([\s\S]*?)\s*<\/work_guide>/i);
  const withoutGuide = guideMatch ? cleaned.replace(guideMatch[0], "") : cleaned;
  const summaryMatch = withoutGuide.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  const rawSummary = summaryMatch ? summaryMatch[1] ?? "" : withoutGuide;
  const rawGuide = guideMatch?.[1] ?? "";

  return {
    guide: capCompactText(normalizeCompactText(rawGuide), MAX_WORK_GUIDE_CHARS),
    summary: capCompactText(normalizeCompactText(rawSummary), MAX_COMPACT_SUMMARY_CHARS),
  };
}

export function formatCompactSummary(text: string | undefined): string {
  return parseCompactResult(text).summary;
}

export function formatCompactWorkGuide(text: string | undefined): string {
  return parseCompactResult(text).guide;
}

export function buildCompactSummaryMessage(
  summary: string,
  options: {
    recentMessagesPreserved?: boolean;
    replStateCleared?: boolean;
    suppressFollowup?: boolean;
    workGuide?: string;
    transcriptPath?: string;
  } = {},
): string {
  let message = `This session is being continued from a previous conversation that ran out of context. The compact continuation state below covers the earlier portion of the conversation.\n\n${formatCompactSummary(summary)}`;
  if (options.workGuide?.trim()) {
    message += "\n\n" + [
      "以下内容相当于用户在压缩后发出的工作总结：",
      "本次续接按它执行；之后只把它当作普通用户对话历史，不要作为特殊系统提醒重复注入。",
      "",
      options.workGuide.trim(),
    ].join("\n");
  }

  if (options.transcriptPath) {
    message += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${options.transcriptPath}`;
  }

  if (options.recentMessagesPreserved) {
    message += "\n\nRecent messages are preserved verbatim.";
  }

  if (options.replStateCleared) {
    message +=
      "\n\nYour REPL VM state has been cleared as part of this compaction. Variables defined in REPL calls before this point are no longer accessible — redefine any you still need.";
  }

  if (options.suppressFollowup) {
    message +=
      "\nContinue from the latest work guide and summary without asking the user any further questions. Resume directly, do not recap, and do not revive completed goals.";
  }

  return message;
}

function stripAnalysis(text: string): string {
  return text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

function normalizeCompactText(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function capCompactText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\n[ComeCode：本段过长，已截断；请以当前指南和最新状态为准。]`;
}
