import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { getCliStorageRoot } from "@zcode/bootstrap";
import {
  PROJECT_MEMORY_FILES,
  PROJECT_MEMORY_STORAGE_MAX_CHARS,
  PROJECT_MEMORY_STORAGE_MAX_BYTES,
  PROJECT_MEMORY_TARGET_CHARS,
  PROJECT_MEMORY_TEMPLATE,
  USER_MEMORY_TEMPLATE,
  USER_MEMORY_MAX_TOTAL_CHARS,
  USER_CHRONICLE_MAX_CHARS,
  formatUserMemoryChronicle,
  loadUserMemoryChronicle,
  resolveUserMemoryRoot,
  resolveWorkspaceProjectMemoryRoot,
} from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";
import { runMemoryRetentionCommand } from "./memory-retention-command.js";

type MemoryScope = "user" | "project" | "both";
type MemoryAction = "path" | "init" | "check" | "history" | "compact" | "recover";
const USER_STABLE_FILES = ["profile.md", "preferences.md"] as const;
const MEMORY_USAGE =
  "用法: comecode memory <path|init|check> [--scope user|project|both]\n      comecode memory history [--scope user]\n      comecode memory compact [--apply] | recover [--scope project]\n";

export async function runMemoryCommand(
  ctx: RunContext,
  _options: GlobalOptions,
  deps: RunDependencies,
  args: readonly string[] = [],
): Promise<number> {
  const parsed = parseMemoryArgs(args);
  if (!parsed) {
    ctx.stderr.write(MEMORY_USAGE);
    return 1;
  }
  try {
    const { action, scope } = parsed;
    const cwd = deps.cwd?.() ?? process.cwd();
    const workspace = await resolveWorkspaceRoot(cwd);
    if (action === "compact" || action === "recover")
      return await runMemoryRetentionCommand(
        ctx,
        resolveWorkspaceProjectMemoryRoot(workspace),
        action,
        parsed.apply,
      );
    // 默认 project 命令不解析用户配置，保留原有路径与初始化行为。
    const config =
      scope === "project"
        ? undefined
        : createConfig({
            env: deps.env ?? process.env,
            workingDirectory: cwd,
            projectConfigPath: deps.projectConfigPath,
            skipUserConfig: deps.skipUserConfig,
            userConfigPath: deps.userConfigPath,
          }).config;
    const cliStorageRoot = config ? getCliStorageRoot(resolvePath(config.storage.dir)) : undefined;
    const scopes = scope === "both" ? (["user", "project"] as const) : [scope];
    for (const target of scopes) {
      const root =
        target === "user"
          ? resolveUserMemoryRoot(cliStorageRoot!)
          : resolveWorkspaceProjectMemoryRoot(workspace);
      const label = target === "user" ? "用户" : "项目";
      if (action === "path") {
        ctx.stdout.write(scope === "both" ? `${target}: ${root}\n` : `${root}\n`);
      } else if (action === "init") {
        const files = target === "user" ? USER_STABLE_FILES : PROJECT_MEMORY_FILES;
        await mkdir(root, { recursive: true });
        const created: string[] = [];
        for (const fileName of files) {
          const template =
            target === "user"
              ? USER_MEMORY_TEMPLATE[fileName as (typeof USER_STABLE_FILES)[number]]
              : PROJECT_MEMORY_TEMPLATE[fileName as (typeof PROJECT_MEMORY_FILES)[number]];
          try {
            await writeFile(join(root, fileName), template, { encoding: "utf8", flag: "wx" });
            created.push(fileName);
          } catch (error) {
            if (!hasCode(error, "EEXIST")) throw error;
          }
        }
        if (target === "project") await addLocalArchiveIgnore(workspace);
        ctx.stdout.write(`${label}记忆目录：${root}\n`);
        ctx.stdout.write(
          created.length > 0
            ? `已创建：${created.join(", ")}\n`
            : "文件已存在，没有覆盖现有内容。\n",
        );
        if (target === "user")
          ctx.stdout.write("chronicle.json 由运行时管理，无需 init；不会创建或导入 history.md。\n");
      } else if (action === "history") {
        const chronicle = await loadUserMemoryChronicle({ root });
        const history =
          chronicle.entries.length > 0
            ? formatUserMemoryChronicle(chronicle)
            : "暂无用户史书记录。";
        ctx.stdout.write(`scope: user\n用户史书目录：${root}\n${history}\n`);
      } else {
        ctx.stdout.write(`scope: ${target}\n${label}记忆目录：${root}\n`);
        if (config)
          ctx.stdout.write(
            `配置 scope: ${config.memory.scope}; enabled: ${config.features.memory}; use: ${config.memory.use}\n`,
          );
        const files = target === "user" ? USER_STABLE_FILES : PROJECT_MEMORY_FILES;
        let bytes = 0;
        let chars = 0;
        for (const fileName of files) {
          const content = await readOptional(join(root, fileName));
          if (content === undefined) {
            ctx.stdout.write(`${fileName}: 缺失\n`);
          } else {
            const size = Buffer.byteLength(content, "utf8");
            bytes += size;
            chars += content.length;
            ctx.stdout.write(`${fileName}: ${size} bytes (UTF-8), ${content.length} chars\n`);
          }
        }
        if (target === "user") {
          ctx.stdout.write(
            `稳定记忆：${bytes} bytes (UTF-8), ${chars}/${USER_MEMORY_MAX_TOTAL_CHARS} chars\n`,
          );
          const raw = await readOptional(join(root, "chronicle.json"));
          const chronicle = await loadUserMemoryChronicle({ root });
          const history = formatUserMemoryChronicle(chronicle);
          ctx.stdout.write(
            `史书：${raw === undefined ? "缺失（无需初始化）" : `${Buffer.byteLength(raw, "utf8")} bytes (UTF-8), ${raw.length} chars (JSON)`}\n`,
          );
          ctx.stdout.write(
            `史书加载：${history.length}/${USER_CHRONICLE_MAX_CHARS} chars；用户总预算：${USER_MEMORY_MAX_TOTAL_CHARS + USER_CHRONICLE_MAX_CHARS} chars\n`,
          );
          printChronicleSummary(ctx, chronicle);
          try {
            await stat(join(root, "history.md"));
            ctx.stdout.write("history.md: 旧用户文件，不导入 managed chronicle.json。\n");
          } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error;
          }
          const legacyRoot = join(cliStorageRoot!, "memories", "projects");
          let legacyCount = 0;
          try {
            legacyCount = (await readdir(legacyRoot, { withFileTypes: true })).filter((entry) =>
              entry.isDirectory(),
            ).length;
          } catch (error) {
            if (!hasCode(error, "ENOENT")) throw error;
          }
          ctx.stdout.write(
            `兼容旧 project 记录：${legacyCount} 个目录（${legacyRoot}），不自动迁移。\n`,
          );
        } else {
          ctx.stdout.write(
            `存储硬上限：${chars}/${PROJECT_MEMORY_STORAGE_MAX_CHARS} chars，${bytes}/${PROJECT_MEMORY_STORAGE_MAX_BYTES} UTF-8 bytes；整理目标：${PROJECT_MEMORY_TARGET_CHARS} chars\n`,
          );
          ctx.stdout.write(
            "上下文加载：双根合计 4000 估算 token / 12000 chars（与磁盘存储分开）。\n",
          );
          if (chars > PROJECT_MEMORY_STORAGE_MAX_CHARS || bytes > PROJECT_MEMORY_STORAGE_MAX_BYTES)
            ctx.stdout.write(
              "存储超限：普通写入只允许逐步缩减；运行 comecode memory compact 查看整理计划。\n",
            );
        }
      }
    }
    return 0;
  } catch (error) {
    ctx.stderr.write(`记忆命令失败：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseMemoryArgs(
  args: readonly string[],
): { action: MemoryAction; scope: MemoryScope; apply: boolean } | undefined {
  let action: MemoryAction | undefined;
  let scope: MemoryScope | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--apply") {
      if (apply) return undefined;
      apply = true;
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      if (scope) return undefined;
      const value = arg === "--scope" ? args[++index] : arg.slice("--scope=".length);
      if (value !== "user" && value !== "project" && value !== "both") return undefined;
      scope = value;
    } else {
      if (action || !["path", "init", "check", "history", "compact", "recover"].includes(arg))
        return undefined;
      action = arg as MemoryAction;
    }
  }
  action ??= "path";
  scope ??= action === "history" ? "user" : "project";
  if (action === "history" && scope !== "user") return undefined;
  if ((action === "compact" || action === "recover") && scope !== "project") return undefined;
  if (apply && action !== "compact") return undefined;
  return { action, scope, apply };
}

function printChronicleSummary(
  ctx: RunContext,
  chronicle: Awaited<ReturnType<typeof loadUserMemoryChronicle>>,
): void {
  // 诊断只输出匿名条数和时间，不泄露会话或工作区标识。
  const entries = chronicle.entries;
  const latest = entries.at(-1);
  ctx.stdout.write(
    `匿名最近记录：${entries.length} 条；最近时间：${latest ? new Date(latest.endedAt).toISOString() : "无"}\n`,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    return undefined;
  }
}

async function resolveWorkspaceRoot(startPath: string): Promise<string> {
  let current = resolve(startPath);
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(startPath);
      current = parent;
    }
  }
}

async function addLocalArchiveIgnore(workspaceRoot: string): Promise<void> {
  const gitignorePath = join(workspaceRoot, ".gitignore");
  const marker = ".ai/.local/";
  const content = (await readOptional(gitignorePath)) ?? "";
  if (content.split(/\r?\n/u).some((line) => line.trim() === marker)) return;
  const prefix = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  await writeFile(gitignorePath, `${prefix}${marker}\n`, "utf8");
}
