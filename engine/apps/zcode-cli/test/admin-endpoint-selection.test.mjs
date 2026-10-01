import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { ADMIN_SCRIPT } from "../packages/cli/src/admin/client.ts";
import { ADMIN_STYLE } from "../packages/cli/src/admin/assets.ts";

// 最小 DOM 覆盖表单事件与草稿，不向模型服务发起请求。
function form(config, renderPage = false) {
  const elements = new Map();
  const element = tag => ({ tag, attributes: {}, value: "", hidden: false, checked: false, options: [],
    append(...items) { this.options.push(...items); }, replaceChildren() { this.options = []; },
    setAttribute(name, value) { this.attributes[name] = value; }, showModal() { this.open = true; }, close() {}, focus() {},
  });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const context = vm.createContext({ URL, URLSearchParams, structuredClone,
    location: { hash: "", pathname: "/" }, sessionStorage: { getItem: () => null },
    document: { getElementById: get, createElement: element, createElementNS: (_namespace, tag) => element(tag) }, window: { addEventListener() {} },
  });
  new vm.Script(ADMIN_SCRIPT).runInContext(context);
  const run = code => new vm.Script(code).runInContext(context);
  run('draft = ' + JSON.stringify(config) + ';');
  if (renderPage) run('snapshot = { source: "fixture", target: "fixture", effective: { paths: {} }, errors: [] }; render();');
  else run('render = () => {}; openModelDialog(null);');
  return { get, run, draft: () => JSON.parse(run('JSON.stringify(draft)')) };
}
const providers = () => ({ providers: [
  { id: "first", name: "接口 A", type: "anthropic", baseUrl: "https://a.example/v1", hasApiKey: true, models: [{ id: "old-a" }] },
  { id: "second", name: "接口 B", type: "openai-responses", baseUrl: "https://b.example/v1", apiKeyEnv: "FIXTURE_API_KEY", models: [{ id: "old-b" }] },
] });
function select(f, id) { f.get("model-endpoint").value = id; f.get("model-endpoint").onchange(); }
function add(f, id) { f.get("model-id").value = id; f.run("saveModelDialog({ preventDefault() {} });"); }

test("已有地址下拉选择带入地址/协议与 Key 复用提示，模型追加到所选供应商", () => {
  const f = form(providers());
  assert.equal(f.get("model-endpoint").hidden, true);
  assert.equal(f.get("model-endpoint-toggle").hidden, false);
  assert.equal(f.get("model-endpoint-toggle").textContent, undefined);
  assert.deepEqual(f.get("model-endpoint").options.map(option => option.value), ["", "first", "second"]);
  assert.deepEqual(f.get("model-endpoint-menu").options.map(option => option.textContent), ["手动填写", "接口 A · https://a.example/v1", "接口 B · https://b.example/v1"]);
  select(f, "first");
  assert.equal(f.get("model-url").value, "https://a.example/v1");
  assert.equal(f.get("model-url").hidden, false);
  assert.equal(f.get("model-type").value, "anthropic");
  assert.equal(f.get("model-key").value, "");
  assert.match(f.get("model-key-hint").textContent, /复用.*接口 A/);
  add(f, "new-model");
  assert.equal(f.draft().providers.length, 2);
  assert.equal(f.draft().providers[0].models[1].id, "new-model");
  assert.equal(f.draft().providers[0].models[1].apiKey, undefined);
});

test("切换供应商与手填新地址不串 Key，协议可以单独覆盖", () => {
  const f = form(providers());
  select(f, "first"); f.get("model-key").value = "unsaved-key";
  select(f, "second");
  assert.equal(f.get("model-key").value, "");
  assert.equal(f.get("model-type").value, "openai-responses");
  f.get("model-type").value = "openai-chat"; add(f, "compatible-model");
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
  add(f, "manual-model");
  assert.equal(f.draft().providers[2].baseUrl, "https://new.example/v1");
  assert.equal(f.draft().providers[2].apiKey, "new-service-key");
});

test("没有地址时保持手填；仅有模型专用 Key 时不误报可复用，手填已有 URL 仍能复用", () => {
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

test("复用已有地址时新 Key 仅覆盖新增模型，不修改供应商共享 Key", () => {
  const config = providers(); config.providers[0].apiKey = "shared-key";
  const f = form(config); select(f, "first"); f.get("model-key").value = "new-model-key";
  add(f, "own-key-model");
  assert.equal(f.draft().providers[0].apiKey, "shared-key");
  assert.equal(f.draft().providers[0].models[1].apiKey, "new-model-key");
});

test("同地址不同供应商按下拉 ID 选择，取消/重开不保留上次选择", () => {
  const config = providers(); config.providers[1].baseUrl = config.providers[0].baseUrl;
  const f = form(config); select(f, "second"); add(f, "from-second");
  assert.equal(f.draft().providers[0].models.length, 1);
  assert.equal(f.draft().providers[1].models[1].id, "from-second");
  select(f, "first"); f.run("closeModelDialog(); openModelDialog(null);");
  assert.equal(f.get("model-endpoint").value, "");
  assert.equal(f.get("model-url").value, "");
  assert.equal(f.get("model-key").value, "");
});

test("供应商名称框与齿轮保持同高并垂直居中", () => {
  assert.match(ADMIN_STYLE, /\.provider-name strong\{[^}]*display:inline-flex/);
  assert.match(ADMIN_STYLE, /\.provider-name strong\{[^}]*align-items:center/);
  assert.match(ADMIN_STYLE, /\.provider-name strong\{[^}]*height:28px/);
  assert.match(ADMIN_STYLE, /\.provider-edit\{[^}]*height:28px/);
  assert.match(ADMIN_STYLE, /\.endpoint-picker\{position:relative\}/);
  assert.match(ADMIN_STYLE, /\.endpoint-picker-toggle\{[^}]*width:38px/);
  assert.match(ADMIN_STYLE, /\.endpoint-picker-toggle:hover\{background:transparent/);
  assert.match(ADMIN_STYLE, /\.endpoint-picker-menu\{[^}]*left:0[^}]*right:0/);
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
