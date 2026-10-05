import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { uptime } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";

const LOCK_WAIT_MS = 800;
const LOCK_RETRY_MS = 20;
const OWNERLESS_GRACE_MS = 200;
const START_TOLERANCE_MS = 2_000;
const PROBE_TIMEOUT_MS = 200;
const MAX_OWNER_BYTES = 1_024;
const PROC_TICKS_PER_SECOND = 100;
const RENAME_RETRIES_MS = [15, 30, 60] as const;
const ownStartTime = Math.round(Date.now() - process.uptime() * 1_000);
const execFileAsync = promisify(execFile);

interface Owner {
  pid: number;
  token: string;
  startTime: number;
}
export function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/** 有界读取，拒绝大文件、非普通文件及符号链接。 */
export async function readBoundedTextFile(file: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    const info = await lstat(file, { bigint: false });
    // open 后再检查大小，避免路径替换后读取无界内容。
    if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid memory file size");
    handle = await open(file, "r");
    const current = await handle.stat();
    if (!current.isFile() || current.size > maxBytes) throw new Error("Invalid memory file size");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error("Invalid memory file size");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function probeStartTime(pid: number): Promise<number | null> {
  if (pid === process.pid) return ownStartTime;
  try {
    if (process.platform === "linux") {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const ticks = Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]);
      return Number.isFinite(ticks)
        ? Math.round(Date.now() - uptime() * 1_000 + (ticks * 1_000) / PROC_TICKS_PER_SECOND)
        : null;
    }
    const options = { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_OWNER_BYTES, windowsHide: true };
    const result =
      process.platform === "win32"
        ? await execFileAsync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
            ],
            options,
          )
        : process.platform === "darwin"
          ? await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], options)
          : null;
    if (!result) return null;
    const time =
      process.platform === "win32"
        ? Number(result.stdout.trim())
        : Date.parse(result.stdout.trim());
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}

async function readOwner(path: string): Promise<Owner | null> {
  try {
    const raw = await readBoundedTextFile(path, MAX_OWNER_BYTES);
    const value = JSON.parse(raw ?? "null") as Partial<Owner> | null;
    return value &&
      Number.isSafeInteger(value.pid) &&
      value.pid! > 0 &&
      typeof value.token === "string" &&
      /^[\w-]{1,80}$/u.test(value.token) &&
      typeof value.startTime === "number" &&
      Number.isFinite(value.startTime) &&
      value.startTime > 0
      ? (value as Owner)
      : null;
  } catch {
    return null;
  }
}
async function isAbandoned(owner: Owner): Promise<boolean> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (fileErrorCode(error) === "ESRCH") return true;
    return false;
  }
  const current = await probeStartTime(owner.pid);
  return current !== null && Math.abs(current - owner.startTime) > START_TOLERANCE_MS;
}

async function reclaimLock(lock: string): Promise<void> {
  try {
    const info = await stat(lock);
    const names = await readdir(lock);
    if (names.length === 0) {
      if (Date.now() - info.mtimeMs >= OWNERLESS_GRACE_MS) await rmdir(lock);
      return;
    }
    if (names.length !== 1 || !/^owner-[\w-]+\.json$/u.test(names[0]!)) return;
    const ownerFile = join(lock, names[0]!);
    const owner = await readOwner(ownerFile);
    if (!owner || !(await isAbandoned(owner))) return;
    // 唯一 token 文件充当实例校验；新 owner 文件不同，rmdir 不会删掉新锁。
    await rm(ownerFile, { force: true });
    await rmdir(lock);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(fileErrorCode(error) ?? "")) throw error;
  }
}

/** 短事务只覆盖读改写；不持锁调用模型，不按活进程锁的年龄强制接管。 */
export async function withShortFileTransaction<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const token = randomUUID();
  const ownerFile = join(lock, `owner-${token}.json`);
  const started = Date.now();
  for (;;) {
    let created = false;
    try {
      await mkdir(lock, { mode: 0o700 });
      created = true;
      const identity = await stat(lock);
      await writeFile(
        ownerFile,
        JSON.stringify({ pid: process.pid, startTime: ownStartTime, token }),
        { flag: "wx", mode: 0o600 },
      );
      const current = await stat(lock);
      const names = await readdir(lock);
      if (
        identity.ino !== current.ino ||
        identity.dev !== current.dev ||
        names.length !== 1 ||
        names[0] !== `owner-${token}.json`
      )
        throw Object.assign(new Error("Memory lock ownership changed"), { code: "EEXIST" });
      break;
    } catch (error) {
      if (created) {
        await rm(ownerFile, { force: true }).catch(() => {});
        await rmdir(lock).catch(() => {});
      }
      if (fileErrorCode(error) !== "EEXIST" && !(created && fileErrorCode(error) === "ENOENT"))
        throw error;
      const remaining = LOCK_WAIT_MS - (Date.now() - started);
      if (remaining <= 0) throw new Error("Memory file transaction lock timeout");
      await reclaimLock(lock);
      await sleep(Math.min(LOCK_RETRY_MS, remaining));
    }
  }
  try {
    return await operation();
  } finally {
    if ((await readOwner(ownerFile))?.token === token) {
      await rm(ownerFile, { force: true });
      await rmdir(lock).catch(() => {});
    }
  }
}

export async function writeTransactionTextFile(file: string, text: string): Promise<void> {
  await atomicWritePrivateTextFile(file, text, RENAME_RETRIES_MS);
}
