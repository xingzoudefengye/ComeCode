import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryAgentLoop } from "../packages/core/src/memory/memory-agent-loop.ts";

function model(generateText) {
  return {
    properties: { inputFormat: { image: false } },
    optionSpecs: { reasoningLevel: { values: ["low"] }, maxOutputTokens: { max: 9000 } },
    generateText,
  };
}
function toolResult(call, success = true) {
  return {
    toolCallId: call.id,
    toolName: call.name,
    success,
    output: "ok",
    modelContent: "ok",
    durationMs: 0,
    startedAt: new Date(),
    completedAt: new Date(),
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-extraction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, ".ai");
  const userRoot = join(root, "memories", "user");
  await mkdir(project);
  await mkdir(userRoot, { recursive: true });
  return {
    root,
    project,
    userRoot,
    roots: [
      {
        kind: "project",
        rootDir: project,
        files: ["project.md", "memory.md", "bugs.md", "tasks.md", "decisions.md"],
      },
      { kind: "user", rootDir: userRoot, files: ["profile.md", "preferences.md"] },
    ],
  };
}

test("loop permits both roots, hides unsafe tools, caps output/turns and denies history/outside writes", async (t) => {
  const { root, project, userRoot, roots } = await fixture(t);
  const executed = [];
  const requests = [];
  const targets = [
    ["Write", join(project, "tasks.md")],
    ["Edit", join(userRoot, "preferences.md")],
    ["Write", join(userRoot, "history.md")],
    ["Write", join(root, "outside.md")],
    ["Bash", undefined],
  ];
  const result = await runMemoryAgentLoop({
    rootDir: project,
    allowedRoots: roots,
    workspaceRoot: root,
    workingDirectory: root,
    maxTurns: 99,
    messages: [{ role: "user", content: "save preference" }],
    tools: ["Read", "Write", "Edit", "Bash", "Agent", "mcp__test"].map((name) => ({ name })),
    model: model(async (request) => {
      requests.push(request);
      return {
        text: "",
        usage: { outputTokens: 100 },
        toolCalls: targets.map(([name, file_path], index) => ({
          id: `call-${index}`,
          name,
          input: { file_path, content: "ok", command: "pwd" },
        })),
      };
    }),
    executeTool: async (call) => {
      executed.push(call);
      return toolResult(call);
    },
  });
  assert.equal(result.turns, 3);
  assert.equal(executed.length, 6);
  for (const request of requests) {
    assert.ok(request.options.maxOutputTokens <= 2000);
    assert.deepEqual(
      request.tools.map((tool) => tool.name),
      ["Read", "Write", "Edit"],
    );
  }
});

test("loop refuses writes proposed alongside Read and stops on mutation failure", async (t) => {
  const { root, project } = await fixture(t);
  const path = join(project, "tasks.md");
  const executed = [];
  await runMemoryAgentLoop({
    rootDir: project,
    workingDirectory: root,
    workspaceRoot: root,
    maxTurns: 1,
    messages: [],
    tools: [{ name: "Read" }, { name: "Write" }],
    model: model(async () => ({
      text: "",
      usage: { outputTokens: 100 },
      toolCalls: [
        { id: "read", name: "Read", input: { file_path: path } },
        { id: "write", name: "Write", input: { file_path: path, content: "unsafe replacement" } },
      ],
    })),
    executeTool: async (call) => {
      executed.push(call.name);
      return toolResult(call);
    },
  });
  assert.deepEqual(executed, ["Read"]);
  await assert.rejects(
    runMemoryAgentLoop({
      rootDir: project,
      workingDirectory: root,
      workspaceRoot: root,
      maxTurns: 3,
      messages: [],
      tools: [{ name: "Write" }],
      model: model(async () => ({
        text: "",
        toolCalls: [{ id: "write", name: "Write", input: { file_path: path } }],
      })),
      executeTool: async (call) => toolResult(call, false),
    }),
    /mutation failed/u,
  );
});

test("loop uses a shared 2000 output-token budget across model turns", async (t) => {
  const { root, project } = await fixture(t);
  const budgets = [];
  await runMemoryAgentLoop({
    rootDir: project,
    workingDirectory: root,
    workspaceRoot: root,
    maxTurns: 3,
    messages: [],
    tools: [{ name: "Read" }],
    model: model(async (request) => {
      budgets.push(request.options.maxOutputTokens);
      return {
        text: "",
        usage: { outputTokens: 500 },
        toolCalls: [{ id: "read", name: "Read", input: { file_path: join(project, "tasks.md") } }],
      };
    }),
    executeTool: async (call) => toolResult(call),
  });
  assert.deepEqual(budgets, [2000, 1500, 1000]);
});

test("loop cancellation propagates to model and does not execute stale results", async (t) => {
  const { root, project } = await fixture(t);
  const controller = new AbortController();
  let modelSignal;
  let writes = 0;
  const pending = runMemoryAgentLoop({
    rootDir: project,
    workingDirectory: root,
    workspaceRoot: root,
    maxTurns: 3,
    messages: [],
    tools: [{ name: "Write" }],
    abortSignal: controller.signal,
    model: model(async (request) => {
      modelSignal = request.abortSignal;
      controller.abort(new DOMException("cancel", "AbortError"));
      return {
        text: "",
        toolCalls: [{ id: "x", name: "Write", input: { file_path: join(project, "tasks.md") } }],
      };
    }),
    executeTool: async (call) => {
      writes++;
      return toolResult(call);
    },
  });
  await assert.rejects(pending, /cancel/u);
  assert.equal(modelSignal.aborted, true);
  assert.equal(writes, 0);
});
