import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  projectRuntimeActivity,
  useRuntimeActivity,
} from "../packages/tui/src/app-runtime-activity.ts";
import { applyModelCacheAndBudgetEvent } from "../packages/tui/src/app-turn-complete.ts";
import { InputActiveStatus, InputComposerStatus } from "../packages/tui/src/app-input-status.tsx";
import { ContentPane } from "../packages/tui/src/app-transcript-components.tsx";
import { getZCodeCopy } from "../packages/i18n/src/index.ts";

const require = createRequire(new URL("../packages/tui/package.json", import.meta.url));
const React = require("react");
const { testRender } = await import(
  pathToFileURL(require.resolve("@mbears/opentui-react/test-utils"))
);
const { displayWidth } = await import("../packages/tui/src/app-terminal-width.ts");
const event = (type, payload = {}, turnId = "turn-1") => ({ type, payload, turnId });

test("关闭压缩清除主请求旧阈值，辅助请求与未知缓存用量不覆盖已有事实", () => {
  let context = { compactThreshold: 120000 };
  let cache = { hitRate: 0.8 };
  const setContext = (update) => {
    context = update(context);
  };
  const setCache = (update) => {
    cache = update(cache);
  };
  applyModelCacheAndBudgetEvent({ querySource: "compact" }, setCache, setContext);
  assert.equal(context.compactThreshold, 120000);
  applyModelCacheAndBudgetEvent(
    { querySource: "main_turn", cacheHit: { hitRate: 0 } },
    setCache,
    setContext,
  );
  assert.equal(context.compactThreshold, undefined);
  assert.equal(cache.hitRate, 0.8);
});

test("窄终端输入框仍显示模式、模型和思考强度", async () => {
  let view;
  await React.act(async () => {
    view = await testRender(
      React.createElement(InputComposerStatus, {
        contentWidth: 72,
        mode: "edit",
        model: "openai/gpt-5",
        sessionId: "sess_1234567890abcdef",
        thoughtLevel: "high",
      }),
      { width: 72, height: 2 },
    );
  });
  try {
    await React.act(async () => {
      await view.flush();
    });
    const frame = view.captureCharFrame();
    assert.match(frame, /Edit/u);
  } finally {
    await React.act(async () => {
      view.renderer.destroy();
    });
  }
});

test("对话列表保持紧凑行距，空闲输入框压缩为单行", async () => {
  let transcript;
  let composer;
  await React.act(async () => {
    transcript = await testRender(
      React.createElement(ContentPane, {
        focused: false,
        messages: [
          { content: "你好", role: "user" },
          { content: "你好，我可以帮你处理代码。", role: "agent" },
        ],
        terminalWidth: 80,
      }),
      { width: 80, height: 8 },
    );
    composer = await testRender(
      React.createElement(InputComposerStatus, {
        contentWidth: 72,
        mode: "edit",
        model: "openai/gpt-5",
        sessionId: "sess_1234567890abcdef",
        thoughtLevel: "high",
      }),
      { width: 72, height: 2 },
    );
  });
  try {
    await React.act(async () => {
      await transcript.flush();
      await composer.flush();
    });
    const rows = transcript
      .captureCharFrame()
      .split("\n")
      .filter((row) => row.trim());
    assert.ok(rows.length <= 3, transcript.captureCharFrame());
    assert.equal(composer.captureCharFrame().split("\n").filter((row) => row.trim()).length, 1);
  } finally {
    await React.act(async () => {
      transcript.renderer.destroy();
      composer.renderer.destroy();
    });
  }
});

test("输入框外部状态栏合并模式信息与 Ready", async () => {
  let view;
  await React.act(async () => {
    view = await testRender(
      React.createElement(InputActiveStatus, {
        active: false,
        contentWidth: 100,
        copy: getZCodeCopy("zh-CN").tui,
        mode: "yolo",
        model: "openai/gpt-5",
        sessionId: "sess_1234567890abcdef",
        thoughtLevel: "high",
        runtimeActivity: { phase: "idle" },
      }),
      { width: 100, height: 2 },
    );
  });
  try {
    await React.act(async () => {
      await view.flush();
    });
    const frame = view.captureCharFrame();
    assert.match(frame, /Yolo.*(?:Ready|就绪)/u);
    assert.equal(frame.split("\n").filter((row) => row.trim()).length, 1, frame);
  } finally {
    await React.act(async () => {
      view.renderer.destroy();
    });
  }
});

test("只有当前 turn 终态能结束运行，取消与失败分别展示", () => {
  const running = projectRuntimeActivity({ phase: "idle" }, event("turn_started"), 1000);
  assert.equal(
    projectRuntimeActivity(running, event("turn_complete", {}, "old-turn"), 2000),
    running,
  );
  assert.equal(
    projectRuntimeActivity(running, event("turn_complete", { resultType: "cancelled" }), 2000)
      .phase,
    "cancelled",
  );
  assert.equal(projectRuntimeActivity(running, event("turn_error"), 2000).phase, "failed");
  const terminal = projectRuntimeActivity(
    running,
    event("turn_complete", { resultType: "success" }),
    2000,
  );
  assert.equal(projectRuntimeActivity(terminal, event("model_streaming"), 3000), terminal);
});

