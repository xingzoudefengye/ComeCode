import assert from "node:assert/strict";
import { test } from "node:test";
import { runTuiCommand } from "../packages/cli/src/tui-command.ts";
import { formatSessionResumeCommand } from "../packages/cli/src/admin/sessions.ts";

for (const request of [{ resumeSessionId: "session-existing", continueSession: false }, { continueSession: true }, { continueSession: false }]) {
  test(`TUI 启动恢复展示原历史 ${JSON.stringify(request)}`, async () => {
    let created = 0, resumed = 0, closed = 0;
    const restoring = Boolean(request.resumeSessionId || request.continueSession);
    const transcript = [{ role: "user", content: "旧问题" }, { role: "agent", content: "旧答复" }];
    const ctx = { stdin: { isTTY: true }, stdout: { write() {} }, stderr: { write(text) { assert.fail(text); } } };
    const status = await runTuiCommand(ctx, { noColor: true }, {
      cwd: () => "/fixture", env: {}, skipUserConfig: true,
      loadDotenv: () => ({ keys: [], loaded: false }),
      resolveLatestSession: async () => ({ id: "session-existing" }),
      listCustomCommands: async () => ({ commands: [] }),
      resolveWorkspaceGitBranch: async () => undefined,
      startProcessProviderRegistryRuntime: async () => ({ runtime: { registryService: {} }, dispose() {} }),
      createZCodeApp: ({ sessionId }) => {
        created++;
        assert.equal(sessionId, restoring ? "session-existing" : undefined);
        return {
          sessionId: sessionId ?? "session-new", runtime: {}, listModels: async () => [],
          resume: async () => { resumed++; return { directory: "/fixture", messageCount: 2, partCount: 2, appliedMessageCount: 2, interruptedToolCount: 0 }; },
          loadSessionTranscript: async () => transcript,
          close: async () => { closed++; },
        };
      },
      runTui: async options => {
        const startup = await options.loadStartupOptions();
        assert.equal(startup.initialSessionId, restoring ? "session-existing" : "session-new");
        if (restoring) {
          assert.deepEqual(startup.initialResult.restoredMessages, transcript);
          assert.equal(startup.initialResult.resetSessionProjection, true);
          assert.match(startup.initialResult.response, /Resumed session session-existing/);
        } else assert.equal(startup.initialResult.restoredMessages, undefined);
        return 0;
      },
    }, "test", undefined, request);
    assert.equal(status, 0);
    assert.equal(created, 1);
    assert.equal(resumed, restoring ? 1 : 0);
    assert.equal(closed, 1);
  });
}

test("恢复命令保留 Windows 路径，正确引用空格与单引号", () => {
  assert.equal(formatSessionResumeCommand("sess-test", "E:\\Projects\\ComeCode", "win32"), "comecode --resume 'sess-test' --cwd 'E:\\Projects\\ComeCode'");
  assert.equal(formatSessionResumeCommand("sess-test", "C:\\User's Projects", "win32"), "comecode --resume 'sess-test' --cwd 'C:\\User''s Projects'");
  assert.equal(formatSessionResumeCommand("sess-test", "/work/user's project", "linux"), "comecode --resume 'sess-test' --cwd '/work/user'\"'\"'s project'");
});
