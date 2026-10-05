import { formatResumeResult } from "./command-center/formatters.js";
import { listAppEffortOptions } from "./command-center/effort-options.js";
export async function readTuiSessionMetadata(app) {
    const modelOptions = (await app.listModels?.()) ?? [];
    return {
        locale: app.getLocale?.(),
        model: app.getModel?.(),
        theme: app.getTheme?.(),
        thoughtLevel: app.getThoughtLevel?.(),
        modelOptions,
        effortOptions: (await listAppEffortOptions(app)) ?? [],
        loginRequired: false,
        sessionId: app.sessionId,
    };
}
export const attachTuiAppQueries = (submitPrompt, getApp) => {
    // 启动恢复不能只读取元数据，否则目标会话已打开但首屏仍像新会话。
    submitPrompt.resumeSession = async () => {
        const app = await getApp();
        const result = await app.resume();
        const restoredMessages = await app.loadSessionTranscript?.();
        return {
            ...(await readTuiSessionMetadata(app)),
            response: formatResumeResult(app.sessionId, result, app.getModel?.()),
            ...(restoredMessages !== undefined ? { resetSessionProjection: true, restoredMessages } : {}),
            traceId: result.traceId ?? app.traceId,
        };
    };
    submitPrompt.readSubagents = async (input) => {
        const app = await getApp();
        return (app.readSubagents?.(input) ?? {
            revision: 0,
            childSessionIds: [],
            running: [],
            ended: { total: 0, items: [] },
        });
    };
    submitPrompt.readSubagentTranscript = async (childSessionId) => {
        const app = await getApp();
        if (!app.readSubagentTranscript)
            throw new Error("Subagent transcript is unavailable.");
        return app.readSubagentTranscript(childSessionId);
    };
    submitPrompt.recallPreviousInput = async (skip) => {
        const activeApp = await getApp();
        return (await activeApp.recallPreviousInputHistory?.(skip)) ?? null;
    };
    submitPrompt.getSessionMetadata = async () => {
        const activeApp = await getApp();
        return readTuiSessionMetadata(activeApp);
    };
    submitPrompt.listModelOptions = async () => {
        const activeApp = await getApp();
        return activeApp.listModels?.() ?? [];
    };
    submitPrompt.listEffortOptions = async () => {
        const activeApp = await getApp();
        return (await listAppEffortOptions(activeApp)) ?? [];
    };
    submitPrompt.listMcpServers = async () => {
        const activeApp = await getApp();
        return activeApp.listMcpServers?.() ?? {};
    };
    submitPrompt.listWorkflowRuns = async () => {
        const activeApp = await getApp();
        // 会话级摘要；服务端已按「最近更新在前」给序，读侧不重排（端口注释的裁定）。
        return (await activeApp.listDynamicWorkflowRuns?.({})) ?? [];
    };
    submitPrompt.replayWorkflowRuns = async (input) => {
        const activeApp = await getApp();
        // 与 v4 冷物化同一条链：journal → 与 live
        // 同一种进度载荷 → 镜像的共享 reducer。
        return (await activeApp.replayDynamicWorkflowRuns?.(input)) ?? [];
    };
};
