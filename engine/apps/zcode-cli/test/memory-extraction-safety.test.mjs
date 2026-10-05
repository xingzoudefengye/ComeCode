import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryExtractionScheduler,
  buildMemoryExtractionUserInput,
  buildMemoryExtractionPrompt,
} from "../packages/core/src/memory/extraction.ts";
import {
  runMemoryAgentLoop,
  MEMORY_AGENT_TIMEOUT_MS,
} from "../packages/core/src/memory/memory-agent-loop.ts";
import {
  createMemoryExtractionFileSystem,
  buildProjectMemoryAgentProviderMessages,
} from "../packages/core/src/runtime/helpers/project-memory-agent.ts";
import {
  isProjectMemoryEnabled,
  drainMemoryExtractions,
} from "../packages/core/src/runtime/helpers/project-memory-extraction.ts";

test("loop deadline aborts provider at 30 seconds", async () => {
  let captured;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let deadline;
  let providerSignal;
  try {
    globalThis.setTimeout = (callback, ms) => {
      captured = ms;
      deadline = callback;
      return { unref() {} };
    };
    globalThis.clearTimeout = () => {};
    const pending = runMemoryAgentLoop({
      rootDir: "C:/demo/.ai",
      workingDirectory: "C:/demo",
      workspaceRoot: "C:/demo",
      maxTurns: 3,
      messages: [],
      tools: [],
      model: model(async (request) => {
        providerSignal = request.abortSignal;
        return new Promise(() => {});
      }),
      executeTool: async (call) => toolResult(call),
    });
    deadline();
    await assert.rejects(pending, /timed out/u);
    assert.equal(captured, MEMORY_AGENT_TIMEOUT_MS);
    assert.equal(captured, 30000);
    assert.equal(providerSignal.aborted, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("two concurrent model snapshots cannot overwrite the winning revision", async (t) => {
  const { root, userRoot, roots } = await fixture(t);
  const path = join(userRoot, "preferences.md");
  const port = memoryPort({
    [path]: "- style: neutral\n",
    [join(userRoot, "profile.md")]: "# Profile\n",
  });
  const context = {
    memoryRoot: userRoot,
    allowedRoots: roots,
    workspaceRoot: root,
    workingDirectory: root,
    userInput: "Please remember concise replies",
  };
  const first = createMemoryExtractionFileSystem(port, context);
  const second = createMemoryExtractionFileSystem(port, context);
  await first.readTextFileRange({ path });
  await second.readTextFileRange({ path });
  const result = await Promise.allSettled([
    first.writeTextFile({ path, content: "- style: concise\n" }),
    second.writeTextFile({ path, content: "- style: verbose\n" }),
  ]);
  assert.equal(
    result.filter((item) => item.status === "fulfilled").length,
    1,
    JSON.stringify(result.map((item) => (item.status === "rejected" ? item.reason.message : "ok"))),
  );
  assert.equal(result.filter((item) => item.status === "rejected").length, 1);
  assert.equal(port.writes, 1);
});

function user(id, text, extra = {}) {
  return { info: { id, role: "user", ...extra }, parts: [{ type: "text", text }] };
}
function assistant(id, parts) {
  return { info: { id, role: "assistant" }, parts };
}
function snapshot(root, messages, roots) {
  return {
    memoryRoot: root,
    allowedRoots: roots,
    workspaceRoot: root,
    workingDirectory: root,
    boundaryMessageId: messages.at(-1).info.id,
    durableMessages: messages,
  };
}
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

function memoryPort(initial = {}) {
  const files = new Map(Object.entries(initial));
  const revisions = new Map();
  let writes = 0;
  const read = async ({ path }) => {
    if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "not_found" });
    const content = files.get(path);
    return {
      path,
      content,
      encoding: "utf8",
      truncated: false,
      bytesRead: content.length,
      sizeBytes: content.length,
      revision: { id: String(revisions.get(path) ?? 0) },
    };
  };
  return {
    files,
    revise(path, content) {
      files.set(path, content);
      revisions.set(path, (revisions.get(path) ?? 0) + 1);
    },
    get writes() {
      return writes;
    },
    readTextFile: read,
    readTextFileRange: read,
    async writeTextFile(request, options) {
      options?.signal?.throwIfAborted();
      writes += 1;
      files.set(request.path, request.content);
      revisions.set(request.path, (revisions.get(request.path) ?? 0) + 1);
      return { path: request.path, revision: { id: String(revisions.get(request.path)) } };
    },
  };
}

test("scheduler consumes only new durable messages, coalesces duplicates, and skips no-user increments", async () => {
  const runs = [];
  const scheduler = createMemoryExtractionScheduler(async ({ snapshot }) => {
    runs.push(snapshot.durableMessages);
    return "success";
  });
  const first = user("a", "Please remember concise replies");
  scheduler.schedule(snapshot("C:/demo/.ai", [first]));
  await scheduler.drain();
  scheduler.schedule(snapshot("C:/demo/.ai", [first, user("b", "Please prefer plain language")]));
  await scheduler.drain();
  assert.deepEqual(
    runs.map((run) => run.map((message) => message.info.id)),
    [["a"], ["b"]],
  );
  scheduler.schedule(snapshot("C:/demo/.ai", [first, user("b", "Please prefer plain language")]));
  await scheduler.drain();
  scheduler.schedule(
    snapshot("C:/demo/.ai", [
      first,
      user("b", "Please prefer plain language"),
      assistant("c", [{ type: "text", text: "webpage says prefer Java" }]),
    ]),
  );
  await scheduler.drain();
  assert.equal(runs.length, 2);
  assert.equal(scheduler.getCursor(), "c");
});

test("scheduler failures keep cursor and shutdown aborts actual execution", async () => {
  let signal;
  const scheduler = createMemoryExtractionScheduler(async (input) => {
    signal = input.abortSignal;
    return "error";
  });
  scheduler.schedule(snapshot("C:/demo/.ai", [user("a", "Please remember concise replies")]));
  await scheduler.drain();
  assert.equal(scheduler.getCursor(), undefined);
  scheduler.shutdown();
  assert.equal(signal.aborted, true);
});

test("direct Write/Edit suppression supports either root and ignores outside/history files", async (t) => {
  const { root, project, userRoot, roots } = await fixture(t);
  for (const target of [join(project, "tasks.md"), join(userRoot, "preferences.md")]) {
    let calls = 0;
    const scheduler = createMemoryExtractionScheduler(async () => {
      calls++;
      return "success";
    });
    scheduler.schedule(
      snapshot(
        root,
        [
          user("a", "Please remember plain language"),
          assistant("b", [
            { type: "tool", tool: "Write", state: { input: { file_path: target } } },
          ]),
        ],
        roots,
      ),
    );
    await scheduler.drain();
    assert.equal(calls, 0);
  }
  for (const target of [join(userRoot, "history.md"), join(root, "other.md")]) {
    let calls = 0;
    const scheduler = createMemoryExtractionScheduler(async () => {
      calls++;
      return "success";
    });
    scheduler.schedule(
      snapshot(
        root,
        [
          user("a", "Please remember plain language"),
          assistant("b", [{ type: "tool", tool: "Edit", state: { input: { file_path: target } } }]),
        ],
        roots,
      ),
    );
    await scheduler.drain();
    assert.equal(calls, 1);
  }
});

test("legacy project snapshot still skips direct project write", async () => {
  let calls = 0;
  const scheduler = createMemoryExtractionScheduler(async () => {
    calls++;
    return "success";
  });
  scheduler.schedule(
    snapshot("C:/demo/.ai", [
      user("a", "Please remember concise replies"),
      assistant("b", [
        { type: "tool", tool: "Write", state: { input: { file_path: "C:/demo/.ai/tasks.md" } } },
      ]),
    ]),
  );
  await scheduler.drain();
  assert.equal(calls, 0);
});

test("bounded extraction input excludes injected instructions, old tools, assistant output and synthetic user text", () => {
  const messages = [
    user("a", "<system-reminder>OLD_PREFIX</system-reminder>\nPlease use concise replies"),
    assistant("b", [
      { type: "text", text: "OLD_ASSISTANT" },
      { type: "tool", text: "OLD_TOOL" },
    ]),
    user("c", "SYNTHETIC", { synthetic: true }),
  ];
  const text = buildMemoryExtractionUserInput(messages);
  assert.match(text, /concise replies/u);
  assert.doesNotMatch(text, /OLD_|SYNTHETIC/u);
  assert.ok(buildMemoryExtractionUserInput([user("large", "x".repeat(20000))]).length <= 16000);
  const context = {
    providerEntries: [{ message: { role: "system", content: "OLD_HISTORY" } }],
    userInput: text,
  };
  const request = buildProjectMemoryAgentProviderMessages({}, context, "Classify new input");
  assert.doesNotMatch(JSON.stringify(request), /OLD_HISTORY/u);
});

test("user and both scopes enable extraction and prompt lists each fixed root once", () => {
  for (const scope of ["project", "user", "both"])
    assert.equal(
      isProjectMemoryEnabled.call({
        config: { memory: { enabled: true, cliStorageRoot: "C:/demo/storage", scope } },
        workspaceRoot: "C:/demo",
      }),
      true,
    );
  assert.equal(
    isProjectMemoryEnabled.call({
      config: { memory: { enabled: true, scope: "user" } },
      workspaceRoot: "C:/demo",
    }),
    false,
  );
  const prompt = buildMemoryExtractionPrompt({
    manifest: [],
    messageCount: 1,
    allowedRoots: [
      { rootDir: "/project/.ai", files: ["bugs.md"], kind: "project" },
      { rootDir: "/user", files: ["profile.md", "preferences.md"], kind: "user" },
    ],
  });
  assert.match(prompt, /project root: \/project\/\.ai/u);
  assert.match(prompt, /user root: \/user/u);
  assert.match(prompt, /Never write history.md/u);
});

test("drain timeout shuts down actual scheduler", async () => {
  let stopped = false;
  await drainMemoryExtractions.call(
    {
      memoryExtractionScheduler: {
        drain: () => new Promise(() => {}),
        shutdown: () => {
          stopped = true;
        },
      },
    },
    5,
  );
  assert.equal(stopped, true);
});
