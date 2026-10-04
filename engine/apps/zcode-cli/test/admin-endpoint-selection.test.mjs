import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderConfigEditor } from "../packages/adapters/dist/config/provider-config-editor.js";
import { testProviderConnection } from "../packages/cli/src/admin/test-connection.ts";
import { ADMIN_SCRIPT } from "../packages/cli/src/admin/client.ts";
import { ADMIN_HTML, ADMIN_STYLE } from "../packages/cli/src/admin/assets.ts";

// 最小 DOM 覆盖表单事件与草稿，不向模型服务发起请求。
function form(config, renderPage = false, fetchImpl) {
  const elements = new Map(), windowHandlers = new Map();
  const element = tag => ({ tag, attributes: {}, value: "", hidden: false, checked: false, options: [],
    disabled: false,
    append(...items) { this.options.push(...items); }, replaceChildren() { this.options = []; },
    setAttribute(name, value) { this.attributes[name] = value; }, addEventListener() {}, showModal() { this.open = true; }, close() {}, focus() {},
  });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = vm.createContext({ URL, URLSearchParams, structuredClone,
    location: { hash: "", pathname: "/" }, sessionStorage: { getItem: () => null },
    document: { getElementById: get, createElement: element, createElementNS: (_namespace, tag) => element(tag), querySelectorAll: () => [] }, window: { addEventListener(type, handler) { windowHandlers.set(type, handler); } }, fetch: fetchImpl || (async (url, options) => { const body = JSON.parse(options.body); return { ok: true, async json() { return url.endsWith('/api/test-draft') ? { ok: true, message: '连接成功' } : { revision: "saved", source: "fixture", target: "fixture", requiresMigration: false, config: body.config, effective: { paths: {} }, errors: [] }; } }; }),
  });
  new vm.Script(ADMIN_SCRIPT).runInContext(context);
  const run = code => new vm.Script(code).runInContext(context);
  run('draft = ' + JSON.stringify(config) + ';');
  run('snapshot = { source: "fixture", target: "fixture", revision: "fixture", requiresMigration: false, effective: { paths: {} }, errors: [] };');
  if (renderPage) run('render();');
  else run('render = () => {}; openModelDialog(null);');
  return { get, run, dispatch(type, event) { windowHandlers.get(type)?.(event); }, draft: () => JSON.parse(run('JSON.stringify(draft)')) };
}
const providers = () => ({ providers: [
  { id: "first", name: "接口 A", type: "anthropic", baseUrl: "https://a.example/v1", hasApiKey: true, models: [{ id: "old-a" }] },
  { id: "second", name: "接口 B", type: "openai-responses", baseUrl: "https://b.example/v1", apiKeyEnv: "FIXTURE_API_KEY", models: [{ id: "old-b" }] },
] });
function select(f, id) { f.get("model-endpoint").value = id; f.get("model-endpoint").onchange(); }
async function add(f, id) { f.get("model-id").value = id; await f.run("saveModelDialog({ preventDefault() {} });"); }

test("连接测试失败不落草稿且仍可保存模型", async () => {
  const calls = [];
  const f = form(providers(), false, async (url, options) => {
    calls.push(url);
    return { ok: true, async json() {
      if (url.endsWith("test-draft")) return { ok: false, message: "连接失败（HTTP 401）" };
      return { revision: "saved", config: JSON.parse(options.body).config };
    } };
  });
  assert.equal(f.get("model-submit").disabled, false);
  f.get("model-id").value = "failed-model";
  f.get("model-url").value = "https://failed.example/v1";
  await f.run("testModelDialog();");
  assert.equal(f.get("model-submit").disabled, false);
  assert.equal(f.draft().providers.length, 2);
  assert.match(f.get("model-dialog-help").textContent, /测试失败.*HTTP 401.*仍可保存/u);
  await f.run("saveModelDialog({ preventDefault() {} });");
  assert.equal(f.draft().providers.at(-1).models[0].id, "failed-model");
  assert.deepEqual(calls, ["/api/test-draft", "/api/config"]);
});

