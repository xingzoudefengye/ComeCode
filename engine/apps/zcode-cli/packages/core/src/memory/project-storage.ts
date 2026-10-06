import { join } from "node:path";
import {
  isFileSystemPortError,
  type FileSystemPort,
  type FileSystemOperationOptions,
  type FileSystemWriteTextRequest,
} from "@zcode/contracts";
import { withShortFileTransaction } from "./file-transaction.js";
import { PROJECT_MEMORY_FILES } from "./project-files.js";
import { resolveAllowedMemoryAgentPath } from "./memory-agent-loop.js";
import {
  PROJECT_MEMORY_STORAGE_MAX_CHARS,
  PROJECT_MEMORY_STORAGE_MAX_BYTES,
} from "./project-retention.js";

export const PROJECT_MEMORY_WRITE_GUARD = Symbol("project-memory-write-guard");
const MAX_EXISTING_FILE_BYTES = 128 * 1024;

export async function validateProjectMemoryWrite(
  port: FileSystemPort,
  root: string,
  request: FileSystemWriteTextRequest,
  options?: FileSystemOperationOptions,
): Promise<void> {
  let beforeChars = 0;
  let beforeBytes = 0;
  let afterChars = 0;
  let afterBytes = 0;
  for (const file of PROJECT_MEMORY_FILES) {
    const path = join(root, file);
    const safe = await resolveAllowedMemoryAgentPath({
      allowedRoots: [{ rootDir: root, files: PROJECT_MEMORY_FILES, kind: "project" }],
      workingDirectory: root,
      workspaceRoot: root,
      toolCall: { id: "memory-budget", name: "Read", input: { file_path: path } },
    });
    if (!safe) throw new Error("Project memory path cannot be safely validated");
    let content = "";
    let lineEndings: string | undefined;
    try {
      const read = await port.readTextFile(
        { path, maxBytes: MAX_EXISTING_FILE_BYTES, trace: request.trace },
        options,
      );
      if (read.truncated)
        throw new Error("Project memory file must be fully read for budget validation");
      content = read.content;
      lineEndings = read.lineEndings;
    } catch (error) {
      if (!isFileSystemPortError(error) || error.code !== "not_found") throw error;
    }
    beforeChars += content.length;
    beforeBytes += utf8Bytes(content, lineEndings);
    const proposed = path === request.path ? request.content : content;
    afterChars += proposed.length;
    afterBytes += utf8Bytes(proposed, path === request.path ? request.lineEndings : lineEndings);
  }
  if (
    afterChars <= PROJECT_MEMORY_STORAGE_MAX_CHARS &&
    afterBytes <= PROJECT_MEMORY_STORAGE_MAX_BYTES
  )
    return;
  // 旧文件允许渐进缩减，不能在超限状态下增加另一维容量。
  if (
    afterChars <= beforeChars &&
    afterBytes <= beforeBytes &&
    (afterChars < beforeChars || afterBytes < beforeBytes)
  )
    return;
  throw new Error(
    `Project memory storage budget exceeded: ${afterChars}/${PROJECT_MEMORY_STORAGE_MAX_CHARS} chars, ${afterBytes}/${PROJECT_MEMORY_STORAGE_MAX_BYTES} UTF-8 bytes. Compact existing entries before adding content.`,
  );
}

export async function writeMemoryTextFile(
  port: FileSystemPort,
  request: FileSystemWriteTextRequest,
  options: FileSystemOperationOptions | undefined,
  root?: string,
) {
  if (
    !root ||
    !PROJECT_MEMORY_FILES.some((file) => join(root, file) === request.path) ||
    Reflect.get(port, PROJECT_MEMORY_WRITE_GUARD) === true
  )
    return port.writeTextFile(request, options);
  return withShortFileTransaction(join(root, ".project-memory"), async () => {
    options?.signal?.throwIfAborted();
    await validateProjectMemoryWrite(port, root, request, options);
    options?.signal?.throwIfAborted();
    return port.writeTextFile(request, options);
  });
}

function utf8Bytes(content: string, lineEndings?: string): number {
  const text = lineEndings === "CRLF" ? content.replace(/\r?\n/gu, "\r\n") : content;
  return Buffer.byteLength(text, "utf8");
}
