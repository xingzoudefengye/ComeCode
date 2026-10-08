import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  coalesceThoughtOnlyMessages,
  ContentPane,
} from "../packages/tui/src/app-transcript-components.tsx";
import { ThoughtRunView } from "../packages/tui/src/app-thought-components.tsx";
import { setActiveTuiThemeMode } from "../packages/tui/src/theme/index.ts";
const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(
  pathToFileURL(require.resolve("@mbears/opentui-react/test-utils"))
);

async function settle(view) {
  async function ready(node) {
    if (node.highlightingDone) await node.highlightingDone;
    for (const child of node.getChildren?.() ?? []) await ready(child);
  }
  await React.act(async () => {
    await ready(view.renderer.root);
    await view.flush();
  });
}

async function render(t, element, width = 90) {
  let view;
  let update;
  function Harness() {
    const [node, setNode] = React.useState(element);
    update = setNode;
    return node;
  }
  await React.act(async () => {
    view = await testRender(React.createElement(Harness), { width, height: 36 });
    await view.flush();
  });
  view.update = async (node) => {
    await React.act(async () => {
      update(node);
    });
    await React.act(async () => {
      await view.flush();
    });
    await settle(view);
  };
  await settle(view);
  view.close = async () => {
    await React.act(async () => view.renderer.destroy());
  };
  t.after(view.close);
  return view;
}

const thought = (text, status = "thought") => ({
  contentCharCount: text.length,
  status,
  text,
  type: "thought",
});

const completedTool = (id) => ({
  detailLines: ["command: hidden-detail"],
  output: "hidden-output",
  status: "completed",
  toolCallId: id,
  toolName: "Bash",
  title: "Bash",
  type: "tool",
});

const row = (lines, text) => lines.findIndex((line) => line.includes(text));
const countThoughtRows = (lines) => lines.filter((line) => line.includes("+ Thought")).length;

test("一回合多个 step 的思考只占一行，工具行仍然隐藏", async (t) => {
  setActiveTuiThemeMode("dark");
  const messages = [
    { role: "user", content: "用户提问" },
    { role: "agent", content: "先做两处修复" },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "agent",
      content: "",
      parts: [thought(`第 ${index} 段思考`), completedTool(`tool-${index}`)],
    })),
    { role: "agent", content: "现在做决定性检查" },
  ];
  const before = JSON.stringify(messages);
  const view = await render(t, React.createElement(ContentPane, { focused: false, messages }));
  const lines = view.captureCharFrame().split("\n");
  assert.equal(countThoughtRows(lines), 1, lines.join("\n"));
  assert.equal(row(lines, "+ Thought") - row(lines, "先做两处修复"), 2);
  assert.equal(row(lines, "现在做决定性检查") - row(lines, "+ Thought"), 1);
  // 折叠时不展开任何一段思考正文，也不泄漏被隐藏的工具细节。
  assert.doesNotMatch(lines.join("\n"), /第 0 段思考|hidden-detail|hidden-output/u);
  assert.equal(JSON.stringify(messages), before);
  await view.close();
});

test("可见工具打断思考分组，正文分隔的两组思考各自成行", async (t) => {
  setActiveTuiThemeMode("dark");
  const messages = [
    { role: "agent", content: "", parts: [thought("前一组思考")] },
    { role: "agent", content: "", parts: [thought("中间正文前的思考")] },
    { role: "agent", content: "中间正文" },
    { role: "agent", content: "", parts: [thought("后一组思考")] },
    {
      role: "agent",
      content: "",
      parts: [
        thought("运行中工具前的思考"),
        {
          detailLines: ["file: active.ts"],
          status: "running",
          toolCallId: "running-tool",
          toolName: "Edit",
          type: "tool",
        },
      ],
    },
    { role: "agent", content: "", parts: [thought("运行中工具后的思考")] },
  ];
  const view = await render(t, React.createElement(ContentPane, { focused: false, messages }));
  const lines = view.captureCharFrame().split("\n");
  assert.equal(countThoughtRows(lines), 4, lines.join("\n"));
  assert.ok(row(lines, "active.ts") > row(lines, "+ Thought"));
  await view.close();
});

test("展开合并后的思考行显示该组全部思考正文", async (t) => {
  setActiveTuiThemeMode("dark");
  const view = await render(
    t,
    React.createElement(ThoughtRunView, {
      parts: [thought("思考片段一"), thought("思考片段二"), thought("思考片段三")],
    }),
  );
  const collapsed = view.captureCharFrame().split("\n");
  assert.equal(row(collapsed, "+ Thought"), 0);
  assert.doesNotMatch(collapsed.join("\n"), /思考片段/u);

  await React.act(async () => {
    await view.mockMouse.click(2, 0);
    await view.flush();
  });
  await settle(view);
  const expanded = view.captureCharFrame().split("\n");
  assert.ok(row(expanded, "- Thought") === 0, expanded.join("\n"));
  assert.equal(row(expanded, "思考片段二") - row(expanded, "思考片段一"), 2);
  assert.equal(row(expanded, "思考片段三") - row(expanded, "思考片段二"), 2);
  await view.close();
});

test("流式思考沿用思考中标签，组内任一段仍在流式即不显示完成态", async (t) => {
  setActiveTuiThemeMode("dark");
  const view = await render(
    t,
    React.createElement(ThoughtRunView, {
      parts: [thought("已完成片段"), thought("流式片段", "thinking")],
    }),
  );
  const lines = view.captureCharFrame().split("\n");
  assert.equal(row(lines, "+ Thinking..."), 0);
  await view.close();
});

test("相邻纯思考消息合并为一条消息，含正文或可见工具时保持断开", () => {
  const messages = [
    { id: "a", role: "agent", content: "", parts: [thought("一"), completedTool("t1")] },
    { id: "b", role: "agent", content: "", parts: [thought("二"), completedTool("t2")] },
    { id: "c", role: "agent", content: "正文" },
    { id: "d", role: "agent", content: "", parts: [thought("三")] },
  ];
  const before = JSON.stringify(messages);
  const coalesced = coalesceThoughtOnlyMessages(messages);
  assert.equal(coalesced.length, 3);
  assert.equal(coalesced[0].id, "a");
  assert.equal(coalesced[0].parts.length, 4);
  assert.deepEqual(
    coalesced[0].parts.map((part) => part.text ?? part.toolCallId),
    ["一", "t1", "二", "t2"],
  );
  assert.equal(coalesced[1], messages[2]);
  assert.equal(coalesced[2], messages[3]);
  assert.equal(JSON.stringify(messages), before);
});
