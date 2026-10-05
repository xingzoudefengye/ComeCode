export function formatResumeResult(sessionId, result, model) {
    return [
        ...(result.warnings ?? []),
        `Resumed session ${sessionId}.`,
        `Directory: ${result.directory}`,
        ...(model?.trim() ? [`Model: ${model.trim()}`] : []),
        `Messages: ${result.appliedMessageCount}/${result.messageCount}; parts: ${result.partCount}; interrupted tools: ${result.interruptedToolCount}`,
    ].join("\n");
}
export function formatNewSessionResult(sessionId) {
    return `Started new session ${sessionId}.`;
}
