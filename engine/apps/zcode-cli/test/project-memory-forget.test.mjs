import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planProjectMemoryForget,
} from "../packages/core/src/memory/project-memory-forget.ts";
import {
  previewProjectMemoryForget,
  applyProjectMemoryForget,
} from "../packages/core/src/memory/project-retention-transaction.ts";
import { createNodeFileSystemAdapter } from "../packages/adapters/dist/index.js";

const files = {
  "project.md": "# 项目说明\n\n- 2026-10-01 [id=stack] [status=active] [kind=fact]: 使用 TypeScript\n",
  "decisions.md": [
    "# 重要决策",
    "",
    "- 2026-10-01 [id=format] [status=active] [kind=decision]: 不自动格式化",
    "- 2026-10-02 [id=provider] [status=active] [kind=decision]: 使用本地网关",
    "- legacy content must remain",
    "",
  ].join("\n"),
  "tasks.md": "# 持续任务\n\n- 2026-10-03 [id=login] [status=active] [kind=task]: 实现登录\n",
  "bugs.md": "# 已知问题\n\n- 2026-10-04 [id=token] [status=active] [kind=bug]: token 丢失\n",
  "memory.md": "# 项目记忆\n",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-memory-forget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  return root;
}

test("forget matches structured entries by file and query without touching legacy text", () => {
  const preview = planProjectMemoryForget(files, {
    file: "decisions.md",
    query: "格式化",
  });
  assert.equal(preview.matchedCount, 1);
  assert.match(preview.plan.files["decisions.md"], /使用本地网关/u);
  assert.doesNotMatch(preview.plan.files["decisions.md"], /不自动格式化/u);
  assert.match(preview.plan.files["decisions.md"], /legacy content must remain/u);
});

test("forget combines id and date selectors and rejects an empty selector", () => {
  const preview = planProjectMemoryForget(files, {
    id: "provider",
    date: "2026-10-02",
  });
  assert.equal(preview.matchedCount, 1);
  assert.throws(() => planProjectMemoryForget(files, {}), /requires --id/u);
  assert.throws(() => planProjectMemoryForget(files, { date: "2026-02-30" }), /valid YYYY-MM-DD/u);
});

test("forget applies through the shared transaction and leaves unrelated files intact", async (t) => {
  const root = await fixture(t);
  const port = createNodeFileSystemAdapter();
  const preview = await previewProjectMemoryForget(port, root, {
    file: "bugs.md",
    id: "token",
  });
  assert.equal(preview.matchedCount, 1);
  await applyProjectMemoryForget(port, root, preview);
  assert.doesNotMatch(await readFile(join(root, "bugs.md"), "utf8"), /token 丢失/u);
  assert.match(await readFile(join(root, "tasks.md"), "utf8"), /实现登录/u);
});

test("forget preview is idempotent when there is no match", () => {
  const preview = planProjectMemoryForget(files, {
    file: "tasks.md",
    query: "不存在",
  });
  assert.equal(preview.matchedCount, 0);
  assert.deepEqual(preview.plan.files, preview.plan.before);
  assert.equal(preview.plan.changes.length, 0);
});
