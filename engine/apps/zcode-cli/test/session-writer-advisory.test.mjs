import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createZCodeApp } from "../packages/bootstrap/src/app/create-app.ts";
import { createSqliteSessionStore } from "../packages/adapters/dist/storage/index.js";
import { acquireSessionWriterLease } from "../packages/adapters/src/storage/session-writer-lease.ts";

const NOTICE = "此会话也在其他窗口中打开，已继续恢复。";

test("共享 SQLite 同会话两个真实 App 可打开和恢复，提醒可见且关闭互不释放锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-advisory-app-"));
  const dbPath = join(root, "sessions.sqlite");
  const configPath = join(root, "config.json");
  const sessionId = "session-advisory";
  const apps = [];
  const events = [];
  let store;
  try {
    await writeFile(configPath, JSON.stringify({ storage: { dir: root, sessionDbPath: dbPath }, mcp: { enabled: false }, skills: { enabled: false } }));
    store = createSqliteSessionStore({ dbPath });
    await store.createSession({ id: sessionId, projectID: "fixture", directory: root, title: "Keep title", slug: "fixture", version: "test" });
    const options = {
      sessionId, sessionStore: store, resume: true, skipUserConfig: true, projectConfigPath: configPath,
      env: { COMECODE_DATA_BASE_DIR: root },
      providerRegistry: { getView: () => ({ providers: [] }), onDidChange: () => () => {}, validateSelection: () => ({ ok: false }), getProvider: () => undefined, getModel: () => undefined },
      modelAdapter: { setModelIoFullRetentionEnabled() {}, addStatusSink() {}, createModel() { throw new Error("禁止调用模型"); } },
      runtimeConfig: { workingDirectory: root, dynamicWorkflowEnabled: false, memory: { extractionEnabled: false } },
    };
    const first = await createZCodeApp(options);
    apps.push(first);
    assert.equal((await first.resume()).warnings, undefined);
    const second = await createZCodeApp({ ...options, eventSink: { onSessionEvent: event => events.push(event) } });
    apps.push(second);
    assert.ok(events.some(event => event.type === "system_message" && event.payload.content === NOTICE));
    const resumedEvents = [];
    const restored = await second.resume({ onEvent: event => resumedEvents.push(event) });
    assert.deepEqual(restored.warnings, [NOTICE]);
    assert.ok(resumedEvents.some(event => event.type === "system_message" && event.payload.content === NOTICE));
    assert.equal((await store.getSession(sessionId)).title, "Keep title");
    await second.close();
    apps.pop();
    const busy = await acquireSessionWriterLease({ dbPath, sessionId });
    assert.equal(busy.acquired, false);
    await busy();
    // 冲突 App 的创建失败也不得释放 first 的锁。
    await assert.rejects(createZCodeApp({ ...options, modelAdapter: { setModelIoFullRetentionEnabled() { throw new Error("fixture startup failure"); } } }), /fixture startup failure/);
    const stillBusy = await acquireSessionWriterLease({ dbPath, sessionId });
    assert.equal(stillBusy.acquired, false);
    await stillBusy();
    await first.resume();
    await first.close();
    apps.pop();
    const available = await acquireSessionWriterLease({ dbPath, sessionId });
    assert.equal(available.acquired, true);
    await available();
  } finally {
    for (const app of apps.reverse()) await app.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("lease 非占用文件系统故障仍正常传播", async () => {
  const root = await mkdtemp(join(tmpdir(), "comecode-advisory-io-"));
  try {
    const dbPath = join(root, "sessions.sqlite");
    await writeFile(`${dbPath}.writers`, "fixture");
    await assert.rejects(acquireSessionWriterLease({ dbPath, sessionId: "fixture" }), { code: "EEXIST" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