test("并发确认全部结算后才恢复运行", () => {
  let state = projectRuntimeActivity({ phase: "idle" }, event("turn_started"), 0);
  state = projectRuntimeActivity(state, event("permission_requested", { toolCallId: "a" }), 1);
  state = projectRuntimeActivity(
    state,
    event("workspace_hook_review_requested", { request: { interactionId: "b" } }),
    2,
  );
  state = projectRuntimeActivity(state, event("permission_resolved", { toolCallId: "a" }), 3);
  assert.equal(state.phase, "waiting");
  state = projectRuntimeActivity(
    state,
    event("workspace_hook_review_settled", { interactionId: "b" }),
    4,
  );
  assert.equal(state.phase, "working");
});

test("时间心跳不刷新活动，真实输出刷新；等待确认显示为等待", () => {
  const running = projectRuntimeActivity({ phase: "idle" }, event("turn_started"), 1000);
  assert.equal(
    projectRuntimeActivity(running, event("tool_call_progress", { elapsedMs: 1000 }), 2000),
    running,
  );
  const progress = projectRuntimeActivity(
    running,
    event("tool_call_progress", { toolCallId: "tool", outputBytes: 10 }),
    2000,
  );
  assert.equal(progress.lastActivityAt, 2000);
  assert.equal(
    projectRuntimeActivity(
      progress,
      event("tool_call_progress", { toolCallId: "tool", outputBytes: 10 }),
      3000,
    ),
    progress,
  );
  assert.equal(
    projectRuntimeActivity(progress, event("permission_requested"), 3000).phase,
    "waiting",
  );
});

test("原生状态栏在不同宽度固定一行，结束/等待/停滞/缓存信息可见", async () => {
  for (const width of [24, 40, 80, 120]) {
    for (const phase of ["completed", "waiting", "model"]) {
      const now = Date.now();
      let view;
      await React.act(async () => {
        view = await testRender(
          React.createElement(InputActiveStatus, {
            active: phase !== "completed",
            frameMs: 0,
            contentWidth: width,
            copy: getZCodeCopy("zh-CN").tui,
            contextUsage: { contextUsed: 100000, contextWindow: 200000, compactThreshold: 120000 },
            cacheHitRate: 0.8,
            backgroundCount: 2,
            runtimeActivity: { phase, startedAt: now - 120000, lastActivityAt: now - 100000 },
          }),
          { width, height: 3 },
        );
      });
      try {
        await React.act(async () => {
          await view.flush();
        });
        const frame = view.captureCharFrame();
        const rows = frame.split("\n").filter((row) => row.trim());
        assert.equal(rows.length, 1, frame);
        assert.ok(
          rows.every((row) => displayWidth(row) <= width),
          frame,
        );
        if (width >= 80) {
          assert.match(
            frame,
            phase === "completed" ? /已完成/u : phase === "waiting" ? /等待确认/u : /较久无新进展/u,
          );
        }
        if (width >= 120) assert.match(frame, /缓存 80%/u);
      } finally {
        await React.act(async () => {
          view.renderer.destroy();
        });
      }
    }
  }
});

test("主会话事件驱动原生状态栏，child 终态和重复事件不结束主任务", async () => {
  let onEvent;
  const getMainSessionId = () => "parent";
  function Harness() {
    const runtime = useRuntimeActivity(getMainSessionId);
    onEvent = runtime.onEvent;
    return React.createElement(InputActiveStatus, {
      active: true,
      frameMs: 0,
      contentWidth: 80,
      copy: getZCodeCopy("zh-CN").tui,
      runtimeActivity: runtime.activity,
    });
  }
  let view;
  await React.act(async () => {
    view = await testRender(React.createElement(Harness), { width: 80, height: 3 });
  });
  const emit = async (type, id, sessionId = "parent", payload = {}) => {
    await React.act(async () => {
      onEvent({ ...event(type, payload), id, sessionId });
    });
    await React.act(async () => {
      await view.flush();
    });
    return view.captureCharFrame();
  };
  try {
    await emit("turn_started", "start");
    const model = await emit("model_request", "model");
    assert.match(model, /等待模型/u);
    assert.equal(await emit("turn_complete", "child-done", "child"), model);
    assert.equal(
      await emit("tool_call_started", "mirror", "parent", { source: "subagent" }),
      model,
    );
    const done = await emit("turn_complete", "done", "parent", { resultType: "success" });
    assert.match(done, /已完成/u);
    assert.equal(await emit("turn_started", "start"), done);
    assert.equal(await emit("model_streaming", "late"), done);
  } finally {
    await React.act(async () => {
      view.renderer.destroy();
    });
  }
});
