import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === "@zcode/contracts"
        ? new URL("../packages/contracts/src/index.ts", import.meta.url).href
        : specifier,
      context,
    );
  },
});
const { createProviderConfigEditor } =
  await import("../packages/adapters/src/config/provider-config-editor.ts");

async function fixture(t, extension = "json") {
  const root = await mkdtemp(join(tmpdir(), "comecode-provider-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, "user");
  await mkdir(dataRoot);
  const document = {
    provider: "fixture",
    model: "fixture-model",
    compact: { resumeInputTokenThreshold: 51200 },
    features: { compact: false },
    providers: [
      {
        id: "fixture",
        type: "openai-chat",
        apiKey: "fake-provider-secret",
        models: [{ id: "fixture-model", apiKey: "fake-model-secret", contextWindow: 32000 }],
      },
    ],
  };
  const original =
    extension === "toml"
      ? `provider = "fixture"
model = "fixture-model"
[compact]
resumeInputTokenThreshold = 51200
[features]
compact = false
[providers.fixture]
type = "openai-chat"
api_key = "fake-provider-secret"
models = ["fixture-model"]
`
      : extension === "jsonc"
        ? `// fixture config\n${JSON.stringify(document, null, 2).replace(/\n}$/, ",\n}")}`
        : JSON.stringify(document);
  const source = join(dataRoot, `config.${extension}`);
  await writeFile(source, original);
  return {
    document,
    original,
    source,
    target: join(dataRoot, "config.json"),
    editor: createProviderConfigEditor({ dataRoot, cwd: root, env: {}, includeProject: false }),
  };
}

for (const extension of ["json", "jsonc", "toml"]) {
  for (const omitFields of [false, true]) {
    test(`${extension}编辑器${omitFields ? "旧网页只改模型" : "读取原样保存"}保留恢复配置与密钥`, async (t) => {
      const f = await fixture(t, extension);
      const before = await f.editor.read();
      assert.deepEqual(before.errors, []);
      assert.deepEqual(before.config.compact, f.document.compact);
      assert.deepEqual(before.config.features, f.document.features);
      assert.doesNotMatch(JSON.stringify(before), /fake-provider-secret|fake-model-secret/u);
      const config = structuredClone(before.config);
      if (omitFields) {
        delete config.compact;
        delete config.features;
        config.providers[0].models[0].contextWindow = 64000;
      }
      const input = { revision: before.revision, config, migrate: true };
      const preview = await f.editor.preview(input);
      assert.deepEqual(preview.document.compact, f.document.compact);
      assert.deepEqual(preview.document.features, f.document.features);
      assert.equal(await readFile(f.source, "utf8"), f.original);
      if (extension !== "json") {
        await assert.rejects(f.editor.save({ ...input, migrate: false }), { status: 409 });
      }
      const saved = await f.editor.save(input);
      assert.deepEqual(saved.config.compact, f.document.compact);
      assert.deepEqual(saved.config.features, f.document.features);
      assert.doesNotMatch(JSON.stringify(saved), /fake-provider-secret|fake-model-secret/u);
      const persisted = JSON.parse(await readFile(f.target, "utf8"));
      assert.deepEqual(persisted.compact, f.document.compact);
      assert.deepEqual(persisted.features, f.document.features);
      assert.equal(persisted.providers[0].apiKey, "fake-provider-secret");
      assert.equal(
        persisted.providers[0].models[0].apiKey,
        extension === "toml" ? undefined : "fake-model-secret",
      );
      assert.equal(
        persisted.providers[0].models[0].contextWindow,
        omitFields ? 64000 : extension === "toml" ? undefined : 32000,
      );
      assert.equal(await readFile(saved.backup, "utf8"), f.original);
      if (extension !== "json") assert.equal(await readFile(f.source, "utf8"), f.original);
    });
  }
}

test("编辑器显式合法值更新恢复配置，0与false可保存", async (t) => {
  const f = await fixture(t);
  for (const [threshold, enabled] of [
    [90000, true],
    [0, false],
  ]) {
    const before = await f.editor.read();
    const config = {
      ...before.config,
      compact: { resumeInputTokenThreshold: threshold },
      features: { compact: enabled },
    };
    const input = { revision: before.revision, config };
    const preview = await f.editor.preview(input);
    assert.equal(preview.document.compact.resumeInputTokenThreshold, threshold);
    assert.equal(preview.document.features.compact, enabled);
    const saved = await f.editor.save(input);
    assert.equal(saved.config.compact.resumeInputTokenThreshold, threshold);
    assert.equal(saved.config.features.compact, enabled);
    const persisted = JSON.parse(await readFile(f.target, "utf8"));
    assert.equal(persisted.compact.resumeInputTokenThreshold, threshold);
    assert.equal(persisted.features.compact, enabled);
  }
});

test("编辑器拒绝null与非法恢复字段，预览和保存均不覆盖源文件", async (t) => {
  const f = await fixture(t);
  const before = await f.editor.read();
  for (const fields of [
    { compact: null },
    { features: null },
    { compact: false },
    { features: [] },
    { compact: { resumeInputTokenThreshold: -1 } },
    { compact: { resumeInputTokenThreshold: 1.5 } },
    { compact: { resumeInputTokenThreshold: "0" } },
    { compact: { resumeInputTokenThreshold: null } },
    { compact: { resumeInputTokenThreshold: Infinity } },
    { compact: { resumeInputTokenThreshold: NaN } },
    { features: { compact: "false" } },
    { features: { compact: null } },
    { compact: { typo: 0 } },
    { features: { typo: false } },
  ]) {
    const input = { revision: before.revision, config: { ...before.config, ...fields } };
    await assert.rejects(f.editor.preview(input), { status: 422 });
    await assert.rejects(f.editor.save(input), { status: 422 });
    assert.equal(await readFile(f.source, "utf8"), f.original);
  }
});
