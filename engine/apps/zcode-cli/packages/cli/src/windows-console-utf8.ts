// Modified by ComeCode：新增文件。
// OpenTUI 原生渲染器在 Windows 上用 WriteFile 直接写 UTF-8 字节，控制台按活动代码页解码。
// 中文系统默认代码页是 936（GBK），会把框线字符解成乱码，并吞掉紧随其后的 ESC，
// 出现 "鈺鋁" 和 "?[0m"。TUI 启动前把控制台输入/输出代码页切到 65001，退出时恢复原值。
import type * as Koffi from "koffi";

const CP_UTF8 = 65001;

interface ConsoleCodePageApi {
  getOutputCP(): number;
  getInputCP(): number;
  setOutputCP(codePage: number): boolean;
  setInputCP(codePage: number): boolean;
}

/** 返回恢复函数；非 Windows、已是 UTF-8 或 koffi 不可用时返回 undefined（不影响启动）。 */
export async function ensureWindowsConsoleUtf8(
  platform: NodeJS.Platform = process.platform,
): Promise<(() => void) | undefined> {
  if (platform !== "win32") return undefined;
  const api = await loadConsoleCodePageApi();
  if (!api) return undefined;

  try {
    const originalOutput = api.getOutputCP();
    const originalInput = api.getInputCP();
    if (originalOutput === CP_UTF8 && originalInput === CP_UTF8) return undefined;
    api.setOutputCP(CP_UTF8);
    api.setInputCP(CP_UTF8);

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try {
        // 恢复到启动前的代码页，避免退出后父终端（cmd/PowerShell）的编码被改掉。
        if (originalOutput > 0) api.setOutputCP(originalOutput);
        if (originalInput > 0) api.setInputCP(originalInput);
      } catch {
        // 退出阶段恢复失败不能再抛错。
      }
    };
    // 正常退出、watchdog 强退都会触发 exit 事件；koffi 调用是同步的，可以在这里执行。
    process.once("exit", restore);
    return restore;
  } catch {
    return undefined;
  }
}

async function loadConsoleCodePageApi(): Promise<ConsoleCodePageApi | undefined> {
  try {
    const koffiModule = await import("koffi");
    const koffi = ("default" in koffiModule ? koffiModule.default : koffiModule) as typeof Koffi;
    const kernel32 = koffi.load("kernel32.dll");
    const getOutputCP = kernel32.func("__stdcall", "GetConsoleOutputCP", "uint32", []);
    const getInputCP = kernel32.func("__stdcall", "GetConsoleCP", "uint32", []);
    const setOutputCP = kernel32.func("__stdcall", "SetConsoleOutputCP", "bool", ["uint32"]);
    const setInputCP = kernel32.func("__stdcall", "SetConsoleCP", "bool", ["uint32"]);
    return {
      getOutputCP: () => Number(getOutputCP()),
      getInputCP: () => Number(getInputCP()),
      setOutputCP: (codePage) => Boolean(setOutputCP(codePage)),
      setInputCP: (codePage) => Boolean(setInputCP(codePage)),
    };
  } catch {
    return undefined;
  }
}