test("测试成功后编辑表单仍可保存最新值，不复用测试草稿", async () => {
  const f = form(providers());
  f.get("model-id").value = "tested-model";
  f.get("model-url").value = "https://tested.example/v1";
  await f.run("testModelDialog();");
  assert.equal(f.get("model-submit").disabled, false);
  f.get("model-id").value = "changed-model";
  f.get("model-name").value = "编辑后的模型";
  assert.equal(f.get("model-submit").disabled, false);
  await f.run("saveModelDialog({ preventDefault() {} });");
  assert.equal(f.draft().providers.at(-1).models[0].id, "changed-model");
  assert.equal(f.draft().providers.at(-1).models[0].name, "编辑后的模型");
});

test("未测试可直接保存，缺少必填结构仍拒绝且不发请求", async () => {
  const calls = [];
  const f = form(providers(), false, async (url, options) => {
    calls.push(url);
    return { ok: true, async json() { return { revision: "saved", config: JSON.parse(options.body).config }; } };
  });
  assert.match(ADMIN_HTML, /测试连接（可选）/u);
  assert.doesNotMatch(ADMIN_HTML, /id="model-submit"[^>]*disabled/u);
  await f.run("saveModelDialog({ preventDefault() {} });");
  assert.deepEqual(calls, []);
  assert.equal(f.draft().providers.length, 2);
  select(f, "first");
  await add(f, "untested-model");
  assert.deepEqual(calls, ["/api/config"]);
  assert.equal(f.draft().providers[0].models.at(-1).id, "untested-model");
});

test("已有地址下拉选择带入地址/协议与 Key 复用提示，模型追加到所选供应商", async () => {
  const f = form(providers());
  assert.equal(f.get("model-endpoint").hidden, true);
  assert.equal(f.get("model-endpoint-toggle").hidden, false);
  assert.equal(f.get("model-endpoint-toggle").textContent, undefined);
  assert.deepEqual(f.get("model-endpoint").options.map(option => option.value), ["", "first", "second"]);
  assert.deepEqual(f.get("model-endpoint-menu").options.map(option => option.textContent), ["手动填写", "接口 A · https://a.example/v1", "接口 B · https://b.example/v1"]);
  assert.equal(f.get("model-type-display").value, "Chat Completions（兼容）");
  assert.deepEqual(f.get("model-type-menu").options.map(option => option.textContent), ["Chat Completions（兼容）", "Responses", "Anthropic Messages"]);
  select(f, "first");
  assert.equal(f.get("model-url").value, "https://a.example/v1");
  assert.equal(f.get("model-url").hidden, false);
  assert.equal(f.get("model-type").value, "anthropic");
  assert.equal(f.get("model-key").value, "");
  assert.match(f.get("model-key-hint").textContent, /复用.*接口 A/);
  await add(f, "new-model");
  assert.equal(f.draft().providers.length, 2);
  assert.equal(f.draft().providers[0].models[1].id, "new-model");
  assert.equal(f.draft().providers[0].models[1].apiKey, undefined);
});

test("默认思考强度默认 high，使用默认值删除字段，可选 low/max 写入", async () => {
  const f = form(providers());
  select(f, "first");
  assert.equal(f.get("model-reasoning").value, "high");
  await add(f, "high-model");
  assert.equal(f.draft().providers[0].models.at(-1).reasoningLevel, "high");

  f.run("closeModelDialog(); openModelDialog(null);");
  select(f, "first");
  f.get("model-reasoning").value = "";
  await add(f, "default-model");
  assert.equal(f.draft().providers[0].models.at(-1).reasoningLevel, undefined);

  f.run("closeModelDialog(); openModelDialog(null);");
  select(f, "first");
  f.get("model-reasoning").value = "max";
  await add(f, "max-model");
  assert.equal(f.draft().providers[0].models.at(-1).reasoningLevel, "max");
});

