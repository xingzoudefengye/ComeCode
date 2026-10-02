import { providerSetupStartupResponse } from "./provider-setup.js";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { SessionEventType } from "@zcode/contracts";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import { createNodeClipboardImageReader } from "./clipboard-image.js";
import { createNodeClipboardTextWriter } from "./clipboard-text.js";
import { listSlashCommandSuggestions } from "./command-center.js";
import { setSessionProcessTitle } from "./process-title.js";
import { registerCliShutdownHandlers } from "./shutdown.js";
import { listCustomCommandsForTui, loadInitialTuiSessionMetadata } from "./tui-command-data.js";
import { createTuiSubmitPrompt } from "./tui-prompt-handler.js";
import { loadTuiRuntime } from "./tui-runtime-loader.js";
import { resolveTuiStartupLocale } from "./tui-startup-locale.js";
import { createWorkspacePathSuggestionProvider } from "./tui-workspace-paths.js";
import { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";
import { createCliModeState, currentCliMode } from "./tui-command-state.js";
import type { CliPermissionMode, CliResumeRequest, RunDependencies } from "./cli-types.js";

export const runTuiCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  mode?: CliPermissionMode,
  resumeRequest?: CliResumeRequest,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
): Promise<number> => {
  try {
    const modeState = createCliModeState(mode);
    const runTui = deps.runTui ?? (await loadTuiRuntime()).runTui;
    const workspaceDirectory = (deps.cwd ?? process.cwd)();
    const env = deps.env ?? process.env;
    const developerMode = resolveZCodeRuntimeEnv(env) === "development";
    const startupLocale = resolveTuiStartupLocale({
      deps,
      options,
      workingDirectory: workspaceDirectory,
    });
    const promptHandler = createTuiSubmitPrompt(
      deps,
      modeState,
      version,
      resumeRequest,
      options.locale,
      options.detectedLocale,
      startupLocale,
      toolDisallowlist,
      forceMcs,
      options.browserUse,
      options.browserExecutable,
    );
    const unregisterShutdownHandlers = registerCliShutdownHandlers({
      cleanup: async () => {
        await promptHandler.close?.();
      },
      // Ctrl+C 归 TUI 所有（一次复制、两次确认退出）。若这里也注册 SIGINT，
      // 第一次信号就会 process.exit，绕过 TUI 的双击确认并直接结束会话。
      // 退出清理改由 runTui 正常返回后的 finally 分支负责。
      excludeSignals: ["SIGINT"],
      cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs,
      exitProcess: deps.exitProcess,
      process: deps.shutdownProcess,
    });
    // 会话标题实时同步到 process.title，让宿主终端 tab 显示当前会话名。
    const unregisterSessionTitleSync = promptHandler.subscribeSessionEvents?.((event) => {
      if (event.type !== SessionEventType.SessionTitleUpdated) return;
      const payload = event.payload as { title?: unknown };
      setSessionProcessTitle(typeof payload?.title === "string" ? payload.title : undefined);
    });
    try {
      return await runTui({
        loadStartupOptions: async () => {
          const [metadata, customCommands, workspaceGitBranch] = await Promise.all([
            loadInitialTuiSessionMetadata(promptHandler),
            listCustomCommandsForTui(deps).catch(() => undefined),
            (deps.resolveWorkspaceGitBranch ?? resolveWorkspaceGitBranch)({
              workspaceDirectory,
            }).catch(() => undefined),
          ]);
          return {
            // 首屏直接展示配置卡片，不要求用户先发送一句话才能发现没有模型。
            ...(!metadata.modelOptions?.some((model) => !model.disabledReason)
              ? { initialResult: { response: providerSetupStartupResponse(env, workspaceDirectory), responseFormat: "plain" as const, loginRequired: false } }
              : {}),
            initialMode: currentCliMode(modeState),
            initialModel: metadata.model,
            initialThoughtLevel: metadata.thoughtLevel,
            initialSessionId: metadata.sessionId,
            loginRequired: metadata.loginRequired,
            locale: metadata.locale ?? startupLocale,
            theme: metadata.theme ?? "auto",
            modelOptions: metadata.modelOptions,
            effortOptions: metadata.effortOptions,
            slashCommands: listSlashCommandSuggestions(customCommands),
            workspaceGitBranch,
          };
        },
        locale: startupLocale,
        developerMode,
        version,
        workspaceDirectory,
        noColor: options.noColor,
        readClipboardImage: deps.readClipboardImage ?? createNodeClipboardImageReader(),
        listModelOptions: promptHandler.listModelOptions,
        listWorkspacePathSuggestions: createWorkspacePathSuggestionProvider({
          workspaceDirectory,
        }),
        listMcpServers: promptHandler.listMcpServers,
        readSubagents: promptHandler.readSubagents,
        readSubagentTranscript: promptHandler.readSubagentTranscript,
        listWorkflowRuns: promptHandler.listWorkflowRuns,
        replayWorkflowRuns: promptHandler.replayWorkflowRuns,
        getMainSessionId: promptHandler.getMainSessionId,
        writeClipboardText:
          deps.writeClipboardText ?? createNodeClipboardTextWriter({ stdout: ctx.stdout }),
        stderr: ctx.stderr,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        recallPreviousInput: promptHandler.recallPreviousInput,
        sendInput: promptHandler.sendInput,
        setMode: promptHandler.setMode,
        submitPrompt: promptHandler,
        subscribeSessionEvents: promptHandler.subscribeSessionEvents,
      });
    } finally {
      unregisterSessionTitleSync?.();
      unregisterShutdownHandlers();
      await promptHandler.close?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};
