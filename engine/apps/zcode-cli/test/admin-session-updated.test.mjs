import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { ADMIN_SESSIONS_SCRIPT } from "../packages/cli/src/admin/session-assets.ts";
import { ADMIN_CONSOLE_STYLE } from "../packages/cli/src/admin/assets.ts";

function fixture() {
  const elements = new Map();
  const node = (tag, text, className) => ({
    tag, textContent: text, className, children: [], attributes: {},
    append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, node("div"));
    return elements.get(id);
  };
  const context = vm.createContext({
    $: get, node, URLSearchParams,
    button: (text, onclick, className) => Object.assign(node("button", text, className), { onclick }),
  });
  new vm.Script(ADMIN_SESSIONS_SCRIPT).runInContext(context);
  return { get, run: (code) => new vm.Script(code).runInContext(context) };
}

test("相对更新时间覆盖分钟、小时、天边界及旧数据降级", () => {
  const { run } = fixture();
  const now = Date.UTC(2026, 9, 7, 12);
  for (const [elapsed, expected] of [
    [-1000, "刚刚"], [0, "刚刚"], [59999, "刚刚"],
    [60000, "1分钟前"], [3599999, "59分钟前"],
    [3600000, "1小时前"], [18000000, "5小时前"],
    [86400000, "1天前"], [172800000, "2天前"],
  ]) assert.equal(run(`formatSessionUpdated(${now - elapsed}, ${now})`), expected);
  for (const value of ["undefined", "null", "NaN", "Infinity", "0", "-1", '"invalid"', "1e20"])
    assert.equal(run(`formatSessionUpdated(${value}, ${now})`), "更新时间未知");
});

test("列表路径与时间同行，归档仍保留，悬停显示完整时间", () => {
  const { get, run } = fixture();
  run('currentSessions = [{id:"fixture",title:"Fixture",directory:"/fixture/project",time:{updated:Date.now()-5*60*60*1000,archived:1}}]; renderSessionList()');
  const row = get("session-list").children[0];
  const metadata = row.children[0].children[1];
  assert.equal(metadata.className, "session-item-meta");
  assert.equal(metadata.children[0].textContent, "/fixture/project · 已归档");
  assert.equal(metadata.children[1].textContent, "5小时前");
  assert.match(metadata.children[1].title, /^更新时间：/u);
  assert.equal(metadata.children[1].attributes["aria-label"], "更新时间：5小时前");
  run('sessionView = "project"; renderSessionList()');
  assert.equal(get("session-list").children[0].children[1].children[0].children[1].children[1].textContent, "5小时前");
  assert.match(ADMIN_CONSOLE_STYLE, /\.session-item-meta\{display:flex/u);
  assert.match(ADMIN_CONSOLE_STYLE, /\.session-item-updated\{flex-shrink:0/u);
});
