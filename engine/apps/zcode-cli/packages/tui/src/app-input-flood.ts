/**
 * 输入框畸形连发闸门：键盘卡键、无线键盘串扰或输入法异常时，同一个字符会在极短时间内
 * 被连续插入几百次，整段垃圾既难看又可能被直接提交。这里只做纯判定，不改编辑器状态。
 *
 * 判定只针对「增量连发」：每一次内容变更都是在原文本里插入同一个字符（光标在中间时也成立），
 * 且相邻两次间隔不超过 IDLE_MS。一次性写入的长重复串（终端括号粘贴）不计数，避免误伤正常粘贴。
 */
export const INPUT_FLOOD_LIMIT = 100;
/** 相邻追加超过这个间隔就认为这一段连发结束，重新计数（人类打字不会在 400ms 内连敲同一字符上百次）。 */
export const INPUT_FLOOD_IDLE_MS = 400;
/** 单次内容变更插入这么多重复字符时按粘贴处理，不计入连发。 */
export const INPUT_FLOOD_PASTE_CHARS = 32;

export interface InputFloodState {
  readonly char: string;
  /** 当前这一段连发累计插入的字符数。 */
  readonly count: number;
  readonly lastAt: number;
}

export interface InputFloodInsertion {
  /** 本次变更插入的文本。 */
  readonly text: string;
  /** 插入位置在变更后文本中的下标。 */
  readonly offset: number;
}

export interface InputFloodVerdict {
  /** 是否丢弃这次插入。 */
  readonly blocked: boolean;
  /** 更新后的连发状态；undefined 表示这一段已经结束。 */
  readonly state: InputFloodState | undefined;
  /** blocked 为真时，编辑器应当回退到的文本（已剥掉整段重复串）。 */
  readonly acceptedText: string;
  /** 仅在整段连发首次越界时给出，用于提示一次而不是每次按键都提示。 */
  readonly notice?: { readonly char: string; readonly count: number };
}

export function assessInputFlood(
  previous: InputFloodState | undefined,
  previousText: string,
  nextText: string,
  now: number,
): InputFloodVerdict {
  // 受控值回显等场景：文本没变，保持当前连发状态。
  if (nextText === previousText) {
    return { acceptedText: nextText, blocked: false, state: previous };
  }

  const insertion = detectInsertion(previousText, nextText);
  const char = insertion ? singleRepeatedChar(insertion.text) : undefined;
  if (!insertion || char === undefined || insertion.text.length > INPUT_FLOOD_PASTE_CHARS) {
    // 删除、替换、混入其它字符，或一次性粘贴的长重复串：不是连发，重新开始计数。
    return { acceptedText: nextText, blocked: false, state: undefined };
  }

  const continued =
    previous !== undefined &&
    previous.char === char &&
    now - previous.lastAt <= INPUT_FLOOD_IDLE_MS;
  const count = (continued ? previous.count : 0) + insertion.text.length;
  const state: InputFloodState = { char, count, lastAt: now };
  if (count <= INPUT_FLOOD_LIMIT) {
    return { acceptedText: nextText, blocked: false, state };
  }

  const wasBlocked = continued && previous !== undefined && previous.count > INPUT_FLOOD_LIMIT;
  return {
    acceptedText: stripRunAroundInsertion(previousText, nextText, insertion, char),
    blocked: true,
    ...(wasBlocked ? {} : { notice: { char, count } }),
    state,
  };
}

/**
 * 纯插入检测：nextText 必须正好等于 previousText 中插入一段文本。
 * 光标在中间时同样成立，插入位置可能出现在任何下标。
 */
export function detectInsertion(
  previousText: string,
  nextText: string,
): InputFloodInsertion | undefined {
  if (nextText.length <= previousText.length) return undefined;

  let prefix = 0;
  while (prefix < previousText.length && previousText[prefix] === nextText[prefix]) prefix += 1;

  // 后缀不能与已匹配的前缀重叠，否则中间那段并不唯一。
  const maxSuffix = previousText.length - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix + suffix !== previousText.length) return undefined;

  return { offset: prefix, text: nextText.slice(prefix, nextText.length - suffix) };
}

/** 插入内容是否为同一个字符的重复；空串或混入其它字符返回 undefined。 */
export function singleRepeatedChar(text: string): string | undefined {
  const chars = [...text];
  const first = chars[0];
  if (first === undefined) return undefined;
  return chars.every((char) => char === first) ? first : undefined;
}

/** 连发可能跨越多次按键，回退时要连同插入点之前已有的同一字符一起剥掉。 */
function stripRunAroundInsertion(
  previousText: string,
  nextText: string,
  insertion: InputFloodInsertion,
  char: string,
): string {
  let start = insertion.offset;
  while (start - char.length >= 0 && previousText.slice(start - char.length, start) === char) {
    start -= char.length;
  }
  return nextText.slice(0, start) + nextText.slice(insertion.offset + insertion.text.length);
}

/** 提示文案：空白与控制字符不适合直接展示，换成可读描述。 */
export function inputFloodNotice(char: string, count: number): string {
  return `输入异常：检测到「${describeChar(char)}」连续重复 ${count} 次，已丢弃整段（可能是按键卡住或输入法异常）。`;
}

function describeChar(char: string): string {
  if (char === " ") return "空格";
  if (char === "\n") return "换行";
  if (char === "\t") return "制表符";
  return /^[\p{Cc}\p{Cf}]$/u.test(char)
    ? `U+${char.codePointAt(0)?.toString(16).toUpperCase()}`
    : char;
}
