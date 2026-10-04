import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore, acquireSessionWriterLease } from "../packages/adapters/dist/storage/index.js";
import { startAdminServer } from "../packages/cli/src/admin/server.ts";
import vm from "node:vm";
import { ADMIN_SESSIONS_SCRIPT } from "../packages/cli/src/admin/session-assets.ts";

test("全部会话/按项目切换仅分组当前页，同名目录不同路径不合并，空态保留", () => {
  const elements = new Map();
  const node = (tag, text, className) => ({ tag, textContent: text, className, children: [], attributes: {},
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const get = id => { if (!elements.has(id)) elements.set(id, node("div")); return elements.get(id); };
  const context = vm.createContext({ $: get, node, URLSearchParams,
    button: (text, onclick, className) => Object.assign(node("button", text, className), {onclick}),
  });
  new vm.Script(ADMIN_SESSIONS_SCRIPT).runInContext(context);
  const run = code => new vm.Script(code).runInContext(context);
  run('currentSessions = [{id:"a",title:"A",directory:"/first/app",time:{}},{id:"b",title:"B",directory:"/second/app",time:{}},{id:"c",title:"C",directory:"/first/app",time:{archived:1}}]; renderSessionList()');
  assert.equal(get("session-list").children.length, 3);
  run("sessionView = 'project'; renderSessionList()");
  assert.equal(get("session-list").children.length, 2);
  assert.equal(get("session-list").children[0].children[0].textContent, "/first/app");
  assert.equal(get("session-list").children[0].children.length, 3);
  assert.match(get("session-view-hint").textContent, /当前页.*非全量/);
  run("sessionView = 'all'; renderSessionList()");
  assert.equal(get("session-list").children.length, 3);
  assert.equal(run("currentSessions.length"), 3);
  run("currentSessions = []; renderSessionList()");
  assert.equal(get("session-list").children.length, 0);
});

test("桌面恢复仅按声明能力展示，通过授权 API 发起且防重复点击", async () => {
  for (const available of [false, true]) {
    const elements = new Map(), calls = [];
    const node = (tag, text, className) => ({tag,textContent:text,className,children:[],
      append(...items){this.children.push(...items);},replaceChildren(...items){this.children=[...items];},
      setAttribute(){},querySelector(selector){return this.children.find(item => selector === '.session-history' && item.className === 'session-history') || null;},
    });
    const get = id => {if (!elements.has(id)) elements.set(id,node('div')); return elements.get(id);};
    const context = vm.createContext({$:get,node,URLSearchParams,
      button:(text,onclick,className)=>Object.assign(node('button',text,className),{onclick}),
      api:async(path,method,body)=>{calls.push({path,method,body});return {session:{title:'Fixture',directory:'/fixture',time:{updated:1}},messages:[],resumeCommand:'comecode --resume fixture',desktopResumeAvailable:available};},
    });
    new vm.Script(ADMIN_SESSIONS_SCRIPT).runInContext(context);
    await new vm.Script('loadSessionDetail("fixture")').runInContext(context);
    assert.equal(get('session-detail').children.some(item => item.tag === 'input'), false);
    assert.equal(get('session-detail').children[0].children[0].textContent, 'Fixture');
    const actions = get('session-detail').children[0].children[3].children[1];
    const resume = actions.children.find(item => item.textContent === '在桌面恢复');
    assert.equal(Boolean(resume), available);
    if (resume) {
      await resume.onclick();
      assert.equal(calls.at(-1).path,'sessions/fixture/resume');
      assert.equal(calls.at(-1).method,'POST');
      assert.equal(resume.disabled,false);
    }
  }
});

test("归档筛选变化即时重载并重置分页，保留搜索条件", async () => {
  const elements = new Map(), calls = [];
  const node = () => ({value:'',checked:false,append(){},replaceChildren(){},setAttribute(){}});
  const get = id => {if (!elements.has(id)) elements.set(id,node()); return elements.get(id);};
  const context = vm.createContext({$:get,node,URLSearchParams,button:node,
    api:async path => {calls.push(path);return {sessions:[],hasMore:false};},
  });
  new vm.Script(ADMIN_SESSIONS_SCRIPT).runInContext(context);
  for (const filter of ['archived', 'project', 'all']) {
    new vm.Script('sessionOffset = 50').runInContext(context);
    get('session-search').value = 'fixture'; get('session-filter').value = filter;
    await get('session-filter').onchange();
    const query = new URLSearchParams(calls.at(-1).split('?')[1]);
    assert.equal(query.get('offset'),'0');
    assert.equal(query.get('search'),'fixture');
    assert.equal(query.get('archived'), String(filter === 'archived'));
    assert.equal(new vm.Script('sessionView').runInContext(context), filter === 'project' ? 'project' : 'all');
  }
});

test("共享管理会话分页、搜索、归档、过期写入及 writer 仲裁", async t => {
  const root = await mkdtemp(join(tmpdir(), "comecode-admin-sessions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "sessions.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  for (let index = 0; index < 4; index++) await store.createSession({
    id: `test-${index}`, projectID: "project-test", slug: `test-${index}`,
    directory: index === 3 ? "/sample/other" : "/sample/workspace",
    title: `标题 ${index}`, version: "test", time: { created: index + 1, updated: index + 1 },
  });
  store.close();
  const server = await startAdminServer({ sessionDbPath: dbPath, dataRoot: root, cwd: root, env: {} });
  try {
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token");
  const request = async (path, method = "GET", body) => {
    const response = await fetch(server.origin + "/api/" + path, { method, headers: {
      Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const first = await request("sessions?limit=2");
  assert.equal(first.status, 200); assert.equal(first.body.sessions.length, 2); assert.equal(first.body.hasMore, true);
  assert.equal(first.body.sessions[0].id, "test-3");
  assert.equal((await request("sessions?limit=2&offset=2")).body.sessions[0].id, "test-1");
  assert.equal((await request("sessions?search=other")).body.sessions.length, 1);
  assert.equal((await request("sessions?limit=0")).status, 400);
  const detail = await request("sessions/test-0");
  assert.deepEqual(detail.body.messages, []); assert.match(detail.body.resumeCommand, /comecode --resume/);
  const patch = { expectedUpdated: detail.body.session.time.updated, title: "新标题", archived: true };
  assert.equal((await request("sessions/test-0", "PATCH", patch)).status, 200);
  assert.equal((await request("sessions/test-0", "PATCH", patch)).status, 409);
  assert.equal((await request("sessions?search=新标题")).body.sessions.length, 0);
  assert.equal((await request("sessions?search=新标题&archived=true")).body.sessions.length, 1);
  const archived = (await request("sessions/test-0")).body.session;
  const release = await acquireSessionWriterLease({ dbPath, sessionId: "test-0" });
  try {
    assert.equal((await request("sessions/test-0", "PATCH", { expectedUpdated: archived.time.updated, archived: false })).status, 200);
    assert.equal((await request("sessions/test-0")).status, 200);
  } finally { await release(); }
  const updated = (await request("sessions/test-0")).body.session;
  assert.equal((await request("sessions/test-0", "PATCH", { expectedUpdated: updated.time.updated, archived: false })).status, 200);
  assert.equal((await request("sessions/missing")).status, 404);
  assert.equal((await request("sessions/test-0", "DELETE")).status, 404);
  assert.equal((await fetch(server.origin + "/api/sessions")).status, 401);
  assert.equal((await fetch(server.origin + "/api/sessions", { headers: { Authorization: `Bearer ${token}`, Origin: "http://evil.test" } })).status, 403);
  } finally { await server.close(); }
});
