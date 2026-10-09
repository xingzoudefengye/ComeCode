import type { KeyEvent } from "@mbears/opentui-core";
import type { UseTuiKeyboardControlsOptions } from "./app-keyboard-options.js";
import { useKeyboard } from "@mbears/opentui-react";
import { useCallback, useRef } from "react";
import { handleApprovalKey } from "./app-approval.js";
import { handleSelectionKey, selectedSlashCommand } from "./app-input.js";
import {
  CTRL_C_EXIT_PROMPT,
  PROMPT_DRAFT_CLEARED_STATUS,
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  createCtrlCExitGuard,
  ESC_DRAFT_CLEARED_STATUS,
  escapeActionFor,
  type CtrlCExitGuard,
  isModeSwitchKey,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
  shouldHandleInputHistoryNavigation,
  workflowExpansionActionFor,
} from "./app-keyboard-helpers.js";
import { handleSuggestionNavigationKey } from "./app-keyboard-suggestions.js";
import { createSidebarShortcutState, type SidebarShortcutState } from "./app-sidebar-shortcut.js";
import { handleSidebarShortcutKey } from "./app-sidebar-keyboard.js";
import { latestRetryableCompactCommand } from "./app-compact-timeline.js";

export {
  CTRL_C_EXIT_CONFIRMATION_WINDOW_MS,
  completeEffortCommand,
  completeModeCommand,
  completeModelCommand,
  completeSlashCommand,
  createCtrlCExitGuard,
  escapeActionFor,
  isModeSwitchKey,
  resetCtrlCExitGuard,
  resolveCtrlCExitIntent,
  shouldHandleInputHistoryNavigation,
} from "./app-keyboard-helpers.js";

