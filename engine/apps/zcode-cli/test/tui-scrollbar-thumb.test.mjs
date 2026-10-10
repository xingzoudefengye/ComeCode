import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ContentPane } from "../packages/tui/src/app-transcript-components.tsx";
import { DARK_TUI_THEME, setActiveTuiThemeMode } from "../packages/tui/src/theme/index.ts";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(
  pathToFileURL(require.resolve("@mbears/opentui-react/test-utils")).href
);

// OpenTUI 默认滑块色，非主题 token；这里用它确认滑块是整格背景填充。
const OPENTUI_DEFAULT_THUMB_COLOR = [154, 158, 163];
const TRACK_COLOR = [20, 20, 20];
// 方块/半块字形：滑块若用字形绘制，终端会按字体行高留缝，看起来像多个小块。
const BLOCK_GLYPHS = /[\u2588\u2580\u2584\u258c\u2590]/u;

const rgba = (color) => [color.buffer[0], color.buffer[1], color.buffer[2]];

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

test("会话滚动条滑块用整格背景填充，不再输出方块字形", async (t) => {
  setActiveTuiThemeMode("dark");
  // 内容高于视口，保证滚动条出现；测试渲染里滑块通常只有一行，
  // 正好覆盖原生实现的半格字形分支。
  const messages = Array.from({ length: 24 }, (_, index) => [
    { role: "user", content: `用户消息 ${index}` },
    { role: "agent", content: `模型回复 ${index}` },
  ]).flat();

  let view;
  await React.act(async () => {
    view = await testRender(React.createElement(ContentPane, { focused: false, messages }), {
      width: 90,
      height: 36,
    });
    await view.flush();
  });
  t.after(async () => {
    await React.act(async () => view.renderer.destroy());
  });
  await settle(view);

  const frame = view.captureCharFrame();
  assert.ok(!BLOCK_GLYPHS.test(frame), "滚动条不应再用 █/▀/▄ 等方块字形绘制滑块");

  const spans = view.captureSpans();
  // 逐行取最右一列的背景色：同一个背景色的相邻单元格会在 spans 里合并。
  const lastColumn = spans.lines.slice(0, spans.rows).map((line) => {
    let x = 0;
    for (const span of line.spans) {
      if (spans.cols - 1 < x + span.width) return span.bg ? rgba(span.bg) : null;
      x += span.width;
    }
    return null;
  });
  const thumbRows = lastColumn.filter((bg) => bg && bg.join(",") === OPENTUI_DEFAULT_THUMB_COLOR.join(","));
  const trackRows = lastColumn.filter((bg) => bg && bg.join(",") === TRACK_COLOR.join(","));

  // 滑块只占半格时 OpenTUI 会画 ▀/▄ 字形（fg=滑块色、bg=轨道色）；
  // 改成整格背景填充后，滑块单元格的 bg 才是滑块色，终端会铺满整个单元格。
  assert.ok(thumbRows.length >= 1, `滚动条滑块应使用整格背景填充，实际 ${thumbRows.length} 行`);
  assert.ok(trackRows.length >= 2, `滚动条轨道应保持深色整格背景，实际 ${trackRows.length} 行`);
  assert.equal(DARK_TUI_THEME.background, "#141414");
});
