// 会话标题同步到 process.title，让宿主终端 tab（如 Windows Terminal）直接显示当前会话名，
// 而不是进程默认的 node。只覆盖「有合法标题」时；空标题/纯空白不动 process.title，保留默认。
const SESSION_TITLE_MAX_CHARS = 30;

export function setSessionProcessTitle(title: string | undefined): void {
  const normalized = normalizeSessionProcessTitle(title);
  if (normalized === undefined) return;
  process.title = normalized;
}

export function normalizeSessionProcessTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const trimmed = title.trim();
  if (!trimmed) return undefined;
  // 按码点截断，避免在代理对中间切开产生乱码字符。
  return trimmed.length <= SESSION_TITLE_MAX_CHARS
    ? trimmed
    : Array.from(trimmed).slice(0, SESSION_TITLE_MAX_CHARS).join("");
}
