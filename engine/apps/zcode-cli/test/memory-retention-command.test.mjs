import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { runMemoryCommand } from "../packages/cli/src/memory-command.ts";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "comecode-retention-cli-"));
  await mkdir(join(cwd, ".git"));
  await mkdir(join(cwd, ".ai"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  async function invoke(args) {
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    let out = "",
      err = "";
    stdout.on("data", (value) => {
      out += value;
    });
    stderr.on("data", (value) => {
      err += value;
    });
    const code = await runMemoryCommand(
      { stdout, stderr, stdin: new PassThrough(), argv: [] },
      {},
      { cwd: () => cwd, env: {}, skipUserConfig: true },
      args,
    );
    return { code, out, err };
  }
  return { cwd, invoke };
}

test("check展示真正存储总预算与加载预算，超限标明", async (t) => {
  const { cwd, invoke } = await fixture(t);
  await writeFile(join(cwd, ".ai", "tasks.md"), "a".repeat(24001));
  const result = await invoke(["check"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /24001\/24000/);
  assert.match(result.out, /65536/);
  assert.match(result.out, /存储超限/);
  assert.match(result.out, /4000.*12000/);
});

test("compact默认只读预览，apply才修改，未知旧内容保留", async (t) => {
  const { cwd, invoke } = await fixture(t);
  const path = join(cwd, ".ai", "tasks.md");
  const content =
    "# 任务\n\n旧格式仍未验收\n\n- 2026-10-01 [id=test] [status=superseded] [kind=task]: 已失效\n";
  await writeFile(path, content);
  const preview = await invoke(["compact"]);
  assert.equal(preview.code, 0, preview.err);
  assert.match(preview.out, /仅预览/);
  assert.equal(await readFile(path, "utf8"), content);
  await assert.rejects(stat(join(cwd, ".ai", ".local")), { code: "ENOENT" });
  const result = await invoke(["compact", "--apply"]);
  assert.equal(result.code, 0, result.err);
  const updated = await readFile(path, "utf8");
  assert.match(updated, /旧格式仍未验收/);
  assert.equal(updated.includes("已失效"), false);
});

test("整理与恢复失败由命令入口转换成错误提示，不拒绝整个调用", async (t) => {
  const { cwd, invoke } = await fixture(t);
  await writeFile(
    join(cwd, ".ai", "tasks.md"),
    "- 2026-10-01 [id=same] [status=active] [kind=task]: one\n- 2026-10-01 [id=same] [status=done] [kind=task]: two\n",
  );
  const compact = await invoke(["compact", "--apply"]);
  assert.equal(compact.code, 1);
  assert.match(compact.err, /记忆命令失败.*Ambiguous/);
  await mkdir(join(cwd, ".ai", ".local"));
  await writeFile(join(cwd, ".ai", ".local", "retention-plan.json"), "{}");
  const recover = await invoke(["recover"]);
  assert.equal(recover.code, 1);
  assert.match(recover.err, /记忆命令失败.*Invalid retention journal/);
});

test("未知旧文件超限拒绝apply，参数不能扩大到user", async (t) => {
  const { cwd, invoke } = await fixture(t);
  const path = join(cwd, ".ai", "bugs.md");
  const content = "a".repeat(24001);
  await writeFile(path, content);
  assert.equal((await invoke(["compact", "--apply"])).code, 1);
  assert.equal(await readFile(path, "utf8"), content);
  assert.equal((await invoke(["compact", "--scope", "user"])).code, 1);
  assert.equal((await invoke(["check", "--apply"])).code, 1);
  assert.equal((await invoke(["recover"])).code, 0);
});
