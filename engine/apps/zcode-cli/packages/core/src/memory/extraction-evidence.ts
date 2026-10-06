import type { MessageWithParts, ToolPart } from "@zcode/contracts";

const COMMIT_HASH = /^[0-9a-f]{7,64}$/u;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const FAILURE_OUTPUT =
  /(?:^|\n)\s*(?:fatal|error|failed|rejected|non-fast-forward)\b|\b(?:failed|rejected)\b/iu;
const MAX_EVIDENCE_CHARS = 2_000;

export interface MemoryExtractionEvidence {
  kind: "commit" | "push" | "merge" | "verification";
  summary: string;
  source: { messageId: string; toolCallID: string };
}

export function collectMemoryExtractionEvidence(
  messages: readonly MessageWithParts[],
): MemoryExtractionEvidence[] {
  const evidence: MemoryExtractionEvidence[] = [];
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== "Bash") continue;
      const item = evidenceFromBashPart(part);
      if (item)
        evidence.push({
          ...item,
          source: { messageId: String(message.info.id), toolCallID: part.callID },
        });
    }
  }
  return evidence;
}

export function buildMemoryExtractionEvidence(messages: readonly MessageWithParts[]): string {
  return collectMemoryExtractionEvidence(messages)
    .map((item) => `${item.summary} [source toolCallID=${item.source.toolCallID}]`)
    .join("\n")
    .slice(0, MAX_EVIDENCE_CHARS);
}

export function hasMemoryExtractionEvidence(messages: readonly MessageWithParts[]): boolean {
  return collectMemoryExtractionEvidence(messages).length > 0;
}

function evidenceFromBashPart(
  part: Extract<ToolPart, { type: "tool" }>,
): Omit<MemoryExtractionEvidence, "source"> | undefined {
  if (part.state.status !== "completed") return undefined;
  const command = readString(part.state.input, "command");
  if (!command) return undefined;
  const verification = readStructuredVerification(part.state.metadata);
  const parsed = parseStructuredBashResult(part.state.output);
  if (!hasSuccessfulExit(part.state, parsed)) return undefined;
  if (verification)
    return { kind: "verification", summary: `核验结果：${verification.itemId} 已通过` };
  const output = parsed?.stdout ?? part.state.output;
  const errorOutput = parsed?.stderr ?? "";
  const tokens = tokenizeGitCommand(command);
  if (tokens?.[1] === "commit") {
    const hash = readCommitHash(output);
    return hash ? { kind: "commit", summary: `核验结果：commit ${hash} 已完成` } : undefined;
  }
  if (
    tokens?.[1] === "merge" &&
    /^(?:Fast-forward|Merge made by the '[^']+' strategy\.)$/imu.test(output)
  ) {
    const refs = tokens.slice(2).filter((arg) => !arg.startsWith("-"));
    if (refs.length === 1 && SAFE_REF.test(refs[0]!) && !refs[0]!.includes(".."))
      return { kind: "merge", summary: `核验结果：merge ${refs[0]} 已完成（不代表验收完成）` };
  }
  if (tokens?.[1] === "push") {
    const target = readPushTarget(tokens);
    if (!target || !readPushSuccess(`${output}\n${errorOutput}`, target.ref)) return undefined;
    return { kind: "push", summary: `核验结果：push ${target.remote}/${target.ref} 已成功` };
  }
  return undefined;
}

function parseStructuredBashResult(output: string):
  | {
      stdout: string;
      stderr: string;
      status: string;
      exitCode: number;
    }
  | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (
      !isRecord(value) ||
      typeof value.stdout !== "string" ||
      typeof value.stderr !== "string" ||
      typeof value.status !== "string" ||
      typeof value.exitCode !== "number"
    )
      return undefined;
    return {
      stdout: value.stdout,
      stderr: value.stderr,
      status: value.status,
      exitCode: value.exitCode,
    };
  } catch {
    return undefined;
  }
}

function tokenizeGitCommand(command: string): string[] | undefined {
  if (!/^\s*git(?:\s|$)/u.test(command) || /[\r\n;&|<>`]|\$\(|\$\{/u.test(command))
    return undefined;
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (/\s/u.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else token += char;
  }
  if (escaped || quote) return undefined;
  if (token) tokens.push(token);
  if (tokens[0] !== "git" || !["commit", "push", "merge"].includes(tokens[1] ?? ""))
    return undefined;
  return tokens;
}

function readCommitHash(output: string): string | undefined {
  if (FAILURE_OUTPUT.test(output)) return undefined;
  const match = output.match(/(?:^|\n)\s*\[[^\]\r\n]{1,128}\s+([0-9a-f]{7,64})\](?:\s|$)/iu);
  return match && COMMIT_HASH.test(match[1]!) ? match[1]!.toLowerCase() : undefined;
}

function readPushTarget(tokens: readonly string[]): { remote: string; ref: string } | undefined {
  const args = tokens.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (args.some((arg) => arg.startsWith("-") && !["-u", "--set-upstream"].includes(arg)))
    return undefined;
  if (positional.length !== 2) return undefined;
  const [remote, ref] = positional;
  if (!remote || !ref || !SAFE_REMOTE.test(remote) || !SAFE_REF.test(ref) || ref.includes(".."))
    return undefined;
  return { remote, ref };
}

function readPushSuccess(output: string, ref: string): boolean {
  if (FAILURE_OUTPUT.test(output)) return false;
  if (/^\s*Everything up-to-date\s*$/imu.test(output)) return true;
  return [
    ...output.matchAll(/^\s*(?:[0-9a-f]+\.\.[0-9a-f]+|\*)\s+[^\s]+\s+->\s+([^\s]+)\s*$/gimu),
  ].some((match) => match[1] === ref);
}

function hasSuccessfulExit(
  state: Extract<ToolPart["state"], { status: "completed" }>,
  result: { status: string; exitCode: number; stderr: string } | undefined,
): boolean {
  const command = readCommandMetadata(state.metadata);
  if (command) return command.status === "completed" && command.exitCode === 0;
  if (result) return result.status === "completed" && result.exitCode === 0;
  // 旧纯文本输出没有退出事实，不能作为状态完成证据。
  return false;
}

function readCommandMetadata(
  metadata: Record<string, unknown> | undefined,
): { status: string; exitCode: number } | undefined {
  const stored = metadata?.commandResult;
  if (isRecord(stored) && typeof stored.status === "string" && typeof stored.exitCode === "number")
    return { status: stored.status, exitCode: stored.exitCode };
  const candidates = [metadata?.performance, metadata?.perf, metadata?.execution];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const detail = candidate.detail;
    const command =
      isRecord(detail) && detail.kind === "command" ? detail.command : candidate.command;
    if (
      isRecord(command) &&
      typeof command.status === "string" &&
      typeof command.exitCode === "number"
    )
      return { status: command.status, exitCode: command.exitCode };
  }
  return undefined;
}

function readStructuredVerification(
  metadata: Record<string, unknown> | undefined,
): { itemId: string } | undefined {
  const value = metadata?.verification;
  if (!isRecord(value) || value.status !== "passed" || typeof value.itemId !== "string")
    return undefined;
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(value.itemId)) return undefined;
  return { itemId: value.itemId };
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
