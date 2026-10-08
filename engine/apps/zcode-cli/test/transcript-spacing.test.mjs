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

test("原生对话渲染：用户与模型分层，Thought 和正文段落保持适度间距", async (t) => {
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
    assert.equal(row(lines, "目前工作区") - row(lines, "你好！"), 2);
    assert.equal(row(lines, "有什么想") - row(lines, "目前工作区"), 2);
    assert.equal(row(lines, "今天是几月") - row(lines, "有什么想"), 2);
    assert.equal(row(lines, "今天是 2026") - row(lines, "今天是几月"), 2);
    assert.equal(row(lines, "顺便一提") - row(lines, "今天是 2026"), 2);
    await view.close();
  }
});

test("思考与正文之间夹着已完成工具时仍保留间距", async (t) => {
  const view = await render(
    t,
    React.createElement(ContentPane, {
      focused: false,
      messages: [
        {
          role: "agent",
          content: "",
          parts: [
            { type: "thought", status: "thought", text: "先思考", contentCharCount: 3 },
            {
              type: "tool",
              toolCallId: "completed-hidden",
              toolName: "Bash",
              status: "completed",
              output: "隐藏工具输出",
            },
            { type: "text", text: "最终正文" },
          ],
        },
      ],
    }),
  );
  const lines = view.captureCharFrame().split("\n");
  assert.equal(row(lines, "最终正文") - row(lines, "Thought"), 2);
});

test("Markdown 段落保留块间距，不修改原文并保留代码、列表、表格内容", async (t) => {
  const content =
    "正文第一段\n\n正文第二段\n\n```text\ncode-first\n\ncode-last\n```\n\n- item-one\n- item-two\n\n| column | value |\n| --- | --- |\n| table-row | 42 |";
  const view = await render(t, React.createElement(MarkdownText, { content, streaming: false }));
  const lines = view.captureCharFrame().split("\n");
  assert.equal(row(lines, "正文第二段") - row(lines, "正文第一段"), 2);
  assert.equal(row(lines, "code-last") - row(lines, "code-first"), 2);
  assert.equal(row(lines, "item-two") - row(lines, "item-one"), 1);
  assert.ok(row(lines, "table-row") > row(lines, "item-two"));
});

test("Markdown 连续空行只保留一个段落间隔，代码围栏内部保持原样", async (t) => {
  const content =
    "正文第一段\n\n\n\n正文第二段\n\n```text\ncode-first\n\n\ncode-last\n```";
  const view = await render(t, React.createElement(MarkdownText, { content, streaming: false }));
  const lines = view.captureCharFrame().split("\n");
  assert.equal(row(lines, "正文第二段") - row(lines, "正文第一段"), 2);
  assert.equal(row(lines, "code-last") - row(lines, "code-first"), 3);
});

test("无关父级刷新不重新创建 Markdown 高亮样式", async (t) => {
  setActiveTuiThemeMode("dark");
  const view = await render(
    t,
    React.createElement(MarkdownText, { content: "稳定正文", streaming: false }),
  );
  const firstNode = view.renderer.root.getChildren()[0];
  const firstSyntaxStyle = firstNode.syntaxStyle;
  assert.ok(firstSyntaxStyle);

  await view.update(React.createElement(MarkdownText, { content: "稳定正文", streaming: false }));
  const secondNode = view.renderer.root.getChildren()[0];
  assert.equal(secondNode.syntaxStyle, firstSyntaxStyle);
  assert.ok(view.captureCharFrame().includes("稳定正文"));
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
      2,
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
          status: "running",
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
  assert.equal(row(lines, "WebFetch") - row(lines, "tool-intro"), 2);
  assert.equal(row(lines, "tool-result") - row(lines, "tool-output"), 2);
  assert.equal(row(lines, "continuation-one") - row(lines, "tool-result"), 2);
  assert.equal(row(lines, "continuation-two") - row(lines, "continuation-one"), 1);
  assert.equal(row(lines, "continuation-three") - row(lines, "continuation-two"), 1);
  assert.equal(row(lines, "last-paragraph") - row(lines, "continuation-three"), 2);
  assert.equal(row(lines, "next-user") - row(lines, "last-paragraph"), 2);
  assert.equal(JSON.stringify(messages), before);
});

test("完成的普通工具隐藏，失败工具只保留有界摘要，运行中工具持续显示", async (t) => {
  const messages = [
    {
      role: "agent",
      content: "",
      parts: [
        {
          type: "tool",
          toolCallId: "done",
          toolName: "Bash",
          status: "completed",
          detailLines: ["command: secret"],
          output: "completed-output",
        },
        {
          type: "tool",
          toolCallId: "failed",
          toolName: "Read",
          status: "failed",
          detailLines: ["file: secret"],
          error: "failure-detail ".repeat(40),
          output: "large-output",
        },
        {
          type: "tool",
          toolCallId: "running",
          toolName: "Edit",
          status: "running",
          detailLines: ["file: active.ts"],
        },
        { type: "text", text: "关键结论" },
      ],
    },
  ];
  const before = JSON.stringify(messages);
  const view = await render(t, React.createElement(ContentPane, { focused: false, messages }));
  const frame = view.renderer.root ? view.renderer.root : undefined;
  const text = view.captureCharFrame();
  assert.doesNotMatch(text, /secret|completed-output|large-output/u);
  assert.match(text, /failed|失败/u);
  assert.match(text, /failure-detail/u);
  assert.match(text, /Edit/u);
  assert.match(text, /active\.ts/u);
  assert.match(text, /关键结论/u);
  assert.equal(JSON.stringify(messages), before);
  void frame;
});
test("只含已完成工具的消息不再占用垂直布局空间", async (t) => {
  const withoutHiddenMessage = await render(
    t,
    React.createElement(ContentPane, {
      focused: false,
      messages: [{ role: "agent", content: "后续结论" }],
    }),
  );
  const withHiddenMessage = await render(
    t,
    React.createElement(ContentPane, {
      focused: false,
      messages: [
        {
          role: "agent",
          content: "",
          parts: [
            {
              type: "tool",
              toolCallId: "completed-only",
              toolName: "Bash",
              status: "completed",
              output: "不应占位",
            },
          ],
        },
        { role: "agent", content: "后续结论" },
      ],
    }),
  );
  const baseline = row(withoutHiddenMessage.captureCharFrame().split("\n"), "后续结论");
  const actual = row(withHiddenMessage.captureCharFrame().split("\n"), "后续结论");
  assert.equal(actual, baseline);
});

test("用户消息使用引用标记，模型列表保留层级缩进", async (t) => {
  const userView = await render(
    t,
    React.createElement(ContentPane, {
      focused: false,
      messages: [{ role: "user", content: "第一段\n\n第二段" }],
    }),
  );
  const userLines = userView.captureCharFrame().split("\n");
  assert.ok(userLines.some((line) => line.includes("> 第一段")));
  assert.ok(userLines.some((line) => line.includes("> 第二段")));

  const markdown = await render(
    t,
    React.createElement(MarkdownText, {
      content: "- 一级项目\n  - 二级项目\n\n1. 第一个步骤\n2. 第二个步骤",
      streaming: false,
    }),
  );
  const lines = markdown.captureCharFrame().split("\n");
  const top = lines.find((line) => line.includes("一级项目"));
  const nested = lines.find((line) => line.includes("二级项目"));
  assert.ok(top && nested);
  assert.ok(nested.indexOf("二级项目") > top.indexOf("一级项目"));
  assert.ok(lines.some((line) => line.includes("第一个步骤")));
  assert.ok(lines.some((line) => line.includes("第二个步骤")));
});
