import assert from "node:assert/strict";
import { test } from "node:test";
import { searchMemorySnapshot } from "../packages/core/src/memory/memory-search.ts";

const snapshot = [
  "## .ai/project.md",
  "",
  "# 项目说明",
  "",
  "- 项目使用 React 和 Vite。",
  "",
  "## .ai/decisions.md",
  "",
  "# 重要决策",
  "",
  "- 2026-10-07：不自动格式化，保留手动格式。",
  "- 2026-10-06：使用本地网关，避免外部服务。",
  "",
  "## .ai/bugs.md",
  "",
  "# 已知问题",
  "",
  "- 登录页刷新后 token 丢失。",
].join("\n");

test("memory search ranks a matching project decision first", () => {
  const results = searchMemorySnapshot(snapshot, "自动格式化");
  assert.equal(results[0]?.file, "decisions.md");
  assert.match(results[0]?.excerpt ?? "", /手动格式/u);
});

test("memory search supports Chinese bigrams and English terms", () => {
  assert.equal(searchMemorySnapshot(snapshot, "token")[0]?.file, "bugs.md");
  assert.equal(searchMemorySnapshot(snapshot, "React")[0]?.file, "project.md");
});

test("memory search can find entries beyond the normal context projection", () => {
  const longPrefix = Array.from({ length: 80 }, (_, index) => `- filler-${index}: unrelated project detail`).join("\n");
  const fullSnapshot = `## .ai/project.md\n\n# 项目说明\n\n${longPrefix}\n\n## .ai/bugs.md\n\n- 2026-10-07: rare sentinel regression in the payment reconciler\n`;
  const results = searchMemorySnapshot(fullSnapshot, "payment reconciler");
  assert.equal(results[0]?.file, "bugs.md");
  assert.match(results[0]?.excerpt ?? "", /payment reconciler/u);
});

test("memory search applies result and character bounds with stable empty results", () => {
  assert.equal(searchMemorySnapshot(snapshot, "量子纠缠").length, 0);
  assert.ok(searchMemorySnapshot(snapshot, "项目", { maxResults: 1 }).length <= 1);
  assert.ok(searchMemorySnapshot(snapshot, "项目", { maxChars: 200 }).length <= 1);
});
