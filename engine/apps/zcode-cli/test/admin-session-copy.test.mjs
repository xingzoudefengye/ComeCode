import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteSessionStore } from "../packages/adapters/dist/storage/index.js";
import { createAdminSessions } from "../packages/cli/src/admin/sessions.ts";
import { ADMIN_SESSIONS_SCRIPT } from "../packages/cli/src/admin/session-assets.ts";

function pageFixture(responses, clipboard) {
  const elements = new Map();
  const node = (tag, textContent, className) => ({
    tag, textContent, className, children: [], attributes: {},
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { for (const item of this.children) { if (item.className?.split(' ').includes(selector.slice(1))) return item; const nested = item.querySelector?.(selector); if (nested) return nested; } return null; },
    remove() {}, focus() {}, select() {},
  });
  const get = id => {
    if (!elements.has(id)) elements.set(id, node("div"));
    return elements.get(id);
  };
  const context = vm.createContext({
    $: get, node, URLSearchParams, navigator: { clipboard },
    button: (text, onclick, className) => Object.assign(node("button", text, className), { onclick }),
    api: async () => responses.shift(),
  });
  new vm.Script(ADMIN_SESSIONS_SCRIPT).runInContext(context);
  return {
    get, context,
    load: (id = "fixture", offset = 0, append = false) => new vm.Script(`loadSessionDetail(${JSON.stringify(id)}, ${offset}, ${append})`).runInContext(context),
  };
}
const response = (messages, extra = {}) => ({
  session: { title: "Fixture", directory: "/fixture", time: { updated: 1 } },
  messages, resumeCommand: "comecode --resume fixture", ...extra,
});

test("隐藏空正文，复制单条正文、会话ID及分页已加载对话，切会话不串内容", async () => {
  const copies = [];
  const f = pageFixture([
    response([{ role: "agent", content: "" }, { role: "agent", content: " \n " }, { role: "user", content: "问题\n第二行" }], { hasMore: true, nextOffset: 50 }),
    response([{ role: "agent", content: "答复", truncated: true }]),
    response([{ role: "user", content: "新会话内容" }]),
  ], { writeText: async text => copies.push(text) });
  await f.load();
  const detail = f.get("session-detail");
  const history = detail.querySelector(".session-history");
  const actions = detail.querySelector(".actions");
  const copyAll = actions.children.find(item => item.textContent === "复制已加载对话");
  assert.equal(history.children.filter(item => item.tag === "article").length, 1);
  const entry = history.children[0];
  await entry.children[0].children[1].onclick();
  assert.equal(copies.at(-1), "问题\n第二行");
  await actions.children.find(item => item.textContent === "复制会话 ID").onclick();
  assert.equal(copies.at(-1), "fixture");
  await copyAll.onclick();
  assert.equal(copies.at(-1), "用户\n问题\n第二行");
  await f.load("fixture", 50, true);
  await copyAll.onclick();
  assert.equal(copies.at(-1), "用户\n问题\n第二行\n\n助手\n答复\n[内容已截断]");
  await f.load("second");
  await detail.querySelector(".actions").children.find(item => item.textContent === "复制已加载对话").onclick();
  assert.equal(copies.at(-1), "用户\n新会话内容");
});

test("详情保留标题，角色与复制图标位于独立气泡上方，分页不重复标题", async () => {
  const f = pageFixture([
    response([{ role: "user", content: "短问题" }, { role: "agent", content: "答复\n第二行" }], { hasMore: true, nextOffset: 50 }),
    response([{ role: "agent", content: "后续答复" }]),
    response([], { session: { title: "", time: { updated: 2 } } }),
  ], {});
  await f.load();
  const detail = f.get("session-detail");
  assert.equal(detail.querySelector(".session-detail-title").textContent, "Fixture");
  const entries = detail.querySelector(".session-history").children.filter(item => item.tag === "article");
  assert.equal(entries[0].className, "session-message session-message-user");
  assert.equal(entries[1].className, "session-message session-message-assistant");
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.children[0].className, "session-message-heading");
    assert.equal(entry.children[0].children[0].textContent, index === 0 ? "用户" : "助手");
    const copy = entry.children[0].children[1];
    assert.equal(copy.attributes["aria-label"], "复制正文");
    assert.match(copy.innerHTML, /<svg/);
    assert.equal(entry.children[1].className, "session-message-bubble");
    assert.equal(entry.children[1].children[0].tag, "pre");
  }
  await f.load("fixture", 50, true);
  assert.equal(detail.querySelector(".session-detail-header").children.filter(item => item.tag === "h2").length, 1);
  await f.load("untitled");
  assert.equal(detail.querySelector(".session-detail-title").textContent, "未命名会话");
});

