import assert from "node:assert/strict";
import { test } from "node:test";
import { selectMemoryContextSnapshot } from "../packages/core/src/memory/context-projection.ts";
import {
  buildMemorySection,
  prepareMemoryContextSnapshots,
  MEMORY_CONTEXT_MAX_TOKENS,
  MEMORY_CONTEXT_MAX_CHARS,
} from "../packages/core/src/context/sections/memory.ts";
import { createContextBuilder } from "../packages/core/src/context/builder.ts";
import { estimateTokens } from "../packages/core/src/context/utils.ts";
import { reloadMemorySnapshot } from "../packages/core/src/runtime/methods/context.ts";
import { rebuildContextPrefix } from "../packages/core/src/runtime/methods/context-refresh.ts";
import { MessageHistoryImpl } from "../packages/core/src/agent/message-history.ts";
import { FileSystemPortError } from "../packages/contracts/dist/interfaces/file-system.port.js";

const snapshot = (file, body) => `## .ai/${file}\n\n${body}`;

test("记忆投影双根含包装守4000估算token，保持完整Markdown条目", () => {
  const projectContent = [
    snapshot("project.md", "# 核心约束\n\n- 不能删除用户文件\n- 保持公开接口\n"),
    snapshot("tasks.md", "# 任务\n\n- [x] 已完成任务\n- [ ] 尚未完成任务\n  - 子项必须保留\n"),
    snapshot(
      "decisions.md",
      Array.from(
        { length: 100 },
        (_, i) =>
          `- 2026-10-${String((i % 28) + 1).padStart(2, "0")}: 决策${i} ${"细节".repeat(80)}`,
      ).join("\n"),
    ),
    snapshot("memory.md", "# 例子\n\n```ts\nconst complete = true;\n```\n"),
  ].join("\n\n");
  const input = {
    projectRoot: "/fixture/.ai",
    projectContent,
    userRoot: "/fixture/user",
    userContent: "## user-memory/preferences.md\n\n- 请用中文\n",
  };
  const prepared = prepareMemoryContextSnapshots(input);
  const result = createContextBuilder({
    envInfo: { cwd: ".", platform: "test", shell: "test", osVersion: "test" },
    memoryRoot: prepared.projectRoot,
    memoryIndexContent: prepared.projectContent,
    userMemoryRoot: prepared.userRoot,
    userMemoryIndexContent: prepared.userContent,
  }).build();
  const sections = result.sections.filter((s) => ["memory", "user_memory"].includes(s.source));
  assert.ok(sections.reduce((sum, s) => sum + s.tokens, 0) <= MEMORY_CONTEXT_MAX_TOKENS);
  assert.ok(sections.reduce((sum, s) => sum + s.chars, 0) <= MEMORY_CONTEXT_MAX_CHARS);
  assert.ok(prepared.projectContent.includes("尚未完成任务"));
  assert.ok(prepared.projectContent.includes("子项必须保留"));
  assert.equal(prepared.projectContent.includes("已完成任务"), false);
  assert.deepEqual(prepareMemoryContextSnapshots(prepared), prepared, "投影再次进入构造器不漂移");
});

test("本地投影近期优先、重复去重、超大条目只留来源且不切代码块", () => {
  const input = snapshot(
    "decisions.md",
    "# 决策\n\n- 2026-01-01: 旧决定\n- 2026-10-07: 新决定\n- 2026-10-07: 新决定\n\n```ts\n" +
      "huge".repeat(20000) +
      "\n```\n",
  );
  const selected = selectMemoryContextSnapshot(input, { kind: "project", maxTokens: 120 });
  assert.ok(estimateTokens(selected) <= 120);
  assert.equal((selected.match(/新决定/gu) ?? []).length, 1);
  assert.ok(selected.indexOf("新决定") < selected.indexOf("旧决定"));
  assert.ok(selected.includes("decisions.md"));
  assert.equal(selected.includes("```"), false);
  assert.ok(selected.includes("More entries"));
});

test("刷新直接替换最新快照，不追加更新消息，冷初始化不复用旧记忆", async () => {
  let fileContent = "# 约束\n\n- 原来约束";
  const envInfo = { cwd: ".", platform: "test", shell: "test", osVersion: "test" };
  const skipped = [];
  const runtime = {
    loadProjectMemoryRoot: async () => "/fixture/.ai",
    loadUserMemoryRoot: async () => undefined,
    fileSystemPort: {
      readTextFile: async ({ path }) => {
        // 真实端口用 not_found 表示文件缺失，缺失的记忆文件应被静默跳过。
        if (!path.endsWith("project.md")) {
          throw new FileSystemPortError({ code: "not_found", message: "missing", path });
        }
        return { content: fileContent, sizeBytes: fileContent.length };
      },
    },
    readFileState: new Map(),
    now: () => new Date(),
    logMemorySkipped: (_trace, reason) => skipped.push(reason),
    contextInitialized: true,
    contextSourceSnapshot: { envInfo },
    contextBuilder: createContextBuilder({ envInfo }),
    createContextBuilderFromSnapshot: (_source, memoryRoot, options) =>
      createContextBuilder({
        envInfo,
        memoryRoot,
        memoryIndexContent: options.memoryIndexContent,
      }),
    messageHistory: new MessageHistoryImpl(),
  };
  runtime.messageHistory.init("规则");
  runtime.messageHistory.addUser("继续当前任务");
  await reloadMemorySnapshot(runtime, {});
  rebuildContextPrefix(runtime);
  const oldCount = runtime.messageHistory.getMessageCount();
  fileContent = "# 约束\n\n- 更新后约束";
  await reloadMemorySnapshot(runtime, {});
  rebuildContextPrefix(runtime);
  const entries = runtime.messageHistory.toRuntimeEntries();
  const text = entries.map((entry) => entry.message?.content ?? entry.content).join("\n");
  assert.match(text, /更新后约束/u);
  assert.equal(text.includes("原来约束"), false);
  assert.equal(runtime.messageHistory.getMessageCount(), oldCount);
  assert.equal(
    entries.some((entry) => entry.metadata?.source === "memory_update"),
    false,
  );
  const cold = { ...runtime, memoryIndexContent: "旧缓存", readFileState: new Map() };
  await reloadMemorySnapshot(cold, {});
  assert.equal(cold.memoryIndexContent, runtime.memoryIndexContent);
  await reloadMemorySnapshot(runtime, {});
  rebuildContextPrefix(runtime);
  assert.deepEqual(runtime.messageHistory.toRuntimeEntries(), entries);
  runtime.loadProjectMemoryRoot = async () => undefined;
  await reloadMemorySnapshot(runtime, {});
  rebuildContextPrefix(runtime);
  assert.equal(runtime.memoryIndexContent, undefined);
  assert.equal(
    runtime.messageHistory
      .toRuntimeEntries()
      .some((entry) => String(entry.message?.content).includes("更新后约束")),
    false,
  );
  assert.deepEqual(skipped, [], "缺失的记忆文件只跳过，不记为读取失败");
});

test("缺失记忆和无法容纳包装的预算不生成半段指令", () => {
  assert.equal(
    selectMemoryContextSnapshot(undefined, { kind: "project", maxTokens: 100 }),
    undefined,
  );
  assert.equal(buildMemorySection("/fixture", "重要", { maxTokens: 1 }), null);
  const section = buildMemorySection("/fixture", "# 规则\n\n- 保持约束", { maxTokens: 1000 });
  assert.ok(section.content.includes("保持约束"));
});
