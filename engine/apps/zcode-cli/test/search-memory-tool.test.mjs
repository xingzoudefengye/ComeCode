import assert from "node:assert/strict";
import { test } from "node:test";
import { searchMemoryToolEntry } from "../packages/core/src/tool/handlers/search-memory.ts";

const context = {
  abortSignal: new AbortController().signal,
};

test("SearchMemory handler searches the complete supplied project snapshot", async () => {
  const output = await searchMemoryToolEntry.handler(
    { query: "old sentinel" },
    { ...context, memorySnapshot: { projectContent: "## .ai/memory.md\n\n- old sentinel decision\n" } },
  );
  assert.equal(output.status, "success");
  assert.match(output.results[0].excerpt, /old sentinel/u);
  assert.equal(output.truncated, false);
});

test("SearchMemory handler does not read disk when snapshot is absent", async () => {
  const output = await searchMemoryToolEntry.handler(
    { query: "anything" },
    { ...context, fileSystemPort: new Proxy({}, { get() { throw new Error("disk access"); } }) },
  );
  assert.equal(output.status, "disabled");
  assert.deepEqual(output.results, []);
});
