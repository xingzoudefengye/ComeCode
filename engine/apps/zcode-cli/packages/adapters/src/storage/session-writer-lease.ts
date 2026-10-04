import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "@zcode/shared";
import { acquireFileLock } from "@zcode/shared/node";

const SESSION_LEASE_WAIT_MS = 500;
const SESSION_LEASE_RETRY_MS = [25, 50];
const SESSION_LEASE_OWNERLESS_GRACE_MS = 250;

/** 同一 SQLite 会话的可写 Runtime 跨 CLI/Host 独占；活进程不会因超时被偷锁。 */
export async function acquireSessionWriterLease(options: {
  dbPath: string;
  sessionId: string;
}): Promise<() => Promise<void>> {
  const root = `${resolve(options.dbPath)}.writers`;
  await mkdir(root, { recursive: true });
  const key = createHash("sha256").update(options.sessionId).digest("hex");
  try {
    return await acquireFileLock(
      join(root, key),
      SESSION_LEASE_RETRY_MS,
      SESSION_LEASE_OWNERLESS_GRACE_MS,
      SESSION_LEASE_WAIT_MS,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE) throw cause;
    throw Object.assign(new Error("会话正在由另一 CLI 或桌面进程使用，请先关闭该会话后恢复", { cause }), {
      code: "COMECODE_SESSION_WRITER_BUSY",
    });
  }
}
