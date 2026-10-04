import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "@zcode/shared";
import { acquireFileLock } from "@zcode/shared/node";

const SESSION_LEASE_WAIT_MS = 500;
const SESSION_LEASE_RETRY_MS = [25, 50];
const SESSION_LEASE_OWNERLESS_GRACE_MS = 250;

/** 占用仅作提醒；释放函数只操作本次取得的锁，未取得时为空操作。 */
export async function acquireSessionWriterLease(options: {
  dbPath: string;
  sessionId: string;
}): Promise<(() => Promise<void>) & { acquired: boolean }> {
  const root = `${resolve(options.dbPath)}.writers`;
  await mkdir(root, { recursive: true });
  const key = createHash("sha256").update(options.sessionId).digest("hex");
  try {
    const release = await acquireFileLock(
      join(root, key),
      SESSION_LEASE_RETRY_MS,
      SESSION_LEASE_OWNERLESS_GRACE_MS,
      SESSION_LEASE_WAIT_MS,
    );
    return Object.assign(release, { acquired: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE) throw cause;
    // 活进程占用不阻断同会话恢复，也不能释放其他进程的锁。
    return Object.assign(async () => {}, { acquired: false });
  }
}
