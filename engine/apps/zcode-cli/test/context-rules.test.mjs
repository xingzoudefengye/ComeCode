import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { NodeContextSourceAdapter } from "../packages/adapters/src/context/index.ts";

test("规则文件按固定顺序合并并支持 CLAUDE.md 与 .comecode/AGENTS.md", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-rules-"));
  const home = join(root, "home");
  const project = join(root, "project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(home, ".comecode"), { recursive: true });
  await writeFile(join(home, ".comecode", "AGENTS.md"), "用户规则\n", "utf8");
  await mkdir(join(project, ".git"), { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "AGENTS 规则\n", "utf8");
  await writeFile(join(project, "CLAUDE.md"), "CLAUDE 规则\n", "utf8");
  await mkdir(join(project, ".comecode"));
  await writeFile(join(project, ".comecode", "AGENTS.md"), "ComeCode 规则\n", "utf8");
  const adapter = new NodeContextSourceAdapter({ env: { USERPROFILE: home } });
  const snapshot = await adapter.resolveContextSources({
    workingDirectory: project,
    userInstructions: { workingDirectory: project },
  });
  assert.ok(snapshot.userInstructions);
  assert.deepEqual(snapshot.userInstructions.sources?.map((source) => source.fileName), [
    "AGENTS.md",
    "AGENTS.md",
    "CLAUDE.md",
    join(".comecode", "AGENTS.md"),
  ]);
  assert.match(snapshot.userInstructions.content, /用户规则[\s\S]*AGENTS 规则[\s\S]*CLAUDE 规则[\s\S]*ComeCode 规则/u);
});

test("规则文件重复路径只注入一次", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "comecode-rules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".git"));
  await writeFile(join(root, "AGENTS.md"), "唯一规则\n", "utf8");
  const adapter = new NodeContextSourceAdapter({ env: { USERPROFILE: root } });
  const snapshot = await adapter.resolveContextSources({
    workingDirectory: root,
    userInstructions: { workingDirectory: root, priorityFiles: ["AGENTS.md"] },
  });
  assert.equal(snapshot.userInstructions?.sources?.length, 1);
  assert.equal(snapshot.userInstructions?.content, "唯一规则\n");
});