import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMemoryExtractionEvidence,
  buildMemoryExtractionInput,
  buildMemoryExtractionPrompt,
  collectMemoryExtractionEvidence,
  createMemoryExtractionScheduler,
} from "../packages/core/src/memory/extraction.ts";

const assistant = (id, part) => ({
  info: { id, role: "assistant" },
  parts: [part],
});

const bash = (id, command, output, extra = {}) => ({
  id: `part-${id}`,
  sessionID: "session-memory-evidence",
  messageID: id,
  type: "tool",
  callID: `call-${id}`,
  tool: "Bash",
  state: {
    status: "completed",
    input: { command },
    output: JSON.stringify(output),
    title: "Run command",
    metadata: {},
    time: { start: 1, end: 2 },
    ...extra,
  },
});

const commitOutput = {
  stdout: "[main abcdef1234567] fix memory extraction",
  stderr: "",
  status: "completed",
  exitCode: 0,
};

const pushOutput = {
  stdout: "",
  stderr: "To example.invalid:demo/project.git\nabc1234..def5678 main -> main",
  status: "completed",
  exitCode: 0,
};

test("只从实际完成且退出成功的 Git ToolPart 构建脱敏证据", () => {
  const messages = [
    assistant("commit", bash("commit", 'git commit -m "done"', commitOutput)),
    assistant("push", bash("push", "git push origin main", pushOutput)),
  ];
  const evidence = collectMemoryExtractionEvidence(messages);
  assert.deepEqual(
    evidence.map((item) => item.kind),
    ["commit", "push"],
  );
  const text = buildMemoryExtractionEvidence(messages);
  assert.match(text, /abcdef1234567/u);
  assert.match(text, /origin\/main/u);
  assert.match(text, /toolCallID=call-commit/u);
  assert.doesNotMatch(text, /git commit|git push|example\.invalid|project\.git/u);
});

test("真实 Bash 持久化的纯文本输出也支持 stdout/stderr 合并核验", () => {
  const messages = [
    assistant("commit-text", {
      ...bash("commit-text", 'git commit -m "done"', commitOutput),
      state: {
        ...bash("commit-text", 'git commit -m "done"', commitOutput).state,
        output: commitOutput.stdout,
        metadata: { commandResult: { status: "completed", exitCode: 0 } },
      },
    }),
    assistant("push-text", {
      ...bash("push-text", "git push origin main", pushOutput),
      state: {
        ...bash("push-text", "git push origin main", pushOutput).state,
        output: pushOutput.stderr,
        metadata: { commandResult: { status: "completed", exitCode: 0 } },
      },
    }),
  ];
  assert.deepEqual(
    collectMemoryExtractionEvidence(messages).map((item) => item.kind),
    ["commit", "push"],
  );
});

test("失败、未完成、复合命令和仅文本匹配都不能产生证据", () => {
  const failed = { ...commitOutput, stdout: "[main abcdef1] maybe", exitCode: 1 };
  const messages = [
    assistant("failed", bash("failed", "git commit -m x", failed)),
    assistant("running", {
      ...bash("running", "git push origin main", pushOutput),
      state: { ...bash("running", "git push origin main", pushOutput).state, status: "running" },
    }),
    assistant(
      "compound",
      bash("compound", "git commit -m x && git push origin main", commitOutput),
    ),
    assistant(
      "text-only",
      bash("text-only", "git status", {
        stdout: "commit abcdef1 push origin main succeeded",
        stderr: "",
        status: "completed",
        exitCode: 0,
      }),
    ),
  ];
  assert.deepEqual(collectMemoryExtractionEvidence(messages), []);
});

test("旧纯文本缺少退出事实、失败元数据和取消结果不产生完成证据", () => {
  const parts = [
    bash("legacy", "git commit -m x", commitOutput, { output: commitOutput.stdout }),
    bash("cancelled", "git commit -m x", { ...commitOutput, status: "cancelled" }),
    bash("metadata-failed", "git commit -m x", commitOutput, {
      metadata: { commandResult: { status: "failed", exitCode: 1 } },
    }),
  ];
  assert.deepEqual(
    collectMemoryExtractionEvidence(parts.map((part, index) => assistant(String(index), part))),
    [],
  );
});

test("合并核验不泛化为验收完成，计划及失败输出不产生证据", () => {
  const part = bash("merge", "git merge feature/demo", {
    ...commitOutput,
    stdout: "Merge made by the 'ort' strategy.",
  });
  const evidence = collectMemoryExtractionEvidence([assistant("merge", part)]);
  assert.equal(evidence[0]?.kind, "merge");
  assert.match(evidence[0].summary, /不代表验收完成/u);
  assert.deepEqual(
    collectMemoryExtractionEvidence([
      assistant("merge-plan", bash("merge-plan", "git merge --abort", commitOutput)),
    ]),
    [],
  );
});

test("其它核验只接受明确结构化 passed 状态", () => {
  const part = bash("verify", "git status", commitOutput);
  part.state.metadata = { verification: { status: "passed", itemId: "tests-targeted" } };
  const evidence = collectMemoryExtractionEvidence([assistant("verify", part)]);
  assert.equal(evidence[0]?.kind, "verification");
  assert.match(buildMemoryExtractionEvidence([assistant("verify", part)]), /tests-targeted/u);
});

test("没有用户正文时，证据批次仍运行且游标只到证据消息", async () => {
  const runs = [];
  const scheduler = createMemoryExtractionScheduler(async ({ snapshot }) => {
    runs.push(snapshot.durableMessages.map((message) => message.info.id));
    return "success";
  });
  const messages = [assistant("tool", bash("tool", "git commit -m x", commitOutput))];
  scheduler.schedule({
    boundaryMessageId: "tool",
    durableMessages: messages,
    memoryRoot: "/tmp/project-memory",
    workspaceRoot: "/tmp",
    workingDirectory: "/tmp",
  });
  await scheduler.drain();
  assert.deepEqual(runs, [["tool"]]);
  assert.equal(scheduler.getCursor(), "tool");
});

test("用户正文与证据共享 6000 字符输入预算，prompt 保留状态更新与保护约束", () => {
  const messages = [
    {
      info: { id: "user", role: "user" },
      parts: [{ type: "text", text: "请记录这是一条足够明确的用户事实" }],
    },
    assistant("commit", bash("commit", "git commit -m x", commitOutput)),
  ];
  const input = buildMemoryExtractionInput(messages);
  assert.ok(input.length <= 6000);
  assert.match(input, /NEW USER PROSE/u);
  assert.match(input, /VERIFIED TOOL EVIDENCE/u);
  const prompt = buildMemoryExtractionPrompt({ manifest: [], messageCount: 2 });
  assert.match(prompt, /update matching keyed ids and statuses/u);
  assert.match(prompt, /protected constraints and active tasks/u);
  assert.match(prompt, /24000 characters and 65536 UTF-8 bytes/u);
  assert.match(prompt, /target 19000 characters/u);
  assert.match(prompt, /semantic compression/u);
});
