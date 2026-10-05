import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAllowedMemoryAgentPath } from "../packages/core/src/memory/memory-agent-loop.ts";
import {
  createMemoryExtractionFileSystem,
  validateStableUserMemory,
} from "../packages/core/src/runtime/helpers/project-memory-agent.ts";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "comecode-extraction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, ".ai");
  const userRoot = join(root, "memories", "user");
  await mkdir(project);
  await mkdir(userRoot, { recursive: true });
  return {
    root,
    project,
    userRoot,
    roots: [
      {
        kind: "project",
        rootDir: project,
        files: ["project.md", "memory.md", "bugs.md", "tasks.md", "decisions.md"],
      },
      { kind: "user", rootDir: userRoot, files: ["profile.md", "preferences.md"] },
    ],
  };
}

function memoryPort(initial = {}) {
  const files = new Map(Object.entries(initial));
  const revisions = new Map();
  let writes = 0;
  const read = async ({ path }) => {
    if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "not_found" });
    const content = files.get(path);
    return {
      path,
      content,
      encoding: "utf8",
      truncated: false,
      bytesRead: content.length,
      sizeBytes: content.length,
      revision: { id: String(revisions.get(path) ?? 0) },
    };
  };
  return {
    files,
    revise(path, content) {
      files.set(path, content);
      revisions.set(path, (revisions.get(path) ?? 0) + 1);
    },
    get writes() {
      return writes;
    },
    readTextFile: read,
    readTextFileRange: read,
    async writeTextFile(request, options) {
      options?.signal?.throwIfAborted();
      writes += 1;
      files.set(request.path, request.content);
      revisions.set(request.path, (revisions.get(request.path) ?? 0) + 1);
      return { path: request.path, revision: { id: String(revisions.get(request.path)) } };
    },
  };
}

test("file policy denies symlink escape and reads outside whitelist", async (t) => {
  const { root, project, roots } = await fixture(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  try {
    await symlink(outside, join(project, "project.md"), "junction");
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("environment cannot create symlinks");
      return;
    }
    throw error;
  }
  const input = { allowedRoots: roots, workingDirectory: root, workspaceRoot: root };
  assert.equal(
    await resolveAllowedMemoryAgentPath({
      ...input,
      toolCall: { id: "a", name: "Write", input: { file_path: join(project, "project.md") } },
    }),
    undefined,
  );
  assert.equal(
    await resolveAllowedMemoryAgentPath({
      ...input,
      toolCall: { id: "b", name: "Read", input: { file_path: join(root, "source.ts") } },
    }),
    undefined,
  );
});

test("stable preference structure rejects secrets, tasks prose, duplicates and oversize", () => {
  assert.equal(
    validateStableUserMemory("# 偏好\n- language: 简体中文\n", "Please remember Chinese language"),
    "# 偏好\n- language: 简体中文\n",
  );
  for (const text of [
    "# 偏好\n任务修复foo",
    "- token: sk-fake123456\n",
    "- x: a\n- x: b\n",
    "- x: " + "a".repeat(2001),
  ])
    assert.throws(() => validateStableUserMemory(text, "remember preferences"));
});

test("transaction compares model-seen revision, protects old content and stops after conflict", async (t) => {
  const { root, userRoot, roots } = await fixture(t);
  const path = join(userRoot, "preferences.md");
  const port = memoryPort({ [path]: "# 偏好\n- language: 中文\n" });
  const guarded = createMemoryExtractionFileSystem(port, {
    memoryRoot: userRoot,
    allowedRoots: roots,
    workspaceRoot: root,
    workingDirectory: root,
    userInput: "Please remember concise replies",
  });
  await guarded.readTextFileRange({ path });
  port.revise(path, "# 偏好\n- language: English\n");
  await assert.rejects(
    guarded.writeTextFile({ path, content: "# 偏好\n- style: concise\n" }),
    /revision/u,
  );
  assert.equal(port.writes, 0);
  await assert.rejects(
    guarded.writeTextFile({ path: join(userRoot, "profile.md"), content: "- style: concise\n" }),
    /stopped/u,
  );
});

test("user transaction normal write, duplicate cross-file key, unread existing and overbudget all fail safely", async (t) => {
  const { root, userRoot, roots } = await fixture(t);
  const path = join(userRoot, "preferences.md");
  const sibling = join(userRoot, "profile.md");
  const context = {
    memoryRoot: userRoot,
    allowedRoots: roots,
    workspaceRoot: root,
    workingDirectory: root,
    userInput: "Please remember concise replies",
  };
  const port = memoryPort({
    [path]: "# 偏好\n- language: 中文\n",
    [sibling]: "# Profile\n- editor: terminal\n",
  });
  let guarded = createMemoryExtractionFileSystem(port, context);
  await guarded.readTextFileRange({ path });
  await guarded.writeTextFile({ path, content: "# 偏好\n- language: 中文\n- style: concise\n" });
  assert.equal(port.writes, 1);
  guarded = createMemoryExtractionFileSystem(port, context);
  await guarded.readTextFileRange({ path });
  await assert.rejects(
    guarded.writeTextFile({ path, content: "- editor: vscode\n" }),
    /Duplicate/u,
  );
  assert.equal(port.writes, 1);
  guarded = createMemoryExtractionFileSystem(port, context);
  await assert.rejects(guarded.writeTextFile({ path, content: "- style: concise\n" }), /revision/u);
  port.revise(path, "old".repeat(1000));
  guarded = createMemoryExtractionFileSystem(port, context);
  await guarded.readTextFileRange({ path });
  await assert.rejects(guarded.writeTextFile({ path, content: "- style: concise\n" }), /revision/u);
});