test("默认思考强度提供五个英文档位，编辑与保存保留 medium/xhigh", async () => {
  const selectHtml = ADMIN_HTML.match(/<select id="model-reasoning">(.*?)<\/select>/su)[1];
  const options = [...selectHtml.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/gu)];
  assert.deepEqual(options.map(option => option[1]), ["", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(options.slice(1).map(option => option[2]), ["low", "medium", "high", "xhigh", "max"]);
  for (const level of ["medium", "xhigh"]) {
    const config = providers();
    config.providers[1].models[0].reasoningLevel = level;
    const f = form(config);
    f.run('openModelDialog({ provider: draft.providers[1], model: draft.providers[1].models[0] });');
    assert.equal(f.get("model-reasoning").value, level);
    f.get("model-output").value = "64000";
    await f.run("testModelDialog();");
    await f.run("saveModelDialog({ preventDefault() {} });");
    assert.equal(f.draft().providers[1].models[0].reasoningLevel, level);
    assert.equal(f.draft().providers[1].models[0].maxOutputTokens, 64000);
    f.run('openModelDialog({ provider: draft.providers[1], model: draft.providers[1].models[0] });');
    assert.equal(f.get("model-reasoning").value, level);
  }
});

test("切换供应商与手填新地址不串 Key，协议可以单独覆盖", async () => {
  const f = form(providers());
  select(f, "first"); f.get("model-key").value = "unsaved-key";
  select(f, "second");
  assert.equal(f.get("model-key").value, "");
  assert.equal(f.get("model-type").value, "openai-responses");
  f.get("model-type").value = "openai-chat"; f.get("model-type").onchange();
  assert.equal(f.get("model-type-display").value, "Chat Completions（兼容）");
  await add(f, "compatible-model");
  assert.equal(f.draft().providers[1].models[1].type, "openai-chat");
  f.run("openModelDialog(null)"); select(f, "second"); f.get("model-key").value = "other-unsaved-key";
  select(f, "");
  assert.equal(f.get("model-url").hidden, false);
  assert.equal(f.get("model-url").value, "");
  assert.equal(f.get("model-key").value, "");
  assert.equal(f.get("model-key-hint").hidden, true);
  f.get("model-url").value = "https://new.example/v1"; f.get("model-url").oninput();
  assert.equal(f.get("model-endpoint").value, "");
  f.get("model-key").value = "new-service-key";
  await add(f, "manual-model");
  assert.equal(f.draft().providers[2].baseUrl, "https://new.example/v1");
  assert.equal(f.draft().providers[2].apiKey, "new-service-key");
});

test("没有地址时保持手填；仅有模型专用 Key 时不误报可复用，手填已有 URL 仍能复用", async () => {
  const empty = form({ providers: [] });
  assert.equal(empty.get("model-endpoint").hidden, true);
  assert.equal(empty.get("model-endpoint-toggle").hidden, true);
  assert.equal(empty.get("model-url").hidden, false);
  const config = providers(); delete config.providers[0].hasApiKey;
  config.providers[0].models[0].hasApiKey = true;
  const f = form(config); select(f, "first");
  assert.match(f.get("model-key-hint").textContent, /没有配置共享 API Key/);
  f.get("model-url").value = "https://b.example/v1/"; f.get("model-url").oninput();
  assert.match(f.get("model-key-hint").textContent, /复用.*接口 B/);
});

test("复用已有地址时新 Key 仅覆盖新增模型，不修改供应商共享 Key", async () => {
  const config = providers(); config.providers[0].apiKey = "shared-key";
  const f = form(config); select(f, "first"); f.get("model-key").value = "new-model-key";
  await add(f, "own-key-model");
  assert.equal(f.draft().providers[0].apiKey, "shared-key");
  assert.equal(f.draft().providers[0].models[1].apiKey, "new-model-key");
});

test("同地址不同供应商按下拉 ID 选择，取消/重开不保留上次选择", async () => {
  const config = providers(); config.providers[1].baseUrl = config.providers[0].baseUrl;
  const f = form(config); select(f, "second"); await add(f, "from-second");
  assert.equal(f.draft().providers[0].models.length, 1);
  assert.equal(f.draft().providers[1].models[1].id, "from-second");
  select(f, "first"); f.run("closeModelDialog(); openModelDialog(null);");
  assert.equal(f.get("model-endpoint").value, "");
  assert.equal(f.get("model-url").value, "");
  assert.equal(f.get("model-key").value, "");
});

test("点击外部空白会收起地址和协议菜单", () => {
  const f = form(providers());
  f.run("toggleModelEndpointMenu(); toggleModelTypeMenu();");
  assert.equal(f.get("model-endpoint-menu").hidden, false);
  assert.equal(f.get("model-type-menu").hidden, false);
  f.dispatch("click", { target: { closest: () => null } });
  assert.equal(f.get("model-endpoint-menu").hidden, true);
  assert.equal(f.get("model-type-menu").hidden, true);
});

test("地址与协议下拉使用相同的整宽菜单样式", () => {
  assert.match(ADMIN_STYLE, /\.endpoint-picker,\.protocol-picker\{position:relative\}/);
  assert.match(ADMIN_STYLE, /\.endpoint-picker-menu,\.protocol-picker-menu\{[^}]*left:0[^}]*right:0/);
  assert.match(ADMIN_STYLE, /\.endpoint-picker-toggle,\.protocol-picker-toggle\{[^}]*width:38px/);
});

