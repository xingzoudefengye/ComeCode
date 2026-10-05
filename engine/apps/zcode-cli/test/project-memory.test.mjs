import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  formatProjectMemorySnapshot,
  resolveWorkspaceProjectMemoryRoot,
  rollMemoryMarkdown,
} from "../packages/core/src/memory/project-files.ts";
import { buildMemorySection } from "../packages/core/src/context/sections/memory.ts";
import { runMemoryCommand } from "../packages/cli/src/memory-command.ts";
import {
  formatUserMemorySnapshot,
  USER_MEMORY_FILES,
  USER_MEMORY_MAX_TOTAL_CHARS,
} from "../packages/core/src/memory/user-files.ts";

test("项目记忆根目录位于工作区 .ai，快照按固定顺序并限制总量", () => {
  assert.equal(resolveWorkspaceProjectMemoryRoot("C:/work/demo"), join("C:/work/demo", ".ai"));
  const snapshot = formatProjectMemorySnapshot({
    "project.md": "项目说明",
    "decisions.md": "决策",
    "tasks.md": "任务",
  });
  assert.ok(snapshot);
  assert.ok(snapshot.content.indexOf("project.md") < snapshot.content.indexOf("decisions.md"));
  assert.ok(snapshot.content.indexOf("decisions.md") < snapshot.content.indexOf("tasks.md"));
});

test("memory.md 超过上限时滚动压缩最旧记录", () => {
  const oldEntry = `## 2026-01-01\n\n${"旧记录".repeat(3_000)}\n`;
  const recent = "## 2026-10-02\n\n保留最近决策。\n";
  const rolled = rollMemoryMarkdown(`# 项目记忆\n\n${oldEntry}\n${recent}`, 1_000);
  assert.match(rolled, /滚动摘要/u);
  assert.match(rolled, /保留最近决策/u);
  assert.equal(rolled.includes("旧记录".repeat(100)), false);
  assert.ok(rolled.length <= 1_000);
});

import { resolveMemoryRoots } from "../packages/core/src/runtime/helpers/project-memory.ts";
import { reloadMemorySnapshot } from "../packages/core/src/runtime/methods/context.ts";
import { readSessionContextToolEntry } from "../packages/core/src/tool/handlers/read-session-context.ts";
import { createContextBuilder } from "../packages/core/src/context/builder.ts";
import { MEMORY_CONTEXT_MAX_CHARS } from "../packages/core/src/context/sections/memory.ts";

test("用户记忆根目录不携带项目路径，两个项目共享同一目录", () => {
  const cliStorageRoot = "C:/home/.comecode/cli";
  const config = { memory: { enabled: true, scope: "both", cliStorageRoot } };
  const first = resolveMemoryRoots(config, "C:/work/first");
  const second = resolveMemoryRoots(config, "C:/work/second");
  assert.equal(first.user, join(cliStorageRoot, "memories", "user"));
  assert.equal(first.user, second.user);
  assert.notEqual(first.project, second.project);
  for (const memory of [
    { enabled: false, scope: "user" },
    { enabled: true, use: false, scope: "both" },
  ]) {
    assert.deepEqual(
      resolveMemoryRoots({ memory: { ...memory, cliStorageRoot } }, "C:/work/first"),
      {},
    );
  }
  assert.equal(
    resolveMemoryRoots({ memory: { enabled: true, cliStorageRoot } }, "C:/work/first").user,
    undefined,
  );
});

test("用户记忆快照固定顺序并限制总量", () => {
  const snapshot = formatUserMemorySnapshot({
    "profile.md": "用户偏好",
    "preferences.md": "输出习惯",
    "history.md": "历史",
  });
  assert.ok(snapshot);
  assert.ok(snapshot.content.indexOf("profile.md") < snapshot.content.indexOf("preferences.md"));
  assert.equal(snapshot.content.includes("history.md"), false);
  assert.equal(snapshot.content.includes("历史"), false);
  assert.deepEqual(USER_MEMORY_FILES, ["profile.md", "preferences.md"]);
  assert.ok(snapshot.content.includes("user-memory/profile.md"));
});

test("用户稳定偏好预算含标题，无伪历史滚动摘要", () => {
  const snapshot = formatUserMemorySnapshot({
    "profile.md": "明确偏好\n".repeat(1000),
    "preferences.md": "输出习惯\n".repeat(1000),
  });
  assert.ok(snapshot.content.length <= USER_MEMORY_MAX_TOTAL_CHARS);
  assert.equal(snapshot.content.includes("滚动摘要"), false);
});