test("正文空页保留下一页入口，复制失败明确提示，旧浏览器复制降级清理并恢复焦点", async () => {
  const f = pageFixture([response([{ role: "agent", content: "" }], { hasMore: true, nextOffset: 50 })], {
    writeText: async () => { throw new Error("denied"); },
  });
  await f.load();
  const detail = f.get("session-detail");
  assert.equal(detail.querySelector(".session-history").children.length, 1);
  assert.equal(detail.querySelector(".actions").children.find(item => item.textContent === "复制已加载对话").disabled, true);
  await detail.querySelector(".actions").children.find(item => item.textContent === "复制会话 ID").onclick();
  assert.match(f.get("session-status").textContent, /复制失败/);
  for (const accepted of [true, false]) {
    let field, removed = false, focused = false;
    f.context.navigator = {};
    f.context.document = {
      activeElement: { focus: () => { focused = true; } }, getSelection: () => null,
      createElement: () => field = { style: {}, select() {}, remove() { removed = true; } },
      body: { append() {} }, execCommand: command => { assert.equal(command, "copy"); return accepted; },
    };
    await new vm.Script('copyConversationContent("正文")').runInContext(f.context);
    assert.equal(field.value, "正文");
    assert.equal(removed, true);
    assert.equal(focused, true);
    assert.match(f.get("session-status").textContent, accepted ? /已复制/ : /复制失败/);
  }
});

test("搜索框默认常显，Esc清空不收起，搜索与归档保留条件", async () => {
  const f = pageFixture(Array.from({ length: 6 }, () => ({ sessions: [], hasMore: false })), {});
  const input = f.get("session-search"), toggle = f.get("session-search-toggle");
  let restored = false;
  toggle.focus = () => { restored = true; };
  assert.equal(f.get("session-search-form").hidden, false);
  input.value = "fixture";
  await toggle.onclick();
  assert.equal(input.value, "fixture");
  f.get("session-filter").value = "archived";
  await f.get("session-filter").onchange();
  assert.equal(f.get("session-archived").checked, true);
  assert.equal(input.value, "fixture");
  await input.onkeydown({ key: "Escape", preventDefault() {} });
  assert.equal(f.get("session-search-form").hidden, false);
  assert.equal(input.value, "");
  assert.equal(restored, true);
});

test("列表小按钮行内重命名，Enter保存，Esc取消，失败不清除输入", async () => {
  const f = pageFixture([], {}), calls = [];
  f.context.api = async (path, method, body) => {
    calls.push({ path, method, body });
    return { sessions: [{ id: "fixture", title: body?.title ?? "新标题", directory: "/fixture", time: { updated: 2 } }], hasMore: false };
  };
  const run = code => new vm.Script(code).runInContext(f.context);
  run('currentSessions = [{id:"fixture",title:"旧标题",directory:"/fixture",time:{updated:1}}]; renderSessionList()');
  const row = f.get("session-list").children[0];
  row.children[1].children[0].onclick();
  assert.equal(row.children[0].maxLength, 30);
  row.children[0].value = "新标题";
  await row.children[0].onkeydown({ key: "Enter", preventDefault() {} });
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].body.title, "新标题");
  assert.equal(calls[0].body.expectedUpdated, 1);
  const next = f.get("session-list").children[0];
  next.children[1].children[0].onclick();
  next.children[0].onkeydown({ key: "Escape", preventDefault() {} });
  assert.equal(calls.length, 2);
  const failed = f.get("session-list").children[0];
  failed.children[1].children[0].onclick();
  f.context.api = async () => { throw new Error("会话正在使用"); };
  failed.children[0].value = "保留草稿";
  await failed.children[1].onclick();
  assert.equal(failed.children[0].value, "保留草稿");
  assert.equal(failed.children[1].disabled, false);
  assert.match(f.get("session-status").textContent, /正在使用/);
});

test("正文 API 过滤工具和思考专用消息，原始分页游标仍可到达后续正文", async t => {
  const root = await mkdtemp(join(tmpdir(), "comecode-session-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "sessions.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  try {
    await store.createSession({ id: "copy-session", projectID: "fixture", slug: "fixture", directory: "/fixture", title: "复制", version: "test", time: { created: 1, updated: 1 } });
    for (let index = 0; index < 52; index++) {
      const id = `copy-${index}`;
      await store.saveMessage({ id, sessionID: "copy-session", role: "assistant", time: { created: index + 1, completed: index + 1 } });
      await store.savePart({ id: `part-${index}`, messageID: id, sessionID: "copy-session", type: index < 50 ? "reasoning" : "text", text: index < 50 ? "内部思考" : "可见答复" });
    }
  } finally { store.close(); }
  const admin = createAdminSessions({ sessionDbPath: dbPath, env: {} });
  try {
    const first = await admin.detail("copy-session", new URL("http://localhost/api/sessions/copy-session"));
    assert.deepEqual(first.messages, []);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 50);
    const next = await admin.detail("copy-session", new URL("http://localhost/api/sessions/copy-session?offset=50"));
    assert.equal(next.messages.length, 2);
    assert.equal(next.messages[0].content, "可见答复");
    assert.equal(next.hasMore, false);
  } finally { admin.close(); }
});
