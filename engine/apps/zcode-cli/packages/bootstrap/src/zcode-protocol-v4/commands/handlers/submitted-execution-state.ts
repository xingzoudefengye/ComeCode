import type { ModelSelection } from "@zcode/shared";
import { resolveExecutionState } from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { parseProviderQualifiedModelSelection } from "../../../app/provider-registry-selection.js";
import type { V4SessionRecordView } from "../types.js";
export function resolveSubmittedExecutionState(
  record: V4SessionRecordView,
  payload: {
    modelSelection?: ModelSelection;
    mode?: SubmissionMode;
    planEnabled?: boolean;
  },
): { modelSelection: ModelSelection; mode: SubmissionMode; planEnabled: boolean } {
  let modelSelection = payload.modelSelection;
  if (!modelSelection) {
    const runtimeSelection = record.app.runtime?.getSessionModelSelection?.();
    const entrySelection = runtimeSelection
      ? undefined
      : parseProviderQualifiedModelSelection(record.app.getModel());
    if (!runtimeSelection && !entrySelection) {
      throw new Error(`Session model must be provider-qualified: ${record.app.getModel()}`);
    }
    // getThoughtLevel() 是 Active Model 的 effective 展示事实。把它补回
    // canonical intent 会把 Config 默认值伪装成显式 pin；旧发送端只能固定 Session
    // 已经持有的稀疏 Selection，不能在 admission 时重新解释它。
    modelSelection = runtimeSelection
      ? {
          providerId: runtimeSelection.providerId,
          modelId: runtimeSelection.modelId,
          ...(runtimeSelection.options ? { options: { ...runtimeSelection.options } } : {}),
        }
      : {
          providerId: entrySelection!.providerId,
          modelId: entrySelection!.modelId,
          ...(entrySelection!.options ? { options: { ...entrySelection!.options } } : {}),
        };
  }
  const current = resolveExecutionState({
    mode: record.app.getMode?.(),
    planEnabled: record.app.runtime?.getPlanEnabled?.(),
  });
  const state = resolveExecutionState(payload, current);
  return {
    modelSelection,
    // auto 是正式的权限模式；保留原值，避免桌面提交在 admission 边界被误降级为
    // build，导致普通工具调用重新进入命令确认流程。
    mode: state.mode,
    planEnabled: state.planEnabled,
  };
}
