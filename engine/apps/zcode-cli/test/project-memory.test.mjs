import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { formatProjectMemorySnapshot, resolveWorkspaceProjectMemoryRoot } from "../packages/core/src/memory/project-files.ts";
import { buildMemorySection } from "../packages/core/src/context/sections/memory.ts";
import { runMemoryCommand } from "../packages/cli/src/memory-command.ts";

test("项目记忆根目录位于工作区 .ai，快照按固定顺序并限制总量", () => {
  assert.equal(resolveWorkspaceProjectMemoryRoot("C:/work/demo"), join("C:/work/demo", ".ai"));
  const snapshot = formatProjectMemorySnapshot({
    "project.md": "项目说明",
    "decisions.md": "决策",
    "tasks.md": "任务",
  });
  assert.ok(snapshot);
  assert.ok(snapshot.content.indexOf("project.md") < snapshot.content.indexOf("decisions.md"));
  assert.ok(snapshot.content.indexOf("decisions.md") < snapshot.content.indexOf("tasks.md"));
});

test("项目记忆注入稳定 system section，不重复放进 meta user", () => {
  const section = buildMemorySection("C:/work/demo/.ai", "## .ai/project.md\n\n项目目标");
  assert.ok(section);
  assert.equal(section.cacheHint, "stable");
  assert.equal(section.injectionTarget, "system");
  assert.match(section.content, /项目目标/u);
});

test("memory init 创建 .ai 模板且不覆盖用户已有文件", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const output = [];
  stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
  const result = await runMemoryCommand(
    { argv: [], stdin: new PassThrough(), stdout, stderr },
    { json: false },
    { cwd: () => root },
    ["init"],
  );
  assert.equal(result, 0);
  const projectPath = join(root, ".ai", "project.md");
  const original = await readFile(projectPath, "utf8");
  assert.match(original, /项目说明/u);
  await writeFile(projectPath, "# 用户内容\n", "utf8");
  await runMemoryCommand(
    { argv: [], stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
    { json: false },
    { cwd: () => root },
    ["init"],
  );
  assert.equal(await readFile(projectPath, "utf8"), "# 用户内容\n");
  assert.match(await readFile(join(root, ".gitignore"), "utf8"), /\.ai\/\.local\//u);
  assert.match(Buffer.concat(output).toString("utf8"), /项目记忆目录/u);
});