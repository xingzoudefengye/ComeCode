import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PROJECT_MEMORY_STORAGE_MAX_CHARS,
  PROJECT_MEMORY_STORAGE_MAX_BYTES,
  PROJECT_MEMORY_TARGET_CHARS,
  planProjectMemoryRetention,
  storageUsage,
} from "../packages/core/src/memory/project-retention.ts";
import {
  applyProjectMemoryRetention,
  previewProjectMemoryRetention,
  resumeProjectMemoryRetention,
} from "../packages/core/src/memory/project-retention-transaction.ts";
import { FileSystemPortError } from "../packages/contracts/dist/interfaces/file-system.port.js";

const files = () => ({
  "project.md": "# Project\n",
  "decisions.md": "# Decisions\n",
  "tasks.md": "# Tasks\n",
  "bugs.md": "# Bugs\n",
  "memory.md": "# Memory\n",
});
const marked = (date, id, status, kind, conclusion, details = "") =>
  `- ${date} [id=${id}] [status=${status}] [kind=${kind}]: ${conclusion}${details ? `\n${details}` : ""}`;

function nodePort({ failWritesAfter = Number.POSITIVE_INFINITY, onWrite } = {}) {
  let writes = 0;
  return {
    async readTextFile({ path, maxBytes }) {
      try {
        const stat = await import("node:fs/promises").then((fs) => fs.stat(path));
        if (stat.size > maxBytes)
          throw new FileSystemPortError({ code: "too_large", path, message: "too large" });
        const content = await readFile(path, "utf8");
        return {
          path,
          content,
          sizeBytes: stat.size,
          bytesRead: stat.size,
          truncated: false,
          revision: { id: `${stat.mtimeMs}:${stat.size}` },
        };
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "not_found")
          throw new FileSystemPortError({ code: "not_found", path, message: "missing" });
        throw error;
      }
    },
    async writeTextFile({ path, content }) {
      writes += 1;
      if (writes > failWritesAfter) throw new Error("injected interruption");
      await mkdir(join(path, ".."), { recursive: true });
      await mkdir(join(path, "..", ".."), { recursive: true });
      await writeFile(path, content, "utf8");
      await onWrite?.(path, content);
      return { path, bytesWritten: Buffer.byteLength(content) };
    },
    async removeFile({ path }) {
      await rm(path, { force: true });
      return { path, removed: true };
    },
    async stat() {
      return { kind: "directory", sizeBytes: 0 };
    },
    async createDirectory({ path }) {
      await mkdir(path, { recursive: true });
      return { path };
    },
    async readBinaryFile() {
      throw new Error("unused");
    },
    async readTextFileRange() {
      throw new Error("unused");
    },
    async listDirectory() {
      throw new Error("unused");
    },
    async searchFiles() {
      throw new Error("unused");
    },
    async searchText() {
      throw new Error("unused");
    },
  };
}

function put(files, name, content) {
  files[name] = `${files[name]}\n${content}`;
  return files;
}

test("normal plan formats, dedupes by latest date, and preserves unknown legacy units", () => {
  const input = put(
    files(),
    "decisions.md",
    `${marked("2026-01-01", "release", "done", "decision", "old conclusion")}\n${marked("2026-10-01", "release", "active", "decision", "current conclusion")}\nlegacy: do not infer acceptance`,
  );
  const plan = planProjectMemoryRetention(input, { now: "2026-10-07" });
  assert.match(plan.files["decisions.md"], /current conclusion/u);
  assert.doesNotMatch(plan.files["decisions.md"], /old conclusion/u);
  assert.match(plan.files["decisions.md"], /legacy: do not infer acceptance/u);
  assert.equal(plan.fits, true);
});

