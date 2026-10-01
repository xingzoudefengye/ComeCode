import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PROJECT_MEMORY_FILES, PROJECT_MEMORY_TEMPLATE, resolveWorkspaceProjectMemoryRoot } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

export async function runMemoryCommand(
  ctx: RunContext,
  _options: GlobalOptions,
  deps: RunDependencies,
  args: readonly string[] = [],
): Promise<number> {
  const action = args[0] ?? "path";
  if (args.length > 1 || !["path", "init", "check"].includes(action)) {
    ctx.stderr.write("用法: comecode memory <path|init|check>\n");
    return 1;
  }
  const workspace = await resolveWorkspaceRoot(deps.cwd?.() ?? process.cwd());
  const memoryRoot = resolveWorkspaceProjectMemoryRoot(workspace);

  if (action === "path") {
    ctx.stdout.write(`${memoryRoot}\n`);
    return 0;
  }

  if (action === "init") {
    await mkdir(memoryRoot, { recursive: true });
    const created: string[] = [];
    for (const fileName of PROJECT_MEMORY_FILES) {
      const path = join(memoryRoot, fileName);
      try {
        await stat(path);
      } catch {
        await writeFile(path, PROJECT_MEMORY_TEMPLATE[fileName], "utf8");
        created.push(fileName);
      }
    }
    await addLocalArchiveIgnore(workspace);
    ctx.stdout.write(`项目记忆目录：${memoryRoot}\n`);
    ctx.stdout.write(created.length > 0 ? `已创建：${created.join(", ")}\n` : "文件已存在，没有覆盖现有内容。\n");
    return 0;
  }

  const entries: string[] = [];
  for (const fileName of PROJECT_MEMORY_FILES) {
    const path = join(memoryRoot, fileName);
    try {
      const info = await stat(path);
      entries.push(`${fileName}: ${info.size} bytes`);
    } catch {
      entries.push(`${fileName}: 缺失`);
    }
  }
  ctx.stdout.write(`项目记忆目录：${memoryRoot}\n${entries.join("\n")}\n`);
  return 0;
}

async function resolveWorkspaceRoot(startPath: string): Promise<string> {
  let current = resolve(startPath);
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(startPath);
      current = parent;
    }
  }
}

async function addLocalArchiveIgnore(workspaceRoot: string): Promise<void> {
  const gitignorePath = join(workspaceRoot, ".gitignore");
  const marker = ".ai/.local/";
  let content = "";
  try { content = await readFile(gitignorePath, "utf8"); } catch { /* 文件不存在时新建。 */ }
  if (content.split(/\r?\n/u).some((line) => line.trim() === marker)) return;
  const prefix = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  await writeFile(gitignorePath, `${prefix}${marker}\n`, "utf8");
}