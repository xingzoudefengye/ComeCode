import assert from "node:assert/strict";
import { test } from "node:test";
import { Lexer } from "marked";
import { selectMemoryContextSnapshot } from "../packages/core/src/memory/context-projection.ts";

test("嵌套列表和代码块完整保留，不按行切断", () => {
  const body =
    "## .ai/tasks.md\n\n# 任务\n\n- [ ] 保留父任务\n  - 子任务\n\n```ts\nconst done = true;\n```\n";
  const result = selectMemoryContextSnapshot(body, { kind: "project", maxTokens: 1000 });
  assert.match(result, /保留父任务/u);
  assert.match(result, /子任务/u);
  const code = Lexer.lex(result).find((entry) => entry.type === "code");
  assert.equal(code.text, "const done = true;");
});
