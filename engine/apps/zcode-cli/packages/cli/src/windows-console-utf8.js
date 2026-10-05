const CP_UTF8 = 65001;
/** 返回恢复函数；非 Windows、已是 UTF-8 或 koffi 不可用时返回 undefined（不影响启动）。 */
export async function ensureWindowsConsoleUtf8(platform = process.platform) {
    if (platform !== "win32")
        return undefined;
    const api = await loadConsoleCodePageApi();
    if (!api)
        return undefined;
    try {
        const originalOutput = api.getOutputCP();
        const originalInput = api.getInputCP();
        if (originalOutput === CP_UTF8 && originalInput === CP_UTF8)
            return undefined;
        api.setOutputCP(CP_UTF8);
        api.setInputCP(CP_UTF8);
        let restored = false;
        const restore = () => {
            if (restored)
                return;
            restored = true;
            try {
                // 恢复到启动前的代码页，避免退出后父终端（cmd/PowerShell）的编码被改掉。
                if (originalOutput > 0)
                    api.setOutputCP(originalOutput);
                if (originalInput > 0)
                    api.setInputCP(originalInput);
            }
            catch {
                // 退出阶段恢复失败不能再抛错。
            }
        };
        // 正常退出、watchdog 强退都会触发 exit 事件；koffi 调用是同步的，可以在这里执行。
        process.once("exit", restore);
        return restore;
    }
    catch {
        return undefined;
    }
}
async function loadConsoleCodePageApi() {
    try {
        const koffiModule = await import("koffi");
        const koffi = ("default" in koffiModule ? koffiModule.default : koffiModule);
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
    }
    catch {
        return undefined;
    }
}
