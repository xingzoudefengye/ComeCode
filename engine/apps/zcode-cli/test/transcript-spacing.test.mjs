import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ContentPane } from "../packages/tui/src/app-transcript-components.tsx";
import { MarkdownText } from "../packages/tui/src/app-markdown.tsx";
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
const row = (lines, text) => lines.findIndex((line) => line.includes(text));

test("原生对话渲染：消息之间一行，Thought 后一行，正文段落无额外空行", async (t) => {
  for (const mode of ["dark", "light"]) {
    setActiveTuiThemeMode(mode);
    const view = await render(
      t,
      React.createElement(ContentPane, {
        focused: false,
        messages: [
          { role: "user", content: "你好" },
          {
            role: "agent",
            content: "",
            parts: [
              { type: "thought", status: "thought", text: "思考", contentCharCount: 2 },
              {
                type: "text",
                text: "你好！我是 ComeCode。\n\n目前工作区是干净的。\n\n有什么想让我做的，直接说。",
              },
            ],
          },
          { role: "user", content: "今天是几月几号" },
          { role: "agent", content: "今天是 2026 年 10 月 1 日。\n\n顺便一提，这是国庆节。" },
        ],
      }),
    );
    const lines = view.captureCharFrame().split("\n");
    assert.equal(row(lines, "Thought") - row(lines, "你好"), 2);
    assert.equal(row(lines, "你好！") - row(lines, "Thought"), 2);
    assert.equal(row(lines, "目前工作区") - row(lines, "你好！"), 1);
    assert.equal(row(lines, "有什么想") - row(lines, "目前工作区"), 1);
    assert.equal(row(lines, "今天是几月") - row(lines, "有什么想"), 2);
    assert.equal(row(lines, "今天是 2026") - row(lines, "今天是几月"), 2);
    assert.equal(row(lines, "顺便一提") - row(lines, "今天是 2026"), 1);
    await view.close();
  }
});

test("Markdown 段落紧凑不修改原文，保留代码空行与列表、表格内容", async (t) => {
  const content =
    "正文第一段\n\n正文第二段\n\n```text\ncode-first\n\ncode-last\n```\n\n- item-one\n- item-two\n\n| column | value |\n| --- | --- |\n| table-row | 42 |";
  const view = await render(t, React.createElement(MarkdownText, { content, streaming: false }));
  const lines = view.captureCharFrame().split("\n");
  assert.equal(row(lines, "正文第二段") - row(lines, "正文第一段"), 1);
  assert.equal(row(lines, "code-last") - row(lines, "code-first"), 2);
  assert.equal(row(lines, "item-two") - row(lines, "item-one"), 1);
  assert.ok(row(lines, "table-row") > row(lines, "item-two"));
});

test("流式文本更新不重复增加消息分隔，完成时与流式布局一致", async (t) => {
  const messages = [
    { role: "user", content: "stream-user" },
    { role: "agent", content: "stream-first", streaming: true },
  ];
  const view = await render(t, React.createElement(ContentPane, { focused: false, messages }));
  const first = view.captureCharFrame().split("\n");
  assert.equal(row(first, "stream-first") - row(first, "stream-user"), 2);
  for (const streaming of [true, false]) {
    await view.update(
      React.createElement(ContentPane, {
        focused: false,
        messages: [
          messages[0],
          { ...messages[1], content: "stream-first\n\nstream-second", streaming },
        ],
      }),
    );
    const lines = view.captureCharFrame().split("\n");
    assert.equal(row(lines, "stream-first") - row(lines, "stream-user"), 2);
    assert.equal(
      row(lines, "stream-second") - row(lines, "stream-first"),
      1,
      `streaming=${streaming}\n${lines.slice(0, 12).join("\n")}`,
    );
  }
});

test("同回合工具与回答续段不叠加间隔，换行与 Markdown 硬换行保留", async (t) => {
  const messages = [
    { role: "user", content: "tool-user" },
    { role: "agent", content: "tool-intro" },
    {
      role: "agent",
      content: "",
      parts: [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "WebFetch",
          title: "WebFetch",
          status: "completed",
          detailLines: ["url: https://example.test"],
          output: "tool-output",
        },
        { type: "text", text: "tool-result" },
      ],
    },
    {
      role: "agent",
      content: "continuation-one  \ncontinuation-two\ncontinuation-three\n\nlast-paragraph",
    },
    { role: "user", content: "next-user" },
  ];
  const before = JSON.stringify(messages);
  const view = await render(t, React.createElement(ContentPane, { focused: false, messages }));
  const lines = view.captureCharFrame().split("\n");
  assert.equal(row(lines, "WebFetch") - row(lines, "tool-intro"), 1);
  assert.equal(row(lines, "tool-result") - row(lines, "tool-output"), 1);
  assert.equal(row(lines, "continuation-one") - row(lines, "tool-result"), 1);
  assert.equal(row(lines, "continuation-two") - row(lines, "continuation-one"), 1);
  assert.equal(row(lines, "continuation-three") - row(lines, "continuation-two"), 1);
  assert.equal(row(lines, "last-paragraph") - row(lines, "continuation-three"), 1);
  assert.equal(row(lines, "next-user") - row(lines, "last-paragraph"), 2);
  assert.equal(JSON.stringify(messages), before);
});