test("供应商名称框与齿轮保持同高并垂直居中", () => {
  assert.match(ADMIN_STYLE, /\.provider-name strong\{[^}]*display:inline-flex/);
  assert.match(ADMIN_STYLE, /\.provider-name strong\{[^}]*align-items:center/);
  assert.match(ADMIN_STYLE, /\.provider-name strong\{[^}]*height:28px/);
  assert.match(ADMIN_STYLE, /\.provider-edit\{[^}]*height:28px/);
  assert.match(ADMIN_STYLE, /\.endpoint-picker-toggle:hover,\.protocol-picker-toggle:hover\{background:transparent/);
});

test("供应商名称同行紧随可访问齿轮图标，点击沿用编辑弹框", () => {
  const f = form(providers(), true);
  const heading = f.get("providers").options[0].options[0];
  assert.equal(heading.className, "provider-heading");
  assert.equal(heading.options.length, 1);
  const info = heading.options[0], name = info.options[0];
  assert.equal(name.className, "provider-name");
  assert.equal(name.options[0].textContent, "接口 A");
  const edit = name.options[1];
  assert.equal(edit.tag, "button");
  assert.equal(edit.type, "button");
  assert.equal(edit.className, "provider-edit");
  assert.equal(edit.textContent, undefined);
  assert.equal(edit.title, "编辑供应商");
  assert.equal(edit.attributes["aria-label"], "编辑供应商");
  assert.equal(edit.options[0].tag, "svg");
  assert.equal(edit.options[0].attributes["aria-hidden"], "true");
  assert.match(edit.options[0].options[0].attributes.d, /^M12\.22/);
  edit.onclick();
  assert.equal(f.get("provider-dialog").open, true);
  assert.equal(f.get("provider-edit-id").value, "first");
  assert.equal(f.get("provider-edit-name").value, "接口 A");
});


test("编辑同地址协议不新建供应商，独立修改 Key 不覆盖其他模型", async () => {
  const f = form(providers());
  f.run('openModelDialog({ provider: draft.providers[0], model: draft.providers[0].models[0] });');
  f.get("model-type").value = "openai-chat";
  f.get("model-key").value = "replacement-model-key";
  await f.run("testModelDialog();");
  await f.run("saveModelDialog({ preventDefault() {} });");
  const config = f.draft();
  assert.equal(config.providers.length, 2);
  assert.equal(config.providers[0].type, "anthropic");
  assert.equal(config.providers[0].apiKey, undefined);
  assert.equal(config.providers[0].models[0].type, "openai-chat");
  assert.equal(config.providers[0].models[0].apiKey, "replacement-model-key");
});

test("真实前端修改 Grok 地址/协议且 Key 留空，预览测试保存均保留原模型凭据", async t => {
  for (const source of ["shared", "model", "environment"]) {
    const root = await mkdtemp(join(tmpdir(), "comecode-edit-model-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dataRoot = join(root, "user");
    await mkdir(dataRoot); await mkdir(join(root, ".comecode"));
    await writeFile(join(root, ".comecode", "config.json"), "{}");
    const secret = "private-" + source + "-key";
    const provider = { id: "my-api", type: "anthropic", baseUrl: "https://example.test", apiKey: "private-shared-key", models: [{ id: "deepseek-flash" }, { id: "grok-4.7" }] };
    const env = {};
    if (source === "model") provider.models[1].apiKey = secret;
    if (source === "environment") { delete provider.apiKey; provider.apiKeyEnv = "EDIT_MODEL_KEY"; env.EDIT_MODEL_KEY = secret; }
    await writeFile(join(dataRoot, "config.json"), JSON.stringify({ provider: "my-api", model: "grok-4.7", providers: [provider] }));
    const editor = createProviderConfigEditor({ cwd: root, dataRoot, env });
    const before = await editor.read();
    let calls = 0, testedProvider;
    const f = form(before.config, false, async (url, options) => {
      const input = JSON.parse(options.body);
      if (url.endsWith("/api/test-draft")) {
        const { test, ...saveInput } = input;
        const preview = await editor.preview(saveInput);
        testedProvider = test.provider;
        const result = await testProviderConnection(test, preview.resolved, async (requestUrl, request) => {
          calls += 1;
          assert.equal(requestUrl, "https://example.test/v1/chat/completions");
          assert.equal(request.headers.Authorization, "Bearer " + secret);
          assert.equal(JSON.parse(request.body).model, "grok-4.7");
          return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
        });
        return { ok: true, json: async () => result };
      }
      const after = await editor.save(input);
      return { ok: true, json: async () => after };
    });
    f.run('snapshot.revision = ' + JSON.stringify(before.revision) + '; openModelDialog({ provider: draft.providers[0], model: draft.providers[0].models[1] });');
    f.get("model-url").value = "https://example.test/v1";
    f.get("model-type").value = "openai-chat";
    assert.equal(f.get("model-key").value, "");
    await f.run("testModelDialog();");
    assert.equal(calls, 1, f.get("model-dialog-help").textContent);
    assert.equal(f.get("model-submit").disabled, false);
    assert.equal(await readFile(join(dataRoot, "config.json"), "utf8"), JSON.stringify({ provider: "my-api", model: "grok-4.7", providers: [provider] }));
    await f.run("saveModelDialog({ preventDefault() {} });");
    const saved = JSON.parse(await readFile(join(dataRoot, "config.json"), "utf8"));
    assert.equal(saved.provider, testedProvider);
    assert.equal(saved.model, "grok-4.7");
    const original = saved.providers.find(item => item.id === "my-api");
    assert.equal(original.type, "anthropic");
    assert.equal(original.models.length, 1);
    const moved = saved.providers.find(item => item.id === testedProvider);
    assert.equal(moved.type, "openai-chat");
    assert.equal(moved.baseUrl, "https://example.test/v1");
    if (source === "environment") { assert.equal(moved.apiKeyEnv, "EDIT_MODEL_KEY"); assert.equal(moved.apiKey, undefined); }
    else assert.equal(moved.apiKey, secret);
    assert.doesNotMatch(JSON.stringify(saved), /apiKeyFrom|hasApiKey/);
  }
});


test("列表测试按钮直接发起请求、不弹确认且防重复点击，成功失败均恢复按钮", async () => {
  for (const outcome of ["success", "protocol-failure", "network-failure"]) {
    let calls = 0, finish;
    const f = form(providers(), true, async (url, options) => {
      calls += 1;
      assert.equal(url, "/api/test");
      assert.deepEqual(JSON.parse(options.body), { provider: "first", model: "old-a", confirm: true });
      await new Promise(resolve => { finish = resolve; });
      if (outcome === "network-failure") throw new Error("网络连接失败");
      return { ok: true, json: async () => ({ ok: outcome === "success", message: outcome === "success" ? "连接成功" : "响应协议不匹配" }) };
    });
    const buttons = [];
    const visit = element => { if (element.tag === "button" && element.textContent === "测试连接") buttons.push(element); (element.options || []).forEach(visit); };
    visit(f.get("providers"));
    const control = buttons[0];
    const operation = control.onclick();
    assert.equal(calls, 1);
    assert.equal(f.get("confirm").open, undefined);
    assert.equal(control.disabled, true);
    assert.equal(control.textContent, "测试中…");
    await control.onclick();
    await buttons[1].onclick();
    assert.equal(calls, 1);
    finish(); await operation;
    assert.equal(control.disabled, false);
    assert.equal(control.textContent, "测试连接");
    assert.equal(f.get("status").className, outcome === "success" ? "" : "error");
    assert.equal(f.get("status").textContent, outcome === "success" ? "连接成功" : outcome === "network-failure" ? "网络连接失败" : "响应协议不匹配");
  }
});
