import assert from "node:assert/strict";
import { test } from "node:test";
import { planProjectMemoryRetention } from "../packages/core/src/memory/project-retention.ts";
const item = (date, id, body, kind = "history", status = "done") =>
  `- ${date} [id=${id}] [status=${status}] [kind=${kind}]: ${body}`;

test("近期保留细节、阶段保留两项、早期只保留结论，持续任务不误删", () => {
  const details = "\n  - 细节一\n  - 细节二\n  - 细节三";
  const input = {
    "memory.md": [
      item("2026-10-06", "recent", "近期结果") + details,
      item("2026-09-25", "phase", "阶段结果") + details,
      item("2026-01-01", "early", "早期结论") + details,
    ].join("\n"),
    "tasks.md": item("2020-01-01", "active", "尚未验收", "task", "active") + details,
  };
  const plan = planProjectMemoryRetention(input, { now: "2026-10-07" });
  assert.equal((plan.files["memory.md"].match(/细节一/g) ?? []).length, 1);
  assert.equal((plan.files["memory.md"].match(/细节三/g) ?? []).length, 2);
  assert.match(plan.files["tasks.md"], /尚未验收\n  - 细节一/);
  assert.deepEqual(planProjectMemoryRetention(plan.files, { now: "2026-10-07" }).files, plan.files);
});

test("代码块中的事项示例不能被当作可删除任务，完整子项不残留", () => {
  const sample =
    "# 说明\n\n```md\n" +
    item("2026-01-01", "sample", "范例", "task", "superseded") +
    "\n- [x] 范例任务\n```\n";
  const tasks = "- [x] 已完成\n  - 子任务不应孤立残留\n- [ ] 未完成\n  - 保留子项\n";
  const plan = planProjectMemoryRetention({ "project.md": sample, "tasks.md": tasks });
  assert.equal(plan.files["project.md"], sample);
  assert.equal(plan.files["tasks.md"].includes("孤立"), false);
  assert.match(plan.files["tasks.md"], /未完成/);
  assert.match(plan.files["tasks.md"], /保留子项/);
});

test("预算压力先去旧详情且保留完整结论，不切半句或重要限定", () => {
  const content =
    item("2026-10-07", "done", "实现已提交但尚未实机验收") + "\n  - " + "中间过程".repeat(300);
  const plan = planProjectMemoryRetention(
    { "memory.md": content },
    { now: "2026-10-07", targetChars: 100 },
  );
  assert.match(plan.files["memory.md"], /实现已提交但尚未实机验收/);
  assert.equal(plan.files["memory.md"].includes("中间过程"), false);
});

test("同日期同id重复完全相同可去重，状态冲突必须拒绝", () => {
  const content = item("2026-10-07", "same", "当前事实");
  assert.equal(
    (
      planProjectMemoryRetention({ "memory.md": content + "\n" + content }).files[
        "memory.md"
      ].match(/当前事实/g) ?? []
    ).length,
    1,
  );
  assert.throws(
    () =>
      planProjectMemoryRetention({
        "memory.md": content + "\n" + item("2026-10-07", "same", "相反事实"),
      }),
    /Ambiguous/,
  );
});
