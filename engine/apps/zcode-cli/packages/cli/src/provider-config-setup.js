import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { parseUnifiedConfigJson, parseUnifiedConfigToml, resolveUnifiedConfigPaths } from "@zcode/adapters/config";
import { providerSetupResponse } from "./provider-setup.js";
/** 中文向导仅持有本次输入；保存后统一配置解析器仍是配置唯一所有者。 */
export async function runProviderConfigSetup(ctx, env, cwd, askOverride, startup = false) {
    if (!ctx.stdin.isTTY || !ctx.stderr.isTTY) {
        ctx.stderr.write(`配置向导需要交互终端，请直接在终端运行 comecode config setup。\n${providerSetupResponse("zh-CN", env, cwd)}\n`);
        return 1;
    }
    const paths = resolveUnifiedConfigPaths({ env, cwd });
    let existing;
    try {
        existing = await readFile(paths.user, "utf8");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const targetPath = startup || existing === undefined ? join(dirname(paths.user), "config.json") : paths.user;
    if (existing !== undefined) {
        const parsed = paths.user.endsWith(".toml") ? parseUnifiedConfigToml(existing, paths.user) : parseUnifiedConfigJson(existing, paths.user);
        // 简单向导不整体替换多模型/高级配置，避免保存时丢失用户字段。
        if (parsed.diagnostics.errors.length || Object.keys(parsed.document.providers).length) {
            ctx.stderr.write(`已有模型配置，未修改。请编辑 ${paths.user} 添加或调整模型，然后运行 comecode config check。\n`);
            return 1;
        }
    }
    let close = () => { };
    const ask = askOverride ?? (() => {
        let hidden = false;
        const controller = new AbortController();
        // 密钥输入由 readline 编辑，但输出被抑制，避免进入终端、滚屏和日志。
        const output = new Writable({
            write(chunk, _encoding, done) {
                if (!hidden)
                    ctx.stderr.write(chunk);
                done();
            },
        });
        Object.assign(output, { isTTY: true, columns: ctx.stderr.columns });
        const reader = createInterface({ input: ctx.stdin, output, terminal: true, historySize: 0 });
        reader.on("SIGINT", () => controller.abort());
        reader.on("close", () => controller.abort());
        close = () => { reader.close(); output.end(); };
        return async (prompt, secret = false) => {
            hidden = secret;
            // 普通问题交由 readline 重绘；手动打印后 question("") 会清屏擦掉提示。
            // 密钥问题只手动打印，readline 的重绘与输入回显都由 hidden 抑制。
            if (secret)
                ctx.stderr.write(prompt);
            try {
                const answer = await reader.question(secret ? "" : prompt, { signal: controller.signal });
                if (secret)
                    ctx.stderr.write("\n");
                return answer.trim();
            }
            finally {
                hidden = false;
            }
        };
    })();
    try {
        ctx.stderr.write("ComeCode 模型配置向导\n需要填写：接口地址、模型名称、API Key。Ctrl+C 可取消。\n");
        if (!startup && paths.project)
            ctx.stderr.write(`注意：项目配置 ${paths.project} 会优先覆盖用户设置；保存后请检查它。\n`);
        if (!startup)
            ctx.stderr.write(`保存位置：${targetPath}\n`);
        const typeChoice = await ask("1. 服务类型：1=OpenAI Chat Completions 兼容接口（默认），2=OpenAI Responses，3=Anthropic/Claude：");
        const type = { "": "openai-chat", "1": "openai-chat", "2": "openai-responses", "3": "anthropic" }[typeChoice];
        if (!type)
            throw new Error("服务类型无效，请选择 1、2 或 3，再运行向导。");
        const defaultUrl = type === "anthropic" ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1";
        let baseUrl;
        while (true) {
            baseUrl = (await ask(`2. 接口地址（回车使用 ${defaultUrl}；第三方网关请填写自己的地址）：`)) || defaultUrl;
            try {
                const parsed = new URL(baseUrl);
                if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
                    throw new Error();
                break;
            }
            catch {
                ctx.stderr.write("地址不正确，请填写以 https:// 或 http:// 开头的 API 地址，不要包含密钥。\n");
            }
        }
        let model = "";
        while (!model)
            model = await ask("3. 模型名称（从服务商模型列表复制，以该平台提供的实际名称为准）：");
        let apiKey = "";
        while (!apiKey)
            apiKey = await ask("4. API Key（输入不显示，粘贴后按回车）：", true);
        const tomlContent = [
            "# ComeCode 模型配置，由配置向导生成。此文件含密钥，请勿分享或提交到 Git。",
            `model = ${JSON.stringify(model)} # 服务商模型列表中的名称`,
            'provider = "my-api"',
            "", "[providers.my-api]",
            `type = ${JSON.stringify(type)} # 请求协议`,
            `base_url = ${JSON.stringify(baseUrl)} # API 接口地址`,
            `api_key = ${JSON.stringify(apiKey)} # 私密凭据`, "",
        ].join("\n");
        const content = targetPath.endsWith(".toml") ? tomlContent : `${targetPath.endsWith(".jsonc") ? "// ComeCode 模型配置：含密钥时请勿分享或提交到 Git。\n" : ""}${JSON.stringify({ model, provider: "my-api", providers: [{ id: "my-api", type, baseUrl, apiKey, models: [{ id: model }] }] }, null, 2)}\n`;
        if (!startup)
            ctx.stderr.write(`将保存模型 ${JSON.stringify(model)}，密钥不会显示。\n`);
        const confirmation = startup ? "y" : await ask(existing === undefined
            ? "保存配置？[y/N] "
            : "配置文件已存在。备份原文件后替换？[y/N] ");
        if (confirmation.toLowerCase() !== "y") {
            ctx.stderr.write("已取消，未修改配置。\n");
            return 0;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        if (existing !== undefined && targetPath === paths.user) {
            const backup = `${targetPath}.${randomUUID()}.bak`;
            await copyFile(targetPath, backup, constants.COPYFILE_EXCL);
            if (!startup)
                ctx.stderr.write(`原配置已备份：${backup}\n`);
        }
        await writeFile(targetPath, content, { encoding: "utf8", mode: 0o600, flag: existing === undefined || targetPath !== paths.user ? "wx" : "w" });
        if (startup)
            ctx.stderr.write("模型已配置，正在启动 ComeCode。\n");
        else
            ctx.stderr.write(`配置已保存：${targetPath}\n下一步：运行 comecode config check，检查通过后运行 comecode。\n${paths.project ? "注意：项目配置仍优先，检查不通过时也要检查项目文件。\n" : ""}`);
        return 0;
    }
    catch (error) {
        const message = error.name === "AbortError" ? "已取消配置向导。" : `配置未保存：${error.code ?? error.message}`;
        ctx.stderr.write(`${message}\n`);
        return 1;
    }
    finally {
        close();
    }
}
