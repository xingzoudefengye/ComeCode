import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runMemoryCommand } from "../packages/cli/src/memory-command.ts";
import { run } from "../packages/cli/src/run.ts";
import {
  formatSlashCommandHelp,
  listSlashCommandSuggestions,
} from "../packages/cli/src/command-center/slash-commands.ts";

async function fixture(t, storageSuffix = "storage") {
  const root = await mkdtemp(join(tmpdir(), "comecode-memory-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project-a");
  const otherProject = join(root, "project-b");
  const storage = join(root, storageSuffix);
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(otherProject, ".git"), { recursive: true });
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      storage: { dir: storage },
      memory: { scope: "both", use: false },
      features: { memory: false },
    }),
  );
  const user = join(storage, ...(storageSuffix === "cli" ? [] : ["cli"]), "memories", "user");
  const deps = { cwd: () => project, env: {}, skipUserConfig: true, projectConfigPath: configPath };
  async function invoke(args, overrides = {}, throughRun = false) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = "";
    let err = "";
    stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    const ctx = { argv: ["memory", ...args], stdin: new PassThrough(), stdout, stderr };
    const code = throughRun
      ? await run(ctx, { ...deps, ...overrides })
      : await runMemoryCommand(ctx, { json: false }, { ...deps, ...overrides }, args);
    return { code, out, err };
  }
  return { root, project, otherProject, storage, user, invoke };
}

test("默认 memory path/init/check 保持 project，子目录解析仓库根且不读用户配置", async (t) => {
  const f = await fixture(t);
  const nested = join(f.project, "src");
  await mkdir(nested);
  const overrides = { cwd: () => nested, projectConfigPath: join(f.root, "missing.json") };
  assert.deepEqual(await f.invoke([], overrides), {
    code: 0,
    out: `${join(f.project, ".ai")}\n`,
    err: "",
  });
  assert.equal((await f.invoke(["init"], overrides)).code, 0);
  assert.match((await f.invoke(["check"], overrides)).out, /scope: project/u);
  assert.match(await readFile(join(f.project, ".gitignore"), "utf8"), /\.ai\/\.local\//u);
  await assert.rejects(stat(f.user), { code: "ENOENT" });
});

test("user init 仅建稳定文件、不覆盖、不写项目，storageRoot跨项目共享", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.invoke(["init", "--scope", "user"])).code, 0);
  assert.deepEqual((await readdir(f.user)).sort(), ["preferences.md", "profile.md"]);
  await assert.rejects(stat(join(f.project, ".gitignore")), { code: "ENOENT" });
  await writeFile(join(f.user, "profile.md"), "已有中文偏好😀");
  assert.equal((await f.invoke(["init", "--scope=user"])).code, 0);
  assert.equal(await readFile(join(f.user, "profile.md"), "utf8"), "已有中文偏好😀");
  const first = await f.invoke(["path", "--scope", "user"]);
  const second = await f.invoke(["path", "--scope", "user"], { cwd: () => f.otherProject });
  assert.equal(first.out, `${f.user}\n`);
  assert.equal(second.out, first.out);
});

test("storage.dir已经是cli时不再附加cli；both init/path同时保留两个根", async (t) => {
  const f = await fixture(t, "cli");
  assert.equal((await f.invoke(["init", "--scope", "both"])).code, 0);
  const path = await f.invoke(["path", "--scope", "both"]);
  assert.equal(path.out, `user: ${f.user}\nproject: ${join(f.project, ".ai")}\n`);
  assert.ok((await readFile(join(f.project, ".ai", "project.md"), "utf8")).includes("项目说明"));
});