test("快照刷新重新读取本地双根，不调用模型，禁用清空旧缓存", async () => {
  let reads = 0;
  const runtime = {
    loadProjectMemoryRoot: async () => "/project/.ai",
    loadUserMemoryRoot: async () => "/storage/memories/user",
    fileSystemPort: {
      readTextFile: async ({ path }) => {
        reads++;
        return { content: `明确偏好 ${path}`, sizeBytes: 1 };
      },
    },
    readFileState: new Map(),
    now: () => new Date(),
  };
  await reloadMemorySnapshot(runtime, {});
  assert.equal(reads, 7);
  assert.match(runtime.userMemoryIndexContent, /明确偏好/u);
  runtime.loadProjectMemoryRoot = async () => undefined;
  runtime.loadUserMemoryRoot = async () => undefined;
  await reloadMemorySnapshot(runtime, {});
  assert.equal(reads, 7);
  assert.equal(runtime.userMemoryIndexContent, undefined);
  assert.equal(runtime.memoryIndexContent, undefined);
});

test("用户历史按需工具禁用返回不可用，不读取会话消息", async () => {
  const result = await readSessionContextToolEntry.handler(
    { scope: "user", sessionId: "sess_test", query: "近期目标" },
    { abortSignal: new AbortController().signal },
  );
  assert.equal(result.status, "not_found");
  assert.equal(result.messageCount, 0);
});
test("双根 system 预算含所有 headers，用户背景先于项目且不带史书", () => {
  const result = createContextBuilder({
    workingDirectory: ".",
    currentDate: "2026-10-05",
    envInfo: { cwd: ".", platform: "test", shell: "test", osVersion: "test", nodeVersion: "test" },
    memoryRoot: "/project/.ai",
    memoryIndexContent: "项目".repeat(30000),
    userMemoryRoot: "/storage/user",
    userMemoryIndexContent: "用户".repeat(2000),
  }).build();
  const memory = result.sections.filter((s) => ["memory", "user_memory"].includes(s.source));
  assert.deepEqual(
    memory.map((s) => s.source),
    ["user_memory", "memory"],
  );
  assert.ok(memory.reduce((sum, s) => sum + s.chars, 0) <= MEMORY_CONTEXT_MAX_CHARS);
  assert.match(memory[0].content, /scope='user'/u);
  assert.match(memory[1].content, /Read an existing file/u);
});

test("用户历史按需工具读取同 storage 的 managed chronicle，无模型与消息回读", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-user-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { appendUserMemoryChronicle } =
    await import("../packages/core/src/memory/user-chronicle.ts");
  await appendUserMemoryChronicle({
    root,
    sessionId: "sess_first",
    projectKey: "first",
    turn: {
      origin: { turnId: "turn_first", branchGeneration: 0 },
      goal: "完成测试",
      response: "测试完成",
      status: "success",
      endedAt: Date.now(),
    },
  });
  const result = await readSessionContextToolEntry.handler(
    { scope: "user", sessionId: "sess_second", query: "测试", strategy: "handoff" },
    { userMemoryRoot: root, abortSignal: new AbortController().signal },
  );
  assert.equal(result.status, "success");
  assert.ok(result.content.length <= 6000);
});

test("用户记忆以独立稳定 system section 注入", () => {
  const section = buildMemorySection(
    "C:/home/.comecode/cli/memories/user",
    "## user-memory/profile.md\n\n用户偏好",
    { kind: "user" },
  );
  assert.ok(section);
  assert.equal(section.source, "user_memory");
  assert.equal(section.cacheHint, "stable");
  assert.equal(section.injectionTarget, "system");
  assert.match(section.content, /cross-project/u);
});

test("项目记忆注入稳定 system section，不重复放进 meta user", () => {
  const section = buildMemorySection("C:/work/demo/.ai", "## .ai/project.md\n\n项目目标");
  assert.ok(section);
  assert.equal(section.cacheHint, "stable");
  assert.equal(section.injectionTarget, "system");
  assert.match(section.content, /项目目标/u);
});

test("memory init 创建 .ai 模板且不覆盖用户已有文件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const result = await runMemoryCommand(
    { argv: [], stdin: new PassThrough(), stdout, stderr },
    { json: false },
    { cwd: () => root },
    ["init"],
  );
  assert.equal(result, 0);
  const projectPath = join(root, ".ai", "project.md");
  const original = await readFile(projectPath, "utf8");
  assert.match(original, /项目说明/u);
  await writeFile(projectPath, "# 用户内容\n", "utf8");
  await runMemoryCommand(
    { argv: [], stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
    { json: false },
    { cwd: () => root },
    ["init"],
  );
  assert.equal(await readFile(projectPath, "utf8"), "# 用户内容\n");
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /\.ai\/\.local\//u);
  assert.match(Buffer.concat(output).toString("utf8"), /项目记忆目录/u);
});
