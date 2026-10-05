import assert from "node:assert/strict";
import { test } from "node:test";
import { readSessionContextToolEntry } from "../packages/core/src/tool/handlers/read-session-context.ts";
import { appendSessionChronicle } from "../packages/core/src/runtime/helpers/session-chronicle.ts";

function fixture(messages = []) {
  const entries = new Map();
  let reads = 0;
  const session = {
    id: "sess_00000000-0000-0000-0000-000000000001",
    title: "测试",
    directory: "/fixture",
    time: { created: 1, updated: 1 },
  };
  const store = {
    getSession: async () => session,
    sessionEntries: async () => [...entries.values()],
    saveSessionEntry: async (entry) => entries.set(entry.id, entry),
    messages: async () => {
      reads++;
      return messages;
    },
  };
  const context = {
    sessionStore: store,
    sessionId: "sess_00000000-0000-0000-0000-000000000001",
    abortSignal: new AbortController().signal,
    model: {
      generateText: () => {
        throw new Error("不允许调用模型");
      },
      streamText: () => {
        throw new Error("不允许调用模型");
      },
    },
  };
  return {
    store,
    session,
    context,
    entries,
    get reads() {
      return reads;
    },
  };
}
const input = {
  sessionId: "sess_00000000-0000-0000-0000-000000000001",
  query: "之前做了什么",
  strategy: "handoff",
  maxTokens: 1000,
};
const msg = (id, role, text) => ({
  info: { id, role, time: { created: 1 } },
  parts: [{ id: `${id}-part`, type: "text", text }],
});

test("历史概括只读有界史书，不扫描消息也不调用辅助模型", async () => {
  const f = fixture();
  await appendSessionChronicle({
    sessionStore: f.store,
    sessionId: "sess_00000000-0000-0000-0000-000000000001",
    turn: {
      origin: { turnId: "turn-fixture", branchGeneration: 0 },
      goal: "修复输入框",
      response: "已修复并提交",
      status: "success",
      endedAt: Date.now(),
    },
  });
  const result = await readSessionContextToolEntry.handler(input, f.context);
  assert.equal(result.source, "local");
  assert.match(result.content, /修复输入框/u);
  assert.ok(result.content.length <= 1000);
  assert.equal(f.reads, 0);
});

test("旧会话无史书或损坏时本地降级，compact前消息可查询，排除撤销分支", async () => {
  for (const damaged of [false, true]) {
    const f = fixture([
      msg("old", "user", "之前修复过图片粘贴"),
      {
        info: { id: "boundary", role: "user", time: { created: 2 } },
        parts: [{ id: "cmp", type: "compaction" }],
      },
      msg("new", "assistant", "最近改了配置"),
    ]);
    if (damaged)
      f.entries.set("broken", {
        id: "sess_00000000-0000-0000-0000-000000000001:chronicle",
        sessionID: "sess_00000000-0000-0000-0000-000000000001",
        type: "runtime/session_chronicle",
        data: { version: 999 },
      });
    const result = await readSessionContextToolEntry.handler(
      { ...input, query: "图片粘贴", strategy: "relevant" },
      f.context,
    );
    assert.equal(result.source, "local");
    assert.match(result.content, /图片粘贴/u);
    assert.equal(f.reads, 1);
    f.session.revert = { targetMessageID: "old", keptMessageIDs: ["old"] };
    const branch = await readSessionContextToolEntry.handler(
      { ...input, query: "最近" },
      f.context,
    );
    assert.doesNotMatch(branch.content, /最近改了配置/u);
  }
});

test("历史读取取消和不存在会话保持既有结果，无额外模型调用", async () => {
  const f = fixture();
  f.store.getSession = async () => null;
  assert.equal((await readSessionContextToolEntry.handler(input, f.context)).status, "not_found");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readSessionContextToolEntry.handler(input, { ...f.context, abortSignal: controller.signal }),
  );
});
