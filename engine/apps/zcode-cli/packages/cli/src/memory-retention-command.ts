import { createNodeFileSystemAdapter } from "@zcode/adapters";
import {
  previewProjectMemoryRetention,
  applyProjectMemoryRetention,
  resumeProjectMemoryRetention,
} from "@zcode/core";
import type { RunContext } from "@zcode/shared-types";

export async function runMemoryRetentionCommand(
  ctx: RunContext,
  root: string,
  action: "compact" | "recover",
  apply: boolean,
): Promise<number> {
  const port = createNodeFileSystemAdapter();
  if (action === "recover") {
    const result = await resumeProjectMemoryRetention(port, root);
    ctx.stdout.write(
      result
        ? `记忆整理事务已恢复：${result.chars} chars, ${result.bytes} bytes\n`
        : "没有待恢复的记忆整理事务。\n",
    );
    return 0;
  }
  const preview = await previewProjectMemoryRetention(port, root);
  const { plan } = preview;
  ctx.stdout.write(`记忆整理${apply ? "应用" : "预览"}：${root}\n`);
  ctx.stdout.write(
    `容量：${plan.beforeUsage.chars} → ${plan.afterUsage.chars} chars；${plan.beforeUsage.bytes} → ${plan.afterUsage.bytes} UTF-8 bytes\n`,
  );
  for (const change of plan.changes) {
    ctx.stdout.write(
      `\n--- ${change.file}（原文）\n${plan.before[change.file]}\n+++ ${change.file}（拟更新）\n${plan.files[change.file]}\n`,
    );
  }
  if (plan.needsSemanticCompaction)
    ctx.stdout.write("仍有需人工或后台语义合并的内容；未知旧条目及有效约束不会自动删除。\n");
  if (!plan.fits) {
    ctx.stderr.write("保守整理后仍超过存储硬上限，未写入文件。\n");
    return 1;
  }
  if (!apply) {
    ctx.stdout.write("仅预览，未写入文件。使用 comecode memory compact --apply 显式应用。\n");
    return 0;
  }
  await applyProjectMemoryRetention(port, root, preview);
  ctx.stdout.write("已应用记忆整理；恢复副本为 .ai/.local/retention-backup.json（单份覆盖）。\n");
  return 0;
}
