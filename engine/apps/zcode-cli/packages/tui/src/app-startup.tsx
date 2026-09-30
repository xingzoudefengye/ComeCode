import { useKeyboard } from "@mbears/opentui-react";
import { getZCodeCopy } from "@zcode/i18n";
import React from "react";
import { EmptyTranscriptLogo } from "./app-empty-transcript.js";
import {
  CTRL_C_EXIT_PROMPT,
  createCtrlCExitGuard,
  resolveCtrlCExitIntent,
} from "./app-keyboard-helpers.js";
import { palette } from "./app-model.js";
import type { TuiOptions } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export function TuiStartupScreen({
  options,
  onExit,
}: {
  options: TuiOptions;
  onExit: (code: number) => void;
}): React.ReactElement {
  const exitGuardRef = React.useRef(createCtrlCExitGuard());
  const [exitPrompted, setExitPrompted] = React.useState(false);
  useKeyboard((key) => {
    if (!key.ctrl || key.name !== "c") return;
    // 启动画面同样遵循「一次提示、两次退出」：这里以前按一次就 onExit(130)，
    // 用户在启动期间想复制内容会被直接结束会话。
    if (resolveCtrlCExitIntent(exitGuardRef.current, Date.now()) === "confirm_exit") {
      onExit(130);
      return;
    }
    setExitPrompted(true);
  });
  return h(
    "box",
    { style: { flexDirection: "column", width: "100%", height: "100%", padding: 1 } },
    h(EmptyTranscriptLogo),
    h("text", { style: { fg: palette.muted } }, options.workspaceDirectory),
    h(
      "text",
      { style: { fg: palette.text } },
      exitPrompted ? CTRL_C_EXIT_PROMPT : getZCodeCopy(options.locale).tui.terminal.starting,
    ),
  );
}
