import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendUserMemoryChronicle,
  loadUserMemoryChronicle,
  formatUserMemoryChronicle,
  boundUserMemoryChronicle,
  createUserChronicleEntry,
} from "../packages/core/src/memory/user-chronicle.ts";
import {
  persistUserMemoryChronicle,
  loadRuntimeUserMemoryChronicle,
} from "../packages/core/src/runtime/helpers/user-memory-chronicle.ts";
import { withShortFileTransaction } from "../packages/core/src/memory/file-transaction.ts";

// 行为契约：文件是唯一所有者；先锁再读改写，损坏拒写；终态历史不核验目标完成。
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const turn = (i, status = "success", endedAt = NOW) => ({
  origin: { turnId: `turn-${i}`, branchGeneration: 0 },
  goal: `修复第${i}轮终端输入`,
  response: "已验证改动",
  status,
  endedAt,
});
async function fixture(t) {
  const storage = await mkdtemp(join(tmpdir(), "comecode-chronicle-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const root = join(storage, "memories", "user");
  return { storage, root, file: join(root, "chronicle.json") };
}
const append = (root, i, extra = {}) =>
  appendUserMemoryChronicle({
    root,
    turn: turn(i),
    projectKey: "fixture-project",
    sessionId: "fixture-session",
    now: NOW,
    ...extra,
  });

test("固定用户文件、session+turn身份去重、匿名项目来源，取消失败不接受部分成功回复", async (t) => {
  const { root, file } = await fixture(t);
  await append(root, 1);
  await append(root, 1);
  await append(root, 1, { sessionId: "another-session", projectKey: "E:\\private\\other" });
  await append(root, 2, { turn: { ...turn(2, "cancelled"), response: "全部完成" } });
  await append(root, 3, { turn: { ...turn(3, "failed"), response: "全部完成" } });
  const loaded = await loadUserMemoryChronicle({ root, now: NOW });
  assert.equal(loaded.entries.length, 4);
  assert.equal(new Set(loaded.entries.map((entry) => entry.origin.turnId)).size, 4);
  assert.equal(new Set(loaded.entries.map((entry) => entry.source)).size, 2);
  assert.doesNotMatch(
    await readFile(file, "utf8"),
    /fixture-session|another-session|private|fixture-project/u,
  );
  const text = formatUserMemoryChronicle(loaded);
  assert.match(text, /目标完成未经核验/u);
  assert.match(text, /取消（未完成）/u);
  assert.match(text, /失败（未完成）/u);
  assert.doesNotMatch(text, /全部完成/u);
});

test("真实7天30天老化，读取仅投影不写回；容量提前粗化且混合来源不形成项目事实", async (t) => {
  const { root, file } = await fixture(t);
  await append(root, 1);
  const raw = await readFile(file, "utf8");
  const earlier = await loadUserMemoryChronicle({ root, now: NOW + 8 * DAY });
  assert.equal(earlier.entries[0].recency, "earlier");
  const oldest = await loadUserMemoryChronicle({ root, now: NOW + 31 * DAY });
  assert.equal(oldest.entries[0].recency, "oldest");
  assert.equal(await readFile(file, "utf8"), raw);
  let value = { version: 1, entries: [] };
  for (let i = 0; i < 2000; i++) {
    const entry = createUserChronicleEntry({
      turn: turn(i),
      sessionId: "fixture",
      projectKey: `project-${i % 2}`,
    });
    value = boundUserMemoryChronicle({ version: 1, entries: [...value.entries, entry] }, NOW);
    assert.ok(JSON.stringify(value).length <= 6000);
    assert.ok(value.entries.length <= 22);
  }
  assert.ok(value.entries.some((entry) => entry.recency === "earlier"));
  assert.ok(value.entries.some((entry) => entry.recency === "oldest"));
  const mixed = value.entries.filter((entry) => entry.source === "mixed");
  assert.ok(mixed.length);
  assert.ok(
    mixed.every((entry) => /来源混合/u.test(entry.summary) && !/修复第/u.test(entry.summary)),
  );
});

test("损坏、超大文件和非法schema拒绝覆盖；内容与输入有硬限制", async (t) => {
  const { root, file } = await fixture(t);
  await mkdir(root, { recursive: true });
  for (const raw of [
    "broken",
    "x".repeat(24001),
    JSON.stringify({ version: 9, entries: [] }),
    JSON.stringify({ version: 1, entries: [{ summary: "injected" }] }),
  ]) {
    await writeFile(file, raw);
    assert.deepEqual((await loadUserMemoryChronicle({ root, now: NOW })).entries, []);
    await assert.rejects(append(root, 1));
    assert.equal(await readFile(file, "utf8"), raw);
  }
  await rm(file);
  await assert.rejects(append(root, 1, { turn: { ...turn(1), goal: "x".repeat(16385) } }));
  await assert.rejects(append(root, 1, { sessionId: "x".repeat(4097) }));
  await assert.rejects(append(root, 1, { turn: turn(1, "success", 9e15) }));
  await append(root, 2, {
    turn: {
      ...turn(2),
      goal: 'api_key="fixture-secret" https://fixture.invalid/x 192.0.2.1 person@fixture.invalid `const key = 1`',
      response: "const password = 'fixture-raw-code';",
    },
  });
  assert.doesNotMatch(
    await readFile(file, "utf8"),
    /fixture-secret|fixture\.invalid|192\.0\.2\.1|const key|fixture-raw-code/u,
  );
});

test("Memory disabled/use false、project scope和非主任务绝不读写；extractionEnabled不禁用本地历史", async (t) => {
  const { storage, root } = await fixture(t);
  const runtime = (memory, taskType) => ({
    config: {
      memory: { cliStorageRoot: storage, enabled: true, scope: "both", ...memory },
      taskType,
    },
    sessionId: "fixture-session",
    sessionPersisted: true,
    workspaceRoot: "fixture-project",
    workingDirectory: "fixture-project",
    isRemoteWorkspace: () => false,
    sessionStore: {
      sessionEntries: () => {
        throw new Error("禁止fake session");
      },
    },
    logger: { warn: () => {} },
  });
  for (const rt of [
    runtime({ enabled: false }),
    runtime({ use: false }),
    runtime({ scope: "project" }),
    runtime({}, "subagent"),
  ]) {
    await persistUserMemoryChronicle(rt, turn(1));
    assert.equal((await loadRuntimeUserMemoryChronicle(rt)).entries.length, 0);
  }
  await assert.rejects(readdir(root), { code: "ENOENT" });
  await persistUserMemoryChronicle(runtime({ extractionEnabled: false }), turn(2, "cancelled"));
  assert.equal((await loadUserMemoryChronicle({ root, now: NOW })).entries[0].status, "cancelled");
});

test("固定 workspaceRoot 决定匿名来源，切换 cwd 不改变来源；显式身份优先", async (t) => {
  const { storage, root, file } = await fixture(t);
  const runtime = (workspaceRoot, workingDirectory, memory = {}, workspaceIdentity) => ({
    config: {
      memory: { cliStorageRoot: storage, enabled: true, scope: "user", ...memory },
      workspaceIdentity,
    },
    sessionId: "fixture-source-session",
    sessionPersisted: true,
    workspaceRoot,
    workingDirectory,
    isRemoteWorkspace: () => false,
    logger: { warn: () => assert.fail("合法回合不应保存失败") },
  });
  await persistUserMemoryChronicle(runtime("fixture-project-a", "fixture-project-a"), turn(1));
  await persistUserMemoryChronicle(
    runtime("fixture-project-a", "fixture-project-a/subdir"),
    turn(2),
  );
  await persistUserMemoryChronicle(
    runtime("fixture-project-b", "fixture-project-a/subdir"),
    turn(3),
  );
  await persistUserMemoryChronicle(
    runtime("fixture-project-a", "fixture-project-a", {}, "fixture-config-identity"),
    turn(4),
  );
  await persistUserMemoryChronicle(
    runtime("fixture-project-b", "fixture-project-b", {}, "fixture-config-identity"),
    turn(5),
  );
  await persistUserMemoryChronicle(
    runtime(
      "fixture-project-a",
      "fixture-project-a",
      { workspaceIdentity: "fixture-memory-identity" },
      "fixture-config-identity",
    ),
    turn(6),
  );
  await persistUserMemoryChronicle(
    runtime(
      "fixture-project-b",
      "fixture-project-b",
      { workspaceIdentity: "fixture-memory-identity" },
      "fixture-other-identity",
    ),
    turn(7),
  );
  const entries = (await loadUserMemoryChronicle({ root, now: NOW })).entries;
  assert.equal(entries.length, 7);
  assert.equal(entries[0].source, entries[1].source);
  assert.notEqual(entries[1].source, entries[2].source);
  assert.equal(entries[3].source, entries[4].source);
  assert.equal(entries[5].source, entries[6].source);
  assert.equal(new Set(entries.map((entry) => entry.source)).size, 4);
  assert.doesNotMatch(
    await readFile(file, "utf8"),
    /fixture-project|fixture-config|fixture-memory/u,
  );
});

test("两个实际进程竞争事务，不丢记录或留下锁/临时文件", async (t) => {
  const { root } = await fixture(t);
  const loader = new URL("./typescript-loader.mjs", import.meta.url).href;
  const moduleUrl = new URL("../packages/core/src/memory/user-chronicle.ts", import.meta.url).href;
  const script = `import { appendUserMemoryChronicle } from ${JSON.stringify(moduleUrl)};
    for (let i=0;i<5;i++) await appendUserMemoryChronicle({root:process.argv[1],sessionId:process.argv[2],projectKey:"fixture",
      now:${NOW},turn:{origin:{turnId:"turn-"+i,branchGeneration:0},goal:"修复输入",status:"success",endedAt:${NOW}}});`;
  const child = (session) =>
    new Promise((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        ["--import", loader, "--input-type=module", "-e", script, root, session],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      proc.on("error", reject);
      proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
    });
  await Promise.all([child("session-a"), child("session-b")]);
  assert.equal((await loadUserMemoryChronicle({ root, now: NOW })).entries.length, 10);
  assert.deepEqual(await readdir(root), ["chronicle.json"]);
});

test("持久化损坏失败只写脱敏警告，不覆盖终态或原文件", async (t) => {
  const { storage, root, file } = await fixture(t);
  await mkdir(root, { recursive: true });
  await writeFile(file, "fixture-corrupt-secret");
  const logs = [];
  for (const status of ["success", "failed", "cancelled"]) {
    await persistUserMemoryChronicle(
      {
        config: { memory: { cliStorageRoot: storage, enabled: true, scope: "user" } },
        sessionId: "fixture",
        sessionPersisted: true,
        workspaceRoot: "fixture",
        workingDirectory: "fixture",
        isRemoteWorkspace: () => false,
        logger: { warn: (...args) => logs.push(args) },
        modelFactory: () => {
          throw new Error("禁止额外模型调用");
        },
      },
      turn(status, status),
    );
  }
  assert.equal(logs.length, 3);
  assert.doesNotMatch(JSON.stringify(logs), /fixture-corrupt-secret/u);
  assert.equal(await readFile(file, "utf8"), "fixture-corrupt-secret");
});

test("退出进程遗留的owner锁可以回收", async (t) => {
  const { root, file } = await fixture(t);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const lock = `${file}.lock`;
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner-exited.json"),
    JSON.stringify({ pid, startTime: 1, token: "exited" }),
  );
  await withShortFileTransaction(file, async () => {});
  assert.deepEqual(await readdir(root), []);
});

test("活owner锁短超时且不回收；PID复用可回收，释放不删后来owner", async (t) => {
  const { file } = await fixture(t);
  let callback = false;
  await withShortFileTransaction(file, async () => {
    const started = Date.now();
    await assert.rejects(
      withShortFileTransaction(file, async () => {
        callback = true;
      }),
    );
    assert.ok(Date.now() - started < 1600);
  });
  assert.equal(callback, false);
  const lock = `${file}.lock`;
  await mkdir(lock);
  const oldOwner = join(lock, "owner-fixture.json");
  await writeFile(
    oldOwner,
    JSON.stringify({ pid: process.pid, startTime: 1, token: "fixture", createdAt: 1 }),
  );
  const oldTime = new Date(Date.now() - 60_000);
  await utimes(lock, oldTime, oldTime);
  await withShortFileTransaction(file, async () => {
    callback = true;
  });
  assert.equal(callback, true);
  await withShortFileTransaction(file, async () => {
    for (const name of await readdir(lock)) await rm(join(lock, name));
    await writeFile(join(lock, "owner-later.json"), "later");
  });
  assert.deepEqual(await readdir(lock), ["owner-later.json"]);
});
