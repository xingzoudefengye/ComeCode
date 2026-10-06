import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileSystemPortError } from "../packages/contracts/dist/interfaces/file-system.port.js";
import { writeMemoryTextFile } from "../packages/core/src/memory/project-storage.ts";
import { PROJECT_MEMORY_FILES } from "../packages/core/src/memory/project-files.ts";

async function fixture(t, values = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "comecode-storage-"));
  const root = join(cwd, ".ai");
  await mkdir(root);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const files = new Map(Object.entries(values).map(([file, text]) => [join(root, file), text]));
  let revision = 0;
  const port = {
    async readTextFile({ path }) {
      if (!files.has(path))
        throw new FileSystemPortError({ code: "not_found", message: "missing" });
      return {
        content: files.get(path),
        revision: { id: String(revision) },
        encoding: "utf8",
        truncated: false,
      };
    },
    async writeTextFile({ path, content }) {
      files.set(path, content);
      revision++;
      return { path, revision: { id: String(revision) } };
    },
  };
  return { cwd, root, files, port };
}

test("项目五文件共享字符预算，普通写入拒绝增加超限内容", async (t) => {
  const { root, files, port } = await fixture(t, { "project.md": "a".repeat(20000) });
  const path = join(root, "tasks.md");
  await assert.rejects(
    writeMemoryTextFile(port, { path, content: "b".repeat(4001) }, undefined, root),
    /budget exceeded/,
  );
  assert.equal(files.has(path), false);
  await writeMemoryTextFile(port, { path, content: "b".repeat(4000) }, undefined, root);
  assert.equal(files.get(path).length, 4000);
});

test("UTF8独立硬上限不能被emoji和CRLF绕过", async (t) => {
  const { root, port, files } = await fixture(t);
  const path = join(root, "memory.md");
  const content = "汉".repeat(23000);
  await assert.rejects(
    writeMemoryTextFile(port, { path, content }, undefined, root),
    /UTF-8 bytes/,
  );
  assert.equal(files.has(path), false);
});

test("旧超限允许逐步缩减，不允许转移后增加容量", async (t) => {
  const { root, port, files } = await fixture(t, { "decisions.md": "a".repeat(30000) });
  const path = join(root, "decisions.md");
  await writeMemoryTextFile(port, { path, content: "a".repeat(29000) }, undefined, root);
  assert.equal(files.get(path).length, 29000);
  await assert.rejects(
    writeMemoryTextFile(port, { path, content: "a".repeat(29001) }, undefined, root),
    /budget/,
  );
});

test("同根并发写入不会分别通过后突破总预算", async (t) => {
  const { root, port, files } = await fixture(t, { "project.md": "a".repeat(23000) });
  const result = await Promise.allSettled(
    ["tasks.md", "bugs.md"].map((file) =>
      writeMemoryTextFile(
        port,
        { path: join(root, file), content: "b".repeat(600) },
        undefined,
        root,
      ),
    ),
  );
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(
    PROJECT_MEMORY_FILES.reduce(
      (sum, file) => sum + (files.get(join(root, file))?.length ?? 0),
      0,
    ) <= 24000,
  );
});

test("取消不写，非白名单文件延续原行为", async (t) => {
  const { root, port, files } = await fixture(t);
  const path = join(root, "tasks.md");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    writeMemoryTextFile(port, { path, content: "任务" }, { signal: controller.signal }, root),
  );
  assert.equal(files.has(path), false);
  const outside = join(root, "notes.md");
  await writeMemoryTextFile(port, { path: outside, content: "a".repeat(30000) }, undefined, root);
  assert.equal(files.get(outside).length, 30000);
});
