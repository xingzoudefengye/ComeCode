import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTuiSubmitPrompt } from "../packages/cli/src/tui-prompt-handler.ts";
import { acquireSessionWriterLease } from "../packages/adapters/src/storage/session-writer-lease.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-resume-"));
  const dbPath = join(root, "sessions.sqlite");
  const created = [];
  const closed = [];
  const resumed = [];
  const submit = createTuiSubmitPrompt(
    {
      env: {},
      cwd: () => root,
      skipUserConfig: true,
      loadDotenv: () => ({ keys: [], loaded: false }),
      resolveLatestSession: async () => ({ id: "session-current" }),
      startProcessProviderRegistryRuntime: async () => ({
        runtime: { registryService: {} },
        dispose() {},
      }),
      createZCodeApp: async ({ sessionId = "session-current" }) => {
        const release = await acquireSessionWriterLease({ dbPath, sessionId });
        created.push(sessionId);
        return {
          sessionId,
          runtime: {},
          listModels: async () => [{ providerId: "mock", modelId: "mock-model" }],
          resume: async () => {
            resumed.push(sessionId);
            return { response: "resumed", warnings: release.acquired ? [] : ["此会话也在其他窗口中打开，已继续恢复。"] };
          },
          loadSessionTranscript: async () => [],
          close: async () => {
            closed.push(sessionId);
            await release();
          },
        };
      },
    },
    { current: "auto" },
    "test",
  );
  t.after(async () => {
    await submit.close();
    await rm(root, { recursive: true, force: true });
  });
  await submit.getSessionMetadata();
  return { submit, dbPath, created, closed, resumed };
}

for (const command of ["/resume session-current", "/continue"]) {
  test(`${command} 复用当前 App，不与自己的真实 writer lease 冲突`, async (t) => {
    const f = await fixture(t);
    const result = await f.submit(command, {});
    assert.deepEqual(f.created, ["session-current"]);
    assert.deepEqual(f.closed, []);
    assert.deepEqual(f.resumed, ["session-current"]);
    assert.equal(result.sessionId, "session-current");
    assert.equal(result.resetSessionProjection, true);
    assert.deepEqual(result.restoredMessages, []);
    const observer = await acquireSessionWriterLease({ dbPath: f.dbPath, sessionId: "session-current" });
    assert.equal(observer.acquired, false);
    await observer();
  });
}

test("恢复其他会话成功后关闭旧 App 并释放其写锁", async (t) => {
  const f = await fixture(t);
  const result = await f.submit("/resume session-next", {});
  assert.equal(result.sessionId, "session-next");
  assert.deepEqual(f.created, ["session-current", "session-next"]);
  assert.deepEqual(f.closed, ["session-current"]);
  const release = await acquireSessionWriterLease({
    dbPath: f.dbPath,
    sessionId: "session-current",
  });
  await release();
});

test("其他持有者占用目标时继续恢复并显示提醒", async (t) => {
  const f = await fixture(t);
  const release = await acquireSessionWriterLease({ dbPath: f.dbPath, sessionId: "session-busy" });
  try {
    const result = await f.submit("/resume session-busy", {});
    assert.equal(result.sessionId, "session-busy");
    assert.match(result.response, /此会话也在/);
    assert.deepEqual(f.created, ["session-current", "session-busy"]);
    assert.deepEqual(f.closed, ["session-current"]);
    await f.submit.close();
    const observer = await acquireSessionWriterLease({ dbPath: f.dbPath, sessionId: "session-busy" });
    assert.equal(observer.acquired, false);
    await observer();
  } finally {
    await release();
  }
});