export function useTuiKeyboardControls({
  readOnlyView,
  abortControllerRef,
  approvalQueue,
  busy,
  copyCurrentSelection,
  draftValue,
  workflowExpansion,
  filteredEffortOptions,
  filteredModeOptions,
  filteredModelOptions,
  filteredSlashCommands,
  handleFileMentionKey,
  openModelSelection,
  openEffortSelection,
  openModeSelection,
  inputHistoryActive,
  messages,
  effortSelection,
  modelSelection,
  modeSelection,
  onExit,
  pasteClipboardImage,
  recallNextInput,
  recallPreviousInput,
  selection,
  setApprovalQueue,
  setDraftAttachments,
  setDraftValue,
  setEffortSelection,
  setModelSelection,
  setModeSelection,
  setSelection,
  setSlashSelection,
  setStatus,
  slashSelection,
  submitValue,
  switchMode,
  toggleSidebar,
  toggleSidebarSection,
}: UseTuiKeyboardControlsOptions): void {
  const ctrlCExitGuardRef = useRef<CtrlCExitGuard>(createCtrlCExitGuard());
  const sidebarShortcutRef = useRef<SidebarShortcutState>(createSidebarShortcutState());

  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        if (key.eventType === "release") return;

        if (readOnlyView) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          if (
            handleSidebarShortcutKey({
              consumeKey,
              key,
              nowMs: Date.now(),
              setStatus,
              shortcutState: sidebarShortcutRef.current,
              toggleSidebar,
              toggleSidebarSection,
            })
          )
            return;
          if (key.name === "escape") {
            consumeKey(key);
            readOnlyView.back();
          } else if ((key.name === "c" || key.name === "y") && key.ctrl) {
            consumeKey(key);
            copyCurrentSelection();
          } else if (
            !["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(key.name)
          ) {
            consumeKey(key);
          }
          return;
        }

        const approval = approvalQueue[0];
        if (approval) {
          // 审批界面允许 Ctrl+C 复制，但不触发退出逻辑
          if (key.name === "c" && key.ctrl) {
            consumeKey(key);
            if (copyCurrentSelection()) {
              resetCtrlCExitGuard(ctrlCExitGuardRef.current);
            }
            // 无论复制成功与否，都不继续走到退出逻辑
            return;
          }
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleApprovalKey(key, approval, setApprovalQueue, setStatus);
          return;
        }

        if (selection) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          consumeKey(key);
          handleSelectionKey(key, selection, setSelection, setStatus, submitValue, () => {
            abortControllerRef.current?.abort();
          });
          return;
        }

        if (
          handleSidebarShortcutKey({
            consumeKey,
            key,
            nowMs: Date.now(),
            setStatus,
            shortcutState: sidebarShortcutRef.current,
            toggleSidebar,
            toggleSidebarSection,
          })
        ) {
          resetCtrlCExitGuard(ctrlCExitGuardRef.current);
          return;
        }

        if (key.name === "c" && key.ctrl) {
          consumeKey(key);
          // 有可复制内容时 Ctrl+C 只复制；没有选区才进入「再按一次退出」的确认流程。
          // 复制后必须重置 guard，否则「复制两次」会被误判成两次 Ctrl+C 而退出会话。
          if (copyCurrentSelection()) {
            resetCtrlCExitGuard(ctrlCExitGuardRef.current);
            return;
          }
          if (resolveCtrlCExitIntent(ctrlCExitGuardRef.current, Date.now()) === "confirm_exit") {
            onExit(130);
            return;
          }
          setStatus(CTRL_C_EXIT_PROMPT);
          return;
        }

        resetCtrlCExitGuard(ctrlCExitGuardRef.current);

        if (key.name === "y" && key.ctrl) {
          consumeKey(key);
          if (!copyCurrentSelection()) setStatus("No selected text to copy.");
          return;
        }

        if (key.name === "return" && !key.shift) {
          const command =
            filteredSlashCommands.find((item) => draftValue === `/${item.name}`) ??
            selectedSlashCommand(draftValue, slashSelection, filteredSlashCommands);
          const openCommandSelection =
            command?.name === "model"
              ? openModelSelection
              : command?.name === "mode"
                ? openModeSelection
                : command?.name === "effort" || command?.name === "variant"
                  ? openEffortSelection
                  : undefined;
          if (
            !modelSelection &&
            !effortSelection &&
            !modeSelection &&
            openCommandSelection &&
            command
          ) {
            // 补全项尚未写入草稿，先规范命令再打开面板，避免缩写被直接提交为文字列表。
            const value = `/${command.name}`;
            setDraftValue(value);
            openCommandSelection(value);
            consumeKey(key);
            return;
          }
          if (openModelSelection() || openEffortSelection() || openModeSelection()) {
            consumeKey(key);
            return;
          }
        }

        if (key.name === "r" && key.ctrl) {
          const compactRetryCommand = latestRetryableCompactCommand(messages);
          if (compactRetryCommand) {
            consumeKey(key);
            if (busy) {
              setStatus("Agent is still responding.");
              return;
            }
            void submitValue(compactRetryCommand, { preserveSelection: true });
            return;
          }
        }

        // Mode switching belongs to the composer, including while @ suggestions
        // are open; file completion must only receive the remaining Tab keys.
        if (isModeSwitchKey(key)) {
          consumeKey(key);
          void switchMode();
          return;
        }

        if (handleFileMentionKey(key)) {
          consumeKey(key);
          return;
        }

        if (key.name === "tab") {
          consumeKey(key);
          if (completeModelCommand(filteredModelOptions, modelSelection, setDraftValue)) {
            setModelSelection(undefined);
            return;
          }
          if (completeEffortCommand(filteredEffortOptions, effortSelection, setDraftValue)) {
            setEffortSelection(undefined);
            return;
          }
          if (completeModeCommand(filteredModeOptions, modeSelection, setDraftValue)) {
            setModeSelection(undefined);
            return;
          }
          if (completeSlashCommand(filteredSlashCommands, slashSelection, setDraftValue)) {
            setSlashSelection(undefined);
          }
          return;
        }

        if (key.name === "escape") {
          consumeKey(key);
          if (modelSelection) {
            setModelSelection(undefined);
            setStatus("Model suggestions dismissed.");
            return;
          }
          if (effortSelection) {
            setEffortSelection(undefined);
            setStatus("Effort suggestions dismissed.");
            return;
          }
          if (modeSelection) {
            setModeSelection(undefined);
            setStatus("Mode suggestions dismissed.");
            return;
          }
          if (slashSelection) {
            setSlashSelection(undefined);
            setStatus("Slash suggestions dismissed.");
            return;
          }
          if (busy) {
            // Bug 根因：之前 Esc 在有草稿时会立即发送引导消息，导致用户想中断却误触发送，任务反而继续跑。
            // 修复：先清空草稿，第二次 Esc 才中断。避免误操作，同时保留 Ctrl+U 的显式清空。
            if (escapeActionFor({ busy, draftValue }) === "clear") {
              setDraftValue("");
              setStatus(ESC_DRAFT_CLEARED_STATUS);
              return;
            }
            abortControllerRef.current?.abort();
            setStatus("Pausing current output...");
            return;
          }
          setStatus("No active output to pause. Press Ctrl-C twice to exit.");
          return;
        }

        if (
          handleSuggestionNavigationKey({
            consumeKey,
            effortSelection,
            filteredEffortOptions,
            filteredModeOptions,
            filteredModelOptions,
            filteredSlashCommands,
            key,
            modelSelection,
            modeSelection,
            setEffortSelection,
            setModeSelection,
            setModelSelection,
            setSlashSelection,
            slashSelection,
          })
        ) {
          return;
        }

        if (
          key.name === "up" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          consumeKey(key);
          void recallPreviousInput();
          return;
        }

        if (
          key.name === "down" &&
          shouldHandleInputHistoryNavigation({ draftValue, inputHistoryActive })
        ) {
          consumeKey(key);
          void recallNextInput();
          return;
        }

        // `+` / `-` 展开/收起全部 workflow 卡（spec 无卡片选择机制，只能作用于全体）。
        // 键位与两层闸门（草稿为空 + 至少一张卡）全部收在纯函数里，直接可测。
        const workflowExpansionKey = workflowExpansionActionFor({
          key,
          draftValue,
          hasCards: workflowExpansion?.hasCards ?? false,
        });
        if (workflowExpansionKey && workflowExpansion) {
          consumeKey(key);
          if (workflowExpansionKey === "expand") workflowExpansion.expandAll();
          else workflowExpansion.collapseAll();
          return;
        }

        if (key.name === "u" && key.ctrl) {
          consumeKey(key);
          setDraftValue("");
          setDraftAttachments([]);
          setStatus(PROMPT_DRAFT_CLEARED_STATUS);
          return;
        }

        if ((key.name === "v" && (key.ctrl || key.meta)) || key.raw === "\x16") {
          consumeKey(key);
          void pasteClipboardImage();
        }
      },
      [
        readOnlyView,
        abortControllerRef,
        approvalQueue,
        workflowExpansion,
        busy,
        copyCurrentSelection,
        draftValue,
        effortSelection,
        filteredEffortOptions,
        filteredModeOptions,
        filteredModelOptions,
        filteredSlashCommands,
        handleFileMentionKey,
        openModelSelection,
        openEffortSelection,
        openModeSelection,
        inputHistoryActive,
        messages,
        modelSelection,
        modeSelection,
        onExit,
        pasteClipboardImage,
        recallNextInput,
        recallPreviousInput,
        selection,
        setApprovalQueue,
        setDraftAttachments,
        setDraftValue,
        setEffortSelection,
        setModelSelection,
        setModeSelection,
        setSelection,
        setSlashSelection,
        setStatus,
        slashSelection,
        submitValue,
        switchMode,
        toggleSidebar,
        toggleSidebarSection,
      ],
    ),
  );
}

function consumeKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}
