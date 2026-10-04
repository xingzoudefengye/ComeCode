import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteSessionStore } from "../packages/adapters/dist/storage/index.js";
import { createAdminSessions } from "../packages/cli/src/admin/sessions.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-admin-session-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, dbPath: join(root, "sessions.sqlite") };
}
const url = (query = "") => new URL(`http://localhost/api/sessions${query}`);

test("会话只读不存在库为空且不创建目录；不存在详情/修改不创建库或 lease", async t => {
  const f = await fixture(t), dbPath = join(f.root, "missing", "sessions.sqlite");
  const admin = createAdminSessions({ sessionDbPath: dbPath, env: {} });
  try {
    assert.deepEqual((await admin.list(url())).sessions, []);
    await assert.rejects(admin.detail("missing", url()), { status: 404 });
    await assert.rejects(admin.update("missing", { expectedUpdated: 1, title: "测试" }), { status: 404 });
    assert.deepEqual(await readdir(f.root), []);
  } finally { admin.close(); }
});

test("会话只读查询跳过迁移并拒绝写；归档 SQL 先筛选再分页，标题30字，恢复含 cwd", async t => {
  const f = await fixture(t);
  const writer = createSqliteSessionStore({ dbPath: f.dbPath });
  for (let index = 0; index < 4; index++) {
    await writer.createSession({ id: `boundary-${index}`, projectID: "fixture", slug: `s-${index}`, directory: "/fixture/work space", title: `title-${index}`, version: "fixture", time: { created: index + 1, updated: index + 1 } });
    if (index % 2 === 0) await writer.updateSession({ id: `boundary-${index}`, timeArchived: 100, timeUpdated: index + 1 });
  }
  writer.close();
  const before = await readFile(f.dbPath);
  const readOnly = createSqliteSessionStore({ dbPath: f.dbPath, readOnly: true });
  try { await assert.rejects(readOnly.updateSession({ id: "boundary-0", title: "拒绝写入" }), /readonly|read.only/i); }
  finally { readOnly.close(); }
  const admin = createAdminSessions({ sessionDbPath: f.dbPath, env: {} });
  try {
    assert.deepEqual((await admin.list(url("?archived=true&limit=1"))).sessions.map(s => s.id), ["boundary-2"]);
    assert.deepEqual((await admin.list(url("?archived=true&limit=1&offset=1"))).sessions.map(s => s.id), ["boundary-0"]);
    assert.deepEqual((await admin.list(url())).sessions.map(s => s.id), ["boundary-3", "boundary-1"]);
    const detail = await admin.detail("boundary-0", url());
    assert.match(detail.resumeCommand, /--cwd "\/fixture\/work space"/);
    assert.deepEqual(await readFile(f.dbPath), before);
    await assert.rejects(admin.update("boundary-0", { expectedUpdated: detail.session.time.updated, title: "字".repeat(31) }), { status: 400 });
    const updated = await admin.update("boundary-0", { expectedUpdated: detail.session.time.updated, title: "字".repeat(30) });
    assert.equal(updated.title.length, 30);
  } finally { admin.close(); }

  // 未迁移旧库只读打开不添加 schema；不能把读取变成启动迁移。
  const legacyPath = join(f.root, "legacy.sqlite");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("create table sentinel(value text)");
  legacy.close();
  const old = await readFile(legacyPath);
  const noMigration = createSqliteSessionStore({ dbPath: legacyPath, readOnly: true });
  noMigration.close();
  assert.deepEqual(await readFile(legacyPath), old);
});
