import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  appendChronicleTurn,
  formatSessionChronicle,
  parseSessionChronicle,
  serializeSessionChronicle,
  summarizeChronicleTurn,
  sanitizeChronicleText,
} from "../packages/core/src/compact/chronicle.ts";
import {
  appendSessionChronicle,
  loadSessionChronicle,
  persistTurnChronicle,
} from "../packages/core/src/runtime/helpers/session-chronicle.ts";

const turn = (i, status = "success", generation = 0) => ({
  origin: {
    turnId: `turn-${i}`,
    messageStartId: `msg-${i}`,
    messageEndId: `end-${i}`,
    branchGeneration: generation,
  },
  goal: `第${i}轮修复终端输入`,
  response: `已修改文件并验证第${i}轮结果`,
  status,
  endedAt: 1_700_000_000_000 + i * 1000,
});

function storeFixture() {
  const values = new Map();
  let writes = 0;
  return {
    values,
    get writes() {
      return writes;
    },
    store: {
      sessionEntries: async ({ sessionID, type }) =>
        [...values.values()].filter(
          (entry) => entry.sessionID === sessionID && entry.type === type,
        ),
      saveSessionEntry: async (entry) => {
        writes++;
        values.set(entry.id, structuredClone(entry));
      },
      messages: () => {
        throw new Error("不应扫描原始历史");
      },
    },
  };
}

test("万轮史书固定序列化容量，最近优先，早期逐层合并且恢复不变", () => {
  let chronicle = { version: 1, entries: [] };
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) {
    chronicle = appendChronicleTurn(chronicle, turn(i));
    assert.ok(JSON.stringify(serializeSessionChronicle(chronicle)).length <= 6000);
    assert.ok(chronicle.entries.length <= 22);
  }
  assert.equal(chronicle.entries.at(-1).origin.turnId, "turn-9999");
  assert.ok(chronicle.entries.some((entry) => entry.recency === "earlier" && entry.count >= 4));
  assert.ok(chronicle.entries.some((entry) => entry.recency === "oldest" && entry.count >= 16));
  assert.match(formatSessionChronicle(chronicle), /阶段|早期概括/u);
  assert.match(formatSessionChronicle(chronicle), /第9999轮/u);
  assert.deepEqual(parseSessionChronicle(serializeSessionChronicle(chronicle)), chronicle);
  assert.ok(performance.now() - started < 10_000);
});

test("失败取消不采用成功部分回复，回合成功不误标目标完成，小结去敏感", () => {
  for (const status of ["failed", "cancelled", "blocked"]) {
    const summary = summarizeChronicleTurn({
      goal: "修复故障",
      response: "全部完成且成功",
      status,
    });
    assert.doesNotMatch(summary, /全部完成且成功/u);
    assert.match(summary, /未完成|未执行/u);
  }
  assert.match(summarizeChronicleTurn(turn(1)), /目标未核验/u);
  const safe = sanitizeChronicleText(
    'api_key="fixture-secret" Authorization: Bearer abcdefg\n密码：secret123 sk-fixturecredential123',
  );
  assert.doesNotMatch(safe, /fixture-secret|abcdefg|secret123|sk-fixture/u);
});

test("单session entry覆盖更新、并发串行、空损坏降级且分支隔离", async () => {
  const f = storeFixture();
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      appendSessionChronicle({ sessionStore: f.store, sessionId: "sess-test", turn: turn(i) }),
    ),
  );
  assert.equal(f.values.size, 1);
  const resumed = await loadSessionChronicle({ sessionStore: f.store, sessionId: "sess-test" });
  assert.equal(resumed.entries.at(-1).origin.turnId, "turn-49");
  const other = await loadSessionChronicle({
    sessionStore: f.store,
    sessionId: "sess-test",
    scope: { branchGeneration: 1 },
  });
  assert.equal(formatSessionChronicle(other), "");
  assert.equal(formatSessionChronicle(parseSessionChronicle({ version: 999 })), "");
  assert.equal(parseSessionChronicle("broken").entries.length, 0);
  const key = [...f.values.keys()][0];
  f.values.get(key).data = { version: 999 };
  await appendSessionChronicle({ sessionStore: f.store, sessionId: "sess-test", turn: turn(51) });
  assert.equal(
    (await loadSessionChronicle({ sessionStore: f.store, sessionId: "sess-test" })).entries.length,
    1,
  );
});

test("史书写入失败不阻断正常回合，日志不回显凭据或原文", async () => {
  const logs = [];
  await persistTurnChronicle({
    sessionPersisted: true,
    sessionId: "sess-test",
    turn: turn(1),
    sessionStore: {
      sessionEntries: async () => {
        throw new Error("fixture-secret");
      },
      saveSessionEntry: async () => {},
    },
    logger: { warn: (...args) => logs.push(args) },
  });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /fixture-secret/u);
});
