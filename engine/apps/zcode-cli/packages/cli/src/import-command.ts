import { formatJson } from "@zcode/core";
import {
  importProviderConfig,
  ProviderConfigImportError,
  type ProviderConfigImportResult,
  type ProviderConfigImportSource,
} from "@zcode/adapters/config";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

const SOURCES: readonly ProviderConfigImportSource[] = ["codex", "claude"];

export async function runImportCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  source: string | undefined,
  args: readonly string[] = [],
): Promise<number> {
  if (!source || !SOURCES.includes(source as ProviderConfigImportSource) || args.length > 0) {
    ctx.stderr.write("用法: comecode import <codex|claude>\n");
    return 1;
  }
  try {
    const result = await importProviderConfig(source as ProviderConfigImportSource, {
      env: deps.env ?? process.env,
    });
    if (options.json) ctx.stdout.write(formatJson(JSON.parse(JSON.stringify(result))));
    else writeImportSummary(ctx, result);
    return 0;
  } catch (error) {
    const message = error instanceof ProviderConfigImportError || error instanceof Error
      ? error.message
      : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
}

function writeImportSummary(ctx: RunContext, result: ProviderConfigImportResult): void {
  const label = result.source === "codex" ? "Codex" : "Claude Code";
  ctx.stdout.write(`${result.changed ? "已导入" : "配置已存在，无需重复导入"} ${label} 配置\n`);
  ctx.stdout.write(`来源：${result.sourcePath}\n目标：${result.targetPath}\n`);
  ctx.stdout.write(`新增供应商：${result.addedProviders.length || "无"}\n`);
  ctx.stdout.write(`新增模型：${result.addedModels.length || "无"}\n`);
  if (result.skippedProviders.length || result.skippedModels.length) {
    ctx.stdout.write(`已跳过重复项：${result.skippedProviders.length + result.skippedModels.length}\n`);
  }
  if (result.backupPath) ctx.stdout.write(`原配置备份：${result.backupPath}\n`);
  for (const warning of result.warnings) ctx.stdout.write(`提示：${warning}\n`);
  ctx.stdout.write("请运行 comecode config check 检查配置，重启 ComeCode 后生效。\n");
}