test("same id on the same date is ambiguous, while status keeps active work and resolved bugs removable", () => {
  const input = put(
    files(),
    "tasks.md",
    `${marked("2026-10-01", "same", "active", "task", "one")}\n${marked("2026-10-01", "same", "done", "task", "two")}`,
  );
  assert.throws(() => planProjectMemoryRetention(input), /Ambiguous/u);
  const plan = planProjectMemoryRetention(
    put(files(), "bugs.md", marked("2020-01-01", "old", "resolved", "bug", "fixed")),
    { now: "2026-10-07" },
  );
  assert.match(plan.files["bugs.md"], /fixed/u);
});

test("aging removes only old nested detail and leaves headline and recent detail", () => {
  const details = "  - 2020-01-01: old detail\n  - 2026-10-01: recent detail";
  const input = put(
    files(),
    "memory.md",
    marked("2026-01-01", "fact", "active", "fact", "headline", details),
  );
  const plan = planProjectMemoryRetention(input, { now: "2026-10-07" });
  assert.match(plan.files["memory.md"], /headline/u);
  assert.doesNotMatch(plan.files["memory.md"], /old detail/u);
  assert.match(plan.files["memory.md"], /recent detail/u);
});

test("completed legacy checkbox is dropped but uncompleted and unknown legacy text is retained", () => {
  const input = put(
    files(),
    "tasks.md",
    "- [x] old task\n- [ ] current task\nlegacy paragraph without status",
  );
  const plan = planProjectMemoryRetention(input, { now: "2026-10-07" });
  assert.doesNotMatch(plan.files["tasks.md"], /old task/u);
  assert.match(plan.files["tasks.md"], /current task/u);
  assert.match(plan.files["tasks.md"], /legacy paragraph/u);
});

test("hard character and UTF-8 byte limits are reported without slicing unknown content", () => {
  const input = files();
  input["memory.md"] = "界".repeat(PROJECT_MEMORY_STORAGE_MAX_CHARS);
  const plan = planProjectMemoryRetention(input, { targetChars: PROJECT_MEMORY_TARGET_CHARS });
  assert.ok(plan.afterUsage.chars >= PROJECT_MEMORY_STORAGE_MAX_CHARS);
  assert.ok(plan.afterUsage.bytes > PROJECT_MEMORY_STORAGE_MAX_BYTES);
  assert.equal(plan.fits, false);
  assert.match(plan.files["memory.md"], /界/gu);
  assert.equal(storageUsage(input).bytes, Buffer.byteLength(input["memory.md"], "utf8") + 37);
});

test("preview/apply uses .ai shared lock and rejects preview conflicts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-retention-"));
  const memoryRoot = join(root, ".ai");
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(join(memoryRoot, "project.md"), "# Project\n", "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const port = nodePort();
  const preview = await previewProjectMemoryRetention(port, memoryRoot, { now: "2026-10-07" });
  await writeFile(join(memoryRoot, "project.md"), "external change\n", "utf8");
  await assert.rejects(
    () => applyProjectMemoryRetention(port, memoryRoot, preview),
    /external conflict/u,
  );
});

test("journal interruption resumes only when every old version still matches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-retention-journal-"));
  const memoryRoot = join(root, ".ai");
  await mkdir(memoryRoot, { recursive: true });
  await writeFile(
    join(memoryRoot, "memory.md"),
    marked(
      "2020-01-01",
      "old",
      "done",
      "history",
      "old",
      `  - 2020-01-01: ${"detail ".repeat(4000)}`,
    ),
    "utf8",
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const preview = await previewProjectMemoryRetention(nodePort(), memoryRoot, {
    now: "2026-10-07",
  });
  await assert.rejects(
    () => applyProjectMemoryRetention(nodePort({ failWritesAfter: 2 }), memoryRoot, preview),
    /interruption/u,
  );
  assert.match(
    await readFile(join(memoryRoot, ".local", "retention-plan.json"), "utf8"),
    /entries/u,
  );
  await resumeProjectMemoryRetention(nodePort(), memoryRoot);
  assert.equal(
    await readFile(join(memoryRoot, "memory.md"), "utf8"),
    marked("2020-01-01", "old", "done", "history", "old"),
  );
});