test("user check展示实际UTF8容量、匿名史书与预算；不读取history.md内容或迁移旧项目", async (t) => {
  const f = await fixture(t);
  await mkdir(f.user, { recursive: true });
  const text = "中文😀";
  await writeFile(join(f.user, "profile.md"), text);
  await writeFile(join(f.user, "history.md"), "这是绝对不能导入的旧用户内容");
  const legacy = join(f.user, "..", "projects", "demo-0123456789abcdef", "memory");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "project.md"), "旧项目事实");
  const entry = {
    origin: { turnId: "a".repeat(32), branchGeneration: 0 },
    source: `project-${"b".repeat(32)}`,
    summary: "目标：完成诊断；结果：已经检查。",
    status: "success",
    endedAt: Date.now(),
    startedAt: Date.now() - 1000,
    count: 1,
    recency: "recent",
  };
  const raw = JSON.stringify({ version: 1, entries: [entry] });
  await writeFile(join(f.user, "chronicle.json"), raw);
  const checked = await f.invoke(["check", "--scope", "user"]);
  assert.equal(checked.code, 0, checked.err);
  assert.match(checked.out, /配置 scope: both; enabled: false; use: false/u);
  assert.ok(
    checked.out.includes(
      `profile.md: ${Buffer.byteLength(text, "utf8")} bytes (UTF-8), ${text.length} chars`,
    ),
  );
  assert.match(checked.out, /4000 chars/u);
  assert.match(checked.out, /6000 chars/u);
  assert.match(checked.out, /用户总预算：10000 chars/u);
  assert.match(checked.out, /匿名最近记录：1 条；最近时间：\d{4}-/u);
  assert.match(checked.out, /兼容旧 project 记录：1 个目录/u);
  assert.equal(checked.out.includes(entry.source), false);
  assert.equal(checked.out.includes("旧用户内容"), false);
  assert.equal(await readFile(join(f.user, "chronicle.json"), "utf8"), raw);
  assert.equal(await readFile(join(legacy, "project.md"), "utf8"), "旧项目事实");
  const history = await f.invoke(["history"]);
  assert.equal(history.code, 0);
  assert.match(history.out, /完成诊断/u);
  assert.equal(history.out.includes("旧用户内容"), false);
  assert.equal(await readFile(join(f.user, "chronicle.json"), "utf8"), raw);
});

test("history无需init只读，不创建storage或启动模型；非法scope与文件读失败有错误", async (t) => {
  const f = await fixture(t);
  const result = await f.invoke(["history"], {
    createZCodeApp: () => {
      throw new Error("不得启动模型");
    },
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /暂无用户史书记录/u);
  await assert.rejects(stat(f.storage), { code: "ENOENT" });
  for (const args of [
    ["check", "--scope", "invalid"],
    ["init", "--scope"],
    ["path", "extra"],
    ["history", "--scope", "project"],
    ["path", "--scope", "user", "--scope", "both"],
  ]) {
    const invalid = await f.invoke(args);
    assert.equal(invalid.code, 1);
    assert.match(invalid.err, /用法: comecode memory/u);
  }
  await mkdir(join(f.user, "profile.md"), { recursive: true });
  const failed = await f.invoke(["check", "--scope", "user"]);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /记忆命令失败/u);
});

test("实际CLI路由透传apply，预览只读且非法用途返回失败", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.project, ".ai"));
  const file = join(f.project, ".ai", "tasks.md");
  await writeFile(file, "- [x] fixture finished\n- [ ] fixture pending\n");
  const preview = await f.invoke(["compact"], {}, true);
  assert.equal(preview.code, 0, preview.err);
  assert.match(await readFile(file, "utf8"), /finished/u);
  const applied = await f.invoke(["compact", "--apply"], {}, true);
  assert.equal(applied.code, 0, applied.err);
  assert.doesNotMatch(await readFile(file, "utf8"), /finished/u);
  assert.match(await readFile(file, "utf8"), /pending/u);
  assert.equal((await f.invoke(["check", "--apply"], {}, true)).code, 1);
  assert.equal((await f.invoke(["compact", "--apply", "--scope", "user"], {}, true)).code, 1);
});

test("实际CLI路由透传全局scope，/memory save帮助按配置作用域且独立自动史书", async (t) => {
  const f = await fixture(t);
  const result = await f.invoke(["path", "--scope", "user"], {}, true);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, `${f.user}\n`);
  const help = formatSlashCommandHelp("memory");
  assert.match(help, /user\/project\/both/u);
  assert.match(help, /不手动追加史书/u);
  assert.equal(help.includes("写入项目 .ai/"), false);
  assert.match(
    listSlashCommandSuggestions().find((item) => item.name === "memory").summary,
    /按配置作用域/u,
  );
});
