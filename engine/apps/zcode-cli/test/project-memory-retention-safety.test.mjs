import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeFileSystemAdapter } from "../packages/adapters/dist/index.js";
import {
  previewProjectMemoryRetention,
  applyProjectMemoryRetention,
  resumeProjectMemoryRetention,
} from "../packages/core/src/memory/project-retention-transaction.ts";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "comecode-retention-safety-"));
  const root = join(cwd, ".ai");
  await mkdir(root);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const file of ["tasks.md", "bugs.md"]) {
    await writeFile(
      join(root, file),
      `# ${file}\n\n- 2026-10-01 [id=${file.slice(0, -3)}] [status=superseded] [kind=task]: obsolete\n`,
    );
  }
  const port = createNodeFileSystemAdapter();
  const preview = await previewProjectMemoryRetention(port, root);
  return { root, port, preview };
}

function interrupt(port, onWrite) {
  let count = 0;
  return new Proxy(port, {
    get(target, key) {
      if (key === "writeTextFile")
        return async (request, options) => {
          const result = await target.writeTextFile(request, options);
          await onWrite(request.path, ++count);
          return result;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function partialApply(root, port, preview) {
  await assert.rejects(
    applyProjectMemoryRetention(
      interrupt(port, (_path, count) => {
        if (count === 3) throw new Error("interrupted after first memory write");
      }),
      root,
      preview,
    ),
    /interrupted/,
  );
}

test("多文件部分应用后可恢复，原副本保留，重复恢复不写", async (t) => {
  const { root, port, preview } = await fixture(t);
  await partialApply(root, port, preview);
  const journal = JSON.parse(await readFile(join(root, ".local", "retention-plan.json"), "utf8"));
  const changed = journal.entries.filter((entry) => entry.next !== entry.old);
  assert.equal(changed.length, 2);
  const applied = [];
  for (const entry of changed) {
    if ((await readFile(join(root, entry.file), "utf8")) === entry.next) applied.push(entry.file);
  }
  assert.equal(applied.length, 1);
  const result = await resumeProjectMemoryRetention(port, root);
  assert.equal(result.chars, preview.plan.afterUsage.chars);
  for (const file of ["tasks.md", "bugs.md"])
    assert.equal(await readFile(join(root, file), "utf8"), preview.plan.files[file]);
  const backup = JSON.parse(await readFile(join(root, ".local", "retention-backup.json"), "utf8"));
  assert.ok(backup.entries.every((entry) => entry.old.includes("obsolete")));
  assert.equal(await resumeProjectMemoryRetention(port, root), undefined);
  await assert.rejects(stat(join(root, ".local", "retention-plan.json")), { code: "ENOENT" });
});

test("恢复先校验全部文件，外部修改未参与计划的文件也停止且不覆盖", async (t) => {
  const { root, port, preview } = await fixture(t);
  await partialApply(root, port, preview);
  const tasksBefore = await readFile(join(root, "tasks.md"), "utf8");
  await writeFile(join(root, "project.md"), "external user constraint\n");
  await assert.rejects(resumeProjectMemoryRetention(port, root), /external conflict: project.md/);
  assert.equal(await readFile(join(root, "project.md"), "utf8"), "external user constraint\n");
  assert.equal(await readFile(join(root, "tasks.md"), "utf8"), tasksBefore);
  assert.ok((await stat(join(root, ".local", "retention-plan.json"))).isFile());
});

test("待恢复 journal 不会被下一次 apply 覆盖", async (t) => {
  const { root, port, preview } = await fixture(t);
  await partialApply(root, port, preview);
  const journalPath = join(root, ".local", "retention-plan.json");
  const journal = await readFile(journalPath, "utf8");
  const fresh = await previewProjectMemoryRetention(port, root);
  await assert.rejects(applyProjectMemoryRetention(port, root, fresh), /recovery is pending/);
  assert.equal(await readFile(journalPath, "utf8"), journal);
});

test("持久化计划后取消不开始写记忆，恢复可完成", async (t) => {
  const { root, port, preview } = await fixture(t);
  const controller = new AbortController();
  const guarded = interrupt(port, (_path, count) => {
    if (count === 2) controller.abort();
  });
  await assert.rejects(
    applyProjectMemoryRetention(guarded, root, preview, { signal: controller.signal }),
  );
  assert.equal(await readFile(join(root, "tasks.md"), "utf8"), preview.plan.before["tasks.md"]);
  await resumeProjectMemoryRetention(port, root);
  assert.equal(await readFile(join(root, "tasks.md"), "utf8"), preview.plan.files["tasks.md"]);
});

test("恢复副本写入失败不变更记忆，无变化整理不重写", async (t) => {
  const { root, port, preview } = await fixture(t);
  await assert.rejects(
    applyProjectMemoryRetention(
      interrupt(port, (_path, count) => {
        if (count === 1) throw new Error("backup failure");
      }),
      root,
      preview,
    ),
    /backup failure/,
  );
  assert.equal(await readFile(join(root, "tasks.md"), "utf8"), preview.plan.before["tasks.md"]);
  await applyProjectMemoryRetention(port, root, preview);
  const mtime = (await stat(join(root, "tasks.md"))).mtimeMs;
  const fresh = await previewProjectMemoryRetention(port, root);
  assert.equal(fresh.plan.changes.length, 0);
  await applyProjectMemoryRetention(port, root, fresh);
  assert.equal((await stat(join(root, "tasks.md"))).mtimeMs, mtime);
});
