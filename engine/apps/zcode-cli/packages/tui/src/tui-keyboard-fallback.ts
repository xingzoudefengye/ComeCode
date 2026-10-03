import { parseKeypress, type CliRenderer } from "@mbears/opentui-core";

const SHIFTED_ENTER_SEQUENCE = "\x1b[13;2u";

export function createShiftEnterFallbackHandler(
  renderer: Pick<CliRenderer, "_internalKeyInput">,
  isShiftPressed?: () => boolean,
): (sequence: string) => boolean {
  return (sequence) => {
    // VS Code 内置终端 / conpty 把 Shift+Enter 发成带 ESC 前缀的回车（\x1b\r / \x1b\n）。
    // 去掉前导 ESC 后，整串必须是纯回车/换行（兼容 \r、\n、\r\n），方向键等
    // 其它 ESC 序列因不以回车结尾而被排除。无前缀的纯回车仅在 Shift 按下时才改写。
    const hasEscPrefix = sequence.startsWith("\x1b");
    const stripped = hasEscPrefix ? sequence.slice(1) : sequence;
    if (!/^(?:\r|\n)+$/.test(stripped)) return false;
    if (!hasEscPrefix && !isShiftPressed?.()) return false;
    const shiftedEnter = parseKeypress(SHIFTED_ENTER_SEQUENCE, { useKittyKeyboard: true });
    if (!shiftedEnter) return false;
    renderer._internalKeyInput.processParsedKey(shiftedEnter);
    return true;
  };
}
