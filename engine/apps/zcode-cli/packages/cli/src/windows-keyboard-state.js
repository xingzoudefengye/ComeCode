const VK_SHIFT = 0x10;
const SHIFT_PRESSED_MASK = 0x8000;
export async function loadWindowsShiftState(options = {}) {
    if ((options.platform ?? process.platform) !== "win32")
        return undefined;
    const api = options.api ?? (await createWindowsKeyboardApi());
    if (!api)
        return undefined;
    return () => {
        try {
            return (api.getAsyncKeyState(VK_SHIFT) & SHIFT_PRESSED_MASK) !== 0;
        }
        catch {
            return false;
        }
    };
}
let nativeApiPromise;
async function createWindowsKeyboardApi() {
    nativeApiPromise ??= importWindowsKeyboardApi();
    return nativeApiPromise;
}
async function importWindowsKeyboardApi() {
    try {
        const koffiModule = await import("koffi");
        const koffi = ("default" in koffiModule ? koffiModule.default : koffiModule);
        const user32 = koffi.load("user32.dll");
        const getAsyncKeyState = user32.func("__stdcall", "GetAsyncKeyState", "int16", ["int32"]);
        return {
            getAsyncKeyState: (virtualKey) => Number(getAsyncKeyState(virtualKey)),
        };
    }
    catch {
        return undefined;
    }
}
