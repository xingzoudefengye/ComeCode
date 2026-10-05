// Modified by ComeCode：迁移只能由用户确认，协议与非交互模式不读取 stdin。
import { cp, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
export async function offerLegacyDataImport(options) {
    const env = options.env;
    if ([
        env.COMECODE_DATA_BASE_DIR,
        env.ZCODE_DATA_BASE_DIR,
        env.COMECODE_STORAGE_DIR,
        env.ZCODE_STORAGE_DIR,
    ].some((value) => value?.trim())) {
        return;
    }
    const home = options.home ?? homedir();
    const legacyRoot = join(home, ".zcode");
    const targetRoot = join(home, ".comecode");
    if (!(await directoryExists(legacyRoot)) || (await directoryExists(targetRoot)))
        return;
    options.stderr.write(`发现旧数据目录 ${legacyRoot}。可导入到 ${targetRoot}，旧数据将保留。\n`);
    if (!options.interactive)
        return;
    const confirm = options.confirm ??
        (async () => {
            const readline = createInterface({ input: process.stdin, output: process.stderr });
            try {
                const answer = await readline.question("是否导入？[y/N] ");
                return /^(y|yes)$/iu.test(answer.trim());
            }
            finally {
                readline.close();
            }
        });
    if (!(await confirm()))
        return;
    await cp(legacyRoot, targetRoot, { recursive: true, force: false, errorOnExist: true });
    options.stderr.write("已导入旧数据。\n");
}
async function directoryExists(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
